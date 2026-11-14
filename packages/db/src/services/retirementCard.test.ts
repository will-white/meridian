import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DashboardView, RetirementCard, RetirementProfileDoc, type RetirementProfileDocInput } from "@meridian/shared";
import { simRun } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { drainFakeRuns, FAKE_ENGINE_VERSION, fakePlannerEnv } from "../test/retirementFakes.js";
import { RETIREMENT_SEED_NOW, RETIREMENT_SEED_TODAY, retirementFixtureDoc, seedRetirementFixture } from "../test/retirementSeed.js";
import type { AuditContext } from "./audit.js";
import { getDashboard, toDashboardView } from "./dashboard.js";
import { retirementCard } from "./retirementCard.js";
import { putProfile } from "./retirementProfile.js";
import { beginSimRun, failSimRun, reportSimProgress, requestRun } from "./retirementRuns.js";
import { createScenario, updateScenario } from "./retirementScenarios.js";

/**
 * Inputs-and-data §7 database case 31: the dashboard card (`DashboardView.retirement`, §4.9), the
 * newest finished run of the default scenario (plan deviation 8, seams G6), in each state, with
 * and without the planner environment. Also settles audit item b7-plan-ui-06's data: the
 * dashboard carries the card.
 */

const TODAY = RETIREMENT_SEED_TODAY;
const NOW = RETIREMENT_SEED_NOW;
const env = fakePlannerEnv();
const q = { today: TODAY, now: NOW, env };

let batch = 0;
const ctx = (): AuditContext => ({ userId: null, batchId: `00000000-0000-4000-8000-${String(++batch).padStart(12, "0")}` });

describe.skipIf(!TEST_DATABASE_URL)("the dashboard's retirement card (inputs case 31)", () => {
  let t: TestDb;
  let doc: RetirementProfileDocInput;
  let base: string;
  let doneRun: string;

  const card = async (o: Partial<typeof q> = {}) => {
    const c = await retirementCard(t.db, { ...q, ...o });
    if (c !== null) expect(RetirementCard.parse(c)).toEqual(c);
    return c;
  };

  beforeAll(async () => {
    t = await createTestDb();
    const seed = await seedRetirementFixture(t.db);
    doc = retirementFixtureDoc(seed);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("no profile: null, and the dashboard carries null", async () => {
    expect(await card()).toBeNull();
    const view = toDashboardView(await getDashboard(t.db, { today: TODAY, now: NOW, planner: env }));
    expect(DashboardView.parse(view).retirement).toBeNull();
  });

  it("a profile without a run: no_run, with the default scenario and no error issues", async () => {
    base = (await putProfile(t.db, { ...q, doc, expectedRevision: 0 }, ctx())).defaultScenarioId!;
    expect(await card()).toEqual({ state: "no_run", scenarioId: base, scenarioName: "Base plan", active: null, run: null, issues: 0 });
  });

  it("an active run: running, with active.progressBp 0, then its progress", async () => {
    const r = await requestRun(t.db, { ...q, scenarioId: base, refresh: false }, ctx());
    expect(await card()).toMatchObject({ state: "running", active: { runId: r.run.id, status: "queued", progressBp: 0 }, run: null });
    await beginSimRun(t.db, r.run.id, { engineVersion: FAKE_ENGINE_VERSION, threads: 0 });
    await reportSimProgress(t.db, r.run.id, 4, 10);
    expect(await card()).toMatchObject({ state: "running", active: { runId: r.run.id, status: "running", progressBp: 4000 } });
    await t.db.update(simRun).set({ status: "queued", pathsDone: 0, paths: 10000 }).where(eq(simRun.id, r.run.id));
  });

  it("after case 25's run: ready, successBp 8000, the summary's p50 and p10, stale false and false", async () => {
    doneRun = (await drainFakeRuns(t.db))[0]!.runId;
    const c = await card();
    const [row] = await t.db.select().from(simRun).where(eq(simRun.id, doneRun));
    expect(c).toEqual({
      state: "ready",
      scenarioId: base,
      scenarioName: "Base plan",
      active: null,
      run: {
        id: doneRun,
        finishedAt: row!.finishedAt!.toISOString(),
        paths: 10,
        successPaths: 8,
        successBp: 8000,
        medianEndingRealCents: "300",
        p10EndingRealCents: "0",
        baselineAsOf: "2026-10-13",
        ageDays: 1,
        stale: { inputsChanged: false, engineChanged: false },
      },
      issues: 0,
    });
    // The dashboard carries it.
    const view = toDashboardView(await getDashboard(t.db, { today: TODAY, now: NOW, planner: env }));
    expect(DashboardView.parse(view).retirement).toEqual(c);
  });

  it("without env (the Phase 2 and 3 callers): the run with stale null", async () => {
    expect(await retirementCard(t.db, { today: TODAY })).toMatchObject({ state: "ready", run: { id: doneRun, stale: null }, issues: 0 });
    const view = toDashboardView(await getDashboard(t.db, { today: TODAY, now: NOW }));
    expect(DashboardView.parse(view).retirement).toMatchObject({ run: { stale: null } });
  });

  it("with a newer engine (or data) version in the environment: engineChanged true", async () => {
    expect((await card({ env: fakePlannerEnv({ engineVersion: "fake-2.0.0" }) }))!.run!.stale).toEqual({ inputsChanged: false, engineChanged: true });
    // A data version moves the hash as well (it is inside the input).
    expect((await card({ env: fakePlannerEnv({ dataVersion: "2027.1.0" }) }))!.run!.stale).toEqual({ inputsChanged: true, engineChanged: true });
  });

  it("a failed run newer than the success: still ready with that success", async () => {
    const r = await requestRun(t.db, { ...q, scenarioId: base, refresh: false, force: true }, ctx());
    await failSimRun(t.db, r.run.id, "engine_error", "boom");
    expect(await card()).toMatchObject({ state: "ready", run: { id: doneRun }, active: null });
  });

  it("after a profile edit: inputsChanged true; a plan that no longer resolves counts its errors", async () => {
    const edited = structuredClone(RetirementProfileDoc.parse(doc));
    edited.people.p1.retirementAge = 59;
    await putProfile(t.db, { ...q, doc: edited, expectedRevision: 1 }, ctx());
    expect((await card())!.run!.stale).toEqual({ inputsChanged: true, engineChanged: false });
    edited.rothConversions["conv1"] = { personId: "p1", fromYear: 2025, toYear: 2025, annualCents: "100000", dollars: "today" };
    await putProfile(t.db, { ...q, doc: edited, expectedRevision: 2 }, ctx());
    expect(await card()).toMatchObject({ state: "ready", issues: 1, run: { stale: { inputsChanged: true, engineChanged: false } } });
    expect(await retirementCard(t.db, { today: TODAY })).toMatchObject({ issues: 1, run: { stale: null } });
    // The baseline's age follows the household's date.
    expect((await card({ today: "2026-10-24" }))!.run!.ageDays).toBe(11);
  });

  it("a default scenario whose newest run failed and none is done: failed", async () => {
    const other = await createScenario(t.db, { name: "Second" }, q, ctx());
    await updateScenario(t.db, other.id, { expectedRevision: 1, isDefault: true }, q, ctx());
    expect(await card()).toMatchObject({ state: "no_run", scenarioId: other.id, scenarioName: "Second", run: null, issues: 1 });
    await updateScenario(t.db, other.id, { expectedRevision: 2, doc: RetirementProfileDoc.parse(doc), profileRevision: 3 }, q, ctx());
    const r = await requestRun(t.db, { ...q, scenarioId: other.id, refresh: false }, ctx());
    await failSimRun(t.db, r.run.id, "engine_error", "boom");
    expect(await card()).toMatchObject({ state: "failed", scenarioId: other.id, run: null, active: null, issues: 0 });
    // A cancelled newest run is not a failure.
    const again = await requestRun(t.db, { ...q, scenarioId: other.id, refresh: false, force: true }, ctx());
    await t.db.update(simRun).set({ status: "cancelled", finishedAt: new Date() }).where(eq(simRun.id, again.run.id));
    expect((await card())!.state).toBe("no_run");
  });
});
