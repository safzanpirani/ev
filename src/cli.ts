#!/usr/bin/env bun
// Thin frontend: parse, call core, render, exit.

import { loadConfig, DEFAULTS } from "./config.ts";
import { makeClient, EsError } from "./es.ts";
import { parseSize, type QuerySpec, type SortKey, type TypeFilter } from "./query.ts";
import { find, count, totalSize, du, duTree, byExtension, dupes, doctor } from "./core.ts";
import { renderFind, renderDu, renderExt, renderDupes, renderDuTree, renderDoctor, renderLinkPlan, renderApply, renderProgress, humanSize, summaryLine } from "./render.ts";
import { planLinks, applyLinks, undoLinks, parsePlan, type Journal, type LinkPlan, type Progress, type SavedPlan } from "./link.ts";
import { makeFsDeps } from "./fsdeps.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { createJournalWriter } from "./journal.ts";
import { selectBackend, runFsearch, runFsearchRaw, LINK_ON_MAC, GREP_OFF_MAC } from "./maccli.ts";

const HELP = `ev — file search over Everything's index

USAGE
  ev <command> [options] [query...]

COMMANDS
  find [query...]     search the index (default command)
  count [query...]    number of matches only
  size [query...]     total bytes of matches only
  du <path>           children by size, largest first (--depth to recurse)
  big <path>          largest files anywhere under a path
  ext <path>          size and count grouped by file extension
  dupes [query...]    same-name same-size candidates, most reclaimable first
  link [query...]     replace verified duplicates with hard links (dry run)
  recent [query...]   most recently modified matches
  raw <args...>       pass arguments straight through to es.exe
  doctor              check that Everything is reachable

QUERY OPTIONS
  --ext a,b,c         restrict to extensions
  --under <path>      restrict to a directory subtree (dupes and link accept
                      it more than once, to compare two trees)
  --parent <path>     restrict to immediate children of a directory
  --larger <size>     at least this big  (500, 10K, 1.5G, 2TB)
  --smaller <size>    at most this big
  --after <date>      modified on or after  (2026-01-01, today, lastweek)
  --before <date>     modified on or before
  --files             files only
  --folders           folders only
  --regex             treat the query as a regular expression
  --case              match case
  --whole-word        match whole words
  --match-path        match against the full path, not just the name

OUTPUT OPTIONS
  -n <count>          max rows (default ${DEFAULTS.limit}; ev du/ext/dupes default 40)
  --offset <n>        skip the first n results
  --sort <key>        size|name|path|modified|created|extension
  --asc               sort ascending (default is descending for size and dates)
  --date              show modified dates in find output
  --depth <n>         levels for du to expand (default 1)
  --cap <n>           rows to aggregate over for ext, dupes and link (default 50000)
  --index-only        dupes: skip the stat that folds existing hard links together
  --json              emit the whole result as JSON
  -q                  suppress the trailing summary line

LINK OPTIONS
  --yes               actually create the links (without it, nothing changes)
  --quick             hash a 1MB head and tail instead of the whole file
  --keep <path>       never replace files under this path; they become the
                      keepers (repeatable)
  --save-plan <path>  write the verified plan to a file for review
  --plan <path>       show or (with --yes) apply a saved plan, without re-planning
  --journal <path>    where to write the undo journal
  --undo <path>       restore independent copies from a journal (needs --yes)

MACOS
  On the Mac, ev answers from fsearch's index instead of Everything.
  find, recent, big, count, size, ext, raw and doctor work. du and dupes
  refuse (no folder-size rollups; APFS clones); link only shows saved plans
  and undoes. --case, --whole-word, --sort created, and --match-path without
  --regex refuse. find without --sort keeps fsearch's relevance ranking, and
  query words are fsearch syntax: fuzzy, typo-tolerant, 'exact, ^prefix,
  suffix$, !exclude. grep:, regex: and sym: words use content-search output
  (also content: and symbol: aliases); content queries require find, no --sort.
  --grep <text>       content search (literal), with any name filters above
  --grep-regex <re>   content search (regular expression)

CONFIG
  Defaults need no config file. Override with $EV_ES_PATH, $EV_INSTANCE,
  or ~/.config/ev/config.json ({"esPath","instance","limit"}).

EXAMPLES
  ev find --ext mkv --larger 5G --under F:\\
  ev du F:\\ --depth 3
  ev ext F:\\SteamLibrary
  ev dupes --under F:\\ --larger 1G
  ev big D:\\Downloads -n 20
  ev count "ext:iso"
  ev raw -parent "F:\\" /ad -size -sort size-descending

  ev link --ext safetensors,onnx --larger 100M          # plan, change nothing
  ev link --ext safetensors,onnx --larger 100M --yes    # apply
  ev link --undo C:\\Tools\\ev-journal-....json --yes   # put the copies back

  # a mirror between two trees: keep one side untouched, review, then apply
  ev link --under D:\\Downloads\\n --under D:\\Media --keep D:\\Downloads\\n --save-plan plan.json
  ev link --plan plan.json --yes
`;

interface Flags {
  positional: string[];
  str: Map<string, string>;
  /** Every value of a repeatable flag, in order. */
  multi: Map<string, string[]>;
  bool: Set<string>;
}

const STR_FLAGS = new Set([
  "--ext", "--under", "--parent", "--larger", "--smaller", "--after", "--before",
  "-n", "--offset", "--sort", "--cap", "--journal", "--undo", "--depth",
  "--keep", "--save-plan", "--plan", "--grep", "--grep-regex",
]);
const MULTI_FLAGS = new Set(["--under", "--keep"]);
const BOOL_FLAGS = new Set([
  "--files", "--folders", "--regex", "--case", "--whole-word", "--match-path",
  "--asc", "--date", "--json", "-q", "-h", "--help", "--yes", "--quick", "--index-only",
]);

function parseFlags(argv: string[]): Flags {
  const positional: string[] = [];
  const str = new Map<string, string>();
  const multi = new Map<string, string[]>();
  const bool = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (STR_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      if (MULTI_FLAGS.has(a)) multi.set(a, [...(multi.get(a) ?? []), v]);
      else if (str.has(a)) throw new Error(`${a} was given twice`);
      str.set(a, v);
    } else if (BOOL_FLAGS.has(a)) {
      bool.add(a);
    } else if (a.startsWith("--") || (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a))) {
      // Anything left that is dash-shaped is a typo, not a positional.
      throw new Error(`unknown option ${a} — run 'ev --help' for the full list`);
    } else {
      positional.push(a);
    }
  }
  return { positional, str, multi, bool };
}

function lower(p: string): string {
  return p.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase() + "\\";
}

/** Every --under root. Nested roots would count the inner tree twice. */
function roots(f: Flags): string[] {
  const all = f.multi.get("--under") ?? [];
  for (const a of all) {
    for (const b of all) {
      if (a !== b && lower(b).startsWith(lower(a))) throw new Error(`--under ${JSON.stringify(b)} is inside --under ${JSON.stringify(a)}; give disjoint trees`);
    }
  }
  return all;
}

/** Throttled to one line per 5s, plus the last, so a 400-file run logs readably. */
function progressWriter(quiet: boolean): ((p: Progress) => void) | undefined {
  if (quiet) return undefined;
  let last = 0;
  return (p) => {
    const now = Date.now();
    const final = p.done === p.total;
    if (!final && now - last < 5000) return;
    last = now;
    process.stderr.write(renderProgress(p) + "\n");
  };
}

function intFlag(f: Flags, name: string, fallback: number): number {
  const raw = f.str.get(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer (got ${JSON.stringify(raw)})`);
  return n;
}

const SORT_KEYS: SortKey[] = ["size", "name", "path", "modified", "created", "extension"];

function buildSpec(f: Flags, terms: string[], defaultLimit: number, defaultSort?: SortKey): QuerySpec {
  const spec: QuerySpec = { terms };

  const ext = f.str.get("--ext");
  if (ext) spec.ext = ext.split(",").map((s) => s.trim().replace(/^\./, "")).filter(Boolean);

  const under = f.multi.get("--under") ?? [];
  // dupes and link pass several roots separately; everything else takes one.
  if (under.length === 1) spec.under = under[0];
  const parent = f.str.get("--parent");
  if (parent) spec.parent = parent;

  const larger = f.str.get("--larger");
  if (larger) spec.larger = parseSize(larger);
  const smaller = f.str.get("--smaller");
  if (smaller) spec.smaller = parseSize(smaller);

  const after = f.str.get("--after");
  if (after) spec.modifiedAfter = after;
  const before = f.str.get("--before");
  if (before) spec.modifiedBefore = before;

  if (f.bool.has("--files") && f.bool.has("--folders")) throw new Error("--files and --folders are mutually exclusive");
  const type: TypeFilter | undefined = f.bool.has("--files") ? "files" : f.bool.has("--folders") ? "folders" : undefined;
  if (type) spec.type = type;

  if (f.bool.has("--regex")) spec.regex = true;
  if (f.bool.has("--case")) spec.matchCase = true;
  if (f.bool.has("--whole-word")) spec.wholeWord = true;
  if (f.bool.has("--match-path")) spec.matchPath = true;

  const sortRaw = f.str.get("--sort");
  if (sortRaw) {
    if (!SORT_KEYS.includes(sortRaw as SortKey)) {
      throw new Error(`--sort must be one of ${SORT_KEYS.join("|")} (got ${JSON.stringify(sortRaw)})`);
    }
    spec.sort = sortRaw as SortKey;
  } else if (defaultSort) {
    spec.sort = defaultSort;
  }
  if (f.bool.has("--asc")) spec.ascending = true;

  spec.limit = intFlag(f, "-n", defaultLimit);
  const offset = intFlag(f, "--offset", 0);
  if (offset) spec.offset = offset;

  return spec;
}

function out(s: string): void {
  if (s) process.stdout.write(s + "\n");
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    out(HELP.trimEnd());
    return 0;
  }

  const KNOWN = new Set(["find", "count", "size", "du", "big", "ext", "dupes", "recent", "raw", "doctor", "link"]);
  const cmd = KNOWN.has(argv[0]!) ? argv[0]! : "find";
  const rest = KNOWN.has(argv[0]!) ? argv.slice(1) : argv;

  // `raw` is an escape hatch: forward argv untouched, no flag parsing of our own.
  const cfg = loadConfig();
  const es = makeClient(cfg.esPath, cfg.instance);
  const backend = selectBackend(process.platform, process.env);

  if (cmd === "raw") {
    if (backend === "fsearch") return runFsearchRaw(rest, { out });
    out((await es.raw(rest)).trimEnd());
    return 0;
  }

  const f = parseFlags(rest);
  if (f.bool.has("-h") || f.bool.has("--help")) {
    out(HELP.trimEnd());
    return 0;
  }
  const json = f.bool.has("--json");
  const quiet = f.bool.has("-q");
  if (cmd !== "dupes" && cmd !== "link" && (f.multi.get("--under")?.length ?? 0) > 1) {
    throw new Error(`only dupes and link accept --under more than once`);
  }
  if (cmd !== "link" && f.multi.has("--keep")) throw new Error(`--keep only applies to ev link`);
  if (backend !== "fsearch" && (f.str.has("--grep") || f.str.has("--grep-regex"))) throw new Error(GREP_OFF_MAC);

  if (backend === "fsearch") {
    const err = (s: string) => process.stderr.write(s + "\n");
    const code = await runFsearch(cmd, f, { buildSpec, intFlag, roots, out, err, defaultLimit: DEFAULTS.limit });
    if (code !== undefined) return code;
  }

  if (cmd === "doctor") {
    const d = await doctor(es, cfg.esPath, cfg.instance);
    out(json ? JSON.stringify(d, null, 2) : renderDoctor(d));
    return d.ok ? 0 : 1;
  }

  if (cmd === "du" || cmd === "ext" || cmd === "big") {
    const path = f.positional[0];
    if (!path) throw new Error(`ev ${cmd} needs a path, e.g. 'ev ${cmd} F:\\'`);

    if (cmd === "du") {
      const limit = intFlag(f, "-n", 40);
      const depth = intFlag(f, "--depth", 1);
      if (depth > 1) {
        const t = await duTree(es, path, depth, Math.min(limit, 12));
        out(json ? JSON.stringify(t, null, 2) : renderDuTree(t));
        return 0;
      }
      const r = await du(es, path, limit);
      out(json ? JSON.stringify(r, null, 2) : renderDu(r));
      return 0;
    }
    if (cmd === "ext") {
      const limit = intFlag(f, "-n", 40);
      const cap = intFlag(f, "--cap", 50_000);
      const r = await byExtension(es, { terms: [], under: path }, cap);
      out(json ? JSON.stringify(r, null, 2) : renderExt(r, limit));
      return 0;
    }
    // big
    const spec = buildSpec(f, [], intFlag(f, "-n", DEFAULTS.limit), "size");
    spec.under = path;
    spec.type = spec.type ?? "files";
    const r = await find(es, spec);
    out(json ? JSON.stringify(r, null, 2) : quiet ? renderFind(r).split("\n").slice(0, -1).join("\n") : renderFind(r));
    return 0;
  }

  if (cmd === "link") {
    const apply = f.bool.has("--yes");
    if (apply && f.bool.has("--quick")) throw new Error("--quick is only available for dry runs; omit it to verify full contents before --yes");
    const fsDeps = makeFsDeps({ quick: f.bool.has("--quick") });

    const undoPath = f.str.get("--undo");
    if (undoPath) {
      const journal = JSON.parse(readFileSync(undoPath, "utf8")) as Journal;
      if (!apply) {
        const msg = `-- would restore ${journal.entries.length} file(s) from ${undoPath}. Re-run with --yes to apply.`;
        out(json ? JSON.stringify({ wouldRestore: journal.entries.length, journal: undoPath }) : msg);
        return 0;
      }
      const r = await undoLinks(journal, fsDeps);
      out(json ? JSON.stringify(r, null, 2) : `-- restored ${r.restored} file(s), ${r.failures.length} failure(s).`);
      return r.failures.length ? 1 : 0;
    }

    const limit = intFlag(f, "-n", 20);
    const progress = progressWriter(quiet);
    const planPath = f.str.get("--plan");
    let plan: LinkPlan;
    if (planPath) {
      const saved = parsePlan(JSON.parse(readFileSync(planPath, "utf8")));
      if (apply && saved.quick) throw new Error(`${planPath} was planned with --quick; re-plan without it before --yes`);
      plan = saved;
      if (!apply) {
        out(json ? JSON.stringify(plan, null, 2) : renderLinkPlan(plan, limit, false, `Apply with: ev link --plan "${planPath}" --yes`));
        return 0;
      }
    } else {
      const cap = intFlag(f, "--cap", 50_000);
      const minSize = f.str.get("--larger") ? parseSize(f.str.get("--larger")!) : 1024 * 1024;
      const spec = buildSpec(f, f.positional, cap);
      if (backend === "fsearch") throw new Error(LINK_ON_MAC);
      const candidates = await dupes(es, spec, cap, roots(f));
      plan = await planLinks(candidates.groups, fsDeps, { minSize, keep: f.multi.get("--keep") ?? [], onProgress: progress });

      const savePath = f.str.get("--save-plan");
      if (savePath) {
        const saved: SavedPlan = { version: 1, created: new Date().toISOString(), quick: f.bool.has("--quick"), ...plan };
        // "wx": a reviewed plan is evidence of what was approved; never overwrite one.
        writeFileSync(savePath, JSON.stringify(saved, null, 2), { flag: "wx" });
      }
      if (!apply) {
        const hint = savePath ? `Apply exactly this plan with: ev link --plan "${savePath}" --yes` : undefined;
        out(json ? JSON.stringify(plan, null, 2) : renderLinkPlan(plan, limit, false, hint));
        return 0;
      }
    }
    if (backend === "fsearch") throw new Error(LINK_ON_MAC);
    const journalPath =
      f.str.get("--journal") ?? `ev-journal-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const saveJournal = createJournalWriter(journalPath);
    const result = await applyLinks(plan, fsDeps, saveJournal, progress);
    saveJournal(result.journal);
    out(json ? JSON.stringify({ ...result, journalPath }, null, 2) : renderApply(result, journalPath));
    return result.failures.length ? 1 : 0;
  }

  if (cmd === "dupes") {
    const limit = intFlag(f, "-n", 40);
    const cap = intFlag(f, "--cap", 50_000);
    const spec = buildSpec(f, f.positional, cap);
    const fsDeps = makeFsDeps();
    const identify = f.bool.has("--index-only")
      ? undefined
      : async (p: string) => {
          const facts = await fsDeps.facts(p);
          return facts ? `${facts.dev}:${facts.ino}` : null;
        };
    const r = await dupes(es, spec, cap, roots(f), identify);
    out(json ? JSON.stringify(r, null, 2) : renderDupes(r, limit));
    return 0;
  }

  if (cmd === "count") {
    const spec = buildSpec(f, f.positional, DEFAULTS.limit);
    const n = await count(es, spec);
    out(json ? JSON.stringify({ count: n }) : String(n));
    return 0;
  }

  if (cmd === "size") {
    const spec = buildSpec(f, f.positional, DEFAULTS.limit);
    const n = await totalSize(es, spec);
    out(json ? JSON.stringify({ bytes: n, human: humanSize(n) }) : n === null ? "size unavailable from index" : `${n}  (${humanSize(n)})`);
    return 0;
  }

  // find / recent
  const defaultSort: SortKey = cmd === "recent" ? "modified" : "size";
  const spec = buildSpec(f, f.positional, intFlag(f, "-n", DEFAULTS.limit), defaultSort);
  const r = await find(es, spec);
  if (json) {
    out(JSON.stringify(r, null, 2));
    return 0;
  }
  const showDate = f.bool.has("--date") || cmd === "recent";
  const body = renderFind(r, { showDate }).split("\n");
  const rows = body.slice(0, -1).join("\n");
  out(rows);
  if (!quiet) process.stderr.write(summaryLine(r) + "\n");
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof EsError || err instanceof Error ? err.message : String(err);
    process.stderr.write(`ev: ${msg}\n`);
    process.exit(1);
  });
