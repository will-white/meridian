/**
 * `toYearTable(detail, run)` (strategies-outputs-web §3.11 with seams C37, C40, C43, C44, C45 and
 * C52): the engine's `PathDetail` of one path as the stored `YearTable` of shared `results.ts`.
 *
 * 1. Account columns keep the engine's order; each account's bucket, owner and name come from the
 *    input. By-bucket figures are sums of the accounts' cents (the buckets are `PlanBucket`, C45).
 * 2. `phase`: accumulation before the first drawdown year; then `transition` while someone living
 *    still works (`year(retirementMonth) > year`), else `retirement` (§3.3).
 * 3. Spending: `healthcare` (the part added to spending, C35), `longTermCare` and `goals` are
 *    recomputed with `plannedYear` from the row's year, alive flags, price level and death years;
 *    `planned` is the decision's planned core + healthcare + care for the period (goals are not
 *    part of it); `funded`, `floor` and `shortfall` are the engine's. The funded amount is allotted
 *    in the order healthcare, long-term care, goals, core, so in a year without shortfall
 *    `core = funded − healthcare − longTermCare − goals`. Before the first drawdown year only goals
 *    are spending (C52). `ruleGross` is the rule's withdrawal for the period in a gross year.
 * 4. Events: the rule flags (`ruleEvents`), then `topped_up` (a gross year in which more than the
 *    rule released, `wd = min(Σ available, max(0, gross × f + lump − Σ rmd))`, was withdrawn) and
 *    `rmd_excess` (a gross year with `Σ rmd > gross × f + lump`).
 * 5. Adding up: every total is the engine's own total rounded once (`units.ts`); when the rounded
 *    parts sum to something else, shared `addUp` gives the difference to the largest part. Applied
 *    to income, withdrawals and RMDs by account, the taxes (`taxYearDetail`) and the ending
 *    balances by account; by-bucket sums are taken after it.
 * 6. `growth` is the plug of the roll-forward in cents: `ending total − (previous ending total +
 *    contributions + surplus saved − withdrawals)`, the starting total for the first row.
 *    Conversions move money between accounts and do not enter it.
 * 7. Ratios from float64, rounded half away from zero to whole basis points (C44):
 *    `withdrawalRateBp = (withdrawals − surplus saved) ÷ portfolio at the start` (0 when the start
 *    is 0), `portfolioReturnBp = growth ÷ (ending total − growth)` (0 when that is 0), `inflationBp`
 *    the period's inflation, and in a drawdown year `essentialCoverageBp = min(20000, (Social
 *    Security + pensions and annuities) ÷ (essential core + healthcare))`, absent when the
 *    denominator is 0 (or before the first drawdown year, when no spending is modelled).
 *
 * Money in a row is nominal; price levels are nine-decimal strings (C43) and `ending.totalReal` is
 * the engine's own figure, so the last row ends at the path's stored ending wealth. The taxable
 * basis of a death year is after the year-end reset of seams C19 (the basis carried into the next
 * year).
 */

import { type ByBucket, type PlanBucket, type StrategyEvent, type YearRow, type YearTable, addUp } from "@meridian/shared";
import { CASH_TOL } from "../constants.js";
import { IY, IY_REC } from "../flows.js";
import { AC, AC_REC, type PathDetail, SP, SP_REC, YEAR_FLAG, YR, YR_REC } from "../loop.js";
import type { PreparedRun } from "../prepare.js";
import { createPlannedYear, plannedYear, ruleEvents } from "../strategies/index.js";
import { taxYearDetail } from "../tax/federalTax.js";
import { SO, SO_REC, TAX_IN, TAX_OUT, TY, TY_REC } from "../tax/layout.js";
import { socialSecurityParts } from "../tax/socialSecurity.js";
import { dollarsToCentsBigInt, priceLevelString, ratioToBp, ratioToPpm } from "../units.js";

const cents = dollarsToCentsBigInt;
const str = (c: bigint) => c.toString();
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** The guaranteed-income diagnostic: `min(20000, guaranteed ÷ essentials)` in basis points; undefined when `essentials` is not above 0. */
export function essentialCoverageBp(guaranteed: number, essentials: number): number | undefined {
  if (!(essentials > 0)) return undefined;
  const bp = ratioToBp(guaranteed / essentials);
  return bp > 20_000 ? 20_000 : bp;
}

/** `(withdrawals − surplus saved) ÷ portfolio at the start`, whole basis points; 0 when the start is 0. */
export function withdrawalRateBp(withdrawals: number, surplusSaved: number, portfolioStart: number): number {
  return portfolioStart > 0 ? ratioToBp((withdrawals - surplusSaved) / portfolioStart) : 0;
}

/** `growth ÷ (ending total − growth)`, whole basis points; 0 when the denominator is 0. */
export function portfolioReturnBp(growth: number, endTotal: number): number {
  const base = endTotal - growth;
  return base !== 0 ? ratioToBp(growth / base) : 0;
}

function byBucketOf(parts: readonly bigint[], buckets: readonly PlanBucket[]): ByBucket {
  const sums: Record<PlanBucket, bigint> = { taxable: 0n, pre_tax: 0n, roth: 0n, hsa: 0n, cash: 0n };
  parts.forEach((c, a) => {
    sums[buckets[a]!] += c;
  });
  return { taxable: str(sums.taxable), pre_tax: str(sums.pre_tax), roth: str(sums.roth), hsa: str(sums.hsa), cash: str(sums.cash) };
}

/** The stored year table of one path (`sim_run_path.year_table`). `detail` must come from `run`. */
export function toYearTable(detail: PathDetail, run: PreparedRun): YearTable {
  const A = run.accountCount;
  const P = run.personCount;
  if (detail.accounts !== A || detail.people !== P || detail.years !== run.years) {
    throw new RangeError("toYearTable: the path detail belongs to another run");
  }
  if (detail.rows < 1) throw new RangeError("toYearTable: the path detail holds no year");
  const input = run.input;
  const buckets = input.accounts.map((a) => a.bucket);
  const accounts = input.accounts.map((a) => ({ id: a.id, name: a.name, bucket: a.bucket, owner: a.owner }));
  const yr = (t: number, slot: number) => detail.year[t * YR_REC + slot]!;
  const sp = (t: number, slot: number) => detail.spending[t * SP_REC + slot]!;
  const ac = (t: number, a: number, slot: number) => detail.account[(t * A + a) * AC_REC + slot]!;
  const triple = (arr: Float64Array, t: number, a: number) => {
    const o = (t * A + a) * 3;
    return arr[o]! + arr[o + 1]! + arr[o + 2]!;
  };
  const py = createPlannedYear();
  const alive = new Uint8Array(P);
  const yearsToDeath = new Int16Array(P);

  const startingTotal = cents(yr(0, YR.PORTFOLIO_START));
  let previousEnd = startingTotal;
  const rows: YearRow[] = [];
  for (let t = 0; t < detail.rows; t++) {
    const year = run.startYear + t;
    const f = yr(t, YR.YEAR_FRACTION);
    const drawdown = yr(t, YR.PHASE) === 1;
    const flags = yr(t, YR.FLAGS);
    for (let i = 0; i < P; i++) {
      alive[i] = detail.alive[t * P + i]!;
      yearsToDeath[i] = detail.deathIdx[i]! - t;
    }
    let phase: YearRow["phase"] = "accumulation";
    if (drawdown) {
      phase = "retirement";
      for (let i = 0; i < P; i++) if (alive[i] === 1 && t < run.retiredFrom[i]!) phase = "transition";
    }

    // Income (the period's): wages, each person's benefit, pensions and annuities, rental, other.
    const iy = detail.income.subarray(t * IY_REC, (t + 1) * IY_REC);
    const so = detail.socialSecurity.subarray(t * SO_REC, (t + 1) * SO_REC);
    const ssDollars: number[] = [];
    for (let i = 0; i < P; i++) ssDollars.push(so[SO.BENEFIT + i]!);
    const incomeTotal = cents(yr(t, YR.CASH_INCOME));
    const incomeParts = addUp(incomeTotal, [
      cents(iy[IY.WAGES0]! + iy[IY.WAGES1]!),
      ...ssDollars.map((x) => cents(x)),
      cents(iy[IY.GUARANTEED]!),
      cents(iy[IY.RENTAL_CASH]!),
      cents(iy[IY.OTHER]! - iy[IY.RENTAL_CASH]!),
    ]);
    const income: YearRow["income"] = {
      wages: str(incomeParts[0]!),
      socialSecurity: incomeParts.slice(1, 1 + P).map(str),
      socialSecurityParts: ssDollars.map((_, i) => socialSecurityParts(so, i as 0 | 1)),
      pensionAnnuity: str(incomeParts[1 + P]!),
      rental: str(incomeParts[2 + P]!),
      other: str(incomeParts[3 + P]!),
      total: str(incomeTotal),
    };
    const employee = cents(yr(t, YR.EMPLOYEE));
    const employer = cents(yr(t, YR.EMPLOYER));

    // Spending.
    const portfolioStart = yr(t, YR.PORTFOLIO_START);
    plannedYear(run.strategies, t, yr(t, YR.CPI_START), alive, yearsToDeath, run.drawdownStart, portfolioStart, py);
    const healthcare = drawdown ? py.healthcare * f : 0;
    const longTermCare = drawdown ? py.longTermCare * f : 0;
    const lump = sp(t, SP.LUMP);
    const funded = cents(sp(t, SP.FUNDED));
    const healthcareFunded = min(funded, cents(healthcare));
    let rest = funded - healthcareFunded;
    const careFunded = min(rest, cents(longTermCare));
    rest -= careFunded;
    const goalsFunded = min(rest, cents(lump));
    rest -= goalsFunded;
    const gross = sp(t, SP.GROSS);
    const spending: YearRow["spending"] = {
      planned: str(cents(sp(t, SP.PLANNED) * f)),
      funded: str(funded),
      core: str(rest),
      healthcare: str(healthcareFunded),
      longTermCare: str(careFunded),
      goals: str(goalsFunded),
      floor: str(cents(sp(t, SP.FLOOR_NEED))),
      shortfall: str(cents(sp(t, SP.SHORTFALL))),
    };
    if (!Number.isNaN(gross)) spending.ruleGross = str(cents(gross * f));

    // Withdrawals (gross: RMDs included, conversions excluded) and RMDs, by account.
    const rmdTotal = yr(t, YR.RMD_TOTAL);
    const withdrawn = yr(t, YR.WITHDRAWAL_TOTAL);
    const withdrawalTotal = cents(rmdTotal + withdrawn);
    const rmdTotalCents = cents(rmdTotal);
    const byAccount: bigint[] = [];
    const rmdByAccount: bigint[] = [];
    let availableTotal = 0;
    let gains = 0;
    let dividends = 0;
    let coupons = 0;
    for (let a = 0; a < A; a++) {
      byAccount.push(cents(ac(t, a, AC.WITHDRAWAL) + ac(t, a, AC.RMD)));
      rmdByAccount.push(cents(ac(t, a, AC.RMD)));
      availableTotal += ac(t, a, AC.AVAILABLE);
      const yo = (t * A + a) * TY_REC;
      gains += ac(t, a, AC.GAIN) + detail.yields[yo + TY.GAIN_DISTRIBUTIONS]!;
      dividends += detail.yields[yo + TY.DIVIDENDS]!;
      coupons += detail.yields[yo + TY.INTEREST]! + detail.yields[yo + TY.TAX_EXEMPT_INTEREST]!;
    }
    const withdrawalsByAccount = addUp(withdrawalTotal, byAccount);

    // Events (§3.11 item 4).
    const events: StrategyEvent[] = ruleEvents(sp(t, SP.RULE));
    if (!Number.isNaN(gross)) {
      const released = gross * f + lump;
      const left = released - rmdTotal;
      const wd = left > 0 ? (left < availableTotal ? left : availableTotal) : 0;
      if (withdrawn > wd + CASH_TOL) events.push("topped_up");
      if (rmdTotal > released) events.push("rmd_excess");
    }

    // Ending balances, the roll-forward and the ratios.
    const endTotalDollars = yr(t, YR.END_TOTAL);
    const endTotal = cents(endTotalDollars);
    const endByAccount: bigint[] = [];
    const basisByAccount: string[] = [];
    for (let a = 0; a < A; a++) {
      endByAccount.push(cents(triple(detail.end, t, a)));
      basisByAccount.push(str(cents(triple(detail.endBasis, t, a))));
    }
    const endingByAccount = addUp(endTotal, endByAccount);
    const surplus = sp(t, SP.SURPLUS);
    const surplusCents = cents(surplus);
    const growth = endTotal - (previousEnd + employee + employer + surplusCents - withdrawalTotal);
    previousEnd = endTotal;
    const growthDollars = endTotalDollars - (portfolioStart + yr(t, YR.EMPLOYEE) + yr(t, YR.EMPLOYER) + surplus - (rmdTotal + withdrawn));

    const strategy: YearRow["strategy"] = { events, withdrawalRateBp: withdrawalRateBp(rmdTotal + withdrawn, surplus, portfolioStart) };
    if (drawdown) {
      let guaranteed = iy[IY.GUARANTEED]!;
      for (const x of ssDollars) guaranteed += x;
      const coverage = essentialCoverageBp(guaranteed, (py.essentialCore + py.healthcare) * f);
      if (coverage !== undefined) strategy.essentialCoverageBp = coverage;
    }

    const status = yr(t, YR.FILING_STATUS) === 1 ? 1 : 0;
    const tax = taxYearDetail(
      detail.taxIn.subarray(t * TAX_IN, (t + 1) * TAX_IN),
      detail.taxOut.subarray(t * TAX_OUT, (t + 1) * TAX_OUT),
      status,
      yr(t, YR.PAYROLL),
    );

    rows.push({
      year,
      yearFractionPpm: ratioToPpm(f),
      ages: Array.from(detail.age.subarray(t * P, (t + 1) * P)),
      alive: Array.from(alive, (x) => x === 1),
      phase,
      filingStatus: status === 1 ? "married_joint" : "single",
      cpiStart: priceLevelString(yr(t, YR.CPI_START)),
      cpiEnd: priceLevelString(yr(t, YR.CPI_END)),
      inflationBp: ratioToBp(detail.priceFactor[t]! - 1),
      portfolioReturnBp: portfolioReturnBp(growthDollars, endTotalDollars),
      income,
      contributions: { employee: str(employee), employer: str(employer) },
      spending,
      strategy,
      withdrawals: {
        byAccount: withdrawalsByAccount.map(str),
        byBucket: byBucketOf(withdrawalsByAccount, buckets),
        total: str(withdrawalTotal),
        rmdByAccount: addUp(rmdTotalCents, rmdByAccount).map(str),
        rmdTotal: str(rmdTotalCents),
      },
      conversions: str(cents(yr(t, YR.CONVERSIONS))),
      investment: { realizedGains: str(cents(gains)), dividends: str(cents(dividends)), coupons: str(cents(coupons)) },
      tax,
      surplusSaved: str(surplusCents),
      growth: str(growth),
      ending: {
        byAccount: endingByAccount.map(str),
        basisByAccount,
        byBucket: byBucketOf(endingByAccount, buckets),
        total: str(endTotal),
        totalReal: str(cents(yr(t, YR.END_TOTAL_REAL))),
      },
      failed: (flags & YEAR_FLAG.FAILED) !== 0,
    });
  }

  const table: YearTable = {
    schemaVersion: 1,
    pathIndex: detail.pathIndex,
    deathYears: Array.from(detail.deathIdx, (d) => run.startYear + d),
    accounts,
    startingTotal: str(startingTotal),
    rows,
  };
  if (detail.cohortStartYear >= 0) table.historicalStartYear = detail.cohortStartYear;
  return table;
}

