import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { defaultThreads, MAX_THREADS } from "@meridian/retirement/node";
import { parsePriceProviderId, placeholderSecretProblem, secretsKeyProblem, type PriceProviderId } from "@meridian/shared";
import { DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_SIMPLEFIN_HOSTS } from "./simplefin/client.js";

/**
 * SECRETS_KEY from the environment, or from a Docker secret file named by SECRETS_KEY_FILE;
 * it must be 32 bytes of base64 (audit a7-backup-deploy-secrets-06). `name` reads another key
 * the same way (SECRETS_KEY_OLD for the key rotation).
 */
export function readSecretsKey(env: NodeJS.ProcessEnv = process.env, name = "SECRETS_KEY"): string {
  const file = env[`${name}_FILE`];
  const fromFile = file ? readFileSync(file, "utf8").trim() : "";
  const key = fromFile || env[name]?.trim() || "";
  if (!key) throw new Error(`${name} (or ${name}_FILE) must be set; generate one with \`openssl rand -base64 32\``);
  const problem = secretsKeyProblem(key, name);
  if (problem) throw new Error(problem);
  return key;
}

/** In production, stop on the .env.example database password (audit a7-backup-deploy-secrets-17). */
export function productionDatabaseProblem(databaseUrl: string): string | null {
  let password = "";
  try {
    password = decodeURIComponent(new URL(databaseUrl).password);
  } catch {
    return null;
  }
  return placeholderSecretProblem("POSTGRES_PASSWORD", password);
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

/**
 * `SIMPLEFIN_ALLOWED_HOSTS`: the hosts a setup token's claim URL and an access URL may name,
 * comma or space separated (audit a4-sync-parse-15). Unset or empty: the SimpleFIN Bridge's
 * own hosts. Only host names or addresses, no scheme, port or path; boot fails otherwise.
 */
export function readSimplefinAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env["SIMPLEFIN_ALLOWED_HOSTS"]?.trim();
  if (!raw) return [...DEFAULT_SIMPLEFIN_HOSTS];
  const hosts = raw.split(/[\s,]+/).filter(Boolean).map((h) => h.toLowerCase());
  for (const host of hosts) {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$|^\[[0-9a-f:.]+\]$/.test(host)) {
      throw new Error(`SIMPLEFIN_ALLOWED_HOSTS: "${host}" is not a host name; list host names only (no https://, port or path), for example bridge.simplefin.org`);
    }
  }
  return hosts;
}

/** `SIMPLEFIN_MAX_RESPONSE_MB`: the largest account-set response the worker reads, in megabytes (default 50). */
export function readSimplefinMaxResponseBytes(env: NodeJS.ProcessEnv = process.env): number {
  const mb = Number(env["SIMPLEFIN_MAX_RESPONSE_MB"]);
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1_000_000) : DEFAULT_MAX_RESPONSE_BYTES;
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

// ---- Retirement simulations (docs/design/phase-4/inputs-and-data.md §3.10 and §6.3; seams C7, C10) ----

export const RETIREMENT_DEFAULTS = {
  /** `RETIREMENT_RUN_MAX_MS`: a run is stopped after 15 minutes, below the runner's 30-minute stale sweep. */
  runMaxMs: 900_000,
  /** `RETIREMENT_KEEP_RUNS`: finished unpinned runs kept per scenario (decision 28). */
  keepRuns: 20,
} as const;

/** The longest run `RETIREMENT_RUN_MAX_MS` accepts: the runner's stale sweep requeues a job running 30 minutes. */
export const RETIREMENT_RUN_MAX_MS_LIMIT = 1_800_000;
/** The most finished runs per scenario `RETIREMENT_KEEP_RUNS` accepts. */
export const RETIREMENT_KEEP_RUNS_LIMIT = 1000;

/**
 * The thread entry the bundle ships beside `main.js` (`dist/simThread.js`, the worker's second
 * bundle). Run from source (`tsx watch`, Vitest) this names `src/simThread.js`, which does not
 * exist, so simulations run inline there (seams C10).
 */
export const SIM_THREAD_ENTRY = new URL("./simThread.js", import.meta.url);

/** The retirement settings a run reads, every field resolved (see `retirementConfigOf`). */
export interface RetirementConfig {
  /** Simulation threads; 0 runs inline on the job's own thread, yielding between chunks. */
  threads: number;
  /** The bundled thread entry; null when the simulations run inline. */
  threadEntry: URL | null;
  runMaxMs: number;
  keepRuns: number;
}

/**
 * `RETIREMENT_THREADS` (§3.10): unset, empty or `auto` → the engine's `defaultThreads`
 * (`min(8, max(1, parallelism − 1))`); a whole number 1 to 64 as given; `inline` → 0. Anything
 * else falls back to `auto`, with a warning for the boot log.
 */
export function readRetirementThreads(env: NodeJS.ProcessEnv = process.env, parallelism: number = availableParallelism()): { threads: number; warning: string | null } {
  const raw = env["RETIREMENT_THREADS"]?.trim().toLowerCase() ?? "";
  const auto = defaultThreads(parallelism);
  if (raw === "" || raw === "auto") return { threads: auto, warning: null };
  if (raw === "inline") return { threads: 0, warning: null };
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 1 && n <= MAX_THREADS) return { threads: n, warning: null };
  }
  return { threads: auto, warning: `RETIREMENT_THREADS="${env["RETIREMENT_THREADS"] ?? ""}" is not auto, inline or a whole number 1 to ${MAX_THREADS}; using auto (${auto})` };
}

/** A whole number within [min, max] (unset or empty: the fallback), else the fallback with a warning naming the variable. */
function boundedInt(name: string, value: string | undefined, min: number, max: number, fallback: number, warnings: string[]): number {
  const raw = value?.trim() ?? "";
  if (raw === "") return fallback;
  const n = Number(raw);
  if (/^\d+$/.test(raw) && n >= min && n <= max) return n;
  warnings.push(`${name}="${value ?? ""}" is not a whole number ${min} to ${max}; using ${fallback}`);
  return fallback;
}

/**
 * The retirement part of `loadConfig` (§6.3): the thread count, the thread entry, the run's time
 * limit and the retention. Threads need the bundled entry: without the file (run from source) the
 * simulations run inline, and `notes` says so for the boot log, beside any unreadable setting.
 */
export function loadRetirementConfig(
  env: NodeJS.ProcessEnv = process.env,
  o: { parallelism?: number; threadEntry?: URL } = {},
): { config: RetirementConfig; notes: string[] } {
  const notes: string[] = [];
  const threads = readRetirementThreads(env, o.parallelism);
  if (threads.warning) notes.push(threads.warning);
  const entry = o.threadEntry ?? SIM_THREAD_ENTRY;
  const entryExists = entry.protocol === "file:" && existsSync(fileURLToPath(entry));
  if (threads.threads > 0 && !entryExists) notes.push(`the simulation thread entry ${entry.href} does not exist (run from source); simulations run inline`);
  const runMaxMs = boundedInt("RETIREMENT_RUN_MAX_MS", env["RETIREMENT_RUN_MAX_MS"], 1000, RETIREMENT_RUN_MAX_MS_LIMIT, RETIREMENT_DEFAULTS.runMaxMs, notes);
  const keepRuns = boundedInt("RETIREMENT_KEEP_RUNS", env["RETIREMENT_KEEP_RUNS"], 1, RETIREMENT_KEEP_RUNS_LIMIT, RETIREMENT_DEFAULTS.keepRuns, notes);
  const inline = threads.threads === 0 || !entryExists;
  return { config: { threads: inline ? 0 : threads.threads, threadEntry: inline ? null : entry, runMaxMs, keepRuns }, notes };
}

/** The resolved retirement settings of a config: a hand-built config without them runs inline with the defaults. */
export function retirementConfigOf(config: Pick<WorkerConfig, "retirement">): RetirementConfig {
  const r = config.retirement;
  const threadEntry = r?.threadEntry ?? null;
  return {
    threads: threadEntry === null ? 0 : (r?.threads ?? 0),
    threadEntry,
    runMaxMs: r?.runMaxMs ?? RETIREMENT_DEFAULTS.runMaxMs,
    keepRuns: r?.keepRuns ?? RETIREMENT_DEFAULTS.keepRuns,
  };
}

/** The boot log's line on the simulations: which mode runs them, and their limits. */
export function describeRetirementConfig(r: RetirementConfig): string {
  const mode = r.threads === 0 || r.threadEntry === null ? "run inline on the job's thread" : `run on ${r.threads} thread${r.threads === 1 ? "" : "s"} from ${r.threadEntry.href}`;
  return `retirement simulations ${mode}, stop after ${r.runMaxMs} ms, keep ${r.keepRuns} finished runs per scenario`;
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
  /** Hosts SimpleFIN requests may go to (`SIMPLEFIN_ALLOWED_HOSTS`). loadConfig always sets it; the client's default is the Bridge's hosts. */
  simplefinAllowedHosts?: readonly string[];
  /** The largest account-set response read (`SIMPLEFIN_MAX_RESPONSE_MB`). loadConfig always sets it. */
  simplefinMaxResponseBytes?: number;
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
  /** `WORKER_HEARTBEAT_FILE`: touched after every pass over the queue, for the container's healthcheck (unset: none). */
  heartbeatFile?: string;
  /**
   * Phase 4 simulations (`RETIREMENT_THREADS`, `RETIREMENT_RUN_MAX_MS`, `RETIREMENT_KEEP_RUNS`).
   * loadConfig always sets it; a hand-built config without it runs inline with the defaults (see
   * `retirementConfigOf`).
   */
  retirement?: Partial<RetirementConfig>;
  /** Settings loadConfig could not use as given, for the boot log. */
  bootNotes?: string[];
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
  const databaseUrl = resolveDatabaseUrl(env);
  if (env["NODE_ENV"] === "production") {
    const problem = productionDatabaseProblem(databaseUrl);
    if (problem) throw new Error(problem);
  }
  const retirement = loadRetirementConfig(env);
  return {
    databaseUrl,
    secretsKey: readSecretsKey(env),
    workerId: `${hostname()}:${process.pid}`,
    syncIntervalHours: int(env["SYNC_INTERVAL_HOURS"], 6),
    pollIntervalMs: int(env["WORKER_POLL_MS"], 5000),
    initialWindowDays: int(env["SIMPLEFIN_INITIAL_WINDOW_DAYS"], 93),
    overlapDays: int(env["SIMPLEFIN_OVERLAP_DAYS"], 7),
    requestTimeoutMs: int(env["SIMPLEFIN_TIMEOUT_MS"], 60_000),
    simplefinAllowedHosts: readSimplefinAllowedHosts(env),
    simplefinMaxResponseBytes: readSimplefinMaxResponseBytes(env),
    detectHourUtc: intInRange(env["DETECT_HOUR_UTC"], 0, 23, DEFAULT_DETECT_HOUR_UTC),
    prices: loadPriceConfig(env),
    ...(env["WORKER_HEARTBEAT_FILE"]?.trim() ? { heartbeatFile: env["WORKER_HEARTBEAT_FILE"].trim() } : {}),
    retirement: retirement.config,
    bootNotes: retirement.notes,
  };
}
