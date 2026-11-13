import { DEFAULT_ASSET_CLASS_MAP, type ClassWeights } from "@meridian/shared";
import { describe, expect, it } from "vitest";
import { compileReturnModel, createMarketPath } from "../models/index.js";
import { seedKey } from "../rng.js";
import { AD, AD_REC, INTEREST_BILL_RETURN, INTEREST_NONE, INTEREST_PRIOR_BILL_PLUS_SPREAD, TD, TD_REC, TY, TY_REC, accountDragOffset } from "./layout.js";
import { BLEND_BOND, BLEND_STOCK, TAX_DRAG_CLASSES, assetClassMapRows, blendTaxDrag, compileAccountTaxDrag, compileTaxDrag, taxableYieldsInto } from "./taxDrag.js";
import { loadTaxData } from "./taxData.js";

// Seams C17 and C18 (plan decision 4) with tax-rmd-ss §2.6: the tax area's yield assumptions,
// blended into the engine's three simulated assets, and the yields on post-trade balances. The
// area design's cases F1 to F11 are replaced (seams §10) by the engine's trade cases (T23 in
// trades.test.ts) and the three blending cases here: the fixture brokerage account's 1.72% and 86%;
// a bond account's interest from the previous year's bill return; a floor at 0 when that return
// plus the spread is negative. The yields of data/taxable/tax-drag.json are assumptions (seams §9
// item 7): us_stock 1.3% (95% qualified), intl_stock 2.8% (75%), real_estate 3.5% (0%), bonds a
// spread of 1.0% over the previous year's bill return. Dollar values within 0.005.

const data = loadTaxData();
const DRAG = compileTaxDrag(data);
const MAP = assetClassMapRows(DEFAULT_ASSET_CLASS_MAP);
const near = (actual: number, expected: number) => expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(0.005);

const weightsOf = (w: Partial<ClassWeights>) => Float64Array.from(TAX_DRAG_CLASSES.map((c) => w[c] ?? 0));

/** One account-year record blended from class weights (basis points). */
function blend(w: Partial<ClassWeights>, drag = DRAG, map = MAP): { rec: Float64Array; held: number } {
  const rec = new Float64Array(AD_REC);
  const held = blendTaxDrag(drag, weightsOf(w), 0, map, rec, 0);
  return { rec, held };
}

/** The `TY` record of one account-year. */
function yields(rec: Float64Array, billRef: number, f: number, stock: number, bond: number, stockBasis = stock, bondBasis = bond): Float64Array {
  const out = new Float64Array(TY_REC);
  taxableYieldsInto(rec, 0, billRef, f, stock, bond, stockBasis, bondBasis, out);
  return out;
}

/** The fixture's joint brokerage account (packages/shared/src/retirement/testFixtures.ts): 68.39 / 26.32 / 5.29. */
const BROKERAGE: Partial<ClassWeights> = { us_stock: 6839, intl_stock: 2632, cash: 529 };
const BOND_FUND: Partial<ClassWeights> = { bonds: 10000 };

describe("compileTaxDrag", () => {
  it("the six classes of tax-drag.json in AssetClass order, the interest modes as codes", () => {
    expect(TAX_DRAG_CLASSES).toEqual(["us_stock", "intl_stock", "bonds", "cash", "real_estate", "other"]);
    expect(DRAG).toHaveLength(6 * TD_REC);
    const row = (i: number) => Array.from(DRAG.subarray(i * TD_REC, (i + 1) * TD_REC));
    expect(row(0)).toEqual([0.013, 0.95, INTEREST_NONE, 0, 0, 0]);
    expect(row(1)).toEqual([0.028, 0.75, INTEREST_NONE, 0, 0, 0]);
    expect(row(2)).toEqual([0, 0, INTEREST_PRIOR_BILL_PLUS_SPREAD, 0.01, 0, 0]);
    expect(row(3)).toEqual([0, 0, INTEREST_BILL_RETURN, 0, 0, 0]);
    expect(row(4)).toEqual([0.035, 0, INTEREST_NONE, 0, 0, 0]);
    expect(row(5)).toEqual([0, 0, INTEREST_NONE, 0, 0, 0]);
  });

  it("a scenario's basis-point overrides replace the file's figures, class by class (TaxSettings.taxDrag)", () => {
    const d = compileTaxDrag(data, { intl_stock: { dividendYieldBp: 300, qualifiedShareBp: 6000 }, bonds: { interestSpreadBp: 20, taxExemptShareBp: 4000 } });
    expect(Array.from(d.subarray(TD_REC, 2 * TD_REC))).toEqual([0.03, 0.6, INTEREST_NONE, 0, 0, 0]);
    expect(d[2 * TD_REC + TD.INTEREST_SPREAD]).toBe(0.002);
    expect(d[2 * TD_REC + TD.TAX_EXEMPT_SHARE]).toBe(0.4);
    // Untouched classes keep the file's numbers.
    expect(Array.from(d.subarray(0, TD_REC))).toEqual(Array.from(DRAG.subarray(0, TD_REC)));
  });

  it("the default asset map as fractions: stocks ← us, intl, real estate, other; bonds ← bonds; bills ← cash", () => {
    expect(Array.from(MAP)).toEqual([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0]);
  });
});

describe("blending case 1: the fixture brokerage account's 1.72% and 86% (seams C17 item 2)", () => {
  it("stock dividend yield 1.72%, 86% of it qualified; the cash slice is bills and adds nothing", () => {
    // Stock weight 6,839 + 2,632 = 9,471 bp (cash maps to bills). Dividends per 10,000 of account:
    // 6,839 × 0.013 + 2,632 × 0.028 = 88.907 + 73.696 = 162.603, so the yield on the stock asset is
    // 162.603 / 9,471 = 0.0171685 (1.72%). Qualified: 88.907 × 0.95 + 73.696 × 0.75 = 84.46165 +
    // 55.272 = 139.73365, and 139.73365 / 162.603 = 0.859355 (86%).
    const { rec, held } = blend(BROKERAGE);
    expect(held).toBe(BLEND_STOCK);
    expect(rec[AD.STOCK_DIVIDEND_YIELD]).toBeCloseTo(162.603 / 9471, 12);
    expect(rec[AD.STOCK_QUALIFIED_SHARE]).toBeCloseTo(139.73365 / 162.603, 12);
    expect(Math.round(rec[AD.STOCK_DIVIDEND_YIELD]! * 10000) / 100).toBe(1.72);
    expect(Math.round(rec[AD.STOCK_QUALIFIED_SHARE]! * 100)).toBe(86);
    // The account holds no bond asset: the bond slots are 0.
    expect([rec[AD.BOND_INTEREST_SPREAD], rec[AD.BOND_TAX_EXEMPT_SHARE], rec[AD.BOND_GAIN_DISTRIBUTION]]).toEqual([0, 0, 0]);
  });

  it("the yields on the post-trade balances: 100,000 of stock pays 1,716.85, 1,475.38 of it qualified; × f in year 0", () => {
    // 100,000 × 162.603 / 9,471 = 1,716.851; qualified 100,000 × 139.73365 / 9,471 = 1,475.384.
    const { rec } = blend(BROKERAGE);
    const y = yields(rec, 0.03, 1, 100000, 0);
    near(y[TY.DIVIDENDS]!, (100000 * 162.603) / 9471);
    near(y[TY.QUALIFIED_DIVIDENDS]!, (100000 * 139.73365) / 9471);
    expect(y[TY.STOCK_BASIS_ADD]).toBe(y[TY.DIVIDENDS]);
    expect([y[TY.INTEREST], y[TY.TAX_EXEMPT_INTEREST], y[TY.BOND_BASIS_ADD], y[TY.GAIN_DISTRIBUTIONS]]).toEqual([0, 0, 0, 0]);
    // October to December 2026 (f = 3/12): a quarter of it (C14: a yield is a recurring amount scaled by f).
    near(yields(rec, 0.03, 3 / 12, 100000, 0)[TY.DIVIDENDS]!, (100000 * 162.603) / 9471 / 4);
  });

  it("the weights may be in basis points or fractions: every blend is a ratio", () => {
    const bp = blend(BROKERAGE).rec;
    const fr = new Float64Array(AD_REC);
    blendTaxDrag(DRAG, weightsOf({ us_stock: 0.6839, intl_stock: 0.2632, cash: 0.0529 }), 0, MAP, fr, 0);
    expect(fr[AD.STOCK_DIVIDEND_YIELD]).toBeCloseTo(bp[AD.STOCK_DIVIDEND_YIELD]!, 15);
    expect(fr[AD.STOCK_QUALIFIED_SHARE]).toBeCloseTo(bp[AD.STOCK_QUALIFIED_SHARE]!, 15);
  });

  it("with the owner's overrides (intl 3.0%, 60% qualified) the same account blends to 1.7724% and 78.54%", () => {
    // 88.907 + 2,632 × 0.03 = 88.907 + 78.96 = 167.867; 167.867 / 9,471 = 0.0177243.
    // Qualified 84.46165 + 78.96 × 0.6 = 84.46165 + 47.376 = 131.83765; / 167.867 = 0.785370.
    const drag = compileTaxDrag(data, { intl_stock: { dividendYieldBp: 300, qualifiedShareBp: 6000 } });
    const { rec } = blend(BROKERAGE, drag);
    expect(rec[AD.STOCK_DIVIDEND_YIELD]).toBeCloseTo(167.867 / 9471, 12);
    expect(rec[AD.STOCK_QUALIFIED_SHARE]).toBeCloseTo(131.83765 / 167.867, 12);
  });

  it("real estate in the stock asset: 50% US stock and 50% REITs yield 2.4%, 25.73% qualified (dividend-weighted)", () => {
    // Per 10,000: 5,000 × 0.013 = 65 (61.75 qualified) and 5,000 × 0.035 = 175 (none qualified in the
    // data): 240 / 10,000 = 2.4%, qualified 61.75 / 240 = 0.2572917. A weight-average of the shares would
    // give 47.5%, overstating the qualified part of a REIT-heavy mix.
    const { rec } = blend({ us_stock: 5000, real_estate: 5000 });
    expect(rec[AD.STOCK_DIVIDEND_YIELD]).toBeCloseTo(0.024, 15);
    expect(rec[AD.STOCK_QUALIFIED_SHARE]).toBeCloseTo(61.75 / 240, 15);
  });
});

describe("blending case 2: a bond account's interest from the previous year's bill return (seams C18 (a))", () => {
  it("interest = max(0, billRef + spread) × post-trade bonds × f, with billRef the previous plan year's full-year bill return", () => {
    // The fixed model's rows: plan year 0 bills 3%, later years 2% (the model's billRef0 is row 0's bill
    // rate, 3%). Year 0 is October to December 2026 (f = 3/12): (0.03 + 0.01) × 100,000 × 3/12 = 1,000.
    // Year 1 uses year 0's full-year bill return, 3%, not its own 2%: 4% × 100,000 = 4,000 (W1's "bills
    // 3%, coupon 4%"). Year 2 uses year 1's 2%: 3,000 (R2's "bills 2%, coupon 3%").
    const model = compileReturnModel(
      {
        kind: "fixed",
        series: [
          { stocksPpm: 100000, bondsPpm: 40000, billsPpm: 30000, inflationPpm: 30000 },
          { stocksPpm: 50000, bondsPpm: 30000, billsPpm: 20000, inflationPpm: 25000 },
        ],
      },
      { key: seedKey(1), years: 3, firstYearMonths: 3, requestedPaths: 1, allFixedLongevity: true },
    );
    const path = createMarketPath(3);
    model.fillPath(0, path);
    const billRef = (t: number) => (t === 0 ? model.billRef0 : path.billsFull[t - 1]!);
    expect([billRef(0), billRef(1), billRef(2)]).toEqual([0.03, 0.03, 0.02]);

    const { rec, held } = blend(BOND_FUND);
    expect(held).toBe(BLEND_BOND);
    expect(rec[AD.BOND_INTEREST_SPREAD]).toBe(0.01);
    near(yields(rec, billRef(0), 3 / 12, 0, 100000)[TY.INTEREST]!, 1000);
    near(yields(rec, billRef(1), 1, 0, 100000)[TY.INTEREST]!, 4000);
    near(yields(rec, billRef(2), 1, 0, 100000)[TY.INTEREST]!, 3000);
  });

  it("the historical and bootstrap models' year-0 reference is the 2025 bill return, 4.21%: (0.0421 + 0.01) × 250,000 = 13,025", () => {
    const { rec } = blend(BOND_FUND);
    const y = yields(rec, 0.0421, 1, 0, 250000);
    near(y[TY.INTEREST]!, 13025);
    // All of it is reinvested in the bond asset's basis; nothing is a dividend.
    near(y[TY.BOND_BASIS_ADD]!, 13025);
    expect([y[TY.DIVIDENDS], y[TY.QUALIFIED_DIVIDENDS], y[TY.TAX_EXEMPT_INTEREST]]).toEqual([0, 0, 0]);
  });

  it("T25's spread of 0.2% over bills of 4% is a 4.2% coupon; a 40% tax-exempt share splits it", () => {
    // Spread override 20 bp: (0.04 + 0.002) × 100,000 = 4,200. With taxExemptShareBp 4,000: 1,680 exempt,
    // 2,520 taxable; the whole 4,200 adds to the bond asset's basis.
    const drag = compileTaxDrag(data, { bonds: { interestSpreadBp: 20, taxExemptShareBp: 4000 } });
    const { rec } = blend(BOND_FUND, drag);
    const y = yields(rec, 0.04, 1, 0, 100000);
    near(y[TY.INTEREST]! + y[TY.TAX_EXEMPT_INTEREST]!, 4200);
    near(y[TY.TAX_EXEMPT_INTEREST]!, 1680);
    near(y[TY.INTEREST]!, 2520);
    near(y[TY.BOND_BASIS_ADD]!, 4200);
  });

  it("a 60/40 account: dividends on the stock asset, interest on the bond asset, each from its own balance", () => {
    // Stocks 60,000 at 1.3% (us_stock only) = 780, 741 qualified; bonds 40,000 at 3% + 1% = 1,600.
    const { rec, held } = blend({ us_stock: 6000, bonds: 4000 });
    expect(held).toBe(BLEND_STOCK | BLEND_BOND);
    const y = yields(rec, 0.03, 1, 60000, 40000);
    near(y[TY.DIVIDENDS]!, 780);
    near(y[TY.QUALIFIED_DIVIDENDS]!, 741);
    near(y[TY.INTEREST]!, 1600);
  });
});

describe("blending case 3: a floor at 0 when the previous year's bill return plus the spread is negative (seams C18)", () => {
  it("bills −2% with the 1% spread pay no interest; bills −0.5% pay 0.5% (F8's figures on the bond asset)", () => {
    const { rec } = blend(BOND_FUND);
    const neg = yields(rec, -0.02, 1, 0, 100000);
    expect([neg[TY.INTEREST], neg[TY.TAX_EXEMPT_INTEREST], neg[TY.BOND_BASIS_ADD]]).toEqual([0, 0, 0]);
    near(yields(rec, -0.005, 1, 0, 100000)[TY.INTEREST]!, 500);
    // Exactly at −1%: the rate is 0, so is the interest.
    expect(yields(rec, -0.01, 1, 0, 100000)[TY.INTEREST]).toBe(0);
  });
});

describe("gain distributions (seams C17 item 6)", () => {
  it("a 5% rate on class other (368,000, basis 230,000) distributes 6,900 of long-term gain and adds it to basis (F9's figures)", () => {
    // 0.05 × (368,000 − 230,000) = 6,900. `other` pays no dividends and maps to stocks.
    const drag = compileTaxDrag(data, { other: { gainDistributionRateBp: 500 } });
    const { rec } = blend({ other: 10000 }, drag);
    expect(rec[AD.STOCK_GAIN_DISTRIBUTION]).toBe(0.05);
    const y = yields(rec, 0.03, 1, 368000, 0, 230000, 0);
    near(y[TY.GAIN_DISTRIBUTIONS]!, 6900);
    near(y[TY.STOCK_BASIS_ADD]!, 6900);
    expect(y[TY.DIVIDENDS]).toBe(0);
    // A position held at a loss distributes nothing.
    expect(yields(rec, 0.03, 1, 200000, 0, 230000, 0)[TY.GAIN_DISTRIBUTIONS]).toBe(0);
  });

  it("the default data distributes nothing (every gainDistributionRate is 0)", () => {
    expect(yields(blend(BROKERAGE).rec, 0.03, 1, 500000, 0, 100000, 0)[TY.GAIN_DISTRIBUTIONS]).toBe(0);
  });
});

describe("a custom asset map", () => {
  it("other → half stocks, half bonds: the stock half pays other's dividends (0), the bond half the bill return plus other's spread (0)", () => {
    const map = assetClassMapRows({ ...DEFAULT_ASSET_CLASS_MAP, other: [5000, 5000, 0] });
    const { rec, held } = blend({ us_stock: 5000, other: 5000 }, DRAG, map);
    expect(held).toBe(BLEND_STOCK | BLEND_BOND);
    // Stock asset: 5,000 us_stock + 2,500 other; yield 5,000 × 0.013 / 7,500 = 0.0086667, all qualified at 95%.
    expect(rec[AD.STOCK_DIVIDEND_YIELD]).toBeCloseTo(65 / 7500, 15);
    expect(rec[AD.STOCK_QUALIFIED_SHARE]).toBeCloseTo(0.95, 15);
    // Bond asset: other only, spread 0: interest at the previous bill return, 3% of 25,000 = 750.
    expect(rec[AD.BOND_INTEREST_SPREAD]).toBe(0);
    near(yields(rec, 0.03, 1, 75000, 25000)[TY.INTEREST]!, 750);
  });
});

describe("compileAccountTaxDrag", () => {
  it("per account and plan year at accountDragOffset; an asset the target leaves keeps the nearest earlier year's rates, else the nearest later", () => {
    // Account 0: year 0 all bonds, year 1 the brokerage mix, year 2 all cash. Account 1: the brokerage mix throughout.
    const years = 3;
    const accounts = 2;
    const w = new Float64Array(years * accounts * 6);
    const put = (t: number, a: number, x: Partial<ClassWeights>) => w.set(weightsOf(x), (t * accounts + a) * 6);
    put(0, 0, BOND_FUND);
    put(1, 0, BROKERAGE);
    put(2, 0, { cash: 10000 });
    for (let t = 0; t < years; t++) put(t, 1, BROKERAGE);
    const table = compileAccountTaxDrag(DRAG, w, MAP, years, accounts);
    expect(table).toHaveLength(years * accounts * AD_REC);
    const brokerage = blend(BROKERAGE).rec;
    const at = (t: number, a: number, slot: number) => table[accountDragOffset(t, a, accounts) + slot];
    // Account 1 is the plain blend in every year.
    for (let t = 0; t < years; t++) expect(at(t, 1, AD.STOCK_DIVIDEND_YIELD)).toBe(brokerage[AD.STOCK_DIVIDEND_YIELD]);
    // Account 0's stock asset: year 0 holds none (takes year 1's, the nearest later), year 2 none (keeps year 1's).
    for (const t of [0, 1, 2]) {
      expect(at(t, 0, AD.STOCK_DIVIDEND_YIELD)).toBe(brokerage[AD.STOCK_DIVIDEND_YIELD]);
      expect(at(t, 0, AD.STOCK_QUALIFIED_SHARE)).toBe(brokerage[AD.STOCK_QUALIFIED_SHARE]);
    }
    // Account 0's bond asset: year 0 holds it (spread 1%); years 1 and 2 keep year 0's.
    for (const t of [0, 1, 2]) expect(at(t, 0, AD.BOND_INTEREST_SPREAD)).toBe(0.01);
    // Account 1 never holds the bond asset: its bond slots stay 0.
    for (let t = 0; t < years; t++) expect(at(t, 1, AD.BOND_INTEREST_SPREAD)).toBe(0);
  });

  it("refuses mismatched lengths and negative or non-finite weights", () => {
    expect(() => compileAccountTaxDrag(DRAG, new Float64Array(5), MAP, 1, 1)).toThrow(RangeError);
    expect(() => compileAccountTaxDrag(DRAG, Float64Array.of(-1, 0, 0, 0, 0, 0), MAP, 1, 1)).toThrow(RangeError);
    expect(() => compileAccountTaxDrag(DRAG, Float64Array.of(NaN, 0, 0, 0, 0, 0), MAP, 1, 1)).toThrow(RangeError);
    expect(() => compileAccountTaxDrag(DRAG, new Float64Array(6), MAP, 0, 1)).toThrow(RangeError);
    expect(compileAccountTaxDrag(DRAG, new Float64Array(0), MAP, 2, 0)).toHaveLength(0);
  });
});

describe("taxableYieldsInto conventions", () => {
  it("f = 0 and f = 1 are a full year (the TI.YEAR_FRACTION convention); every slot is written", () => {
    const { rec } = blend({ us_stock: 6000, bonds: 4000 });
    const full = yields(rec, 0.03, 1, 60000, 40000);
    expect(Array.from(yields(rec, 0.03, 0, 60000, 40000))).toEqual(Array.from(full));
    const out = new Float64Array(TY_REC).fill(99);
    taxableYieldsInto(rec, 0, 0.03, 1, 60000, 40000, 60000, 40000, out);
    expect(Array.from(out)).toEqual(Array.from(full));
    expect(out[TY.RESERVED0]).toBe(0);
  });

  it("an all-bills (cash) account has no stock or bond asset: every yield is 0 (its bill return is the engine's, taxed a year later)", () => {
    const { rec, held } = blend({ cash: 10000 });
    expect(held).toBe(0);
    expect(Array.from(rec)).toEqual(new Array(AD_REC).fill(0));
    expect(Array.from(yields(rec, 0.05, 1, 0, 0))).toEqual(new Array(TY_REC).fill(0));
  });
});
