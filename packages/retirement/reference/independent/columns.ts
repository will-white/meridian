// The expected CSV files of R1 and R2: one row per plan year, every money column of the sheets'
// tables (r1.md §4, r2.md §4) plus the columns their §2.11 lists as 0 (or equal to another column)
// in every year, so that the engine comparison of step 22 covers them too.
//
// Cells: money in dollars with two decimals and no thousands separator (sheets §2.12 / §2.13
// rounding); basis points as integers; price levels as the shortest round-trip form of the double
// (JavaScript String()); ages and filing as the sheets print them.

import { ASSETS, BUCKETS, type RunResult, type YearRow } from "./deterministic.js";
import { basisPoints, money } from "./money.js";

export type CellKind = "money" | "bp" | "cpi" | "text" | "year";

export interface Column {
  readonly key: string;
  readonly kind: CellKind;
  readonly value: (row: YearRow) => number | string;
}

export function columnsFor(run: RunResult): Column[] {
  const s = run.scenario;
  const m = (key: string, value: (row: YearRow) => number): Column => ({ key, kind: "money", value });
  const zero = (key: string): Column => m(key, () => 0);
  const cols: Column[] = [
    { key: "year", kind: "year", value: (r) => r.year },
    { key: "ages", kind: "text", value: (r) => r.ages },
    { key: "filing", kind: "text", value: (r) => r.filing },
    { key: "cpi_start", kind: "cpi", value: (r) => r.cpiStart },
    { key: "cpi_end", kind: "cpi", value: (r) => r.cpiEnd },
    // Income.
    ...s.persons.map((p) => m(`ss_${p.id}`, (r) => r.ss[p.id] ?? 0)),
    m("pension", (r) => r.pension),
    zero("wages"),
    zero("rental"),
    zero("other_income"),
    m("income_total", (r) => r.incomeTotal),
    zero("employee_contributions"),
    zero("employer_contributions"),
    zero("payroll_tax"),
    // Spending.
    m("planned", (r) => r.planned),
    m("healthcare", (r) => r.healthcare),
    m("long_term_care", (r) => r.longTermCare),
    m("goals", (r) => r.goals),
    m("floor", (r) => r.floor),
    m("funded", (r) => r.funded),
    m("core", (r) => r.core),
    m("shortfall", (r) => r.shortfall),
    m("surplus_saved", (r) => r.surplus),
    // Withdrawals: gross by account (RMDs included, conversions excluded), by bucket, RMDs.
    ...s.accounts.map((a) => m(`wd_${a.id}`, (r) => r.withdrawals[a.id] ?? 0)),
    ...BUCKETS.map((b) =>
      m(`wd_bucket_${b}`, (r) => s.accounts.filter((a) => a.bucket === b).reduce((sum, a) => sum + (r.withdrawals[a.id] ?? 0), 0)),
    ),
    ...s.accounts.filter((a) => a.bucket === "pre_tax").map((a) => m(`rmd_${a.id}`, (r) => r.rmd[a.id] ?? 0)),
    m("rmd_total", (r) => r.rmdTotal),
    m("wd_total", (r) => r.withdrawalsTotal),
    m("conversions", (r) => r.conversions),
    // Investment income.
    m("realized_gains", (r) => r.realizedGains),
    m("dividends", (r) => r.dividends),
    m("qualified_dividends", (r) => r.qualifiedDividends),
    m("coupons", (r) => r.coupons),
    m("interest_carried", (r) => r.interestCarried),
    // Tax (every TaxYearDetail money line the sheets define).
    m("provisional_income", (r) => r.tax.provisionalIncome),
    m("taxable_ss", (r) => r.tax.taxableSs),
    m("agi", (r) => r.tax.agi),
    m("magi_irmaa", (r) => r.tax.magiIrmaa),
    m("magi_aca", (r) => r.tax.magiAca),
    m("standard_deduction", (r) => r.tax.standardDeduction),
    m("senior_deduction", (r) => r.tax.seniorDeduction),
    m("taxable_income", (r) => r.tax.taxableIncome),
    m("ordinary_taxable", (r) => r.tax.ordinaryTaxable),
    m("gains_at_0", (r) => r.tax.gainsAt0),
    m("gains_at_15", (r) => r.tax.gainsAt15),
    m("gains_at_20", (r) => r.tax.gainsAt20),
    m("ordinary_tax", (r) => r.tax.ordinaryTax),
    m("capital_gains_tax", (r) => r.tax.capitalGainsTax),
    m("income_tax", (r) => r.tax.incomeTax),
    m("niit", (r) => r.tax.niit),
    m("penalty_10", (r) => r.tax.penalty10),
    m("penalty_20", (r) => r.tax.penalty20),
    m("total_federal_tax", (r) => r.tax.totalFederalTax),
    m("capital_loss_carryover", (r) => r.tax.capitalLossCarryover),
    { key: "bracket_rate_bp", kind: "bp", value: (r) => r.tax.bracketRateBp },
    { key: "next_gain_rate_bp", kind: "bp", value: (r) => r.tax.nextGainRateBp },
    // Ending balances after returns, buckets, taxable basis by asset (before a death-year reset).
    ...s.accounts.map((a) => m(`end_${a.id}`, (r) => r.ending[a.id] ?? 0)),
    ...BUCKETS.map((b) =>
      m(`end_bucket_${b}`, (r) => s.accounts.filter((a) => a.bucket === b).reduce((sum, a) => sum + (r.ending[a.id] ?? 0), 0)),
    ),
    ...s.accounts
      .filter((a) => a.bucket === "taxable")
      .flatMap((a) => [
        ...ASSETS.map((k) => m(`basis_${a.id}_${k}`, (r) => r.basis[a.id]?.[k] ?? 0)),
        m(`basis_${a.id}`, (r) => {
          const b = r.basis[a.id];
          return b === undefined ? 0 : b.stocks + b.bonds + b.bills;
        }),
      ]),
    m("end_total", (r) => r.endTotal),
    m("end_total_real", (r) => r.endTotalReal),
    m("growth", (r) => r.growth),
    { key: "withdrawal_rate_bp", kind: "bp", value: (r) => basisPoints(r.withdrawalRate) },
    { key: "portfolio_return_bp", kind: "bp", value: (r) => basisPoints(r.portfolioReturn) },
  ];
  return cols;
}

function cell(c: Column, row: YearRow): string {
  const v = c.value(row);
  switch (c.kind) {
    case "money":
      return money(v as number);
    case "cpi":
      return String(v);
    case "bp":
    case "year":
      return String(v);
    case "text":
      return String(v);
  }
}

/** The CSV text: a header line, one line per plan year, LF line ends, a final newline. */
export function renderCsv(run: RunResult): string {
  const cols = columnsFor(run);
  const lines = [cols.map((c) => c.key).join(",")];
  for (const row of run.rows) lines.push(cols.map((c) => cell(c, row)).join(","));
  return `${lines.join("\n")}\n`;
}

/**
 * Where each column of the sheets' tables (`<!-- table: id -->`) is found in the CSV. A sheet
 * column absent here is a mistake the test reports.
 */
export const SHEET_COLUMNS: Readonly<Record<"r1" | "r2", Readonly<Record<string, Readonly<Record<string, string>>>>>> = {
  r1: {
    "r1.income": {
      Year: "year", Ages: "ages", cpiStart: "cpi_start", "SS A": "ss_p1", "SS B": "ss_p2", Pension: "pension",
      "Income total": "income_total", Planned: "planned", Goals: "goals", Floor: "floor", Funded: "funded", Core: "core",
      "Surplus saved": "surplus_saved",
    },
    "r1.withdrawals": {
      Year: "year", Cash: "wd_cash", Taxable: "wd_taxable", "Pre-tax A": "wd_pre_tax_a", "Pre-tax B": "wd_pre_tax_b",
      "Pre-tax bucket": "wd_bucket_pre_tax", "RMD A": "rmd_pre_tax_a", "RMD B": "rmd_pre_tax_b", "RMD total": "rmd_total",
      "Withdrawals total": "wd_total", Conversions: "conversions",
    },
    "r1.tax": {
      Year: "year", "Realized gains": "realized_gains", "Provisional income": "provisional_income", "Taxable SS": "taxable_ss",
      AGI: "agi", "Standard deduction": "standard_deduction", "Senior deduction": "senior_deduction",
      "Taxable income": "taxable_income", "Ordinary taxable": "ordinary_taxable", "Gains at 0%": "gains_at_0",
      "Gains at 15%": "gains_at_15", "Ordinary tax": "ordinary_tax", "Capital gains tax": "capital_gains_tax",
      "Total federal tax": "total_federal_tax", "MAGI ACA": "magi_aca", "Bracket rate bp": "bracket_rate_bp",
      "Next gain rate bp": "next_gain_rate_bp",
    },
    "r1.ending": {
      Year: "year", Taxable: "end_taxable", "Taxable basis": "basis_taxable", "Pre-tax A": "end_pre_tax_a",
      "Pre-tax B": "end_pre_tax_b", "Pre-tax bucket": "end_bucket_pre_tax", "Roth A": "end_roth_a", "End total": "end_total",
      cpiEnd: "cpi_end", "End total real": "end_total_real", Growth: "growth", "Withdrawal rate bp": "withdrawal_rate_bp",
      "Portfolio return bp": "portfolio_return_bp",
    },
  },
  r2: {
    "r2.income": {
      Year: "year", Ages: "ages", Filing: "filing", cpiStart: "cpi_start", "SS p1": "ss_p1", "SS p2": "ss_p2",
      "Income total": "income_total", Planned: "planned", Healthcare: "healthcare", "Long-term care": "long_term_care",
      Goals: "goals", Floor: "floor", Funded: "funded", Core: "core", Shortfall: "shortfall",
    },
    "r2.withdrawals": {
      Year: "year", Cash: "wd_cash", HSA: "wd_hsa_2", Taxable: "wd_taxable", "Pre-tax 1": "wd_pre_tax_1",
      "Pre-tax 2": "wd_pre_tax_2", "Pre-tax bucket": "wd_bucket_pre_tax", "Roth 1": "wd_roth_1", "Roth 2": "wd_roth_2",
      "Roth bucket": "wd_bucket_roth", "RMD 1": "rmd_pre_tax_1", "RMD 2": "rmd_pre_tax_2", "RMD total": "rmd_total",
      "Withdrawals total": "wd_total", Conversions: "conversions",
    },
    "r2.tax": {
      Year: "year", "Realized gains": "realized_gains", Dividends: "dividends", Coupons: "coupons",
      "Interest carried": "interest_carried", "Provisional income": "provisional_income", "Taxable SS": "taxable_ss",
      AGI: "agi", "Standard deduction": "standard_deduction", "Senior deduction": "senior_deduction",
      "Taxable income": "taxable_income", "Ordinary taxable": "ordinary_taxable", "Gains at 0%": "gains_at_0",
      "Gains at 15%": "gains_at_15", "Ordinary tax": "ordinary_tax", "Capital gains tax": "capital_gains_tax",
      "Total federal tax": "total_federal_tax", "MAGI ACA": "magi_aca", "Bracket rate bp": "bracket_rate_bp",
      "Next gain rate bp": "next_gain_rate_bp",
    },
    "r2.ending": {
      Year: "year", Cash: "end_cash", Taxable: "end_taxable", "Basis stocks": "basis_taxable_stocks",
      "Basis bonds": "basis_taxable_bonds", "Taxable basis": "basis_taxable", "Pre-tax 1": "end_pre_tax_1",
      "Pre-tax 2": "end_pre_tax_2", "Pre-tax bucket": "end_bucket_pre_tax", "Roth 1": "end_roth_1", "Roth 2": "end_roth_2",
      "Roth bucket": "end_bucket_roth", HSA: "end_hsa_2", "End total": "end_total", cpiEnd: "cpi_end",
      "End total real": "end_total_real", Growth: "growth", "Withdrawal rate bp": "withdrawal_rate_bp",
      "Portfolio return bp": "portfolio_return_bp",
    },
  },
};

/**
 * CSV columns that no sheet table carries, with what the sheet (§1, §2.11) says they hold: "zero"
 * (0.00 in every year), the key of the column they equal, or a fixed text.
 */
export type Untabulated = "zero" | { readonly equals: string } | { readonly text: string };

export const UNTABULATED: Readonly<Record<"r1" | "r2", Readonly<Record<string, Untabulated>>>> = {
  r1: {
    filing: { text: "joint" }, // married filing jointly in every year (r1.md §1)
    wages: "zero", rental: "zero", other_income: "zero", employee_contributions: "zero", employer_contributions: "zero",
    payroll_tax: "zero", healthcare: "zero", long_term_care: "zero", shortfall: "zero",
    wd_roth_a: "zero", wd_bucket_roth: "zero", wd_bucket_hsa: "zero",
    wd_bucket_cash: { equals: "wd_cash" }, wd_bucket_taxable: { equals: "wd_taxable" },
    dividends: "zero", qualified_dividends: "zero", coupons: "zero", interest_carried: "zero",
    magi_irmaa: { equals: "agi" }, income_tax: { equals: "total_federal_tax" },
    gains_at_20: "zero", niit: "zero", penalty_10: "zero", penalty_20: "zero", capital_loss_carryover: "zero",
    end_cash: "zero", end_bucket_cash: "zero", end_bucket_taxable: { equals: "end_taxable" },
    end_bucket_roth: { equals: "end_roth_a" }, end_bucket_hsa: "zero",
    basis_taxable_stocks: { equals: "basis_taxable" }, basis_taxable_bonds: "zero", basis_taxable_bills: "zero",
  },
  r2: {
    pension: "zero", wages: "zero", rental: "zero", other_income: "zero", employee_contributions: "zero",
    employer_contributions: "zero", payroll_tax: "zero", surplus_saved: "zero",
    wd_bucket_cash: { equals: "wd_cash" }, wd_bucket_taxable: { equals: "wd_taxable" }, wd_bucket_hsa: { equals: "wd_hsa_2" },
    qualified_dividends: { equals: "dividends" },
    magi_irmaa: { equals: "agi" }, income_tax: { equals: "total_federal_tax" },
    gains_at_20: "zero", niit: "zero", penalty_10: "zero", penalty_20: "zero", capital_loss_carryover: "zero",
    end_bucket_cash: { equals: "end_cash" }, end_bucket_taxable: { equals: "end_taxable" }, end_bucket_hsa: { equals: "end_hsa_2" },
    basis_taxable_bills: "zero",
  },
};
