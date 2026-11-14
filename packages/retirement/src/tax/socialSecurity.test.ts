import { SocialSecurityPreviewResponse } from "@meridian/shared";
import { describe, expect, it } from "vitest";
import { runsInOwnFile } from "../testIsolation.js";
import { buildSimInput } from "../testing/simInput.js";
import { fillPathTables } from "./compile.js";
import { PR, PROG_REC, SO, SO_REC, SS, SS_REC, TAX_REC, progOffset } from "./layout.js";
import {
  SS_RULES,
  compileSsPlan,
  floorDime,
  monthlyPayment,
  resetSsState,
  retirementFactor,
  roundCola,
  socialSecurityParts,
  socialSecurityPreviewView,
  socialSecurityYear,
  socialSecurityYearMonthLoop,
  spousalFactor,
  ssPersonInputs,
  ssRuleVerification,
  survivorFactor,
  type SsPersonInput,
  type SsPlan,
} from "./socialSecurity.js";
import { loadTaxData } from "./taxData.js";
import { pathTables } from "./testKit.js";

// tax-rmd-ss §3.9 and tests H1 to H17 (§7 H); the gate's HC-S1 and HC-S2 (strategies-outputs-web
// §7.5) and HC-S3 as re-derived in packages/retirement/reference/sheets/hand-cases.md (seams §10);
// seams C20, C21 and C37. Monthly dollars; "the program table with COLA 0 and scale 1 unless
// stated" (H): the real program table of the year with its COLA set to 0. Payments are whole
// dollars and asserted exactly; factors are exact rationals and equal the same fraction written
// in JavaScript (one correctly rounded division each).

const data = loadTaxData();
const INF = Number.POSITIVE_INFINITY;

/** Month number `year × 12 + month − 1` (clock.ts). */
const mo = (year: number, month: number) => year * 12 + month - 1;

interface Prog {
  readonly startYear: number;
  readonly prog: Float64Array;
}

/** The program table of `years` plan years from `startYear`; COLA 0 unless `keepCola`, or the COLAs given per calendar year. */
function progTable(
  startYear: number,
  years: number,
  o: { inflation?: number | number[]; keepCola?: boolean; cola?: Record<number, number>; ruleSetId?: string; ssAdjustment?: { fromYear: number; factor: number } } = {},
): Prog {
  const t = pathTables(data, {
    startYear,
    years,
    ...(o.inflation !== undefined ? { inflation: o.inflation } : {}),
    ...(o.ruleSetId !== undefined ? { ruleSetId: o.ruleSetId } : {}),
    ...(o.ssAdjustment !== undefined ? { ssAdjustment: o.ssAdjustment } : {}),
  });
  for (let i = 0; i < years; i++) {
    if (!o.keepCola) t.prog[progOffset(i) + PR.COLA] = 0;
    const c = o.cola?.[startYear + i];
    if (c !== undefined) t.prog[progOffset(i) + PR.COLA] = c;
  }
  return { startYear, prog: t.prog };
}

/** An `estimate` person: PIA (benefit at full retirement age) and claim age in months. */
function est(birthYear: number, birthMonth: number, pia: number, claimAgeMonths: number, asOfYear = 2026): SsPersonInput {
  return { mode: "estimate", birthYear, birthMonth, monthlyAtFra: pia, asOfYear, claimAgeMonths };
}

interface Household {
  readonly plan: SsPlan;
  readonly st: Float64Array;
}

function household(people: SsPersonInput[], startYear: number, o: { spousal?: boolean; survivor?: boolean } = {}): Household {
  const plan = compileSsPlan(people, { spousal: o.spousal ?? true, survivor: o.survivor ?? true, startYear });
  const st = new Float64Array(SS_REC);
  resetSsState(plan, st);
  return { plan, st };
}

interface YearOptions {
  deaths?: [number, number];
  wages?: [number, number];
  /** Defaults to the whole calendar year. */
  periodStart?: number;
  periodMonths?: number;
}

/** One plan year through `socialSecurityYear`; returns a copy of the SO record. */
function year(h: Household, p: Prog, y: number, o: YearOptions = {}): Float64Array {
  const out = new Float64Array(SO_REC);
  const [d0, d1] = o.deaths ?? [INF, INF];
  const [w0, w1] = o.wages ?? [0, 0];
  socialSecurityYear(h.plan, h.st, y, o.periodStart ?? y * 12, o.periodMonths ?? 12, p.prog, progOffset(y - p.startYear), d0, d1, w0, w1, out);
  return out;
}

/** The years `from` … `to` in order; the benefit of person `i` in each. */
function benefits(h: Household, p: Prog, from: number, to: number, i: 0 | 1, o: YearOptions = {}): number[] {
  const res: number[] = [];
  for (let y = from; y <= to; y++) res.push(year(h, p, y, o)[SO.BENEFIT + i]!);
  return res;
}

const pay = (h: Household, i: 0 | 1, m: number, deaths: [number, number] = [INF, INF]) => monthlyPayment(h.plan, h.st, i, m, deaths[0], deaths[1]);

describe("H1 to H4 factors", () => {
  it("H1 retirementFactor for full retirement age 804 at 62 to 70: 7/10, 3/4, 4/5, 13/15, 14/15, 1, 27/25, 29/25, 31/25", () => {
    // Early: 1 − (min(m, 36) × 5/900 + max(0, m − 36) × 5/1200), m = 60, 48, 36, 24, 12 (62: 0.2 + 0.1 → 7/10).
    // Late: 1 + months / 150 (68: 12/150 = 2/25 → 27/25).
    const ages = [744, 756, 768, 780, 792, 804, 816, 828, 840];
    expect(ages.map((c) => retirementFactor(c, 804))).toEqual([7 / 10, 3 / 4, 4 / 5, 13 / 15, 14 / 15, 1, 27 / 25, 29 / 25, 31 / 25]);
  });

  it("H2 full retirement age 802 (born 1959): 58 months early 1 − (20% + 22 × 5/12%) = 17/24; 38 months late 94/75", () => {
    expect(retirementFactor(744, 802)).toBe(17 / 24);
    expect(retirementFactor(840, 802)).toBe(94 / 75);
  });

  it("H3 month granularity at 804: 62y1m 169/240; 66y6m 29/30; 67y6m 26/25; 71 clamped to 31/25 (and 61 to 7/10)", () => {
    // 745: m = 59 → 1 − (0.2 + 23 × 5/1200) = 169/240. 798: 6 × 5/900 = 1/30. 810: 1 + 6/150.
    expect([745, 798, 810, 852, 732].map((c) => retirementFactor(c, 804))).toEqual([169 / 240, 29 / 30, 26 / 25, 31 / 25, 7 / 10]);
  });

  it("H4 spousalFactor for 804 at 62 to 67: 13/20, 7/10, 3/4, 5/6, 11/12, 1; survivorFactor 143/200 at 60, 223/280 at 62, 293/350 at 63, 1 at 67", () => {
    // Spousal: e = 60 → 36 × 25/3600 + 24 × 5/1200 = 0.25 + 0.1. Survivor: 1 − 0.285 × (804 − age) / 84.
    expect([744, 756, 768, 780, 792, 804].map((a) => spousalFactor(a, 804))).toEqual([13 / 20, 7 / 10, 3 / 4, 5 / 6, 11 / 12, 1]);
    expect([720, 744, 756, 804, 840].map((a) => survivorFactor(a, 804))).toEqual([143 / 200, 223 / 280, 293 / 350, 1, 1]);
  });

  it("every factor is non-decreasing in the claim age (K6's part for this module)", () => {
    for (const fra of [780, 792, 800, 802, 804]) {
      for (let c = 744; c < 840; c++) expect(retirementFactor(c + 1, fra)).toBeGreaterThanOrEqual(retirementFactor(c, fra));
    }
  });
});

describe("H5 and HC-S1 each claiming age with SSA's rounding", () => {
  it("H5 PIA 2,000.00, born January 1960: 1,400 1,500 1,600 1,733 1,866 2,000 2,160 2,320 2,480; born 1959: 1,416 and 2,506", () => {
    const paid = [744, 756, 768, 780, 792, 804, 816, 828, 840].map((c) => {
      const h = household([est(1960, 1, 2000, c)], 2026);
      return pay(h, 0, mo(1960, 1) + c);
    });
    // 65: 2,000 × 13/15 = 1,733.33 → 1,733.30 → $1,733; 66: 1,866.66 → 1,866.60 → $1,866.
    expect(paid).toEqual([1400, 1500, 1600, 1733, 1866, 2000, 2160, 2320, 2480]);
    expect(floorDime(2000 * retirementFactor(780, 804))).toBe(1733.3);
    expect(floorDime(2000 * retirementFactor(792, 804))).toBe(1866.6);
    // 1959 (full retirement age 802): 2,000 × 17/24 = 1,416.67 → 1,416.60; 2,000 × 94/75 = 2,506.67 → 2,506.60.
    expect(pay(household([est(1959, 1, 2000, 744)], 2026), 0, mo(2021, 1))).toBe(1416);
    expect(pay(household([est(1959, 1, 2000, 840)], 2026), 0, mo(2029, 1))).toBe(2506);
  });

  it("H5 a full later year pays twelve times the monthly amount: 20,796 at 65", () => {
    // Claimed January 2025 at 65; 2026 is a whole year in pay: 12 × 1,733.
    const h = household([est(1960, 1, 2000, 780)], 2026);
    expect(year(h, progTable(2026, 1), 2026)[SO.BENEFIT]).toBe(20796);
  });

  it("HC-S1 full retirement age 67, benefit 3,000: 62 → 2,100; 64 → 2,400; 65 → 2,600; 67 → 3,000; 70 → 3,720", () => {
    // 3,000 × 7/10, × 4/5, × 13/15 (2,600.0000000000005 → 2,600.00), × 1, × 31/25.
    const at = (c: number) => pay(household([est(1960, 1, 3000, c)], 2026), 0, mo(1960, 1) + c);
    expect([744, 768, 780, 804, 840].map(at)).toEqual([2100, 2400, 2600, 3000, 3720]);
  });
});

describe("H6 the January rule for delayed credits", () => {
  it("H6(a) born July 1960, claim at 68 (July 2028): 2028 pays 6 × 2,080 = 12,480; 2029 pays 12 × 2,160 = 25,920", () => {
    // Full retirement age July 2027; 12 credits, of which 12 × 2028 − fraIndex = 6 were earned before 2028.
    const h = household([est(1960, 7, 2000, 816, 2028)], 2028);
    expect(benefits(h, progTable(2028, 2), 2028, 2029, 0)).toEqual([12480, 25920]);
  });

  it("H6(b) born March 1960, claim at 70: the full 31/25 at once, 10 × 2,480 = 24,800 in 2030", () => {
    const h = household([est(1960, 3, 2000, 840, 2030)], 2030);
    expect(benefits(h, progTable(2030, 1), 2030, 2030, 0)).toEqual([24800]);
  });

  it("H6(c) born November 1960, claim at 69 (November 2029): 14 of 24 credits before 2029, $2,186 for 2 months (4,372); 2030 $2,320 a month", () => {
    // 2,000 × (1 + 14/150) = 2,186.67 → 2,186.60 → $2,186; 2030: 2,000 × 29/25 = 2,320.
    const h = household([est(1960, 11, 2000, 828, 2029)], 2029);
    expect(benefits(h, progTable(2029, 2), 2029, 2030, 0)).toEqual([4372, 27840]);
  });
});

describe("H7 and HC-S2 spousal (worker PIA 2,400 unless stated; every full retirement age 67)", () => {
  // Worker p0 born January 1960; spouse p1 born January 1962 (62 in January 2024).
  const worker = (claimAge: number, pia = 2400) => est(1960, 1, pia, claimAge);

  it("H7(a) spouse PIA 600, both in pay when the spouse is 62: own 420.00, excess 600 × 13/20 = 390.00, paid $810", () => {
    expect(pay(household([worker(744), est(1962, 1, 600, 744)], 2026), 1, mo(2024, 1))).toBe(810);
  });

  it("H7(b) the spouse claims at 67: 600 + 600 = $1,200 (150% of the worker's PIA in total: ss_family_maximum)", () => {
    expect(pay(household([worker(744), est(1962, 1, 600, 804)], 2026), 1, mo(2029, 1))).toBe(1200);
  });

  it("H7(c) spouse PIA 0 at 62: 1,200 × 13/20 = $780", () => {
    expect(pay(household([worker(744), est(1962, 1, 0, 744)], 2026), 1, mo(2024, 1))).toBe(780);
  });

  it("H7(d) the spouse claims own at 62, the worker when the spouse is 65: own 420.00, factor 5/6, excess 500.00, paid $920", () => {
    // The worker claims in January 2027 (age 67); before that the spouse is paid her own 420.
    const h = household([worker(804), est(1962, 1, 600, 744)], 2026);
    expect(pay(h, 1, mo(2026, 12))).toBe(420);
    expect(pay(h, 1, mo(2027, 1))).toBe(920);
  });

  it("H7(e) own PIA 1,000 claimed at 70 (1,240.00), worker PIA 2,600: excess 1,300 − 1,240 = 60; paid $1,300", () => {
    expect(pay(household([worker(744, 2600), est(1962, 1, 1000, 840)], 2026), 1, mo(2032, 1))).toBe(1300);
  });

  it("H7(f) spouse PIA 800, both at 62: own 560.00, excess 400 × 13/20 = 260.00, paid $820 (9,840 a year)", () => {
    const h = household([worker(744), est(1962, 1, 800, 744)], 2026);
    expect(pay(h, 1, mo(2024, 1))).toBe(820);
    expect(year(h, progTable(2026, 1), 2026)[SO.BENEFIT + 1]).toBe(9840);
  });

  it("H7(g) spouse PIA 800 claims own at 62, the worker when the spouse is 66: 400 × 11/12 = 366.67 → 366.60; paid $926", () => {
    // The worker claims in January 2028, at 68 (816 months).
    expect(pay(household([worker(816), est(1962, 1, 800, 744)], 2026), 1, mo(2028, 1))).toBe(926);
  });

  it("H7(h) a start inside the year: 2027 pays 6 × $420 + 6 × $945 = 8,190", () => {
    // Spouse born January 1962, PIA 600, claimed at 62; worker born July 1960 claims at 67 (July 2027),
    // when the spouse is 65 years 6 months: e = 18, factor 1 − 18 × 25/3600 = 7/8, excess 600 × 7/8 = 525.00.
    const h = household([est(1960, 7, 2400, 804, 2027), est(1962, 1, 600, 744, 2027)], 2027);
    const out = year(h, progTable(2027, 1), 2027);
    expect(out[SO.BENEFIT + 1]).toBe(8190);
    expect(out[SO.SPOUSAL + 1]).toBe(6 * 525);
    expect(out[SO.MONTHS_PAID + 1]).toBe(12);
    expect(h.st[SS.SPOUSAL_FACTOR + 1]).toBe(7 / 8);
  });

  it("HC-S2 worker 3,000, spouse's own 800, both at full retirement age: $1,500; a spousal benefit of 1,000 claimed at 62: 650.00", () => {
    // 800 + (1,500 − 800) × 1. Worker PIA 2,000, spouse PIA 0 at 62: 1,000 × 13/20 = 650.00.
    expect(pay(household([est(1962, 1, 3000, 804), est(1962, 1, 800, 804)], 2026), 1, mo(2029, 1))).toBe(1500);
    expect(pay(household([est(1960, 1, 2000, 744), est(1962, 1, 0, 744)], 2026), 1, mo(2024, 1))).toBe(650);
  });
});

describe("H8 survivor (deceased PIA 2,000)", () => {
  it("H8(a) the deceased claimed at 62 (7/10); survivor past survivor full retirement age: min(2,000, max(1,400, 1,650)) = $1,650", () => {
    // Deceased p0 born January 1960, claimed January 2022, dies at the end of 2030. Survivor p1 born
    // January 1960 (survivor full retirement age 800), 71 in January 2031; own PIA 0.
    const h = household([est(1960, 1, 2000, 744), est(1960, 1, 0, 744)], 2026);
    expect(pay(h, 1, mo(2031, 1), [2030, INF])).toBe(1650);
    expect(h.st[SS.DECEASED_FACTOR]).toBe(7 / 10);
  });

  it("H8(b) the deceased claimed at 70: $2,480, also for a survivor whose own benefit is 1,200", () => {
    const zero = household([est(1960, 1, 2000, 840), est(1960, 1, 0, 744)], 2026);
    expect(pay(zero, 1, mo(2031, 1), [2030, INF])).toBe(2480);
    const own = household([est(1960, 1, 2000, 840), est(1960, 1, 1200, 804)], 2026);
    expect(pay(own, 1, mo(2030, 12), [2030, INF])).toBe(1200);
    expect(pay(own, 1, mo(2031, 1), [2030, INF])).toBe(2480);
  });

  it("H8(c) the deceased died before claiming and before full retirement age; survivor 60 at the start: 2,000 × 143/200 = $1,430", () => {
    // Deceased born January 1970 (full retirement age 2037), dies at the end of 2030; survivor born January 1971.
    const h = household([est(1970, 1, 2000, 804), est(1971, 1, 0, 804)], 2026);
    expect(pay(h, 1, mo(2031, 1), [2030, INF])).toBe(1430);
    expect(h.st[SS.DECEASED_FACTOR]).toBe(1);
  });

  it("H8(d) the survivor 63 at the start: 2,000 × 293/350 = 1,674.29 → 1,674.20, paid $1,674", () => {
    const h = household([est(1970, 1, 2000, 804), est(1968, 1, 0, 804)], 2026);
    expect(pay(h, 1, mo(2031, 1), [2030, INF])).toBe(1674);
  });

  it("H8(e) case (a) with the survivor 63: min(1,674.29, 1,650) = $1,650 (reduced for age, then capped)", () => {
    const h = household([est(1960, 1, 2000, 744), est(1968, 1, 0, 804)], 2026);
    expect(pay(h, 1, mo(2031, 1), [2030, INF])).toBe(1650);
  });

  it("H8(f) the deceased born July 1960, unclaimed, dies at the end of 2028: 18 credit months, factor 28/25, $2,240", () => {
    // July 2027 (full retirement age) to January 2029: 18 months; 1 + 18/150 = 28/25.
    const h = household([est(1960, 7, 2000, 840), est(1955, 1, 0, 804)], 2026);
    expect(pay(h, 1, mo(2029, 1), [2028, INF])).toBe(2240);
    expect(h.st[SS.DECEASED_FACTOR]).toBe(28 / 25);
  });

  it("H8(g) survivor born January 1966, own PIA 1,500 claimed at 70: $1,592 (19,104 a year) through 2035, then $1,860 (22,320)", () => {
    // The deceased (born January 1962, full retirement age January 2029) dies at the end of 2027 unclaimed.
    // From January 2028 at 62: 223/280 × 2,000 = 1,592.86 → 1,592.80. From January 2036: 1,500 × 31/25 = 1,860.
    const h = household([est(1962, 1, 2000, 804, 2028), est(1966, 1, 1500, 840, 2028)], 2028);
    const p = progTable(2028, 9);
    const b = benefits(h, p, 2028, 2036, 1, { deaths: [2027, INF] });
    expect(b[0]).toBe(19104);
    expect(b[7]).toBe(19104);
    expect(b[8]).toBe(22320);
    expect(year(h, p, 2036, { deaths: [2027, INF] })[SO.SURVIVOR + 1]).toBe(0);
  });

  it("H8(h) survivor born May 1968; the deceased dies at the end of 2026: nothing in 2027; 2028 pays 8 × $1,430 = 11,440 from May", () => {
    const h = household([est(1966, 1, 2000, 804, 2027), est(1968, 5, 0, 804, 2027)], 2027);
    const p = progTable(2027, 2);
    const y2027 = year(h, p, 2027, { deaths: [2026, INF] });
    const y2028 = year(h, p, 2028, { deaths: [2026, INF] });
    expect(y2027[SO.BENEFIT + 1]).toBe(0);
    expect(y2028[SO.BENEFIT + 1]).toBe(11440);
    expect(y2028[SO.SURVIVOR + 1]).toBe(11440);
    expect(y2028[SO.MONTHS_PAID + 1]).toBe(8);
  });

  it("H8(i) the couple of H7(f), the worker dies at the end of 2030: December 2030 pays $820; from 2031 $1,980", () => {
    // From 2031: min(2,400, max(1,680, 1,980)); the spouse (born 1962) is past her survivor full retirement age.
    const h = household([est(1960, 1, 2400, 744, 2030), est(1962, 1, 800, 744, 2030)], 2030);
    const p = progTable(2030, 2);
    const y2030 = year(h, p, 2030, { deaths: [2030, INF] });
    expect(y2030[SO.BENEFIT + 1]).toBe(12 * 820);
    expect(pay(h, 1, mo(2030, 12), [2030, INF])).toBe(820);
    const y2031 = year(h, p, 2031, { deaths: [2030, INF] });
    expect(y2031[SO.BENEFIT + 1]).toBe(12 * 1980);
    // The parts: the survivor part adds 1,980 − 560 a month over the own benefit; the dead worker is paid nothing.
    expect(y2031[SO.SURVIVOR + 1]).toBe(12 * (1980 - 560));
    expect(y2031[SO.SPOUSAL + 1]).toBe(0);
    expect(y2031[SO.BENEFIT]).toBe(0);
  });
});

describe("H9 COLA (seams C20)", () => {
  it("H9 the chain of §3.9.6: 2,000.00 → 2,072.00 → 2,121.70 → 2,121.70 → 2,142.90", () => {
    // 2027 published 3.6%: 2,072.00. Path inflation 2.44% in 2027 → 2.4% for 2028: 2,121.728 → 2,121.70.
    // −1.0% in 2028: no COLA for 2029. +2.0% in 2029: 1.0244 × 0.99 × 1.02 = 1.03443912 against the
    // high-water 1.0244, a rise of 0.98%, so 1.0% for 2030: 2,142.917 → 2,142.90.
    const p = progTable(2026, 5, { keepCola: true, inflation: [0.03, 0.0244, -0.01, 0.02, 0] });
    expect([2026, 2027, 2028, 2029, 2030].map((y) => p.prog[progOffset(y - 2026) + PR.COLA])).toEqual([0.028, 0.036, 0.024, 0, 0.01]);
    const h = household([est(1962, 1, 2000, 744)], 2026);
    const pias: number[] = [];
    for (let y = 2026; y <= 2030; y++) {
      year(h, p, y);
      pias.push(h.st[SS.PIA]!);
    }
    expect(pias).toEqual([2000, 2072, 2121.7, 2121.7, 2142.9]);
  });

  it("H9 the statement year: 2,000 as of 2025 is 2,056.00 at a 2026 start and 2,130.00 at a 2027 start (2,130.016 truncated)", () => {
    expect(compileSsPlan([est(1962, 1, 2000, 804, 2025)], { spousal: true, survivor: true, startYear: 2026 }).people[0]!.piaAtStart).toBe(2056);
    expect(compileSsPlan([est(1962, 1, 2000, 804, 2025)], { spousal: true, survivor: true, startYear: 2027 }).people[0]!.piaAtStart).toBe(2130);
  });

  it("H9 rounding: a rise of 0.049% gives no COLA; 0.05% gives 0.1% (the half step in float64 is 0.000499999999999945)", () => {
    expect(roundCola(0.00049, 0.001)).toBe(0);
    expect(roundCola(1.0005 - 1, 0.001)).toBe(0.001);
    expect(roundCola(0.0244, 0.001)).toBe(0.024);
    expect(roundCola(-0.01, 0.001)).toBe(0);
    const cola2028 = (pi: number) => progTable(2026, 3, { keepCola: true, inflation: [0, pi, 0] }).prog[progOffset(2) + PR.COLA];
    expect(cola2028(0.00049)).toBe(0);
    expect(cola2028(0.0005)).toBe(0.001);
    expect(cola2028(0.0025)).toBe(0.003);
  });

  it("H9 stale years: a plan from 2029 carries a 2027 statement by 2.5% twice, as fillPathTables does", () => {
    // 2,000 × 1.025 = 2,050.00; × 1.025 = 2,101.25 → 2,101.20. The program table's 2029 COLA is the same 2.5%.
    expect(compileSsPlan([est(1962, 1, 2000, 804, 2027)], { spousal: true, survivor: true, startYear: 2029 }).people[0]!.piaAtStart).toBe(2101.2);
    expect(progTable(2029, 1, { keepCola: true }).prog[PR.COLA]).toBe(0.025);
  });

  it("seams §4: the fixture's PIAs 2,800 and 1,900 of 2026 are 2,900.80 and 1,968.40 in 2027; no spousal excess (1,450.40 < 1,968.40)", () => {
    const h = household([est(1975, 6, 2800, 804), est(1977, 9, 1900, 804)], 2026);
    year(h, progTable(2026, 2, { keepCola: true }), 2027);
    expect([h.st[SS.PIA], h.st[SS.PIA + 1]]).toEqual([2900.8, 1968.4]);
    // In 2050 both are in pay and Sam's spousal part is 0.
    const later = household([est(1975, 6, 2800, 804), est(1977, 9, 1900, 804)], 2050);
    expect(year(later, progTable(2050, 1), 2050)[SO.SPOUSAL + 1]).toBe(0);
  });
});

describe("H10 earnings test (PIA 2,000 claimed at 62, $1,400 a month)", () => {
  it("H10(a) born January 1963, 2026, wages 40,000: (40,000 − 24,480) ÷ 2 = 7,760 withheld of 16,800; 6 months; then 29/40 and $1,450", () => {
    const h = household([est(1963, 1, 2000, 744)], 2026);
    const out = year(h, progTable(2026, 1), 2026, { wages: [40000, 0] });
    expect(out[SO.WITHHELD]).toBe(7760);
    expect(out[SO.BENEFIT]).toBe(9040);
    expect(out[SO.MONTHS_PAID]).toBe(6);
    expect(h.st[SS.ARF_MONTHS]).toBe(6);
    // From full retirement age (January 2030) the factor is that of a claim at 62 years 6 months: 29/40.
    expect(retirementFactor(750, 804)).toBe(29 / 40);
    expect(pay(h, 0, mo(2030, 1))).toBe(1450);
    expect(pay(h, 0, mo(2029, 12))).toBe(1400);
  });

  it("H10(b) born July 1960, 2027, wages 180,000: counted 90,000; (90,000 − 67,920) ÷ 3 = 7,360 of 8,400; July to December $1,450; 9,740", () => {
    const h = household([est(1960, 7, 2000, 744, 2027)], 2027);
    const out = year(h, progTable(2027, 1), 2027, { wages: [180000, 0] });
    expect(out[SO.WITHHELD]).toBe(7360);
    expect(h.st[SS.ARF_MONTHS]).toBe(6);
    expect(out[SO.BENEFIT]).toBe(8400 - 7360 + 6 * 1450);
    expect(out[SO.BENEFIT]).toBe(9740);
  });

  it("H10(c) the same with wages 90,000: counted 45,000, nothing withheld, 16,800", () => {
    const h = household([est(1960, 7, 2000, 744, 2027)], 2027);
    const out = year(h, progTable(2027, 1), 2027, { wages: [90000, 0] });
    expect([out[SO.WITHHELD], out[SO.BENEFIT], h.st[SS.ARF_MONTHS]]).toEqual([0, 16800, 0]);
  });

  it("H10(d) plan year 0 of November and December 2026 (f = 2/12), wages 10,000: (10,000 − 4,080) ÷ 2 = 2,960, capped at 2,800: 0, 2 months", () => {
    const h = household([est(1963, 1, 2000, 744)], 2026);
    const out = year(h, progTable(2026, 1), 2026, { wages: [10000, 0], periodStart: mo(2026, 11), periodMonths: 2 });
    expect([out[SO.WITHHELD], out[SO.BENEFIT], out[SO.MONTHS_PAID], h.st[SS.ARF_MONTHS]]).toEqual([2800, 0, 0, 2]);
  });

  it("H10(e) (a) with wages 60,000: 17,760 exceeds the 16,800 payable: all withheld, 12 months", () => {
    const h = household([est(1963, 1, 2000, 744)], 2026);
    const out = year(h, progTable(2026, 1), 2026, { wages: [60000, 0] });
    expect([out[SO.WITHHELD], out[SO.BENEFIT], out[SO.MONTHS_PAID], h.st[SS.ARF_MONTHS]]).toEqual([16800, 0, 0, 12]);
  });
});

describe("H11 months (seams C21)", () => {
  it("H11 born June 1964, claim at 62 (June 2026): 2026 pays 7 × 1,400 = 9,800 and 2027 16,800", () => {
    const h = household([est(1964, 6, 2000, 744)], 2026);
    expect(benefits(h, progTable(2026, 2), 2026, 2027, 0)).toEqual([9800, 16800]);
  });

  it("H11 receiving 1,400 since June 2026 (PIA 1,400 ÷ 7/10 = 2,000), plan from November 2026: year 0 pays 2,800, not seven months × f", () => {
    const plan = compileSsPlan([{ mode: "receiving", birthYear: 1964, birthMonth: 6, monthly: 1400, asOfYear: 2026, startedIndex: mo(2026, 6) }], {
      spousal: true,
      survivor: true,
      startYear: 2026,
    });
    expect(plan.people[0]!.piaAtStart).toBe(2000);
    expect(plan.people[0]!.claimAge).toBe(744);
    const st = new Float64Array(SS_REC);
    resetSsState(plan, st);
    const out = year({ plan, st }, progTable(2026, 1), 2026, { periodStart: mo(2026, 11), periodMonths: 2 });
    expect([out[SO.BENEFIT], out[SO.MONTHS_PAID]]).toEqual([2800, 2]);
  });

  it("C21 the fixture's claims in June 2042 and September 2044 pay 7 and 4 months in their first years", () => {
    // Alex (born June 1975) 2,800 a month, Sam (born September 1977) 1,900; COLA 0 to keep the counts plain.
    const h = household([est(1975, 6, 2800, 804, 2042), est(1977, 9, 1900, 804, 2042)], 2042);
    const p = progTable(2042, 3);
    const y2042 = year(h, p, 2042);
    year(h, p, 2043);
    const y2044 = year(h, p, 2044);
    expect([y2042[SO.BENEFIT], y2042[SO.MONTHS_PAID], y2042[SO.BENEFIT + 1]]).toEqual([7 * 2800, 7, 0]);
    expect([y2044[SO.BENEFIT + 1], y2044[SO.MONTHS_PAID + 1]]).toEqual([4 * 1900, 4]);
  });
});

describe("H12 the scale (law changes and the plan's adjustment)", () => {
  it("H12 ss_shortfall_2033: 1 in 2032, 0.78 in 2033 (30,000 pays 23,400); with { fromYear 2035, factorBp 9000 } 0.702 in 2035", () => {
    const p = progTable(2032, 4, { ruleSetId: "ss_shortfall_2033", ssAdjustment: { fromYear: 2035, factor: 0.9 } });
    expect([2032, 2033, 2034, 2035].map((y) => p.prog[progOffset(y - 2032) + PR.SS_SCALE])).toEqual([1, 0.78, 0.78, 0.78 * 0.9]);
    const h = household([est(1962, 1, 2500, 804, 2032)], 2032);
    const b = benefits(h, p, 2032, 2035, 0);
    expect(b[0]).toBe(30000);
    expect(b[1]).toBeCloseTo(23400, 6);
    expect(b[3]).toBeCloseTo(30000 * 0.702, 6);
  });
});

describe("H13 switches", () => {
  it("H13 spousal false: H7(a) pays $420; survivor false: H8(i) pays $560 from 2031; a partner of mode none gives and receives neither part", () => {
    expect(pay(household([est(1960, 1, 2400, 744), est(1962, 1, 600, 744)], 2026, { spousal: false }), 1, mo(2024, 1))).toBe(420);
    const h = household([est(1960, 1, 2400, 744, 2030), est(1962, 1, 800, 744, 2030)], 2030, { survivor: false });
    expect(year(h, progTable(2030, 2), 2031, { deaths: [2030, INF] })[SO.BENEFIT + 1]).toBe(12 * 560);
    const none: SsPersonInput = { mode: "none", birthYear: 1960, birthMonth: 1 };
    const withNone = household([none, est(1962, 1, 600, 744)], 2026);
    expect(pay(withNone, 1, mo(2024, 1))).toBe(420);
    expect(pay(withNone, 1, mo(2031, 1), [2030, INF])).toBe(420);
    expect(pay(withNone, 0, mo(2024, 1))).toBe(0);
    const out = year(withNone, progTable(2026, 1), 2026);
    expect([out[SO.BENEFIT], out[SO.BENEFIT + 1]]).toEqual([0, 12 * 420]);
  });
});

describe("H14 compile", () => {
  it("H14 receiving with monthlyAtFra uses it unchanged; without it the PIA is backed out of the benefit", () => {
    const base = { mode: "receiving" as const, birthYear: 1962, birthMonth: 1, monthly: 1500, asOfYear: 2026, startedIndex: mo(2024, 1) };
    const o = { spousal: true, survivor: true, startYear: 2026 };
    expect(compileSsPlan([{ ...base, monthlyAtFra: 2100 }], o).people[0]!.piaAtStart).toBe(2100);
    expect(compileSsPlan([base], o).people[0]!.piaAtStart).toBeCloseTo(1500 / 0.7, 9);
  });

  it("H14 an asOfYear of 2010 is treated as 2016 and raises ss_statement_old; 1,000 then carries to 1,354.40 at a 2026 start", () => {
    // 2017 0.3% 1,003.00; 2018 2.0% 1,023.06 → 1,023.00; 2019 2.8% 1,051.64 → 1,051.60; 2020 1.6% 1,068.43 → 1,068.40;
    // 2021 1.3% 1,082.29 → 1,082.20; 2022 5.9% 1,146.05 → 1,146.00; 2023 8.7% 1,245.70; 2024 3.2% 1,285.56 → 1,285.50;
    // 2025 2.5% 1,317.64 → 1,317.60; 2026 2.8% 1,354.49 → 1,354.40 (the history is secondary, not primary).
    const plan = compileSsPlan([est(1962, 1, 1000, 804, 2010)], { spousal: true, survivor: true, startYear: 2026 });
    expect(plan.people[0]!.piaAtStart).toBe(1354.4);
    expect(plan.warnings.map((w) => w.code)).toEqual(["ss_statement_old"]);
    expect(compileSsPlan([est(1962, 1, 1000, 804, 2016)], { spousal: true, survivor: true, startYear: 2026 }).people[0]!.piaAtStart).toBe(1354.4);
    expect(compileSsPlan([est(1962, 1, 1000, 804, 2016)], { spousal: true, survivor: true, startYear: 2026 }).warnings).toEqual([]);
    // A statement after the start year is treated as the start year's.
    expect(compileSsPlan([est(1962, 1, 1000, 804, 2030)], { spousal: true, survivor: true, startYear: 2026 }).people[0]!.piaAtStart).toBe(1000);
  });

  it("the compiled person: indices on the plan clock, credits, mode none", () => {
    const plan = compileSsPlan([est(1960, 7, 2000, 816), { mode: "none", birthYear: 1963, birthMonth: 4 }], { spousal: true, survivor: true, startYear: 2026 });
    expect(plan.people[0]).toMatchObject({ birthIndex: mo(1960, 7), fra: 804, survivorFra: 800, fraIndex: mo(2027, 7), claimAge: 816, claimIndex: mo(2028, 7), claimYear: 2028, totalCreditMonths: 12 });
    expect(plan.people[1]).toMatchObject({ claimIndex: INF, piaAtStart: 0 });
    expect(() => compileSsPlan([est(1960, 7, 2000, 900)], { spousal: true, survivor: true, startYear: 2026 })).toThrow(RangeError);
    expect(() => compileSsPlan([], { spousal: true, survivor: true, startYear: 2026 })).toThrow(RangeError);
  });
});

describe("H15 the deceased's PIA keeps its COLAs", () => {
  it("H15 H8(a) after a 2.5% COLA: PIA 2,050.00; min(2,050, max(1,435, 1,691.25)) = 1,691.25 → 1,691.20, paid $1,691", () => {
    const h = household([est(1960, 1, 2000, 744, 2030), est(1960, 1, 0, 744, 2030)], 2030);
    const p = progTable(2030, 2, { cola: { 2031: 0.025 } });
    year(h, p, 2030, { deaths: [2030, INF] });
    const out = year(h, p, 2031, { deaths: [2030, INF] });
    expect(h.st[SS.PIA]).toBe(2050);
    expect(out[SO.BENEFIT + 1]).toBe(12 * 1691);
  });
});

describe("HC-S3 survivor and cost-of-living with SSA's rounding (reference/sheets/hand-cases.md)", () => {
  it("HC-S3(a) R2: the widow's benefit in 2035 is 12 × 3,045 = 36,540.00 (superseded 36,552.09)", () => {
    // Person 1 born January 1958, receiving 2,500.00 since his full retirement age (September 2024),
    // monthlyAtFra 2,500.00, dies at the end of 2034. Person 2 born January 1961, 1,500.00 at 67
    // (January 2028). COLA 2.5% from 2028 (inflation 2.5%; 2027's published 3.6% is inside the 2027 amounts).
    // PIA 1: 2,562.5, 2,626.5, 2,692.1, 2,759.4, 2,828.3, 2,899.0, 2,971.4, 3,045.6 (2028 … 2035);
    // PIA 2 in 2035: 1,827.1. Widow's benefit: d = 1, survivor factor 1 (888 months against 802): 3,045.60.
    const h = household(
      [
        { mode: "receiving", birthYear: 1958, birthMonth: 1, monthly: 2500, monthlyAtFra: 2500, asOfYear: 2027, startedIndex: mo(2024, 9) },
        est(1961, 1, 1500, 804, 2027),
      ],
      2027,
    );
    const p = progTable(2027, 9, { keepCola: true, inflation: 0.025 });
    const rows: number[][] = [];
    for (let y = 2027; y <= 2035; y++) {
      const out = year(h, p, y, { deaths: [2034, INF] });
      rows.push([out[SO.BENEFIT]!, out[SO.BENEFIT + 1]!]);
    }
    expect(rows[0]).toEqual([30000, 0]);
    expect(rows[1]).toEqual([30744, 18444]);
    expect(h.st[SS.PIA]).toBe(3045.6);
    expect(h.st[SS.PIA + 1]).toBe(1827.1);
    expect(rows[8]).toEqual([0, 36540]);
  });

  it("HC-S3(b) R1: a PIA of 3,000.00 as of 2027 in pay all of 2029 pays 12 × 3,151 = 37,812.00 (superseded 37,822.50); with B 60,504.00", () => {
    // 3,000 → 3,075.0 → 3,151.875 → 3,151.8; B: 1,800 → 1,845.0 → 1,891.125 → 1,891.1, 12 × 1,891 = 22,692.
    const h = household([est(1962, 1, 3000, 804, 2027), est(1962, 1, 1800, 804, 2027)], 2027);
    const p = progTable(2027, 3, { keepCola: true, inflation: 0.025 });
    year(h, p, 2027);
    year(h, p, 2028);
    const out = year(h, p, 2029);
    expect([out[SO.BENEFIT], out[SO.BENEFIT + 1]]).toEqual([37812, 22692]);
    expect(out[SO.BENEFIT]! + out[SO.BENEFIT + 1]!).toBe(60504);
  });
});

/** mulberry32: a small seeded generator for the property tests (deterministic, test only). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("H16 the shortcut equals the month loop", () => {
  const YEARS = 45;

  function randomCouple(r: () => number, startYear: number) {
    const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
    const person = (): SsPersonInput => {
      const birthYear = int(1950, 1975);
      const birthMonth = int(1, 12);
      const u = r();
      if (u < 0.12) return { mode: "none", birthYear, birthMonth };
      if (u < 0.3) {
        const started = birthYear * 12 + birthMonth - 1 + int(744, 840);
        const p: SsPersonInput = { mode: "receiving", birthYear, birthMonth, monthly: int(0, 35000) / 10, asOfYear: startYear, startedIndex: started };
        if (r() < 0.5) p.monthlyAtFra = int(0, 35000) / 10;
        return p;
      }
      return est(birthYear, birthMonth, r() < 0.1 ? 0 : int(1, 40000) / 10, int(744, 840), int(2010, startYear + 1));
    };
    const people = [person(), person()];
    const death = () => (r() < 0.3 ? INF : int(startYear, startYear + YEARS));
    const deaths: [number, number] = [death(), death()];
    const wages = Array.from({ length: YEARS }, () => [r() < 0.5 ? 0 : int(0, 90000), r() < 0.5 ? 0 : int(0, 90000)] as [number, number]);
    const inflation = Array.from({ length: YEARS }, () => -0.02 + 0.08 * r());
    return { people, deaths, wages, inflation, spousal: r() < 0.85, survivor: r() < 0.85 };
  }

  it("H16 500 seeded couples: the shortcut equals the month loop in every year (benefits, parts, months and state)", () => {
    const r = rng(20261113);
    for (let c = 0; c < 500; c++) {
      const startYear = c % 2 === 0 ? 2026 : 2027;
      const firstMonth = c % 3 === 0 ? 11 : 1;
      const k = randomCouple(r, startYear);
      const plan = compileSsPlan(k.people, { spousal: k.spousal, survivor: k.survivor, startYear });
      const p = progTable(startYear, YEARS, { keepCola: true, inflation: k.inflation });
      const a = new Float64Array(SS_REC);
      const b = new Float64Array(SS_REC);
      resetSsState(plan, a);
      resetSsState(plan, b);
      const outA = new Float64Array(SO_REC);
      const outB = new Float64Array(SO_REC);
      for (let t = 0; t < YEARS; t++) {
        const y = startYear + t;
        const ps = t === 0 ? mo(y, firstMonth) : y * 12;
        const pm = t === 0 ? 13 - firstMonth : 12;
        const [w0, w1] = k.wages[t]!;
        socialSecurityYear(plan, a, y, ps, pm, p.prog, progOffset(t), k.deaths[0], k.deaths[1], w0, w1, outA);
        socialSecurityYearMonthLoop(plan, b, y, ps, pm, p.prog, progOffset(t), k.deaths[0], k.deaths[1], w0, w1, outB);
        expect(Array.from(outA), `couple ${c}, ${y}`).toEqual(Array.from(outB));
        expect(Array.from(a), `couple ${c}, ${y} state`).toEqual(Array.from(b));
      }
    }
  });

  it("H16 with wages 0, the twelve single-month periods of a year sum to the annual call", () => {
    const r = rng(7);
    for (let c = 0; c < 500; c++) {
      const startYear = 2026;
      const k = randomCouple(r, startYear);
      const plan = compileSsPlan(k.people, { spousal: k.spousal, survivor: k.survivor, startYear });
      const p = progTable(startYear, YEARS, { keepCola: true, inflation: k.inflation });
      const annual = new Float64Array(SS_REC);
      const monthly = new Float64Array(SS_REC);
      resetSsState(plan, annual);
      resetSsState(plan, monthly);
      const outA = new Float64Array(SO_REC);
      const outM = new Float64Array(SO_REC);
      for (let t = 0; t < YEARS; t++) {
        const y = startYear + t;
        socialSecurityYear(plan, annual, y, y * 12, 12, p.prog, progOffset(t), k.deaths[0], k.deaths[1], 0, 0, outA);
        const sum = new Array<number>(SO_REC).fill(0);
        for (let m = 0; m < 12; m++) {
          socialSecurityYear(plan, monthly, y, y * 12 + m, 1, p.prog, progOffset(t), k.deaths[0], k.deaths[1], 0, 0, outM);
          for (let s = 0; s < SO_REC; s++) sum[s]! += outM[s]!;
        }
        expect(sum, `couple ${c}, ${y}`).toEqual(Array.from(outA));
        expect(Array.from(monthly), `couple ${c}, ${y} state`).toEqual(Array.from(annual));
      }
    }
  });

  it("no allocation in 10,000 annual calls (heap unchanged within noise; the month loop of a claim year included)", ({ skip }) => {
    if (!runsInOwnFile(import.meta.url, expect.getState().testPath)) skip(); // a heap check means something only in its own file (testIsolation.ts)
    const h = household([est(1960, 7, 2400, 816, 2026), est(1962, 3, 800, 750, 2026)], 2026);
    const p = progTable(2026, 20, { keepCola: true, inflation: 0.03 });
    const out = new Float64Array(SO_REC);
    const run = (calls: number) => {
      for (let n = 0; n < calls; n++) {
        const t = n % 20;
        if (t === 0) resetSsState(h.plan, h.st);
        const y = 2026 + t;
        socialSecurityYear(h.plan, h.st, y, y * 12, 12, p.prog, progOffset(t), 2035, INF, t < 3 ? 30000 : 0, 0, out);
      }
    };
    run(200_000); // warm-up: let the optimizing compiler settle
    const before = process.memoryUsage().heapUsed;
    run(10_000);
    const after = process.memoryUsage().heapUsed;
    // One boxed double per evaluated month would be several hundred KB.
    expect(after - before).toBeLessThan(64 * 1024);
  });

  it("socialSecurityYear reads the program table and writes only the state and the output record", () => {
    const h = household([est(1960, 1, 2400, 744), est(1962, 1, 600, 744)], 2026);
    const p = progTable(2026, 2, { keepCola: true, inflation: 0.03 });
    const before = Array.from(p.prog);
    year(h, p, 2027, { wages: [50000, 0] });
    expect(Array.from(p.prog)).toEqual(before);
  });
});

describe("H17 the preview", () => {
  it("H17 H7(a)'s spouse: at 62 monthly 42000 and spousal 39000; at 67 60000 and 60000; survivor at survivor full retirement age 198000", () => {
    const res = socialSecurityPreviewView({
      people: [
        { birthYear: 1960, birthMonth: 1, monthlyAtFraCents: "240000", asOfYear: 2026, claimAgeMonths: 744 },
        { birthYear: 1962, birthMonth: 1, monthlyAtFraCents: "60000", asOfYear: 2026, claimAgeMonths: 744 },
      ],
      startYear: 2026,
    });
    expect(SocialSecurityPreviewResponse.safeParse(res).success).toBe(true);
    const spouse = res.people[1]!;
    expect(spouse).toMatchObject({ fraMonths: 804, survivorFraMonths: 804, piaAtStartCents: "60000", survivorMonthlyAtFraCents: "198000" });
    expect(spouse.byClaimAge.map((a) => a.claimAgeMonths)).toEqual([744, 756, 768, 780, 792, 804, 816, 828, 840]);
    expect(spouse.byClaimAge[0]).toEqual({ claimAgeMonths: 744, factorBp: 7000, monthlyCents: "42000", spousalMonthlyCents: "39000" });
    expect(spouse.byClaimAge[5]).toEqual({ claimAgeMonths: 804, factorBp: 10000, monthlyCents: "60000", spousalMonthlyCents: "60000" });
    // 13/15 = 8,666.67 bp → 8,667 (half away from zero, seams C44); 31/25 → 12,400.
    expect(spouse.byClaimAge.map((a) => a.factorBp)).toEqual([7000, 7500, 8000, 8667, 9333, 10000, 10800, 11600, 12400]);
    // The worker: no spousal excess from a PIA of 600; as a survivor, the spouse's 600 at 62 (cap 495) → 495.00.
    expect(res.people[0]!.byClaimAge.every((a) => a.spousalMonthlyCents === "0")).toBe(true);
    expect(res.people[0]!.survivorMonthlyAtFraCents).toBe("49500");
  });

  it("a single person has no spousal or survivor amounts; the PIA is carried from the statement year", () => {
    const res = socialSecurityPreviewView({ people: [{ birthYear: 1962, birthMonth: 1, monthlyAtFraCents: "200000", asOfYear: 2025, claimAgeMonths: 804 }], startYear: 2027 });
    expect(res.people[0]).toMatchObject({ piaAtStartCents: "213000", survivorMonthlyAtFraCents: "0" });
    expect(res.people[0]!.byClaimAge[0]).toEqual({ claimAgeMonths: 744, factorBp: 7000, monthlyCents: "149100", spousalMonthlyCents: "0" });
  });
});

describe("the frozen input and the year table (seams C1, C37)", () => {
  it("ssPersonInputs maps SimInput's entries in household order, from cents; a person without an entry is none", () => {
    const input = buildSimInput({ people: [{ birthYear: 1975, birthMonth: 6 }, { birthYear: 1977, birthMonth: 9 }] });
    input.socialSecurity.people = [
      { personId: "p2", mode: "receiving", monthlyCents: "190000", asOfYear: 2026, startedMonth: "2040-01" },
      { personId: "p1", mode: "estimate", monthlyAtFraCents: "280000", asOfYear: 2026, claimMonth: "2042-06", claimAgeMonths: 804 },
    ];
    expect(ssPersonInputs(input)).toEqual([
      { mode: "estimate", birthYear: 1975, birthMonth: 6, monthlyAtFra: 2800, asOfYear: 2026, claimAgeMonths: 804 },
      { mode: "receiving", birthYear: 1977, birthMonth: 9, monthly: 1900, asOfYear: 2026, startedIndex: mo(2040, 1) },
    ]);
    input.socialSecurity.people = [input.socialSecurity.people[1]!];
    expect(ssPersonInputs(input)[1]).toEqual({ mode: "none", birthYear: 1977, birthMonth: 9 });
  });

  it("ssPersonInputs refuses an unknown person, a second entry, a claim month that disagrees and a claim age outside 62 to 70", () => {
    const input = buildSimInput({ people: [{ birthYear: 1975, birthMonth: 6 }] });
    const entry = { personId: "p1" as const, mode: "estimate" as const, monthlyAtFraCents: "280000", asOfYear: 2026, claimMonth: "2042-06", claimAgeMonths: 804 };
    const code = (people: typeof input.socialSecurity.people) => {
      try {
        ssPersonInputs({ ...input, socialSecurity: { ...input.socialSecurity, people } });
        return "ok";
      } catch (e) {
        return (e as { code: string }).code;
      }
    };
    expect(code([entry])).toBe("ok");
    expect(code([{ ...entry, personId: "p2" }])).toBe("person_missing");
    expect(code([entry, entry])).toBe("social_security_invalid");
    expect(code([{ ...entry, claimMonth: "2042-07" }])).toBe("social_security_invalid");
    expect(code([{ ...entry, claimAgeMonths: 852, claimMonth: "2046-06" }])).toBe("social_security_invalid");
  });

  it("C37 socialSecurityParts gives the spousal, survivor and withheld cents of one person", () => {
    const out = new Float64Array(SO_REC);
    out[SO.SPOUSAL + 1] = 3150;
    out[SO.SURVIVOR + 1] = 17040.04;
    out[SO.WITHHELD] = 7760;
    expect(socialSecurityParts(out, 0)).toEqual({ spousal: "0", survivor: "0", withheld: "776000" });
    expect(socialSecurityParts(out, 1)).toEqual({ spousal: "315000", survivor: "1704004", withheld: "0" });
  });
});

describe("what every rule rests on (plan decision 11; seams §9 item 1)", () => {
  it("each rule names figures ss/rules.json marks; none is primary; the coded rules and the unconfirmed table rows are unverified", () => {
    const v = ssRuleVerification(data);
    expect(v.map((x) => x.id)).toEqual(SS_RULES.map((x) => x.id));
    expect(v.filter((x) => x.status === "primary")).toEqual([]);
    expect(v.filter((x) => x.status === "secondary").map((x) => x.id)).toEqual([
      "claim_window",
      "early_reduction",
      "delayed_credits",
      "spousal_share",
      "spousal_reduction",
      "earnings_test",
      "cola",
    ]);
    expect(v.filter((x) => x.status === "unverified").map((x) => x.id)).toEqual([
      "full_retirement_age",
      "survivor_full_retirement_age",
      "delayed_credits_january",
      "spousal_excess",
      "survivor_reduction",
      "widow_limit",
      "deceased_credits",
      "earnings_test_credit_back",
      "ssa_rounding",
    ]);
    // The full-retirement-age rule is unverified only through the rows 1939 to 1942.
    const fra = v.find((x) => x.id === "full_retirement_age")!;
    expect(fra.figures.filter((f) => f.status === "unverified").map((f) => f.key)).toEqual([
      "retirementFraMonths.1939",
      "retirementFraMonths.1940",
      "retirementFraMonths.1941",
      "retirementFraMonths.1942",
    ]);
    // Every figure mark of ss/rules.json is read by some rule.
    const used = new Set(v.flatMap((x) => x.figures.map((f) => f.key)));
    expect(Object.keys(data.ss.verification).filter((k) => !used.has(k))).toEqual([]);
  });
});

describe("layout sanity", () => {
  it("the SS and SO records are the sizes of layout.ts; the program table has the slots this module reads", () => {
    expect([SS_REC, SO_REC, PROG_REC, TAX_REC]).toEqual([16, 10, 24, 48]);
    expect([PR.COLA, PR.SS_SCALE, PR.ET_UNDER, PR.ET_FRA]).toEqual([0, 1, 2, 3]);
    // fillPathTables is the COLA's only writer (C20): a path with no inflation after 2027 has no COLA.
    const t = pathTables(data, { startYear: 2026, years: 4, inflation: 0 });
    expect([0, 1, 2, 3].map((i) => t.prog[progOffset(i) + PR.COLA])).toEqual([0.028, 0.036, 0, 0]);
    expect(typeof fillPathTables).toBe("function");
  });
});
