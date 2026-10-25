import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, connection, enqueueJob, holdingSnapshot, importLog, job, security, type Db, type JobRow } from "@meridian/db";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "@meridian/db/testing";
import { generateSecretsKey, isoDateToUtcMs, type IsoDate, type SimplefinAccountSet } from "@meridian/shared";
import type { WorkerConfig } from "../env.js";
import { drainQueue } from "../runner.js";
import type { JobContext } from "./context.js";
import { runReprocessHoldingsJob } from "./reprocessHoldings.js";

/**
 * `simplefin.reprocess_holdings` (imports design §6, test 25): stored sync payloads are
 * replayed through the holdings parser so positions a stubbed or older parser missed land
 * as `simplefin` snapshots, never over a csv or manual one.
 */

const BRK = "ACT-BRK-001";

function payload(asOf: IsoDate, quantity: string, value: string, accounts: SimplefinAccountSet["accounts"] = []): SimplefinAccountSet {
  return {
    errors: [],
    errlist: [],
    accounts: [
      {
        org: { domain: "brokerage.example.test", name: "Example Brokerage Services" },
        id: BRK,
        name: "Example Brokerage",
        currency: "USD",
        balance: value,
        "balance-date": Math.floor(isoDateToUtcMs(asOf) / 1000) + 6 * 3600,
        transactions: [],
        extra: { holdings: [{ symbol: "VTI", description: "Vanguard Total Stock Market ETF", quantity, price: "250.66", market_value: value }] },
      },
      ...accounts,
    ],
  };
}

function fakeJob(payload: Record<string, unknown>): JobRow {
  const now = new Date();
  return { id: "00000000-0000-0000-0000-000000000000", type: "simplefin.reprocess_holdings", payload, status: "running", runAt: now, attempts: 1, maxAttempts: 3, lockedBy: "test", lastError: null, createdAt: now, startedAt: now, finishedAt: null };
}

describe.skipIf(!TEST_DATABASE_URL)("simplefin.reprocess_holdings", () => {
  let t: TestDb;
  let db: Db;
  let ctx: JobContext;
  let connectionId: string;
  let accountId: string;
  let vtiId: string;
  const logIds: string[] = [];
  const now = new Date("2026-10-14T18:00:00Z");
  const config: WorkerConfig = { databaseUrl: "unused", secretsKey: generateSecretsKey(), workerId: "test-worker", syncIntervalHours: 6, pollIntervalMs: 10, initialWindowDays: 93, overlapDays: 7, requestTimeoutMs: 5000 };
  const snapshotsOn = (date: IsoDate) =>
    db
      .select({ securityId: holdingSnapshot.securityId, quantity: holdingSnapshot.quantity, valueCents: holdingSnapshot.valueCents, source: holdingSnapshot.source, importLogId: holdingSnapshot.importLogId })
      .from(holdingSnapshot)
      .where(and(eq(holdingSnapshot.accountId, accountId), eq(holdingSnapshot.date, date)));
  const summaries = () => db.select().from(importLog).where(eq(importLog.kind, "simplefin.reprocess")).orderBy(asc(importLog.startedAt), asc(importLog.id));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    const [conn] = await db.insert(connection).values({ type: "simplefin", name: "Brokerage", status: "ok" }).returning({ id: connection.id });
    connectionId = conn!.id;
    const [acct] = await db
      .insert(account)
      .values({ connectionId, externalId: BRK, name: "Example Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false, balanceCents: 313250n, balanceDate: "2026-10-13" })
      .returning({ id: account.id });
    accountId = acct!.id;
    // Two syncs stored while the parser was stubbed (no snapshots), plus one payload that no longer parses.
    const logs = await db
      .insert(importLog)
      .values([
        { connectionId, kind: "simplefin.sync", status: "ok", startedAt: new Date("2026-10-12T12:00:00Z"), finishedAt: new Date("2026-10-12T12:00:05Z"), rawPayload: payload("2026-10-12", "12.345", "3094.40"), stats: { created: 3 } },
        { connectionId, kind: "simplefin.balances", status: "ok", startedAt: new Date("2026-10-13T12:00:00Z"), finishedAt: new Date("2026-10-13T12:00:05Z"), rawPayload: payload("2026-10-13", "12.5", "3132.50"), stats: {} },
        { connectionId, kind: "simplefin.sync", status: "ok", startedAt: new Date("2026-10-13T18:00:00Z"), finishedAt: new Date("2026-10-13T18:00:05Z"), rawPayload: { accounts: "nope" } },
        { connectionId, kind: "simplefin.sync", status: "error", startedAt: new Date("2026-10-14T00:00:00Z"), finishedAt: new Date("2026-10-14T00:00:05Z"), rawPayload: payload("2026-10-14", "99", "1.00"), message: "boom" },
      ])
      .returning({ id: importLog.id });
    logIds.push(...logs.map((l) => l.id));
    // A csv statement the owner imported for 10-13 outranks the feed.
    const [vti] = await db.insert(security).values({ ticker: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf", assetClass: "us_stock", priceMode: "provider", needsReview: false }).returning({ id: security.id });
    vtiId = vti!.id;
    await db.insert(holdingSnapshot).values({ accountId, securityId: vtiId, date: "2026-10-13", quantity: "20", price: "250", valueCents: 500000n, source: "csv" });
    ctx = { db, config, client: {}, now: () => now, log: { info: () => {}, warn: () => {}, error: () => {} } };
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("replays the stored payloads oldest first, keeps the csv snapshot, stamps the rows and writes a summary (imports test 25)", async () => {
    const first = await enqueueJob(db, "simplefin.reprocess_holdings", { connectionId }, { dedupe: true });
    expect(first.created).toBe(true);
    expect((await enqueueJob(db, "simplefin.reprocess_holdings", { connectionId }, { dedupe: true })).created).toBe(false);
    expect(await drainQueue(ctx)).toBe(1);
    expect((await db.select().from(job))[0]).toMatchObject({ type: "simplefin.reprocess_holdings", status: "done" });

    expect(await snapshotsOn("2026-10-12")).toEqual([{ securityId: vtiId, quantity: "12.34500000", valueCents: 309440n, source: "simplefin", importLogId: logIds[0] }]);
    expect(await snapshotsOn("2026-10-13")).toEqual([{ securityId: vtiId, quantity: "20.00000000", valueCents: 500000n, source: "csv", importLogId: null }]);
    expect(await snapshotsOn("2026-10-14")).toEqual([]);

    const [summary] = await summaries();
    expect(summary).toMatchObject({ connectionId, status: "ok", message: "Reprocessed holdings from 2 payloads", rawPayload: null, errors: [] });
    expect(summary!.stats).toMatchObject({ payloads: 2, payloadsUnparseable: 1, accountsUnknown: 0, holdingsAccounts: 1, holdingsPositions: 1, holdingsInserted: 1, holdingsSnapshotsKept: 1, securitiesCreated: 0, impliedPrices: 1 });
    const replayed = await db.select({ id: importLog.id, stats: importLog.stats }).from(importLog).where(eq(importLog.connectionId, connectionId)).orderBy(asc(importLog.startedAt));
    expect(typeof replayed.find((r) => r.id === logIds[0])!.stats!["reprocessedAt"]).toBe("number");
    expect(replayed.find((r) => r.id === logIds[0])!.stats!["created"]).toBe(3);
    expect(typeof replayed.find((r) => r.id === logIds[1])!.stats!["reprocessedAt"]).toBe("number");
    expect(replayed.find((r) => r.id === logIds[2])!.stats).toBeNull();
    expect(replayed.find((r) => r.id === logIds[3])!.stats).toBeNull();
  });

  it("a second run changes nothing, and one payload can be named", async () => {
    const again = await runReprocessHoldingsJob(ctx, fakeJob({ connectionId }));
    expect(again).toMatchObject({ payloads: 2, payloadsUnparseable: 1, holdingsInserted: 0, holdingsUpdated: 0, holdingsDeleted: 0, holdingsSnapshotsKept: 1 });
    const one = await runReprocessHoldingsJob(ctx, fakeJob({ connectionId, importLogId: logIds[0] }));
    expect(one).toMatchObject({ payloads: 1, payloadsUnparseable: 0, holdingsAccounts: 1, holdingsUpdated: 0 });
    expect(await summaries()).toHaveLength(3);
  });

  it("an account the payload names but the connection does not have is counted, a missing connection is a no-op", async () => {
    await db.update(importLog).set({ rawPayload: payload("2026-10-12", "12.345", "3094.40", [{ org: {}, id: "ACT-ZZZ", name: "Someone else", currency: "USD", balance: "1.00", "balance-date": 1791900000, transactions: [], extra: { holdings: [{ symbol: "VXUS", quantity: "1", price: "60" }] } }]) }).where(eq(importLog.id, logIds[0]!));
    const outcome = await runReprocessHoldingsJob(ctx, fakeJob({ connectionId, importLogId: logIds[0] }));
    expect(outcome).toMatchObject({ payloads: 1, accountsUnknown: 1, holdingsAccounts: 1 });
    expect(await db.select().from(security).where(eq(security.ticker, "VXUS"))).toHaveLength(0);
    const ghost = await runReprocessHoldingsJob(ctx, fakeJob({ connectionId: "11111111-1111-4111-8111-111111111111" }));
    expect(ghost).toMatchObject({ importLogId: null, payloads: 0 });
  });
});
