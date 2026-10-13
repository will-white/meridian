import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../index.js";
import { job } from "../schema/index.js";

export type JobRow = typeof job.$inferSelect;
export type JobType = JobRow["type"];

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
  /** Skip when a queued or running job of the same type and connection already exists. */
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
    const connectionId = typeof payload["connectionId"] === "string" ? payload["connectionId"] : undefined;
    const [existing] = await tx
      .select()
      .from(job)
      .where(
        and(
          eq(job.type, type),
          inArray(job.status, ["queued", "running"]),
          connectionId ? sql`${job.payload}->>'connectionId' = ${connectionId}` : undefined,
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

/** Record a failure; retry with exponential backoff until maxAttempts is spent. */
export async function failJob(tx: DbOrTx, row: Pick<JobRow, "id" | "attempts" | "maxAttempts">, error: string, options: { retry?: boolean } = {}): Promise<void> {
  const retry = options.retry !== false && row.attempts < row.maxAttempts;
  const delayMs = Math.min(60, 2 ** row.attempts) * 60_000;
  await tx
    .update(job)
    .set(
      retry
        ? { status: "queued", lockedBy: null, lastError: error.slice(0, 2000), runAt: new Date(Date.now() + delayMs) }
        : { status: "failed", lockedBy: null, lastError: error.slice(0, 2000), finishedAt: new Date() },
    )
    .where(eq(job.id, row.id));
}

/** Jobs stuck in `running` (worker died) go back to the queue. */
export async function requeueStaleJobs(tx: DbOrTx, olderThanMinutes = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const rows = await tx
    .update(job)
    .set({ status: "queued", lockedBy: null, lastError: "worker did not finish; requeued" })
    .where(and(eq(job.status, "running"), lt(job.startedAt, cutoff)))
    .returning({ id: job.id });
  return rows.length;
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
