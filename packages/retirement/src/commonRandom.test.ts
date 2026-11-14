import type { ReturnModelConfigInput, SimInput } from "@meridian/shared";
import { describe, expect, it } from "vitest";
import { W, ZERO_YIELDS } from "./loopTestKit.js";
import { simulatePath } from "./loop.js";
import { prepare } from "./prepare.js";
import { createPathState } from "./state.js";
import { type SimInputOptions, account, buildSimInput, cashAccount, incomeStream, stubHooks } from "./testing/index.js";
import { TREATMENT } from "./prepare.js";
import { createProductionState } from "./simulate.js";

// T42 (engine-and-returns §7, seams F8): common random numbers. A market variate depends only on
// (seed, path, plan year, slot) (§3.3), so for the bootstrap and the parametric model the market of
// path 123 (its growth factors, the price factors and, with seams C22 and C18, the full-year
// inflation and bill returns of every plan year) is unchanged in its first 40 years when the
// spending, a retirement month, the withdrawal order or the mortality kind changes. Phase 5's
// paired scenario comparison rests on it.

const PATH = 123;
const YEARS = 40;

/** Born 1975 (52 in 2027), fixed age 95: Y = 44, plan from January 2027 (f = 1); a salary until retirement and two accounts. */
function household(o: Partial<SimInputOptions> = {}, returnModel: ReturnModelConfigInput): SimInput {
  return buildSimInput({
    people: [{ birthYear: 1975, birthMonth: 4, retirementMonth: "2035-04", longevity: { mode: "fixed", age: 95 } }],
    accounts: [account("k", "pre_tax", "60000000", { type: "401k", allocation: W(6000, 0, 4000, 0) }), cashAccount("cash", "5000000")],
    incomes: [incomeStream("salary", "salary", "9000000", "2027-01", { personId: "p1", endMonth: "2035-04" })],
    spending: { baseAnnualCents: "5000000", startMonth: "2035-04" },
    returnModel,
    paths: 200,
    seed: 20261110,
    tax: ZERO_YIELDS,
    ...o,
  });
}

interface Market {
  growth: Float64Array;
  priceFactor: Float64Array;
  inflationFull: Float64Array;
  billsFull: Float64Array;
}

/** Path 123's market after a full simulation of the path (the loop fills it). */
function marketOf(input: SimInput, production = true, order?: readonly number[]): Market {
  const run = prepare(input);
  const ps = production ? createProductionState(run) : createPathState(run, stubHooks(order));
  simulatePath(ps, PATH);
  const m = ps.market;
  return {
    growth: m.growth.slice(0, YEARS * 3),
    priceFactor: m.priceFactor.slice(0, YEARS),
    inflationFull: m.inflationFull.slice(0, YEARS),
    billsFull: m.billsFull.slice(0, YEARS),
  };
}

const bytes = (a: Float64Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

function expectSameMarket(a: Market, b: Market, what: string): void {
  for (const key of ["growth", "priceFactor", "inflationFull", "billsFull"] as const) {
    expect(bytes(a[key]).equals(bytes(b[key])), `${what}: ${key}`).toBe(true);
  }
}

const MODELS: Array<[string, ReturnModelConfigInput]> = [
  ["bootstrap", { kind: "bootstrap", meanBlockYears: 10 }],
  ["parametric", { kind: "parametric", preset: "historical" }],
];

describe.each(MODELS)("T42 common random numbers, %s model", (_name, model) => {
  const base = marketOf(household({}, model));

  it("T42 the market of path 123 has 40 years of draws that are not all alike", () => {
    expect(base.growth.length).toBe(120);
    expect(new Set(base.growth).size).toBeGreaterThan(30);
  });

  it("T42 unchanged when the spending changes (base 50,000 → 80,000, a goal, essential spending)", () => {
    const changed = household(
      { spending: { baseAnnualCents: "8000000", essentialAnnualCents: "4000000", startMonth: "2035-04", goals: [{ id: "car", name: "Car", year: 2040, amountCents: "3000000", dollars: "today" }] } },
      model,
    );
    expectSameMarket(base, marketOf(changed), "spending");
  });

  it("T42 unchanged when the retirement month changes (April 2035 → September 2041)", () => {
    const changed = household(
      {
        people: [{ birthYear: 1975, birthMonth: 4, retirementMonth: "2041-09", longevity: { mode: "fixed", age: 95 } }],
        incomes: [incomeStream("salary", "salary", "9000000", "2027-01", { personId: "p1", endMonth: "2041-09" })],
        spending: { baseAnnualCents: "5000000", startMonth: "2041-09" },
      },
      model,
    );
    expectSameMarket(base, marketOf(changed), "retirement");
  });

  it("T42 unchanged when the withdrawal order changes (a cash reserve; a stub order with pre-tax before cash)", () => {
    expectSameMarket(base, marketOf(household({ cashReserveCents: "2000000" }, model)), "cash reserve");
    const input = household({}, model);
    const stubDefault = marketOf(input, false);
    const stubOther = marketOf(input, false, [TREATMENT.pre_tax, TREATMENT.cash, TREATMENT.taxable, TREATMENT.roth, TREATMENT.hsa]);
    expectSameMarket(base, stubDefault, "stub order");
    expectSameMarket(base, stubOther, "another stub order");
  });

  it("T42 unchanged when the mortality kind changes (fixed age 95 → the table to 110, Y = 59)", () => {
    const changed = household({ people: [{ birthYear: 1975, birthMonth: 4, retirementMonth: "2035-04", longevity: { mode: "mortality", sex: "female", adjustYears: 0, maxAge: 110 } }] }, model);
    const run = prepare(changed);
    expect(run.years).toBe(2085 - 2027 + 1);
    expect(run.paths).toBe(200);
    expectSameMarket(base, marketOf(changed), "mortality");
  });

  it("T42 another seed or another path gives another market (the test can fail)", () => {
    const otherSeed = marketOf(household({ seed: 1 }, model));
    expect(bytes(otherSeed.growth).equals(bytes(base.growth))).toBe(false);
    const run = prepare(household({}, model));
    const ps = createProductionState(run);
    simulatePath(ps, PATH + 1);
    expect(bytes(ps.market.growth.slice(0, YEARS * 3)).equals(bytes(base.growth))).toBe(false);
  });
});
