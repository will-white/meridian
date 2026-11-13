/**
 * The engine's error classes (engine-and-returns §4.2, seams §2.4 and C7).
 *
 * All three are permanent: the job runner does not retry them, because the same input gives the
 * same failure. Each sets `name` to its class name, so the thread harness can rebuild the class on
 * the far side of a worker boundary from `{ name, code, message }`.
 *
 * The harness errors (`SimulationCancelledError`, `SimulationWorkerError`) belong to
 * `src/node` and are added with the pool.
 */

/** Bad input, raised by `prepare()` / `validateInput()` before any thread starts. */
export class EngineInputError extends Error {
  readonly permanent = true;
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EngineInputError";
    this.code = code;
  }
}

/** A hook or an internal step broke its contract (for example a withdrawal above `available`). */
export class EngineInvariantError extends Error {
  readonly permanent = true;
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EngineInvariantError";
    this.code = code;
  }
}

export type EngineRuntimeCode = "self_test_failed";

/** The machine cannot run the engine faithfully (the start-up self-test disagreed). */
export class EngineRuntimeError extends Error {
  readonly permanent = true;
  readonly code: EngineRuntimeCode;
  constructor(code: EngineRuntimeCode, message: string) {
    super(message);
    this.name = "EngineRuntimeError";
    this.code = code;
  }
}
