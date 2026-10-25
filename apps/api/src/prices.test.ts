import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, job, price } from "@meridian/db";
import { INV_SEED_TODAY } from "@meridian/db/testing";
import type { PriceHistoryResponse, PricesStatusResponse, PriceView, RefreshPricesResponse } from "@meridian/shared";
import { TEST_DATABASE_URL } from "./test/helpers.js";
import { freshInvestmentApp, viewerCookies, type InvestmentApp } from "./test/investments.js";

/**
 * Prices routes on the INV seed (prices design §4.1, tests 25–26; plan decisions 10, 17, 19):
 * the status view (unconfigured in the test config, configured when the config says so), the
 * manual refresh (503 without a provider; created / moved up with one), a security's history,
 * and manual closes at PUT/DELETE /api/prices/:securityId/:date with their audit rows and error
 * codes. Reads are open to the viewer role and write nothing; mutations are refused for it.
 */

const TODAY = INV_SEED_TODAY;

describe.skipIf(!TEST_DATABASE_URL)("prices routes", () => {
  let A: InvestmentApp;
  let VTI: string;

  beforeAll(async () => {
    A = await freshInvestmentApp();
    VTI = A.S.securities.vti;
  });
  afterAll(async () => {
    await A?.t.cleanup();
  });

  const tableCounts = async () => {
    const out: Record<string, number> = {};
    for (const [name, table] of Object.entries({ job, auditLog, price })) out[name] = (await A.t.db.db.select({ n: count() }).from(table))[0]!.n;
    return out;
  };
  const securityAudits = async (securityId: string) =>
    (await A.t.db.db.select({ n: count() }).from(auditLog).where(and(eq(auditLog.entity, "security"), eq(auditLog.entityId, securityId))))[0]!.n;
  const fetchJobs = async () => A.t.db.db.select().from(job).where(eq(job.type, "prices.fetch"));

  it("reports the feed's status on the seed: unconfigured, the expected close, one row per priced security, the counts (prices test 26)", async () => {
    const before = await tableCounts();
    const res = await A.t.call({ method: "GET", url: "/api/prices/status" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const view = res.json() as PricesStatusResponse;
    expect(view).toMatchObject({ provider: null, configured: false, fetchHourLocal: 18, catchupHourLocal: 6, timezone: "America/Denver", expectedDate: "2026-10-13", lastRun: null, activeJob: null });
    expect(view.securities.map((s) => s.ticker ?? s.name)).toEqual(["AAPL", "BND", "VTI", "VXUS", "Vanguard Target Retirement 2050 Trust"]);
    expect(view.securities.find((s) => s.ticker === "VTI")).toEqual({
      securityId: VTI,
      ticker: "VTI",
      name: "Vanguard Total Stock Market ETF",
      priceMode: "provider",
      providerSymbol: null,
      alwaysPrice: false,
      held: true,
      latestPriceDate: "2026-10-13",
      latestClose: "312.5",
      latestSource: "provider",
      priceStatus: "current",
      tradingDaysBehind: 0,
      fetchStatus: null,
      fetchMessage: null,
      fetchedAt: null,
      failures: 0,
      nextAttemptAt: null,
      backfilledFrom: null,
    });
    expect(view.securities.find((s) => s.securityId === A.S.securities.tr2050)).toMatchObject({ priceMode: "implied", held: true, latestPriceDate: "2026-10-09", latestClose: "42", latestSource: "implied", priceStatus: "implied" });
    expect(view.counts).toEqual({ current: 4, stale: 0, notFound: 0, error: 0, implied: 1, manual: 0 });

    const viewer = await A.t.app.inject({ method: "GET", url: "/api/prices/status", cookies: await viewerCookies(A.t) });
    expect(viewer.statusCode).toBe(200);
    expect(viewer.body).toBe(res.body);
    expect(await tableCounts()).toEqual(before);

    // The config says a provider is set: the page reads `configured`.
    A.t.config.priceProvider = "tiingo";
    try {
      const configured = (await A.t.call({ method: "GET", url: "/api/prices/status" })).json() as PricesStatusResponse;
      expect(configured).toMatchObject({ provider: "tiingo", configured: true });
    } finally {
      delete A.t.config.priceProvider;
    }
  });

  it("lists a security's history newest first with its status, honouring from/to/limit", async () => {
    const res = await A.t.call({ method: "GET", url: `/api/prices/${VTI}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const view = res.json() as PriceHistoryResponse;
    expect(view).toMatchObject({ securityId: VTI, priceMode: "provider", expectedDate: "2026-10-13", priceStatus: "current", tradingDaysBehind: 0 });
    expect(view.latest).toMatchObject({ securityId: VTI, date: "2026-10-13", close: "312.5", adjClose: "312.5", source: "provider", provider: "tiingo", suspect: false });
    expect(view.items.map((p) => [p.date, p.close])).toEqual([
      ["2026-10-13", "312.5"],
      ["2026-10-12", "310"],
      ["2026-10-09", "309"],
      ["2026-04-13", "290"],
      ["2026-04-10", "290"],
      ["2025-10-13", "260"],
    ]);
    const windowed = (await A.t.call({ method: "GET", url: `/api/prices/${VTI}?from=2026-04-01&to=2026-10-12&limit=2` })).json() as PriceHistoryResponse;
    expect(windowed.items.map((p) => p.date)).toEqual(["2026-10-12", "2026-10-09"]);
    expect((await A.t.call({ method: "GET", url: `/api/prices/${randomUUID()}` })).statusCode).toBe(404);
    expect((await A.t.call({ method: "GET", url: "/api/prices/not-a-uuid" })).statusCode).toBe(400);
  });

  it("sets and removes a manual close: precedence, audit rows, 409 manual_only, 400 future_date / cash_security_reserved (prices test 25)", async () => {
    const auditsBefore = await securityAudits(VTI);
    const put = await A.t.call({ method: "PUT", url: `/api/prices/${VTI}/2026-10-09`, payload: { close: "310.02", today: TODAY } });
    expect(put.statusCode, put.body).toBe(200);
    // A manual close keeps the row's stored adjusted close (upsertPrices compares adj_close through COALESCE, a step-6 decision).
    expect(put.json() as PriceView).toMatchObject({ securityId: VTI, date: "2026-10-09", close: "310.02", adjClose: "309", source: "manual", provider: null, suspect: false });
    expect(await securityAudits(VTI)).toBe(auditsBefore + 1);
    const history = (await A.t.call({ method: "GET", url: `/api/prices/${VTI}?from=2026-10-09&to=2026-10-09` })).json() as PriceHistoryResponse;
    expect(history.items).toEqual([expect.objectContaining({ date: "2026-10-09", close: "310.02", source: "manual" })]);
    // An identical re-put is a no-op: the row and the audit log are unchanged.
    expect((await A.t.call({ method: "PUT", url: `/api/prices/${VTI}/2026-10-09`, payload: { close: "310.02", today: TODAY } })).statusCode).toBe(200);
    expect(await securityAudits(VTI)).toBe(auditsBefore + 1);

    expect((await A.t.call({ method: "PUT", url: `/api/prices/${VTI}/2026-10-15`, payload: { close: "1", today: TODAY } })).json()).toMatchObject({ code: "future_date" });
    expect((await A.t.call({ method: "PUT", url: `/api/prices/${A.S.securities.cash}/2026-10-13`, payload: { close: "1", today: TODAY } })).json()).toMatchObject({ code: "cash_security_reserved" });
    expect((await A.t.call({ method: "PUT", url: `/api/prices/${randomUUID()}/2026-10-13`, payload: { close: "1", today: TODAY } })).statusCode).toBe(404);
    expect((await A.t.call({ method: "PUT", url: `/api/prices/${VTI}/2026-10-13`, payload: { close: "-1", today: TODAY } })).statusCode).toBe(400);

    // Removing it: audited; no provider is configured, so no refill fetch is queued.
    const del = await A.t.call({ method: "DELETE", url: `/api/prices/${VTI}/2026-10-09` });
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json()).toEqual({ ok: true });
    expect(await securityAudits(VTI)).toBe(auditsBefore + 2);
    expect(await fetchJobs()).toEqual([]);
    expect((await A.t.db.db.select().from(price).where(and(eq(price.securityId, VTI), eq(price.date, "2026-10-09"))))).toEqual([]);
    expect((await A.t.call({ method: "DELETE", url: `/api/prices/${VTI}/2026-10-09` })).json()).toMatchObject({ code: "not_found" });
    const provider = await A.t.call({ method: "DELETE", url: `/api/prices/${VTI}/2026-10-12` });
    expect(provider.statusCode).toBe(409);
    expect(provider.json()).toMatchObject({ code: "manual_only" });
  });

  it("queues a manual refresh only when a provider is configured: 503 not_configured, then created, then moved up", async () => {
    const off = await A.t.call({ method: "POST", url: "/api/prices/refresh", payload: {} });
    expect(off.statusCode).toBe(503);
    expect(off.json()).toMatchObject({ code: "not_configured" });
    expect(await fetchJobs()).toEqual([]);

    A.t.config.priceProvider = "tiingo";
    try {
      const first = await A.t.call({ method: "POST", url: "/api/prices/refresh", payload: { securityIds: [VTI] } });
      expect(first.statusCode, first.body).toBe(200);
      const created = first.json() as RefreshPricesResponse;
      expect(created).toMatchObject({ created: true, movedUp: false });
      const [row] = await fetchJobs();
      expect(row).toMatchObject({ id: created.jobId, status: "queued", maxAttempts: 5, payload: { reason: "manual", securityIds: [VTI], dedupeKey: "prices:manual" } });
      const again = (await A.t.call({ method: "POST", url: "/api/prices/refresh", payload: {} })).json() as RefreshPricesResponse;
      expect(again).toEqual({ jobId: created.jobId, created: false, movedUp: true });
      const status = (await A.t.call({ method: "GET", url: "/api/prices/status" })).json() as PricesStatusResponse;
      expect(status.activeJob).toMatchObject({ id: created.jobId, status: "queued", reason: "manual" });
    } finally {
      delete A.t.config.priceProvider;
      await A.t.db.db.delete(job).where(eq(job.type, "prices.fetch"));
    }
  });

  it("rebuilds implied prices on demand: the 10-09 VTI close removed above is re-derived from the Roth statement (20 @ 309); a second run writes nothing", async () => {
    expect(await A.t.db.db.select().from(price).where(and(eq(price.securityId, VTI), eq(price.date, "2026-10-09")))).toEqual([]);
    const res = await A.t.call({ method: "POST", url: "/api/prices/rebuild-implied" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ written: 1 });
    const history = (await A.t.call({ method: "GET", url: `/api/prices/${VTI}?from=2026-10-09&to=2026-10-09` })).json() as PriceHistoryResponse;
    expect(history.items).toEqual([expect.objectContaining({ date: "2026-10-09", close: "309", source: "implied", provider: null })]);
    const before = await tableCounts();
    expect((await A.t.call({ method: "POST", url: "/api/prices/rebuild-implied" })).json()).toEqual({ written: 0 });
    expect(await tableCounts()).toEqual(before);
  });

  it("viewer: every read is 200, every mutation 403 viewer", async () => {
    const cookies = await viewerCookies(A.t);
    expect((await A.t.app.inject({ method: "GET", url: `/api/prices/${VTI}`, cookies })).statusCode).toBe(200);
    for (const req of [
      { method: "POST" as const, url: "/api/prices/refresh", payload: {} },
      { method: "POST" as const, url: "/api/prices/rebuild-implied" },
      { method: "PUT" as const, url: `/api/prices/${VTI}/2026-10-09`, payload: { close: "310.02" } },
      { method: "DELETE" as const, url: `/api/prices/${VTI}/2026-10-12` },
    ]) {
      const res = await A.t.app.inject({ ...req, cookies });
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(403);
      expect(res.json()).toMatchObject({ code: "viewer" });
    }
  });
});
