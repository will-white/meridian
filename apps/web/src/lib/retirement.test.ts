import { RetirementCard, SimInput, type EffectiveInputsView } from "@meridian/shared";
import { fixtureSimInput } from "@meridian/shared/src/retirement/testFixtures.js";
import { describe, expect, it } from "vitest";
import { changeLabel, fanMarkers, hintInputs, strategyHints, successTone } from "./retirement.js";
import { retirementCardView, retirementStaleText, successText } from "./retirementCard.js";
import { R1_YEAR_TABLE } from "./retirementFixtures.js";

describe("successTone (strategies-outputs-web §1 decision 34)", () => {
  it("UI-1 9000 good; 8999 warning; 7500 warning; 7499 bad", () => {
    expect(successTone(9000)).toBe("ok");
    expect(successTone(8999)).toBe("warn");
    expect(successTone(7500)).toBe("warn");
    expect(successTone(7499)).toBe("bad");
    expect(successTone(10000)).toBe("ok");
    expect(successTone(0)).toBe("bad");
  });
});

describe("changeLabel (§5.3 ChangeChips)", () => {
  it("UI-2 retirement age 65 → 62; base spending 8,400,000 → 7,560,000; an unknown path → the path with both values", () => {
    expect(changeLabel("people.p1.retirementAge", 65, 62)).toBe("Retire at 62 instead of 65");
    // (7,560,000 − 8,400,000) × 10000 ÷ 8,400,000 = −1000 bp exactly.
    expect(changeLabel("spending.base.annualCents", "8400000", "7560000")).toBe("Spending −10%");
    expect(changeLabel("settings.mystery", 1, 2)).toBe("settings.mystery: 1 → 2");
    expect(changeLabel("state", "CO", "CA")).toBe("state: CO → CA");
    expect(changeLabel("spending.excludedCategoryIds.abc", true, undefined)).toBe("spending.excludedCategoryIds.abc: true → (removed)");
  });

  it("names people, truncates percentage changes and words additions and removals", () => {
    const names = { people: { p1: "Alex", p2: "Sam" }, account: (id: string) => (id === "k" ? "Acme 401(k)" : undefined) };
    expect(changeLabel("people.p2.retirementAge", 62, 64, names)).toBe("Sam: retire at 64 instead of 62");
    expect(changeLabel("people.p2.retirementAge", 62, 64)).toBe("Person 2: retire at 64 instead of 62");
    // 1 ÷ 3 of an increase: 3333.3 bp truncated to 3333 → "+33.3%".
    expect(changeLabel("spending.essential.annualCents", "300000", "400000")).toBe("Essential spending +33.3%");
    expect(changeLabel("spending.base.annualCents", undefined, "8400000")).toBe("Spending set to $84,000.00 a year");
    expect(changeLabel("spending.base.mode", "live", "manual")).toBe("Spending typed instead of from live data");
    expect(changeLabel("socialSecurity.p1.claimAge.years", 67, 70, names)).toBe("Alex: claim Social Security at 70 instead of 67");
    expect(changeLabel("people.p1.longevity.age", 95, 92)).toBe("Plan to age 92 instead of 95");
    expect(changeLabel("incomes.pen2", undefined, { kind: "pension", name: "Teacher pension" })).toBe("Adds income: Teacher pension");
    expect(changeLabel("incomes.pen1", { kind: "pension", name: "Sam's pension" }, undefined)).toBe("Removes income: Sam's pension");
    expect(changeLabel("spending.goals.boat", undefined, { name: "Boat", year: 2030 })).toBe("Adds goal: Boat (2030)");
    expect(changeLabel("rothConversions.c2", undefined, { personId: "p1", fromYear: 2030, toYear: 2034, annualCents: "2500000" })).toBe(
      "Adds a Roth conversion of $25,000.00 a year 2030 to 2034",
    );
    expect(changeLabel("accounts.k.include", undefined, false, names)).toBe("Leaves out Acme 401(k)");
    expect(changeLabel("spending.survivorBp", 10000, 8000)).toBe("Spending after a death: 80% instead of 100%");
    expect(changeLabel("people.p1.retirementMonth", undefined, "2034-06")).toBe("Retire in June 2034");
  });
});

describe("fanMarkers (§5.5 item 3)", () => {
  it("the fixture household: retirements, Social Security claims and Medicare after the plan start, by year", () => {
    // Alex: born 1975-06, retires 2035-06, claims 2042-06, Medicare 2040-06; Sam: born 1977-09,
    // retires 2039-09, claims 2044-09, Medicare 2042-09; the plan starts 2026-10.
    expect(fanMarkers(fixtureSimInput())).toEqual([
      { year: 2035, label: "Alex retires" },
      { year: 2039, label: "Sam retires" },
      { year: 2040, label: "Alex: Medicare" },
      { year: 2042, label: "Alex: Social Security" },
      { year: 2042, label: "Sam: Medicare" },
      { year: 2044, label: "Sam: Social Security" },
    ]);
  });

  it("R1's household: no marker at the plan start itself; the first RMD comes from the path's own table", () => {
    // R1: both born 1962-01, retired and on Medicare from the plan start 2027-01 (equal months make no
    // marker), both claim in 2029-01, and the table's first RMDs are in 2037 (age 75, born 1960 or later).
    const base = fixtureSimInput();
    const input = SimInput.parse({
      ...base,
      plan: { ...base.plan, startYear: 2027, startMonth: "2027-01", firstYearMonths: 12, endYear: 2047 },
      household: {
        ...base.household,
        people: [
          { id: "p1", name: "A", birthYear: 1962, birthMonth: 1, retirementMonth: "2027-01", longevity: { mode: "fixed", age: 85 } },
          { id: "p2", name: "B", birthYear: 1962, birthMonth: 1, retirementMonth: "2027-01", longevity: { mode: "fixed", age: 85 } },
        ],
      },
      socialSecurity: {
        ...base.socialSecurity,
        people: [
          { personId: "p1", mode: "estimate", monthlyAtFraCents: "300000", asOfYear: 2027, claimMonth: "2029-01", claimAgeMonths: 804 },
          { personId: "p2", mode: "estimate", monthlyAtFraCents: "180000", asOfYear: 2027, claimMonth: "2029-01", claimAgeMonths: 804 },
        ],
      },
    });
    expect(fanMarkers(input, R1_YEAR_TABLE)).toEqual([
      { year: 2029, label: "A: Social Security" },
      { year: 2029, label: "B: Social Security" },
      { year: 2037, label: "A: first RMD" },
      { year: 2037, label: "B: first RMD" },
    ]);
  });

  it("one person: labels carry no name", () => {
    const base = fixtureSimInput();
    const input = SimInput.parse({ ...base, household: { ...base.household, filingStatus: "single", people: [base.household.people[0]!] } });
    expect(fanMarkers(input).map((m) => m.label)).toEqual(["Retirement", "Medicare", "Social Security"]);
  });
});

function effective(includedTotalCents: string, baseSpendingCents: string, essentialSpendingCents: string): EffectiveInputsView {
  return { includedTotalCents, byBucketCents: {}, baseSpendingCents, essentialSpendingCents, contributionsCents: "0", employerCents: "0", accounts: [] };
}

describe("strategyHints (§5.4)", () => {
  it("UI-3 included total 2,742,857.00 and base 96,000.00 → 3.5% of today's portfolio; ages 70 and 64 at 50% stocks → 4.7%", () => {
    // 9,600,000 × 10000 ÷ 274,285,700 = 350.00004 → 350 bp → "3.5%".
    // VPW at the younger age 64 with g = 0.5 × 5% + 0.5 × 1.9% = 3.45% and n = 99 + 1 − 64 = 36:
    // 1.0345^36 = 3.39071; 0.0345 ÷ (1 − 1 ÷ 3.39071) ÷ 1.0345 = 0.0345 ÷ 0.705077 ÷ 1.0345 = 0.047300 → 472 bp → "4.7%".
    const hints = strategyHints({ includedTotalCents: "274285700", baseSpendingCents: "9600000", essentialSpendingCents: "5760000", ages: [70, 64], stockShareBp: 5000 });
    expect(hints.constant_dollar.hint).toBe("Your plan spends $96,000 a year, 3.5% of today's portfolio.");
    expect(hints.vpw.hint).toBe("At your ages and mix the first percentage is 4.7%.");
    // 274,285,700 × 400 ÷ 10000 = 10,971,428 cents → "$109,714".
    expect(hints.fixed_percentage.hint).toBe("At 4% the first withdrawal would be $109,714.");
    // 5,760,000 ÷ 9,600,000 = 6000 bp; discretionary 3,840,000 → 3,840,000 × 10000 ÷ 274,285,700 = 140.0 bp.
    expect(hints.floor_ceiling.hint).toBe("Essentials are 60% of your plan; your discretionary budget is $38,400, 1.4% of the portfolio.");
    expect(hints.fixed_percentage.note).toBe("Other income is spent in addition, so spending steps up when Social Security starts.");
    expect(hints.vpw.note).toBe(hints.fixed_percentage.note);
    expect(hints.guardrails.hint).toBeUndefined();
    expect(hints.guardrails.note).toMatch(/^The published rules assume no other income\./);
  });

  it("the design's own example: at 4% of 1,360,000 the first withdrawal is $54,400; the configured rate is used", () => {
    const inputs = { includedTotalCents: "136000000", baseSpendingCents: "9600000", essentialSpendingCents: "9600000", ages: [65], stockShareBp: 6000 };
    expect(strategyHints(inputs).fixed_percentage.hint).toBe("At 4% the first withdrawal would be $54,400.");
    expect(strategyHints(inputs, { strategy: { kind: "fixed_percentage", rateBp: 350 } }).fixed_percentage.hint).toBe("At 3.5% the first withdrawal would be $47,600.");
  });

  it("no portfolio and no base: the ratios are left out rather than divided by zero", () => {
    const hints = strategyHints({ includedTotalCents: "0", baseSpendingCents: "0", essentialSpendingCents: "0", ages: [], stockShareBp: 0 });
    expect(hints.constant_dollar.hint).toBe("Your plan spends $0 a year.");
    expect(hints.vpw.hint).toBeUndefined();
    expect(hints.floor_ceiling.hint).toBeUndefined();
  });

  it("hintInputs on the fixture: ages in the first year both are retired (2039), the balance-weighted stock share", () => {
    // Stock share (the default asset map: US, international, real estate, other → stocks; a cash account none):
    // K 15,000,000 × 7500 + H 125,000 × 7500 + T 432,500 × 10000 + B 2,705,200 × 9471 + R 1,820,000 × 5511
    // + the synthetic Roth 0; S and C (2,500,000) are cash. Σ = 112,500,000,000 + 937,500,000 + 4,325,000,000
    // + 25,620,949,200 + 10,030,020,000 = 153,413,469,200; ÷ 22,582,700 = 6793.4 → 6793 bp.
    const inputs = hintInputs(fixtureSimInput(), effective("22582700", "4000000", "2400000"));
    expect(inputs).toEqual({ includedTotalCents: "22582700", baseSpendingCents: "4000000", essentialSpendingCents: "2400000", ages: [64, 62], stockShareBp: 6793 });
    expect(hintInputs(null, effective("1", "1", "1"))).toBeNull();
  });
});

const CARD_BASE = {
  scenarioId: "b0000000-0000-4000-8000-000000000001",
  scenarioName: "Base plan",
  active: null,
  run: null,
  issues: 0,
} as const;

const RUN = {
  id: "d0000000-0000-4000-8000-000000000001",
  finishedAt: "2026-11-08",
  paths: 10000,
  successPaths: 9402,
  successBp: 9402,
  medianEndingRealCents: "120000000",
  p10EndingRealCents: "0",
  baselineAsOf: "2026-11-08",
  ageDays: 6,
  stale: { inputsChanged: false, engineChanged: false },
};

describe("the dashboard card (§5.8)", () => {
  it("UI-5 successBp 9420 → '94%' (truncated, never rounded up)", () => {
    expect(successText(9420)).toBe("94%");
    expect(successText(9999)).toBe("99%");
    expect(successText(10000)).toBe("100%");
  });

  it("UI-5 no profile: 'Plan your retirement' for the owner, nothing for the viewer", () => {
    expect(retirementCardView(null, false)).toEqual({ kind: "setup", title: "Plan your retirement", link: { to: "/retirement/profile", label: "Set up your retirement profile" } });
    expect(retirementCardView(null, true)).toBeNull();
  });

  it("UI-5 no_run, with and without issues", () => {
    const card = RetirementCard.parse({ ...CARD_BASE, state: "no_run" });
    expect(retirementCardView(card, false)).toEqual({ kind: "no_run", title: "No simulation yet", link: { to: "/retirement/scenarios/b0000000-0000-4000-8000-000000000001", label: "Base plan" } });
    expect(retirementCardView({ ...card, issues: 1 }, false)).toMatchObject({ issuesText: "1 thing to fix before a run" });
    expect(retirementCardView({ ...card, issues: 3 }, false)).toMatchObject({ issuesText: "3 things to fix before a run" });
  });

  it("UI-5 running: 'Simulating: 62%', the previous run's figures underneath", () => {
    const card = RetirementCard.parse({ ...CARD_BASE, state: "running", active: { runId: "d0000000-0000-4000-8000-000000000002", status: "running", progressBp: 6250 } });
    expect(retirementCardView(card, false)).toEqual({ kind: "running", title: "Simulating: 62%", progressBp: 6250 });
    const withPrevious = retirementCardView({ ...card, run: RUN }, false);
    expect(withPrevious).toMatchObject({ kind: "running", previous: { hero: "94%", countText: "9,402 of 10,000 simulated futures funded the plan" } });
  });

  it("UI-5 failed: a link to History", () => {
    expect(retirementCardView(RetirementCard.parse({ ...CARD_BASE, state: "failed" }), true)).toEqual({ kind: "failed", title: "The last run failed", link: { to: "/retirement/history", label: "History" } });
  });

  it("UI-5 ready: hero, tone, the count, wealth in today's dollars, the run line, the disclaimer as the title; stale lines", () => {
    const card = RetirementCard.parse({ ...CARD_BASE, state: "ready", run: RUN });
    expect(retirementCardView(card, false)).toEqual({
      kind: "ready",
      hero: "94%",
      tone: "ok",
      countText: "9,402 of 10,000 simulated futures funded the plan",
      wealthText: "Median ending wealth $1.2M, 10th percentile $0 (today's dollars)",
      runText: "Base plan · run 11/08/26",
      link: { to: "/retirement?scenario=b0000000-0000-4000-8000-000000000001", label: "Open retirement plan" },
      title: "The planner is an estimate, not tax or investment advice.",
    });
    const stale = retirementCardView({ ...card, run: { ...RUN, stale: { inputsChanged: true, engineChanged: false } } }, false);
    expect(stale).toMatchObject({ staleText: "Your accounts or profile changed since this run" });
    expect(retirementStaleText({ inputsChanged: false, engineChanged: true })).toBe("The engine or its data was updated");
    expect(retirementStaleText(null)).toBeNull();
    expect(retirementStaleText({ inputsChanged: false, engineChanged: false })).toBeNull();
  });
});
