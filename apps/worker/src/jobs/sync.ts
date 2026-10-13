import { eq } from "drizzle-orm";
import { applyAccountSet, connection, importLog, type JobRow } from "@meridian/db";
import { addDays, decryptSecret, toIsoDate, type IsoDate } from "@meridian/shared";
import { fetchAccounts, SimplefinError } from "../simplefin/client.js";
import type { JobContext } from "./context.js";

export interface SyncOutcome {
  importLogId: string;
  windowStart?: IsoDate;
  accounts: number;
  created: number;
  updated: number;
  replacedPending: number;
  removedPending: number;
  transfersPaired: number;
  errors: number;
}

/** Compute the overlapping window: 7 days before the last high-water mark, or 93 days back the first time. */
export function syncWindowStart(syncedThrough: IsoDate | null, today: IsoDate, config: { initialWindowDays: number; overlapDays: number }): IsoDate {
  return syncedThrough ? addDays(syncedThrough, -config.overlapDays) : addDays(today, -config.initialWindowDays);
}

/** GET /accounts for one connection, store the raw payload, apply it, update the connection's status. */
export async function runSyncJob(ctx: JobContext, job: JobRow): Promise<SyncOutcome> {
  const connectionId = String(job.payload["connectionId"] ?? "");
  const balancesOnly = job.type === "simplefin.balances" || job.payload["balancesOnly"] === true;
  const [conn] = await ctx.db.select().from(connection).where(eq(connection.id, connectionId));
  if (!conn) throw new Error(`connection ${connectionId} not found`);
  if (conn.type !== "simplefin" || !conn.accessUrlEnc) throw new Error(`connection ${connectionId} has no access URL`);
  if (conn.status === "disabled") throw new Error(`connection ${connectionId} is disabled`);

  const today = toIsoDate(ctx.now());
  const fullResync = job.payload["fullResync"] === true;
  const windowStart = balancesOnly ? undefined : syncWindowStart(fullResync ? null : conn.syncedThrough, today, ctx.config);
  const kind = balancesOnly ? "simplefin.balances" : "simplefin.sync";
  const [log] = await ctx.db.insert(importLog).values({ connectionId, kind }).returning({ id: importLog.id });
  const importLogId = log!.id;

  try {
    const accessUrl = await decryptSecret(conn.accessUrlEnc, ctx.config.secretsKey);
    const query: Parameters<typeof fetchAccounts>[1] = balancesOnly ? { balancesOnly: true } : { pending: true };
    if (windowStart) query.startDate = windowStart;
    const result = await fetchAccounts(accessUrl, query, ctx.client);

    // Raw payload first, so a crash while applying never loses the data.
    await ctx.db.update(importLog).set({ rawPayload: result.raw as Record<string, unknown> }).where(eq(importLog.id, importLogId));

    const applyOptions: Parameters<typeof applyAccountSet>[1] = { connectionId, importLogId, accountSet: result.set, balancesOnly };
    if (windowStart) applyOptions.windowStart = windowStart;
    const applied = await applyAccountSet(ctx.db, applyOptions);

    const authError = applied.errors.some((e) => e.code === "con.auth");
    await ctx.db
      .update(connection)
      .set({
        status: authError ? "auth_required" : "ok",
        lastSyncAt: ctx.now(),
        ...(balancesOnly ? {} : { syncedThrough: today }),
        lastErrors: applied.errors,
        lastError: authError ? "The Bridge reports this bank connection needs to be re-authenticated." : null,
        updatedAt: ctx.now(),
      })
      .where(eq(connection.id, connectionId));

    const stats = {
      accounts: applied.accounts,
      accountsCreated: applied.accountsCreated,
      ...applied.stats,
      transfersPaired: applied.transfersPaired,
    };
    await ctx.db
      .update(importLog)
      .set({ status: "ok", finishedAt: ctx.now(), stats, errors: applied.errors, message: balancesOnly ? "Balances refreshed" : `Synced from ${windowStart}` })
      .where(eq(importLog.id, importLogId));

    const outcome: SyncOutcome = {
      importLogId,
      accounts: applied.accounts,
      created: applied.stats.created,
      updated: applied.stats.updated,
      replacedPending: applied.stats.replacedPending,
      removedPending: applied.stats.removedPending,
      transfersPaired: applied.transfersPaired,
      errors: applied.errors.length,
    };
    if (windowStart) outcome.windowStart = windowStart;
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof SimplefinError && err.kind === "forbidden" ? "auth_required" : "error";
    await ctx.db.update(connection).set({ status, lastError: message, updatedAt: ctx.now() }).where(eq(connection.id, connectionId));
    await ctx.db.update(importLog).set({ status: "error", finishedAt: ctx.now(), message }).where(eq(importLog.id, importLogId));
    throw err;
  }
}
