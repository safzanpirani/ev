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
}

export interface LinkDeps {
  facts: (path: string) => Promise<FileFacts | null>;
  hash: (path: string) => Promise<string>;
  link: (existing: string, newPath: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  copy: (from: string, to: string) => Promise<void>;
  now?: () => string;
}

export type SkipReason =
  | "denied-path"
  | "cross-volume"
  | "already-linked"
  | "hash-mismatch"
  | "unreadable"
  | "symlink"
  | "too-small";

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

/** Pure. Exported so the policy is testable without touching a disk. */
export function isLinkable(path: string): boolean {
  const p = path.toLowerCase();
  if (DENIED_DIRS.some((d) => p.includes(d))) return false;
  const slash = p.lastIndexOf("\\");
  const name = slash >= 0 ? p.slice(slash + 1) : p;
  if (DENIED_NAMES.includes(name)) return false;
  const dot = name.lastIndexOf(".");
  if (dot > 0 && DENIED_EXTS.includes(name.slice(dot))) return false;
  return true;
}

/** Shortest path wins, with an already-shared file preferred — deterministic. */
function pickKeeper(entries: Array<{ path: string; facts: FileFacts }>): string {
  const sorted = [...entries].sort((a, b) => {
    if (a.facts.nlink !== b.facts.nlink) return b.facts.nlink - a.facts.nlink;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path < b.path ? -1 : 1;
  });
  return sorted[0]!.path;
}

export interface PlanOptions {
  minSize?: number;
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
  const out: LinkGroup[] = [];
  const skipped: Skipped[] = [];
  let hashedBytes = 0;

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
      const hashes = new Map<string, Array<{ path: string; facts: FileFacts }>>();
      for (const e of entries) {
        let h: string;
        try {
          h = await deps.hash(e.path);
        } catch {
          skipped.push({ path: e.path, reason: "unreadable" });
          continue;
        }
        hashedBytes += e.facts.size;
        const list = hashes.get(h) ?? [];
        list.push(e);
        hashes.set(h, list);
      }

      for (const [hash, matched] of hashes) {
        if (matched.length < 2) {
          for (const e of matched) skipped.push({ path: e.path, reason: "hash-mismatch" });
          continue;
        }
        const keeper = pickKeeper(matched);
        const keeperIno = matched.find((e) => e.path === keeper)!.facts.ino;
        const replace: string[] = [];
        for (const e of matched) {
          if (e.path === keeper) continue;
          if (e.facts.ino === keeperIno) {
            skipped.push({ path: e.path, reason: "already-linked" });
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
export async function applyLinks(plan: LinkPlan, deps: LinkDeps): Promise<ApplyResult> {
  const entries: JournalEntry[] = [];
  const failures: Array<{ path: string; error: string }> = [];
  let reclaimed = 0;

  for (const g of plan.groups) {
    for (const target of g.replace) {
      const tmp = `${target}.evlink-tmp`;
      try {
        await deps.link(g.keeper, tmp);
        await deps.rename(tmp, target);
        entries.push({ keeper: g.keeper, linked: target, size: g.size, hash: g.hash });
        reclaimed += g.size;
      } catch (err) {
        try {
          await deps.unlink(tmp);
        } catch {
          // The temp link may never have been created; nothing to clean up.
        }
        failures.push({ path: target, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return {
    journal: { version: 1, created: (deps.now ?? (() => new Date().toISOString()))(), entries },
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

  for (const e of journal.entries) {
    const tmp = `${e.linked}.evunlink-tmp`;
    try {
      await deps.copy(e.keeper, tmp);
      await deps.rename(tmp, e.linked);
      restored++;
    } catch (err) {
      try {
        await deps.unlink(tmp);
      } catch {
        // Nothing to clean up.
      }
      failures.push({ path: e.linked, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { restored, failures };
}
