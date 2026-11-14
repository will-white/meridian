import { describe, expect, it } from "vitest";
import { looseWireFields } from "../wire.js";
import { SimInput, SimInputAccount, SimInputHealthcare, SYNTHETIC_CASH_ACCOUNT_ID, syntheticRothAccountId } from "./input.js";
import { fixtureSimInput, forbiddenValuePaths } from "./testFixtures.js";

const ok = (value: unknown) => SimInput.safeParse(value).success;

describe("SimInput (inputs-and-data §4.5, seams §2.1)", () => {
  it("11 (shape): the fixture's frozen input parses unchanged and contains no float and no null", () => {
    const input = fixtureSimInput();
    expect(SimInput.parse(input)).toEqual(input);
    expect(forbiddenValuePaths(input)).toEqual([]);
    // Test 11: eight accounts whose balances sum to 22,582,700.
    expect(input.accounts).toHaveLength(8);
    expect(input.accounts.reduce((a, x) => a + BigInt(x.balanceCents), 0n)).toBe(22_582_700n);
    expect(SimInput.parse(JSON.parse(JSON.stringify(input)))).toEqual(input);
  });

  it("C25: every account carries an integer expense ratio in ppm (0 when unknown)", () => {
    const account = fixtureSimInput().accounts[0]!;
    expect(SimInputAccount.parse({ ...account, expenseRatioPpm: 270 }).expenseRatioPpm).toBe(270);
    const { expenseRatioPpm: _dropped, ...without } = account;
    expect(SimInputAccount.safeParse(without).success).toBe(false);
    for (const bad of [-1, 100_001, 2.7]) expect(SimInputAccount.safeParse({ ...account, expenseRatioPpm: bad }).success, String(bad)).toBe(false);
  });

  it("C35: healthcare keeps the entered amounts and says whether they are in base spending", () => {
    const entry = { personId: "p1", preMedicareAnnualCents: "1200000", preMedicareFrom: "2035-06", medicareFrom: "2040-06", medicareAnnualCents: "700000", realGrowthBp: 100, inBase: true };
    expect(SimInputHealthcare.parse(entry)).toEqual(entry);
    const { inBase: _dropped, ...without } = entry;
    expect(SimInputHealthcare.safeParse(without).success).toBe(false);
  });

  it("C24: the synthetic cash account", () => {
    expect(SYNTHETIC_CASH_ACCOUNT_ID).toBe("synthetic:cash");
    expect(syntheticRothAccountId("p2")).toBe("synthetic:roth:p2");
    const input = fixtureSimInput();
    const synthetic = {
      id: SYNTHETIC_CASH_ACCOUNT_ID,
      name: "Cash",
      bucket: "cash",
      owner: "joint",
      balanceCents: "0",
      allocation: { us_stock: 0, intl_stock: 0, bonds: 0, cash: 10000, real_estate: 0, other: 0 },
      allocationSource: "cash",
      expenseRatioPpm: 0,
      synthetic: true,
    };
    expect(ok({ ...input, accounts: [...input.accounts, synthetic] })).toBe(true);
  });

  it("strict at every level", () => {
    const at = (mutate: (i: ReturnType<typeof fixtureSimInput>) => void) => {
      const input = structuredClone(fixtureSimInput());
      mutate(input);
      return ok(input);
    };
    expect(at(() => undefined)).toBe(true);
    expect(at((i) => Object.assign(i, { engine: "1.0.0" }))).toBe(false);
    expect(at((i) => Object.assign(i.meta, { user: "x" }))).toBe(false);
    expect(at((i) => Object.assign(i.data, { checksum: "x" }))).toBe(false);
    expect(at((i) => Object.assign(i.plan, { asOf: "2026-10-13" }))).toBe(false);
    expect(at((i) => Object.assign(i.household, { members: 2 }))).toBe(false);
    expect(at((i) => Object.assign(i.household.people[0]!, { sex: "male" }))).toBe(false);
    expect(at((i) => Object.assign(i.accounts[0]!, { holdingsCents: {} }))).toBe(false);
    expect(at((i) => Object.assign(i.incomes[0]!, { growth: { kind: "real" } }))).toBe(false);
    expect(at((i) => Object.assign(i.socialSecurity.people[0]!, { fraMonths: 804 }))).toBe(false);
    expect(at((i) => Object.assign(i.spending, { strategy: {} }))).toBe(false);
    expect(at((i) => Object.assign(i.spending.goals[0]!, { repeat: {} }))).toBe(false);
    expect(at((i) => Object.assign(i.contributions[0]!, { source: "employer" }))).toBe(false);
    expect(at((i) => Object.assign(i.rothConversions[0]!, { fromAccountId: "x" }))).toBe(false);
    expect(at((i) => Object.assign(i.settings, { assetClassMap: {} }))).toBe(false);
  });

  it("literals, counts and the settings block", () => {
    const input = fixtureSimInput();
    expect(ok({ ...input, schema: "meridian.retirement.engine" })).toBe(false);
    expect(ok({ ...input, schemaVersion: 2 })).toBe(false);
    expect(ok({ ...input, plan: { ...input.plan, firstYearMonths: 0 } })).toBe(false);
    expect(ok({ ...input, plan: { ...input.plan, firstYearMonths: 13 } })).toBe(false);
    expect(ok({ ...input, plan: { ...input.plan, currency: "EUR" } })).toBe(false);
    expect(ok({ ...input, plan: { ...input.plan, stepsPerYear: 12 } })).toBe(false);
    expect(ok({ ...input, accounts: [] })).toBe(false);
    expect(ok({ ...input, household: { ...input.household, people: [] } })).toBe(false);
    expect(ok({ ...input, household: { ...input.household, filingStatus: "married_separate" } })).toBe(false);
    expect(ok({ ...input, settings: { ...input.settings, paths: 50 } })).toBe(false);
    expect(ok({ ...input, accounts: input.accounts.map((a) => ({ ...a, balanceCents: "-1" })) })).toBe(false);
    expect(ok({ ...input, meta: { ...input.meta, provenance: { "spending.base": "guess" } } })).toBe(false);
  });

  it("is a stored document and a response, never a request: it uses the loose wire shapes", () => {
    expect(looseWireFields(SimInput)).toContain("meta.today (IsoDateString)");
    expect(looseWireFields(SimInput)).toContain("plan.startMonth (MonthString)");
  });

  it("contracts-01: the integer fields hold safe integers in the profile's ranges (growth, care years, claim ages, revisions)", () => {
    const at = (mutate: (i: ReturnType<typeof fixtureSimInput>) => void) => {
      const input = structuredClone(fixtureSimInput());
      mutate(input);
      return ok(input);
    };
    // The review's probe: realGrowthBp 1,000,000,000 and 2^53 parsed, and the second could not be hashed.
    for (const bad of [1_000_000_000, 2 ** 53, 1001, -501]) expect(at((i) => void (i.incomes[1]!.realGrowthBp = bad)), `income ${bad}`).toBe(false);
    for (const good of [-500, 0, 1000]) expect(at((i) => void (i.incomes[1]!.realGrowthBp = good)), `income ${good}`).toBe(true);
    const hc = { personId: "p1", preMedicareAnnualCents: "1200000", preMedicareFrom: "2035-06", medicareFrom: "2040-06", medicareAnnualCents: "700000", inBase: true };
    for (const bad of [1001, -1, 2 ** 53]) expect(SimInputHealthcare.safeParse({ ...hc, realGrowthBp: bad }).success, `healthcare ${bad}`).toBe(false);
    for (const good of [0, 1000]) expect(SimInputHealthcare.safeParse({ ...hc, realGrowthBp: good }).success, `healthcare ${good}`).toBe(true);
    const ltc = (lastYears: number) => (i: ReturnType<typeof fixtureSimInput>) => void (i.spending.longTermCare = [{ personId: "p1", reserveCents: "100", lastYears }]);
    for (const bad of [0, 11, 2 ** 53]) expect(at(ltc(bad)), `lastYears ${bad}`).toBe(false);
    for (const good of [1, 10]) expect(at(ltc(good)), `lastYears ${good}`).toBe(true);
    const claim = (months: number) => (i: ReturnType<typeof fixtureSimInput>) => {
      const p = i.socialSecurity.people[0]!;
      if (p.mode === "estimate") p.claimAgeMonths = months;
    };
    expect(fixtureSimInput().socialSecurity.people[0]!.mode).toBe("estimate");
    for (const bad of [743, 841, 2 ** 53]) expect(at(claim(bad)), `claim ${bad}`).toBe(false);
    for (const good of [744, 840]) expect(at(claim(good)), `claim ${good}`).toBe(true);
    for (const bad of [-1, 2 ** 53]) {
      expect(at((i) => void (i.meta.profileRevision = bad)), `profileRevision ${bad}`).toBe(false);
      expect(at((i) => void (i.meta.scenarioRevision = bad)), `scenarioRevision ${bad}`).toBe(false);
    }
  });

  it("contracts-02: spending phases run in strictly ascending years (the multiplier is the last phase with fromYear ≤ year, whatever the order)", () => {
    const phases = (list: Array<{ fromYear: number; multiplierBp: number }>) => (i: ReturnType<typeof fixtureSimInput>) => void (i.spending.phases = list);
    const at = (mutate: (i: ReturnType<typeof fixtureSimInput>) => void) => {
      const input = structuredClone(fixtureSimInput());
      mutate(input);
      return ok(input);
    };
    expect(at(phases([{ fromYear: 2035, multiplierBp: 5000 }, { fromYear: 2060, multiplierBp: 10000 }]))).toBe(true);
    // The review's unsorted pair, and a repeated year.
    expect(at(phases([{ fromYear: 2060, multiplierBp: 10000 }, { fromYear: 2035, multiplierBp: 5000 }]))).toBe(false);
    expect(at(phases([{ fromYear: 2035, multiplierBp: 5000 }, { fromYear: 2035, multiplierBp: 10000 }]))).toBe(false);
    expect(at(phases([]))).toBe(true);
  });

  it("contracts-03: cents are written without leading zeros, so equal amounts have one spelling and one hash", () => {
    const at = (mutate: (i: ReturnType<typeof fixtureSimInput>) => void) => {
      const input = structuredClone(fixtureSimInput());
      mutate(input);
      return ok(input);
    };
    expect(fixtureSimInput().accounts[0]!.balanceCents).toBe("15000000");
    // The review's probe: "015000000" parsed and hashed differently from "15000000".
    expect(at((i) => void (i.accounts[0]!.balanceCents = "015000000"))).toBe(false);
    expect(at((i) => void (i.accounts[0]!.balanceCents = "00"))).toBe(false);
    expect(at((i) => void (i.accounts[0]!.balanceCents = "0"))).toBe(true);
    expect(at((i) => void (i.spending.baseAnnualCents = "04000000"))).toBe(false);
    expect(at((i) => void (i.incomes[0]!.annualCents = "0100"))).toBe(false);
    expect(at((i) => void (i.contributions[0]!.employeeAnnualCents = "0100"))).toBe(false);
    expect(at((i) => void (i.rothConversions[0]!.amountCents = "0100"))).toBe(false);
  });
});
