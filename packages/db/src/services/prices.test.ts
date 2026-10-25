import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, parseFixed8 } from "@meridian/shared";
import { account, holdingSnapshot, householdSetting, importLog, job, price, security } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { INV_SEED_NOW, INV_SEED_TODAY, seedInvestmentFixture, type InvestmentSeed } from "../test/investmentSeed.js";
import { listAudit } from "./audit.js";
import { rebuildImpliedPrices } from "./holdings.js";
import {
  countSecuritiesBehind,
  deleteManualPrice,
  getPrice,
  latestPrices,
  listPrices,
  loadPriceSeries,
  priceFeedHealth,
  priceFetchPlan,
  priceRefreshDedupeKey,
  pricesStatus,
  requestPriceRefresh,
  securityPriceStatus,
  upsertPrices,
} from "./prices.js";
import { createSecurity, setManualPrice } from "./securities.js";

const ctx = (batchId = randomUUID()) => ({ userId: null, batchId, today: INV_SEED_TODAY });
const f8 = parseFixed8;
const NOW = INV_SEED_NOW;

describe.skipIf(!TEST_DATABASE_URL)("prices", () => {
  let t: TestDb;
  let S: InvestmentSeed;

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedInvestmentFixture(t.db);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("status view on the seed: expected date, held rows, counts; stale on a later day; unconfigured feed (prices test 26)", async () => {
    const status = await pricesStatus(t.db, { now: NOW, provider: "tiingo", fetchHourLocal: 18, catchupHourLocal: 6 });
    expect(status).toMatchObject({ provider: "tiingo", configured: true, fetchHourLocal: 18, catchupHourLocal: 6, timezone: "America/Denver", today: "2026-10-14", expectedDate: "2026-10-13", lastRun: null, activeJob: null });
    expect(status.securities.map((s) => s.ticker ?? s.name)).toEqual(["AAPL", "BND", "VTI", "VXUS", "Vanguard Target Retirement 2050 Trust"]);
    for (const ticker of ["AAPL", "BND", "VTI", "VXUS"]) {
      expect(status.securities.find((s) => s.ticker === ticker)).toMatchObject({ priceMode: "provider", held: true, fetched: true, latestPriceDate: "2026-10-13", latestSource: "provider", priceStatus: "current", tradingDaysBehind: 0, fetchStatus: null, failures: 0 });
    }
    expect(status.securities.find((s) => s.securityId === S.securities.tr2050)).toMatchObject({ priceMode: "implied", held: true, fetched: false, latestPriceDate: "2026-10-09", latestClose: f8("42"), latestSource: "implied", priceStatus: "implied", tradingDaysBehind: 0 });
    expect(status.counts).toEqual({ current: 4, stale: 0, notFound: 0, error: 0, implied: 1, manual: 0 });

    // Saturday 2026-10-17: the expected close is 10-16; 10-14, 10-15, 10-16 are three sessions behind.
    const saturday = await pricesStatus(t.db, { now: new Date("2026-10-17T15:00:00Z"), provider: "tiingo" });
    expect(saturday).toMatchObject({ expectedDate: "2026-10-16", fetchHourLocal: 18, catchupHourLocal: 6 });
    expect(saturday.securities.filter((s) => s.priceMode === "provider").map((s) => [s.priceStatus, s.tradingDaysBehind])).toEqual(Array(4).fill(["stale", 3]));
    expect(saturday.counts).toMatchObject({ current: 0, stale: 4 });
    const health = await priceFeedHealth(t.db, { now: new Date("2026-10-17T15:00:00Z"), provider: "tiingo" });
    expect(health).toEqual({ configured: true, provider: "tiingo", expectedDate: "2026-10-16", lastRunAt: null, stale: 4, notFound: 0, error: 0 });

    const none = await pricesStatus(t.db, { now: NOW, provider: null, catchupHourLocal: null });
    expect(none).toMatchObject({ provider: null, configured: false, catchupHourLocal: null });

    // The last run and an active job show up.
    const [log] = await t.db.insert(importLog).values({ kind: "prices.fetch", status: "ok", startedAt: new Date("2026-10-14T01:00:00Z"), finishedAt: new Date("2026-10-14T01:02:00Z"), message: "tiingo: 4 requests", stats: { requests: 4 } }).returning({ id: importLog.id });
    const queued = await requestPriceRefresh(t.db, { reason: "holdings", now: NOW });
    const withRun = await pricesStatus(t.db, { now: NOW, provider: "tiingo" });
    expect(withRun.lastRun).toMatchObject({ importLogId: log!.id, status: "ok", message: "tiingo: 4 requests", stats: { requests: 4 } });
    expect(withRun.activeJob).toMatchObject({ id: queued.jobId, status: "queued", reason: "holdings" });
    expect(withRun.lastRun!.startedAt.toISOString()).toBe("2026-10-14T01:00:00.000Z");
    await t.db.delete(job).where(eq(job.id, queued.jobId));

    const one = await securityPriceStatus(t.db, S.securities.vti, NOW);
    expect(one).toMatchObject({ priceMode: "provider", expectedDate: "2026-10-13", priceStatus: "current", tradingDaysBehind: 0, latest: { date: "2026-10-13", close: f8("312.5") } });
  });

  it("reads: latest on or before a date, series with the anchor first, adjusted fallback, history newest first", async () => {
    const latest = await latestPrices(t.db, [S.securities.vti, S.securities.vxus, S.securities.tr2050, S.securities.cash], "2026-10-10");
    expect(latest.get(S.securities.vti)).toEqual({ date: "2026-10-09", close: f8("309"), source: "provider" });
    expect(latest.get(S.securities.vxus)).toEqual({ date: "2026-10-09", close: f8("70.5"), source: "provider" });
    expect(latest.get(S.securities.tr2050)).toEqual({ date: "2026-10-09", close: f8("42"), source: "implied" });
    expect(latest.get(S.securities.cash)).toBeNull();
    expect((await latestPrices(t.db, [S.securities.vti])).get(S.securities.vti)).toMatchObject({ date: "2026-10-13" });

    const series = await loadPriceSeries(t.db, [S.securities.vti, S.securities.tr2050, S.securities.cash], "2026-10-10", "2026-10-13");
    expect(series.get(S.securities.vti)).toEqual({
      securityId: S.securities.vti,
      adjusted: false,
      points: [
        { date: "2026-10-09", close: f8("309"), source: "provider", suspect: false },
        { date: "2026-10-12", close: f8("310"), source: "provider", suspect: false },
        { date: "2026-10-13", close: f8("312.5"), source: "provider", suspect: false },
      ],
    });
    expect(series.get(S.securities.tr2050)!.points.map((p) => p.date)).toEqual(["2026-10-09"]);
    expect(series.get(S.securities.cash)).toEqual({ securityId: S.securities.cash, adjusted: false, points: [] });
    const exact = await loadPriceSeries(t.db, [S.securities.vti], "2026-10-12", "2026-10-13");
    expect(exact.get(S.securities.vti)!.points.map((p) => p.date)).toEqual(["2026-10-12", "2026-10-13"]);
    const adjusted = await loadPriceSeries(t.db, [S.securities.vti, S.securities.tr2050], "2026-10-10", "2026-10-13", { adjusted: true });
    expect(adjusted.get(S.securities.vti)!.adjusted).toBe(true);
    expect(adjusted.get(S.securities.tr2050)!.adjusted).toBe(false);
    await expect(loadPriceSeries(t.db, [S.securities.vti], "2026-10-13", "2026-10-12")).rejects.toMatchObject({ status: 400 });

    expect((await listPrices(t.db, S.securities.vti, { limit: 2 })).map((p) => p.date)).toEqual(["2026-10-13", "2026-10-12"]);
    expect((await listPrices(t.db, S.securities.vti, { from: "2026-04-01", to: "2026-04-30" })).map((p) => p.date)).toEqual(["2026-04-13", "2026-04-10"]);
  });

  it("upsert precedence manual > provider > implied, adjusted closes kept, no-op re-upserts kept (prices test 7)", async () => {
    const vfiax = (await createSecurity(t.db, { ticker: "VFIAX", name: "Vanguard 500 Index Admiral", type: "fund", assetClass: "us_stock" }, ctx())).id;
    const d = "2026-10-13";
    expect(await upsertPrices(t.db, [{ securityId: vfiax, date: d, close: f8("500"), source: "implied" }])).toEqual({ inserted: 1, updated: 0, kept: 0 });
    expect(await upsertPrices(t.db, [{ securityId: vfiax, date: d, close: f8("505.1"), source: "provider", provider: "tiingo", adjClose: f8("505.1"), fetchedAt: NOW }])).toEqual({ inserted: 0, updated: 1, kept: 0 });
    expect((await getPrice(t.db, vfiax, d))!).toMatchObject({ close: f8("505.1"), source: "provider", provider: "tiingo", adjClose: f8("505.1"), fetchedAt: NOW });
    expect(await upsertPrices(t.db, [{ securityId: vfiax, date: d, close: f8("505"), source: "manual" }])).toEqual({ inserted: 0, updated: 1, kept: 0 });
    expect((await getPrice(t.db, vfiax, d))!).toMatchObject({ close: f8("505"), source: "manual", provider: null, adjClose: f8("505.1") });
    expect(await upsertPrices(t.db, [{ securityId: vfiax, date: d, close: f8("505.1"), source: "provider", provider: "tiingo" }])).toEqual({ inserted: 0, updated: 0, kept: 1 });
    expect((await getPrice(t.db, vfiax, d))!).toMatchObject({ close: f8("505"), source: "manual" });

    const d2 = "2026-10-14";
    expect(await upsertPrices(t.db, [{ securityId: vfiax, date: d2, close: f8("505.1"), source: "provider", provider: "tiingo", adjClose: f8("505.1") }])).toEqual({ inserted: 1, updated: 0, kept: 0 });
    expect(await upsertPrices(t.db, [{ securityId: vfiax, date: d2, close: f8("505.11"), source: "provider", provider: "tiingo", adjClose: f8("505.11") }])).toEqual({ inserted: 0, updated: 1, kept: 0 });
    expect(await upsertPrices(t.db, [{ securityId: vfiax, date: d2, close: f8("505.12"), source: "implied" }])).toEqual({ inserted: 0, updated: 0, kept: 1 });
    const before = (await getPrice(t.db, vfiax, d2))!;
    // A later provider row without an adjusted close keeps the stored one and is a no-op.
    expect(await upsertPrices(t.db, [{ securityId: vfiax, date: d2, close: f8("505.11"), source: "provider", provider: "tiingo", adjClose: null }])).toEqual({ inserted: 0, updated: 0, kept: 1 });
    const after = (await getPrice(t.db, vfiax, d2))!;
    expect(after).toMatchObject({ close: f8("505.11"), adjClose: f8("505.11"), source: "provider" });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    // The suspect flag is a change in its own right.
    expect(await upsertPrices(t.db, [{ securityId: vfiax, date: d2, close: f8("505.11"), source: "provider", provider: "tiingo", suspect: true }])).toEqual({ inserted: 0, updated: 1, kept: 0 });
    expect((await getPrice(t.db, vfiax, d2))!.suspect).toBe(true);
    // Duplicate keys in one batch collapse to the last; a batch mixes inserts, updates and keeps.
    expect(
      await upsertPrices(t.db, [
        { securityId: vfiax, date: "2026-10-15", close: f8("1"), source: "implied" },
        { securityId: vfiax, date: "2026-10-15", close: f8("506"), source: "implied" },
        { securityId: vfiax, date: d2, close: f8("505.11"), source: "provider", provider: "tiingo", suspect: true },
        { securityId: vfiax, date: d, close: f8("1"), source: "implied" },
      ]),
    ).toEqual({ inserted: 1, updated: 0, kept: 2 });
    expect((await getPrice(t.db, vfiax, "2026-10-15"))!.close).toBe(f8("506"));
    await expect(upsertPrices(t.db, [{ securityId: vfiax, date: d, close: f8("1"), source: "provider" }])).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(upsertPrices(t.db, [{ securityId: vfiax, date: d, close: f8("-1"), source: "manual" }])).rejects.toMatchObject({ status: 400, code: "validation" });
    expect(await upsertPrices(t.db, [])).toEqual({ inserted: 0, updated: 0, kept: 0 });
  });

  it("implied → provider → implied kept → manual → provider kept; an identical re-write moves nothing (imports test 20)", async () => {
    const sec = (await createSecurity(t.db, { ticker: "IMP20", name: "Implied Twenty ETF", type: "etf", assetClass: "us_stock" }, ctx())).id;
    const d = "2026-10-13";
    expect(await upsertPrices(t.db, [{ securityId: sec, date: d, close: f8("250.66"), source: "implied" }])).toEqual({ inserted: 1, updated: 0, kept: 0 });
    expect(await upsertPrices(t.db, [{ securityId: sec, date: d, close: f8("250.7"), source: "provider", provider: "tiingo" }])).toEqual({ inserted: 0, updated: 1, kept: 0 });
    expect((await getPrice(t.db, sec, d))!).toMatchObject({ close: f8("250.7"), source: "provider", provider: "tiingo" });
    expect(await upsertPrices(t.db, [{ securityId: sec, date: d, close: f8("250.66"), source: "implied" }])).toEqual({ inserted: 0, updated: 0, kept: 1 });
    expect((await getPrice(t.db, sec, d))!.close).toBe(f8("250.7"));
    expect(await upsertPrices(t.db, [{ securityId: sec, date: d, close: f8("251"), source: "manual" }])).toEqual({ inserted: 0, updated: 1, kept: 0 });
    expect(await upsertPrices(t.db, [{ securityId: sec, date: d, close: f8("250.7"), source: "provider", provider: "tiingo" }])).toEqual({ inserted: 0, updated: 0, kept: 1 });
    const before = (await getPrice(t.db, sec, d))!;
    expect(before).toMatchObject({ close: f8("251"), source: "manual", provider: null });
    // The same implied write again, and the same manual write again: both kept, nothing moves.
    expect(await upsertPrices(t.db, [{ securityId: sec, date: d, close: f8("250.66"), source: "implied" }])).toEqual({ inserted: 0, updated: 0, kept: 1 });
    expect(await upsertPrices(t.db, [{ securityId: sec, date: d, close: f8("251"), source: "manual" }])).toEqual({ inserted: 0, updated: 0, kept: 1 });
    expect((await getPrice(t.db, sec, d))!.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    // One row per (security, date): the manual close is the one every reader sees.
    expect((await listPrices(t.db, sec)).map((p) => [p.date, p.source, p.close])).toEqual([[d, "manual", f8("251")]]);
  });

  it("manual prices and refresh requests (prices test 25)", async () => {
    const VTI = S.securities.vti;
    const batch = randomUUID();
    const set = await setManualPrice(t.db, VTI, { date: "2026-10-09", close: f8("310.02") }, ctx(batch));
    expect(set).toMatchObject({ securityId: VTI, date: "2026-10-09", close: f8("310.02"), source: "manual", provider: null });
    const audit = await listAudit(t.db, { batchId: batch, limit: 5 });
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({
      entity: "security",
      entityId: VTI,
      action: "update",
      before: { price: { date: "2026-10-09", close: "309", source: "provider" } },
      after: { price: { date: "2026-10-09", close: "310.02", source: "manual" } },
    });
    // Neither the feed nor an implied rebuild replaces it (R's 10-09 statement prices VTI at 309).
    expect(await upsertPrices(t.db, [{ securityId: VTI, date: "2026-10-09", close: f8("310"), source: "provider", provider: "tiingo" }])).toEqual({ inserted: 0, updated: 0, kept: 1 });
    expect(await rebuildImpliedPrices(t.db, { securityIds: [VTI], dates: ["2026-10-09"] })).toEqual({ written: 0, removed: 0 });
    expect((await getPrice(t.db, VTI, "2026-10-09"))!.close).toBe(f8("310.02"));
    await expect(setManualPrice(t.db, VTI, { date: "2026-10-15", close: f8("1") }, ctx())).rejects.toMatchObject({ status: 400, code: "future_date" });
    await expect(setManualPrice(t.db, VTI, { date: "2026-10-13", close: f8("-1") }, ctx())).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(setManualPrice(t.db, randomUUID(), { date: "2026-10-13", close: f8("1") }, ctx())).rejects.toMatchObject({ status: 404 });

    // A queued continuation never swallows the refill that follows a delete.
    const cont = await requestPriceRefresh(t.db, { reason: "continue", rootJobId: "11111111-1111-4111-8111-111111111111", continuation: 1, securityIds: [VTI], now: NOW });
    expect(cont).toMatchObject({ created: true, movedUp: false, dedupeKey: "prices:continue:11111111-1111-4111-8111-111111111111" });
    const delBatch = randomUUID();
    const removed = await deleteManualPrice(t.db, VTI, "2026-10-09", ctx(delBatch), { now: NOW });
    expect(removed.refillJobId).not.toBeNull();
    expect(await getPrice(t.db, VTI, "2026-10-09")).toBeUndefined();
    const [refill] = await t.db.select().from(job).where(eq(job.id, removed.refillJobId!));
    expect(refill).toMatchObject({ type: "prices.fetch", status: "queued", payload: { reason: "refill", securityIds: [VTI], from: "2026-10-09", dedupeKey: `prices:refill:${VTI}` } });
    expect((await listAudit(t.db, { batchId: delBatch, limit: 5 })).items[0]).toMatchObject({ before: { price: { date: "2026-10-09", close: "310.02", source: "manual" } }, after: { price: { date: "2026-10-09", close: null, source: null } } });
    await expect(deleteManualPrice(t.db, VTI, "2026-10-12", ctx())).rejects.toMatchObject({ status: 409, code: "manual_only" });
    await expect(deleteManualPrice(t.db, VTI, "2026-10-01", ctx())).rejects.toMatchObject({ status: 404, code: "not_found" });
    // The same refill again is deduped; with the refill turned off nothing is queued.
    await setManualPrice(t.db, VTI, { date: "2026-10-09", close: f8("310.02") }, ctx());
    const again = await deleteManualPrice(t.db, VTI, "2026-10-09", ctx(), { now: NOW });
    expect(again.refillJobId).toBe(removed.refillJobId);
    await setManualPrice(t.db, VTI, { date: "2026-10-09", close: f8("310.02") }, ctx());
    expect(await deleteManualPrice(t.db, VTI, "2026-10-09", ctx(), { refill: false })).toEqual({ refillJobId: null });
    await t.db.delete(job).where(and(eq(job.type, "prices.fetch")));

    // POST /api/prices/refresh semantics.
    expect(priceRefreshDedupeKey({ reason: "nightly", day: "2026-10-13" })).toBe("prices:nightly:2026-10-13");
    expect(priceRefreshDedupeKey({ reason: "catchup", day: "2026-10-14" })).toBe("prices:catchup:2026-10-14");
    expect(() => priceRefreshDedupeKey({ reason: "nightly" })).toThrow();
    expect(() => priceRefreshDedupeKey({ reason: "refill" })).toThrow();
    const later = new Date(NOW.getTime() + 3_600_000);
    const first = await requestPriceRefresh(t.db, { reason: "manual", securityIds: [VTI], runAt: later, now: NOW });
    expect(first).toMatchObject({ created: true, movedUp: false, dedupeKey: "prices:manual" });
    expect((await t.db.select().from(job).where(eq(job.id, first.jobId)))[0]).toMatchObject({ maxAttempts: 5, payload: { reason: "manual", securityIds: [VTI], dedupeKey: "prices:manual" } });
    const moved = await requestPriceRefresh(t.db, { reason: "manual", now: NOW });
    expect(moved).toMatchObject({ jobId: first.jobId, created: false, movedUp: true });
    expect((await t.db.select().from(job).where(eq(job.id, first.jobId)))[0]!.runAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
    const holdings = await requestPriceRefresh(t.db, { reason: "holdings", now: NOW });
    expect(holdings).toMatchObject({ created: true, dedupeKey: "prices:holdings" });
    expect(await requestPriceRefresh(t.db, { reason: "holdings", now: NOW })).toMatchObject({ jobId: holdings.jobId, created: false, movedUp: false });
    await t.db.update(job).set({ status: "running" }).where(eq(job.id, holdings.jobId));
    expect(await requestPriceRefresh(t.db, { reason: "manual", now: NOW })).toEqual({ jobId: holdings.jobId, created: false, movedUp: false, dedupeKey: "prices:manual" });
    // Another reason is still queued beside the running one.
    expect(await requestPriceRefresh(t.db, { reason: "reconcile", now: NOW })).toMatchObject({ created: true, dedupeKey: "prices:reconcile" });
    await t.db.delete(job).where(and(eq(job.type, "prices.fetch")));
  });

  it("fetch plan: the fetch set, eligibility, ranges, order and the budget (prices test 20)", async () => {
    const VTI = S.securities.vti;
    const VXUS = S.securities.vxus;
    const AAPL = S.securities.aapl;
    const BND = S.securities.bnd;
    const [m] = await t.db.insert(account).values({ name: "Plan Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false }).returning({ id: account.id });
    const M = m!.id;
    const sold = (await createSecurity(t.db, { ticker: "SOLD", name: "Sold Out Inc", type: "stock", assetClass: "other" }, ctx())).id;
    const bench = (await createSecurity(t.db, { ticker: "BENCH", name: "Benchmark Index", type: "etf", assetClass: "us_stock" }, ctx())).id;
    const newx = (await createSecurity(t.db, { ticker: "NEWX", name: "New Fund", type: "fund", assetClass: "other" }, ctx())).id;
    await t.db.insert(holdingSnapshot).values([
      { accountId: M, securityId: sold, date: "2026-10-13", quantity: "0", price: null, valueCents: 0n, source: "csv" },
      { accountId: M, securityId: newx, date: "2026-08-03", quantity: "1", price: "10", valueCents: 1000n, source: "csv" },
      { accountId: M, securityId: newx, date: "2026-10-13", quantity: "1", price: "11", valueCents: 1100n, source: "csv" },
    ]);
    await t.db.update(householdSetting).set({ benchmarkSecurityId: bench }).where(eq(householdSetting.id, 1));
    const day = 86_400_000;
    await t.db.update(security).set({ priceBackfilledFrom: "2024-02-23", priceFetchedAt: new Date(NOW.getTime() - day), priceFetchStatus: "ok" }).where(eq(security.id, VTI));
    await t.db.update(security).set({ priceBackfilledFrom: "2024-06-03", priceFetchedAt: new Date(NOW.getTime() - 2 * day), priceFetchStatus: "ok" }).where(eq(security.id, VXUS));
    await t.db.update(security).set({ priceFetchedAt: new Date(NOW.getTime() - 2 * day), priceFetchStatus: "not_found", updatedAt: new Date(NOW.getTime() - 3 * day) }).where(eq(security.id, AAPL));
    await t.db.update(security).set({ priceNextAttemptAt: new Date(NOW.getTime() + day), priceFetchStatus: "error", priceFetchFailures: 1 }).where(eq(security.id, BND));

    const base = { now: NOW, today: INV_SEED_TODAY, expectedThrough: "2026-10-13" };
    const plan = await priceFetchPlan(t.db, base);
    expect(plan.expectedThrough).toBe("2026-10-13");
    expect(plan.skipped).toEqual([
      { securityId: AAPL, ticker: "AAPL", reason: "not_found" },
      { securityId: BND, ticker: "BND", reason: "backoff" },
    ]);
    expect(plan.deferred).toEqual([]);
    expect(plan.work.map((e) => e.ticker)).toEqual(["BENCH", "NEWX", "VXUS", "VTI"]);
    const by = (ticker: string) => plan.work.find((e) => e.ticker === ticker)!;
    // The benchmark has no evidence of its own: the household's earliest date (B's first buy, 2024-03-01) minus 7.
    expect(by("BENCH")).toMatchObject({ securityId: bench, symbol: "BENCH", from: "2024-02-23", to: "2026-10-13", latestProviderDate: null, firstNeededDate: "2024-03-01", priceFetchedAt: null, priceBackfilledFrom: null });
    expect(by("NEWX")).toMatchObject({ from: "2026-07-27", to: "2026-10-13", firstNeededDate: "2026-08-03", latestProviderDate: null });
    // Latest provider close 10-13 → from 10-10 ≤ to: the overlap is still requested.
    expect(by("VTI")).toMatchObject({ from: "2026-10-10", to: "2026-10-13", latestProviderDate: "2026-10-13", priceBackfilledFrom: "2024-02-23" });
    expect(by("VXUS")).toMatchObject({ from: "2026-10-10", to: "2026-10-13", latestProviderDate: "2026-10-13" });
    expect(plan.work.map((e) => e.securityId)).not.toContain(S.securities.tr2050);
    expect(plan.work.map((e) => e.securityId)).not.toContain(S.securities.cash);
    expect(plan.work.map((e) => e.securityId)).not.toContain(sold);

    // Named: the not_found security is retried; a symbol edit or a week's wait retries it too.
    const named = await priceFetchPlan(t.db, { ...base, securityIds: [AAPL, S.securities.tr2050] });
    expect(named.work.map((e) => e.ticker)).toEqual(["AAPL"]);
    expect(named.skipped).toEqual([]);
    await t.db.update(security).set({ providerSymbol: "AAPL.US", updatedAt: NOW }).where(eq(security.id, AAPL));
    // AAPL and VXUS were both fetched two days ago: the tie goes by ticker.
    expect((await priceFetchPlan(t.db, base)).work.map((e) => e.ticker)).toEqual(["BENCH", "NEWX", "AAPL", "VXUS", "VTI"]);
    expect((await priceFetchPlan(t.db, base)).work.find((e) => e.ticker === "AAPL")).toMatchObject({ symbol: "AAPL.US", from: "2025-01-08", firstNeededDate: "2025-01-15" });
    await t.db.update(security).set({ providerSymbol: null, updatedAt: new Date(NOW.getTime() - 3 * day), priceFetchedAt: new Date(NOW.getTime() - 8 * day) }).where(eq(security.id, AAPL));
    expect((await priceFetchPlan(t.db, base)).work.map((e) => e.ticker)).toEqual(["BENCH", "NEWX", "AAPL", "VXUS", "VTI"]);
    await t.db.update(security).set({ priceFetchedAt: new Date(NOW.getTime() - 2 * day) }).where(eq(security.id, AAPL));

    // A requested start, the history floor and from > to.
    const extended = await priceFetchPlan(t.db, { ...base, from: "2015-01-01" });
    expect(extended.work.every((e) => e.from === "2015-01-01")).toBe(true);
    const floored = await priceFetchPlan(t.db, { ...base, from: "1990-01-01" });
    expect(floored.work.every((e) => e.from === "2006-10-14")).toBe(true);
    const tenYears = await priceFetchPlan(t.db, { ...base, from: "1990-01-01", maxYears: 10 });
    expect(tenYears.work.every((e) => e.from === "2016-10-14")).toBe(true);
    const late = await priceFetchPlan(t.db, { ...base, from: "2026-10-20" });
    expect(late.work).toEqual([]);
    expect(late.skipped.map((s) => [s.ticker, s.reason])).toEqual([
      ["AAPL", "not_found"],
      ["BENCH", "from_after_to"],
      ["BND", "backoff"],
      ["NEWX", "from_after_to"],
      ["VTI", "from_after_to"],
      ["VXUS", "from_after_to"],
    ]);
    const overlap = await priceFetchPlan(t.db, { ...base, overlapDays: 1 });
    expect(overlap.work.find((e) => e.ticker === "VTI")!.from).toBe("2026-10-12");

    // The budget splits work from deferred in plan order.
    const budgeted = await priceFetchPlan(t.db, { ...base, maxRequests: 2 });
    expect(budgeted.work.map((e) => e.ticker)).toEqual(["BENCH", "NEWX"]);
    expect(budgeted.deferred.map((e) => e.ticker)).toEqual(["VXUS", "VTI"]);

    // Behind: the two never-fetched securities; VTI and VXUS carry the expected close already.
    expect(await countSecuritiesBehind(t.db, base)).toBe(2);
    expect(await countSecuritiesBehind(t.db, { ...base, expectedThrough: "2026-10-14" })).toBe(4);

    // A security sold within 400 days stays in the set through its disposal row; an archived one never appears.
    await t.db.update(security).set({ archived: true }).where(eq(security.id, newx));
    expect((await priceFetchPlan(t.db, base)).work.map((e) => e.ticker)).toEqual(["BENCH", "VXUS", "VTI"]);
    await t.db.update(security).set({ archived: false }).where(eq(security.id, newx));
    await t.db.update(householdSetting).set({ benchmarkSecurityId: VTI }).where(eq(householdSetting.id, 1));
    expect((await priceFetchPlan(t.db, base)).work.map((e) => e.ticker)).toEqual(["NEWX", "VXUS", "VTI"]);
    await t.db.update(security).set({ alwaysPrice: true }).where(eq(security.id, bench));
    expect((await priceFetchPlan(t.db, base)).work.map((e) => e.ticker)).toEqual(["BENCH", "NEWX", "VXUS", "VTI"]);
    expect(addDays("2026-10-13", -3)).toBe("2026-10-10");
    await t.db.delete(price).where(eq(price.securityId, sold));
  });
});
