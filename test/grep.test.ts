import { test, expect, describe } from "bun:test";
import { makeClient, type Runner } from "../src/es.ts";
import { grepMain, mainGrepSummary, GREP_MAX_BYTES } from "../src/grep.ts";

/** An index that lists `paths` as candidates and reports `total` matches. */
function index(paths: string[], total = paths.length) {
  const calls: string[][] = [];
  const run: Runner = async (_exe, args) => {
    calls.push(args);
    const stdout = args.includes("-get-result-count") ? String(total) : JSON.stringify(paths.map((filename) => ({ filename })));
    return { ok: true, stdout, stderr: "", code: 0 };
  };
  return { es: makeClient("es.exe", "1.5a", run), calls };
}

function disk(files: Record<string, string | Uint8Array>) {
  const reads: string[] = [];
  const read = async (p: string) => {
    reads.push(p);
    const v = files[p];
    if (v === undefined) return null;
    return typeof v === "string" ? new TextEncoder().encode(v) : v;
  };
  return { read, reads };
}

describe("grep on main", () => {
  test("asks the index for small files in path order, then reports matching lines in that order", async () => {
    const { es, calls } = index(["C:\\a.py", "C:\\b.py", "C:\\c.py"]);
    const { read } = disk({ "C:\\a.py": "x\nNeedle here\r\nno", "C:\\b.py": "nothing", "C:\\c.py": "needle" });
    const r = await grepMain(es, { terms: [], ext: ["py"], limit: 10 }, { literal: "needle" }, { cap: 100, read });
    expect(r.files).toEqual([
      { path: "C:\\a.py", matches: [{ line: 2, text: "Needle here" }] },
      { path: "C:\\c.py", matches: [{ line: 1, text: "needle" }] },
    ]);
    expect(r.complete).toBe(true);
    const listing = calls.find((a) => a.includes("-json"))!;
    expect(listing).toContain("/a-d");
    expect(listing).toContain("path-ascending");
    expect(listing).toContain(`size:<=${GREP_MAX_BYTES}`);
  });

  test("--case and a regex are honoured", async () => {
    const { es } = index(["C:\\a.txt"]);
    const { read } = disk({ "C:\\a.txt": "Foo\nfoo\nfoo42" });
    const cased = await grepMain(es, { terms: [], matchCase: true }, { literal: "Foo" }, { cap: 10, read });
    expect(cased.files[0]!.matches.map((m) => m.line)).toEqual([1]);
    const re = await grepMain(es, { terms: [] }, { regex: "foo\\d+" }, { cap: 10, read });
    expect(re.files[0]!.matches.map((m) => m.line)).toEqual([3]);
  });

  test("dependency folders and binary files are not searched, and the summary says so", async () => {
    const { es } = index(["C:\\p\\node_modules\\x.js", "C:\\p\\a.bin", "C:\\p\\a.js"]);
    const { read, reads } = disk({ "C:\\p\\a.bin": new Uint8Array([104, 0, 105]), "C:\\p\\a.js": "hi" });
    const r = await grepMain(es, { terms: [] }, { literal: "h" }, { cap: 10, read });
    expect(reads).not.toContain("C:\\p\\node_modules\\x.js");
    expect(r.skippedDirs).toBe(1);
    expect(r.binary).toBe(1);
    expect(r.files.map((f) => f.path)).toEqual(["C:\\p\\a.js"]);
    expect(mainGrepSummary(r, 10)).toContain("--all-dirs");
    const all = await grepMain(es, { terms: [] }, { literal: "h" }, { cap: 10, read, allDirs: true });
    expect(all.skippedDirs).toBe(0);
  });

  // Live 2026-10-24: under C:\amos, 4,998 of the first 5,000 files by path sat in .venv,
  // so filtering after the cap left 2 files to read. The index must exclude them first.
  test("dependency folders are excluded in the index query, before the cap applies", async () => {
    const { es, calls } = index(["C:\\p\\a.js"]);
    await grepMain(es, { terms: ["x"] }, { literal: "h" }, { cap: 10, read: disk({}).read });
    const listing = calls.find((a) => a.includes("-json"))!;
    expect(listing).toContain("!\\.venv\\");
    expect(listing).toContain("!\\node_modules\\");
    const regexCalls = index(["C:\\p\\a.js"]);
    await grepMain(regexCalls.es, { terms: ["^a"], regex: true }, { literal: "h" }, { cap: 10, read: disk({}).read });
    expect(regexCalls.calls.find((a) => a.includes("-json"))!.some((t) => t.startsWith("!"))).toBe(false);
  });

  test("stops reading once -n files matched, and says the answer is partial", async () => {
    const paths = Array.from({ length: 40 }, (_, i) => `C:\\f${String(i).padStart(2, "0")}.txt`);
    const { es } = index(paths);
    const { read, reads } = disk(Object.fromEntries(paths.map((p) => [p, "hit"])));
    const r = await grepMain(es, { terms: [], limit: 2 }, { literal: "hit" }, { cap: 100, read, concurrency: 4 });
    expect(r.files.map((f) => f.path)).toEqual(paths.slice(0, 2));
    expect(reads.length).toBe(4);
    expect(r.complete).toBe(false);
    expect(mainGrepSummary(r, 100)).toContain("Raise -n");
  });

  test("more candidates than --cap is reported, not hidden", async () => {
    const { es } = index(["C:\\a.txt"], 9000);
    const { read } = disk({ "C:\\a.txt": "x" });
    const r = await grepMain(es, { terms: [] }, { literal: "x" }, { cap: 1, read });
    expect(r.capped).toBe(true);
    expect(mainGrepSummary(r, 1)).toContain("raise --cap");
  });
});
