#!/usr/bin/env bun
// Thin frontend: parse, call core, render, exit.

import { loadConfig, DEFAULTS } from "./config.ts";
import { makeClient, EsError } from "./es.ts";
import { parseSize, type QuerySpec, type SortKey, type TypeFilter } from "./query.ts";
import { find, count, totalSize, du, duTree, byExtension, dupes, doctor } from "./core.ts";
import { renderFind, renderDu, renderExt, renderDupes, renderDuTree, renderDoctor, renderLinkPlan, renderApply, humanSize, summaryLine } from "./render.ts";
import { planLinks, applyLinks, undoLinks, type Journal } from "./link.ts";
import { makeFsDeps } from "./fsdeps.ts";
import { writeFileSync, readFileSync } from "node:fs";

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
  --under <path>      restrict to a directory subtree
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
  --json              emit the whole result as JSON
  -q                  suppress the trailing summary line

LINK OPTIONS
  --yes               actually create the links (without it, nothing changes)
  --quick             hash a 1MB head and tail instead of the whole file
  --journal <path>    where to write the undo journal
  --undo <path>       restore independent copies from a journal (needs --yes)

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
`;

interface Flags {
  positional: string[];
  str: Map<string, string>;
  bool: Set<string>;
}

const STR_FLAGS = new Set([
  "--ext", "--under", "--parent", "--larger", "--smaller", "--after", "--before",
  "-n", "--offset", "--sort", "--cap", "--journal", "--undo", "--depth",
]);
const BOOL_FLAGS = new Set([
  "--files", "--folders", "--regex", "--case", "--whole-word", "--match-path",
  "--asc", "--date", "--json", "-q", "-h", "--help", "--yes", "--quick",
]);

function parseFlags(argv: string[]): Flags {
  const positional: string[] = [];
  const str = new Map<string, string>();
  const bool = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (STR_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
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
  return { positional, str, bool };
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

  const under = f.str.get("--under");
  if (under) spec.under = under;
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

  if (cmd === "raw") {
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
    const cap = intFlag(f, "--cap", 50_000);
    const minSize = f.str.get("--larger") ? parseSize(f.str.get("--larger")!) : 1024 * 1024;
    const spec = buildSpec(f, f.positional, cap);
    const candidates = await dupes(es, spec, cap);
    const plan = await planLinks(candidates.groups, fsDeps, { minSize });

    if (!apply) {
      out(json ? JSON.stringify(plan, null, 2) : renderLinkPlan(plan, limit, false));
      return 0;
    }
    const result = await applyLinks(plan, fsDeps);
    const journalPath =
      f.str.get("--journal") ?? `ev-journal-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(journalPath, JSON.stringify(result.journal, null, 2));
    out(json ? JSON.stringify({ ...result, journalPath }, null, 2) : renderApply(result, journalPath));
    return result.failures.length ? 1 : 0;
  }

  if (cmd === "dupes") {
    const limit = intFlag(f, "-n", 40);
    const cap = intFlag(f, "--cap", 50_000);
    const spec = buildSpec(f, f.positional, cap);
    const r = await dupes(es, spec, cap);
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
    out(json ? JSON.stringify({ bytes: n, human: humanSize(n) }) : `${n}  (${humanSize(n)})`);
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
