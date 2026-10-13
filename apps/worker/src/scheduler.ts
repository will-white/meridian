import { and, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { connection, enqueueJob } from "@meridian/db";
import type { JobContext } from "./jobs/context.js";

/** Queue a sync for every SimpleFIN connection whose last sync is older than the interval. Returns how many were queued. */
export async function scheduleDueSyncs(ctx: JobContext): Promise<number> {
  const cutoff = new Date(ctx.now().getTime() - ctx.config.syncIntervalHours * 3600_000);
  const due = await ctx.db
    .select({ id: connection.id })
    .from(connection)
    .where(
      and(
        eq(connection.type, "simplefin"),
        isNotNull(connection.accessUrlEnc),
        inArray(connection.status, ["ok", "error", "auth_required"]),
        or(isNull(connection.lastSyncAt), lt(connection.lastSyncAt, cutoff)),
      ),
    );
  let queued = 0;
  for (const c of due) {
    const job = await enqueueJob(ctx.db, "simplefin.sync", { connectionId: c.id, scheduled: true }, { dedupe: true });
    if (job.created) queued++;
  }
  return queued;
}

export function startScheduler(ctx: JobContext, everyMs = 60_000): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const n = await scheduleDueSyncs(ctx);
      if (n > 0) ctx.log.info(`[scheduler] queued ${n} sync job(s)`);
    } catch (err) {
      ctx.log.error(`[scheduler] ${(err as Error).message}`);
    } finally {
      if (!stopped) setTimeout(() => void tick(), everyMs);
    }
  };
  void tick();
  return () => {
    stopped = true;
  };
}
