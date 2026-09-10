// The one file that owns the filesystem side of `ev link`.

import { promises as fs } from "node:fs";
import type { LinkDeps, FileFacts } from "./link.ts";

/** Streamed so a 30 GB model weight does not land in memory. */
async function hashFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("blake2b256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest("hex");
}

/**
 * Head+tail+size sampling. Two files that differ almost always differ in the
 * first or last megabyte, so this rejects mismatches fast — but it is a
 * heuristic, and `ev link` only uses it behind an explicit --quick.
 */
async function quickHashFile(path: string, size: number): Promise<string> {
  const SAMPLE = 1024 * 1024;
  const file = Bun.file(path);
  const hasher = new Bun.CryptoHasher("blake2b256");
  hasher.update(String(size));
  if (size <= SAMPLE * 2) {
    hasher.update(new Uint8Array(await file.arrayBuffer()));
  } else {
    hasher.update(new Uint8Array(await file.slice(0, SAMPLE).arrayBuffer()));
    hasher.update(new Uint8Array(await file.slice(size - SAMPLE, size).arrayBuffer()));
  }
  return hasher.digest("hex");
}

export function makeFsDeps(opts: { quick?: boolean } = {}): LinkDeps {
  return {
    async facts(path: string): Promise<FileFacts | null> {
      try {
        const s = await fs.lstat(path);
        return {
          // ino exceeds 2^53 on NTFS, so it is carried as a string.
          ino: String(s.ino),
          dev: Number(s.dev),
          nlink: Number(s.nlink),
          size: Number(s.size),
          isSymlink: s.isSymbolicLink(),
        };
      } catch {
        return null;
      }
    },
    async hash(path: string): Promise<string> {
      if (!opts.quick) return hashFile(path);
      const s = await fs.stat(path);
      return quickHashFile(path, Number(s.size));
    },
    link: (existing, newPath) => fs.link(existing, newPath),
    rename: (from, to) => fs.rename(from, to),
    unlink: (path) => fs.unlink(path),
    copy: (from, to) => fs.copyFile(from, to),
    // On Windows, chmod only toggles the read-only bit, which is exactly what
    // a rename over a ReadOnly target needs cleared.
    makeWritable: (path) => fs.chmod(path, 0o666),
  };
}
