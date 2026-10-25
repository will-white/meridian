import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, holdingSnapshot, job, price, security, type Db } from "@meridian/db";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "@meridian/db/testing";
import { generateSecretsKey } from "@meridian/shared";
import type { WorkerConfig } from "./env.js";
import type { JobContext } from "./jobs/context.js";
import { DAILY_JOB_TYPES, inCatchupWindow, schedulePriceJobs } from "./scheduler.js";

/**
 * The price feed's clock (prices design §3.13, test 24) on the household-local day
 * (America/Denver, the default): a nightly fetch at or after 18:00 and a conditional catch-up
 * from 06:00, each keyed per local day. The daily tick's third job is asserted here too.
 */

describe("inCatchupWindow", () => {
  it("is the half-open window from the catch-up hour to the nightly hour, wrapping past midnight", () => {
    expect(inCatchupWindow(6, 6, 18)).toBe(true);
    expect(inCatchupWindow(12, 6, 18)).toBe(true);
    expect(inCatchupWindow(17, 6, 18)).toBe(true);
    expect(inCatchupWindow(18, 6, 18)).toBe(false);
    expect(inCatchupWindow(5, 6, 18)).toBe(false);
    expect(inCatchupWindow(23, 20, 6)).toBe(true);
    expect(inCatchupWindow(3, 20, 6)).toBe(true);
    expect(inCatchupWindow(6, 20, 6)).toBe(false);
    expect(inCatchupWindow(10, 20, 6)).toBe(false);
    expect(inCatchupWindow(6, 6, 6)).toBe(false);
  });
});

describe("DAILY_JOB_TYPES", () => {
  it("queues the income feed between the recurring run and the month close (plan decision 18)", () => {
    expect(DAILY_JOB_TYPES).toEqual(["recurring.detect", "investments.income_feed", "plan.close_month"]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("schedulePriceJobs", () => {
  let t: TestDb;
  let db: Db;
  let ctx: JobContext;
  let vtiId: string;
  let now = new Date("2026-10-13T23:30:00Z");
  const config: WorkerConfig = {
    databaseUrl: "unused",
    secretsKey: generateSecretsKey(),
    workerId: "test-worker",
    syncIntervalHours: 6,
    pollIntervalMs: 10,
    initialWindowDays: 93,
    overlapDays: 7,
    requestTimeoutMs: 5000,
    prices: { provider: "tiingo", tiingoApiKey: "k", fetchHour: 18, catchupHour: 6 },
  };
  const priceJobs = async () => (await db.select().from(job).orderBy(asc(job.createdAt))).filter((j) => j.type === "prices.fetch").map((j) => j.payload);

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    const [acct] = await db.insert(account).values({ name: "Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false }).returning({ id: account.id });
    const [vti] = await db.insert(security).values({ ticker: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf", assetClass: "us_stock", priceMode: "provider", needsReview: false }).returning({ id: security.id });
    vtiId = vti!.id;
    await db.insert(holdingSnapshot).values({ accountId: acct!.id, securityId: vtiId, date: "2026-10-09", quantity: "10", price: "300", valueCents: 300000n, source: "csv" });
    // The feed is current: the 10-13 close is in (so an afternoon tick has no catch-up to queue).
    await db.insert(price).values({ securityId: vtiId, date: "2026-10-13", close: "305.25", source: "provider", provider: "tiingo" });
    ctx = { db, config, client: {}, now: () => now, log: { info: () => {}, warn: () => {}, error: () => {} } };
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("queues the nightly fetch once the Denver clock passes 18:00, keyed by the local day (test 24)", async () => {
    now = new Date("2026-10-13T23:30:00Z"); // 17:30 MDT
    expect(await schedulePriceJobs(ctx)).toBe(0);
    now = new Date("2026-10-14T00:05:00Z"); // 18:05 MDT, household day 10-13
    expect(await schedulePriceJobs(ctx)).toBe(1);
    expect(await priceJobs()).toEqual([{ reason: "nightly", day: "2026-10-13", dedupeKey: "prices:nightly:2026-10-13" }]);
    // The next tick finds the key, even after the job has run.
    expect(await schedulePriceJobs(ctx)).toBe(0);
    await db.update(job).set({ status: "done" });
    now = new Date("2026-10-14T05:59:00Z"); // 23:59 MDT
    expect(await schedulePriceJobs(ctx)).toBe(0);
    expect(await priceJobs()).toHaveLength(1);
  });

  it("queues the morning catch-up only when a fetched security is behind the expected close", async () => {
    now = new Date("2026-10-14T12:00:00Z"); // 06:00 MDT 10-14; 08:00 in New York → the expected close is 10-13
    // Nothing is behind while the 10-13 close is in.
    expect(await schedulePriceJobs(ctx)).toBe(0);
    // With the 10-13 close missing VTI is behind: one catch-up for the local day.
    await db.delete(price).where(eq(price.securityId, vtiId));
    expect(await schedulePriceJobs(ctx)).toBe(1);
    expect((await priceJobs())[1]).toEqual({ reason: "catchup", day: "2026-10-14", dedupeKey: "prices:catchup:2026-10-14" });
    expect(await schedulePriceJobs(ctx)).toBe(0);
    // Before 06:00 there is no catch-up, and at 18:00 only the nightly is due.
    await db.delete(job);
    now = new Date("2026-10-14T11:30:00Z"); // 05:30 MDT
    expect(await schedulePriceJobs(ctx)).toBe(0);
    now = new Date("2026-10-15T00:30:00Z"); // 18:30 MDT 10-14
    expect(await schedulePriceJobs(ctx)).toBe(1);
    expect(await priceJobs()).toEqual([{ reason: "nightly", day: "2026-10-14", dedupeKey: "prices:nightly:2026-10-14" }]);
  });

  it("never queues with PRICE_PROVIDER=none, and PRICE_CATCHUP_HOUR=off disables the catch-up", async () => {
    await db.delete(job);
    now = new Date("2026-10-15T00:30:00Z");
    expect(await schedulePriceJobs({ ...ctx, config: { ...config, prices: { ...config.prices, provider: null } } })).toBe(0);
    const { prices: _prices, ...withoutPrices } = config;
    expect(await schedulePriceJobs({ ...ctx, config: withoutPrices })).toBe(0);
    now = new Date("2026-10-15T12:00:00Z"); // 06:00 MDT 10-15 with VTI still behind
    expect(await schedulePriceJobs({ ...ctx, config: { ...config, prices: { ...config.prices, catchupHour: null } } })).toBe(0);
    expect(await schedulePriceJobs(ctx)).toBe(1);
    expect(await priceJobs()).toEqual([{ reason: "catchup", day: "2026-10-15", dedupeKey: "prices:catchup:2026-10-15" }]);
  });
});
