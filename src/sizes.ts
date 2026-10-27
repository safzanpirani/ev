// The Linux folder-size cache. plocate stores names only, and an lstat per file
// over an NTFS drive mounted through ntfs-3g costs about 38 µs, so `du` over
// main's 4M-entry C: took 77 s and still hit the read cap. `ev index` therefore
// walks each indexed mount once with find(1), which stats relative to an open
// directory, and stores every folder's total in SQLite. `du` then reads folder
// totals from the cache and stats only the loose files of the folders it shows.

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, lstatSync, readdirSync, renameSync, rmSync, statSync, type Dirent, type Stats } from "node:fs";
import type { DuEntry, DuEntryTree, DuResult, DuTreeResult } from "./core.ts";

export function defaultSizesDb(env: NodeJS.ProcessEnv = process.env): string {
  if (env["EV_SIZES_DB"]) return env["EV_SIZES_DB"];
  const data = env["XDG_DATA_HOME"] || join(homedir(), ".local", "share");
  return join(data, "ev", "sizes.db");
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export interface FolderSize {
  bytes: number;
  files: number;
}

/**
 * Pure: fold walk records into folder totals. Each file's bytes go to every
 * folder above it up to `/`, so a mount's total reaches the folders that hold
 * it. A file with several hard links counts once.
 */
export class SizeAccumulator {
  readonly dirs = new Map<string, FolderSize>();
  private linked = new Set<string>();
  files = 0;

  dir(path: string): void {
    if (!this.dirs.has(path)) this.dirs.set(path, { bytes: 0, files: 0 });
  }

  file(path: string, bytes: number, id: string, links: number): void {
    if (links > 1) {
      if (this.linked.has(id)) return;
      this.linked.add(id);
    }
    this.files++;
    for (let d = parentOf(path); ; d = parentOf(d)) {
      const cur = this.dirs.get(d);
      if (cur) {
        cur.bytes += bytes;
        cur.files += 1;
      } else this.dirs.set(d, { bytes, files: 1 });
      if (d === "/") break;
    }
  }

  /** One `find -printf '%y %s %D:%i %n %p\0'` record. */
  record(rec: string): void {
    const a = rec.indexOf(" "), b = rec.indexOf(" ", a + 1), c = rec.indexOf(" ", b + 1), d = rec.indexOf(" ", c + 1);
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    const type = rec.slice(0, a);
    const path = rec.slice(d + 1);
    if (type === "d") this.dir(path.length > 1 ? path.replace(/\/+$/, "") : path);
    else if (type === "f") this.file(path, Number(rec.slice(a + 1, b)), rec.slice(b + 1, c), Number(rec.slice(c + 1, d)));
  }
}

/** Walk each root on its own filesystem and feed the records to `acc`. Roots run in parallel: they are different devices. */
export async function walk(roots: string[], prune: string[], acc: SizeAccumulator): Promise<void> {
  const pruneExpr = prune.flatMap((p) => ["-path", p, "-o"]);
  await Promise.all(roots.map(async (root) => {
    // Repository internals stay in: .git is often the bulk of a checkout, and du should show it.
    const pruning = prune.length ? ["(", ...pruneExpr.slice(0, -1), ")", "-prune", "-o"] : [];
    const argv = ["find", root, "-xdev", ...pruning, "-printf", "%y %s %D:%i %n %p\\0"];
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
    const decoder = new TextDecoder();
    let carry = "";
    for await (const chunk of proc.stdout) {
      const text = carry + decoder.decode(chunk, { stream: true });
      const parts = text.split("\0");
      carry = parts.pop() ?? "";
      for (const rec of parts) acc.record(rec);
    }
    if (carry) acc.record(carry);
    // find exits 1 when some folders were unreadable; what it could read is still right.
    await proc.exited;
  }));
}

/** Write the totals to a fresh database, then swap it in, so readers never see half a cache. */
export function saveSizes(path: string, acc: SizeAccumulator): void {
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  const db = new Database(tmp, { create: true });
  db.run("PRAGMA journal_mode = OFF");
  db.run("PRAGMA synchronous = OFF");
  db.run("CREATE TABLE dirs (path TEXT PRIMARY KEY, parent TEXT NOT NULL, bytes INTEGER NOT NULL, files INTEGER NOT NULL) WITHOUT ROWID");
  const insert = db.prepare("INSERT OR REPLACE INTO dirs VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    for (const [p, s] of acc.dirs) insert.run(p, p === "/" ? "" : parentOf(p), s.bytes, s.files);
  })();
  db.run("CREATE INDEX dirs_parent ON dirs (parent, bytes DESC)");
  db.close();
  renameSync(tmp, path);
}

export interface SizeCache {
  path: string;
  builtAt: number;
  total(dir: string): FolderSize | null;
  children(dir: string): Array<{ path: string } & FolderSize>;
  close(): void;
}

export function openSizes(path: string = defaultSizesDb()): SizeCache | null {
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  const total = db.prepare<FolderSize, [string]>("SELECT bytes, files FROM dirs WHERE path = ?");
  const children = db.prepare<{ path: string } & FolderSize, [string]>("SELECT path, bytes, files FROM dirs WHERE parent = ? ORDER BY bytes DESC");
  return {
    path,
    builtAt: statSync(path).mtimeMs,
    total: (dir) => total.get(dir) ?? null,
    children: (dir) => children.all(dir),
    close: () => db.close(),
  };
}

function nameOf(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

/** Folders from the cache, loose files from disk now. A folder the cache lacks is
 *  known from its directory entry and never stat'ed: lstat on an empty automount
 *  waits out systemd's 90 s device timeout and then fails with ENODEV. */
function entries(cache: SizeCache, dir: string): DuEntry[] {
  const folders = cache.children(dir).map((c): DuEntry => ({ path: c.path, name: nameOf(c.path), size: c.bytes, kind: "folder" }));
  const files: DuEntry[] = [];
  let names: Dirent[] = [];
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    // Unreadable now: the folder totals still stand.
  }
  const known = new Set(folders.map((f) => f.name));
  for (const d of names) {
    if (known.has(d.name) || d.isDirectory()) continue;
    const p = dir === "/" ? `/${d.name}` : `${dir}/${d.name}`;
    let s: Stats | undefined;
    try {
      s = lstatSync(p, { throwIfNoEntry: false });
    } catch {
      // Unreadable (EACCES, ENODEV, EIO): leave it out rather than fail the listing.
    }
    if (!s || s.isDirectory()) continue;
    files.push({ path: p, name: d.name, size: s.size, kind: "file" });
  }
  return [...folders, ...files].sort((a, b) => b.size - a.size);
}

export function cachedDu(cache: SizeCache, root: string, limit: number): DuResult {
  const all = entries(cache, root);
  const folderTotal = all.filter((e) => e.kind === "folder").reduce((n, e) => n + e.size, 0);
  const fileTotal = all.filter((e) => e.kind === "file").reduce((n, e) => n + e.size, 0);
  return { root, entries: all.slice(0, limit), folderTotal, fileTotal, grandTotal: folderTotal + fileTotal };
}

export function cachedDuTree(cache: SizeCache, root: string, depth: number, perLevel: number, minShare = 0.02): DuTreeResult {
  const level = (dir: string, remaining: number, d: number): { nodes: DuEntryTree[]; total: number } => {
    const all = entries(cache, dir);
    const total = all.reduce((n, e) => n + e.size, 0);
    const nodes = all.slice(0, perLevel).map((e) => {
      const node: DuEntryTree = { ...e, depth: d };
      if (remaining > 1 && e.kind === "folder" && e.size >= total * minShare) node.children = level(e.path, remaining - 1, d + 1).nodes;
      return node;
    });
    return { nodes, total };
  };
  const top = level(root, depth, 0);
  return { root, entries: top.nodes, grandTotal: top.total, depth, perLevel, minShare };
}
