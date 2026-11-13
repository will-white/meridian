import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../index.js";
import { connection, importLog, job } from "../schema/index.js";

export type JobRow = typeof job.$inferSelect;
export type JobType = JobRow["type"];

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
  /**
   * Skip when a queued or running job of the same type already exists. The match is on
   * `payload.dedupeKey` when the payload carries one (Phase 3: a continuation and a nightly
   * run of `prices.fetch` never swallow each other), else on `payload.connectionId` (Phase 1).
   */
  dedupe?: boolean;
}

/** Insert a job. `created` is false when `dedupe` found one already queued or running. */
export async function enqueueJob(
  tx: DbOrTx,
  type: JobType,
  payload: Record<string, unknown> = {},
  options: EnqueueOptions = {},
): Promise<JobRow & { created: boolean }> {
  if (options.dedupe) {
    const dedupeKey = typeof payload["dedupeKey"] === "string" ? payload["dedupeKey"] : undefined;
    const connectionId = typeof payload["connectionId"] === "string" ? payload["connectionId"] : undefined;
    const [existing] = await tx
      .select()
      .from(job)
      .where(
        and(
          eq(job.type, type),
          inArray(job.status, ["queued", "running"]),
          dedupeKey !== undefined
            ? sql`${job.payload}->>'dedupeKey' = ${dedupeKey}`
            : connectionId
              ? sql`${job.payload}->>'connectionId' = ${connectionId}`
              : undefined,
        ),
      )
      .limit(1);
    if (existing) return { ...existing, created: false };
  }
  const [row] = await tx
    .insert(job)
    .values({ type, payload, runAt: options.runAt ?? new Date(), maxAttempts: options.maxAttempts ?? 3 })
    .returning();
  return { ...row!, created: true };
}

/** Atomically claim the next due job (FOR UPDATE SKIP LOCKED), or undefined when the queue is idle. */
export async function claimNextJob(db: Db, workerId: string): Promise<JobRow | undefined> {
  const rows = await db.execute<JobRow>(sql`
    update "job" set status = 'running', locked_by = ${workerId}, started_at = now(), attempts = attempts + 1
    where id = (
      select id from "job"
      where status = 'queued' and run_at <= now()
      order by run_at asc, created_at asc
      for update skip locked
      limit 1
    )
    returning id, type, payload, status, run_at as "runAt", attempts, max_attempts as "maxAttempts",
      locked_by as "lockedBy", last_error as "lastError", created_at as "createdAt", started_at as "startedAt", finished_at as "finishedAt"
  `);
  const row = rows[0];
  if (!row) return undefined;
  return {
    ...row,
    runAt: new Date(row.runAt),
    createdAt: new Date(row.createdAt),
    startedAt: row.startedAt ? new Date(row.startedAt) : null,
    finishedAt: row.finishedAt ? new Date(row.finishedAt) : null,
  };
}

export async function completeJob(tx: DbOrTx, id: string): Promise<void> {
  await tx.update(job).set({ status: "done", finishedAt: new Date(), lockedBy: null, lastError: null }).where(eq(job.id, id));
}

/** The wait before the next attempt after `attempts` failed ones: 2, 4, 8 … minutes, at most an hour. */
export function retryDelayMs(attempts: number): number {
  return Math.min(60, 2 ** attempts) * 60_000;
}

/** Record a failure; retry with exponential backoff until maxAttempts is spent. */
export async function failJob(tx: DbOrTx, row: Pick<JobRow, "id" | "attempts" | "maxAttempts">, error: string, options: { retry?: boolean } = {}): Promise<void> {
  const retry = options.retry !== false && row.attempts < row.maxAttempts;
  const delayMs = retryDelayMs(row.attempts);
  await tx
    .update(job)
    .set(
      retry
        ? { status: "queued", lockedBy: null, lastError: error.slice(0, 2000), runAt: new Date(Date.now() + delayMs) }
        : { status: "failed", lockedBy: null, lastError: error.slice(0, 2000), finishedAt: new Date() },
    )
    .where(eq(job.id, row.id));
}

export interface StaleJobsOutcome {
  /** Put back in the queue, to run after the backoff of a failed attempt. */
  requeued: number;
  /** Their attempts were spent: failed. */
  failed: number;
}

export const STALE_JOB_MESSAGE = "The worker stopped before this job finished (it was restarted, or ran out of memory)";

/**
 * Jobs stuck in `running` because the worker died (audit a4-sync-parse-07). A crash counts as
 * a failed attempt: a job whose attempts are spent is failed, any other goes back to the queue
 * after the same backoff `failJob` gives, so a job that kills the worker cannot run again
 * every half hour for ever, and the single try a failing connection gets (audit decision 27)
 * stays single. A SimpleFIN job's open import log rows are closed as errors, and a sync's
 * connection records the attempt as a failed sync does, so the scheduler spaces the next one
 * from it.
 */
export async function requeueStaleJobs(db: Db, olderThanMinutes = 30): Promise<StaleJobsOutcome> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const stale = await db
    .select()
    .from(job)
    .where(and(eq(job.status, "running"), lt(job.startedAt, cutoff)));
  const outcome: StaleJobsOutcome = { requeued: 0, failed: 0 };
  for (const row of stale) {
    const spent = row.attempts >= row.maxAttempts;
    const now = new Date();
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(job)
        .set(
          spent
            ? { status: "failed", lockedBy: null, lastError: STALE_JOB_MESSAGE, finishedAt: now }
            : { status: "queued", lockedBy: null, lastError: `${STALE_JOB_MESSAGE}; tried again later`, runAt: new Date(now.getTime() + retryDelayMs(row.attempts)) },
        )
        .where(and(eq(job.id, row.id), eq(job.status, "running"), row.lockedBy === null ? undefined : eq(job.lockedBy, row.lockedBy)))
        .returning({ id: job.id });
      if (!updated) return;
      if (spent) outcome.failed++;
      else outcome.requeued++;
      const connectionId = row.payload["connectionId"];
      if (typeof connectionId !== "string" || !row.type.startsWith("simplefin.") || !row.startedAt) return;
      await tx
        .update(importLog)
        .set({ status: "error", finishedAt: now, message: STALE_JOB_MESSAGE })
        .where(and(eq(importLog.connectionId, connectionId), eq(importLog.status, "running"), gte(importLog.startedAt, row.startedAt)));
      if (row.type === "simplefin.sync" || row.type === "simplefin.balances") {
        await tx
          .update(connection)
          .set({ status: "error", lastError: STALE_JOB_MESSAGE, lastErrors: [], lastAttemptAt: now, updatedAt: now })
          .where(and(eq(connection.id, connectionId), inArray(connection.status, ["ok", "error", "auth_required"])));
      }
    });
  }
  return outcome;
}

export async function listRecentJobs(tx: DbOrTx, limit = 50): Promise<JobRow[]> {
  return tx.select().from(job).orderBy(desc(job.createdAt)).limit(limit);
}

export async function activeJobsByConnection(tx: DbOrTx): Promise<Map<string, JobRow>> {
  const rows = await tx
    .select()
    .from(job)
    .where(inArray(job.status, ["queued", "running"]))
    .orderBy(desc(job.createdAt));
  const out = new Map<string, JobRow>();
  for (const r of rows) {
    const connectionId = r.payload["connectionId"];
    if (typeof connectionId === "string" && !out.has(connectionId)) out.set(connectionId, r);
  }
  return out;
}
