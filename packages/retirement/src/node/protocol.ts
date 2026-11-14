/**
 * The messages between the pool and a simulation thread (engine-and-returns §3.13 item 5).
 *
 * Main → thread: `init` (the frozen input by structured clone; the thread runs the self-test once,
 * prepares the run and allocates one path state) and `chunk` (a range of paths). Thread → main:
 * `ready`, `chunkDone` (the chunk summary, every typed array's buffer in the transfer list, so the
 * arrays move instead of being copied) and `error`. Every message carries the run's id, so a reply
 * that belongs to an earlier run is never mistaken for one of this run.
 *
 * Structured clone and transfer are used, not `SharedArrayBuffer`, so the same protocol works in a
 * browser worker later.
 */

import type { SimInput } from "@meridian/shared";
import type { ChunkSummary } from "../aggregate.js";
import { EngineInputError, EngineInvariantError, EngineRuntimeError } from "../errors.js";
import { SimulationWorkerError } from "./errors.js";

export interface InitMessage {
  readonly type: "init";
  readonly runId: number;
  readonly input: SimInput;
  /** The versions the pool was built with; a thread from another build refuses the run. */
  readonly engineVersion: string;
  readonly dataVersion: string;
}

export interface ChunkMessage {
  readonly type: "chunk";
  readonly runId: number;
  readonly chunkId: number;
  readonly pathStart: number;
  readonly pathCount: number;
}

export type MainMessage = InitMessage | ChunkMessage;

export interface ReadyMessage {
  readonly type: "ready";
  readonly runId: number;
}

export interface ChunkDoneMessage {
  readonly type: "chunkDone";
  readonly runId: number;
  readonly chunkId: number;
  readonly summary: ChunkSummary;
}

/** An error inside the thread, flattened for structured clone. */
export interface ErrorMessage {
  readonly type: "error";
  readonly runId: number;
  readonly name: string;
  readonly code: string | null;
  readonly message: string;
  readonly stack: string | null;
}

export type ThreadMessage = ReadyMessage | ChunkDoneMessage | ErrorMessage;

/** The name a thread gives an init whose versions differ from its own (a stale bundle). */
export const VERSION_MISMATCH = "VersionMismatch";

/** Every buffer of a chunk summary: moved to the main thread, not copied. */
export function chunkTransferList(chunk: ChunkSummary): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const value of Object.values(chunk)) {
    if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer && !out.includes(value.buffer)) out.push(value.buffer);
  }
  return out;
}

/** Flattens anything thrown in a thread. */
export function errorMessage(runId: number, e: unknown): ErrorMessage {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return { type: "error", runId, name: e.name, code: typeof code === "string" ? code : null, message: e.message, stack: e.stack ?? null };
  }
  return { type: "error", runId, name: "Error", code: null, message: String(e), stack: null };
}

/**
 * The main thread's error for a thread's `error` message (engine-and-returns §3.13 item 9): an
 * engine error is rebuilt as its own class (permanent, so the job does not retry it); anything
 * else is a `SimulationWorkerError` (retryable).
 */
export function rebuildError(m: ErrorMessage): Error {
  let error: Error;
  if (m.name === "EngineInputError" && m.code !== null) error = new EngineInputError(m.code, m.message);
  else if (m.name === "EngineInvariantError" && m.code !== null) error = new EngineInvariantError(m.code, m.message);
  else if (m.name === "EngineRuntimeError" && m.code === "self_test_failed") error = new EngineRuntimeError("self_test_failed", m.message);
  else {
    const cause = new Error(m.message);
    cause.name = m.name;
    if (m.stack !== null) cause.stack = m.stack;
    return new SimulationWorkerError(`a simulation thread failed: ${m.name}: ${m.message}`, { cause });
  }
  if (m.stack !== null) error.stack = m.stack;
  return error;
}
