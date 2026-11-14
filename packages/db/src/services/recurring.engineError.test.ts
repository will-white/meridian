import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChargeLike, IsoDate } from "@meridian/shared";
import { account, category, payee, recurring, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { seedDefaultCategories } from "./categories.js";
import { resolvePayee } from "./payees.js";
import { runRecurringDetection, setRecurringStatus, updateRecurring } from "./recurring.js";

/**
 * C1's contract for an engine error, kept for the detection of a resubscription (audit
 * b5-recurring-cashflow-05, second round): that detection runs inside `upsertDetections`, and
 * when the pure engine throws there the payee is skipped and its rows are left untouched, as
 * when it throws for the whole group. The engine is mocked to throw for a group of charges that
 * are all dated after the cancel, which only the resubscription phase asks for.
 */

const engine = vi.hoisted(() => ({ throwAfter: null as string | null }));

vi.mock("@meridian/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meridian/shared")>();
  return {
    ...actual,
    detectRecurring: (group: readonly ChargeLike[], today: IsoDate) => {
      if (engine.throwAfter !== null && group.length > 0 && group.every((c) => c.date > engine.throwAfter!)) throw new Error("engine failure");
      return actual.detectRecurring(group, today);
    },
  };
});

const at = (iso: string): Date => new Date(iso);

describe.skipIf(!TEST_DATABASE_URL)("b5-05 (second round): an engine error while detecting a resubscription skips the payee", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("logs the payee, counts it skipped, keeps its rows and finishes the run for the others", async () => {
    const db = t.db;
    await seedDefaultCategories(db);
    const [checking] = await db.insert(account).values({ name: "Checking", type: "checking", taxTreatment: "none", balanceCents: 500000n, balanceDate: "2026-10-01" }).returning({ id: account.id });
    const [subscriptions] = await db.select({ id: category.id }).from(category).where(eq(category.name, "Subscriptions"));
    const add = async (name: string, date: IsoDate, cents: bigint) => {
      const p = await resolvePayee(db, name);
      await db.insert(transaction).values({ accountId: checking!.id, source: "manual", date, amountCents: cents, payeeId: p.id, rawDescription: name });
    };
    for (const date of ["2026-03-05", "2026-04-05", "2026-05-05", "2026-06-05", "2026-07-05", "2026-08-05"] as IsoDate[]) await add("Netflix", date, -1549n);
    await runRecurringDetection(db, { today: "2026-08-06", now: at("2026-08-06T08:00:00Z") });
    const [item] = await db.select().from(recurring);
    await updateRecurring(db, item!.id, { categoryId: subscriptions!.id, status: "active" }, "2026-08-06", at("2026-08-06T09:00:00Z"));
    await setRecurringStatus(db, item!.id, "cancelled", { today: "2026-08-10", now: at("2026-08-10T12:00:00Z") });
    for (const date of ["2026-11-20", "2026-12-20", "2027-01-20"] as IsoDate[]) await add("Netflix", date, -1549n);
    // Another payee, billed since before the cancel date, so the mock leaves its group alone.
    for (const date of ["2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01", "2027-01-01"] as IsoDate[]) await add("Spotify", date, -1199n);
    const before = await db.select().from(recurring).where(eq(recurring.id, item!.id));

    engine.throwAfter = "2026-08-10";
    const errors: string[] = [];
    try {
      const stats = await runRecurringDetection(db, { today: "2027-01-22", now: at("2027-01-22T08:00:00Z"), onGroupError: (payeeId, error) => errors.push(`${payeeId}: ${(error as Error).message}`) });
      expect(stats).toMatchObject({ groupsSkipped: 1, suggestionsCreated: 1 });
    } finally {
      engine.throwAfter = null;
    }
    expect(errors).toEqual([`${item!.payeeId}: engine failure`]);
    const rows = await db.select({ name: payee.name, status: recurring.status }).from(recurring).innerJoin(payee, eq(payee.id, recurring.payeeId)).orderBy(asc(payee.name));
    expect(rows).toEqual([
      { name: "Netflix", status: "cancelled" },
      { name: "Spotify", status: "suggested" },
    ]);
    expect(await db.select().from(recurring).where(eq(recurring.id, item!.id))).toEqual(before);
  });
});
