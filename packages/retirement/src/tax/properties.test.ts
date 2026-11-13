import { describe, expect, it } from "vitest";
import { federalTaxInto } from "./federalTax.js";
import { N_BRACKETS, TAX_IN, TAX_OUT, TI, TO, TR, taxOffset } from "./layout.js";
import { loadTaxData } from "./taxData.js";
import { pathTables, taxInput, taxOn, type TaxInputName } from "./testKit.js";

// tax-rmd-ss §3.4 and §7 K1 to K4: the properties a gross-up solver relies on, over seeded random
// households, and the partial-year identity Tax_f(x) = f × Tax(x / f) (decision 44, seams C23).

const data = loadTaxData();
const published = pathTables(data, { startYear: 2026, years: 2 });
const indexed = pathTables(data, { startYear: 2026, years: 12, inflation: [0.02, 0.031, 0.045, -0.012, 0.025, 0.08, 0.03, 0.01, 0.022, 0.027, 0.019, 0.024] });

/** mulberry32: a small deterministic generator for the property tests (tests only). */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random household: about four in ten inputs are 0, so the thresholds and the zero branches are exercised. */
function household(rand: () => number): { status: 0 | 1; x: Float64Array } {
  const status = rand() < 0.5 ? 0 : 1;
  const amt = (max: number) => (rand() < 0.4 ? 0 : Math.round(rand() * max * 100) / 100);
  const signed = (lo: number, hi: number) => (rand() < 0.4 ? 0 : Math.round((lo + rand() * (hi - lo)) * 100) / 100);
  const ordDiv = amt(30000);
  const x = taxInput({
    WAGES: amt(400000),
    PENSION: amt(100000),
    INTEREST: amt(20000),
    TAX_EXEMPT_INTEREST: amt(10000),
    ORD_DIV: ordDiv,
    QUAL_DIV: Math.round(ordDiv * rand() * 100) / 100,
    ST_GAIN: signed(-20000, 20000),
    LT_GAIN: signed(-60000, 150000),
    LOSS_CARRY_IN: amt(30000),
    TRAD_DIST: amt(150000),
    ROTH_CONV: amt(60000),
    ROTH_TAXABLE: amt(10000),
    HSA_TAXABLE: amt(10000),
    SS_GROSS: amt(70000),
    RENTAL: amt(30000),
    OTHER_ORD: amt(20000),
    NII_OTHER: amt(5000),
    ADJUSTMENTS: amt(8000),
    PEN10_BASE: amt(20000),
    PEN20_BASE: amt(5000),
    N_AGED: Math.floor(rand() * (status + 2)),
  });
  return { status, x };
}

describe("K1 monotonicity over 20,000 seeded random 2026 households", () => {
  const raising: TaxInputName[] = [
    "WAGES", "PENSION", "INTEREST", "TAX_EXEMPT_INTEREST", "ORD_DIV", "ST_GAIN", "LT_GAIN", "TRAD_DIST", "ROTH_CONV",
    "ROTH_TAXABLE", "HSA_TAXABLE", "SS_GROSS", "RENTAL", "OTHER_ORD", "NII_OTHER", "PEN10_BASE", "PEN20_BASE",
  ];
  const lowering: TaxInputName[] = ["LOSS_CARRY_IN", "ADJUSTMENTS"];

  it("K1 adding $10 to each input of §3.4 never lowers TOTAL; $10 more of QUAL_DIV alone, LOSS_CARRY_IN or ADJUSTMENTS never raises it", () => {
    const rand = generator(20261113);
    const r = new Float64Array(TAX_OUT);
    const bumped = new Float64Array(TAX_IN);
    const total = (status: 0 | 1, x: Float64Array) => {
      federalTaxInto(published.tax, taxOffset(0, status), x, r);
      return r[TO.TOTAL]!;
    };
    const tol = 1e-7;
    let checks = 0;
    for (let n = 0; n < 20000; n++) {
      const { status, x } = household(rand);
      const base = total(status, x);
      const step = (names: readonly TaxInputName[]) => {
        bumped.set(x);
        for (const name of names) bumped[TI[name]] = x[TI[name]]! + 10;
        return total(status, bumped);
      };
      for (const name of raising) {
        const t = step([name]);
        if (t < base - tol) throw new Error(`K1: ${name} +10 lowered TOTAL ${base} → ${t} on ${Array.from(x)}`);
        checks++;
      }
      // Ordinary dividends with their qualified part raised together.
      if (step(["ORD_DIV", "QUAL_DIV"]) < base - tol) throw new Error(`K1: ORD_DIV and QUAL_DIV +10 lowered TOTAL on ${Array.from(x)}`);
      for (const name of lowering) {
        const t = step([name]);
        if (t > base + tol) throw new Error(`K1: ${name} +10 raised TOTAL ${base} → ${t} on ${Array.from(x)}`);
        checks++;
      }
      if (x[TI.ORD_DIV]! - x[TI.QUAL_DIV]! >= 10) {
        // QUAL_DIV alone: never raises TOTAL, except in the band of the amended K1 below, and there by at most
        // 10 × (15% − the ordinary rate at the margin).
        federalTaxInto(published.tax, taxOffset(0, status), x, r);
        const ordTaxable = r[TO.ORD_TAXABLE]!;
        const ordRate = r[TO.BRACKET_RATE]!;
        const o = taxOffset(0, status);
        const inBand = ordTaxable > published.tax[o + TR.LTCG0]! && ordRate < published.tax[o + TR.LTCG_RATE1]!;
        const t = step(["QUAL_DIV"]);
        const allowed = inBand ? 10 * (published.tax[o + TR.LTCG_RATE1]! - ordRate) : 0;
        if (t > base + allowed + tol) throw new Error(`K1: QUAL_DIV +10 raised TOTAL ${base} → ${t} on ${Array.from(x)}`);
        checks++;
      }
    }
    expect(checks).toBeGreaterThan(20000 * 19);
  });

  it("K1 (amended) QUAL_DIV alone can raise TOTAL where ordinary taxable income is above the 0% maximum but still in the 12% bracket", () => {
    // tax-rmd-ss §3.4 says TOTAL is non-increasing in QUAL_DIV alone. The worksheet says otherwise in one band:
    // 2026 single, ordinary taxable income in (49,450, 50,400], joint (98,900, 100,800]. There the 0% band is
    // already filled by ordinary income, so a dollar reclassified from ordinary to qualified dividends leaves
    // the 12% bracket and is taxed at 15%. Hand case, single 2026, no one aged:
    //   wages 66,000, ordinary dividends 10,100 of which 10,000 qualified: AGI 76,100, taxable 60,000,
    //   ordinary 50,000 → 1,240 + 12% × 37,600 = 5,752; gains 15% × 10,000 = 1,500 (line 9 is 0: 49,450 < 50,000);
    //   line 23 = 7,252 < line 24 = 5,800 + 22% × 9,600 = 7,912 → 7,252.00.
    //   All 10,100 qualified: ordinary 49,900 → 1,240 + 12% × 37,500 = 5,740; gains 15% × 10,100 = 1,515 → 7,255.00.
    // +3.00 for 100 dollars reclassified: (15% − 12%) × 100. This is the law, not a defect; a withdrawal solver
    // never moves QUAL_DIV, so nothing relies on the stronger claim.
    const base = taxOn(published, 2026, 0, taxInput({ WAGES: 66000, ORD_DIV: 10100, QUAL_DIV: 10000 }));
    const more = taxOn(published, 2026, 0, taxInput({ WAGES: 66000, ORD_DIV: 10100, QUAL_DIV: 10100 }));
    expect(Math.abs(base[TO.TOTAL]! - 7252)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(more[TO.TOTAL]! - 7255)).toBeLessThanOrEqual(0.005);
    // Below the band the 0% band absorbs the dollar and the tax falls: ordinary 49,000 (wages 65,100).
    const below = taxOn(published, 2026, 0, taxInput({ WAGES: 65100, ORD_DIV: 10100, QUAL_DIV: 10000 }));
    const belowMore = taxOn(published, 2026, 0, taxInput({ WAGES: 65100, ORD_DIV: 10100, QUAL_DIV: 10100 }));
    expect(belowMore[TO.TOTAL]!).toBeLessThan(below[TO.TOTAL]!);
  });
});

describe("K2 the slope a gross-up solver may rely on", () => {
  it("K2 the largest slope of TOTAL in TRAD_DIST over the scan of §3.4 is below 0.60 (the worst case is 0.52947)", () => {
    // 2026, single and joint, 0 to 2 people over 65; Social Security 0 to 60,000 and long-term gains 0 to 60,000
    // in steps of 10,000; withdrawals 0 to 400,000 in steps of 1,000; slope = ΔTOTAL / 1,000.
    const r = new Float64Array(TAX_OUT);
    let worst = { slope: 0, at: "" };
    for (const [status, nAgedMax] of [[0, 1], [1, 2]] as const) {
      for (let nAged = 0; nAged <= nAgedMax; nAged++) {
        for (let ss = 0; ss <= 60000; ss += 10000) {
          for (let gain = 0; gain <= 60000; gain += 10000) {
            const x = taxInput({ SS_GROSS: ss, LT_GAIN: gain, N_AGED: nAged });
            let previous = Number.NaN;
            for (let w = 0; w <= 401000; w += 1000) {
              x[TI.TRAD_DIST] = w;
              federalTaxInto(published.tax, taxOffset(0, status), x, r);
              const t = r[TO.TOTAL]!;
              if (w > 0) {
                const slope = (t - previous) / 1000;
                if (slope > worst.slope) worst = { slope, at: `status ${status}, ${nAged} aged, SS ${ss}, gain ${gain}, withdrawal ${w - 1000}` };
              }
              previous = t;
            }
          }
        }
      }
    }
    expect(worst.slope).toBeLessThan(0.6);
    // (12% + 15%) × 1.85 × 1.06 = 0.52947: in the 12% bracket a dollar of withdrawal makes 85 cents of benefits
    // taxable, pushes gains out of the 0% band and erodes the senior deduction (tax-rmd-ss §3.4).
    expect(worst.slope).toBeCloseTo(0.27 * 1.85 * 1.06, 9);
    expect(worst.at).toMatch(/^status 0, 1 aged, SS 40000, gain 10000, withdrawal /);
    // At the design's point (single, one aged, benefits 40,000, gain 10,000, withdrawal 36,000) the slope over the
    // next 1,000 is that maximum; so is the slope over the 1,000 before it (the scan records the first).
    const r0 = taxOn(published, 2026, 0, taxInput({ SS_GROSS: 40000, LT_GAIN: 10000, N_AGED: 1, TRAD_DIST: 36000 }));
    const r1 = taxOn(published, 2026, 0, taxInput({ SS_GROSS: 40000, LT_GAIN: 10000, N_AGED: 1, TRAD_DIST: 37000 }));
    expect((r1[TO.TOTAL]! - r0[TO.TOTAL]!) / 1000).toBeCloseTo(0.52947, 9);
  });
});

describe("K3 continuity at every threshold of a row", () => {
  it("K3 one cent below and one cent above a threshold the tax differs by less than one cent", () => {
    const failures: string[] = [];
    const check = (label: string, t: typeof published, year: number, status: 0 | 1, fields: Partial<Record<TaxInputName, number>>, moving: TaxInputName) => {
      const lo = taxInput({ ...fields, [moving]: (fields[moving] ?? 0) - 0.01 });
      const hi = taxInput({ ...fields, [moving]: (fields[moving] ?? 0) + 0.01 });
      const d = Math.abs(taxOn(t, year, status, hi)[TO.TOTAL]! - taxOn(t, year, status, lo)[TO.TOTAL]!);
      if (!(d < 0.01)) failures.push(`${label}: ${d}`);
    };
    for (const [t, year] of [[published, 2026], [published, 2027], [indexed, 2031], [indexed, 2037]] as const) {
      for (const status of [0, 1] as const) {
        const o = taxOffset(year - t.law.startYear, status);
        const slot = (k: number) => t.tax[o + k]!;
        const std = slot(TR.STD);
        const tag = `${year} ${status === 0 ? "single" : "joint"}`;
        // Bracket bounds: taxable income at each bound.
        for (let k = 1; k < N_BRACKETS; k++) check(`${tag} bracket ${k}`, t, year, status, { WAGES: std + slot(TR.THR0 + k) }, "WAGES");
        // The two gains thresholds: taxable income at the bound with 20,000 of gains on top of wages.
        for (const k of [TR.LTCG0, TR.LTCG15]) check(`${tag} gains ${k}`, t, year, status, { WAGES: std + slot(k) - 20000, LT_GAIN: 20000 }, "LT_GAIN");
        // The Social Security bases: provisional income at the base.
        for (const k of [TR.SS_BASE1, TR.SS_BASE2]) check(`${tag} SS base ${k}`, t, year, status, { SS_GROSS: 20000, PENSION: slot(k) - 10000, N_AGED: 1 }, "PENSION");
        // The senior phase-out start and end (AGI at start and at start + amount / rate), with every filer aged.
        const nAged = status + 1;
        if (slot(TR.SENIOR_AMT) > 0) {
          const start = slot(TR.SENIOR_START);
          const end = start + slot(TR.SENIOR_AMT) / slot(TR.SENIOR_RATE);
          for (const agi of [start, end]) check(`${tag} senior ${agi}`, t, year, status, { PENSION: agi, N_AGED: nAged }, "PENSION");
        }
        // The NIIT threshold: AGI at the threshold with 50,000 of interest.
        check(`${tag} NIIT`, t, year, status, { WAGES: slot(TR.NIIT_THRESHOLD) - 50000, INTEREST: 50000 }, "WAGES");
        // The loss limit: a net loss exactly at the limit.
        check(`${tag} loss limit`, t, year, status, { WAGES: 80000, LT_GAIN: -slot(TR.LOSS_LIMIT) }, "LT_GAIN");
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("K4 identities on random inputs", () => {
  /** Ordinary tax on z from the table slots, written independently of federalTax.ts. */
  const bracket = (t: Float64Array, o: number, z: number) => {
    let tax = 0;
    for (let k = 0; k < N_BRACKETS; k++) {
      const lo = t[o + TR.THR0 + k]!;
      const hi = t[o + TR.THR0 + k + 1]!;
      if (z > lo) tax += (Math.min(z, hi) - lo) * t[o + TR.RATE0 + k]!;
    }
    return tax;
  };
  const close = (a: number, b: number, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

  it("K4 the gain bands sum to preferential income, ordinary plus preferential is taxable income, 0 ≤ taxable SS ≤ 85%, income tax ≤ bracket(taxable income)", () => {
    const rand = generator(4);
    const r = new Float64Array(TAX_OUT);
    const bad: string[] = [];
    for (let n = 0; n < 20000; n++) {
      const { status, x } = household(rand);
      const t = n % 2 === 0 ? published : indexed;
      const year = n % 2 === 0 ? 2026 + (n % 4 === 0 ? 0 : 1) : 2026 + (n % 12);
      const o = taxOffset(year - t.law.startYear, status);
      federalTaxInto(t.tax, o, x, r);
      const v = (k: number) => r[k]!;
      if (!close(v(TO.PREF_AT_0) + v(TO.PREF_AT_15) + v(TO.PREF_AT_20), v(TO.PREF_INCOME))) bad.push(`bands ${n}`);
      if (!close(v(TO.ORD_TAXABLE) + v(TO.PREF_INCOME), v(TO.TAXABLE_INCOME))) bad.push(`taxable ${n}`);
      if (!(v(TO.TAXABLE_SS) >= 0 && v(TO.TAXABLE_SS) <= 0.85 * x[TI.SS_GROSS]! + 1e-9)) bad.push(`ss ${n}`);
      if (!(v(TO.INCOME_TAX) <= bracket(t.tax, o, v(TO.TAXABLE_INCOME)) + 1e-7)) bad.push(`line 24 ${n}`);
      if (!(v(TO.INCOME_TAX) >= v(TO.ORD_TAX) && v(TO.CG_TAX) >= 0)) bad.push(`cg ${n}`);
      if (!close(v(TO.TOTAL), v(TO.INCOME_TAX) + v(TO.NIIT) + v(TO.PEN10) + v(TO.PEN20))) bad.push(`total ${n}`);
      if (!close(v(TO.ORD_TAX), bracket(t.tax, o, v(TO.ORD_TAXABLE)))) bad.push(`ordinary ${n}`);
      const net = x[TI.ST_GAIN]! + x[TI.LT_GAIN]! - x[TI.LOSS_CARRY_IN]!;
      if (net < 0 && !close(v(TO.LOSS_USED) + v(TO.LOSS_CARRY_OUT), -net)) bad.push(`loss ${n}`);
      for (let k = 0; k < TAX_OUT; k++) if (k !== TO.ROOM_IN_BRACKET && !Number.isFinite(r[k]!)) bad.push(`finite ${n} ${k}`);
    }
    expect(bad).toEqual([]);
  });

  it("K4 Tax_f(x) = f × Tax(x / f) to 1e-9 relative for f in {1/12, …, 11/12}", () => {
    // federalTaxInto reads every dollar input as x[k] / f and multiplies every dollar output by f; the reference
    // divides outside, calls with a full year and multiplies the outputs by f.
    const rand = generator(1112);
    const rf = new Float64Array(TAX_OUT);
    const r1 = new Float64Array(TAX_OUT);
    const annual = new Float64Array(TAX_IN);
    const dollarOutputs = Object.values(TO).filter((k) => k !== TO.BRACKET_RATE && k !== TO.BRACKET_INDEX && k !== TO.LTCG_NEXT_RATE && k < TO.RESERVED0);
    const bad: string[] = [];
    for (let n = 0; n < 5000; n++) {
      const { status, x } = household(rand);
      const o = taxOffset(n % 2, status);
      for (let m = 1; m <= 11; m++) {
        const f = m / 12;
        x[TI.YEAR_FRACTION] = f;
        federalTaxInto(published.tax, o, x, rf);
        for (let k = 0; k < TI.N_AGED; k++) annual[k] = x[k]! / f;
        annual[TI.N_AGED] = x[TI.N_AGED]!;
        annual[TI.YEAR_FRACTION] = 1;
        federalTaxInto(published.tax, o, annual, r1);
        for (const k of dollarOutputs) {
          const expected = f * r1[k]!;
          if (!(rf[k] === expected || close(rf[k]!, expected))) bad.push(`n ${n} f ${m}/12 slot ${k}: ${rf[k]} vs ${expected}`);
        }
        for (const k of [TO.BRACKET_RATE, TO.BRACKET_INDEX, TO.LTCG_NEXT_RATE]) if (rf[k] !== r1[k]) bad.push(`n ${n} f ${m}/12 rate slot ${k}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
