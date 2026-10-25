import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enqueueJob, householdSetting, job, transaction, type Db, type JobRow } from "@meridian/db";
import { createTestDb, INV_SEED_NOW, seedInvestmentFixture, TEST_DATABASE_URL, type InvestmentSeed, type TestDb } from "@meridian/db/testing";
import { generateSecretsKey } from "@meridian/shared";
import type { WorkerConfig } from "../env.js";
import { drainQueue } from "../runner.js";
import type { JobContext } from "./context.js";
import { runInvestmentIncomeFeedJob } from "./investmentIncomeFeed.js";

/** `investments.income_feed` runs the feed service over every account with a feed (plan decision 13); on the INV seed B links its seven bank twins. */

function fakeJob(payload: Record<string, unknown>): JobRow {
  const now = new Date();
  return { id: "00000000-0000-0000-0000-000000000000", type: "investments.income_feed", payload, status: "running", runAt: now, attempts: 1, maxAttempts: 3, lockedBy: "test", lastError: null, createdAt: now, startedAt: now, finishedAt: null };
}

describe.skipIf(!TEST_DATABASE_URL)("investments.income_feed", () => {
  let t: TestDb;
  let db: Db;
  let S: InvestmentSeed;
  let ctx: JobContext;
  const config: WorkerConfig = { databaseUrl: "unused", secretsKey: generateSecretsKey(), workerId: "test-worker", syncIntervalHours: 6, pollIntervalMs: 10, initialWindowDays: 93, overlapDays: 7, requestTimeoutMs: 5000 };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    S = await seedInvestmentFixture(db);
    ctx = { db, config, client: {}, now: () => INV_SEED_NOW, log: { info: () => {}, warn: () => {}, error: () => {} } };
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("categorizes the bank twins of B's dividends and interest into the household category, then changes nothing", async () => {
    const first = await runInvestmentIncomeFeedJob(ctx, fakeJob({ reason: "nightly", day: "2026-10-14", dedupeKey: "investments.income_feed" }));
    expect(first).toEqual({ reason: "nightly", categorized: 7, created: 0, upgraded: 0, awaiting: 0, unchanged: 0, deleted: 0, skipped: 0 });
    const [row] = await db.select({ categoryId: transaction.categoryId }).from(transaction).where(eq(transaction.id, S.ledger["divVtiSep"]!));
    expect(row!.categoryId).toBe(S.categories.dividends);
    expect(await runInvestmentIncomeFeedJob(ctx, fakeJob({ reason: "sync" }))).toMatchObject({ reason: "sync", categorized: 0, unchanged: 7 });
  });

  it("runs from the queue under its shared key, and reports an account whose household category is missing", async () => {
    await enqueueJob(db, "investments.income_feed", { reason: "setting", accountId: S.accounts.brokerage, dedupeKey: "investments.income_feed" }, { dedupe: true });
    expect((await enqueueJob(db, "investments.income_feed", { reason: "trades", dedupeKey: "investments.income_feed" }, { dedupe: true })).created).toBe(false);
    expect(await drainQueue(ctx)).toBe(1);
    expect((await db.select().from(job))[0]).toMatchObject({ type: "investments.income_feed", status: "done" });

    await db.update(householdSetting).set({ investmentIncomeCategoryId: null }).where(eq(householdSetting.id, 1));
    expect(await runInvestmentIncomeFeedJob(ctx, fakeJob({ reason: "manual" }))).toMatchObject({ categorized: 0, unchanged: 0, skipped: 1 });
  });
});
