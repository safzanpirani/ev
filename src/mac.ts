// macOS actions over fsearch. Never prints — frontends decide rendering.
//
// Everything answers counts, total sizes and sorted pages directly. fsearch
// answers one thing: the top `limit` hits by relevance. Everything else here
// is built from that, and each answer says whether it is exact:
//
// - totals come from fetching up to a cap; past the cap a total is a lower bound
//   (`totalExact: false`) and the total size is unknown (null), never a guess;
// - "largest" and "newest" pages are exact even past the cap: a size or age
//   threshold is narrowed until the matches above it fit in one fetch;
// - sorts with no threshold to narrow by (name, path, extension, ascending)
//   need the whole match set and refuse when it exceeds the cap.

import type { EsRow } from "./es.ts";
import type { ExtEntry, FindResult } from "./core.ts";
import type { QuerySpec, SortKey } from "./query.ts";
import { buildFsQuery, parseWhen, UnsupportedFlag } from "./fsquery.ts";
import type { DaemonFacts, FsearchClient, FsGrepReply, FsHit, FsStatus } from "./fsearch.ts";
import { FsearchError } from "./fsearch.ts";

/** Matches fetched to count a find. Pinned: 10,000 hits is ~1.7 MB of JSON and ~35 ms on a 4M-entry index. */
export const FIND_TOTAL_CAP = 10_000;

export interface MacFindResult extends FindResult {
  /** False when there were more matches than ev fetched: `total` is then a lower bound and `totalSize` is null. */
  totalExact: boolean;
}

/** Local ISO-8601 without a zone, the shape es -date-format 1 gives on main. */
export function isoLocal(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The same row shape es produces. Folders carry no size: fsearch keeps no folder rollups and reports 0. */
export function toRow(h: FsHit): EsRow {
  const row: EsRow = { filename: h.path };
  if (h.kind !== "dir") row.size = h.size;
  row.date_modified = isoLocal(h.mtime);
  return row;
}

/** Bytes of the files among `hits`. Folders report 0 and symlinks their own length, so neither counts. */
function fileBytes(hits: FsHit[]): number {
  return hits.reduce((n, h) => n + (h.kind === "file" ? h.size : 0), 0);
}

interface Fetched {
  hits: FsHit[];
  /** True when every match came back. */
  complete: boolean;
}

/** Up to `cap` matches, asking for one more so a set of exactly `cap` is known to be complete. */
async function fetchSet(fs: FsearchClient, spec: QuerySpec, cap: number, now: number): Promise<Fetched> {
  const hits = await fs.search(buildFsQuery(spec, { limit: cap + 1, now }));
  return hits.length > cap ? { hits: hits.slice(0, cap), complete: false } : { hits, complete: true };
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function extOf(p: string): string {
  const n = baseName(p);
  const dot = n.lastIndexOf(".");
  return dot > 0 ? n.slice(dot + 1).toLowerCase() : "";
}

const COMPARE: Partial<Record<SortKey, (a: FsHit, b: FsHit) => number>> = {
  size: (a, b) => a.size - b.size,
  modified: (a, b) => a.mtime - b.mtime,
  name: (a, b) => baseName(a.path).toLowerCase().localeCompare(baseName(b.path).toLowerCase()),
  path: (a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()),
  extension: (a, b) => extOf(a.path).localeCompare(extOf(b.path)),
};

/** Like es: descending unless --asc, ties broken by path so pages are stable. */
export function sortHits(hits: FsHit[], key: SortKey, ascending = false): FsHit[] {
  const cmp = COMPARE[key];
  if (!cmp) throw new UnsupportedFlag(`--sort ${key}`, "fsearch's index records modification time only");
  const dir = ascending ? 1 : -1;
  return [...hits].sort((a, b) => dir * cmp(a, b) || a.path.localeCompare(b.path));
}

type TopKey = "size" | "modified";

/** Thresholds, narrowest first. The last one matches everything. */
const SIZE_FLOORS = [1e12, 1e11, 1e10, 1e9, 1e8, 1e7, 1e6, 1e5, 1e4, 1e3, 1, 0];
const AGE_ALL = 4_294_967_295;
const AGE_STEPS = [3600, 21_600, 86_400, 604_800, 2_592_000, 31_536_000, 315_360_000, AGE_ALL];

/**
 * The spec restricted to items at least `t` bytes, or at most `t` seconds old.
 * null when the restriction leaves nothing (it falls outside --smaller or --before).
 */
function restrict(spec: QuerySpec, key: TopKey, t: number, now: number): QuerySpec | null {
  if (key === "size") {
    if (spec.smaller !== undefined && t > spec.smaller) return null;
    return t <= (spec.larger ?? 0) ? spec : { ...spec, larger: t };
  }
  if (t >= AGE_ALL) return spec;
  if (spec.modifiedBefore !== undefined && t < Math.floor((now - parseWhen("--before", spec.modifiedBefore, now)) / 1000)) return null;
  if (spec.modifiedAfter !== undefined) {
    const own = Math.floor((now - parseWhen("--after", spec.modifiedAfter, now)) / 1000);
    if (own <= t) return spec;
  }
  return { ...spec, modifiedAfter: `${t}s` };
}

/**
 * The exact top `need` matches by size or by modification time, descending,
 * whatever the number of matches. A threshold is narrowed until the matches
 * above it are at least `need` and fit in one fetch; bisection handles a
 * band too crowded for the fixed steps.
 */
export async function topBy(fs: FsearchClient, spec: QuerySpec, need: number, key: TopKey, now: number): Promise<FsHit[]> {
  const cap = Math.max(need * 2, need + 1000);
  const run = async (t: number): Promise<Fetched> => {
    const narrowed = restrict(spec, key, t, now);
    return narrowed ? fetchSet(fs, narrowed, cap, now) : { hits: [], complete: true };
  };
  const take = (hits: FsHit[]) => sortHits(hits, key).slice(0, need);
  const steps = key === "size" ? SIZE_FLOORS : AGE_STEPS;

  // `narrow` is the tightest threshold seen with fewer than `need` matches, all fetched.
  let narrow = { t: key === "size" ? Number.MAX_SAFE_INTEGER : 0, hits: [] as FsHit[] };
  for (const t of steps) {
    const r = await run(t);
    if (r.complete && r.hits.length < need) {
      narrow = { t, hits: r.hits };
      continue;
    }
    if (r.complete) return take(r.hits);

    // Overflow at t, too few at narrow.t: bisect between them.
    let broad = { t, hits: r.hits };
    while (Math.abs(narrow.t - broad.t) > 1) {
      const m = Math.floor((narrow.t + broad.t) / 2);
      const rm = await run(m);
      if (!rm.complete) broad = { t: m, hits: rm.hits };
      else if (rm.hits.length < need) narrow = { t: m, hits: rm.hits };
      else return take(rm.hits);
    }
    // Adjacent thresholds: every match beyond `narrow` is in narrow.hits, and
    // the rest of broad.hits tie exactly at the boundary, so any of them will do.
    const have = new Set(narrow.hits.map((h) => h.path));
    return take([...narrow.hits, ...broad.hits.filter((h) => !have.has(h.path))]);
  }
  return take(narrow.hits);
}

export interface FindOptions {
  now: number;
  /** Matches fetched to compute the total. */
  totalCap?: number;
}

/** A search with the same result shape as the es backend, plus whether the total is exact. */
export async function find(fs: FsearchClient, spec: QuerySpec, opts: FindOptions): Promise<MacFindResult> {
  const offset = spec.offset ?? 0;
  const limit = spec.limit ?? 50;
  const need = offset + limit;
  const cap = Math.max(need, opts.totalCap ?? FIND_TOTAL_CAP);

  if (spec.sort === "created") throw new UnsupportedFlag("--sort created", "fsearch's index records modification time only");
  // Validate every flag before any request leaves.
  buildFsQuery(spec, { limit: 1, now: opts.now });

  const base = await fetchSet(fs, spec, cap, opts.now);
  let ordered: FsHit[];
  if (!spec.sort) {
    ordered = base.hits; // fsearch's relevance ranking
  } else if (base.complete) {
    ordered = sortHits(base.hits, spec.sort, spec.ascending);
  } else if ((spec.sort === "size" || spec.sort === "modified") && !spec.ascending) {
    ordered = await topBy(fs, spec, need, spec.sort, opts.now);
  } else {
    throw new Error(
      `--sort ${spec.sort}${spec.ascending ? " --asc" : ""} needs every match, and this query has more than ${cap.toLocaleString()}. ` +
        `Narrow it (--under, --ext, --larger, --after) or drop --sort to get fsearch's relevance ranking.`,
    );
  }

  const rows = ordered.slice(offset, need).map(toRow);
  const total = base.hits.length;
  return {
    rows,
    total,
    shown: rows.length,
    totalSize: base.complete ? fileBytes(base.hits) : null,
    truncated: !base.complete || total > rows.length,
    totalExact: base.complete,
  };
}

export async function count(fs: FsearchClient, spec: QuerySpec, cap: number, now: number): Promise<{ count: number; exact: boolean }> {
  const r = await fetchSet(fs, spec, cap, now);
  return { count: r.hits.length, exact: r.complete };
}

/** Total bytes of matching files. Refuses past the cap rather than report part of a sum. */
export async function totalSize(fs: FsearchClient, spec: QuerySpec, cap: number, now: number): Promise<number> {
  const r = await fetchSet(fs, spec, cap, now);
  if (!r.complete) {
    throw new Error(
      `more than ${cap.toLocaleString()} matches, and fsearch has no total-size query. Narrow the query, raise --cap, or measure the folder with 'sweep dust <dir>'.`,
    );
  }
  return fileBytes(r.hits);
}

export interface MacExtResult {
  entries: ExtEntry[];
  scanned: number;
  total: number;
  sampled: boolean;
  /** False when `total` is a lower bound. */
  totalExact: boolean;
}

/** Size and count by extension over every file under `root`, or over its `cap` largest files. */
export async function byExtension(fs: FsearchClient, root: string, cap: number, now: number): Promise<MacExtResult> {
  const spec: QuerySpec = { terms: [], under: root, type: "files" };
  const base = await fetchSet(fs, spec, cap, now);
  const hits = base.complete ? base.hits : await topBy(fs, spec, cap, "size", now);

  const acc = new Map<string, ExtEntry>();
  for (const h of hits) {
    const ext = extOf(h.path) || "(none)";
    const cur = acc.get(ext) ?? { ext, count: 0, size: 0 };
    cur.count += 1;
    cur.size += h.size;
    acc.set(ext, cur);
  }
  const entries = [...acc.values()].sort((a, b) => b.size - a.size);
  return { entries, scanned: hits.length, total: base.hits.length, sampled: !base.complete, totalExact: base.complete };
}

export interface GrepResult extends FsGrepReply {
  /** Files shown after --offset and -n. */
  shown: number;
  offset: number;
}

/** Content search. Name filters in the spec narrow which files are read. */
export async function grep(
  fs: FsearchClient,
  spec: QuerySpec,
  pattern: { literal?: string; regex?: string },
  now: number,
): Promise<GrepResult> {
  if (spec.sort) throw new UnsupportedFlag("--sort with --grep", "content matches come back in fsearch's order");
  const offset = spec.offset ?? 0;
  const limit = spec.limit ?? 50;
  const reply = await fs.grep(buildFsQuery(spec, { limit: offset + limit, now, grep: pattern.literal, grepRegex: pattern.regex }));
  const files = reply.files.slice(offset, offset + limit);
  return { ...reply, files, shown: files.length, offset };
}

/** Folders macOS guards with a consent prompt; the daemon skips them without Full Disk Access. */
export function consentGated(home: string): string[] {
  return [
    "Desktop", "Documents", "Downloads", "Library/Mobile Documents", "Library/Containers", "Library/Group Containers",
    "Library/CloudStorage", "Pictures/Photos Library.photoslibrary",
  ].map((d) => `${home}/${d}`).concat("/Volumes");
}

export interface MacDoctorReport {
  ok: boolean;
  backend: "fsearch";
  binary: string;
  binaryExists: boolean;
  /** fsearch has no --version flag; this is the installed binary's build time. */
  binaryModified?: string;
  socket: string;
  daemonAnswering: boolean;
  pid?: number;
  rssBytes?: number;
  index: {
    ready: boolean;
    /** While the first index builds: how far it has got. */
    progress?: string;
    entries?: number;
    dirs?: number;
    nameIndexBytes?: number;
    contentDocs?: number;
    contentBytes?: number;
    contentPending?: number;
    onDiskBytes: number;
    dataDir: string;
  };
  /** The daemon's own check. null when no daemon answered. */
  fullDiskAccess: boolean | null;
  /** Consent-gated folders the index lacks: what Full Disk Access would add. */
  skippedGated: string[];
  /** Other folders macOS refused to list. */
  skippedRefused: number;
  fixes: string[];
}

export const FDA_FIX =
  "Full Disk Access is missing, so Desktop, Documents, Downloads, iCloud Drive and other consent-gated folders are not indexed. " +
  "Grant it in System Settings > Privacy & Security > Full Disk Access to the terminal app that starts the daemon " +
  "(or run 'fsearch install --login' and grant it to ~/.local/bin/fsearch, again after each rebuild), " +
  "then restart the daemon: pkill -f 'fsearch serve' — the next ev call starts it and rescans the skipped folders.";

export async function doctor(probe: FsearchClient, facts: DaemonFacts, home: string): Promise<MacDoctorReport> {
  const gatedSet = new Set(consentGated(home));
  const report: MacDoctorReport = {
    ok: false,
    backend: "fsearch",
    binary: facts.binary,
    binaryExists: facts.binaryExists,
    binaryModified: facts.binaryModified,
    socket: facts.socket,
    daemonAnswering: await probe.ping(),
    pid: facts.pid,
    rssBytes: facts.rssBytes,
    index: { ready: false, onDiskBytes: facts.indexOnDiskBytes, dataDir: facts.dataDir },
    fullDiskAccess: null,
    skippedGated: facts.skipped.filter((p) => gatedSet.has(p)),
    skippedRefused: facts.skipped.filter((p) => !gatedSet.has(p)).length,
    fixes: [],
  };
  if (!facts.binaryExists) {
    report.fixes.push(`fsearch is not installed at ${facts.binary}: cd ~/Development/vendor/fsearch && cargo build --release && ./target/release/fsearch install`);
  }
  if (!report.daemonAnswering) {
    report.fixes.push("The fsearch daemon is not running. Any ev search starts it (or run 'fsearch status').");
    return report;
  }
  let s: FsStatus;
  try {
    s = await probe.status();
  } catch (err) {
    if (err instanceof FsearchError && err.indexing) {
      report.index.progress = err.message;
      return report;
    }
    throw err;
  }
  report.index = {
    ...report.index,
    ready: true,
    entries: s.entries,
    dirs: s.dirs,
    nameIndexBytes: s.index_bytes,
    contentDocs: s.content_docs,
    contentBytes: s.content_bytes,
    contentPending: s.content_pending,
  };
  report.fullDiskAccess = s.full_disk_access;
  if (!s.full_disk_access) report.fixes.push(FDA_FIX);
  report.ok = report.binaryExists;
  return report;
}
