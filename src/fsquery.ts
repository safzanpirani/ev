// Pure: a QuerySpec in, an fsearch request out. No IO, no clock of its own.
//
// fsearch's query language differs from Everything's in ways that change
// answers, so every flag either maps to an exact fsearch filter or fails here
// with a message naming the flag. Nothing is silently dropped.

import type { QuerySpec } from "./query.ts";

/** One line of the fsearch JSON-lines API. `limit` rides as its own field. */
export interface FsRequest {
  q: string;
  limit: number;
  /** Content search. The pattern rides as its own field, so quotes and spaces need no escaping. */
  op?: "grep";
  pattern?: string;
  mode?: "literal" | "regex";
}

export interface FsQueryOptions {
  /** Rows to ask the daemon for. */
  limit: number;
  /** Epoch milliseconds, injected so date flags map deterministically in tests. */
  now: number;
  /** Content search for a literal string (fsearch `grep:`). */
  grep?: string;
  /** Content search for a regular expression (fsearch `regex:`). */
  grepRegex?: string;
}

/** Thrown for a flag fsearch cannot express. The message names the flag. */
export class UnsupportedFlag extends Error {
  constructor(flag: string, why: string) {
    super(`${flag} is not supported on macOS (fsearch): ${why}`);
    this.name = "UnsupportedFlag";
  }
}

/**
 * fsearch splits its query on spaces and toggles on `"`, so a value with a
 * space must be wrapped in double quotes, and a value holding a double quote
 * cannot be expressed at all.
 */
function quoteValue(flag: string, v: string): string {
  if (v.includes('"')) throw new UnsupportedFlag(flag, `the value ${JSON.stringify(v)} contains a double quote, which fsearch's query syntax cannot carry`);
  return /\s/.test(v) ? `"${v}"` : v;
}

function quoteTerm(t: string): string {
  if (/^".*"$/.test(t) && !t.slice(1, -1).includes('"')) return t;
  return quoteValue("query term", t);
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const AGE_UNITS: Record<string, number> = { s: 1, m: 60, min: 60, h: 3600, d: 86400, w: 604800, mo: 2592000, y: 31536000 };

/**
 * A date flag as epoch milliseconds. Accepts what agents type: an ISO date or
 * local date-time, `today`, `yesterday`, or an age like `7d`, `12h`, `30min`.
 * A bare `30m` is thirty minutes, as in fsearch; months are `mo`.
 */
export function parseWhen(flag: string, input: string, now: number): number {
  const s = input.trim().toLowerCase();
  const midnight = (offsetDays: number) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offsetDays);
    return d.getTime();
  };
  if (s === "today") return midnight(0);
  if (s === "yesterday") return midnight(-1);

  const age = /^(\d+(?:\.\d+)?)(s|min|mo|m|h|d|w|y)$/.exec(s);
  if (age) return now - Math.round(Number(age[1]) * AGE_UNITS[age[2]!]! * 1000);

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (iso) {
    const [, y, mo, d, h, mi, sec] = iso;
    const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(sec ?? 0));
    if (!Number.isNaN(t.getTime()) && t.getMonth() === Number(mo) - 1) return t.getTime();
  }
  throw new Error(`${flag}: cannot read ${JSON.stringify(input)} — use 2026-01-01, 2026-01-01T09:30, today, yesterday, or an age like 7d, 12h, 30min`);
}

/** Whole seconds between `when` and `now`; never negative. */
function ageSeconds(when: number, now: number): number {
  return Math.max(0, Math.floor((now - when) / 1000));
}

/**
 * Map the flags fsearch can express. Called for every request, so an
 * unsupported flag fails before the daemon is contacted.
 */
export function buildFsQuery(spec: QuerySpec, opts: FsQueryOptions): FsRequest {
  if (spec.matchCase) throw new UnsupportedFlag("--case", "fsearch matches names case-insensitively (content search is smart-case)");
  if (spec.wholeWord) throw new UnsupportedFlag("--whole-word", "fsearch has no word-boundary mode; use --regex with \\b, or an 'exact term");
  if (spec.matchPath && !spec.regex) {
    throw new UnsupportedFlag("--match-path", "fsearch words already match folder names once one word hits the file name; for a full-path pattern use --regex --match-path");
  }
  if (spec.under && spec.parent) throw new UnsupportedFlag("--under with --parent", "fsearch takes one in: scope; pass only --parent");
  if (opts.grep !== undefined && opts.grepRegex !== undefined) throw new Error("--grep and --grep-regex are mutually exclusive");

  const parts: string[] = [];
  const terms = spec.terms.filter((t) => t.trim());

  if (spec.regex) {
    if (terms.length !== 1) throw new Error(`--regex takes exactly one pattern (got ${terms.length}); quote it as one argument`);
    parts.push(`${spec.matchPath ? "path" : "re"}:${quoteValue("--regex", terms[0]!)}`);
  } else {
    for (const t of terms) parts.push(quoteTerm(t));
  }

  if (spec.ext?.length) parts.push(`ext:${spec.ext.join(",")}`);

  if (spec.type === "files") parts.push("kind:file");
  else if (spec.type === "folders") parts.push("kind:dir");

  if (spec.under) parts.push(`in:${quoteValue("--under", spec.under)}`);
  if (spec.parent) {
    // fsearch has no parent filter: scope to the folder, then require exactly
    // one more path segment. `in:` keeps the scan to that folder's range.
    const dir = spec.parent.replace(/\/+$/, "") || "/";
    parts.push(`in:${quoteValue("--parent", dir)}`);
    parts.push(`path:${quoteValue("--parent", `^${escapeRegex(dir === "/" ? "" : dir)}/[^/]+$`)}`);
  }

  // fsearch keeps one size range and one mtime range; a second filter of the
  // same kind replaces the first, so both bounds go into one `a..b` range.
  if (spec.larger !== undefined && spec.smaller !== undefined) parts.push(`size:${spec.larger}..${spec.smaller}`);
  else if (spec.larger !== undefined) parts.push(`size:>=${spec.larger}`);
  else if (spec.smaller !== undefined) parts.push(`size:<=${spec.smaller}`);

  // fsearch's mtime filter is an age ("modified within 7d"). Convert dates to
  // ages in seconds: after a date = younger than its age.
  const after = spec.modifiedAfter !== undefined ? ageSeconds(parseWhen("--after", spec.modifiedAfter, opts.now), opts.now) : undefined;
  const before = spec.modifiedBefore !== undefined ? ageSeconds(parseWhen("--before", spec.modifiedBefore, opts.now), opts.now) : undefined;
  if (after !== undefined && before !== undefined) {
    if (before > after) throw new Error("--before is earlier than --after; nothing can match");
    parts.push(`mtime:${before}s..${after}s`);
  } else if (after !== undefined) parts.push(`mtime:<=${after}s`);
  else if (before !== undefined) parts.push(`mtime:>=${before}s`);

  const req: FsRequest = { q: parts.join(" "), limit: opts.limit };
  if (opts.grep !== undefined) return { ...req, op: "grep", pattern: opts.grep, mode: "literal" };
  if (opts.grepRegex !== undefined) return { ...req, op: "grep", pattern: opts.grepRegex, mode: "regex" };
  return req;
}
