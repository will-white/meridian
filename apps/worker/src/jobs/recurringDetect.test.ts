import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, category, connection, enqueueJob, householdSetting, job, monthPlan, payee, recurring, resolvePayee, seedDefaultCategories, setRecurringStatus, transaction, type Db, type JobRow } from "@meridian/db";
import { createTestDb, FIXTURE_END, renderAccountSet, TEST_DATABASE_URL, type TestDb } from "@meridian/db/testing";
import { addDays, encryptSecret, generateSecretsKey, type IsoDate } from "@meridian/shared";
import type { WorkerConfig } from "../env.js";
import { drainQueue } from "../runner.js";
import { scheduleDailyJobs, scheduleDueSyncs } from "../scheduler.js";
import { runCloseMonthJob } from "./closeMonth.js";
import type { JobContext } from "./context.js";
import { runRecurringDetectJob } from "./recurringDetect.js";

/**
 * The Phase 2 worker pieces: `recurring.detect` and `plan.close_month` with `today` in
 * the household time zone, the scheduler's once-per-UTC-day tick, and the detect job a
 * full sync queues (recurring design C6; docs/phase-2-plan.md §16–17).
 */

const ACCESS = "https://alice:s3cret@bridge.example.test/simplefin";
const NETFLIX_DATES: IsoDate[] = ["2026-04-05", "2026-05-05", "2026-06-05", "2026-07-05", "2026-08-05", "2026-09-05"];

async function addTx(db: Db, input: { accountId: string; payeeName: string; date: IsoDate; cents: bigint }): Promise<string> {
  const p = await resolvePayee(db, input.payeeName);
  const [row] = await db
    .insert(transaction)
    .values({ accountId: input.accountId, source: "manual", date: input.date, amountCents: input.cents, payeeId: p.id, rawDescription: input.payeeName })
    .returning({ id: transaction.id });
  return row!.id;
}

/** A job row as the runner would hand it to a handler. */
function fakeJob(type: JobRow["type"], payload: Record<string, unknown>): JobRow {
  const now = new Date();
  return { id: "00000000-0000-0000-0000-000000000000", type, payload, status: "running", runAt: now, attempts: 1, maxAttempts: 3, lockedBy: "test", lastError: null, createdAt: now, startedAt: now, finishedAt: null };
}

describe.skipIf(!TEST_DATABASE_URL)("recurring.detect, plan.close_month and the daily tick", () => {
  let t: TestDb;
  let db: Db;
  let ctx: JobContext;
  let checking: string;
  let connectionId: string;
  const secretsKey = generateSecretsKey();
  // 03:30 UTC on the 14th is still the 13th in America/Denver (the default household time zone).
  let now = new Date("2026-10-14T03:30:00Z");
  const requests: URL[] = [];
  let nextResponse: () => Response = () => new Response("", { status: 500 });

  const config: WorkerConfig = {
    databaseUrl: "unused",
    secretsKey,
    workerId: "test-worker",
    syncIntervalHours: 6,
    pollIntervalMs: 10,
    initialWindowDays: 93,
    overlapDays: 7,
    requestTimeoutMs: 5000,
    detectHourUtc: 8,
  };

  const allJobs = () => db.select().from(job).orderBy(asc(job.createdAt), asc(job.id));
  const jobsOf = async (type: JobRow["type"]) => (await allJobs()).filter((j) => j.type === type);

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    await seedDefaultCategories(db);
    const [conn] = await db
      .insert(connection)
      .values({ type: "simplefin", name: "Bank", status: "ok", accessUrlEnc: await encryptSecret(ACCESS, secretsKey) })
      .returning({ id: connection.id });
    connectionId = conn!.id;
    const [acct] = await db
      .insert(account)
      .values({ connectionId, externalId: "MANUAL-CHK", name: "Checking", type: "checking", taxTreatment: "none" })
      .returning({ id: account.id });
    checking = acct!.id;
    ctx = {
      db,
      config,
      client: {
        fetch: (async (input: string | URL | Request) => {
          requests.push(new URL(String(input)));
          return nextResponse();
        }) as typeof fetch,
      },
      now: () => now,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("a seeded ledger produces suggestions through the job, with today taken in the household time zone", async () => {
    for (const date of NETFLIX_DATES) await addTx(db, { accountId: checking, payeeName: "Netflix", date, cents: -1549n });
    // TC6a: three coffees at three prices are not a bill.
    await addTx(db, { accountId: checking, payeeName: "Blue Bottle", date: "2026-09-02", cents: -475n });
    await addTx(db, { accountId: checking, payeeName: "Blue Bottle", date: "2026-09-19", cents: -610n });
    await addTx(db, { accountId: checking, payeeName: "Blue Bottle", date: "2026-10-07", cents: -380n });

    await enqueueJob(db, "recurring.detect", { reason: "manual" });
    expect(await drainQueue(ctx)).toBe(1);
    const [done] = await jobsOf("recurring.detect");
    expect(done).toMatchObject({ status: "done", lastError: null });

    const rows = await db.select({ row: recurring, payeeName: payee.name }).from(recurring).innerJoin(payee, eq(payee.id, recurring.payeeId));
    expect(rows).toHaveLength(1);
    const netflix = rows[0]!.row;
    expect(rows[0]!.payeeName).toBe("Netflix");
    // TC1: monthly on the 5th, 10000 bp, fixed −1549 ± 100, next due 2026-10-05.
    expect(netflix).toMatchObject({
      status: "suggested",
      source: "detected",
      cadence: "monthly",
      anchorDay: 5,
      expectedCents: -1549n,
      toleranceCents: 100n,
      amountMode: "fixed",
      confidence: 100,
      chargeCount: 6,
      firstChargeDate: "2026-04-05",
      lastChargeDate: "2026-09-05",
      lastChargeCents: -1549n,
      nextDueDate: "2026-10-05",
      accountId: checking,
      detectedAt: now,
    });
    const linked = await db.select({ id: transaction.id }).from(transaction).where(eq(transaction.recurringId, netflix.id));
    expect(linked).toHaveLength(6);

    // The handler reports the household date it used: 2026-10-13 in Denver, 2026-10-14 in Auckland.
    const again = await runRecurringDetectJob(ctx, fakeJob("recurring.detect", { reason: "nightly" }));
    expect(again).toMatchObject({ reason: "nightly", today: "2026-10-13", groups: 2, suggestionsCreated: 0, suggestionsUpdated: 1, suggestionsDeleted: 0, groupsSkipped: 0, alertsCreated: 0 });
    await db.update(householdSetting).set({ timezone: "Pacific/Auckland" }).where(eq(householdSetting.id, 1));
    expect((await runRecurringDetectJob(ctx, fakeJob("recurring.detect", {}))).today).toBe("2026-10-14");
    await db.update(householdSetting).set({ timezone: "America/Denver" }).where(eq(householdSetting.id, 1));
    expect(await db.select().from(recurring)).toHaveLength(1);
  });

  it("the scheduler queues recurring.detect and plan.close_month once per UTC day, at or after the detect hour", async () => {
    await db.delete(job);
    now = new Date("2026-10-13T07:59:59Z");
    expect(await scheduleDailyJobs(ctx)).toBe(0);
    expect(await allJobs()).toHaveLength(0);

    now = new Date("2026-10-13T08:00:00Z");
    expect(await scheduleDailyJobs(ctx)).toBe(2);
    expect(await scheduleDailyJobs(ctx)).toBe(0);
    let queued = await allJobs();
    expect(queued.map((j) => [j.type, j.status, j.payload])).toEqual([
      ["recurring.detect", "queued", { reason: "nightly", day: "2026-10-13" }],
      ["plan.close_month", "queued", { reason: "nightly", day: "2026-10-13" }],
    ]);

    // Both run; the same day never queues again, even late in the day or after they finished.
    expect(await drainQueue(ctx)).toBe(2);
    expect((await allJobs()).map((j) => j.status)).toEqual(["done", "done"]);
    now = new Date("2026-10-13T23:59:00Z");
    expect(await scheduleDailyJobs(ctx)).toBe(0);

    // A sync-triggered detect still queued on the next day holds the nightly detect back (dedupe) until the next tick after it ran.
    now = new Date("2026-10-14T08:00:00Z");
    await enqueueJob(db, "recurring.detect", { reason: "sync" });
    expect(await scheduleDailyJobs(ctx)).toBe(1);
    queued = (await allJobs()).filter((j) => j.status === "queued");
    expect(queued.map((j) => [j.type, j.payload])).toEqual([
      ["recurring.detect", { reason: "sync" }],
      ["plan.close_month", { reason: "nightly", day: "2026-10-14" }],
    ]);
    expect(await drainQueue(ctx)).toBe(2);
    expect(await scheduleDailyJobs(ctx)).toBe(1);
    expect((await allJobs()).filter((j) => j.status === "queued").map((j) => [j.type, j.payload])).toEqual([["recurring.detect", { reason: "nightly", day: "2026-10-14" }]]);
    expect(await scheduleDailyJobs(ctx)).toBe(0);
    expect(await drainQueue(ctx)).toBe(1);

    // The hour is configurable.
    now = new Date("2026-10-15T02:00:00Z");
    expect(await scheduleDailyJobs({ ...ctx, config: { ...config, detectHourUtc: 3 } })).toBe(0);
    expect(await scheduleDailyJobs({ ...ctx, config: { ...config, detectHourUtc: 2 } })).toBe(2);
    expect(await drainQueue(ctx)).toBe(2);
    expect((await allJobs()).every((j) => j.status === "done")).toBe(true);
  });

  it("plan.close_month freezes the auto-planned bills through the household's previous month", async () => {
    const [netflix] = await db.select().from(recurring);
    const [subscriptions] = await db.select({ id: category.id }).from(category).where(eq(category.name, "Subscriptions"));
    await db.update(recurring).set({ categoryId: subscriptions!.id }).where(eq(recurring.id, netflix!.id));
    await setRecurringStatus(db, netflix!.id, "active", { today: "2026-10-13", now: new Date("2026-10-13T08:00:00Z") });

    now = new Date("2026-10-14T03:30:00Z"); // 2026-10-13 in Denver → through 2026-09
    const outcome = await runCloseMonthJob(ctx, fakeJob("plan.close_month", { reason: "nightly", day: "2026-10-14" }));
    expect(outcome).toMatchObject({ today: "2026-10-13", through: "2026-09" });
    expect(outcome.inserted).toBeGreaterThan(0);
    const frozen = await db
      .select({ month: monthPlan.month, plannedCents: monthPlan.plannedCents, plannedSource: monthPlan.plannedSource })
      .from(monthPlan)
      .where(eq(monthPlan.categoryId, subscriptions!.id))
      .orderBy(asc(monthPlan.month));
    expect(frozen[frozen.length - 1]).toEqual({ month: "2026-09", plannedCents: 1549n, plannedSource: "recurring" });
    expect(frozen.every((r) => r.month <= "2026-09")).toBe(true);

    // Idempotent, and a requested month never reaches the current one.
    expect(await runCloseMonthJob(ctx, fakeJob("plan.close_month", { reason: "nightly" }))).toEqual({ today: "2026-10-13", through: "2026-09", inserted: 0 });
    expect(await runCloseMonthJob(ctx, fakeJob("plan.close_month", { through: "2027-03" }))).toEqual({ today: "2026-10-13", through: "2026-09", inserted: 0 });
    expect((await runCloseMonthJob(ctx, fakeJob("plan.close_month", { through: "2026-08" }))).through).toBe("2026-08");
  });

  it("a successful full sync queues a detect job; balances-only refreshes and failed syncs do not", async () => {
    await db.delete(job);
    now = new Date(`${FIXTURE_END}T12:00:00Z`);
    nextResponse = () => new Response(JSON.stringify(renderAccountSet({ start: addDays(FIXTURE_END, -93), asOf: FIXTURE_END })), { status: 200 });
    await enqueueJob(db, "simplefin.sync", { connectionId });
    // The sync queues the detect job and the same drain runs it.
    expect(await drainQueue(ctx)).toBe(2);
    expect((await allJobs()).map((j) => [j.type, j.status, j.payload["reason"] ?? null])).toEqual([
      ["simplefin.sync", "done", null],
      ["recurring.detect", "done", "sync"],
    ]);
    expect(requests).toHaveLength(1);

    await enqueueJob(db, "simplefin.balances", { connectionId });
    expect(await drainQueue(ctx)).toBe(1);
    expect(await jobsOf("recurring.detect")).toHaveLength(1);

    nextResponse = () => new Response("", { status: 503 });
    await enqueueJob(db, "simplefin.sync", { connectionId });
    expect(await drainQueue(ctx)).toBe(1);
    expect(await jobsOf("recurring.detect")).toHaveLength(1);
    expect((await jobsOf("simplefin.sync")).map((j) => j.status)).toEqual(["done", "queued"]);

    // The Phase 1 sync scheduler is untouched: nothing is due right after a sync.
    expect(await scheduleDueSyncs(ctx)).toBe(0);
  });
});
