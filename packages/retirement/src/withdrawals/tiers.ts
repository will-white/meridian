/**
 * The default withdrawal order's tiers (strategies-outputs-web §2.4, §3.5, decisions 18 to 20;
 * seams C33, C34, C35). After the engine has taken the RMDs and the scheduled conversions,
 * `available[a]` is what each account can still give; the year's withdrawals are taken through nine
 * tiers in order:
 *
 * | Tier | Source | Cap |
 * | --- | --- | --- |
 * | 1 | cash accounts, above the reserve | `max(0, Σ cash − cashReserve × cpi)` |
 * | 2 | HSAs of living owners, for the year's healthcare | `min(Σ HSA, healthcare × f)` |
 * | 3 | taxable accounts | their balances |
 * | 4 | pre-tax accounts whose penalty share is 0 (C33) | their balances |
 * | 5 | Roth, the free part (C34) | per person `min(Σ own Roth, rothFree[i])` |
 * | 6 | the cash reserve | the rest of the cash |
 * | 7 | pre-tax accounts whose penalty share is above 0 | their balances |
 * | 8 | Roth beyond the free part | the rest of each person's Roth |
 * | 9 | HSA beyond the year's healthcare | the rest of the HSAs |
 *
 * C33: an account's tier follows the tax area's penalty share, not an age: a pre-tax account with
 * `preTaxPenaltyShare[a] = 0` (59½ before the period, or a 401(k) after separating at 55) is in
 * tier 4, one with a share above 0 (a whole or partial early year) in tier 7, where `assess` charges
 * the partial additional tax. The Roth's free part is the tax area's `rothFreeAmount` (C34, the
 * view's `rothFree[i]`): the basis, plus the conversion layers when the early share is 0, plus the
 * earnings once the five-year clock is met as well; whatever is not free (earnings before the clock,
 * or the conversions and earnings of an early owner) is tier 8 for every owner. An HSA's tier does
 * not depend on its owner's age: up to the year's qualified medical spending it is tier 2 (never
 * taxed), beyond it tier 9, where `assess` adds the 20% for the share of the period before 65.
 * C35: the healthcare cap is `SpendDecision.healthcare`, the entered amount whether or not it is
 * included in base spending.
 *
 * Within a tier each account's cap is its share of the tier's cap in proportion to its `available`
 * (tiers 1 and 6 split each cash account in the same proportion, tiers 2 and 9 each HSA, tiers 5 and
 * 8 each Roth account of a person), so the accounts of a tier are drawn pro rata to what each can
 * still supply (decision 19). `fill(x)` takes `x` dollars through the tiers in order: the tiers
 * before the one `x` ends in are taken whole, that one in proportion to its accounts' caps. It is
 * continuous and non-decreasing in every account, which is all the solver needs; a v2 policy
 * supplies another `buildTiers`.
 *
 * Nothing here allocates outside `createWithdrawalTiers`, and no double crosses a call: the amount
 * `fillTiers` takes is the record's `amount` field (engine-and-returns §4.3).
 */

import { TREATMENT } from "../prepare.js";
import type { SpendDecision } from "../strategies/types.js";

/** Tier indices, in the order of the table above (index = tier number − 1). */
export const TIER = {
  CASH: 0,
  HSA_MEDICAL: 1,
  TAXABLE: 2,
  PRE_TAX: 3,
  ROTH_FREE: 4,
  CASH_RESERVE: 5,
  PRE_TAX_EARLY: 6,
  ROTH_REST: 7,
  HSA_REST: 8,
} as const;
export const TIER_COUNT = 9;

/** What `buildTiers` reads of the loop's `YearView` (a structural subset, so a test can pass a hand-made view). */
export interface TierView {
  readonly accountCount: number;
  /** Per account: `TREATMENT` index and owner (0, 1, −1 joint). */
  readonly treatment: ArrayLike<number>;
  readonly owner: ArrayLike<number>;
  /** Per account: what is left after the RMDs and conversions (dollars, the period's). */
  readonly available: ArrayLike<number>;
  /** Per account: the share of a pre-tax withdrawal that carries the 10% additional tax (seams C33). */
  readonly preTaxPenaltyShare: ArrayLike<number>;
  /** Per person: what can leave the person's Roth accounts with no tax and no penalty (seams C34). */
  readonly rothFree: ArrayLike<number>;
  /** Per person: alive this year. */
  readonly alive: ArrayLike<number>;
  /** Price level at the start of the year (today = 1) and the year fraction f. */
  readonly cpi: number;
  readonly yearFraction: number;
  /** The cash reserve in today's dollars (`StrategyTables.cashReserve`). */
  readonly strategies: { readonly cashReserve: number };
}

/** The year's tiers, rebuilt every year into arrays allocated once per thread. Money is dollars. */
export interface WithdrawalTiers {
  readonly accountCount: number;
  /** The cap of each tier (`TIER_COUNT`): the sum of its accounts' caps. */
  readonly cap: Float64Array;
  /** The cap of account `a` in tier `k`, at `k × accountCount + a`. */
  readonly accountCap: Float64Array;
  /** Σ `cap`: everything the order can take this year (= Σ `available`). */
  total: number;
  /** The amount `fillTiers` takes through the order. */
  amount: number;
}

export function createWithdrawalTiers(accountCount: number): WithdrawalTiers {
  return {
    accountCount,
    cap: new Float64Array(TIER_COUNT),
    accountCap: new Float64Array(TIER_COUNT * accountCount),
    total: 0,
    amount: 0,
  };
}

const CASH = TREATMENT.cash;
const HSA = TREATMENT.hsa;
const TAXABLE = TREATMENT.taxable;
const PRE_TAX = TREATMENT.pre_tax;
const ROTH = TREATMENT.roth;

/**
 * Builds the year's tiers from the view and the spending decision (its `healthcare`, the HSA's
 * qualified cap, is a full-year amount and is multiplied by f here, as `assess` does). An account
 * with nothing available is in no tier.
 */
export function buildTiers(view: TierView, decision: Readonly<SpendDecision>, tiers: WithdrawalTiers): void {
  const A = view.accountCount;
  const cap = tiers.cap;
  const ac = tiers.accountCap;
  for (let k = 0; k < TIER_COUNT; k++) cap[k] = 0;
  for (let k = 0; k < TIER_COUNT * A; k++) ac[k] = 0;
  const available = view.available;
  const treatment = view.treatment;
  const owner = view.owner;
  const alive = view.alive;

  // The sums the shared tiers are split by.
  let cash = 0;
  let hsa = 0;
  let roth0 = 0;
  let roth1 = 0;
  for (let a = 0; a < A; a++) {
    const x = available[a]!;
    if (!(x > 0)) continue;
    const tr = treatment[a]!;
    if (tr === CASH) cash += x;
    else if (tr === HSA) {
      if (alive[owner[a]!] === 1) hsa += x;
    } else if (tr === ROTH) {
      if (owner[a] === 0) roth0 += x;
      else if (owner[a] === 1) roth1 += x;
    }
  }
  const reserve = view.strategies.cashReserve * view.cpi;
  const cashFree = cash > reserve ? cash - reserve : 0;
  const medical = decision.healthcare * view.yearFraction;
  const hsaMedical = medical > 0 ? (hsa < medical ? hsa : medical) : 0;
  const rothFree = view.rothFree;
  const f0 = roth0 > 0 ? rothFree[0]! : 0;
  const free0 = f0 > 0 ? (f0 < roth0 ? f0 : roth0) : 0;
  const f1 = roth1 > 0 ? rothFree[1]! : 0;
  const free1 = f1 > 0 ? (f1 < roth1 ? f1 : roth1) : 0;

  for (let a = 0; a < A; a++) {
    const x = available[a]!;
    if (!(x > 0)) continue;
    const tr = treatment[a]!;
    if (tr === CASH) {
      let c = (cashFree * x) / cash;
      if (c > x) c = x;
      ac[TIER.CASH * A + a] = c;
      ac[TIER.CASH_RESERVE * A + a] = x - c;
    } else if (tr === HSA) {
      let c = 0;
      if (alive[owner[a]!] === 1) {
        c = (hsaMedical * x) / hsa;
        if (c > x) c = x;
      }
      ac[TIER.HSA_MEDICAL * A + a] = c;
      ac[TIER.HSA_REST * A + a] = x - c;
    } else if (tr === TAXABLE) {
      ac[TIER.TAXABLE * A + a] = x;
    } else if (tr === PRE_TAX) {
      ac[(view.preTaxPenaltyShare[a]! > 0 ? TIER.PRE_TAX_EARLY : TIER.PRE_TAX) * A + a] = x;
    } else if (tr === ROTH) {
      const o = owner[a];
      let c = o === 0 ? (free0 * x) / roth0 : o === 1 ? (free1 * x) / roth1 : 0;
      if (c > x) c = x;
      ac[TIER.ROTH_FREE * A + a] = c;
      ac[TIER.ROTH_REST * A + a] = x - c;
    }
  }

  let total = 0;
  for (let k = 0; k < TIER_COUNT; k++) {
    let s = 0;
    for (let a = 0; a < A; a++) s += ac[k * A + a]!;
    cap[k] = s;
    total += s;
  }
  tiers.total = total;
}

/**
 * `fill(x)` with the amount in `tiers.amount`: writes every `w[a]` (dollars). Tiers are taken whole
 * while the amount lasts; the tier it ends in gives each of its accounts `accountCap × rest / cap`.
 * An amount at or above `total` takes everything; at or below 0 nothing.
 */
export function fillTiers(tiers: WithdrawalTiers, w: Float64Array): void {
  const A = tiers.accountCount;
  const cap = tiers.cap;
  const ac = tiers.accountCap;
  for (let a = 0; a < A; a++) w[a] = 0;
  let left = tiers.amount;
  for (let k = 0; k < TIER_COUNT && left > 0; k++) {
    const c = cap[k]!;
    if (!(c > 0)) continue;
    const o = k * A;
    if (left >= c) {
      for (let a = 0; a < A; a++) w[a] = w[a]! + ac[o + a]!;
      left -= c;
    } else {
      const share = left / c;
      for (let a = 0; a < A; a++) w[a] = w[a]! + ac[o + a]! * share;
      left = 0;
    }
  }
}

/** `fill(x, w)`: `x` dollars through the tiers in order (sets `tiers.amount`). */
export function fill(tiers: WithdrawalTiers, x: number, w: Float64Array): void {
  tiers.amount = x;
  fillTiers(tiers, w);
}
