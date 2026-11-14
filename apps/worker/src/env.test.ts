import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePriceProviderId } from "@meridian/shared";
import {
  describeRetirementConfig,
  loadRetirementConfig,
  readRetirementThreads,
  RETIREMENT_DEFAULTS,
  retirementConfigOf,
  SIM_THREAD_ENTRY,
  loadConfig,
  loadPriceConfig,
  PRICE_DEFAULTS,
  priceConfigOf,
  readCatchupHour,
  readPriceProvider,
  readSimplefinAllowedHosts,
  readSimplefinMaxResponseBytes,
  readTiingoApiKey,
  resolveDatabaseUrl,
} from "./env.js";

describe("resolveDatabaseUrl", () => {
  it("assembles the URL from POSTGRES_* inside Docker and escapes the password", () => {
    expect(resolveDatabaseUrl({ MERIDIAN_DB_HOST: "db", POSTGRES_USER: "meridian", POSTGRES_PASSWORD: "p@ss/word", POSTGRES_DB: "meridian" })).toBe(
      "postgres://meridian:p%40ss%2Fword@db:5432/meridian",
    );
  });
  it("uses DATABASE_URL otherwise and fails loudly when nothing is set", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "postgres://x" })).toBe("postgres://x");
    expect(() => resolveDatabaseUrl({})).toThrow(/DATABASE_URL/);
  });
});

describe("price feed configuration (prices design §6.4)", () => {
  it("defaults to no provider, the hours 18 and 6 and the run budget", () => {
    expect(loadPriceConfig({})).toEqual({
      provider: null,
      tiingoApiKey: null,
      fetchHour: 18,
      catchupHour: 6,
      maxRequestsPerRun: 45,
      requestSpacingMs: 1500,
      runMaxMs: 1_200_000,
      overlapDays: 3,
      historyMaxYears: 20,
      timeoutMs: 30_000,
    });
    expect(readPriceProvider({ PRICE_PROVIDER: "none" })).toBeNull();
    expect(readPriceProvider({ PRICE_PROVIDER: "" })).toBeNull();
    expect(readPriceProvider({ PRICE_PROVIDER: " None " })).toBeNull();
    expect(readPriceProvider({})).toBeNull();
    expect(readPriceProvider({ PRICE_PROVIDER: "Tiingo" })).toBe("tiingo");
    expect(readPriceProvider({ PRICE_PROVIDER: " tiingo\n" })).toBe("tiingo");
    // The same parser as the API's `loadConfig` (plan decision 10): one .env value boots both or neither.
    for (const value of ["", "none", " None ", "tiingo", " Tiingo ", "stooq"]) {
      let shared: string | null | Error;
      let worker: string | null | Error;
      try {
        shared = parsePriceProviderId(value);
      } catch (err) {
        shared = err as Error;
      }
      try {
        worker = readPriceProvider({ PRICE_PROVIDER: value });
      } catch (err) {
        worker = err as Error;
      }
      expect(worker instanceof Error ? worker.message : worker, value).toEqual(shared instanceof Error ? shared.message : shared);
    }
    expect(() => readPriceProvider({ PRICE_PROVIDER: "stooq" })).toThrow('PRICE_PROVIDER must be "tiingo" or "none", not "stooq"');
  });

  it("tiingo needs a key from the environment or a secret file; boot fails without one", () => {
    expect(() => loadPriceConfig({ PRICE_PROVIDER: "tiingo" })).toThrow(/TIINGO_API_KEY/);
    expect(loadPriceConfig({ PRICE_PROVIDER: "tiingo", TIINGO_API_KEY: " abc " })).toMatchObject({ provider: "tiingo", tiingoApiKey: "abc" });
    const dir = mkdtempSync(path.join(tmpdir(), "meridian-env-"));
    const file = path.join(dir, "tiingo_api_key");
    writeFileSync(file, "from-file\n");
    expect(readTiingoApiKey({ PRICE_PROVIDER: "tiingo", TIINGO_API_KEY_FILE: file })).toBe("from-file");
    // The file wins over the variable, as SECRETS_KEY_FILE does.
    expect(readTiingoApiKey({ PRICE_PROVIDER: "tiingo", TIINGO_API_KEY_FILE: file, TIINGO_API_KEY: "env" })).toBe("from-file");
    // With PRICE_PROVIDER=none a key is kept but never required.
    expect(readTiingoApiKey({ TIINGO_API_KEY: "k" })).toBe("k");
    expect(readTiingoApiKey({})).toBeNull();
  });

  it("reads the hours, lets `off` disable the catch-up, and falls back on bad values", () => {
    expect(loadPriceConfig({ PRICE_FETCH_HOUR: "0", PRICE_CATCHUP_HOUR: "off" })).toMatchObject({ fetchHour: 0, catchupHour: null });
    expect(readCatchupHour({ PRICE_CATCHUP_HOUR: "25" })).toBe(6);
    expect(readCatchupHour({ PRICE_CATCHUP_HOUR: "7" })).toBe(7);
    expect(loadPriceConfig({ PRICE_FETCH_HOUR: "24", PRICE_MAX_REQUESTS_PER_RUN: "10", PRICE_REQUEST_SPACING_MS: "0", PRICE_RUN_MAX_MS: "10000" })).toMatchObject({
      fetchHour: 18,
      maxRequestsPerRun: 10,
      requestSpacingMs: 0,
      runMaxMs: 10_000,
    });
  });

  it("priceConfigOf fills a hand-built config with the defaults and keeps an explicit null catch-up", () => {
    expect(priceConfigOf({})).toMatchObject({ provider: null, tiingoApiKey: null, fetchHour: PRICE_DEFAULTS.fetchHour, catchupHour: PRICE_DEFAULTS.catchupHour });
    expect(priceConfigOf({ prices: { provider: "tiingo", tiingoApiKey: "k", catchupHour: null, maxRequestsPerRun: 3 } })).toMatchObject({
      provider: "tiingo",
      tiingoApiKey: "k",
      catchupHour: null,
      maxRequestsPerRun: 3,
      requestSpacingMs: 1500,
    });
  });

  it("loadConfig carries the price feed beside the Phase 1 settings", () => {
    const config = loadConfig({ DATABASE_URL: "postgres://x", SECRETS_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", PRICE_PROVIDER: "tiingo", TIINGO_API_KEY: "k", DETECT_HOUR_UTC: "3" });
    expect(config.prices).toMatchObject({ provider: "tiingo", tiingoApiKey: "k" });
    expect(config.detectHourUtc).toBe(3);
    expect(loadConfig({ DATABASE_URL: "postgres://x", SECRETS_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" }).prices?.provider).toBeNull();
  });
});

describe("SimpleFIN hosts and response size (a4-sync-parse-13, a4-sync-parse-15)", () => {
  it("allows the Bridge's hosts unless SIMPLEFIN_ALLOWED_HOSTS lists others, and refuses anything that is not a host name", () => {
    expect(readSimplefinAllowedHosts({})).toEqual(["bridge.simplefin.org", "beta-bridge.simplefin.org"]);
    expect(readSimplefinAllowedHosts({ SIMPLEFIN_ALLOWED_HOSTS: " " })).toEqual(["bridge.simplefin.org", "beta-bridge.simplefin.org"]);
    expect(readSimplefinAllowedHosts({ SIMPLEFIN_ALLOWED_HOSTS: "Bridge.SimpleFIN.org, sfin.home.example 192.168.1.20" })).toEqual(["bridge.simplefin.org", "sfin.home.example", "192.168.1.20"]);
    expect(() => readSimplefinAllowedHosts({ SIMPLEFIN_ALLOWED_HOSTS: "https://bridge.simplefin.org" })).toThrow(/host names only/);
    expect(() => readSimplefinAllowedHosts({ SIMPLEFIN_ALLOWED_HOSTS: "bridge.simplefin.org:443" })).toThrow(/host names only/);
  });
  it("reads at most 50 MB of a response unless SIMPLEFIN_MAX_RESPONSE_MB says otherwise", () => {
    expect(readSimplefinMaxResponseBytes({})).toBe(50_000_000);
    expect(readSimplefinMaxResponseBytes({ SIMPLEFIN_MAX_RESPONSE_MB: "120" })).toBe(120_000_000);
    expect(readSimplefinMaxResponseBytes({ SIMPLEFIN_MAX_RESPONSE_MB: "0" })).toBe(50_000_000);
    const config = loadConfig({ DATABASE_URL: "postgres://x", SECRETS_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" });
    expect(config).toMatchObject({ simplefinAllowedHosts: ["bridge.simplefin.org", "beta-bridge.simplefin.org"], simplefinMaxResponseBytes: 50_000_000 });
  });
});

describe("the encryption key and the database password (audit a7-backup-deploy-secrets-06, -17)", () => {
  const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
  it("refuses a SECRETS_KEY that is not 32 bytes of base64, from the variable or the secret file", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://x", SECRETS_KEY: "not-base64-at-all!!" })).toThrow(/SECRETS_KEY must be 32 random bytes in base64/);
    expect(() => loadConfig({ DATABASE_URL: "postgres://x", SECRETS_KEY: "ab".repeat(32) })).toThrow(/decodes to 48 bytes.*hex/);
    const file = path.join(mkdtempSync(path.join(tmpdir(), "meridian-key-")), "secrets_key");
    writeFileSync(file, "ab".repeat(32) + "\n");
    expect(() => loadConfig({ DATABASE_URL: "postgres://x", SECRETS_KEY_FILE: file })).toThrow(/decodes to 48 bytes/);
    writeFileSync(file, KEY + "\n");
    expect(loadConfig({ DATABASE_URL: "postgres://x", SECRETS_KEY_FILE: file }).secretsKey).toBe(KEY);
  });

  it("in production refuses the .env.example database password", () => {
    expect(() => loadConfig({ NODE_ENV: "production", MERIDIAN_DB_HOST: "db", POSTGRES_USER: "meridian", POSTGRES_PASSWORD: "change-me", POSTGRES_DB: "meridian", SECRETS_KEY: KEY })).toThrow(/POSTGRES_PASSWORD is the \.env\.example placeholder/);
    expect(loadConfig({ NODE_ENV: "development", DATABASE_URL: "postgres://meridian:change-me@localhost/meridian", SECRETS_KEY: KEY }).secretsKey).toBe(KEY);
  });
});

describe("retirement simulations (inputs-and-data §3.10, §6.3; seams C10)", () => {
  it("case 39: RETIREMENT_THREADS auto is min(8, max(1, parallelism − 1)); 1 to 64 as given; inline is 0; anything else is auto", () => {
    // Unset, empty and auto are the same default: 1 core → 1; 2 → 1; 4 → 3; 8 → 7; 16 → 8.
    for (const [parallelism, threads] of [
      [1, 1],
      [2, 1],
      [4, 3],
      [8, 7],
      [16, 8],
    ] as const) {
      expect(readRetirementThreads({}, parallelism), `parallelism ${parallelism}`).toEqual({ threads, warning: null });
      expect(readRetirementThreads({ RETIREMENT_THREADS: "" }, parallelism).threads).toBe(threads);
      expect(readRetirementThreads({ RETIREMENT_THREADS: " Auto " }, parallelism).threads).toBe(threads);
    }
    expect(readRetirementThreads({ RETIREMENT_THREADS: "12" }, 4)).toEqual({ threads: 12, warning: null });
    expect(readRetirementThreads({ RETIREMENT_THREADS: "1" }, 16)).toEqual({ threads: 1, warning: null });
    expect(readRetirementThreads({ RETIREMENT_THREADS: "64" }, 4)).toEqual({ threads: 64, warning: null });
    expect(readRetirementThreads({ RETIREMENT_THREADS: "inline" }, 4)).toEqual({ threads: 0, warning: null });
    expect(readRetirementThreads({ RETIREMENT_THREADS: "INLINE" }, 4).threads).toBe(0);
    // 0, 65 and abc fall back to auto (3 threads on 4 cores), with a warning for the boot log.
    for (const value of ["0", "65", "abc", "2.5", "-1", "1e1"]) {
      const r = readRetirementThreads({ RETIREMENT_THREADS: value }, 4);
      expect(r.threads, value).toBe(3);
      expect(r.warning, value).toBe(`RETIREMENT_THREADS="${value}" is not auto, inline or a whole number 1 to 64; using auto (3)`);
    }
  });

  it("threads need the bundled thread entry: without dist/simThread.js the simulations run inline, and the boot log says so", () => {
    // Run from source the entry names src/simThread.js, which is never built.
    expect(SIM_THREAD_ENTRY.href).toMatch(/\/apps\/worker\/src\/simThread\.js$/);
    const missing = loadRetirementConfig({ RETIREMENT_THREADS: "2" }, { parallelism: 4 });
    expect(missing.config).toEqual({ threads: 0, threadEntry: null, runMaxMs: 900_000, keepRuns: 20 });
    expect(missing.notes).toEqual([`the simulation thread entry ${SIM_THREAD_ENTRY.href} does not exist (run from source); simulations run inline`]);
    expect(describeRetirementConfig(missing.config)).toBe("retirement simulations run inline on the job's thread, stop after 900000 ms, keep 20 finished runs per scenario");

    const dir = mkdtempSync(path.join(tmpdir(), "meridian-simthread-"));
    const file = path.join(dir, "simThread.js");
    writeFileSync(file, "");
    const entry = pathToFileURL(file);
    const auto = loadRetirementConfig({}, { parallelism: 4, threadEntry: entry });
    expect(auto).toEqual({ config: { threads: 3, threadEntry: entry, runMaxMs: 900_000, keepRuns: 20 }, notes: [] });
    expect(describeRetirementConfig(auto.config)).toBe(`retirement simulations run on 3 threads from ${entry.href}, stop after 900000 ms, keep 20 finished runs per scenario`);
    expect(loadRetirementConfig({ RETIREMENT_THREADS: "1" }, { threadEntry: entry }).config.threads).toBe(1);
    expect(describeRetirementConfig(loadRetirementConfig({ RETIREMENT_THREADS: "1" }, { threadEntry: entry }).config)).toMatch(/^retirement simulations run on 1 thread from /);
    // inline needs no entry and writes no note.
    expect(loadRetirementConfig({ RETIREMENT_THREADS: "inline" }, { threadEntry: entry })).toEqual({ config: { threads: 0, threadEntry: null, runMaxMs: 900_000, keepRuns: 20 }, notes: [] });
  });

  it("RETIREMENT_RUN_MAX_MS (default 15 minutes, at most the stale sweep's 30) and RETIREMENT_KEEP_RUNS (default 20, at least 1)", () => {
    const entry = { threadEntry: new URL("file:///nowhere/simThread.js") };
    expect(loadRetirementConfig({ RETIREMENT_THREADS: "inline", RETIREMENT_RUN_MAX_MS: "60000", RETIREMENT_KEEP_RUNS: "5" }, entry)).toEqual({
      config: { threads: 0, threadEntry: null, runMaxMs: 60_000, keepRuns: 5 },
      notes: [],
    });
    expect(loadRetirementConfig({ RETIREMENT_THREADS: "inline", RETIREMENT_RUN_MAX_MS: " ", RETIREMENT_KEEP_RUNS: "" }, entry).config).toMatchObject({ runMaxMs: 900_000, keepRuns: 20 });
    const bad = loadRetirementConfig({ RETIREMENT_THREADS: "inline", RETIREMENT_RUN_MAX_MS: "3600000", RETIREMENT_KEEP_RUNS: "0" }, entry);
    expect(bad.config).toMatchObject({ runMaxMs: 900_000, keepRuns: 20 });
    expect(bad.notes).toEqual([
      'RETIREMENT_RUN_MAX_MS="3600000" is not a whole number 1000 to 1800000; using 900000',
      'RETIREMENT_KEEP_RUNS="0" is not a whole number 1 to 1000; using 20',
    ]);
    expect(RETIREMENT_DEFAULTS).toEqual({ runMaxMs: 900_000, keepRuns: 20 });
  });

  it("loadConfig carries the settings; a hand-built config without them runs inline with the defaults", () => {
    const config = loadConfig({ DATABASE_URL: "postgres://x", SECRETS_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", RETIREMENT_THREADS: "abc", RETIREMENT_KEEP_RUNS: "7" });
    // From source there is no thread entry, so even auto runs inline.
    expect(config.retirement).toEqual({ threads: 0, threadEntry: null, runMaxMs: 900_000, keepRuns: 7 });
    expect(config.bootNotes).toHaveLength(2);
    expect(config.bootNotes![0]).toMatch(/^RETIREMENT_THREADS="abc" is not auto, inline or a whole number 1 to 64; using auto \(\d+\)$/);
    expect(retirementConfigOf({})).toEqual({ threads: 0, threadEntry: null, runMaxMs: 900_000, keepRuns: 20 });
    // Threads without an entry are not threads.
    expect(retirementConfigOf({ retirement: { threads: 4 } })).toEqual({ threads: 0, threadEntry: null, runMaxMs: 900_000, keepRuns: 20 });
    const entry = new URL("file:///app/apps/worker/dist/simThread.js");
    expect(retirementConfigOf({ retirement: { threads: 4, threadEntry: entry, keepRuns: 3 } })).toEqual({ threads: 4, threadEntry: entry, runMaxMs: 900_000, keepRuns: 3 });
  });
});
