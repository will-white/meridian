/**
 * Simulating paths of a prepared run on the calling thread (engine-and-returns §4.2): a chunk of
 * paths into a `ChunkSummary`, a whole run into a `RunSummary`, and one path with its detail for
 * the year table. The thread pool (`src/node`) runs `simulateChunk` in its workers; these are also
 * what inline mode, the tests and the API's single-path re-simulation use.
 *
 * A path depends only on `(run, pathIndex)` (L5): the same path gives the same numbers in any
 * chunk, on any thread, after any other path, and with or without its detail recorded.
 */

import { type ChunkSummary, type RunSummary, addChunk, createChunkSummary, createRunSummary, recordPath } from "./aggregate.js";
import { TAX_FUNCTIONS } from "./hooks.js";
import { type PathDetail, createPathDetail, simulatePath } from "./loop.js";
import type { PreparedRun } from "./prepare.js";
import { type PathState, createPathState } from "./state.js";
import { createEngineHooks } from "./withdrawals/index.js";

/** A thread's state for `run` with the production hooks and tax functions. */
export function createProductionState(run: PreparedRun): PathState {
  return createPathState(run, createEngineHooks(), TAX_FUNCTIONS);
}

function checkState(run: PreparedRun, ps: PathState): void {
  if (ps.run !== run) throw new RangeError("the path state was created for another run");
}

/** Simulates paths `[pathStart, pathStart + pathCount)`. `ps` (default: production hooks) must have been created for `run`. */
export function simulateChunk(run: PreparedRun, pathStart: number, pathCount: number, ps: PathState = createProductionState(run)): ChunkSummary {
  checkState(run, ps);
  const chunk = createChunkSummary(run, pathStart, pathCount);
  for (let i = 0; i < pathCount; i++) {
    simulatePath(ps, pathStart + i);
    recordPath(chunk, i, ps);
  }
  return chunk;
}

/** Every path of `run` inline, in chunks of `chunkSize` (one chunk by default), merged into the run summary. */
export function simulateRun(run: PreparedRun, ps: PathState = createProductionState(run), chunkSize: number = run.paths): RunSummary {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new RangeError(`simulateRun: not a chunk size: ${chunkSize}`);
  const summary = createRunSummary(run);
  for (let start = 0; start < run.paths; start += chunkSize) {
    addChunk(summary, simulateChunk(run, start, Math.min(chunkSize, run.paths - start), ps));
  }
  return summary;
}

/** Re-simulates path `pathIndex` with its detail recorded (the year table's source). */
export function simulatePathDetail(run: PreparedRun, pathIndex: number, ps: PathState = createProductionState(run)): PathDetail {
  checkState(run, ps);
  if (!Number.isSafeInteger(pathIndex) || pathIndex < 0 || pathIndex >= run.paths) {
    throw new RangeError(`simulatePathDetail: path ${pathIndex} is not one of the run's ${run.paths}`);
  }
  const detail = createPathDetail(run);
  simulatePath(ps, pathIndex, detail);
  return detail;
}
