/**
 * Meridian worker: the only process that talks to the outside world.
 * Phase 1: SimpleFIN claim and sync jobs (every SYNC_INTERVAL_HOURS), rules re-runs.
 * Later: price fetch, recurring detection, retirement simulations.
 */
import { createDb, errorMessageOf, verifySecretsKey } from "@meridian/db";
import { loadConfig } from "./env.js";
import type { JobContext } from "./jobs/context.js";
import { startRunner } from "./runner.js";
import { startScheduler } from "./scheduler.js";

const config = loadConfig();
const { db, client } = createDb(config.databaseUrl, { max: 5 });
const ctx: JobContext = {
  db,
  config,
  client: {
    timeoutMs: config.requestTimeoutMs,
    ...(config.simplefinAllowedHosts ? { allowedHosts: config.simplefinAllowedHosts } : {}),
    ...(config.simplefinMaxResponseBytes ? { maxResponseBytes: config.simplefinMaxResponseBytes } : {}),
  },
  now: () => new Date(),
  log: console,
};

// Audit a7-backup-deploy-secrets-06: a SECRETS_KEY that opens none of the stored secrets stops the worker with the reason.
try {
  const warning = await verifySecretsKey(db, config.secretsKey);
  if (warning) console.warn(`[worker] ${warning}`);
} catch (err) {
  console.error(`[worker] not starting: ${errorMessageOf(err)}`);
  await client.end({ timeout: 5 });
  process.exit(1);
}

console.log(
  `[worker] ${config.workerId} starting; sync every ${config.syncIntervalHours}h, polling every ${config.pollIntervalMs}ms; SimpleFIN hosts: ${(config.simplefinAllowedHosts ?? []).join(", ")}`,
);
const stopRunner = startRunner(ctx);
const stopScheduler = startScheduler(ctx);

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received, stopping`);
  stopRunner();
  await stopScheduler();
  await client.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
