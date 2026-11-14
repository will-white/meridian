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
