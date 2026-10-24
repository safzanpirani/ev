import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SizeAccumulator, saveSizes, openSizes, cachedDu, cachedDuTree } from "../src/sizes.ts";

test("folder totals reach every ancestor up to / and count a hard-linked file once", () => {
  const acc = new SizeAccumulator();
  acc.record("d 4096 1:1 1 /m");
  acc.record("d 4096 1:2 1 /m/a");
  acc.record("f 100 1:3 1 /m/a/x.bin");
  acc.record("f 50 1:4 2 /m/a/y.bin");
  acc.record("f 50 1:4 2 /m/b/y-link.bin");
  acc.record("f 7 1:5 1 /m/name with spaces.txt");
  expect(acc.dirs.get("/m/a")).toEqual({ bytes: 150, files: 2 });
  expect(acc.dirs.get("/m")).toEqual({ bytes: 157, files: 3 });
  expect(acc.dirs.get("/")).toEqual({ bytes: 157, files: 3 });
  expect(acc.dirs.get("/m/b")).toBeUndefined();
});

test("du reads folder totals from the cache and loose files from disk", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "ev-sizes-")));
  try {
    await mkdir(join(root, "big"));
    await mkdir(join(root, "big", "deep"));
    await mkdir(join(root, "empty"));
    await writeFile(join(root, "loose.txt"), "x".repeat(30));
    const acc = new SizeAccumulator();
    acc.dir(root);
    acc.dir(join(root, "big"));
    acc.dir(join(root, "big", "deep"));
    acc.dir(join(root, "empty"));
    acc.file(join(root, "big", "deep", "a.bin"), 900, "1:1", 1);
    acc.file(join(root, "big", "b.bin"), 100, "1:2", 1);
    const db = join(`${root}-db`, "sizes.db");
    await mkdir(`${root}-db`);
    saveSizes(db, acc);
    const cache = openSizes(db)!;
    try {
      const r = cachedDu(cache, root, 10);
      expect(r.entries.map((e) => [e.name, e.size, e.kind])).toEqual([
        ["big", 1000, "folder"], ["loose.txt", 30, "file"], ["empty", 0, "folder"],
      ]);
      expect(r.folderTotal).toBe(1000);
      const t = cachedDuTree(cache, root, 2, 5);
      expect(t.entries[0]!.children!.map((e) => [e.name, e.size])).toEqual([["deep", 900]]);
    } finally {
      cache.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}-db`, { recursive: true, force: true });
  }
});
