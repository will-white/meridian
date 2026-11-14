import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { count, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse, RouteOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { auditLog, failSimRun, job, planProfile, scenario, simRun, simRunPath, simRunSeries, computeBaseline } from "@meridian/db";
import {
  drainFakeRuns,
  FAKE_REFUSED_SEED,
  fakePlannerEngine,
  RETIREMENT_SEED_NOW,
  RETIREMENT_SEED_TODAY,
  retirementFixtureDoc,
  seedRetirementFixture,
  type FakePlannerEngine,
  type RetirementSeed,
} from "@meridian/db/testing";
import {
  DashboardView,
  defaultRunSettings,
  ProfileResponse,
  RETIREMENT_API_PREFIX,
  RETIREMENT_ROUTES,
  RetirementProfileDoc,
  RunPathResponse,
  RunRequestResponse,
  ScenarioView,
  SimInput,
  SimRunDetail,
  type RetirementProfileDocInput,
  type RetirementRoute,
} from "@meridian/shared";
import { createTestApp, fakePlanner, signInOwner, TEST_DATABASE_URL, viewerCookies, type CookieJar, type FakePlanner, type TestApp } from "./test/helpers.js";

/**
 * The planner's API (docs/design/phase-4/inputs-and-data.md §7, cases 32 to 37; seams C42): the
 * route table, the viewer matrix over routes 1 to 24, the profile round trip, a run end to end,
 * the error codes of the §4.8 table and the dashboard's card. On the planner fixture (§7.0,
 * `seedRetirementFixture`, the server clock at 2026-10-14) with the fake planner (`fakePlanner`:
 * packages/db's fake engine, whose runs `drainFakeRuns` completes as the ten-path result of §3.8).
 * Routes 22 to 24 against the real tax functions are in retirementPreview.test.ts.
 */

const R = RETIREMENT_API_PREFIX;
const NOW = RETIREMENT_SEED_NOW;
const TODAY = RETIREMENT_SEED_TODAY;
const MISSING = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** A request body the contract accepts, for routes whose role is under test (not their logic). */
const TAX_PREVIEW = { year: 2026, filingStatus: "single", ages: [40], wagesCents: "10000000" };
const SS_PREVIEW = { people: [{ birthYear: 1960, birthMonth: 3, monthlyAtFraCents: "200000", asOfYear: 2026, claimAgeMonths: 804 }], startYear: 2026 };

interface PlannerApp {
  t: TestApp;
  seed: RetirementSeed;
  doc: RetirementProfileDocInput;
  planner: FakePlanner;
}

async function plannerApp(planner: FakePlanner = fakePlanner()): Promise<PlannerApp> {
  const t = await createTestApp({ now: () => NOW, planner });
  const seed = await seedRetirementFixture(t.db.db);
  await signInOwner(t);
  return { t, seed, doc: retirementFixtureDoc(seed), planner };
}

function withRetirementAge(doc: RetirementProfileDocInput, age: number): RetirementProfileDocInput {
  return { ...doc, people: { ...doc.people, p1: { ...doc.people.p1, retirementAge: age } } };
}

/** The response's JSON after checking it against a contract (a failed parse names the issues). */
function parsed<T extends z.ZodTypeAny>(schema: T, res: LightMyRequestResponse): z.infer<T> {
  const json: unknown = res.json();
  const result = schema.safeParse(json);
  expect(result.success, `${res.statusCode} ${res.body.slice(0, 400)} ${JSON.stringify(result.error?.issues ?? [])}`).toBe(true);
  return result.data as z.infer<T>;
}

function expectError(res: LightMyRequestResponse, status: number, code: string): void {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.json()).toMatchObject({ code, error: expect.any(String) });
}

async function putProfile(p: PlannerApp, doc: RetirementProfileDocInput = p.doc, expectedRevision = 0) {
  const res = await p.t.call({ method: "PUT", url: `${R}/profile`, payload: { doc, expectedRevision } });
  return parsed(ProfileResponse, res);
}

async function tableCounts(p: PlannerApp): Promise<Record<string, number>> {
  const db = p.t.db.db;
  const n = async (table: typeof planProfile | typeof scenario | typeof simRun | typeof simRunSeries | typeof simRunPath | typeof job | typeof auditLog) =>
    (await db.select({ n: count() }).from(table))[0]!.n;
  return {
    plan_profile: await n(planProfile),
    scenario: await n(scenario),
    sim_run: await n(simRun),
    sim_run_series: await n(simRunSeries),
    sim_run_path: await n(simRunPath),
    job: await n(job),
    audit_log: await n(auditLog),
  };
}

describe.skipIf(!TEST_DATABASE_URL)("case 32: the app builds with the planner's routes, and they are the contract's", () => {
  let t: TestApp;
  let routes: RouteOptions[];

  beforeAll(async () => {
    // Every route Fastify registers, from the root's onRoute hook in every scope (as guardCoverage.test.ts does).
    routes = [];
    const onInit = (message: unknown) => {
      (message as { fastify: FastifyInstance }).fastify.addHook("onRoute", (route) => {
        routes.push(route);
      });
    };
    subscribe("fastify.initialization", onInit);
    try {
      // The request guard throws while the app is built if any body, query or path contract uses a loose wire shape.
      t = await createTestApp({ planner: fakePlanner() });
    } finally {
      unsubscribe("fastify.initialization", onInit);
    }
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const methodOf = (route: RouteOptions) => (Array.isArray(route.method) ? route.method.join(",") : route.method);
  const registered = (entry: RetirementRoute) => routes.filter((r) => r.url === `${R}${entry.path}` && methodOf(r) === entry.method);

  it("each of the 24 routes is registered once, with the contract's schemas, and nothing else under the prefix", () => {
    for (const entry of RETIREMENT_ROUTES) {
      const found = registered(entry);
      expect(found, `${entry.n} ${entry.method} ${entry.path}`).toHaveLength(1);
      const schema = found[0]!.schema as { body?: unknown; querystring?: unknown; params?: unknown; response?: Record<number, unknown> };
      expect(schema.body, `${entry.n} body`).toBe(entry.body);
      expect(schema.querystring, `${entry.n} querystring`).toBe(entry.querystring);
      expect(schema.params, `${entry.n} params`).toBe(entry.params);
      expect(Object.keys(schema.response ?? {}).map(Number).sort(), `${entry.n} statuses`).toEqual(Object.keys(entry.response).map(Number).sort());
      for (const [status, contract] of Object.entries(entry.response)) expect(schema.response?.[Number(status)], `${entry.n} ${status}`).toBe(contract);
    }
    const ours = routes.filter((r) => r.url.startsWith(`${R}/`) && methodOf(r) !== "HEAD");
    expect(ours).toHaveLength(RETIREMENT_ROUTES.length);
  });

  it("the read-only POSTs are 23 and 24 (config.readOnly); every other non-GET is a mutation", () => {
    for (const entry of RETIREMENT_ROUTES) {
      const readOnly = (registered(entry)[0]!.config as { readOnly?: boolean } | undefined)?.readOnly === true;
      expect(readOnly, `${entry.n}`).toBe(entry.method !== "GET" && entry.role === "any");
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("case 33: the viewer matrix over routes 1 to 24", () => {
  let p: PlannerApp;
  let viewer: CookieJar;
  let base: string;
  let second: string;
  let runId: string;
  let auditId: string;

  beforeAll(async () => {
    p = await plannerApp();
    const profile = await putProfile(p);
    base = profile.defaultScenarioId!;
    second = parsed(ScenarioView, await p.t.call({ method: "POST", url: `${R}/scenarios`, payload: { name: "Second" } })).id;
    runId = parsed(RunRequestResponse, await p.t.call({ method: "POST", url: `${R}/scenarios/${base}/runs`, payload: {} })).run.id;
    expect(await drainFakeRuns(p.t.db.db)).toEqual([{ runId, outcome: "done" }]);
    const [row] = await p.t.db.db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entity, "scenario")).limit(1);
    auditId = row!.id;
    viewer = await viewerCookies(p.t);
  });
  afterAll(async () => {
    await p?.t.cleanup();
  });

  /** Each route with a request its contract accepts; `n` is the designs' number. */
  const requests = () =>
    [
      { n: 1, method: "GET", url: `${R}/meta` },
      { n: 2, method: "GET", url: `${R}/profile` },
      { n: 3, method: "PUT", url: `${R}/profile`, payload: { doc: p.doc, expectedRevision: 1 } },
      { n: 4, method: "POST", url: `${R}/profile/revert`, payload: { auditId, expectedRevision: 1 } },
      { n: 5, method: "GET", url: `${R}/baseline/preview` },
      { n: 6, method: "POST", url: `${R}/baseline/refresh`, payload: {} },
      { n: 7, method: "GET", url: `${R}/scenarios?includeArchived=true` },
      { n: 8, method: "POST", url: `${R}/scenarios`, payload: { name: "Third" } },
      { n: 9, method: "GET", url: `${R}/scenarios/${base}` },
      { n: 10, method: "PATCH", url: `${R}/scenarios/${second}`, payload: { expectedRevision: 1, name: "Renamed" } },
      { n: 11, method: "DELETE", url: `${R}/scenarios/${second}` },
      { n: 12, method: "POST", url: `${R}/scenarios/${second}/revert`, payload: { auditId, expectedRevision: 1 } },
      { n: 13, method: "GET", url: `${R}/scenarios/${base}/input` },
      { n: 14, method: "POST", url: `${R}/scenarios/${base}/runs`, payload: { force: true } },
      { n: 15, method: "GET", url: `${R}/runs?scenarioId=${base}` },
      { n: 16, method: "GET", url: `${R}/runs/${runId}` },
      { n: 17, method: "GET", url: `${R}/runs/${runId}/input` },
      { n: 18, method: "GET", url: `${R}/runs/${runId}/paths/50` },
      { n: 19, method: "POST", url: `${R}/runs/${runId}/cancel` },
      { n: 20, method: "PATCH", url: `${R}/runs/${runId}`, payload: { pinned: true } },
      { n: 21, method: "DELETE", url: `${R}/runs/${runId}` },
      { n: 22, method: "GET", url: `${R}/rules` },
      { n: 23, method: "POST", url: `${R}/tax-preview`, payload: TAX_PREVIEW },
      { n: 24, method: "POST", url: `${R}/social-security-preview`, payload: SS_PREVIEW },
    ] as const;

  it("a viewer gets 200 on routes 1, 2, 5, 7, 9, 13, 15 to 18 and 22 to 24, each answer its contract, and 403 viewer on the rest; nothing is written", async () => {
    const before = await tableCounts(p);
    const [profileBefore] = await p.t.db.db.select().from(planProfile);
    const open: number[] = [];
    const refused: number[] = [];
    for (const request of requests()) {
      const route = RETIREMENT_ROUTES.find((r) => r.n === request.n)!;
      const res = await p.t.call({ ...request, cookies: viewer });
      if (res.statusCode === 200) {
        open.push(request.n);
        parsed(route.response[200]!, res);
      } else {
        expectError(res, 403, "viewer");
        refused.push(request.n);
      }
    }
    expect(open).toEqual([1, 2, 5, 7, 9, 13, 15, 16, 17, 18, 22, 23, 24]);
    expect(refused).toEqual([3, 4, 6, 8, 10, 11, 12, 14, 19, 20, 21]);
    // The matrix is the contract's roles.
    expect(refused).toEqual(RETIREMENT_ROUTES.filter((r) => r.role === "owner").map((r) => r.n));
    // A re-simulated percentile writes nothing either.
    const resim = parsed(RunPathResponse, await p.t.call({ method: "GET", url: `${R}/runs/${runId}/paths/60`, cookies: viewer }));
    expect(resim.source).toBe("resimulated");
    expect(await tableCounts(p)).toEqual(before);
    const [profileAfter] = await p.t.db.db.select().from(planProfile);
    expect(profileAfter).toEqual(profileBefore);
  });

  it("the owner may call every route of the matrix (each read as the viewer did)", async () => {
    // Reads only: the owner's writes are cases 34 to 36. The status is the owner's, not a refusal.
    for (const request of requests().filter((r) => r.method === "GET" || r.n === 23 || r.n === 24)) {
      const res = await p.t.call(request);
      expect(res.statusCode, `${request.n} ${res.body.slice(0, 200)}`).toBe(200);
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("case 34: the profile round trip", () => {
  let p: PlannerApp;
  beforeAll(async () => {
    p = await plannerApp();
  });
  afterAll(async () => {
    await p?.t.cleanup();
  });

  it("GET before creation: exists false, revision 0, no document, the live baseline of case 20, not stored", async () => {
    const res = await p.t.call({ method: "GET", url: `${R}/profile` });
    const profile = parsed(ProfileResponse, res);
    expect(profile).toMatchObject({ exists: false, revision: 0, doc: null, updatedAt: null, baselineStored: false, effective: null, defaultScenarioId: null });
    const live = await computeBaseline(p.t.db.db, { today: TODAY, now: NOW });
    expect(res.json().baseline).toEqual(JSON.parse(JSON.stringify(live)));
    expect(live.asOf).toBe("2026-10-13");
    expect(await p.t.db.db.select().from(planProfile)).toEqual([]);
  });

  it("PUT creates it; GET answers the same document with case 21's effective inputs and the default scenario", async () => {
    const put = await p.t.call({ method: "PUT", url: `${R}/profile`, payload: { doc: p.doc, expectedRevision: 0 } });
    expect(put.statusCode, put.body).toBe(200);
    expect(parsed(ProfileResponse, put)).toMatchObject({ exists: true, revision: 1, baselineStored: true });

    const profile = parsed(ProfileResponse, await p.t.call({ method: "GET", url: `${R}/profile` }));
    expect(profile.doc).toEqual(RetirementProfileDoc.parse(p.doc));
    expect(profile.effective).toMatchObject({ baseSpendingCents: "4000000", essentialSpendingCents: "2400000", includedTotalCents: "22582700", planSavingsRateBp: 1644 });
    expect(profile.defaultScenarioId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(profile.issues.filter((i) => i.severity === "error")).toEqual([]);
    const [sc] = await p.t.db.db.select().from(scenario);
    expect(sc).toMatchObject({ id: profile.defaultScenarioId, name: "Base plan", isDefault: true });
  });

  it("a claim age of 71 is 400 validation; a today five days off is 400 today_out_of_range; neither writes", async () => {
    const bad = structuredClone(RetirementProfileDoc.parse(p.doc)) as unknown as { socialSecurity: { p1: { claimAge: { years: number } } } };
    bad.socialSecurity.p1.claimAge.years = 71;
    expectError(await p.t.call({ method: "PUT", url: `${R}/profile`, payload: { doc: bad, expectedRevision: 1 } }), 400, "validation");
    expectError(await p.t.call({ method: "GET", url: `${R}/profile?today=2026-10-19` }), 400, "today_out_of_range");
    expectError(await p.t.call({ method: "PUT", url: `${R}/profile`, payload: { doc: p.doc, expectedRevision: 1, today: "2026-10-09" } }), 400, "today_out_of_range");
    // Two days off is the client's own date and is accepted.
    expect((await p.t.call({ method: "GET", url: `${R}/profile?today=2026-10-16` })).statusCode).toBe(200);
    const [row] = await p.t.db.db.select().from(planProfile);
    expect(row!.revision).toBe(1);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("case 35: a run end to end", () => {
  let p: PlannerApp;
  beforeAll(async () => {
    p = await plannerApp();
  });
  afterAll(async () => {
    await p?.t.cleanup();
  });

  it("PUT profile → POST scenario → POST run → drain → the run, its input, a stored and a re-simulated path, the dashboard", async () => {
    const profile = await putProfile(p);

    // POST scenario: the full edited document, stored as its patch over the profile (case 23).
    const created = await p.t.call({ method: "POST", url: `${R}/scenarios`, payload: { name: "Retire at 58", doc: withRetirementAge(p.doc, 58), profileRevision: profile.revision } });
    expect(created.statusCode, created.body).toBe(201);
    const sc = parsed(ScenarioView, created);
    expect(sc).toMatchObject({ name: "Retire at 58", isDefault: false, overrides: { people: { p1: { retirementAge: 58 } } }, changeCount: 1, latestRun: null, activeRunId: null });
    expect(sc.issues.filter((i) => i.severity === "error")).toEqual([]);

    // POST run: 202, a new queued run.
    const requested = await p.t.call({ method: "POST", url: `${R}/scenarios/${sc.id}/runs`, payload: {} });
    expect(requested.statusCode, requested.body).toBe(202);
    const run = parsed(RunRequestResponse, requested);
    expect(run).toMatchObject({ created: true, reused: false, run: { scenarioId: sc.id, status: "queued", pathsDone: 0 } });

    const queued = parsed(SimRunDetail, await p.t.call({ method: "GET", url: `${R}/runs/${run.run.id}` }));
    expect(queued).toMatchObject({ status: "queued", pathsDone: 0, summary: null, fan: null, storedPercentiles: [] });

    // The worker's side, with the fake engine.
    expect(await drainFakeRuns(p.t.db.db)).toEqual([{ runId: run.run.id, outcome: "done" }]);

    const done = parsed(SimRunDetail, await p.t.call({ method: "GET", url: `${R}/runs/${run.run.id}` }));
    // §3.8's ten paths, eight funded: truncDiv(8 × 10000, 10) = 8000; the summary's p50 and p10.
    expect(done).toMatchObject({ status: "done", paths: 10, pathsDone: 10, progressBp: 10000, successPaths: 8, successBp: 8000, medianEndingRealCents: "300", p10EndingRealCents: "0", current: true });
    expect(done.storedPercentiles).toEqual([5, 10, 25, 50, 75, 90, 95]);

    // GET input: the stored document.
    const [row] = await p.t.db.db.select({ input: simRun.input }).from(simRun).where(eq(simRun.id, run.run.id));
    expect(parsed(SimInput, await p.t.call({ method: "GET", url: `${R}/runs/${run.run.id}/input` }))).toEqual(SimInput.parse(row!.input));

    // Percentile 50 is stored: rank 4 of the ranking 2, 0, 5, 9, 3, … is path 3, ending 300 (case 25).
    const p50 = parsed(RunPathResponse, await p.t.call({ method: "GET", url: `${R}/runs/${run.run.id}/paths/50` }));
    expect(p50).toMatchObject({ percentile: 50, pathIndex: 3, rank: 4, source: "stored", endingRealCents: "300", depletionYear: null });
    // Percentile 60 is not: rank 5 is path 7 (ending 400), re-simulated once by the planner (case 30).
    const calls = p.planner.engine.calls.length;
    const p60 = parsed(RunPathResponse, await p.t.call({ method: "GET", url: `${R}/runs/${run.run.id}/paths/60` }));
    expect(p60).toMatchObject({ percentile: 60, pathIndex: 7, rank: 5, source: "resimulated", endingRealCents: "400", depletionYear: null });
    expect(p.planner.engine.calls.slice(calls)).toEqual([7]);

    // Asking again with the same input returns the finished run: 200, not a new one.
    const again = await p.t.call({ method: "POST", url: `${R}/scenarios/${sc.id}/runs`, payload: { refresh: false } });
    expect(again.statusCode, again.body).toBe(200);
    expect(parsed(RunRequestResponse, again)).toMatchObject({ created: false, reused: true, run: { id: run.run.id } });

    // The lists.
    const runs = await p.t.call({ method: "GET", url: `${R}/runs?scenarioId=${sc.id}` });
    expect(runs.statusCode).toBe(200);
    expect(runs.json()).toMatchObject({ items: [{ id: run.run.id, status: "done" }], nextCursor: null });
    const list = await p.t.call({ method: "GET", url: `${R}/scenarios` });
    expect(list.json().items.map((s: { name: string; latestRun: { id: string } | null }) => [s.name, s.latestRun?.id ?? null])).toEqual([
      ["Base plan", null],
      ["Retire at 58", run.run.id],
    ]);

    // The card reports the default scenario's newest done run: make this scenario the default.
    const patched = await p.t.call({ method: "PATCH", url: `${R}/scenarios/${sc.id}`, payload: { expectedRevision: sc.revision, isDefault: true } });
    expect(parsed(ScenarioView, patched)).toMatchObject({ isDefault: true, revision: sc.revision + 1 });
    const dashboard = parsed(DashboardView, await p.t.call({ method: "GET", url: "/api/dashboard" }));
    expect(dashboard.retirement).toMatchObject({
      state: "ready",
      scenarioId: sc.id,
      active: null,
      run: { id: run.run.id, successBp: 8000, medianEndingRealCents: "300", p10EndingRealCents: "0", stale: { inputsChanged: false, engineChanged: false } },
      issues: 0,
    });

    // Pin and note, then the run is still there (a pinned run survives pruning).
    const flagged = await p.t.call({ method: "PATCH", url: `${R}/runs/${run.run.id}`, payload: { pinned: true, note: "the 58 case" } });
    expect(flagged.json()).toMatchObject({ pinned: true, note: "the 58 case" });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("case 36: the error codes of the §4.8 table", () => {
  let p: PlannerApp;
  let offset = 0n;
  let base: string;
  let firstRun: string;

  beforeAll(async () => {
    // A fake engine that can be told to disagree with the stored series (not_reproducible).
    const calls: number[] = [];
    const engine: FakePlannerEngine = {
      calls,
      simulatePath: (input, k) => {
        calls.push(k);
        return fakePlannerEngine({ endingOffset: offset }).simulatePath(input, k);
      },
    };
    p = await plannerApp(fakePlanner({ engine }));
  });
  afterAll(async () => {
    await p?.t.cleanup();
  });

  it("409 profile_missing for scenario and run writes (and the baseline refresh) before a profile exists", async () => {
    const writes = [
      { method: "POST", url: `${R}/scenarios`, payload: { name: "Early" } },
      { method: "PATCH", url: `${R}/scenarios/${MISSING}`, payload: { expectedRevision: 1, name: "Early" } },
      { method: "DELETE", url: `${R}/scenarios/${MISSING}` },
      { method: "POST", url: `${R}/scenarios/${MISSING}/runs`, payload: {} },
      { method: "POST", url: `${R}/runs/${MISSING}/cancel` },
      { method: "PATCH", url: `${R}/runs/${MISSING}`, payload: { pinned: true } },
      { method: "DELETE", url: `${R}/runs/${MISSING}` },
      { method: "POST", url: `${R}/baseline/refresh`, payload: {} },
    ] as const;
    const before = await tableCounts(p);
    for (const w of writes) expectError(await p.t.call(w), 409, "profile_missing");
    // Reads answer: an empty list, and the profile route never 404s.
    expect((await p.t.call({ method: "GET", url: `${R}/scenarios` })).json()).toEqual({ items: [] });
    expect((await p.t.call({ method: "GET", url: `${R}/runs` })).json()).toEqual({ items: [], nextCursor: null });
    expect((await p.t.call({ method: "GET", url: `${R}/profile` })).statusCode).toBe(200);
    expect(await tableCounts(p)).toEqual(before);
    expect(before).toMatchObject({ plan_profile: 0, scenario: 0, sim_run: 0 });
  });

  it("400 validation: a contract fails (a claim age of 71, percentile 0 or 100, an id that is not a uuid, a loose cents field)", async () => {
    const profile = await putProfile(p);
    base = profile.defaultScenarioId!;
    const bad = structuredClone(RetirementProfileDoc.parse(p.doc)) as unknown as { socialSecurity: { p1: { claimAge: { years: number } } } };
    bad.socialSecurity.p1.claimAge.years = 71;
    expectError(await p.t.call({ method: "PUT", url: `${R}/profile`, payload: { doc: bad, expectedRevision: 1 } }), 400, "validation");
    expectError(await p.t.call({ method: "GET", url: `${R}/runs/${MISSING}/paths/0` }), 400, "validation");
    expectError(await p.t.call({ method: "GET", url: `${R}/runs/${MISSING}/paths/100` }), 400, "validation");
    expectError(await p.t.call({ method: "GET", url: `${R}/scenarios/not-a-uuid` }), 400, "validation");
    expectError(await p.t.call({ method: "POST", url: `${R}/scenarios`, payload: { name: "Loose", unknownField: 1 } }), 400, "validation");
    // `doc` without the profile revision it was edited on.
    expectError(await p.t.call({ method: "POST", url: `${R}/scenarios`, payload: { name: "No revision", doc: p.doc } }), 400, "validation");
  });

  it("400 today_out_of_range and 403 viewer", async () => {
    expectError(await p.t.call({ method: "GET", url: `${R}/scenarios/${base}?today=2026-10-19` }), 400, "today_out_of_range");
    expectError(await p.t.call({ method: "POST", url: `${R}/scenarios/${base}/runs`, payload: { today: "2026-10-01" } }), 400, "today_out_of_range");
    const viewer = await viewerCookies(p.t);
    expectError(await p.t.call({ method: "PUT", url: `${R}/profile`, payload: { doc: p.doc, expectedRevision: 1 }, cookies: viewer }), 403, "viewer");
  });

  it("404 not_found names the scenario, the run or the history entry", async () => {
    for (const url of [`${R}/scenarios/${MISSING}`, `${R}/scenarios/${MISSING}/input`, `${R}/runs/${MISSING}`, `${R}/runs/${MISSING}/input`, `${R}/runs/${MISSING}/paths/50`]) {
      const res = await p.t.call({ method: "GET", url });
      expectError(res, 404, "not_found");
      expect(res.json().error).toMatch(/scenario|run/i);
    }
    const revert = await p.t.call({ method: "POST", url: `${R}/profile/revert`, payload: { auditId: MISSING, expectedRevision: 1 } });
    expectError(revert, 404, "not_found");
    expect(revert.json().error).toMatch(/history/i);
    expectError(await p.t.call({ method: "POST", url: `${R}/scenarios/${base}/revert`, payload: { auditId: MISSING, expectedRevision: 1 } }), 404, "not_found");
  });

  it("409 revision_conflict: the profile's, a scenario's, and a scenario edited on an old profile revision", async () => {
    expectError(await p.t.call({ method: "PUT", url: `${R}/profile`, payload: { doc: p.doc, expectedRevision: 7 } }), 409, "revision_conflict");
    expectError(await p.t.call({ method: "PATCH", url: `${R}/scenarios/${base}`, payload: { expectedRevision: 9, name: "Renamed" } }), 409, "revision_conflict");
    expectError(await p.t.call({ method: "POST", url: `${R}/scenarios`, payload: { name: "Stale", doc: withRetirementAge(p.doc, 58), profileRevision: 9 } }), 409, "revision_conflict");
  });

  it("409 baseline_changed: the fresh baseline's hash differs from the preview's", async () => {
    expectError(await p.t.call({ method: "POST", url: `${R}/baseline/refresh`, payload: { expectedHash: "f".repeat(64) } }), 409, "baseline_changed");
    const preview = (await p.t.call({ method: "GET", url: `${R}/baseline/preview` })).json() as { proposedHash: string };
    const refreshed = await p.t.call({ method: "POST", url: `${R}/baseline/refresh`, payload: { expectedHash: preview.proposedHash } });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
  });

  it("409 name_taken, too_many_scenarios and default_scenario", async () => {
    expectError(await p.t.call({ method: "POST", url: `${R}/scenarios`, payload: { name: "BASE PLAN" } }), 409, "name_taken");
    expectError(await p.t.call({ method: "DELETE", url: `${R}/scenarios/${base}` }), 409, "default_scenario");
    expectError(await p.t.call({ method: "PATCH", url: `${R}/scenarios/${base}`, payload: { expectedRevision: 1, archived: true } }), 409, "default_scenario");
    // 49 more open scenarios make 50, the most.
    const filler = await p.t.db.db
      .insert(scenario)
      .values(Array.from({ length: 49 }, (_, i) => ({ name: `Filler ${i + 1}`, position: i + 1, settings: defaultRunSettings() })))
      .returning({ id: scenario.id });
    expectError(await p.t.call({ method: "POST", url: `${R}/scenarios`, payload: { name: "Fifty-first" } }), 409, "too_many_scenarios");
    await p.t.db.db.delete(scenario).where(
      inArray(
        scenario.id,
        filler.map((f) => f.id),
      ),
    );
  });

  it("409 plan_incomplete: an error issue (here the engine's own refusal, seams C13) blocks the run; nothing is queued", async () => {
    const sc = parsed(ScenarioView, await p.t.call({ method: "POST", url: `${R}/scenarios`, payload: { name: "Refused seed", settings: { ...defaultRunSettings(), seed: FAKE_REFUSED_SEED } } }));
    expect(sc.issues.map((i) => i.code)).toContain("seed_invalid");
    const before = await tableCounts(p);
    expectError(await p.t.call({ method: "POST", url: `${R}/scenarios/${sc.id}/runs`, payload: { refresh: false } }), 409, "plan_incomplete");
    const input = (await p.t.call({ method: "GET", url: `${R}/scenarios/${sc.id}/input` })).json();
    expect(input).toMatchObject({ input: null, inputHash: null, reusableRunId: null });
    expect(await tableCounts(p)).toEqual(before);
  });

  it("409 run_in_progress, run_active and run_not_done while a run is queued", async () => {
    const queued = await p.t.call({ method: "POST", url: `${R}/scenarios/${base}/runs`, payload: { refresh: false } });
    expect(queued.statusCode, queued.body).toBe(202);
    firstRun = queued.json().run.id;
    const sc = parsed(ScenarioView, await p.t.call({ method: "GET", url: `${R}/scenarios/${base}` }));
    const changed = await p.t.call({ method: "PATCH", url: `${R}/scenarios/${base}`, payload: { expectedRevision: sc.revision, settings: { ...defaultRunSettings(), seed: 2 } } });
    expect(changed.statusCode, changed.body).toBe(200);
    const busy = await p.t.call({ method: "POST", url: `${R}/scenarios/${base}/runs`, payload: { refresh: false } });
    expectError(busy, 409, "run_in_progress");
    expect(busy.json().error).toContain(firstRun);
    expectError(await p.t.call({ method: "DELETE", url: `${R}/runs/${firstRun}` }), 409, "run_active");
    expectError(await p.t.call({ method: "GET", url: `${R}/runs/${firstRun}/paths/50` }), 409, "run_not_done");
  });

  it("409 run_not_active, engine_changed, not_reproducible and pin_limit on a finished run", async () => {
    expect(await drainFakeRuns(p.t.db.db)).toEqual([{ runId: firstRun, outcome: "done" }]);
    expectError(await p.t.call({ method: "POST", url: `${R}/runs/${firstRun}/cancel` }), 409, "run_not_active");

    // A non-stored percentile after the engine moved: only the stored ones are served.
    await p.t.db.db.update(simRun).set({ engineVersion: "fake-0.9.0" }).where(eq(simRun.id, firstRun));
    expectError(await p.t.call({ method: "GET", url: `${R}/runs/${firstRun}/paths/60` }), 409, "engine_changed");
    expect((await p.t.call({ method: "GET", url: `${R}/runs/${firstRun}/paths/50` })).statusCode).toBe(200);
    await p.t.db.db.update(simRun).set({ engineVersion: p.planner.env.engineVersion }).where(eq(simRun.id, firstRun));

    // A re-simulated path that does not match the stored series.
    offset = 1n;
    expectError(await p.t.call({ method: "GET", url: `${R}/runs/${firstRun}/paths/60` }), 409, "not_reproducible");
    offset = 0n;
    expect((await p.t.call({ method: "GET", url: `${R}/runs/${firstRun}/paths/60` })).json()).toMatchObject({ source: "resimulated", pathIndex: 7 });

    // Twenty pinned runs of the scenario, then a 21st.
    const [row] = await p.t.db.db.select().from(simRun).where(eq(simRun.id, firstRun));
    const { id: _id, jobId: _job, createdAt: _created, ...copy } = row!;
    await p.t.db.db.insert(simRun).values(Array.from({ length: 20 }, () => ({ ...copy, pinned: true })));
    expectError(await p.t.call({ method: "PATCH", url: `${R}/runs/${firstRun}`, payload: { pinned: true } }), 409, "pin_limit");
    // A note alone is fine.
    expect((await p.t.call({ method: "PATCH", url: `${R}/runs/${firstRun}`, payload: { note: "kept" } })).statusCode).toBe(200);
  });

  it("409 revert_invalid: a history entry that is not a change of the profile", async () => {
    const [row] = await p.t.db.db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entity, "scenario")).limit(1);
    const profile = parsed(ProfileResponse, await p.t.call({ method: "GET", url: `${R}/profile` }));
    expectError(await p.t.call({ method: "POST", url: `${R}/profile/revert`, payload: { auditId: row!.id, expectedRevision: profile.revision } }), 409, "revert_invalid");
    // The profile's own creation has no "before" to restore either.
    const [created] = await p.t.db.db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entity, "plan_profile")).limit(1);
    expectError(await p.t.call({ method: "POST", url: `${R}/profile/revert`, payload: { auditId: created!.id, expectedRevision: profile.revision } }), 409, "revert_invalid");
  });

  it("every refusal above left the run and the profile as they were", async () => {
    const [run] = await p.t.db.db.select().from(simRun).where(eq(simRun.id, firstRun));
    expect(run).toMatchObject({ status: "done", pinned: false, note: "kept" });
    const [profile] = await p.t.db.db.select().from(planProfile);
    expect(profile!.revision).toBe(1);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("case 37: GET /api/dashboard in each state of case 31", () => {
  let p: PlannerApp;
  beforeAll(async () => {
    p = await plannerApp();
  });
  afterAll(async () => {
    await p?.t.cleanup();
  });

  const card = async () => {
    const res = await p.t.call({ method: "GET", url: "/api/dashboard" });
    expect(res.statusCode, res.body).toBe(200);
    return parsed(DashboardView, res).retirement;
  };

  it("no profile: null; then no_run, running, ready and failed", async () => {
    expect(await card()).toBeNull();

    const base = (await putProfile(p)).defaultScenarioId!;
    expect(await card()).toEqual({ state: "no_run", scenarioId: base, scenarioName: "Base plan", active: null, run: null, issues: 0 });

    const run = parsed(RunRequestResponse, await p.t.call({ method: "POST", url: `${R}/scenarios/${base}/runs`, payload: {} })).run;
    expect(await card()).toMatchObject({ state: "running", active: { runId: run.id, status: "queued", progressBp: 0 }, run: null });

    await drainFakeRuns(p.t.db.db);
    expect(await card()).toMatchObject({
      state: "ready",
      active: null,
      run: { id: run.id, paths: 10, successPaths: 8, successBp: 8000, medianEndingRealCents: "300", p10EndingRealCents: "0", baselineAsOf: "2026-10-13", ageDays: 1, stale: { inputsChanged: false, engineChanged: false } },
    });

    // A second scenario made the default, whose only run failed.
    const profile = parsed(ProfileResponse, await p.t.call({ method: "GET", url: `${R}/profile` }));
    const other = parsed(ScenarioView, await p.t.call({ method: "POST", url: `${R}/scenarios`, payload: { name: "Second", doc: p.doc, profileRevision: profile.revision } }));
    await p.t.call({ method: "PATCH", url: `${R}/scenarios/${other.id}`, payload: { expectedRevision: other.revision, isDefault: true } });
    const failing = parsed(RunRequestResponse, await p.t.call({ method: "POST", url: `${R}/scenarios/${other.id}/runs`, payload: { refresh: false } })).run;
    await failSimRun(p.t.db.db, failing.id, "engine_error", "boom");
    expect(await card()).toMatchObject({ state: "failed", scenarioId: other.id, scenarioName: "Second", active: null, run: null, issues: 0 });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("the real planner on the fixture (app.planner from the engine, seams C13)", () => {
  let t: TestApp;
  let doc: RetirementProfileDocInput;
  beforeAll(async () => {
    t = await createTestApp({ now: () => NOW });
    doc = retirementFixtureDoc(await seedRetirementFixture(t.db.db));
    await signInOwner(t);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("the default scenario freezes an input the engine accepts: no error issue, the engine's data version, a reusable run none", async () => {
    const profile = parsed(ProfileResponse, await t.call({ method: "PUT", url: `${R}/profile`, payload: { doc, expectedRevision: 0 } }));
    expect(profile.issues.filter((i) => i.severity === "error")).toEqual([]);
    const frozen = (await t.call({ method: "GET", url: `${R}/scenarios/${profile.defaultScenarioId}/input` })).json();
    expect(frozen.issues.filter((i: { severity: string }) => i.severity === "error")).toEqual([]);
    const input = SimInput.parse(frozen.input);
    expect(input.data.version).toBe(t.app.planner.env.dataVersion);
    expect(t.app.planner.env.validateInput?.(input)).toEqual([]);
    expect(frozen).toMatchObject({ inputHash: expect.stringMatching(/^[0-9a-f]{64}$/), reusableRunId: null });
    // One path of it through the planner's simulatePath, on this thread (G11): the fixture's 47 years.
    const path = t.app.planner.simulatePath(input, 0);
    expect(path.table.rows).toHaveLength(47);
  });
});
