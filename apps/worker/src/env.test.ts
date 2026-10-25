import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, loadPriceConfig, PRICE_DEFAULTS, priceConfigOf, readCatchupHour, readPriceProvider, readTiingoApiKey, resolveDatabaseUrl } from "./env.js";

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
    expect(readPriceProvider({ PRICE_PROVIDER: "Tiingo" })).toBe("tiingo");
    expect(() => readPriceProvider({ PRICE_PROVIDER: "stooq" })).toThrow(/PRICE_PROVIDER/);
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
    const config = loadConfig({ DATABASE_URL: "postgres://x", SECRETS_KEY: "s", PRICE_PROVIDER: "tiingo", TIINGO_API_KEY: "k", DETECT_HOUR_UTC: "3" });
    expect(config.prices).toMatchObject({ provider: "tiingo", tiingoApiKey: "k" });
    expect(config.detectHourUtc).toBe(3);
    expect(loadConfig({ DATABASE_URL: "postgres://x", SECRETS_KEY: "s" }).prices?.provider).toBeNull();
  });
});
