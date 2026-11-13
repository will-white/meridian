import type { Longevity } from "@meridian/shared";
import { describe, expect, it } from "vitest";
import { EngineInputError } from "./errors.js";
import { LIFE_2010CM_LX } from "./generated/data.js";
import {
  LIFE_TABLES,
  type LifeTable,
  type LifeTables,
  Q_SCALE,
  aliveInYear,
  buildLifeTables,
  calendarDeathProbability,
  compileMortality,
  deathIndexFromCdf,
  lifeTableFor,
  tableFromLx,
} from "./mortality.js";
import { seedKey } from "./rng.js";

// Build step 13: mortality, the horizon and the death draws (engine-and-returns decision 18, §3.6,
// §7 T17 and T18; seams C14 and C28; plan decision 11). Expected values are the design's; the f0 = 0.5
// case of T17 needs no re-derivation under C14 (a July start: firstYearMonths 6 gives f = 6/12 = 0.5),
// and the horizon rows follow C28 (the horizon ends in the year maxAge is attained).

const KEY = seedKey(20261110);
const START = 2027;

/** T17's fixture: q[88..94] = 0.10, 0.12, 0.15, 0.20, 0.30, 0.50, 1 (M = 94); younger ages 0. */
const FIXTURE: LifeTable = (() => {
  const q = new Float64Array(95);
  [0.1, 0.12, 0.15, 0.2, 0.3, 0.5, 1].forEach((v, k) => (q[88 + k] = v));
  return { id: "irs_2010cm_fallback", q, lastAge: 94 };
})();
const FIXTURE_TABLES: LifeTables = { fallback: FIXTURE, female: null, male: null };

const table = (sex: "female" | "male", maxAge: number, adjustYears = 0): Longevity => ({ mode: "mortality", sex, adjustYears, maxAge });
const fixed = (age: number): Longevity => ({ mode: "fixed", age });

/** Two people who attain 90 in plan year 0 (born 1937), on the fixture, with maxAge 95. */
function fixturePair(firstYearMonths: number, maxAge = 95) {
  return compileMortality(
    [
      { birthYear: START - 90, longevity: table("female", maxAge) },
      { birthYear: START - 90, longevity: table("male", maxAge) },
    ],
    { startYear: START, firstYearMonths },
    FIXTURE_TABLES,
  );
}

function draw(m: ReturnType<typeof compileMortality>, path: number): number[] {
  const out = new Int16Array(m.people);
  m.drawDeaths(KEY, path, out);
  return Array.from(out);
}

describe("T17 calendar-year probabilities and draws", () => {
  it("T17 qCal(90 … 95) = 0.135, 0.175, 0.25, 0.40, 0.75, 1 on the fixture (mean of the two ages, 1 above M)", () => {
    // qCal(90) = (q[89] + q[90]) / 2 = (0.12 + 0.15) / 2 = 0.135; qCal(94) = (0.5 + 1) / 2 = 0.75; 95 > M.
    expect([90, 91, 92, 93, 94, 95].map((a) => calendarDeathProbability(FIXTURE.q, 94, 1, a))).toEqual([0.135, 0.175, 0.25, 0.4, 0.75, 1]);
    expect(Q_SCALE).toBe(1);
  });

  it("T17 qScale = 0.5 → qCal(90) = 0.0675, qCal(94) = 0.375, qCal(95) = 1; qScale = 2 → 0.27, qCal(93) = 0.8, qCal(94) = 1", () => {
    expect([90, 94, 95].map((a) => calendarDeathProbability(FIXTURE.q, 94, 0.5, a))).toEqual([0.0675, 0.375, 1]);
    expect([90, 93, 94].map((a) => calendarDeathProbability(FIXTURE.q, 94, 2, a))).toEqual([0.27, 0.8, 1]);
  });

  it("T17 f = 1: cdf = 0.135, 0.286375, 0.46478125, 0.67886875, 0.9197171875, 1", () => {
    // S_t = Π (1 − qCal): 0.865, 0.713625, 0.53521875, 0.32113125, 0.0802828125, 0.
    const m = fixturePair(12);
    expect(m.years).toBe(6);
    const expected = [0.135, 0.286375, 0.46478125, 0.67886875, 0.9197171875, 1];
    for (const person of [0, 1]) expected.forEach((v, t) => expect(m.cdf[person * 6 + t]).toBeCloseTo(v, 15));
    expect(m.cdf[5]).toBe(1);
  });

  it("T17 draws for two persons who attain 90 in year 0, f = 1: path 0 → [5, 3], path 1 → [3, 4], path 2 → [2, 1]", () => {
    // Path 0: u = 0.9664983621314399, 0.6475357745930787 (T3); path 1: 0.5219427464730636,
    // 0.7826978958245384; path 2: 0.461106800847343, 0.2094269807901371.
    const m = fixturePair(12);
    expect(draw(m, 0)).toEqual([5, 3]);
    expect(draw(m, 1)).toEqual([3, 4]);
    expect(draw(m, 2)).toEqual([2, 1]);
  });

  it("T17 strictness: u = 0.135 exactly → index 1; u = 0.1349999 → index 0", () => {
    const m = fixturePair(12);
    expect(deathIndexFromCdf(m.cdf, 0, 6, 0.135)).toBe(1);
    expect(deathIndexFromCdf(m.cdf, 0, 6, 0.1349999)).toBe(0);
  });

  it("T17 f = 0.5 (firstYearMonths 6): year-0 survival 0.865^0.5 = 0.9300537619; cdf and draws [5, 3], [3, 4], [3, 1]", () => {
    // C14: the year-0 death probability is 1 − (1 − q)^f. cdf = 0.0699462381, 0.2327056464,
    // 0.4245292348, 0.6547175409, 0.9136793852, 1 (re-derived with 60-digit decimals).
    const m = fixturePair(6);
    expect(1 - m.cdf[0]!).toBeCloseTo(0.9300537619, 10);
    [0.0699462381, 0.2327056464, 0.4245292348, 0.6547175409, 0.9136793852, 1].forEach((v, t) => expect(m.cdf[t]).toBeCloseTo(v, 10));
    expect(draw(m, 0)).toEqual([5, 3]);
    expect(draw(m, 1)).toEqual([3, 4]);
    expect(draw(m, 2)).toEqual([3, 1]);
  });

  it("C14 for a November start (f = 2/12) the year-0 probability is 1 − (1 − 0.135)^(1/6)", () => {
    const m = fixturePair(2);
    // 1 − 0.865^(1/6) = 1 − e^(ln 0.865 / 6) = 0.023878 … (Math.pow reference within 1e-15).
    expect(m.cdf[0]).toBeCloseTo(1 - Math.pow(0.865, 1 / 6), 15);
    expect(m.cdf[1]).toBeCloseTo(1 - Math.pow(0.865, 1 / 6) * 0.825, 15);
  });
});

describe("C28 the profile's adjustYears and maxAge", () => {
  it("C28 death is certain in the year maxAge is attained, and the horizon ends there", () => {
    // maxAge 93: the person attains 93 in plan year 3, so cdf[3] = 1 and Y = 4.
    const m = fixturePair(12, 93);
    expect(m.years).toBe(4);
    expect(Array.from(m.lastIndex)).toEqual([3, 3]);
    expect(Array.from(m.cdf.subarray(0, 4))).toEqual([0.135, 1 - 0.865 * 0.825, 1 - 0.865 * 0.825 * 0.75, 1]);
    // Path 0's first person (u = 0.966…) would have lived to index 5; maxAge stops the life at 3.
    expect(draw(m, 0)).toEqual([3, 3]);
  });

  it("C28 the table is read at age − adjustYears: +2 at 92 reads as 90; −2 at 90 reads as 92", () => {
    const healthier = compileMortality([{ birthYear: START - 92, longevity: table("female", 97, 2) }], { startYear: START, firstYearMonths: 12 }, FIXTURE_TABLES);
    const base = fixturePair(12);
    expect(Array.from(healthier.cdf)).toEqual(Array.from(base.cdf.subarray(0, 6)));
    const frailer = compileMortality([{ birthYear: START - 90, longevity: table("female", 95, -2) }], { startYear: START, firstYearMonths: 12 }, FIXTURE_TABLES);
    // qCal at table ages 92, 93, 94, 95: 0.25, 0.40, 0.75, 1 → cdf 0.25, 0.55, 0.8875, 1, 1, 1.
    const expected = [0.25, 0.55, 0.8875, 1, 1, 1];
    expected.forEach((v, t) => expect(frailer.cdf[t]).toBeCloseTo(v, 15));
  });

  it("the engine's qScale is the internal constant 1 (the profile has no such field)", () => {
    const m = fixturePair(12);
    expect(m.cdf[0]).toBe(calendarDeathProbability(FIXTURE.q, 94, 1, 90));
  });
});

describe("T18 fixed ages and the horizon", () => {
  it("T18 born 1962, fixed age 95, start 2027 → deathIdx = 30, Y = 31", () => {
    const m = compileMortality([{ birthYear: 1962, longevity: fixed(95) }], { startYear: START, firstYearMonths: 12 });
    expect(m.years).toBe(31);
    expect(draw(m, 0)).toEqual([30]);
    expect(draw(m, 9999)).toEqual([30]);
    expect([m.allFixed, m.table, m.warnings]).toEqual([true, "fixed", []]);
  });

  it("T18 born 1960 and 1962, fixed ages 84 and 93, start 2027 → [17, 28], Y = 29; both alive through plan year 17 (2044), one from 18", () => {
    const m = compileMortality(
      [
        { birthYear: 1960, longevity: fixed(84) },
        { birthYear: 1962, longevity: fixed(93) },
      ],
      { startYear: START, firstYearMonths: 12 },
    );
    const deaths = draw(m, 0);
    expect(deaths).toEqual([17, 28]);
    expect(m.years).toBe(29);
    // Married filing jointly while both are alive (through 2044), single from plan year 18 (L2).
    expect(aliveInYear(deaths[0]!, 17) && aliveInYear(deaths[1]!, 17)).toBe(true);
    expect(aliveInYear(deaths[0]!, 18)).toBe(false);
    expect(aliveInYear(deaths[1]!, 28)).toBe(true);
    expect(START + 17).toBe(2044);
  });

  it("T18 the IRS table (M = 109), born 1962, start 2027: maxAge 110 → Y = 46, death certain at 110 (index 45)", () => {
    // C28: last possible death 1962 + 110 − 2027 = 45. Under Table 2010CM age 110 is above M = 109,
    // so qCal = 1 there anyway; at 109 qCal = (q[108] + q[109]) / 2 = (0.487009 + 1) / 2.
    const m = compileMortality([{ birthYear: 1962, longevity: table("female", 110) }], { startYear: START, firstYearMonths: 12 });
    expect(m.years).toBe(46);
    expect(m.cdf[45]).toBe(1);
    expect(m.cdf[44]).toBeLessThan(1);
    expect(LIFE_TABLES.fallback.lastAge).toBe(109);
    expect(calendarDeathProbability(LIFE_TABLES.fallback.q, 109, 1, 109)).toBeCloseTo((0.487009 + 1) / 2, 6);
    // maxAge 119 extends the horizon to Y = 55, but the table still ends every life by 110.
    const long = compileMortality([{ birthYear: 1962, longevity: table("female", 119) }], { startYear: START, firstYearMonths: 12 });
    expect(long.years).toBe(55);
    expect(long.cdf[45]).toBe(1);
    for (let t = 45; t < 55; t++) expect(long.cdf[t]).toBe(1);
  });

  it("a person past the fixed age dies in year 0 (deathIdx = max(0, …)); a horizon above 120 years is horizon_too_long", () => {
    const m = compileMortality([{ birthYear: 1930, longevity: fixed(90) }], { startYear: START, firstYearMonths: 12 });
    expect([m.years, draw(m, 0)[0]]).toEqual([1, 0]);
    let caught: unknown;
    try {
      // Last possible death 2026 + 119 − 2025 = 120, so Y = 121.
      compileMortality([{ birthYear: 2026, longevity: fixed(119) }], { startYear: 2025, firstYearMonths: 12 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EngineInputError);
    expect((caught as EngineInputError).code).toBe("horizon_too_long");
    // 120 years is the cap itself.
    expect(compileMortality([{ birthYear: 2026, longevity: fixed(119) }], { startYear: 2026, firstYearMonths: 12 }).years).toBe(120);
  });
});

describe("life tables (plan decision 11, G4)", () => {
  it("Table 2010CM: q[x] = 1 − lx[x+1]/lx[x] for x ≤ 108, q[109] = 1; q[65] = 0.012814, q[85] = 0.084651, q[108] = 0.487009", () => {
    const t = tableFromLx(LIFE_2010CM_LX, "irs_2010cm_fallback");
    expect(t.lastAge).toBe(109);
    expect(t.q.length).toBe(110);
    expect([65, 85, 108].map((x) => Number(t.q[x]!.toFixed(6)))).toEqual([0.012814, 0.084651, 0.487009]);
    expect(t.q[109]).toBe(1);
    expect(t.q[65]).toBe(1 - LIFE_2010CM_LX[66]! / LIFE_2010CM_LX[65]!);
  });

  it("without the SSA table sex has no effect, the run says irs_2010cm_fallback and warns mortality_fallback_table", () => {
    expect(LIFE_TABLES.male).toBeNull();
    expect(LIFE_TABLES.female).toBeNull();
    expect(lifeTableFor("male").fallback).toBe(true);
    const f = compileMortality([{ birthYear: 1962, longevity: table("female", 110) }], { startYear: START, firstYearMonths: 12 });
    const m = compileMortality([{ birthYear: 1962, longevity: table("male", 110) }], { startYear: START, firstYearMonths: 12 });
    expect(Array.from(f.cdf)).toEqual(Array.from(m.cdf));
    expect(m.table).toBe("irs_2010cm_fallback");
    expect(m.warnings.map((w) => w.code)).toEqual(["mortality_fallback_table"]);
    expect(m.warnings[0]!.message).toContain("IRS 2010 table for both sexes");
  });

  it("a mixed household (one fixed, one drawn) draws only for the table person, on slot = person index", () => {
    const m = compileMortality(
      [
        { birthYear: START - 90, longevity: fixed(93) },
        { birthYear: START - 90, longevity: table("male", 95) },
      ],
      { startYear: START, firstYearMonths: 12 },
      FIXTURE_TABLES,
    );
    expect([m.allFixed, m.table, m.years]).toEqual([false, "irs_2010cm_fallback", 6]);
    // Person 1 uses slot 1: path 0's u = 0.6475357745930787 → index 3.
    expect(draw(m, 0)).toEqual([3, 3]);
    expect(Number.isNaN(m.cdf[0]!)).toBe(true);
  });

  it("with the SSA table installed each sex uses its own column, q[119] = 1, the run says ssa_period, no warning", () => {
    // A synthetic 120-row table (not SSA data): female q = 0.01 at every age, male 0.02.
    const female = new Float64Array(120).fill(0.01);
    const male = new Float64Array(120).fill(0.02);
    const tables = buildLifeTables(LIFE_2010CM_LX, male, female);
    expect([tables.female!.id, tables.female!.lastAge, tables.female!.q[119], tables.male!.q[118]]).toEqual(["ssa_period", 119, 1, 0.02]);
    expect(female[119]).toBe(0.01);
    const f = compileMortality([{ birthYear: 1962, longevity: table("female", 110) }], { startYear: START, firstYearMonths: 12 }, tables);
    const m = compileMortality([{ birthYear: 1962, longevity: table("male", 110) }], { startYear: START, firstYearMonths: 12 }, tables);
    expect([f.table, f.warnings]).toEqual(["ssa_period", []]);
    expect(f.cdf[0]).toBeCloseTo(0.01, 15);
    expect(m.cdf[0]).toBeCloseTo(0.02, 15);
    expect(m.cdf[1]).toBeCloseTo(1 - 0.98 * 0.98, 15);
  });
});
