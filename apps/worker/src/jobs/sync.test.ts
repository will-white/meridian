import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, balanceSnapshot, category, connection, enqueueJob, holdingSnapshot, householdSetting, importLog, investmentTxn, job, price, security, transaction, type Db, type JobRow } from "@meridian/db";
import { ACCOUNTS, BROKERAGE_ACCOUNT, createTestDb, FIXTURE_END, FIXTURE_START, renderAccountSet, TEST_DATABASE_URL, type TestDb } from "@meridian/db/testing";
import { addDays, encryptSecret, generateSecretsKey, isoDateToUtcMs, type IsoDate, type SimplefinAccountSet } from "@meridian/shared";
import type { WorkerConfig } from "../env.js";
import { drainQueue } from "../runner.js";
import { scheduleDueSyncs } from "../scheduler.js";
import type { JobContext } from "./context.js";
import { syncWindowStart } from "./sync.js";

const ACCESS = "https://alice:s3cret@bridge.example.test/simplefin";

describe("syncWindowStart", () => {
  const config = { initialWindowDays: 93, overlapDays: 7 };
  it("looks back 93 days on the first sync and overlaps 7 days afterwards", () => {
    expect(syncWindowStart(null, "2026-10-13", config)).toBe("2026-07-12");
    expect(syncWindowStart("2026-10-10", "2026-10-13", config)).toBe("2026-10-03");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("claim and sync jobs end to end", () => {
  let t: TestDb;
  let ctx: JobContext;
  let connectionId: string;
  const secretsKey = generateSecretsKey();
  let now = new Date(`${addDays(FIXTURE_START, 60)}T12:00:00Z`);
  const requests: URL[] = [];
  let nextResponse: (init: RequestInit) => Response = () => new Response("", { status: 500 });

  const config: WorkerConfig = {
    databaseUrl: "unused",
    secretsKey,
    workerId: "test-worker",
    syncIntervalHours: 6,
    pollIntervalMs: 10,
    initialWindowDays: 93,
    overlapDays: 7,
    requestTimeoutMs: 5000,
  };

  beforeAll(async () => {
    t = await createTestDb();
    ctx = {
      db: t.db,
      config,
      client: {
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          requests.push(new URL(String(input)));
          return nextResponse(init ?? {});
        }) as typeof fetch,
      },
      now: () => now,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("claims a setup token, stores the access URL encrypted, and runs the first sync it queued", async () => {
    const claimTokenEnc = await encryptSecret(btoa("https://bridge.example.test/simplefin/claim/tok"), secretsKey);
    const [conn] = await t.db.insert(connection).values({ type: "simplefin", name: "Bank", status: "claiming", claimTokenEnc }).returning();
    connectionId = conn!.id;
    await enqueueJob(t.db, "simplefin.claim", { connectionId });
    const firstWindow = addDays(FIXTURE_START, 60 - 93);
    nextResponse = (init) =>
      init.method === "POST"
        ? new Response(ACCESS, { status: 200 })
        : new Response(JSON.stringify(renderAccountSet({ start: firstWindow, asOf: addDays(FIXTURE_START, 60) })), { status: 200 });

    // The claim job queues the first sync, which queues the recurring run (plan §17); draining runs all three.
    expect(await drainQueue(ctx)).toBe(3);

    const [after] = await t.db.select().from(connection).where(eq(connection.id, connectionId));
    expect(after!.status).toBe("ok");
    expect(after!.claimTokenEnc).toBeNull();
    expect(after!.accessUrlEnc).not.toContain("s3cret");
    expect(after!.accessUrlEnc?.startsWith("v1.")).toBe(true);
    const jobs = await t.db.select().from(job);
    expect(jobs.map((j) => [j.type, j.status]).sort()).toEqual([
      ["recurring.detect", "done"],
      ["simplefin.claim", "done"],
      ["simplefin.sync", "done"],
    ]);
    expect(jobs.find((j) => j.type === "recurring.detect")!.payload).toEqual({ reason: "sync" });

    // First sync: 93 days back, pending included, raw payload logged, connection updated.
    expect(requests).toHaveLength(2);
    const req = requests[1]!;
    expect(req.searchParams.get("version")).toBe("2");
    expect(req.searchParams.get("pending")).toBe("1");
    expect(req.searchParams.get("start-date")).toBe(String(isoDateToUtcMs(firstWindow) / 1000));
    expect(after!.syncedThrough).toBe(addDays(FIXTURE_START, 60));
    expect(after!.lastSyncAt).toEqual(now);
    const logs = await t.db.select().from(importLog).where(eq(importLog.kind, "simplefin.sync"));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe("ok");
    expect((logs[0]!.rawPayload as { accounts: unknown[] }).accounts).toHaveLength(3);
    expect(logs[0]!.stats?.["created"]).toBeGreaterThan(50);
    expect(await t.db.select().from(account)).toHaveLength(3);
  });

  it("the scheduler queues a sync only once the interval has passed, and dedupes", async () => {
    expect(await scheduleDueSyncs(ctx)).toBe(0);
    now = new Date(now.getTime() + 7 * 3600_000);
    expect(await scheduleDueSyncs(ctx)).toBe(1);
    expect(await scheduleDueSyncs(ctx)).toBe(0);
  });

  it("second sync overlaps by 7 days, posts pending items, and adds nothing twice", async () => {
    requests.length = 0;
    now = new Date(`${FIXTURE_END}T12:00:00Z`);
    const expectedStart = addDays(addDays(FIXTURE_START, 60), -7);
    nextResponse = () => new Response(JSON.stringify(renderAccountSet({ start: expectedStart, asOf: FIXTURE_END })), { status: 200 });
    const before = (await t.db.select().from(transaction)).length;
    // The sync plus the recurring run it queues.
    expect(await drainQueue(ctx)).toBe(2);
    expect(requests[0]!.searchParams.get("start-date")).toBe(String(isoDateToUtcMs(expectedStart) / 1000));
    const logs = await t.db.select().from(importLog).where(eq(importLog.kind, "simplefin.sync"));
    const last = logs[logs.length - 1]!;
    expect(last.stats?.["replacedPending"]).toBeGreaterThan(0);
    expect(last.stats?.["removedPending"]).toBe(1);
    expect((await t.db.select().from(transaction)).length).toBe(before + (last.stats?.["created"] ?? 0) - 1);
  });

  it("surfaces errlist per connection and flags con.auth as auth_required", async () => {
    const set = renderAccountSet({ start: addDays(FIXTURE_END, -7), asOf: FIXTURE_END });
    set.errlist = [{ code: "con.auth", msg: "Please <b>re-login</b>", conn_id: "x" }];
    nextResponse = () => new Response(JSON.stringify(set), { status: 200 });
    await enqueueJob(t.db, "simplefin.sync", { connectionId });
    await drainQueue(ctx);
    const [conn] = await t.db.select().from(connection).where(eq(connection.id, connectionId));
    expect(conn!.status).toBe("auth_required");
    expect(conn!.lastErrors).toEqual([{ code: "con.auth", message: "The bank connection needs to be re-authenticated at the SimpleFIN Bridge. (Please re-login)" }]);
  });

  it("a 403 on sync marks the connection auth_required and does not retry", async () => {
    nextResponse = () => new Response("", { status: 403 });
    await enqueueJob(t.db, "simplefin.sync", { connectionId });
    await drainQueue(ctx);
    const [conn] = await t.db.select().from(connection).where(eq(connection.id, connectionId));
    expect(conn!.status).toBe("auth_required");
    expect(conn!.lastError).toMatch(/403/);
    const failed = await t.db.select().from(job).where(eq(job.status, "failed"));
    expect(failed).toHaveLength(1);
  });

  it("a 5xx is retried with backoff and the connection shows the error", async () => {
    nextResponse = () => new Response("", { status: 503 });
    await enqueueJob(t.db, "simplefin.sync", { connectionId });
    await drainQueue(ctx);
    const [conn] = await t.db.select().from(connection).where(eq(connection.id, connectionId));
    expect(conn!.status).toBe("error");
    const queued = await t.db.select().from(job).where(eq(job.status, "queued"));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.attempts).toBe(1);
    expect(queued[0]!.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("a refused claim token (403) is dropped and the user is told it may be compromised", async () => {
    const claimTokenEnc = await encryptSecret(btoa("https://bridge.example.test/simplefin/claim/tok2"), secretsKey);
    const [conn] = await t.db.insert(connection).values({ type: "simplefin", name: "Other", status: "claiming", claimTokenEnc }).returning();
    await enqueueJob(t.db, "simplefin.claim", { connectionId: conn!.id });
    nextResponse = () => new Response("", { status: 403 });
    await drainQueue(ctx);
    const [after] = await t.db.select().from(connection).where(eq(connection.id, conn!.id));
    expect(after!.status).toBe("error");
    expect(after!.claimTokenEnc).toBeNull();
    expect(after!.lastError).toMatch(/compromised/);
  });
});

/**
 * Phase 3 (imports design §3.3, test 6; plan decision 18): the fixture's fourth account is a
 * brokerage whose Bridge lists positions under `extra.holdings`. The sync writes them as the
 * day's `simplefin` snapshot, reports a container it cannot read per account, never changes
 * the three bank accounts' truth, queues the holdings price fetch once, links investment rows
 * to the bank rows it delivered and queues the income feed.
 */
describe.skipIf(!TEST_DATABASE_URL)("sync with holdings in extra", () => {
  let t: TestDb;
  let db: Db;
  let ctx: JobContext;
  let connectionId: string;
  const secretsKey = generateSecretsKey();
  const ASOF: IsoDate = "2026-10-13";
  const START = addDays(ASOF, -93);
  let now = new Date(`${ASOF}T12:00:00Z`);
  let accountSet: SimplefinAccountSet;
  const unix = (date: IsoDate, hour = 12) => Math.floor(isoDateToUtcMs(date) / 1000) + hour * 3600;
  const OTHER: SimplefinAccountSet["accounts"][number] = {
    org: { domain: "brokerage.example.test", name: "Example Brokerage Services" },
    id: "ACT-OTH-001",
    name: "Other IRA",
    currency: "USD",
    balance: "10.00",
    "balance-date": unix(ASOF, 6),
    transactions: [],
    extra: { positions: [{ foo: 1, bar: "x" }] },
  };
  const config: WorkerConfig = {
    databaseUrl: "unused",
    secretsKey,
    workerId: "test-worker",
    syncIntervalHours: 6,
    pollIntervalMs: 10,
    initialWindowDays: 93,
    overlapDays: 7,
    requestTimeoutMs: 5000,
    prices: { provider: "tiingo", tiingoApiKey: "k" },
  };
  const accountByExternalId = async (externalId: string) => (await db.select().from(account).where(eq(account.externalId, externalId)))[0]!;
  const jobsOf = async (type: JobRow["type"]) => (await db.select().from(job).orderBy(asc(job.createdAt))).filter((j) => j.type === type);
  const lastSyncLog = async () => (await db.select().from(importLog).where(inArray(importLog.kind, ["simplefin.sync", "simplefin.balances"])).orderBy(desc(importLog.startedAt), desc(importLog.id)))[0]!;
  const snapshotsOf = async (accountId: string, date: IsoDate) =>
    db
      .select({ row: holdingSnapshot, ticker: security.ticker, type: security.type })
      .from(holdingSnapshot)
      .innerJoin(security, eq(security.id, holdingSnapshot.securityId))
      .where(and(eq(holdingSnapshot.accountId, accountId), eq(holdingSnapshot.date, date)))
      .orderBy(asc(security.type));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    const [conn] = await db
      .insert(connection)
      .values({ type: "simplefin", name: "Brokerage", status: "ok", accessUrlEnc: await encryptSecret(ACCESS, secretsKey) })
      .returning({ id: connection.id });
    connectionId = conn!.id;
    ctx = {
      db,
      config,
      client: {
        fetch: (async (input: string | URL | Request) => {
          const url = new URL(String(input));
          // One fake covers both feeds: the Bridge answers with the account set, Tiingo with an empty CSV (no bars).
          if (url.hostname === "api.tiingo.com") return new Response("", { status: 200 });
          return new Response(JSON.stringify(accountSet), { status: 200 });
        }) as typeof fetch,
      },
      now: () => now,
      sleep: async () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("writes the brokerage's holdings, reports the unreadable container, keeps the bank truth and queues the holdings fetch once", async () => {
    accountSet = renderAccountSet({ start: START, asOf: ASOF, brokerage: true, extraAccounts: [OTHER] });
    await enqueueJob(db, "simplefin.sync", { connectionId });
    // The sync, the recurring run and the holdings fetch it queued, then the valuation the fetch chains.
    expect(await drainQueue(ctx)).toBe(4);
    const jobs = await db.select().from(job);
    expect(jobs.map((j) => [j.type, j.status]).sort()).toEqual([
      ["investments.valuation", "done"],
      ["prices.fetch", "done"],
      ["recurring.detect", "done"],
      ["simplefin.sync", "done"],
    ]);
    expect(jobs.find((j) => j.type === "prices.fetch")!.payload).toEqual({ reason: "holdings", dedupeKey: "prices:holdings" });

    const log = await lastSyncLog();
    expect(log.status).toBe("ok");
    expect(log.stats).toMatchObject({ holdingsAccounts: 1, holdingsPositions: 2, holdingsInserted: 2, holdingsUnrecognizedAccounts: 1, holdingsIgnoredAccounts: 0, holdingsSnapshotsKept: 0, securitiesCreated: 2, impliedPrices: 1, investmentTxnsLinked: 0 });
    // The bank accounts' transactions are exactly those of a run without holdings.
    expect(log.stats!["created"]).toBe(accountSet.accounts.reduce((n, a) => n + a.transactions.length, 0));
    const unreadable = { code: "holdings.unrecognized", message: "Other IRA: 1 of 1 holding rows could not be read (keys: foo, bar)", accountId: "ACT-OTH-001" };
    expect(log.errors).toEqual([unreadable]);
    const [conn] = await db.select().from(connection).where(eq(connection.id, connectionId));
    expect(conn).toMatchObject({ status: "ok", lastErrors: [unreadable], lastError: null });

    expect(await db.select().from(account)).toHaveLength(5);
    const brokerage = await accountByExternalId(BROKERAGE_ACCOUNT.id);
    expect(brokerage).toMatchObject({ type: "brokerage", onBudget: false, balanceCents: 324465n, balanceDate: ASOF });
    expect(await accountByExternalId("ACT-OTH-001")).toMatchObject({ type: "ira", onBudget: false });
    expect((await accountByExternalId(ACCOUNTS.checking.id)).onBudget).toBe(true);

    const securities = await db.select().from(security).orderBy(asc(security.type));
    expect(securities.map((s) => [s.ticker, s.name, s.type, s.needsReview, s.priceMode])).toEqual([
      [null, "Cash (USD)", "cash", false, "manual"],
      ["VTI", "Vanguard Total Stock Market ETF", "etf", true, "provider"],
    ]);
    const rows = await snapshotsOf(brokerage.id, ASOF);
    expect(rows.map((r) => [r.ticker, r.row.quantity, r.row.price, r.row.valueCents, r.row.reportedCostBasisCents, r.row.source, r.row.importLogId])).toEqual([
      [null, "150.25000000", "1.00000000", 15025n, null, "simplefin", log.id],
      ["VTI", "12.34500000", "250.66000000", 309440n, 250000n, "simplefin", log.id],
    ]);
    const prices = await db.select().from(price);
    expect(prices.map((p) => [p.date, p.close, p.source])).toEqual([[ASOF, "250.66000000", "implied"]]);
    // The checking account's empty extra and the other account's junk write nothing.
    expect(await db.select().from(holdingSnapshot)).toHaveLength(2);
    const [balance] = await db
      .select()
      .from(balanceSnapshot)
      .where(and(eq(balanceSnapshot.accountId, brokerage.id), eq(balanceSnapshot.date, ASOF)));
    expect(balance).toMatchObject({ balanceCents: 324465n, source: "simplefin" });
  });

  it("the same payload again changes nothing and queues no second fetch", async () => {
    await enqueueJob(db, "simplefin.sync", { connectionId });
    expect(await drainQueue(ctx)).toBe(2);
    const log = await lastSyncLog();
    expect(log.stats).toMatchObject({ holdingsAccounts: 1, holdingsInserted: 0, holdingsUpdated: 0, holdingsDeleted: 0, securitiesCreated: 0, impliedPrices: 0, created: 0 });
    expect(await jobsOf("prices.fetch")).toHaveLength(1);
    expect(await db.select().from(holdingSnapshot)).toHaveLength(2);
  });

  it("a balances-only refresh writes the day's snapshot too; a full sync links investment rows and queues the income feed", async () => {
    const DAY2: IsoDate = "2026-10-14";
    now = new Date(`${DAY2}T12:00:00Z`);
    const holdings = [{ symbol: "VTI", description: "Vanguard Total Stock Market ETF", quantity: "13", price: "251.00", market_value: "3263.00" }];
    accountSet = renderAccountSet({ start: START, asOf: DAY2, brokerage: { extra: { holdings }, balance: "3263.00" } });
    await enqueueJob(db, "simplefin.balances", { connectionId });
    expect(await drainQueue(ctx)).toBe(1);
    const brokerage = await accountByExternalId(BROKERAGE_ACCOUNT.id);
    expect((await snapshotsOf(brokerage.id, DAY2)).map((r) => [r.ticker, r.row.quantity, r.row.valueCents])).toEqual([["VTI", "13.00000000", 326300n]]);
    expect((await lastSyncLog()).stats).toMatchObject({ holdingsAccounts: 1, holdingsInserted: 1 });
    expect(await jobsOf("investments.income_feed")).toHaveLength(0);

    // A dividend entered by hand before the bank row arrived; the brokerage feeds the plan's Dividends category.
    const [dividends] = await db.insert(category).values({ name: "Dividends", bucket: "income", position: 1 }).returning({ id: category.id });
    await db.update(householdSetting).set({ investmentIncomeCategoryId: dividends!.id }).where(eq(householdSetting.id, 1));
    await db.update(account).set({ investmentIncomeFeed: "link" }).where(eq(account.id, brokerage.id));
    const [vti] = await db.select({ id: security.id }).from(security).where(eq(security.ticker, "VTI"));
    const [dividend] = await db
      .insert(investmentTxn)
      .values({ accountId: brokerage.id, securityId: vti!.id, date: DAY2, type: "dividend", amountCents: 1234n, source: "manual" })
      .returning({ id: investmentTxn.id });
    accountSet = renderAccountSet({
      start: START,
      asOf: DAY2,
      brokerage: { extra: { holdings }, balance: "3275.34", transactions: [{ id: "BRK-DIV-1", posted: unix(DAY2), amount: "12.34", description: "DIVIDEND VTI", transaction_date: unix(DAY2, 0), pending: false }] },
    });
    await enqueueJob(db, "simplefin.sync", { connectionId });
    // The sync, the recurring run and the income feed (no fetch: no security was created).
    expect(await drainQueue(ctx)).toBe(3);
    expect((await lastSyncLog()).stats).toMatchObject({ investmentTxnsLinked: 1, securitiesCreated: 0 });
    const [feedJob] = await jobsOf("investments.income_feed");
    expect(feedJob).toMatchObject({ status: "done", payload: { reason: "sync", dedupeKey: "investments.income_feed" } });
    const [bankRow] = await db.select().from(transaction).where(eq(transaction.externalId, "BRK-DIV-1"));
    expect(bankRow).toMatchObject({ accountId: brokerage.id, amountCents: 1234n, isTransfer: false, categoryId: dividends!.id });
    const [linked] = await db.select({ ledgerTransactionId: investmentTxn.ledgerTransactionId }).from(investmentTxn).where(eq(investmentTxn.id, dividend!.id));
    expect(linked!.ledgerTransactionId).toBe(bankRow!.id);
    expect(await jobsOf("prices.fetch")).toHaveLength(1);
  });
});
