/**
 * The Roth ordering state per person and its functions (tax-rmd-ss §3.7.3, decision 25; seams C32,
 * C34).
 *
 * One `RB` record (layout.ts) per person covers all of that person's Roth accounts together, as
 * Publication 590-B's "Ordering Rules for Distributions" do: regular contributions and conversions
 * older than five tax years (`BASIS_FREE`), then the conversions of the last five tax years oldest
 * first (`CONV0` made four tax years ago … `CONV4` this year), then earnings. `FIRST_YEAR` is the
 * five-year clock: the first tax year any Roth of the person was funded (0 = none yet). Earnings
 * are tax-free only in a qualified distribution, after 59½ and once the clock is met.
 *
 * Every function is pure apart from the record it is given, allocates nothing and never throws on
 * finite inputs. A gross-up preview runs `rothWithdraw` on a scratch copy of the record.
 *
 * The year loop calls the `…From` / `…Into` forms, which read their amounts from arrays and write
 * a result into an array instead of taking or returning a double: V8 boxes a double that crosses a
 * call it does not inline (engine-and-returns §3.15's zero-allocation budget). The scalar forms
 * (`seedRoth`, `rothWithdraw`, …) are the same functions on a one-slot scratch, for previews and
 * tests.
 */

import { RB, RW } from "./layout.js";

/** Years after `FIRST_YEAR` from which earnings can be qualified (the five-taxable-year period). */
const FIVE_YEARS = 5;

/** Scratch of the scalar forms: the amount (or balance) and the early fraction. */
const AMOUNT = new Float64Array(1);
const EARLY = new Float64Array(1);

/**
 * Seeds a person's record at the plan start (§3.7.3): `BASIS_FREE` is the sum of the contribution
 * basis entered on the person's Roth accounts (an absent value counts 0; the caller keeps the
 * person's `basisUnknown` flag), the five layers are 0, and `FIRST_YEAR = startYear − 5` when the
 * person has a Roth account that is not synthetic and has a balance (the clock is assumed already
 * met for an existing account, §8.2 `roth_history`), else 0.
 */
export function seedRoth(st: Float64Array, off: number, basisFree: number, fundedAccount: boolean, startYear: number): void {
  AMOUNT[0] = basisFree;
  seedRothFrom(st, off, AMOUNT, 0, fundedAccount, startYear);
}

/** `seedRoth` with the basis read from `basis[at]` (the loop's form: `PreparedRun.rothBasis0`). */
export function seedRothFrom(st: Float64Array, off: number, basis: Float64Array, at: number, fundedAccount: boolean, startYear: number): void {
  const basisFree = basis[at]!;
  st[off + RB.BASIS_FREE] = basisFree > 0 ? basisFree : 0;
  for (let k = RB.CONV0; k <= RB.CONV4; k++) st[off + k] = 0;
  st[off + RB.FIRST_YEAR] = fundedAccount ? startYear - FIVE_YEARS : 0;
  st[off + RB.RESERVED0] = 0;
}

/**
 * The start of every plan year after the first: the oldest layer joins `BASIS_FREE`, the others
 * shift down by one and `CONV4` empties. A conversion made in year Y therefore joins `BASIS_FREE`
 * on 1 January of Y + 5.
 */
export function rothRollYear(st: Float64Array, off: number): void {
  st[off + RB.BASIS_FREE] = (st[off + RB.BASIS_FREE] as number) + (st[off + RB.CONV0] as number);
  for (let k = RB.CONV0; k < RB.CONV4; k++) st[off + k] = st[off + k + 1] as number;
  st[off + RB.CONV4] = 0;
}

function startClock(st: Float64Array, off: number, year: number): void {
  if (st[off + RB.FIRST_YEAR] === 0) st[off + RB.FIRST_YEAR] = year;
}

/** A regular contribution in `year`: `BASIS_FREE += amount`; the first funding starts the clock. */
export function addRothContribution(st: Float64Array, off: number, amount: number, year: number): void {
  AMOUNT[0] = amount;
  addRothContributionFrom(st, off, AMOUNT, 0, year);
}

/** `addRothContribution` of `amounts[at]`. */
export function addRothContributionFrom(st: Float64Array, off: number, amounts: Float64Array, at: number, year: number): void {
  const amount = amounts[at]!;
  if (!(amount > 0)) return;
  st[off + RB.BASIS_FREE] = (st[off + RB.BASIS_FREE] as number) + amount;
  startClock(st, off, year);
}

/** A conversion in `year`: `CONV4 += amount`; the first funding starts the clock. */
export function addRothConversion(st: Float64Array, off: number, amount: number, year: number): void {
  AMOUNT[0] = amount;
  addRothConversionFrom(st, off, AMOUNT, 0, year);
}

/** `addRothConversion` of `amounts[at]`. */
export function addRothConversionFrom(st: Float64Array, off: number, amounts: Float64Array, at: number, year: number): void {
  const amount = amounts[at]!;
  if (!(amount > 0)) return;
  st[off + RB.CONV4] = (st[off + RB.CONV4] as number) + amount;
  startClock(st, off, year);
}

/** True when a distribution in `year` is after the five-year period: `FIRST_YEAR > 0 && year ≥ FIRST_YEAR + 5`. */
export function rothFiveYearMet(st: Float64Array, off: number, year: number): boolean {
  const first = st[off + RB.FIRST_YEAR] as number;
  return first > 0 && year >= first + FIVE_YEARS;
}

/**
 * A Roth withdrawal of `amount` in `year` by a person whose early fraction (before 59½) is
 * `earlyFrac`. Takes the amount from `BASIS_FREE`, then from the layers oldest first, then from
 * earnings, and subtracts what it takes from the record. Writes `out` (layout `RW`):
 * `TAXABLE = fromEarnings × (fiveYearMet ? earlyFrac : 1)` to `TI.ROTH_TAXABLE`,
 * `PENALTY_BASE = (fromConversions + fromEarnings) × earlyFrac` to `TI.PEN10_BASE`, and the three
 * parts. The caller keeps `amount` within the person's Roth balance.
 */
export function rothWithdraw(st: Float64Array, off: number, amount: number, earlyFrac: number, year: number, out: Float64Array): void {
  AMOUNT[0] = amount;
  EARLY[0] = earlyFrac;
  rothWithdrawFrom(st, off, AMOUNT, EARLY, 0, year, out);
}

/**
 * `rothWithdraw` of `amounts[at]` with the early fraction `early[at]` (the loop's form, through
 * `TAX_FUNCTIONS.rothWithdraw`: the person's withdrawal and early fraction, at the person's index).
 */
export function rothWithdrawFrom(st: Float64Array, off: number, amounts: Float64Array, early: Float64Array, at: number, year: number, out: Float64Array): void {
  const amount = amounts[at]!;
  const earlyFrac = early[at]!;
  let remaining = amount > 0 ? amount : 0;
  const basis = st[off + RB.BASIS_FREE] as number;
  const fromBasis = basis > 0 ? (remaining < basis ? remaining : basis) : 0;
  st[off + RB.BASIS_FREE] = basis - fromBasis;
  remaining -= fromBasis;
  let fromConversions = 0;
  for (let k = RB.CONV0; k <= RB.CONV4 && remaining > 0; k++) {
    const layer = st[off + k] as number;
    if (!(layer > 0)) continue;
    const take = remaining < layer ? remaining : layer;
    st[off + k] = layer - take;
    remaining -= take;
    fromConversions += take;
  }
  const fromEarnings = remaining;
  out[RW.TAXABLE] = fromEarnings * (rothFiveYearMet(st, off, year) ? earlyFrac : 1);
  out[RW.PENALTY_BASE] = (fromConversions + fromEarnings) * earlyFrac;
  out[RW.FROM_BASIS] = fromBasis;
  out[RW.FROM_CONVERSIONS] = fromConversions;
  out[RW.FROM_EARNINGS] = fromEarnings;
}

/**
 * What the person can take from Roth accounts holding `balance` in `year` with no tax and no
 * additional tax (seams C34; the `rothFree[i]` of the withdrawal order's tier 5): `BASIS_FREE`,
 * plus the conversion layers when `earlyFrac = 0`, plus the earnings when `earlyFrac = 0` and the
 * clock is met; never more than the balance. Withdrawing exactly this amount with `rothWithdraw`
 * gives `TAXABLE = PENALTY_BASE = 0`.
 */
export function rothFreeAmount(st: Float64Array, off: number, balance: number, earlyFrac: number, year: number): number {
  AMOUNT[0] = balance;
  EARLY[0] = earlyFrac;
  rothFreeAmountInto(st, off, AMOUNT, EARLY, 0, year, AMOUNT);
  return AMOUNT[0]!;
}

/**
 * `rothFreeAmount` of the balance `balances[at]` with the early fraction `early[at]`, written to
 * `out[at]` (the loop's form, through `TAX_FUNCTIONS.rothFreeAmount`; `out` may be `balances`).
 */
export function rothFreeAmountInto(st: Float64Array, off: number, balances: Float64Array, early: Float64Array, at: number, year: number, out: Float64Array): void {
  const balance = balances[at]!;
  const earlyFrac = early[at]!;
  const total = balance > 0 ? balance : 0;
  const basis = st[off + RB.BASIS_FREE] as number;
  let free = basis > 0 ? basis : 0;
  if (earlyFrac <= 0) {
    if (rothFiveYearMet(st, off, year)) {
      out[at] = total;
      return;
    }
    for (let k = RB.CONV0; k <= RB.CONV4; k++) {
      const layer = st[off + k] as number;
      if (layer > 0) free += layer;
    }
  }
  out[at] = free < total ? free : total;
}

/**
 * At a death the survivor's record absorbs the decedent's (decision 24, the spousal rollover): the
 * basis and each layer are added (both people's layers are aligned by tax year), and `FIRST_YEAR`
 * becomes the smaller non-zero one. The decedent's record is then emptied so nothing is counted
 * twice.
 */
export function mergeRothAtDeath(st: Float64Array, survivorOff: number, deceasedOff: number): void {
  for (let k = RB.BASIS_FREE; k <= RB.CONV4; k++) {
    st[survivorOff + k] = (st[survivorOff + k] as number) + (st[deceasedOff + k] as number);
    st[deceasedOff + k] = 0;
  }
  const s = st[survivorOff + RB.FIRST_YEAR] as number;
  const d = st[deceasedOff + RB.FIRST_YEAR] as number;
  st[survivorOff + RB.FIRST_YEAR] = s > 0 && d > 0 ? (s < d ? s : d) : s > 0 ? s : d;
  st[deceasedOff + RB.FIRST_YEAR] = 0;
}
