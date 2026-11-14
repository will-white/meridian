import type { Db } from "@meridian/db";
import type { PathResult, RunSimulationOptions, SimOutput } from "@meridian/retirement/node";
import type { SimInput } from "@meridian/shared";
import type { WorkerConfig } from "../env.js";
import type { ClientOptions } from "../simplefin/client.js";

/**
 * What the `retirement.simulate` job needs of the engine (inputs-and-data §6.1, seams §2.4): the
 * whole run, one path re-simulated with its year table, and the two versions a run is stamped and
 * checked with. The default is the real `@meridian/retirement`; the suites inject a fake.
 */
export interface SimEngine {
  readonly ENGINE_VERSION: string;
  readonly DATA_VERSION: string;
  runSimulation(input: SimInput, opts: RunSimulationOptions): Promise<SimOutput>;
  simulatePath(input: SimInput, pathIndex: number): PathResult;
}

export interface JobContext {
  db: Db;
  config: WorkerConfig;
  /** Outbound HTTP options; `client.fetch` is also what the price adapter uses, so one fake covers both feeds in the suites. */
  client: ClientOptions;
  now: () => Date;
  /** Pauses between provider requests and retries (prices design §3.11); defaults to a real timer, a no-op in the suites. */
  sleep?: (ms: number) => Promise<void>;
  log: Pick<Console, "info" | "warn" | "error">;
  /** The retirement engine (Phase 4); the real package when absent. */
  sim?: SimEngine;
}

/** The context's pause, or a real timer when none was injected. */
export function sleepOf(ctx: Pick<JobContext, "sleep">): (ms: number) => Promise<void> {
  return ctx.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}
