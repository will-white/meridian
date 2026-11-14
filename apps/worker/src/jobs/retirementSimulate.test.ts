import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getRun,
  job,
  putProfile,
  requestCancel,
  requestRun,
  requeueStaleJobs,
  simRun,
  simRunPath,
  simRunSeries,
  type AuditContext,
  type Db,
  type JobRow,
} from "@meridian/db";
import {
  createTestDb,
  FAKE_DATA_VERSION,
  FAKE_DEPLETIONS,
  FAKE_ENDINGS,
  FAKE_ENGINE_VERSION,
  fakePlannerEngine,
  fakePlannerEnv,
  fakeRunResult,
  RETIREMENT_SEED_NOW,
  RETIREMENT_SEED_TODAY,
  retirementFixtureDoc,
  seedRetirementFixture,
  TEST_DATABASE_URL,
  type TestDb,
} from "@meridian/db/testing";
import {
  EngineInputError,
  EngineInvariantError,
  SimulationCancelledError,
  SimulationWorkerError,
  type RunSimulationOptions,
  type SimOutput,
} from "@meridian/retirement/node";
import { decodeI16le, decodeI64le, type SimInput } from "@meridian/shared";
import type { WorkerConfig } from "../env.js";
import { drainQueue, sweepStaleJobs } from "../runner.js";
import type { JobContext, SimEngine } from "./context.js";
import { PROGRESS_INTERVAL_MS } from "./retirementSimulate.js";

/**
 * Inputs-and-data §7 worker case 38: the `retirement.simulate` job through the runner's
 * `drainQueue` (so through `dispatchJob`, with the queue's own completion, retry and failure) on
 * the planner fixture, with `ctx.sim` faked by the ten-path engine of §7.0. Cases 25, 27 and 28
 * from the job's side, the progress throttle, and the error mapping of seams C7. The real engine
 * runs in retirementSimulate.engine.test.ts.
 */

const TODAY = RETIREMENT_SEED_TODAY;
const env = fakePlannerEnv();
const q = { today: TODAY, now: RETIREMENT_SEED_NOW, env };
let batch = 0;
const audit = (): AuditContext => ({ userId: null, batchId: `00000000-0000-4000-8000-${String(++batch).padStart(12, "0")}` });

const config: WorkerConfig = {
  databaseUrl: "unused",
  secretsKey: "unused",
  workerId: "test-worker",
  syncIntervalHours: 6,
  pollIntervalMs: 10,
  initialWindowDays: 93,
  overlapDays: 7,
  requestTimeoutMs: 5000,
};

interface FakeSim extends SimEngine {
  /** The options of every `runSimulation` call. */
  readonly runs: RunSimulationOptions[];
  /** The paths `simulatePath` re-simulated, in order. */
  readonly paths: number[];
}

/**
 * The fake engine as the job sees it: `runSimulation` runs `during` (which may report progress,
 * wait for the abort signal, or throw), then answers the ten-path result of §3.8 without its
 * tables; `simulatePath` is the fake planner engine's (`endingOffset` makes it disagree).
 */
function fakeSim(o: { during?: (input: SimInput, opts: RunSimulationOptions) => Promise<void> | void; endingOffset?: bigint; dataVersion?: string } = {}): FakeSim {
  const engine = fakePlannerEngine(o.endingOffset === undefined ? {} : { endingOffset: o.endingOffset });
  const runs: RunSimulationOptions[] = [];
  return {
    ENGINE_VERSION: FAKE_ENGINE_VERSION,
    DATA_VERSION: o.dataVersion ?? FAKE_DATA_VERSION,
    runs,
    paths: engine.calls,
    async runSimulation(input, opts): Promise<SimOutput> {
      runs.push(opts);
      await o.during?.(input, opts);
      const r = fakeRunResult(fakePlannerEngine());
      return {
        paths: r.paths,
        successPaths: r.successPaths,
        endingRealCents: r.endingRealCents,
        depletionYear: r.depletionYear,
        lifetimeTaxRealCents: r.lifetimeTaxRealCents!,
        lifetimeSpendingRealCents: r.lifetimeSpendingRealCents!,
        summary: r.summary,
        fan: r.fan,
        warnings: [...r.warnings],
        timing: { elapsedMs: r.timing.elapsedMs, threads: opts.threads },
      };
    },
    simulatePath: (input, k) => engine.simulatePath(input, k),
  };
}

/** Resolves once `check` holds, polling the database (a progress write is in flight). */
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe.skipIf(!TEST_DATABASE_URL)("retirement.simulate with a fake engine (inputs-and-data §7 case 38)", () => {
  let t: TestDb;
  let db: Db;
  let scenarioId: string;
  let clockMs = 0;
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
  const ctxOf = (sim: SimEngine, o: Partial<JobContext> = {}): JobContext => ({
    db,
    config,
    client: {},
    now: () => new Date(RETIREMENT_SEED_NOW.getTime() + clockMs),
    log,
    sim,
    ...o,
  });

  /** A new run of the default scenario (forced, so a finished run with the same input is not reused) and its job. */
  async function queueRun(): Promise<{ runId: string; jobId: string }> {
    const r = await requestRun(db, { ...q, scenarioId, refresh: false, force: true }, audit());
    expect(r.created).toBe(true);
    const [row] = await db.select({ jobId: simRun.jobId }).from(simRun).where(eq(simRun.id, r.run.id));
    return { runId: r.run.id, jobId: row!.jobId! };
  }

  /** Drains the queue as the runner does; returns the outcomes the runner logged for the planner's jobs. */
  async function drain(ctx: JobContext): Promise<unknown[]> {
    logs.length = 0;
    await drainQueue(ctx);
    return logs.flatMap((line) => {
      const m = /^\[job\] retirement\.simulate \S+ done in \d+ms (\{.*\})$/.exec(line);
      return m ? [JSON.parse(m[1]!) as unknown] : [];
    });
  }

  const runRow = async (id: string) => (await db.select().from(simRun).where(eq(simRun.id, id)))[0]!;
  const jobRow = async (id: string): Promise<JobRow> => (await db.select().from(job).where(eq(job.id, id)))[0]!;
  const children = async (id: string) => ({
    series: (await db.select({ id: simRunSeries.runId }).from(simRunSeries).where(eq(simRunSeries.runId, id))).length,
    paths: (await db.select({ id: simRunPath.runId }).from(simRunPath).where(eq(simRunPath.runId, id))).length,
  });
  /** Makes a requeued job due now (the queue's backoff is minutes). */
  const dueNow = (jobId: string) => db.update(job).set({ runAt: sql`now()` }).where(eq(job.id, jobId));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    const seed = await seedRetirementFixture(db);
    const p = await putProfile(db, { ...q, doc: retirementFixtureDoc(seed), expectedRevision: 0 }, audit());
    scenarioId = p.defaultScenarioId!;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("case 25 through the job: running with the engine version and threads, progress 4 of 10, then done with the series and the seven stored paths", async () => {
    const { runId, jobId } = await queueRun();
    let seenRunning: Awaited<ReturnType<typeof runRow>> | undefined;
    const sim = fakeSim({
      during: async (_input, opts) => {
        seenRunning = await runRow(runId);
        opts.onProgress?.({ donePaths: 4, totalPaths: 10, elapsedMs: 5 });
        await until(async () => (await runRow(runId)).pathsDone === 4, "the progress write");
      },
    });
    const outcomes = await drain(ctxOf(sim));
    expect(outcomes).toEqual([{ runId, outcome: "done", paths: 10, successPaths: 8, elapsedMs: 1234, threads: 0 }]);
    // beginSimRun: running, stamped with the worker's engine version and its thread count (0 inline).
    expect(seenRunning).toMatchObject({ status: "running", engineVersion: FAKE_ENGINE_VERSION, threads: 0, pathsDone: 0 });
    // The engine was given the stored input, inline (no thread entry), the abort signal and the 15-minute limit.
    expect(sim.runs).toHaveLength(1);
    expect(sim.runs[0]).toMatchObject({ threads: 0, maxRunMs: 900_000 });
    expect(sim.runs[0]!.threadEntry).toBeUndefined();
    expect(sim.runs[0]!.signal).toBeInstanceOf(AbortSignal);

    const row = await runRow(runId);
    expect(row).toMatchObject({ status: "done", paths: 10, pathsDone: 10, successPaths: 8, durationMs: 1234, errorCode: null });
    const series = await db.select().from(simRunSeries).where(eq(simRunSeries.runId, runId)).orderBy(asc(simRunSeries.kind));
    const byKind = new Map(series.map((s) => [s.kind, s]));
    expect(byKind.get("ending_real_cents")!.data.byteLength).toBe(80);
    expect(byKind.get("depletion_year")!.data.byteLength).toBe(20);
    expect([...decodeI64le(byKind.get("ending_real_cents")!.data)]).toEqual(FAKE_ENDINGS);
    expect([...decodeI16le(byKind.get("depletion_year")!.data)]).toEqual(FAKE_DEPLETIONS);
    // F9's two series are stored too.
    expect(series.map((s) => s.kind).sort()).toEqual(["depletion_year", "ending_real_cents", "lifetime_spending_real_cents", "lifetime_tax_real_cents"]);
    const paths = await db.select().from(simRunPath).where(eq(simRunPath.runId, runId)).orderBy(asc(simRunPath.percentile));
    expect(paths.map((p) => p.percentile)).toEqual([5, 10, 25, 50, 75, 90, 95]);
    expect(paths.map((p) => p.pathIndex)).toEqual([2, 2, 5, 3, 6, 8, 4]);
    expect(paths.map((p) => p.rank)).toEqual([0, 0, 2, 4, 7, 8, 9]);
    expect(paths.map((p) => p.endingRealCents)).toEqual([0n, 0n, 150n, 300n, 700n, 900n, 1200n]);
    expect(paths.map((p) => p.depletionYear)).toEqual([2047, 2047, null, null, null, null, null]);
    // C8: the job re-simulated each distinct stored path once, in the order of the percentiles.
    expect(sim.paths).toEqual([2, 5, 3, 6, 8, 4]);
    expect(paths.map((p) => (p.yearTable as { pathIndex: number }).pathIndex)).toEqual([2, 2, 5, 3, 6, 8, 4]);
    expect((await getRun(db, runId, q)).successBp).toBe(8000);
    expect((await jobRow(jobId)).status).toBe("done");

    // A later identical request returns this run; a second delivery of its job finds nothing to do.
    const again = await requestRun(db, { ...q, scenarioId, refresh: false }, audit());
    expect(again).toMatchObject({ created: false, reused: true, run: { id: runId } });
    await db.update(job).set({ status: "queued", runAt: sql`now()` }).where(eq(job.id, jobId));
    expect(await drain(ctxOf(sim))).toEqual([{ runId, outcome: "skipped" }]);
    expect(sim.runs).toHaveLength(1);
    expect((await runRow(runId)).status).toBe("done");
  });

  it("case 27: a run cancelled while queued is skipped by its job, and the engine is never called", async () => {
    const { runId, jobId } = await queueRun();
    expect((await requestCancel(db, runId, q)).status).toBe("cancelled");
    const sim = fakeSim();
    expect(await drain(ctxOf(sim))).toEqual([{ runId, outcome: "skipped" }]);
    expect(sim.runs).toHaveLength(0);
    expect((await runRow(runId)).status).toBe("cancelled");
    expect((await jobRow(jobId)).status).toBe("done");
  });

  it("case 27: a running run gets cancel_requested; the next progress write aborts the engine; the run is cancelled with no series or paths", async () => {
    const { runId, jobId } = await queueRun();
    const sim = fakeSim({
      during: async (_input, opts) => {
        expect((await requestCancel(db, runId, q)).cancelRequested).toBe(true);
        expect((await runRow(runId)).status).toBe("running");
        opts.onProgress?.({ donePaths: 1, totalPaths: 10, elapsedMs: 1 });
        // The pool rejects once the signal aborts (within a chunk); so does this fake.
        await until(async () => opts.signal?.aborted === true, "the abort");
        throw new SimulationCancelledError("cancelled");
      },
    });
    expect(await drain(ctxOf(sim))).toEqual([{ runId, outcome: "cancelled" }]);
    expect(await runRow(runId)).toMatchObject({ status: "cancelled", cancelRequested: true, errorCode: null });
    expect(await children(runId)).toEqual({ series: 0, paths: 0 });
    expect(sim.paths).toEqual([]);
    expect((await jobRow(jobId)).status).toBe("done");
    await expect(requestCancel(db, runId, q)).rejects.toMatchObject({ status: 409, code: "run_not_active" });
  });

  it("case 27: a running run silent for 3 minutes is cancelled at once; the job's late result writes nothing", async () => {
    const { runId, jobId } = await queueRun();
    const sim = fakeSim({
      during: async () => {
        await db.update(simRun).set({ progressAt: sql`now() - interval '3 minutes'` }).where(eq(simRun.id, runId));
        expect((await requestCancel(db, runId, q)).status).toBe("cancelled");
      },
    });
    expect(await drain(ctxOf(sim))).toEqual([{ runId, outcome: "skipped" }]);
    expect((await runRow(runId)).status).toBe("cancelled");
    expect(await children(runId)).toEqual({ series: 0, paths: 0 });
    expect((await jobRow(jobId)).status).toBe("done");
  });

  it("the progress throttle: ten calls inside one second write once, a call after the interval writes again", async () => {
    const { runId } = await queueRun();
    const pathsDone = async () => (await runRow(runId)).pathsDone;
    const sim = fakeSim({
      during: async (_input, opts) => {
        clockMs = 0;
        opts.onProgress?.({ donePaths: 1, totalPaths: 10, elapsedMs: 1 });
        await until(async () => (await pathsDone()) === 1, "the first write");
        // Nine more calls in the same second, the first write long finished: none is written.
        for (let i = 2; i <= 10; i++) {
          clockMs = (i - 1) * 100;
          opts.onProgress?.({ donePaths: i, totalPaths: 10, elapsedMs: i });
        }
        await settle();
        expect(await pathsDone()).toBe(1);
        // A call one interval after the first write is written.
        clockMs = PROGRESS_INTERVAL_MS;
        opts.onProgress?.({ donePaths: 7, totalPaths: 10, elapsedMs: 11 });
        await until(async () => (await pathsDone()) === 7, "the second write");
        // While a write is in flight, a call is dropped even after the interval.
        clockMs = 3 * PROGRESS_INTERVAL_MS;
        opts.onProgress?.({ donePaths: 8, totalPaths: 10, elapsedMs: 12 });
        clockMs = 5 * PROGRESS_INTERVAL_MS;
        opts.onProgress?.({ donePaths: 9, totalPaths: 10, elapsedMs: 13 });
        await until(async () => (await pathsDone()) === 8, "the third write");
        await settle();
        expect(await pathsDone()).toBe(8);
      },
    });
    expect(await drain(ctxOf(sim))).toEqual([expect.objectContaining({ runId, outcome: "done" })]);
    clockMs = 0;
  });

  describe("case 28: failures", () => {
    it("EngineInputError(bad_allocation) fails the run with that code and message; the job is done", async () => {
      const { runId, jobId } = await queueRun();
      const sim = fakeSim({
        during: () => {
          throw new EngineInputError("bad_allocation", "Account K's allocation does not add up to 100%.");
        },
      });
      expect(await drain(ctxOf(sim))).toEqual([{ runId, outcome: "failed", code: "bad_allocation" }]);
      expect(await runRow(runId)).toMatchObject({ status: "failed", errorCode: "bad_allocation", errorMessage: "Account K's allocation does not add up to 100%." });
      expect(await jobRow(jobId)).toMatchObject({ status: "done", attempts: 1 });
      expect(await children(runId)).toEqual({ series: 0, paths: 0 });
    });

    it("an unknown engine error fails the run engine_error and the job after one attempt", async () => {
      const { runId, jobId } = await queueRun();
      const sim = fakeSim({
        during: () => {
          throw new TypeError("Cannot read properties of undefined (reading 'length')");
        },
      });
      expect(await drain(ctxOf(sim))).toEqual([]);
      expect(await runRow(runId)).toMatchObject({ status: "failed", errorCode: "engine_error", errorMessage: "Cannot read properties of undefined (reading 'length')" });
      const j = await jobRow(jobId);
      expect(j).toMatchObject({ status: "failed", attempts: 1 });
      expect(j.lastError).toContain("the engine failed run");
      expect(logs.some((l) => l.includes("no retry"))).toBe(true);
    });

    it("an EngineInvariantError is an engine_error naming its class and code, failed without a retry", async () => {
      const { runId, jobId } = await queueRun();
      const sim = fakeSim({
        during: () => {
          throw new EngineInvariantError("withdrawal_out_of_range", "a withdrawal above what the account holds");
        },
      });
      await drain(ctxOf(sim));
      expect(await runRow(runId)).toMatchObject({ status: "failed", errorCode: "engine_error", errorMessage: "EngineInvariantError withdrawal_out_of_range: a withdrawal above what the account holds" });
      expect(await jobRow(jobId)).toMatchObject({ status: "failed", attempts: 1 });
    });

    it("an error re-simulating a stored path is the engine's too", async () => {
      const { runId, jobId } = await queueRun();
      const sim = fakeSim();
      sim.simulatePath = () => {
        throw new RangeError("path index 2 is outside the 1 paths of this run");
      };
      await drain(ctxOf(sim));
      expect(await runRow(runId)).toMatchObject({ status: "failed", errorCode: "engine_error" });
      expect(await jobRow(jobId)).toMatchObject({ status: "failed", attempts: 1 });
    });

    it("a job with attempts 3 of 2 fails the run worker_crashed without calling the engine", async () => {
      const { runId, jobId } = await queueRun();
      // Two claims already happened (each one counted); the worker died both times.
      await db.update(job).set({ attempts: 2 }).where(eq(job.id, jobId));
      const sim = fakeSim();
      expect(await drain(ctxOf(sim))).toEqual([{ runId, outcome: "failed", code: "worker_crashed" }]);
      expect(sim.runs).toHaveLength(0);
      expect(await runRow(runId)).toMatchObject({ status: "failed", errorCode: "worker_crashed" });
      expect((await runRow(runId)).errorMessage).toMatch(/^The worker stopped during each of the 2 attempts/);
      expect(await jobRow(jobId)).toMatchObject({ status: "done", attempts: 3 });
    });

    it("a stored input that does not parse fails the run bad_input", async () => {
      const { runId, jobId } = await queueRun();
      await db.update(simRun).set({ input: { schemaVersion: 1, household: "not a household" } }).where(eq(simRun.id, runId));
      const sim = fakeSim();
      expect(await drain(ctxOf(sim))).toEqual([{ runId, outcome: "failed", code: "bad_input" }]);
      expect(sim.runs).toHaveLength(0);
      expect((await runRow(runId)).errorMessage).toMatch(/^The stored input does not parse at /);
      expect((await jobRow(jobId)).status).toBe("done");
    });

    it("a run frozen under another data version fails data_version_changed", async () => {
      const { runId, jobId } = await queueRun();
      const sim = fakeSim({ dataVersion: "2027.1.0" });
      expect(await drain(ctxOf(sim))).toEqual([{ runId, outcome: "failed", code: "data_version_changed" }]);
      expect(sim.runs).toHaveLength(0);
      expect((await runRow(runId)).errorMessage).toBe(`The run was frozen with data ${FAKE_DATA_VERSION}; this worker carries data 2027.1.0. Request the run again.`);
      expect((await jobRow(jobId)).status).toBe("done");
    });

    it("a re-simulated path that disagrees with the series fails the run not_reproducible; nothing is stored", async () => {
      const { runId, jobId } = await queueRun();
      const sim = fakeSim({ endingOffset: 1n });
      expect(await drain(ctxOf(sim))).toEqual([{ runId, outcome: "failed", code: "not_reproducible" }]);
      expect((await runRow(runId)).errorMessage).toBe("Path 2 (percentile 5) re-simulated alone ends at 1 cents with depletion year 2047; the run's series hold 0 and 2047.");
      expect(sim.paths).toEqual([2]);
      expect(await children(runId)).toEqual({ series: 0, paths: 0 });
      expect((await jobRow(jobId)).status).toBe("done");
    });

    it("a timeout fails the run timeout; RETIREMENT_RUN_MAX_MS is the engine's maxRunMs", async () => {
      const { runId, jobId } = await queueRun();
      const sim = fakeSim({
        during: () => {
          throw new SimulationCancelledError("timeout");
        },
      });
      const ctx = ctxOf(sim, { config: { ...config, retirement: { runMaxMs: 120_000 } } });
      expect(await drain(ctx)).toEqual([{ runId, outcome: "failed", code: "timeout" }]);
      expect(sim.runs[0]!.maxRunMs).toBe(120_000);
      expect(await runRow(runId)).toMatchObject({ status: "failed", errorCode: "timeout", errorMessage: "The simulation ran longer than 120 seconds (RETIREMENT_RUN_MAX_MS) and was stopped." });
      expect((await jobRow(jobId)).status).toBe("done");
    });

    it("a database error in completeSimRun on attempt 1 requeues the job with the run still running; on attempt 2 the run fails worker_error", async () => {
      const { runId, jobId } = await queueRun();
      // The database refuses the next transaction once: the one completeSimRun opens.
      let refuse = 0;
      const flaky = new Proxy(db, {
        get(target, prop) {
          if (prop === "transaction" && refuse > 0) {
            refuse--;
            return () => Promise.reject(new Error("the database connection was reset"));
          }
          const value = Reflect.get(target, prop) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
      const sim = fakeSim({
        during: () => {
          refuse = 1;
        },
      });
      expect(await drain(ctxOf(sim, { db: flaky }))).toEqual([]);
      expect(await runRow(runId)).toMatchObject({ status: "running", errorCode: null });
      expect(await jobRow(jobId)).toMatchObject({ status: "queued", attempts: 1, lastError: "the database connection was reset" });

      await dueNow(jobId);
      expect(await drain(ctxOf(sim, { db: flaky }))).toEqual([]);
      expect(sim.runs).toHaveLength(2);
      expect(await runRow(runId)).toMatchObject({ status: "failed", errorCode: "worker_error", errorMessage: "the database connection was reset" });
      expect(await jobRow(jobId)).toMatchObject({ status: "failed", attempts: 2 });
      expect(await children(runId)).toEqual({ series: 0, paths: 0 });
    });

    it("a simulation thread that dies is retried: requeued on attempt 1, worker_error on attempt 2", async () => {
      const { runId, jobId } = await queueRun();
      const sim = fakeSim({
        during: () => {
          throw new SimulationWorkerError("a simulation thread exited with code 1");
        },
      });
      await drain(ctxOf(sim));
      expect(await runRow(runId)).toMatchObject({ status: "running" });
      expect(await jobRow(jobId)).toMatchObject({ status: "queued", attempts: 1, lastError: "a simulation thread exited with code 1" });
      await dueNow(jobId);
      await drain(ctxOf(sim));
      expect(await runRow(runId)).toMatchObject({ status: "failed", errorCode: "worker_error", errorMessage: "a simulation thread exited with code 1" });
      expect(await jobRow(jobId)).toMatchObject({ status: "failed", attempts: 2 });
    });

    it("a job whose worker died on its last attempt: the stale sweep fails the job, and the run with it (worker_crashed)", async () => {
      const { runId, jobId } = await queueRun();
      // The second attempt claimed the run 31 minutes ago, and the worker stopped during it.
      await db.update(job).set({ status: "running", attempts: 2, startedAt: sql`now() - interval '31 minutes'`, lockedBy: "dead-worker" }).where(eq(job.id, jobId));
      await db.update(simRun).set({ status: "running", startedAt: sql`now() - interval '31 minutes'`, progressAt: sql`now() - interval '30 minutes'` }).where(eq(simRun.id, runId));
      logs.length = 0;
      expect(await sweepStaleJobs(ctxOf(fakeSim()))).toEqual({ requeued: 0, failed: 1, orphanedRuns: 1 });
      expect((await jobRow(jobId)).status).toBe("failed");
      expect(await runRow(runId)).toMatchObject({ status: "failed", errorCode: "worker_crashed" });
      expect(logs.some((l) => l.includes(`retirement run(s) failed: their job failed while they were active (${runId})`))).toBe(true);
      // Nothing is left for a second sweep, and a run whose job is only requeued is left alone.
      expect(await sweepStaleJobs(ctxOf(fakeSim()))).toEqual({ requeued: 0, failed: 0, orphanedRuns: 0 });
      expect(await requeueStaleJobs(db, 30)).toEqual({ requeued: 0, failed: 0 });
    });

    it("a payload without a run id fails the job permanently and touches no run", async () => {
      const [bad] = await db.insert(job).values({ type: "retirement.simulate", payload: { dedupeKey: "retirement.simulate:none" }, maxAttempts: 2 }).returning({ id: job.id });
      await drain(ctxOf(fakeSim()));
      const j = await jobRow(bad!.id);
      expect(j).toMatchObject({ status: "failed", attempts: 1 });
      expect(j.lastError).toBe(`job ${bad!.id} names no run (payload.runId)`);
    });
  });
});
