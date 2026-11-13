/**
 * Example documents for the contract tests of this directory. Not exported from the package.
 *
 * The household is the inputs design's fixture (inputs-and-data §7.0 and test 11): Alex, born
 * June 1975, retires at 60 (2035-06); Sam, born September 1977, retires at 62 (2039-09); both a
 * fixed life to 95; plan start 2026-10 (three months in year 0). Every amount marked "design"
 * is the design's; the account ids, category ids and the dates and texts of `meta` are made up
 * for the tests, and so are the amounts marked "illustrative". None of this is law or market
 * data: tax figures in the tests are synthetic.
 */
import type { RetirementBaseline } from "./baseline.js";
import type { SimInput } from "./input.js";
import type { RetirementProfileDocInput } from "./profile.js";
import type { FanSeries, SimSummary, YearRow, YearTable } from "./results.js";
import { defaultRunSettings } from "./settings.js";
import type { TaxYearDetail } from "./tax.js";

export const IDS = {
  /** "Acme 401(k)", pre-tax, owned by p1. */
  K: "a0000000-0000-4000-8000-000000000001",
  /** "HealthEquity HSA", owned by p1. */
  H: "a0000000-0000-4000-8000-000000000002",
  /** "Old Brokerage", taxable, joint. */
  T: "a0000000-0000-4000-8000-000000000003",
  /** "Savings". */
  S: "a0000000-0000-4000-8000-000000000004",
  /** "College 529": listed, never included. */
  E: "a0000000-0000-4000-8000-000000000005",
  /** The investment seed's brokerage account, joint. */
  B: "a0000000-0000-4000-8000-000000000007",
  /** The investment seed's Roth IRA, owned by p2. */
  R: "a0000000-0000-4000-8000-000000000008",
  /** "Checking". */
  C: "a0000000-0000-4000-8000-000000000009",
  scenario: "b0000000-0000-4000-8000-000000000001",
  rent: "c0000000-0000-4000-8000-000000000001",
  groceries: "c0000000-0000-4000-8000-000000000002",
  childcare: "c0000000-0000-4000-8000-000000000003",
} as const;

/** `retirementFixtureDoc(seed)` of inputs §7.0, as the wizard would send it (defaults left out). */
export function fixtureProfileDoc(): RetirementProfileDocInput {
  return {
    schemaVersion: 1,
    people: {
      p1: { name: "Alex", birthYear: 1975, birthMonth: 6, retirementAge: 60, longevity: { mode: "fixed", age: 95 } },
      p2: { name: "Sam", birthYear: 1977, birthMonth: 9, retirementAge: 62, longevity: { mode: "fixed", age: 95 } },
    },
    state: "CO",
    accounts: {
      [IDS.B]: {},
      [IDS.T]: {},
      [IDS.C]: {},
      [IDS.S]: {},
      [IDS.K]: { owner: "p1" },
      [IDS.H]: { owner: "p1" },
      [IDS.R]: { owner: "p2" },
    },
    allocation: {},
    incomes: {
      salary_p1: { kind: "salary", personId: "p1", annualGrossCents: "12000000", realRaiseBp: 100 },
      salary_p2: { kind: "salary", personId: "p2", annualGrossCents: "6000000" },
      pen1: {
        kind: "pension",
        personId: "p2",
        name: "Sam's pension",
        monthlyCents: "100000",
        dollars: "nominal",
        start: { at: "age", personId: "p2", age: 62 },
        cola: { mode: "none" },
        survivorBp: 5000,
      },
    },
    socialSecurity: {
      p1: { mode: "estimate", monthlyAtFraCents: "280000", asOfYear: 2026, claimAge: { years: 67, months: 0 } },
      p2: { mode: "estimate", monthlyAtFraCents: "190000", asOfYear: 2026, claimAge: { years: 67, months: 0 } },
    },
    spending: {
      base: { mode: "live" },
      essential: { mode: "live" },
      phases: [
        { label: "Early active years", fromAge: 60, multiplierBp: 10000 },
        { label: "Slower years", fromAge: 75, multiplierBp: 10000 },
        { label: "Late life", fromAge: 85, multiplierBp: 10000 },
      ],
      goals: { roof: { name: "Roof", year: 2031, amountCents: "1800000", dollars: "today" } },
      healthcare: { includedInBase: true },
      longTermCare: {},
    },
    rothConversions: { conv1: { personId: "p1", fromYear: 2036, toYear: 2036, annualCents: "3000000", dollars: "today" } },
  };
}

/** The fixture's baseline (inputs §7.0, tests 4, 6, 7, 9 and 11). */
export function fixtureBaseline(): RetirementBaseline {
  const base = {
    treatmentDefaulted: false,
    stale: false,
  };
  return {
    schemaVersion: 1,
    asOf: "2026-10-13",
    today: "2026-10-14",
    computedAt: "2026-10-14T12:00:00.000Z",
    window: { from: "2025-10", to: "2026-09", monthsWithData: 12 },
    accounts: [
      { ...base, accountId: IDS.K, name: "Acme 401(k)", type: "401k", taxTreatment: "pre_tax", bucket: "pre_tax", valueCents: "15000000", valuationDate: "2026-10-10", valuationBasis: "balance", fidelity: "balance_only" },
      { ...base, accountId: IDS.H, name: "HealthEquity HSA", type: "hsa", taxTreatment: "hsa", bucket: "hsa", valueCents: "125000", valuationDate: "2026-10-10", valuationBasis: "balance", fidelity: "balance_only" },
      {
        ...base,
        accountId: IDS.T,
        name: "Old Brokerage",
        type: "brokerage",
        taxTreatment: "taxable",
        bucket: "taxable",
        valueCents: "432500",
        valuationDate: "2026-10-13",
        valuationBasis: "snapshot",
        fidelity: "positions",
        basis: { knownCents: "200000", unknownValueCents: "120000", coverage: "partial", source: "statement" },
        classCents: { us_stock: "432500" },
        weights: { us_stock: 10000, intl_stock: 0, bonds: 0, cash: 0, real_estate: 0, other: 0 },
      },
      {
        ...base,
        accountId: IDS.B,
        name: "Brokerage",
        type: "brokerage",
        taxTreatment: "taxable",
        bucket: "taxable",
        valueCents: "2705200",
        valuationDate: "2026-10-13",
        valuationBasis: "lots",
        fidelity: "full_history",
        basis: { knownCents: "2378200", unknownValueCents: "0", coverage: "full", source: "lots" },
        classCents: { us_stock: "1850000", intl_stock: "712000", cash: "143200" },
        weights: { us_stock: 6839, intl_stock: 2632, bonds: 0, cash: 529, real_estate: 0, other: 0 },
        // Inputs open question 12: "measured 270 ppm for the seed's brokerage account"; the covered share is illustrative.
        expenseRatio: { ppm: 270, coveredBp: 10000 },
      },
      {
        ...base,
        accountId: IDS.R,
        name: "Roth IRA",
        type: "roth",
        taxTreatment: "roth",
        bucket: "roth",
        valueCents: "1820000",
        valuationDate: "2026-10-13",
        valuationBasis: "lots",
        fidelity: "full_history",
        classCents: { us_stock: "851800", intl_stock: "151200", bonds: "790000", cash: "27000" },
        weights: { us_stock: 4680, intl_stock: 831, bonds: 4341, cash: 148, real_estate: 0, other: 0 },
      },
      { ...base, accountId: IDS.C, name: "Checking", type: "checking", taxTreatment: "none", bucket: "cash", valueCents: "500000", valuationDate: "2026-10-13", valuationBasis: "bank_balance" },
      { ...base, accountId: IDS.S, name: "Savings", type: "savings", taxTreatment: "none", bucket: "cash", valueCents: "2000000", valuationDate: "2026-10-13", valuationBasis: "bank_balance" },
      { ...base, accountId: IDS.E, name: "College 529", type: "529", taxTreatment: "none", ineligible: "education", valueCents: "1200000", valuationDate: "2026-10-10", valuationBasis: "balance" },
    ],
    // Design: 15,000,000 + 125,000 + 3,137,700 + 1,820,000 + 2,500,000 = 22,582,700.
    totals: { byBucket: { pre_tax: "15000000", hsa: "125000", taxable: "3137700", roth: "1820000", cash: "2500000" }, totalCents: "22582700" },
    allocationTargets: { us_stock: 5000, intl_stock: 2500, bonds: 2000, cash: 500, real_estate: 0, other: 0 },
    spending: {
      // Design: Rent 12 × 200,000; Groceries 12 × 80,000 − 5,000; Childcare 12 × 50,000; 3,955,000 in all.
      byCategory: [
        { categoryId: IDS.rent, name: "Rent", bucket: "bills", cents: "2400000", activeMonths: 12 },
        { categoryId: IDS.groceries, name: "Groceries", bucket: "spending", cents: "955000", activeMonths: 12 },
        { categoryId: IDS.childcare, name: "Childcare", bucket: "spending", cents: "600000", activeMonths: 12 },
      ],
      categorizedCents: "3955000",
      billsCents: "2400000",
      uncategorized: { count: 2, outflowCents: "45000", inflowCents: "20000" },
    },
    income: { takeHomeCents: "8400000", investmentIncomeCents: "4720" },
    contributions: [
      {
        // Design (test 6): 24 unpaired rows, 1,200,000 employee and 600,000 employer.
        accountId: IDS.K,
        monthsWithData: 12,
        grossInCents: "1800000",
        outCents: "0",
        netCents: "1800000",
        unpairedCents: "1800000",
        employerCents: "600000",
        employeeCents: "1200000",
        employerDetected: true,
        annualNetCents: "1800000",
        annualEmployeeCents: "1200000",
        annualEmployerCents: "600000",
        annualUnpairedCents: "1800000",
        plannedCents: "0",
        source: "measured",
        flags: [],
      },
      {
        // Design (test 6): four rows of 30,000 over four months, annualized to 360,000.
        accountId: IDS.H,
        monthsWithData: 4,
        grossInCents: "120000",
        outCents: "0",
        netCents: "120000",
        unpairedCents: "120000",
        employerCents: "0",
        employeeCents: "120000",
        employerDetected: false,
        annualNetCents: "360000",
        annualEmployeeCents: "360000",
        annualEmployerCents: "0",
        annualUnpairedCents: "360000",
        plannedCents: "0",
        source: "measured",
        flags: ["partial_window"],
      },
      {
        // Design (test 8): 300,000 a year from the recurring transfer of 25,000 a month.
        accountId: IDS.R,
        monthsWithData: 0,
        grossInCents: "0",
        outCents: "0",
        netCents: "0",
        unpairedCents: "0",
        employerCents: "0",
        employeeCents: "0",
        employerDetected: false,
        plannedCents: "300000",
        source: "recurring",
        flags: ["insufficient_history"],
      },
    ],
    // Illustrative except the measured rate of 2518 bp (inputs §3.4 R9).
    savingsRate: { bp: 2518, contributionsCents: "2580000", payrollCents: "1846000", baseCents: "10246000" },
  };
}

/**
 * The fixture's frozen input (inputs test 11) with the seams' additions: `expenseRatioPpm` on
 * every account (270 measured on B; 0 elsewhere), `inBase` on healthcare, and the default run
 * settings with `portfolio` and `tax`. Arrays are sorted as R12 sorts them.
 */
export function fixtureSimInput(): SimInput {
  const cash = { us_stock: 0, intl_stock: 0, bonds: 0, cash: 10000, real_estate: 0, other: 0 };
  const target = { us_stock: 5000, intl_stock: 2500, bonds: 2000, cash: 500, real_estate: 0, other: 0 };
  const salary = { dollars: "today", cola: { mode: "cpi" }, survivorBp: 0, taxableBp: 10000, earned: true } as const;
  return {
    schema: "meridian.retirement.input",
    schemaVersion: 1,
    meta: {
      createdAt: "2026-10-14T12:00:00.000Z",
      today: "2026-10-14",
      asOf: "2026-10-13",
      profileRevision: 1,
      baselineHash: "0".repeat(64),
      scenarioId: IDS.scenario,
      scenarioRevision: 1,
      scenarioName: "Base plan",
      provenance: { [`accounts.${IDS.T}.basis`]: "live", [`accounts.${IDS.K}.allocation`]: "default", "spending.base": "live" },
      warnings: [
        { code: "basis_unknown", severity: "warning", path: `accounts.${IDS.T}.basisCents`, message: "Basis unknown for 1,200.00", accountId: IDS.T },
        { code: "allocation_assumed", severity: "warning", path: `accounts.${IDS.K}.allocation`, message: "Household targets used", accountId: IDS.K },
      ],
    },
    data: { version: "2026.11.0" },
    plan: { startYear: 2026, startMonth: "2026-10", firstYearMonths: 3, endYear: 2072, stepsPerYear: 1, currency: "USD" },
    household: {
      filingStatus: "married_joint",
      state: "CO",
      people: [
        { id: "p1", name: "Alex", birthYear: 1975, birthMonth: 6, retirementMonth: "2035-06", longevity: { mode: "fixed", age: 95 } },
        { id: "p2", name: "Sam", birthYear: 1977, birthMonth: 9, retirementMonth: "2039-09", longevity: { mode: "fixed", age: 95 } },
      ],
    },
    accounts: [
      { id: IDS.K, name: "Acme 401(k)", type: "401k", bucket: "pre_tax", owner: "p1", balanceCents: "15000000", allocation: target, allocationSource: "household_target", expenseRatioPpm: 0, synthetic: false },
      { id: IDS.H, name: "HealthEquity HSA", type: "hsa", bucket: "hsa", owner: "p1", balanceCents: "125000", allocation: target, allocationSource: "household_target", expenseRatioPpm: 0, synthetic: false },
      {
        id: IDS.T,
        name: "Old Brokerage",
        type: "brokerage",
        bucket: "taxable",
        owner: "joint",
        balanceCents: "432500",
        basisCents: "200000",
        basisCoverage: "partial",
        allocation: { us_stock: 10000, intl_stock: 0, bonds: 0, cash: 0, real_estate: 0, other: 0 },
        allocationSource: "holdings",
        expenseRatioPpm: 0,
        synthetic: false,
      },
      { id: IDS.S, name: "Savings", type: "savings", bucket: "cash", owner: "joint", balanceCents: "2000000", allocation: cash, allocationSource: "cash", expenseRatioPpm: 0, synthetic: false },
      {
        id: IDS.B,
        name: "Brokerage",
        type: "brokerage",
        bucket: "taxable",
        owner: "joint",
        balanceCents: "2705200",
        basisCents: "2378200",
        basisCoverage: "full",
        allocation: { us_stock: 6839, intl_stock: 2632, bonds: 0, cash: 529, real_estate: 0, other: 0 },
        allocationSource: "holdings",
        expenseRatioPpm: 270,
        synthetic: false,
      },
      {
        id: IDS.R,
        name: "Roth IRA",
        type: "roth",
        bucket: "roth",
        owner: "p2",
        balanceCents: "1820000",
        allocation: { us_stock: 4680, intl_stock: 831, bonds: 4341, cash: 148, real_estate: 0, other: 0 },
        allocationSource: "holdings",
        expenseRatioPpm: 0,
        synthetic: false,
      },
      { id: IDS.C, name: "Checking", type: "checking", bucket: "cash", owner: "joint", balanceCents: "500000", allocation: cash, allocationSource: "cash", expenseRatioPpm: 0, synthetic: false },
      { id: "synthetic:roth:p1", name: "Roth (for conversions)", bucket: "roth", owner: "p1", balanceCents: "0", allocation: target, allocationSource: "pretax_mix", expenseRatioPpm: 0, synthetic: true },
    ],
    incomes: [
      { id: "pen1", kind: "pension", personId: "p2", name: "Sam's pension", annualCents: "1200000", dollars: "nominal", startMonth: "2039-09", realGrowthBp: 0, cola: { mode: "none" }, survivorBp: 5000, taxableBp: 10000, earned: false },
      { id: "salary_p1", kind: "salary", personId: "p1", name: "Salary", annualCents: "12000000", startMonth: "2026-10", endMonth: "2035-06", realGrowthBp: 100, ...salary },
      { id: "salary_p2", kind: "salary", personId: "p2", name: "Salary", annualCents: "6000000", startMonth: "2026-10", endMonth: "2039-09", realGrowthBp: 0, ...salary },
    ],
    socialSecurity: {
      people: [
        { personId: "p1", mode: "estimate", monthlyAtFraCents: "280000", asOfYear: 2026, claimMonth: "2042-06", claimAgeMonths: 804 },
        { personId: "p2", mode: "estimate", monthlyAtFraCents: "190000", asOfYear: 2026, claimMonth: "2044-09", claimAgeMonths: 804 },
      ],
      spousal: true,
      survivor: true,
    },
    spending: {
      baseAnnualCents: "4000000",
      essentialAnnualCents: "2400000",
      startMonth: "2035-06",
      survivorBp: 10000,
      phases: [
        { fromYear: 2035, multiplierBp: 10000 },
        { fromYear: 2050, multiplierBp: 10000 },
        { fromYear: 2060, multiplierBp: 10000 },
      ],
      goals: [{ id: "roof", name: "Roof", year: 2031, amountCents: "1800000", dollars: "today" }],
      healthcare: [
        { personId: "p1", preMedicareAnnualCents: "0", preMedicareFrom: "2035-06", medicareFrom: "2040-06", medicareAnnualCents: "0", realGrowthBp: 0, inBase: true },
        { personId: "p2", preMedicareAnnualCents: "0", preMedicareFrom: "2039-09", medicareFrom: "2042-09", medicareAnnualCents: "0", realGrowthBp: 0, inBase: true },
      ],
      longTermCare: [],
    },
    contributions: [
      { accountId: IDS.K, employeeAnnualCents: "1200000", employerAnnualCents: "600000", scaleWith: "p1", salaryBasisCents: "12000000", endMonth: "2035-06" },
      { accountId: IDS.H, employeeAnnualCents: "360000", employerAnnualCents: "0", scaleWith: "p1", salaryBasisCents: "12000000", endMonth: "2035-06" },
      { accountId: IDS.B, employeeAnnualCents: "500000", employerAnnualCents: "0", scaleWith: "household", salaryBasisCents: "18000000", endMonth: "2039-09" },
      { accountId: IDS.R, employeeAnnualCents: "300000", employerAnnualCents: "0", scaleWith: "p2", salaryBasisCents: "6000000", endMonth: "2039-09" },
    ],
    rothConversions: [{ year: 2036, personId: "p1", amountCents: "3000000", dollars: "today" }],
    settings: defaultRunSettings(),
  };
}

/** A year's tax detail with every amount zero (an accumulation year in which nothing is owed). */
export function zeroTaxDetail(filingStatus: TaxYearDetail["filingStatus"]): TaxYearDetail {
  return {
    filingStatus,
    totalFederalCents: "0",
    incomeTaxCents: "0",
    ordinaryTaxCents: "0",
    capitalGainsTaxCents: "0",
    niitCents: "0",
    earlyPenaltyCents: "0",
    hsaPenaltyCents: "0",
    payrollTaxCents: "0",
    agiCents: "0",
    taxableIncomeCents: "0",
    ordinaryTaxableCents: "0",
    taxableSocialSecurityCents: "0",
    standardDeductionCents: "0",
    seniorDeductionCents: "0",
    gainsAt0Cents: "0",
    gainsAt15Cents: "0",
    gainsAt20Cents: "0",
    capitalLossCarryoverCents: "0",
    magiIrmaaCents: "0",
    magiAcaCents: "0",
    bracketRateBp: 0,
    nextGainRateBp: 0,
  };
}

/**
 * One drawdown year of a one-person, one-account plan (illustrative): a Roth account of
 * 1,000,000.00 in stocks, 40,000.00 spent, no tax, a 5% return on the rest at 2.5% inflation:
 * (1,000,000 − 40,000) × 1.05 = 1,008,000.00; growth 48,000.00; today's dollars 1,008,000 ÷ 1.025
 * = 983,414.63 (983,414.634… rounded half away from zero).
 */
export function exampleYearRow(): YearRow {
  return {
    year: 2027,
    yearFractionPpm: 1_000_000,
    ages: [65],
    alive: [true],
    phase: "retirement",
    filingStatus: "single",
    cpiStart: "1.000000000",
    cpiEnd: "1.025000000",
    inflationBp: 250,
    portfolioReturnBp: 500,
    income: { wages: "0", socialSecurity: ["0"], socialSecurityParts: [{ spousal: "0", survivor: "0", withheld: "0" }], pensionAnnuity: "0", rental: "0", other: "0", total: "0" },
    contributions: { employee: "0", employer: "0" },
    spending: { planned: "4000000", funded: "4000000", core: "4000000", healthcare: "0", longTermCare: "0", goals: "0", floor: "4000000", shortfall: "0" },
    strategy: { events: [], withdrawalRateBp: 400 },
    withdrawals: {
      byAccount: ["4000000"],
      byBucket: { taxable: "0", pre_tax: "0", roth: "4000000", hsa: "0", cash: "0" },
      total: "4000000",
      rmdByAccount: ["0"],
      rmdTotal: "0",
    },
    conversions: "0",
    investment: { realizedGains: "0", dividends: "0", coupons: "0" },
    tax: zeroTaxDetail("single"),
    surplusSaved: "0",
    growth: "4800000",
    ending: {
      byAccount: ["100800000"],
      basisByAccount: ["0"],
      byBucket: { taxable: "0", pre_tax: "0", roth: "100800000", hsa: "0", cash: "0" },
      total: "100800000",
      totalReal: "98341463",
    },
    failed: false,
  };
}

export function exampleYearTable(): YearTable {
  return {
    schemaVersion: 1,
    pathIndex: 0,
    deathYears: [2056],
    accounts: [{ id: "roth", name: "Roth IRA", bucket: "roth", owner: "p1" }],
    startingTotal: "100000000",
    rows: [exampleYearRow()],
  };
}

/**
 * A summary of a ten-path run with eight successes (the inputs design's fake engine, §7.0); the
 * other figures are illustrative. Wilson at 8 of 10, z = 1.96: centre (0.8 + 1.96²/20) ÷ (1 + 1.96²/10)
 * = 0.99208 ÷ 1.38416 = 0.716738; half-width 1.96 ÷ 1.38416 × √(0.016 + 1.96²/400) = 1.416022 × 0.160013
 * = 0.226582; bounds 0.490156 and 0.943320 → 4902 and 9433 bp. Depletions in plan years 2 and 3 of a
 * 2026 start: first 2028; the running count reaches ceil(2 ÷ 2) = 1 in 2028.
 */
export function exampleSimSummary(): SimSummary {
  return {
    schemaVersion: 1,
    paths: 10,
    successPaths: 8,
    fullPlanPaths: 8,
    successCi95Bp: [4902, 9433],
    endingWealthReal: { p10: "0", p25: "35000000", p50: "98000000", p75: "150000000", p90: "210000000", mean: "101234567" },
    endingWealthNominal: { p10: "0", p50: "180000000", p90: "390000000" },
    failure: { paths: 2, firstDepletionYear: 2028, medianDepletionYear: 2028, byYear: [0, 0, 1, 1] },
    lifetimeSpendingRealP50: "160000000",
    lifetimeTaxesRealP50: "12000000",
    shortfallRealP50OfFailures: "4500000",
    model: { kind: "bootstrap", requestedPaths: 10, meanBlockYears: 10 },
    mortalityTable: "fixed",
    strategy: "constant_dollar",
    startYear: 2026,
    firstYearFractionPpm: 250_000,
    dataChecksum: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    digest: "1a2b3c4d",
  };
}

/** A fan of four years (fundedBp as strategies §3.10's example: 4 paths, a first failure in plan year 3). */
export function exampleFanSeries(): FanSeries {
  const band = (values: string[]) => ({ p10: values, p25: values, p50: values, p75: values, p90: values });
  return {
    schemaVersion: 1,
    years: [2026, 2027, 2028, 2029],
    ages: [[51, 52, 53, 54]],
    aliveCount: [4, 4, 4, 4],
    fundedBp: [10000, 10000, 10000, 7500],
    truncated: false,
    real: band(["100", "200", "300", "400"]),
    nominal: band(["100", "205", "315", "430"]),
    spendingFromIndex: 2,
    spendingReal: band(["10", "10"]),
  };
}

/**
 * Paths in a JSON-like value that a stored document may not hold (inputs decision 2): `null`,
 * `undefined`, a non-integer or unsafe number, or anything but plain objects, arrays, strings,
 * booleans and safe integers. Empty for a valid stored document.
 */
export function forbiddenValuePaths(value: unknown, at = "$"): string[] {
  if (value === null) return [`${at} (null)`];
  if (typeof value === "string" || typeof value === "boolean") return [];
  if (typeof value === "number") return Number.isSafeInteger(value) ? [] : [`${at} (${value})`];
  if (Array.isArray(value)) return value.flatMap((item, i) => forbiddenValuePaths(item, `${at}[${i}]`));
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.entries(value).flatMap(([key, item]) => forbiddenValuePaths(item, `${at}.${key}`));
  }
  return [`${at} (${typeof value})`];
}
