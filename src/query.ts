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

/** Everything treats a bare date as a day; pass through what it already understands. */
function normalizeDate(input: string): string {
  return /\s/.test(input) ? `"${input}"` : input;
}

/**
 * The Everything search-syntax half of the query, as separate argv tokens.
 *
 * ES joins multiple non-switch arguments into one search, but a SINGLE argument
 * containing spaces is treated as one literal phrase. Passing "ext:mkv size:>1gb"
 * as one token matches nothing; passing them as two tokens matches correctly.
 * A user term that contains spaces is quoted so Everything reads it as a phrase.
 */
export function buildSearchTokens(spec: QuerySpec): string[] {
  const parts: string[] = [];
  for (const t of spec.terms) {
    if (!t.trim()) continue;
    parts.push(/\s/.test(t) && !/^".*"$/.test(t) ? `"${t}"` : t);
  }
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
