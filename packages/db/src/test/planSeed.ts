import { randomUUID } from "node:crypto";
import type { IsoDate, MonthKey } from "@meridian/shared";
import type { Db } from "../index.js";
import { account, alert, balanceSnapshot, category, categoryGroup, householdSetting, monthPlan, payee, recurring, savingsGoal, transaction } from "../schema/index.js";

/**
 * The Phase 2 "Seed" from docs/design/phase-2/grid-and-api.md, inserted into a
 * test database. Every service and route test starts from a fresh copy with
 * today = 2026-10-13. Hand totals (bucket direction): Groceries Aug 7000, Sep
 * 40000, Oct 54500; Dining Sep 26000, Oct 20000; Fuel Sep 6000, Oct 5500 (2500
 * pending); Old Hobby Sep 2000; Paycheck Sep 500000, Oct 250000; Rent Sep/Oct
 * 180000; Netflix Sep 1549, Oct 1649; Internet Sep 7999; Emergency Fund Sep
 * 50000, Oct 30000 (net transfers); uncategorized Oct 1 row −4500.
 */

export const PLAN_SEED_TODAY: IsoDate = "2026-10-13";
export const PLAN_SEED_START_MONTH: MonthKey = "2026-08";

export interface PlanSeed {
  accounts: { checking: string; savings: string; visa: string };
  groups: { paychecks: string; housing: string; subscriptions: string; everyday: string };
  categories: {
    paycheck: string;
    rent: string;
    carInsurance: string;
    netflix: string;
    internet: string;
    music: string;
    emergencyFund: string;
    groceries: string;
    dining: string;
    fuel: string;
    oldHobby: string;
    shopping: string;
  };
  payees: { rent: string; netflix: string; internet: string; carInsurance: string; spotify: string; gym: string };
  recurring: { rent: string; netflix: string; internet: string; carInsurance: string; spotify: string; gym: string };
  goals: { emergencyFund: string };
  transactions: { amazon: string; netflixOct: string };
  alerts: { netflixPrice: string };
}

interface TxSpec {
  account: string;
  date: IsoDate;
  amountCents: bigint;
  description: string;
  categoryId?: string | null;
  pending?: boolean;
  transferPairId?: string;
  recurringId?: string;
}

export async function seedPlanFixture(db: Db): Promise<PlanSeed> {
  await db.insert(householdSetting).values({ id: 1, planStartMonth: PLAN_SEED_START_MONTH }).onConflictDoNothing();

  const accounts = await db
    .insert(account)
    .values([
      { name: "Checking", type: "checking", taxTreatment: "none", onBudget: true },
      { name: "Savings", type: "savings", taxTreatment: "none", onBudget: true },
      { name: "Visa", type: "credit", taxTreatment: "none", onBudget: true },
    ])
    .returning({ id: account.id, name: account.name });
  const acct = (name: string) => accounts.find((a) => a.name === name)!.id;
  const checking = acct("Checking");
  const savings = acct("Savings");
  const visa = acct("Visa");

  const groups = await db
    .insert(categoryGroup)
    .values([
      { name: "Paychecks", bucket: "income", position: 1 },
      { name: "Housing", bucket: "bills", position: 1 },
      { name: "Subscriptions", bucket: "bills", position: 2 },
      { name: "Everyday", bucket: "spending", position: 1 },
    ])
    .returning({ id: categoryGroup.id, name: categoryGroup.name });
  const grp = (name: string) => groups.find((g) => g.name === name)!.id;
  const g = { paychecks: grp("Paychecks"), housing: grp("Housing"), subscriptions: grp("Subscriptions"), everyday: grp("Everyday") };

  const cats = await db
    .insert(category)
    .values([
      { name: "Paycheck", bucket: "income", groupId: g.paychecks, position: 1 },
      { name: "Rent", bucket: "bills", groupId: g.housing, position: 1 },
      { name: "Car Insurance", bucket: "bills", groupId: g.housing, position: 2 },
      { name: "Netflix", bucket: "bills", groupId: g.subscriptions, position: 1 },
      { name: "Internet", bucket: "bills", groupId: g.subscriptions, position: 2 },
      { name: "Music", bucket: "bills", groupId: g.subscriptions, position: 3 },
      { name: "Emergency Fund", bucket: "savings", groupId: null, position: 1 },
      { name: "Groceries", bucket: "spending", groupId: g.everyday, position: 1, rolloverMode: "all", rolloverFromMonth: "2026-09" },
      { name: "Dining", bucket: "spending", groupId: g.everyday, position: 2, rolloverMode: "surplus", rolloverFromMonth: "2026-09" },
      { name: "Fuel", bucket: "spending", groupId: g.everyday, position: 3 },
      { name: "Old Hobby", bucket: "spending", groupId: g.everyday, position: 4, hidden: true },
      { name: "Shopping", bucket: "spending", groupId: null, position: 1 },
    ])
    .returning({ id: category.id, name: category.name });
  const cat = (name: string) => cats.find((c) => c.name === name)!.id;
  const c = {
    paycheck: cat("Paycheck"),
    rent: cat("Rent"),
    carInsurance: cat("Car Insurance"),
    netflix: cat("Netflix"),
    internet: cat("Internet"),
    music: cat("Music"),
    emergencyFund: cat("Emergency Fund"),
    groceries: cat("Groceries"),
    dining: cat("Dining"),
    fuel: cat("Fuel"),
    oldHobby: cat("Old Hobby"),
    shopping: cat("Shopping"),
  };

  const payees = await db
    .insert(payee)
    .values([{ name: "Oakwood Apartments" }, { name: "Netflix" }, { name: "Comcast" }, { name: "Geico" }, { name: "Spotify" }, { name: "Gym" }])
    .returning({ id: payee.id, name: payee.name });
  const pay = (name: string) => payees.find((p) => p.name === name)!.id;
  const p = { rent: pay("Oakwood Apartments"), netflix: pay("Netflix"), internet: pay("Comcast"), carInsurance: pay("Geico"), spotify: pay("Spotify"), gym: pay("Gym") };

  const recs = await db
    .insert(recurring)
    .values([
      { payeeId: p.rent, name: "Rent", categoryId: c.rent, accountId: checking, cadence: "monthly", anchorDay: 1, expectedCents: -180000n, nextDueDate: "2026-11-01", firstChargeDate: "2026-09-01", lastChargeDate: "2026-10-01", lastChargeCents: -180000n, chargeCount: 2, source: "detected", status: "active" },
      { payeeId: p.netflix, name: "Netflix", categoryId: c.netflix, accountId: checking, cadence: "monthly", anchorDay: 5, expectedCents: -1549n, nextDueDate: "2026-11-05", firstChargeDate: "2026-09-05", lastChargeDate: "2026-10-05", lastChargeCents: -1649n, chargeCount: 2, source: "detected", status: "active" },
      { payeeId: p.internet, name: "Internet", categoryId: c.internet, accountId: checking, cadence: "monthly", anchorDay: 20, expectedCents: -7999n, nextDueDate: "2026-10-20", firstChargeDate: "2026-09-20", lastChargeDate: "2026-09-20", lastChargeCents: -7999n, chargeCount: 1, source: "detected", status: "active" },
      { payeeId: p.carInsurance, name: "Car Insurance", categoryId: c.carInsurance, accountId: checking, cadence: "quarterly", anchorDay: 20, anchorMonth: 12, expectedCents: -45000n, nextDueDate: "2026-12-20", firstChargeDate: "2026-12-20", source: "manual", status: "active" },
      { payeeId: p.spotify, name: "Spotify", categoryId: null, accountId: checking, cadence: "monthly", anchorDay: 25, expectedCents: -1099n, nextDueDate: "2026-10-25", firstChargeDate: "2026-10-25", source: "detected", status: "suggested" },
      { payeeId: p.gym, name: "Gym", categoryId: null, accountId: checking, cadence: "monthly", anchorDay: 30, expectedCents: -3999n, nextDueDate: "2026-10-30", firstChargeDate: "2026-09-30", source: "detected", status: "suggested" },
    ])
    .returning({ id: recurring.id, name: recurring.name });
  const rec = (name: string) => recs.find((r) => r.name === name)!.id;
  const r = { rent: rec("Rent"), netflix: rec("Netflix"), internet: rec("Internet"), carInsurance: rec("Car Insurance"), spotify: rec("Spotify"), gym: rec("Gym") };

  const [goal] = await db
    .insert(savingsGoal)
    .values({
      name: "Emergency Fund",
      categoryId: c.emergencyFund,
      targetCents: 1000000n,
      targetDate: "2027-09-30",
      linkedAccountId: savings,
      monthlyContributionCents: 50000n,
      startMonth: "2026-09",
      startingCents: 200000n,
    })
    .returning({ id: savingsGoal.id });

  await db.insert(monthPlan).values([
    { categoryId: c.paycheck, month: "2026-09", plannedCents: 500000n, plannedSource: "manual" },
    { categoryId: c.paycheck, month: "2026-10", plannedCents: 500000n, plannedSource: "manual" },
    { categoryId: c.paycheck, month: "2026-11", plannedCents: 500000n, plannedSource: "manual" },
    { categoryId: c.groceries, month: "2026-09", plannedCents: 50000n, plannedSource: "manual" },
    { categoryId: c.groceries, month: "2026-10", plannedCents: 50000n, plannedSource: "manual" },
    { categoryId: c.groceries, month: "2026-11", plannedCents: 50000n, plannedSource: "manual" },
    { categoryId: c.dining, month: "2026-09", plannedCents: 20000n, plannedSource: "manual" },
    { categoryId: c.dining, month: "2026-10", plannedCents: 20000n, plannedSource: "manual" },
    { categoryId: c.fuel, month: "2026-10", plannedCents: 15000n, plannedSource: "manual" },
  ]);

  const sweepSep = randomUUID();
  const sweepOct = randomUUID();
  const withdrawalOct = randomUUID();
  const cardPayOct = randomUUID();
  const specs: TxSpec[] = [
    { account: checking, date: "2026-08-20", amountCents: -7000n, description: "KING SOOPERS", categoryId: c.groceries },
    { account: checking, date: "2026-09-01", amountCents: 250000n, description: "ACME PAYROLL", categoryId: c.paycheck },
    { account: checking, date: "2026-09-15", amountCents: 250000n, description: "ACME PAYROLL", categoryId: c.paycheck },
    { account: checking, date: "2026-09-01", amountCents: -180000n, description: "OAKWOOD APTS RENT", categoryId: c.rent, recurringId: r.rent },
    { account: checking, date: "2026-09-05", amountCents: -1549n, description: "NETFLIX.COM", categoryId: c.netflix, recurringId: r.netflix },
    { account: checking, date: "2026-09-20", amountCents: -7999n, description: "COMCAST", categoryId: c.internet, recurringId: r.internet },
    { account: checking, date: "2026-09-03", amountCents: -30000n, description: "KING SOOPERS", categoryId: c.groceries },
    { account: checking, date: "2026-09-17", amountCents: -10000n, description: "KING SOOPERS", categoryId: c.groceries },
    { account: checking, date: "2026-09-10", amountCents: -25000n, description: "TAPHOUSE", categoryId: c.dining },
    { account: checking, date: "2026-09-30", amountCents: -1000n, description: "COFFEE", categoryId: c.dining },
    { account: checking, date: "2026-09-20", amountCents: -6000n, description: "SHELL", categoryId: c.fuel },
    { account: checking, date: "2026-09-08", amountCents: -2000n, description: "HOBBY SHOP", categoryId: c.oldHobby },
    { account: checking, date: "2026-09-02", amountCents: -50000n, description: "TRANSFER TO SAVINGS", transferPairId: sweepSep },
    { account: savings, date: "2026-09-02", amountCents: 50000n, description: "TRANSFER FROM CHECKING", transferPairId: sweepSep },
    { account: checking, date: "2026-10-01", amountCents: 250000n, description: "ACME PAYROLL", categoryId: c.paycheck },
    { account: checking, date: "2026-10-01", amountCents: -180000n, description: "OAKWOOD APTS RENT", categoryId: c.rent, recurringId: r.rent },
    { account: checking, date: "2026-10-05", amountCents: -1649n, description: "NETFLIX.COM", categoryId: c.netflix, recurringId: r.netflix },
    { account: checking, date: "2026-10-02", amountCents: -35000n, description: "KING SOOPERS", categoryId: c.groceries },
    { account: checking, date: "2026-10-11", amountCents: -21000n, description: "KING SOOPERS", categoryId: c.groceries },
    { account: checking, date: "2026-10-12", amountCents: 1500n, description: "KING SOOPERS REFUND", categoryId: c.groceries },
    { account: checking, date: "2026-10-09", amountCents: -12000n, description: "TAPHOUSE", categoryId: c.dining },
    { account: visa, date: "2026-10-07", amountCents: -8000n, description: "SUSHI", categoryId: c.dining },
    { account: checking, date: "2026-10-03", amountCents: -3000n, description: "SHELL", categoryId: c.fuel },
    { account: visa, date: "2026-10-13", amountCents: -2500n, description: "SHELL", categoryId: c.fuel, pending: true },
    { account: checking, date: "2026-10-02", amountCents: -50000n, description: "TRANSFER TO SAVINGS", transferPairId: sweepOct },
    { account: savings, date: "2026-10-02", amountCents: 50000n, description: "TRANSFER FROM CHECKING", transferPairId: sweepOct },
    { account: checking, date: "2026-10-10", amountCents: 20000n, description: "TRANSFER FROM SAVINGS", transferPairId: withdrawalOct },
    { account: savings, date: "2026-10-10", amountCents: -20000n, description: "TRANSFER TO CHECKING", transferPairId: withdrawalOct },
    { account: checking, date: "2026-10-08", amountCents: -30000n, description: "PAYMENT TO VISA", transferPairId: cardPayOct },
    { account: visa, date: "2026-10-08", amountCents: 30000n, description: "PAYMENT THANK YOU", transferPairId: cardPayOct },
    { account: visa, date: "2026-10-12", amountCents: -4500n, description: "AMAZON", categoryId: null },
  ];
  const inserted = await db
    .insert(transaction)
    .values(
      specs.map((s, i) => ({
        accountId: s.account,
        externalId: `SEED-${i + 1}`,
        source: "manual" as const,
        date: s.date,
        amountCents: s.amountCents,
        rawDescription: s.description,
        categoryId: s.categoryId ?? null,
        categoryLocked: s.categoryId !== undefined && s.categoryId !== null,
        pending: s.pending ?? false,
        isTransfer: s.transferPairId !== undefined,
        transferPairId: s.transferPairId ?? null,
        recurringId: s.recurringId ?? null,
      })),
    )
    .returning({ id: transaction.id, rawDescription: transaction.rawDescription, date: transaction.date });
  const amazon = inserted.find((t) => t.rawDescription === "AMAZON")!.id;
  const netflixOct = inserted.find((t) => t.rawDescription === "NETFLIX.COM" && t.date === "2026-10-05")!.id;

  const [priceAlert] = await db
    .insert(alert)
    .values({
      kind: "price_increase",
      recurringId: r.netflix,
      payeeId: p.netflix,
      transactionId: netflixOct,
      oldCents: 1549n,
      newCents: 1649n,
      dedupeKey: `price:${r.netflix}:${netflixOct}`,
    })
    .returning({ id: alert.id });

  await db.insert(balanceSnapshot).values([
    { accountId: checking, date: "2026-10-13", balanceCents: 320000n, source: "manual" },
    { accountId: checking, date: "2025-10-10", balanceCents: 150000n, source: "manual" },
    { accountId: savings, date: "2026-10-13", balanceCents: 300000n, source: "manual" },
    { accountId: savings, date: "2025-10-01", balanceCents: 200000n, source: "manual" },
    { accountId: visa, date: "2026-10-13", balanceCents: -45000n, source: "manual" },
  ]);

  return {
    accounts: { checking, savings, visa },
    groups: g,
    categories: c,
    payees: p,
    recurring: r,
    goals: { emergencyFund: goal!.id },
    transactions: { amazon, netflixOct },
    alerts: { netflixPrice: priceAlert!.id },
  };
}
