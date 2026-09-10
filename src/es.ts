// The one file that owns the es.exe dependency (Everything Command-line Interface).
//
// Everything's IPC is instance-scoped, not session-scoped: a bare `es.exe` from an
// SSH session fails with "Error 8: Everything IPC not found" even while Everything
// is running, because Everything 1.5a registers under the instance name "1.5a"
// rather than the unnamed default. Every invocation here passes -instance.

export interface EsRow {
  filename: string;
  size?: number;
  date_modified?: string;
  date_created?: string;
  attributes?: number;
}

export interface EsResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export type Runner = (exe: string, args: string[]) => Promise<EsResult>;

export const defaultRunner: Runner = async (exe, args) => {
  const proc = Bun.spawn([exe, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, stdout, stderr, code };
};

/** ES errorlevels that mean something an operator can act on. */
const ES_ERRORS: Record<number, string> = {
  1: "es: failed to register window class",
  2: "es: failed to create listening window",
  3: "es: out of memory",
  4: "es: a switch was missing its argument",
  5: "es: failed to create the export output file",
  6: "es: unknown switch",
  7: "es: failed to send Everything a query",
  8: "es: Everything IPC not found — Everything is not running on this machine, or the instance name is wrong. Check `ev doctor`.",
  9: "es: no results",
};

export class EsError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "EsError";
  }
}

export interface EsClient {
  rows(args: string[]): Promise<EsRow[]>;
  count(query: string[]): Promise<number>;
  totalSize(query: string[]): Promise<number>;
  raw(args: string[]): Promise<string>;
  version(): Promise<string>;
  /** The instance name that actually answered, after any fallback. */
  resolvedInstance(): string;
}

/**
 * Instance names to try when the configured one does not answer.
 *
 * Everything registers its IPC window under a version-shaped instance name
 * ("1.5a" today). An upgrade changes that name and would otherwise break every
 * command with a bare "Error 8", so a failure falls back through these before
 * giving up. The empty string is the unnamed default used by Everything 1.4.
 */
const FALLBACK_INSTANCES = ["1.5a", "1.5", "1.4", "", "Everything"];

export function makeClient(exe: string, instance: string, run: Runner = defaultRunner): EsClient {
  // Resolved once per process: the fast path never pays for the fallback.
  let resolved = instance;
  let probed = false;

  function argsFor(name: string, args: string[]): string[] {
    return name ? ["-instance", name, ...args] : args;
  }

  async function call(args: string[]): Promise<string> {
    let r = await run(exe, argsFor(resolved, args));

    // Error 8 means no Everything answered under that instance name. Try the
    // others once before reporting failure, and keep whichever one works.
    if (!r.ok && r.code === 8 && !probed) {
      probed = true;
      for (const candidate of FALLBACK_INSTANCES) {
        if (candidate === resolved) continue;
        const attempt = await run(exe, argsFor(candidate, args));
        if (attempt.ok) {
          resolved = candidate;
          r = attempt;
          break;
        }
      }
    }

    if (!r.ok) {
      // errorlevel 9 (no results) is only set with -no-result-error; treat as empty.
      if (r.code === 9) return "";
      const hint = ES_ERRORS[r.code];
      const detail = r.stderr.trim() || r.stdout.trim();
      throw new EsError(r.code, hint ? `${hint}${detail ? `\n  ${detail}` : ""}` : `es exited ${r.code}: ${detail}`);
    }
    return r.stdout;
  }

  return {
    async rows(args) {
      // -date-format 1 gives ISO-8601 strings instead of raw FILETIME integers.
      const out = await call(["-json", "-date-format", "1", ...args]);
      const text = out.trim();
      if (!text) return [];
      try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? (parsed as EsRow[]) : [];
      } catch {
        throw new EsError(0, `es returned output that is not JSON:\n  ${text.slice(0, 200)}`);
      }
    },
    async count(query) {
      const out = await call(["-get-result-count", ...query]);
      const n = Number(out.trim());
      if (!Number.isFinite(n)) throw new EsError(0, `es -get-result-count returned ${JSON.stringify(out.trim())}`);
      return n;
    },
    async totalSize(query) {
      const out = await call(["-get-total-size", ...query]);
      const n = Number(out.trim());
      if (!Number.isFinite(n)) throw new EsError(0, `es -get-total-size returned ${JSON.stringify(out.trim())}`);
      return n;
    },
    raw: (args) => call(args),
    version: () => call(["-get-everything-version"]),
    resolvedInstance: () => resolved,
  };
}
