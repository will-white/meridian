import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, balanceSnapshot, enqueueJob, job, type Db, type JobRow } from "@meridian/db";
import { createTestDb, INV_SEED_NOW, seedInvestmentFixture, seedInvestmentLots, TEST_DATABASE_URL, type InvestmentSeed, type TestDb } from "@meridian/db/testing";
import { generateSecretsKey } from "@meridian/shared";
import type { WorkerConfig } from "../env.js";
import { drainQueue } from "../runner.js";
import type { JobContext } from "./context.js";
import { runInvestmentsValuationJob } from "./investmentsValuation.js";

/**
 * `investments.valuation` on the INV seed (plan decision 9): computed balance rows from the
 * chain after each account's last reported row through the expected price date. Hand values
 * (views §7.0 / step 8): R is anchored on its 10-09 csv statement (1 810 000) and repriced
 * 1 816 000 on 10-12 and 1 820 000 on 10-13 (10-10 and 10-11 carry 10-09's closes); B's last
 * reported row is 10-13 (2 705 200), so nothing is due until the clock moves on.
 */

function fakeJob(payload: Record<string, unknown>): JobRow {
  const now = new Date();
  return { id: "00000000-0000-0000-0000-000000000000", type: "investments.valuation", payload, status: "running", runAt: now, attempts: 1, maxAttempts: 3, lockedBy: "test", lastError: null, createdAt: now, startedAt: now, finishedAt: null };
}

describe.skipIf(!TEST_DATABASE_URL)("investments.valuation", () => {
  let t: TestDb;
  let db: Db;
  let S: InvestmentSeed;
  let ctx: JobContext;
  let now = INV_SEED_NOW;
  const config: WorkerConfig = { databaseUrl: "unused", secretsKey: generateSecretsKey(), workerId: "test-worker", syncIntervalHours: 6, pollIntervalMs: 10, initialWindowDays: 93, overlapDays: 7, requestTimeoutMs: 5000 };
  const rowsOf = (accountId: string) =>
    db
      .select({ date: balanceSnapshot.date, balanceCents: balanceSnapshot.balanceCents, source: balanceSnapshot.source })
      .from(balanceSnapshot)
      .where(eq(balanceSnapshot.accountId, accountId))
      .orderBy(asc(balanceSnapshot.date));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    S = await seedInvestmentFixture(db);
    await seedInvestmentLots(db, S);
    ctx = { db, config, client: {}, now: () => now, log: { info: () => {}, warn: () => {}, error: () => {} } };
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("writes the Roth's computed rows after its 10-09 statement and leaves the up-to-date brokerage alone", async () => {
    const outcome = await runInvestmentsValuationJob(ctx, fakeJob({ reason: "prices", dedupeKey: "investments.valuation" }));
    expect(outcome).toMatchObject({ reason: "prices", today: "2026-10-14", expectedThrough: "2026-10-13", through: "2026-10-13", accounts: 1, written: 2, kept: 2, removed: 0 });
    expect(outcome.skipped).toEqual([{ accountId: S.accounts.brokerage, reason: "up_to_date" }]);
    expect(await rowsOf(S.accounts.roth)).toEqual([
      { date: "2025-10-13", balanceCents: 1500000n, source: "manual" },
      { date: "2026-10-09", balanceCents: 1810000n, source: "csv" },
      { date: "2026-10-10", balanceCents: 1810000n, source: "computed" },
      { date: "2026-10-11", balanceCents: 1810000n, source: "computed" },
      { date: "2026-10-12", balanceCents: 1816000n, source: "computed" },
      { date: "2026-10-13", balanceCents: 1820000n, source: "computed" },
    ]);
    // The brokerage's reported rows are untouched, and so is the account's own (reported) balance.
    expect((await rowsOf(S.accounts.brokerage)).map((r) => r.source)).toEqual(["simplefin", "simplefin", "simplefin", "simplefin"]);
    const [roth] = await db.select({ balanceCents: account.balanceCents, balanceDate: account.balanceDate }).from(account).where(eq(account.id, S.accounts.roth));
    expect(roth).toEqual({ balanceCents: 1810000n, balanceDate: "2026-10-09" });
    // Checking is not an investment account: no rows beyond the seed's.
    expect(await rowsOf(S.accounts.checking)).toEqual([{ date: "2026-10-13", balanceCents: 500000n, source: "manual" }]);
  });

  it("is idempotent, corrects a wrong computed row, and never overwrites a reported one", async () => {
    expect(await runInvestmentsValuationJob(ctx, fakeJob({ reason: "prices" }))).toMatchObject({ written: 0, kept: 4, removed: 0 });

    await db
      .update(balanceSnapshot)
      .set({ balanceCents: 9999999n })
      .where(and(eq(balanceSnapshot.accountId, S.accounts.roth), eq(balanceSnapshot.date, "2026-10-12")));
    expect(await runInvestmentsValuationJob(ctx, fakeJob({ reason: "snapshot", accountId: S.accounts.roth }))).toMatchObject({ accounts: 1, written: 1, kept: 3 });
    expect((await rowsOf(S.accounts.roth)).find((r) => r.date === "2026-10-12")).toEqual({ date: "2026-10-12", balanceCents: 1816000n, source: "computed" });

    // A statement the owner checked on 10-11 becomes the last reported row: the window starts after it and the row stays.
    await db
      .update(balanceSnapshot)
      .set({ balanceCents: 1000000n, source: "manual" })
      .where(and(eq(balanceSnapshot.accountId, S.accounts.roth), eq(balanceSnapshot.date, "2026-10-11")));
    const outcome = await runInvestmentsValuationJob(ctx, fakeJob({ reason: "reconcile", accountId: S.accounts.roth }));
    expect(outcome).toMatchObject({ accounts: 1, written: 0, kept: 2, removed: 0 });
    const rows = await rowsOf(S.accounts.roth);
    expect(rows.find((r) => r.date === "2026-10-11")).toEqual({ date: "2026-10-11", balanceCents: 1000000n, source: "manual" });
    expect(rows.find((r) => r.date === "2026-10-10")).toEqual({ date: "2026-10-10", balanceCents: 1810000n, source: "computed" });
    expect(rows.slice(-2)).toEqual([
      { date: "2026-10-12", balanceCents: 1816000n, source: "computed" },
      { date: "2026-10-13", balanceCents: 1820000n, source: "computed" },
    ]);
  });

  it("a payload naming an up-to-date, unknown or non-investment account is a skip, never a failure", async () => {
    expect(await runInvestmentsValuationJob(ctx, fakeJob({ reason: "snapshot", accountId: S.accounts.brokerage }))).toMatchObject({ accounts: 0, written: 0, skipped: [{ accountId: S.accounts.brokerage, reason: "up_to_date" }] });
    const ghost = "11111111-1111-4111-8111-111111111111";
    expect((await runInvestmentsValuationJob(ctx, fakeJob({ reason: "snapshot", accountId: ghost }))).skipped).toEqual([{ accountId: ghost, reason: "unknown_account" }]);
    expect((await runInvestmentsValuationJob(ctx, fakeJob({ reason: "snapshot", accountId: S.accounts.checking }))).skipped).toEqual([{ accountId: S.accounts.checking, reason: "unknown_account" }]);
  });

  it("two days later both accounts carry forward through the new expected close, and the queue runs it deduped", async () => {
    now = new Date("2026-10-16T18:00:00Z"); // Friday 14:00 in New York: the expected close is Thursday 10-15.
    await enqueueJob(db, "investments.valuation", { reason: "prices", dedupeKey: "investments.valuation" }, { dedupe: true });
    const again = await enqueueJob(db, "investments.valuation", { reason: "snapshot", dedupeKey: "investments.valuation" }, { dedupe: true });
    expect(again.created).toBe(false);
    expect(await drainQueue(ctx)).toBe(1);
    expect((await db.select().from(job))[0]).toMatchObject({ type: "investments.valuation", status: "done" });
    expect((await rowsOf(S.accounts.brokerage)).slice(-2)).toEqual([
      { date: "2026-10-14", balanceCents: 2705200n, source: "computed" },
      { date: "2026-10-15", balanceCents: 2705200n, source: "computed" },
    ]);
    expect((await rowsOf(S.accounts.roth)).slice(-2)).toEqual([
      { date: "2026-10-14", balanceCents: 1820000n, source: "computed" },
      { date: "2026-10-15", balanceCents: 1820000n, source: "computed" },
    ]);
  });
});
