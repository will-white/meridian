/**
 * The yield assumptions of taxable accounts (tax-rmd-ss §2.6; seams C17 and C18; plan decision 4).
 *
 * The taxable-account mechanics are the engine's (C17 item 1: three simulated assets per account,
 * one trade list, gains taxed in the year of the sale); the assumptions are this area's
 * `taxable/tax-drag.json` with the scenario's `TaxSettings.taxDrag` overrides, which is the only
 * source of yields. Three steps:
 *
 * 1. `compileTaxDrag` (once per run, inside `prepare`, C12): the six classes' numbers with the
 *    overrides, `TD_REC` per class in `AssetClass` order.
 * 2. `blendTaxDrag` / `compileAccountTaxDrag` (inside `prepare`): per account and plan year, the six
 *    classes are blended into the simulated assets with that year's six-class target weights and
 *    the asset map (C17 item 2). The simulated asset decides the kind of income (stocks pay
 *    dividends, bonds pay interest, bills earn the bill return); the classes mapped into it decide
 *    its rates. With `v_c = w_c × map[c][stocks]` and `u_c = w_c × map[c][bonds]`:
 *    - stock dividend yield `Σ v_c y_c / Σ v_c`; qualified share `Σ v_c y_c q_c / Σ v_c y_c`
 *      (dividend-weighted; 0 when the asset pays none); gain distribution rate `Σ v_c g_c / Σ v_c`;
 *    - bond interest spread `Σ u_c s_c / Σ u_c`; tax-exempt share `Σ u_c e_c / Σ u_c`; gain
 *      distribution rate `Σ u_c g_c / Σ u_c`.
 *    A class's dividends count only through its stock share and its spread only through its bond
 *    share. Weights and map rows may be in any common scale (basis points or fractions): every
 *    blend is a ratio. The fixture's brokerage account (68.39% US stock, 26.32% international,
 *    5.29% cash) gets a stock dividend yield of 1.72%, 86% of it qualified.
 * 3. `taxableYieldsInto` (inside `assess`, per candidate): on the post-trade balances, dividends
 *    `= yield × stock × f`, split into qualified and ordinary; bond interest
 *    `= max(0, billRef + spread) × bond × f` (C18 (a)), split into taxable and tax-exempt, where
 *    `billRef` is the path's full-year bill return of the previous plan year (for year 0 the return
 *    model's starting bill rate); gain distributions `= rate × max(0, value − basis) × f` per asset
 *    (C17 item 6). All of it is taxed in the year and added to the asset's basis.
 *
 * Bills in taxable and cash accounts earn the whole actual bill return of the year, taxed with the
 * next year (C17 item 5): the engine's rule, with no parameter here. The cash class's own interest
 * mode is not read (`bill_return`), and `fallbackCashYield` does not exist (C17 item 6).
 */

import { AssetClass, DEFAULT_ASSET_CLASS_MAP, type AssetClassMap, type TaxDragOverride } from "@meridian/shared";
import { AD, AD_REC, INTEREST_BILL_RETURN, INTEREST_NONE, INTEREST_PRIOR_BILL_PLUS_SPREAD, TD, TD_REC, TY, TYI, TYI_REC } from "./layout.js";
import { loadTaxData, type TaxData, type TaxDragClass } from "./taxData.js";

/** The six classes in the order of every per-class array (`AssetClass` options, the frozen input's order). */
export const TAX_DRAG_CLASSES: readonly AssetClass[] = AssetClass.options;
const N_CLASSES = 6;
const N_SIM = 3;
const SIM_STOCKS = 0;
const SIM_BONDS = 1;

const INTEREST_MODES: Record<TaxDragClass["interest"], number> = {
  none: INTEREST_NONE,
  prior_bill_plus_spread: INTEREST_PRIOR_BILL_PLUS_SPREAD,
  bill_return: INTEREST_BILL_RETURN,
};

/** A scenario's per-class overrides (`TaxSettings.taxDrag`). */
export type TaxDragOverrides = Readonly<Partial<Record<AssetClass, TaxDragOverride>>>;

/**
 * The six classes' assumptions (`TD_REC` slots each, in `TAX_DRAG_CLASSES` order) from
 * `taxable/tax-drag.json`, with each basis-point override replacing the file's figure.
 */
export function compileTaxDrag(data: TaxData = loadTaxData(), overrides: TaxDragOverrides = {}): Float64Array {
  const out = new Float64Array(N_CLASSES * TD_REC);
  TAX_DRAG_CLASSES.forEach((c, i) => {
    const d = data.drag.classes[c];
    const o = overrides[c] ?? {};
    const off = i * TD_REC;
    out[off + TD.DIVIDEND_YIELD] = o.dividendYieldBp !== undefined ? o.dividendYieldBp / 10000 : d.dividendYield;
    out[off + TD.QUALIFIED_SHARE] = o.qualifiedShareBp !== undefined ? o.qualifiedShareBp / 10000 : d.qualifiedShare;
    out[off + TD.INTEREST_MODE] = INTEREST_MODES[d.interest];
    out[off + TD.INTEREST_SPREAD] = o.interestSpreadBp !== undefined ? o.interestSpreadBp / 10000 : d.interestSpread;
    out[off + TD.TAX_EXEMPT_SHARE] = o.taxExemptShareBp !== undefined ? o.taxExemptShareBp / 10000 : d.taxExemptShare;
    out[off + TD.GAIN_DISTRIBUTION] = o.gainDistributionRateBp !== undefined ? o.gainDistributionRateBp / 10000 : d.gainDistributionRate;
  });
  return out;
}

/** An asset map as 6 × 3 fractions (`[stocks, bonds, bills]` per class in `TAX_DRAG_CLASSES` order). */
export function assetClassMapRows(map: Readonly<Record<AssetClass, Readonly<AssetClassMap[AssetClass]>>> = DEFAULT_ASSET_CLASS_MAP): Float64Array {
  const out = new Float64Array(N_CLASSES * N_SIM);
  TAX_DRAG_CLASSES.forEach((c, i) => {
    const row = map[c];
    for (let s = 0; s < N_SIM; s++) out[i * N_SIM + s] = row[s]! / 10000;
  });
  return out;
}

/** `blendTaxDrag`'s result bits: the account holds a positive target weight in the stock / bond asset. */
export const BLEND_STOCK = 1;
export const BLEND_BOND = 2;

/**
 * Blends the classes' assumptions (`classDrag` from `compileTaxDrag`) into one account-year record
 * (`AD` at `outOff`) from the six class weights at `weights[wOff .. wOff + 5]` and the asset map
 * (`map`, 6 × 3, `assetClassMapRows`). Returns `BLEND_STOCK | BLEND_BOND` for the assets with a
 * positive weight; an asset without one gets zeros. Allocates nothing.
 */
export function blendTaxDrag(classDrag: Float64Array, weights: Float64Array, wOff: number, map: Float64Array, out: Float64Array, outOff: number): number {
  let vSum = 0;
  let vDiv = 0;
  let vQual = 0;
  let vGain = 0;
  let uSum = 0;
  let uSpread = 0;
  let uExempt = 0;
  let uGain = 0;
  for (let c = 0; c < N_CLASSES; c++) {
    const w = weights[wOff + c]!;
    if (!(w > 0)) continue;
    const d = c * TD_REC;
    const v = w * map[c * N_SIM + SIM_STOCKS]!;
    const u = w * map[c * N_SIM + SIM_BONDS]!;
    if (v > 0) {
      const div = v * classDrag[d + TD.DIVIDEND_YIELD]!;
      vSum += v;
      vDiv += div;
      vQual += div * classDrag[d + TD.QUALIFIED_SHARE]!;
      vGain += v * classDrag[d + TD.GAIN_DISTRIBUTION]!;
    }
    if (u > 0) {
      uSum += u;
      uSpread += u * classDrag[d + TD.INTEREST_SPREAD]!;
      uExempt += u * classDrag[d + TD.TAX_EXEMPT_SHARE]!;
      uGain += u * classDrag[d + TD.GAIN_DISTRIBUTION]!;
    }
  }
  let held = 0;
  if (vSum > 0) {
    out[outOff + AD.STOCK_DIVIDEND_YIELD] = vDiv / vSum;
    out[outOff + AD.STOCK_QUALIFIED_SHARE] = vDiv > 0 ? vQual / vDiv : 0;
    out[outOff + AD.STOCK_GAIN_DISTRIBUTION] = vGain / vSum;
    held |= BLEND_STOCK;
  } else {
    out[outOff + AD.STOCK_DIVIDEND_YIELD] = 0;
    out[outOff + AD.STOCK_QUALIFIED_SHARE] = 0;
    out[outOff + AD.STOCK_GAIN_DISTRIBUTION] = 0;
  }
  if (uSum > 0) {
    out[outOff + AD.BOND_INTEREST_SPREAD] = uSpread / uSum;
    out[outOff + AD.BOND_TAX_EXEMPT_SHARE] = uExempt / uSum;
    out[outOff + AD.BOND_GAIN_DISTRIBUTION] = uGain / uSum;
    held |= BLEND_BOND;
  } else {
    out[outOff + AD.BOND_INTEREST_SPREAD] = 0;
    out[outOff + AD.BOND_TAX_EXEMPT_SHARE] = 0;
    out[outOff + AD.BOND_GAIN_DISTRIBUTION] = 0;
  }
  out[outOff + AD.RESERVED0] = 0;
  out[outOff + AD.RESERVED0 + 1] = 0;
  return held;
}

const STOCK_SLOTS = [AD.STOCK_DIVIDEND_YIELD, AD.STOCK_QUALIFIED_SHARE, AD.STOCK_GAIN_DISTRIBUTION] as const;
const BOND_SLOTS = [AD.BOND_INTEREST_SPREAD, AD.BOND_TAX_EXEMPT_SHARE, AD.BOND_GAIN_DISTRIBUTION] as const;

/**
 * Every account's record for every plan year (`AD_REC` at `accountDragOffset(t, a, accounts)`) from
 * the six-class target weights `weights` (`years × accounts × 6`, any common scale, at
 * `(t × accounts + a) × 6`) and the asset map. For a plan year in which an account's target holds
 * nothing in the stock (or bond) asset, the asset keeps the rates of the nearest earlier year that
 * held some, else of the nearest later one, else 0: under `flows_only` an account can still hold
 * the asset its target has left. Allocating; for `prepare`.
 */
export function compileAccountTaxDrag(classDrag: Float64Array, weights: Float64Array, map: Float64Array, years: number, accounts: number): Float64Array {
  if (!Number.isInteger(years) || years < 1 || !Number.isInteger(accounts) || accounts < 0) {
    throw new RangeError(`compileAccountTaxDrag needs whole numbers of years (at least 1) and accounts, got ${years} and ${accounts}`);
  }
  if (classDrag.length !== N_CLASSES * TD_REC || map.length !== N_CLASSES * N_SIM || weights.length !== years * accounts * N_CLASSES) {
    throw new RangeError("compileAccountTaxDrag: 6 × TD_REC class numbers, a 6 × 3 map and years × accounts × 6 weights are needed");
  }
  for (const x of [...weights, ...map]) {
    if (!(Number.isFinite(x) && x >= 0)) throw new RangeError("compileAccountTaxDrag: weights and map entries must be finite and non-negative");
  }
  const out = new Float64Array(years * accounts * AD_REC);
  const held = new Uint8Array(years * accounts);
  for (let t = 0; t < years; t++) {
    for (let a = 0; a < accounts; a++) {
      const k = t * accounts + a;
      held[k] = blendTaxDrag(classDrag, weights, k * N_CLASSES, map, out, k * AD_REC);
    }
  }
  for (let a = 0; a < accounts; a++) {
    for (const [bit, slots] of [
      [BLEND_STOCK, STOCK_SLOTS],
      [BLEND_BOND, BOND_SLOTS],
    ] as const) {
      let from = -1;
      for (let t = 0; t < years; t++) {
        const k = t * accounts + a;
        if ((held[k]! & bit) !== 0) from = k;
        else if (from >= 0) for (const s of slots) out[k * AD_REC + s] = out[from * AD_REC + s]!;
      }
      let first = -1;
      for (let t = 0; t < years && first < 0; t++) if ((held[t * accounts + a]! & bit) !== 0) first = t * accounts + a;
      if (first < 0) continue;
      for (let t = 0; t * accounts + a < first; t++) {
        const k = t * accounts + a;
        for (const s of slots) out[k * AD_REC + s] = out[first * AD_REC + s]!;
      }
    }
  }
  return out;
}

/**
 * One taxable account's income for the period on its post-trade balances (`TY` in `out`): the
 * record `drag` at `off` (`AD`), `billRef` the path's full-year bill return of the previous plan
 * year (the model's starting bill rate in year 0), `f` the year fraction (the convention of
 * `TI.YEAR_FRACTION`: outside (0, 1) a full year), `stock` / `bond` the post-trade balances and
 * `stockBasis` / `bondBasis` their basis after the trade. The interest rate is floored at 0 (C18).
 * Allocates nothing; never throws.
 */
export function taxableYieldsInto(
  drag: Float64Array,
  off: number,
  billRef: number,
  f: number,
  stock: number,
  bond: number,
  stockBasis: number,
  bondBasis: number,
  out: Float64Array,
): void {
  const x = INPUT;
  x[TYI.BILL_REF] = billRef;
  x[TYI.YEAR_FRACTION] = f;
  x[TYI.STOCK] = stock;
  x[TYI.BOND] = bond;
  x[TYI.STOCK_BASIS] = stockBasis;
  x[TYI.BOND_BASIS] = bondBasis;
  taxableYieldsFrom(drag, off, x, 0, out);
}

/** Scratch of `taxableYieldsInto`'s inputs. */
const INPUT = new Float64Array(TYI_REC);

/**
 * `taxableYieldsInto` with its inputs read from the record `input` at `inOff` (`TYI`): the form
 * the year loop calls through `TAX_FUNCTIONS.taxableYieldsInto`, because V8 boxes a double passed
 * to a call it does not inline. The same operations on the same values.
 */
export function taxableYieldsFrom(drag: Float64Array, off: number, input: Float64Array, inOff: number, out: Float64Array): void {
  const billRef = input[inOff + TYI.BILL_REF]!;
  const f = input[inOff + TYI.YEAR_FRACTION]!;
  const stock = input[inOff + TYI.STOCK]!;
  const bond = input[inOff + TYI.BOND]!;
  const stockBasis = input[inOff + TYI.STOCK_BASIS]!;
  const bondBasis = input[inOff + TYI.BOND_BASIS]!;
  const g = f > 0 && f < 1 ? f : 1;
  const dividends = drag[off + AD.STOCK_DIVIDEND_YIELD]! * stock * g;
  const rate = billRef + drag[off + AD.BOND_INTEREST_SPREAD]!;
  const interest = rate > 0 ? rate * bond * g : 0;
  const exempt = interest * drag[off + AD.BOND_TAX_EXEMPT_SHARE]!;
  const stockGain = stock - stockBasis;
  const bondGain = bond - bondBasis;
  const distStock = stockGain > 0 ? drag[off + AD.STOCK_GAIN_DISTRIBUTION]! * stockGain * g : 0;
  const distBond = bondGain > 0 ? drag[off + AD.BOND_GAIN_DISTRIBUTION]! * bondGain * g : 0;
  out[TY.DIVIDENDS] = dividends;
  out[TY.QUALIFIED_DIVIDENDS] = dividends * drag[off + AD.STOCK_QUALIFIED_SHARE]!;
  out[TY.INTEREST] = interest - exempt;
  out[TY.TAX_EXEMPT_INTEREST] = exempt;
  out[TY.GAIN_DISTRIBUTIONS] = distStock + distBond;
  out[TY.STOCK_BASIS_ADD] = dividends + distStock;
  out[TY.BOND_BASIS_ADD] = interest + distBond;
  out[TY.RESERVED0] = 0;
}
