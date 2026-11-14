/**
 * Trades: the year's flows and the rebalance in one trade list per account (engine-and-returns
 * decision 12 and §3.8; seams C17 item 1; plan decision 8).
 *
 * An account holds three simulated assets (stocks, bonds, bills; `STOCKS`, `BONDS`, `BILLS`) at
 * offsets `off .. off + 2` of the path's `bal` and `basis` arrays. Basis is average cost per account
 * and asset and is kept for taxable accounts only (0 elsewhere). `netOut > 0` is money leaving the
 * account (withdrawal + RMD + conversion out − deposits − conversion in), `netOut < 0` money coming
 * in. With `V` the account's value and `V' = V − netOut` the value after the flow, the trade that
 * leaves the account on its target weights `w_j` is `Δ_j = bal_j − w_j · V'` (Σ Δ_j = netOut):
 *
 * - `full`, and every account that is not taxable: `sell_j = max(Δ_j, 0)`, `buy_j = max(−Δ_j, 0)`;
 * - `flows_only` (taxable accounts only): no sale beyond what the flow needs. For `netOut > 0`,
 *   `sell_j = max(Δ_j, 0) · netOut / P` with `P = Σ max(Δ, 0)`, nothing bought; for `netOut < 0`,
 *   `buy_j = max(−Δ_j, 0) · (−netOut) / Q` with `Q = Σ max(−Δ, 0)`, nothing sold; no trade at 0.
 *
 * A taxable sale realizes `sell_j · (1 − basis_j / bal_j)` (negative for a loss; every gain is
 * long-term, engine decision 29) and removes `sell_j · basis_j / bal_j` of basis; a purchase adds its
 * cost to basis. With `apply = false` nothing is written but the result: `assess` previews the
 * trades of every candidate withdrawal this way, and the loop applies the chosen one (seams §2.3
 * steps 4 to 6).
 *
 * Guards (engine-and-returns §3.8): a holding with `bal_j = 0` has `Δ_j ≤ 0`, is never sold and is
 * skipped in the gain and basis terms, so no division by zero occurs (an all-stock taxable account is
 * the normal case). The `flows_only` scale factors are at most 1 (`P ≥ netOut` and `Q ≥ −netOut`
 * because Σ Δ = netOut), so no underweight asset is sold; when rounding leaves `P` or `Q` at 0 (a
 * flow of a few ulps) nothing is traded. A flow that would overdraw the account by more than
 * `CASH_TOL` is the caller's bug (`EngineInvariantError("trade_overdraw")`); within it the account
 * is emptied exactly. A sale of a whole holding leaves its basis at exactly 0.
 *
 * Nothing is allocated per call: results go to a `TradeResult` created once per thread.
 */

import type { TaxableRebalance } from "@meridian/shared";
import { CASH_TOL } from "./constants.js";
import { EngineInvariantError } from "./errors.js";
import { SIM_ASSET_COUNT } from "./models/market.js";

/** Rebalance to target with the flow in one trade list (plan decision 8's default). */
export const TRADE_FULL = 0;
/** Taxable accounts only: no sale beyond what the withdrawal needs, no purchase beyond the deposit. */
export const TRADE_FLOWS_ONLY = 1;
export type TradeMode = typeof TRADE_FULL | typeof TRADE_FLOWS_ONLY;

/** The trade mode of `RunSettings.portfolio.taxableRebalance`. */
export function tradeModeOf(setting: TaxableRebalance): TradeMode {
  return setting === "flows_only" ? TRADE_FLOWS_ONLY : TRADE_FULL;
}

/** One account's trade, per simulated asset; overwritten by every `planTrades` call. */
export interface TradeResult {
  /** The gain the sales realize (taxable accounts; 0 otherwise); negative for a loss. Dollars. */
  realizedGain: number;
  /** Value after the flow, `V' = V − netOut` (0 when the account is emptied). Dollars. */
  valueAfter: number;
  /** Dollars sold, bought and held after the trade, by simulated asset. */
  readonly sell: Float64Array;
  readonly buy: Float64Array;
  readonly post: Float64Array;
}

export function createTradeResult(): TradeResult {
  return {
    realizedGain: 0,
    valueAfter: 0,
    sell: new Float64Array(SIM_ASSET_COUNT),
    buy: new Float64Array(SIM_ASSET_COUNT),
    post: new Float64Array(SIM_ASSET_COUNT),
  };
}

/**
 * Plans (and with `apply`, executes) one account's trades for a year.
 *
 * @param bal     balances by account and asset (dollars); the account's are `bal[off .. off + 2]`
 * @param basis   cost basis in the same layout; read and written only when `taxable`
 * @param off     the account's offset, `a × 3`
 * @param target  target weights (fractions summing to 1) in the same layout, at `targetOff`
 * @param netOut  dollars leaving the account (negative: arriving)
 * @param mode    `TRADE_FULL` or `TRADE_FLOWS_ONLY`; the latter applies to taxable accounts only
 * @param taxable whether the account is taxable (realizes gains, keeps basis)
 * @param apply   write the trade into `bal` and `basis` (false: preview only)
 */
export function planTrades(
  bal: Float64Array,
  basis: Float64Array,
  off: number,
  target: Float64Array,
  targetOff: number,
  netOut: number,
  mode: TradeMode,
  taxable: boolean,
  apply: boolean,
  out: TradeResult,
): void {
  FLOW[0] = netOut;
  planTradesFrom(bal, basis, off, target, targetOff, FLOW, 0, mode, taxable, apply, out);
}

const FLOW = new Float64Array(1);

/**
 * `planTrades` with the flow read from `flows[k]`: the year loop's form. A double passed to a call
 * TurboFan does not inline is boxed, and this function is too large to be inlined into its callers.
 */
export function planTradesFrom(
  bal: Float64Array,
  basis: Float64Array,
  off: number,
  target: Float64Array,
  targetOff: number,
  flows: Float64Array,
  k: number,
  mode: TradeMode,
  taxable: boolean,
  apply: boolean,
  out: TradeResult,
): void {
  const netOut = flows[k]!;
  if (!Number.isFinite(netOut)) throw new EngineInvariantError("trade_invalid", `a trade needs a finite flow, got ${netOut}`);
  const sell = out.sell;
  const buy = out.buy;
  const post = out.post;
  let value = 0;
  for (let j = 0; j < SIM_ASSET_COUNT; j++) value += bal[off + j]!;
  let valueAfter = value - netOut;
  let flow = netOut;
  if (valueAfter < 0) {
    if (valueAfter < -CASH_TOL) {
      throw new EngineInvariantError("trade_overdraw", `a flow of ${netOut} dollars overdraws an account holding ${value}`);
    }
    valueAfter = 0;
    flow = value;
  }

  // Δ_j into `post` for now; Σ Δ_j = flow.
  let over = 0;
  let under = 0;
  for (let j = 0; j < SIM_ASSET_COUNT; j++) {
    const d = bal[off + j]! - target[targetOff + j]! * valueAfter;
    post[j] = d;
    if (d > 0) over += d;
    else under -= d;
  }

  if (mode === TRADE_FLOWS_ONLY && taxable) {
    if (flow > 0) {
      const s = over > 0 ? (flow < over ? flow / over : 1) : 0;
      for (let j = 0; j < SIM_ASSET_COUNT; j++) {
        const d = post[j]!;
        sell[j] = d > 0 ? d * s : 0;
        buy[j] = 0;
      }
    } else if (flow < 0) {
      const s = under > 0 ? (-flow < under ? -flow / under : 1) : 0;
      for (let j = 0; j < SIM_ASSET_COUNT; j++) {
        const d = post[j]!;
        buy[j] = d < 0 ? -d * s : 0;
        sell[j] = 0;
      }
    } else {
      for (let j = 0; j < SIM_ASSET_COUNT; j++) {
        sell[j] = 0;
        buy[j] = 0;
      }
    }
  } else {
    for (let j = 0; j < SIM_ASSET_COUNT; j++) {
      const d = post[j]!;
      sell[j] = d > 0 ? d : 0;
      buy[j] = d < 0 ? -d : 0;
    }
  }

  let gain = 0;
  for (let j = 0; j < SIM_ASSET_COUNT; j++) {
    const b = bal[off + j]!;
    post[j] = b - sell[j]! + buy[j]!;
    if (taxable && b > 0) gain += sell[j]! * (1 - basis[off + j]! / b);
  }
  out.realizedGain = gain;
  out.valueAfter = valueAfter;

  if (!apply) return;
  for (let j = 0; j < SIM_ASSET_COUNT; j++) {
    const b = bal[off + j]!;
    if (taxable) {
      const s = sell[j]!;
      if (b > 0 && s > 0) basis[off + j] = s >= b ? 0 : basis[off + j]! - (s * basis[off + j]!) / b;
      basis[off + j] = basis[off + j]! + buy[j]!;
    }
    bal[off + j] = post[j]!;
  }
}

/**
 * Deposits `amount` dollars at the target weights (the surplus deposit of engine-and-returns §3.7
 * step 6 and seams C24): `bal_j += amount × w_j`, and in a taxable account `basis_j += amount × w_j`.
 */
export function depositAtWeights(
  bal: Float64Array,
  basis: Float64Array,
  off: number,
  target: Float64Array,
  targetOff: number,
  amount: number,
  taxable: boolean,
): void {
  if (!(amount >= 0) || !Number.isFinite(amount)) {
    throw new EngineInvariantError("deposit_invalid", `a deposit is a finite amount of at least 0, got ${amount}`);
  }
  for (let j = 0; j < SIM_ASSET_COUNT; j++) {
    const x = amount * target[targetOff + j]!;
    bal[off + j] = bal[off + j]! + x;
    if (taxable) basis[off + j] = basis[off + j]! + x;
  }
}
