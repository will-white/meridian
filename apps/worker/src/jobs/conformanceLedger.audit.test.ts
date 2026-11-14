import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, applyAccountSet, connection, importLog, transaction, type Db, type JobRow } from "@meridian/db";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "@meridian/db/testing";
import { generateSecretsKey, isoDateToUtcMs, type IsoDate, type SimplefinAccountSet } from "@meridian/shared";
import type { WorkerConfig } from "../env.js";
import type { JobContext } from "./context.js";
import { runReprocessTransactionsJob } from "./reprocessTransactions.js";

type SfTxn = SimplefinAccountSet["accounts"][number]["transactions"][number];
const unix = (date: IsoDate) => Math.floor(isoDateToUtcMs(date) / 1000) + 12 * 3600;
const posted = (id: string, date: IsoDate, amount: string, description: string): SfTxn => ({ id, posted: unix(date), amount, description, pending: false });
const payload = (asOf: IsoDate, transactions: SfTxn[]): SimplefinAccountSet => ({
  errors: [],
  errlist: [],
  accounts: [{ org: { name: "Bank" }, id: "CHK", name: "Everyday Checking", currency: "USD", balance: "100.00", "balance-date": unix(asOf), transactions }],
});
const fakeJob = (p: Record<string, unknown>): JobRow => {
  const now = new Date();
  return { id: randomUUID(), type: "simplefin.reprocess_transactions", payload: p, status: "running", runAt: now, attempts: 1, maxAttempts: 3, lockedBy: "test", lastError: null, createdAt: now, startedAt: now, finishedAt: null };
};

/**
 * Audit a10-conformance-ledger-04: a connection removed and added again (the recovery for a
 * spent setup token, decision 37) keeps the responses stored under the old one, so Re-read
 * transactions on the new connection still reaches the days only those responses hold.
 */
describe.skipIf(!TEST_DATABASE_URL)("stored responses survive a removed connection (audit a10-conformance-ledger-04)", () => {
  let t: TestDb;
  let db: Db;
  let ctx: JobContext;
  const now = new Date("2026-11-13T18:00:00Z");
  const config = { databaseUrl: "unused", secretsKey: generateSecretsKey(), workerId: "test-worker", syncIntervalHours: 6, pollIntervalMs: 10, initialWindowDays: 93, overlapDays: 7, requestTimeoutMs: 5000 } as WorkerConfig;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    ctx = { db, config, client: {}, now: () => now, log: { info: () => {}, warn: () => {}, error: () => {} } };
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("re-reads, on the new connection, a payment that only a response stored under the removed one holds", async () => {
    const [old] = await db.insert(connection).values({ type: "simplefin", name: "Bank" }).returning({ id: connection.id });
    // July: a rent payment an older ingest lost; the response that holds it is stored.
    const july = payload("2026-07-02", [posted("RENT", "2026-07-01", "-1800.00", "ACH RENT PROPERTY CO"), posted("GRO", "2026-07-02", "-54.10", "GROCERY OUTLET")]);
    await db.insert(importLog).values({ connectionId: old!.id, kind: "simplefin.sync", status: "ok", startedAt: new Date("2026-07-02T18:00:00Z"), rawPayload: july });
    await applyAccountSet(db, { connectionId: old!.id, accountSet: payload("2026-07-02", [posted("GRO", "2026-07-02", "-54.10", "GROCERY OUTLET")]), windowStart: "2026-06-01", now: new Date("2026-07-02T18:00:00Z") });

    // The token was spent: the household removes the connection and adds it again; its first sync reaches back 93 days only.
    await db.delete(connection).where(eq(connection.id, old!.id));
    const [fresh] = await db.insert(connection).values({ type: "simplefin", name: "Bank" }).returning({ id: connection.id });
    const first = await applyAccountSet(db, { connectionId: fresh!.id, accountSet: payload("2026-11-13", [posted("NOV", "2026-11-10", "-12.00", "COFFEE")]), windowStart: "2026-08-12", now });
    expect(first.accountsReattached).toBe(1);

    const outcome = await runReprocessTransactionsJob(ctx, fakeJob({ connectionId: fresh!.id }));
    expect(outcome).toMatchObject({ payloads: 1, created: 1 });
    const rows = await db.select({ ext: transaction.externalId, amount: transaction.amountCents }).from(transaction).orderBy(asc(transaction.date));
    expect(rows).toEqual([
      { ext: "RENT", amount: -180000n },
      { ext: "GRO", amount: -5410n },
      { ext: "NOV", amount: -1200n },
    ]);
    const accounts = await db.select({ connectionId: account.connectionId }).from(account);
    expect(accounts).toEqual([{ connectionId: fresh!.id }]);
  });
});
