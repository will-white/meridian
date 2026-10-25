import { describe, expect, it } from "vitest";
import { parseFixed8, type PriceProvider, type ProviderResult } from "@meridian/shared";
import type { WorkerConfig } from "../env.js";
import { isPermanentError } from "../runner.js";
import { createPriceProvider, fetchWithRetries, PriceFeedError, RETRY_AFTER_CAP_MS, sanitizeProviderMessage } from "./provider.js";
import { bodyNamesUnknownTicker, parseRetryAfter, TiingoProvider } from "./tiingo.js";

/**
 * The Tiingo adapter over an injected fetch and the per-symbol retry loop (prices design
 * §3.12; tests 21 and 23's adapter half). The CSV parser, symbol mapping and suspect rule
 * are covered in packages/shared.
 */

const HEADER = "date,close,high,low,open,volume,adjClose,adjHigh,adjLow,adjOpen,divCash,splitFactor";
const CSV = `${HEADER}\n2026-10-13,305.25,306,304,304.5,1000,305.25,306,304,304.5,0.0,1.0\n2026-10-12T00:00:00.000Z,303,304,302,302.5,900,303,304,302,302.5,0.0,1.0\n`;
const RANGE = { from: "2026-10-09", to: "2026-10-13" };

function fakeFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function providerWith(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const { fetchImpl, calls } = fakeFetch(handler);
  return { provider: new TiingoProvider({ apiKey: "secret-key", fetch: fetchImpl, timeoutMs: 1000 }), calls };
}

describe("TiingoProvider", () => {
  it("asks for the daily CSV with the key in the Authorization header and never in the URL", async () => {
    const { provider, calls } = providerWith(() => new Response(CSV, { status: 200 }));
    const result = await provider.fetchDaily("BRK-B", RANGE);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url.origin).toBe("https://api.tiingo.com");
    expect(url.pathname).toBe("/tiingo/daily/BRK-B/prices");
    expect(Object.fromEntries(url.searchParams)).toEqual({ startDate: "2026-10-09", endDate: "2026-10-13", format: "csv", resampleFreq: "daily" });
    expect(url.toString()).not.toContain("secret-key");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Token secret-key");
    expect(headers["Accept"]).toBe("text/csv");
    expect(headers["User-Agent"]).toMatch(/^Meridian\//);
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({
      ok: true,
      bars: [
        { date: "2026-10-12", close: parseFixed8("303"), adjClose: parseFixed8("303"), splitFactor: parseFixed8("1") },
        { date: "2026-10-13", close: parseFixed8("305.25"), adjClose: parseFixed8("305.25"), splitFactor: parseFixed8("1") },
      ],
    });
    expect(provider.mapSymbol({ ticker: "brk.b", providerSymbol: null })).toBe("BRK-B");
    expect(provider.mapSymbol({ ticker: "brk.b", providerSymbol: "BRKB" })).toBe("BRKB");
    expect(provider.urlFor("A B", RANGE)).toContain("/tiingo/daily/A%20B/prices");
  });

  it("maps every status the way the fetch job expects", async () => {
    const status = async (res: Response | (() => never)) => {
      const { provider } = providerWith(typeof res === "function" ? res : () => res);
      return provider.fetchDaily("ZZZZ", RANGE);
    };
    expect(await status(new Response("", { status: 404 }))).toEqual({ ok: false, kind: "not_found", message: "tiingo: symbol ZZZZ not found", status: 404 });
    expect(await status(new Response(JSON.stringify({ detail: "Error: Ticker 'ZZZZ' not found" }), { status: 200 }))).toMatchObject({ ok: false, kind: "not_found" });
    expect(await status(new Response("", { status: 401 }))).toEqual({ ok: false, kind: "auth", message: "tiingo: API key rejected (401)", status: 401 });
    expect(await status(new Response("", { status: 403 }))).toMatchObject({ ok: false, kind: "auth", status: 403 });
    expect(await status(new Response("", { status: 429, headers: { "Retry-After": "30" } }))).toEqual({ ok: false, kind: "rate_limited", message: "tiingo: rate limited (429)", status: 429, retryAfterMs: 30_000 });
    expect(await status(new Response("", { status: 429 }))).toEqual({ ok: false, kind: "rate_limited", message: "tiingo: rate limited (429)", status: 429 });
    expect(await status(new Response("boom", { status: 503 }))).toEqual({ ok: false, kind: "http", message: "tiingo: HTTP 503", status: 503, body: "boom" });
    const network = await status(() => {
      throw new TypeError("fetch failed: ECONNRESET");
    });
    expect(network).toMatchObject({ ok: false, kind: "network" });
    expect((network as { message: string }).message).toContain("ECONNRESET");
    const html = await status(new Response("<html><body>Sign in</body></html>", { status: 200 }));
    expect(html).toMatchObject({ ok: false, kind: "invalid_response", body: "<html><body>Sign in</body></html>" });
    expect((html as { message: string }).message).toMatch(/^tiingo: /);
    expect(await status(new Response("", { status: 200 }))).toEqual({ ok: true, bars: [] });
  });

  it("reads Retry-After as seconds or an HTTP date, and spots an unknown-ticker JSON body", () => {
    const now = new Date("2026-10-14T18:00:00Z");
    expect(parseRetryAfter("30", now)).toBe(30_000);
    expect(parseRetryAfter("Wed, 14 Oct 2026 18:01:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("Wed, 14 Oct 2026 17:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(bodyNamesUnknownTicker('{"detail":"Error: Ticker \'ZZZZ\' not found"}')).toBe(true);
    expect(bodyNamesUnknownTicker('{"detail":"Not found."}')).toBe(true);
    expect(bodyNamesUnknownTicker('{"detail":"Rate limit"}')).toBe(false);
    expect(bodyNamesUnknownTicker(CSV)).toBe(false);
    expect(bodyNamesUnknownTicker("{not json")).toBe(false);
  });
});

/** A provider that answers from a script, one result per call. */
function scripted(results: ProviderResult[]): PriceProvider & { calls: number } {
  let i = 0;
  const p: PriceProvider & { calls: number } = {
    id: "tiingo",
    calls: 0,
    mapSymbol: (s) => s.ticker,
    fetchDaily: async () => {
      p.calls++;
      const r = results[Math.min(i, results.length - 1)]!;
      i++;
      return r;
    },
  };
  return p;
}

const OK: ProviderResult = { ok: true, bars: [] };
const RATE = (retryAfterMs?: number): ProviderResult => ({ ok: false, kind: "rate_limited", message: "429", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
const HTTP: ProviderResult = { ok: false, kind: "http", message: "503", status: 503 };
const NET: ProviderResult = { ok: false, kind: "network", message: "ECONNRESET" };

describe("fetchWithRetries", () => {
  const run = async (results: ProviderResult[]) => {
    const sleeps: number[] = [];
    const p = scripted(results);
    const out = await fetchWithRetries(p, "VTI", RANGE, { sleep: async (ms) => void sleeps.push(ms) });
    return { ...out, sleeps, calls: p.calls };
  };

  it("429 with Retry-After 30 then 503 then 200 → 3 requests, sleeps [30 s, 15 s], success (prices test 21)", async () => {
    const r = await run([RATE(30_000), HTTP, OK]);
    expect(r.attempts).toBe(3);
    expect(r.calls).toBe(3);
    expect(r.sleeps).toEqual([30_000, 15_000]);
    expect(r.result).toEqual(OK);
  });

  it("http and network failures back off 5 s then 15 s and give up after the third attempt", async () => {
    const r = await run([NET, NET, NET, OK]);
    expect(r.attempts).toBe(3);
    expect(r.sleeps).toEqual([5_000, 15_000]);
    expect(r.result).toEqual(NET);
    const two = await run([HTTP, OK]);
    expect(two.attempts).toBe(2);
    expect(two.sleeps).toEqual([5_000]);
    expect(two.result).toEqual(OK);
  });

  it("a persistent 429 sleeps the default 5 s without Retry-After, caps Retry-After at 120 s, and comes back rate_limited", async () => {
    const r = await run([RATE(), RATE(), RATE()]);
    expect(r.attempts).toBe(3);
    expect(r.sleeps).toEqual([5_000, 5_000]);
    expect(r.result).toMatchObject({ ok: false, kind: "rate_limited" });
    const capped = await run([RATE(500_000), OK]);
    expect(capped.sleeps).toEqual([RETRY_AFTER_CAP_MS]);
  });

  it("not_found, auth and invalid_response come back at once", async () => {
    for (const kind of ["not_found", "auth", "invalid_response"] as const) {
      const r = await run([{ ok: false, kind, message: kind }, OK]);
      expect(r.attempts).toBe(1);
      expect(r.sleeps).toEqual([]);
      expect(r.result).toMatchObject({ ok: false, kind });
    }
  });
});

describe("createPriceProvider and PriceFeedError", () => {
  const base: Pick<WorkerConfig, "prices"> = {};
  it("is null with PRICE_PROVIDER=none (or no price config), tiingo with a key, and refuses tiingo without one", () => {
    expect(createPriceProvider(base)).toBeNull();
    expect(createPriceProvider({ prices: { provider: null } })).toBeNull();
    const p = createPriceProvider({ prices: { provider: "tiingo", tiingoApiKey: "k" } });
    expect(p).toBeInstanceOf(TiingoProvider);
    expect(p!.id).toBe("tiingo");
    expect(() => createPriceProvider({ prices: { provider: "tiingo" } })).toThrow(PriceFeedError);
    try {
      createPriceProvider({ prices: { provider: "tiingo", tiingoApiKey: null } });
    } catch (err) {
      expect((err as PriceFeedError).kind).toBe("not_configured");
      expect((err as PriceFeedError).permanent).toBe(true);
    }
  });

  it("marks auth and not_configured permanent, network retryable; the runner reads any `permanent: true`", () => {
    expect(new PriceFeedError("auth", "x").permanent).toBe(true);
    expect(new PriceFeedError("not_configured", "x").permanent).toBe(true);
    expect(new PriceFeedError("network", "x").permanent).toBe(false);
    expect(isPermanentError(new PriceFeedError("auth", "x"))).toBe(true);
    expect(isPermanentError(new PriceFeedError("network", "x"))).toBe(false);
    expect(isPermanentError(Object.assign(new Error("x"), { permanent: true }))).toBe(true);
    expect(isPermanentError(new Error("x"))).toBe(false);
    expect(isPermanentError(null)).toBe(false);
    expect(isPermanentError("permanent")).toBe(false);
  });

  it("sanitizes provider text to one line of at most 300 characters", () => {
    expect(sanitizeProviderMessage("tiingo:\n  bad\tthing\u0000")).toBe("tiingo: bad thing");
    expect(sanitizeProviderMessage("x".repeat(400))).toHaveLength(300);
  });
});
