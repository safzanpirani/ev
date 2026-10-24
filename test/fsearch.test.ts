import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { buildFsQuery, parseWhen, UnsupportedFlag, type FsRequest } from "../src/fsquery.ts";
import { makeFsearchClient, parseGrep, parseHits, parseStatus, FsearchError, type FsHit, type Transport } from "../src/fsearch.ts";
import { find, count, totalSize, byExtension, topBy, sortHits, toRow, doctor, FIND_TOTAL_CAP } from "../src/mac.ts";
import { runFsearch, selectBackend, resolveDir, type MacContext, type MacFlags } from "../src/maccli.ts";
import { macSummaryLine } from "../src/macrender.ts";

// Real daemon replies, captured from fsearch ffcb37d on the Mac (4.0M entries).
// Each fixture is named after the fact it pins.
const REAL = {
  /** {"q":"fsearch main","limit":3}: keys sorted, mtime in unix seconds, size in bytes. */
  hits: '{"hits":[{"kind":"file","mtime":1791719875,"path":"/Users/safzan/Development/vendor/fsearch/src/main.rs","score":400,"size":11270},{"kind":"file","mtime":1791719875,"path":"/Users/safzan/Development/vendor/fsearch/.git/logs/refs/heads/main","score":396,"size":190},{"kind":"file","mtime":1791719875,"path":"/Users/safzan/Development/vendor/fsearch/.git/refs/heads/main","score":396,"size":41}],"id":null,"ok":true,"took_us":128302}',
  /** No match is an empty array with ok:true, not an error. */
  empty: '{"hits":[],"id":null,"ok":true,"took_us":4915}',
  /** Folders report size 0: there are no folder-size rollups. Symlinks report their own length. */
  dirAndLink: '{"hits":[{"kind":"dir","mtime":1790436246,"path":"/Users/safzan/Development/moshi-re/artifacts/apk-3.15.0/x","score":151,"size":0},{"kind":"link","mtime":1789801172,"path":"/Applications/Safari.app","score":31,"size":54}],"id":7,"ok":true,"took_us":27533}',
  /** Every search answers this while the first index builds. */
  indexing: '{"error":"indexing: 1.3M entries so far (the first run lists the whole disk, ~25s)","id":null,"ok":false}',
  /** A bad filter value is an ok:false reply, not a dropped connection. */
  badRange: '{"error":"bad range bad","id":null,"ok":false}',
  /** {"op":"grep","pattern":"apply_dir","in":"~/Development/vendor/fsearch"}: outside the content index it scans. */
  grep: '{"candidates":351,"complete":true,"id":null,"indexing":0,"ok":true,"read":351,"source":"scan","took_us":43691,"files":[{"matches":[{"line":201,"text":"    pub fn apply_dir(&mut self, path: &[u8], recursive: bool) -> Applied {"}],"path":"/Users/safzan/Development/vendor/fsearch/src/live.rs"}]}',
  /** {"op":"status"} once ready, without Full Disk Access. */
  status: '{"content_bytes":1188116992,"content_docs":601429,"content_pending":0,"content_segments":23,"dirs":620666,"entries":4004428,"event_id":153419569,"full_disk_access":false,"id":null,"index_bytes":174926464,"ok":true,"overlay":1876,"owner":true,"removed":173}',
};
const reply = (s: string) => JSON.parse(s) as Record<string, unknown>;

const NOW = new Date(2026, 9, 11, 17, 30, 0).getTime();

describe("fsearch replies", () => {
  test("a name search parses to hits with the daemon's exact fields", () => {
    const hits = parseHits(reply(REAL.hits));
    expect(hits).toHaveLength(3);
    expect(hits[0]).toEqual({ kind: "file", mtime: 1791719875, path: "/Users/safzan/Development/vendor/fsearch/src/main.rs", score: 400, size: 11270 });
  });

  test("no match is an empty list", () => {
    expect(parseHits(reply(REAL.empty))).toEqual([]);
  });

  test("the first index build is reported as a wait with its progress, not as a failure", () => {
    try {
      parseHits(reply(REAL.indexing));
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FsearchError);
      expect((err as FsearchError).indexing).toBe(true);
      expect((err as Error).message).toContain("1.3M entries");
      expect((err as Error).message).toContain("ev doctor");
    }
  });

  test("a daemon error surfaces its own text", () => {
    expect(() => parseHits(reply(REAL.badRange))).toThrow("fsearch: bad range bad");
  });

  test("a hit with an unexpected shape is reported rather than rendered as garbage", () => {
    expect(() => parseHits({ ok: true, hits: [{ path: "/x", kind: "file", size: "big", mtime: 1, score: 1 }] })).toThrow(/does not understand/);
  });

  test("content search parses files, line numbers and the index-or-scan source", () => {
    const g = parseGrep(reply(REAL.grep));
    expect(g.files[0]!.matches[0]!.line).toBe(201);
    expect(g.source).toBe("scan");
    expect(g.complete).toBe(true);
    expect(g.candidates).toBe(351);
  });

  test("status reports Full Disk Access as the daemon sees it", () => {
    const s = parseStatus(reply(REAL.status));
    expect(s.entries).toBe(4004428);
    expect(s.full_disk_access).toBe(false);
  });
});

describe("rows", () => {
  test("rows have the es shape; folders carry no size because fsearch reports 0 for them", () => {
    const [dir, link] = parseHits(reply(REAL.dirAndLink));
    expect(Object.keys(toRow(dir!)).sort()).toEqual(["date_modified", "filename"]);
    expect(toRow(link!)).toMatchObject({ filename: "/Applications/Safari.app", size: 54 });
    expect(toRow(link!).date_modified).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
  });
});

describe("QuerySpec to fsearch query", () => {
  const q = (spec: Parameters<typeof buildFsQuery>[0], extra: Partial<Parameters<typeof buildFsQuery>[1]> = {}) =>
    buildFsQuery(spec, { limit: 50, now: NOW, ...extra });

  test("terms pass through as fsearch syntax and filters map one to one", () => {
    expect(q({ terms: ["mian.rs", "'exact"], ext: ["rs", "toml"], type: "files" }).q).toBe("mian.rs 'exact ext:rs,toml kind:file");
    expect(q({ terms: [], type: "folders" }).q).toBe("kind:dir");
  });

  test("limit rides as its own JSON field", () => {
    expect(q({ terms: ["x"] }, { limit: 7 })).toEqual({ q: "x", limit: 7 });
  });

  test("a path with spaces is double-quoted, which fsearch's word splitter keeps together", () => {
    expect(q({ terms: [], under: "/Users/me/Library/Application Support" }).q).toBe('in:"/Users/me/Library/Application Support"');
    expect(q({ terms: ["black myth"] }).q).toBe('"black myth"');
  });

  test("a value containing a double quote is refused, since fsearch's syntax cannot carry it", () => {
    expect(() => q({ terms: [], under: '/tmp/a"b' })).toThrow(/--under.*double quote/);
  });

  // fsearch keeps one size range: a second size: filter replaces the first.
  test("both size bounds share one range", () => {
    expect(q({ terms: [], larger: 100, smaller: 2000 }).q).toBe("size:100..2000");
    expect(q({ terms: [], larger: 1073741824 }).q).toBe("size:>=1073741824");
    expect(q({ terms: [], smaller: 10 }).q).toBe("size:<=10");
  });

  test("dates become ages in seconds, because fsearch's mtime filter is an age", () => {
    expect(q({ terms: [], modifiedAfter: "7d" }).q).toBe("mtime:<=604800s");
    expect(q({ terms: [], modifiedBefore: "1h" }).q).toBe("mtime:>=3600s");
    expect(q({ terms: [], modifiedAfter: "2026-10-11" }).q).toBe(`mtime:<=${17.5 * 3600}s`);
    expect(q({ terms: [], modifiedAfter: "yesterday", modifiedBefore: "today" }).q).toBe(`mtime:${17.5 * 3600}s..${41.5 * 3600}s`);
  });

  test("an unreadable date names the forms that work", () => {
    expect(() => parseWhen("--after", "lastweek", NOW)).toThrow(/--after.*today, yesterday, or an age like 7d/);
    expect(() => parseWhen("--after", "2026-02-30", NOW)).toThrow();
  });

  test("--parent becomes a scope plus a one-segment path regex", () => {
    expect(q({ terms: [], parent: "/Users/me/a.b" }).q).toBe("in:/Users/me/a.b path:^/Users/me/a\\.b/[^/]+$");
  });

  test("--regex matches the name, and the full path with --match-path", () => {
    expect(q({ terms: ["^main\\.rs$"], regex: true }).q).toBe("re:^main\\.rs$");
    expect(q({ terms: ["src/.*\\.rs$"], regex: true, matchPath: true }).q).toBe("path:src/.*\\.rs$");
    expect(() => q({ terms: ["a", "b"], regex: true })).toThrow(/exactly one pattern/);
  });

  test("content search sends the pattern as its own field, so quotes need no escaping", () => {
    const r: FsRequest = q({ terms: [], ext: ["rs"] }, { grep: 'say "hi"' });
    expect(r).toEqual({ q: "ext:rs", limit: 50, op: "grep", pattern: 'say "hi"', mode: "literal" });
    expect(q({ terms: [] }, { grepRegex: "fn\\s+\\w+" })).toMatchObject({ op: "grep", mode: "regex" });
  });

  test("flags with no fsearch equivalent fail and name the flag", () => {
    expect(() => q({ terms: ["x"], matchCase: true })).toThrow(UnsupportedFlag);
    expect(() => q({ terms: ["x"], matchCase: true })).toThrow(/^--case is not supported on macOS/);
    expect(() => q({ terms: ["x"], wholeWord: true })).toThrow(/^--whole-word/);
    expect(() => q({ terms: ["x"], matchPath: true })).toThrow(/^--match-path/);
    expect(() => q({ terms: [], under: "/a", parent: "/a/b" })).toThrow(/--under with --parent/);
  });
});

/**
 * A fake daemon over a synthetic file list. It applies the filters ev sends
 * (kind, size, mtime, limit) and keeps list order as the "ranking", which is
 * enough to check that ev's counting and top-by-size logic is exact.
 */
function fakeDaemon(files: FsHit[], nowSec: number) {
  const requests: Array<Record<string, unknown>> = [];
  const send: Transport = async (req) => {
    requests.push(req);
    const q = String(req["q"] ?? "");
    let lo = 0, hi = Infinity, mlo = -Infinity, mhi = Infinity;
    let kind: string | undefined;
    for (const w of q.split(" ")) {
      let m;
      if ((m = /^size:>=(\d+)$/.exec(w))) lo = Number(m[1]);
      else if ((m = /^size:<=(\d+)$/.exec(w))) hi = Number(m[1]);
      else if ((m = /^size:(\d+)\.\.(\d+)$/.exec(w))) [lo, hi] = [Number(m[1]), Number(m[2])];
      else if ((m = /^mtime:<=(\d+)s$/.exec(w))) mlo = nowSec - Number(m[1]);
      else if ((m = /^mtime:>=(\d+)s$/.exec(w))) mhi = nowSec - Number(m[1]);
      else if ((m = /^mtime:(\d+)s\.\.(\d+)s$/.exec(w))) [mhi, mlo] = [nowSec - Number(m[1]), nowSec - Number(m[2])];
      else if ((m = /^kind:(\w+)$/.exec(w))) kind = m[1];
    }
    const hits = files.filter((f) => f.size >= lo && f.size <= hi && f.mtime >= mlo && f.mtime <= mhi && (!kind || f.kind === kind));
    return { ok: true, hits: hits.slice(0, Number(req["limit"] ?? 50)) };
  };
  return { client: makeFsearchClient(send), requests };
}

/** Deterministic pseudo-random sizes with heavy ties, so a threshold band can overflow. */
function synthetic(n: number, nowSec: number): FsHit[] {
  let x = 42;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  return Array.from({ length: n }, (_, i) => ({
    kind: "file" as const,
    path: `/data/f${String(i).padStart(6, "0")}.bin`,
    score: 0,
    size: rnd() < 0.3 ? 4096 : Math.floor(rnd() ** 3 * 5e9),
    mtime: nowSec - Math.floor(rnd() * 400 * 86400),
  }));
}

describe("find over fsearch", () => {
  const nowSec = Math.floor(NOW / 1000);

  test("a complete match set reports an exact total and total size", async () => {
    const { client } = fakeDaemon(parseHits(reply(REAL.hits)), nowSec);
    const r = await find(client, { terms: ["fsearch", "main"], limit: 2 }, { now: NOW });
    expect(r).toMatchObject({ total: 3, shown: 2, totalSize: 11270 + 190 + 41, truncated: true, totalExact: true });
    expect(macSummaryLine(r)).toBe("-- 3 matches, 11.2K total; showing 2. Raise with -n, page with --offset.");
  });

  test("past the cap the total is a floor and the size is unknown, never a guess", async () => {
    const { client, requests } = fakeDaemon(synthetic(300, nowSec), nowSec);
    const r = await find(client, { terms: [], limit: 5 }, { now: NOW, totalCap: 100 });
    expect(requests[0]!["limit"]).toBe(101); // one more than the cap proves completeness
    expect(r).toMatchObject({ total: 100, totalSize: null, truncated: true, totalExact: false });
    expect(macSummaryLine(r)).toContain("more than 100 matches");
  });

  test("the cap default is the pinned 10,000", () => {
    expect(FIND_TOTAL_CAP).toBe(10_000);
  });

  test("largest-first is exact even when the matches far exceed one fetch", async () => {
    const files = synthetic(30_000, nowSec);
    const { client } = fakeDaemon(files, nowSec);
    const want = sortHits(files, "size").slice(0, 40).map((h) => h.size);
    const r = await find(client, { terms: [], sort: "size", limit: 40 }, { now: NOW, totalCap: 1000 });
    expect(r.rows.map((x) => x.size)).toEqual(want);
    expect(r.totalExact).toBe(false);
  });

  test("a crowd of identical sizes at the boundary still yields an exact top-N", async () => {
    // 5,000 files of exactly 4096 bytes under 20 bigger ones: no step and no
    // bisection can split the tie, so the tie is filled from the boundary.
    const files: FsHit[] = [
      ...Array.from({ length: 5000 }, (_, i) => ({ kind: "file" as const, path: `/t/${i}`, score: 0, size: 4096, mtime: nowSec })),
      ...Array.from({ length: 20 }, (_, i) => ({ kind: "file" as const, path: `/b/${i}`, score: 0, size: 10_000 + i, mtime: nowSec })),
    ];
    const { client } = fakeDaemon(files, nowSec);
    const top = await topBy(client, { terms: [] }, 30, "size", NOW);
    expect(top.map((h) => h.size)).toEqual([...Array.from({ length: 20 }, (_, i) => 10_019 - i), ...Array(10).fill(4096)]);
  });

  test("newest-first is exact and respects --before", async () => {
    const files = synthetic(20_000, nowSec);
    const { client } = fakeDaemon(files, nowSec);
    const cutoff = nowSec - 86400;
    const want = sortHits(files.filter((f) => f.mtime <= cutoff), "modified").slice(0, 25).map((h) => h.path);
    const r = await find(client, { terms: [], sort: "modified", modifiedBefore: "1d", limit: 25 }, { now: NOW, totalCap: 500 });
    expect(r.rows.map((x) => x.filename)).toEqual(want);
  });

  test("offset pages through one consistent ordering", async () => {
    const files = synthetic(500, nowSec);
    const { client } = fakeDaemon(files, nowSec);
    const all = await find(client, { terms: [], sort: "size", limit: 20 }, { now: NOW });
    const page = await find(client, { terms: [], sort: "size", limit: 10, offset: 10 }, { now: NOW });
    expect(page.rows).toEqual(all.rows.slice(10));
  });

  test("sorts with no threshold to narrow by refuse past the cap and say how to fix it", async () => {
    const { client } = fakeDaemon(synthetic(300, nowSec), nowSec);
    await expect(find(client, { terms: [], sort: "name", limit: 5 }, { now: NOW, totalCap: 100 })).rejects.toThrow(/--sort name needs every match.*Narrow it/);
    await expect(find(client, { terms: [], sort: "size", ascending: true, limit: 5 }, { now: NOW, totalCap: 100 })).rejects.toThrow(/--sort size --asc/);
    await expect(find(client, { terms: [], sort: "created" }, { now: NOW })).rejects.toThrow(/--sort created is not supported/);
  });

  test("an unsupported flag fails before any request leaves", async () => {
    const { client, requests } = fakeDaemon([], nowSec);
    await expect(find(client, { terms: ["x"], wholeWord: true }, { now: NOW })).rejects.toThrow(UnsupportedFlag);
    expect(requests).toHaveLength(0);
  });
});

describe("count, size, ext over fsearch", () => {
  const nowSec = Math.floor(NOW / 1000);

  test("count is exact under the cap and a floor above it", async () => {
    const { client } = fakeDaemon(synthetic(250, nowSec), nowSec);
    expect(await count(client, { terms: [] }, 1000, NOW)).toEqual({ count: 250, exact: true });
    expect(await count(client, { terms: [] }, 100, NOW)).toEqual({ count: 100, exact: false });
  });

  test("a set of exactly the cap is known complete, because ev asks for one more", async () => {
    const { client } = fakeDaemon(synthetic(100, nowSec), nowSec);
    expect(await count(client, { terms: [] }, 100, NOW)).toEqual({ count: 100, exact: true });
  });

  test("size refuses a partial sum and points at sweep", async () => {
    const { client } = fakeDaemon(synthetic(250, nowSec), nowSec);
    await expect(totalSize(client, { terms: [] }, 100, NOW)).rejects.toThrow(/more than 100 matches.*sweep dust/);
  });

  test("ext over a sampled tree groups exactly the largest files", async () => {
    const files = synthetic(3000, nowSec).map((f, i) => ({ ...f, path: `/d/f${i}.${i % 3 ? "mkv" : "srt"}` }));
    const { client } = fakeDaemon(files, nowSec);
    const r = await byExtension(client, "/d", 500, NOW);
    expect(r).toMatchObject({ scanned: 500, total: 500, sampled: true, totalExact: false });
    const want = sortHits(files, "size").slice(0, 500).reduce((n, f) => n + f.size, 0);
    expect(r.entries.reduce((n, e) => n + e.size, 0)).toBe(want);
  });
});

describe("doctor", () => {
  const facts = {
    binary: "/Users/me/.local/bin/fsearch", binaryExists: true, socket: "/s", dataDir: "/d", indexOnDiskBytes: 1,
    skipped: ["/Users/me/Desktop", "/Users/me/Downloads", "/Volumes", "/private/var/db/biome"], pid: 9, rssBytes: 200e6,
  };

  test("reports missing Full Disk Access with what it costs and the fix", async () => {
    const probe = makeFsearchClient(async (req) => (req["op"] === "ping" ? { ok: true } : reply(REAL.status)));
    const d = await doctor(probe, facts, "/Users/me");
    expect(d.ok).toBe(true);
    expect(d.fullDiskAccess).toBe(false);
    expect(d.skippedGated).toEqual(["/Users/me/Desktop", "/Users/me/Downloads", "/Volumes"]);
    expect(d.skippedRefused).toBe(1);
    expect(d.fixes.join("\n")).toContain("Full Disk Access");
    expect(d.index.entries).toBe(4004428);
  });

  test("reports first-build progress instead of failing", async () => {
    const probe = makeFsearchClient(async (req) => (req["op"] === "ping" ? { ok: true } : reply(REAL.indexing)));
    const d = await doctor(probe, facts, "/Users/me");
    expect(d.ok).toBe(false);
    expect(d.index.progress).toContain("1.3M entries");
  });

  test("a daemon that does not answer is named, with how to start it", async () => {
    const probe = makeFsearchClient(async () => {
      throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
    });
    const d = await doctor(probe, facts, "/Users/me");
    expect(d).toMatchObject({ ok: false, daemonAnswering: false });
    expect(d.fixes[0]).toContain("Any ev search starts it");
  });
});

describe("backend selection", () => {
  test("darwin uses fsearch, linux uses plocate, Windows keeps es, and $EV_BACKEND overrides", () => {
    expect(selectBackend("darwin", {})).toBe("fsearch");
    expect(selectBackend("win32", {})).toBe("es");
    expect(selectBackend("linux", {})).toBe("locate");
    expect(selectBackend("darwin", { EV_BACKEND: "es" })).toBe("es");
    expect(selectBackend("darwin", { EV_BACKEND: "locate" })).toBe("locate");
    expect(() => selectBackend("darwin", { EV_BACKEND: "mdfind" })).toThrow(/EV_BACKEND/);
  });

  test("relative and ~ paths resolve, since fsearch's in: only expands ~", () => {
    expect(resolveDir("~/x/nope", "/Users/me", "/w")).toBe("/Users/me/x/nope");
    expect(resolveDir("rel/nope", "/Users/me", "/w")).toBe("/w/rel/nope");
  });
});

describe("native content queries through the macOS frontend", () => {
  async function run(terms: string[], extra: { json?: boolean; quiet?: boolean; offset?: number; pattern?: string; cmd?: string } = {}) {
    const requests: Record<string, unknown>[] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const f: MacFlags = {
      positional: terms,
      str: new Map(extra.pattern === undefined ? [] : [["--grep", extra.pattern]]),
      multi: new Map(),
      bool: new Set([...(extra.json ? ["--json"] : []), ...(extra.quiet ? ["-q"] : [])]),
    };
    const ctx: MacContext = {
      buildSpec: (_flags, words, limit, sort) => ({ terms: words, ext: ["rs"], limit, offset: extra.offset, sort }),
      intFlag: (_flags, _name, fallback) => fallback,
      roots: () => [],
      out: (s) => output.push(s),
      err: (s) => errors.push(s),
      defaultLimit: 1,
      now: () => NOW,
      client: makeFsearchClient(async (req) => {
        requests.push(req);
        return reply(REAL.grep);
      }),
    };
    const code = await runFsearch(extra.cmd ?? "find", f, ctx);
    return { code, requests, output, errors };
  }

  for (const word of ["sym:apply_dir", "grep:apply_dir", "regex:apply_.*", "content:apply_dir", "symbol:apply_dir"]) {
    test(`${word} keeps its native pattern and receives a content result`, async () => {
      const r = await run([word, "live"], { json: true });
      expect(r.code).toBe(0);
      expect(r.requests).toEqual([{ q: `${word} live ext:rs`, limit: 1, op: "grep" }]);
      expect(JSON.parse(r.output[0]!)).toMatchObject({
        files: [{ path: "/Users/safzan/Development/vendor/fsearch/src/live.rs", matches: [{ line: 201 }] }],
        source: "scan", complete: true, shown: 1, offset: 0,
      });
      expect(r.errors).toEqual([]);
    });
  }

  test("quoted native patterns keep spaces and content rendering, not name rows", async () => {
    const r = await run(["grep:pub fn"]);
    expect(r.requests[0]).toEqual({ q: '"grep:pub fn" ext:rs', limit: 1, op: "grep" });
    expect(r.output[0]).toContain("pub fn apply_dir");
    expect(r.output[0]).toContain("201");
    expect(r.errors).toHaveLength(1);
  });

  test("native content queries honor offset, limit and quiet output", async () => {
    const r = await run(["sym:apply_dir"], { offset: 1, quiet: true });
    expect(r.requests[0]!["limit"]).toBe(2);
    expect(r.output).toEqual([""]);
    expect(r.errors).toEqual([]);
  });

  test("explicit content flags retain daemon precedence over native words", async () => {
    const r = await run(["sym:apply_dir"], { json: true, pattern: 'say "hi"' });
    expect(r.requests[0]).toEqual({ q: "sym:apply_dir ext:rs", limit: 1, op: "grep", pattern: 'say "hi"', mode: "literal" });
  });

  test("name-only verbs reject native content words before contacting the daemon", async () => {
    for (const cmd of ["recent", "count", "size"]) {
      await expect(run(["sym:apply_dir"], { cmd })).rejects.toThrow(/ev find/);
    }
  });
});

describe("cli on each backend", () => {
  async function cli(args: string[], backend: "es" | "fsearch") {
    const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, EV_BACKEND: backend, EV_CONFIG: "/nonexistent/ev/config.json", EV_ES_PATH: "/nonexistent/es.exe", EV_FSEARCH_PATH: "/nonexistent/fsearch" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, stdout, stderr };
  }

  test("du on macOS points to sweep dust", async () => {
    const r = await cli(["du", "/tmp"], "fsearch");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("sweep dust <dir>");
  });

  test("link refuses to plan on macOS", async () => {
    const r = await cli(["link", "--ext", "onnx"], "fsearch");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ev link cannot plan or apply on macOS");
  });

  test("an unsupported flag on macOS fails before fsearch is contacted", async () => {
    const r = await cli(["find", "--case", "x"], "fsearch");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--case is not supported on macOS");
  });
});
