import { eq } from "drizzle-orm";
import { connection, enqueueJob, importLog, type JobRow } from "@meridian/db";
import { decryptSecret, encryptSecret, errorMessageText } from "@meridian/shared";
import { claimAccessUrl, SimplefinError } from "../simplefin/client.js";
import type { JobContext } from "./context.js";

/**
 * What the connection says after a claim failed, and whether the token is spent. The Bridge
 * refusing the token (403) or answering with an access URL that was not kept (another host)
 * spends it: it is deleted and the household creates a new one. Any other failure (the Bridge
 * down, a timeout, a host this server is not set up to call) leaves the token stored, and
 * `POST /connections/:id/sync` (Sync now) queues the claim again (audit a4-sync-parse-06).
 */
export function claimFailure(err: unknown): { message: string; spent: boolean } {
  const reason = errorMessageText(err);
  if (err instanceof SimplefinError && (err.kind === "claim_forbidden" || err.kind === "access_url_refused")) return { message: reason, spent: true };
  if (err instanceof SimplefinError && err.kind === "host_not_allowed") return { message: `${reason} Then press Sync now to claim the token.`, spent: false };
  return { message: `The setup token could not be claimed yet: ${reason.replace(/\.$/, "")}. Press Sync now to try again.`, spent: false };
}

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
    const { message, spent } = claimFailure(err);
    await ctx.db
      .update(connection)
      .set({
        status: "error",
        lastError: message,
        // A refused token is dead; any other is kept, so the claim can be tried again.
        claimTokenEnc: spent ? null : conn.claimTokenEnc,
        updatedAt: ctx.now(),
      })
      .where(eq(connection.id, connectionId));
    await ctx.db.update(importLog).set({ status: "error", finishedAt: ctx.now(), message }).where(eq(importLog.id, log!.id));
    throw err;
  }
}
