import { SimInput, vpwParams } from "@meridian/shared";
import { describe, expect, it } from "vitest";
import { EngineInputError } from "../errors.js";
import { buildSimInput } from "../testing/simInput.js";
import { validateInput } from "../prepare.js";
import { STRATEGY, prepareStrategies } from "./prepare.js";

// Build step 18: `prepareStrategies(input)` (strategies-outputs-web §2.1 and §4.1: basis points ÷
// 10,000 and cents ÷ 100 here only; seams C1: it reads the frozen `SimInput`).

function code(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof EngineInputError) return e.code;
    throw e;
  }
  return undefined;
}

describe("prepareStrategies", () => {
  it("the test builder writes a valid frozen input", () => {
    const input = buildSimInput({ people: [{ birthYear: 1960 }, { birthYear: 1962 }] });
    expect(SimInput.safeParse(input).success).toBe(true);
    expect(input.plan).toMatchObject({ startYear: 2027, startMonth: "2027-01", firstYearMonths: 12, endYear: 2057 });
    expect(input.household.filingStatus).toBe("married_joint");
  });

  it("converts every setting once: kinds, rates, bands and amounts", () => {
    const tb = prepareStrategies(
      buildSimInput({
        people: [{ birthYear: 1960 }],
        spending: { baseAnnualCents: "8000000", essentialAnnualCents: "5000000", survivorBp: 7000 },
        strategy: { kind: "guardrails", upperBandBp: 2500, lowerBandBp: 1500, cutBp: 800, raiseBp: 1200, skipInflationAfterLoss: false, preservationCutoffYears: 10, planningAge: 100 },
        cashReserveCents: "1234567",
      }),
    );
    expect(tb.kind).toBe(STRATEGY.guardrails);
    expect(tb.base).toBe(80_000);
    expect(tb.essentialShare).toBe(0.625);
    expect(tb.survivorShare).toBe(0.7);
    expect(tb.gk).toEqual({ upper: 0.25, lower: 0.15, cut: 0.08, raise: 0.12, skipAfterLoss: 0, cutoffYears: 10, planningAge: 100 });
    expect(tb.cashReserve).toBe(12_345.67);
    // The kinds not chosen carry the schema's defaults.
    expect(tb.fixedRate).toBe(0.04);
    expect(tb.vpw).toEqual({ stockReal: 0.05, bondReal: 0.019, lastAge: 99, maxRate: 0.1 });
    expect(Number.isNaN(tb.fc.rate)).toBe(true);
    expect([tb.fc.floor, tb.fc.ceiling]).toEqual([0.15, 0.2]);
  });

  it("each kind's index and parameters", () => {
    const kinds = {
      constant_dollar: { kind: "constant_dollar" },
      fixed_percentage: { kind: "fixed_percentage", rateBp: 350 },
      guardrails: { kind: "guardrails" },
      vpw: { kind: "vpw", stockRealBp: 450, bondRealBp: 150, lastWithdrawalAge: 95, maxRateBp: 1200 },
      floor_ceiling: { kind: "floor_ceiling", rateBp: 425, floorBp: 1000, ceilingBp: 2500 },
    } as const;
    for (const [name, strategy] of Object.entries(kinds)) {
      const tb = prepareStrategies(buildSimInput({ strategy }));
      expect(tb.kind).toBe(STRATEGY[name as keyof typeof STRATEGY]);
    }
    expect(prepareStrategies(buildSimInput({ strategy: kinds.fixed_percentage })).fixedRate).toBe(0.035);
    expect(prepareStrategies(buildSimInput({ strategy: kinds.vpw })).vpw).toEqual(vpwParams({ ...kinds.vpw }));
    expect(prepareStrategies(buildSimInput({ strategy: kinds.floor_ceiling })).fc).toEqual({ rate: 0.0425, floor: 0.1, ceiling: 0.25 });
  });

  it("essential share is 0 with no base; goals go to the year's real or nominal table", () => {
    const tb = prepareStrategies(
      buildSimInput({
        spending: {
          goals: [
            { id: "a", name: "a", year: 2027, amountCents: "100000", dollars: "today" },
            { id: "b", name: "b", year: 2030, amountCents: "250000", dollars: "nominal" },
            { id: "c", name: "c", year: 2030, amountCents: "50000", dollars: "today" },
          ],
        },
      }),
    );
    expect(tb.essentialShare).toBe(0);
    expect([tb.goalReal[0], tb.goalReal[3], tb.goalNominal[3], tb.goalNominal[0]]).toEqual([1_000, 500, 2_500, 0]);
  });

  it("horizonYear: the fixed life expectancy, or the planning age under table mortality", () => {
    const tb = prepareStrategies(
      buildSimInput({
        people: [{ birthYear: 1960, longevity: { mode: "fixed", age: 90 } }, { birthYear: 1963, longevity: { mode: "mortality", sex: "female", adjustYears: 0, maxAge: 105 } }],
        strategy: { kind: "guardrails", planningAge: 97 },
      }),
    );
    expect(Array.from(tb.horizonYear)).toEqual([2050, 2060]);
    expect(tb.personCount).toBe(2);
    expect(tb.years).toBe(2068 - 2027 + 1);
  });

  it("long-term care per named person", () => {
    const tb = prepareStrategies(
      buildSimInput({ people: [{ birthYear: 1960 }, { birthYear: 1962 }], spending: { longTermCare: [{ personId: "p2", reserveCents: "9000000", lastYears: 3 }] } }),
    );
    expect(Array.from(tb.ltcReserve)).toEqual([0, 90_000]);
    expect(Array.from(tb.ltcYears)).toEqual([0, 3]);
  });

  it("contracts-02: phases out of year order are spending_invalid (an input that did not pass the schema): never read by array order", () => {
    // The review's probe: sorted [{2035, 5000}, {2060, 10000}] gives 0.5 in 2040 and 1 in 2065;
    // unsorted, the loop's "last entry with fromYear ≤ year" read 0.5 in both. Here the plan ends
    // in 2057 (born 1962, fixed age 95), so the second phase starts in 2050.
    const sorted = buildSimInput({ spending: { phases: [{ fromYear: 2035, multiplierBp: 5000 }, { fromYear: 2050, multiplierBp: 10000 }] } });
    const tb = prepareStrategies(sorted);
    expect([tb.phase[2040 - tb.startYear], tb.phase[2055 - tb.startYear]]).toEqual([0.5, 1]);
    const unsorted = { ...sorted, spending: { ...sorted.spending, phases: [{ fromYear: 2050, multiplierBp: 10000 }, { fromYear: 2035, multiplierBp: 5000 }] } };
    expect(code(() => prepareStrategies(unsorted))).toBe("spending_invalid");
    expect(validateInput(unsorted).map((i) => i.code)).toEqual(["spending_invalid"]);
    const repeated = { ...sorted, spending: { ...sorted.spending, phases: [{ fromYear: 2035, multiplierBp: 5000 }, { fromYear: 2035, multiplierBp: 10000 }] } };
    expect(code(() => prepareStrategies(repeated))).toBe("spending_invalid");
  });

  it("contracts-01: healthcare growth outside the profile's 0 to 1,000 bp and long-term-care years outside 1 to 10 are spending_invalid (an input that did not pass the schema)", () => {
    const hc = { personId: "p1" as const, preMedicareAnnualCents: "0", preMedicareFrom: "2027-01", medicareFrom: "2027-01", medicareAnnualCents: "1", realGrowthBp: 0, inBase: false };
    const base = buildSimInput({ spending: { healthcare: [hc] } });
    const withHealthcare = (realGrowthBp: number) => ({ ...base, spending: { ...base.spending, healthcare: [{ ...hc, realGrowthBp }] } });
    for (const bad of [1001, 1_000_000_000, -1, -10000]) expect(code(() => prepareStrategies(withHealthcare(bad))), `${bad}`).toBe("spending_invalid");
    for (const good of [0, 1000]) expect(() => prepareStrategies(withHealthcare(good))).not.toThrow();
    const withCare = (lastYears: number) => ({ ...base, spending: { ...base.spending, longTermCare: [{ personId: "p1" as const, reserveCents: "1", lastYears }] } });
    for (const bad of [0, 11, 120]) expect(code(() => prepareStrategies(withCare(bad))), `${bad}`).toBe("spending_invalid");
    for (const good of [1, 10]) expect(() => prepareStrategies(withCare(good))).not.toThrow();
    expect(validateInput(withHealthcare(1_000_000_000)).map((i) => i.code)).toEqual(["spending_invalid"]);
  });

  it("refuses a malformed spending block", () => {
    const hc = { preMedicareAnnualCents: "0", preMedicareFrom: "2027-01", medicareFrom: "2027-01", medicareAnnualCents: "1", realGrowthBp: 0, inBase: false };
    expect(code(() => prepareStrategies(buildSimInput({ spending: { baseAnnualCents: "100", essentialAnnualCents: "101" } })))).toBe("spending_invalid");
    expect(code(() => prepareStrategies(buildSimInput({ spending: { goals: [{ id: "g", name: "g", year: 2026, amountCents: "1", dollars: "today" }] } })))).toBe(
      "spending_invalid",
    );
    expect(code(() => prepareStrategies(buildSimInput({ spending: { healthcare: [{ personId: "p2", ...hc }] } })))).toBe("person_missing");
    expect(code(() => prepareStrategies(buildSimInput({ spending: { longTermCare: [{ personId: "p2", reserveCents: "1", lastYears: 2 }] } })))).toBe("person_missing");
    expect(
      code(() =>
        prepareStrategies(
          buildSimInput({
            spending: {
              longTermCare: [
                { personId: "p1", reserveCents: "1", lastYears: 2 },
                { personId: "p1", reserveCents: "2", lastYears: 2 },
              ],
            },
          }),
        ),
      ),
    ).toBe("spending_invalid");
    // An input the schema would refuse, built past it: the engine still names the field.
    const badMonth = buildSimInput();
    badMonth.spending.startMonth = "2027-1";
    expect(code(() => prepareStrategies(badMonth))).toBe("month_invalid");
  });
});
