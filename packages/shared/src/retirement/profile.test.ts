import { describe, expect, it } from "vitest";
import { UnsupportedSchemaVersionError } from "./primitives.js";
import {
  AccountSetting,
  ClaimAge,
  DEFAULT_SPENDING_PHASES,
  defaultProfileDoc,
  IncomeStream,
  Longevity,
  Person,
  RetirementProfileDoc,
  RothConversion,
  SocialSecurityInput,
  Spending,
  upgradeProfileDoc,
} from "./profile.js";
import { fixtureBaseline, fixtureProfileDoc, forbiddenValuePaths, IDS } from "./testFixtures.js";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => schema.safeParse(value).success;
const person = { name: "Alex", birthYear: 1975, birthMonth: 6, retirementAge: 60, longevity: { mode: "fixed", age: 95 } };

describe("RetirementProfileDoc (inputs-and-data §4.2)", () => {
  it("7.0 the fixture document parses and the defaults are filled", () => {
    const doc = RetirementProfileDoc.parse(fixtureProfileDoc());
    expect(doc.incomes["salary_p2"]).toEqual({ kind: "salary", personId: "p2", annualGrossCents: "6000000", realRaiseBp: 0 });
    expect(doc.incomes["pen1"]).toMatchObject({ kind: "pension", dollars: "nominal", survivorBp: 5000, cola: { mode: "none" } });
    expect(doc.socialSecurity).toMatchObject({ spousal: true, survivor: true });
    expect(doc.spending).toMatchObject({ excludedCategoryIds: {}, includeUncategorized: true, survivorBp: 10000, phaseAnchor: "p1" });
    expect(doc.spending.goals["roof"]).toEqual({ name: "Roof", year: 2031, amountCents: "1800000", dollars: "today" });
    expect(doc.spending.healthcare).toEqual({ includedInBase: true, preMedicareAnnualCents: "0", medicareAnnualCents: "0", realGrowthBp: 0 });
    expect(doc.spending.longTermCare).toEqual({ reserveCents: "0", lastYears: 2, people: "each" });
    expect(doc.contributions).toEqual({});
    expect(doc.rothConversions["conv1"]).toEqual({ personId: "p1", fromYear: 2036, toYear: 2036, annualCents: "3000000", dollars: "today" });
    expect(doc.accounts[IDS.K]).toEqual({ owner: "p1" });
  });

  it("decision 2: the parsed document holds no float and no null, and parsing it again changes nothing", () => {
    const doc = RetirementProfileDoc.parse(fixtureProfileDoc());
    expect(forbiddenValuePaths(doc)).toEqual([]);
    expect(RetirementProfileDoc.parse(doc)).toEqual(doc);
    expect(RetirementProfileDoc.parse(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it("strict at every level: an unknown key is refused", () => {
    const at = (mutate: (d: ReturnType<typeof fixtureProfileDoc>) => void) => {
      const d = structuredClone(fixtureProfileDoc());
      mutate(d);
      return ok(RetirementProfileDoc, d);
    };
    expect(at(() => undefined)).toBe(true);
    expect(at((d) => Object.assign(d, { extra: 1 }))).toBe(false);
    expect(at((d) => Object.assign(d.people.p1, { nickname: "A" }))).toBe(false);
    expect(at((d) => Object.assign(d.people, { p3: person }))).toBe(false);
    expect(at((d) => Object.assign(d.accounts ?? {}, { [IDS.T]: { include: true, color: "red" } }))).toBe(false);
    expect(at((d) => Object.assign(d.incomes?.["salary_p1"] ?? {}, { bonusCents: "1" }))).toBe(false);
    expect(at((d) => Object.assign(d.spending.healthcare, { dental: "0" }))).toBe(false);
    expect(at((d) => Object.assign(d.socialSecurity, { p3: { mode: "none" } }))).toBe(false);
    expect(at((d) => Object.assign(d, { schemaVersion: 2 }))).toBe(false);
    expect(at((d) => Object.assign(d, { state: "co" }))).toBe(false);
  });

  it("maps are keyed by uuid (accounts, contributions, excluded categories) or by item id (incomes, goals, conversions)", () => {
    const d = fixtureProfileDoc();
    expect(ok(RetirementProfileDoc, { ...d, accounts: { "not-a-uuid": {} } })).toBe(false);
    expect(ok(RetirementProfileDoc, { ...d, incomes: { "Salary P1": d.incomes?.["salary_p1"] } })).toBe(false);
    expect(ok(Spending, { ...d.spending, excludedCategoryIds: { [IDS.rent]: true } })).toBe(true);
    expect(ok(Spending, { ...d.spending, excludedCategoryIds: { [IDS.rent]: false } })).toBe(false);
    expect(ok(Spending, { ...d.spending, excludedCategoryIds: { rent: true } })).toBe(false);
  });

  it("people and longevity", () => {
    expect(Person.parse({ ...person, name: "  Alex  " }).name).toBe("Alex");
    expect(ok(Person, { ...person, name: "   " })).toBe(false);
    expect(ok(Person, { ...person, birthMonth: 13 })).toBe(false);
    expect(ok(Person, { ...person, retirementMonth: "2035-06" })).toBe(true);
    expect(ok(Person, { ...person, retirementMonth: "2200-01" })).toBe(false);
    expect(Longevity.parse({ mode: "mortality", sex: "female" })).toEqual({ mode: "mortality", sex: "female", adjustYears: 0, maxAge: 110 });
    for (const bad of [{ mode: "fixed", age: 49 }, { mode: "fixed", age: 120 }, { mode: "mortality", sex: "female", maxAge: 89 }, { mode: "mortality", sex: "female", adjustYears: 11 }, { mode: "mortality", sex: "unisex" }]) {
      expect(ok(Longevity, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("claim ages run from 62 to 70 years 0 months", () => {
    expect(ok(ClaimAge, { years: 62, months: 0 })).toBe(true);
    expect(ok(ClaimAge, { years: 69, months: 11 })).toBe(true);
    expect(ok(ClaimAge, { years: 70, months: 0 })).toBe(true);
    expect(ClaimAge.safeParse({ years: 70, months: 1 }).error?.issues[0]?.message).toBe("claim by 70");
    expect(ok(ClaimAge, { years: 61, months: 11 })).toBe(false);
    expect(ok(SocialSecurityInput, { mode: "receiving", monthlyCents: "190000", asOfYear: 2026, startedMonth: "2025-03" })).toBe(true);
  });

  it("income streams: per-kind fields and defaults", () => {
    expect(IncomeStream.parse({ kind: "annuity", personId: "p1", name: "SPIA", monthlyCents: "50000", start: { at: "start" }, cola: { mode: "fixed", bp: 200 } })).toEqual({
      kind: "annuity",
      personId: "p1",
      name: "SPIA",
      monthlyCents: "50000",
      dollars: "nominal",
      start: { at: "start" },
      cola: { mode: "fixed", bp: 200 },
      survivorBp: 0,
      taxableBp: 10000,
    });
    expect(IncomeStream.parse({ kind: "other", name: "Gift", annualCents: "100", start: { at: "year", year: 2030 } })).toMatchObject({ dollars: "today", taxableBp: 10000, realGrowthBp: 0 });
    expect(ok(IncomeStream, { kind: "part_time", personId: "p1", annualCents: "100", start: { at: "start" } })).toBe(false);
    expect(ok(IncomeStream, { kind: "bonus", personId: "p1", annualCents: "100" })).toBe(false);
    expect(ok(IncomeStream, { kind: "salary", personId: "p1", annualGrossCents: "1234567890123456" })).toBe(false);
    expect(ok(IncomeStream, { kind: "salary", personId: "p1", annualGrossCents: "100", realRaiseBp: 1001 })).toBe(false);
    expect(ok(IncomeStream, { kind: "pension", personId: "p1", name: "P", monthlyCents: "1", start: { at: "start" }, cola: { mode: "fixed", bp: 1001 } })).toBe(false);
  });

  it("account settings take an expense ratio in ppm (seams C25)", () => {
    expect(AccountSetting.parse({ expenseRatioPpm: 270 })).toEqual({ expenseRatioPpm: 270 });
    expect(ok(AccountSetting, { expenseRatioPpm: 100_001 })).toBe(false);
    expect(ok(AccountSetting, { expenseRatioPpm: 2.7 })).toBe(false);
    expect(ok(AccountSetting, { basisCents: "-1" })).toBe(false);
  });

  it("spending phases, goals and conversions", () => {
    const s = fixtureProfileDoc().spending;
    const phase = { label: "x", fromAge: 60, multiplierBp: 10000 };
    expect(ok(Spending, { ...s, phases: [phase, phase, phase, phase] })).toBe(true);
    expect(ok(Spending, { ...s, phases: [phase, phase, phase, phase, phase] })).toBe(false);
    expect(ok(Spending, { ...s, phases: [{ ...phase, fromAge: 39 }] })).toBe(false);
    expect(ok(Spending, { ...s, phases: [{ ...phase, multiplierBp: 20001 }] })).toBe(false);
    expect(ok(Spending, { ...s, goals: { car: { name: "Car", year: 2030, amountCents: "3000000", repeat: { everyYears: 10, times: 3 } } } })).toBe(true);
    expect(ok(Spending, { ...s, goals: { car: { name: "Car", year: 2030, amountCents: "3000000", repeat: { everyYears: 0, times: 3 } } } })).toBe(false);
    expect(RothConversion.safeParse({ personId: "p1", fromYear: 2037, toYear: 2036, annualCents: "1" }).error?.issues[0]?.message).toBe("toYear before fromYear");
  });
});

describe("upgradeProfileDoc", () => {
  it("is the identity for version 1", () => {
    const doc = RetirementProfileDoc.parse(fixtureProfileDoc());
    expect(upgradeProfileDoc(doc)).toEqual(doc);
    expect(upgradeProfileDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it("refuses an unknown version", () => {
    expect(() => upgradeProfileDoc({ ...fixtureProfileDoc(), schemaVersion: 2 })).toThrow(UnsupportedSchemaVersionError);
    expect(() => upgradeProfileDoc({})).toThrow("RetirementProfileDoc: schemaVersion undefined is not supported");
    expect(() => upgradeProfileDoc(null)).toThrow(UnsupportedSchemaVersionError);
  });
});

describe("defaultProfileDoc (inputs-and-data §4.2)", () => {
  const people = RetirementProfileDoc.parse(fixtureProfileDoc()).people;

  it("the fixture household: every bucketed account reviewed, nothing assumed the owner did not type", () => {
    const doc = defaultProfileDoc(people, fixtureBaseline());
    expect(doc.state).toBe("CO");
    // The 529 has no bucket and is left out; the other seven accounts get an empty setting.
    expect(Object.keys(doc.accounts).sort()).toEqual([IDS.K, IDS.H, IDS.T, IDS.B, IDS.R, IDS.C, IDS.S].sort());
    expect(Object.values(doc.accounts).every((s) => Object.keys(s).length === 0)).toBe(true);
    expect(doc.allocation).toEqual({});
    expect(doc.incomes).toEqual({});
    expect(doc.socialSecurity).toEqual({ p1: { mode: "none" }, p2: { mode: "none" }, spousal: true, survivor: true });
    expect(doc.spending.base).toEqual({ mode: "live" });
    expect(doc.spending.essential).toEqual({ mode: "live" });
    // p1 retires at 60: phases from 60, 75 and 85 (test 11's 2035, 2050 and 2060 for a 1975 birth year).
    expect(doc.spending.phases).toEqual([
      { label: "Early active years", fromAge: 60, multiplierBp: 10000 },
      { label: "Slower years", fromAge: 75, multiplierBp: 10000 },
      { label: "Late life", fromAge: 85, multiplierBp: 10000 },
    ]);
    expect(doc.spending.goals).toEqual({});
    expect(doc.spending.healthcare).toEqual({ includedInBase: false, preMedicareAnnualCents: "0", medicareAnnualCents: "0", realGrowthBp: 0 });
    expect(doc.spending.longTermCare).toEqual({ reserveCents: "0", lastYears: 2, people: "each" });
    expect(doc.contributions).toEqual({});
    expect(doc.rothConversions).toEqual({});
    expect(RetirementProfileDoc.parse(doc)).toEqual(doc);
    expect(DEFAULT_SPENDING_PHASES.map((p) => p.label)).toEqual(["Early active years", "Slower years", "Late life"]);
  });

  it("one person: no second Social Security entry", () => {
    const doc = defaultProfileDoc({ p1: people.p1 }, { accounts: [] });
    expect(doc.people).toEqual({ p1: people.p1 });
    expect(doc.socialSecurity).toEqual({ p1: { mode: "none" }, spousal: true, survivor: true });
    expect(doc.accounts).toEqual({});
  });

  it("a phase whose age is not above the previous one is left out", () => {
    const phasesAt = (retirementAge: number) => defaultProfileDoc({ p1: { ...people.p1, retirementAge } }, { accounts: [] }).spending.phases.map((p) => p.fromAge);
    expect(phasesAt(80)).toEqual([80, 85]);
    expect(phasesAt(75)).toEqual([75, 85]);
    expect(phasesAt(85)).toEqual([85]);
    expect(phasesAt(90)).toEqual([90]);
    // Below 40, the phases' lowest age, the first phase starts at 40.
    expect(phasesAt(35)).toEqual([40, 75, 85]);
  });
});
