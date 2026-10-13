// The macOS frontend: the same verbs and flags as cli.ts, answered by fsearch.
// cli.ts parses flags and hands over here when the backend is fsearch.

import { homedir } from "node:os";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { QuerySpec, SortKey } from "./query.ts";
import { buildFsQuery, isFsContentQuery } from "./fsquery.ts";
import { humanSize } from "./render.ts";
import { defaultTransport, fsearchPaths, makeFsearchClient, probeTransport, readDaemonFacts, type FsearchClient } from "./fsearch.ts";
import { byExtension, count, doctor, find, grep, totalSize } from "./mac.ts";
import { grepSummaryLine, macSummaryLine, renderGrepLines, renderMacDoctor, renderMacExt, renderMacRows } from "./macrender.ts";

export type Backend = "es" | "fsearch";

/** darwin uses fsearch; everything else keeps es.exe. $EV_BACKEND overrides. */
export function selectBackend(platform: string, env: NodeJS.ProcessEnv): Backend {
  const forced = env["EV_BACKEND"];
  if (forced === "es" || forced === "fsearch") return forced;
  if (forced) throw new Error(`$EV_BACKEND must be es or fsearch (got ${JSON.stringify(forced)})`);
  return platform === "darwin" ? "fsearch" : "es";
}

export const DU_ON_MAC =
  "ev du is not available on macOS: fsearch keeps no folder-size rollups. Use 'sweep dust <dir>' (or 'sweep scan <dir> --json') for disk usage, and 'ev big <dir>' for the largest files.";

export const DUPES_ON_MAC =
  "ev dupes is not available on macOS: APFS clones share blocks while looking like separate same-name same-size files, so a name+size candidate list would overstate what is reclaimable. Use 'ev dupes' on main.";

export const LINK_ON_MAC =
  "ev link cannot plan or apply on macOS: it finds candidates through the Everything index on main, its deny-list guards Windows paths rather than macOS app data, and APFS clones would make the reclaim figures wrong. Showing a saved plan and --undo still work.";

export const GREP_OFF_MAC = "--grep and --grep-regex need fsearch's content index, which only exists on macOS. On main, use ripgrep.";

/** The parsed flags cli.ts hands over. */
export interface MacFlags {
  positional: string[];
  str: Map<string, string>;
  multi: Map<string, string[]>;
  bool: Set<string>;
}

export interface MacContext {
  buildSpec: (f: MacFlags, terms: string[], defaultLimit: number, defaultSort?: SortKey) => QuerySpec;
  intFlag: (f: MacFlags, name: string, fallback: number) => number;
  roots: (f: MacFlags) => string[];
  out: (s: string) => void;
  err: (s: string) => void;
  defaultLimit: number;
  /** Injected so tests run without a daemon. */
  client?: FsearchClient;
  now?: () => number;
}

/** fsearch's `in:` expands `~` but not relative paths, and the index holds real paths (/tmp is /private/tmp). */
export function resolveDir(p: string, home = homedir(), cwd = process.cwd()): string {
  const expanded = p === "~" ? home : p.startsWith("~/") ? home + p.slice(1) : p;
  const abs = resolve(cwd, expanded);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function withDirs(spec: QuerySpec): QuerySpec {
  return {
    ...spec,
    ...(spec.under ? { under: resolveDir(spec.under) } : {}),
    ...(spec.parent ? { parent: resolveDir(spec.parent) } : {}),
  };
}

/** `ev raw` on macOS: the arguments are one fsearch query; the daemon's reply line is printed untouched. */
export async function runFsearchRaw(args: string[], ctx: Pick<MacContext, "out">): Promise<number> {
  const send = defaultTransport();
  const reply = await send({ q: args.join(" ") });
  ctx.out(JSON.stringify(reply));
  return reply["ok"] === true ? 0 : 1;
}

/**
 * Answer one verb. Returns undefined to hand the verb back to cli.ts, which
 * happens only for `link`: its plan display and undo are plain filesystem
 * work, and cli.ts refuses the index-backed parts itself.
 */
export async function runFsearch(cmd: string, f: MacFlags, ctx: MacContext): Promise<number | undefined> {
  const json = f.bool.has("--json");
  const quiet = f.bool.has("-q");
  const now = (ctx.now ?? Date.now)();
  const client = () => ctx.client ?? makeFsearchClient(defaultTransport());
  const pattern = { literal: f.str.get("--grep"), regex: f.str.get("--grep-regex") };
  const grepping = pattern.literal !== undefined || pattern.regex !== undefined;
  if (grepping && cmd !== "find") throw new Error(`--grep and --grep-regex go with ev find (got ev ${cmd})`);

  switch (cmd) {
    case "link":
      return undefined;

    case "du":
      throw new Error(DU_ON_MAC);

    case "dupes":
      ctx.roots(f); // reject nested roots the same way main does, before refusing
      throw new Error(DUPES_ON_MAC);

    case "doctor": {
      const paths = fsearchPaths();
      const d = await doctor(ctx.client ?? makeFsearchClient(probeTransport(paths)), await readDaemonFacts(paths), homedir());
      ctx.out(json ? JSON.stringify(d, null, 2) : renderMacDoctor(d));
      return d.ok ? 0 : 1;
    }

    case "count": {
      const spec = withDirs(ctx.buildSpec(f, f.positional, ctx.defaultLimit));
      const r = await count(client(), spec, ctx.intFlag(f, "--cap", 100_000), now);
      ctx.out(json ? JSON.stringify(r.exact ? { count: r.count } : { count: r.count, atLeast: true }) : r.exact ? String(r.count) : `${r.count}+`);
      return 0;
    }

    case "size": {
      const spec = withDirs(ctx.buildSpec(f, f.positional, ctx.defaultLimit));
      const n = await totalSize(client(), spec, ctx.intFlag(f, "--cap", 100_000), now);
      ctx.out(json ? JSON.stringify({ bytes: n, human: humanSize(n) }) : `${n}  (${humanSize(n)})`);
      return 0;
    }

    case "ext": {
      const path = f.positional[0];
      if (!path) throw new Error("ev ext needs a path, e.g. 'ev ext ~/Development'");
      const r = await byExtension(client(), resolveDir(path), ctx.intFlag(f, "--cap", 50_000), now);
      ctx.out(json ? JSON.stringify(r, null, 2) : renderMacExt(r, ctx.intFlag(f, "-n", 40)));
      return 0;
    }
  }

  // find / recent / big
  let spec: QuerySpec;
  if (cmd === "big") {
    const path = f.positional[0];
    if (!path) throw new Error("ev big needs a path, e.g. 'ev big ~'");
    spec = ctx.buildSpec(f, [], ctx.intFlag(f, "-n", ctx.defaultLimit), "size");
    spec.under = path;
    spec.type = spec.type ?? "files";
  } else {
    // Without --sort, find keeps fsearch's relevance ranking: that is what
    // makes a typo-tolerant name search useful. recent sorts by date as on main.
    spec = ctx.buildSpec(f, f.positional, ctx.intFlag(f, "-n", ctx.defaultLimit), cmd === "recent" ? "modified" : undefined);
  }
  spec = withDirs(spec);

  const contentQuery = isFsContentQuery(buildFsQuery(spec, { limit: 1, now }).q);
  if (grepping || contentQuery) {
    if (cmd !== "find") throw new Error(`content query words go with ev find (got ev ${cmd})`);
    const r = await grep(client(), spec, pattern, now);
    if (json) {
      ctx.out(JSON.stringify(r, null, 2));
      return 0;
    }
    ctx.out(renderGrepLines(r));
    if (!quiet) ctx.err(grepSummaryLine(r));
    return 0;
  }

  const r = await find(client(), spec, { now });
  if (json) {
    ctx.out(JSON.stringify(r, null, 2));
    return 0;
  }
  ctx.out(renderMacRows(r, { showDate: f.bool.has("--date") || cmd === "recent" }));
  // Same streams as the es path: big prints its summary on stdout, find and recent on stderr.
  if (!quiet) (cmd === "big" ? ctx.out : ctx.err)(macSummaryLine(r));
  return 0;
}
