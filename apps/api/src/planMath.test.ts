import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, resolvePayee, runRecurringDetection, transaction } from "@meridian/db";
import { PLAN_SEED_TODAY, seedPlanFixture, type PlanSeed } from "@meridian/db/testing";
import type { CashFlowProjectionResponse, CategoryView, DashboardView, PlanResponse, TransactionList, TransactionView } from "@meridian/shared";
import { createTestApp, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/**
 * Plan math through the HTTP API, as the owner sees it: the dashboard's left to spend when
 * charges post in the neighbouring month, recurring charges in spending categories, split
 * transactions, the drill-down behind a cell, and goals that share an account. Every
 * expected number is worked by hand in the comments.
 */

interface World {
  t: TestApp;
  clock: { now: Date };
  setToday: (date: string) => void;
  cat: Record<string, string>;
  get: <T>(url: string) => Promise<T>;
  send: <T>(method: "POST" | "PUT" | "PATCH", url: string, payload?: unknown) => Promise<T>;
  addAccount: (name: string, type: "checking" | "credit" | "brokerage", onBudget?: boolean) => Promise<string>;
  addTx: (accountId: string, date: string, cents: bigint, payee: string, categoryName: string | null) => Promise<string>;
}

async function world(startDate: string): Promise<World> {
  const clock = { now: new Date(`${startDate}T19:00:00Z`) }; // noon in America/Denver
  const t = await createTestApp({ now: () => clock.now });
  await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "correct horse battery staple" } });
  const setup = await t.call({ method: "POST", url: "/api/auth/totp/setup" });
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json().secret), digits: 6, period: 30 }).generate();
  await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code } });

  const get = async <T>(url: string): Promise<T> => {
    const res = await t.call({ method: "GET", url });
    if (res.statusCode !== 200) throw new Error(`GET ${url}: ${res.statusCode} ${res.body}`);
    return res.json() as T;
  };
  const send = async <T>(method: "POST" | "PUT" | "PATCH", url: string, payload?: unknown): Promise<T> => {
    const res = await t.call({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
    if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
    return res.json() as T;
  };
  const cat: Record<string, string> = {};
  for (const c of await get<CategoryView[]>("/api/categories")) cat[c.name] = c.id;

  return {
    t,
    clock,
    setToday: (date) => {
      clock.now = new Date(`${date}T19:00:00Z`);
    },
    cat,
    get,
    send,
    addAccount: async (name, type, onBudget = true) => {
      const [row] = await t.db.db
        .insert(account)
        .values({ name, type, taxTreatment: type === "brokerage" ? "taxable" : "none", onBudget, balanceCents: 500000n, balanceDate: startDate })
        .returning({ id: account.id });
      return row!.id;
    },
    addTx: async (accountId, date, cents, payee, categoryName) => {
      const p = await resolvePayee(t.db.db, payee);
      const [row] = await t.db.db
        .insert(transaction)
        .values({ accountId, source: "manual", date, amountCents: cents, payeeId: p.id, rawDescription: payee, categoryId: categoryName === null ? null : cat[categoryName]! })
        .returning({ id: transaction.id });
      return row!.id;
    },
  };
}

function cellOf(plan: PlanResponse, categoryId: string, month: string) {
  const row = plan.rows.find((r) => r.kind === "category" && r.categoryId === categoryId);
  const cell = row?.cells[plan.months.indexOf(month)];
  if (!cell) throw new Error(`no cell ${categoryId} ${month}`);
  return cell;
}

describe.skipIf(!TEST_DATABASE_URL)("dashboard left to spend when a paycheck and the rent post in the neighbouring month", () => {
  let w: World;

  beforeAll(async () => {
    w = await world("2026-01-02");
  });
  afterAll(async () => {
    await w?.t.cleanup();
  });

  it("counts the March 1 paycheck and rent that arrived on February 27 in February, not in March", async () => {
    const checking = await w.addAccount("Checking", "checking");
    await w.addTx(checking, "2026-01-02", 300000n, "Acme Payroll", "Paycheck");
    await w.send("POST", "/api/recurring", { name: "Salary", payeeName: "Acme Payroll", categoryId: w.cat["Paycheck"], accountId: checking, cadence: "twice_monthly", anchorDay: 1, anchorDay2: 15, expectedCents: "300000" });
    await w.send("POST", "/api/recurring", { name: "Rent", payeeName: "Landlord", categoryId: w.cat["Rent / Mortgage"], accountId: checking, cadence: "monthly", anchorDay: 1, expectedCents: "-150000" });
    const step = async (today: string, charges: Array<[string, bigint, string, string]>) => {
      w.setToday(today);
      for (const [date, cents, payee, category] of charges) await w.addTx(checking, date, cents, payee, category);
      await runRecurringDetection(w.t.db.db, { today, now: w.clock.now });
    };
    await step("2026-01-16", [
      ["2026-01-15", 300000n, "Acme Payroll", "Paycheck"],
      ["2026-01-02", -150000n, "Landlord", "Rent / Mortgage"],
    ]);
    await step("2026-01-31", [
      ["2026-01-30", 300000n, "Acme Payroll", "Paycheck"],
      ["2026-01-30", -150000n, "Landlord", "Rent / Mortgage"],
    ]);
    await step("2026-02-14", [["2026-02-13", 300000n, "Acme Payroll", "Paycheck"]]);
    await step("2026-02-28", [
      ["2026-02-27", 300000n, "Acme Payroll", "Paycheck"],
      ["2026-02-27", -150000n, "Landlord", "Rent / Mortgage"],
    ]);
    await step("2026-03-20", [["2026-03-13", 300000n, "Acme Payroll", "Paycheck"]]);

    // March 20: the only March money is the 3,000.00 paycheck of Mar 13; the Mar 1 paycheck and rent were both
    // settled on Feb 27. Left to spend 3,000.00 over the 12 days left (Mar 20..31) = 250.00 a day.
    const dash = await w.get<DashboardView>("/api/dashboard");
    expect(dash.plan.leftToSpendCents).toBe("300000");
    expect(dash.plan.pace).toEqual({ daysLeft: 12, perDayCents: "25000", overCents: "0" });
    expect(dash.plan.committed).toMatchObject({ income: "300000", bills: "0" });

    const plan = await w.get<PlanResponse>("/api/plan?from=2026-01&to=2026-03");
    expect(["2026-01", "2026-02", "2026-03"].map((m) => cellOf(plan, w.cat["Paycheck"]!, m).plannedCents)).toEqual(["900000", "600000", "300000"]);
    expect(["2026-01", "2026-02", "2026-03"].map((m) => cellOf(plan, w.cat["Rent / Mortgage"]!, m).plannedCents)).toEqual(["300000", "150000", "0"]);
    // Every closed month balances: what was planned is what arrived.
    expect(plan.summary.slice(0, 2).map((s) => s.leftToSpendCents)).toEqual(["600000", "450000"]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("a recurring charge in a spending category", () => {
  let w: World;

  beforeAll(async () => {
    w = await world("2027-01-12");
  });
  afterAll(async () => {
    await w?.t.cleanup();
  });

  it("is planned in its category and projected once: a dated bill, taken out of the month's spread", async () => {
    const checking = await w.addAccount("Checking", "checking");
    await w.send("POST", "/api/recurring", { name: "Gym", payeeName: "Gym", categoryId: w.cat["Health"], accountId: checking, cadence: "monthly", anchorDay: 20, expectedCents: "-4000" });
    // Health also covers the pharmacy: 100.00 typed for February. Dining: 300.00 typed for January.
    await w.send("PUT", "/api/plan/cells", {
      edits: [
        { month: "2027-02", categoryId: w.cat["Health"], plannedCents: "10000" },
        { month: "2027-01", categoryId: w.cat["Dining"], plannedCents: "30000" },
      ],
    });

    const plan = await w.get<PlanResponse>("/api/plan?from=2027-01&to=2027-03");
    expect(cellOf(plan, w.cat["Health"]!, "2027-01")).toMatchObject({ plannedCents: "4000", source: "recurring", hasExplicitPlan: false });
    expect(cellOf(plan, w.cat["Health"]!, "2027-02")).toMatchObject({ plannedCents: "10000", source: "manual" });
    expect(cellOf(plan, w.cat["Health"]!, "2027-03")).toMatchObject({ plannedCents: "4000", source: "recurring" });
    expect(plan.summary[0]!.planned.spending).toBe("34000");

    const cf = await w.send<CashFlowProjectionResponse>("POST", "/api/cashflow/projection", { horizonDays: 45 }); // through Feb 26
    expect(cf.events.map((e) => [e.date, e.kind, e.label, e.amountCents])).toEqual([
      ["2027-01-20", "bill", "Gym", "-4000"],
      ["2027-02-20", "bill", "Gym", "-4000"],
    ]);
    // January: Dining 300.00 is spread; Health's 40.00 is the dated gym charge. February: Health 100.00 − 40.00 = 60.00.
    expect(cf.spreads.map((s) => [s.month, s.totalCents])).toEqual([
      ["2027-01", "30000"],
      ["2027-02", "6000"],
    ]);
    // Skipping the charge removes it from the projection altogether (it is not in the spread either).
    const skipped = await w.send<CashFlowProjectionResponse>("POST", "/api/cashflow/projection", {
      horizonDays: 45,
      whatIfs: [{ kind: "skipOccurrence", recurringId: cf.events[0]!.recurringId, occurrenceDate: "2027-01-20" }],
    });
    const last = (r: CashFlowProjectionResponse) => BigInt(r.combined.points[r.combined.points.length - 1]!);
    expect(last(skipped) - last(cf)).toBe(4000n);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("split transactions and the list behind a plan cell", () => {
  let w: World;
  let checking: string;
  let brokerage: string;
  let warehouse: string;
  const january = "from=2027-01-01&to=2027-01-31";

  beforeAll(async () => {
    w = await world("2027-01-25");
    checking = await w.addAccount("Checking", "checking");
    brokerage = await w.addAccount("Brokerage", "brokerage", false);
    await w.addTx(checking, "2027-01-04", -2500n, "King Soopers", "Groceries");
    await w.addTx(checking, "2027-01-09", -1500n, "King Soopers", "Groceries");
    warehouse = await w.addTx(checking, "2027-01-12", -10000n, "Costco", null);
    await w.addTx(brokerage, "2027-01-15", -9900n, "Advisory fee", "Fees & Charges");
    await w.addTx(checking, "2027-01-20", -1200n, "Mystery", null);
  });
  afterAll(async () => {
    await w?.t.cleanup();
  });

  it("splits a transaction through the API and counts each line in its own category", async () => {
    expect((await w.get<DashboardView>("/api/dashboard")).review.uncategorized).toBe(2);
    const row = await w.send<TransactionView>("PUT", `/api/transactions/${warehouse}/splits`, {
      splits: [
        { categoryId: w.cat["Groceries"], amountCents: "-6000" },
        { categoryId: w.cat["Home"], amountCents: "-4000", memo: "shelves" },
      ],
    });
    expect(row).toMatchObject({ id: warehouse, amountCents: "-10000", categoryId: null });
    expect(row.splits.map((s) => [s.categoryName, s.amountCents, s.memo])).toEqual([
      ["Groceries", "-6000", null],
      ["Home", "-4000", "shelves"],
    ]);

    // Groceries: 25.00 + 15.00 + 60.00 of the split = 100.00 in 3 lines; Home: 40.00.
    const plan = await w.get<PlanResponse>("/api/plan?from=2027-01&to=2027-01");
    expect(cellOf(plan, w.cat["Groceries"]!, "2027-01")).toMatchObject({ actualCents: "10000", txnCount: 3 });
    expect(cellOf(plan, w.cat["Home"]!, "2027-01")).toMatchObject({ actualCents: "4000", txnCount: 1 });
    // The split row no longer asks to be categorized, on the plan strip and on the dashboard alike.
    expect(plan.summary[0]!.uncategorized).toEqual({ count: 1, cents: "-1200" });
    expect((await w.get<DashboardView>("/api/dashboard")).review.uncategorized).toBe(1);
  });

  it("the drill-down behind a cell adds up to the cell: split lines in, off-budget rows out", async () => {
    const inCategory = (t: TransactionView, categoryId: string) =>
      t.splits.length === 0 ? BigInt(t.amountCents) : t.splits.filter((s) => s.categoryId === categoryId).reduce((sum, s) => sum + BigInt(s.amountCents), 0n);
    const groceries = await w.get<TransactionList>(`/api/transactions?categoryId=${w.cat["Groceries"]}&${january}&transfers=exclude&planScope=true`);
    expect(groceries.items).toHaveLength(3);
    expect(groceries.items.reduce((sum, t) => sum + inCategory(t, w.cat["Groceries"]!), 0n)).toBe(-10000n);
    const home = await w.get<TransactionList>(`/api/transactions?categoryId=${w.cat["Home"]}&${january}&transfers=exclude&planScope=true`);
    expect(home.items.map((t) => [t.id, inCategory(t, w.cat["Home"]!)])).toEqual([[warehouse, -4000n]]);

    // Fees & Charges: the only row sits in the off-budget brokerage, so the cell is 0.00 and its list is empty.
    const plan = await w.get<PlanResponse>("/api/plan?from=2027-01&to=2027-01");
    expect(cellOf(plan, w.cat["Fees & Charges"]!, "2027-01")).toMatchObject({ actualCents: "0", txnCount: 0 });
    expect((await w.get<TransactionList>(`/api/transactions?categoryId=${w.cat["Fees & Charges"]}&${january}&transfers=exclude&planScope=true`)).items).toEqual([]);
    expect((await w.get<TransactionList>(`/api/transactions?categoryId=${w.cat["Fees & Charges"]}&${january}`)).items).toHaveLength(1);
    // The uncategorized list is the badge's one row.
    const uncategorized = await w.get<TransactionList>(`/api/transactions?uncategorized=true&${january}&planScope=true`);
    expect(uncategorized.items.map((t) => t.amountCents)).toEqual(["-1200"]);
  });

  it("refuses lines that do not add up and unknown transactions; an empty list removes the split", async () => {
    const bad = await w.t.call({
      method: "PUT",
      url: `/api/transactions/${warehouse}/splits`,
      payload: { splits: [{ categoryId: w.cat["Groceries"], amountCents: "-6000" }, { categoryId: w.cat["Home"], amountCents: "-3000" }] },
    });
    expect([bad.statusCode, bad.json().code]).toEqual([400, "validation"]);
    const missing = await w.t.call({ method: "PUT", url: "/api/transactions/00000000-0000-4000-8000-000000000000/splits", payload: { splits: [] } });
    expect(missing.statusCode).toBe(404);

    const cleared = await w.send<TransactionView>("PUT", `/api/transactions/${warehouse}/splits`, { splits: [] });
    expect(cleared).toMatchObject({ categoryId: null, splits: [] });
    expect((await w.get<DashboardView>("/api/dashboard")).review.uncategorized).toBe(2);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("goals and their linked account through the API", () => {
  let t: TestApp;
  let S: PlanSeed;

  beforeAll(async () => {
    t = await createTestApp({ now: () => new Date(`${PLAN_SEED_TODAY}T18:00:00Z`) });
    S = await seedPlanFixture(t.db.db);
    await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "correct horse battery staple" } });
    const setup = await t.call({ method: "POST", url: "/api/auth/totp/setup" });
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json().secret), digits: 6, period: 30 }).generate();
    await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code } });
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("answers 409 account_linked, naming the goal the account already feeds, and counts the transfer once", async () => {
    const res = await t.call({
      method: "POST",
      url: "/api/goals",
      payload: { name: "Vacation 2027", newCategory: { name: "Vacation 2027" }, targetCents: "300000", linkedAccountId: S.accounts.savings },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "account_linked" });
    expect(res.json().error).toContain("Emergency Fund");

    // Without the link the goal is created; October's +500.00 − 200.00 into Savings still counts once, for Emergency Fund.
    const ok = await t.call({ method: "POST", url: "/api/goals", payload: { name: "Vacation 2027", newCategory: { name: "Vacation 2027" }, targetCents: "300000" } });
    expect(ok.statusCode).toBe(200);
    const plan = (await t.call({ method: "GET", url: "/api/plan?from=2026-10&to=2026-10" })).json() as PlanResponse;
    const savings = plan.rows.find((r) => r.kind === "bucket" && r.bucket === "savings")!;
    expect(savings.cells[0]!.actualCents).toBe("30000");
  });
});
