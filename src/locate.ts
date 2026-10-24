// The one file that owns plocate and updatedb, the Linux backend's name index.
//
// ev keeps its own database rather than the system one: a user-built database
// (`updatedb -l 0`) needs no root, its prune list keeps NTFS and other real
// mounts that distribution defaults leave out, and `ev index` can rebuild it on
// demand. updatedb reuses the previous database for folders whose mtime did not
// change, so a rebuild after the first one is quick.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";

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
  "debugfs", "securityfs", "configfs", "fusectl", "mqueue", "hugetlbfs", "binfmt_misc", "efivarfs",
  "nsfs", "overlay", "squashfs", "rpc_pipefs", "nfs", "nfs4", "cifs", "smb3", "9p", "iso9660", "udf",
  "fuse.sshfs", "fuse.rclone", "fuse.gvfsd-fuse", "fuse.portal", "fuse.s3fs", "fuse.mergerfs",
];
export const PRUNE_PATHS = ["/proc", "/sys", "/dev", "/run", "/tmp", "/var/tmp", "/var/cache", "/.snapshots", "/var/lib/docker"];

export interface MountEntry {
  path: string;
  fs: string;
}

export interface MountPlan {
  indexed: MountEntry[];
  skipped: Array<MountEntry & { why: string }>;
  /** Mount points updatedb must not enter, beyond PRUNE_PATHS. */
  prune: string[];
}

const unescape = (s: string) => s.replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

/**
 * Pure over /proc/self/mountinfo: which mounts the index covers.
 *
 * - An automount (autofs) with nothing mounted on it is pruned. Entering it asks
 *   systemd to mount a device that may be absent, and updatedb then waits out the
 *   90 s device timeout. A mounted one is indexed through the filesystem on top.
 * - A bind mount, a mount whose root lies inside another mount of the same
 *   device, is pruned so its files are not listed twice. btrfs subvolumes such
 *   as /home (root /@home beside / at /@) are separate trees and stay in.
 */
export function mountPlan(mountinfo: string): MountPlan {
  const mounts = mountinfo.split("\n").filter(Boolean).map((line) => {
    const [pre = "", post = ""] = line.split(" - ");
    const f = pre.split(" ");
    return { dev: f[2] ?? "", root: unescape(f[3] ?? "/"), path: unescape(f[4] ?? ""), fs: post.split(" ")[0] ?? "" };
  });
  const plan: MountPlan = { indexed: [], skipped: [], prune: [] };
  const pruneFs = new Set(PRUNE_FS);
  mounts.forEach((m, i) => {
    if (PRUNE_PATHS.some((p) => m.path === p || m.path.startsWith(p + "/"))) return;
    if (m.fs === "autofs") {
      if (!mounts.some((n) => n.path === m.path && n.fs !== "autofs")) {
        plan.skipped.push({ path: m.path, fs: m.fs, why: "automount with nothing mounted" });
        plan.prune.push(m.path);
      }
      return;
    }
    if (pruneFs.has(m.fs)) {
      if (/^(nfs|cifs|smb3|9p|fuse\.)/.test(m.fs)) plan.skipped.push({ path: m.path, fs: m.fs, why: "network or FUSE drive" });
      return;
    }
    const host = mounts.find((n, j) => n !== m && n.dev === m.dev && n.fs !== "autofs" &&
      (n.root === "/" ? m.root !== "/" : m.root.startsWith(n.root + "/") || (m.root === n.root && j < i)));
    if (host) {
      plan.skipped.push({ path: m.path, fs: m.fs, why: `bind mount of ${host.path}` });
      plan.prune.push(m.path);
      return;
    }
    plan.indexed.push({ path: m.path, fs: m.fs });
  });
  return plan;
}

/** The block device an fstab source names, as a path that exists only while the disk is attached. */
function fstabDevice(spec: string): string | null {
  const tagged = /^(UUID|LABEL|PARTUUID|PARTLABEL)=(.+)$/.exec(spec);
  if (tagged) return `/dev/disk/by-${tagged[1]!.toLowerCase()}/${tagged[2]}`;
  return spec.startsWith("/dev/") ? spec : null;
}

/**
 * Pure: systemd automounts with nothing mounted yet whose disk is attached. After a boot no NTFS
 * drive is mounted until something opens it, so they would all be pruned; opening these first
 * gets them indexed, while an absent disk (which would stall the walk for 90 s) stays pruned.
 */
export function automountsToWake(mountinfo: string, fstab: string, exists: (path: string) => boolean): string[] {
  const plan = mountPlan(mountinfo);
  const sleeping = new Set(plan.skipped.filter((s) => s.fs === "autofs").map((s) => s.path));
  const wake: string[] = [];
  for (const line of fstab.split("\n")) {
    const [spec, path, , options] = line.trim().split(/\s+/);
    if (!spec || spec.startsWith("#") || !path || !sleeping.has(unescape(path))) continue;
    if (!options?.split(",").includes("x-systemd.automount")) continue;
    const device = fstabDevice(spec);
    if (device && exists(device)) wake.push(unescape(path));
  }
  return wake;
}

/** Mount what is attached, then plan from the mount table as it is now. */
export function currentMountPlan(): MountPlan {
  try {
    let mountinfo = readFileSync("/proc/self/mountinfo", "utf8");
    const wake = automountsToWake(mountinfo, readFileSync("/etc/fstab", "utf8"), existsSync);
    for (const path of wake) {
      try {
        readdirSync(path);
      } catch {
        // A mount that fails stays an empty automount and is pruned below.
      }
    }
    if (wake.length) mountinfo = readFileSync("/proc/self/mountinfo", "utf8");
    return mountPlan(mountinfo);
  } catch {
    // No mountinfo or fstab: the static prune lists still apply.
    return { indexed: [], skipped: [], prune: [] };
  }
}

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
      const plan = currentMountPlan();
      const argv = [
        "updatedb", "-l", "0", "-U", "/", "-o", db,
        "--prunefs", PRUNE_FS.join(" "),
        "--prunepaths", PRUNE_PATHS.join(" "),
        "--prunenames", ".git .hg .svn",
        // updatedb's own bind-mount test also drops btrfs subvolumes such as /home; mountPlan finds real binds.
        "--prune-bind-mounts", "no",
        ...plan.prune.flatMap((p) => ["--add-single-prunepath", p]),
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
