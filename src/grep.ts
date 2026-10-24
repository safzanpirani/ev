// Content search on main. Everything indexes names, not contents, so the index
// names the candidate files (with every name, size, date and folder filter) and
// ev reads them from disk. A drive-wide walk never happens: the read set is the
// filtered candidate list, capped.

import type { EsClient } from "./es.ts";
import type { FsGrepFile } from "./fsearch.ts";
import { buildArgs, buildCountArgs, type QuerySpec } from "./query.ts";

/** Folders whose files are dependencies or VCS internals, not what a search is after. */
export const SKIPPED_DIRS = ["\\node_modules\\", "\\.git\\", "\\site-packages\\", "\\__pycache__\\", "\\venv\\", "\\.venv\\"];
/** Larger files are logs, dumps and models; a line search over them is rarely the question. */
export const GREP_MAX_BYTES = 10 * 1024 ** 2;
const BINARY_SNIFF = 8000;
const MAX_LINE = 300;

export type ReadFile = (path: string) => Promise<Uint8Array | null>;

export const readFromDisk: ReadFile = async (path) => {
  try {
    return await Bun.file(path).bytes();
  } catch {
    return null;
  }
};

export interface MainGrepResult {
  files: FsGrepFile[];
  /** Files the index matched on name filters, before the cap. */
  candidates: number;
  /** Candidates read before the search stopped. */
  read: number;
  /** Candidates under SKIPPED_DIRS, not read. */
  skippedDirs: number;
  /** Read but not searched: NUL bytes in the first 8000 (binary or UTF-16). */
  binary: number;
  unreadable: number;
  /** False when matching files filled -n before every candidate was read. */
  complete: boolean;
  /** True when more candidates matched the filters than --cap allowed to be read. */
  capped: boolean;
  shown: number;
  offset: number;
  /** Which index named the candidates, for the summary line. */
  index: string;
}

export interface GrepOptions {
  cap: number;
  allDirs?: boolean;
  read?: ReadFile;
  concurrency?: number;
}

function matcher(pattern: { literal?: string; regex?: string }, matchCase: boolean): (line: string) => boolean {
  if (pattern.regex !== undefined) {
    const re = new RegExp(pattern.regex, matchCase ? "" : "i");
    return (line) => re.test(line);
  }
  const lit = pattern.literal ?? "";
  if (matchCase) return (line) => line.includes(lit);
  const needle = lit.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}

export async function grepMain(
  es: EsClient,
  spec: QuerySpec,
  pattern: { literal?: string; regex?: string },
  opts: GrepOptions,
): Promise<MainGrepResult> {
  const base: QuerySpec = {
    ...spec,
    type: "files",
    smaller: Math.min(spec.smaller ?? GREP_MAX_BYTES, GREP_MAX_BYTES),
    sort: "path",
    ascending: true,
    limit: opts.cap,
    offset: undefined,
  };
  // Exclude dependency folders in the query itself, so they never eat the cap: a
  // project's .venv sorts before its src. A name regex would read !\venv\ as a
  // pattern, so that case filters the listing instead.
  const skipInQuery = !opts.allDirs && !spec.regex;
  const candidateSpec: QuerySpec = skipInQuery ? { ...base, terms: [...spec.terms, ...SKIPPED_DIRS.map((d) => `!${d}`)] } : base;
  const [rows, candidates, unskipped] = await Promise.all([
    es.rows(buildArgs(candidateSpec, [])),
    es.count(buildCountArgs(candidateSpec)),
    skipInQuery ? es.count(buildCountArgs(base)) : Promise.resolve(0),
  ]);

  const lowerSkips = SKIPPED_DIRS.map((d) => d.toLowerCase());
  const paths: string[] = [];
  let skippedDirs = skipInQuery ? Math.max(0, unskipped - candidates) : 0;
  for (const r of rows) {
    if (!opts.allDirs && lowerSkips.some((d) => r.filename.toLowerCase().includes(d))) skippedDirs++;
    else paths.push(r.filename);
  }

  return readCandidates(paths, { candidates, capped: candidates > rows.length, skippedDirs, index: "the Everything index" }, spec, pattern, opts);
}

/** Read candidate files in order and keep the ones with matching lines. Shared by every backend. */
export async function readCandidates(
  paths: string[],
  listing: Pick<MainGrepResult, "candidates" | "capped" | "skippedDirs" | "index">,
  spec: QuerySpec,
  pattern: { literal?: string; regex?: string },
  opts: GrepOptions,
): Promise<MainGrepResult> {
  const test = matcher(pattern, spec.matchCase ?? false);
  const offset = spec.offset ?? 0;
  const want = offset + (spec.limit ?? 50);
  const read = opts.read ?? readFromDisk;
  const concurrency = opts.concurrency ?? 16;

  const files: FsGrepFile[] = [];
  let readCount = 0;
  let binary = 0;
  let unreadable = 0;
  let next = 0;
  // Batches keep results in path order and let the search stop once -n files matched.
  while (next < paths.length && files.length < want) {
    const batch = paths.slice(next, next + concurrency);
    next += batch.length;
    const found = await Promise.all(batch.map(async (path): Promise<FsGrepFile | null> => {
      const bytes = await read(path);
      readCount++;
      if (!bytes) {
        unreadable++;
        return null;
      }
      if (bytes.subarray(0, BINARY_SNIFF).includes(0)) {
        binary++;
        return null;
      }
      const matches: FsGrepFile["matches"] = [];
      const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (test(line)) matches.push({ line: i + 1, text: line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line });
      }
      return matches.length ? { path, matches } : null;
    }));
    for (const f of found) if (f) files.push(f);
  }

  const shownFiles = files.slice(offset, want);
  return {
    ...listing,
    files: shownFiles,
    read: readCount,
    binary,
    unreadable,
    complete: next >= paths.length,
    shown: shownFiles.length,
    offset,
  };
}

/** The summary, then one `-- ` line per caveat, as dupes prints its footers. */
export function mainGrepSummary(r: MainGrepResult, cap: number): string {
  const files = `${r.shown.toLocaleString()} file${r.shown === 1 ? "" : "s"} with matches`;
  const work = `read ${r.read.toLocaleString()} of ${r.candidates.toLocaleString()} candidate files (under ${GREP_MAX_BYTES / 1024 ** 2}M) named by ${r.index}`;
  const notes = [
    !r.complete ? "Stopped once -n files matched. Raise -n or page with --offset for more." : "",
    r.capped ? `Only the first ${cap.toLocaleString()} candidates by path were eligible. Narrow with --under/--ext or raise --cap.` : "",
    r.skippedDirs ? `${r.skippedDirs.toLocaleString()} files under node_modules, .git, site-packages or venv were not read (--all-dirs reads them).` : "",
    r.binary ? `${r.binary.toLocaleString()} binary or UTF-16 files were skipped.` : "",
    r.unreadable ? `${r.unreadable.toLocaleString()} files could not be read.` : "",
  ].filter(Boolean);
  return [`-- ${files}; ${work}.`, ...notes.map((n) => `-- ${n}`)].join("\n");
}
