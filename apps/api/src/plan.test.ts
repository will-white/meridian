import { randomBytes, randomUUID } from "node:crypto";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { session, user } from "@meridian/db";
import { PLAN_SEED_TODAY, seedPlanFixture, type PlanSeed } from "@meridian/db/testing";
import type { MonthSummaryView, PlanCellView, PlanResponse, PlanRow } from "@meridian/shared";
import { createTestApp, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/**
 * GET /api/plan, PUT /api/plan/cells, averages, close-month, settings, audit and
 * the viewer role on the grid-and-api seed (docs/design/phase-2/grid-and-api.md,
 * "testCases"), with today = 2026-10-13 both as the server clock (noon in
 * America/Denver) and as the client's `today`.
 */

const TODAY = PLAN_SEED_TODAY;
const MONTHS = ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01"];
const RANGE = { from: "2026-08", to: "2027-01" };
const serverClock = () => new Date(`${TODAY}T18:00:00Z`);

type CategoryRowView = Extract<PlanRow, { kind: "category" }>;

async function freshApp(): Promise<{ t: TestApp; S: PlanSeed }> {
  const t = await createTestApp({ now: serverClock });
  const S = await seedPlanFixture(t.db.db);
  await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "correct horse battery staple" } });
  const setup = await t.call({ method: "POST", url: "/api/auth/totp/setup" });
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json().secret), digits: 6, period: 30 }).generate();
  await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code } });
  return { t, S };
}

/** A viewer-role user with a verified session, inserted directly; returns the cookie jar for inject(). */
async function viewerCookies(t: TestApp): Promise<Record<string, string>> {
  const [row] = await t.db.db
    .insert(user)
    .values({ username: "viewer", passwordHash: "never-verified", role: "viewer", totpConfirmedAt: new Date() })
    .returning({ id: user.id });
  const id = randomBytes(32).toString("hex");
  await t.db.db.insert(session).values({ id, userId: row!.id, expiresAt: new Date(Date.now() + 86_400_000), totpVerified: true });
  return { meridian_session: t.app.signCookie(id) };
}

async function getPlan(t: TestApp, query = `?today=${TODAY}`): Promise<PlanResponse> {
  const res = await t.call({ method: "GET", url: `/api/plan${query}` });
  expect(res.statusCode).toBe(200);
  return res.json() as PlanResponse;
}

function catRow(plan: PlanResponse, categoryId: string): CategoryRowView {
  const r = plan.rows.find((x): x is CategoryRowView => x.kind === "category" && x.categoryId === categoryId);
  if (!r) throw new Error(`no row for ${categoryId}`);
  return r;
}

function cellOf(plan: PlanResponse, categoryId: string, month: string): PlanCellView {
  const c = catRow(plan, categoryId).cells[plan.months.indexOf(month)];
  if (!c) throw new Error(`no cell ${categoryId} ${month}`);
  return c;
}

function rowCell(plan: PlanResponse, pick: (r: PlanRow) => boolean, month: string): PlanCellView {
  const c = plan.rows.find(pick)?.cells[plan.months.indexOf(month)];
  if (!c) throw new Error(`no row cell for ${month}`);
  return c;
}

function summaryOf(plan: PlanResponse, month: string): MonthSummaryView {
  const s = plan.summary[plan.months.indexOf(month)];
  if (!s) throw new Error(`no summary for ${month}`);
  return s;
}

/** planned / carriedIn / actual / remaining / source: the grid design's shorthand. */
const brief = (c: PlanCellView) => [c.plannedCents, c.carriedInCents, c.actualCents, c.remainingCents, c.source];
const totals = (c: PlanCellView) => [c.plannedCents, c.carriedInCents, c.actualCents, c.remainingCents];
const committed = (s: MonthSummaryView) => [s.committed.income, s.committed.bills, s.committed.savings, s.committed.spending];
const rowOrder = (plan: PlanResponse, bucket: string) =>
  plan.rows.filter((r) => r.bucket === bucket).map((r) => (r.kind === "bucket" ? `bucket:${r.bucket}` : r.kind === "group" ? `group:${r.name}` : r.name));

describe.skipIf(!TEST_DATABASE_URL)("GET /api/plan on the fresh seed", () => {
  let t: TestApp;
  let S: PlanSeed;
  let C: PlanSeed["categories"];

  beforeAll(async () => {
    ({ t, S } = await freshApp());
    C = S.categories;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("default range, row order and the Groceries chain ('all' from 2026-09)", async () => {
    const plan = await getPlan(t);
    expect(plan).toMatchObject({ today: TODAY, currentMonth: "2026-10", from: "2026-08", to: "2027-01", months: MONTHS, zeroBased: false });
    expect(plan.rows[0]).toMatchObject({ kind: "bucket", bucket: "income" });
    expect(rowOrder(plan, "spending")).toEqual(["bucket:spending", "group:Everyday", "Groceries", "Dining", "Fuel", "Old Hobby", "Shopping"]);
    expect(catRow(plan, C.oldHobby).hidden).toBe(true);
    expect(catRow(plan, C.shopping)).toMatchObject({ groupId: null, position: 1 });
    expect(catRow(plan, C.groceries)).toMatchObject({ groupId: S.groups.everyday, rolloverMode: "all", rolloverFromMonth: "2026-09", goal: null });
    expect(plan.summary.map((s) => s.state)).toEqual(["past", "past", "current", "future", "future", "future"]);

    const g = (m: string) => cellOf(plan, C.groceries, m);
    expect(brief(g("2026-08"))).toEqual(["0", "0", "7000", "-7000", "none"]);
    expect(g("2026-08")).toMatchObject({ overspent: true, overspendCents: "7000", carriedInSource: "none", hasExplicitPlan: false });
    expect(brief(g("2026-09"))).toEqual(["50000", "0", "40000", "10000", "manual"]);
    expect(g("2026-09")).toMatchObject({ carriedInSource: "start", hasExplicitPlan: true, availableCents: "50000" });
    expect(brief(g("2026-10"))).toEqual(["50000", "10000", "54500", "5500", "manual"]);
    expect(g("2026-10")).toMatchObject({ txnCount: 3, carriedInSource: "chain", committedCents: "50000", rolloverMode: "all" });
    expect(brief(g("2026-11"))).toEqual(["50000", "5500", "0", "55500", "manual"]);
    expect(brief(g("2026-12"))).toEqual(["0", "55500", "0", "55500", "none"]);
    expect(brief(g("2027-01"))).toEqual(["0", "55500", "0", "55500", "none"]);
  });

  it("Dining (surplus), Fuel (none, pending) and the month boundary", async () => {
    const plan = await getPlan(t);
    expect(brief(cellOf(plan, C.dining, "2026-09"))).toEqual(["20000", "0", "26000", "-6000", "manual"]);
    expect(cellOf(plan, C.dining, "2026-09").overspent).toBe(true);
    expect(brief(cellOf(plan, C.dining, "2026-10"))).toEqual(["20000", "0", "20000", "0", "manual"]);
    expect(brief(cellOf(plan, C.dining, "2026-11"))).toEqual(["0", "0", "0", "0", "none"]);
    expect(brief(cellOf(plan, C.fuel, "2026-09"))).toEqual(["0", "0", "6000", "-6000", "none"]);
    expect(brief(cellOf(plan, C.fuel, "2026-10"))).toEqual(["15000", "0", "5500", "9500", "manual"]);
    expect(cellOf(plan, C.fuel, "2026-10")).toMatchObject({ pendingCents: "2500", txnCount: 2 });
    expect(cellOf(plan, C.rent, "2026-10").actualCents).toBe("180000");
    expect(cellOf(plan, C.oldHobby, "2026-09").actualCents).toBe("2000");
  });

  it("auto-filled bills, the goal row and its summary, income without carry", async () => {
    const plan = await getPlan(t);
    expect(brief(cellOf(plan, C.rent, "2026-08"))).toEqual(["0", "0", "0", "0", "none"]);
    expect(brief(cellOf(plan, C.rent, "2026-09"))).toEqual(["180000", "0", "180000", "0", "recurring"]);
    expect(brief(cellOf(plan, C.rent, "2026-10"))).toEqual(["180000", "0", "180000", "0", "recurring"]);
    for (const m of ["2026-11", "2026-12", "2027-01"]) expect(brief(cellOf(plan, C.rent, m))).toEqual(["180000", "0", "0", "180000", "recurring"]);
    expect(brief(cellOf(plan, C.netflix, "2026-10"))).toEqual(["1549", "0", "1649", "-100", "recurring"]);
    expect(cellOf(plan, C.netflix, "2026-10").overspent).toBe(true);
    expect(brief(cellOf(plan, C.internet, "2026-10"))).toEqual(["7999", "0", "0", "7999", "recurring"]);
    expect(brief(cellOf(plan, C.carInsurance, "2026-12"))).toEqual(["45000", "0", "0", "45000", "recurring"]);
    for (const m of MONTHS.filter((m) => m !== "2026-12")) expect(brief(cellOf(plan, C.carInsurance, m))).toEqual(["0", "0", "0", "0", "none"]);
    for (const m of MONTHS) expect(brief(cellOf(plan, C.music, m))).toEqual(["0", "0", "0", "0", "none"]);

    expect(brief(cellOf(plan, C.emergencyFund, "2026-08"))).toEqual(["0", "0", "0", "0", "none"]);
    expect(brief(cellOf(plan, C.emergencyFund, "2026-09"))).toEqual(["50000", "0", "50000", "0", "goal"]);
    expect(brief(cellOf(plan, C.emergencyFund, "2026-10"))).toEqual(["50000", "0", "30000", "20000", "goal"]);
    expect(cellOf(plan, C.emergencyFund, "2026-10").txnCount).toBe(2);
    for (const m of ["2026-11", "2026-12", "2027-01"]) expect(brief(cellOf(plan, C.emergencyFund, m))).toEqual(["50000", "0", "0", "50000", "goal"]);
    expect(catRow(plan, C.emergencyFund).goal).toMatchObject({
      id: S.goals.emergencyFund,
      name: "Emergency Fund",
      targetCents: "1000000",
      targetDate: "2027-09-30",
      linkedAccountId: S.accounts.savings,
      linkedAccountName: "Savings",
      monthlyContributionCents: "50000",
      startMonth: "2026-09",
      startingCents: "200000",
      status: "active",
      progress: { savedCents: "280000", remainingToTargetCents: "720000", monthsLeft: 12, neededPerMonthCents: "60000", projectedCompletionMonth: "2028-01", onTrack: false, progressBp: 2800 },
    });

    expect(brief(cellOf(plan, C.paycheck, "2026-09"))).toEqual(["500000", "0", "500000", "0", "manual"]);
    expect(brief(cellOf(plan, C.paycheck, "2026-10"))).toEqual(["500000", "0", "250000", "250000", "manual"]);
    expect(cellOf(plan, C.paycheck, "2026-10")).toMatchObject({ committedCents: "500000", rolloverMode: "none", overspendCents: "0" });
    expect(brief(cellOf(plan, C.paycheck, "2026-11"))).toEqual(["500000", "0", "0", "500000", "manual"]);
    for (const m of ["2026-12", "2027-01"]) expect(brief(cellOf(plan, C.paycheck, m))).toEqual(["0", "0", "0", "0", "none"]);
  });

  it("subtotal rows and the summary strip (committed, LTS, to assign, pace, uncategorized)", async () => {
    const plan = await getPlan(t);
    const spending = (m: string) => totals(rowCell(plan, (r) => r.kind === "bucket" && r.bucket === "spending", m));
    expect(spending("2026-08")).toEqual(["0", "0", "7000", "-7000"]);
    expect(spending("2026-09")).toEqual(["70000", "0", "74000", "-4000"]);
    expect(spending("2026-10")).toEqual(["85000", "10000", "80000", "15000"]);
    expect(spending("2026-11")).toEqual(["50000", "5500", "0", "55500"]);
    expect(spending("2026-12")).toEqual(["0", "55500", "0", "55500"]);
    expect(spending("2027-01")).toEqual(["0", "55500", "0", "55500"]);
    expect(totals(rowCell(plan, (r) => r.kind === "group" && r.name === "Everyday", "2026-10"))).toEqual(["85000", "10000", "80000", "15000"]);
    expect(totals(rowCell(plan, (r) => r.kind === "group" && r.name === "Subscriptions", "2026-10"))).toEqual(["9548", "0", "1649", "7899"]);
    expect(totals(rowCell(plan, (r) => r.kind === "group" && r.name === "Housing", "2026-10"))).toEqual(["180000", "0", "180000", "0"]);
    const bills = (m: string) => totals(rowCell(plan, (r) => r.kind === "bucket" && r.bucket === "bills", m));
    expect(bills("2026-09")).toEqual(["189548", "0", "189548", "0"]);
    expect(bills("2026-10")).toEqual(["189548", "0", "181649", "7899"]);
    expect(bills("2026-11")).toEqual(["189548", "0", "0", "189548"]);
    expect(bills("2026-12")).toEqual(["234548", "0", "0", "234548"]);
    expect(bills("2027-01")).toEqual(["189548", "0", "0", "189548"]);

    expect(committed(summaryOf(plan, "2026-08"))).toEqual(["0", "0", "0", "7000"]);
    expect(committed(summaryOf(plan, "2026-09"))).toEqual(["500000", "189548", "50000", "84000"]);
    expect(committed(summaryOf(plan, "2026-10"))).toEqual(["500000", "189648", "50000", "85000"]);
    expect(committed(summaryOf(plan, "2026-11"))).toEqual(["500000", "189548", "50000", "50000"]);
    expect(committed(summaryOf(plan, "2026-12"))).toEqual(["0", "234548", "50000", "0"]);
    expect(committed(summaryOf(plan, "2027-01"))).toEqual(["0", "189548", "50000", "0"]);
    expect(summaryOf(plan, "2026-10").planned).toEqual({ income: "500000", bills: "189548", savings: "50000", spending: "85000" });
    expect(summaryOf(plan, "2026-10").actual).toEqual({ income: "250000", bills: "181649", savings: "30000", spending: "80000" });
    expect(summaryOf(plan, "2026-10").plannedLeftToSpendCents).toBe("175452");
    expect(plan.summary.map((s) => s.leftToSpendCents)).toEqual(["-7000", "176452", "175352", "210452", "-284548", "-239548"]);
    expect(plan.summary.map((s) => s.toAssignCents)).toEqual(["0", "190452", "175452", "210452", "-284548", "-239548"]);
    expect(plan.summary.map((s) => s.warning)).toEqual([true, false, false, false, true, true]);
    expect(plan.summary.map((s) => s.pace)).toEqual([null, null, { daysLeft: 19, perDayCents: "9229", overCents: "0" }, null, null, null]);
    expect(summaryOf(plan, "2026-10").uncategorized).toEqual({ count: 1, cents: "-4500" });
    expect(summaryOf(plan, "2026-09").uncategorized).toEqual({ count: 0, cents: "0" });
  });

  it("GET /api/plan/averages divides by months with data and truncates", async () => {
    const three = await t.call({ method: "GET", url: "/api/plan/averages?months=3" });
    expect(three.statusCode).toBe(200);
    expect(three.json().window).toEqual({ from: "2026-07", to: "2026-09", monthsWithData: 2 });
    const expected: Record<string, string> = {
      [C.groceries]: "23500",
      [C.dining]: "13000",
      [C.fuel]: "3000",
      [C.oldHobby]: "1000",
      [C.rent]: "90000",
      [C.netflix]: "774",
      [C.internet]: "3999",
      [C.paycheck]: "250000",
      [C.emergencyFund]: "25000",
      [C.carInsurance]: "0",
      [C.music]: "0",
      [C.shopping]: "0",
    };
    const byId = (items: Array<{ categoryId: string; averageCents: string }>) => Object.fromEntries(items.map((a) => [a.categoryId, a.averageCents]));
    expect(byId(three.json().averages)).toEqual(expected);

    const twelve = await t.call({ method: "GET", url: `/api/plan/averages?months=12&today=${TODAY}` });
    expect(twelve.json().window).toEqual({ from: "2025-10", to: "2026-09", monthsWithData: 2 });
    expect(byId(twelve.json().averages)).toEqual(expected);

    const asOf = await t.call({ method: "GET", url: "/api/plan/averages?months=3&asOf=2026-11" });
    expect(asOf.json().window).toEqual({ from: "2026-08", to: "2026-10", monthsWithData: 3 });
    expect(byId(asOf.json().averages)[C.groceries]).toBe("33833"); // (7000 + 40000 + 54500) / 3 = 33833 rem 1
    expect((await t.call({ method: "GET", url: "/api/plan/averages?months=5" })).statusCode).toBe(400);
  });

  it("range and today validation", async () => {
    const backwards = await t.call({ method: "GET", url: "/api/plan?from=2026-10&to=2026-09" });
    expect(backwards.statusCode).toBe(400);
    const wide = await t.call({ method: "GET", url: "/api/plan?from=2024-01&to=2026-12" });
    expect(wide.statusCode).toBe(400);
    expect(wide.json().error).toMatch(/At most 24 months/);
    const badMonth = await t.call({ method: "GET", url: "/api/plan?from=2026-13" });
    expect(badMonth.statusCode).toBe(400);
    expect(badMonth.json().code).toBe("validation");
    expect((await getPlan(t, "?from=2026-10")).months).toEqual(["2026-10", "2026-11", "2026-12", "2027-01"]);
    expect((await getPlan(t, "?to=2026-10")).months).toEqual(["2026-08", "2026-09", "2026-10"]);
    const noToday = await getPlan(t, "");
    expect(noToday).toMatchObject({ today: TODAY, currentMonth: "2026-10", months: MONTHS });
    expect((await getPlan(t, "?today=2026-10-15")).today).toBe("2026-10-15");
    const far = await t.call({ method: "GET", url: "/api/plan?today=2026-10-20" });
    expect(far.statusCode).toBe(400);
    expect(far.json().error).toMatch(/too far from the server date/);
    const impossible = await t.call({ method: "GET", url: "/api/plan?today=2026-10-32" });
    expect(impossible.statusCode).toBe(400);
  });

  it("a viewer session reads everything and changes nothing", async () => {
    const cookies = await viewerCookies(t);
    const as = (opts: Parameters<TestApp["call"]>[0]) => t.app.inject({ ...opts, cookies });
    for (const url of ["/api/plan", "/api/plan/averages?months=3", "/api/goals", "/api/audit", "/api/settings", "/api/categories", "/api/category-groups"]) {
      expect((await as({ method: "GET", url })).statusCode, url).toBe(200);
    }
    const mutations = [
      { method: "PUT" as const, url: "/api/plan/cells", payload: { edits: [{ month: "2026-11", categoryId: C.dining, plannedCents: "1" }] } },
      { method: "PATCH" as const, url: `/api/categories/${C.dining}`, payload: { rolloverMode: "none" } },
      { method: "DELETE" as const, url: `/api/categories/${C.shopping}` },
      { method: "POST" as const, url: "/api/goals", payload: { name: "x", categoryId: C.emergencyFund, targetCents: "1" } },
      { method: "PATCH" as const, url: "/api/settings", payload: { zeroBased: true } },
      { method: "POST" as const, url: "/api/plan/close-month", payload: {} },
    ];
    for (const m of mutations) {
      const res = await as(m);
      expect(res.statusCode, m.url).toBe(403);
      expect(res.json().code).toBe("viewer");
    }
    const plan = await getPlan(t);
    expect(brief(cellOf(plan, C.dining, "2026-11"))).toEqual(["0", "0", "0", "0", "none"]);
    expect(catRow(plan, C.shopping)).toBeDefined();
  });

  it("settings: read, audited patch, zero-based warning, validation", async () => {
    const initial = await t.call({ method: "GET", url: "/api/settings" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ planStartMonth: "2026-08", zeroBased: false, lowBalanceThresholdCents: "0", primaryAccountId: null, projectionDefaultDays: 90, timezone: "America/Denver" });

    const patched = await t.call({ method: "PATCH", url: "/api/settings", payload: { zeroBased: true, lowBalanceThresholdCents: "50000", primaryAccountId: S.accounts.checking } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ zeroBased: true, lowBalanceThresholdCents: "50000", primaryAccountId: S.accounts.checking });
    const audit = await t.call({ method: "GET", url: "/api/audit?entity=household_setting" });
    expect(audit.json().items).toHaveLength(1);
    expect(audit.json().items[0]).toMatchObject({ entityId: "1", action: "update", username: "owner", before: { zeroBased: false, lowBalanceThresholdCents: "0" }, after: { zeroBased: true, lowBalanceThresholdCents: "50000" } });

    // Zero-based: the strip's warning follows toAssign (Aug 0 is not a warning), the numbers themselves do not move.
    const plan = await getPlan(t);
    expect(plan.zeroBased).toBe(true);
    expect(plan.summary.map((s) => s.warning)).toEqual([false, false, false, false, true, true]);
    expect(summaryOf(plan, "2026-10").leftToSpendCents).toBe("175352");

    expect((await t.call({ method: "PATCH", url: "/api/settings", payload: { timezone: "Mars/Olympus" } })).statusCode).toBe(400);
    expect((await t.call({ method: "PATCH", url: "/api/settings", payload: { primaryAccountId: randomUUID() } })).statusCode).toBe(400);
    expect((await t.call({ method: "PATCH", url: "/api/settings", payload: { planStartMonth: "2026-9" } })).statusCode).toBe(400);
    const noop = await t.call({ method: "PATCH", url: "/api/settings", payload: { zeroBased: true } });
    expect(noop.statusCode).toBe(200);
    expect((await t.call({ method: "GET", url: "/api/audit?entity=household_setting" })).json().items).toHaveLength(1);

    const restored = await t.call({ method: "PATCH", url: "/api/settings", payload: { zeroBased: false, lowBalanceThresholdCents: "0", primaryAccountId: null } });
    expect(restored.json()).toMatchObject({ zeroBased: false, lowBalanceThresholdCents: "0", primaryAccountId: null });
  });

  it("POST /api/plan/close-month freezes auto values for completed months, idempotently", async () => {
    const first = await t.call({ method: "POST", url: "/api/plan/close-month", payload: {} });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ inserted: 4, through: "2026-09" }); // Rent, Netflix, Internet, Emergency Fund
    expect((await t.call({ method: "POST", url: "/api/plan/close-month", payload: {} })).json()).toEqual({ inserted: 0, through: "2026-09" });
    expect((await t.call({ method: "POST", url: "/api/plan/close-month", payload: { through: "2026-10" } })).statusCode).toBe(400);

    const plan = await getPlan(t);
    expect(cellOf(plan, C.rent, "2026-09")).toMatchObject({ plannedCents: "180000", source: "recurring", hasExplicitPlan: true });
    expect(cellOf(plan, C.emergencyFund, "2026-09")).toMatchObject({ plannedCents: "50000", source: "goal", hasExplicitPlan: true });
    expect(cellOf(plan, C.rent, "2026-08").hasExplicitPlan).toBe(false);
    expect(cellOf(plan, C.rent, "2026-10").hasExplicitPlan).toBe(false);
    expect(summaryOf(plan, "2026-09").leftToSpendCents).toBe("176452");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("PUT /api/plan/cells and drill-down", () => {
  let t: TestApp;
  let S: PlanSeed;
  let C: PlanSeed["categories"];

  beforeAll(async () => {
    ({ t, S } = await freshApp());
    C = S.categories;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const put = (edits: unknown[], extra: Record<string, unknown> = { range: RANGE }) => t.call({ method: "PUT", url: "/api/plan/cells", payload: { edits, ...extra } });
  const auditOf = async (query: string) => (await t.call({ method: "GET", url: `/api/audit?${query}` })).json().items as Array<Record<string, unknown>>;

  it("fill right: one audit batch, idempotent re-run, clearing deletes the rows", async () => {
    const edits = ["2026-11", "2026-12", "2027-01"].map((month) => ({ month, categoryId: C.dining, plannedCents: "20000" }));
    const res = await put(edits);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ changed: 3 });
    const batchId: string = res.json().batchId;
    expect(batchId).toMatch(/^[0-9a-f-]{36}$/);
    const plan = res.json().plan as PlanResponse;
    expect(plan.months).toEqual(MONTHS);
    // Dining carries its surplus, so each unspent 20000 rolls into the next month.
    expect(brief(cellOf(plan, C.dining, "2026-11"))).toEqual(["20000", "0", "0", "20000", "manual"]);
    expect(brief(cellOf(plan, C.dining, "2026-12"))).toEqual(["20000", "20000", "0", "40000", "manual"]);
    expect(brief(cellOf(plan, C.dining, "2027-01"))).toEqual(["20000", "40000", "0", "60000", "manual"]);
    for (const m of ["2026-11", "2026-12", "2027-01"]) expect(cellOf(plan, C.dining, m)).toMatchObject({ hasExplicitPlan: true, committedCents: "20000" });
    expect(summaryOf(plan, "2026-11").committed.spending).toBe("70000");
    expect(summaryOf(plan, "2026-11")).toMatchObject({ leftToSpendCents: "190452", toAssignCents: "190452" });
    expect(summaryOf(plan, "2026-12").leftToSpendCents).toBe("-304548");

    const items = await auditOf("entity=month_plan");
    expect(items).toHaveLength(3);
    expect(items.every((e) => e.batchId === batchId && e.action === "create" && e.before === null && e.username === "owner")).toBe(true);
    expect(items.map((e) => e.entityId).sort()).toEqual(["2026-11", "2026-12", "2027-01"].map((m) => `${m}:${C.dining}`));
    expect(items[0]!.after).toMatchObject({ plannedCents: "20000", source: "manual" });
    expect(await auditOf(`batchId=${batchId}`)).toHaveLength(3);

    const again = await put(edits);
    expect(again.json()).toMatchObject({ changed: 0 });
    expect(again.json().plan).not.toBeNull();
    expect(await auditOf("entity=month_plan")).toHaveLength(3);

    const cleared = await put(edits.map((e) => ({ ...e, plannedCents: null })));
    expect(cleared.json()).toMatchObject({ changed: 3 });
    for (const m of ["2026-11", "2026-12", "2027-01"]) expect(brief(cellOf(cleared.json().plan, C.dining, m))).toEqual(["0", "0", "0", "0", "none"]);
    const deletes = (await auditOf("entity=month_plan")).filter((e) => e.action === "delete");
    expect(deletes).toHaveLength(3);
    expect(deletes[0]!.after).toBeNull();
  });

  it("override a recurring bill, then clear to auto; audit newest first; negative cents rejected", async () => {
    const rentOct = `2026-10:${C.rent}`;
    const over = await put([{ month: "2026-10", categoryId: C.rent, plannedCents: "190000" }]);
    expect(over.json()).toMatchObject({ changed: 1 });
    expect(brief(cellOf(over.json().plan, C.rent, "2026-10"))).toEqual(["190000", "0", "180000", "10000", "manual"]);
    expect(summaryOf(over.json().plan, "2026-10")).toMatchObject({ leftToSpendCents: "165352", toAssignCents: "165452" });
    expect(summaryOf(over.json().plan, "2026-10").committed.bills).toBe("199648");

    const back = await put([{ month: "2026-10", categoryId: C.rent, plannedCents: null }]);
    expect(back.json()).toMatchObject({ changed: 1 });
    expect(brief(cellOf(back.json().plan, C.rent, "2026-10"))).toEqual(["180000", "0", "180000", "0", "recurring"]);
    expect(summaryOf(back.json().plan, "2026-10").leftToSpendCents).toBe("175352");

    const history = await auditOf(`entity=month_plan&entityId=${encodeURIComponent(rentOct)}`);
    expect(history.map((e) => e.action)).toEqual(["delete", "create"]);
    expect(history[0]!.before).toMatchObject({ plannedCents: "190000", source: "manual" });
    expect(history[0]!.after).toBeNull();
    expect(history[1]!.before).toBeNull();
    expect(history[1]!.after).toMatchObject({ plannedCents: "190000", source: "manual" });

    const negative = await put([{ month: "2026-10", categoryId: C.rent, plannedCents: "-100" }]);
    expect(negative.statusCode).toBe(400);
    expect(negative.json().code).toBe("validation");
    expect(await auditOf(`entity=month_plan&entityId=${encodeURIComponent(rentOct)}`)).toHaveLength(2);

    const unknown = await put([{ month: "2026-10", categoryId: randomUUID(), plannedCents: "1" }]);
    expect(unknown.statusCode).toBe(404);
    const early = await put([{ month: "2026-07", categoryId: C.rent, plannedCents: "1" }]);
    expect(early.statusCode).toBe(400);
    expect(early.json().code).toBe("before_plan_start");
    const income = await put([{ month: "2026-10", categoryId: C.paycheck, rolloverMode: "surplus" }]);
    expect(income.statusCode).toBe(400);
    expect(income.json().code).toBe("income_no_rollover");
    const noRange = await put([{ month: "2026-10", categoryId: C.rent, note: "paid early" }], {});
    expect(noRange.statusCode).toBe(200);
    expect(noRange.json()).toMatchObject({ changed: 1, plan: null });
    const farToday = await put([{ month: "2026-10", categoryId: C.rent, note: "x" }], { today: "2026-10-01" });
    expect(farToday.statusCode).toBe(400);
    expect((await put([{ month: "2026-10", categoryId: C.rent, note: null }], {})).json()).toMatchObject({ changed: 1 });
  });

  it("an average-sourced edit feeds the carry chain", async () => {
    const res = await put([{ month: "2026-11", categoryId: C.groceries, plannedCents: "23500", source: "average" }]);
    expect(res.json()).toMatchObject({ changed: 1 });
    const plan = res.json().plan as PlanResponse;
    expect(brief(cellOf(plan, C.groceries, "2026-11"))).toEqual(["23500", "5500", "0", "29000", "average"]);
    expect(brief(cellOf(plan, C.groceries, "2026-12"))).toEqual(["0", "29000", "0", "29000", "none"]);
    expect(brief(cellOf(plan, C.groceries, "2027-01"))).toEqual(["0", "29000", "0", "29000", "none"]);
    expect(summaryOf(plan, "2026-11").committed.spending).toBe("23500");
    expect(summaryOf(plan, "2026-11")).toMatchObject({ leftToSpendCents: "236952", toAssignCents: "236952" });
    const [latest] = await auditOf(`entity=month_plan&entityId=${encodeURIComponent(`2026-11:${C.groceries}`)}`);
    expect(latest).toMatchObject({ action: "update", before: { plannedCents: "50000", source: "manual" }, after: { plannedCents: "23500", source: "average" } });

    // Fill right over an average-sourced cell overwrites it as manual.
    const restored = await put([{ month: "2026-11", categoryId: C.groceries, plannedCents: "50000" }]);
    expect(restored.json()).toMatchObject({ changed: 1 });
    expect(brief(cellOf(restored.json().plan, C.groceries, "2026-11"))).toEqual(["50000", "5500", "0", "55500", "manual"]);
  });

  it("drill-down query params (category, goal, uncategorized) and drag-to-categorize", async () => {
    const list = async (query: string) => (await t.call({ method: "GET", url: `/api/transactions?${query}` })).json().items as Array<Record<string, unknown>>;
    const groceries = await list(`categoryId=${C.groceries}&from=2026-10-01&to=2026-10-31&transfers=exclude`);
    expect(groceries.map((i) => i.amountCents)).toEqual(["1500", "-21000", "-35000"]);
    const goal = await list(`goalId=${S.goals.emergencyFund}&from=2026-10-01&to=2026-10-31`);
    expect(goal.map((i) => [i.amountCents, i.accountId, i.isTransfer])).toEqual([
      ["-20000", S.accounts.savings, true],
      ["50000", S.accounts.savings, true],
    ]);
    const uncategorized = await list("uncategorized=true&from=2026-10-01&to=2026-10-31");
    expect(uncategorized.map((i) => i.rawDescription)).toEqual(["AMAZON"]);

    const patched = await t.call({ method: "PATCH", url: `/api/transactions/${S.transactions.amazon}`, payload: { categoryId: C.shopping } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ categoryId: C.shopping, categoryLocked: true });
    const plan = await getPlan(t);
    expect(brief(cellOf(plan, C.shopping, "2026-10"))).toEqual(["0", "0", "4500", "-4500", "none"]);
    expect(cellOf(plan, C.shopping, "2026-10").overspent).toBe(true);
    expect(summaryOf(plan, "2026-10").uncategorized).toEqual({ count: 0, cents: "0" });
    expect(summaryOf(plan, "2026-10").committed.spending).toBe("89500");
    expect(summaryOf(plan, "2026-10")).toMatchObject({ leftToSpendCents: "170852", toAssignCents: "175452", pace: { daysLeft: 19, perDayCents: "8992", overCents: "0" } });
  });
});
