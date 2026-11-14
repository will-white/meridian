import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decodeI16le,
  decodeI64le,
  defaultRunSettings,
  inputHash,
  RetirementProfileDoc,
  RunRequestResponse,
  RunPathResponse,
  SimInput,
  SimRunDetail,
  SimRunView,
  type RetirementProfileDocInput,
} from "@meridian/shared";
import { fixtureSimInput, IDS } from "@meridian/shared/src/retirement/testFixtures.js";
import { auditLog, balanceSnapshot, job, planProfile, simRun, simRunPath, simRunSeries } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import {
  drainFakeRuns,
  FAKE_DATA_VERSION,
  FAKE_DEPLETIONS,
  FAKE_ENDINGS,
  FAKE_ENGINE_VERSION,
  FAKE_REFUSED_SEED,
  fakePlannerEngine,
  fakePlannerEnv,
  fakeRunResult,
  fakeSimSummary,
} from "../test/retirementFakes.js";
import { RETIREMENT_SEED_NOW, RETIREMENT_SEED_TODAY, retirementFixtureDoc, seedRetirementFixture, type RetirementSeed } from "../test/retirementSeed.js";
import type { AuditContext } from "./audit.js";
import { claimNextJob } from "./jobs.js";
import { putProfile } from "./retirementProfile.js";
import {
  beginSimRun,
  cancelSimRun,
  completeSimRun,
  deleteRun,
  failSimRun,
  freezeScenarioInput,
  getRun,
  getRunInput,
  getRunPath,
  listRuns,
  pruneSimRuns,
  reportSimProgress,
  requestCancel,
  requestRun,
  setRunFlags,
  SimRunResultError,
} from "./retirementRuns.js";
import { updateScenario } from "./retirementScenarios.js";

/**
 * Inputs-and-data §7 database cases 24 to 30: requesting a run (with the baseline refresh, the
 * 35-day staleness refusal, the engine's own `validateInput` issues as `409 plan_incomplete`,
 * input-hash reuse and one active run per scenario), the run lifecycle with the fake engine of
 * §7.0 (progress, completion, failure, cancellation), retention and the percentile paths. Each
 * block seeds its own database with the planner fixture and creates the profile.
 */

const TODAY = RETIREMENT_SEED_TODAY;
const NOW = RETIREMENT_SEED_NOW;
const env = fakePlannerEnv();
const q = { today: TODAY, now: NOW, env };

let batch = 0;
const ctx = (): AuditContext => ({ userId: null, batchId: `00000000-0000-4000-8000-${String(++batch).padStart(12, "0")}` });

interface Setup {
  t: TestDb;
  seed: RetirementSeed;
  doc: RetirementProfileDocInput;
  base: string;
}

async function setup(): Promise<Setup> {
  const t = await createTestDb();
  const seed = await seedRetirementFixture(t.db);
  const doc = retirementFixtureDoc(seed);
  const p = await putProfile(t.db, { ...q, doc, expectedRevision: 0 }, ctx());
  return { t, seed, doc, base: p.defaultScenarioId! };
}

async function runRow(t: TestDb, id: string) {
  const [row] = await t.db.select().from(simRun).where(eq(simRun.id, id));
  return row!;
}

async function childCounts(t: TestDb, id: string) {
  const series = await t.db.select().from(simRunSeries).where(eq(simRunSeries.runId, id));
  const paths = await t.db.select().from(simRunPath).where(eq(simRunPath.runId, id));
  return { series: series.length, paths: paths.length };
}

/** A run of the scenario through the fake engine: requested (forced), begun, completed with `keep`. */
async function finishedRun(s: Setup, keep?: number): Promise<string> {
  const r = await requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false, force: true }, ctx());
  await beginSimRun(s.t.db, r.run.id, { engineVersion: FAKE_ENGINE_VERSION, threads: 0 });
  await reportSimProgress(s.t.db, r.run.id, 10, 10);
  expect(await completeSimRun(s.t.db, r.run.id, fakeRunResult(), keep === undefined ? {} : { keep })).toBe(true);
  return r.run.id;
}

/**
 * Case 11's frozen input on the db fixture: the shared `fixtureSimInput()` with the seeded account
 * ids and names, the measured fund costs of R and T (410 and 216 ppm, step 25's measurement; the
 * shared fixture illustrates 0), and accounts and contributions re-sorted by the seeded ids (R12).
 */
function case11Input(seed: RetirementSeed): Omit<SimInput, "meta"> {
  const ids: Record<string, string> = {
    [IDS.K]: seed.accounts.K,
    [IDS.H]: seed.accounts.H,
    [IDS.T]: seed.accounts.T,
    [IDS.S]: seed.accounts.S,
    [IDS.E]: seed.accounts.E,
    [IDS.B]: seed.accounts.B,
    [IDS.R]: seed.accounts.R,
    [IDS.C]: seed.accounts.C,
  };
  const names: Record<string, string> = { [IDS.B]: "Vanguard Brokerage", [IDS.R]: "Fidelity Roth IRA" };
  const ppm: Record<string, number> = { [IDS.R]: 410, [IDS.T]: 216 };
  const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const { meta: _meta, ...input } = fixtureSimInput();
  return {
    ...input,
    accounts: input.accounts
      .map((a) => ({ ...a, id: ids[a.id] ?? a.id, name: names[a.id] ?? a.name, expenseRatioPpm: ppm[a.id] ?? a.expenseRatioPpm }))
      .sort((a, b) => byId(a.id, b.id)),
    contributions: input.contributions.map((c) => ({ ...c, accountId: ids[c.accountId]! })).sort((a, b) => byId(a.accountId, b.accountId)),
  };
}

const CASE_11_WARNINGS = [
  "allocation_assumed",
  "allocation_assumed",
  "basis_unknown",
  "contribution_from_recurring",
  "contribution_partial_window",
  "expense_ratio_unknown",
  "expense_ratio_unknown",
  "goal_before_retirement",
  "hsa_no_medical",
  "irregular_contributions",
  "uncategorized_in_spending",
].sort();

describe.skipIf(!TEST_DATABASE_URL)("requestRun (inputs case 24)", () => {
  let s: Setup;
  let first: RunRequestResponse;

  beforeAll(async () => {
    s = await setup();
  });
  afterAll(async () => {
    await s?.t.cleanup();
  });

  it("refresh false: a queued run whose input is case 11's, with the environment's data version, 10,000 paths, seed 1 and one job", async () => {
    first = await requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false }, ctx());
    expect(RunRequestResponse.parse(first)).toEqual(first);
    expect(first).toMatchObject({ created: true, reused: false, baselineChanges: [] });
    expect(first.run).toMatchObject({ status: "queued", paths: 10000, pathsDone: 0, progressBp: 0, seed: 1, dataVersion: FAKE_DATA_VERSION, engineVersion: null, current: true, stalled: false });

    const row = await runRow(s.t, first.run.id);
    const stored = SimInput.parse(row.input);
    const { meta, ...rest } = stored;
    expect(rest).toEqual(case11Input(s.seed));
    const [profile] = await s.t.db.select().from(planProfile);
    expect(meta).toMatchObject({
      createdAt: NOW.toISOString(),
      today: TODAY,
      asOf: "2026-10-13",
      profileRevision: 1,
      baselineHash: profile!.baselineHash,
      scenarioId: s.base,
      scenarioRevision: 1,
      scenarioName: "Base plan",
    });
    expect(meta.warnings.map((w) => w.code).sort()).toEqual(CASE_11_WARNINGS);
    expect(meta.provenance).toMatchObject({ [`accounts.${s.seed.accounts.T}.basis`]: "live", [`accounts.${s.seed.accounts.K}.allocation`]: "default", "spending.base": "live" });
    expect(row).toMatchObject({
      scenarioName: "Base plan",
      status: "queued",
      inputSchemaVersion: 1,
      seed: 1,
      paths: 10000,
      returnModel: "bootstrap",
      strategy: "constant_dollar",
      taxRuleSet: "current_law",
      dataVersion: FAKE_DATA_VERSION,
      baselineAsOf: "2026-10-13",
      profileRevision: 1,
      scenarioRevision: 1,
    });
    // Re-hashing the stored input gives input_hash.
    expect(await inputHash(stored)).toBe(row.inputHash);
    expect(first.run.inputHash).toBe(row.inputHash);

    const jobs = await s.t.db.select().from(job);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: "retirement.simulate", status: "queued", maxAttempts: 2, payload: { runId: row.id, dedupeKey: `retirement.simulate:${row.id}` } });
    expect(row.jobId).toBe(jobs[0]!.id);
  });

  it("the same request again returns the same run (created false, reused true), still one job", async () => {
    const again = await requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false }, ctx());
    expect(again).toMatchObject({ created: false, reused: true, run: { id: first.run.id, status: "queued" } });
    expect(await s.t.db.select().from(job)).toHaveLength(1);
    expect(await s.t.db.select().from(simRun)).toHaveLength(1);
  });

  it("a different input while the first is queued is 409 run_in_progress", async () => {
    await updateScenario(s.t.db, s.base, { expectedRevision: 1, settings: { ...defaultRunSettings(), seed: 2 } }, q, ctx());
    await expect(requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false }, ctx())).rejects.toMatchObject({ status: 409, code: "run_in_progress" });
    await updateScenario(s.t.db, s.base, { expectedRevision: 2, settings: defaultRunSettings() }, q, ctx());
    expect(await s.t.db.select().from(simRun)).toHaveLength(1);
  });

  it("refresh true with nothing new: no baseline change, no audit row, the queued run", async () => {
    const audits = (await s.t.db.select().from(auditLog)).length;
    const r = await requestRun(s.t.db, { ...q, scenarioId: s.base }, ctx());
    expect(r).toMatchObject({ created: false, reused: true, baselineChanges: [], run: { id: first.run.id } });
    expect(await s.t.db.select().from(auditLog)).toHaveLength(audits);
  });

  let second: RunRequestResponse;
  it("after K's balance moves to 15,250,000, refresh stores the baseline with one audit row and the new input holds it", async () => {
    await requestCancel(s.t.db, first.run.id, q);
    await s.t.db.insert(balanceSnapshot).values({ accountId: s.seed.accounts.K, date: "2026-10-13", balanceCents: 15250000n, source: "manual" });
    const audits = (await s.t.db.select().from(auditLog).where(eq(auditLog.entity, "plan_baseline"))).length;
    second = await requestRun(s.t.db, { ...q, scenarioId: s.base }, ctx());
    expect(second).toMatchObject({ created: true, reused: false });
    expect(second.baselineChanges.map((c) => c.kind)).toEqual(["account_value", "bucket_total", "total"]);
    expect(second.baselineChanges[0]).toMatchObject({ accountId: s.seed.accounts.K, beforeCents: "15000000", afterCents: "15250000" });
    expect(await s.t.db.select().from(auditLog).where(eq(auditLog.entity, "plan_baseline"))).toHaveLength(audits + 1);
    const input = SimInput.parse((await runRow(s.t, second.run.id)).input);
    expect(input.accounts.find((a) => a.id === s.seed.accounts.K)!.balanceCents).toBe("15250000");
    expect(input.meta.baselineHash).toBe((await s.t.db.select().from(planProfile))[0]!.baselineHash);
    expect(second.run.inputHash).not.toBe(first.run.inputHash);
  });

  it("a plan with an error is 409 plan_incomplete and writes nothing, the refreshed baseline included", async () => {
    await requestCancel(s.t.db, second.run.id, q);
    await s.t.db
      .update(balanceSnapshot)
      .set({ balanceCents: 15500000n })
      .where(and(eq(balanceSnapshot.accountId, s.seed.accounts.K), eq(balanceSnapshot.date, "2026-10-13")));
    const doc = structuredClone(RetirementProfileDoc.parse(s.doc));
    doc.rothConversions["conv1"] = { personId: "p1", fromYear: 2025, toYear: 2025, annualCents: "100000", dollars: "today" };
    await updateScenario(s.t.db, s.base, { expectedRevision: 3, doc, profileRevision: 1 }, q, ctx());
    const [profile] = await s.t.db.select().from(planProfile);
    const counts = async () => ({
      runs: (await s.t.db.select().from(simRun)).length,
      jobs: (await s.t.db.select().from(job)).length,
      audits: (await s.t.db.select().from(auditLog)).length,
    });
    const before = await counts();
    await expect(requestRun(s.t.db, { ...q, scenarioId: s.base }, ctx())).rejects.toMatchObject({ status: 409, code: "plan_incomplete" });
    expect(await counts()).toEqual(before);
    expect((await s.t.db.select().from(planProfile))[0]).toEqual(profile);
    await updateScenario(s.t.db, s.base, { expectedRevision: 4, doc: RetirementProfileDoc.parse(s.doc), profileRevision: 1 }, q, ctx());
  });

  it("the engine's own refusal (C13) is 409 plan_incomplete before anything is queued, and route 13 lists it", async () => {
    await updateScenario(s.t.db, s.base, { expectedRevision: 5, settings: { ...defaultRunSettings(), seed: FAKE_REFUSED_SEED } }, q, ctx());
    const runs = (await s.t.db.select().from(simRun)).length;
    await expect(requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false }, ctx())).rejects.toMatchObject({
      status: 409,
      code: "plan_incomplete",
      message: `The engine refuses seed ${FAKE_REFUSED_SEED}.`,
    });
    expect(await s.t.db.select().from(simRun)).toHaveLength(runs);
    const preview = await freezeScenarioInput(s.t.db, s.base, q);
    expect(preview).toMatchObject({ input: null, inputHash: null, reusableRunId: null });
    expect(preview.issues.filter((i) => i.severity === "error")).toEqual([{ code: "seed_invalid", severity: "error", path: "settings.seed", message: `The engine refuses seed ${FAKE_REFUSED_SEED}.` }]);
    await updateScenario(s.t.db, s.base, { expectedRevision: 6, settings: defaultRunSettings() }, q, ctx());
  });

  it("a stored baseline more than 35 days old is refused (refresh false); at 35 days it runs", async () => {
    // The stored baseline is as of 2026-10-13: 2026-11-18 is 36 days later, 2026-11-17 35.
    await expect(requestRun(s.t.db, { ...q, today: "2026-11-18", scenarioId: s.base, refresh: false }, ctx())).rejects.toMatchObject({
      status: 409,
      code: "plan_incomplete",
      message: expect.stringContaining("36 days ago"),
    });
    const r = await requestRun(s.t.db, { ...q, today: "2026-11-17", scenarioId: s.base, refresh: false }, ctx());
    expect(r.created).toBe(true);
    const input = SimInput.parse((await runRow(s.t, r.run.id)).input);
    expect(input.meta.warnings.map((w) => w.code)).toContain("baseline_stale");
  });

  it("route 13: the input the scenario would freeze, its hash, and the active run it would reuse", async () => {
    const preview = await freezeScenarioInput(s.t.db, s.base, { ...q, today: "2026-11-17" });
    const [active] = await s.t.db.select().from(simRun).where(inArray(simRun.status, ["queued", "running"]));
    expect(preview.inputHash).toBe(active!.inputHash);
    expect(preview.reusableRunId).toBe(active!.id);
    // The stored baseline is still the one with K at 15,250,000: the refresh to 15,500,000 was rolled
    // back with the refused request, and the later requests did not refresh.
    expect(preview.input!.accounts.find((a) => a.id === s.seed.accounts.K)!.balanceCents).toBe("15250000");
    expect(preview.effective).toMatchObject({ includedTotalCents: "22832700" });
  });

  it("a run request before a profile exists is 409 profile_missing; an unknown scenario 404", async () => {
    await expect(requestRun(s.t.db, { ...q, scenarioId: "00000000-0000-4000-8000-0000000000ff" }, ctx())).rejects.toMatchObject({ status: 404, code: "not_found" });
    const other = await createTestDb();
    try {
      await expect(requestRun(other.db, { ...q, scenarioId: s.base }, ctx())).rejects.toMatchObject({ status: 409, code: "profile_missing" });
    } finally {
      await other.cleanup();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("the run lifecycle with the fake engine (inputs case 25)", () => {
  let s: Setup;
  let runId: string;

  beforeAll(async () => {
    s = await setup();
    runId = (await requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false }, ctx())).run.id;
  });
  afterAll(async () => {
    await s?.t.cleanup();
  });

  it("beginSimRun: running, with the engine version and threads, from path 0; the stored input and data version back", async () => {
    const begun = await beginSimRun(s.t.db, runId, { engineVersion: FAKE_ENGINE_VERSION, threads: 3 });
    const row = await runRow(s.t, runId);
    expect(begun).toEqual({ skipped: false, input: row.input, dataVersion: FAKE_DATA_VERSION });
    expect(row).toMatchObject({ status: "running", engineVersion: FAKE_ENGINE_VERSION, threads: 3, pathsDone: 0 });
    expect(row.startedAt).not.toBeNull();
    expect(row.progressAt).not.toBeNull();
  });

  it("reportSimProgress(4, 10): the engine's own count, and no cancellation", async () => {
    expect(await reportSimProgress(s.t.db, runId, 4, 10)).toBe(false);
    expect(await runRow(s.t, runId)).toMatchObject({ pathsDone: 4, paths: 10 });
    expect((await getRun(s.t.db, runId, q)).progressBp).toBe(4000);
  });

  it("completeSimRun refuses a result it cannot store, writing nothing", async () => {
    const good = fakeRunResult();
    const bad = [
      { ...good, tables: good.tables.filter((t) => t.pathIndex !== 4) },
      { ...good, endingRealCents: good.endingRealCents.slice(0, 9) },
      { ...good, summary: { ...good.summary, successPaths: 7 } },
      { ...good, successPaths: 11 },
    ];
    for (const result of bad) {
      await expect(completeSimRun(s.t.db, runId, result)).rejects.toBeInstanceOf(SimRunResultError);
    }
    expect(await runRow(s.t, runId)).toMatchObject({ status: "running", successPaths: null });
    expect(await childCounts(s.t, runId)).toEqual({ series: 0, paths: 0 });
  });

  it("completeSimRun: done with 10 paths and 8 successes, the four series and the seven stored paths of §3.8", async () => {
    const engine = fakePlannerEngine();
    expect(await completeSimRun(s.t.db, runId, fakeRunResult(engine))).toBe(true);
    // The distinct paths of the seven percentiles: 2, 5, 3, 6, 8, 4.
    expect(engine.calls).toEqual([2, 5, 3, 6, 8, 4]);
    const row = await runRow(s.t, runId);
    expect(row).toMatchObject({ status: "done", paths: 10, pathsDone: 10, successPaths: 8, durationMs: 1234, engineVersion: FAKE_ENGINE_VERSION });
    expect(row.summary).toEqual(fakeSimSummary());
    expect(row.warnings).toEqual([{ code: "historical_wrapped", message: "An illustrative warning." }]);
    expect(row.finishedAt).not.toBeNull();

    const series = await s.t.db.select().from(simRunSeries).where(eq(simRunSeries.runId, runId)).orderBy(simRunSeries.kind);
    expect(series.map((x) => [x.kind, x.encoding, x.count, x.data.byteLength])).toEqual([
      ["depletion_year", "i16le", 10, 20],
      ["ending_real_cents", "i64le", 10, 80],
      ["lifetime_spending_real_cents", "i64le", 10, 80],
      ["lifetime_tax_real_cents", "i64le", 10, 80],
    ]);
    expect([...decodeI64le(series.find((x) => x.kind === "ending_real_cents")!.data)]).toEqual(FAKE_ENDINGS);
    expect([...decodeI16le(series.find((x) => x.kind === "depletion_year")!.data)]).toEqual(FAKE_DEPLETIONS);
    expect([...decodeI64le(series.find((x) => x.kind === "lifetime_tax_real_cents")!.data)]).toEqual(FAKE_ENDINGS.map((e) => e / 10n));

    const paths = await s.t.db.select().from(simRunPath).where(eq(simRunPath.runId, runId)).orderBy(simRunPath.percentile);
    expect(paths.map((p) => p.percentile)).toEqual([5, 10, 25, 50, 75, 90, 95]);
    expect(paths.map((p) => p.pathIndex)).toEqual([2, 2, 5, 3, 6, 8, 4]);
    expect(paths.map((p) => p.rank)).toEqual([0, 0, 2, 4, 7, 8, 9]);
    expect(paths.map((p) => p.endingRealCents)).toEqual([0n, 0n, 150n, 300n, 700n, 900n, 1200n]);
    expect(paths.map((p) => p.depletionYear)).toEqual([2047, 2047, null, null, null, null, null]);
    expect(paths.map((p) => (p.yearTable as { pathIndex: number }).pathIndex)).toEqual([2, 2, 5, 3, 6, 8, 4]);
  });

  it("the view: successBp truncDiv(8 × 10000, 10) = 8000, the summary's p50 and p10, the stored percentiles", async () => {
    const d = await getRun(s.t.db, runId, q);
    expect(SimRunDetail.parse(d)).toEqual(d);
    expect(d).toMatchObject({
      status: "done",
      paths: 10,
      pathsDone: 10,
      progressBp: 10000,
      successPaths: 8,
      successBp: 8000,
      medianEndingRealCents: "300",
      p10EndingRealCents: "0",
      threads: 3,
      durationMs: 1234,
      current: true,
      stalled: false,
      storedPercentiles: [5, 10, 25, 50, 75, 90, 95],
    });
    expect(d.summary).toEqual(fakeSimSummary());
    expect(d.fan).not.toBeNull();
    expect(d.warnings).toEqual([{ code: "historical_wrapped", message: "An illustrative warning." }]);
  });

  it("a second delivery finds no active run: beginSimRun skips and a late completion writes nothing", async () => {
    const before = await runRow(s.t, runId);
    expect(await beginSimRun(s.t.db, runId, { engineVersion: FAKE_ENGINE_VERSION, threads: 1 })).toEqual({ skipped: true });
    expect(await completeSimRun(s.t.db, runId, fakeRunResult())).toBe(false);
    expect(await reportSimProgress(s.t.db, runId, 1, 10)).toBe(true);
    expect(await runRow(s.t, runId)).toEqual(before);
  });

  let forced: string;
  it("a later identical request returns this run; with force it creates a new one", async () => {
    const again = await requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false }, ctx());
    expect(again).toMatchObject({ created: false, reused: true, run: { id: runId, status: "done", current: true } });
    const f = await requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false, force: true }, ctx());
    expect(f).toMatchObject({ created: true, reused: false, run: { status: "queued" } });
    forced = f.run.id;
    expect(forced).not.toBe(runId);
  });

  it("a run finished under another engine version is not reused", async () => {
    await cancelSimRun(s.t.db, forced);
    const other = fakePlannerEnv({ engineVersion: "fake-2.0.0" });
    const r = await requestRun(s.t.db, { ...q, env: other, scenarioId: s.base, refresh: false }, ctx());
    expect(r).toMatchObject({ created: true, reused: false });
    expect((await getRun(s.t.db, runId, { ...q, env: other })).current).toBe(false);
    await cancelSimRun(s.t.db, r.run.id);
  });

  it("after a profile edit that changes the input, the old run reports current false", async () => {
    const doc = structuredClone(RetirementProfileDoc.parse(s.doc));
    doc.people.p1.retirementAge = 59;
    await putProfile(s.t.db, { ...q, doc, expectedRevision: 1 }, ctx());
    expect((await getRun(s.t.db, runId, q)).current).toBe(false);
    const list = await listRuns(s.t.db, { ...q, scenarioId: s.base });
    for (const item of list.items) expect(SimRunView.parse(item)).toEqual(item);
    expect(list.items.find((r) => r.id === runId)!.current).toBe(false);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("runs after a cancellation and cancelling (inputs cases 26 and 27)", () => {
  let s: Setup;

  beforeAll(async () => {
    s = await setup();
  });
  afterAll(async () => {
    await s?.t.cleanup();
  });

  it("case 26: a cancelled queued run and a new request at once: a new run with its own job; draining skips the first and completes the second", async () => {
    const r1 = await requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false }, ctx());
    const cancelled = await requestCancel(s.t.db, r1.run.id, q);
    expect(cancelled).toMatchObject({ id: r1.run.id, status: "cancelled" });
    expect(cancelled.finishedAt).not.toBeNull();
    const r2 = await requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false }, ctx());
    expect(r2).toMatchObject({ created: true, reused: false });
    expect(r2.run.id).not.toBe(r1.run.id);
    const rows = await s.t.db.select().from(simRun).where(inArray(simRun.id, [r1.run.id, r2.run.id]));
    const jobIds = rows.map((r) => r.jobId);
    expect(new Set(jobIds).size).toBe(2);
    expect(await drainFakeRuns(s.t.db)).toEqual([
      { runId: r1.run.id, outcome: "skipped" },
      { runId: r2.run.id, outcome: "done" },
    ]);
    expect(await runRow(s.t, r1.run.id)).toMatchObject({ status: "cancelled" });
    expect(await childCounts(s.t, r1.run.id)).toEqual({ series: 0, paths: 0 });
    expect(await runRow(s.t, r2.run.id)).toMatchObject({ status: "done", successPaths: 8 });
  });

  it("case 26: the same after cancelling a stalled run whose job row is still running", async () => {
    const r3 = await requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false, force: true }, ctx());
    const claimed = await claimNextJob(s.t.db, "dead-worker");
    expect(claimed!.payload["runId"]).toBe(r3.run.id);
    await beginSimRun(s.t.db, r3.run.id, { engineVersion: FAKE_ENGINE_VERSION, threads: 2 });
    await s.t.db.update(simRun).set({ progressAt: sql`now() - interval '3 minutes'` }).where(eq(simRun.id, r3.run.id));
    expect((await getRun(s.t.db, r3.run.id, q)).stalled).toBe(true);
    // The worker is gone: cancelled at once.
    expect(await requestCancel(s.t.db, r3.run.id, q)).toMatchObject({ status: "cancelled", stalled: false });
    expect((await s.t.db.select().from(job).where(eq(job.id, claimed!.id)))[0]!.status).toBe("running");
    const r4 = await requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false, force: true }, ctx());
    expect(r4.created).toBe(true);
    expect(await drainFakeRuns(s.t.db)).toEqual([{ runId: r4.run.id, outcome: "done" }]);
    // A late report from the dead worker stops it, and its late result writes nothing.
    expect(await reportSimProgress(s.t.db, r3.run.id, 5, 10)).toBe(true);
    expect(await completeSimRun(s.t.db, r3.run.id, fakeRunResult())).toBe(false);
    expect(await runRow(s.t, r3.run.id)).toMatchObject({ status: "cancelled" });
  });

  it("case 27: a queued run is cancelled at once and its job skips", async () => {
    const r = await requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false, force: true }, ctx());
    expect(await requestCancel(s.t.db, r.run.id, q)).toMatchObject({ status: "cancelled", cancelRequested: false });
    expect(await drainFakeRuns(s.t.db)).toEqual([{ runId: r.run.id, outcome: "skipped" }]);
  });

  it("case 27: a running run gets cancel_requested; the next report says stop; cancelSimRun; no series or paths; a late completion writes nothing", async () => {
    const r = await requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false, force: true }, ctx());
    await beginSimRun(s.t.db, r.run.id, { engineVersion: FAKE_ENGINE_VERSION, threads: 1 });
    expect(await reportSimProgress(s.t.db, r.run.id, 3, 10)).toBe(false);
    expect(await requestCancel(s.t.db, r.run.id, q)).toMatchObject({ status: "running", cancelRequested: true });
    expect(await reportSimProgress(s.t.db, r.run.id, 6, 10)).toBe(true);
    expect(await cancelSimRun(s.t.db, r.run.id)).toBe(true);
    expect(await runRow(s.t, r.run.id)).toMatchObject({ status: "cancelled", pathsDone: 6 });
    expect(await childCounts(s.t, r.run.id)).toEqual({ series: 0, paths: 0 });
    expect(await completeSimRun(s.t.db, r.run.id, fakeRunResult())).toBe(false);
    expect(await childCounts(s.t, r.run.id)).toEqual({ series: 0, paths: 0 });
    expect(await cancelSimRun(s.t.db, r.run.id)).toBe(false);
  });

  it("case 27: a queued run whose cancellation was asked before the claim is cancelled by the claim", async () => {
    const r = await requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false, force: true }, ctx());
    await s.t.db.update(simRun).set({ cancelRequested: true }).where(eq(simRun.id, r.run.id));
    expect(await beginSimRun(s.t.db, r.run.id, { engineVersion: FAKE_ENGINE_VERSION, threads: 0 })).toEqual({ skipped: true });
    expect(await runRow(s.t, r.run.id)).toMatchObject({ status: "cancelled" });
  });

  it("case 27: a finished run is 409 run_not_active; an unknown run 404", async () => {
    const [done] = await s.t.db.select().from(simRun).where(eq(simRun.status, "done")).limit(1);
    await expect(requestCancel(s.t.db, done!.id, q)).rejects.toMatchObject({ status: 409, code: "run_not_active" });
    await expect(requestCancel(s.t.db, "00000000-0000-4000-8000-0000000000ff", q)).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("failure, retention, pins and deletion (inputs cases 28 and 29)", () => {
  let s: Setup;

  beforeAll(async () => {
    s = await setup();
  });
  afterAll(async () => {
    await s?.t.cleanup();
  });

  it("case 28: an engine error code fails the run with a sanitized message; nothing more happens to it", async () => {
    const r = await requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false }, ctx());
    await beginSimRun(s.t.db, r.run.id, { engineVersion: FAKE_ENGINE_VERSION, threads: 0 });
    expect(await failSimRun(s.t.db, r.run.id, "bad_allocation", "The <b>allocation</b>\u0007 is not valid‮")).toBe(true);
    const row = await runRow(s.t, r.run.id);
    expect(row).toMatchObject({ status: "failed", errorCode: "bad_allocation", errorMessage: "The allocation is not valid" });
    expect(row.finishedAt).not.toBeNull();
    expect(row.durationMs).not.toBeNull();
    expect(await childCounts(s.t, r.run.id)).toEqual({ series: 0, paths: 0 });
    expect(await failSimRun(s.t.db, r.run.id, "engine_error", "again")).toBe(false);
    expect(await beginSimRun(s.t.db, r.run.id, { engineVersion: FAKE_ENGINE_VERSION, threads: 0 })).toEqual({ skipped: true });
    expect(await runRow(s.t, r.run.id)).toMatchObject({ status: "failed", errorCode: "bad_allocation" });
    expect(await getRun(s.t.db, r.run.id, q)).toMatchObject({ status: "failed", errorCode: "bad_allocation", errorMessage: "The allocation is not valid", successBp: null, summary: null });
  });

  it("case 28: a queued run fails without being begun (worker_crashed), and a message is cut to 500 characters", async () => {
    const r = await requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false, force: true }, ctx());
    expect(await failSimRun(s.t.db, r.run.id, "worker_crashed", "x".repeat(2000))).toBe(true);
    const row = await runRow(s.t, r.run.id);
    expect(row).toMatchObject({ status: "failed", errorCode: "worker_crashed", durationMs: null });
    expect(row.errorMessage).toHaveLength(500);
  });

  it("case 29: retention with keep 2: r2 and its children are deleted, r1 (pinned), r3 and r4 remain", async () => {
    const r1 = await finishedRun(s, 2);
    await setRunFlags(s.t.db, r1, { pinned: true }, q, ctx());
    const r2 = await finishedRun(s, 2);
    const r3 = await finishedRun(s, 2);
    expect(await childCounts(s.t, r2)).toEqual({ series: 4, paths: 7 });
    const r4 = await finishedRun(s, 2);
    const done = await s.t.db.select({ id: simRun.id }).from(simRun).where(eq(simRun.status, "done"));
    expect(new Set(done.map((d) => d.id))).toEqual(new Set([r1, r3, r4]));
    expect(await childCounts(s.t, r2)).toEqual({ series: 0, paths: 0 });
  });

  it("case 29: of seven failed runs the two oldest are deleted (five failed or cancelled kept)", async () => {
    // The two failed runs of case 28 count: clear them first so the seven are f1..f7.
    await s.t.db.delete(simRun).where(eq(simRun.status, "failed"));
    const failed: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false, force: true }, ctx());
      expect(await failSimRun(s.t.db, r.run.id, "engine_error", `f${i + 1}`)).toBe(true);
      failed.push(r.run.id);
    }
    const left = await s.t.db.select({ id: simRun.id }).from(simRun).where(eq(simRun.status, "failed"));
    expect(new Set(left.map((r) => r.id))).toEqual(new Set(failed.slice(2)));
  });

  it("case 29: a 21st pin in one scenario is 409 pin_limit; notes are audited", async () => {
    const [template] = await s.t.db.select().from(simRun).where(eq(simRun.status, "done")).limit(1);
    const { id: _id, jobId: _job, createdAt: _c, ...copy } = template!;
    // r1 is pinned; nineteen more pinned (cancelled) runs make twenty.
    await s.t.db.insert(simRun).values(Array.from({ length: 19 }, () => ({ ...copy, status: "cancelled" as const, pinned: true, summary: null, fan: null, successPaths: null })));
    const unpinned = await s.t.db
      .select({ id: simRun.id })
      .from(simRun)
      .where(and(eq(simRun.status, "done"), eq(simRun.pinned, false)))
      .limit(1);
    const target = unpinned[0]!.id;
    await expect(setRunFlags(s.t.db, target, { pinned: true }, q, ctx())).rejects.toMatchObject({ status: 409, code: "pin_limit" });
    const audit = ctx();
    const v = await setRunFlags(s.t.db, target, { note: "  Before the raise  " }, q, audit);
    expect(v).toMatchObject({ note: "Before the raise", pinned: false });
    const [row] = await s.t.db.select().from(auditLog).where(eq(auditLog.batchId, audit.batchId));
    expect(row).toMatchObject({ entity: "sim_run", entityId: target, action: "update", before: { pinned: false, note: null }, after: { pinned: false, note: "Before the raise" } });
    // Clearing the note; then nothing changed writes nothing.
    expect(await setRunFlags(s.t.db, target, { note: "" }, q, ctx())).toMatchObject({ note: null });
    const audits = (await s.t.db.select().from(auditLog)).length;
    await setRunFlags(s.t.db, target, { note: null }, q, ctx());
    expect(await s.t.db.select().from(auditLog)).toHaveLength(audits);
  });

  it("pruneSimRuns keeps pinned runs whatever keep is", async () => {
    const removed = await pruneSimRuns(s.t.db, s.base, 0);
    expect(removed.length).toBeGreaterThan(0);
    const done = await s.t.db.select({ pinned: simRun.pinned }).from(simRun).where(eq(simRun.status, "done"));
    expect(done.every((d) => d.pinned)).toBe(true);
  });

  it("deleteRun: an active run is 409 run_active; a finished one is deleted with its children and audited", async () => {
    const active = await requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false, force: true }, ctx());
    await expect(deleteRun(s.t.db, active.run.id, ctx())).rejects.toMatchObject({ status: 409, code: "run_active" });
    await cancelSimRun(s.t.db, active.run.id);
    const [pinned] = await s.t.db.select({ id: simRun.id }).from(simRun).where(eq(simRun.status, "done")).limit(1);
    const audit = ctx();
    await deleteRun(s.t.db, pinned!.id, audit);
    expect(await s.t.db.select().from(simRun).where(eq(simRun.id, pinned!.id))).toEqual([]);
    expect(await childCounts(s.t, pinned!.id)).toEqual({ series: 0, paths: 0 });
    const [row] = await s.t.db.select().from(auditLog).where(eq(auditLog.batchId, audit.batchId));
    expect(row).toMatchObject({ entity: "sim_run", entityId: pinned!.id, action: "delete", after: null, before: { status: "done", pinned: true } });
    await expect(deleteRun(s.t.db, pinned!.id, ctx())).rejects.toMatchObject({ status: 404 });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("percentile paths and the run list (inputs case 30)", () => {
  let s: Setup;
  let runId: string;

  beforeAll(async () => {
    s = await setup();
    await requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false }, ctx());
    runId = (await drainFakeRuns(s.t.db))[0]!.runId;
  });
  afterAll(async () => {
    await s?.t.cleanup();
  });

  it("percentile 50 is stored (path 3); percentile 60 is path 7, re-simulated by the engine", async () => {
    const engine = fakePlannerEngine();
    const p50 = await getRunPath(s.t.db, runId, 50, { env, engine });
    expect(RunPathResponse.parse(p50)).toEqual(p50);
    expect(p50).toMatchObject({ percentile: 50, pathIndex: 3, rank: 4, source: "stored", endingRealCents: "300", depletionYear: null });
    expect(p50.table.pathIndex).toBe(3);
    expect(await getRunPath(s.t.db, runId, 5, { env, engine })).toMatchObject({ pathIndex: 2, rank: 0, source: "stored", endingRealCents: "0", depletionYear: 2047 });
    expect(engine.calls).toEqual([]);
    // Percentile 60: rank ceilDiv(600, 100) − 1 = 5 → path 7 (ending 400).
    const p60 = await getRunPath(s.t.db, runId, 60, { env, engine });
    expect(RunPathResponse.parse(p60)).toEqual(p60);
    expect(p60).toMatchObject({ percentile: 60, pathIndex: 7, rank: 5, source: "resimulated", endingRealCents: "400", depletionYear: null });
    expect(engine.calls).toEqual([7]);
    // Percentile 1: rank 0 → path 2, a failed path (2047); 99: rank 9 → path 4.
    expect(await getRunPath(s.t.db, runId, 1, { env, engine })).toMatchObject({ pathIndex: 2, source: "resimulated", depletionYear: 2047 });
    expect(await getRunPath(s.t.db, runId, 99, { env, engine })).toMatchObject({ pathIndex: 4, source: "resimulated", endingRealCents: "1200" });
  });

  it("after the engine moved: 409 engine_changed for 60, still the stored table for 50", async () => {
    const engine = fakePlannerEngine();
    const moved = fakePlannerEnv({ engineVersion: "fake-2.0.0" });
    await expect(getRunPath(s.t.db, runId, 60, { env: moved, engine })).rejects.toMatchObject({ status: 409, code: "engine_changed" });
    await expect(getRunPath(s.t.db, runId, 60, { env: fakePlannerEnv({ dataVersion: "2027.1.0" }), engine })).rejects.toMatchObject({ status: 409, code: "engine_changed" });
    expect(await getRunPath(s.t.db, runId, 50, { env: moved, engine })).toMatchObject({ source: "stored", pathIndex: 3 });
    expect(engine.calls).toEqual([]);
  });

  it("a re-simulated path that disagrees with the series is 409 not_reproducible", async () => {
    await expect(getRunPath(s.t.db, runId, 60, { env, engine: fakePlannerEngine({ endingOffset: 1n }) })).rejects.toMatchObject({ status: 409, code: "not_reproducible" });
  });

  it("an unfinished run is 409 run_not_done; a percentile outside 1..99 is 400; an unknown run 404", async () => {
    const queued = await requestRun(s.t.db, { ...q, scenarioId: s.base, refresh: false, force: true }, ctx());
    const engine = fakePlannerEngine();
    await expect(getRunPath(s.t.db, queued.run.id, 50, { env, engine })).rejects.toMatchObject({ status: 409, code: "run_not_done" });
    await expect(getRunPath(s.t.db, runId, 0, { env, engine })).rejects.toMatchObject({ status: 400 });
    await expect(getRunPath(s.t.db, runId, 100, { env, engine })).rejects.toMatchObject({ status: 400 });
    await expect(getRunPath(s.t.db, "00000000-0000-4000-8000-0000000000ff", 50, { env, engine })).rejects.toMatchObject({ status: 404 });
  });

  it("route 17: the stored input, and route 15: newest first, a page at a time", async () => {
    expect(await getRunInput(s.t.db, runId)).toEqual(SimInput.parse((await runRow(s.t, runId)).input));
    const all = await listRuns(s.t.db, q);
    expect(all.items.map((r) => r.status)).toEqual(["queued", "done"]);
    expect(all.nextCursor).toBeNull();
    const page1 = await listRuns(s.t.db, { ...q, limit: 1 });
    expect(page1.items.map((r) => r.status)).toEqual(["queued"]);
    const page2 = await listRuns(s.t.db, { ...q, limit: 1, cursor: page1.nextCursor! });
    expect(page2).toMatchObject({ items: [{ id: runId, status: "done", current: true }], nextCursor: null });
    expect((await listRuns(s.t.db, { ...q, scenarioId: "00000000-0000-4000-8000-0000000000ff" })).items).toEqual([]);
    await expect(listRuns(s.t.db, { ...q, cursor: "nonsense" })).rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
  });
});
