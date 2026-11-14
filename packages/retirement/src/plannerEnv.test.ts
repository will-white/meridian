import { RetirementProfileDoc, freezeInput, inputHash, resolvePlan, type PlannerEnv, type ResolveContext, type SimInput } from "@meridian/shared";
import { fixtureProfileDoc, fixtureResolveArgs, fixtureResolveContext, fixtureSimInput } from "@meridian/shared/src/retirement/testFixtures.js";
import { describe, expect, it } from "vitest";
import { DATA_VERSION, ENGINE_VERSION, TAX_DATA_FIRST_YEAR, contributionLimit, listTaxRuleSets, prepare, simulatePath, validateInput } from "./index.js";

// Seams §11 step 23 against the real engine: the planner environment the API and the worker build
// from this package (inputs-and-data §6.1, seams C13), the resolver's frozen input accepted by
// `prepare` and `validateInput`, and one path simulated on it. The shared resolver never imports the
// engine (C47); its facts and functions come in through `PlannerEnv`.

/** The real environment, as `app.planner` builds it. */
const ENV: PlannerEnv = {
  engineVersion: ENGINE_VERSION,
  dataVersion: DATA_VERSION,
  ruleSets: listTaxRuleSets().map((r) => r.id),
  minStartYear: TAX_DATA_FIRST_YEAR,
  contributionLimit: (year, age, kind) => contributionLimit(year, age, kind),
  validateInput,
};

function context(o: Partial<ResolveContext> = {}): ResolveContext {
  const { engineVersion: _engineVersion, ...env } = ENV;
  return fixtureResolveContext({ ...env, ...o });
}

const strip = (input: SimInput) => ({ ...input, meta: undefined });

describe("the resolver through the real planner environment (seams §11 step 23)", () => {
  it("the environment carries the engine's facts: data version 2026.11.1, current law first, tax data from 2026", () => {
    expect(ENV.dataVersion).toBe("2026.11.1");
    expect(ENV.ruleSets[0]).toBe("current_law");
    expect(ENV.minStartYear).toBe(2026);
  });

  it("the inputs fixture resolves with no error; prepare and validateInput accept it and one path simulates", () => {
    const r = resolvePlan(fixtureResolveArgs(), context());
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    const input = r.input!;
    expect(input.data.version).toBe(DATA_VERSION);
    expect(validateInput(input)).toEqual([]);
    const run = prepare(input);
    // 2026 to 2072 (C28: plan.endYear is the mortality horizon prepare requires); the bootstrap's 10,000 requested paths.
    expect(run.years).toBe(47);
    expect(run.paths).toBe(10_000);
    expect(run.firstYearFraction).toBe(3 / 12);
    expect(run.accountIds).toEqual(input.accounts.map((a) => a.id));
    const path = simulatePath(input, 0);
    expect(path.pathIndex).toBe(0);
    expect(path.table.rows).toHaveLength(47);
    expect(path.table.rows[0]!.year).toBe(2026);
    expect(path.table.rows[46]!.year).toBe(2072);
    // The resolved input is the frozen fixture the engine's own tests prepare (apart from meta), so its path is the same.
    expect(strip(input)).toEqual(strip(fixtureSimInput()));
    const reference = simulatePath(fixtureSimInput(), 0);
    expect(path.endingRealCents).toBe(reference.endingRealCents);
    expect(path.depletionYear).toBe(reference.depletionYear);
  });

  it("freezeInput hashes what prepare runs; the real contribution limit warns, the engine does the capping", async () => {
    const frozen = await freezeInput(fixtureResolveArgs(), context());
    expect(frozen.inputHash).toBe(await inputHash(frozen.input!));
    // 2026: deferral 24,500 plus the age-50 catch-up 8,000 (Notice 2025-67) = 3,250,000 cents for Alex at 51.
    expect(contributionLimit(2026, 51, "employer_plan")).toBe(3_250_000n);
    const doc = structuredClone(fixtureProfileDoc());
    doc.contributions = { "a0000000-0000-4000-8000-000000000001": { employee: { mode: "annual", annualCents: "3300000" }, employer: { mode: "live" } } };
    const over = resolvePlan(fixtureResolveArgs({ doc: RetirementProfileDoc.parse(doc) }), context());
    expect(over.issues.find((i) => i.code === "contribution_over_limit")).toMatchObject({ severity: "warning" });
    expect(validateInput(over.input!)).toEqual([]);
  });

  it("C24 a plan without taxable or cash accounts runs on the synthetic cash account (the engine's surplus account)", () => {
    const doc = structuredClone(fixtureProfileDoc());
    for (const id of ["a0000000-0000-4000-8000-000000000003", "a0000000-0000-4000-8000-000000000004", "a0000000-0000-4000-8000-000000000007", "a0000000-0000-4000-8000-000000000009"]) {
      doc.accounts![id] = { include: false };
    }
    const r = resolvePlan(fixtureResolveArgs({ doc: RetirementProfileDoc.parse(doc) }), context());
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    const run = prepare(r.input!);
    expect(run.accountIds[run.surplusAccount]).toBe("synthetic:cash");
    expect(simulatePath(r.input!, 3).table.rows).toHaveLength(47);
  });

  it("C13 an engine-only refusal (the historical model's own path count) comes back as an error issue and no input", () => {
    // Alex on the mortality table to 119 (horizon 2094, 69 years): the historical model wraps 98 start years and
    // draws ceil(100,000 ÷ 98) = 1,021 lives for each, 100,058 paths, 6,904,002 path-years over the 6,000,000 cap.
    // The resolver leaves that count to the engine; the engine's validateInput refuses it.
    const doc = structuredClone(fixtureProfileDoc());
    doc.people!.p1!.longevity = { mode: "mortality", sex: "female", maxAge: 119 };
    const args = fixtureResolveArgs({ doc: RetirementProfileDoc.parse(doc) });
    args.settings = { ...args.settings, paths: 100_000, returnModel: { kind: "historical", cohorts: "auto" } };
    const browser = resolvePlan(args, fixtureResolveContext());
    expect(browser.input).toBeDefined(); // without the engine's check the plan resolves
    const r = resolvePlan(args, context());
    expect(r.input).toBeUndefined();
    const engineIssue = validateInput(browser.input!);
    expect(engineIssue.map((i) => i.code)).toEqual(["path_years_too_many"]);
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([{ code: "path_years_too_many", severity: "error", path: "settings.paths", message: engineIssue[0]!.message }]);
    expect(engineIssue[0]!.message).toContain("100058 paths of 69 years");
  });

  it("13 a birth year after the plan's start (2077 for Sam's 1977, or 2027) is an error issue on the form, not a throw from the real contribution limit", () => {
    // The real contributionLimit refuses a negative age (RangeError); Sam owns R, whose contribution is counted.
    expect(() => contributionLimit(2026, -1, "ira")).toThrow(RangeError);
    for (const [birthYear, expected] of [
      [2077, ["born_after_start@people.p2.birthYear", "horizon_too_long@people"]], // 2077 + 95 = 2172: 147 years
      [2027, ["born_after_start@people.p2.birthYear"]], // 2027 + 95 = 2122: 97 years
    ] as const) {
      const doc = structuredClone(fixtureProfileDoc());
      doc.people!.p2!.birthYear = birthYear;
      const args = fixtureResolveArgs({ doc: RetirementProfileDoc.parse(doc) });
      const server = resolvePlan(args, context());
      const browser = resolvePlan(args, fixtureResolveContext());
      const errorsOf = (r: typeof server) => r.issues.filter((i) => i.severity === "error").map((i) => `${i.code}@${i.path}`);
      expect(server.input, String(birthYear)).toBeUndefined();
      expect(errorsOf(server), String(birthYear)).toEqual(expected);
      expect(errorsOf(browser), String(birthYear)).toEqual(expected);
    }
  });

  it("C13 the real engine's return-model refusals come back at settings.returnModel", () => {
    // Sam on a fixed life to 119: 2005 + 119 = 2124, 99 plan years against 98 years of data (1928 to 2025), so no
    // complete cohort exists (98 − 99 + 1 = 0).
    const doc = structuredClone(fixtureProfileDoc());
    doc.people!.p2! = { ...doc.people!.p2!, birthYear: 2005, longevity: { mode: "fixed", age: 119 } };
    const longArgs = fixtureResolveArgs({ doc: RetirementProfileDoc.parse(doc) });
    longArgs.settings = { ...longArgs.settings, returnModel: { kind: "historical", cohorts: "complete" } };
    const long = resolvePlan(longArgs, context());
    expect(long.input).toBeUndefined();
    expect(long.issues.filter((i) => i.severity === "error").map((i) => [i.code, i.path])).toEqual([["historical_horizon_too_long", "settings.returnModel"]]);
    expect(long.issues.find((i) => i.code === "historical_horizon_too_long")!.message).toContain("99 years against 98 years of data");
    // Stocks–bonds 0.9, bonds–bills 0.9 and stocks–bills −0.9 cannot hold together: the 3 × 3 block's determinant is
    // 1 × (1 − 0.81) − 0.9 × (0.9 + 0.81) − 0.9 × (0.81 + 0.9) = 0.19 − 3.078 < 0.
    const pdArgs = fixtureResolveArgs();
    pdArgs.settings = {
      ...pdArgs.settings,
      returnModel: {
        kind: "parametric",
        preset: "custom",
        params: {
          meanKind: "arithmetic",
          stocks: { meanBp: 1000, volBp: 2000 },
          bonds: { meanBp: 500, volBp: 800 },
          bills: { meanBp: 300, volBp: 300, persistenceBp: 0 },
          inflation: { meanBp: 300, volBp: 400, persistenceBp: 5000 },
          correlationBp: [
            [10000, 9000, -9000, 0],
            [9000, 10000, 9000, 0],
            [-9000, 9000, 10000, 0],
            [0, 0, 0, 10000],
          ],
        },
      },
    };
    const pd = resolvePlan(pdArgs, context());
    expect(pd.input).toBeUndefined();
    expect(pd.issues.filter((i) => i.severity === "error").map((i) => [i.code, i.path])).toEqual([["correlation_not_positive_definite", "settings.returnModel"]]);
  });

  it("every rule set the engine lists resolves and prepares", () => {
    for (const id of ENV.ruleSets) {
      const args = fixtureResolveArgs();
      args.settings = { ...args.settings, taxRuleSet: id };
      const r = resolvePlan(args, context());
      expect(r.input, id).toBeDefined();
      expect(validateInput(r.input!), id).toEqual([]);
    }
  });
});
