// Pure: ergonomic flags in, es.exe argv out. No IO, no spawning.

export type SortKey = "size" | "name" | "path" | "modified" | "created" | "extension";
export type TypeFilter = "files" | "folders" | "all";

export interface QuerySpec {
  terms: string[];
  ext?: string[];
  under?: string;
  parent?: string;
  larger?: number;
  smaller?: number;
  modifiedAfter?: string;
  modifiedBefore?: string;
  type?: TypeFilter;
  regex?: boolean;
  matchCase?: boolean;
  wholeWord?: boolean;
  matchPath?: boolean;
  sort?: SortKey;
  ascending?: boolean;
  limit?: number;
  offset?: number;
}

const SORT_FIELD: Record<SortKey, string> = {
  size: "size",
  name: "name",
  path: "path",
  modified: "date-modified",
  created: "date-created",
  extension: "extension",
};

/** Sizes agents actually type: 500, 10k, 1.5G, 2tb. */
export function parseSize(input: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb|t|tb)?$/i.exec(input.trim());
  if (!m) throw new Error(`bad size ${JSON.stringify(input)} — use forms like 500, 10K, 1.5G, 2TB`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "b").toLowerCase();
  const mult: Record<string, number> = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4 };
  return Math.round(n * mult[unit]!);
}

/**
 * Everything treats a bare date as a day and reads 2026-10-01T10:00 as a time.
 * A space inside the token makes ES match nothing, so "2026-10-01 10:00" becomes
 * the T form and any other space is refused.
 */
function normalizeDate(input: string): string {
  const d = input.trim().replace(/^(\d{4}-\d{2}-\d{2})\s+(\d)/, "$1T$2");
  if (/\s/.test(d)) throw new Error(`bad date ${JSON.stringify(input)} — use forms without spaces: 2026-10-01, 2026-10-01T10:00, today, lastweek`);
  return d;
}

/**
 * One user argument as Everything search words. Whitespace separates words,
 * which Everything ANDs as its search box does, so `ev find "walking dead"`
 * matches `The.Walking.Dead.S01E01.mkv`. A "double-quoted" run stays one word,
 * which Everything reads as a phrase.
 *
 * Returned words never contain quote characters. Bun quotes an argv token that
 * contains a space when it builds the Windows command line, and ES reads that
 * token as a phrase. A token that already contains quotes reaches ES as \"...\"
 * and matches nothing, which is what `ev find "red dead"` did before.
 */
export function queryWords(term: string): string[] {
  return (term.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((w) => w.replaceAll('"', "")).filter(Boolean);
}

/**
 * The Everything search-syntax half of the query, as separate argv tokens.
 *
 * ES joins multiple non-switch arguments into one search, but a SINGLE argument
 * containing spaces is treated as one literal phrase. Passing "ext:mkv size:>1gb"
 * as one token matches nothing; passing them as two tokens matches correctly.
 */
export function buildSearchTokens(spec: QuerySpec): string[] {
  // A regex is one pattern: "red dead|walking dead" split into words would AND the pieces.
  const parts = spec.regex ? spec.terms.filter((t) => t.trim()) : spec.terms.flatMap(queryWords);
  if (spec.ext?.length) parts.push(`ext:${spec.ext.join(";")}`);
  if (spec.larger !== undefined) parts.push(`size:>=${spec.larger}`);
  if (spec.smaller !== undefined) parts.push(`size:<=${spec.smaller}`);
  if (spec.modifiedAfter) parts.push(`dm:>=${normalizeDate(spec.modifiedAfter)}`);
  if (spec.modifiedBefore) parts.push(`dm:<=${normalizeDate(spec.modifiedBefore)}`);
  return parts;
}

/** Full argv for es.exe, search text last (ES joins trailing non-switch args). */
export function buildArgs(spec: QuerySpec, columns: string[] = ["-size", "-dm"]): string[] {
  const args: string[] = [];

  if (spec.under) args.push("-path", spec.under);
  if (spec.parent) args.push("-parent", spec.parent);

  if (spec.type === "folders") args.push("/ad");
  else if (spec.type === "files") args.push("/a-d");

  if (spec.regex) args.push("-regex");
  if (spec.matchCase) args.push("-case");
  if (spec.wholeWord) args.push("-whole-word");
  if (spec.matchPath) args.push("-match-path");

  if (spec.sort) {
    const dir = spec.ascending ? "ascending" : "descending";
    args.push("-sort", `${SORT_FIELD[spec.sort]}-${dir}`);
  }
  if (spec.limit !== undefined) args.push("-n", String(spec.limit));
  if (spec.offset) args.push("-o", String(spec.offset));

  args.push(...columns);
  args.push(...buildSearchTokens(spec));
  return args;
}

/** Query-only argv, for -get-result-count / -get-total-size (they reject -n and columns). */
export function buildCountArgs(spec: QuerySpec): string[] {
  const args: string[] = [];
  if (spec.under) args.push("-path", spec.under);
  if (spec.parent) args.push("-parent", spec.parent);
  if (spec.type === "folders") args.push("/ad");
  else if (spec.type === "files") args.push("/a-d");
  if (spec.regex) args.push("-regex");
  if (spec.matchCase) args.push("-case");
  if (spec.wholeWord) args.push("-whole-word");
  if (spec.matchPath) args.push("-match-path");
  args.push(...buildSearchTokens(spec));
  return args;
}
