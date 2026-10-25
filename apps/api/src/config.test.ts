import { describe, expect, it } from "vitest";
import { parsePriceProviderId } from "@meridian/shared";
import { loadConfig, parseCatchupHour } from "./config.js";

/**
 * The API's environment (plan decision 10): `PRICE_PROVIDER` goes through the shared
 * `parsePriceProviderId`, exactly as the worker's `readPriceProvider` does, so a value that
 * boots one container boots the other (and a bad one fails both with the same message).
 */

const BASE = { DATABASE_URL: "postgres://x", SECRETS_KEY: "s", SESSION_SECRET: "0123456789abcdef0123456789abcdef" };

describe("loadConfig: PRICE_PROVIDER", () => {
  it("defaults to no provider and accepts the worker's spellings: empty, `none` in any case, surrounding spaces", () => {
    expect(loadConfig(BASE).priceProvider).toBeNull();
    expect(loadConfig({ ...BASE, PRICE_PROVIDER: "" }).priceProvider).toBeNull();
    expect(loadConfig({ ...BASE, PRICE_PROVIDER: "none" }).priceProvider).toBeNull();
    expect(loadConfig({ ...BASE, PRICE_PROVIDER: " None " }).priceProvider).toBeNull();
    expect(loadConfig({ ...BASE, PRICE_PROVIDER: "tiingo" }).priceProvider).toBe("tiingo");
    expect(loadConfig({ ...BASE, PRICE_PROVIDER: " Tiingo\n" }).priceProvider).toBe("tiingo");
  });

  it("refuses an unknown provider with the shared message", () => {
    expect(() => loadConfig({ ...BASE, PRICE_PROVIDER: "stooq" })).toThrow('PRICE_PROVIDER must be "tiingo" or "none", not "stooq"');
    for (const value of ["", "none", " None ", "tiingo", " Tiingo ", "stooq"]) {
      let shared: string | null | Error;
      let api: string | null | Error;
      try {
        shared = parsePriceProviderId(value);
      } catch (err) {
        shared = err as Error;
      }
      try {
        api = loadConfig({ ...BASE, PRICE_PROVIDER: value }).priceProvider ?? null;
      } catch (err) {
        api = err as Error;
      }
      expect(api instanceof Error ? api.message : api, value).toEqual(shared instanceof Error ? shared.message : shared);
    }
  });

  it("carries the display hours beside the provider", () => {
    const config = loadConfig({ ...BASE, PRICE_PROVIDER: "tiingo", PRICE_FETCH_HOUR: "17", PRICE_CATCHUP_HOUR: "off" });
    expect(config).toMatchObject({ priceProvider: "tiingo", priceFetchHour: 17, priceCatchupHour: null });
    expect(parseCatchupHour("7")).toBe(7);
    expect(parseCatchupHour("25")).toBe(6);
  });
});
