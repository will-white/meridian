import { describe, expect, it, vi } from "vitest";
import { EffectiveInputsView } from "./api.js";
import type { RetirementBaseline } from "./baseline.js";
import { inputHash } from "./freeze.js";
import { SimInput } from "./input.js";
import { PLAN_LIMITS, type PlanIssue } from "./primitives.js";
import { RetirementProfileDoc, type RetirementProfileDocInput } from "./profile.js";
import { effectiveInputsView, freezeInput, resolvePlan, type PlanLimits, type ResolveContext, type ResolveResult } from "./resolve.js";
import type { RunSettings } from "./settings.js";
import { fixtureProfileDoc, fixtureResolveArgs, fixtureResolveContext, fixtureSimInput, forbiddenValuePaths, IDS } from "./testFixtures.js";

// The resolver's cases of inputs-and-data §7 (tests 7 to 13 and 18; 6 is in contributions.test.ts,
// 15 in baselineDiff.test.ts) and the cases seams §10 adds (C13, C24, C25, C35). Expected values are
// the design's, re-derived where a seam changes them. HC-D1 (strategies-outputs-web §7.5) is cases 7
// and 11; packages/retirement/src/gate.test.ts runs this file.

interface Variant {
  doc?: (d: RetirementProfileDocInput) => void;
  baseline?: (b: RetirementBaseline) => void;
  overrides?: Record<string, unknown>;
  settings?: (s: RunSettings) => void;
  ctx?: Partial<ResolveContext>;
}

function resolve(v: Variant = {}): ResolveResult {
  const docInput = structuredClone(fixtureProfileDoc());
  v.doc?.(docInput);
  const args = fixtureResolveArgs({ doc: RetirementProfileDoc.parse(docInput), overrides: v.overrides ?? {} });
  v.baseline?.(args.baseline);
  v.settings?.(args.settings);
  return resolvePlan(args, fixtureResolveContext(v.ctx));
}

const errors = (r: ResolveResult) => r.issues.filter((i) => i.severity === "error");
const warnings = (r: ResolveResult) => r.issues.filter((i) => i.severity === "warning");
const codes = (list: PlanIssue[]) => list.map((i) => i.code);
const issue = (r: ResolveResult, code: string, accountId?: string) => r.issues.find((i) => i.code === code && (accountId === undefined || i.accountId === accountId));
const account = (r: ResolveResult, id: string) => r.input!.accounts.find((a) => a.id === id)!;
const contribution = (r: ResolveResult, id: string) => r.input!.contributions.find((c) => c.accountId === id);
const withoutMeta = (input: SimInput) => ({ ...input, meta: undefined });
const bucketOf = (b: RetirementBaseline, id: string) => b.accounts.find((a) => a.accountId === id)!;
const measured = (b: RetirementBaseline, id: string) => b.contributions.find((c) => c.accountId === id)!;

/** K's record when its deposits carry no employer description (§3.4 R9's second and fourth examples). */
function kUndetected(b: RetirementBaseline): void {
  Object.assign(measured(b, IDS.K), { employerCents: "0", employeeCents: "1800000", employerDetected: false, annualEmployeeCents: "1800000", annualEmployerCents: "0" });
}

describe("HC-D1 7. spending resolution on the fixture baseline (inputs-and-data §3.4 R8)", () => {
  const spending = (v: Variant) => {
    const r = resolve(v);
    return { base: r.effective!.baseSpendingCents, essential: r.effective!.essentialSpendingCents, r };
  };

  it("7 HC-D1 default → base 3,955,000 + 45,000 = 4,000,000, essential 2,400,000 (the bills bucket)", () => {
    const { base, essential, r } = spending({});
    expect([base, essential]).toEqual([4_000_000n, 2_400_000n]);
    expect(r.input!.spending).toMatchObject({ baseAnnualCents: "4000000", essentialAnnualCents: "2400000" });
    expect(issue(r, "uncategorized_in_spending")).toMatchObject({ severity: "warning", path: "spending.includeUncategorized" });
    expect(issue(r, "uncategorized_in_spending")!.message).toContain("450.00");
    expect(issue(r, "uncategorized_in_spending")!.message).toContain("2 transactions");
  });

  it("7 HC-D1 Childcare excluded → 3,355,000 + 45,000 = 3,400,000; uncategorized off → 3,955,000; manual 4,400,000 → 4,400,000", () => {
    const excluded = spending({ doc: (d) => void (d.spending.excludedCategoryIds = { [IDS.childcare]: true }) });
    expect(excluded.base).toBe(3_400_000n); // 3,955,000 − 600,000 + 45,000
    expect(excluded.essential).toBe(2_400_000n);
    const noUncategorized = spending({ doc: (d) => void (d.spending.includeUncategorized = false) });
    expect(noUncategorized.base).toBe(3_955_000n);
    expect(issue(noUncategorized.r, "uncategorized_in_spending")).toBeUndefined();
    expect(spending({ doc: (d) => void (d.spending.base = { mode: "manual", annualCents: "4400000" }) }).base).toBe(4_400_000n);
  });

  it("7 HC-D1 manual base 2,000,000 with live essential → essential 2,000,000 (capped at the base); Rent excluded → essential 0", () => {
    expect(spending({ doc: (d) => void (d.spending.base = { mode: "manual", annualCents: "2000000" }) })).toMatchObject({ base: 2_000_000n, essential: 2_000_000n });
    expect(spending({ doc: (d) => void (d.spending.excludedCategoryIds = { [IDS.rent]: true }) })).toMatchObject({ base: 1_600_000n, essential: 0n });
  });

  it("7 HC-D1 six months with the same sums → truncDiv(3,955,000 × 12, 6) + truncDiv(45,000 × 12, 6) = 7,910,000 + 90,000 = 8,000,000; essential 4,800,000; spending_short_history", () => {
    const { base, essential, r } = spending({ baseline: (b) => void (b.window.monthsWithData = 6) });
    expect([base, essential]).toEqual([8_000_000n, 4_800_000n]);
    expect(issue(r, "spending_short_history")).toMatchObject({ severity: "warning", path: "spending.base" });
    // Seven months: truncDiv(47,460,000, 7) = 6,780,000 and truncDiv(540,000, 7) = 77,142 (truncated from 77,142.86).
    expect(spending({ baseline: (b) => void (b.window.monthsWithData = 7) }).base).toBe(6_857_142n);
  });

  it("7 HC-D1 two months in live mode → error spending_missing and no input; a manual base still resolves (essential = base)", () => {
    const short = resolve({ baseline: (b) => void (b.window.monthsWithData = 2) });
    expect(codes(errors(short))).toEqual(["spending_missing"]);
    expect(short.input).toBeUndefined();
    const manual = spending({ baseline: (b) => void (b.window.monthsWithData = 2), doc: (d) => void (d.spending.base = { mode: "manual", annualCents: "4400000" }) });
    expect(manual).toMatchObject({ base: 4_400_000n, essential: 4_400_000n });
    expect(manual.r.input).toBeDefined();
  });
});

describe("8. contribution resolution (inputs-and-data §3.4 R9)", () => {
  it("8 the fixture: K 1,200,000 / 600,000 scaled with p1 to 2035-06; H 360,000 / 0; B 500,000 / 0 with the household; R 300,000 / 0 from the recurring transfer", () => {
    const r = resolve();
    expect(r.input!.contributions).toEqual([
      { accountId: IDS.K, employeeAnnualCents: "1200000", employerAnnualCents: "600000", scaleWith: "p1", salaryBasisCents: "12000000", endMonth: "2035-06" },
      { accountId: IDS.H, employeeAnnualCents: "360000", employerAnnualCents: "0", scaleWith: "p1", salaryBasisCents: "12000000", endMonth: "2035-06" },
      { accountId: IDS.B, employeeAnnualCents: "500000", employerAnnualCents: "0", scaleWith: "household", salaryBasisCents: "18000000", endMonth: "2039-09" },
      { accountId: IDS.R, employeeAnnualCents: "300000", employerAnnualCents: "0", scaleWith: "p2", salaryBasisCents: "6000000", endMonth: "2039-09" },
    ]);
    expect(issue(r, "contribution_from_recurring", IDS.R)).toMatchObject({ path: `contributions.${IDS.R}.employee` });
    // T (no history) and the bank accounts (never seeded) are left out.
    expect(contribution(r, IDS.T)).toBeUndefined();
  });

  it("8 K with employee pct_salary 1000 bp and no description match → truncDiv(12,000,000 × 1000, 10000) = 1,200,000; employer max(0, 1,800,000 − 1,200,000) = 600,000", () => {
    const r = resolve({ baseline: kUndetected, doc: (d) => void (d.contributions = { [IDS.K]: { employee: { mode: "pct_salary", bp: 1000 }, employer: { mode: "live" } } }) });
    expect(contribution(r, IDS.K)).toMatchObject({ employeeAnnualCents: "1200000", employerAnnualCents: "600000" });
    expect(issue(r, "match_unknown")).toBeUndefined();
  });

  it("8 K with employer formula 5000 bp up to 600 bp of pay → cap 720,000; min(1,200,000, 720,000) × 5000 ÷ 10000 = 360,000", () => {
    const r = resolve({ doc: (d) => void (d.contributions = { [IDS.K]: { employee: { mode: "live" }, employer: { mode: "formula", matchBp: 5000, capBpOfSalary: 600 } } }) });
    expect(contribution(r, IDS.K)).toMatchObject({ employeeAnnualCents: "1200000", employerAnnualCents: "360000" });
  });

  it("8 K live and live with no description match → employee 1,800,000, employer 0, warning match_unknown", () => {
    const r = resolve({ baseline: kUndetected });
    expect(contribution(r, IDS.K)).toMatchObject({ employeeAnnualCents: "1800000", employerAnnualCents: "0" });
    expect(issue(r, "match_unknown")).toMatchObject({ severity: "warning", path: `contributions.${IDS.K}.employer`, accountId: IDS.K });
  });

  it("8 the plan savings rate: truncDiv(2,960,000 × 10000, 18,000,000) = 1644 bp of gross salary", () => {
    const e = resolve().effective!;
    expect(e.contributionsCents).toBe(2_960_000n); // 1,200,000 + 600,000 + 360,000 + 500,000 + 300,000
    expect(e.employerCents).toBe(600_000n);
    expect(e.planSavingsRateBp).toBe(1644);
  });

  it("8 a contributionLimit of 3,250,000 for employer_plan at age 51: 3,300,000 on K raises contribution_over_limit, 3,250,000 does not", () => {
    const limit = vi.fn((_year: number, age: number, kind: string) => (kind === "employer_plan" && age === 51 ? 3_250_000n : null));
    const at = (cents: string) =>
      resolve({ ctx: { contributionLimit: limit }, doc: (d) => void (d.contributions = { [IDS.K]: { employee: { mode: "annual", annualCents: cents }, employer: { mode: "live" } } }) });
    const over = at("3300000");
    expect(issue(over, "contribution_over_limit")).toMatchObject({ severity: "warning", path: `contributions.${IDS.K}.employee`, accountId: IDS.K });
    expect(over.input).toBeDefined(); // a warning: the engine caps (C26), the resolver does not
    expect(contribution(over, IDS.K)!.employeeAnnualCents).toBe("3300000");
    expect(limit).toHaveBeenCalledWith(2026, 51, "employer_plan"); // 2026 − 1975
    expect(issue(at("3250000"), "contribution_over_limit")).toBeUndefined();
  });

  it("salary_missing → scaleWith inflation; already_retired drops a retired person's salary and contributions; a typed amount wins", () => {
    // No salary for p2: R's contribution follows inflation until Sam retires.
    const noSalary = resolve({ doc: (d) => void delete d.incomes!.salary_p2 });
    expect(contribution(noSalary, IDS.R)).toEqual({ accountId: IDS.R, employeeAnnualCents: "300000", employerAnnualCents: "0", scaleWith: "inflation", endMonth: "2039-09" });
    expect(issue(noSalary, "salary_missing", IDS.R)).toMatchObject({ severity: "warning", path: `contributions.${IDS.R}` });
    // The household's basis is then p1's salary only.
    expect(contribution(noSalary, IDS.B)).toMatchObject({ scaleWith: "household", salaryBasisCents: "12000000" });
    // Sam retired in 2026-09, before the plan's 2026-10 start: her salary and R's contribution are dropped.
    const retired = resolve({ doc: (d) => void (d.people!.p2!.retirementMonth = "2026-09") });
    expect(retired.input!.incomes.map((s) => s.id)).toEqual(["pen1", "salary_p1"]);
    expect(contribution(retired, IDS.R)).toBeUndefined();
    expect(issue(retired, "already_retired")).toMatchObject({ severity: "warning", path: "people.p2.retirementAge" });
    // B (joint) keeps going with Alex's salary, to the later retirement month (Alex's 2035-06).
    expect(contribution(retired, IDS.B)).toMatchObject({ scaleWith: "household", salaryBasisCents: "12000000", endMonth: "2035-06" });
    const typed = resolve({ doc: (d) => void (d.contributions = { [IDS.C]: { employee: { mode: "annual", annualCents: "120000" }, employer: { mode: "none" } } }) });
    expect(contribution(typed, IDS.C)).toMatchObject({ employeeAnnualCents: "120000", scaleWith: "household" });
  });
});

describe("9. basis (inputs-and-data §3.4 R4)", () => {
  it("9 T → 200,000 known, coverage partial, basis_unknown naming 120,000; B → 2,378,200, full", () => {
    const r = resolve();
    expect(account(r, IDS.T)).toMatchObject({ basisCents: "200000", basisCoverage: "partial" });
    expect(issue(r, "basis_unknown", IDS.T)).toMatchObject({ severity: "warning", path: `accounts.${IDS.T}.basisCents` });
    expect(issue(r, "basis_unknown", IDS.T)!.message).toContain("1,200.00");
    expect(account(r, IDS.B)).toMatchObject({ basisCents: "2378200", basisCoverage: "full" });
    expect(issue(r, "basis_unknown", IDS.B)).toBeUndefined();
  });

  it("9 a typed basis of 300,000 → manual, no warning; 9,999,999 is kept as entered with basis_above_value", () => {
    const typed = (cents: string) => resolve({ doc: (d) => void (d.accounts![IDS.T] = { basisCents: cents }) });
    const ok = typed("300000");
    expect(account(ok, IDS.T)).toMatchObject({ basisCents: "300000", basisCoverage: "manual" });
    expect(issue(ok, "basis_unknown", IDS.T)).toBeUndefined();
    const above = typed("9999999");
    expect(account(above, IDS.T)).toMatchObject({ basisCents: "9999999", basisCoverage: "manual" });
    expect(issue(above, "basis_above_value", IDS.T)).toMatchObject({ severity: "warning", path: `accounts.${IDS.T}.basisCents` });
  });
});

describe("10. allocation fallbacks for K (inputs-and-data §3.4 R4)", () => {
  const target = { us_stock: 5000, intl_stock: 2500, bonds: 2000, cash: 500, real_estate: 0, other: 0 };
  it("10 the fixture → the household targets 5000 / 2500 / 2000 / 500, household_target, allocation_assumed", () => {
    const r = resolve();
    expect(account(r, IDS.K)).toMatchObject({ allocation: target, allocationSource: "household_target" });
    expect(issue(r, "allocation_assumed", IDS.K)).toMatchObject({ severity: "warning", path: `accounts.${IDS.K}.allocation` });
    expect(issue(r, "allocation_assumed", IDS.K)!.message).toContain("150,000.00");
  });

  it("10 without targets → the actual mix of B, R, T 6322 / 1741 / 1594 / 343, household_actual, with the warning", () => {
    // 3,134,300 / 863,200 / 790,000 / 170,200 of 4,957,700 (inputs §3.2's worked example).
    const r = resolve({ baseline: (b) => void delete b.allocationTargets });
    expect(account(r, IDS.K)).toMatchObject({ allocation: { us_stock: 6322, intl_stock: 1741, bonds: 1594, cash: 343, real_estate: 0, other: 0 }, allocationSource: "household_actual" });
    expect(issue(r, "allocation_assumed", IDS.K)).toBeDefined();
  });

  it("10 without targets and with B, R, T excluded → 6000 / 0 / 4000 / 0, assumed, with the warning", () => {
    const r = resolve({
      baseline: (b) => void delete b.allocationTargets,
      doc: (d) => {
        for (const id of [IDS.B, IDS.R, IDS.T]) d.accounts![id] = { ...d.accounts![id], include: false };
      },
    });
    expect(account(r, IDS.K)).toMatchObject({ allocation: { us_stock: 6000, intl_stock: 0, bonds: 4000, cash: 0, real_estate: 0, other: 0 }, allocationSource: "assumed" });
    expect(issue(r, "allocation_assumed", IDS.K)).toBeDefined();
  });

  it("10 allocation.unclassified 7000 / 0 / 3000 / 0 → that, profile_default, no warning; a per-account override wins over all", () => {
    const unclassified = { us_stock: 7000, intl_stock: 0, bonds: 3000, cash: 0, real_estate: 0, other: 0 };
    const p = resolve({ doc: (d) => void (d.allocation = { unclassified }) });
    expect(account(p, IDS.K)).toMatchObject({ allocation: unclassified, allocationSource: "profile_default" });
    expect(issue(p, "allocation_assumed", IDS.K)).toBeUndefined();
    const own = { us_stock: 2000, intl_stock: 2000, bonds: 2000, cash: 2000, real_estate: 1000, other: 1000 };
    const o = resolve({ doc: (d) => void ((d.allocation = { unclassified }), (d.accounts![IDS.K] = { owner: "p1", allocation: own })) });
    expect(account(o, IDS.K)).toMatchObject({ allocation: own, allocationSource: "override" });
    // B's own measured mix (holdings) also loses to an override.
    const b = resolve({ doc: (d) => void (d.accounts![IDS.B] = { allocation: own }) });
    expect(account(b, IDS.B)).toMatchObject({ allocation: own, allocationSource: "override" });
  });
});

describe("HC-D1 11. full resolution of the fixture (inputs-and-data §7 test 11, with seams §2.1 and §10)", () => {
  const r = resolve();

  it("11 HC-D1 equals the fixture's frozen input apart from meta (the shape the engine's tests prepare)", () => {
    expect(withoutMeta(r.input!)).toEqual(withoutMeta(fixtureSimInput()));
  });

  it("11 HC-D1 the plan, people, Social Security and the pension", () => {
    const input = r.input!;
    expect(input.plan).toEqual({ startYear: 2026, startMonth: "2026-10", firstYearMonths: 3, endYear: 2072, stepsPerYear: 1, currency: "USD" });
    expect(input.household.filingStatus).toBe("married_joint");
    expect(input.household.people.map((p) => p.retirementMonth)).toEqual(["2035-06", "2039-09"]);
    expect(input.socialSecurity.people.map((p) => (p.mode === "estimate" ? [p.claimMonth, p.claimAgeMonths] : p.mode))).toEqual([
      ["2042-06", 804],
      ["2044-09", 804],
    ]);
    expect(input.incomes.find((s) => s.id === "pen1")).toMatchObject({ annualCents: "1200000", dollars: "nominal", startMonth: "2039-09", survivorBp: 5000, cola: { mode: "none" } });
    expect(input.incomes.filter((s) => s.kind === "salary").map((s) => [s.startMonth, s.endMonth])).toEqual([
      ["2026-10", "2035-06"],
      ["2026-10", "2039-09"],
    ]);
    // 1975 + 95 = 2070 and 1977 + 95 = 2072: the horizon is the later.
    expect(input.plan.endYear).toBe(2072);
  });

  it("11 HC-D1 spending: base 4,000,000, essential 2,400,000 from 2035-06, phases 2035 / 2050 / 2060, the roof, healthcare kept with inBase (C35)", () => {
    expect(r.input!.spending).toEqual({
      baseAnnualCents: "4000000",
      essentialAnnualCents: "2400000",
      startMonth: "2035-06",
      survivorBp: 10000,
      phases: [
        { fromYear: 2035, multiplierBp: 10000 },
        { fromYear: 2050, multiplierBp: 10000 },
        { fromYear: 2060, multiplierBp: 10000 },
      ],
      goals: [{ id: "roof", name: "Roof", year: 2031, amountCents: "1800000", dollars: "today" }],
      healthcare: [
        { personId: "p1", preMedicareAnnualCents: "0", preMedicareFrom: "2035-06", medicareFrom: "2040-06", medicareAnnualCents: "0", realGrowthBp: 0, inBase: true },
        { personId: "p2", preMedicareAnnualCents: "0", preMedicareFrom: "2039-09", medicareFrom: "2042-09", medicareAnnualCents: "0", realGrowthBp: 0, inBase: true },
      ],
      longTermCare: [],
    });
    expect(r.input!.rothConversions).toEqual([{ year: 2036, personId: "p1", amountCents: "3000000", dollars: "today" }]);
  });

  it("11 HC-D1 eight accounts summing to 22,582,700, the synthetic Roth at the pre-tax mix, the fund costs (C25)", () => {
    const input = r.input!;
    expect(input.accounts.map((a) => a.id)).toEqual([IDS.K, IDS.H, IDS.T, IDS.S, IDS.B, IDS.R, IDS.C, "synthetic:roth:p1"]);
    expect(input.accounts.reduce((s, a) => s + BigInt(a.balanceCents), 0n)).toBe(22_582_700n);
    expect(account(r, "synthetic:roth:p1")).toEqual({
      id: "synthetic:roth:p1",
      name: "Roth (for conversions)",
      bucket: "roth",
      owner: "p1",
      balanceCents: "0",
      allocation: { us_stock: 5000, intl_stock: 2500, bonds: 2000, cash: 500, real_estate: 0, other: 0 },
      allocationSource: "pretax_mix",
      expenseRatioPpm: 0,
      synthetic: true,
    });
    expect([account(r, IDS.K).allocationSource, account(r, IDS.H).allocationSource]).toEqual(["household_target", "household_target"]);
    for (const id of [IDS.C, IDS.S]) expect(account(r, id)).toMatchObject({ allocation: { cash: 10000 }, allocationSource: "cash" });
    // B's measured 270 ppm; nothing measured elsewhere.
    expect(input.accounts.map((a) => a.expenseRatioPpm)).toEqual([0, 0, 0, 0, 270, 0, 0, 0]);
    expect(input.contributions.map((c) => c.accountId)).toEqual([IDS.K, IDS.H, IDS.B, IDS.R]);
  });

  it("11 HC-D1 no errors and exactly thirteen warnings: the design's eight, four expense_ratio_unknown (C25) and hsa_no_medical (C35)", () => {
    expect(errors(r)).toEqual([]);
    const got = warnings(r).map((i) => [i.code, i.accountId ?? ""]);
    expect(got).toHaveLength(13);
    expect([...got].sort()).toEqual(
      [
        // The design's eight (test 11).
        ["basis_unknown", IDS.T],
        ["allocation_assumed", IDS.K],
        ["allocation_assumed", IDS.H],
        ["uncategorized_in_spending", ""],
        ["contribution_partial_window", IDS.H],
        ["irregular_contributions", IDS.B],
        ["contribution_from_recurring", IDS.R],
        ["goal_before_retirement", ""],
        // C25: K and H are unclassified (no positions), T and R have positions without an expense ratio; B is
        // measured and the bank accounts hold no fund.
        ["expense_ratio_unknown", IDS.K],
        ["expense_ratio_unknown", IDS.H],
        ["expense_ratio_unknown", IDS.T],
        ["expense_ratio_unknown", IDS.R],
        // C35: H is included and both healthcare amounts are 0 (healthcare is in base).
        ["hsa_no_medical", IDS.H],
      ].sort(),
    );
    expect(r.input!.meta.warnings).toEqual(warnings(r));
  });

  it("11 HC-D1 meta, no float and no null, the effective inputs and the hash", async () => {
    const input = r.input!;
    expect(forbiddenValuePaths(input)).toEqual([]);
    expect(SimInput.parse(input)).toEqual(input);
    expect(input.meta).toMatchObject({ today: "2026-10-14", asOf: "2026-10-13", profileRevision: 1, scenarioId: IDS.scenario, scenarioName: "Base plan" });
    expect(input.data.version).toBe("2026.11.1");
    expect(r.effective).toMatchObject({ includedTotalCents: 22_582_700n, baseSpendingCents: 4_000_000n, essentialSpendingCents: 2_400_000n, planSavingsRateBp: 1644 });
    expect(r.effective!.byBucketCents).toEqual({ taxable: 3_137_700n, pre_tax: 15_000_000n, roth: 1_820_000n, hsa: 125_000n, cash: 2_500_000n });
    // The 529 has no bucket and is not listed; the synthetic Roth is.
    expect(r.effective!.accounts).toHaveLength(8);
    const view = effectiveInputsView(r.effective!);
    expect(EffectiveInputsView.parse(view)).toEqual(view);
    expect(view).toMatchObject({ includedTotalCents: "22582700", baseSpendingCents: "4000000", essentialSpendingCents: "2400000", planSavingsRateBp: 1644 });
    const frozen = await freezeInput(fixtureResolveArgs(), fixtureResolveContext());
    expect(frozen.inputHash).toBe(await inputHash(fixtureSimInput()));
  });
});

describe("12. override scenario (inputs-and-data §7 test 12)", () => {
  it("12 { people: { p1: { retirementAge: 58 } } } moves Alex's retirement, spending, K and H to 2033-06; B and R stay at 2039-09; the hash changes", async () => {
    const overrides = { people: { p1: { retirementAge: 58 } } };
    const r = resolve({ overrides });
    expect(r.input!.household.people[0]!.retirementMonth).toBe("2033-06");
    expect(r.input!.spending.startMonth).toBe("2033-06");
    expect([contribution(r, IDS.K)!.endMonth, contribution(r, IDS.H)!.endMonth]).toEqual(["2033-06", "2033-06"]);
    expect([contribution(r, IDS.B)!.endMonth, contribution(r, IDS.R)!.endMonth]).toEqual(["2039-09", "2039-09"]);
    expect(r.input!.spending.healthcare[0]!.preMedicareFrom).toBe("2033-06");
    expect(r.input!.incomes.find((s) => s.id === "salary_p1")!.endMonth).toBe("2033-06");
    expect(r.doc!.people.p1.retirementAge).toBe(58);
    expect(await inputHash(r.input!)).not.toBe(await inputHash(resolve().input!));
  });
});

describe("13. errors, each giving no input (inputs-and-data §7 test 13)", () => {
  const blocked = (v: Variant, code: string, path?: string) => {
    const r = resolve(v);
    expect(r.input, code).toBeUndefined();
    const found = errors(r).find((i) => i.code === code);
    expect(found, `${code} in ${JSON.stringify(codes(errors(r)))}`).toBeDefined();
    if (path !== undefined) expect(found!.path).toBe(path);
    return r;
  };

  it("13 R's owner removed or joint → owner_required at accounts.<R>.owner", () => {
    blocked({ doc: (d) => void (d.accounts![IDS.R] = {}) }, "owner_required", `accounts.${IDS.R}.owner`);
    blocked({ doc: (d) => void (d.accounts![IDS.R] = { owner: "joint" }) }, "owner_required", `accounts.${IDS.R}.owner`);
  });

  it("13 a person born 1960-03 with a fixed age of 65 → planning_age_low (1960 + 65 = 2025 ≤ 2026)", () => {
    blocked({ doc: (d) => void Object.assign(d.people!.p1, { birthYear: 1960, birthMonth: 3, longevity: { mode: "fixed", age: 65 } }) }, "planning_age_low", "people.p1.longevity");
  });

  it("13 a person born after the plan's start year (2077 or 2027 for Sam) → born_after_start at people.p2.birthYear; the contribution limit is never asked for a negative age", () => {
    // The engine's contributionLimit refuses a negative age with a RangeError (src/tax/contributionLimits.ts); this stub does the same.
    const limit = vi.fn((_year: number, age: number, _kind: string): bigint | null => {
      if (age < 0) throw new RangeError(`age must be a whole number of years, got ${age}`);
      return null;
    });
    const born = (birthYear: number) => resolve({ ctx: { contributionLimit: limit }, doc: (d) => void (d.people!.p2!.birthYear = birthYear) });
    // 2027 + 95 = 2122: 97 years, inside the horizon, so the new error is the only one.
    const r2027 = blocked({ ctx: { contributionLimit: limit }, doc: (d) => void (d.people!.p2!.birthYear = 2027) }, "born_after_start", "people.p2.birthYear");
    expect(errors(r2027)).toEqual([{ code: "born_after_start", severity: "error", path: "people.p2.birthYear", message: "Sam's birth year, 2027, is after the plan starts in 2026." }]);
    // 2077 (a typo for 1977) + 95 = 2172: 147 years, so horizon_too_long as well, after the people's error.
    expect(codes(errors(born(2077)))).toEqual(["born_after_start", "horizon_too_long"]);
    // R is Sam's Roth (the ira group); only Alex's groups were asked, at 2026 − 1975 = 51.
    expect(limit.mock.calls.map(([, age]) => age)).not.toContain(-1);
    expect(limit.mock.calls.map(([, age]) => age)).not.toContain(-51);
    // Born in the start year is age 0 there (seams §2.2): no error from this rule, and the limit is asked at 0.
    limit.mockClear();
    expect(codes(errors(born(2026)))).not.toContain("born_after_start");
    expect(limit).toHaveBeenCalledWith(2026, 0, "ira");
  });

  it("13 conversions: for p2 (no pre-tax account) → conversion_no_pretax; from 2025 → conversion_in_past; two covering 2036 → conversion_overlap", () => {
    blocked({ doc: (d) => void (d.rothConversions = { c2: { personId: "p2", fromYear: 2030, toYear: 2030, annualCents: "100000" } }) }, "conversion_no_pretax", "rothConversions.c2.personId");
    blocked({ doc: (d) => void (d.rothConversions = { c0: { personId: "p1", fromYear: 2025, toYear: 2027, annualCents: "100000" } }) }, "conversion_in_past", "rothConversions.c0.fromYear");
    blocked(
      { doc: (d) => void (d.rothConversions!.conv2 = { personId: "p1", fromYear: 2035, toYear: 2037, annualCents: "100000" }) },
      "conversion_overlap",
      "rothConversions.conv2",
    );
  });

  it("13 an estimate for a person born 1958-03 claiming at 67 years 0 months (2025-03) → claim_in_past", () => {
    blocked({ doc: (d) => void Object.assign(d.people!.p1, { birthYear: 1958, birthMonth: 3 }) }, "claim_in_past", "socialSecurity.p1.claimAge");
  });

  it("13 phases at ages 75 then 70 → phase_order; a goal in 2025 with no repeat → goal_in_past", () => {
    blocked(
      {
        doc: (d) =>
          void (d.spending!.phases = [
            { label: "a", fromAge: 75, multiplierBp: 10000 },
            { label: "b", fromAge: 70, multiplierBp: 9000 },
          ]),
      },
      "phase_order",
      "spending.phases",
    );
    blocked({ doc: (d) => void (d.spending!.goals = { car: { name: "Car", year: 2025, amountCents: "3000000" } }) }, "goal_in_past", "spending.goals.car.year");
  });

  it("13 a one-person document with K's owner p2 → unknown_person", () => {
    blocked(
      {
        doc: (d) => {
          delete d.people!.p2;
          delete d.socialSecurity!.p2;
          delete d.incomes!.salary_p2;
          delete d.incomes!.pen1;
          d.accounts![IDS.R] = { owner: "p1" };
          d.accounts![IDS.K] = { owner: "p2" };
        },
      },
      "unknown_person",
      `accounts.${IDS.K}.owner`,
    );
  });

  it("13 today 2026-11-20 against the 2026-10-13 baseline (38 days) → baseline_too_old; minStartYear 2027 → start_year_unsupported", () => {
    blocked({ ctx: { today: "2026-11-20" } }, "baseline_too_old");
    blocked({ ctx: { minStartYear: 2027 } }, "start_year_unsupported");
    // 35 days is still allowed (a warning past 7).
    const r35 = resolve({ ctx: { today: "2026-11-17" } });
    expect(r35.input).toBeDefined();
    expect(issue(r35, "baseline_stale")).toMatchObject({ severity: "warning" });
  });

  it("13 a scenario patch editing incomes.pen1.monthlyCents after the profile deleted pen1 → override_invalid, and nothing else is resolved", () => {
    const r = blocked({ doc: (d) => void delete d.incomes!.pen1, overrides: { incomes: { pen1: { monthlyCents: "120000" } } } }, "override_invalid");
    expect(r.issues).toHaveLength(1);
    expect(r.doc).toBeUndefined();
    expect(r.effective).toBeUndefined();
  });

  it("the other errors of §3.5: no_accounts, stream_window, salary_duplicate, glide_order, unknown_rule_set", () => {
    blocked({ doc: (d) => void (d.accounts = Object.fromEntries(Object.keys(d.accounts!).map((id) => [id, { ...d.accounts![id], include: false }]))) }, "no_accounts", "accounts");
    blocked(
      { doc: (d) => void (d.incomes!.gig = { kind: "part_time", personId: "p1", annualCents: "100000", start: { at: "year", year: 2030 }, end: { at: "year", year: 2030 } }) },
      "stream_window",
      "incomes.gig.end",
    );
    blocked({ doc: (d) => void (d.incomes!.salary_x = { kind: "salary", personId: "p1", annualGrossCents: "100" }) }, "salary_duplicate");
    const points = [
      { age: 60, weights: { us_stock: 6000, intl_stock: 0, bonds: 4000, cash: 0, real_estate: 0, other: 0 } },
      { age: 60, weights: { us_stock: 4000, intl_stock: 0, bonds: 6000, cash: 0, real_estate: 0, other: 0 } },
    ];
    blocked({ doc: (d) => void (d.allocation = { glidePath: { reference: "p1", points } }) }, "glide_order", "allocation.glidePath.points");
    blocked({ settings: (s) => void (s.taxRuleSet = "tcja_sunset") }, "unknown_rule_set", "settings.taxRuleSet");
  });
});

describe("18. provenance (inputs-and-data §3.4 R13)", () => {
  const prov = (r: ResolveResult) => r.input!.meta.provenance;
  it("18 T's basis: baseline only → live; profile basisCents → profile; a scenario patch on accounts.<T>.basisCents → scenario", () => {
    expect(prov(resolve())[`accounts.${IDS.T}.basis`]).toBe("live");
    expect(prov(resolve({ doc: (d) => void (d.accounts![IDS.T] = { basisCents: "250000" }) }))[`accounts.${IDS.T}.basis`]).toBe("profile");
    expect(prov(resolve({ overrides: { accounts: { [IDS.T]: { basisCents: "250000" } } } }))[`accounts.${IDS.T}.basis`]).toBe("scenario");
  });

  it("18 K's allocation in the fixture → default; spending.base → live (manual → profile, or scenario when the patch sets it)", () => {
    const p = prov(resolve());
    expect(p[`accounts.${IDS.K}.allocation`]).toBe("default");
    expect(p["spending.base"]).toBe("live");
    expect(p[`accounts.${IDS.K}.balance`]).toBe("live");
    expect(p[`accounts.${IDS.K}.owner`]).toBe("profile");
    expect(p[`accounts.${IDS.T}.owner`]).toBe("default");
    expect(p[`accounts.${IDS.B}.allocation`]).toBe("live");
    expect(p[`contributions.${IDS.K}.employee`]).toBe("live");
    expect(prov(resolve({ doc: (d) => void (d.spending!.base = { mode: "manual", annualCents: "4400000" }) }))["spending.base"]).toBe("profile");
    expect(prov(resolve({ overrides: { spending: { base: { mode: "manual", annualCents: "4400000" } } } }))["spending.base"]).toBe("scenario");
  });
});

describe("seams §10: the resolver's new cases (C13, C24, C25, C35)", () => {
  it("C24 synthetic:cash: no taxable or cash account included → a cash account of 0 that receives surplus cash", () => {
    const r = resolve({ doc: (d) => void [IDS.B, IDS.T, IDS.C, IDS.S].forEach((id) => (d.accounts![id] = { include: false })) });
    expect(r.input!.accounts.map((a) => a.id)).toEqual([IDS.K, IDS.H, IDS.R, "synthetic:cash", "synthetic:roth:p1"]);
    expect(account(r, "synthetic:cash")).toEqual({
      id: "synthetic:cash",
      name: "Cash (surplus)",
      bucket: "cash",
      owner: "joint",
      balanceCents: "0",
      allocation: { us_stock: 0, intl_stock: 0, bonds: 0, cash: 10000, real_estate: 0, other: 0 },
      allocationSource: "cash",
      expenseRatioPpm: 0,
      synthetic: true,
    });
    expect(r.effective!.accounts.find((a) => a.accountId === "synthetic:cash")).toMatchObject({ included: true, bucket: "cash", balanceCents: 0n });
    // The fixture has taxable and cash accounts: no synthetic cash. One taxable account is enough.
    expect(resolve().input!.accounts.some((a) => a.id === "synthetic:cash")).toBe(false);
    const taxableOnly = resolve({ doc: (d) => void [IDS.T, IDS.C, IDS.S].forEach((id) => (d.accounts![id] = { include: false })) });
    expect(taxableOnly.input!.accounts.some((a) => a.id === "synthetic:cash")).toBe(false);
  });

  it("C24 a one-person household's synthetic cash belongs to p1", () => {
    const r = resolve({
      doc: (d) => {
        delete d.people!.p2;
        delete d.socialSecurity!.p2;
        delete d.incomes!.salary_p2;
        delete d.incomes!.pen1;
        d.accounts = { [IDS.K]: {}, [IDS.H]: {}, [IDS.R]: {}, [IDS.B]: { include: false }, [IDS.T]: { include: false }, [IDS.C]: { include: false }, [IDS.S]: { include: false } };
      },
    });
    expect(errors(r)).toEqual([]);
    expect(r.input!.household.filingStatus).toBe("single");
    expect(account(r, "synthetic:cash").owner).toBe("p1");
    // R is p1's own Roth now, so the conversion goes there and no synthetic Roth is added.
    expect(r.input!.accounts.map((a) => a.id)).toEqual([IDS.K, IDS.H, IDS.R, "synthetic:cash"]);
  });

  it("C35 hsa_no_medical: an included HSA and no healthcare amounts; the entered amounts are kept with inBase", () => {
    expect(issue(resolve(), "hsa_no_medical", IDS.H)).toMatchObject({ severity: "warning", path: "spending.healthcare" });
    const entered = resolve({ doc: (d) => void (d.spending!.healthcare = { includedInBase: true, preMedicareAnnualCents: "1200000", medicareAnnualCents: "700000" }) });
    expect(issue(entered, "hsa_no_medical")).toBeUndefined();
    expect(entered.input!.spending.healthcare[0]).toMatchObject({ preMedicareAnnualCents: "1200000", medicareAnnualCents: "700000", inBase: true });
    // H left out: nothing to warn about.
    expect(issue(resolve({ doc: (d) => void (d.accounts![IDS.H] = { owner: "p1", include: false }) }), "hsa_no_medical")).toBeUndefined();
    // Not in base and nothing entered: both warnings.
    const notInBase = resolve({ doc: (d) => void (d.spending!.healthcare = { includedInBase: false }) });
    expect(codes(warnings(notInBase)).filter((c) => c === "healthcare_zero" || c === "hsa_no_medical")).toEqual(["healthcare_zero", "hsa_no_medical"]);
    expect(notInBase.input!.spending.healthcare.every((h) => !h.inBase)).toBe(true);
  });

  it("C25 expense ratios: typed (profile or scenario), else measured (live, capped at 100,000 ppm), else 0 with expense_ratio_unknown", () => {
    const typed = resolve({ doc: (d) => void (d.accounts![IDS.K] = { owner: "p1", expenseRatioPpm: 300 }) });
    expect(account(typed, IDS.K).expenseRatioPpm).toBe(300);
    expect(issue(typed, "expense_ratio_unknown", IDS.K)).toBeUndefined();
    expect(typed.input!.meta.provenance[`accounts.${IDS.K}.expenseRatio`]).toBe("profile");
    const scenario = resolve({ overrides: { accounts: { [IDS.K]: { expenseRatioPpm: 450 } } } });
    expect(account(scenario, IDS.K).expenseRatioPpm).toBe(450);
    expect(scenario.input!.meta.provenance[`accounts.${IDS.K}.expenseRatio`]).toBe("scenario");
    const r = resolve();
    expect(r.input!.meta.provenance[`accounts.${IDS.B}.expenseRatio`]).toBe("live");
    expect(r.input!.meta.provenance[`accounts.${IDS.K}.expenseRatio`]).toBe("default");
    expect(issue(r, "expense_ratio_unknown", IDS.K)).toMatchObject({ severity: "warning", path: `accounts.${IDS.K}.expenseRatioPpm` });
    // Bank accounts hold no fund: 0 and no warning.
    expect(issue(r, "expense_ratio_unknown", IDS.C)).toBeUndefined();
    const high = resolve({ baseline: (b) => void (bucketOf(b, IDS.B).expenseRatio = { ppm: 250_000, coveredBp: 2000 }) });
    expect(account(high, IDS.B).expenseRatioPpm).toBe(100_000);
  });

  it("C13 too_many_accounts above 32, synthetic accounts included", () => {
    // The fixture includes seven baseline accounts and adds synthetic:roth:p1 (8); n more bank accounts make 8 + n.
    const withBanks = (n: number) =>
      resolve({
        baseline: (b) => {
          for (let i = 0; i < n; i++) {
            const id = `d0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
            b.accounts.push({ accountId: id, name: `Bank ${i}`, type: "savings", taxTreatment: "none", bucket: "cash", treatmentDefaulted: false, valueCents: "100", valuationBasis: "bank_balance", stale: false });
          }
        },
      });
    const at32 = withBanks(24);
    expect(at32.input!.accounts).toHaveLength(32);
    expect(codes(errors(at32))).toEqual([]);
    const at33 = withBanks(25);
    expect(at33.input).toBeUndefined();
    expect(errors(at33)).toEqual([{ code: "too_many_accounts", severity: "error", path: "accounts", message: "A plan can have at most 32 accounts, synthetic ones included; this one has 33." }]);
  });

  it("C13 the other limits: income streams, conversions, the horizon, the path-years of the models whose count is the request", () => {
    const limits = (o: Partial<PlanLimits>) => ({ ctx: { limits: { ...PLAN_LIMITS, ...o } } });
    // Three streams against a limit of 2; eleven conversion years (2036 to 2046) against 10; 47 years against 40.
    expect(codes(errors(resolve(limits({ maxIncomes: 2 }))))).toEqual(["too_many_incomes"]);
    const conversions = resolve({ ...limits({ maxConversions: 10 }), doc: (d) => void (d.rothConversions!.conv1!.toYear = 2046) });
    expect(codes(errors(conversions))).toEqual(["too_many_conversions"]);
    expect(codes(errors(resolve(limits({ maxYears: 40 }))))).toEqual(["horizon_too_long"]);
    // 100,000 paths: 47 years make 4,700,000 path-years (allowed); a fixed life to 119 for Alex runs to 2094,
    // 69 years, 6,900,000 path-years over the 6,000,000 cap.
    const paths = (s: RunSettings) => void (s.paths = 100_000);
    expect(codes(errors(resolve({ settings: paths })))).toEqual([]);
    const long = (d: RetirementProfileDocInput) => void (d.people!.p1!.longevity = { mode: "fixed", age: 119 });
    expect(errors(resolve({ settings: paths, doc: long }))).toEqual([
      { code: "path_years_too_many", severity: "error", path: "settings.paths", message: "100000 paths of 69 years exceed the engine's 6000000 path-years; lower the path count." },
    ]);
    // The historical model's count is the cohorts': the engine checks it (see the engine's resolver test).
    expect(codes(errors(resolve({ settings: (s) => void ((s.paths = 100_000), (s.returnModel = { kind: "historical", cohorts: "auto" })), doc: long })))).toEqual([]);
  });

  it("C13 the engine's validateInput issues become error issues and block the run; it is not called on a plan with errors", () => {
    const validateInput = vi.fn((_input: SimInput) => [{ code: "path_years_too_many", message: "100058 paths of 69 years exceed the engine's 6000000 path-years; lower the path count" }]);
    const r = resolve({ ctx: { validateInput } });
    expect(validateInput).toHaveBeenCalledTimes(1);
    expect(withoutMeta(validateInput.mock.calls[0]![0])).toEqual(withoutMeta(fixtureSimInput()));
    expect(r.input).toBeUndefined();
    expect(errors(r)).toEqual([{ code: "path_years_too_many", severity: "error", path: "settings.paths", message: validateInput.mock.results[0]!.value[0]!.message }]);
    // Warnings are kept beside them, and the effective inputs still show.
    expect(warnings(r)).toHaveLength(13);
    expect(r.effective!.includedTotalCents).toBe(22_582_700n);
    const unknown = resolve({ ctx: { validateInput: () => [{ code: "income_invalid", message: "x" }, { code: "brand_new", message: "y" }] } });
    expect(errors(unknown).map((i) => [i.code, i.path])).toEqual([
      ["income_invalid", "incomes"],
      ["brand_new", ""],
    ]);
    // The return model's and the seed's refusals belong next to the setting that fixes them (C13): the cohorts or
    // the custom figures, and the seed. Reachable through the schema: the first two (the engine's resolver test).
    const settingsCodes = ["historical_horizon_too_long", "correlation_not_positive_definite", "correlation_not_symmetric", "persistence_invalid", "initial_rate_invalid", "mean_block_invalid", "seed_invalid"];
    const model = resolve({ ctx: { validateInput: () => settingsCodes.map((code) => ({ code, message: code })) } });
    expect(errors(model).map((i) => [i.code, i.path])).toEqual([
      ["historical_horizon_too_long", "settings.returnModel"],
      ["correlation_not_positive_definite", "settings.returnModel"],
      ["correlation_not_symmetric", "settings.returnModel"],
      ["persistence_invalid", "settings.returnModel"],
      ["initial_rate_invalid", "settings.returnModel"],
      ["mean_block_invalid", "settings.returnModel"],
      ["seed_invalid", "settings.seed"],
    ]);
    const clean = vi.fn(() => []);
    expect(resolve({ ctx: { validateInput: clean } }).input).toBeDefined();
    const notCalled = vi.fn(() => []);
    expect(resolve({ ctx: { validateInput: notCalled, today: "2026-12-01" } }).input).toBeUndefined();
    expect(notCalled).not.toHaveBeenCalled();
  });

  it("freezeInput: the input hash with the input, none without", async () => {
    const ok = await freezeInput(fixtureResolveArgs(), fixtureResolveContext());
    expect(ok.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ok.inputHash).toBe(await inputHash(ok.input!));
    const blocked = await freezeInput(fixtureResolveArgs(), fixtureResolveContext({ today: "2026-12-01" }));
    expect(blocked.input).toBeUndefined();
    expect(blocked.inputHash).toBeUndefined();
  });
});

describe("the other steps of §3.4", () => {
  it("R4 inclusion and the baseline's flags: no value, excluded, unreviewed, dangling, defaulted treatment, bank treatment, negative, stale", () => {
    const r = resolve({
      baseline: (b) => {
        delete bucketOf(b, IDS.H).valueCents;
        Object.assign(bucketOf(b, IDS.T), { treatmentDefaulted: true, stale: true });
        Object.assign(bucketOf(b, IDS.C), { taxTreatment: "hsa", valueCents: "-5000" });
      },
      doc: (d) => {
        delete d.accounts![IDS.S];
        d.accounts!["e0000000-0000-4000-8000-000000000001"] = { include: false };
      },
    });
    expect(r.input!.accounts.some((a) => a.id === IDS.H)).toBe(false);
    expect(issue(r, "account_no_value", IDS.H)).toMatchObject({ severity: "warning", path: `accounts.${IDS.H}` });
    expect(issue(r, "account_unreviewed", IDS.S)).toBeDefined();
    expect(account(r, IDS.S).balanceCents).toBe("2000000");
    expect(issue(r, "dangling_account_setting")).toMatchObject({ path: "accounts.e0000000-0000-4000-8000-000000000001" });
    expect(issue(r, "tax_treatment_defaulted", IDS.T)).toBeDefined();
    expect(issue(r, "valuation_stale", IDS.T)).toBeDefined();
    expect(issue(r, "cash_account_treatment", IDS.C)).toBeDefined();
    expect(issue(r, "negative_balance", IDS.C)).toBeDefined();
    expect(account(r, IDS.C).balanceCents).toBe("0");
    // H excluded: no HSA left, so no hsa_no_medical; its contribution is gone.
    expect(issue(r, "hsa_no_medical")).toBeUndefined();
    expect(contribution(r, IDS.H)).toBeUndefined();
    expect(r.effective!.accounts.find((a) => a.accountId === IDS.H)).toMatchObject({ included: false, balanceCents: 0n });
  });

  it("R4 glide paths: the household's on every non-cash account, an account's own wins, ages to years by the reference person", () => {
    const a = { us_stock: 8000, intl_stock: 0, bonds: 2000, cash: 0, real_estate: 0, other: 0 };
    const b = { us_stock: 4000, intl_stock: 0, bonds: 6000, cash: 0, real_estate: 0, other: 0 };
    const r = resolve({
      doc: (d) => {
        d.allocation = { glidePath: { reference: "p2", points: [{ age: 50, weights: a }, { age: 70, weights: b }] } };
        d.accounts![IDS.R] = { owner: "p2", glidePath: { reference: "p1", points: [{ age: 65, weights: b }] } };
      },
    });
    // Sam is born 1977: 2027 and 2047.
    expect(account(r, IDS.K).glidePath).toEqual([
      { year: 2027, weights: a },
      { year: 2047, weights: b },
    ]);
    expect(account(r, IDS.R).glidePath).toEqual([{ year: 2040, weights: b }]); // 1975 + 65
    expect(account(r, IDS.C).glidePath).toBeUndefined();
  });

  it("R6 streams: when-months, a start before the plan raised to it, open ends, the frozen defaults of each kind", () => {
    const r = resolve({
      doc: (d) => {
        d.incomes!.gig = { kind: "part_time", personId: "p1", annualCents: "2400000", start: { at: "retirement", personId: "p1" }, end: { at: "age", personId: "p1", age: 65 } };
        d.incomes!.flat = { kind: "rental", name: "Flat", annualNetCents: "1200000", start: { at: "year", year: 2020 } };
        d.incomes!.ann = { kind: "annuity", personId: "p2", name: "Annuity", monthlyCents: "50000", start: { at: "age", personId: "p2", age: 70 }, cola: { mode: "fixed", bp: 200 }, taxableBp: 4000 };
        d.incomes!.misc = { kind: "other", name: "Royalties", annualCents: "300000", start: { at: "start" }, end: { at: "year", year: 2030 }, dollars: "nominal" };
      },
    });
    const s = (id: string) => r.input!.incomes.find((x) => x.id === id);
    expect(s("gig")).toEqual({ id: "gig", kind: "part_time", personId: "p1", name: "Part-time work", annualCents: "2400000", dollars: "today", startMonth: "2035-06", endMonth: "2040-06", realGrowthBp: 0, cola: { mode: "cpi" }, survivorBp: 0, taxableBp: 10000, earned: true });
    expect(s("flat")).toEqual({ id: "flat", kind: "rental", name: "Flat", annualCents: "1200000", dollars: "today", startMonth: "2026-10", realGrowthBp: 0, cola: { mode: "cpi" }, survivorBp: 0, taxableBp: 10000, earned: false });
    expect(s("ann")).toMatchObject({ annualCents: "600000", dollars: "nominal", startMonth: "2047-09", cola: { mode: "fixed", bp: 200 }, taxableBp: 4000, earned: false });
    expect(s("ann")!.endMonth).toBeUndefined();
    expect(s("misc")).toMatchObject({ dollars: "nominal", startMonth: "2026-10", endMonth: "2030-01", taxableBp: 10000 });
    expect(s("misc")!.personId).toBeUndefined();
    expect(r.input!.incomes.map((x) => x.id)).toEqual(["ann", "flat", "gig", "misc", "pen1", "salary_p1", "salary_p2"]);
  });

  it("R7 Social Security: receiving copied, none with ss_missing while a claim is still possible, the switches and adjustment copied", () => {
    const r = resolve({
      doc: (d) => {
        d.socialSecurity = {
          p1: { mode: "receiving", monthlyCents: "250000", asOfYear: 2026, startedMonth: "2026-01" },
          p2: { mode: "none" },
          spousal: false,
          survivor: true,
          adjustment: { fromYear: 2034, factorBp: 7700 },
        };
      },
    });
    expect(r.input!.socialSecurity).toEqual({
      people: [
        { personId: "p1", mode: "receiving", monthlyCents: "250000", asOfYear: 2026, startedMonth: "2026-01" },
        { personId: "p2", mode: "none" },
      ],
      spousal: false,
      survivor: true,
      adjustment: { fromYear: 2034, factorBp: 7700 },
    });
    expect(issue(r, "ss_missing")).toMatchObject({ severity: "warning", path: "socialSecurity.p2" });
  });

  it("R10 conversion years after the horizon are left out; a range wholly after it adds no synthetic Roth", () => {
    const tail = resolve({ doc: (d) => void (d.rothConversions!.conv1 = { personId: "p1", fromYear: 2070, toYear: 2199, annualCents: "100000" }) });
    // 2070 to 2072 (the horizon) are kept.
    expect(tail.input!.rothConversions.map((c) => c.year)).toEqual([2070, 2071, 2072]);
    const after = resolve({ doc: (d) => void (d.rothConversions!.conv1 = { personId: "p1", fromYear: 2080, toYear: 2085, annualCents: "100000" }) });
    expect(after.input!.rothConversions).toEqual([]);
    expect(after.input!.accounts.some((a) => a.synthetic)).toBe(false);
  });

  it("R8 goals repeat inside the plan's years; long-term care per named person; phases after the horizon are left out", () => {
    const r = resolve({
      doc: (d) => {
        d.spending!.goals = { car: { name: "Car", year: 2024, amountCents: "3000000", repeat: { everyYears: 10, times: 7 } } };
        d.spending!.longTermCare = { reserveCents: "10000000", lastYears: 3, people: "each" };
        d.spending!.phases = [...d.spending!.phases!, { label: "Very late", fromAge: 110, multiplierBp: 8000 }];
      },
    });
    // 2024 (before the plan), 2034, 2044, 2054, 2064, 2074 and 2084 (after 2072): four kept, and 2034 is before retirement (2035).
    expect(r.input!.spending.goals.map((g) => [g.id, g.year])).toEqual([
      ["car:2", 2034],
      ["car:3", 2044],
      ["car:4", 2054],
      ["car:5", 2064],
    ]);
    expect(issue(r, "goal_before_retirement")!.message).toContain("2034");
    expect(r.input!.spending.longTermCare).toEqual([
      { personId: "p1", reserveCents: "10000000", lastYears: 3 },
      { personId: "p2", reserveCents: "10000000", lastYears: 3 },
    ]);
    // 1975 + 110 = 2085 is after the 2072 horizon.
    expect(r.input!.spending.phases.map((p) => p.fromYear)).toEqual([2035, 2050, 2060]);
  });
});
