import type { Db } from "@meridian/db";
import type { WorkerConfig } from "../env.js";
import type { ClientOptions } from "../simplefin/client.js";

export interface JobContext {
  db: Db;
  config: WorkerConfig;
  client: ClientOptions;
  now: () => Date;
  log: Pick<Console, "info" | "warn" | "error">;
}
