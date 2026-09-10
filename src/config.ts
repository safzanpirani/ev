/**
 * Config for ev.
 *
 * ev has no secrets and no network endpoint, so config is entirely optional —
 * the defaults are correct on main. Resolution order for each setting:
 * flag, then environment, then $EV_CONFIG or ~/.config/ev/config.json, then default.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export interface Config {
  /** Path to voidtools' es.exe. */
  esPath: string;
  /**
   * Everything IPC instance name. Everything 1.5a registers as "1.5a", not the
   * unnamed default, so a bare es.exe fails with "Error 8: Everything IPC not
   * found" even while Everything is running. Set "" to use the unnamed instance.
   */
  instance: string;
  /** Default row cap for find, before -n. */
  limit: number;
}

export const DEFAULTS: Config = {
  esPath: "C:\\Tools\\es\\es.exe",
  instance: "1.5a",
  limit: 50,
};

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env["EV_CONFIG"] ?? join(homedir(), ".config", "ev", "config.json");
}

function fail(msg: string): never {
  throw new Error("config: " + msg);
}

/** Validate a raw object. Exported so tests never touch the filesystem. */
export function parseConfig(raw: unknown, source = "<inline>"): Partial<Config> {
  if (typeof raw !== "object" || raw === null) fail(source + " is not an object");
  const o = raw as Record<string, unknown>;
  const cfg: Partial<Config> = {};

  if (o["esPath"] !== undefined) {
    if (typeof o["esPath"] !== "string" || o["esPath"] === "") fail("esPath must be a non-empty string");
    cfg.esPath = o["esPath"];
  }
  if (o["instance"] !== undefined) {
    if (typeof o["instance"] !== "string") fail("instance must be a string");
    cfg.instance = o["instance"];
  }
  if (o["limit"] !== undefined) {
    const n = o["limit"];
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) fail("limit must be a positive integer");
    cfg.limit = n;
  }
  return cfg;
}

/** Never throws for a missing file — config is optional by design. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const path = configPath(env);
  let fromFile: Partial<Config> = {};
  if (existsSync(path)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      fail(path + " is not valid JSON (" + (err as Error).message + ")");
    }
    fromFile = parseConfig(raw, path);
  }

  const fromEnv: Partial<Config> = {};
  if (env["EV_ES_PATH"]) fromEnv.esPath = env["EV_ES_PATH"];
  if (env["EV_INSTANCE"] !== undefined) fromEnv.instance = env["EV_INSTANCE"];

  return { ...DEFAULTS, ...fromFile, ...fromEnv };
}
