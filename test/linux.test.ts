import { test, expect, describe } from "bun:test";
import { collect, planQueries, toDu, toDuTree, toDupes, toFind, type LxRow } from "../src/linux.ts";
import { linuxNotes } from "../src/linuxcli.ts";
import { automountsToWake, mountPlan, type LocateClient, type PathQuery } from "../src/locate.ts";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// Lines from main's Omarchy boot, 2026-10-24. The first index run there held 325k
// entries: updatedb pruned /home as a bind mount and every NTFS automount as autofs,
// and waited 90 s on the unmounted /mnt/nvme-500gb.
test("the mount plan indexes subvolumes and mounted automounts, prunes binds and empty automounts", () => {
  const p = mountPlan([
    "33 2 0:30 /@ / rw,noatime shared:1 - btrfs /dev/nvme0n1p9 rw,subvol=/@",
    "26 33 0:24 / /proc rw shared:5 - proc proc rw",
    "152 33 0:30 /@home /home rw,noatime shared:192 - btrfs /dev/nvme0n1p9 rw,subvol=/@home",
    "103 33 259:6 / /mnt/shared rw,noatime shared:182 - ext4 /dev/nvme0n1p7 rw",
    "147 33 259:6 /jellyfin /var/lib/jellyfin rw,noatime shared:182 - ext4 /dev/nvme0n1p7 rw",
    "66 33 0:54 / /mnt/windows-c rw,relatime shared:102 - autofs systemd-1 rw,direct",
    "426 66 259:2 / /mnt/windows-c rw,relatime shared:734 - fuseblk /dev/nvme0n1p2 rw",
    "63 33 0:53 / /mnt/nvme-500gb rw,relatime shared:99 - autofs systemd-1 rw,direct",
    "599 281 0:84 / /home/x/gvfs rw shared:646 - fuse.gvfsd-fuse gvfsd-fuse rw",
    "700 33 0:90 / /mnt/My\\040Drive rw shared:9 - ntfs3 /dev/sdd1 rw",
  ].join("\n"));
  expect(p.indexed.map((m) => m.path)).toEqual(["/", "/home", "/mnt/shared", "/mnt/windows-c", "/mnt/My Drive"]);
  expect(p.prune).toEqual(["/var/lib/jellyfin", "/mnt/nvme-500gb"]);
  expect(p.skipped.map((m) => m.why)).toEqual(["bind mount of /mnt/shared", "automount with nothing mounted", "network or FUSE drive"]);
});

// Seen 2026-10-24 right after a boot: the hourly index ran before anything had opened the NTFS drives,
// so every automount was empty and pruned, and the index lost three drives.
test("attached disks behind empty automounts are woken; an absent disk is left alone", () => {
  const mountinfo = [
    "33 2 0:30 /@ / rw - btrfs /dev/nvme0n1p9 rw",
    "57 33 0:51 / /mnt/data-750gb rw - autofs systemd-1 rw,direct",
    "63 33 0:53 / /mnt/nvme-500gb rw - autofs systemd-1 rw,direct",
    "66 33 0:54 / /mnt/windows-c rw - autofs systemd-1 rw,direct",
    "426 66 259:2 / /mnt/windows-c rw - fuseblk /dev/nvme0n1p2 rw",
  ].join("\n");
  const fstab = [
    "# comment",
    "UUID=AAA639A7A6397543 /mnt/windows-c ntfs-3g uid=1000,x-systemd.automount 0 0",
    "UUID=2EC8AC85C8AC4D41 /mnt/data-750gb ntfs-3g uid=1000,nofail,x-systemd.automount 0 0",
    "UUID=C84E16C64E16ACE6 /mnt/nvme-500gb ntfs-3g uid=1000,nofail,x-systemd.automount 0 0",
  ].join("\n");
  const attached = new Set(["/dev/disk/by-uuid/AAA639A7A6397543", "/dev/disk/by-uuid/2EC8AC85C8AC4D41"]);
  expect(automountsToWake(mountinfo, fstab, (p) => attached.has(p))).toEqual(["/mnt/data-750gb"]);
});

test("a candidate lstat cannot read counts as gone instead of failing the query (papercut 58be5a)", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "ev-linux-")));
  const locked = join(root, "locked");
  try {
    await mkdir(locked);
    await writeFile(join(locked, "x.txt"), "x");
    await writeFile(join(root, "y.txt"), "yy");
    await chmod(locked, 0o444);
    const c = await collect(fakeLocate(() => [join(locked, "x.txt"), join(root, "y.txt")]).locate, { terms: [], under: root }, { cap: 100, now: NOW });
    expect(c.rows.map((r) => [r.filename, r.bytes])).toEqual([[join(root, "y.txt"), 2]]);
    expect(c.gone).toBe(1);
  } finally {
    await chmod(locked, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
