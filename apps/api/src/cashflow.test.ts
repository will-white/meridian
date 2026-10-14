import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, householdSetting, payee, recurring } from "@meridian/db";
import { PLAN_SEED_TODAY, seedPlanFixture, type PlanSeed } from "@meridian/db/testing";
import type { AccountView, CashFlowProjectionResponse } from "@meridian/shared";
import { createTestApp, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/**
 * POST /api/cashflow/projection and the account settings it reads
 * (docs/design/phase-2/cashflow.md "api" and "testCases"; docs/phase-2-plan.md §14, §16).
 * The first suite rebuilds the design's test 1 from database rows (one checking account,
 * a biweekly paycheck and a monthly rent) and runs it through the route, with the
 * what-if cases 8, 9(a) and 11 on top. The second suite runs on the grid-and-api seed
 * with balances set (Checking 320000, Savings 300000, Visa −45000 paid from Checking on
 * the 25th, statement day 5): subsets, validation and the account PATCH rules.
 */

const TODAY = PLAN_SEED_TODAY;
const serverClock = () => new Date(`${TODAY}T18:00:00Z`);

async function signInOwner(t: TestApp): Promise<void> {
  await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "correct horse battery staple" } });
  const setup = await t.call({ method: "POST", url: "/api/auth/totp/setup" });
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json().secret), digits: 6, period: 30 }).generate();
  await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code } });
}

async function project(t: TestApp, payload: Record<string, unknown>): Promise<CashFlowProjectionResponse> {
  const res = await t.call({ method: "POST", url: "/api/cashflow/projection", payload });
  expect(res.statusCode).toBe(200);
  return res.json() as CashFlowProjectionResponse;
}

/** points[i] for the given date, on an account series or the combined line. */
function at(body: CashFlowProjectionResponse, series: { points: string[] }, date: string): string | undefined {
  const i = body.dates.indexOf(date);
  return i < 0 ? undefined : series.points[i];
}

/** Expand [first, last, cents] runs into the full point list (the design's shorthand). */
function pointsFromRuns(dates: string[], runs: Array<[string, string, string]>): string[] {
  return dates.map((d) => {
    const run = runs.find(([first, last]) => d >= first && d <= last);
    if (!run) throw new Error(`no run covers ${d}`);
    return run[2];
  });
}

/** Row counts and last-updated stamps of every table the projection reads, to prove the route writes nothing. */
async function tableState(t: TestApp): Promise<Record<string, unknown>> {
  const rows = await t.db.db.execute(sql`
    select
      (select count(*) from "account") as accounts,
      (select max(updated_at)::text from "account") as account_updated,
      (select count(*) from "transaction") as transactions,
      (select count(*) from "recurring") as recurring,
      (select max(updated_at)::text from "recurring") as recurring_updated,
      (select count(*) from "month_plan") as month_plans,
      (select count(*) from "category") as categories,
      (select count(*) from "balance_snapshot") as snapshots,
      (select count(*) from "audit_log") as audits,
      (select count(*) from "job") as jobs,
      (select count(*) from "alert") as alerts,
      (select max(updated_at)::text from "household_setting") as setting_updated
  `);
  return { ...rows[0] };
}

describe.skipIf(!TEST_DATABASE_URL)("POST /api/cashflow/projection: cash-flow design test 1 end to end", () => {
  let t: TestApp;
  let chk: string;
  let pay: string;
  let rent: string;

  beforeAll(async () => {
    t = await createTestApp({ now: serverClock });
    const db = t.db.db;
    await db.insert(householdSetting).values({ id: 1, planStartMonth: "2026-10" }).onConflictDoNothing();
    const [chkRow] = await db
      .insert(account)
      .values({ name: "chk", type: "checking", taxTreatment: "none", onBudget: true, balanceCents: 250000n, balanceDate: TODAY })
      .returning({ id: account.id });
    chk = chkRow!.id;
    const payees = await db
      .insert(payee)
      .values([{ name: "Employer" }, { name: "Landlord" }])
      .returning({ id: payee.id, name: payee.name });
    const payeeOf = (name: string) => payees.find((p) => p.name === name)!.id;
    const items = await db
      .insert(recurring)
      .values([
        // pay: income, biweekly from 2026-10-16, +200000 into chk.
        { payeeId: payeeOf("Employer"), name: "pay", accountId: chk, cadence: "biweekly", anchorDate: "2026-10-16", expectedCents: 200000n, nextDueDate: "2026-10-16", firstChargeDate: "2026-10-16", source: "manual", status: "active" },
        // rent: bill, monthly on the 1st from 2026-11-01, −150000 out of chk.
        { payeeId: payeeOf("Landlord"), name: "rent", accountId: chk, cadence: "monthly", anchorDay: 1, expectedCents: -150000n, nextDueDate: "2026-11-01", firstChargeDate: "2026-11-01", source: "manual", status: "active" },
      ])
      .returning({ id: recurring.id, name: recurring.name });
    pay = items.find((r) => r.name === "pay")!.id;
    rent = items.find((r) => r.name === "rent")!.id;
    await signInOwner(t);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("reproduces the 91 points and 10 events of a biweekly paycheck and a monthly rent over 90 days", async () => {
    const body = await project(t, { today: TODAY, horizonDays: 90 });
    expect(body.today).toBe(TODAY);
    expect(body.endDate).toBe("2027-01-11");
    expect(body.dates).toHaveLength(91);
    expect(body.dates[0]).toBe(TODAY);
    expect(body.dates[90]).toBe("2027-01-11");

    expect(body.accounts).toHaveLength(1);
    const series = body.accounts[0]!;
    expect(series).toMatchObject({
      accountId: chk,
      name: "chk",
      type: "checking",
      balanceDate: TODAY,
      openingCents: "250000",
      thresholdCents: "0",
      minCents: "250000",
      minDate: TODAY,
      firstBelowThresholdDate: null,
      alreadyBelow: false,
    });
    expect(series.points).toEqual(
      pointsFromRuns(body.dates, [
        ["2026-10-13", "2026-10-15", "250000"],
        ["2026-10-16", "2026-10-29", "450000"],
        ["2026-10-30", "2026-10-31", "650000"],
        ["2026-11-01", "2026-11-12", "500000"],
        ["2026-11-13", "2026-11-26", "700000"],
        ["2026-11-27", "2026-11-30", "900000"],
        ["2026-12-01", "2026-12-10", "750000"],
        ["2026-12-11", "2026-12-24", "950000"],
        ["2026-12-25", "2026-12-31", "1150000"],
        ["2027-01-01", "2027-01-07", "1000000"],
        ["2027-01-08", "2027-01-11", "1200000"],
      ]),
    );
    // 250000 + 7 × 200000 − 3 × 150000.
    expect(at(body, series, "2027-01-11")).toBe("1200000");
    // One account: the combined line is the account's line with the household threshold.
    expect(body.combined).toEqual({
      openingCents: "250000",
      thresholdCents: "0",
      points: series.points,
      minCents: "250000",
      minDate: TODAY,
      firstBelowThresholdDate: null,
      alreadyBelow: false,
    });

    expect(body.events.map((e) => [e.date, e.kind, e.label, e.amountCents])).toEqual([
      ["2026-10-16", "income", "pay", "200000"],
      ["2026-10-30", "income", "pay", "200000"],
      ["2026-11-01", "bill", "rent", "-150000"],
      ["2026-11-13", "income", "pay", "200000"],
      ["2026-11-27", "income", "pay", "200000"],
      ["2026-12-01", "bill", "rent", "-150000"],
      ["2026-12-11", "income", "pay", "200000"],
      ["2026-12-25", "income", "pay", "200000"],
      ["2027-01-01", "bill", "rent", "-150000"],
      ["2027-01-08", "income", "pay", "200000"],
    ]);
    for (const e of body.events) {
      expect(e).toMatchObject({ accountId: chk, accountName: "chk", originalDate: e.date, applied: true, overdue: false, moved: false });
      expect(e.recurringId).toBe(e.kind === "income" ? pay : rent);
    }
    expect(body.whatIfs).toEqual([]);
    // The default categories carry no plan and no history: every month spreads 0 on the only checking account.
    expect(body.spreads.map((s) => [s.month, s.accountId, s.totalCents, s.baseCents, s.extraCentDays])).toEqual([
      ["2026-10", chk, "0", "0", 0],
      ["2026-11", chk, "0", "0", 0],
      ["2026-12", chk, "0", "0", 0],
      ["2027-01", chk, "0", "0", 0],
    ]);
    expect(body.warnings).toEqual(["3 months use 3-month averages for unplanned spending categories"]);
  });

  it("defaults today to the server's household date and the horizon to the household setting; bounds a client today to ±2 days", async () => {
    const body = await project(t, {});
    expect(body.today).toBe(TODAY);
    expect(body.dates).toHaveLength(91);
    expect(body.endDate).toBe("2027-01-11");

    expect((await project(t, { today: "2026-10-15", horizonDays: 1 })).today).toBe("2026-10-15");
    expect((await project(t, { today: "2026-10-11", horizonDays: 1 })).today).toBe("2026-10-11");
    const tooFar = await t.call({ method: "POST", url: "/api/cashflow/projection", payload: { today: "2026-10-16" } });
    expect(tooFar.statusCode).toBe(400);
    expect(tooFar.json().code).toBe("today_out_of_range");
    expect((await t.call({ method: "POST", url: "/api/cashflow/projection", payload: { today: "2026-10-10" } })).statusCode).toBe(400);
    expect((await t.call({ method: "POST", url: "/api/cashflow/projection", payload: { today: "2026-13-01" } })).statusCode).toBe(400);

    // Body validation: horizon 1..366, shiftDays ≠ 0, at most 50 what-ifs, integer cents.
    for (const payload of [
      { horizonDays: 0 },
      { horizonDays: 367 },
      { whatIfs: [{ kind: "moveOccurrence", recurringId: pay, shiftDays: 0 }] },
      { whatIfs: Array.from({ length: 51 }, () => ({ kind: "skipOccurrence", recurringId: rent, occurrenceDate: "2026-12-01" })) },
      { whatIfs: [{ kind: "oneTime", date: "2026-11-20", amountCents: "-8.50", accountId: chk }] },
    ]) {
      const res = await t.call({ method: "POST", url: "/api/cashflow/projection", payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("validation");
    }

    // The horizon is inclusive of both ends: horizonDays 1 gives two points.
    const two = await project(t, { today: TODAY, horizonDays: 1 });
    expect(two.dates).toEqual([TODAY, "2026-10-14"]);
  });

  it("reports each what-if as applied or not: skipping one rent (test 8), moving a payday (test 9a), one-time items (test 11)", async () => {
    // Test 8: skip the 12-01 rent; skipping 12-02 names no occurrence and is reported, not an error.
    const skipped = await project(t, {
      today: TODAY,
      horizonDays: 90,
      whatIfs: [
        { kind: "skipOccurrence", recurringId: rent, occurrenceDate: "2026-12-01" },
        { kind: "skipOccurrence", recurringId: rent, occurrenceDate: "2026-12-02" },
      ],
    });
    expect(skipped.whatIfs).toEqual([
      { index: 0, applied: true },
      { index: 1, applied: false, reason: `no occurrence of ${rent} on 2026-12-02` },
    ]);
    const s = skipped.accounts[0]!;
    expect(at(skipped, s, "2026-11-30")).toBe("900000");
    expect(at(skipped, s, "2026-12-01")).toBe("900000");
    expect(at(skipped, s, "2026-12-11")).toBe("1100000");
    expect(at(skipped, s, "2026-12-25")).toBe("1300000");
    expect(at(skipped, s, "2027-01-01")).toBe("1150000");
    for (const d of ["2027-01-08", "2027-01-11"]) expect(at(skipped, s, d)).toBe("1350000");
    expect(skipped.events).toHaveLength(10);
    expect(skipped.events.find((e) => e.date === "2026-12-01")).toMatchObject({ kind: "bill", label: "rent", amountCents: "-150000", applied: false });
    expect(skipped.events.filter((e) => !e.applied)).toHaveLength(1);

    // Test 9(a): the 10-16 paycheck moved +4 days; still 7 paychecks.
    const moved = await project(t, { today: TODAY, horizonDays: 90, whatIfs: [{ kind: "moveOccurrence", recurringId: pay, shiftDays: 4, occurrenceDate: "2026-10-16" }] });
    expect(moved.whatIfs).toEqual([{ index: 0, applied: true }]);
    const m = moved.accounts[0]!;
    for (const d of ["2026-10-16", "2026-10-19"]) expect(at(moved, m, d)).toBe("250000");
    expect(at(moved, m, "2026-10-20")).toBe("450000");
    expect(at(moved, m, "2026-10-30")).toBe("650000");
    expect(at(moved, m, "2027-01-11")).toBe("1200000");
    expect(moved.events.filter((e) => e.kind === "income")).toHaveLength(7);
    expect(moved.events.find((e) => e.moved)).toMatchObject({ date: "2026-10-20", originalDate: "2026-10-16", kind: "income", applied: true, overdue: false });
    // A move with an unknown recurring id is reported too.
    const unknown = await project(t, { today: TODAY, horizonDays: 30, whatIfs: [{ kind: "moveOccurrence", recurringId: randomUUID(), shiftDays: 3 }] });
    expect(unknown.whatIfs).toEqual([{ index: 0, applied: false, reason: "unknown recurring id" }]);

    // Test 11: one-time items in range, before today, after the horizon and on an account that is not projected.
    const oneTime = await project(t, {
      today: TODAY,
      horizonDays: 90,
      whatIfs: [
        { kind: "oneTime", date: "2026-11-20", amountCents: "-80000", accountId: chk, label: "Car repair" },
        { kind: "oneTime", date: "2026-10-01", amountCents: "-1000", accountId: chk },
        { kind: "oneTime", date: "2027-02-01", amountCents: "-1000", accountId: chk },
        { kind: "oneTime", date: "2026-11-01", amountCents: "-1000", accountId: randomUUID() },
      ],
    });
    expect(oneTime.whatIfs).toEqual([
      { index: 0, applied: true },
      { index: 1, applied: true, reason: "moved to today" },
      { index: 2, applied: false, reason: "after horizon" },
      { index: 3, applied: false, reason: "account not projected" },
    ]);
    const o = oneTime.accounts[0]!;
    expect(at(oneTime, o, TODAY)).toBe("249000");
    expect(at(oneTime, o, "2026-11-19")).toBe("699000");
    for (const d of ["2026-11-20", "2026-11-26"]) expect(at(oneTime, o, d)).toBe("619000");
    expect(at(oneTime, o, "2026-11-27")).toBe("819000");
    expect(at(oneTime, o, "2027-01-11")).toBe("1119000");
    expect(oneTime.events).toHaveLength(12);
    expect(oneTime.events.filter((e) => e.kind === "one_time")).toEqual([
      { date: TODAY, originalDate: "2026-10-01", accountId: chk, accountName: "chk", amountCents: "-1000", kind: "one_time", recurringId: null, label: "One-time", applied: true, overdue: false, moved: true },
      { date: "2026-11-20", originalDate: "2026-11-20", accountId: chk, accountName: "chk", amountCents: "-80000", kind: "one_time", recurringId: null, label: "Car repair", applied: true, overdue: false, moved: false },
    ]);
  });

  it("is deterministic and writes nothing", async () => {
    const payload = {
      today: TODAY,
      horizonDays: 90,
      whatIfs: [
        { kind: "skipOccurrence", recurringId: rent, occurrenceDate: "2026-12-01" },
        { kind: "oneTime", date: "2026-11-20", amountCents: "-80000", accountId: chk, label: "Car repair" },
      ],
    };
    const before = await tableState(t);
    const first = await t.call({ method: "POST", url: "/api/cashflow/projection", payload });
    const second = await t.call({ method: "POST", url: "/api/cashflow/projection", payload });
    expect(first.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    expect(await tableState(t)).toEqual(before);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("POST /api/cashflow/projection on the grid-and-api seed", () => {
  let t: TestApp;
  let S: PlanSeed;

  beforeAll(async () => {
    t = await createTestApp({ now: serverClock });
    S = await seedPlanFixture(t.db.db);
    const db = t.db.db;
    await db.update(account).set({ balanceCents: 320000n, balanceDate: TODAY }).where(eq(account.id, S.accounts.checking));
    await db.update(account).set({ balanceCents: 300000n, balanceDate: TODAY }).where(eq(account.id, S.accounts.savings));
    await db
      .update(account)
      .set({ balanceCents: -45000n, balanceDate: TODAY, paymentDay: 25, paymentFromAccountId: S.accounts.checking, statementDay: 5 })
      .where(eq(account.id, S.accounts.visa));
    await signInOwner(t);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("projects every on-budget open account by default: openings include pending, the card is paid from checking", async () => {
    const body = await project(t, { today: TODAY, horizonDays: 30 });
    expect(body.accounts.map((a) => [a.name, a.type, a.openingCents, a.thresholdCents])).toEqual([
      ["Checking", "checking", "320000", "0"],
      ["Savings", "savings", "300000", "0"],
      ["Visa", "credit", "-47500", null],
    ]);
    expect(body.combined.openingCents).toBe("572500");
    expect(body.dates).toHaveLength(31);
    // The service test's hand number for the combined line on 11-12 (card payments cancel in the sum).
    expect(at(body, body.combined, "2026-11-12")).toBe("341146");
    expect(body.combined.minDate).toBe("2026-11-12");
    const applied = body.events
      .filter((e) => e.applied)
      .map((e) => [e.date, e.kind, e.accountName, e.label, e.amountCents] as const)
      .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
    expect(applied).toEqual([
      ["2026-10-20", "bill", "Checking", "Internet", "-7999"],
      ["2026-10-25", "card_payment_in", "Visa", "Visa payment", "62500"],
      ["2026-10-25", "card_payment_out", "Checking", "Visa payment", "-62500"],
      ["2026-11-01", "bill", "Checking", "Rent", "-180000"],
      ["2026-11-05", "bill", "Checking", "Netflix", "-1549"],
    ]);
    expect(body.spreads.map((s) => [s.month, s.accountId, s.totalCents])).toEqual([
      ["2026-10", S.accounts.checking, "14031"],
      ["2026-10", S.accounts.visa, "969"],
      ["2026-11", S.accounts.checking, "62671"],
      ["2026-11", S.accounts.visa, "4329"],
    ]);
    expect(body.warnings).toEqual(["1 month uses 3-month averages for unplanned spending categories"]);
  });

  it("accountIds restricts the projection to a subset, in name order; unknown, off-budget and closed ids are 400", async () => {
    const only = await project(t, { today: TODAY, horizonDays: 30, accountIds: [S.accounts.checking] });
    expect(only.accounts.map((a) => a.name)).toEqual(["Checking"]);
    expect(only.combined.openingCents).toBe("320000");
    // The card is not projected, so there is no payment and no card warning; the bills still post.
    expect(only.events.map((e) => [e.date, e.kind, e.label])).toEqual([
      ["2026-10-20", "bill", "Internet"],
      ["2026-11-01", "bill", "Rent"],
      ["2026-11-05", "bill", "Netflix"],
    ]);
    expect(only.spreads.map((s) => [s.month, s.totalCents])).toEqual([
      ["2026-10", "15000"],
      ["2026-11", "67000"],
    ]);

    const pair = await project(t, { today: TODAY, horizonDays: 30, accountIds: [S.accounts.visa, S.accounts.savings] });
    expect(pair.accounts.map((a) => a.name)).toEqual(["Savings", "Visa"]);
    // Paid from an account outside the subset: no payment, and the response says so.
    expect(pair.events.filter((e) => e.kind.startsWith("card_payment"))).toEqual([]);
    expect(pair.warnings).toContain("card Visa is paid from an account that is not projected");

    const unknown = await t.call({ method: "POST", url: "/api/cashflow/projection", payload: { today: TODAY, accountIds: [S.accounts.checking, randomUUID()] } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().code).toBe("bad_request");

    const [brokerage] = await t.db.db
      .insert(account)
      .values({ name: "Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false, balanceCents: 1000000n })
      .returning({ id: account.id });
    const [closed] = await t.db.db
      .insert(account)
      .values({ name: "Old Checking", type: "checking", taxTreatment: "none", onBudget: true, closed: true, balanceCents: 0n })
      .returning({ id: account.id });
    for (const id of [brokerage!.id, closed!.id]) {
      const res = await t.call({ method: "POST", url: "/api/cashflow/projection", payload: { today: TODAY, accountIds: [id] } });
      expect(res.statusCode).toBe(400);
    }
    // Neither joins the default projection.
    expect((await project(t, { today: TODAY, horizonDays: 5 })).accounts.map((a) => a.name)).toEqual(["Checking", "Savings", "Visa"]);
    await t.db.db.delete(account).where(eq(account.id, brokerage!.id));
    await t.db.db.delete(account).where(eq(account.id, closed!.id));
  });

  it("PATCH /api/settings rejects a primaryAccountId that is off budget or closed", async () => {
    // cashflow.md "api": primaryAccountId must be an on-budget open account (it is the spending-spread fallback).
    const before = (await t.call({ method: "GET", url: "/api/settings" })).json().primaryAccountId;
    const [brokerage] = await t.db.db
      .insert(account)
      .values({ name: "Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false, balanceCents: 0n })
      .returning({ id: account.id });
    const [closed] = await t.db.db
      .insert(account)
      .values({ name: "Old Checking", type: "checking", taxTreatment: "none", onBudget: true, closed: true, balanceCents: 0n })
      .returning({ id: account.id });
    for (const id of [brokerage!.id, closed!.id]) {
      const res = await t.call({ method: "PATCH", url: "/api/settings", payload: { primaryAccountId: id } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "Primary account must be an on-budget open account", code: "validation" });
    }
    expect((await t.call({ method: "GET", url: "/api/settings" })).json().primaryAccountId).toBe(before);
    // An on-budget open account is still accepted.
    const ok = await t.call({ method: "PATCH", url: "/api/settings", payload: { primaryAccountId: S.accounts.savings } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().primaryAccountId).toBe(S.accounts.savings);
    expect((await t.call({ method: "PATCH", url: "/api/settings", payload: { primaryAccountId: before } })).statusCode).toBe(200);
    await t.db.db.delete(account).where(eq(account.id, brokerage!.id));
    await t.db.db.delete(account).where(eq(account.id, closed!.id));
  });

  it("thresholdCents overrides the household default for the request only", async () => {
    const body = await project(t, { today: TODAY, horizonDays: 10, thresholdCents: "600000", accountIds: [S.accounts.checking] });
    expect(body.combined.thresholdCents).toBe("600000");
    expect(body.combined.alreadyBelow).toBe(true);
    expect(body.combined.firstBelowThresholdDate).toBe(TODAY);
    expect(body.accounts[0]).toMatchObject({ name: "Checking", thresholdCents: "600000", alreadyBelow: true });
    const settings = await t.call({ method: "GET", url: "/api/settings" });
    expect(settings.json().lowBalanceThresholdCents).toBe("0");
    expect((await project(t, { today: TODAY, horizonDays: 10 })).combined.thresholdCents).toBe("0");
  });

  describe("PATCH /api/accounts/:id cash-flow settings", () => {
    const patch = async (id: string, payload: Record<string, unknown>) => t.call({ method: "PATCH", url: `/api/accounts/${id}`, payload });
    const expect400 = async (id: string, payload: Record<string, unknown>) => {
      const res = await patch(id, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("validation");
    };

    it("sets and clears a per-account low-balance threshold that the projection honours", async () => {
      const set = await patch(S.accounts.checking, { lowBalanceThresholdCents: "50000" });
      expect(set.statusCode).toBe(200);
      expect((set.json() as AccountView).lowBalanceThresholdCents).toBe("50000");
      const withLine = await project(t, { today: TODAY, horizonDays: 5, accountIds: [S.accounts.checking] });
      expect(withLine.accounts[0]).toMatchObject({ thresholdCents: "50000", alreadyBelow: false });
      // The combined line keeps the household default.
      expect(withLine.combined.thresholdCents).toBe("0");

      const cleared = await patch(S.accounts.checking, { lowBalanceThresholdCents: null });
      expect((cleared.json() as AccountView).lowBalanceThresholdCents).toBeNull();
      expect((await project(t, { today: TODAY, horizonDays: 5, accountIds: [S.accounts.checking] })).accounts[0]?.thresholdCents).toBe("0");
      // Other fields are untouched by a threshold edit.
      expect(cleared.json()).toMatchObject({ name: "Checking", type: "checking", onBudget: true, paymentDay: null, paymentFromAccountId: null, statementDay: null });
    });

    it("rejects card payment settings on non-credit accounts", async () => {
      await expect400(S.accounts.checking, { paymentDay: 25, paymentFromAccountId: S.accounts.savings });
      await expect400(S.accounts.checking, { statementDay: 5 });
      await expect400(S.accounts.savings, { paymentDay: 25, paymentFromAccountId: S.accounts.checking, statementDay: 5 });
      // Becoming a checking account in the same request does not help.
      await expect400(S.accounts.visa, { type: "checking", paymentDay: 25, paymentFromAccountId: S.accounts.checking });
      expect((await t.call({ method: "GET", url: "/api/accounts" })).json().find((a: AccountView) => a.id === S.accounts.visa)).toMatchObject({ type: "credit", paymentDay: 25 });
      // Explicit nulls on a cash account are accepted (nothing to clear).
      const nulls = await patch(S.accounts.checking, { paymentDay: null, paymentFromAccountId: null, statementDay: null });
      expect(nulls.statusCode).toBe(200);
    });

    it("paymentDay and paymentFromAccountId are set or cleared together; the payer must be an on-budget checking/savings account other than the card", async () => {
      // Start from a card without settings.
      const off = await patch(S.accounts.visa, { paymentDay: null, paymentFromAccountId: null, statementDay: null });
      expect(off.statusCode).toBe(200);
      expect(off.json()).toMatchObject({ paymentDay: null, paymentFromAccountId: null, statementDay: null });
      expect((await project(t, { today: TODAY, horizonDays: 30 })).warnings).toContain("card Visa has no payment day");

      await expect400(S.accounts.visa, { paymentDay: 25 });
      await expect400(S.accounts.visa, { paymentFromAccountId: S.accounts.checking });
      await expect400(S.accounts.visa, { paymentDay: 25, paymentFromAccountId: S.accounts.visa });
      await expect400(S.accounts.visa, { paymentDay: 25, paymentFromAccountId: randomUUID() });
      const [brokerage] = await t.db.db
        .insert(account)
        .values({ name: "Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false })
        .returning({ id: account.id });
      const [offBudgetChecking] = await t.db.db
        .insert(account)
        .values({ name: "Side Checking", type: "checking", taxTreatment: "none", onBudget: false })
        .returning({ id: account.id });
      const [otherCard] = await t.db.db
        .insert(account)
        .values({ name: "Amex", type: "credit", taxTreatment: "none", onBudget: true })
        .returning({ id: account.id });
      await expect400(S.accounts.visa, { paymentDay: 25, paymentFromAccountId: brokerage!.id });
      await expect400(S.accounts.visa, { paymentDay: 25, paymentFromAccountId: offBudgetChecking!.id });
      await expect400(S.accounts.visa, { paymentDay: 25, paymentFromAccountId: otherCard!.id });
      // Zod bounds: 1..31.
      expect((await patch(S.accounts.visa, { paymentDay: 0, paymentFromAccountId: S.accounts.checking })).statusCode).toBe(400);
      expect((await patch(S.accounts.visa, { paymentDay: 32, paymentFromAccountId: S.accounts.checking })).statusCode).toBe(400);
      expect((await patch(S.accounts.visa, { statementDay: 40 })).statusCode).toBe(400);
      // Nothing above was written.
      expect((await t.call({ method: "GET", url: "/api/accounts" })).json().find((a: AccountView) => a.id === S.accounts.visa)).toMatchObject({ paymentDay: null, paymentFromAccountId: null, statementDay: null });

      // The pair plus a statement day; a savings payer is fine too.
      const on = await patch(S.accounts.visa, { paymentDay: 25, paymentFromAccountId: S.accounts.checking, statementDay: 5 });
      expect(on.statusCode).toBe(200);
      expect(on.json()).toMatchObject({ paymentDay: 25, paymentFromAccountId: S.accounts.checking, statementDay: 5 });
      const paid = await project(t, { today: TODAY, horizonDays: 30 });
      expect(paid.events.filter((e) => e.kind === "card_payment_out").map((e) => [e.date, e.amountCents])).toEqual([["2026-10-25", "-62500"]]);
      expect(paid.warnings).not.toContain("card Visa has no payment day");
      expect((await patch(S.accounts.visa, { paymentFromAccountId: S.accounts.savings })).json()).toMatchObject({ paymentDay: 25, paymentFromAccountId: S.accounts.savings });

      // Changing one half while the other stays set is allowed; clearing one half alone is not.
      expect((await patch(S.accounts.visa, { paymentDay: 20 })).json()).toMatchObject({ paymentDay: 20, paymentFromAccountId: S.accounts.savings, statementDay: 5 });
      await expect400(S.accounts.visa, { paymentDay: null });
      await expect400(S.accounts.visa, { paymentFromAccountId: null });
      // statementDay is independent: null means "the balance as of the day before the payment".
      expect((await patch(S.accounts.visa, { statementDay: null })).json()).toMatchObject({ paymentDay: 20, paymentFromAccountId: S.accounts.savings, statementDay: null });
      expect((await patch(S.accounts.visa, { paymentDay: null, paymentFromAccountId: null })).json()).toMatchObject({ paymentDay: null, paymentFromAccountId: null, statementDay: null });

      // Leaving the credit type drops the settings; a new credit account starts without any.
      await patch(S.accounts.visa, { paymentDay: 25, paymentFromAccountId: S.accounts.checking, statementDay: 5 });
      const asLoan = await patch(S.accounts.visa, { type: "loan" });
      expect(asLoan.json()).toMatchObject({ type: "loan", paymentDay: null, paymentFromAccountId: null, statementDay: null });
      expect((await patch(S.accounts.visa, { type: "credit" })).json()).toMatchObject({ type: "credit", paymentDay: null, paymentFromAccountId: null, statementDay: null });

      expect((await patch(randomUUID(), { paymentDay: 25, paymentFromAccountId: S.accounts.checking })).statusCode).toBe(404);

      // Restore the seed's settings for later suites.
      await patch(S.accounts.visa, { paymentDay: 25, paymentFromAccountId: S.accounts.checking, statementDay: 5 });
      for (const row of [brokerage, offBudgetChecking, otherCard]) await t.db.db.delete(account).where(eq(account.id, row!.id));
    });
  });
});
