import { claimNextJob, completeJob, failJob, requeueStaleJobs } from "@meridian/db";
import { dispatchJob } from "./jobs/index.js";
import type { JobContext } from "./jobs/context.js";
import { SimplefinError } from "./simplefin/client.js";

/** Drain the queue once: claim and run jobs until none are due. Returns how many ran. */
export async function drainQueue(ctx: JobContext): Promise<number> {
  let ran = 0;
  for (;;) {
    const job = await claimNextJob(ctx.db, ctx.config.workerId);
    if (!job) return ran;
    ran++;
    const started = Date.now();
    try {
      const result = await dispatchJob(ctx, job);
      await completeJob(ctx.db, job.id);
      ctx.log.info(`[job] ${job.type} ${job.id} done in ${Date.now() - started}ms ${result ? JSON.stringify(result) : ""}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retry = !(err instanceof SimplefinError && err.permanent);
      await failJob(ctx.db, job, message, { retry });
      ctx.log.error(`[job] ${job.type} ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}${retry ? "" : ", no retry"}): ${message}`);
    }
  }
}

/** Poll the queue forever. Stops when the returned function is called. */
export function startRunner(ctx: JobContext): () => void {
  let stopped = false;
  let lastStaleSweep = 0;
  const tick = async () => {
    if (stopped) return;
    try {
      if (Date.now() - lastStaleSweep > 60_000) {
        lastStaleSweep = Date.now();
        const n = await requeueStaleJobs(ctx.db, 30);
        if (n > 0) ctx.log.warn(`[runner] requeued ${n} stale job(s)`);
      }
      await drainQueue(ctx);
    } catch (err) {
      ctx.log.error(`[runner] ${(err as Error).message}`);
    } finally {
      if (!stopped) setTimeout(() => void tick(), ctx.config.pollIntervalMs);
    }
  };
  void tick();
  return () => {
    stopped = true;
  };
}
