import { test, expect, describe } from "bun:test";
import { collect, planQueries, toDu, toDuTree, toDupes, toFind, type LxRow } from "../src/linux.ts";
import { mountView, linuxNotes } from "../src/linuxcli.ts";
import type { LocateClient, PathQuery } from "../src/locate.ts";

const NOW = Date.parse("2026-10-24T12:00:00Z");

/** A plocate that answers each query with `answer(q)`, recording what it was asked. */
function fakeLocate(answer: (q: PathQuery) => string[]): { locate: LocateClient; asked: PathQuery[] } {
  const asked: PathQuery[] = [];
  return {
    asked,
    locate: {
      db: "/x/plocate.db",
      paths: async (q) => {
        asked.push(q);
        return answer(q);
      },
      build: async () => ({ ms: 0 }),
      builtAt: () => NOW,
    },
  };
}

/** A disk: path → [kind, bytes, mtime ISO, ino]. Missing paths stat as gone. */
function fakeStat(disk: Record<string, [LxRow["kind"], number, string?, number?]>) {
  return (p: string): LxRow | null => {
    const e = disk[p];
    if (!e) return null;
    const [kind, bytes, mtime = "2026-10-20T00:00:00Z", ino = Object.keys(disk).indexOf(p)] = e;
    const mtimeMs = Date.parse(mtime);
    return { filename: p, kind, bytes, mtimeMs, birthMs: mtimeMs, id: `1:${ino}`, ...(kind === "dir" ? {} : { size: bytes }), date_modified: mtime };
  };
}

describe("plocate queries", () => {
  test("words match names, case-insensitively, and each extension is its own glob run", () => {
    const { queries } = planQueries({ terms: ["walking dead"], ext: ["mkv", "srt"] });
    expect(queries).toEqual([
      { patterns: ["walking", "dead", "*.mkv"], basename: true, ignoreCase: true, regex: false },
      { patterns: ["walking", "dead", "*.srt"], basename: true, ignoreCase: true, regex: false },
    ]);
  });

  test("with no name to look up, the subtree path is the pattern", () => {
    expect(planQueries({ terms: [], under: "/mnt/shared/" }).queries).toEqual([{ patterns: ["/mnt/shared"], basename: false, ignoreCase: false, regex: false }]);
  });

  test("Everything filter words are refused with the flags that replace them", () => {
    expect(() => planQueries({ terms: ["size:>1gb"] })).toThrow(/--larger/);
  });
});

describe("collect", () => {
  test("--under is a path prefix, not a substring; !words exclude; vanished entries are counted", async () => {
    const { locate } = fakeLocate(() => ["/mnt/a/x.mkv", "/mnt/ab/x.mkv", "/mnt/a/sample.mkv", "/mnt/a/old.mkv", "/home/mnt/a/x.mkv"]);
    const stat = fakeStat({ "/mnt/a/x.mkv": ["file", 10], "/mnt/ab/x.mkv": ["file", 10], "/mnt/a/sample.mkv": ["file", 10] });
    const c = await collect(locate, { terms: ["!sample"], under: "/mnt/a", ext: ["mkv"] }, { cap: 100, now: NOW, stat });
    expect(c.rows.map((r) => r.filename)).toEqual(["/mnt/a/x.mkv"]);
    expect(c.gone).toBe(1);
  });

  test("size and date filters read lstat, and --before a bare date covers that whole day", async () => {
    const { locate } = fakeLocate(() => ["/d/a", "/d/b", "/d/c", "/d/dir"]);
    const stat = fakeStat({
      "/d/a": ["file", 5 * 2 ** 30, "2026-10-23T18:00:00Z"],
      "/d/b": ["file", 10, "2026-10-23T18:00:00Z"],
      "/d/c": ["file", 5 * 2 ** 30, "2026-10-01T00:00:00Z"],
      "/d/dir": ["dir", 0, "2026-10-23T18:00:00Z"],
    });
    const c = await collect(locate, { terms: [], under: "/d", larger: 2 ** 30, modifiedAfter: "2026-10-22", modifiedBefore: "2026-10-23" }, { cap: 100, now: NOW, stat });
    expect(c.rows.map((r) => r.filename)).toEqual(["/d/a"]);
  });

  test("a match set over --cap is read only up to the cap and flagged", async () => {
    const { locate } = fakeLocate(() => ["/a", "/b", "/c"]);
    const c = await collect(locate, { terms: ["x"] }, { cap: 2, now: NOW, stat: fakeStat({ "/a": ["file", 1], "/b": ["file", 1], "/c": ["file", 1] }) });
    expect(c.sampled).toBe(true);
    expect(c.rows).toHaveLength(2);
    expect(linuxNotes(c, NOW, NOW, 2)[0]).toContain("raise --cap");
  });
});

describe("listings and rollups", () => {
  const disk = fakeStat({
    "/r/big": ["dir", 0],
    "/r/big/a.bin": ["file", 700, undefined, 50],
    "/r/big/link.bin": ["file", 700, undefined, 50], // a hard link to a.bin
    "/r/big/deep": ["dir", 0],
    "/r/big/deep/b.bin": ["file", 200],
    "/r/small": ["dir", 0],
    "/r/small/c.bin": ["file", 50],
    "/r/loose.txt": ["file", 30],
  });
  const all = ["/r", "/r/big", "/r/big/a.bin", "/r/big/link.bin", "/r/big/deep", "/r/big/deep/b.bin", "/r/small", "/r/small/c.bin", "/r/loose.txt"];

  test("du sums each folder from one listing and counts a hard-linked file once", async () => {
    const c = await collect(fakeLocate(() => all).locate, { terms: [], under: "/r" }, { cap: 100, now: NOW, stat: disk });
    const r = toDu(c.rows, "/r", 10);
    expect(r.entries.map((e) => [e.name, e.size])).toEqual([["big", 900], ["small", 50], ["loose.txt", 30]]);
    expect(r.grandTotal).toBe(980);
    expect(r.fileTotal).toBe(30);
    const t = toDuTree(c.rows, "/r", 2, 2, 0.02);
    expect(t.entries[0]!.children!.map((e) => e.name)).toEqual(["a.bin", "link.bin"]);
  });

  test("find sorts by size and totals hard links once", async () => {
    const c = await collect(fakeLocate(() => all).locate, { terms: [], under: "/r", type: "files" }, { cap: 100, now: NOW, stat: disk });
    const r = toFind(c, { terms: [], sort: "size", limit: 2 });
    expect(r.rows.map((x) => x.filename)).toEqual(["/r/big/a.bin", "/r/big/link.bin"]);
    expect(r.total).toBe(5);
    expect(r.totalSize).toBe(980);
    expect(r.truncated).toBe(true);
  });

  test("dupes groups same-name same-size files and folds hard links", async () => {
    const stat = fakeStat({ "/x/m.onnx": ["file", 9, undefined, 1], "/y/m.onnx": ["file", 9, undefined, 2], "/z/m.onnx": ["file", 9, undefined, 2] });
    const c = await collect(fakeLocate(() => ["/x/m.onnx", "/y/m.onnx", "/z/m.onnx"]).locate, { terms: ["m"] }, { cap: 100, now: NOW, stat });
    const r = toDupes([c]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.wasted).toBe(9);
    expect(r.groups[0]!.linked).toBe(1);
  });
});

test("doctor's mount view keeps real disks, names network drives, hides kernel views", () => {
  const v = mountView([
    "/dev/nvme0n1p9 / btrfs rw 0 0",
    "proc /proc proc rw 0 0",
    "/dev/sda1 /mnt/D\\040Drive fuseblk rw 0 0",
    "/dev/sdb1 /mnt/z ntfs3 rw 0 0",
    "nas:/x /mnt/nas nfs4 rw 0 0",
    "tmpfs /tmp tmpfs rw 0 0",
  ].join("\n"));
  expect(v.indexed.map((m) => m.path)).toEqual(["/", "/mnt/D Drive", "/mnt/z"]);
  expect(v.skipped).toEqual([{ path: "/mnt/nas", fs: "nfs4" }]);
});
