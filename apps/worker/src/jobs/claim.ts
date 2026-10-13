import { eq } from "drizzle-orm";
import { connection, enqueueJob, importLog, type JobRow } from "@meridian/db";
import { decryptSecret, encryptSecret } from "@meridian/shared";
import { claimAccessUrl, SimplefinError } from "../simplefin/client.js";
import type { JobContext } from "./context.js";

/** Turn a pasted setup token into an encrypted Access URL, then queue the first sync. */
export async function runClaimJob(ctx: JobContext, job: JobRow): Promise<void> {
  const connectionId = String(job.payload["connectionId"] ?? "");
  const [conn] = await ctx.db.select().from(connection).where(eq(connection.id, connectionId));
  if (!conn) throw new Error(`connection ${connectionId} not found`);
  if (!conn.claimTokenEnc) {
    ctx.log.warn(`[claim] connection ${connectionId} has no pending token`);
    return;
  }
  const [log] = await ctx.db.insert(importLog).values({ connectionId, kind: "simplefin.claim" }).returning({ id: importLog.id });

  try {
    const token = await decryptSecret(conn.claimTokenEnc, ctx.config.secretsKey);
    const accessUrl = await claimAccessUrl(token, ctx.client);
    const accessUrlEnc = await encryptSecret(accessUrl, ctx.config.secretsKey);
    await ctx.db
      .update(connection)
      .set({ accessUrlEnc, claimTokenEnc: null, status: "ok", lastError: null, lastErrors: [], updatedAt: ctx.now() })
      .where(eq(connection.id, connectionId));
    await ctx.db.update(importLog).set({ status: "ok", finishedAt: ctx.now(), message: "Access URL claimed" }).where(eq(importLog.id, log!.id));
    await enqueueJob(ctx.db, "simplefin.sync", { connectionId }, { dedupe: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const permanent = err instanceof SimplefinError ? err.permanent : false;
    await ctx.db
      .update(connection)
      .set({
        status: "error",
        lastError: message,
        // A refused token is dead; keep it only while a retry could still succeed.
        claimTokenEnc: permanent ? null : conn.claimTokenEnc,
        updatedAt: ctx.now(),
      })
      .where(eq(connection.id, connectionId));
    await ctx.db.update(importLog).set({ status: "error", finishedAt: ctx.now(), message }).where(eq(importLog.id, log!.id));
    throw err;
  }
}
