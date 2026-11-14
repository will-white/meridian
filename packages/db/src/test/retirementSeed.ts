import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { IsoDate, RetirementProfileDocInput } from "@meridian/shared";
import { fixtureProfileDoc, IDS } from "@meridian/shared/src/retirement/testFixtures.js";
import type { Db } from "../index.js";
import { account, balanceSnapshot, category, holdingSnapshot, payee, recurring, transaction } from "../schema/index.js";
import { INV_SEED_NOW, INV_SEED_TODAY, seedInvestmentFixture, seedInvestmentLots, type InvestmentSeed } from "./investmentSeed.js";

/**
 * The planner's fixture (docs/design/phase-4/inputs-and-data.md §7.0): the Phase 3 "INV" seed
 * with its lots (today 2026-10-14, `INV_SEED_NOW`, expected price date 2026-10-13; household
 * targets 5000 / 2500 / 2000 / 500) plus a 401(k), an HSA, a second brokerage account, Savings, a
 * 529 and a credit card, twelve months of ledger on Checking, payroll deferrals into the 401(k)
 * and the HSA, and an active monthly transfer into the Roth IRA.
 *
 * Hand figures (the §3.2 worked example; amounts in cents):
 * - Values on 2026-10-13: Vanguard Brokerage 2,705,200 (VTI 1,250,000, VXUS 712,000, AAPL 600,000,
 *   cash 143,200); Old Brokerage 432,500 (VTI 312,500, AAPL 120,000); Acme 401(k) 15,000,000;
 *   Fidelity Roth IRA 1,820,000; HealthEquity HSA 125,000; Checking 500,000; Savings 2,000,000;
 *   College 529 1,200,000 (listed, never included); Visa −150,000 (not listed).
 * - Window 2025-10..2026-09; the earliest on-budget row is 2025-09-03 (not the 1st), so 2025-10 is
 *   the first full month and all 12 count. Rent 12 × 200,000 = 2,400,000; Groceries 12 × 80,000 −
 *   5,000 = 955,000; Childcare 12 × 50,000 = 600,000; uncategorized 2 rows, 45,000 out, 20,000 in;
 *   Paycheck 12 × 700,000 = 8,400,000; Dividends 4,720 (B's 2026-06-26 row).
 * - Contributions: K 12 × (100,000 employee + 50,000 employer match); H 4 × 30,000 from June;
 *   B one paired transfer of 500,000 from Checking (the investment seed's 2026-04-13); R none, with
 *   an active recurring transfer of 25,000 a month; T no full month of data.
 */

export const RETIREMENT_SEED_TODAY: IsoDate = INV_SEED_TODAY;
export const RETIREMENT_SEED_NOW = INV_SEED_NOW;

export interface RetirementSeed {
  inv: InvestmentSeed;
  accounts: {
    /** "Acme 401(k)": pre-tax, owned by p1 in the profile. */
    K: string;
    /** "HealthEquity HSA": owned by p1. */
    H: string;
    /** "Old Brokerage": taxable, joint. */
    T: string;
    /** "Savings". */
    S: string;
    /** "College 529": listed, never included. */
    E: string;
    /** "Visa": a credit card, not listed. */
    V: string;
    /** The investment seed's "Vanguard Brokerage", joint. */
    B: string;
    /** The investment seed's "Fidelity Roth IRA", owned by p2. */
    R: string;
    /** The investment seed's "Checking". */
    C: string;
  };
  categories: { paycheck: string; rent: string; groceries: string; childcare: string; emergencyFund: string; dividends: string };
  /** The ledger rows the design says move no figure: "rentSep" (2025-09-03), "groceriesOct" (2026-10-05), and the Savings transfer legs. */
  ledger: { rentSep: string; groceriesOct: string; savingsTransfers: string[] };
  recurring: { rothContribution: string };
}

const WINDOW_MONTHS = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"] as const;

export async function seedRetirementFixture(db: Db): Promise<RetirementSeed> {
  const inv = await seedInvestmentFixture(db);
  await seedInvestmentLots(db, inv);
  const B = inv.accounts.brokerage;
  const R = inv.accounts.roth;
  const C = inv.accounts.checking;

  const accounts = await db
    .insert(account)
    .values([
      { name: "Acme 401(k)", type: "401k", taxTreatment: "pre_tax", onBudget: false, balanceCents: 15000000n, balanceDate: "2026-10-10" },
      { name: "HealthEquity HSA", type: "hsa", taxTreatment: "hsa", onBudget: false, balanceCents: 125000n, balanceDate: "2026-10-10" },
      { name: "Old Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false, balanceCents: 432500n, balanceDate: "2026-10-13" },
      { name: "Savings", type: "savings", taxTreatment: "none", onBudget: true, balanceCents: 2000000n, balanceDate: "2026-10-13" },
      { name: "College 529", type: "529", taxTreatment: "none", onBudget: false, balanceCents: 1200000n, balanceDate: "2026-10-10" },
      { name: "Visa", type: "credit", taxTreatment: "none", onBudget: true, balanceCents: -150000n, balanceDate: "2026-10-13" },
    ])
    .returning({ id: account.id, name: account.name });
  const acct = (name: string) => accounts.find((a) => a.name === name)!.id;
  const K = acct("Acme 401(k)");
  const H = acct("HealthEquity HSA");
  const T = acct("Old Brokerage");
  const S = acct("Savings");
  const E = acct("College 529");
  const V = acct("Visa");

  await db.insert(balanceSnapshot).values([
    { accountId: K, date: "2025-09-30", balanceCents: 12000000n, source: "manual" },
    { accountId: K, date: "2026-10-10", balanceCents: 15000000n, source: "manual" },
    { accountId: H, date: "2026-06-01", balanceCents: 0n, source: "manual" },
    { accountId: H, date: "2026-10-10", balanceCents: 125000n, source: "manual" },
    { accountId: T, date: "2026-10-13", balanceCents: 432500n, source: "csv" },
    { accountId: S, date: "2026-10-13", balanceCents: 2000000n, source: "manual" },
    { accountId: E, date: "2026-10-10", balanceCents: 1200000n, source: "manual" },
    { accountId: V, date: "2026-10-13", balanceCents: -150000n, source: "manual" },
  ]);
  await db.insert(holdingSnapshot).values([
    { accountId: T, date: "2026-10-13", source: "csv", securityId: inv.securities.vti, quantity: "10", price: "312.5", valueCents: 312500n, reportedCostBasisCents: 200000n },
    { accountId: T, date: "2026-10-13", source: "csv", securityId: inv.securities.aapl, quantity: "5", price: "240", valueCents: 120000n, reportedCostBasisCents: null },
  ]);

  const cats = await db
    .insert(category)
    .values([
      { name: "Paycheck", bucket: "income", position: 2 },
      { name: "Rent", bucket: "bills", position: 1 },
      { name: "Groceries", bucket: "spending", position: 1 },
      { name: "Childcare", bucket: "spending", position: 2 },
      { name: "Emergency Fund", bucket: "savings", position: 1 },
    ])
    .returning({ id: category.id, name: category.name });
  const cat = (name: string) => cats.find((c) => c.name === name)!.id;
  const categories = {
    paycheck: cat("Paycheck"),
    rent: cat("Rent"),
    groceries: cat("Groceries"),
    childcare: cat("Childcare"),
    emergencyFund: cat("Emergency Fund"),
    dividends: inv.categories.dividends,
  };
  // The seed's 2026-06-26 VTI dividend row in B (off budget) is in the household's investment income category.
  await db.update(transaction).set({ categoryId: categories.dividends }).where(eq(transaction.id, inv.ledger["divVtiJun"]!));

  interface Row {
    key?: string;
    accountId: string;
    date: IsoDate;
    amountCents: bigint;
    description: string;
    categoryId?: string;
    pairId?: string;
  }
  const rows: Row[] = [];
  const savingsKeys: string[] = [];
  for (const m of WINDOW_MONTHS) {
    rows.push(
      { accountId: C, date: `${m}-01`, amountCents: 700000n, description: "ACME CORP PAYROLL", categoryId: categories.paycheck },
      { accountId: C, date: `${m}-03`, amountCents: -200000n, description: "OAKWOOD APARTMENTS RENT", categoryId: categories.rent },
      { accountId: C, date: `${m}-10`, amountCents: -80000n, description: "KING SOOPERS", categoryId: categories.groceries },
      { accountId: C, date: `${m}-12`, amountCents: -50000n, description: "BRIGHT HORIZONS", categoryId: categories.childcare },
    );
    // The paired transfer to Savings: the Checking leg is in the savings-bucket category, the Savings leg uncategorized.
    const pairId = randomUUID();
    savingsKeys.push(`toSavings${m}`, `fromChecking${m}`);
    rows.push(
      { key: `toSavings${m}`, accountId: C, date: `${m}-20`, amountCents: -30000n, description: "TRANSFER TO SAVINGS", categoryId: categories.emergencyFund, pairId },
      { key: `fromChecking${m}`, accountId: S, date: `${m}-20`, amountCents: 30000n, description: "TRANSFER FROM CHECKING", pairId },
    );
    // Payroll deferrals into the 401(k): unpaired transfers on day 15.
    rows.push(
      { accountId: K, date: `${m}-15`, amountCents: 100000n, description: "EMPLOYEE PRE-TAX CONTRIBUTION" },
      { accountId: K, date: `${m}-15`, amountCents: 50000n, description: "EMPLOYER MATCH" },
    );
  }
  for (const date of ["2026-06-15", "2026-07-15", "2026-08-17", "2026-09-15"] as const) {
    rows.push({ accountId: H, date, amountCents: 30000n, description: "PAYROLL HSA CONTRIBUTION" });
  }
  rows.push(
    { key: "rentSep", accountId: C, date: "2025-09-03", amountCents: -200000n, description: "OAKWOOD APARTMENTS RENT", categoryId: categories.rent },
    { accountId: C, date: "2026-03-20", amountCents: 5000n, description: "KING SOOPERS REFUND", categoryId: categories.groceries },
    { accountId: C, date: "2026-06-18", amountCents: -45000n, description: "VENMO PAYMENT" },
    { accountId: C, date: "2026-07-02", amountCents: 20000n, description: "VENMO CASHOUT" },
    { key: "groceriesOct", accountId: C, date: "2026-10-05", amountCents: -99900n, description: "KING SOOPERS", categoryId: categories.groceries },
  );
  const transfers = new Set([K, H]);
  const inserted = await db
    .insert(transaction)
    .values(
      rows.map((r, i) => ({
        accountId: r.accountId,
        externalId: `RET-SEED-${i + 1}`,
        source: "manual" as const,
        date: r.date,
        amountCents: r.amountCents,
        rawDescription: r.description,
        categoryId: r.categoryId ?? null,
        isTransfer: r.pairId !== undefined || transfers.has(r.accountId),
        transferPairId: r.pairId ?? null,
      })),
    )
    .returning({ id: transaction.id, externalId: transaction.externalId });
  const idOf = (key: string) => inserted[rows.findIndex((r) => r.key === key)]!.id;

  const [fidelity] = await db.insert(payee).values({ name: "Fidelity Investments" }).returning({ id: payee.id });
  const [roth] = await db
    .insert(recurring)
    .values({
      payeeId: fidelity!.id,
      name: "Roth IRA contribution",
      accountId: C,
      transferAccountId: R,
      cadence: "monthly",
      anchorDay: 25,
      expectedCents: -25000n,
      nextDueDate: "2026-10-25",
      source: "manual",
      status: "active",
    })
    .returning({ id: recurring.id });

  return {
    inv,
    accounts: { K, H, T, S, E, V, B, R, C },
    categories,
    ledger: { rentSep: idOf("rentSep"), groceriesOct: idOf("groceriesOct"), savingsTransfers: savingsKeys.map(idOf) },
    recurring: { rothContribution: roth!.id },
  };
}

/**
 * `retirementFixtureDoc(seed)` of §7.0: the shared fixture's profile document (Alex and Sam, the
 * incomes, Social Security, spending, the roof and the 2036 conversion) with this seed's account
 * ids in place of the shared fixture's.
 */
export function retirementFixtureDoc(seed: RetirementSeed): RetirementProfileDocInput {
  const doc = fixtureProfileDoc();
  const ids: Record<string, string> = {
    [IDS.K]: seed.accounts.K,
    [IDS.H]: seed.accounts.H,
    [IDS.T]: seed.accounts.T,
    [IDS.S]: seed.accounts.S,
    [IDS.E]: seed.accounts.E,
    [IDS.B]: seed.accounts.B,
    [IDS.R]: seed.accounts.R,
    [IDS.C]: seed.accounts.C,
  };
  const accounts = Object.fromEntries(Object.entries(doc.accounts ?? {}).map(([id, setting]) => [ids[id] ?? id, setting]));
  return { ...doc, accounts };
}
