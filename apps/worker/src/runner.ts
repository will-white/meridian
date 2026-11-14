import { writeFileSync } from "node:fs";
import { claimNextJob, completeJob, driverError, errorMessageOf, failJob, requeueStaleJobs } from "@meridian/db";
import { errorMessageText } from "@meridian/shared";
import { dispatchJob } from "./jobs/index.js";
import type { JobContext } from "./jobs/context.js";

/** An error that marks itself as not worth retrying (`SimplefinError`, `PriceFeedError`, or any `{ permanent: true }`). */
export function isPermanentError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const permanent = (err as { permanent?: unknown }).permanent;
  return typeof permanent === "boolean" && permanent;
}

/**
 * Audit a7-backup-deploy-secrets-18: the container's healthcheck reads this file's time. It is
 * written after every pass over the queue and every job, so it goes stale only when the runner
 * is stuck (or cannot reach the database).
 */
export function heartbeatWriter(file: string | undefined): (() => void) | undefined {
  if (!file) return undefined;
  return () => {
    try {
      writeFileSync(file, `${new Date().toISOString()}\n`);
    } catch {
      // The healthcheck reports a missing or stale file; the runner itself goes on.
    }
  };
}

/** Drain the queue once: claim and run jobs until none are due. Returns how many ran. */
export async function drainQueue(ctx: JobContext, beat?: () => void): Promise<number> {
  let ran = 0;
  for (;;) {
    const job = await claimNextJob(ctx.db, ctx.config.workerId);
    if (!job) return ran;
    ran++;
    const started = Date.now();
    try {
      const result = await dispatchJob(ctx, job);
      await completeJob(ctx.db, job.id);
      ctx.log.info(`[job] ${job.type} ${job.id} done in ${Date.now() - started}ms ${result ? JSON.stringify(result, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) : ""}`);
    } catch (err) {
      // Shown on the Connections page: sanitized and bounded, since an error can quote what a server sent.
      const message = errorMessageText(driverError(err));
      // Plan decision 18: retry unless the error says retrying cannot help.
      const retry = !isPermanentError(err);
      await failJob(ctx.db, job, message, { retry });
      ctx.log.error(`[job] ${job.type} ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}${retry ? "" : ", no retry"}): ${message}`);
    }
    beat?.();
  }
}

/** Poll the queue forever. Stops when the returned function is called. `heartbeat` runs after each pass that reached the database. */
export function startRunner(ctx: JobContext, heartbeat: (() => void) | undefined = heartbeatWriter(ctx.config.heartbeatFile)): () => void {
  let stopped = false;
  let lastStaleSweep = 0;
  const tick = async () => {
    if (stopped) return;
    try {
      if (Date.now() - lastStaleSweep > 60_000) {
        lastStaleSweep = Date.now();
        const stale = await requeueStaleJobs(ctx.db, 30);
        if (stale.requeued + stale.failed > 0) ctx.log.warn(`[runner] a worker stopped during ${stale.requeued + stale.failed} job(s): ${stale.requeued} requeued after a backoff, ${stale.failed} failed (attempts spent)`);
      }
      await drainQueue(ctx, heartbeat);
      heartbeat?.();
    } catch (err) {
      ctx.log.error(`[runner] ${errorMessageOf(err)}`);
    } finally {
      if (!stopped) setTimeout(() => void tick(), ctx.config.pollIntervalMs);
    }
  };
  void tick();
  return () => {
    stopped = true;
  };
}
