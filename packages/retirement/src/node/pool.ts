/**
 * The worker-thread pool and `runSimulation` (engine-and-returns §3.13; seams §2.4, C7, C8, C10,
 * C41).
 *
 * `createSimPool({ threads, threadEntry })` returns a pool whose threads live until `close()`;
 * `pool.run(input, opts)` runs one simulation; `runSimulation(input, opts)` is create, run, close.
 * A Phase 5 grid reuses one pool for all its runs inside one job (F6).
 *
 * A run: `prepare(input)` on the calling thread (an `EngineInputError` stops here, before any
 * thread starts); chunks of `CHUNK_PATHS` paths; with `threads = 0` the chunks run inline on the
 * calling thread, yielding to the event loop between chunks; otherwise each thread prepares the
 * same run and asks for its next chunk when it reports one done, and the main thread copies every
 * chunk into the run summary at its `pathStart` offset. When all are in: `aggregate`, then the
 * stored summary and fan. No year table is produced here (C8): the job re-simulates its stored
 * percentiles with `simulatePath`.
 *
 * Every path depends only on `(input, pathIndex)` and every reduction walks the paths in path order,
 * so the output is the same for any thread count and any chunk size (L5).
 *
 * Stopping: when `signal` aborts or `maxRunMs` passes, every thread is terminated and the run
 * rejects with `SimulationCancelledError` (`cancelled` or `timeout`); the next run starts fresh
 * threads. An engine error inside a thread keeps its class (permanent); a thread that dies or
 * breaks the protocol rejects with `SimulationWorkerError` (retryable). A failed run also
 * terminates every thread, so nothing of it is left running.
 */

import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { SimInput } from "@meridian/shared";
import { type ChunkSummary, addChunk, aggregate, createRunSummary } from "../aggregate.js";
import { type SimOutput, ensureSelfTest, toSimOutput } from "../facade.js";
import { type PreparedRun, prepare } from "../prepare.js";
import { createProductionState, simulateChunk } from "../simulate.js";
import { DATA_VERSION, ENGINE_VERSION } from "../version.js";
import { SimulationCancelledError, SimulationWorkerError } from "./errors.js";
import { type ChunkMessage, type InitMessage, type ThreadMessage, rebuildError } from "./protocol.js";

/** Paths per chunk (engine-and-returns §3.13 item 2): 10,000 paths are 40 chunks. */
export const CHUNK_PATHS = 250;

/** The most threads a pool starts (`RETIREMENT_THREADS` accepts 1 to 64, inputs-and-data §3.10). */
export const MAX_THREADS = 64;

/** A run's time limit when the caller gives none (engine-and-returns §3.13 item 8); the job passes `RETIREMENT_RUN_MAX_MS`. */
export const DEFAULT_MAX_RUN_MS = 600_000;

const MAX_TIMER_MS = 2_147_483_647;

/** The package's own thread entry (development and its tests, C10); production passes the worker app's bundled `simThread.js`. */
export const DEV_THREAD_ENTRY = new URL("./thread.boot.mjs", import.meta.url);

/** `max(1, min(8, parallelism − 1))` (engine-and-returns §3.13 item 3; `RETIREMENT_THREADS=auto`). */
export function defaultThreads(parallelism: number = availableParallelism()): number {
  return Math.max(1, Math.min(8, parallelism - 1));
}

export interface SimProgress {
  readonly donePaths: number;
  readonly totalPaths: number;
  readonly elapsedMs: number;
}

export interface PoolOptions {
  /** 0 = inline on the calling thread; default `defaultThreads()`; at most `MAX_THREADS`, and a run never uses more threads than it has chunks. */
  readonly threads?: number;
  /** The thread entry file; default `DEV_THREAD_ENTRY`. */
  readonly threadEntry?: URL;
}

export interface RunOptions {
  readonly signal?: AbortSignal;
  /** Default `DEFAULT_MAX_RUN_MS`. */
  readonly maxRunMs?: number;
  /** Called after every chunk, in the order the chunks finish. */
  readonly onProgress?: (p: SimProgress) => void;
  /** Paths per chunk, default `CHUNK_PATHS`. The output does not depend on it (L5). */
  readonly chunkPaths?: number;
}

export interface RunSimulationOptions extends RunOptions {
  readonly threads: number;
  readonly threadEntry?: URL;
}

export interface SimPool {
  /** The pool's thread count (0 = inline). */
  readonly threads: number;
  /** Threads currently running (they are started by the first run and after a failed one). */
  readonly liveWorkers: number;
  run(input: SimInput, opts?: RunOptions): Promise<SimOutput>;
  /** Terminates every thread; a run still going rejects with `SimulationCancelledError("cancelled")`. */
  close(): Promise<void>;
}

interface Handler {
  onMessage(m: ThreadMessage): void;
  onFailure(e: Error): void;
}

interface Slot {
  readonly worker: Worker;
  handler: Handler | null;
  exited: boolean;
}

function checkThreads(threads: number): number {
  if (!Number.isSafeInteger(threads) || threads < 0) throw new RangeError(`threads must be a whole number 0 or more, got ${threads}`);
  return threads > MAX_THREADS ? MAX_THREADS : threads;
}

function checkRunOptions(opts: RunOptions): { maxRunMs: number; chunkPaths: number } {
  const maxRunMs = opts.maxRunMs ?? DEFAULT_MAX_RUN_MS;
  const chunkPaths = opts.chunkPaths ?? CHUNK_PATHS;
  // A timer longer than 2^31 − 1 ms would fire at once.
  if (!(maxRunMs > 0) || !(maxRunMs <= MAX_TIMER_MS)) throw new RangeError(`maxRunMs must be 1 to ${MAX_TIMER_MS} milliseconds, got ${maxRunMs}`);
  if (!Number.isSafeInteger(chunkPaths) || chunkPaths < 1) throw new RangeError(`chunkPaths must be a whole number 1 or more, got ${chunkPaths}`);
  return { maxRunMs, chunkPaths };
}

/** The chunks of a run of `paths` paths: `[pathStart, pathCount]` pairs in path order. */
export function chunkRanges(paths: number, chunkPaths: number): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (let start = 0; start < paths; start += chunkPaths) out.push([start, Math.min(chunkPaths, paths - start)]);
  return out;
}

const POOL_CLOSED = "the simulation pool was closed during the run";

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

function cancelled(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** All chunks inline on the calling thread, yielding between chunks so timers, aborts and progress writes run. */
async function runInline(
  run: PreparedRun,
  opts: RunOptions,
  maxRunMs: number,
  chunkPaths: number,
  t0: number,
  isClosed: () => boolean,
): Promise<SimOutput> {
  ensureSelfTest();
  const ps = createProductionState(run);
  const summary = createRunSummary(run);
  let done = 0;
  for (const [start, count] of chunkRanges(run.paths, chunkPaths)) {
    if (isClosed()) throw new SimulationCancelledError("cancelled", POOL_CLOSED);
    if (cancelled(opts.signal)) throw new SimulationCancelledError("cancelled");
    if (performance.now() - t0 > maxRunMs) throw new SimulationCancelledError("timeout");
    addChunk(summary, simulateChunk(run, start, count, ps));
    done += count;
    opts.onProgress?.({ donePaths: done, totalPaths: run.paths, elapsedMs: performance.now() - t0 });
    await yieldToEventLoop();
  }
  if (cancelled(opts.signal)) throw new SimulationCancelledError("cancelled");
  const result = aggregate(run, summary);
  return toSimOutput(run, result, { elapsedMs: performance.now() - t0, threads: 0 });
}

export function createSimPool(opts: PoolOptions = {}): SimPool {
  const threads = checkThreads(opts.threads ?? defaultThreads());
  const entry = opts.threadEntry ?? DEV_THREAD_ENTRY;
  if (threads > 0 && entry.protocol === "file:" && !existsSync(fileURLToPath(entry))) {
    throw new Error(`the simulation thread entry ${entry.href} does not exist; pass threadEntry, or threads 0 to run inline`);
  }
  const slots: Slot[] = [];
  let closed = false;
  let running = false;
  let runCounter = 0;
  /** Stops the run in progress (set while a threaded run is going). */
  let abortCurrent: ((e: Error) => void) | null = null;

  const spawn = (): Slot => {
    const worker = new Worker(entry);
    // The pool never keeps the process alive on its own; a run in progress does, through its timer.
    worker.unref();
    const slot: Slot = { worker, handler: null, exited: false };
    worker.on("message", (m: ThreadMessage) => slot.handler?.onMessage(m));
    worker.on("messageerror", (e) => slot.handler?.onFailure(new SimulationWorkerError("a simulation thread sent a message that could not be read", { cause: e })));
    worker.on("error", (e) => slot.handler?.onFailure(new SimulationWorkerError(`a simulation thread threw: ${e.message}`, { cause: e })));
    worker.on("exit", (code) => {
      slot.exited = true;
      const i = slots.indexOf(slot);
      if (i >= 0) slots.splice(i, 1);
      slot.handler?.onFailure(new SimulationWorkerError(`a simulation thread exited with code ${code}`));
    });
    return slot;
  };

  const terminateAll = async (): Promise<void> => {
    const all = slots.splice(0);
    for (const s of all) s.handler = null;
    await Promise.all(all.map((s) => (s.exited ? Promise.resolve() : s.worker.terminate().then(() => undefined))));
  };

  const runThreaded = (run: PreparedRun, input: SimInput, opts: RunOptions, maxRunMs: number, chunkPaths: number, t0: number, used: number) =>
    new Promise<SimOutput>((resolve, reject) => {
      const runId = ++runCounter;
      const chunks = chunkRanges(run.paths, chunkPaths);
      const received = new Uint8Array(chunks.length);
      const summary = createRunSummary(run);
      let next = 0;
      let done = 0;
      let settled = false;
      while (slots.length < used) slots.push(spawn());
      const active = slots.slice(0, used);

      const detach = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        for (const s of active) s.handler = null;
        abortCurrent = null;
      };
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        detach();
        terminateAll().then(
          () => reject(e),
          () => reject(e),
        );
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        detach();
        try {
          const result = aggregate(run, summary);
          resolve(toSimOutput(run, result, { elapsedMs: performance.now() - t0, threads: used }));
        } catch (e) {
          terminateAll().then(
            () => reject(e),
            () => reject(e),
          );
        }
      };
      const dispatch = (slot: Slot) => {
        if (next >= chunks.length) return;
        const chunkId = next++;
        const [pathStart, pathCount] = chunks[chunkId]!;
        const m: ChunkMessage = { type: "chunk", runId, chunkId, pathStart, pathCount };
        slot.worker.postMessage(m);
      };
      const onChunk = (chunkId: number, chunk: ChunkSummary) => {
        const range = chunks[chunkId];
        if (range === undefined || received[chunkId] === 1 || chunk.pathStart !== range[0] || chunk.pathCount !== range[1]) {
          throw new SimulationWorkerError(`a simulation thread reported chunk ${chunkId} that was not asked for`);
        }
        received[chunkId] = 1;
        addChunk(summary, chunk);
        done += range[1];
      };

      // The limit counts from the start of the run, preparation included.
      const remaining = maxRunMs - (performance.now() - t0);
      const timer = setTimeout(() => fail(new SimulationCancelledError("timeout")), remaining > 0 ? remaining : 0);
      const onAbort = () => fail(new SimulationCancelledError("cancelled"));
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      abortCurrent = fail;

      for (const slot of active) {
        slot.handler = {
          onFailure: fail,
          onMessage: (m) => {
            if (settled || m.runId !== runId) return;
            if (m.type === "error") return fail(rebuildError(m));
            if (m.type === "ready") return dispatch(slot);
            try {
              onChunk(m.chunkId, m.summary);
            } catch (e) {
              return fail(e instanceof SimulationWorkerError ? e : new SimulationWorkerError(`a simulation thread sent a chunk that does not fit the run`, { cause: e }));
            }
            try {
              opts.onProgress?.({ donePaths: done, totalPaths: run.paths, elapsedMs: performance.now() - t0 });
            } catch (e) {
              return fail(e instanceof Error ? e : new Error(String(e)));
            }
            if (settled) return; // onProgress aborted the run
            if (done === run.paths) finish();
            else dispatch(slot);
          },
        };
      }
      const init: InitMessage = { type: "init", runId, input, engineVersion: ENGINE_VERSION, dataVersion: DATA_VERSION };
      for (const slot of active) slot.worker.postMessage(init);
      if (cancelled(opts.signal)) onAbort();
    });

  return {
    threads,
    get liveWorkers() {
      return slots.length;
    },
    async run(input, opts = {}) {
      if (closed) throw new Error("the simulation pool is closed");
      if (running) throw new Error("the simulation pool is already running a simulation");
      running = true;
      try {
        const t0 = performance.now();
        const { maxRunMs, chunkPaths } = checkRunOptions(opts);
        if (cancelled(opts.signal)) throw new SimulationCancelledError("cancelled");
        const run = prepare(input);
        const chunkCount = Math.ceil(run.paths / chunkPaths);
        const used = threads < chunkCount ? threads : chunkCount;
        if (used === 0) return await runInline(run, opts, maxRunMs, chunkPaths, t0, () => closed);
        return await runThreaded(run, input, opts, maxRunMs, chunkPaths, t0, used);
      } finally {
        running = false;
      }
    },
    async close() {
      closed = true;
      if (abortCurrent !== null) abortCurrent(new SimulationCancelledError("cancelled", POOL_CLOSED));
      await terminateAll();
    },
  };
}

/** Create a pool, run one simulation, close the pool (seams §2.4). `threads: 0` runs inline. */
export async function runSimulation(input: SimInput, opts: RunSimulationOptions): Promise<SimOutput> {
  const pool = createSimPool({ threads: opts.threads, ...(opts.threadEntry === undefined ? {} : { threadEntry: opts.threadEntry }) });
  try {
    return await pool.run(input, opts);
  } finally {
    await pool.close();
  }
}
