import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, category, connection, deleteTransaction, enqueueJob, importLog, job, setTransactionSplits, split, transaction, type Db, type JobRow } from "@meridian/db";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "@meridian/db/testing";
import { generateSecretsKey, isoDateToUtcMs, type IsoDate, type SimplefinAccountSet } from "@meridian/shared";
import type { WorkerConfig } from "../env.js";
import { drainQueue } from "../runner.js";
import type { JobContext } from "./context.js";
import { runReprocessTransactionsJob } from "./reprocessTransactions.js";

type SfTxn = SimplefinAccountSet["accounts"][number]["transactions"][number];
const unix = (date: IsoDate) => Math.floor(isoDateToUtcMs(date) / 1000) + 12 * 3600;
const posted = (id: string, date: IsoDate, amount: string, description: string): SfTxn => ({ id, posted: unix(date), amount, description, pending: false });
const pending = (id: string, date: IsoDate, amount: string, description: string): SfTxn => ({ id, posted: 0, transacted_at: unix(date), amount, description, pending: true });
const payload = (asOf: IsoDate, transactions: SfTxn[]): SimplefinAccountSet => ({
  errors: [],
  errlist: [],
  accounts: [{ org: { name: "Bank" }, id: "CHK", name: "Everyday Checking", currency: "USD", balance: "100.00", "balance-date": unix(asOf), transactions }],
});
function fakeJob(p: Record<string, unknown>): JobRow {
  const now = new Date();
  return { id: randomUUID(), type: "simplefin.reprocess_transactions", payload: p, status: "running", runAt: now, attempts: 1, maxAttempts: 3, lockedBy: "test", lastError: null, createdAt: now, startedAt: now, finishedAt: null };
}

/**
 * Audit a5-ingest-transfers-13: stored sync payloads can be replayed for their transactions, so
 * an item an older reader or ingest missed is read again even when it is older than the
 * Bridge's 93-day window. A replay inserts only posted items the ledger lacks; it never inserts
 * a pending item, removes a pending row or changes a row the ledger has.
 */
describe.skipIf(!TEST_DATABASE_URL)("simplefin.reprocess_transactions (audit a5-ingest-transfers-13)", () => {
  let t: TestDb;
  let db: Db;
  let ctx: JobContext;
  let connectionId: string;
  let accountId: string;
  const now = new Date("2026-11-13T18:00:00Z");
  const config: WorkerConfig = { databaseUrl: "unused", secretsKey: generateSecretsKey(), workerId: "test-worker", syncIntervalHours: 6, pollIntervalMs: 10, initialWindowDays: 93, overlapDays: 7, requestTimeoutMs: 5000 } as WorkerConfig;
  const ledger = () =>
    db.select({ ext: transaction.externalId, amount: transaction.amountCents, pending: transaction.pending, importLogId: transaction.importLogId }).from(transaction).orderBy(asc(transaction.date), asc(transaction.externalId));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    const [conn] = await db.insert(connection).values({ type: "simplefin", name: "Bank", status: "ok" }).returning({ id: connection.id });
    connectionId = conn!.id;
    const [acct] = await db.insert(account).values({ connectionId, externalId: "CHK", name: "Everyday Checking", type: "checking", taxTreatment: "none" }).returning({ id: account.id });
    accountId = acct!.id;
    ctx = { db, config, client: {}, now: () => now, log: { info: () => {}, warn: () => {}, error: () => {} } };
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("inserts the posted items the ledger lacks, never a pending one, and a second run changes nothing", async () => {
    // Four months ago: a rent payment (lost by an older ingest), a coffee still pending, a grocery run.
    const old = payload("2026-07-02", [posted("RENT", "2026-07-01", "-1800.00", "ACH RENT PROPERTY CO"), pending("P-COF", "2026-07-02", "-4.50", "SQ *BLUE BOTTLE"), posted("GRO", "2026-07-02", "-54.10", "GROCERY OUTLET")]);
    const later = payload("2026-07-05", [posted("COF", "2026-07-02", "-4.50", "SQ *BLUE BOTTLE"), posted("GRO", "2026-07-02", "-56.10", "GROCERY OUTLET")]);
    const [l1, l2] = await db
      .insert(importLog)
      .values([
        { connectionId, kind: "simplefin.sync", status: "ok", startedAt: new Date("2026-07-02T18:00:00Z"), rawPayload: old },
        { connectionId, kind: "simplefin.sync", status: "ok", startedAt: new Date("2026-07-05T18:00:00Z"), rawPayload: later },
      ])
      .returning({ id: importLog.id });
    // What the ledger holds today: the coffee posted, the grocery run as the bank corrected it, split by the household.
    const [gro] = await db
      .insert(transaction)
      .values([
        { accountId, externalId: "COF", source: "simplefin", date: "2026-07-02", amountCents: -450n, rawDescription: "SQ *BLUE BOTTLE" },
        { accountId, externalId: "GRO", source: "simplefin", date: "2026-07-02", amountCents: -5610n, rawDescription: "GROCERY OUTLET" },
      ])
      .returning({ id: transaction.id })
      .then((rows) => [rows[1]!]);
    const [a, b] = await db.insert(category).values([
      { name: "Groceries (a5-13)", bucket: "spending", position: 70 },
      { name: "Household (a5-13)", bucket: "spending", position: 71 },
    ]).returning({ id: category.id });
    await setTransactionSplits(db, gro!.id, [
      { categoryId: a!.id, amountCents: -4000n },
      { categoryId: b!.id, amountCents: -1610n },
    ]);

    const queued = await enqueueJob(db, "simplefin.reprocess_transactions", { connectionId }, { dedupe: true });
    expect(queued.created).toBe(true);
    expect(await drainQueue(ctx)).toBe(1);
    expect((await db.select().from(job).where(eq(job.id, queued.id)))[0]).toMatchObject({ status: "done" });
    expect(await ledger()).toEqual([
      { ext: "RENT", amount: -180000n, pending: false, importLogId: l1!.id },
      { ext: "COF", amount: -450n, pending: false, importLogId: null },
      { ext: "GRO", amount: -5610n, pending: false, importLogId: null },
    ]);
    expect(await db.select().from(split).where(eq(split.transactionId, gro!.id))).toHaveLength(2);

    const again = await runReprocessTransactionsJob(ctx, fakeJob({ connectionId }));
    expect(again).toMatchObject({ payloads: 2, created: 0, updated: 0 });
    expect(await ledger()).toHaveLength(3);
    const summaries = await db.select().from(importLog).where(eq(importLog.kind, "simplefin.reprocess")).orderBy(asc(importLog.startedAt));
    expect(summaries).toHaveLength(2);
    expect(summaries[0]!.stats).toMatchObject({ payloads: 2, created: 1 });
    expect(typeof (await db.select().from(importLog).where(eq(importLog.id, l2!.id)))[0]!.stats!["transactionsReprocessedAt"]).toBe("number");

    // A row the household deleted is not brought back by a replay.
    const rent = (await db.select().from(transaction).where(eq(transaction.externalId, "RENT")))[0]!;
    await deleteTransaction(db, rent.id, { userId: null, batchId: randomUUID() });
    expect(await runReprocessTransactionsJob(ctx, fakeJob({ connectionId }))).toMatchObject({ created: 0, duplicates: 1 });
    expect(await ledger()).toHaveLength(2);
  });

  it("a5-ingest-transfers (second round): a response whose sync failed while it was applied is replayed too; one that is not an account set is passed over", async () => {
    // The worker stores a response before applying it; an older ingest crashed on this one, so the sync was marked failed.
    const crashed = payload("2026-08-03", [posted("ELEC", "2026-08-01", "-96.40", "XCEL ENERGY"), pending("P-GAS", "2026-08-03", "-30.00", "SHELL OIL")]);
    const [failed] = await db
      .insert(importLog)
      .values({ connectionId, kind: "simplefin.sync", status: "error", startedAt: new Date("2026-08-03T18:00:00Z"), rawPayload: crashed, message: "TypeError: cannot read properties of undefined" })
      .returning({ id: importLog.id });
    // A 502 page the Bridge sent instead of an account set, kept as it came.
    await db.insert(importLog).values({ connectionId, kind: "simplefin.sync", status: "error", startedAt: new Date("2026-08-04T18:00:00Z"), rawPayload: { notJson: "<html>502 Bad Gateway</html>" }, message: "not JSON" });
    const run = await runReprocessTransactionsJob(ctx, fakeJob({ connectionId }));
    expect(run).toMatchObject({ created: 1, payloadsFailedSync: 1, payloadsUnparseable: 0 });
    const elec = await db.select({ amount: transaction.amountCents, importLogId: transaction.importLogId }).from(transaction).where(eq(transaction.externalId, "ELEC"));
    expect(elec).toEqual([{ amount: -9640n, importLogId: failed!.id }]);
    expect(await db.select().from(transaction).where(eq(transaction.externalId, "P-GAS"))).toHaveLength(0);
    // Replayed once more, nothing changes.
    expect(await runReprocessTransactionsJob(ctx, fakeJob({ connectionId }))).toMatchObject({ created: 0, payloadsFailedSync: 1 });
    expect(await db.select().from(transaction).where(eq(transaction.externalId, "ELEC"))).toHaveLength(1);
  });

  it("a missing connection is a no-op", async () => {
    expect(await runReprocessTransactionsJob(ctx, fakeJob({ connectionId: randomUUID() }))).toMatchObject({ importLogId: null, payloads: 0 });
  });
});
