/**
 * @meridian/retirement/node: the worker-thread harness (engine-and-returns §3.13; seams §2.4,
 * C7, C10).
 *
 * The only part of the package that may import node: modules. The worker's job calls
 * `runSimulation(input, { threads, threadEntry, signal, maxRunMs, onProgress })`; the worker app's
 * `simThread.ts` calls `runThreadMain()`. The engine's error classes are re-exported, so the job
 * can map every error a run rejects with from this one import (C7).
 */

export {
  CHUNK_PATHS,
  DEFAULT_MAX_RUN_MS,
  DEV_THREAD_ENTRY,
  MAX_THREADS,
  chunkRanges,
  createSimPool,
  defaultThreads,
  runSimulation,
} from "./pool.js";
export type { PoolOptions, RunOptions, RunSimulationOptions, SimPool, SimProgress } from "./pool.js";
export { runThreadMain } from "./thread.js";
export type { ThreadMainOptions } from "./thread.js";
export { SimulationCancelledError, SimulationWorkerError } from "./errors.js";
export type { CancelCode } from "./errors.js";
export { EngineInputError, EngineInvariantError, EngineRuntimeError } from "../errors.js";
export type { PathResult, SimOutput } from "../facade.js";
