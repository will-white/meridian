import { beginSimRun, cancelSimRun, completeSimRun, errorMessageOf, failSimRun, reportSimProgress, SimRunResultError, storedPercentilePaths, type JobRow } from "@meridian/db";
import { DATA_VERSION, ENGINE_VERSION, simulatePath } from "@meridian/retirement";
import {
  EngineInputError,
  EngineInvariantError,
  EngineRuntimeError,
  runSimulation,
  SimulationCancelledError,
  SimulationWorkerError,
  type SimOutput,
  type SimProgress,
} from "@meridian/retirement/node";
import { SimInput, type YearTable } from "@meridian/shared";
import { retirementConfigOf } from "../env.js";
import type { JobContext, SimEngine } from "./context.js";

/**
 * The `retirement.simulate` job (docs/design/phase-4/inputs-and-data.md §6.3; seams C7, C8, C10).
 *
 * Queued by `requestRun` only, one job per run (payload `{ runId, dedupeKey }`, two attempts):
 *
 * 1. Crash guard: an attempt beyond the job's last one fails the run `worker_crashed`.
 * 2. Claim (`beginSimRun`): a run whose cancellation was asked is cancelled instead, and the job
 *    skips; a run left `running` by an attempt that died restarts from path 0.
 * 3. Checks: a run frozen under another data version fails `data_version_changed`, a stored input
 *    that does not parse `bad_input` (retrying cannot help either).
 * 4. Run: `runSimulation` with `RETIREMENT_THREADS` (the bundled `dist/simThread.js`, or inline),
 *    the abort signal and `maxRunMs` from `RETIREMENT_RUN_MAX_MS` (the one timer, C7). Progress is
 *    written at most once a second, one write at a time; a write that finds the cancellation asked
 *    (or the run no longer running) aborts the run.
 * 5. The seven stored percentiles (C8): each distinct path is re-simulated alone with
 *    `simulatePath`, and its ending wealth and depletion year must equal the series' values
 *    (`not_reproducible` otherwise; the engine is deterministic, so a retry cannot help).
 * 6. Finish: `completeSimRun` with the series, the summary, the fan and the year tables.
 *
 * Errors (C7): `EngineInputError` fails the run with its code, a cancellation cancels it and a
 * timeout fails it `timeout`, and the job completes; any other error an engine call throws
 * (`EngineInvariantError`, `EngineRuntimeError`, anything unexpected) fails the run
 * `engine_error` and fails the job without a retry, since the engine is a pure function of its
 * input. `SimulationWorkerError` (a thread died) and an error from anywhere else (a database
 * write) are retried by the queue with the run left `running`; on the job's last attempt the run
 * is failed `worker_error` first.
 */

/** The real engine, unless the context injects another. */
export const RETIREMENT_ENGINE: SimEngine = { ENGINE_VERSION, DATA_VERSION, runSimulation, simulatePath };

/** One progress write a second at most (§6.3 step 4). */
export const PROGRESS_INTERVAL_MS = 1000;

export type RetirementSimulateOutcome =
  | { runId: string; outcome: "done"; paths: number; successPaths: number; elapsedMs: number; threads: number }
  | { runId: string; outcome: "failed"; code: string }
  | { runId: string; outcome: "cancelled" }
  /** The run was not active (already finished, cancelled before it began, or deleted): nothing to do. */
  | { runId: string; outcome: "skipped" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An error the job raises itself; `permanent` tells the runner not to retry it. */
export class RetirementJobError extends Error {
  readonly code: string;
  readonly permanent: boolean;
  constructor(code: string, message: string, o: { permanent: boolean; cause?: unknown }) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = "RetirementJobError";
    this.code = code;
    this.permanent = o.permanent;
  }
}

function runIdOf(job: JobRow): string {
  const runId = job.payload["runId"];
  if (typeof runId !== "string" || !UUID.test(runId)) throw new RetirementJobError("bad_payload", `job ${job.id} names no run (payload.runId)`, { permanent: true });
  return runId;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPermanent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { permanent?: unknown }).permanent === true;
}

/**
 * The throttled heartbeat (§6.3 step 4): the first call writes, later ones only when the interval
 * has passed since the last write and no write is in flight. A write that answers "stop" aborts the
 * run; a write that fails is logged and the run goes on (the result's own writes decide).
 */
function progressWriter(ctx: JobContext, runId: string, controller: AbortController) {
  let lastAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;
  return {
    onProgress(p: SimProgress): void {
      const now = ctx.now().getTime();
      if (inFlight !== null || now - lastAt < PROGRESS_INTERVAL_MS) return;
      lastAt = now;
      inFlight = reportSimProgress(ctx.db, runId, p.donePaths, p.totalPaths)
        .then(
          (stop) => {
            if (stop) controller.abort();
          },
          (err: unknown) => ctx.log.warn(`[retirement] run ${runId}: progress not written: ${errorMessageOf(err)}`),
        )
        .finally(() => {
          inFlight = null;
        });
    },
    /** Waits for the write in flight, so nothing of the run is still writing when it finishes. */
    async settle(): Promise<void> {
      if (inFlight !== null) await inFlight;
    },
  };
}

/** Fail the run with `code`; "skipped" when it was no longer active (cancelled or finished meanwhile). */
async function failed(ctx: JobContext, runId: string, code: string, message: string, keep: { keep: number }): Promise<RetirementSimulateOutcome> {
  return (await failSimRun(ctx.db, runId, code, message, keep)) ? { runId, outcome: "failed", code } : { runId, outcome: "skipped" };
}

/**
 * What a failed engine call means for the run (C7): an outcome when the job completes, or an
 * error to throw (permanent for `engine_error`; as it is for `SimulationWorkerError`, which the
 * queue retries).
 */
async function engineFailure(ctx: JobContext, runId: string, err: unknown, keep: { keep: number }, runMaxMs: number): Promise<RetirementSimulateOutcome> {
  if (err instanceof EngineInputError) return failed(ctx, runId, err.code, err.message, keep);
  if (err instanceof SimulationCancelledError) {
    if (err.code === "timeout") return failed(ctx, runId, "timeout", `The simulation ran longer than ${Math.round(runMaxMs / 1000)} seconds (RETIREMENT_RUN_MAX_MS) and was stopped.`, keep);
    return (await cancelSimRun(ctx.db, runId, keep)) ? { runId, outcome: "cancelled" } : { runId, outcome: "skipped" };
  }
  if (err instanceof SimulationWorkerError) throw err;
  const kind = err instanceof EngineInvariantError || err instanceof EngineRuntimeError ? `${err.name} ${err.code}: ` : "";
  await failSimRun(ctx.db, runId, "engine_error", `${kind}${messageOf(err)}`, keep);
  throw new RetirementJobError("engine_error", `the engine failed run ${runId}: ${kind}${messageOf(err)}`, { permanent: true, cause: err });
}

/**
 * The stored percentiles' year tables (C8), one per distinct path, each checked against the run's
 * series. Returns the tables, or the first disagreement.
 */
function storedTables(sim: SimEngine, input: SimInput, output: SimOutput): { tables: YearTable[] } | { mismatch: string } {
  const tables: YearTable[] = [];
  const done = new Set<number>();
  for (const { percentile, pathIndex } of storedPercentilePaths(output.endingRealCents, output.depletionYear)) {
    if (done.has(pathIndex)) continue;
    done.add(pathIndex);
    const path = sim.simulatePath(input, pathIndex);
    const ending = output.endingRealCents[pathIndex]!;
    const depletion = output.depletionYear[pathIndex]!;
    if (path.pathIndex !== pathIndex || path.table.pathIndex !== pathIndex || path.endingRealCents !== ending || path.depletionYear !== depletion) {
      return {
        mismatch:
          `Path ${pathIndex} (percentile ${percentile}) re-simulated alone ends at ${path.endingRealCents} cents with depletion year ${path.depletionYear}; ` +
          `the run's series hold ${ending} and ${depletion}.`,
      };
    }
    tables.push(path.table);
  }
  return { tables };
}

/** Steps 2 to 6 once the crash guard has passed. */
async function simulateRun(ctx: JobContext, job: JobRow, runId: string): Promise<RetirementSimulateOutcome> {
  const sim = ctx.sim ?? RETIREMENT_ENGINE;
  const settings = retirementConfigOf(ctx.config);
  const keep = { keep: settings.keepRuns };

  const begun = await beginSimRun(ctx.db, runId, { engineVersion: sim.ENGINE_VERSION, threads: settings.threads }, keep);
  if (begun.skipped) return { runId, outcome: "skipped" };

  if (begun.dataVersion !== sim.DATA_VERSION) {
    return failed(ctx, runId, "data_version_changed", `The run was frozen with data ${begun.dataVersion}; this worker carries data ${sim.DATA_VERSION}. Request the run again.`, keep);
  }
  const parsed = SimInput.safeParse(begun.input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return failed(ctx, runId, "bad_input", `The stored input does not parse${issue ? ` at ${issue.path.join(".") || "(root)"}: ${issue.message}` : ""}.`, keep);
  }
  const input = parsed.data;

  const controller = new AbortController();
  const progress = progressWriter(ctx, runId, controller);
  let output: SimOutput;
  try {
    output = await sim.runSimulation(input, {
      threads: settings.threads,
      ...(settings.threadEntry === null ? {} : { threadEntry: settings.threadEntry }),
      signal: controller.signal,
      maxRunMs: settings.runMaxMs,
      onProgress: progress.onProgress,
    });
  } catch (err) {
    await progress.settle();
    return engineFailure(ctx, runId, err, keep, settings.runMaxMs);
  }
  await progress.settle();

  let stored: ReturnType<typeof storedTables>;
  try {
    stored = storedTables(sim, input, output);
  } catch (err) {
    return engineFailure(ctx, runId, err, keep, settings.runMaxMs);
  }
  if ("mismatch" in stored) return failed(ctx, runId, "not_reproducible", stored.mismatch, keep);

  try {
    const written = await completeSimRun(ctx.db, runId, { ...output, tables: stored.tables }, keep);
    if (!written) return { runId, outcome: "skipped" };
  } catch (err) {
    if (!(err instanceof SimRunResultError)) throw err;
    return failed(ctx, runId, err.code, err.message, keep);
  }
  ctx.log.info(
    `[retirement] run ${runId} (job ${job.id}): ${output.successPaths} of ${output.paths} paths funded, ${Math.round(output.timing.elapsedMs)} ms on ${output.timing.threads === 0 ? "the job's thread" : `${output.timing.threads} threads`}`,
  );
  return { runId, outcome: "done", paths: output.paths, successPaths: output.successPaths, elapsedMs: Math.round(output.timing.elapsedMs), threads: output.timing.threads };
}

export async function runRetirementSimulateJob(ctx: JobContext, job: JobRow): Promise<RetirementSimulateOutcome> {
  const runId = runIdOf(job);
  const keep = { keep: retirementConfigOf(ctx.config).keepRuns };

  // Step 1, the crash guard: the runner counts every claim, so an attempt beyond the last one is a
  // job whose earlier attempts stopped the worker itself.
  if (job.attempts > job.maxAttempts) {
    return failed(ctx, runId, "worker_crashed", `The worker stopped during each of the ${job.maxAttempts} attempts at this run (it was restarted, or ran out of memory).`, keep);
  }

  try {
    return await simulateRun(ctx, job, runId);
  } catch (err) {
    // A permanent error has failed the run already (engine_error). Anything else is retried by
    // the queue while the run stays running; after the last attempt nothing would end the run, so
    // it is failed here first.
    if (!isPermanent(err) && job.attempts >= job.maxAttempts) {
      try {
        await failSimRun(ctx.db, runId, "worker_error", errorMessageOf(err), keep);
      } catch (failErr) {
        ctx.log.error(`[retirement] run ${runId}: could not record the failure: ${errorMessageOf(failErr)}`);
      }
    }
    throw err;
  }
}
