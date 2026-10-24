// The Linux frontend: the same verbs and flags as cli.ts, answered by plocate
// names plus lstat. cli.ts parses flags and hands over here on Linux.

import { existsSync, readFileSync, statSync } from "node:fs";
import type { QuerySpec, SortKey } from "./query.ts";
import { duration, humanSize, renderDu, renderDuTree, renderDupes, renderExt } from "./render.ts";
import { renderGrepLines } from "./macrender.ts";
import { mainGrepSummary } from "./grep.ts";
import { makeLocate, defaultRun, mountPlan, PRUNE_PATHS, type LocateClient, type MountPlan, type Run } from "./locate.ts";
import { SizeAccumulator, cachedDu, cachedDuTree, defaultSizesDb, openSizes, saveSizes, walk } from "./sizes.ts";
import { collect, grepLinux, toDu, toDuTree, toDupes, toExt, toFind, type Collected, type LxFindResult } from "./linux.ts";
import type { DupesResult } from "./core.ts";
import { resolveDir, type MacFlags } from "./maccli.ts";

export interface LinuxContext {
  buildSpec: (f: MacFlags, terms: string[], defaultLimit: number, defaultSort?: SortKey) => QuerySpec;
  intFlag: (f: MacFlags, name: string, fallback: number) => number;
  roots: (f: MacFlags) => string[];
  printListing: (r: LxFindResult, spec: QuerySpec, f: MacFlags, showDate: boolean) => void;
  out: (s: string) => void;
  err: (s: string) => void;
  defaultLimit: number;
  locate?: LocateClient;
  run?: Run;
  /** Folder-size cache path, for tests. */
  sizesDb?: string;
  now?: () => number;
}

/** Entries every index-backed verb reads at most, unless --cap says otherwise. */
export const STAT_CAP = 2_000_000;
/** Older than this, a listing says how old its index is. */
const STALE_MS = 2 * 3600_000;

/** ~ and relative paths resolved, and a missing folder refused rather than answered with 0B. */
export function linuxDir(p: string, what: string): string {
  const abs = resolveDir(p);
  if (!existsSync(abs)) throw new Error(`${what}: '${abs}' does not exist on this machine`);
  return abs;
}

function withDirs(spec: QuerySpec): QuerySpec {
  return {
    ...spec,
    ...(spec.under ? { under: linuxDir(spec.under, "--under") } : {}),
    ...(spec.parent ? { parent: linuxDir(spec.parent, "--parent") } : {}),
  };
}

/** `ev raw` on Linux: the arguments go to plocate against ev's database, untouched. */
export async function runLocateRaw(args: string[], ctx: Pick<LinuxContext, "out" | "err" | "run" | "locate">): Promise<number> {
  const run = ctx.run ?? defaultRun;
  const r = await run(["plocate", "-d", (ctx.locate ?? makeLocate()).db, ...args]);
  ctx.out(new TextDecoder().decode(r.stdout).trimEnd());
  if (r.stderr.trim()) ctx.err(r.stderr.trim());
  return r.code;
}

/** Caveats a Linux listing owes its reader: stale index entries, a sampled read, an old index. */
export function linuxNotes(c: Pick<Collected, "gone" | "sampled" | "matched">, builtAt: number | null, now: number, cap: number): string[] {
  const notes: string[] = [];
  if (c.sampled) notes.push(`-- ${c.matched.toLocaleString()} index entries matched; only the first ${cap.toLocaleString()} were read. Narrow the query or raise --cap.`);
  if (c.gone) notes.push(`-- ${c.gone.toLocaleString()} indexed paths no longer exist. 'ev index' refreshes the index.`);
  if (builtAt !== null && now - builtAt > STALE_MS) notes.push(`-- The index was built ${duration(now - builtAt)} ago; newer files are missing. 'ev index' refreshes it.`);
  return notes;
}

/**
 * Answer one verb. Returns undefined to hand `link` back to cli.ts, which
 * plans and applies with candidates from `linuxDupes`.
 */
export async function runLinux(cmd: string, f: MacFlags, ctx: LinuxContext): Promise<number | undefined> {
  const json = f.bool.has("--json");
  const quiet = f.bool.has("-q");
  const now = (ctx.now ?? Date.now)();
  const run = ctx.run ?? defaultRun;
  const locate = ctx.locate ?? makeLocate(undefined, run);
  const cap = ctx.intFlag(f, "--cap", STAT_CAP);
  const say = (lines: string[]) => {
    if (quiet || !lines.length) return;
    if (f.bool.has("--paths")) ctx.err(lines.join("\n"));
    else ctx.out(lines.join("\n"));
  };

  switch (cmd) {
    case "link":
      return undefined;

    case "index": {
      if (!quiet) ctx.err(`-- names: updatedb into ${locate.db} (the first run reads every disk; later runs reread changed folders only)`);
      const names = await locate.build();
      const counted = await run(["plocate", "-d", locate.db, "-c", "/"]);
      const entries = Number(new TextDecoder().decode(counted.stdout).trim()) || 0;

      const plan = mountPlan(readFileSync("/proc/self/mountinfo", "utf8"));
      const roots = plan.indexed.map((m) => m.path);
      if (!quiet) ctx.err(`-- sizes: walking ${roots.join(", ")}`);
      const start = Date.now();
      const acc = new SizeAccumulator();
      await walk(roots, [...PRUNE_PATHS, ...plan.prune], acc);
      const sizesPath = ctx.sizesDb ?? defaultSizesDb();
      saveSizes(sizesPath, acc);
      const sizesMs = Date.now() - start;

      if (json) ctx.out(JSON.stringify({ names: { db: locate.db, ms: names.ms, entries }, sizes: { db: sizesPath, ms: sizesMs, folders: acc.dirs.size, files: acc.files } }));
      else {
        ctx.out([
          `-- names: ${entries.toLocaleString()} entries in ${duration(names.ms)} (${locate.db}).`,
          `-- sizes: ${acc.dirs.size.toLocaleString()} folders over ${acc.files.toLocaleString()} files in ${duration(sizesMs)} (${sizesPath}).`,
        ].join("\n"));
      }
      return 0;
    }

    case "doctor": {
      const builtAt = locate.builtAt();
      const timer = await run(["systemctl", "--user", "is-active", "ev-index.timer"]).then((r) => new TextDecoder().decode(r.stdout).trim() || "unknown", () => "unknown");
      let mounts: MountPlan = { indexed: [], skipped: [], prune: [] };
      try {
        mounts = mountPlan(readFileSync("/proc/self/mountinfo", "utf8"));
      } catch {
        // Not Linux, or /proc is hidden: leave the mount view empty.
      }
      const plocate = Bun.which("plocate");
      const updatedb = Bun.which("updatedb");
      const fixes: string[] = [];
      if (!plocate || !updatedb) fixes.push("install plocate (pacman -S plocate) for plocate and updatedb");
      if (builtAt === null) fixes.push("build the index: ev index");
      else if (now - builtAt > STALE_MS) fixes.push("the index is old: run ev index, and check the ev-index.timer user unit");
      if (timer !== "active") fixes.push("enable hourly refreshes: systemctl --user enable --now ev-index.timer");
      const ok = Boolean(plocate && updatedb && builtAt !== null);
      const sizesPath = ctx.sizesDb ?? defaultSizesDb();
      const sizesAt = existsSync(sizesPath) ? statSync(sizesPath).mtimeMs : null;
      const report = { ok, backend: "locate", db: locate.db, builtAt: builtAt === null ? null : new Date(builtAt).toISOString(), sizes: sizesPath, sizesBuiltAt: sizesAt === null ? null : new Date(sizesAt).toISOString(), plocate, updatedb, timer, mounts, fixes };
      if (json) ctx.out(JSON.stringify(report, null, 2));
      else {
        ctx.out([
          ok ? "ev: ok (Linux, plocate backend)" : "ev: not ready (Linux, plocate backend)",
          `  plocate:  ${plocate ?? "missing"}`,
          `  index:    ${locate.db}${builtAt === null ? "  (not built)" : `  (built ${duration(now - builtAt)} ago)`}`,
          `  sizes:    ${sizesPath}${sizesAt === null ? "  (not built: du adds up files at query time)" : `  (built ${duration(now - sizesAt)} ago)`}`,
          `  refresh:  ev-index.timer ${timer}`,
          `  indexed:  ${mounts.indexed.map((m) => `${m.path} (${m.fs})`).join(", ") || "(unknown)"}`,
          ...mounts.skipped.map((m) => `  skipped:  ${m.path} (${m.fs}): ${m.why}`),
          ...fixes.map((x) => `  fix: ${x}`),
        ].join("\n"));
      }
      return ok ? 0 : 1;
    }

    case "du": {
      const path = f.positional[0];
      if (!path) throw new Error("ev du needs a path, e.g. 'ev du /mnt/shared'");
      const root = linuxDir(path, "ev du");
      const depth = ctx.intFlag(f, "--depth", 1);
      const sizes = openSizes(ctx.sizesDb ?? defaultSizesDb());
      if (sizes?.total(root)) {
        try {
          if (depth > 1) {
            const t = cachedDuTree(sizes, root, depth, ctx.intFlag(f, "-n", 12));
            ctx.out(json ? JSON.stringify(t, null, 2) : renderDuTree(t));
          } else {
            const r = cachedDu(sizes, root, ctx.intFlag(f, "-n", 40));
            ctx.out(json ? JSON.stringify(r, null, 2) : renderDu(r));
          }
          if (!json && now - sizes.builtAt > STALE_MS) say([`-- Folder totals come from the index built ${duration(now - sizes.builtAt)} ago; loose files are current. 'ev index' refreshes it.`]);
        } finally {
          sizes.close();
        }
        return 0;
      }
      sizes?.close();
      // Not in the size cache (built before this folder existed, or no cache yet): add up its files now.
      const c = await collect(locate, { terms: [], under: root }, { cap, now });
      if (depth > 1) {
        const t = toDuTree(c.rows, root, depth, ctx.intFlag(f, "-n", 12));
        ctx.out(json ? JSON.stringify(t, null, 2) : renderDuTree(t));
      } else {
        const r = toDu(c.rows, root, ctx.intFlag(f, "-n", 40));
        ctx.out(json ? JSON.stringify(r, null, 2) : renderDu(r));
      }
      if (!json) say(linuxNotes(c, locate.builtAt(), now, cap));
      return 0;
    }

    case "ext": {
      const path = f.positional[0];
      if (!path) throw new Error("ev ext needs a path, e.g. 'ev ext /mnt/shared'");
      const c = await collect(locate, { terms: [], under: linuxDir(path, "ev ext"), type: "files" }, { cap, now });
      const r = toExt(c, cap);
      ctx.out(json ? JSON.stringify(r, null, 2) : renderExt(r, ctx.intFlag(f, "-n", 40)));
      if (!json) say(linuxNotes(c, locate.builtAt(), now, cap));
      return 0;
    }

    case "dupes": {
      const r = await linuxDupes(locate, ctx.buildSpec(f, f.positional, cap), ctx.roots(f), cap, now);
      ctx.out(json ? JSON.stringify(r, null, 2) : renderDupes(r, ctx.intFlag(f, "-n", 40)));
      return 0;
    }

    case "count":
    case "size": {
      const spec = withDirs(ctx.buildSpec(f, f.positional, ctx.defaultLimit));
      const c = await collect(locate, spec, { cap, now });
      const r = toFind(c, spec);
      if (cmd === "count") ctx.out(json ? JSON.stringify({ count: r.total, ...(c.sampled ? { atLeast: true } : {}) }) : `${r.total}${c.sampled ? "+" : ""}`);
      else ctx.out(json ? JSON.stringify({ bytes: r.totalSize, human: humanSize(r.totalSize) }) : r.totalSize === null ? "no total for folders" : `${r.totalSize}  (${humanSize(r.totalSize)})`);
      return 0;
    }
  }

  // find / recent / big, and --grep
  const literal = f.str.get("--grep");
  const regex = f.str.get("--grep-regex");
  if (literal !== undefined || regex !== undefined) {
    if (cmd !== "find") throw new Error(`--grep and --grep-regex go with ev find (got ev ${cmd})`);
    if (literal !== undefined && regex !== undefined) throw new Error("give --grep or --grep-regex, not both");
    if (f.str.has("--sort")) throw new Error("--sort does not apply to --grep: matching files come back in path order");
    const grepCap = ctx.intFlag(f, "--cap", 5000);
    const spec = withDirs(ctx.buildSpec(f, f.positional, ctx.intFlag(f, "-n", ctx.defaultLimit)));
    const r = await grepLinux(locate, spec, { literal, regex }, { cap: grepCap, allDirs: f.bool.has("--all-dirs"), now });
    if (json) {
      ctx.out(JSON.stringify(r, null, 2));
      return 0;
    }
    ctx.out(f.bool.has("--paths") ? r.files.map((x) => x.path).join("\n") : renderGrepLines(r));
    say([mainGrepSummary(r, grepCap)]);
    return 0;
  }

  let spec: QuerySpec;
  if (cmd === "big") {
    const path = f.positional[0];
    if (!path) throw new Error("ev big needs a path, e.g. 'ev big /mnt/shared'");
    spec = ctx.buildSpec(f, [], ctx.intFlag(f, "-n", ctx.defaultLimit), "size");
    spec.under = path;
    spec.type = spec.type ?? "files";
  } else {
    spec = ctx.buildSpec(f, f.positional, ctx.intFlag(f, "-n", ctx.defaultLimit), cmd === "recent" ? "modified" : "size");
  }
  spec = withDirs(spec);
  const c = await collect(locate, spec, { cap, now });
  const r = toFind(c, spec);
  if (json) {
    ctx.out(JSON.stringify(r, null, 2));
    return 0;
  }
  ctx.printListing(r, spec, f, f.bool.has("--date") || cmd === "recent");
  say(linuxNotes(c, locate.builtAt(), now, cap));
  return 0;
}

/** Name+size candidates for dupes and link, one index query per --under root. */
export async function linuxDupes(locate: LocateClient, spec: QuerySpec, roots: string[], cap: number, now: number): Promise<DupesResult> {
  const scopes = roots.length ? roots.map((under) => withDirs({ ...spec, under })) : [withDirs(spec)];
  const parts = await Promise.all(scopes.map((s) => collect(locate, { ...s, type: "files" }, { cap, now })));
  return toDupes(parts);
}
