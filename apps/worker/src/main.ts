/**
 * Meridian worker: the only process that talks to the outside world.
 * Phase 1: SimpleFIN claim and sync jobs (every SYNC_INTERVAL_HOURS), rules re-runs.
 * Later: price fetch, recurring detection, retirement simulations.
 */
import { createDb } from "@meridian/db";
import { loadConfig } from "./env.js";
import type { JobContext } from "./jobs/context.js";
import { startRunner } from "./runner.js";
import { startScheduler } from "./scheduler.js";

const config = loadConfig();
const { db, client } = createDb(config.databaseUrl, { max: 5 });
const ctx: JobContext = {
  db,
  config,
  client: { timeoutMs: config.requestTimeoutMs },
  now: () => new Date(),
  log: console,
};

console.log(`[worker] ${config.workerId} starting; sync every ${config.syncIntervalHours}h, polling every ${config.pollIntervalMs}ms`);
const stopRunner = startRunner(ctx);
const stopScheduler = startScheduler(ctx);

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received, stopping`);
  stopRunner();
  stopScheduler();
  await client.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
