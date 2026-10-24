// Actions. Never prints — frontends decide rendering.

import { type EsClient, type EsRow } from "./es.ts";
import { buildArgs, buildCountArgs, type QuerySpec } from "./query.ts";

export interface FindResult {
  rows: EsRow[];
  total: number;
  shown: number;
  totalSize: number | null;
  truncated: boolean;
}

/** A search plus the totals, so a capped result set still reports the true scale. */
export async function find(es: EsClient, spec: QuerySpec): Promise<FindResult> {
  const countArgs = buildCountArgs(spec);
  const [rows, total, totalSize] = await Promise.all([
    es.rows(buildArgs(spec)),
    es.count(countArgs),
    es.totalSize(countArgs),
  ]);
  // An empty result set has no size, so ES reports the unknown-size sentinel.
  return { rows, total, shown: rows.length, totalSize: total === 0 ? 0 : totalSize, truncated: total > rows.length };
}

export function count(es: EsClient, spec: QuerySpec): Promise<number> {
  return es.count(buildCountArgs(spec));
}

/**
 * ES answers -get-total-size with the unknown-size sentinel for an empty result
 * set as well as for a genuinely unknown size. A folder with no loose files hit
 * the first case, and `du` reported it as missing index data. Zero matches
 * means zero bytes.
 */
async function indexedBytes(es: EsClient, query: string[]): Promise<number | null> {
  const size = await es.totalSize(query);
  if (size !== null) return size;
  return (await es.count(query)) === 0 ? 0 : null;
}

export function totalSize(es: EsClient, spec: QuerySpec): Promise<number | null> {
  return indexedBytes(es, buildCountArgs(spec));
}

export interface DuEntry {
  path: string;
  name: string;
  size: number;
  kind: "folder" | "file";
}

export interface DuEntryTree extends DuEntry {
  depth: number;
  children?: DuEntryTree[];
}

export interface DuResult {
  root: string;
  entries: DuEntry[];
  folderTotal: number;
  fileTotal: number;
  grandTotal: number;
}

export interface DuTreeResult {
  root: string;
  entries: DuEntryTree[];
  grandTotal: number;
  depth: number;
  /** Rows kept per folder, and the share of its parent a folder needs to be expanded. */
  perLevel: number;
  minShare: number;
}

/** The last path component, for Windows (\) and Linux (/) paths alike. */
function leafName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

/**
 * Immediate children by size. Everything 1.5a indexes folder sizes
 * (index_folder_size=1), so folder totals come straight from the index rather
 * than a recursive walk — this is the whole reason `du` is instant.
 */
export async function du(es: EsClient, root: string, limit = 40): Promise<DuResult> {
  const base: QuerySpec = { terms: [], parent: root, sort: "size", limit };
  const [folders, files, grandTotal, fileTotal] = await Promise.all([
    es.rows(buildArgs({ ...base, type: "folders" }, ["-size"])),
    es.rows(buildArgs({ ...base, type: "files" }, ["-size"])),
    // ES returns an unknown-size sentinel when a total includes folders.
    // Sum indexed files under the root instead, independently of display caps.
    indexedBytes(es, buildCountArgs({ terms: [], under: root, type: "files" })),
    indexedBytes(es, buildCountArgs({ terms: [], parent: root, type: "files" })),
  ]);

  const entries: DuEntry[] = [
    ...folders.map((r): DuEntry => ({ path: r.filename, name: leafName(r.filename), size: r.size ?? 0, kind: "folder" })),
    ...files.map((r): DuEntry => ({ path: r.filename, name: leafName(r.filename), size: r.size ?? 0, kind: "file" })),
  ].sort((a, b) => b.size - a.size);

  if (grandTotal === null || fileTotal === null) throw new Error("Everything did not report indexed file sizes for this directory");
  const folderTotal = grandTotal - fileTotal;
  return { root, entries: entries.slice(0, limit), folderTotal, fileTotal, grandTotal };
}

export interface ExtEntry {
  ext: string;
  count: number;
  size: number;
}

/**
 * Size and count grouped by extension. Everything cannot aggregate, so this
 * pulls a bounded set of the largest files and groups client-side. The cap keeps
 * a query over a million-file tree from turning into a million-row fetch;
 * `sampled` says whether the answer covers every match.
 */
export async function byExtension(
  es: EsClient,
  spec: QuerySpec,
  cap = 50_000,
): Promise<{ entries: ExtEntry[]; scanned: number; total: number; sampled: boolean }> {
  const total = await es.count(buildCountArgs({ ...spec, type: "files" }));
  const rows = await es.rows(buildArgs({ ...spec, type: "files", sort: "size", limit: cap }, ["-size"]));

  const acc = new Map<string, ExtEntry>();
  for (const r of rows) {
    const name = leafName(r.filename);
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "(none)";
    const cur = acc.get(ext) ?? { ext, count: 0, size: 0 };
    cur.count += 1;
    cur.size += r.size ?? 0;
    acc.set(ext, cur);
  }
  const entries = [...acc.values()].sort((a, b) => b.size - a.size);
  return { entries, scanned: rows.length, total, sampled: total > rows.length };
}

export interface DupeGroup {
  name: string;
  size: number;
  paths: string[];
  wasted: number;
  /** Paths that already share an inode with another path in the group. */
  linked?: number;
}

/**
 * Returns a file identity (volume and file index), or null when the path
 * cannot be read. Two paths with the same identity are one file on disk.
 */
export type Identify = (path: string) => Promise<string | null>;

export interface DupesResult {
  groups: DupeGroup[];
  scanned: number;
  total: number;
  sampled: boolean;
  wastedTotal: number;
  /** Bytes the index double-counts because hard links already share them. Present when identities were checked. */
  linkedTotal?: number;
}

/**
 * Same-name, same-size candidates. This is a candidate set, not proof: matching
 * name and byte count is strong evidence, not a content hash. A caller that
 * needs certainty must hash the paths this returns.
 *
 * `roots` scopes the search to several subtrees at once, which is what a mirror
 * between two folders needs: `-path` takes one subtree, so each root is its own
 * query and the rows are merged before grouping.
 */
export async function dupes(
  es: EsClient,
  spec: QuerySpec,
  cap = 50_000,
  roots: string[] = [],
  identify?: Identify,
): Promise<DupesResult> {
  const scopes: QuerySpec[] = roots.length ? roots.map((under) => ({ ...spec, under })) : [spec];
  const parts = await Promise.all(scopes.map(async (s) => {
    const [rows, total] = await Promise.all([
      es.rows(buildArgs({ ...s, type: "files", sort: "size", limit: cap }, ["-size"])),
      es.count(buildCountArgs({ ...s, type: "files" })),
    ]);
    return { rows, total, sampled: total > rows.length };
  }));

  const candidates = nameSizeGroups(parts.flatMap((p) => p.rows));

  // Everything sees names, not inodes, so a hard-linked library looks like a
  // full copy. Stat the candidates and count each file once.
  let ids: Map<string, string> | undefined;
  if (identify) {
    ids = new Map();
    const paths = candidates.flatMap((g) => g.paths);
    for (let i = 0; i < paths.length; i += 64) {
      const batch = paths.slice(i, i + 64);
      const got = await Promise.all(batch.map(identify));
      batch.forEach((p, j) => ids!.set(p, got[j] ?? `unreadable:${p}`));
    }
  }

  return {
    ...foldDupes(candidates, ids),
    scanned: parts.reduce((n, p) => n + p.rows.length, 0),
    total: parts.reduce((n, p) => n + p.total, 0),
    sampled: parts.some((p) => p.sampled),
  };
}

/** Pure: same-name (case-insensitive), same-size files with at least two paths. */
export function nameSizeGroups(rows: Array<{ filename: string; size?: number }>): Array<{ name: string; size: number; paths: string[] }> {
  const seen = new Set<string>();
  const acc = new Map<string, { name: string; size: number; paths: string[] }>();
  for (const r of rows) {
    const size = r.size ?? 0;
    if (size <= 0 || seen.has(r.filename.toLowerCase())) continue;
    seen.add(r.filename.toLowerCase());
    const name = leafName(r.filename);
    const key = `${name.toLowerCase()} ${size}`;
    const cur = acc.get(key) ?? { name, size, paths: [] };
    cur.paths.push(r.filename);
    acc.set(key, cur);
  }
  return [...acc.values()].filter((g) => g.paths.length >= 2);
}

/**
 * Pure: fold paths that share a file identity (hard links) and rank by
 * reclaimable bytes. Without `ids`, every path counts as its own copy.
 */
export function foldDupes(
  candidates: Array<{ name: string; size: number; paths: string[] }>,
  ids?: Map<string, string>,
): Pick<DupesResult, "groups" | "wastedTotal" | "linkedTotal"> {
  const groups: DupeGroup[] = [];
  let linkedTotal = 0;
  for (const g of candidates) {
    const distinct = ids ? new Set(g.paths.map((p) => ids.get(p) ?? `unreadable:${p}`)).size : g.paths.length;
    const linked = g.paths.length - distinct;
    linkedTotal += g.size * linked;
    if (distinct < 2) continue;
    groups.push({ name: g.name, size: g.size, paths: g.paths, wasted: g.size * (distinct - 1), ...(ids ? { linked } : {}) });
  }
  groups.sort((a, b) => b.wasted - a.wasted);
  return { ...(ids ? { linkedTotal } : {}), groups, wastedTotal: groups.reduce((s, g) => s + g.wasted, 0) };
}

export interface DoctorReport {
  ok: boolean;
  exe: string;
  /** The instance that answered. Differs from `requested` when a fallback won. */
  instance: string;
  requested?: string;
  everythingVersion?: string;
  indexedFiles?: number;
  error?: string;
}

export async function doctor(es: EsClient, exe: string, instance: string): Promise<DoctorReport> {
  try {
    const indexedFiles = await es.count([]);
    const actual = es.resolvedInstance();
    let everythingVersion: string | undefined;
    try {
      everythingVersion = (await es.version()).trim() || undefined;
    } catch {
      // Not every instance answers -get-everything-version; not fatal.
    }
    return { ok: true, exe, instance: actual, requested: instance, everythingVersion, indexedFiles };
  } catch (err) {
    return { ok: false, exe, instance, error: err instanceof Error ? err.message : String(err) };
  }
}


/**
 * Recursive rollup. Each level is one indexed query, so depth is cheap — but
 * the branching is not, so only folders holding at least `minShare` of their
 * parent are expanded. That keeps "what is eating this drive" to the few
 * branches that actually answer it instead of walking the whole tree.
 */
export async function duTree(
  es: EsClient,
  root: string,
  depth = 2,
  perLevel = 12,
  minShare = 0.02,
): Promise<DuTreeResult> {
  async function level(path: string, remaining: number, d: number): Promise<{ entries: DuEntryTree[]; grandTotal: number }> {
    const r = await du(es, path, perLevel);
    const out: DuEntryTree[] = [];
    for (const e of r.entries) {
      const node: DuEntryTree = { ...e, depth: d };
      if (remaining > 1 && e.kind === "folder" && e.size >= r.grandTotal * minShare) {
        node.children = (await level(e.path, remaining - 1, d + 1)).entries;
      }
      out.push(node);
    }
    return { entries: out, grandTotal: r.grandTotal };
  }

  const { entries, grandTotal } = await level(root, depth, 0);
  return { root, entries, grandTotal, depth, perLevel, minShare };
}
