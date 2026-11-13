import { describe, expect, it } from "vitest";
import * as shared from "../index.js";
import { AllocationSource, BasisCoverage, DollarBasis, OwnerId, PersonId, PlanBucket, PlanIncomeKind, PlanIssueSeverity, SimRunStatus } from "../enums.js";
import {
  BASELINE_MAX_DAYS,
  BASELINE_STALE_DAYS,
  bp,
  ClassWeights,
  DEFAULT_PATHS,
  ExpenseRatioPpm,
  MAX_PATHS,
  MEDICARE_AGE,
  MIN_PATHS,
  PLAN_LIMITS,
  PlanCents,
  PlanIssue,
  PlanItemId,
  PlanMonth,
  PlanYear,
  schemaVersionOf,
  STORED_PERCENTILES,
  UnsupportedSchemaVersionError,
} from "./primitives.js";
import { forbiddenValuePaths } from "./testFixtures.js";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => schema.safeParse(value).success;

describe("planner enums (inputs-and-data §2.5)", () => {
  it("have the design's members, in its order", () => {
    expect(PlanBucket.options).toEqual(["taxable", "pre_tax", "roth", "hsa", "cash"]);
    expect(PersonId.options).toEqual(["p1", "p2"]);
    expect(OwnerId.options).toEqual(["p1", "p2", "joint"]);
    expect(SimRunStatus.options).toEqual(["queued", "running", "done", "failed", "cancelled"]);
    expect(PlanIncomeKind.options).toEqual(["salary", "part_time", "pension", "annuity", "rental", "other"]);
    expect(PlanIssueSeverity.options).toEqual(["error", "warning"]);
    expect(BasisCoverage.options).toEqual(["full", "partial", "none", "manual"]);
    expect(AllocationSource.options).toEqual(["holdings", "override", "profile_default", "household_target", "household_actual", "assumed", "cash", "pretax_mix"]);
    expect(DollarBasis.options).toEqual(["today", "nominal"]);
  });

  it("the Phase 3 IncomeKind keeps its meaning; the planner's is PlanIncomeKind", () => {
    expect(shared.IncomeKind.options).toEqual(["dividend", "interest"]);
    expect(shared.PlanIncomeKind).toBe(PlanIncomeKind);
  });

  it("the package index exports the retirement contracts", () => {
    for (const name of ["RetirementProfileDoc", "RetirementBaseline", "RunSettings", "SimInput", "ReturnModelConfig", "StrategyConfig", "SimSummary", "YearTable", "TaxSettings", "RetirementMeta", "RETIREMENT_ROUTES", "RetirementCard", "upgradeRunSettings", "defaultRunSettings"]) {
      expect(shared, name).toHaveProperty(name);
    }
  });
});

describe("primitives (inputs-and-data §4.1)", () => {
  it("cents, months and years are the bounded request shapes", () => {
    expect(ok(PlanCents, "0")).toBe(true);
    expect(ok(PlanCents, "999999999999999")).toBe(true);
    for (const bad of ["-1", "1.5", "1000000000000000", "", "1e3"]) expect(ok(PlanCents, bad), bad).toBe(false);
    expect(ok(PlanMonth, "2026-10")).toBe(true);
    for (const bad of ["2026-13", "1899-12", "2200-01", "2026-1"]) expect(ok(PlanMonth, bad), bad).toBe(false);
    expect(ok(PlanYear, 1900)).toBe(true);
    expect(ok(PlanYear, 2199)).toBe(true);
    for (const bad of [1899, 2200, 2026.5]) expect(ok(PlanYear, bad), String(bad)).toBe(false);
  });

  it("basis points are integers in range; ids are lower-case", () => {
    expect(ok(bp(), 0)).toBe(true);
    expect(ok(bp(), 10000)).toBe(true);
    for (const bad of [-1, 10001, 12.5]) expect(ok(bp(), bad), String(bad)).toBe(false);
    expect(ok(bp(-500, 1000), -500)).toBe(true);
    expect(ok(bp(-500, 1000), -501)).toBe(false);
    for (const id of ["roof", "salary_p1", "a", "a".repeat(32)]) expect(ok(PlanItemId, id), id).toBe(true);
    for (const id of ["Roof", "1roof", "_a", "a-b", "", "a".repeat(33)]) expect(ok(PlanItemId, id), id).toBe(false);
  });

  it("class weights: six integer classes summing to 10000, strict", () => {
    const w = { us_stock: 6839, intl_stock: 2632, bonds: 0, cash: 529, real_estate: 0, other: 0 };
    expect(ClassWeights.parse(w)).toEqual(w);
    expect(ok(ClassWeights, { ...w, cash: 528 })).toBe(false);
    expect(ok(ClassWeights, { ...w, extra: 0 })).toBe(false);
    const { other: _other, ...five } = w;
    expect(ok(ClassWeights, five)).toBe(false);
    expect(ok(ClassWeights, { ...w, us_stock: 6838.5, cash: 529.5 })).toBe(false);
  });

  it("expense ratio: integer ppm up to 10%", () => {
    expect(ok(ExpenseRatioPpm, 0)).toBe(true);
    expect(ok(ExpenseRatioPpm, 100_000)).toBe(true);
    for (const bad of [-1, 100_001, 2.5]) expect(ok(ExpenseRatioPpm, bad), String(bad)).toBe(false);
  });

  it("constants", () => {
    expect([MIN_PATHS, MAX_PATHS, DEFAULT_PATHS]).toEqual([100, 100_000, 10_000]);
    expect(STORED_PERCENTILES).toEqual([5, 10, 25, 50, 75, 90, 95]);
    expect([BASELINE_STALE_DAYS, BASELINE_MAX_DAYS, MEDICARE_AGE]).toEqual([7, 35, 65]);
    expect(PLAN_LIMITS).toEqual({ maxAccounts: 32, maxIncomes: 40, maxConversions: 120, maxYears: 120, maxPathYears: 6_000_000 });
  });

  it("an issue is strict and carries its severity", () => {
    const issue = { code: "owner_required", severity: "error", path: "accounts.x.owner", message: "Choose an owner" };
    expect(PlanIssue.parse(issue)).toEqual(issue);
    expect(ok(PlanIssue, { ...issue, severity: "info" })).toBe(false);
    expect(ok(PlanIssue, { ...issue, hint: "x" })).toBe(false);
  });

  it("schemaVersionOf and the unsupported-version error", () => {
    expect(schemaVersionOf({ schemaVersion: 2 })).toBe(2);
    for (const raw of [null, undefined, 1, "x", [], {}]) expect(schemaVersionOf(raw)).toBeUndefined();
    const error = new UnsupportedSchemaVersionError("RunSettings", 2);
    expect(error.code).toBe("unsupported_schema_version");
    expect(error.message).toBe("RunSettings: schemaVersion 2 is not supported");
    expect(new UnsupportedSchemaVersionError("X", undefined).message).toBe("X: schemaVersion undefined is not supported");
  });

  it("the stored-document check finds floats, nulls and non-plain values", () => {
    expect(forbiddenValuePaths({ a: [1, "x", true, { b: 2 }] })).toEqual([]);
    expect(forbiddenValuePaths({ a: 1.5, b: null, c: [Number.NaN, 2 ** 53], d: undefined, e: new Date(0) })).toEqual([
      "$.a (1.5)",
      "$.b (null)",
      "$.c[0] (NaN)",
      "$.c[1] (9007199254740992)",
      "$.d (undefined)",
      "$.e (object)",
    ]);
  });
});
