import { test, expect, describe } from "bun:test";
import { planLinks, applyLinks, undoLinks, isLinkable, type LinkDeps, type FileFacts, type Journal } from "../src/link.ts";
import type { DupeGroup } from "../src/core.ts";

/** An in-memory filesystem. Records every mutation so tests assert on real values. */
function fakeFs(files: Record<string, { ino: string; dev: number; nlink?: number; size: number; content: string; isSymlink?: boolean }>) {
  const fs = { ...files };
  const ops: string[] = [];
  const deps: LinkDeps = {
    async facts(path): Promise<FileFacts | null> {
      const f = fs[path];
      if (!f) return null;
      return { ino: f.ino, dev: f.dev, nlink: f.nlink ?? 1, size: f.size, isSymlink: f.isSymlink ?? false };
    },
    async hash(path) {
      const f = fs[path];
      if (!f) throw new Error("ENOENT");
      return `h(${f.content})`;
    },
    async link(existing, newPath) {
      ops.push(`link ${existing} -> ${newPath}`);
      const src = fs[existing]!;
      fs[newPath] = { ...src };
    },
    async rename(from, to) {
      ops.push(`rename ${from} -> ${to}`);
      fs[to] = fs[from]!;
      delete fs[from];
    },
    async unlink(path) {
      ops.push(`unlink ${path}`);
      delete fs[path];
    },
    async copy(from, to) {
      ops.push(`copy ${from} -> ${to}`);
      fs[to] = { ...fs[from]! , ino: `copy-${to}`, nlink: 1 };
    },
    now: () => "2026-09-10T00:00:00.000Z",
  };
  return { deps, fs, ops };
}

const MB = 1024 * 1024;

function group(paths: string[], size: number): DupeGroup {
  return { name: "x", size, paths, wasted: size * (paths.length - 1) };
}

describe("isLinkable", () => {
  test("refuses files that tools modify in place", () => {
    expect(isLinkable("F:\\app\\data.sqlite")).toBe(false);
    expect(isLinkable("F:\\vm\\disk.vhdx")).toBe(false);
    expect(isLinkable("F:\\logs\\out.log")).toBe(false);
    expect(isLinkable("C:\\pagefile.sys")).toBe(false);
  });

  test("refuses system and repository internals", () => {
    expect(isLinkable("C:\\Windows\\System32\\x.dll")).toBe(false);
    expect(isLinkable("C:\\Program Files\\app\\x.dll")).toBe(false);
    expect(isLinkable("F:\\proj\\.git\\objects\\ab\\cdef")).toBe(false);
    expect(isLinkable("C:/Windows/System32/x.dll")).toBe(false);
    expect(isLinkable("F:/proj/.git/objects/ab/cdef")).toBe(false);
  });

  test("allows the read-heavy files this exists for", () => {
    expect(isLinkable("F:\\models\\GFPGANv1.4.onnx")).toBe(true);
    expect(isLinkable("F:\\venv\\Lib\\site-packages\\torch\\lib\\cublasLt64_12.dll")).toBe(true);
    expect(isLinkable("F:\\SteamLibrary\\steamapps\\common\\g\\cas_01.cas")).toBe(true);
  });

  test("is case-insensitive, like the filesystem it guards", () => {
    expect(isLinkable("C:\\WINDOWS\\x.dll")).toBe(false);
    expect(isLinkable("F:\\App\\Data.SQLite")).toBe(false);
  });
});

describe("planLinks", () => {
  test("plans a link only after the content hash matches", async () => {
    const { deps } = fakeFs({
      "F:\\a\\m.onnx": { ino: "1", dev: 10, size: 10 * MB, content: "same" },
      "F:\\b\\m.onnx": { ino: "2", dev: 10, size: 10 * MB, content: "same" },
    });
    const plan = await planLinks([group(["F:\\a\\m.onnx", "F:\\b\\m.onnx"], 10 * MB)], deps);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]!.replace).toHaveLength(1);
    expect(plan.reclaim).toBe(10 * MB);
  });

  test("same name and size but different content is never linked", async () => {
    const { deps } = fakeFs({
      "F:\\a\\m.onnx": { ino: "1", dev: 10, size: 10 * MB, content: "alpha" },
      "F:\\b\\m.onnx": { ino: "2", dev: 10, size: 10 * MB, content: "beta" },
    });
    const plan = await planLinks([group(["F:\\a\\m.onnx", "F:\\b\\m.onnx"], 10 * MB)], deps);
    expect(plan.groups).toHaveLength(0);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["hash-mismatch", "hash-mismatch"]);
  });

  test("hard links cannot cross volumes, so each volume is planned separately", async () => {
    const { deps } = fakeFs({
      "F:\\a\\m.onnx": { ino: "1", dev: 10, size: 10 * MB, content: "same" },
      "F:\\b\\m.onnx": { ino: "2", dev: 10, size: 10 * MB, content: "same" },
      "G:\\c\\m.onnx": { ino: "3", dev: 20, size: 10 * MB, content: "same" },
    });
    const plan = await planLinks([group(["F:\\a\\m.onnx", "F:\\b\\m.onnx", "G:\\c\\m.onnx"], 10 * MB)], deps);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]!.replace).toEqual(["F:\\b\\m.onnx"]);
    expect(plan.skipped).toContainEqual({ path: "G:\\c\\m.onnx", reason: "cross-volume" });
  });

  test("files already sharing an inode are reported, not relinked", async () => {
    const { deps } = fakeFs({
      "F:\\a\\m.onnx": { ino: "1", dev: 10, nlink: 2, size: 10 * MB, content: "same" },
      "F:\\b\\m.onnx": { ino: "1", dev: 10, nlink: 2, size: 10 * MB, content: "same" },
    });
    const plan = await planLinks([group(["F:\\a\\m.onnx", "F:\\b\\m.onnx"], 10 * MB)], deps);
    expect(plan.groups).toHaveLength(0);
    expect(plan.skipped).toContainEqual({ path: "F:\\b\\m.onnx", reason: "already-linked" });
  });

  test("denied paths never reach the hasher", async () => {
    const { deps } = fakeFs({
      "C:\\Windows\\a.dll": { ino: "1", dev: 10, size: 10 * MB, content: "same" },
      "F:\\b\\a.dll": { ino: "2", dev: 10, size: 10 * MB, content: "same" },
    });
    const plan = await planLinks([group(["C:\\Windows\\a.dll", "F:\\b\\a.dll"], 10 * MB)], deps);
    expect(plan.groups).toHaveLength(0);
    expect(plan.skipped).toContainEqual({ path: "C:\\Windows\\a.dll", reason: "denied-path" });
  });

  test("symlinks are left alone", async () => {
    const { deps } = fakeFs({
      "F:\\a\\m.onnx": { ino: "1", dev: 10, size: 10 * MB, content: "same" },
      "F:\\b\\m.onnx": { ino: "2", dev: 10, size: 10 * MB, content: "same", isSymlink: true },
    });
    const plan = await planLinks([group(["F:\\a\\m.onnx", "F:\\b\\m.onnx"], 10 * MB)], deps);
    expect(plan.groups).toHaveLength(0);
    expect(plan.skipped).toContainEqual({ path: "F:\\b\\m.onnx", reason: "symlink" });
  });

  test("small files are not worth a link", async () => {
    const { deps } = fakeFs({
      "F:\\a\\t.txt": { ino: "1", dev: 10, size: 100, content: "same" },
      "F:\\b\\t.txt": { ino: "2", dev: 10, size: 100, content: "same" },
    });
    const plan = await planLinks([group(["F:\\a\\t.txt", "F:\\b\\t.txt"], 100)], deps);
    expect(plan.groups).toHaveLength(0);
    expect(plan.skipped.every((s) => s.reason === "too-small")).toBe(true);
  });

  test("an unreadable file is skipped without sinking the group", async () => {
    const { deps } = fakeFs({
      "F:\\a\\m.onnx": { ino: "1", dev: 10, size: 10 * MB, content: "same" },
      "F:\\b\\m.onnx": { ino: "2", dev: 10, size: 10 * MB, content: "same" },
    });
    const plan = await planLinks([group(["F:\\a\\m.onnx", "F:\\b\\m.onnx", "F:\\gone\\m.onnx"], 10 * MB)], deps);
    expect(plan.groups).toHaveLength(1);
    expect(plan.skipped).toContainEqual({ path: "F:\\gone\\m.onnx", reason: "unreadable" });
  });

  test("keeper choice is deterministic and prefers an already-shared file", async () => {
    const { deps } = fakeFs({
      "F:\\long\\path\\m.onnx": { ino: "1", dev: 10, nlink: 3, size: 10 * MB, content: "same" },
      "F:\\s\\m.onnx": { ino: "2", dev: 10, nlink: 1, size: 10 * MB, content: "same" },
    });
    const plan = await planLinks([group(["F:\\s\\m.onnx", "F:\\long\\path\\m.onnx"], 10 * MB)], deps);
    expect(plan.groups[0]!.keeper).toBe("F:\\long\\path\\m.onnx");
  });
});

describe("applyLinks", () => {
  test("refuses a target whose bytes changed after planning", async () => {
    const { deps, fs, ops } = fakeFs({
      "F:\\a\\x.bin": { ino: "1", dev: 10, size: MB, content: "same" },
      "F:\\b\\x.bin": { ino: "2", dev: 10, size: MB, content: "same" },
    });
    const plan = await planLinks([group(Object.keys(fs), MB)], deps);
    fs["F:\\b\\x.bin"]!.content = "new user data";
    const result = await applyLinks(plan, deps);
    expect(result.linked).toBe(0);
    expect(result.failures[0]?.error).toContain("changed since planning");
    expect(fs["F:\\b\\x.bin"]!.content).toBe("new user data");
    expect(ops).toEqual([]);
  });

  test("a failed journal write prevents replacement", async () => {
    const { deps, fs, ops } = fakeFs({
      "F:\\a\\x.bin": { ino: "1", dev: 10, size: MB, content: "same" },
      "F:\\b\\x.bin": { ino: "2", dev: 10, size: MB, content: "same" },
    });
    const plan = await planLinks([group(Object.keys(fs), MB)], deps);
    const result = await applyLinks(plan, deps, () => { throw new Error("disk full"); });
    expect(result.linked).toBe(0);
    expect(result.failures[0]?.error).toContain("disk full");
    expect(fs["F:\\b\\x.bin"]!.ino).toBe("2");
    expect(ops.some((op) => op.startsWith("rename "))).toBe(false);
    expect(Object.keys(fs)).toHaveLength(2);
  });

  test("persists an undo entry before replacement", async () => {
    const { deps, fs } = fakeFs({
      "F:\\a\\x.bin": { ino: "1", dev: 10, size: MB, content: "same" },
      "F:\\b\\x.bin": { ino: "2", dev: 10, size: MB, content: "same" },
    });
    const plan = await planLinks([group(Object.keys(fs), MB)], deps);
    let saved: Journal | undefined;
    const result = await applyLinks(plan, deps, (journal) => {
      expect(fs["F:\\b\\x.bin"]!.ino).toBe("2");
      saved = journal;
    });
    expect(result.linked).toBe(1);
    expect(saved?.entries).toEqual(result.journal.entries);
  });

  test("does not delete a temporary path it failed to create", async () => {
    const { deps, fs, ops } = fakeFs({
      "F:\\a\\x.bin": { ino: "1", dev: 10, size: MB, content: "same" },
      "F:\\b\\x.bin": { ino: "2", dev: 10, size: MB, content: "same" },
    });
    const plan = await planLinks([group(Object.keys(fs), MB)], deps);
    let foreign = "";
    deps.link = async (_keeper, temporary) => {
      foreign = temporary;
      fs[temporary] = { ino: "99", dev: 10, size: MB, content: "foreign file" };
      throw new Error("EEXIST");
    };
    const result = await applyLinks(plan, deps);
    expect(result.linked).toBe(0);
    expect(fs[foreign]?.content).toBe("foreign file");
    expect(ops).toEqual([]);
  });
  test("links via a temp name then renames, so an interruption cannot lose the file", async () => {
    const { deps, ops, fs } = fakeFs({
      "F:\\a\\m.onnx": { ino: "1", dev: 10, size: 10 * MB, content: "same" },
      "F:\\b\\m.onnx": { ino: "2", dev: 10, size: 10 * MB, content: "same" },
    });
    const plan = await planLinks([group(["F:\\a\\m.onnx", "F:\\b\\m.onnx"], 10 * MB)], deps);
    const r = await applyLinks(plan, deps);

    expect(ops).toEqual([
      expect.stringMatching(/^link F:\\a\\m.onnx -> F:\\b\\m.onnx.evlink-tmp-/),
      expect.stringMatching(/^rename F:\\b\\m.onnx.evlink-tmp-.* -> F:\\b\\m.onnx$/),
    ]);
    expect(r.linked).toBe(1);
    expect(r.reclaimed).toBe(10 * MB);
    expect(fs["F:\\b\\m.onnx"]!.ino).toBe("1");
    expect(r.journal.entries).toEqual([
      { keeper: "F:\\a\\m.onnx", linked: "F:\\b\\m.onnx", size: 10 * MB, hash: "h(same)" },
    ]);
  });

  test("a failure cleans up its temp and leaves the original in place", async () => {
    const { deps, fs } = fakeFs({
      "F:\\a\\m.onnx": { ino: "1", dev: 10, size: 10 * MB, content: "same" },
      "F:\\b\\m.onnx": { ino: "2", dev: 10, size: 10 * MB, content: "same" },
    });
    const plan = await planLinks([group(["F:\\a\\m.onnx", "F:\\b\\m.onnx"], 10 * MB)], deps);
    deps.link = async () => {
      throw new Error("ERROR_TOO_MANY_LINKS");
    };
    const r = await applyLinks(plan, deps);
    expect(r.linked).toBe(0);
    expect(r.failures[0]!.error).toMatch(/TOO_MANY_LINKS/);
    expect(fs["F:\\b\\m.onnx"]!.ino).toBe("2");
    expect(fs["F:\\b\\m.onnx.evlink-tmp"]).toBeUndefined();
  });

  // A read-only or locked target fails the rename AND the cleanup, which
  // silently leaked a temp hard link on the first real run against main.
  test("a temp that cannot be cleaned up is named in the failure, not swallowed", async () => {
    const { deps } = fakeFs({
      "F:\\a\\m.onnx": { ino: "1", dev: 10, size: 10 * MB, content: "same" },
      "F:\\b\\m.onnx": { ino: "2", dev: 10, size: 10 * MB, content: "same" },
    });
    const plan = await planLinks([group(["F:\\a\\m.onnx", "F:\\b\\m.onnx"], 10 * MB)], deps);
    deps.rename = async () => {
      throw new Error("EPERM: operation not permitted");
    };
    deps.unlink = async () => {
      throw new Error("EPERM: operation not permitted");
    };
    const r = await applyLinks(plan, deps);
    expect(r.linked).toBe(0);
    expect(r.failures[0]!.error).toContain("left behind: F:\\b\\m.onnx.evlink-tmp-");
  });
});

describe("read-only targets", () => {
  // Windows refuses to rename over a ReadOnly file. One such file out of 198
  // was the only failure on the first real run against main.
  test("a rename refused by ReadOnly is retried after clearing the attribute", async () => {
    const { deps, fs, ops } = fakeFs({
      "F:\\a\\s.exe": { ino: "1", dev: 10, size: 10 * MB, content: "same" },
      "F:\\b\\s.exe": { ino: "2", dev: 10, size: 10 * MB, content: "same" },
    });
    const plan = await planLinks([group(["F:\\a\\s.exe", "F:\\b\\s.exe"], 10 * MB)], deps);

    let readOnly = true;
    const realRename = deps.rename;
    deps.rename = async (from, to) => {
      if (readOnly) throw new Error("EPERM: operation not permitted");
      return realRename(from, to);
    };
    deps.makeWritable = async (path) => {
      ops.push(`makeWritable ${path}`);
      readOnly = false;
    };

    const r = await applyLinks(plan, deps);
    expect(r.linked).toBe(1);
    expect(r.failures).toHaveLength(0);
    expect(ops).toContain("makeWritable F:\\b\\s.exe");
    expect(fs["F:\\b\\s.exe"]!.ino).toBe("1");
  });

  test("without a makeWritable dep the original error still surfaces", async () => {
    const { deps } = fakeFs({
      "F:\\a\\s.exe": { ino: "1", dev: 10, size: 10 * MB, content: "same" },
      "F:\\b\\s.exe": { ino: "2", dev: 10, size: 10 * MB, content: "same" },
    });
    const plan = await planLinks([group(["F:\\a\\s.exe", "F:\\b\\s.exe"], 10 * MB)], deps);
    deps.rename = async () => {
      throw new Error("EPERM: operation not permitted");
    };
    delete deps.makeWritable;
    const r = await applyLinks(plan, deps);
    expect(r.linked).toBe(0);
    expect(r.failures[0]!.error).toContain("EPERM");
  });
});

describe("undoLinks", () => {
  test("does not overwrite a linked path replaced with an independent file", async () => {
    const { deps, fs, ops } = fakeFs({
      "F:\\a\\x.bin": { ino: "1", dev: 10, size: MB, content: "same" },
      "F:\\b\\x.bin": { ino: "2", dev: 10, size: MB, content: "new contents" },
    });
    const result = await undoLinks({ version: 1, created: "fixture", entries: [
      { keeper: "F:\\a\\x.bin", linked: "F:\\b\\x.bin", size: MB, hash: "h(same)" },
    ] }, deps);
    expect(result.restored).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(fs["F:\\b\\x.bin"]!.content).toBe("new contents");
    expect(ops).toEqual([]);
  });
  test("restores an independent copy at the linked path", async () => {
    const { deps, ops, fs } = fakeFs({
      "F:\\a\\m.onnx": { ino: "1", dev: 10, nlink: 2, size: 10 * MB, content: "same" },
      "F:\\b\\m.onnx": { ino: "1", dev: 10, nlink: 2, size: 10 * MB, content: "same" },
    });
    const journal: Journal = {
      version: 1,
      created: "2026-09-10T00:00:00.000Z",
      entries: [{ keeper: "F:\\a\\m.onnx", linked: "F:\\b\\m.onnx", size: 10 * MB, hash: "h(same)" }],
    };
    const r = await undoLinks(journal, deps);
    expect(r.restored).toBe(1);
    expect(ops).toEqual([
      expect.stringMatching(/^copy F:\\b\\m.onnx -> F:\\b\\m.onnx.evunlink-tmp-/),
      expect.stringMatching(/^rename F:\\b\\m.onnx.evunlink-tmp-.* -> F:\\b\\m.onnx$/),
    ]);
    expect(fs["F:\\b\\m.onnx"]!.ino).not.toBe("1");
    expect(fs["F:\\b\\m.onnx"]!.content).toBe("same");
  });

  test("apply then undo returns the tree to independent files", async () => {
    const { deps, fs } = fakeFs({
      "F:\\a\\m.onnx": { ino: "1", dev: 10, size: 10 * MB, content: "same" },
      "F:\\b\\m.onnx": { ino: "2", dev: 10, size: 10 * MB, content: "same" },
    });
    const plan = await planLinks([group(["F:\\a\\m.onnx", "F:\\b\\m.onnx"], 10 * MB)], deps);
    const applied = await applyLinks(plan, deps);
    expect(fs["F:\\b\\m.onnx"]!.ino).toBe("1");
    await undoLinks(applied.journal, deps);
    expect(fs["F:\\b\\m.onnx"]!.ino).not.toBe("1");
    expect(fs["F:\\b\\m.onnx"]!.content).toBe("same");
  });
});
