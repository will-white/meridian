import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, connection, createSession, enqueueJob, holdingSnapshot, job, price, security, session, signInEvent, user, type Db } from "@meridian/db";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "@meridian/db/testing";
import { encryptSecret, generateSecretsKey } from "@meridian/shared";
import type { WorkerConfig } from "./env.js";
import type { JobContext } from "./jobs/context.js";
import { drainQueue } from "./runner.js";
import { atMostEvery, DAILY_JOB_TYPES, inCatchupWindow, purgeSignInData, scheduleDueSyncs, schedulePriceJobs, SIGN_IN_PURGE_INTERVAL_MS } from "./scheduler.js";

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

describe("atMostEvery", () => {
  it("runs the first call, skips calls inside the interval, and retries a failed run on the next call", async () => {
    let now = new Date("2026-11-10T09:00:00Z");
    let runs = 0;
    let fail = false;
    const hourly = atMostEvery(SIGN_IN_PURGE_INTERVAL_MS, async () => {
      if (fail) throw new Error("database is restarting");
      return ++runs;
    });
    const ctx = { now: () => now };
    expect(SIGN_IN_PURGE_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(await hourly(ctx)).toBe(1);
    now = new Date("2026-11-10T09:59:59Z");
    expect(await hourly(ctx)).toBeNull();
    now = new Date("2026-11-10T10:00:00Z");
    fail = true;
    await expect(hourly(ctx)).rejects.toThrow("database is restarting");
    fail = false;
    now = new Date("2026-11-10T10:01:00Z"); // one minute later, not one hour: the failed run did not count
    expect(await hourly(ctx)).toBe(2);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("purgeSignInData", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("deletes sessions past their end and sign-in activity older than 90 days, and nothing else", async () => {
    const now = new Date("2026-11-10T09:00:00Z");
    const day = 86_400_000;
    const [owner] = await t.db.insert(user).values({ username: "owner", passwordHash: "hash" }).returning({ id: user.id });
    const base = { userId: owner!.id, totpVerified: true, ttlMs: 30 * day, idleMs: 14 * day, ip: null, userAgent: null };
    const live = await createSession(t.db, { ...base, now: new Date(now.getTime() - 13 * day) }); // idle for 13 of 14 days
    await createSession(t.db, { ...base, now: new Date(now.getTime() - 15 * day) }); // idle too long
    await createSession(t.db, { ...base, now: new Date(now.getTime() - 31 * day) }); // past 30 days
    await createSession(t.db, { ...base, totpVerified: false, ttlMs: 600_000, idleMs: 600_000, now: new Date(now.getTime() - 601_000) }); // an abandoned password-only session
    await t.db.insert(signInEvent).values([
      { at: sql`now() - interval '89 days'`, userId: owner!.id, username: "owner", kind: "code_failed" },
      { at: sql`now() - interval '91 days'`, userId: owner!.id, username: "owner", kind: "code_failed" },
      { at: sql`now() - interval '400 days'`, userId: owner!.id, username: "owner", kind: "signed_in" },
    ]);

    expect(await purgeSignInData({ db: t.db, now: () => now })).toEqual({ sessions: 3, events: 2 });
    expect((await t.db.select({ id: session.id }).from(session)).map((r) => r.id)).toEqual([live.id]);
    expect(await t.db.select({ kind: signInEvent.kind }).from(signInEvent)).toEqual([{ kind: "code_failed" }]);
    expect(await purgeSignInData({ db: t.db, now: () => now })).toEqual({ sessions: 0, events: 0 });
  });
});

/**
 * The scheduler ticks every minute and the sync interval is 6 hours. A connection whose sync
 * fails must not be asked again on the next tick: the Bridge counts requests, and every
 * attempt adds a job row and an import log row.
 */
describe.skipIf(!TEST_DATABASE_URL)("scheduleDueSyncs after a sync has failed", () => {
  let t: TestDb;
  let db: Db;
  let ctx: JobContext;
  let connectionId: string;
  const secretsKey = generateSecretsKey();
  let now = new Date("2026-10-13T06:00:00Z");
  let bridgeStatus = 200;
  let requests = 0;
  const config: WorkerConfig = { databaseUrl: "unused", secretsKey, workerId: "test-worker", syncIntervalHours: 6, pollIntervalMs: 10, initialWindowDays: 93, overlapDays: 7, requestTimeoutMs: 5000 };
  const HOUR = 3600_000;
  const MINUTE = 60_000;

  const conn = async () => (await db.select().from(connection).where(eq(connection.id, connectionId)))[0]!;
  const syncJobs = async () => (await db.select().from(job).orderBy(asc(job.createdAt))).filter((j) => j.type === "simplefin.sync");
  /** A scheduler tick followed by a pass of the runner, `times` times, `minutes` apart. A retry the queue is holding back is made due at once: the worst case for the Bridge. */
  const tick = async (times: number, minutes = 1) => {
    for (let i = 0; i < times; i++) {
      now = new Date(now.getTime() + minutes * MINUTE);
      await scheduleDueSyncs(ctx);
      await db.update(job).set({ runAt: new Date(0) }).where(eq(job.status, "queued"));
      await drainQueue(ctx);
    }
  };
  /** A connection that last synced (and was last tried) 7 hours ago, so a sync is due; the queue and the request count start empty. */
  const dueConnection = async () => {
    await db.delete(job);
    const seven = new Date(now.getTime() - 7 * HOUR);
    await db
      .update(connection)
      .set({ status: "ok", lastSyncAt: seven, lastAttemptAt: seven, syncPaused: false, lastError: null, lastErrors: [{ code: "act.missingdata", message: "The Bridge returned incomplete data for this account.", accountId: "CHK" }] })
      .where(eq(connection.id, connectionId));
    requests = 0;
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    const [row] = await db.insert(connection).values({ type: "simplefin", name: "Bank", status: "ok", accessUrlEnc: await encryptSecret("https://alice:s3cret@bridge.example.test/simplefin", secretsKey) }).returning({ id: connection.id });
    connectionId = row!.id;
    ctx = {
      db,
      config,
      client: {
        fetch: (async () => {
          requests++;
          return bridgeStatus === 200 ? new Response(JSON.stringify({ errors: [], errlist: [], accounts: [] }), { status: 200 }) : new Response("", { status: bridgeStatus });
        }) as typeof fetch,
      },
      now: () => now,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("asks a Bridge that refuses the access URL (403) once, then leaves it alone until a sync started by hand succeeds", async () => {
    await dueConnection();
    bridgeStatus = 403;
    // An hour of ticks: one request, one failed job. Before the fix this was 60 of each.
    await tick(60);
    expect(requests).toBe(1);
    expect((await syncJobs()).map((j) => [j.status, j.attempts])).toEqual([["failed", 1]]);
    expect(await conn()).toMatchObject({ status: "auth_required", syncPaused: true, lastErrors: [] });
    // A whole day later it has still not been asked again.
    await tick(48, 30);
    expect(requests).toBe(1);

    // The household starts a sync from the Connections page; it fails the same way and nothing resumes.
    await enqueueJob(db, "simplefin.sync", { connectionId, manual: true }, { dedupe: true });
    await tick(60);
    expect(requests).toBe(2);
    expect((await conn()).syncPaused).toBe(true);

    // Access is restored and a sync by hand works: the schedule picks the connection up again, one interval later.
    bridgeStatus = 200;
    await enqueueJob(db, "simplefin.sync", { connectionId, manual: true }, { dedupe: true });
    await drainQueue(ctx);
    expect(requests).toBe(3);
    expect(await conn()).toMatchObject({ status: "ok", syncPaused: false, lastError: null, lastAttemptAt: now, lastSyncAt: now });
    now = new Date(now.getTime() + 6 * HOUR - MINUTE);
    expect(await scheduleDueSyncs(ctx)).toBe(0);
    now = new Date(now.getTime() + 2 * MINUTE);
    expect(await scheduleDueSyncs(ctx)).toBe(1);
  });

  it("does the same when the Bridge asks for payment (402)", async () => {
    await dueConnection();
    bridgeStatus = 402;
    await tick(60);
    expect(requests).toBe(1);
    expect(await conn()).toMatchObject({ status: "error", syncPaused: true });
    expect((await conn()).lastError).toMatch(/payment required/);
    await tick(48, 30);
    expect(requests).toBe(1);
  });

  it("retries a Bridge that is down three times, then once per interval until it answers", async () => {
    await dueConnection();
    bridgeStatus = 503;
    // The first round keeps its quick retries: three attempts, then nothing for the rest of the hour.
    await tick(60);
    expect(requests).toBe(3);
    expect((await syncJobs()).map((j) => [j.status, j.attempts, j.maxAttempts])).toEqual([["failed", 3, 3]]);
    const afterFirstRound = await conn();
    expect(afterFirstRound).toMatchObject({ status: "error", syncPaused: false, lastErrors: [] });

    // Nothing more until 6 hours after the last attempt; then one attempt per interval, with no quick retries.
    now = new Date(afterFirstRound.lastAttemptAt!.getTime() + 6 * HOUR - MINUTE);
    await tick(1, 0);
    expect(requests).toBe(3);
    await tick(60);
    expect(requests).toBe(4);
    expect((await syncJobs()).map((j) => [j.status, j.attempts, j.maxAttempts])).toEqual([
      ["failed", 3, 3],
      ["failed", 1, 1],
    ]);
    now = new Date((await conn()).lastAttemptAt!.getTime() + 6 * HOUR);
    await tick(60);
    expect(requests).toBe(5);

    // The Bridge is back: the next scheduled attempt succeeds, and a later failure gets its three attempts again.
    bridgeStatus = 200;
    now = new Date((await conn()).lastAttemptAt!.getTime() + 6 * HOUR);
    await tick(60);
    expect(requests).toBe(6);
    expect(await conn()).toMatchObject({ status: "ok", lastError: null });
    bridgeStatus = 503;
    now = new Date((await conn()).lastAttemptAt!.getTime() + 6 * HOUR);
    await tick(60);
    expect(requests).toBe(9);
  });

  it("leaves a disabled connection and one still waiting for its access URL alone", async () => {
    await dueConnection();
    bridgeStatus = 200;
    await db.update(connection).set({ status: "disabled" }).where(eq(connection.id, connectionId));
    await tick(5);
    expect(requests).toBe(0);
    await db.update(connection).set({ status: "error", accessUrlEnc: null }).where(eq(connection.id, connectionId));
    await tick(5);
    expect(requests).toBe(0);
  });
});
