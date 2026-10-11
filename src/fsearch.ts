// The one file that owns the fsearch dependency (macOS name + content index).
//
// fsearch answers JSON lines over a unix socket. One request line in, one
// reply line out. The CLI and `fsearch stdio` are thin clients of the same
// socket, so ev talks to it directly and spawns the binary only to start the
// daemon when the socket is absent.

import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { FsRequest } from "./fsquery.ts";

/** One name-search hit, exactly as the daemon serialises it. */
export interface FsHit {
  kind: "file" | "dir" | "link" | "other";
  /** Unix seconds. */
  mtime: number;
  path: string;
  score: number;
  /** Bytes. Folders report 0: fsearch keeps no folder-size rollups. */
  size: number;
}

export interface FsGrepFile {
  path: string;
  matches: Array<{ line: number; text: string }>;
}

export interface FsGrepReply {
  files: FsGrepFile[];
  /** Files whose name filters and trigram filter made them worth reading. */
  candidates: number;
  read: number;
  /** False when the time budget ran out before every candidate was read. */
  complete: boolean;
  /** "index" (trigram content index) or "scan" (outside it, read from disk). */
  source: string;
  /** Files still waiting for the content index. */
  indexing: number;
  took_us: number;
}

export interface FsStatus {
  entries: number;
  dirs: number;
  overlay: number;
  removed: number;
  event_id: number;
  index_bytes: number;
  content_docs: number;
  content_segments: number;
  content_bytes: number;
  content_pending: number;
  full_disk_access: boolean;
  owner: boolean;
}

/** The send half: one request object in, one parsed reply object out. */
export type Transport = (req: Record<string, unknown>) => Promise<Record<string, unknown>>;

export class FsearchError extends Error {
  constructor(message: string, readonly indexing = false) {
    super(message);
    this.name = "FsearchError";
  }
}

export interface FsearchPaths {
  /** Daemon data directory: index, socket, skipped-folder list, log. */
  dataDir: string;
  socket: string;
  /** The fsearch binary ev starts the daemon with. */
  binary: string;
}

export function fsearchPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): FsearchPaths {
  const dataDir = join(home, "Library", "Application Support", "FSearch");
  return { dataDir, socket: join(dataDir, "fsearch.sock"), binary: env["EV_FSEARCH_PATH"] ?? join(home, ".local", "bin", "fsearch") };
}

const INSTALL_HINT = "build and install it: cd ~/Development/vendor/fsearch && cargo build --release && ./target/release/fsearch install (or set $EV_FSEARCH_PATH)";

/**
 * Turn a daemon reply into a value or a useful error. While the first index
 * builds, every search answers `{"ok":false,"error":"indexing: 2.6M entries so
 * far ..."}`; that is a wait, not a failure, and the message says so.
 */
function unwrap(reply: Record<string, unknown>): Record<string, unknown> {
  if (reply["ok"] === true) return reply;
  const err = typeof reply["error"] === "string" ? reply["error"] : JSON.stringify(reply);
  const m = /^indexing: ([\d.]+M) entries so far/.exec(err);
  if (m) {
    throw new FsearchError(`fsearch is still building its first index (${m[1]} entries listed so far). Retry in about 30 s; 'ev doctor' shows progress.`, true);
  }
  throw new FsearchError(`fsearch: ${err}`);
}

const KINDS = new Set(["file", "dir", "link", "other"]);

/** Validate a name-search reply. Pinned against real daemon output in tests. */
export function parseHits(reply: Record<string, unknown>): FsHit[] {
  const r = unwrap(reply);
  const hits = r["hits"];
  if (!Array.isArray(hits)) throw new FsearchError(`fsearch reply has no hits array: ${JSON.stringify(r).slice(0, 200)}`);
  for (const h of hits) {
    if (
      typeof h !== "object" || h === null ||
      typeof h.path !== "string" || !KINDS.has(h.kind) ||
      typeof h.size !== "number" || typeof h.mtime !== "number" || typeof h.score !== "number"
    ) {
      throw new FsearchError(`fsearch returned a hit ev does not understand: ${JSON.stringify(h).slice(0, 200)}`);
    }
  }
  return hits as FsHit[];
}

export function parseGrep(reply: Record<string, unknown>): FsGrepReply {
  const r = unwrap(reply);
  if (!Array.isArray(r["files"])) throw new FsearchError(`fsearch grep reply has no files array: ${JSON.stringify(r).slice(0, 200)}`);
  return {
    files: r["files"] as FsGrepFile[],
    candidates: Number(r["candidates"] ?? 0),
    read: Number(r["read"] ?? 0),
    complete: r["complete"] !== false,
    source: String(r["source"] ?? ""),
    indexing: Number(r["indexing"] ?? 0),
    took_us: Number(r["took_us"] ?? 0),
  };
}

export function parseStatus(reply: Record<string, unknown>): FsStatus {
  const r = unwrap(reply);
  if (typeof r["entries"] !== "number") throw new FsearchError(`fsearch status reply ev does not understand: ${JSON.stringify(r).slice(0, 200)}`);
  return r as unknown as FsStatus;
}

export interface FsearchClient {
  search(req: FsRequest): Promise<FsHit[]>;
  grep(req: FsRequest): Promise<FsGrepReply>;
  /** Throws while the first index builds (FsearchError with indexing=true). */
  status(): Promise<FsStatus>;
  /** True when a daemon answers on the socket. Never starts one. */
  ping(): Promise<boolean>;
}

export function makeFsearchClient(send: Transport, probe: Transport = send): FsearchClient {
  const wire = (req: FsRequest): Record<string, unknown> => ({ ...req });
  return {
    search: async (req) => parseHits(await send(wire(req))),
    grep: async (req) => parseGrep(await send({ ...wire(req), op: "grep" })),
    status: async () => parseStatus(await send({ op: "status" })),
    async ping() {
      try {
        return (await probe({ op: "ping" }))["ok"] === true;
      } catch {
        return false;
      }
    },
  };
}

/** One request over the socket. Rejects with the socket error code (ENOENT, ECONNREFUSED) when no daemon listens. */
export function socketRequest(socket: string, req: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const s = connect(socket);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      s.destroy();
      reject(new FsearchError(`fsearch did not answer within ${timeoutMs / 1000} s on ${socket}`));
    }, timeoutMs);
    s.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    s.on("connect", () => {
      s.write(JSON.stringify(req) + "\n");
      // One request only: closing our side tells the daemon not to keep its cores warm for a next one.
      s.end();
    });
    s.on("data", (d: Buffer) => chunks.push(d));
    s.on("end", () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return reject(new FsearchError("fsearch closed the connection without a reply"));
      try {
        resolve(JSON.parse(text.split("\n")[0]!));
      } catch {
        reject(new FsearchError(`fsearch replied with something that is not JSON: ${text.slice(0, 200)}`));
      }
    });
  });
}

const NOT_LISTENING = new Set(["ENOENT", "ECONNREFUSED"]);

/**
 * The real transport: the socket, starting the daemon on first use the way
 * the fsearch CLI does. `fsearch status` spawns `fsearch serve` in its own
 * session when the socket is absent, so it outlives this process.
 */
export function defaultTransport(paths: FsearchPaths = fsearchPaths()): Transport {
  return async (req) => {
    try {
      return await socketRequest(paths.socket, req);
    } catch (err) {
      if (!NOT_LISTENING.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
    }
    if (!existsSync(paths.binary)) throw new FsearchError(`the fsearch daemon is not running and ${paths.binary} does not exist — ${INSTALL_HINT}`);
    const proc = Bun.spawn([paths.binary, "status"], { stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new FsearchError(`could not start the fsearch daemon (${paths.binary} status exited ${code}): ${stderr.trim()}`);
    try {
      return await socketRequest(paths.socket, req);
    } catch (err) {
      throw new FsearchError(`started fsearch but its socket ${paths.socket} still does not answer (${(err as Error).message}); see ${join(paths.dataDir, "daemon.log")}`);
    }
  };
}

/** The socket alone, never starting a daemon. Doctor uses it to report what is actually running. */
export function probeTransport(paths: FsearchPaths = fsearchPaths()): Transport {
  return (req) => socketRequest(paths.socket, req, 5_000);
}

/** What doctor reports about the install and the daemon, read from disk and `ps`. */
export interface DaemonFacts {
  binary: string;
  binaryExists: boolean;
  /** fsearch has no --version flag; the binary's build time identifies it instead. */
  binaryModified?: string;
  socket: string;
  dataDir: string;
  pid?: number;
  rssBytes?: number;
  /** Bytes on disk under the data directory: name index plus content index. */
  indexOnDiskBytes: number;
  /** Folders the daemon could not or would not read (its `skipped` file). */
  skipped: string[];
}

export async function readDaemonFacts(paths: FsearchPaths = fsearchPaths()): Promise<DaemonFacts> {
  const { stat, readFile, readdir } = await import("node:fs/promises");
  const facts: DaemonFacts = { binary: paths.binary, binaryExists: false, socket: paths.socket, dataDir: paths.dataDir, indexOnDiskBytes: 0, skipped: [] };
  try {
    const s = await stat(paths.binary);
    facts.binaryExists = true;
    facts.binaryModified = s.mtime.toISOString();
  } catch {}
  try {
    for (const e of await readdir(paths.dataDir, { recursive: true, withFileTypes: true })) {
      if (e.isFile()) facts.indexOnDiskBytes += (await stat(join(e.parentPath, e.name))).size;
    }
  } catch {}
  try {
    facts.skipped = (await readFile(join(paths.dataDir, "skipped"), "utf8")).split("\n").filter(Boolean);
  } catch {}
  try {
    const pid = Number((await readFile(join(paths.dataDir, "socket.lock"), "utf8")).trim());
    if (Number.isInteger(pid) && pid > 1) {
      const ps = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]);
      const kb = Number(ps.stdout.toString().trim());
      if (ps.exitCode === 0 && Number.isFinite(kb) && kb > 0) {
        facts.pid = pid;
        facts.rssBytes = kb * 1024;
      }
    }
  } catch {}
  return facts;
}
