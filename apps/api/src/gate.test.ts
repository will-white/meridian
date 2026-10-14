import { eq, isNotNull, sql } from "drizzle-orm";
import type { InjectOptions } from "fastify";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, applyAccountSet, category, claimNextJob, closeMonth, completeJob, connection, runRecurringDetection, transaction } from "@meridian/db";
import { ACCOUNTS, buildTruth, expectedFinalCount, FIXTURE_START, renderAccountSet } from "@meridian/db/testing";
import {
  addDays,
  addMonths,
  monthKey,
  truncDiv,
  type AlertList,
  type CashFlowProjectionResponse,
  type CategoryView,
  type DashboardView,
  type GoalView,
  type HouseholdSettingView,
  type IsoDate,
  type MonthKey,
  type MonthSummaryView,
  type PlanAveragesResponse,
  type PlanCellEdit,
  type PlanCellView,
  type PlanResponse,
  type PlanRow,
  type RecurringList,
  type RecurringView,
  type SetPlanCellsResponse,
  type SubscriptionsResponse,
} from "@meridian/shared";
import { createTestApp, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/**
 * Phase 2 gate (spec: "one full month budgeted in this app instead of the
 * current one"), played end to end on the Phase 1 household extended through
 * October 2026:
 *
 *   Oct 2   sync Jul 1 .. Oct 1, categorize with rules, run recurring detection
 *           (the queued job, run as the worker runs it), confirm the suggestions,
 *           add the one bill detection could not yet see, set a savings goal,
 *           plan every spending category from its 3-month average and budget
 *           the whole of October through the HTTP API.
 *   Nov 1   sync the rest of October with an overlapping window, run detection
 *           again, read October back as a closed month, freeze it with
 *           close-month, and check the dashboard, cash flow and subscriptions.
 *
 * Every grid number is checked against sums derived here from the ledger with
 * a different query, and every fixed amount (paychecks, rent, interest, the
 * goal) is hand-calculated.
 */

const OCT_END: IsoDate = "2026-10-31";
const truth = buildTruth(OCT_END);
const CENTS = { paycheck: 250000n, rent: 180000n, interest: 1234n, xcel: 11000n, goal: 50000n };
type CategoryRowView = Extract<PlanRow, { kind: "category" }>;

describe.skipIf(!TEST_DATABASE_URL)("Phase 2 gate: October 2026 budgeted end to end", () => {
  let t: TestApp;
  let connectionId: string;
  /** Server clock and the household date it maps to (18:00Z is noon in America/Denver). */
  let today: IsoDate = "2026-10-02";
  let now = new Date(`${today}T18:00:00Z`);
  const setClock = (date: IsoDate) => {
    today = date;
    now = new Date(`${date}T18:00:00Z`);
  };
  const cat: Record<string, string> = {};
  const acct: Record<"checking" | "savings" | "card", string> = { checking: "", savings: "", card: "" };
  const recurringIds: Record<string, string> = {};
  let goalId = "";
  let octoberBatchId = "";
  let plannedSpendingOct = 0n;

  beforeAll(async () => {
    t = await createTestApp({ now: () => now });
    await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "correct horse battery staple" } });
    const setup = await t.call({ method: "POST", url: "/api/auth/totp/setup" });
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json().secret), digits: 6, period: 30 }).generate();
    await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code } });
    const [conn] = await t.db.db.insert(connection).values({ type: "simplefin", name: "First Example Bank" }).returning();
    connectionId = conn!.id;
    for (const c of await get<CategoryView[]>("/api/categories")) cat[c.name] = c.id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  // ---- helpers ----

  async function get<T>(url: string): Promise<T> {
    const res = await t.call({ method: "GET", url });
    expect(res.statusCode, `GET ${url}: ${res.body}`).toBe(200);
    return res.json() as T;
  }
  async function send<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object): Promise<T> {
    const opts: InjectOptions = { method, url };
    if (payload !== undefined) opts.payload = payload;
    const res = await t.call(opts);
    expect([200, 201, 202], `${method} ${url}: ${res.statusCode} ${res.body}`).toContain(res.statusCode);
    return res.json() as T;
  }

  /** What the Bridge returns for `start-date=start` on day `asOf`, applied like the sync job does. */
  async function sync(start: IsoDate, asOf: IsoDate) {
    return applyAccountSet(t.db.db, { connectionId, accountSet: renderAccountSet({ start, asOf, truth }), windowStart: start });
  }

  /** Run every queued job the way apps/worker's runner does, in queue order. */
  async function drainJobs(): Promise<string[]> {
    const ran: string[] = [];
    for (;;) {
      const j = await claimNextJob(t.db.db, "gate-worker");
      if (!j) return ran;
      if (j.type === "recurring.detect") await runRecurringDetection(t.db.db, { today, now });
      else if (j.type === "plan.close_month") await closeMonth(t.db.db, addMonths(monthKey(today), -1), { today });
      else throw new Error(`unexpected job ${j.type}`);
      await completeJob(t.db.db, j.id);
      ran.push(j.type);
    }
  }

  interface Ledger {
    byCategoryMonth: Map<string, { bucket: string; cents: bigint; n: number }>;
    /** Net transfer legs (+ in, − out) in the savings account per month: the goal's extra actual (plan §7). */
    savingsNetByMonth: Map<string, bigint>;
  }
  /** The grid's actuals derived independently: signed sums per (category, month) over categorized non-transfer rows. */
  async function ledgerByCategoryMonth(): Promise<Ledger> {
    const month = sql<string>`to_char(${transaction.date}, 'YYYY-MM')`;
    const rows = await t.db.db
      .select({ name: category.name, bucket: category.bucket, month, cents: sql<string>`sum(${transaction.amountCents})::text`, n: sql<number>`count(*)::int` })
      .from(transaction)
      .innerJoin(category, eq(category.id, transaction.categoryId))
      .where(eq(transaction.isTransfer, false))
      .groupBy(category.name, category.bucket, month);
    const byCategoryMonth = new Map<string, { bucket: string; cents: bigint; n: number }>();
    for (const r of rows) byCategoryMonth.set(`${r.name}|${r.month}`, { bucket: r.bucket, cents: BigInt(r.cents), n: r.n });
    const nets = await t.db.db
      .select({ month, cents: sql<string>`sum(${transaction.amountCents})::text` })
      .from(transaction)
      .where(sql`${transaction.isTransfer} = true and ${transaction.accountId} = ${acct.savings}`)
      .groupBy(month);
    return { byCategoryMonth, savingsNetByMonth: new Map(nets.map((r) => [r.month, BigInt(r.cents)])) };
  }
  /** Bucket-natural actual (income +, everything else −) for one category and month; the goal category adds its account's net transfers. */
  function naturalActual(ledger: Ledger, name: string, month: MonthKey): bigint {
    const r = ledger.byCategoryMonth.get(`${name}|${month}`);
    const base = r ? (r.bucket === "income" ? r.cents : -r.cents) : 0n;
    return name === "Savings" ? base + (ledger.savingsNetByMonth.get(month) ?? 0n) : base;
  }

  const catRows = (plan: PlanResponse) => plan.rows.filter((r): r is CategoryRowView => r.kind === "category");
  function cell(plan: PlanResponse, name: string, month: MonthKey): PlanCellView {
    const row = catRows(plan).find((r) => r.name === name);
    const c = row?.cells[plan.months.indexOf(month)];
    if (!c) throw new Error(`no cell for ${name} ${month}`);
    return c;
  }
  function summary(plan: PlanResponse, month: MonthKey): MonthSummaryView {
    const s = plan.summary[plan.months.indexOf(month)];
    if (!s) throw new Error(`no summary for ${month}`);
    return s;
  }
  const big = (s: string) => BigInt(s);

  // ---- October 2: set up the month ----

  it("syncs three months of history and categorizes it with rules", async () => {
    const result = await sync(FIXTURE_START, "2026-10-01");
    expect(result.accounts).toBe(3);
    expect(result.errors).toEqual([]);
    for (const a of await t.db.db.select().from(account)) {
      if (a.externalId === ACCOUNTS.checking.id) acct.checking = a.id;
      if (a.externalId === ACCOUNTS.savings.id) acct.savings = a.id;
      if (a.externalId === ACCOUNTS.card.id) acct.card = a.id;
    }
    expect(Object.values(acct).every(Boolean)).toBe(true);

    const rules: Array<[string, string]> = [
      ["Acme Corp Payroll", "Paycheck"],
      ["Interest Payment", "Interest & Dividends"],
      ["Rent Payment Oakwood Apts", "Rent / Mortgage"],
      ["Xcel Energy", "Utilities"],
      ["King Soopers", "Groceries"],
      ["Costco Whse", "Groceries"],
      ["Blue Bottle Coffee", "Dining"],
      ["The Local Taphouse", "Dining"],
      ["Shell Oil", "Fuel"],
      ["Amazon.com", "Shopping"],
    ];
    for (const [payeeName, categoryName] of rules) {
      await send("POST", "/api/rules", { name: payeeName, conditions: { payee: { op: "equals", value: payeeName } }, actions: { setCategoryId: cat[categoryName] } });
    }
    const [left] = await t.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(transaction)
      .where(sql`${transaction.categoryId} is null and ${transaction.isTransfer} = false`);
    expect(left!.n).toBe(0);

    const settings = await get<HouseholdSettingView>("/api/settings");
    expect(settings.planStartMonth).toBe("2026-07"); // the ledger's first month
    const patched = await send<HouseholdSettingView>("PATCH", "/api/settings", { primaryAccountId: acct.checking, lowBalanceThresholdCents: "100000" });
    expect(patched.primaryAccountId).toBe(acct.checking);
  });

  it("detects the recurring series and the owner confirms them", async () => {
    const detect = await send<{ jobId: string; created: boolean }>("POST", "/api/recurring/detect");
    expect(detect.created).toBe(true);
    expect(await drainJobs()).toEqual(["recurring.detect"]);

    const suggested = await get<RecurringList>("/api/recurring?status=suggested");
    const byPayee = new Map(suggested.items.map((r) => [r.payeeName, r]));
    const paycheck = byPayee.get("Acme Corp Payroll")!;
    const rent = byPayee.get("Rent Payment Oakwood Apts")!;
    const interest = byPayee.get("Interest Payment")!;
    expect(paycheck).toMatchObject({ cadence: "biweekly", expectedCents: "250000", accountId: acct.checking, nextDueDate: "2026-10-09", chargeCount: 7 });
    expect(paycheck.anchorDate).toBe("2026-09-25"); // the last Friday paid
    expect(rent).toMatchObject({ cadence: "monthly", anchorDay: 1, expectedCents: "-180000", accountId: acct.checking, nextDueDate: "2026-11-01", chargeCount: 4 });
    expect(interest).toMatchObject({ cadence: "monthly", anchorDay: 28, expectedCents: "1234", accountId: acct.savings, nextDueDate: "2026-10-28", chargeCount: 3 });
    // Transfers (card payments, savings sweeps) never become suggestions, and three variable utility bills are not yet
    // enough. The card's coffee habit happens to fit a twice-monthly pattern at low confidence: the owner dismisses it.
    expect([...byPayee.keys()].sort()).toEqual(["Acme Corp Payroll", "Blue Bottle Coffee", "Interest Payment", "Rent Payment Oakwood Apts"]);
    const coffee = byPayee.get("Blue Bottle Coffee")!;
    expect(coffee.confidence).toBeLessThan(paycheck.confidence!);
    expect((await send<RecurringView>("PATCH", `/api/recurring/${coffee.id}`, { status: "dismissed" })).status).toBe("dismissed");

    for (const [item, categoryName] of [
      [paycheck, "Paycheck"],
      [rent, "Rent / Mortgage"],
      [interest, "Interest & Dividends"],
    ] as const) {
      const view = await send<RecurringView>("PATCH", `/api/recurring/${item.id}`, { status: "active", categoryId: cat[categoryName] });
      expect(view.status).toBe("active");
      expect(view.categoryName).toBe(categoryName);
      recurringIds[categoryName] = view.id;
    }
    // The utility bill is added by hand (variable amount, due on the 12th).
    const xcel = await send<RecurringView>("POST", "/api/recurring", {
      name: "Xcel Energy",
      payeeName: "Xcel Energy",
      categoryId: cat["Utilities"],
      accountId: acct.checking,
      cadence: "monthly",
      anchorDay: 12,
      expectedCents: (-CENTS.xcel).toString(),
      amountMode: "variable",
    });
    expect(xcel).toMatchObject({ status: "active", source: "manual", nextDueDate: "2026-10-12", payeeName: "Xcel Energy" });
    recurringIds["Utilities"] = xcel.id;
    expect((await get<RecurringList>("/api/recurring?status=suggested")).items).toEqual([]);
  });

  it("sets a savings goal whose progress is the sweeps into the linked account", async () => {
    const goal = await send<GoalView>("POST", "/api/goals", {
      name: "Emergency fund",
      categoryId: cat["Savings"],
      targetCents: "1000000",
      linkedAccountId: acct.savings,
      monthlyContributionCents: CENTS.goal.toString(),
      startMonth: "2026-07",
    });
    goalId = goal.id;
    // Jul 15, Aug 15, Sep 15 sweeps of $500; interest is income, not a transfer, so it does not count.
    expect(goal.progress).toMatchObject({ savedCents: "150000", remainingToTargetCents: "850000", progressBp: 1500 });
  });

  it("plans October from the 3-month averages and budgets every category with history", async () => {
    const ledger = await ledgerByCategoryMonth();
    const avg = await get<PlanAveragesResponse>(`/api/plan/averages?months=3&asOf=2026-10&today=${today}`);
    expect(avg.window).toEqual({ from: "2026-07", to: "2026-09", monthsWithData: 3 });
    const idToName = new Map(Object.entries(cat).map(([n, id]) => [id, n]));
    const expectedAverages: Record<string, string> = {};
    for (const [name] of Object.entries(cat)) {
      let sum = 0n;
      for (const m of ["2026-07", "2026-08", "2026-09"] as MonthKey[]) sum += naturalActual(ledger, name, m);
      const a = truncDiv(sum, 3n);
      expectedAverages[name] = (a < 0n ? 0n : a).toString();
    }
    for (const a of avg.averages) expect(a.averageCents, idToName.get(a.categoryId)).toBe(expectedAverages[idToName.get(a.categoryId)!]);
    expect(expectedAverages["Groceries"]).not.toBe("0");
    expect(expectedAverages["Paycheck"]).toBe("583333"); // 7 paychecks over 3 months: 1750000 / 3, truncated

    // Plan-from-average for every spending category with history, plus one hand-typed envelope and a note.
    const spendingIds = new Set((await get<CategoryView[]>("/api/categories")).filter((c) => c.bucket === "spending").map((c) => c.id));
    const edits: PlanCellEdit[] = avg.averages
      .filter((a) => a.averageCents !== "0" && spendingIds.has(a.categoryId))
      .map((a) => ({ month: "2026-10", categoryId: a.categoryId, plannedCents: a.averageCents, source: "average" }));
    expect(edits.map((e) => idToName.get(e.categoryId)).sort()).toEqual(["Dining", "Fuel", "Groceries", "Shopping"]);
    edits.push({ month: "2026-10", categoryId: cat["Entertainment"]!, plannedCents: "10000", source: "manual" });
    const res = await send<SetPlanCellsResponse>("PUT", "/api/plan/cells", {
      edits: [...edits, { month: "2026-10", categoryId: cat["Groceries"], note: "Costco run on the 20th" }],
      range: { from: "2026-08", to: "2026-11" },
      today,
    });
    expect(res.changed).toBe(edits.length + 1);
    octoberBatchId = res.batchId;
    const plan = res.plan!;
    expect(plan.months).toEqual(["2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(plan.currentMonth).toBe("2026-10");

    // Bills and income come from the confirmed items; savings from the goal; spending from the averages.
    expect(cell(plan, "Paycheck", "2026-10")).toMatchObject({ plannedCents: (2n * CENTS.paycheck).toString(), source: "recurring", hasExplicitPlan: false }); // Oct 9 and Oct 23
    expect(cell(plan, "Interest & Dividends", "2026-10")).toMatchObject({ plannedCents: CENTS.interest.toString(), source: "recurring" });
    expect(cell(plan, "Rent / Mortgage", "2026-10")).toMatchObject({ plannedCents: CENTS.rent.toString(), source: "recurring", actualCents: CENTS.rent.toString(), remainingCents: "0" });
    expect(cell(plan, "Utilities", "2026-10")).toMatchObject({ plannedCents: CENTS.xcel.toString(), source: "recurring", actualCents: "0" });
    expect(cell(plan, "Savings", "2026-10")).toMatchObject({ plannedCents: CENTS.goal.toString(), source: "goal" });
    expect(cell(plan, "Groceries", "2026-10")).toMatchObject({ plannedCents: expectedAverages["Groceries"], source: "average", hasExplicitPlan: true, note: "Costco run on the 20th" });
    expect(cell(plan, "Entertainment", "2026-10")).toMatchObject({ plannedCents: "10000", source: "manual" });

    // Every category that had activity in the history is budgeted for October; the untouched ones are zero.
    for (const row of catRows(plan)) {
      const history = ["2026-07", "2026-08", "2026-09"].reduce((s, m) => s + naturalActual(ledger, row.name, m as MonthKey), 0n);
      const oct = cell(plan, row.name, "2026-10");
      if (history > 0n || row.name === "Savings") expect(big(oct.plannedCents), row.name).toBeGreaterThan(0n);
      else if (row.name !== "Entertainment") expect(oct, row.name).toMatchObject({ plannedCents: "0", source: "none" });
    }

    // Summary, hand-calculated: planned income 5,012.34; bills 1,910.00; savings 500.00.
    const s = summary(plan, "2026-10");
    plannedSpendingOct = catRows(plan)
      .filter((r) => r.bucket === "spending")
      .reduce((sum, r) => sum + big(cell(plan, r.name, "2026-10").plannedCents), 0n);
    expect(s.planned).toEqual({ income: "501234", bills: "191000", savings: "50000", spending: plannedSpendingOct.toString() });
    expect(big(s.plannedLeftToSpendCents)).toBe(501234n - 191000n - 50000n - plannedSpendingOct);
    expect(s.state).toBe("current");
    expect(s.uncategorized).toEqual({ count: 0, cents: "0" });
    // Oct 1 rent is the only October activity so far: committed = planned everywhere, pace over the 30 days left.
    expect(s.actual.bills).toBe(CENTS.rent.toString());
    expect(s.committed).toEqual(s.planned);
    expect(s.leftToSpendCents).toBe(s.plannedLeftToSpendCents);
    expect(s.pace).toEqual({ daysLeft: 30, perDayCents: truncDiv(big(s.leftToSpendCents), 30n).toString(), overCents: "0" });
    expect(s.warning).toBe(false);

    // September, already complete, shows the same recurring values and its real actuals.
    expect(cell(plan, "Paycheck", "2026-09")).toMatchObject({ plannedCents: (2n * CENTS.paycheck).toString(), actualCents: naturalActual(ledger, "Paycheck", "2026-09").toString() });
    expect(cell(plan, "Groceries", "2026-09").actualCents).toBe(naturalActual(ledger, "Groceries", "2026-09").toString());
    expect(summary(plan, "2026-09").state).toBe("past");

    // One audit batch for the whole write.
    const audit = await get<{ items: Array<{ batchId: string; entity: string; action: string }> }>("/api/audit?entity=month_plan&limit=100");
    expect(audit.items.filter((a) => a.batchId === octoberBatchId)).toHaveLength(edits.length + 1);
  });

  // ---- November 1: the month has passed ----

  it("syncs the rest of October with an overlapping window: no duplicates, pending charges posted in place", async () => {
    setClock("2026-11-01");
    const before = await t.db.db.select({ n: sql<number>`count(*)::int` }).from(transaction);
    const result = await sync(addDays("2026-10-01", -7), OCT_END);
    expect(result.errors).toEqual([]);
    const dupes = await t.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(transaction)
      .where(isNotNull(transaction.externalId))
      .groupBy(transaction.accountId, transaction.externalId)
      .having(sql`count(*) > 1`);
    expect(dupes).toEqual([]);
    const after = await t.db.db.select({ n: sql<number>`count(*)::int` }).from(transaction);
    expect(after[0]!.n).toBe(before[0]!.n + result.stats.created - result.stats.removedPending);
    expect(after[0]!.n).toBe(expectedFinalCount(truth));
    // Rules kept categorizing the new rows as they landed.
    const [left] = await t.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(transaction)
      .where(sql`${transaction.categoryId} is null and ${transaction.isTransfer} = false`);
    expect(left!.n).toBe(0);
    expect(result.stats.created).toBeGreaterThan(0);
  });

  it("the second detection run links October's charges and raises no false alerts", async () => {
    await send("POST", "/api/recurring/detect");
    expect(await drainJobs()).toEqual(["recurring.detect"]);
    const all = await get<RecurringList>("/api/recurring?status=all");
    const byName = new Map(all.items.map((r) => [r.categoryName, r]));
    expect(byName.get("Paycheck")).toMatchObject({ chargeCount: 9, lastChargeDate: "2026-10-23", nextDueDate: "2026-11-06", consecutiveMissed: 0, overdue: false });
    expect(byName.get("Rent / Mortgage")).toMatchObject({ chargeCount: 4, lastChargeDate: "2026-10-01", nextDueDate: "2026-11-01", consecutiveMissed: 0 });
    expect(byName.get("Interest & Dividends")).toMatchObject({ chargeCount: 4, lastChargeDate: "2026-10-28", nextDueDate: "2026-11-28" });
    // The hand-made Xcel item links its charges from the period it was created in (Sep 12 was that period's bill, Oct 12 is new);
    // the detector saw the same four-charge series, mapped it onto the user's row by link overlap and left the row alone.
    expect(byName.get("Utilities")).toMatchObject({ chargeCount: 2, firstChargeDate: "2026-09-12", lastChargeDate: "2026-10-12", nextDueDate: "2026-11-12", status: "active", source: "manual", expectedCents: "-11000" });
    expect(all.items.filter((r) => r.status !== "dismissed").every((r) => r.status === "active")).toBe(true);
    expect(all.items.map((r) => r.payeeName).sort()).toEqual(["Acme Corp Payroll", "Blue Bottle Coffee", "Interest Payment", "Rent Payment Oakwood Apts", "Xcel Energy"]);
    expect(all.items.filter((r) => r.status === "suggested")).toEqual([]);
    const alerts = await get<AlertList>("/api/alerts");
    expect(alerts.items.map((a) => [a.kind, a.payeeName])).toEqual([]);
  });

  it("reads October back as a completed month with the ledger's actuals", async () => {
    const ledger = await ledgerByCategoryMonth();
    const plan = await get<PlanResponse>(`/api/plan?from=2026-09&to=2026-11&today=${today}`);
    expect(plan.currentMonth).toBe("2026-11");
    const s = summary(plan, "2026-10");
    expect(s.state).toBe("past");
    expect(s.pace).toBeNull();

    // Actuals per bucket, from the independent ledger sums (the goal's actual is the Oct 15 sweep into savings).
    const bucketActual = (bucket: string) => catRows(plan).filter((r) => r.bucket === bucket).reduce((sum, r) => sum + naturalActual(ledger, r.name, "2026-10"), 0n);
    expect(s.actual).toEqual({
      income: (2n * CENTS.paycheck + CENTS.interest).toString(),
      bills: bucketActual("bills").toString(),
      savings: CENTS.goal.toString(),
      spending: bucketActual("spending").toString(),
    });
    expect(bucketActual("bills")).toBeGreaterThan(CENTS.rent); // rent plus the real Xcel bill
    expect(cell(plan, "Savings", "2026-10")).toMatchObject({ plannedCents: CENTS.goal.toString(), actualCents: CENTS.goal.toString(), remainingCents: "0" });

    // Each cell: remaining = planned − actual (no rollover anywhere), committed = max(planned, actual); the strip sums them.
    const committed = { income: 0n, bills: 0n, savings: 0n, spending: 0n };
    for (const row of catRows(plan)) {
      const c = cell(plan, row.name, "2026-10");
      const planned = big(c.plannedCents);
      const actual = big(c.actualCents);
      expect(c.carriedInCents, row.name).toBe("0");
      expect(big(c.remainingCents), row.name).toBe(planned - actual);
      expect(big(c.committedCents), row.name).toBe(planned > actual ? planned : actual);
      expect(c.overspent, row.name).toBe(row.bucket !== "income" && actual > planned);
      committed[row.bucket] += big(c.committedCents);
    }
    expect(s.committed).toEqual({ income: committed.income.toString(), bills: committed.bills.toString(), savings: committed.savings.toString(), spending: committed.spending.toString() });
    expect(big(s.leftToSpendCents)).toBe(committed.income - committed.bills - committed.savings - committed.spending);
    expect(s.uncategorized).toEqual({ count: 0, cents: "0" });

    // November is live and still unplanned for spending; the confirmed items already fill in bills and income.
    expect(cell(plan, "Paycheck", "2026-11")).toMatchObject({ plannedCents: (2n * CENTS.paycheck).toString(), source: "recurring" }); // Nov 6, Nov 20
    expect(cell(plan, "Rent / Mortgage", "2026-11")).toMatchObject({ plannedCents: CENTS.rent.toString(), source: "recurring" });
    expect(cell(plan, "Groceries", "2026-11")).toMatchObject({ plannedCents: "0", source: "none" });
    expect(summary(plan, "2026-11").planned).toEqual({ income: "501234", bills: "191000", savings: "50000", spending: "0" });

    // The goal grew by October's sweep.
    const goal = await get<GoalView>(`/api/goals/${goalId}?today=${today}`);
    expect(goal.progress).toMatchObject({ savedCents: "200000", progressBp: 2000 });
  });

  it("close-month freezes October's auto values so a later price change leaves history alone", async () => {
    const first = await send<{ inserted: number; through: MonthKey }>("POST", "/api/plan/close-month", {});
    // One row per month from Jul to Oct for Paycheck, Rent, Interest and the goal (16), plus Utilities from its first linked charge (Sep, Oct).
    expect(first).toEqual({ inserted: 18, through: "2026-10" });
    expect(await send("POST", "/api/plan/close-month", {})).toEqual({ inserted: 0, through: "2026-10" });

    const patched = await send<RecurringView>("PATCH", `/api/recurring/${recurringIds["Paycheck"]}`, { expectedCents: "260000" });
    expect(patched.amountLocked).toBe(true);
    const plan = await get<PlanResponse>(`/api/plan?from=2026-10&to=2026-11&today=${today}`);
    expect(cell(plan, "Paycheck", "2026-10")).toMatchObject({ plannedCents: "500000", source: "recurring", hasExplicitPlan: true });
    expect(cell(plan, "Paycheck", "2026-11")).toMatchObject({ plannedCents: "520000", source: "recurring", hasExplicitPlan: false });
    expect(cell(plan, "Savings", "2026-10")).toMatchObject({ plannedCents: "50000", source: "goal", hasExplicitPlan: true });
    expect(summary(plan, "2026-11").planned.income).toBe("521234");
  });

  it("dashboard, cash flow and subscriptions agree with the plan", async () => {
    const dash = await get<DashboardView>(`/api/dashboard?today=${today}`);
    expect(dash.plan.month).toBe("2026-11");
    expect(dash.plan.planned).toEqual({ income: "521234", bills: "191000", savings: "50000", spending: "0" });
    expect(dash.review).toEqual({ uncategorized: 0, suggestedRecurring: 0, alerts: 0 });
    // Outflows due in the next 14 days, soonest first; income never appears here.
    expect(dash.billsDue.map((b) => [b.name, b.dueDate, b.amountCents, b.overdue])).toEqual([
      ["Rent Payment Oakwood Apts", "2026-11-01", "-180000", false],
      ["Xcel Energy", "2026-11-12", "-11000", false],
    ]);
    // Net worth is the three bank balances: 4,210.55 + 15,230.12 − 842.19.
    expect(dash.netWorth.todayCents).toBe("1859848");
    expect(dash.netWorth.changeCents).toBeNull();
    expect(dash.cashFlow.thresholdCents).toBe("100000");

    const cf = await send<CashFlowProjectionResponse>("POST", "/api/cashflow/projection", { today, horizonDays: 30 });
    expect(cf.endDate).toBe("2026-12-01");
    expect(cf.accounts.map((a) => a.name).sort()).toEqual(["Everyday Checking", "High Yield Savings", "Sapphire Visa"]);
    // Opening balances are the bank balances plus the charges still pending on Oct 31 (cashflow design §data model).
    const [pending] = await t.db.db.select({ cents: sql<string>`coalesce(sum(${transaction.amountCents}), 0)::text` }).from(transaction).where(eq(transaction.pending, true));
    expect(big(cf.combined.openingCents)).toBe(1859848n + big(pending!.cents));
    const events = cf.events.filter((e) => e.applied).map((e) => [e.date, e.label, e.amountCents, e.kind]);
    expect(events).toEqual([
      ["2026-11-01", "Rent Payment Oakwood Apts", "-180000", "bill"],
      ["2026-11-06", "Acme Corp Payroll", "260000", "income"],
      ["2026-11-12", "Xcel Energy", "-11000", "bill"],
      ["2026-11-20", "Acme Corp Payroll", "260000", "income"],
      ["2026-11-28", "Interest Payment", "1234", "income"],
      ["2026-12-01", "Rent Payment Oakwood Apts", "-180000", "bill"], // the 30-day horizon ends on Dec 1
    ]);
    // The combined line ends at opening + events − the spending spread day by day inside the horizon
    // (each spread is baseCents per day over its window, one extra cent on the first extraCentDays days).
    const eventTotal = cf.events.filter((e) => e.applied).reduce((s, e) => s + big(e.amountCents), 0n);
    let spreadApplied = 0n;
    for (const x of cf.spreads) {
      expect(big(x.totalCents)).toBe(big(x.baseCents) * BigInt(x.days) + BigInt(x.extraCentDays));
      for (let i = 0; i < x.days; i++) {
        const d = addDays(x.windowStart, i);
        if (d < today || d > cf.endDate) continue;
        spreadApplied += big(x.baseCents) + (i < x.extraCentDays ? 1n : 0n);
      }
    }
    expect(big(cf.combined.points.at(-1)!)).toBe(big(cf.combined.openingCents) + eventTotal - spreadApplied);
    expect(cf.warnings.some((w) => /average/.test(w))).toBe(true); // November's spending is unplanned, so the 3-month average carries it

    const subs = await get<SubscriptionsResponse>("/api/recurring/subscriptions");
    expect(subs.items.map((r) => [r.name, r.expectedCents, r.yearlyCents, r.monthlyEquivalentCents])).toEqual([
      ["Rent Payment Oakwood Apts", "-180000", "-2160000", "-180000"],
      ["Xcel Energy", "-11000", "-132000", "-11000"],
    ]);
    expect(subs).toMatchObject({ pausedItems: [], totalYearlyCents: "-2292000", totalMonthlyCents: "-191000" });
  });
});
