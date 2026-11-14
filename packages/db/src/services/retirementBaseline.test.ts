import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baselineHash, RetirementBaseline, type BaselineAccount, type BaselineContribution } from "@meridian/shared";
import { account, security, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { RETIREMENT_SEED_NOW, RETIREMENT_SEED_TODAY, retirementFixtureDoc, seedRetirementFixture, type RetirementSeed } from "../test/retirementSeed.js";
import { baselineAuditJson, computeBaseline } from "./retirementBaseline.js";

/**
 * Inputs-and-data §7 case 20: `computeBaseline` on the planner's fixture (§7.0) gives every number
 * of the §3.2 worked example, with seams C25's measured fund costs. Each figure below is the
 * design's; the expense ratios are derived by hand in their test.
 */

const TODAY = RETIREMENT_SEED_TODAY;
const NOW = RETIREMENT_SEED_NOW;

describe.skipIf(!TEST_DATABASE_URL)("computeBaseline on the planner fixture (inputs case 20)", () => {
  let t: TestDb;
  let seed: RetirementSeed;
  let first: RetirementBaseline;

  const byId = (b: RetirementBaseline, id: string) => b.accounts.find((a) => a.accountId === id)!;
  const contribution = (b: RetirementBaseline, id: string) => b.contributions.find((c) => c.accountId === id)!;
  /** The figures a fixture row that "moves no figure" must leave alone. */
  const figures = (b: RetirementBaseline) => ({ window: b.window, totals: b.totals, spending: b.spending, income: b.income, contributions: b.contributions, savingsRate: b.savingsRate });

  beforeAll(async () => {
    t = await createTestDb();
    seed = await seedRetirementFixture(t.db);
    first = await computeBaseline(t.db, { today: TODAY, now: NOW });
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("dates the baseline at the latest close the feed can have and counts the 12 complete months the ledger covers", () => {
    expect(RetirementBaseline.parse(first)).toEqual(first);
    expect(first).toMatchObject({ schemaVersion: 1, asOf: "2026-10-13", today: "2026-10-14", computedAt: NOW.toISOString() });
    // The earliest on-budget row is 2025-09-03, so 2025-10 is the first full month and the whole window counts.
    expect(first.window).toEqual({ from: "2025-10", to: "2026-09", monthsWithData: 12 });
  });

  it("lists the eight accounts in name order with their values, buckets, valuation bases, bases and weights", () => {
    const A = seed.accounts;
    const base = { treatmentDefaulted: false, stale: false };
    const expected: BaselineAccount[] = [
      { ...base, accountId: A.K, name: "Acme 401(k)", type: "401k", taxTreatment: "pre_tax", bucket: "pre_tax", valueCents: "15000000", valuationDate: "2026-10-10", valuationBasis: "balance", fidelity: "balance_only" },
      { ...base, accountId: A.C, name: "Checking", type: "checking", taxTreatment: "none", bucket: "cash", valueCents: "500000", valuationDate: "2026-10-13", valuationBasis: "bank_balance" },
      { ...base, accountId: A.E, name: "College 529", type: "529", taxTreatment: "none", ineligible: "education", valueCents: "1200000", valuationDate: "2026-10-10", valuationBasis: "balance", fidelity: "balance_only" },
      {
        ...base,
        accountId: A.R,
        name: "Fidelity Roth IRA",
        type: "roth",
        taxTreatment: "roth",
        bucket: "roth",
        valueCents: "1820000",
        valuationDate: "2026-10-13",
        valuationBasis: "positions",
        fidelity: "positions",
        // The target-date fund's 420,000 splits 54/36/10 into 226,800 / 151,200 / 42,000.
        classCents: { us_stock: "851800", intl_stock: "151200", bonds: "790000", cash: "27000" },
        // Shares 4680.22, 830.77, 4340.66, 148.35; floors sum to 9998; .77 (intl) and .66 (bonds) take the two spare points.
        weights: { us_stock: 4680, intl_stock: 831, bonds: 4341, cash: 148, real_estate: 0, other: 0 },
        expenseRatio: { ppm: 410, coveredBp: 10000 },
      },
      { ...base, accountId: A.H, name: "HealthEquity HSA", type: "hsa", taxTreatment: "hsa", bucket: "hsa", valueCents: "125000", valuationDate: "2026-10-10", valuationBasis: "balance", fidelity: "balance_only" },
      {
        ...base,
        accountId: A.T,
        name: "Old Brokerage",
        type: "brokerage",
        taxTreatment: "taxable",
        bucket: "taxable",
        valueCents: "432500",
        valuationDate: "2026-10-13",
        valuationBasis: "snapshot",
        fidelity: "positions",
        // VTI's reported basis 200,000 is known; AAPL's 120,000 of value has none.
        basis: { knownCents: "200000", unknownValueCents: "120000", coverage: "partial", source: "statement" },
        classCents: { us_stock: "432500" },
        weights: { us_stock: 10000, intl_stock: 0, bonds: 0, cash: 0, real_estate: 0, other: 0 },
        expenseRatio: { ppm: 216, coveredBp: 10000 },
      },
      { ...base, accountId: A.S, name: "Savings", type: "savings", taxTreatment: "none", bucket: "cash", valueCents: "2000000", valuationDate: "2026-10-13", valuationBasis: "bank_balance" },
      {
        ...base,
        accountId: A.B,
        name: "Vanguard Brokerage",
        type: "brokerage",
        taxTreatment: "taxable",
        bucket: "taxable",
        valueCents: "2705200",
        valuationDate: "2026-10-13",
        valuationBasis: "snapshot",
        fidelity: "full_history",
        // Lots VTI 500,000 + 580,000, VXUS 580,000, AAPL 575,000 = 2,235,000, plus the cash line 143,200.
        basis: { knownCents: "2378200", unknownValueCents: "0", coverage: "full", source: "lots" },
        // US: VTI 1,250,000 + AAPL 600,000.
        classCents: { us_stock: "1850000", intl_stock: "712000", cash: "143200" },
        // Shares 6838.68, 2631.97, 529.35; floors 9998; .97 (intl) and .68 (US) take the spare points.
        weights: { us_stock: 6839, intl_stock: 2632, bonds: 0, cash: 529, real_estate: 0, other: 0 },
        expenseRatio: { ppm: 270, coveredBp: 10000 },
      },
    ];
    expect(first.accounts).toEqual(expected);
    // The credit card is not listed.
    expect(first.accounts.some((a) => a.accountId === A.V)).toBe(false);
  });

  it("measures fund costs as the value-weighted expense ratio of the positions that have one, with the share they cover (seams C25)", () => {
    // By the Holdings page's rule: a stock, bond, cash or CD position without a ratio costs 0; a fund without one is unknown.
    // B: (1,250,000 × 300 + 712,000 × 500 + 600,000 × 0 + 143,200 × 0) / 2,705,200 = 731,000,000 / 2,705,200 = 270.22 → 270 ppm; all covered.
    // R: (625,000 × 300 + 748,000 × 300 + 420,000 × 800 + 27,000 × 0) / 1,820,000 = 747,900,000 / 1,820,000 = 410.93 → 410 ppm.
    // T: (312,500 × 300 + 120,000 × 0) / 432,500 = 93,750,000 / 432,500 = 216.76 → 216 ppm.
    // B's 270 is the figure inputs open question 12 measured for the seed's brokerage account.
    expect(byId(first, seed.accounts.B).expenseRatio).toEqual({ ppm: 270, coveredBp: 10000 });
    expect(byId(first, seed.accounts.R).expenseRatio).toEqual({ ppm: 410, coveredBp: 10000 });
    expect(byId(first, seed.accounts.T).expenseRatio).toEqual({ ppm: 216, coveredBp: 10000 });
    // Balance-only accounts measure nothing (the resolver then freezes 0 and warns expense_ratio_unknown).
    for (const id of [seed.accounts.K, seed.accounts.H, seed.accounts.E, seed.accounts.C, seed.accounts.S]) expect(byId(first, id).expenseRatio).toBeUndefined();
  });

  it("sums the buckets and reads the household targets", () => {
    // 3,137,700 + 15,000,000 + 1,820,000 + 125,000 + 2,500,000 = 22,582,700; the 529 is in no bucket.
    expect(first.totals).toEqual({ byBucket: { taxable: "3137700", pre_tax: "15000000", roth: "1820000", hsa: "125000", cash: "2500000" }, totalCents: "22582700" });
    expect(first.allocationTargets).toEqual({ us_stock: 5000, intl_stock: 2500, bonds: 2000, cash: 500, real_estate: 0, other: 0 });
  });

  it("seeds spending from the grid's actuals plus uncategorized outflows, and income from take-home pay", () => {
    const C = seed.categories;
    expect(first.spending).toEqual({
      byCategory: [
        { categoryId: C.rent, name: "Rent", bucket: "bills", cents: "2400000", activeMonths: 12 },
        // 12 × 80,000 − the 5,000 refund.
        { categoryId: C.groceries, name: "Groceries", bucket: "spending", cents: "955000", activeMonths: 12 },
        { categoryId: C.childcare, name: "Childcare", bucket: "spending", cents: "600000", activeMonths: 12 },
      ],
      categorizedCents: "3955000",
      billsCents: "2400000",
      uncategorized: { count: 2, outflowCents: "45000", inflowCents: "20000" },
    });
    // Paycheck 12 × 700,000; the Dividends row (4,720, in B off budget) is the feed category: shown, never used.
    expect(first.income).toEqual({ takeHomeCents: "8400000", investmentIncomeCents: "4720" });
  });

  it("measures contributions into each planner investment account, with the recurring fallback", () => {
    const A = seed.accounts;
    const none = { outCents: "0", employerDetected: false, plannedCents: "0" };
    const expected: Record<string, BaselineContribution> = {
      // 24 unpaired rows: 1,200,000 employee and 600,000 "EMPLOYER MATCH"; first data 2025-09-30, so 2025-10 is the first full month.
      [A.K]: {
        ...none,
        accountId: A.K,
        monthsWithData: 12,
        grossInCents: "1800000",
        netCents: "1800000",
        unpairedCents: "1800000",
        employerCents: "600000",
        employeeCents: "1200000",
        employerDetected: true,
        annualNetCents: "1800000",
        annualEmployeeCents: "1200000",
        annualEmployerCents: "600000",
        annualUnpairedCents: "1800000",
        source: "measured",
        flags: [],
      },
      // First data 2026-06-01: four months, truncDiv(120,000 × 12, 4) = 360,000.
      [A.H]: {
        ...none,
        accountId: A.H,
        monthsWithData: 4,
        grossInCents: "120000",
        netCents: "120000",
        unpairedCents: "120000",
        employerCents: "0",
        employeeCents: "120000",
        annualNetCents: "360000",
        annualEmployeeCents: "360000",
        annualEmployerCents: "0",
        annualUnpairedCents: "360000",
        source: "measured",
        flags: ["partial_window"],
      },
      // One paired transfer of 500,000 from Checking: more than half the gross.
      [A.B]: {
        ...none,
        accountId: A.B,
        monthsWithData: 12,
        grossInCents: "500000",
        netCents: "500000",
        unpairedCents: "0",
        employerCents: "0",
        employeeCents: "500000",
        annualNetCents: "500000",
        annualEmployeeCents: "500000",
        annualEmployerCents: "0",
        annualUnpairedCents: "0",
        source: "measured",
        flags: ["irregular"],
      },
      // No flows over 11 months (first data 2025-10-13); 12 × 25,000 from the active recurring transfer.
      [A.R]: {
        ...none,
        accountId: A.R,
        monthsWithData: 11,
        grossInCents: "0",
        netCents: "0",
        unpairedCents: "0",
        employerCents: "0",
        employeeCents: "0",
        annualNetCents: "0",
        annualEmployeeCents: "0",
        annualEmployerCents: "0",
        annualUnpairedCents: "0",
        plannedCents: "300000",
        source: "recurring",
        flags: ["partial_window"],
      },
      // First data 2026-10-13: no month of the window counts.
      [A.T]: { ...none, accountId: A.T, monthsWithData: 0, grossInCents: "0", netCents: "0", unpairedCents: "0", employerCents: "0", employeeCents: "0", source: "none", flags: ["insufficient_history"] },
    };
    expect(first.contributions).toEqual(Object.values(expected).sort((a, b) => (a.accountId < b.accountId ? -1 : 1)));
    expect(contribution(first, A.E)).toBeUndefined();
    // Contributions 1,800,000 + 500,000 + 360,000; payroll 1,800,000 + 360,000; base 8,400,000 + 2,160,000;
    // truncDiv(2,660,000 × 10000, 10,560,000) = 2518.
    expect(first.savingsRate).toEqual({ bp: 2518, contributionsCents: "2660000", payrollCents: "2160000", baseCents: "10560000" });
  });

  it("is read-only and returns the same hash on a second call, computedAt aside", async () => {
    // 15:00 in New York, before the close: the same as-of date, another computedAt. In a READ ONLY
    // transaction any write would fail (SQLSTATE 25006).
    const later = new Date("2026-10-14T19:00:00Z");
    const second = await t.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      return computeBaseline(tx, { today: TODAY, now: later });
    });
    expect(second.computedAt).toBe(later.toISOString());
    expect(await baselineHash(second)).toBe(await baselineHash(first));
    expect(await baselineHash(first)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("audits the comparable figures without dates", () => {
    expect(baselineAuditJson(first)).toEqual({
      byBucket: { taxable: "3137700", pre_tax: "15000000", roth: "1820000", hsa: "125000", cash: "2500000" },
      totalCents: "22582700",
      categorizedCents: "3955000",
      billsCents: "2400000",
      uncategorizedOutflowCents: "45000",
      takeHomeCents: "8400000",
      contributionsCents: "2660000",
      savingsRateBp: 2518,
      accountCount: 8,
    });
    expect(baselineAuditJson({ ...first, asOf: "2026-10-12", today: "2026-10-13" })).toEqual(baselineAuditJson(first));
  });

  it("the fixture's profile document names the seeded accounts", () => {
    const doc = retirementFixtureDoc(seed);
    expect(Object.keys(doc.accounts ?? {}).sort()).toEqual([seed.accounts.B, seed.accounts.T, seed.accounts.C, seed.accounts.S, seed.accounts.K, seed.accounts.H, seed.accounts.R].sort());
    expect(doc.accounts?.[seed.accounts.R]).toEqual({ owner: "p2" });
  });

  it("an unknown fund ratio leaves the fund out of the covered share", async () => {
    // R without the target-date fund's ratio: (625,000 × 300 + 748,000 × 300 + 27,000 × 0) / 1,400,000
    // = 411,900,000 / 1,400,000 = 294.21 → 294 ppm, covering truncDiv(1,400,000 × 10000, 1,820,000) = 7692 bp.
    await t.db.update(security).set({ expenseRatioPpm: null }).where(eq(security.id, seed.inv.securities.tr2050));
    const b = await computeBaseline(t.db, { today: TODAY, now: NOW });
    expect(byId(b, seed.accounts.R).expenseRatio).toEqual({ ppm: 294, coveredBp: 7692 });
    expect(byId(b, seed.accounts.B).expenseRatio).toEqual({ ppm: 270, coveredBp: 10000 });
    await t.db.update(security).set({ expenseRatioPpm: 800 }).where(eq(security.id, seed.inv.securities.tr2050));
  });

  it("an investment account without a tax treatment takes its type's default bucket, flagged", async () => {
    await t.db.update(account).set({ taxTreatment: "none" }).where(eq(account.id, seed.accounts.K));
    const b = await computeBaseline(t.db, { today: TODAY, now: NOW });
    expect(byId(b, seed.accounts.K)).toMatchObject({ taxTreatment: "none", bucket: "pre_tax", treatmentDefaulted: true });
    expect(b.totals).toEqual(first.totals);
    await t.db.update(account).set({ taxTreatment: "pre_tax" }).where(eq(account.id, seed.accounts.K));
  });

  it("the 2025-09-03 and 2026-10-05 rows, the Savings transfers, the 529 and the credit card move no figure", async () => {
    // Without the 2025-09-03 row the earliest on-budget row is 2025-10-01 (a 1st), so 2025-10 is still the first full month.
    await t.db.delete(transaction).where(inArray(transaction.id, [seed.ledger.rentSep, seed.ledger.groceriesOct, ...seed.ledger.savingsTransfers]));
    await t.db.delete(account).where(inArray(account.id, [seed.accounts.E, seed.accounts.V]));
    const b = await computeBaseline(t.db, { today: TODAY, now: NOW });
    expect(figures(b)).toEqual(figures(first));
    expect(b.accounts).toEqual(first.accounts.filter((a) => a.accountId !== seed.accounts.E));
  });
});
