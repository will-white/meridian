import { defaultRunSettings, mergePatch, ParametricParams, resolvePlan, RetirementProfileDoc, RunSettings, type ScenarioView } from "@meridian/shared";
import { fixtureBaseline, fixtureProfileDoc, fixtureResolveArgs, fixtureResolveContext } from "@meridian/shared/src/retirement/testFixtures.js";
import { describe, expect, it } from "vitest";
import {
  addGlidePoint,
  COHORT_CHOICES,
  draftChanges,
  draftPatch,
  duplicateName,
  editDraft,
  essentialsShareText,
  glidePathForm,
  glidePreview,
  HISTORY_START_PARAMS,
  inlineIssues,
  isChanged,
  parametricForm,
  parseGlidePathForm,
  parseParametricForm,
  parseRunSettingsForm,
  pathsField,
  profileValue,
  removeGlidePoint,
  resetToProfile,
  runSettingsForm,
  scenarioSaveBody,
  seedHint,
  setAt,
  spendingEvidence,
  startScenarioDraft,
  valueAt,
} from "./retirementForms.js";

const PROFILE = RetirementProfileDoc.parse(fixtureProfileDoc());

function scenario(overrides: Record<string, unknown>, doc: RetirementProfileDoc | null): Pick<ScenarioView, "overrides" | "doc" | "revision"> {
  return { overrides, doc, revision: 4 };
}

describe("dot paths", () => {
  it("valueAt and setAt read and write nested keys and array items without mutating", () => {
    const doc = { a: { b: [1, { c: 2 }] } };
    expect(valueAt(doc, "a.b.1.c")).toBe(2);
    expect(valueAt(doc, "a.x.y")).toBeUndefined();
    const next = setAt(doc, "a.b.1.c", 3);
    expect(next).toEqual({ a: { b: [1, { c: 3 }] } });
    expect(doc).toEqual({ a: { b: [1, { c: 2 }] } });
    expect(setAt(doc, "a.new.deep", "v")).toEqual({ a: { b: [1, { c: 2 }], new: { deep: "v" } } });
    expect(setAt(doc, "a.b", undefined)).toEqual({ a: {} });
    expect(setAt(doc, "a.b.0", undefined)).toEqual({ a: { b: [{ c: 2 }] } });
    // A key named __proto__ stays a key.
    const odd = setAt({}, "__proto__.x", 1) as Record<string, unknown>;
    expect(Object.getPrototypeOf(odd)).toBe(Object.prototype);
    expect(Object.keys(odd)).toEqual(["__proto__"]);
  });
});

describe("the scenario editor's merge-patch flow (inputs-and-data §3.3, §4.7)", () => {
  it("inputs §3.3's worked example: the patch the server will store, its five leaves and their labels", () => {
    // Base: retirement age 60, manual spending 4,000,000, salary 12,000,000, a pension. Target: age 58,
    // live spending, salary 11,000,000, no pension.
    const base = RetirementProfileDoc.parse({
      ...fixtureProfileDoc(),
      spending: { ...fixtureProfileDoc().spending, base: { mode: "manual", annualCents: "4000000" } },
    });
    let draft = startScenarioDraft({ doc: base, revision: 7 }, scenario({}, base));
    draft = editDraft(draft, "people.p1.retirementAge", 58);
    draft = editDraft(draft, "spending.base", { mode: "live" });
    draft = editDraft(draft, "incomes.salary_p1.annualGrossCents", "11000000");
    draft = editDraft(draft, "incomes.pen1", undefined);
    expect(draftPatch(draft)).toEqual({
      incomes: { pen1: null, salary_p1: { annualGrossCents: "11000000" } },
      people: { p1: { retirementAge: 58 } },
      spending: { base: { annualCents: null, mode: "live" } },
    });
    expect(mergePatch(base, draftPatch(draft))).toEqual(draft.doc);
    const changes = draftChanges(draft, { people: { p1: "Alex", p2: "Sam" } });
    expect(changes.map((c) => c.path)).toEqual(["incomes.pen1", "incomes.salary_p1.annualGrossCents", "people.p1.retirementAge", "spending.base.annualCents", "spending.base.mode"]);
    expect(changes.map((c) => c.label)).toEqual([
      "Removes income: Sam's pension",
      "incomes.salary_p1.annualGrossCents: 12000000 → 11000000",
      "Alex: retire at 58 instead of 60",
      "Spending from live data",
      "Spending from live data instead of typed",
    ]);
  });

  it("a field edited back to the profile's value leaves the patch; changed fields are marked with the profile's value beside them", () => {
    let draft = startScenarioDraft({ doc: PROFILE, revision: 2 }, scenario({}, PROFILE));
    draft = editDraft(draft, "people.p2.retirementAge", 64);
    expect(isChanged(draft, "people.p2.retirementAge")).toBe(true);
    expect(isChanged(draft, "people.p2")).toBe(true);
    expect(isChanged(draft, "people.p1.retirementAge")).toBe(false);
    expect(profileValue(draft, "people.p2.retirementAge")).toBe(62);
    draft = editDraft(draft, "people.p2.retirementAge", 62);
    expect(draftPatch(draft)).toEqual({});
    // A whole new item marks every field inside it.
    draft = editDraft(draft, "spending.goals.boat", { name: "Boat", year: 2030, amountCents: "1000000", dollars: "today" });
    expect(isChanged(draft, "spending.goals.boat.year")).toBe(true);
  });

  it("Reset to profile restores the profile's value, or removes what the profile does not have", () => {
    let draft = startScenarioDraft({ doc: PROFILE, revision: 2 }, scenario({}, PROFILE));
    draft = editDraft(editDraft(draft, "people.p1.retirementAge", 55), "spending.goals.boat", { name: "Boat", year: 2030, amountCents: "1000000", dollars: "today" });
    draft = resetToProfile(draft, "people.p1.retirementAge");
    expect(valueAt(draft.doc, "people.p1.retirementAge")).toBe(60);
    draft = resetToProfile(draft, "spending.goals.boat");
    expect(valueAt(draft.doc, "spending.goals.boat")).toBeUndefined();
    expect(draftPatch(draft)).toEqual({});
  });

  it("the save body carries both revisions and the whole document; an invalid document is refused with its path", () => {
    const draft = editDraft(startScenarioDraft({ doc: PROFILE, revision: 2 }, scenario({}, PROFILE)), "people.p1.retirementAge", 58);
    const save = scenarioSaveBody(draft);
    expect(save.ok).toBe(true);
    if (save.ok) {
      expect(save.body.expectedRevision).toBe(4);
      expect(save.body.profileRevision).toBe(2);
      expect(save.body.doc?.people.p1.retirementAge).toBe(58);
    }
    const bad = scenarioSaveBody(editDraft(draft, "people.p1.retirementAge", 12));
    expect(bad).toMatchObject({ ok: false, path: "people.p1.retirementAge" });
  });

  it("a scenario whose overrides no longer apply starts from the profile and says why (override_invalid)", () => {
    const draft = startScenarioDraft({ doc: PROFILE, revision: 2 }, scenario({ people: { p1: { retirementAge: "sixty" } } }, null));
    expect(draft.doc).toEqual(PROFILE);
    expect(draft.overridesLost?.path).toBe("people.p1.retirementAge");
    const applied = startScenarioDraft({ doc: PROFILE, revision: 2 }, scenario({ people: { p1: { retirementAge: 58 } } }, null));
    expect(applied.overridesLost).toBeUndefined();
    expect(applied.doc.people.p1.retirementAge).toBe(58);
  });

  it("duplicate names are unique without regard to case", () => {
    expect(duplicateName("Base plan", ["Base plan"])).toBe("Base plan (copy)");
    expect(duplicateName("Base plan", ["Base plan", "base plan (COPY)"])).toBe("Base plan (copy 2)");
  });
});

describe("the household glide-path editor (seams G3)", () => {
  const start = { age: 60, weights: { us_stock: 6000, intl_stock: 2000, bonds: 1500, cash: 500, real_estate: 0, other: 0 } };

  it("inputs §3.9's worked example through the form: 60 / 20 / 15 / 5 at 2030, 40 / 10 / 40 / 10 at 2033, previewed with glideWeightsAt", () => {
    // Reference born 1970: ages 60 and 63 are 2030 and 2033.
    let form = glidePathForm(undefined, start);
    form = addGlidePoint(form);
    form = { ...form, points: [form.points[0]!, { age: "63", weights: { us_stock: "40", intl_stock: "10", bonds: "40", cash: "10", real_estate: "", other: "" } }] };
    const parsed = parseGlidePathForm(form, { p2: {} });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.glidePath).toEqual({
      reference: "p1",
      points: [
        { age: 60, weights: { us_stock: 6000, intl_stock: 2000, bonds: 1500, cash: 500, real_estate: 0, other: 0 } },
        { age: 63, weights: { us_stock: 4000, intl_stock: 1000, bonds: 4000, cash: 1000, real_estate: 0, other: 0 } },
      ],
    });
    const preview = glidePreview(parsed.glidePath, 1970, 2029, 2034);
    expect(preview.map((p) => p.age)).toEqual([59, 60, 61, 62, 63, 64]);
    // 2031 (d 1, span 3): 5333, 1667, 2333, 667 (the design's largest remainder).
    expect(preview[2]!.weights).toEqual({ us_stock: 5333, intl_stock: 1667, bonds: 2333, cash: 667, real_estate: 0, other: 0 });
    expect(preview[0]!.weights).toEqual(parsed.glidePath.points[0]!.weights);
    expect(preview[5]!.weights).toEqual(parsed.glidePath.points[1]!.weights);
  });

  it("errors inline: ages that do not rise, a mix that is not 100%, a second person the household lacks", () => {
    const form = glidePathForm(undefined, { ...start, reference: "p2" });
    const twice = addGlidePoint(form);
    const bad = { ...twice, points: [twice.points[0]!, { ...twice.points[1]!, age: "60", weights: { ...twice.points[1]!.weights, cash: "6" } }] };
    const parsed = parseGlidePathForm(bad, {});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual([
      { field: "reference", message: "The household has one person" },
      { point: 1, field: "age", message: "Ages must rise from one point to the next" },
      // cash 5% → 6% adds 100 bp: 10100 bp in all.
      { point: 1, field: "weights", message: "The mix must add up to 100% (now 101%)" },
    ]);
  });

  it("adds five years at a time with the last mix, keeps at least one point and at most twelve", () => {
    let form = glidePathForm(undefined, start);
    form = addGlidePoint(form);
    expect(form.points[1]!.age).toBe("65");
    expect(form.points[1]!.weights).toEqual(form.points[0]!.weights);
    expect(removeGlidePoint(removeGlidePoint(form, 0), 0).points).toHaveLength(1);
    for (let i = 0; i < 20; i++) form = addGlidePoint(form);
    expect(form.points).toHaveLength(12);
    expect(form.points[11]!.age).toBe("115");
    expect(glidePathForm({ reference: "p2", points: [{ age: 70, weights: start.weights }] }, start)).toEqual({
      reference: "p2",
      points: [{ age: "70", weights: { us_stock: "60", intl_stock: "20", bonds: "15", cash: "5", real_estate: "", other: "" } }],
    });
  });
});

describe("the custom parametric form (seams G2)", () => {
  it("starts from history, parses back to the same integers, and is a valid ParametricParams", () => {
    expect(ParametricParams.safeParse(HISTORY_START_PARAMS).success).toBe(true);
    const form = parametricForm();
    expect(form.stocks).toEqual({ mean: "11.85", vol: "19.4" });
    expect(form.inflation).toEqual({ mean: "3.11", vol: "3.9" });
    expect(parseParametricForm(form)).toEqual({ ok: true, params: HISTORY_START_PARAMS });
  });

  it("R4's custom figures (r4.md §1) from typed percentages; correlations and persistence kept from the saved parameters", () => {
    const r4 = ParametricParams.parse({
      meanKind: "arithmetic",
      stocks: { meanBp: 600, volBp: 1200 },
      bonds: { meanBp: 400, volBp: 700 },
      bills: { meanBp: 300, volBp: 200, persistenceBp: 0 },
      inflation: { meanBp: 250, volBp: 100, persistenceBp: 0 },
      correlationBp: [
        [10000, 0, 0, 0],
        [0, 10000, 0, 0],
        [0, 0, 10000, 0],
        [0, 0, 0, 10000],
      ],
    });
    expect(parametricForm(r4).inflation).toEqual({ mean: "2.5", vol: "1" });
    const edited = { ...parametricForm(r4), stocks: { mean: "6.5", vol: "12" }, meanKind: "geometric" as const };
    const parsed = parseParametricForm(edited, r4);
    expect(parsed).toEqual({ ok: true, params: { ...r4, meanKind: "geometric", stocks: { meanBp: 650, volBp: 1200 } } });
  });

  it("refuses a mean outside −50% to 100%, a negative volatility and more than two decimals", () => {
    const form = { ...parametricForm(), stocks: { mean: "-51", vol: "-1" }, bonds: { mean: "4.123", vol: "7" } };
    const parsed = parseParametricForm(form);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.map((e) => e.field)).toEqual(["stocks.mean", "stocks.vol", "bonds.mean"]);
    expect(parseParametricForm({ ...parametricForm(), stocks: { mean: "−5", vol: "18" } })).toMatchObject({ ok: true, params: { stocks: { meanBp: -500, volBp: 1800 } } });
  });
});

describe("the run-settings form (§5.4, plan decisions 6 and 7)", () => {
  it("a new scenario: the bootstrap with a mean block of 10, 10,000 paths, seed 1, constant spending; parsing it returns the defaults", () => {
    const base = defaultRunSettings();
    const form = runSettingsForm();
    expect(form).toMatchObject({ model: "bootstrap", meanBlockYears: "10", paths: "10000", seed: "1", strategy: "constant_dollar", cashReserve: "0", taxableRebalance: "full", cohorts: "auto" });
    expect(parseRunSettingsForm(form, base)).toEqual({ ok: true, settings: base });
  });

  it("the historical model: cohorts auto, complete or wrap; the paths field disabled and kept", () => {
    const base = RunSettings.parse({ ...defaultRunSettings(), paths: 2500 });
    const form = { ...runSettingsForm(base), model: "historical" as const, cohorts: "complete" as const, paths: "not a number" };
    expect(pathsField(form)).toEqual({ disabled: true, note: "One path per historical start year" });
    const parsed = parseRunSettingsForm(form, base);
    expect(parsed).toMatchObject({ ok: true, settings: { paths: 2500, returnModel: { kind: "historical", cohorts: "complete" } } });
    expect(pathsField({ model: "bootstrap" })).toEqual({ disabled: false });
  });

  it("the cohort choices say when auto picks complete stretches: every life a fixed age and at least 30 of them (plan decision 7)", () => {
    // The engine's planCohorts: complete when allFixedLongevity && complete >= MIN_COMPLETE_COHORTS (30), wrap otherwise.
    expect(COHORT_CHOICES).toEqual([
      { value: "auto", label: "Complete stretches of history when every life is a fixed age and at least 30 stretches exist, else wrap around (default)" },
      { value: "complete", label: "Complete stretches of history only" },
      { value: "wrap", label: "Every start year, wrapping around to the first year of the record" },
    ]);
  });

  it("strategies: the chosen kind from its fields, the others keep their defaults; a typed reserve in dollars", () => {
    const base = defaultRunSettings();
    const form = runSettingsForm(base);
    expect(form.strategyFields).toMatchObject({ fixedRate: "4", upperBand: "20", cut: "10", stockReal: "5", bondReal: "1.9", maxRate: "10", floorCeilingRate: "", floor: "15", ceiling: "20" });
    const guard = parseRunSettingsForm({ ...form, strategy: "guardrails", strategyFields: { ...form.strategyFields, cut: "12.5", planningAge: "97" }, cashReserve: "25,000" }, base);
    expect(guard).toMatchObject({
      ok: true,
      settings: {
        strategy: { kind: "guardrails", upperBandBp: 2000, lowerBandBp: 2000, cutBp: 1250, raiseBp: 1000, skipInflationAfterLoss: true, preservationCutoffYears: 15, planningAge: 97 },
        withdrawalOrder: { kind: "default", cashReserveCents: "2500000" },
      },
    });
    const fc = parseRunSettingsForm({ ...form, strategy: "floor_ceiling", strategyFields: { ...form.strategyFields, floorCeilingRate: "3.75" } }, base);
    expect(fc).toMatchObject({ ok: true, settings: { strategy: { kind: "floor_ceiling", rateBp: 375, floorBp: 1500, ceilingBp: 2000 } } });
    const back = runSettingsForm((guard as { settings: RunSettings }).settings);
    expect(back.strategyFields.cut).toBe("12.5");
    expect(back.cashReserve).toBe("25000");
  });

  it("the custom preset keeps the saved correlations; flows-only and the payroll switch; errors by field", () => {
    const base = defaultRunSettings();
    const form = { ...runSettingsForm(base), model: "parametric" as const, preset: "custom" as const, taxableRebalance: "flows_only" as const, includePayrollTax: false };
    const parsed = parseRunSettingsForm(form, base);
    expect(parsed).toMatchObject({ ok: true, settings: { returnModel: { kind: "parametric", preset: "custom", params: HISTORY_START_PARAMS }, portfolio: { taxableRebalance: "flows_only" }, tax: { includePayrollTax: false } } });
    const bad = parseRunSettingsForm({ ...form, paths: "50", seed: "-1", custom: { ...form.custom, bills: { mean: "x", vol: "3" } }, strategy: "vpw", strategyFields: { ...form.strategyFields, lastWithdrawalAge: "80" } }, base);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((e) => e.field)).toEqual(["paths", "seed", "custom.bills.mean", "strategy.lastWithdrawalAge"]);
    expect(parseRunSettingsForm({ ...runSettingsForm(base), model: "parametric", preset: "conservative" }, base)).toMatchObject({ ok: true, settings: { returnModel: { kind: "parametric", preset: "conservative" } } });
  });

  it("a fixed test model is shown, not offered, and kept as it is", () => {
    const base = RunSettings.parse({ ...defaultRunSettings(), returnModel: { kind: "fixed", series: [{ stocksPpm: 50000, bondsPpm: 30000, billsPpm: 20000, inflationPpm: 25000 }] } });
    const form = runSettingsForm(base);
    expect(form.model).toBe("fixed");
    expect(pathsField(form).disabled).toBe(true);
    expect(parseRunSettingsForm(form, base)).toEqual({ ok: true, settings: base });
  });
});

describe("seed hints and evidence (§5.2)", () => {
  it("provenance in words; a typed value shows the live one, prominent beyond 2% or $500 a year, whichever is larger", () => {
    expect(seedHint({ provenance: "live", valueCents: "8420000" })).toEqual({ label: "from live data", useLive: false, prominent: false });
    // Live 8,605,000: 2% is 172,100 cents; typed 8,420,000 differs by 185,000 → prominent.
    expect(seedHint({ provenance: "profile", valueCents: "8420000", liveCents: "8605000" })).toEqual({ label: "typed", liveText: "Live value $86,050.00", useLive: true, prominent: true });
    // 2% of 8,605,000 = 172,100 > 50,000: a gap of 150,000 is not prominent.
    expect(seedHint({ provenance: "scenario", valueCents: "8455000", liveCents: "8605000" }).prominent).toBe(false);
    // A small amount: $500 (50,000 cents) is the larger threshold; a gap of 60,000 is prominent.
    expect(seedHint({ provenance: "profile", valueCents: "1000000", liveCents: "940000" }).prominent).toBe(true);
    expect(seedHint({ provenance: "profile", valueCents: "1000000", liveCents: "960000" }).prominent).toBe(false);
    expect(seedHint({ provenance: "default", valueCents: "0" }).label).toBe("default");
  });

  it("the spending evidence and the essentials share", () => {
    expect(spendingEvidence({ from: "2025-11", to: "2026-10", monthsWithData: 12 })).toBe("last 12 months of the plan, Nov 2025 to Oct 2026");
    expect(essentialsShareText("2400000", "4000000")).toBe("Essentials are 60% of your spending");
    expect(essentialsShareText("1", "0")).toBeNull();
  });
});

describe("inline issues: the shared resolver in the browser (§5.2, seams C47)", () => {
  const meta = { dataVersion: "2026.11.1", minStartYear: 2026, ruleSets: [{ id: "current_law", label: "Current law" }] };

  it("the fixture: the same issues and effective values as the server's resolution with the same context", () => {
    const server = resolvePlan(fixtureResolveArgs(), fixtureResolveContext());
    const browser = inlineIssues({ doc: PROFILE, baseline: fixtureBaseline(), settings: defaultRunSettings() }, meta, "2026-10-14");
    expect(browser.issues).toEqual(server.issues);
    expect(browser.issues.some((i) => i.severity === "error")).toBe(false);
    expect(browser.effective?.includedTotalCents).toBe("22582700");
  });

  it("an error at a path: the glide path's ages out of order (glide_order), listed under its field", () => {
    const weights = { us_stock: 6000, intl_stock: 0, bonds: 4000, cash: 0, real_estate: 0, other: 0 };
    const doc = RetirementProfileDoc.parse({ ...fixtureProfileDoc(), allocation: { glidePath: { reference: "p1", points: [{ age: 65, weights }, { age: 60, weights }] } } });
    const browser = inlineIssues({ doc, baseline: fixtureBaseline(), settings: defaultRunSettings() }, meta, "2026-10-14");
    const glide = browser.issues.find((i) => i.code === "glide_order");
    expect(glide).toMatchObject({ severity: "error", path: "allocation.glidePath.points" });
    expect(browser.byPath.get("allocation.glidePath.points")).toContainEqual(glide);
  });
});
