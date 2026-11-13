import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { looseWireFields } from "../wire.js";
import * as apiContracts from "./api.js";
import {
  CreateScenarioBody,
  ProfileResponse,
  PutProfileBody,
  RETIREMENT_API_PREFIX,
  RETIREMENT_ROUTES,
  RetirementMeta,
  RunListQuery,
  RunPathParams,
  RunPathResponse,
  RunRequestBody,
  ScenarioInputResponse,
  SimRunDetail,
  UpdateRunBody,
  UpdateScenarioBody,
} from "./api.js";
import { RetirementCard } from "./card.js";
import { defaultRunSettings } from "./settings.js";
import * as taxContracts from "./tax.js";
import { exampleFanSeries, exampleSimSummary, exampleYearTable, fixtureBaseline, fixtureProfileDoc, fixtureSimInput, IDS } from "./testFixtures.js";

const ok = (schema: z.ZodTypeAny, value: unknown) => schema.safeParse(value).success;
const RUN = "d0000000-0000-4000-8000-000000000001";

const runView = {
  id: RUN,
  scenarioId: IDS.scenario,
  scenarioName: "Base plan",
  status: "done",
  cancelRequested: false,
  stalled: false,
  paths: 10,
  pathsDone: 10,
  progressBp: 10000,
  seed: 1,
  returnModel: "bootstrap",
  strategy: "constant_dollar",
  taxRuleSet: "current_law",
  baselineAsOf: "2026-10-13",
  dataVersion: "2026.11.0",
  engineVersion: "1.0.0",
  threads: 3,
  inputHash: "0".repeat(64),
  successPaths: 8,
  successBp: 8000,
  medianEndingRealCents: "98000000",
  p10EndingRealCents: "0",
  errorCode: null,
  errorMessage: null,
  pinned: false,
  note: null,
  createdAt: "2026-10-14T12:00:00.000Z",
  startedAt: "2026-10-14T12:00:01.000Z",
  finishedAt: "2026-10-14T12:00:03.000Z",
  durationMs: 2000,
  current: true,
};

describe("the planner's routes (inputs-and-data §4.7, tax-rmd-ss §4.4, seams C42)", () => {
  it("24 routes in the designs' numbering under /api/retirement", () => {
    expect(RETIREMENT_API_PREFIX).toBe("/api/retirement");
    expect(RETIREMENT_ROUTES.map((r) => r.n)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    const keys = RETIREMENT_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(24);
    expect(keys.slice(21)).toEqual(["GET /rules", "POST /tax-preview", "POST /social-security-preview"]);
  });

  it("the viewer matrix: reads and the two previews are open to viewers, every other mutation is owner-only", () => {
    const owner = RETIREMENT_ROUTES.filter((r) => r.role === "owner").map((r) => r.n);
    expect(owner).toEqual([3, 4, 6, 8, 10, 11, 12, 14, 19, 20, 21]);
    for (const route of RETIREMENT_ROUTES) {
      if (route.method === "GET") expect(route.role, `${route.n}`).toBe("any");
    }
    expect(RETIREMENT_ROUTES.filter((r) => r.method === "POST" && r.role === "any").map((r) => r.n)).toEqual([23, 24]);
  });

  it("every path parameter has a params contract", () => {
    for (const route of RETIREMENT_ROUTES) {
      const names = [...route.path.matchAll(/:([a-z]+)/g)].map((m) => m[1]);
      const shape = route.params instanceof z.ZodObject ? Object.keys(route.params.shape as object) : [];
      expect(shape, `${route.n} ${route.path}`).toEqual(names);
    }
  });

  it("the request guard (commit aea5d84): every request contract uses only the bounded wire shapes", () => {
    const offenders: string[] = [];
    for (const route of RETIREMENT_ROUTES) {
      for (const part of ["params", "querystring", "body"] as const) {
        for (const field of looseWireFields(route[part])) offenders.push(`${route.n} ${part}: ${field}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every exported request contract is guarded and used by a route", () => {
    const used = new Set(RETIREMENT_ROUTES.flatMap((r) => [r.params, r.querystring, r.body]).filter((s) => s !== undefined));
    const offenders: string[] = [];
    let count = 0;
    for (const [name, value] of Object.entries({ ...apiContracts, ...taxContracts })) {
      if (!/(Body|Query|Params|Request)$/.test(name) || !(value instanceof z.ZodType)) continue;
      count++;
      for (const field of looseWireFields(value)) offenders.push(`${name}: ${field}`);
      if (!used.has(value)) offenders.push(`${name}: not in RETIREMENT_ROUTES`);
    }
    expect(offenders).toEqual([]);
    // 11 in api.ts (routes 2 to 21) and the two preview requests in tax.ts.
    expect(count).toBe(13);
  });

  it("strict request bodies: a valid body with one unknown key is refused", () => {
    const valid: Record<number, unknown> = {
      3: { doc: fixtureProfileDoc(), expectedRevision: 0 },
      4: { auditId: RUN, expectedRevision: 1 },
      6: {},
      8: { name: "Retire at 58" },
      10: { expectedRevision: 1 },
      12: { auditId: RUN, expectedRevision: 1 },
      14: {},
      20: {},
      23: { year: 2026, filingStatus: "single", ages: [40] },
      24: { people: [{ birthYear: 1975, birthMonth: 6, monthlyAtFraCents: "280000", asOfYear: 2026, claimAgeMonths: 804 }], startYear: 2026 },
    };
    const withBody = RETIREMENT_ROUTES.filter((r) => r.body !== undefined);
    expect(withBody.map((r) => r.n)).toEqual(Object.keys(valid).map(Number));
    for (const route of withBody) {
      const body = valid[route.n] as object;
      expect(route.body?.safeParse(body).success, `${route.n} valid`).toBe(true);
      expect(route.body?.safeParse({ ...body, unexpectedKey: true }).success, `${route.n} unknown key`).toBe(false);
    }
  });
});

describe("request contracts", () => {
  it("route 3: the fixture document with expectedRevision 0 creates the profile", () => {
    const body = PutProfileBody.parse({ doc: fixtureProfileDoc(), expectedRevision: 0, today: "2026-10-14" });
    expect(body.expectedRevision).toBe(0);
    expect(ok(PutProfileBody, { doc: fixtureProfileDoc(), expectedRevision: -1 })).toBe(false);
    expect(ok(PutProfileBody, { doc: fixtureProfileDoc(), expectedRevision: 0, today: "2026-02-31" })).toBe(false);
  });

  it("routes 8 and 10: profileRevision is required with doc", () => {
    expect(ok(CreateScenarioBody, { name: "Retire at 58" })).toBe(true);
    expect(ok(CreateScenarioBody, { name: "Retire at 58", doc: fixtureProfileDoc(), profileRevision: 3, settings: defaultRunSettings() })).toBe(true);
    expect(CreateScenarioBody.safeParse({ name: "Retire at 58", doc: fixtureProfileDoc() }).error?.issues[0]).toMatchObject({ path: ["profileRevision"], message: "profileRevision is required with doc" });
    expect(ok(CreateScenarioBody, { name: "   " })).toBe(false);
    expect(ok(CreateScenarioBody, { name: "x".repeat(81) })).toBe(false);
    expect(ok(UpdateScenarioBody, { expectedRevision: 2, notes: null, isDefault: true })).toBe(true);
    expect(ok(UpdateScenarioBody, { expectedRevision: 2, doc: fixtureProfileDoc() })).toBe(false);
    expect(ok(UpdateScenarioBody, { expectedRevision: 0 })).toBe(false);
  });

  it("route 14: refresh by default, never forced by default", () => {
    expect(RunRequestBody.parse({})).toEqual({ refresh: true, force: false });
    expect(RunRequestBody.parse({ refresh: false, today: "2026-10-14" })).toEqual({ refresh: false, force: false, today: "2026-10-14" });
  });

  it("route 15: limit 1 to 100, default 20, from the query string", () => {
    expect(RunListQuery.parse({})).toEqual({ limit: 20 });
    expect(RunListQuery.parse({ limit: "50", scenarioId: IDS.scenario })).toEqual({ limit: 50, scenarioId: IDS.scenario });
    for (const limit of ["0", "101", "2.5", "x"]) expect(ok(RunListQuery, { limit }), limit).toBe(false);
  });

  it("API-2: percentiles 1 to 99; 0 and 100 are refused", () => {
    expect(RunPathParams.parse({ id: RUN, percentile: "50" })).toEqual({ id: RUN, percentile: 50 });
    expect(RunPathParams.parse({ id: RUN, percentile: "37" }).percentile).toBe(37);
    for (const percentile of ["0", "100", "-5", "12.5", "median"]) expect(ok(RunPathParams, { id: RUN, percentile }), percentile).toBe(false);
    expect(ok(RunPathParams, { id: "run-1", percentile: "50" })).toBe(false);
  });

  it("route 20: pin and note", () => {
    expect(ok(UpdateRunBody, { pinned: true, note: null })).toBe(true);
    expect(ok(UpdateRunBody, { note: "x".repeat(501) })).toBe(false);
  });
});

describe("response contracts", () => {
  it("C47: the meta carries minStartYear", () => {
    const meta = {
      engineVersion: "1.0.0",
      dataVersion: "2026.11.0",
      minStartYear: 2026,
      ruleSets: [{ id: "current_law", label: "Current law" }],
      limits: { minPaths: 100, maxPaths: 100_000, defaultPaths: 10_000 },
      defaultSettings: defaultRunSettings(),
      storedPercentiles: [5, 10, 25, 50, 75, 90, 95],
      medicareAge: 65,
      fullRetirementAge: [{ fromBirthYear: 1960, toBirthYear: null, years: 67, months: 0 }],
      disclaimer: "The planner is an estimate, not tax or investment advice.",
    };
    expect(RetirementMeta.parse(meta)).toEqual(meta);
    const { minStartYear: _dropped, ...without } = meta;
    expect(ok(RetirementMeta, without)).toBe(false);
  });

  it("routes 2, 13, 16 and 18 carry the stored documents", () => {
    expect(
      ok(ProfileResponse, {
        exists: true,
        revision: 1,
        doc: fixtureProfileDoc(),
        updatedAt: "2026-10-14T12:00:00.000Z",
        baseline: fixtureBaseline(),
        baselineStored: true,
        baselineHash: "0".repeat(64),
        baselineAgeDays: 1,
        baselineStale: false,
        effective: null,
        issues: [],
        scenarioIssues: [],
        defaultScenarioId: IDS.scenario,
      }),
    ).toBe(true);
    expect(ok(ScenarioInputResponse, { input: fixtureSimInput(), inputHash: "0".repeat(64), issues: [], effective: null, reusableRunId: null })).toBe(true);
    expect(ok(SimRunDetail, { ...runView, summary: exampleSimSummary(), fan: exampleFanSeries(), warnings: [], storedPercentiles: [5, 10, 25, 50, 75, 90, 95] })).toBe(true);
    expect(ok(SimRunDetail, { ...runView, summary: null, fan: null, warnings: [{ code: "mortality_fallback_table", message: "x" }], storedPercentiles: [] })).toBe(true);
  });

  it("C46: a path's depletion year is depletionYear, null for never", () => {
    const path = { percentile: 50, pathIndex: 3, rank: 5, source: "stored", endingRealCents: "98000000", depletionYear: null, table: exampleYearTable() };
    expect(ok(RunPathResponse, path)).toBe(true);
    expect(ok(RunPathResponse, { ...path, depletionYear: 2053 })).toBe(true);
    const { depletionYear: _dropped, ...old } = path;
    expect(ok(RunPathResponse, { ...old, depletedYear: null })).toBe(false);
  });

  it("the dashboard card (inputs §4.9)", () => {
    expect(ok(RetirementCard, { state: "no_run", scenarioId: IDS.scenario, scenarioName: "Base plan", active: null, run: null, issues: 0 })).toBe(true);
    expect(
      ok(RetirementCard, {
        state: "ready",
        scenarioId: IDS.scenario,
        scenarioName: "Base plan",
        active: null,
        run: {
          id: RUN,
          finishedAt: "2026-10-14T12:00:03.000Z",
          paths: 69,
          successPaths: 65,
          successBp: 9420,
          medianEndingRealCents: "241039603",
          p10EndingRealCents: "27816395",
          baselineAsOf: "2026-10-13",
          ageDays: 1,
          stale: { inputsChanged: false, engineChanged: false },
        },
        issues: 0,
      }),
    ).toBe(true);
    expect(ok(RetirementCard, { state: "stale", scenarioId: IDS.scenario, scenarioName: "x", active: null, run: null, issues: 0 })).toBe(false);
  });
});

describe("import rule (no cycle between ../api.ts and this directory)", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const source = (path: string) => readFileSync(path, "utf8");
  const imports = (text: string) => [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);

  it("only ./api.ts here imports ../api.ts", () => {
    for (const file of readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const importsApi = imports(source(`${here}${file}`)).includes("../api.js");
      expect(importsApi, file).toBe(file === "api.ts");
    }
  });

  it("../api.ts imports nothing from this directory but ./retirement/card.js", () => {
    const fromHere = imports(source(fileURLToPath(new URL("../api.ts", import.meta.url)))).filter((p) => p?.startsWith("./retirement/"));
    expect(fromHere.every((p) => p === "./retirement/card.js")).toBe(true);
  });
});
