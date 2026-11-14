import { and, desc, eq, inArray } from "drizzle-orm";
import { dayDiff, successBp, type IsoDate, type PlannerEnv, type RetirementCard } from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { simRun } from "../schema/index.js";
import { findDefaultScenario, freezeScenario, loadProfile, progressBp, scenarioSettings } from "./retirementStore.js";

/**
 * The dashboard's retirement card (`DashboardView.retirement`, docs/design/phase-4/inputs-and-data.md
 * §4.9 and §6.2; plan deviation 8, seams G6): the newest finished run of the default scenario,
 * with its staleness. Null until a profile exists. This settles audit item b7-plan-ui-06's data
 * (the card component is the web's).
 *
 * `state`: `running` while the default scenario has an active run (the previous run's figures stay
 * in `run`); `ready` with a finished run; `failed` when its newest run failed and none is done;
 * `no_run` otherwise. `stale.inputsChanged`: the run's input hash differs from what the default
 * scenario would freeze now from the stored documents (true as well when the plan no longer
 * resolves); `stale.engineChanged`: the run's engine or data version differs from the current
 * one. Without `env` (the Phase 2 and 3 suites call `getDashboard(db, { today })`) `stale` is null
 * (not evaluated) and `issues` counts the document's own errors, the engine's facts unchecked.
 *
 * Read-only: the profile row, the default scenario, its active run, its newest done run's scalar
 * columns and summary figures, one resolve of the stored documents and one hash.
 */
export async function retirementCard(db: DbOrTx, q: { today: IsoDate; now?: Date | undefined; env?: PlannerEnv | undefined }): Promise<RetirementCard | null> {
  const profile = await loadProfile(db);
  if (profile === undefined) return null;
  // No default scenario cannot arise through the services; the dashboard then shows no card rather than failing.
  const sc = await findDefaultScenario(db);
  if (sc === undefined) return null;
  const now = q.now ?? new Date();

  const [active] = await db
    .select({ id: simRun.id, status: simRun.status, paths: simRun.paths, pathsDone: simRun.pathsDone })
    .from(simRun)
    .where(and(eq(simRun.scenarioId, sc.id), inArray(simRun.status, ["queued", "running"])))
    .limit(1);
  const [done] = await db
    .select({
      id: simRun.id,
      finishedAt: simRun.finishedAt,
      paths: simRun.paths,
      successPaths: simRun.successPaths,
      summary: simRun.summary,
      baselineAsOf: simRun.baselineAsOf,
      inputHash: simRun.inputHash,
      engineVersion: simRun.engineVersion,
      dataVersion: simRun.dataVersion,
    })
    .from(simRun)
    .where(and(eq(simRun.scenarioId, sc.id), eq(simRun.status, "done")))
    .orderBy(desc(simRun.finishedAt), desc(simRun.id))
    .limit(1);

  // Without the engine's facts, accept the scenario's own rule set and any start year: `issues`
  // then counts the document's own errors, and no hash is compared.
  const env: PlannerEnv = q.env ?? { engineVersion: "", dataVersion: "unknown", ruleSets: [scenarioSettings(sc).taxRuleSet], minStartYear: 0 };
  const frozen = await freezeScenario({ today: q.today, now, env }, profile, sc);
  const issues = frozen.issues.filter((i) => i.severity === "error").length;
  const currentHash = frozen.inputHash;

  let run: RetirementCard["run"] = null;
  if (done !== undefined && done.successPaths !== null && done.finishedAt !== null) {
    const figures = (done.summary ?? {}) as { endingWealthReal?: { p50?: unknown; p10?: unknown } };
    run = {
      id: done.id,
      finishedAt: done.finishedAt.toISOString(),
      paths: done.paths,
      successPaths: done.successPaths,
      successBp: successBp(done.successPaths, done.paths),
      medianEndingRealCents: String(figures.endingWealthReal?.p50 ?? "0"),
      p10EndingRealCents: String(figures.endingWealthReal?.p10 ?? "0"),
      baselineAsOf: done.baselineAsOf,
      ageDays: dayDiff(done.baselineAsOf, q.today),
      stale:
        q.env === undefined
          ? null
          : {
              inputsChanged: currentHash === undefined || currentHash !== done.inputHash,
              engineChanged: done.engineVersion !== q.env.engineVersion || done.dataVersion !== q.env.dataVersion,
            },
    };
  }

  let state: RetirementCard["state"];
  if (active !== undefined) state = "running";
  else if (run !== null) state = "ready";
  else {
    const [newest] = await db.select({ status: simRun.status }).from(simRun).where(eq(simRun.scenarioId, sc.id)).orderBy(desc(simRun.createdAt), desc(simRun.id)).limit(1);
    state = newest?.status === "failed" ? "failed" : "no_run";
  }

  return {
    state,
    scenarioId: sc.id,
    scenarioName: sc.name,
    active: active === undefined ? null : { runId: active.id, status: active.status as "queued" | "running", progressBp: progressBp(active.pathsDone, active.paths) },
    run,
    issues,
  };
}
