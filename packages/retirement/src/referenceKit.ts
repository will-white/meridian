/**
 * Test support for the reference scenarios (build step 22b; not exported from the package): the
 * engine's path of R1 or R2 as rows of the independent calculator's CSV columns
 * (`reference/independent/columns.ts`), so that every column of `r1.expected.csv` and
 * `r2.expected.csv` has an engine value to be compared with.
 *
 * Each money cell carries two engine values:
 * - `dollars`: the engine's own unrounded float64 figure, read from the path's `PathDetail`. Rounded
 *   once to the cent it follows the sheets' rounding rule (r1.md §2.12, r2.md §2.13: every cell, a
 *   bucket or a total included, is its unrounded value rounded half away from zero), which is how
 *   the calculator writes its cells, so the two are compared like with like.
 * - `table`: the same figure in the stored `YearTable` (the public output of `simulatePath`), where
 *   the table has it. The table differs from a once-rounded cell by design in two ways: the parts
 *   of a total are made to add up to it (`addUp`, strategies-outputs-web §3.11 item 5; bucket sums
 *   are taken after it), and `growth` is the plug of the roll-forward in cents (item 6).
 *
 * Nothing here is engine logic: every value is a slot the loop recorded or a sum of such slots
 * (the planned healthcare and long-term care are `plannedYear`'s, as in `toYearTable`), except the
 * taxable basis of a first-death year, which the `PathDetail` holds after the reset of seams C19 and
 * the sheets print before it; `basisBeforeReset` undoes the reset arithmetically.
 */

import type { PlanBucket, YearRow, YearTable } from "@meridian/shared";
import { IY, IY_REC } from "./flows.js";
import { AC, AC_REC, type PathDetail, SP, SP_REC, YR, YR_REC } from "./loop.js";
import type { PreparedRun } from "./prepare.js";
import { createPlannedYear, plannedYear } from "./strategies/index.js";
import { SO, SO_REC, TAX_OUT, TO, TY, TY_REC } from "./tax/layout.js";

/** The calculator's bucket order (`reference/independent/deterministic.ts` BUCKETS). */
export const CSV_BUCKETS: readonly PlanBucket[] = ["cash", "taxable", "pre_tax", "roth", "hsa"];
/** The simulated assets in the order of every `[stocks, bonds, bills]` triple. */
export const CSV_ASSETS = ["stocks", "bonds", "bills"] as const;

export type EngineCell =
  | { readonly kind: "money"; readonly dollars: number; readonly table?: bigint }
  | { readonly kind: "bp" | "year"; readonly value: number }
  | { readonly kind: "text"; readonly value: string }
  /** A price level: the engine's double and the table's nine-decimal string. */
  | { readonly kind: "cpi"; readonly value: number; readonly table: string };

export type EngineCsvRow = Readonly<Record<string, EngineCell>>;

/** The ages column as the sheets print it: "65 / 65", and "– / 74" for a person who has died. */
export function agesText(row: YearRow): string {
  return row.ages.map((age, i) => (row.alive[i] ? String(age) : "–")).join(" / ");
}

/** Year `t` ends with the first of two deaths (the survivor lives on into year t + 1). */
export function isFirstDeathYear(run: PreparedRun, detail: PathDetail, t: number): boolean {
  if (run.personCount !== 2) return false;
  const d0 = detail.deathIdx[0]!;
  const d1 = detail.deathIdx[1]!;
  return (d0 === t && d1 > t) || (d1 === t && d0 > t);
}

/**
 * The basis of taxable account `a`, asset `j`, at the end of year `t`, before the year-end reset of a
 * first death (seams C19). The detail holds `after = before + s × (value − before)`, with `s` the
 * run's share for the account (its own share for the decedent's account, the joint share for a
 * joint account, 0 for the survivor's), so `before = (after − s × value) ÷ (1 − s)`. In any other
 * year the detail's basis is returned. Throws for `s = 1`, where the reset leaves no trace of the
 * earlier basis.
 */
export function basisBeforeReset(run: PreparedRun, detail: PathDetail, t: number, a: number, j: number): number {
  const A = run.accountCount;
  const after = detail.endBasis[(t * A + a) * 3 + j]!;
  if (!isFirstDeathYear(run, detail, t)) return after;
  const decedent = detail.deathIdx[0] === t ? 0 : 1;
  const owner = detail.account[(t * A + a) * AC_REC + AC.OWNER]!;
  const share = owner === decedent ? run.ownStepUp : owner === -1 ? run.jointStepUp : 0;
  if (share === 0) return after;
  if (share >= 1) throw new RangeError("basisBeforeReset: a full step-up leaves no earlier basis");
  const value = detail.end[(t * A + a) * 3 + j]!;
  return (after - share * value) / (1 - share);
}

/**
 * The engine's path as CSV rows keyed like `r1.expected.csv` and `r2.expected.csv`: one per plan
 * year, with the account, person and bucket columns of the run's own input. `table` must be
 * `toYearTable(detail, run)`.
 */
export function engineCsvRows(run: PreparedRun, detail: PathDetail, table: YearTable): EngineCsvRow[] {
  const A = run.accountCount;
  const P = run.personCount;
  const input = run.input;
  const accounts = input.accounts;
  const people = input.household.people;
  const yr = (t: number, slot: number) => detail.year[t * YR_REC + slot]!;
  const sp = (t: number, slot: number) => detail.spending[t * SP_REC + slot]!;
  const ac = (t: number, a: number, slot: number) => detail.account[(t * A + a) * AC_REC + slot]!;
  const ty = (t: number, a: number, slot: number) => detail.yields[(t * A + a) * TY_REC + slot]!;
  const to = (t: number, slot: number) => detail.taxOut[t * TAX_OUT + slot]!;
  const endOf = (t: number, a: number) => {
    const o = (t * A + a) * 3;
    return detail.end[o]! + detail.end[o + 1]! + detail.end[o + 2]!;
  };
  const sumOver = (pick: (a: number) => boolean, value: (a: number) => number) => {
    let s = 0;
    for (let a = 0; a < A; a++) if (pick(a)) s += value(a);
    return s;
  };
  const py = createPlannedYear();
  const alive = new Uint8Array(P);
  const yearsToDeath = new Int16Array(P);

  const rows: EngineCsvRow[] = [];
  for (let t = 0; t < detail.rows; t++) {
    const row = table.rows[t]!;
    const cells: Record<string, EngineCell> = {};
    const money = (key: string, dollars: number, tableCents?: string) => {
      cells[key] = tableCents === undefined ? { kind: "money", dollars } : { kind: "money", dollars, table: BigInt(tableCents) };
    };
    const f = yr(t, YR.YEAR_FRACTION);
    const iy = (slot: number) => detail.income[t * IY_REC + slot]!;
    const so = (slot: number) => detail.socialSecurity[t * SO_REC + slot]!;
    const tax = row.tax;

    cells.year = { kind: "year", value: row.year };
    cells.ages = { kind: "text", value: agesText(row) };
    cells.filing = { kind: "text", value: row.filingStatus === "married_joint" ? "joint" : "single" };
    cells.cpi_start = { kind: "cpi", value: yr(t, YR.CPI_START), table: row.cpiStart };
    cells.cpi_end = { kind: "cpi", value: yr(t, YR.CPI_END), table: row.cpiEnd };

    // Income.
    people.forEach((p, i) => money(`ss_${p.id}`, so(SO.BENEFIT + i), row.income.socialSecurity[i]));
    money("pension", iy(IY.GUARANTEED), row.income.pensionAnnuity);
    money("wages", iy(IY.WAGES0) + iy(IY.WAGES1), row.income.wages);
    money("rental", iy(IY.RENTAL_CASH), row.income.rental);
    money("other_income", iy(IY.OTHER) - iy(IY.RENTAL_CASH), row.income.other);
    money("income_total", yr(t, YR.CASH_INCOME), row.income.total);
    money("employee_contributions", yr(t, YR.EMPLOYEE), row.contributions.employee);
    money("employer_contributions", yr(t, YR.EMPLOYER), row.contributions.employer);
    money("payroll_tax", yr(t, YR.PAYROLL), tax.payrollTaxCents);

    // Spending. The funded amount is allotted to healthcare, long-term care, goals, then core
    // (strategies-outputs-web §3.11 item 3), here in float64 before rounding.
    for (let i = 0; i < P; i++) {
      alive[i] = detail.alive[t * P + i]!;
      yearsToDeath[i] = detail.deathIdx[i]! - t;
    }
    plannedYear(run.strategies, t, yr(t, YR.CPI_START), alive, yearsToDeath, run.drawdownStart, yr(t, YR.PORTFOLIO_START), py);
    const drawdown = yr(t, YR.PHASE) === 1;
    const funded = sp(t, SP.FUNDED);
    const healthcare = Math.min(funded, drawdown ? py.healthcare * f : 0);
    const longTermCare = Math.min(funded - healthcare, drawdown ? py.longTermCare * f : 0);
    const goals = Math.min(funded - healthcare - longTermCare, sp(t, SP.LUMP));
    money("planned", sp(t, SP.PLANNED) * f, row.spending.planned);
    money("healthcare", healthcare, row.spending.healthcare);
    money("long_term_care", longTermCare, row.spending.longTermCare);
    money("goals", goals, row.spending.goals);
    money("floor", sp(t, SP.FLOOR_NEED), row.spending.floor);
    money("funded", funded, row.spending.funded);
    money("core", funded - healthcare - longTermCare - goals, row.spending.core);
    money("shortfall", sp(t, SP.SHORTFALL), row.spending.shortfall);
    money("surplus_saved", sp(t, SP.SURPLUS), row.surplusSaved);

    // Withdrawals: gross by account (RMDs included, conversions excluded), by bucket, RMDs.
    const gross = (a: number) => ac(t, a, AC.WITHDRAWAL) + ac(t, a, AC.RMD);
    accounts.forEach((acct, a) => money(`wd_${acct.id}`, gross(a), row.withdrawals.byAccount[a]));
    for (const b of CSV_BUCKETS) money(`wd_bucket_${b}`, sumOver((a) => accounts[a]!.bucket === b, gross), row.withdrawals.byBucket[b]);
    accounts.forEach((acct, a) => {
      if (acct.bucket === "pre_tax") money(`rmd_${acct.id}`, ac(t, a, AC.RMD), row.withdrawals.rmdByAccount[a]);
    });
    money("rmd_total", yr(t, YR.RMD_TOTAL), row.withdrawals.rmdTotal);
    money("wd_total", yr(t, YR.RMD_TOTAL) + yr(t, YR.WITHDRAWAL_TOTAL), row.withdrawals.total);
    money("conversions", yr(t, YR.CONVERSIONS), row.conversions);

    // Investment income.
    const all = () => true;
    money("realized_gains", sumOver(all, (a) => ac(t, a, AC.GAIN) + ty(t, a, TY.GAIN_DISTRIBUTIONS)), row.investment.realizedGains);
    money("dividends", sumOver(all, (a) => ty(t, a, TY.DIVIDENDS)), row.investment.dividends);
    money("qualified_dividends", sumOver(all, (a) => ty(t, a, TY.QUALIFIED_DIVIDENDS)));
    money("coupons", sumOver(all, (a) => ty(t, a, TY.INTEREST) + ty(t, a, TY.TAX_EXEMPT_INTEREST)), row.investment.coupons);
    money("interest_carried", yr(t, YR.INTEREST_CARRIED_IN));

    // Tax: the record call's output (`TO`).
    money("provisional_income", to(t, TO.PROVISIONAL));
    money("taxable_ss", to(t, TO.TAXABLE_SS), tax.taxableSocialSecurityCents);
    money("agi", to(t, TO.AGI), tax.agiCents);
    money("magi_irmaa", to(t, TO.MAGI_IRMAA), tax.magiIrmaaCents);
    money("magi_aca", to(t, TO.MAGI_ACA), tax.magiAcaCents);
    money("standard_deduction", to(t, TO.STD_DEDUCTION), tax.standardDeductionCents);
    money("senior_deduction", to(t, TO.SENIOR_DEDUCTION), tax.seniorDeductionCents);
    money("taxable_income", to(t, TO.TAXABLE_INCOME), tax.taxableIncomeCents);
    money("ordinary_taxable", to(t, TO.ORD_TAXABLE), tax.ordinaryTaxableCents);
    money("gains_at_0", to(t, TO.PREF_AT_0), tax.gainsAt0Cents);
    money("gains_at_15", to(t, TO.PREF_AT_15), tax.gainsAt15Cents);
    money("gains_at_20", to(t, TO.PREF_AT_20), tax.gainsAt20Cents);
    money("ordinary_tax", to(t, TO.ORD_TAX), tax.ordinaryTaxCents);
    money("capital_gains_tax", to(t, TO.CG_TAX), tax.capitalGainsTaxCents);
    money("income_tax", to(t, TO.INCOME_TAX), tax.incomeTaxCents);
    money("niit", to(t, TO.NIIT), tax.niitCents);
    money("penalty_10", to(t, TO.PEN10), tax.earlyPenaltyCents);
    money("penalty_20", to(t, TO.PEN20), tax.hsaPenaltyCents);
    money("total_federal_tax", to(t, TO.TOTAL), tax.totalFederalCents);
    money("capital_loss_carryover", to(t, TO.LOSS_CARRY_OUT), tax.capitalLossCarryoverCents);
    cells.bracket_rate_bp = { kind: "bp", value: tax.bracketRateBp };
    cells.next_gain_rate_bp = { kind: "bp", value: tax.nextGainRateBp };

    // Ending balances after returns, buckets, the taxable basis by asset (before a first death's reset).
    accounts.forEach((acct, a) => money(`end_${acct.id}`, endOf(t, a), row.ending.byAccount[a]));
    for (const b of CSV_BUCKETS) money(`end_bucket_${b}`, sumOver((a) => accounts[a]!.bucket === b, (a) => endOf(t, a)), row.ending.byBucket[b]);
    const reset = isFirstDeathYear(run, detail, t);
    accounts.forEach((acct, a) => {
      if (acct.bucket !== "taxable") return;
      let total = 0;
      CSV_ASSETS.forEach((asset, j) => {
        const basis = basisBeforeReset(run, detail, t, a, j);
        total += basis;
        money(`basis_${acct.id}_${asset}`, basis);
      });
      // The table's basis is after the reset, so it is the comparable figure only in other years.
      money(`basis_${acct.id}`, total, reset ? undefined : row.ending.basisByAccount[a]);
    });
    money("end_total", yr(t, YR.END_TOTAL), row.ending.total);
    money("end_total_real", yr(t, YR.END_TOTAL_REAL), row.ending.totalReal);
    const withdrawals = yr(t, YR.RMD_TOTAL) + yr(t, YR.WITHDRAWAL_TOTAL);
    const inflow = yr(t, YR.EMPLOYEE) + yr(t, YR.EMPLOYER) + sp(t, SP.SURPLUS);
    money("growth", yr(t, YR.END_TOTAL) - (yr(t, YR.PORTFOLIO_START) + inflow - withdrawals), row.growth);
    cells.withdrawal_rate_bp = { kind: "bp", value: row.strategy.withdrawalRateBp };
    cells.portfolio_return_bp = { kind: "bp", value: row.portfolioReturnBp };
    rows.push(cells);
  }
  return rows;
}
