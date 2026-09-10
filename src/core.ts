// Actions. Never prints — frontends decide rendering.

import { type EsClient, type EsRow } from "./es.ts";
import { buildArgs, buildCountArgs, type QuerySpec } from "./query.ts";

export interface FindResult {
  rows: EsRow[];
  total: number;
  shown: number;
  totalSize: number;
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
  return { rows, total, shown: rows.length, totalSize, truncated: total > rows.length };
}

export function count(es: EsClient, spec: QuerySpec): Promise<number> {
  return es.count(buildCountArgs(spec));
}

export function totalSize(es: EsClient, spec: QuerySpec): Promise<number> {
  return es.totalSize(buildCountArgs(spec));
}

export interface DuEntry {
  path: string;
  name: string;
  size: number;
  kind: "folder" | "file";
}

export interface DuResult {
  root: string;
  entries: DuEntry[];
  folderTotal: number;
  fileTotal: number;
  grandTotal: number;
}

function leafName(p: string): string {
  const trimmed = p.replace(/\\+$/, "");
  const i = trimmed.lastIndexOf("\\");
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

/**
 * Immediate children by size. Everything 1.5a indexes folder sizes
 * (index_folder_size=1), so folder totals come straight from the index rather
 * than a recursive walk — this is the whole reason `du` is instant.
 */
export async function du(es: EsClient, root: string, limit = 40): Promise<DuResult> {
  const base: QuerySpec = { terms: [], parent: root, sort: "size", limit };
  const [folders, files] = await Promise.all([
    es.rows(buildArgs({ ...base, type: "folders" }, ["-size"])),
    es.rows(buildArgs({ ...base, type: "files" }, ["-size"])),
  ]);

  const entries: DuEntry[] = [
    ...folders.map((r): DuEntry => ({ path: r.filename, name: leafName(r.filename), size: r.size ?? 0, kind: "folder" })),
    ...files.map((r): DuEntry => ({ path: r.filename, name: leafName(r.filename), size: r.size ?? 0, kind: "file" })),
  ].sort((a, b) => b.size - a.size);

  const folderTotal = folders.reduce((s, r) => s + (r.size ?? 0), 0);
  const fileTotal = files.reduce((s, r) => s + (r.size ?? 0), 0);
  return { root, entries: entries.slice(0, limit), folderTotal, fileTotal, grandTotal: folderTotal + fileTotal };
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
}

/**
 * Same-name, same-size candidates. This is a candidate set, not proof: matching
 * name and byte count is strong evidence, not a content hash. A caller that
 * needs certainty must hash the paths this returns.
 */
export async function dupes(
  es: EsClient,
  spec: QuerySpec,
  cap = 50_000,
): Promise<{ groups: DupeGroup[]; scanned: number; wastedTotal: number }> {
  const rows = await es.rows(buildArgs({ ...spec, type: "files", sort: "size", limit: cap }, ["-size"]));

  const acc = new Map<string, { name: string; size: number; paths: string[] }>();
  for (const r of rows) {
    const size = r.size ?? 0;
    if (size <= 0) continue;
    const name = leafName(r.filename).toLowerCase();
    const key = `${name} ${size}`;
    const cur = acc.get(key) ?? { name: leafName(r.filename), size, paths: [] };
    cur.paths.push(r.filename);
    acc.set(key, cur);
  }

  const groups: DupeGroup[] = [];
  for (const g of acc.values()) {
    if (g.paths.length < 2) continue;
    groups.push({ name: g.name, size: g.size, paths: g.paths, wasted: g.size * (g.paths.length - 1) });
  }
  groups.sort((a, b) => b.wasted - a.wasted);
  return { groups, scanned: rows.length, wastedTotal: groups.reduce((s, g) => s + g.wasted, 0) };
}

export interface DoctorReport {
  ok: boolean;
  exe: string;
  instance: string;
  everythingVersion?: string;
  indexedFiles?: number;
  error?: string;
}

export async function doctor(es: EsClient, exe: string, instance: string): Promise<DoctorReport> {
  try {
    const indexedFiles = await es.count([]);
    let everythingVersion: string | undefined;
    try {
      everythingVersion = (await es.version()).trim() || undefined;
    } catch {
      // Not every instance answers -get-everything-version; not fatal.
    }
    return { ok: true, exe, instance, everythingVersion, indexedFiles };
  } catch (err) {
    return { ok: false, exe, instance, error: err instanceof Error ? err.message : String(err) };
  }
}
