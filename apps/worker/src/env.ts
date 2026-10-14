import { readFileSync } from "node:fs";
import { hostname } from "node:os";

/** SECRETS_KEY from the environment, or from a Docker secret file named by SECRETS_KEY_FILE. */
export function readSecretsKey(env: NodeJS.ProcessEnv = process.env): string {
  const file = env["SECRETS_KEY_FILE"];
  const fromFile = file ? readFileSync(file, "utf8").trim() : "";
  const key = fromFile || env["SECRETS_KEY"]?.trim() || "";
  if (!key) throw new Error("SECRETS_KEY (or SECRETS_KEY_FILE) must be set; generate one with `openssl rand -base64 32`");
  return key;
}

/**
 * In Docker the compose file sets MERIDIAN_DB_HOST and the container gets POSTGRES_*
 * from the env file, so the URL is assembled here rather than interpolated by compose
 * (which reads a different .env). Outside Docker, DATABASE_URL is used as given.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const host = env["MERIDIAN_DB_HOST"];
  if (host) {
    const user = env["POSTGRES_USER"] ?? "meridian";
    const password = env["POSTGRES_PASSWORD"] ?? "";
    const db = env["POSTGRES_DB"] ?? "meridian";
    const port = env["MERIDIAN_DB_PORT"] ?? "5432";
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(db)}`;
  }
  const url = env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL (or MERIDIAN_DB_HOST with POSTGRES_*) must be set");
  return url;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** An integer within [min, max] (so 0 is a valid hour), else the fallback. */
function intInRange(value: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export interface WorkerConfig {
  databaseUrl: string;
  secretsKey: string;
  workerId: string;
  /** How often connections are synced. Spec default: 6 hours. */
  syncIntervalHours: number;
  /** Queue poll cadence. */
  pollIntervalMs: number;
  /** First sync looks this far back (3 months plus overlap). */
  initialWindowDays: number;
  /** Each sync starts this many days before the last high-water mark. */
  overlapDays: number;
  /** Outbound request timeout. */
  requestTimeoutMs: number;
  /**
   * The daily tick (recurring detection, month close) runs once per UTC day at or after
   * this hour (0..23). loadConfig always sets it; a hand-built config without it means
   * DEFAULT_DETECT_HOUR_UTC.
   */
  detectHourUtc?: number;
}

export const DEFAULT_DETECT_HOUR_UTC = 8;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    databaseUrl: resolveDatabaseUrl(env),
    secretsKey: readSecretsKey(env),
    workerId: `${hostname()}:${process.pid}`,
    syncIntervalHours: int(env["SYNC_INTERVAL_HOURS"], 6),
    pollIntervalMs: int(env["WORKER_POLL_MS"], 5000),
    initialWindowDays: int(env["SIMPLEFIN_INITIAL_WINDOW_DAYS"], 93),
    overlapDays: int(env["SIMPLEFIN_OVERLAP_DAYS"], 7),
    requestTimeoutMs: int(env["SIMPLEFIN_TIMEOUT_MS"], 60_000),
    detectHourUtc: intInRange(env["DETECT_HOUR_UTC"], 0, 23, DEFAULT_DETECT_HOUR_UTC),
  };
}
