// Linux actions. plocate names the candidates; lstat supplies sizes, dates and
// file identities, so every total is as fresh as the moment of the query even
// though the name index is only as fresh as its last `ev index`. Never prints.

import { lstatSync } from "node:fs";
import { queryWords, type QuerySpec, type SortKey } from "./query.ts";
import { parseWhen } from "./fsquery.ts";
import type { EsRow } from "./es.ts";
import type { LocateClient, PathQuery } from "./locate.ts";
import { foldDupes, nameSizeGroups, type DuEntry, type DuEntryTree, type DuResult, type DuTreeResult, type DupesResult, type ExtEntry, type FindResult } from "./core.ts";
import { SKIPPED_DIRS, GREP_MAX_BYTES, readCandidates, type GrepOptions, type MainGrepResult } from "./grep.ts";

export interface LxRow extends EsRow {
  kind: "file" | "dir" | "link" | "other";
  /** Bytes on the file itself; folders carry 0 here and no `size`. */
  bytes: number;
  mtimeMs: number;
  birthMs: number;
  /** dev:ino, so hard links count once. */
  id: string;
}

export interface Collected {
  rows: LxRow[];
  /** Index entries that matched the name filters. */
  matched: number;
  /** Matched index entries that no longer exist on disk. */
  gone: number;
  /** True when more entries matched than `cap` allowed to be read. */
  sampled: boolean;
}

/** Everything's filter words. On Linux the flags carry those filters. */
const FILTER_WORD = /^!?[a-z]{2,}:/i;

/** `/a/b/` → `/a/b`, keeping `/`. */
function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function nameOf(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function isUnder(p: string, root: string): boolean {
  return root === "/" ? p.startsWith("/") : p === root || p.startsWith(root + "/");
}

/** The plocate runs one spec needs, plus the filters plocate cannot express. */
export function planQueries(spec: QuerySpec): { queries: PathQuery[]; include: string[]; exclude: string[] } {
  const words = spec.regex ? spec.terms.filter((t) => t.trim()) : spec.terms.flatMap(queryWords);
  if (!spec.regex) {
    for (const w of words) {
      if (FILTER_WORD.test(w)) {
        throw new Error(`'${w}' is Everything search syntax, which plocate does not read. On Linux use --ext, --larger/--smaller, --after/--before and --files/--folders.`);
      }
    }
  }
  const exclude = words.filter((w) => w.startsWith("!") && w.length > 1).map((w) => w.slice(1));
  const include = words.filter((w) => !(w.startsWith("!") && w.length > 1));
  const basename = !spec.matchPath;
  const ignoreCase = !spec.matchCase;

  let queries: PathQuery[];
  if (spec.regex) {
    queries = [{ patterns: include, basename, ignoreCase, regex: true }];
  } else if (spec.ext?.length) {
    // One run per extension: plocate ANDs its patterns, and a glob must match the whole name.
    queries = spec.ext.map((e) => ({ patterns: [...include, `*.${e}`], basename, ignoreCase, regex: false }));
  } else if (include.length) {
    queries = [{ patterns: include, basename, ignoreCase, regex: false }];
  } else {
    // No name to look up: list the subtree. A path substring uses plocate's index; the prefix check below makes it exact.
    queries = [{ patterns: [trimSlash(spec.under ?? spec.parent ?? "/")], basename: false, ignoreCase: false, regex: false }];
  }
  return { queries, include, exclude };
}

function wordRe(w: string, matchCase: boolean): RegExp {
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, matchCase ? "u" : "iu");
}

/** Local wall-clock time, as es.exe prints dates on main. */
function localIso(ms: number): string {
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

/** Dates are formatted only for the rows a listing shows; a du over millions of files never needs them. */
export function withDates(r: LxRow): LxRow {
  return { ...r, date_modified: localIso(r.mtimeMs), date_created: localIso(r.birthMs) };
}

function statRow(p: string): LxRow | null {
  const s = lstatSync(p, { throwIfNoEntry: false });
  if (!s) return null;
  const kind = s.isDirectory() ? "dir" : s.isFile() ? "file" : s.isSymbolicLink() ? "link" : "other";
  const row: LxRow = { filename: p, kind, bytes: kind === "dir" ? 0 : s.size, mtimeMs: s.mtimeMs, birthMs: s.birthtimeMs, id: `${s.dev}:${s.ino}` };
  if (kind !== "dir") row.size = s.size;
  return row;
}

/** A bare date in --before means the whole day, as it does in Everything. */
function beforeMs(input: string, now: number): number {
  const t = parseWhen("--before", input, now);
  return /^\d{4}-\d{2}-\d{2}$/.test(input.trim()) ? t + 86_400_000 - 1 : t;
}

/** Name candidates from plocate, filtered and stat'ed. Sorting and paging are the caller's. */
export async function collect(locate: LocateClient, spec: QuerySpec, opts: { cap: number; now: number; stat?: (p: string) => LxRow | null }): Promise<Collected> {
  const { queries, include, exclude } = planQueries(spec);
  const lists = await Promise.all(queries.map((q) => locate.paths(q)));
  const under = spec.under ? trimSlash(spec.under) : undefined;
  const parent = spec.parent ? trimSlash(spec.parent) : undefined;
  const matchCase = spec.matchCase ?? false;
  const fold = (s: string) => (matchCase ? s : s.toLowerCase());
  const excludes = exclude.map(fold);
  const whole = spec.wholeWord ? include.map((w) => wordRe(w, matchCase)) : [];
  const extSet = spec.regex && spec.ext?.length ? new Set(spec.ext.map((e) => e.toLowerCase())) : undefined;

  // One plocate run cannot repeat a path, so only merged runs need the set.
  const seen = lists.length > 1 ? new Set<string>() : undefined;
  const names: string[] = [];
  for (const list of lists) {
    for (const p of list) {
      if (seen) {
        if (seen.has(p)) continue;
        seen.add(p);
      }
      if (under && !isUnder(p, under)) continue;
      if (parent && parentOf(p) !== parent) continue;
      const subject = spec.matchPath ? p : nameOf(p);
      if (excludes.length && excludes.some((x) => fold(subject).includes(x))) continue;
      if (whole.length && !whole.every((re) => re.test(subject))) continue;
      if (extSet) {
        const n = nameOf(p);
        const dot = n.lastIndexOf(".");
        if (dot <= 0 || !extSet.has(n.slice(dot + 1).toLowerCase())) continue;
      }
      names.push(p);
    }
  }

  const sampled = names.length > opts.cap;
  const read = sampled ? names.slice(0, opts.cap) : names;
  const after = spec.modifiedAfter ? parseWhen("--after", spec.modifiedAfter, opts.now) : undefined;
  const before = spec.modifiedBefore ? beforeMs(spec.modifiedBefore, opts.now) : undefined;
  const stat = opts.stat ?? statRow;

  const rows: LxRow[] = [];
  let gone = 0;
  for (const p of read) {
    const r = stat(p);
    if (!r) {
      gone++;
      continue;
    }
    if (spec.type === "files" && r.kind === "dir") continue;
    if (spec.type === "folders" && r.kind !== "dir") continue;
    // Folder sizes are not known per row, so size filters keep files only.
    if ((spec.larger !== undefined || spec.smaller !== undefined) && r.kind === "dir") continue;
    if (spec.larger !== undefined && r.bytes < spec.larger) continue;
    if (spec.smaller !== undefined && r.bytes > spec.smaller) continue;
    if (after !== undefined && r.mtimeMs < after) continue;
    if (before !== undefined && r.mtimeMs > before) continue;
    rows.push(r);
  }
  return { rows, matched: names.length, gone, sampled };
}

function extOf(p: string): string {
  const n = nameOf(p);
  const dot = n.lastIndexOf(".");
  return dot > 0 ? n.slice(dot + 1).toLowerCase() : "";
}

export function sortRows(rows: LxRow[], key: SortKey | undefined, ascending: boolean): LxRow[] {
  if (!key) return rows;
  const val: Record<SortKey, (r: LxRow) => number | string> = {
    size: (r) => r.size ?? -1,
    modified: (r) => r.mtimeMs,
    created: (r) => r.birthMs,
    name: (r) => nameOf(r.filename).toLowerCase(),
    path: (r) => r.filename,
    extension: (r) => extOf(r.filename),
  };
  const get = val[key];
  // Every key reads descending unless --asc, as es.exe's -sort does on main.
  return rows.toSorted((a, b) => {
    const x = get(a), y = get(b);
    const c = x < y ? -1 : x > y ? 1 : 0;
    if (c) return ascending ? c : -c;
    return a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0;
  });
}

export interface LxFindResult extends FindResult {
  gone: number;
  sampled: boolean;
}

/** Hard links count once in byte totals: they share their bytes on disk. */
function fileBytes(rows: LxRow[]): number {
  const seen = new Set<string>();
  let n = 0;
  for (const r of rows) {
    if (r.kind === "dir" || seen.has(r.id)) continue;
    seen.add(r.id);
    n += r.bytes;
  }
  return n;
}

export function toFind(c: Collected, spec: QuerySpec): LxFindResult {
  const sorted = sortRows(c.rows, spec.sort, spec.ascending ?? false);
  const offset = spec.offset ?? 0;
  const rows = sorted.slice(offset, offset + (spec.limit ?? 50)).map(withDates);
  const onlyFolders = c.rows.length > 0 && c.rows.every((r) => r.kind === "dir");
  return {
    rows,
    total: c.rows.length,
    shown: rows.length,
    totalSize: onlyFolders ? null : fileBytes(c.rows),
    truncated: c.rows.length > rows.length,
    gone: c.gone,
    sampled: c.sampled,
  };
}

export interface FolderTotals {
  /** Bytes under each folder. */
  totals: Map<string, number>;
  /** Immediate entries of each folder. */
  children: Map<string, LxRow[]>;
  grandTotal: number;
}

/**
 * Folder totals from one listing of the subtree: each file's bytes go to every
 * folder above it, up to `root`. Hard links count once.
 */
export function folderTotals(rows: LxRow[], root: string): FolderTotals {
  const totals = new Map<string, number>();
  const children = new Map<string, LxRow[]>();
  const seen = new Set<string>();
  let grandTotal = 0;
  for (const r of rows) {
    if (r.filename === root || !isUnder(r.filename, root)) continue;
    const parent = parentOf(r.filename);
    const list = children.get(parent);
    if (list) list.push(r);
    else children.set(parent, [r]);
    if (r.kind === "dir" || seen.has(r.id)) continue;
    seen.add(r.id);
    grandTotal += r.bytes;
    for (let d = parent; isUnder(d, root); d = parentOf(d)) {
      totals.set(d, (totals.get(d) ?? 0) + r.bytes);
      if (d === root || d === "/") break;
    }
  }
  return { totals, children, grandTotal };
}

function entriesOf(dir: string, t: FolderTotals): DuEntry[] {
  return (t.children.get(dir) ?? [])
    .map((r): DuEntry => ({ path: r.filename, name: nameOf(r.filename), size: r.kind === "dir" ? (t.totals.get(r.filename) ?? 0) : r.bytes, kind: r.kind === "dir" ? "folder" : "file" }))
    .sort((a, b) => b.size - a.size);
}

export function toDu(rows: LxRow[], root: string, limit: number): DuResult {
  const t = folderTotals(rows, root);
  const entries = entriesOf(root, t);
  const fileTotal = entries.filter((e) => e.kind === "file").reduce((n, e) => n + e.size, 0);
  return { root, entries: entries.slice(0, limit), folderTotal: t.grandTotal - fileTotal, fileTotal, grandTotal: t.grandTotal };
}

export function toDuTree(rows: LxRow[], root: string, depth: number, perLevel: number, minShare = 0.02): DuTreeResult {
  const t = folderTotals(rows, root);
  const level = (dir: string, remaining: number, d: number, parentTotal: number): DuEntryTree[] =>
    entriesOf(dir, t).slice(0, perLevel).map((e) => {
      const node: DuEntryTree = { ...e, depth: d };
      if (remaining > 1 && e.kind === "folder" && e.size >= parentTotal * minShare) node.children = level(e.path, remaining - 1, d + 1, e.size);
      return node;
    });
  return { root, entries: level(root, depth, 0, t.grandTotal), grandTotal: t.grandTotal, depth, perLevel, minShare };
}

export function toExt(c: Collected, cap: number): { entries: ExtEntry[]; scanned: number; total: number; sampled: boolean } {
  const files = c.rows.filter((r) => r.kind !== "dir");
  const acc = new Map<string, ExtEntry>();
  for (const r of files) {
    const ext = extOf(r.filename) || "(none)";
    const cur = acc.get(ext) ?? { ext, count: 0, size: 0 };
    cur.count += 1;
    cur.size += r.bytes;
    acc.set(ext, cur);
  }
  return { entries: [...acc.values()].sort((a, b) => b.size - a.size), scanned: files.length, total: c.sampled ? c.matched : files.length, sampled: c.sampled || files.length > cap };
}

export function toDupes(parts: Collected[]): DupesResult {
  const rows = parts.flatMap((p) => p.rows).filter((r) => r.kind === "file");
  const ids = new Map(rows.map((r) => [r.filename, r.id]));
  return {
    ...foldDupes(nameSizeGroups(rows), ids),
    scanned: rows.length,
    total: parts.reduce((n, p) => n + p.matched, 0),
    sampled: parts.some((p) => p.sampled),
  };
}

/** Content search: the index names candidate files, then they are read in path order. */
export async function grepLinux(
  locate: LocateClient,
  spec: QuerySpec,
  pattern: { literal?: string; regex?: string },
  opts: GrepOptions & { now: number; stat?: (p: string) => LxRow | null },
): Promise<MainGrepResult> {
  const c = await collect(locate, { ...spec, type: "files", smaller: Math.min(spec.smaller ?? GREP_MAX_BYTES, GREP_MAX_BYTES) }, { cap: Number.MAX_SAFE_INTEGER, now: opts.now, ...(opts.stat ? { stat: opts.stat } : {}) });
  const skips = SKIPPED_DIRS.map((d) => d.replaceAll("\\", "/"));
  let skippedDirs = 0;
  const paths: string[] = [];
  for (const r of c.rows) {
    if (r.kind !== "file") continue;
    if (!opts.allDirs && skips.some((d) => r.filename.includes(d))) skippedDirs++;
    else paths.push(r.filename);
  }
  paths.sort();
  const eligible = paths.slice(0, opts.cap);
  return readCandidates(eligible, { candidates: paths.length, capped: paths.length > eligible.length, skippedDirs, index: "the plocate index" }, spec, pattern, opts);
}
