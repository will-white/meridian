import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, claimNextJob, completeJob, enqueueJob, holdingSnapshot, importLog, job, price, security, type Db, type JobRow } from "@meridian/db";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "@meridian/db/testing";
import { generateSecretsKey, type IsoDate } from "@meridian/shared";
import type { PriceConfig, WorkerConfig } from "../env.js";
import { drainQueue } from "../runner.js";
import type { JobContext } from "./context.js";
import { BACKOFF_BASE_MS, CONTINUATION_DELAY_MS, runPricesFetchJob } from "./pricesFetch.js";

/**
 * `prices.fetch` with a fake provider behind the injected fetch (prices design §3.11; tests
 * 21 and 22). Sixty held provider securities S001..S060 (one snapshot each on 2026-10-09),
 * `now` = 2026-10-14T18:00Z (14:00 in New York, before the 18:30 close) so the expected
 * close is 2026-10-13 and a never-fetched security is requested from 2026-10-02 (the first
 * needed date less a week). The provider has closes for the eight trading days 10-02..10-13.
 */

const NOW0 = new Date("2026-10-14T18:00:00Z");
/**
 * When the securities were created. The plan re-tries a `not_found` symbol when the security was
 * edited after its last fetch (`updated_at > price_fetched_at`), so the fixture's rows must predate
 * the fake clock: inserted at the real wall clock they would look edited after every fake-dated run.
 */
const SEEDED_AT = new Date("2026-10-01T00:00:00Z");
const SNAPSHOT_DATE: IsoDate = "2026-10-09";
const TRADING: IsoDate[] = ["2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13"];
const HEADER = "date,close,high,low,open,volume,adjClose,adjHigh,adjLow,adjOpen,divCash,splitFactor";
const N = 60;
const SYMBOLS = Array.from({ length: N }, (_, i) => `S${String(i + 1).padStart(3, "0")}`);

type Range = { from: IsoDate; to: IsoDate };
type Responder = (symbol: string, range: Range) => Response | Promise<Response>;

/** The close of symbol #i on trading day #k: 100 + i + k / 2, as decimal text. */
function closeOf(symbol: string, k: number): string {
  return (100 + Number(symbol.slice(1)) + k * 0.5).toFixed(1);
}

function csvFor(symbol: string, range: Range, close: (symbol: string, k: number) => string = closeOf): string {
  const lines = [HEADER];
  TRADING.forEach((d, k) => {
    if (d >= range.from && d <= range.to) {
      const c = close(symbol, k);
      lines.push(`${d},${c},${c},${c},${c},1000,${c},${c},${c},${c},0.0,1.0`);
    }
  });
  return `${lines.join("\n")}\n`;
}

const ok: Responder = (symbol, range) => new Response(csvFor(symbol, range), { status: 200 });

describe.skipIf(!TEST_DATABASE_URL)("prices.fetch", () => {
  let t: TestDb;
  let db: Db;
  let ctx: JobContext;
  let now = NOW0;
  let responder: Responder = ok;
  const requests: Array<{ symbol: string } & Range> = [];
  const sleeps: number[] = [];
  const ids = new Map<string, string>();

  const config: WorkerConfig = {
    databaseUrl: "unused",
    secretsKey: generateSecretsKey(),
    workerId: "test-worker",
    syncIntervalHours: 6,
    pollIntervalMs: 10,
    initialWindowDays: 93,
    overlapDays: 7,
    requestTimeoutMs: 5000,
    prices: { provider: "tiingo", tiingoApiKey: "test-key", maxRequestsPerRun: 45, requestSpacingMs: 1500 },
  };
  const withPrices = (p: Partial<PriceConfig>): JobContext => ({ ...ctx, config: { ...config, prices: { ...config.prices, ...p } } });

  const fetchImpl = (async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(input));
    const symbol = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const range = { from: url.searchParams.get("startDate")!, to: url.searchParams.get("endDate")! };
    requests.push({ symbol, ...range });
    return responder(symbol, range);
  }) as typeof fetch;

  const idOf = (symbol: string) => ids.get(symbol)!;
  const securityRow = async (symbol: string) => (await db.select().from(security).where(eq(security.id, idOf(symbol))))[0]!;
  const priceRows = () => db.select().from(price).orderBy(asc(price.securityId), asc(price.date));
  const jobsOf = async (type: JobRow["type"]) => (await db.select().from(job).orderBy(asc(job.createdAt))).filter((j) => j.type === type);
  const continuations = async () => (await jobsOf("prices.fetch")).filter((j) => j.payload["reason"] === "continue");
  const logOf = async (id: string) => (await db.select().from(importLog).where(eq(importLog.id, id)))[0]!;
  /** Insert a real job row and run the handler on it directly (the queue is exercised where the runner's decisions matter). */
  const runFetch = async (c: JobContext, payload: Record<string, unknown>) => {
    const row = await enqueueJob(db, "prices.fetch", payload);
    const outcome = await runPricesFetchJob(c, row);
    return { row, outcome };
  };
  const resetFeed = async () => {
    await db.delete(price);
    await db.delete(job);
    await db.delete(importLog);
    await db.update(security).set({ priceFetchedAt: null, priceFetchStatus: null, priceFetchMessage: null, priceFetchFailures: 0, priceNextAttemptAt: null, priceBackfilledFrom: null });
    requests.length = 0;
    sleeps.length = 0;
    now = NOW0;
    responder = ok;
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    const [acct] = await db.insert(account).values({ name: "Test Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false }).returning({ id: account.id });
    const rows = await db
      .insert(security)
      .values(SYMBOLS.map((ticker, i) => ({ ticker, name: `Security ${i + 1}`, type: "etf" as const, assetClass: "us_stock" as const, priceMode: "provider" as const, needsReview: false, createdAt: SEEDED_AT, updatedAt: SEEDED_AT })))
      .returning({ id: security.id, ticker: security.ticker });
    for (const r of rows) ids.set(r.ticker!, r.id);
    await db.insert(holdingSnapshot).values(rows.map((r) => ({ accountId: acct!.id, securityId: r.id, date: SNAPSHOT_DATE, quantity: "10", price: "100", valueCents: 100000n, source: "csv" as const })));
    ctx = {
      db,
      config,
      client: { fetch: fetchImpl },
      now: () => now,
      sleep: async (ms) => void sleeps.push(ms),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("60 targets with a 45-request budget: the rest goes to one continuation 61 minutes later, which finishes the set (test 21)", async () => {
    await resetFeed();
    const { row, outcome } = await runFetch(ctx, { reason: "manual", dedupeKey: "prices:manual" });
    expect(requests.map((r) => r.symbol)).toEqual(SYMBOLS.slice(0, 45));
    expect(requests.every((r) => r.from === "2026-10-02" && r.to === "2026-10-13")).toBe(true);
    expect(outcome.stats).toEqual({ securities: 45, requests: 45, rowsInserted: 360, rowsUpdated: 0, rowsKept: 0, notFound: 0, errors: 0, rateLimited: 0, deferred: 15, suspect: 0 });
    expect(outcome.message).toBe("tiingo: 45 requests, 360 rows; 15 deferred");
    expect(sleeps).toEqual(Array(44).fill(1500));
    const log = await logOf(outcome.importLogId);
    expect(log).toMatchObject({ kind: "prices.fetch", status: "ok", connectionId: null, message: outcome.message });
    expect(log.stats).toEqual(outcome.stats);
    expect(log.startedAt).toEqual(NOW0);

    const s001 = await securityRow("S001");
    expect(s001).toMatchObject({ priceFetchedAt: NOW0, priceFetchStatus: "ok", priceFetchMessage: null, priceFetchFailures: 0, priceNextAttemptAt: null, priceBackfilledFrom: "2026-10-02" });
    expect((await securityRow("S046")).priceFetchedAt).toBeNull();
    const rows = await priceRows();
    expect(rows).toHaveLength(360);
    expect(rows.every((r) => r.source === "provider" && r.provider === "tiingo" && r.adjClose !== null && r.fetchedAt?.getTime() === NOW0.getTime() && !r.suspect)).toBe(true);
    const s001Close = rows.find((r) => r.securityId === idOf("S001") && r.date === "2026-10-13")!;
    expect(s001Close.close).toBe("104.50000000");

    // The continuation: the 15 deferred ids, keyed by the root job, an hour and a minute out.
    const conts = await continuations();
    expect(conts).toHaveLength(1);
    const cont = conts[0]!;
    expect(cont.id).toBe(outcome.continuationJobId);
    expect(cont.payload).toEqual({
      reason: "continue",
      continuation: 1,
      rootJobId: row.id,
      securityIds: SYMBOLS.slice(45).map(idOf),
      dedupeKey: `prices:continue:${row.id}`,
    });
    expect(cont.runAt.getTime()).toBe(NOW0.getTime() + CONTINUATION_DELAY_MS);
    expect(cont.maxAttempts).toBe(5);
    // Every completed run chains the valuation job (plan decision 18).
    const valuations = await jobsOf("investments.valuation");
    expect(valuations).toHaveLength(1);
    expect(valuations[0]!.payload).toEqual({ reason: "prices", dedupeKey: "investments.valuation" });
    expect(outcome.valuationJobId).toBe(valuations[0]!.id);

    // The continuation processes the 15, defers nothing and queues nothing further.
    requests.length = 0;
    now = new Date(cont.runAt);
    const second = await runPricesFetchJob(ctx, cont);
    expect(requests.map((r) => r.symbol)).toEqual(SYMBOLS.slice(45));
    expect(second.stats).toMatchObject({ securities: 15, requests: 15, rowsInserted: 120, deferred: 0 });
    expect(second.continuationJobId).toBeNull();
    expect(await continuations()).toHaveLength(1);
    expect(await priceRows()).toHaveLength(480);

    // A retry of the root job (the continuation still queued) never creates a second continuation.
    requests.length = 0;
    const retried = await runPricesFetchJob(ctx, row);
    expect(retried.stats.deferred).toBe(15);
    expect(retried.continuationJobId).toBe(cont.id);
    expect(await continuations()).toHaveLength(1);
  });

  it("429 with Retry-After 30, then 503, then 200: three requests, sleeps [30 s, 15 s], success", async () => {
    await resetFeed();
    const answers = [new Response("", { status: 429, headers: { "Retry-After": "30" } }), new Response("", { status: 503 })];
    responder = (symbol, range) => answers.shift() ?? ok(symbol, range);
    const { outcome } = await runFetch(ctx, { reason: "refill", securityIds: [idOf("S001")], dedupeKey: `prices:refill:${idOf("S001")}` });
    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([30_000, 15_000]);
    expect(outcome.stats).toMatchObject({ securities: 1, requests: 3, rowsInserted: 8, errors: 0, rateLimited: 0, deferred: 0 });
    expect(await securityRow("S001")).toMatchObject({ priceFetchStatus: "ok", priceFetchFailures: 0 });
    expect(await continuations()).toHaveLength(0);
  });

  it("a persistent 429 on request 10 stops the run: 9 written, 51 deferred, rateLimited 1", async () => {
    await resetFeed();
    responder = (symbol, range) => (symbol === "S010" ? new Response("", { status: 429 }) : ok(symbol, range));
    const { outcome } = await runFetch(ctx, { reason: "nightly", day: "2026-10-14", dedupeKey: "prices:nightly:2026-10-14" });
    expect(outcome.stats).toMatchObject({ securities: 10, requests: 12, rowsInserted: 72, rateLimited: 1, deferred: 51, errors: 0 });
    expect(sleeps.filter((ms) => ms === 5_000)).toHaveLength(2);
    expect(await priceRows()).toHaveLength(72);
    expect(await securityRow("S010")).toMatchObject({ priceFetchStatus: "rate_limited", priceFetchMessage: "tiingo: rate limited (429)", priceFetchFailures: 0, priceNextAttemptAt: null });
    // The plan's own deferred entries come first, then what this run did not reach.
    const [cont] = await continuations();
    expect(cont!.payload["securityIds"]).toEqual([...SYMBOLS.slice(45), ...SYMBOLS.slice(9, 45)].map(idOf));
  });

  it("401 on request 3: two written, the log says the key was rejected, the job fails permanently, no continuation", async () => {
    await resetFeed();
    responder = (symbol, range) => (symbol === "S003" ? new Response("", { status: 401 }) : ok(symbol, range));
    await enqueueJob(db, "prices.fetch", { reason: "manual", dedupeKey: "prices:manual" });
    expect(await drainQueue(ctx)).toBe(1);
    const [failed] = await jobsOf("prices.fetch");
    expect(failed).toMatchObject({ status: "failed", attempts: 1, lastError: "tiingo: API key rejected (401)" });
    expect(await priceRows()).toHaveLength(16);
    const [log] = await db.select().from(importLog).orderBy(sql`${importLog.startedAt} desc`).limit(1);
    expect(log).toMatchObject({ status: "error", message: "tiingo: API key rejected (401)" });
    expect(log!.stats).toMatchObject({ securities: 3, requests: 3, rowsInserted: 16 });
    expect(await continuations()).toHaveLength(0);
    expect(await jobsOf("investments.valuation")).toHaveLength(0);
    // The rejected symbol keeps no fetch state of its own: the key, not the symbol, was refused.
    expect((await securityRow("S003")).priceFetchStatus).toBeNull();
  });

  it("404 for one symbol: not_found for it, the rest ok, retried after 7 days (not after 2)", async () => {
    await resetFeed();
    const c = withPrices({ maxRequestsPerRun: 100 });
    let missing = true;
    responder = (symbol, range) => (missing && symbol === "S007" ? new Response("", { status: 404 }) : ok(symbol, range));
    const first = await runFetch(c, { reason: "manual", dedupeKey: "prices:manual" });
    expect(first.outcome.stats).toMatchObject({ securities: 60, requests: 60, notFound: 1, errors: 0, rowsInserted: 472, deferred: 0 });
    expect((await logOf(first.outcome.importLogId)).status).toBe("ok");
    expect(await securityRow("S007")).toMatchObject({ priceFetchStatus: "not_found", priceFetchMessage: "tiingo: symbol S007 not found", priceFetchedAt: NOW0, priceFetchFailures: 0 });

    requests.length = 0;
    now = new Date(NOW0.getTime() + 2 * 86_400_000);
    await runFetch(c, { reason: "manual", dedupeKey: "prices:manual" });
    expect(requests).toHaveLength(59);
    expect(requests.some((r) => r.symbol === "S007")).toBe(false);

    // Editing the security (its ticker or feed symbol, say) brings the retry forward; still missing, it is recorded not_found again.
    requests.length = 0;
    await db.update(security).set({ updatedAt: now }).where(eq(security.id, idOf("S007")));
    await runFetch(c, { reason: "manual", dedupeKey: "prices:manual" });
    expect(requests.filter((r) => r.symbol === "S007")).toHaveLength(1);
    expect(await securityRow("S007")).toMatchObject({ priceFetchStatus: "not_found", priceFetchedAt: now });
    await db.update(security).set({ updatedAt: SEEDED_AT }).where(eq(security.id, idOf("S007")));

    // Seven days after that record it is tried again on its own.
    requests.length = 0;
    now = new Date(now.getTime() + 7 * 86_400_000);
    missing = false;
    await runFetch(c, { reason: "manual", dedupeKey: "prices:manual" });
    expect(requests).toHaveLength(60);
    expect(await securityRow("S007")).toMatchObject({ priceFetchStatus: "ok", priceFetchMessage: null });
  });

  it("every request dying on the network: the job throws, the queue requeues it, the log says error, nothing is continued, and the retry fetches", async () => {
    await resetFeed();
    responder = () => {
      throw new TypeError("fetch failed: ECONNRESET");
    };
    await enqueueJob(db, "prices.fetch", { reason: "manual", dedupeKey: "prices:manual" });
    expect(await drainQueue(ctx)).toBe(1);
    const [requeued] = await jobsOf("prices.fetch");
    expect(requeued).toMatchObject({ status: "queued", attempts: 1 });
    expect(requeued!.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(requeued!.lastError).toMatch(/every request failed on the network \(45 securities, 135 requests\)/);
    const [log] = await db.select().from(importLog).orderBy(sql`${importLog.startedAt} desc`).limit(1);
    expect(log!.status).toBe("error");
    expect(log!.stats).toMatchObject({ securities: 45, requests: 135, errors: 45 });
    expect(await continuations()).toHaveLength(0);
    expect(await jobsOf("investments.valuation")).toHaveLength(0);
    // The outage is the run's, not any security's: no per-security error or backoff is recorded, so the
    // queue's retry finds the same plan (with a backoff, the retry would find nothing to fetch and finish "done").
    expect(await securityRow("S001")).toMatchObject({ priceFetchStatus: null, priceFetchMessage: null, priceFetchFailures: 0, priceNextAttemptAt: null, priceFetchedAt: null });
    expect(await securityRow("S045")).toMatchObject({ priceFetchStatus: null, priceFetchFailures: 0, priceNextAttemptAt: null });

    // The network is back two minutes later and the queue's retry claims the job (attempt 2): it fetches the 45
    // as the first run would have. (Claimed and completed by hand rather than drained: the fake clock dates the
    // continuation and the chained valuation before the database's `now()`, so a drain would run those too.)
    responder = ok;
    requests.length = 0;
    now = new Date(NOW0.getTime() + 2 * 60_000);
    await db.update(job).set({ runAt: new Date(0) }).where(eq(job.id, requeued!.id));
    const claimed = await claimNextJob(db, config.workerId);
    expect(claimed).toMatchObject({ id: requeued!.id, attempts: 2 });
    const retried = await runPricesFetchJob(ctx, claimed!);
    await completeJob(db, claimed!.id);
    expect(retried.stats).toMatchObject({ securities: 45, requests: 45, rowsInserted: 360, errors: 0, deferred: 15 });
    expect(requests.map((r) => r.symbol)).toEqual(SYMBOLS.slice(0, 45));
    expect(await priceRows()).toHaveLength(360);
    expect(await securityRow("S001")).toMatchObject({ priceFetchStatus: "ok", priceFetchMessage: null, priceFetchFailures: 0, priceNextAttemptAt: null, priceFetchedAt: now });
    expect((await logOf(retried.importLogId)).status).toBe("ok");
    expect((await db.select().from(job).where(eq(job.id, requeued!.id)))[0]).toMatchObject({ status: "done", attempts: 2 });
    expect(await continuations()).toHaveLength(1);
    expect(await jobsOf("investments.valuation")).toHaveLength(1);
  });

  it("a network failure in a run where another request got through is that security's own: backoff applies", async () => {
    await resetFeed();
    responder = (symbol, range) => {
      if (symbol === "S002") throw new TypeError("fetch failed: ECONNRESET");
      return ok(symbol, range);
    };
    const { outcome } = await runFetch(ctx, { reason: "refill", securityIds: [idOf("S001"), idOf("S002")], dedupeKey: "prices:refill:n" });
    expect(outcome.stats).toMatchObject({ securities: 2, requests: 4, errors: 1, rowsInserted: 8 });
    expect((await logOf(outcome.importLogId)).status).toBe("ok");
    expect(await securityRow("S001")).toMatchObject({ priceFetchStatus: "ok", priceFetchFailures: 0 });
    expect(await securityRow("S002")).toMatchObject({ priceFetchStatus: "error", priceFetchFailures: 1, priceNextAttemptAt: new Date(NOW0.getTime() + BACKOFF_BASE_MS) });
    expect((await securityRow("S002")).priceFetchMessage).toMatch(/ECONNRESET/);
  });

  it("one symbol timing out three times backs off 6 h, then 12 h, and a success resets it", async () => {
    await resetFeed();
    const c = withPrices({ maxRequestsPerRun: 100 });
    let broken = true;
    responder = (symbol, range) => {
      if (broken && symbol === "S003") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return ok(symbol, range);
    };
    const first = await runFetch(c, { reason: "manual", dedupeKey: "prices:manual" });
    expect(first.outcome.stats).toMatchObject({ securities: 60, requests: 62, errors: 1, rowsInserted: 472 });
    expect((await logOf(first.outcome.importLogId)).status).toBe("ok");
    expect(await securityRow("S003")).toMatchObject({ priceFetchStatus: "error", priceFetchFailures: 1, priceNextAttemptAt: new Date(NOW0.getTime() + 6 * 3600_000) });
    expect((await securityRow("S003")).priceFetchMessage).toMatch(/timeout/i);

    // Inside the backoff the symbol is skipped.
    requests.length = 0;
    now = new Date(NOW0.getTime() + 5 * 3600_000);
    await runFetch(c, { reason: "manual", dedupeKey: "prices:manual" });
    expect(requests.some((r) => r.symbol === "S003")).toBe(false);

    // After 6 h it is tried again; a second failure doubles the backoff.
    requests.length = 0;
    const second = new Date(NOW0.getTime() + 6 * 3600_000);
    now = second;
    await runFetch(c, { reason: "manual", dedupeKey: "prices:manual" });
    expect(requests.filter((r) => r.symbol === "S003")).toHaveLength(3);
    expect(await securityRow("S003")).toMatchObject({ priceFetchFailures: 2, priceNextAttemptAt: new Date(second.getTime() + 12 * 3600_000) });

    // The next success resets both.
    broken = false;
    now = new Date(second.getTime() + 12 * 3600_000);
    await runFetch(c, { reason: "manual", dedupeKey: "prices:manual" });
    expect(await securityRow("S003")).toMatchObject({ priceFetchStatus: "ok", priceFetchFailures: 0, priceNextAttemptAt: null, priceFetchMessage: null });
  });

  it("a 10-second run cap with a 3-second provider and 10 targets fetches 4 and defers the rest", async () => {
    await resetFeed();
    const c = withPrices({ runMaxMs: 10_000 });
    responder = (symbol, range) => {
      now = new Date(now.getTime() + 3_000);
      return ok(symbol, range);
    };
    const ten = SYMBOLS.slice(0, 10).map(idOf);
    const { outcome } = await runFetch(c, { reason: "refill", securityIds: ten, dedupeKey: "prices:refill:x" });
    expect(outcome.stats).toMatchObject({ securities: 4, requests: 4, deferred: 6 });
    expect((await logOf(outcome.importLogId)).status).toBe("ok");
    const [cont] = await continuations();
    expect(cont!.payload["securityIds"]).toEqual(ten.slice(4));
  });

  it("two runs against the same bars are idempotent: the second inserts and updates nothing and moves no timestamp (test 22)", async () => {
    await resetFeed();
    const c = withPrices({ maxRequestsPerRun: 100 });
    const first = await runFetch(c, { reason: "nightly", day: "2026-10-14", dedupeKey: "prices:nightly:2026-10-14" });
    expect(first.outcome.stats).toMatchObject({ rowsInserted: 480, rowsUpdated: 0, rowsKept: 0 });
    const before = await priceRows();

    requests.length = 0;
    now = new Date(NOW0.getTime() + 3600_000);
    const second = await runFetch(c, { reason: "catchup", day: "2026-10-14", dedupeKey: "prices:catchup:2026-10-14" });
    // The overlap: from the latest provider close (10-13) less three days, so two bars per symbol are re-requested.
    expect(requests.every((r) => r.from === "2026-10-10" && r.to === "2026-10-13")).toBe(true);
    expect(second.outcome.stats).toMatchObject({ securities: 60, requests: 60, rowsInserted: 0, rowsUpdated: 0, rowsKept: 120 });
    const after = await priceRows();
    expect(after.map((r) => [r.id, r.close, r.fetchedAt?.getTime(), r.updatedAt.getTime()])).toEqual(before.map((r) => [r.id, r.close, r.fetchedAt?.getTime(), r.updatedAt.getTime()]));
    expect((await securityRow("S001")).priceBackfilledFrom).toBe("2026-10-02");
  });

  it("PRICE_PROVIDER=none: the log says the feed is not configured, the job is done, nothing is written or queued", async () => {
    await resetFeed();
    await enqueueJob(db, "prices.fetch", { reason: "manual", dedupeKey: "prices:manual" });
    expect(await drainQueue(withPrices({ provider: null }))).toBe(1);
    const jobs = await db.select().from(job);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: "prices.fetch", status: "done" });
    const [log] = await db.select().from(importLog).orderBy(sql`${importLog.startedAt} desc`).limit(1);
    expect(log).toMatchObject({ kind: "prices.fetch", status: "error", message: "Price feed not configured" });
    expect(requests).toHaveLength(0);
    expect(await priceRows()).toHaveLength(0);
  });

  it("a close that halves overnight is stored and marked suspect", async () => {
    await resetFeed();
    responder = (symbol, range) => new Response(csvFor(symbol, range, (s, k) => (s === "S001" && k === TRADING.length - 1 ? "40.0" : closeOf(s, k))), { status: 200 });
    const { outcome } = await runFetch(ctx, { reason: "refill", securityIds: [idOf("S001"), idOf("S002")], dedupeKey: "prices:refill:y" });
    expect(outcome.stats).toMatchObject({ rowsInserted: 16, suspect: 1 });
    const rows = await priceRows();
    const flagged = rows.filter((r) => r.suspect);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ securityId: idOf("S001"), date: "2026-10-13", close: "40.00000000" });
  });

  it("an unreadable body is a per-security error with backoff, and the body is kept on the log", async () => {
    await resetFeed();
    responder = (symbol, range) => (symbol === "S002" ? new Response("<html><body>Please sign in</body></html>", { status: 200 }) : ok(symbol, range));
    const { outcome } = await runFetch(ctx, { reason: "refill", securityIds: [idOf("S001"), idOf("S002")], dedupeKey: "prices:refill:z" });
    expect(outcome.stats).toMatchObject({ securities: 2, requests: 2, errors: 1, rowsInserted: 8 });
    const s002 = await securityRow("S002");
    expect(s002).toMatchObject({ priceFetchStatus: "error", priceFetchFailures: 1, priceNextAttemptAt: new Date(NOW0.getTime() + BACKOFF_BASE_MS) });
    expect(s002.priceFetchMessage).toMatch(/^tiingo: response is not a daily price CSV/);
    const log = await logOf(outcome.importLogId);
    expect(log.status).toBe("ok");
    expect((log.rawPayload as { invalidResponses: Array<{ symbol: string; body: string }> }).invalidResponses).toEqual([{ symbol: "S002", body: "<html><body>Please sign in</body></html>" }]);
  });

  it("the plan is empty when nothing is held: zero requests, an ok log, and the valuation still chained", async () => {
    await resetFeed();
    await db.update(account).set({ closed: true });
    const { outcome } = await runFetch(ctx, { reason: "manual", dedupeKey: "prices:manual" });
    expect(outcome.stats).toMatchObject({ securities: 0, requests: 0, deferred: 0 });
    expect(requests).toHaveLength(0);
    expect(outcome.message).toBe("tiingo: 0 requests, 0 rows; 0 deferred");
    expect(await jobsOf("investments.valuation")).toHaveLength(1);
    await db.update(account).set({ closed: false });
    expect(await db.select({ n: sql<number>`count(*)::int` }).from(holdingSnapshot).where(and(eq(holdingSnapshot.date, SNAPSHOT_DATE)))).toEqual([{ n: N }]);
  });
});
