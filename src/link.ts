// Hard-link deduplication: plan, apply, undo.
//
// Everything's index finds candidates by name and size. That is never enough to
// delete data on, so nothing here links a file until its content hash matches.

import type { DupeGroup } from "./core.ts";

export interface FileFacts {
  /** NTFS file index — two paths sharing it are already the same file. */
  ino: string;
  /** Volume id. Hard links cannot cross volumes, so this partitions every group. */
  dev: number;
  /** Existing hard-link count. */
  nlink: number;
  size: number;
  isSymlink: boolean;
  modified?: string;
}

export interface LinkDeps {
  facts: (path: string) => Promise<FileFacts | null>;
  hash: (path: string) => Promise<string>;
  link: (existing: string, newPath: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  copy: (from: string, to: string) => Promise<void>;
  /** Clear a target's read-only attribute so a rename can replace it. */
  makeWritable?: (path: string) => Promise<void>;
  now?: () => string;
}

export type SkipReason =
  | "denied-path"
  | "cross-volume"
  | "already-linked"
  | "hash-mismatch"
  | "unreadable"
  | "symlink"
  | "too-small"
  | "kept";

export interface Skipped {
  path: string;
  reason: SkipReason;
}

export interface LinkGroup {
  keeper: string;
  replace: string[];
  size: number;
  hash: string;
  reclaim: number;
}

export interface LinkPlan {
  groups: LinkGroup[];
  reclaim: number;
  skipped: Skipped[];
  hashedBytes: number;
}

/**
 * Paths that must never be hard-linked.
 *
 * The rule behind the list: a hard link is safe when tools REPLACE a file
 * (delete then create, which breaks the link harmlessly) and unsafe when tools
 * MODIFY it in place (which silently rewrites every other copy). Databases,
 * VM disks and logs are modified in place. Windows system directories are
 * excluded because nothing good comes of deduplicating them.
 */
const DENIED_DIRS = [
  "\\windows\\",
  "\\program files\\",
  "\\program files (x86)\\",
  "\\programdata\\",
  "\\$recycle.bin\\",
  "\\system volume information\\",
  "\\.git\\",
];

const DENIED_EXTS = [
  ".sqlite", ".sqlite3", ".db", ".db-wal", ".db-shm", ".mdb", ".ldb", ".edb",
  ".vhd", ".vhdx", ".vmdk", ".qcow2", ".vdi", ".avhdx",
  ".log", ".lock", ".pid", ".tmp", ".sys", ".etl",
];

const DENIED_NAMES = ["pagefile.sys", "hiberfil.sys", "swapfile.sys", "ntuser.dat", "desktop.ini", "thumbs.db"];

/** Linux system trees: package-managed, live state, or not files at all. Btrfs snapshots are read-only history. */
const DENIED_LINUX_ROOTS = ["/usr", "/etc", "/boot", "/proc", "/sys", "/dev", "/run", "/.snapshots", "/var/lib", "/var/log", "/var/cache", "/var/spool"];

/** Pure. Exported so the policy is testable without touching a disk. */
export function isLinkable(path: string): boolean {
  if (DENIED_LINUX_ROOTS.some((d) => path === d || path.startsWith(d + "/"))) return false;
  const p = path.replaceAll("/", "\\").toLowerCase();
  if (DENIED_DIRS.some((d) => p.includes(d))) return false;
  const slash = p.lastIndexOf("\\");
  const name = slash >= 0 ? p.slice(slash + 1) : p;
  if (DENIED_NAMES.includes(name)) return false;
  const dot = name.lastIndexOf(".");
  if (dot > 0 && DENIED_EXTS.includes(name.slice(dot))) return false;
  return true;
}

/** Lowercased with one trailing backslash, so `D:\Media` never matches `D:\Media2`. */
function dirPrefix(dir: string): string {
  return dir.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase() + "\\";
}

/** Pure. True when `path` sits under one of the `--keep` directories. */
export function isKept(path: string, keep: string[]): boolean {
  const p = path.replaceAll("/", "\\").toLowerCase();
  return keep.some((dir) => p.startsWith(dirPrefix(dir)));
}

/**
 * A kept file wins first, then an already-shared file, then the shortest path —
 * deterministic.
 */
function pickKeeper(entries: Array<{ path: string; facts: FileFacts }>, keep: string[] = []): string {
  const sorted = [...entries].sort((a, b) => {
    const ka = isKept(a.path, keep), kb = isKept(b.path, keep);
    if (ka !== kb) return ka ? -1 : 1;
    if (a.facts.nlink !== b.facts.nlink) return b.facts.nlink - a.facts.nlink;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path < b.path ? -1 : 1;
  });
  return sorted[0]!.path;
}

export type Progress =
  | { phase: "hash"; done: number; total: number; bytes: number; totalBytes: number; path: string }
  | { phase: "link"; done: number; total: number; bytes: number; totalBytes: number; path: string };

export interface PlanOptions {
  minSize?: number;
  /**
   * Directories whose files are never replaced. A kept file becomes the keeper
   * of its group, so another application reading that tree (Stash, Jellyfin)
   * sees the same inode, timestamps and bytes it saw before.
   */
  keep?: string[];
  onProgress?: (p: Progress) => void;
}

/**
 * Turn name+size candidates into a verified plan.
 *
 * Groups are split by volume, screened against the deny list, then hashed.
 * Files already sharing an inode are reported as already-linked rather than
 * relinked, so a second run over the same tree plans nothing.
 */
export async function planLinks(
  groups: DupeGroup[],
  deps: LinkDeps,
  opts: PlanOptions = {},
): Promise<LinkPlan> {
  const minSize = opts.minSize ?? 1024 * 1024;
  const keep = opts.keep ?? [];
  const out: LinkGroup[] = [];
  const skipped: Skipped[] = [];
  let hashedBytes = 0;

  // An upper bound: denied, unreadable and single-volume leftovers are never hashed.
  const eligible = groups.filter((g) => g.size >= minSize);
  const totalFiles = eligible.reduce((n, g) => n + g.paths.length, 0);
  const totalBytes = eligible.reduce((n, g) => n + g.size * g.paths.length, 0);
  let hashedFiles = 0;

  for (const g of groups) {
    if (g.size < minSize) {
      for (const p of g.paths) skipped.push({ path: p, reason: "too-small" });
      continue;
    }

    // Collect facts, dropping anything the policy or the filesystem rules out.
    const usable: Array<{ path: string; facts: FileFacts }> = [];
    for (const p of g.paths) {
      if (!isLinkable(p)) {
        skipped.push({ path: p, reason: "denied-path" });
        continue;
      }
      const facts = await deps.facts(p);
      if (!facts) {
        skipped.push({ path: p, reason: "unreadable" });
        continue;
      }
      if (facts.isSymlink) {
        skipped.push({ path: p, reason: "symlink" });
        continue;
      }
      usable.push({ path: p, facts });
    }

    // Hard links cannot cross volumes, so each volume is planned on its own.
    const byVolume = new Map<number, Array<{ path: string; facts: FileFacts }>>();
    for (const e of usable) {
      const list = byVolume.get(e.facts.dev) ?? [];
      list.push(e);
      byVolume.set(e.facts.dev, list);
    }
    if (byVolume.size > 1) {
      for (const [, list] of byVolume) {
        if (list.length < 2) for (const e of list) skipped.push({ path: e.path, reason: "cross-volume" });
      }
    }

    for (const [, entries] of byVolume) {
      if (entries.length < 2) continue;

      // Hash confirms content. Name and size never justify replacing a file.
      // Paths sharing an inode are one file, so each inode is read once: a
      // library that is already hard-linked costs no reads at all.
      const hashes = new Map<string, Array<{ path: string; facts: FileFacts }>>();
      const byInode = new Map<string, string | null>();
      for (const e of entries) {
        let h = byInode.get(e.facts.ino);
        if (h === undefined) {
          try {
            h = await deps.hash(e.path);
            hashedBytes += e.facts.size;
          } catch {
            h = null;
          }
          byInode.set(e.facts.ino, h);
        }
        opts.onProgress?.({ phase: "hash", done: ++hashedFiles, total: totalFiles, bytes: hashedBytes, totalBytes, path: e.path });
        if (h === null) {
          skipped.push({ path: e.path, reason: "unreadable" });
          continue;
        }
        const list = hashes.get(h) ?? [];
        list.push(e);
        hashes.set(h, list);
      }

      for (const [hash, matched] of hashes) {
        if (matched.length < 2) {
          for (const e of matched) skipped.push({ path: e.path, reason: "hash-mismatch" });
          continue;
        }
        const keeper = pickKeeper(matched, keep);
        const keeperIno = matched.find((e) => e.path === keeper)!.facts.ino;
        const replace: string[] = [];
        for (const e of matched) {
          if (e.path === keeper) continue;
          if (e.facts.ino === keeperIno) {
            skipped.push({ path: e.path, reason: "already-linked" });
            continue;
          }
          if (isKept(e.path, keep)) {
            skipped.push({ path: e.path, reason: "kept" });
            continue;
          }
          replace.push(e.path);
        }
        if (replace.length === 0) continue;
        const size = matched[0]!.facts.size;
        out.push({ keeper, replace, size, hash, reclaim: size * replace.length });
      }
    }
  }

  out.sort((a, b) => b.reclaim - a.reclaim);
  return { groups: out, reclaim: out.reduce((s, g) => s + g.reclaim, 0), skipped, hashedBytes };
}

/** A plan written by `--save-plan`, so `--plan` applies exactly what was reviewed. */
export interface SavedPlan extends LinkPlan {
  version: 1;
  created: string;
  /** Hashes from --quick are samples; a saved quick plan can be read, never applied. */
  quick: boolean;
}

const isPath = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isSize = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * Validate a saved plan. Apply re-checks identity and full hashes of every
 * file, so a hand-edited plan can at worst link less, never link wrong bytes —
 * but a malformed one should fail here with a clear message, not mid-apply.
 */
export function parsePlan(raw: unknown): SavedPlan {
  const o = raw as Partial<SavedPlan> | null;
  if (!o || o.version !== 1 || typeof o.quick !== "boolean" || !Array.isArray(o.groups) || !Array.isArray(o.skipped)) {
    throw new Error("invalid ev link plan (expected a file written by --save-plan)");
  }
  for (const g of o.groups) {
    if (!g || !isPath(g.keeper) || !Array.isArray(g.replace) || !g.replace.every(isPath) || g.replace.includes(g.keeper) ||
        !isSize(g.size) || !isPath(g.hash)) {
      throw new Error("invalid ev link plan: malformed group");
    }
  }
  const groups = o.groups.map((g) => ({ ...g, reclaim: g.size * g.replace.length }));
  return {
    version: 1,
    created: typeof o.created === "string" ? o.created : "",
    quick: o.quick,
    groups,
    reclaim: groups.reduce((n, g) => n + g.reclaim, 0),
    skipped: o.skipped,
    hashedBytes: isSize(o.hashedBytes) ? o.hashedBytes : 0,
  };
}

export interface JournalEntry {
  keeper: string;
  linked: string;
  size: number;
  hash: string;
}

export interface Journal {
  version: 1;
  created: string;
  entries: JournalEntry[];
}

export interface ApplyResult {
  journal: Journal;
  linked: number;
  reclaimed: number;
  failures: Array<{ path: string; error: string }>;
}

/**
 * Replace each duplicate with a hard link to the keeper.
 *
 * Link to a temporary name first, then rename over the original. The rename is
 * atomic, so an interruption leaves either the original or the link in place —
 * never a missing file. Each success is journalled so `undoLinks` can reverse it.
 */
function sameFile(a: FileFacts | null, b: FileFacts | null): boolean {
  return !!a && !!b && !a.isSymlink && !b.isSymlink && a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.modified === b.modified;
}

export async function applyLinks(
  plan: LinkPlan,
  deps: LinkDeps,
  saveJournal?: (journal: Journal) => Promise<void> | void,
  onProgress?: (p: Progress) => void,
): Promise<ApplyResult> {
  const entries: JournalEntry[] = [];
  const failures: Array<{ path: string; error: string }> = [];
  let reclaimed = 0;
  const created = (deps.now ?? (() => new Date().toISOString()))();
  const total = plan.groups.reduce((n, g) => n + g.replace.length, 0);
  let done = 0;

  for (const g of plan.groups) {
    for (const target of g.replace) {
      onProgress?.({ phase: "link", done: ++done, total, bytes: reclaimed, totalBytes: plan.reclaim, path: target });
      const tmp = `${target}.evlink-tmp-${crypto.randomUUID()}`;
      let ownsTemporary = false;
      try {
        const keeperFacts = await deps.facts(g.keeper);
        const targetFacts = await deps.facts(target);
        if (!isLinkable(g.keeper) || !isLinkable(target) || !keeperFacts || !targetFacts ||
            keeperFacts.isSymlink || targetFacts.isSymlink || keeperFacts.dev !== targetFacts.dev ||
            keeperFacts.size !== g.size || targetFacts.size !== g.size) throw new Error("files no longer match the link plan");
        if (keeperFacts.ino === targetFacts.ino) continue;
        if (await deps.hash(g.keeper) !== g.hash || await deps.hash(target) !== g.hash ||
            !sameFile(keeperFacts, await deps.facts(g.keeper)) || !sameFile(targetFacts, await deps.facts(target))) {
          throw new Error("file changed since planning; original preserved");
        }
        await deps.link(g.keeper, tmp);
        ownsTemporary = true;
        const entry = { keeper: g.keeper, linked: target, size: g.size, hash: g.hash };
        // Persist the intended replacement before it can happen. If interrupted,
        // undo verifies the actual hard link before touching this path.
        await saveJournal?.({ version: 1, created, entries: [...entries, entry] });
        if (!sameFile(targetFacts, await deps.facts(target)) || !sameFile(keeperFacts, await deps.facts(tmp))) {
          throw new Error("file changed before replacement; original preserved");
        }
        try {
          await deps.rename(tmp, target);
        } catch (renameErr) {
          // Windows refuses to rename over a file carrying the ReadOnly
          // attribute. The bytes are already verified identical, so clearing it
          // and retrying is safe. The resulting link shares the keeper's inode,
          // and therefore the keeper's attributes — there is nothing to restore.
          if (!deps.makeWritable) throw renameErr;
          if (!sameFile(targetFacts, await deps.facts(target))) throw new Error("target changed before retry; original preserved");
          await deps.makeWritable(target);
          await deps.rename(tmp, target);
        }
        ownsTemporary = false;
        entries.push(entry);
        reclaimed += g.size;
      } catch (err) {
        let stray = false;
        try {
          if (ownsTemporary) await deps.unlink(tmp);
        } catch {
          // The temp link either never existed or cannot be removed. A locked or
          // read-only target fails BOTH the rename and the cleanup, so say which
          // path was left behind rather than swallowing it.
          stray = true;
        }
        const base = err instanceof Error ? err.message : String(err);
        failures.push({ path: target, error: stray ? `${base} (left behind: ${tmp})` : base });
      }
    }
  }

  return {
    journal: { version: 1, created, entries },
    linked: entries.length,
    reclaimed,
    failures,
  };
}

/**
 * Restore independent copies. The bytes are identical by construction, so
 * copying the keeper back over the link reproduces the original file exactly
 * and costs back the space that was reclaimed.
 */
export async function undoLinks(
  journal: Journal,
  deps: LinkDeps,
): Promise<{ restored: number; failures: Array<{ path: string; error: string }> }> {
  const failures: Array<{ path: string; error: string }> = [];
  let restored = 0;

  if (journal?.version !== 1 || !Array.isArray(journal.entries) || journal.entries.some((e) =>
    !e || typeof e.keeper !== "string" || typeof e.linked !== "string" || typeof e.hash !== "string" ||
    !e.hash || !Number.isSafeInteger(e.size) || e.size < 0 || e.keeper === e.linked)) {
    throw new Error("invalid ev undo journal");
  }

  for (const e of journal.entries) {
    const tmp = `${e.linked}.evunlink-tmp-${crypto.randomUUID()}`;
    let ownsTemporary = false;
    try {
      const keeperFacts = await deps.facts(e.keeper);
      const targetFacts = await deps.facts(e.linked);
      if (!isLinkable(e.keeper) || !isLinkable(e.linked) || !sameFile(keeperFacts, targetFacts) ||
          targetFacts!.size !== e.size || await deps.hash(e.linked) !== e.hash) {
        throw new Error("journal paths no longer share the recorded contents; file preserved");
      }
      await deps.copy(e.linked, tmp);
      ownsTemporary = true;
      if (await deps.hash(tmp) !== e.hash || !sameFile(targetFacts, await deps.facts(e.linked))) {
        throw new Error("file changed during undo; file preserved");
      }
      await deps.rename(tmp, e.linked);
      ownsTemporary = false;
      restored++;
    } catch (err) {
      try {
        if (ownsTemporary) await deps.unlink(tmp);
      } catch {
        // Nothing to clean up.
      }
      failures.push({ path: e.linked, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { restored, failures };
}
