import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { parsePriceProviderId, type PriceProviderId } from "@meridian/shared";

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

// ---- Price feed (prices design §6.4; plan decision 10) ----

/**
 * `PRICE_PROVIDER`: `tiingo` or `none` (the default: no fetch is ever queued, valuations use
 * implied and manual prices), read by the shared `parsePriceProviderId` so the API and the
 * worker accept exactly the same values.
 */
export function readPriceProvider(env: NodeJS.ProcessEnv = process.env): PriceProviderId | null {
  return parsePriceProviderId(env["PRICE_PROVIDER"]);
}

/** `TIINGO_API_KEY`, or the Docker secret file named by `TIINGO_API_KEY_FILE`; required when the provider is tiingo (boot fails otherwise). */
export function readTiingoApiKey(env: NodeJS.ProcessEnv = process.env, provider: PriceProviderId | null = readPriceProvider(env)): string | null {
  const file = env["TIINGO_API_KEY_FILE"];
  const fromFile = file ? readFileSync(file, "utf8").trim() : "";
  const key = fromFile || env["TIINGO_API_KEY"]?.trim() || "";
  if (provider === "tiingo" && !key) throw new Error("PRICE_PROVIDER=tiingo needs TIINGO_API_KEY (or TIINGO_API_KEY_FILE); get a free key at https://www.tiingo.com");
  return key || null;
}

/** `PRICE_CATCHUP_HOUR`: an hour 0..23, or `off` (null) to disable the morning catch-up. */
export function readCatchupHour(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env["PRICE_CATCHUP_HOUR"]?.trim().toLowerCase();
  if (raw === "off" || raw === "none" || raw === "false") return null;
  return intInRange(raw, 0, 23, PRICE_DEFAULTS.catchupHour);
}

export const PRICE_DEFAULTS = {
  fetchHour: 18,
  catchupHour: 6,
  maxRequestsPerRun: 45,
  requestSpacingMs: 1500,
  runMaxMs: 1_200_000,
  overlapDays: 3,
  historyMaxYears: 20,
  timeoutMs: 30_000,
} as const;

/** The price-feed settings a run reads, every field resolved (see `priceConfigOf`). */
export interface PriceConfig {
  provider: PriceProviderId | null;
  tiingoApiKey: string | null;
  /** Household-local hour of the nightly fetch. */
  fetchHour: number;
  /** Household-local hour of the conditional catch-up; null = off. */
  catchupHour: number | null;
  maxRequestsPerRun: number;
  requestSpacingMs: number;
  runMaxMs: number;
  overlapDays: number;
  historyMaxYears: number;
  timeoutMs: number;
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
   * The daily tick (recurring detection, income feed, month close) runs once per UTC day at
   * or after this hour (0..23). loadConfig always sets it; a hand-built config without it
   * means DEFAULT_DETECT_HOUR_UTC.
   */
  detectHourUtc?: number;
  /**
   * Phase 3 price feed. loadConfig always sets it; a hand-built config without it means
   * `PRICE_PROVIDER=none` with the `PRICE_DEFAULTS` (see `priceConfigOf`).
   */
  prices?: Partial<PriceConfig>;
}

export const DEFAULT_DETECT_HOUR_UTC = 8;

/** The resolved price-feed settings of a config (defaults for anything a hand-built config left out). */
export function priceConfigOf(config: Pick<WorkerConfig, "prices">): PriceConfig {
  const p = config.prices ?? {};
  return {
    provider: p.provider ?? null,
    tiingoApiKey: p.tiingoApiKey ?? null,
    fetchHour: p.fetchHour ?? PRICE_DEFAULTS.fetchHour,
    catchupHour: p.catchupHour === undefined ? PRICE_DEFAULTS.catchupHour : p.catchupHour,
    maxRequestsPerRun: p.maxRequestsPerRun ?? PRICE_DEFAULTS.maxRequestsPerRun,
    requestSpacingMs: p.requestSpacingMs ?? PRICE_DEFAULTS.requestSpacingMs,
    runMaxMs: p.runMaxMs ?? PRICE_DEFAULTS.runMaxMs,
    overlapDays: p.overlapDays ?? PRICE_DEFAULTS.overlapDays,
    historyMaxYears: p.historyMaxYears ?? PRICE_DEFAULTS.historyMaxYears,
    timeoutMs: p.timeoutMs ?? PRICE_DEFAULTS.timeoutMs,
  };
}

/** The price-feed part of `loadConfig` (prices design §6.4): the provider, its key, the hours and the run budget. */
export function loadPriceConfig(env: NodeJS.ProcessEnv = process.env): PriceConfig {
  const provider = readPriceProvider(env);
  return {
    provider,
    tiingoApiKey: readTiingoApiKey(env, provider),
    fetchHour: intInRange(env["PRICE_FETCH_HOUR"], 0, 23, PRICE_DEFAULTS.fetchHour),
    catchupHour: readCatchupHour(env),
    maxRequestsPerRun: int(env["PRICE_MAX_REQUESTS_PER_RUN"], PRICE_DEFAULTS.maxRequestsPerRun),
    requestSpacingMs: intInRange(env["PRICE_REQUEST_SPACING_MS"], 0, 600_000, PRICE_DEFAULTS.requestSpacingMs),
    runMaxMs: int(env["PRICE_RUN_MAX_MS"], PRICE_DEFAULTS.runMaxMs),
    overlapDays: intInRange(env["PRICE_OVERLAP_DAYS"], 0, 365, PRICE_DEFAULTS.overlapDays),
    historyMaxYears: int(env["PRICE_HISTORY_MAX_YEARS"], PRICE_DEFAULTS.historyMaxYears),
    timeoutMs: int(env["PRICE_TIMEOUT_MS"], PRICE_DEFAULTS.timeoutMs),
  };
}

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
    prices: loadPriceConfig(env),
  };
}
