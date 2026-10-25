import type { Db } from "@meridian/db";
import type { WorkerConfig } from "../env.js";
import type { ClientOptions } from "../simplefin/client.js";

export interface JobContext {
  db: Db;
  config: WorkerConfig;
  /** Outbound HTTP options; `client.fetch` is also what the price adapter uses, so one fake covers both feeds in the suites. */
  client: ClientOptions;
  now: () => Date;
  /** Pauses between provider requests and retries (prices design §3.11); defaults to a real timer, a no-op in the suites. */
  sleep?: (ms: number) => Promise<void>;
  log: Pick<Console, "info" | "warn" | "error">;
}

/** The context's pause, or a real timer when none was injected. */
export function sleepOf(ctx: Pick<JobContext, "sleep">): (ms: number) => Promise<void> {
  return ctx.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}
