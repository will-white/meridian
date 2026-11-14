/**
 * The thread harness's own errors (engine-and-returns §4.2, seams §2.4 and C7). The engine's
 * errors (`EngineInputError`, `EngineInvariantError`, `EngineRuntimeError`) keep their class across
 * the thread boundary (`protocol.ts`); these two are raised by the harness itself.
 *
 * The job maps them (C7): `SimulationCancelledError("cancelled")` → `cancelSimRun`,
 * `("timeout")` → `failSimRun("timeout")`, `SimulationWorkerError` → rethrown as it is, so the
 * queue's second attempt runs.
 */

export type CancelCode = "cancelled" | "timeout";

/** The run was stopped: its signal aborted, or it ran longer than `maxRunMs`. Permanent: a retry would be stopped again. */
export class SimulationCancelledError extends Error {
  readonly permanent = true;
  readonly code: CancelCode;
  constructor(code: CancelCode, message: string = code === "timeout" ? "the simulation ran past its time limit" : "the simulation was cancelled") {
    super(message);
    this.name = "SimulationCancelledError";
    this.code = code;
  }
}

/** A simulation thread died or broke the protocol (not an engine error). Retryable: the machine, not the input, failed. */
export class SimulationWorkerError extends Error {
  readonly permanent = false;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SimulationWorkerError";
  }
}
