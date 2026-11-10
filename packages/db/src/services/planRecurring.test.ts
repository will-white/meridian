import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IsoDate, MonthKey, PlanCategoryRowResult, PlanResult } from "@meridian/shared";
import type { Db } from "../index.js";
import { account, category, monthPlan, recurring, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { seedDefaultCategories } from "./categories.js";
import { closeMonth } from "./closeMonth.js";
import { resolvePayee } from "./payees.js";
import { getPlan } from "./plan.js";
import { createManualRecurring, runRecurringDetection, updateRecurring } from "./recurring.js";

/**
 * Auto-planned values follow what actually happened: a linked charge plans its occurrence in
 * the month the charge posted, only an active item's awaited occurrences are planned ahead,
 * and a completed month keeps what was paid in it. Every expectation is worked by hand in the
 * comments beside it.
 */

const noon = (date: IsoDate): Date => new Date(`${date}T19:00:00Z`);

interface World {
  t: TestDb;
  db: Db;
  checking: string;
  visa: string;
  cat: (name: string) => string;
}

async function world(): Promise<World> {
  const t = await createTestDb();
  await seedDefaultCategories(t.db);
  const rows = await t.db
    .insert(account)
    .values([
      { name: "Checking", type: "checking", taxTreatment: "none", onBudget: true },
      { name: "Visa", type: "credit", taxTreatment: "none", onBudget: true },
    ])
    .returning({ id: account.id, name: account.name });
  const cats = await t.db.select({ id: category.id, name: category.name }).from(category);
  return {
    t,
    db: t.db,
    checking: rows.find((r) => r.name === "Checking")!.id,
    visa: rows.find((r) => r.name === "Visa")!.id,
    cat: (name) => cats.find((c) => c.name === name)!.id,
  };
}

async function charge(w: World, accountId: string, payee: string, date: IsoDate, cents: bigint, categoryName: string): Promise<string> {
  const p = await resolvePayee(w.db, payee);
  const [row] = await w.db
    .insert(transaction)
    .values({ accountId, source: "manual", date, amountCents: cents, payeeId: p.id, rawDescription: payee, categoryId: w.cat(categoryName) })
    .returning({ id: transaction.id });
  return row!.id;
}

function cellOf(plan: PlanResult, categoryId: string, month: MonthKey) {
  const row = plan.rows.find((r): r is PlanCategoryRowResult => r.kind === "category" && r.categoryId === categoryId);
  const cell = row?.cells[plan.months.indexOf(month)];
  if (!cell) throw new Error(`no cell ${categoryId} ${month}`);
  return cell;
}

function summaryOf(plan: PlanResult, month: MonthKey) {
  const s = plan.summary[plan.months.indexOf(month)];
  if (!s) throw new Error(`no summary ${month}`);
  return s;
}

describe.skipIf(!TEST_DATABASE_URL)("auto-planned occurrences when charges post in the neighbouring month", () => {
  let w: World;
  let salary: string;
  let rent: string;

  beforeAll(async () => {
    w = await world();
    // Salary on the 1st and the 15th (paid the Friday before a weekend), rent on the 1st (taken a day late or a few days early).
    await charge(w, w.checking, "Acme Payroll", "2026-01-02", 300000n, "Paycheck");
    salary = await w.db.transaction((tx) =>
      createManualRecurring(
        tx,
        { name: "Salary", payeeName: "Acme Payroll", categoryId: w.cat("Paycheck"), accountId: w.checking, cadence: "twice_monthly", anchorDay: 1, anchorDay2: 15, expectedCents: 300000n },
        "2026-01-02",
        { now: noon("2026-01-02") },
      ),
    );
    rent = await w.db.transaction((tx) =>
      createManualRecurring(
        tx,
        { name: "Rent", payeeName: "Landlord", categoryId: w.cat("Rent / Mortgage"), accountId: w.checking, cadence: "monthly", anchorDay: 1, expectedCents: -150000n },
        "2026-01-02",
        { now: noon("2026-01-02") },
      ),
    );
  });
  afterAll(async () => {
    await w?.t.cleanup();
  });

  async function step(today: IsoDate, charges: Array<[IsoDate, bigint, string, string]>): Promise<void> {
    for (const [date, cents, payee, categoryName] of charges) await charge(w, w.checking, payee, date, cents, categoryName);
    await runRecurringDetection(w.db, { today, now: noon(today) });
  }

  it("plans the first occurrence when its charge posts a day after the scheduled date", async () => {
    await step("2026-01-16", [
      ["2026-01-15", 300000n, "Acme Payroll", "Paycheck"],
      ["2026-01-02", -150000n, "Landlord", "Rent / Mortgage"],
    ]);
    const plan = await getPlan(w.db, { from: "2026-01", to: "2026-02", today: "2026-01-16" });
    // Rent due Jan 1 was taken on Jan 2: one occurrence, planned and paid in January.
    expect(cellOf(plan, w.cat("Rent / Mortgage"), "2026-01")).toMatchObject({ plannedCents: 150000n, actualCents: 150000n, remainingCents: 0n, source: "recurring", overspent: false });
    // Salary: the Jan 1 pay arrived Jan 2 and the Jan 15 pay on the day: 2 x 3,000.00.
    expect(cellOf(plan, w.cat("Paycheck"), "2026-01")).toMatchObject({ plannedCents: 600000n, actualCents: 600000n, source: "recurring" });
    // February still expects both paydays and the rent.
    expect(cellOf(plan, w.cat("Paycheck"), "2026-02").plannedCents).toBe(600000n);
    expect(cellOf(plan, w.cat("Rent / Mortgage"), "2026-02").plannedCents).toBe(150000n);
  });

  it("moves an occurrence to the month its charge posted in, for income and for bills", async () => {
    await step("2026-01-31", [
      ["2026-01-30", 300000n, "Acme Payroll", "Paycheck"], // the Feb 1 pay, a Sunday, paid Friday
      ["2026-01-30", -150000n, "Landlord", "Rent / Mortgage"], // the Feb 1 rent
    ]);
    await step("2026-02-14", [["2026-02-13", 300000n, "Acme Payroll", "Paycheck"]]);
    await step("2026-02-28", [
      ["2026-02-27", 300000n, "Acme Payroll", "Paycheck"], // the Mar 1 pay
      ["2026-02-27", -150000n, "Landlord", "Rent / Mortgage"], // the Mar 1 rent
    ]);
    await step("2026-03-20", [["2026-03-13", 300000n, "Acme Payroll", "Paycheck"]]);

    const [s] = await w.db.select().from(recurring).where(eq(recurring.id, salary));
    const [r] = await w.db.select().from(recurring).where(eq(recurring.id, rent));
    expect([s!.nextDueDate, s!.chargeCount, r!.nextDueDate, r!.chargeCount]).toEqual(["2026-04-01", 6, "2026-04-01", 3]);

    const plan = await getPlan(w.db, { from: "2026-01", to: "2026-04", today: "2026-03-20" });
    const months: MonthKey[] = ["2026-01", "2026-02", "2026-03", "2026-04"];
    // Paychecks by posting month: Jan 2, 15, 30 | Feb 13, 27 | Mar 13 | Apr 1 and 15 still to come.
    expect(months.map((m) => cellOf(plan, w.cat("Paycheck"), m).plannedCents)).toEqual([900000n, 600000n, 300000n, 600000n]);
    expect(months.map((m) => cellOf(plan, w.cat("Paycheck"), m).actualCents)).toEqual([900000n, 600000n, 300000n, 0n]);
    // Rent by posting month: Jan 2 and Jan 30 | Feb 27 | none in March | Apr 1 still to come.
    expect(months.map((m) => cellOf(plan, w.cat("Rent / Mortgage"), m).plannedCents)).toEqual([300000n, 150000n, 0n, 150000n]);
    expect(months.map((m) => cellOf(plan, w.cat("Rent / Mortgage"), m).actualCents)).toEqual([300000n, 150000n, 0n, 0n]);

    // March: one paycheck of 3,000.00 came in and no rent is left to pay: 3,000.00 over 12 days.
    const march = summaryOf(plan, "2026-03");
    expect(march.committed.income).toBe(300000n);
    expect(march.committed.bills).toBe(0n);
    expect(march.leftToSpendCents).toBe(300000n);
    expect(march.pace).toEqual({ daysLeft: 12, perDayCents: 25000n, overCents: 0n });
  });

  it("freezes a completed month at what was paid in it", async () => {
    expect(await closeMonth(w.db, "2026-02", { today: "2026-03-20" })).toEqual({ inserted: 4, through: "2026-02" });
    const rows = await w.db.select().from(monthPlan);
    const frozen = Object.fromEntries(rows.map((x) => [`${x.month}|${x.categoryId}`, [x.plannedCents, x.plannedSource]]));
    expect(frozen[`2026-01|${w.cat("Paycheck")}`]).toEqual([900000n, "recurring"]);
    expect(frozen[`2026-02|${w.cat("Paycheck")}`]).toEqual([600000n, "recurring"]);
    expect(frozen[`2026-01|${w.cat("Rent / Mortgage")}`]).toEqual([300000n, "recurring"]);
    expect(frozen[`2026-02|${w.cat("Rent / Mortgage")}`]).toEqual([150000n, "recurring"]);
  });

  it("keeps an unpaid bill planned in its own month and counts it once when it posts late", async () => {
    // April 3: the Apr 1 rent has not posted yet, so April still plans it.
    await step("2026-04-03", [["2026-04-01", 300000n, "Acme Payroll", "Paycheck"]]);
    let plan = await getPlan(w.db, { from: "2026-03", to: "2026-05", today: "2026-04-03" });
    expect(cellOf(plan, w.cat("Rent / Mortgage"), "2026-04")).toMatchObject({ plannedCents: 150000n, actualCents: 0n });

    // The April rent posted on Apr 4. On May 2 the May 1 rent is a day late: April has its one rent, May and June one each.
    await step("2026-04-30", [["2026-04-04", -150000n, "Landlord", "Rent / Mortgage"]]);
    await step("2026-05-02", []);
    plan = await getPlan(w.db, { from: "2026-04", to: "2026-06", today: "2026-05-02" });
    expect(["2026-04", "2026-05", "2026-06"].map((m) => cellOf(plan, w.cat("Rent / Mortgage"), m).plannedCents)).toEqual([150000n, 150000n, 150000n]);

    // The late May rent posts on May 3 and is still one May bill.
    await step("2026-05-04", [["2026-05-03", -150000n, "Landlord", "Rent / Mortgage"]]);
    plan = await getPlan(w.db, { from: "2026-04", to: "2026-06", today: "2026-05-04" });
    expect(cellOf(plan, w.cat("Rent / Mortgage"), "2026-05")).toMatchObject({ plannedCents: 150000n, actualCents: 150000n, remainingCents: 0n });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("a bill due at the end of a month that posts in the next one", () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
    await charge(w, w.checking, "Old", "2027-01-03", -500n, "Shopping");
    await w.db.transaction((tx) =>
      createManualRecurring(
        tx,
        { name: "Water", payeeName: "City Water", categoryId: w.cat("Utilities"), accountId: w.checking, cadence: "monthly", anchorDay: 30, expectedCents: -9000n },
        "2027-01-05",
        { now: noon("2027-01-05") },
      ),
    );
  });
  afterAll(async () => {
    await w?.t.cleanup();
  });

  it("is not frozen into the closed month while it is still awaited, and lands in the month it posted", async () => {
    // Feb 1: the Jan 30 bill has not posted. It is overdue but inside the 5 days of grace.
    await runRecurringDetection(w.db, { today: "2027-02-01", now: noon("2027-02-01") });
    let plan = await getPlan(w.db, { from: "2027-01", to: "2027-02", today: "2027-02-01" });
    // January is over and nothing was paid in it; February holds the overdue bill and its own (Feb 28).
    expect(["2027-01", "2027-02"].map((m) => cellOf(plan, w.cat("Utilities"), m).plannedCents)).toEqual([0n, 18000n]);
    // The nightly close leaves the category alone while the item still awaits a January occurrence.
    expect(await closeMonth(w.db, "2027-01", { today: "2027-02-01" })).toEqual({ inserted: 0, through: "2027-01" });

    // Feb 2: the bill posts dated Feb 2. It is a February outflow; January stays empty and can freeze (nothing to write).
    await charge(w, w.checking, "City Water", "2027-02-02", -9000n, "Utilities");
    await runRecurringDetection(w.db, { today: "2027-02-03", now: noon("2027-02-03") });
    plan = await getPlan(w.db, { from: "2027-01", to: "2027-02", today: "2027-02-03" });
    expect(["2027-01", "2027-02"].map((m) => cellOf(plan, w.cat("Utilities"), m).plannedCents)).toEqual([0n, 18000n]);
    expect(cellOf(plan, w.cat("Utilities"), "2027-02")).toMatchObject({ actualCents: 9000n, remainingCents: 9000n });
    expect(summaryOf(plan, "2027-01").committed.bills).toBe(0n);
  });

  it("a charge dated in the closed month that syncs late is planned in that month and then frozen", async () => {
    // The Feb 28 bill posted on Feb 28 but only reaches the ledger on Mar 2.
    await runRecurringDetection(w.db, { today: "2027-03-01", now: noon("2027-03-01") });
    expect(await closeMonth(w.db, "2027-02", { today: "2027-03-01" })).toEqual({ inserted: 0, through: "2027-02" });
    await charge(w, w.checking, "City Water", "2027-02-28", -9000n, "Utilities");
    await runRecurringDetection(w.db, { today: "2027-03-02", now: noon("2027-03-02") });
    // February: the late January bill (Feb 2) and its own (Feb 28): 2 x 90.00 planned and paid.
    expect(await closeMonth(w.db, "2027-02", { today: "2027-03-02" })).toEqual({ inserted: 1, through: "2027-02" });
    const plan = await getPlan(w.db, { from: "2027-02", to: "2027-03", today: "2027-03-02" });
    expect(cellOf(plan, w.cat("Utilities"), "2027-02")).toMatchObject({ plannedCents: 18000n, actualCents: 18000n, hasExplicitPlan: true, source: "recurring", overspent: false });
    expect(cellOf(plan, w.cat("Utilities"), "2027-03").plannedCents).toBe(9000n);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("pausing, cancelling and resuming an item leaves what already happened alone", () => {
  let w: World;
  let netflix: string;
  let gym: string;
  let yoga: string;
  const subs = () => w.cat("Subscriptions");

  beforeAll(async () => {
    w = await world();
    await charge(w, w.visa, "Old", "2027-01-03", -500n, "Shopping");
    const make = (name: string, categoryName: string, anchorDay: number, expectedCents: bigint) =>
      w.db.transaction((tx) =>
        createManualRecurring(tx, { name, payeeName: name, categoryId: w.cat(categoryName), accountId: w.visa, cadence: "monthly", anchorDay, expectedCents }, "2027-01-12", { now: noon("2027-01-12") }),
      );
    netflix = await make("Netflix", "Subscriptions", 5, -1549n);
    gym = await make("Gym", "Subscriptions", 8, -4000n);
    await make("Spotify", "Subscriptions", 15, -1099n);
    yoga = await make("Yoga", "Insurance", 8, -4000n); // alone in its category
    await charge(w, w.visa, "Netflix", "2027-01-05", -1549n, "Subscriptions");
    await charge(w, w.visa, "Gym", "2027-01-08", -4000n, "Subscriptions");
    await charge(w, w.visa, "Yoga", "2027-01-08", -4000n, "Insurance");
    await runRecurringDetection(w.db, { today: "2027-01-12", now: noon("2027-01-12") });
  });
  afterAll(async () => {
    await w?.t.cleanup();
  });

  const setStatus = (id: string, status: "active" | "paused" | "cancelled", today: IsoDate) => w.db.transaction((tx) => updateRecurring(tx, id, { status }, today, noon(today)));

  it("plans what was paid plus what is still due this month", async () => {
    const plan = await getPlan(w.db, { from: "2027-01", to: "2027-02", today: "2027-01-12" });
    // 15.49 (paid Jan 5) + 40.00 (paid Jan 8) + 10.99 (due Jan 15) = 66.48; paid so far 55.49.
    expect(cellOf(plan, subs(), "2027-01")).toMatchObject({ plannedCents: 6648n, actualCents: 5549n, remainingCents: 1099n });
    expect(cellOf(plan, subs(), "2027-02").plannedCents).toBe(6648n);
  });

  it("cancelling after this month's charge keeps it planned this month and drops it from later months", async () => {
    await setStatus(netflix, "cancelled", "2027-01-12");
    const plan = await getPlan(w.db, { from: "2027-01", to: "2027-02", today: "2027-01-12" });
    expect(cellOf(plan, subs(), "2027-01")).toMatchObject({ plannedCents: 6648n, overspent: false });
    expect(cellOf(plan, subs(), "2027-02").plannedCents).toBe(5099n); // 40.00 + 10.99
  });

  it("a month closed while an item is paused keeps what was paid, and a resume does not rewrite it", async () => {
    await charge(w, w.visa, "Spotify", "2027-01-15", -1099n, "Subscriptions");
    await runRecurringDetection(w.db, { today: "2027-01-20", now: noon("2027-01-20") });
    await setStatus(gym, "paused", "2027-01-20");
    let plan = await getPlan(w.db, { from: "2027-01", to: "2027-02", today: "2027-01-20" });
    expect(cellOf(plan, subs(), "2027-01").plannedCents).toBe(6648n);
    expect(cellOf(plan, subs(), "2027-02").plannedCents).toBe(1099n); // only Spotify while the gym is on hold

    await runRecurringDetection(w.db, { today: "2027-02-01", now: noon("2027-02-01") });
    await closeMonth(w.db, "2027-01", { today: "2027-02-01" });
    await setStatus(gym, "active", "2027-02-03");
    plan = await getPlan(w.db, { from: "2027-01", to: "2027-02", today: "2027-02-03" });
    // January: Netflix 15.49 + Gym 40.00 + Spotify 10.99, all paid: frozen at 66.48 and not overspent.
    expect(cellOf(plan, subs(), "2027-01")).toMatchObject({ plannedCents: 6648n, actualCents: 6648n, hasExplicitPlan: true, overspent: false });
    expect(cellOf(plan, subs(), "2027-02").plannedCents).toBe(5099n); // gym (Feb 8) + Spotify (Feb 15)
  });

  it("the months an item was paused stay unplanned after it resumes, and closed months' left to spend does not move", async () => {
    await setStatus(yoga, "paused", "2027-01-20");
    for (const [today, through] of [
      ["2027-02-01", "2027-01"],
      ["2027-03-01", "2027-02"],
      ["2027-04-01", "2027-03"],
    ] as const) {
      await runRecurringDetection(w.db, { today, now: noon(today) });
      await closeMonth(w.db, through, { today });
    }
    const months: MonthKey[] = ["2027-01", "2027-02", "2027-03", "2027-04"];
    const during = await getPlan(w.db, { from: "2027-01", to: "2027-04", today: "2027-04-01" });
    expect(months.map((m) => cellOf(during, w.cat("Insurance"), m).plannedCents)).toEqual([4000n, 0n, 0n, 0n]);

    await setStatus(yoga, "active", "2027-04-03");
    const after = await getPlan(w.db, { from: "2027-01", to: "2027-04", today: "2027-04-03" });
    // On hold from Jan 20 to Apr 3: nothing was due in February or March; the Apr 8 occurrence is expected again.
    expect(months.map((m) => cellOf(after, w.cat("Insurance"), m).plannedCents)).toEqual([4000n, 0n, 0n, 4000n]);
    expect(months.slice(0, 3).map((m) => summaryOf(after, m).leftToSpendCents)).toEqual(months.slice(0, 3).map((m) => summaryOf(during, m).leftToSpendCents));

    await closeMonth(w.db, "2027-04", { today: "2027-05-01" });
    const frozen = await w.db.select({ month: monthPlan.month, plannedCents: monthPlan.plannedCents }).from(monthPlan).where(eq(monthPlan.categoryId, w.cat("Insurance")));
    expect(frozen).toEqual([{ month: "2027-01", plannedCents: 4000n }]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("recurring items outside the bills and income buckets", () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
    await charge(w, w.visa, "Old", "2027-01-03", -500n, "Shopping");
  });
  afterAll(async () => {
    await w?.t.cleanup();
  });

  it("plans an active recurring charge in a spending category, and a typed amount still replaces it", async () => {
    await w.db.transaction((tx) =>
      createManualRecurring(tx, { name: "Gym", payeeName: "Gym", categoryId: w.cat("Health"), accountId: w.visa, cadence: "monthly", anchorDay: 20, expectedCents: -4000n }, "2027-01-12", {
        now: noon("2027-01-12"),
      }),
    );
    const plan = await getPlan(w.db, { from: "2027-01", to: "2027-02", today: "2027-01-12" });
    expect(cellOf(plan, w.cat("Health"), "2027-01")).toMatchObject({ plannedCents: 4000n, source: "recurring", hasExplicitPlan: false, remainingCents: 4000n });
    expect(cellOf(plan, w.cat("Health"), "2027-02")).toMatchObject({ plannedCents: 4000n, source: "recurring" });
    expect(summaryOf(plan, "2027-01").planned.spending).toBe(4000n);

    await w.db.insert(monthPlan).values({ categoryId: w.cat("Health"), month: "2027-02", plannedCents: 10000n, plannedSource: "manual" });
    const typed = await getPlan(w.db, { from: "2027-02", to: "2027-02", today: "2027-01-12" });
    expect(cellOf(typed, w.cat("Health"), "2027-02")).toMatchObject({ plannedCents: 10000n, source: "manual" });
  });

  it("plans a recurring outflow in a savings category that has no goal contribution", async () => {
    await w.db.transaction((tx) =>
      createManualRecurring(
        tx,
        { name: "401k ACH", payeeName: "Fidelity", categoryId: w.cat("Retirement Contribution"), accountId: w.visa, cadence: "monthly", anchorDay: 25, expectedCents: -50000n },
        "2027-01-12",
        { now: noon("2027-01-12") },
      ),
    );
    const plan = await getPlan(w.db, { from: "2027-01", to: "2027-01", today: "2027-01-12" });
    expect(cellOf(plan, w.cat("Retirement Contribution"), "2027-01")).toMatchObject({ plannedCents: 50000n, source: "recurring" });
  });

  it("nets a recurring refund against the category's recurring charges and never plans a negative amount", async () => {
    // A 10.00 monthly reimbursement in Health against the 40.00 gym: 30.00 planned.
    await w.db.transaction((tx) =>
      createManualRecurring(tx, { name: "HSA refund", payeeName: "HSA", categoryId: w.cat("Health"), accountId: w.visa, cadence: "monthly", anchorDay: 22, expectedCents: 1000n }, "2027-01-12", {
        now: noon("2027-01-12"),
      }),
    );
    // A refund alone in a category plans nothing.
    await w.db.transaction((tx) =>
      createManualRecurring(tx, { name: "Pet rebate", payeeName: "Vet", categoryId: w.cat("Pets"), accountId: w.visa, cadence: "monthly", anchorDay: 22, expectedCents: 1000n }, "2027-01-12", {
        now: noon("2027-01-12"),
      }),
    );
    const plan = await getPlan(w.db, { from: "2027-01", to: "2027-01", today: "2027-01-12" });
    expect(cellOf(plan, w.cat("Health"), "2027-01")).toMatchObject({ plannedCents: 3000n, source: "recurring" });
    expect(cellOf(plan, w.cat("Pets"), "2027-01")).toMatchObject({ plannedCents: 0n, source: "none" });
  });
});
