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

type SfAccount = SimplefinAccountSet["accounts"][number];
type SfTxn = SfAccount["transactions"][number];

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
        // The suites' Bridge (the default list is the real Bridge's hosts).
        allowedHosts: ["bridge.example.test"],
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
        // The suites' Bridge (the default list is the real Bridge's hosts).
        allowedHosts: ["bridge.example.test"],
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
      brokerage: { extra: { holdings }, balance: "3275.34", transactions: [{ id: "BRK-DIV-1", posted: unix(DAY2), amount: "12.34", description: "DIVIDEND VTI", transacted_at: unix(DAY2, 0), pending: false }] },
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

/**
 * The high-water mark (`connection.synced_through`) is the day through which every account
 * is complete; the next window starts 7 days before it. One checking account whose bank
 * books a $10.00 purchase every day from 2026-09-01 on, so a missing day is a missing row.
 */
describe.skipIf(!TEST_DATABASE_URL)("sync high-water mark", () => {
  let t: TestDb;
  let ctx: JobContext;
  let connectionId: string;
  const secretsKey = generateSecretsKey();
  let now = new Date("2026-09-10T12:00:00Z");
  const requests: URL[] = [];
  let respond: (url: URL) => SimplefinAccountSet = () => ({ errors: [], errlist: [], accounts: [] });
  const config: WorkerConfig = { databaseUrl: "unused", secretsKey, workerId: "test-worker", syncIntervalHours: 6, pollIntervalMs: 10, initialWindowDays: 93, overlapDays: 7, requestTimeoutMs: 5000 };

  const unix = (date: IsoDate, hour = 12) => Math.floor(isoDateToUtcMs(date) / 1000) + hour * 3600;
  const day = (d: Date): IsoDate => d.toISOString().slice(0, 10) as IsoDate;
  const startAsked = (url: URL): IsoDate => day(new Date(Number(url.searchParams.get("start-date")) * 1000));
  /** The bank's real history inside the requested window, as far as the Bridge has read it (`through`). */
  const purchases = (url: URL, through: IsoDate, prefix = "T"): SfTxn[] => {
    const out: SfTxn[] = [];
    for (let d: IsoDate = "2026-09-01"; d <= through; d = addDays(d, 1)) {
      if (d >= startAsked(url)) out.push({ id: `${prefix}-${d}`, posted: unix(d), amount: "-10.00", description: "KING SOOPERS #0123", pending: false });
    }
    return out;
  };
  const checking = (url: URL, through: IsoDate, balanceDay: IsoDate = through): SfAccount => ({
    org: { name: "First Example Bank" },
    id: "CHK",
    name: "Everyday Checking",
    currency: "USD",
    balance: "100.00",
    "balance-date": unix(balanceDay, 6),
    transactions: purchases(url, through),
  });
  const healthy = (url: URL): SimplefinAccountSet => ({ errors: [], errlist: [], accounts: [checking(url, day(now))] });
  const syncOn = async (date: IsoDate, payload: Record<string, unknown> = {}) => {
    now = new Date(`${date}T12:00:00Z`);
    requests.length = 0;
    await enqueueJob(t.db, "simplefin.sync", { connectionId, ...payload });
    await drainQueue(ctx);
  };
  const conn = async () => (await t.db.select().from(connection).where(eq(connection.id, connectionId)))[0]!;
  const ids = async () => (await t.db.select({ ext: transaction.externalId }).from(transaction).orderBy(asc(transaction.externalId))).map((r) => r.ext);
  const expected = (through: IsoDate, prefix = "T") => {
    const out: string[] = [];
    for (let d: IsoDate = "2026-09-01"; d <= through; d = addDays(d, 1)) out.push(`${prefix}-${d}`);
    return out;
  };

  beforeAll(async () => {
    t = await createTestDb();
    ctx = {
      db: t.db,
      config,
      client: {
        // The suites' Bridge (the default list is the real Bridge's hosts).
        allowedHosts: ["bridge.example.test"],
        fetch: (async (input: string | URL | Request) => {
          const url = new URL(String(input));
          requests.push(url);
          return new Response(JSON.stringify(respond(url)), { status: 200 });
        }) as typeof fetch,
      },
      now: () => now,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
    const [row] = await t.db.insert(connection).values({ type: "simplefin", name: "Bank", status: "ok", accessUrlEnc: await encryptSecret(ACCESS, secretsKey) }).returning({ id: connection.id });
    connectionId = row!.id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("does not move while a bank needs re-authentication, so three weeks of outage lose nothing", async () => {
    // 09-10: a healthy first sync. 93 days back is 2026-06-09; the bank has ten purchases so far.
    respond = healthy;
    await syncOn("2026-09-10");
    expect(startAsked(requests[0]!)).toBe("2026-06-09");
    expect(await ids()).toEqual(expected("2026-09-10"));
    expect(await conn()).toMatchObject({ status: "ok", syncedThrough: "2026-09-10" });

    // 09-11 to 10-01, 21 days: the bank login is broken at the Bridge. It answers 200 with con.auth and
    // what it last read (nothing after 09-10), under a balance date that looks current.
    respond = (url) => ({ errors: [], errlist: [{ code: "con.auth", msg: "re-login", conn_id: "CON-1" }], accounts: [checking(url, "2026-09-10", day(now))] });
    for (let d: IsoDate = "2026-09-11"; d <= "2026-10-01"; d = addDays(d, 1)) await syncOn(d);
    expect(await conn()).toMatchObject({ status: "auth_required", syncedThrough: "2026-09-10" });
    // Every one of those syncs asked from 7 days before the mark, not from 7 days before itself.
    expect(startAsked(requests[0]!)).toBe("2026-09-03");

    // 10-02: re-authenticated. The window still starts at 09-03, so 09-11 to 10-02 all arrive: 32 purchases, none missing.
    respond = healthy;
    await syncOn("2026-10-02");
    expect(startAsked(requests[0]!)).toBe("2026-09-03");
    expect(await ids()).toEqual(expected("2026-10-02"));
    expect(await ids()).toHaveLength(32);
    expect(await conn()).toMatchObject({ status: "ok", syncedThrough: "2026-10-02", lastErrors: [], lastError: null });
  });

  it("does not move past data the overlap can no longer cover when the Bridge serves a stale copy without saying so", async () => {
    // 10-03 to 10-12: no error entry, but the Bridge has read nothing since 10-02 (the balance date says so).
    respond = (url) => ({ errors: [], errlist: [], accounts: [checking(url, "2026-10-02")] });
    for (let d: IsoDate = "2026-10-03"; d <= "2026-10-12"; d = addDays(d, 1)) await syncOn(d);
    // Through 10-09 the copy is at most 7 days old and the next window still reaches it; from 10-10 it is not.
    expect(await conn()).toMatchObject({ status: "ok", syncedThrough: "2026-10-09" });

    // 10-13: the Bridge catches up. The window starts at 10-02, so 10-03 and 10-04 are not lost: 43 purchases.
    respond = healthy;
    await syncOn("2026-10-13");
    expect(startAsked(requests[0]!)).toBe("2026-10-02");
    expect(await ids()).toEqual(expected("2026-10-13"));
    expect(await ids()).toHaveLength(43);
    expect((await conn()).syncedThrough).toBe("2026-10-13");
  });

  it("gives an account that appears later the first-sync window on the next sync", async () => {
    // 10-14: a second bank was added at the Bridge. This window only reaches back to 10-06.
    const savings = (url: URL): SfAccount => ({ ...checking(url, day(now)), id: "SAV", name: "Savings", transactions: purchases(url, day(now), "S") });
    respond = (url) => ({ errors: [], errlist: [], accounts: [checking(url, day(now)), savings(url)] });
    await syncOn("2026-10-14");
    expect(startAsked(requests[0]!)).toBe("2026-10-06");
    expect((await ids()).filter((id) => id!.startsWith("S-"))).toHaveLength(9); // 10-06 to 10-14
    expect((await conn()).syncedThrough).toBeNull();

    // 10-15: no mark, so 93 days back (2026-07-14): the savings account's whole history arrives.
    await syncOn("2026-10-15");
    expect(startAsked(requests[0]!)).toBe("2026-07-14");
    expect((await ids()).filter((id) => id!.startsWith("S-"))).toEqual(expected("2026-10-15", "S"));
    expect((await conn()).syncedThrough).toBe("2026-10-15");
    // And the next one is an ordinary 7-day overlap again.
    await syncOn("2026-10-16");
    expect(startAsked(requests[0]!)).toBe("2026-10-08");
  });

  it("a full resync asks for the first-sync window whatever the mark, and a balances-only refresh leaves the mark alone", async () => {
    await syncOn("2026-10-17", { fullResync: true });
    expect(startAsked(requests[0]!)).toBe("2026-07-16");
    expect((await conn()).syncedThrough).toBe("2026-10-17");

    now = new Date("2026-10-19T12:00:00Z");
    requests.length = 0;
    await enqueueJob(t.db, "simplefin.balances", { connectionId });
    await drainQueue(ctx);
    expect(requests[0]!.searchParams.get("balances-only")).toBe("1");
    expect(requests[0]!.searchParams.get("start-date")).toBeNull();
    expect((await conn()).syncedThrough).toBe("2026-10-17");
  });

  it("says so when the last complete sync is further back than a sync can ask for", async () => {
    // The bank was unreadable from 2026-06-01 until today, 2026-10-20: 141 days. 93 days back is 2026-07-19.
    await t.db.update(connection).set({ syncedThrough: "2026-06-01" }).where(eq(connection.id, connectionId));
    await syncOn("2026-10-20");
    expect(startAsked(requests[0]!)).toBe("2026-07-19");
    const gap = {
      code: "sync.gap",
      message: "The last complete sync was 2026-06-01. A sync asks the Bridge for at most 93 days, so transactions from 2026-06-02 to 2026-07-18 were not requested. Import a CSV from the bank for that period if any are missing.",
    };
    expect(await conn()).toMatchObject({ status: "ok", syncedThrough: "2026-10-20", lastErrors: [gap] });
    const [log] = await t.db.select().from(importLog).where(eq(importLog.kind, "simplefin.sync")).orderBy(desc(importLog.startedAt), desc(importLog.id)).limit(1);
    expect(log!.errors).toEqual([gap]);
    // The next sync has nothing to report.
    await syncOn("2026-10-21");
    expect((await conn()).lastErrors).toEqual([]);
  });

  it("a failed sync records the attempt, drops the previous sync's entries and leaves the last success and the mark alone", async () => {
    const before = await conn();
    await t.db.update(connection).set({ lastErrors: [{ code: "act.missingdata", message: "The Bridge returned incomplete data for this account.", accountId: "CHK" }] }).where(eq(connection.id, connectionId));
    ctx.client.fetch = (async () => new Response("", { status: 402 })) as typeof fetch;
    await syncOn("2026-10-22");
    const after = await conn();
    expect(after).toMatchObject({ status: "error", lastErrors: [], syncedThrough: before.syncedThrough, syncPaused: true });
    expect(after.lastError).toMatch(/402/);
    expect(after.lastSyncAt).toEqual(before.lastSyncAt);
    expect(after.lastAttemptAt).toEqual(new Date("2026-10-22T12:00:00Z"));
  });
});

/**
 * Audit batch a4-sync-parse: what an odd response, or an odd value in one, does to a sync.
 * The clock is 2026-11-01T01:00Z, which is 19:00 on Oct 31 in the household's zone.
 */
describe.skipIf(!TEST_DATABASE_URL)("sync of odd responses (a4-sync-parse)", () => {
  let t: TestDb;
  let ctx: JobContext;
  let connectionId: string;
  const secretsKey = generateSecretsKey();
  const now = new Date("2026-11-01T01:00:00Z");
  const requests: URL[] = [];
  let respond: (url: URL, init: RequestInit) => Response = () => new Response("", { status: 500 });
  const config: WorkerConfig = { databaseUrl: "unused", secretsKey, workerId: "test-worker", syncIntervalHours: 6, pollIntervalMs: 10, initialWindowDays: 93, overlapDays: 7, requestTimeoutMs: 5000 };
  const unix = (date: IsoDate, hour = 12) => Math.floor(isoDateToUtcMs(date) / 1000) + hour * 3600;
  const checking = (transactions: unknown[], extra: Record<string, unknown> = {}) => ({
    org: { name: "First Example Bank" },
    id: "CHK",
    name: "Everyday Checking",
    currency: "USD",
    balance: "100.00",
    "balance-date": unix("2026-10-31", 6),
    transactions,
    ...extra,
  });
  const posted = (id: string, amount: string, description = "KING SOOPERS") => ({ id, posted: unix("2026-10-30"), amount, description });
  const conn = async () => (await t.db.select().from(connection).where(eq(connection.id, connectionId)))[0]!;
  const lastLog = async () => (await t.db.select().from(importLog).where(eq(importLog.connectionId, connectionId)).orderBy(desc(importLog.startedAt), desc(importLog.id)))[0]!;
  const sync = async () => {
    requests.length = 0;
    await enqueueJob(t.db, "simplefin.sync", { connectionId });
    await drainQueue(ctx);
  };
  const ids = async () => (await t.db.select({ ext: transaction.externalId }).from(transaction).orderBy(asc(transaction.externalId))).map((r) => r.ext);

  beforeAll(async () => {
    t = await createTestDb();
    ctx = {
      db: t.db,
      config,
      client: {
        allowedHosts: ["bridge.example.test"],
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input));
          requests.push(url);
          return respond(url, init ?? {});
        }) as typeof fetch,
      },
      now: () => now,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
    const [row] = await t.db.insert(connection).values({ type: "simplefin", name: "Bank", status: "ok", accessUrlEnc: await encryptSecret(ACCESS, secretsKey) }).returning({ id: connection.id });
    connectionId = row!.id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("a4-sync-parse-08: the window and the mark are the household's day, not the UTC day", async () => {
    respond = () => new Response(JSON.stringify({ errors: [], accounts: [checking([posted("C1", "-1.00"), { id: "P1", posted: 0, amount: "-2.00", description: "HOLD", pending: true }])] }));
    await sync();
    // 93 days before 2026-10-31 is 2026-07-30.
    expect(requests[0]!.searchParams.get("start-date")).toBe(String(isoDateToUtcMs("2026-07-30") / 1000));
    expect(await conn()).toMatchObject({ status: "ok", syncedThrough: "2026-10-31" });
    const [hold] = await t.db.select({ date: transaction.date }).from(transaction).where(eq(transaction.externalId, "P1"));
    expect(hold!.date).toBe("2026-10-31");
  });

  it("a4-sync-parse-02: a response that is not JSON, or not an account set, is kept in the import log", async () => {
    respond = () => new Response("<html>Bridge maintenance</html>", { status: 200 });
    await sync();
    let log = await lastLog();
    expect(log).toMatchObject({ status: "error", message: "SimpleFIN returned a response that is not JSON", rawPayload: { notJson: "<html>Bridge maintenance</html>" } });

    respond = () => new Response(JSON.stringify({ errors: [], accounts: { CHK: { balance: "1.00" } } }));
    await sync();
    log = await lastLog();
    expect(log).toMatchObject({ status: "error", message: "SimpleFIN response did not match protocol v2: accounts: expected a list", rawPayload: { errors: [], accounts: { CHK: { balance: "1.00" } } } });
    expect((await conn()).lastError).toBe("SimpleFIN response did not match protocol v2: accounts: expected a list");
  });

  it("a4-sync-parse-03: holdings keyed by symbol, null text and an account that cannot be read do not stop the other accounts", async () => {
    const brokerage = {
      org: { name: "Example Brokerage" },
      id: "BRK",
      name: "Individual Brokerage",
      currency: "USD",
      balance: "500.00",
      "balance-date": unix("2026-10-31", 6),
      transactions: [{ id: "B1", posted: unix("2026-10-30"), amount: "-1.00", description: null, payee: null }],
      holdings: { VTI: { shares: "2", market_value: "500.00" } },
      extra: null,
    };
    const broken = { org: { name: "Card Bank" }, id: "CARD", name: "Sapphire Visa", currency: "USD", balance: "1.00", transactions: [] };
    respond = () => new Response(JSON.stringify({ errors: [], errlist: [], accounts: [checking([posted("C6", "-6.00")]), brokerage, broken] }));
    await sync();
    // The hold P1 is gone from this response: the checking account was read in full, so it dropped off.
    expect(await ids()).toEqual(["B1", "C1", "C6"]);
    const log = await lastLog();
    expect(log.status).toBe("ok");
    expect(log.stats).toMatchObject({ holdingsAccounts: 1, holdingsPositions: 1 });
    const c = await conn();
    expect(c.lastErrors).toEqual([{ code: "account.unreadable", message: "Sapphire Visa: the account could not be read and was skipped (balance-date: Required)", accountId: "CARD" }]);
    expect(c.lastError).toBeNull();
    // A new account (BRK) clears the mark, so the next sync asks for its history.
    expect(c.syncedThrough).toBeNull();
    // An account none of whose transactions arrived holds the mark, as act.failed does; once it is readable the mark moves.
    await sync();
    expect((await conn()).syncedThrough).toBeNull();
    respond = () => new Response(JSON.stringify({ errors: [], errlist: [], accounts: [checking([posted("C6", "-6.00")]), brokerage] }));
    await sync();
    expect(await conn()).toMatchObject({ syncedThrough: "2026-10-31", lastErrors: [] });
  });

  it("a4-sync-parse-05: NUL characters in a description, a payee, an errlist message and an id leave the sync working and the payload kept", async () => {
    const nul = String.fromCharCode(0);
    respond = () =>
      new Response(
        JSON.stringify({
          errors: [`maintenance${nul}tonight`],
          errlist: [{ code: "act.missingdata", msg: `partial${nul}data`, account_id: "CHK" }],
          accounts: [checking([{ ...posted(`N${nul}1`, "-3.00", `ACME${nul}STORE`), payee: `Acme${nul}` }])],
        }),
      );
    await sync();
    const log = await lastLog();
    expect(log.status).toBe("ok");
    const raw = log.rawPayload as { accounts: Array<{ transactions: Array<{ id: string; description: string; payee: string }> }> };
    expect(raw.accounts[0]!.transactions[0]).toMatchObject({ id: "N\uFFFD1", description: "ACME\uFFFDSTORE", payee: "Acme\uFFFD" });
    const [row] = await t.db.select().from(transaction).where(eq(transaction.externalId, "N\uFFFD1"));
    expect(row).toMatchObject({ amountCents: -300n, rawDescription: "ACME\uFFFDSTORE" });
    expect((await conn()).lastErrors).toEqual([
      // The entry names the account (audit a8-ledger-ui-11).
      { code: "act.missingdata", message: "Everyday Checking: The Bridge returned incomplete data for this account. It will retry on the next sync. (partial\uFFFDdata)", accountId: "CHK" },
      { code: "error", message: "maintenance\uFFFDtonight" },
    ]);
  });

  it("a4-sync-parse-11: a long junk amount never reaches the error text, and stored error text is sanitized and bounded", async () => {
    const junk = `<b>${"x".repeat(5000)}</b>`;
    respond = () => new Response(JSON.stringify({ errors: [], accounts: [checking([posted("J1", junk), posted("J2", "-4.00")])] }));
    await sync();
    const c = await conn();
    expect(c.status).toBe("ok");
    expect(c.lastError).toBeNull();
    expect(c.lastErrors).toEqual([{ code: "amount.unreadable", message: "Everyday Checking: 1 transaction was skipped because its amount could not be read", accountId: "CHK" }]);
    expect(await ids()).toContain("J2");
    // The raw payload keeps the value as sent; nothing shown for display quotes it.
    const { rawPayload: _raw, ...shown } = await lastLog();
    expect(JSON.stringify(shown, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("xxxxxxxxxx");

    // A database error quotes the value it refused: the job's error is sanitized and bounded before it is stored.
    const [bad] = await t.db.insert(job).values({ type: "simplefin.sync", payload: { connectionId: junk }, maxAttempts: 1 }).returning({ id: job.id });
    await drainQueue(ctx);
    const [failed] = await t.db.select().from(job).where(eq(job.id, bad!.id));
    expect(failed!.status).toBe("failed");
    expect(failed!.lastError!.length).toBeLessThanOrEqual(300);
    expect(failed!.lastError).not.toContain("<b>");
  });
});

/** Audit a4-sync-parse-06: a setup token whose claim failed for a reason that passes can still be claimed. */
describe.skipIf(!TEST_DATABASE_URL)("claim after a transient failure (a4-sync-parse-06)", () => {
  let t: TestDb;
  let ctx: JobContext;
  const secretsKey = generateSecretsKey();
  let bridgeStatus = 503;
  const config: WorkerConfig = { databaseUrl: "unused", secretsKey, workerId: "test-worker", syncIntervalHours: 6, pollIntervalMs: 10, initialWindowDays: 93, overlapDays: 7, requestTimeoutMs: 5000 };

  beforeAll(async () => {
    t = await createTestDb();
    ctx = {
      db: t.db,
      config,
      client: {
        allowedHosts: ["bridge.example.test"],
        fetch: (async (_input: string | URL | Request, init?: RequestInit) =>
          bridgeStatus !== 200 ? new Response("", { status: bridgeStatus }) : init?.method === "POST" ? new Response(ACCESS) : new Response(JSON.stringify({ errors: [], accounts: [] }))) as typeof fetch,
      },
      now: () => new Date("2026-10-13T12:00:00Z"),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("keeps the token through three failed attempts, says to press Sync now, and claims it when queued again", async () => {
    const claimTokenEnc = await encryptSecret(btoa("https://bridge.example.test/simplefin/claim/tok"), secretsKey);
    const [conn] = await t.db.insert(connection).values({ type: "simplefin", name: "Bank", status: "claiming", claimTokenEnc }).returning();
    const [claim] = await t.db.insert(job).values({ type: "simplefin.claim", payload: { connectionId: conn!.id } }).returning();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await t.db.update(job).set({ runAt: new Date(Date.now() - 1000) }).where(eq(job.id, claim!.id));
      await drainQueue(ctx);
    }
    const [spent] = await t.db.select().from(job).where(eq(job.id, claim!.id));
    expect(spent).toMatchObject({ status: "failed", attempts: 3 });
    const [after] = await t.db.select().from(connection).where(eq(connection.id, conn!.id));
    expect(after).toMatchObject({ status: "error", accessUrlEnc: null, lastError: "The setup token could not be claimed yet: Claim failed with HTTP 503. Press Sync now to try again." });
    expect(after!.claimTokenEnc).toBe(conn!.claimTokenEnc);

    // What Sync now queues for such a connection (the API test covers the route): the claim, which now works.
    bridgeStatus = 200;
    await enqueueJob(t.db, "simplefin.claim", { connectionId: conn!.id }, { dedupe: true });
    await drainQueue(ctx);
    const [claimed] = await t.db.select().from(connection).where(eq(connection.id, conn!.id));
    expect(claimed).toMatchObject({ status: "ok", claimTokenEnc: null, lastError: null });
    expect(claimed!.accessUrlEnc).not.toBeNull();
  });
});
