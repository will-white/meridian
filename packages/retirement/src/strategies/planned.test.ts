import { describe, expect, it } from "vitest";
import { buildSimInput } from "../testing/simInput.js";
import { createPlannedYear, plannedYear } from "./planned.js";
import { prepareStrategies } from "./prepare.js";
import { level } from "./testKit.js";

// Build step 18: planned spending (strategies-outputs-web §3.2, ST-1 and ST-2). Dollars within 0.005.

const CENT = 2;

function planned(tb: ReturnType<typeof prepareStrategies>, t: number, cpi: number, o: { alive?: number[]; yearsToDeath?: number[]; drawdownStart?: number; portfolioStart?: number } = {}) {
  const out = createPlannedYear();
  const P = tb.personCount;
  plannedYear(tb, t, cpi, o.alive ?? Array(P).fill(1), o.yearsToDeath ?? Array(P).fill(40), o.drawdownStart ?? 0, o.portfolioStart ?? 0, out);
  return out;
}

describe("ST-1 planned core with phases", () => {
  it("ST-1 base 60,000; cpi 1, 1.03, 1.0609; multipliers 1, 1, 0.9 → 60,000.00; 61,800.00; 57,288.60", () => {
    // 60,000 × 0.9 × 1.0609 = 57,288.60.
    const tb = prepareStrategies(
      buildSimInput({ spending: { baseAnnualCents: "6000000", phases: [{ fromYear: 2027, multiplierBp: 10000 }, { fromYear: 2029, multiplierBp: 9000 }] } }),
    );
    expect(Array.from(tb.phase.subarray(0, 4))).toEqual([1, 1, 0.9, 0.9]);
    expect(planned(tb, 0, 1).corePlanned).toBeCloseTo(60_000, CENT);
    expect(planned(tb, 1, 1.03).corePlanned).toBeCloseTo(61_800, CENT);
    expect(planned(tb, 2, 1.0609).corePlanned).toBeCloseTo(57_288.6, CENT);
  });
});

describe("ST-2 goal, survivor, long-term care, month window, reserve", () => {
  // R2's household (strategies-outputs-web §7.7): a couple, plan from January 2027, base 99,600,
  // healthcare 6,000 a person not included in base, survivor share 70%; its price level rises 2.5%
  // a year, so cpi of year y is 1.025^(y − 2027). The design prints 1.218403 and 1.996495 rounded to
  // six places; the cases below use the exact powers (1.025^8 = 1.218402897509918…).
  const r2 = buildSimInput({
    people: [{ birthYear: 1957 }, { birthYear: 1959, longevity: { mode: "fixed", age: 97 } }],
    spending: {
      baseAnnualCents: "9960000",
      survivorBp: 7000,
      goals: [{ id: "car", name: "car", year: 2030, amountCents: "3000000", dollars: "today" }],
      healthcare: ["p1", "p2"].map((personId) => ({
        personId: personId as "p1" | "p2",
        preMedicareAnnualCents: "0",
        preMedicareFrom: "2027-01",
        medicareFrom: "2027-01",
        medicareAnnualCents: "600000",
        realGrowthBp: 0,
        inBase: false,
      })),
      longTermCare: [{ personId: "p2", reserveCents: "6000000", lastYears: 2 }],
    },
  });
  const tb = prepareStrategies(r2);

  it("ST-2 a goal year (R2, 2030): (99,600 + 2 × 6,000 + 30,000) × 1.076890625 = 152,487.71", () => {
    const y = planned(tb, 3, level(1.025, 3), { yearsToDeath: [10, 26] });
    expect(y.corePlanned + y.healthcare + y.goals).toBeCloseTo(152_487.71, CENT);
    expect(y.goals).toBeCloseTo(30_000 * 1.076890625, 9);
    expect(y.longTermCare).toBe(0);
  });

  it("ST-2 after a first death (R2, 2035, survivor share 0.7): core 84,947.05, healthcare 7,310.42, need 92,257.47", () => {
    // 99,600 × 0.7 × 1.025^8 = 69,720 × 1.2184028975 = 84,947.050; 6,000 × 1.2184028975 = 7,310.417.
    const y = planned(tb, 8, level(1.025, 8), { alive: [0, 1], yearsToDeath: [-1, 21] });
    expect(y.corePlanned).toBeCloseTo(84_947.05, CENT);
    expect(y.healthcare).toBeCloseTo(7_310.42, CENT);
    expect(y.corePlanned + y.healthcare + y.longTermCare + y.goals).toBeCloseTo(92_257.47, CENT);
  });

  it("ST-2 long-term care (R2: 60,000 for person 2, 2 years, death in 2056): none through 2054; 59,894.85 and 61,392.22, with 119,789.70 and 61,392.22 set aside", () => {
    // 2055 (t = 28, d = 1, k = min(2, 1 + 28 − 0 + 1) = 2): a care year, 30,000 × 1.025^28 =
    // 59,894.85; set aside 60,000 × 1.025^28 × min(2, 2) ÷ 2 = 119,789.70. 2056 (t = 29, d = 0):
    // 30,000 × 1.025^29 = 61,392.22, set aside 60,000 × 1.025^29 × 1 ÷ 2 = 61,392.22.
    // 2054 (t = 27, d = 2): not a care year; the whole reserve 60,000 × 1.025^27 is set aside.
    const y54 = planned(tb, 27, level(1.025, 27), { alive: [0, 1], yearsToDeath: [-1, 2] });
    expect(y54.longTermCare).toBe(0);
    expect(y54.reserved).toBeCloseTo(60_000 * level(1.025, 27), 6);
    const y55 = planned(tb, 28, level(1.025, 28), { alive: [0, 1], yearsToDeath: [-1, 1] });
    expect(y55.longTermCare).toBeCloseTo(59_894.85, CENT);
    expect(y55.reserved).toBeCloseTo(119_789.7, CENT);
    const y56 = planned(tb, 29, level(1.025, 29), { alive: [0, 1], yearsToDeath: [-1, 0] });
    expect(y56.longTermCare).toBeCloseTo(61_392.22, CENT);
    expect(y56.reserved).toBeCloseTo(61_392.22, CENT);
  });

  it("ST-2 long-term care when the drawdown starts inside the care years: k is the care years in the drawdown", () => {
    // Death at plan year 10, drawdown from plan year 10: k = min(2, d + t − 10 + 1) = 1 in year 10
    // (d = 0), so the whole reserve is spent that year: 60,000 × cpi ÷ 1.
    const y = planned(tb, 10, 1.2, { alive: [1, 1], yearsToDeath: [20, 0], drawdownStart: 10 });
    expect(y.longTermCare).toBeCloseTo(72_000, CENT);
    expect(y.reserved).toBeCloseTo(72_000, CENT);
    // A person who dies before the drawdown has no care years in it (k ≤ 0): nothing is set aside.
    const early = planned(tb, 3, 1, { alive: [1, 1], yearsToDeath: [20, 2], drawdownStart: 10 });
    expect(early.reserved).toBe(0);
    expect(early.longTermCare).toBe(0);
  });

  it("ST-2 a month window: retirement in June 2035 gives coreShare 7/12; base 84,000 at cpi 1.1 → 53,900.00", () => {
    // 84,000 × 7/12 × 1.1 = 53,900.
    const tbw = prepareStrategies(buildSimInput({ spending: { baseAnnualCents: "8400000", startMonth: "2035-06" } }));
    expect(tbw.coreShare[7]).toBe(0);
    expect(tbw.coreShare[8]).toBe(7 / 12);
    expect(tbw.coreShare[9]).toBe(1);
    expect(planned(tbw, 8, 1.1).corePlanned).toBeCloseTo(53_900, CENT);
  });

  it("ST-2 reserve exclusion: accounts 1,000,000, reserve 200,000 not yet started, cpi 1.1 → P = 780,000", () => {
    // 1,000,000 − 200,000 × 1.1 = 780,000.
    const tbr = prepareStrategies(buildSimInput({ spending: { longTermCare: [{ personId: "p1", reserveCents: "20000000", lastYears: 2 }] } }));
    const y = planned(tbr, 5, 1.1, { yearsToDeath: [20], portfolioStart: 1_000_000 });
    expect(y.reserved).toBeCloseTo(220_000, CENT);
    expect(y.spendable).toBeCloseTo(780_000, CENT);
    // The spendable portfolio never goes below 0.
    expect(planned(tbr, 5, 1.1, { yearsToDeath: [20], portfolioStart: 100_000 }).spendable).toBe(0);
  });
});

describe("C35 healthcare included in base", () => {
  it("C35 the entered amounts stay the HSA's qualified cap; spending adds only the entries not in base", () => {
    // p1 in base (8,000 a year), p2 not (5,000): spending healthcare 5,000 × cpi; the cap 13,000 × cpi.
    const tb = prepareStrategies(
      buildSimInput({
        people: [{ birthYear: 1957 }, { birthYear: 1959 }],
        spending: {
          healthcare: [
            { personId: "p1", preMedicareAnnualCents: "0", preMedicareFrom: "2027-01", medicareFrom: "2027-01", medicareAnnualCents: "800000", realGrowthBp: 0, inBase: true },
            { personId: "p2", preMedicareAnnualCents: "0", preMedicareFrom: "2027-01", medicareFrom: "2027-01", medicareAnnualCents: "500000", realGrowthBp: 0, inBase: false },
          ],
        },
      }),
    );
    const y = planned(tb, 2, 1.05);
    expect(y.healthcare).toBeCloseTo(5_250, 9);
    expect(y.healthcareCap).toBeCloseTo(13_650, 9);
    // A dead person's healthcare counts for neither.
    const widow = planned(tb, 2, 1.05, { alive: [0, 1] });
    expect(widow.healthcare).toBeCloseTo(5_250, 9);
    expect(widow.healthcareCap).toBeCloseTo(5_250, 9);
  });

  it("the healthcare windows: pre-Medicare from retirement to 65, Medicare from 65, both with real growth by plan year", () => {
    // Plan from October 2026 (f = 3/12). Pre-Medicare 12,000 from 2026-11 to 2028-06, Medicare 6,000
    // from 2028-06, growth 2% a year: year 0 = 12,000 × 2/3 (two of three months) = 8,000; year 1
    // = 12,000 × 1.02 = 12,240; year 2 = (12,000 × 5/12 + 6,000 × 7/12) × 1.02² = 8,500 × 1.0404
    // = 8,843.40; year 3 = 6,000 × 1.02³ = 6,367.248.
    const tb = prepareStrategies(
      buildSimInput({
        startYear: 2026,
        startMonth: 10,
        people: [{ birthYear: 1963, birthMonth: 6 }],
        spending: {
          healthcare: [
            { personId: "p1", preMedicareAnnualCents: "1200000", preMedicareFrom: "2026-11", medicareFrom: "2028-06", medicareAnnualCents: "600000", realGrowthBp: 200, inBase: false },
          ],
        },
      }),
    );
    expect(tb.healthcare[0]).toBeCloseTo(8_000, 9);
    expect(tb.healthcare[1]).toBeCloseTo(12_240, 9);
    expect(tb.healthcare[2]).toBeCloseTo(8_843.4, 9);
    expect(tb.healthcare[3]).toBeCloseTo(6_367.248, 9);
    expect(Array.from(tb.healthcareSpend.subarray(0, 4))).toEqual(Array.from(tb.healthcare.subarray(0, 4)));
  });
});
