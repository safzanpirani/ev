// The one file that owns plocate and updatedb, the Linux backend's name index.
//
// ev keeps its own database rather than the system one: a user-built database
// (`updatedb -l 0`) needs no root, its prune list keeps NTFS and other real
// mounts that distribution defaults leave out, and `ev index` can rebuild it on
// demand. updatedb reuses the previous database for folders whose mtime did not
// change, so a rebuild after the first one is quick.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, statSync } from "node:fs";

export interface RunResult {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}
export type Run = (argv: string[]) => Promise<RunResult>;

export const defaultRun: Run = async (argv) => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).arrayBuffer().then((b) => new Uint8Array(b)), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
};

export function defaultDb(env: NodeJS.ProcessEnv = process.env): string {
  if (env["EV_LOCATE_DB"]) return env["EV_LOCATE_DB"];
  const data = env["XDG_DATA_HOME"] || join(homedir(), ".local", "share");
  return join(data, "ev", "plocate.db");
}

/**
 * Filesystems with nothing worth finding, or too slow to walk: kernel views,
 * memory-backed mounts, network and cloud drives. Real disks of every kind,
 * NTFS through ntfs3 or ntfs-3g (fuseblk) included, stay in.
 */
export const PRUNE_FS = [
  "proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "ramfs", "cgroup", "cgroup2", "pstore", "bpf", "tracefs",
  "debugfs", "securityfs", "configfs", "fusectl", "mqueue", "hugetlbfs", "autofs", "binfmt_misc", "efivarfs",
  "nsfs", "overlay", "squashfs", "rpc_pipefs", "nfs", "nfs4", "cifs", "smb3", "9p", "iso9660", "udf",
  "fuse.sshfs", "fuse.rclone", "fuse.gvfsd-fuse", "fuse.portal", "fuse.s3fs", "fuse.mergerfs",
];
export const PRUNE_PATHS = ["/proc", "/sys", "/dev", "/run", "/tmp", "/var/tmp", "/var/cache", "/.snapshots", "/var/lib/docker"];

export interface PathQuery {
  patterns: string[];
  basename: boolean;
  ignoreCase: boolean;
  /** Patterns are POSIX extended regular expressions; plocate then scans the whole database. */
  regex: boolean;
}

export interface LocateClient {
  db: string;
  paths(q: PathQuery): Promise<string[]>;
  /** Rebuild the database. Returns how long it took. */
  build(): Promise<{ ms: number }>;
  /** When the database was last written, or null when it does not exist yet. */
  builtAt(): number | null;
}

export class LocateError extends Error {}

export function makeLocate(db: string = defaultDb(), run: Run = defaultRun): LocateClient {
  return {
    db,
    async paths(q) {
      if (!existsSync(db)) throw new LocateError(`no index at ${db} yet. Build it with 'ev index' (the first run reads every disk; later runs reuse it).`);
      const argv = ["plocate", "-d", db, "-0"];
      if (q.basename) argv.push("-b");
      if (q.ignoreCase) argv.push("-i");
      if (q.regex) argv.push("--regex");
      argv.push("--", ...q.patterns);
      const r = await run(argv);
      // plocate exits 1 both for "no match" and for errors; only errors write stderr.
      if (r.code !== 0 && r.stderr.trim()) throw new LocateError(`plocate: ${r.stderr.trim()}`);
      if (r.code !== 0) return [];
      return new TextDecoder().decode(r.stdout).split("\0").filter(Boolean);
    },
    async build() {
      mkdirSync(join(db, ".."), { recursive: true });
      const start = Date.now();
      const argv = [
        "updatedb", "-l", "0", "-U", "/", "-o", db,
        "--prunefs", PRUNE_FS.join(" "),
        "--prunepaths", PRUNE_PATHS.join(" "),
        "--prunenames", ".git .hg .svn",
        "--prune-bind-mounts", "yes",
      ];
      const r = await run(argv);
      if (r.code !== 0) throw new LocateError(`updatedb exited ${r.code}: ${r.stderr.trim()}`);
      return { ms: Date.now() - start };
    },
    builtAt() {
      try {
        return statSync(db).mtimeMs;
      } catch {
        return null;
      }
    },
  };
}
