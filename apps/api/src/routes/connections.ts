import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { activeJobsByConnection, connection, enqueueJob, importLog, job as jobTable, listRecentJobs } from "@meridian/db";
import {
  ConnectionView,
  CreateSimplefinConnectionBody,
  decodeSetupToken,
  encryptSecret,
  ImportLogView,
  JobView,
  OkResponse,
  UpdateConnectionBody,
  UuidParams,
} from "@meridian/shared";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
import { toConnectionView, toImportLogView, toJobView } from "../views.js";

export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  async function listConnections() {
    const rows = await app.db
      .select({
        conn: connection,
        // Raw identifiers on purpose: drizzle unqualifies interpolated columns in single-table queries.
        accountCount: sql<number>`(select count(*)::int from "account" a where a.connection_id = "connection"."id")`,
      })
      .from(connection)
      .orderBy(desc(connection.createdAt));
    const active = await activeJobsByConnection(app.db);
    return rows.map((row) => toConnectionView({ ...row.conn, accountCount: row.accountCount, activeJob: active.get(row.conn.id) }));
  }

  r.get("/connections", { schema: { response: { 200: z.array(ConnectionView) } } }, async () => listConnections());

  r.post("/connections/simplefin", { schema: { body: CreateSimplefinConnectionBody, response: { 200: ConnectionView } } }, async (request) => {
    // Validate before storing: the token must decode to an https claim URL.
    try {
      decodeSetupToken(request.body.token);
    } catch (err) {
      throw badRequest((err as Error).message, "bad_token");
    }
    const claimTokenEnc = await encryptSecret(request.body.token.trim(), app.config.secretsKey);
    const [row] = await app.db
      .insert(connection)
      .values({ type: "simplefin", name: request.body.name.trim(), status: "claiming", claimTokenEnc })
      .returning();
    const job = await enqueueJob(app.db, "simplefin.claim", { connectionId: row!.id });
    return toConnectionView({ ...row!, accountCount: 0, activeJob: job });
  });

  r.patch("/connections/:id", { schema: { params: UuidParams, body: UpdateConnectionBody, response: { 200: ConnectionView } } }, async (request) => {
    const patch: Partial<typeof connection.$inferInsert> = { updatedAt: new Date() };
    if (request.body.name !== undefined) patch.name = request.body.name.trim();
    if (request.body.status !== undefined) patch.status = request.body.status;
    // Switching a connection (back) on is the household saying "try again": a pause left by a 403 or 402 is lifted.
    if (request.body.status === "ok") patch.syncPaused = false;
    const [row] = await app.db.update(connection).set(patch).where(eq(connection.id, request.params.id)).returning();
    if (!row) throw notFound("Connection not found");
    return (await listConnections()).find((c) => c.id === row.id)!;
  });

  r.delete("/connections/:id", { schema: { params: UuidParams, response: { 200: OkResponse } } }, async (request) => {
    const deleted = await app.db.delete(connection).where(eq(connection.id, request.params.id)).returning({ id: connection.id });
    if (deleted.length === 0) throw notFound("Connection not found");
    return { ok: true as const };
  });

  /**
   * Queue a sync now (or, while a setup token is stored and not yet claimed, the claim). The
   * worker picks it up within its poll interval. One sync per connection
   * is queued or running at a time, so "sync now" during one returns that one. A full resync
   * (the whole first-sync window again, for after a bank was unreadable) is never dropped that
   * way: a sync still waiting is turned into one, and while one is running the answer is 409
   * `sync_running`.
   */
  r.post(
    "/connections/:id/sync",
    {
      schema: {
        params: UuidParams,
        body: z.object({ balancesOnly: z.boolean().default(false), fullResync: z.boolean().default(false) }).default({}),
        response: { 200: JobView },
      },
    },
    async (request) => {
      const [row] = await app.db.select().from(connection).where(eq(connection.id, request.params.id));
      if (!row) throw notFound("Connection not found");
      if (row.type !== "simplefin") throw badRequest("Only SimpleFIN connections sync", "not_simplefin");
      // A token that is stored but not claimed yet (the claim failed for a reason that passes: audit a4-sync-parse-06) is claimed again.
      if (row.claimTokenEnc && !row.accessUrlEnc) {
        const claim = await enqueueJob(app.db, "simplefin.claim", { connectionId: row.id }, { dedupe: true });
        if (row.status !== "disabled") await app.db.update(connection).set({ status: "claiming", updatedAt: new Date() }).where(eq(connection.id, row.id));
        return toJobView(claim);
      }
      if (!row.accessUrlEnc) {
        throw badRequest(
          "This connection has no access URL: its setup token was refused or used up. Remove the connection and add it again with a new setup token from the SimpleFIN Bridge.",
          "no_access_url",
        );
      }
      const type = request.body.balancesOnly ? "simplefin.balances" : "simplefin.sync";
      const payload: Record<string, unknown> = { connectionId: row.id, manual: true };
      const fullResync = request.body.fullResync && !request.body.balancesOnly;
      if (fullResync) payload["fullResync"] = true;
      const queued = await enqueueJob(app.db, type, payload, { dedupe: true });
      if (queued.created || !fullResync || queued.payload["fullResync"] === true) return toJobView(queued);
      // A sync was already there and it is not a full one. Only a job the worker has not claimed can still change.
      const [upgraded] = await app.db
        .update(jobTable)
        .set({ payload: sql`${jobTable.payload} || ${JSON.stringify({ manual: true, fullResync: true })}::jsonb` })
        .where(and(eq(jobTable.id, queued.id), eq(jobTable.status, "queued")))
        .returning();
      if (!upgraded) throw new HttpError(409, "A sync is running for this connection; ask for the full resync when it has finished", "sync_running");
      return toJobView(upgraded);
    },
  );

  /**
   * Phase 3 (imports design §4, plan decision 18): replay the connection's stored sync payloads
   * through the holdings parser (after a parser change), deduped per connection like a sync.
   */
  r.post("/connections/:id/reprocess-holdings", { schema: { params: UuidParams, response: { 200: JobView } } }, async (request) => {
    const [row] = await app.db.select({ id: connection.id, type: connection.type }).from(connection).where(eq(connection.id, request.params.id));
    if (!row) throw notFound("Connection not found");
    if (row.type !== "simplefin") throw badRequest("Only SimpleFIN connections carry holdings payloads to re-process", "not_simplefin");
    return toJobView(await enqueueJob(app.db, "simplefin.reprocess_holdings", { connectionId: row.id }, { dedupe: true }));
  });

  /**
   * Audit a5-ingest-transfers-13: replay the connection's stored sync payloads for their
   * transactions (after a reader or ingest fix, and for days older than the Bridge's 93-day
   * window): posted items the ledger lacks are inserted; nothing it has is changed.
   */
  r.post("/connections/:id/reprocess-transactions", { schema: { params: UuidParams, response: { 200: JobView } } }, async (request) => {
    const [row] = await app.db.select({ id: connection.id, type: connection.type }).from(connection).where(eq(connection.id, request.params.id));
    if (!row) throw notFound("Connection not found");
    if (row.type !== "simplefin") throw badRequest("Only SimpleFIN connections carry sync payloads to re-process", "not_simplefin");
    return toJobView(await enqueueJob(app.db, "simplefin.reprocess_transactions", { connectionId: row.id }, { dedupe: true }));
  });

  r.get("/connections/:id/imports", { schema: { params: UuidParams, response: { 200: z.array(ImportLogView) } } }, async (request) => {
    const rows = await app.db
      .select({
        id: importLog.id,
        connectionId: importLog.connectionId,
        kind: importLog.kind,
        status: importLog.status,
        startedAt: importLog.startedAt,
        finishedAt: importLog.finishedAt,
        stats: importLog.stats,
        errors: importLog.errors,
        message: importLog.message,
      })
      .from(importLog)
      .where(eq(importLog.connectionId, request.params.id))
      .orderBy(desc(importLog.startedAt))
      .limit(50);
    return rows.map((row) => toImportLogView({ ...row, rawPayload: null }));
  });

  r.get("/jobs", { schema: { response: { 200: z.array(JobView) } } }, async () => (await listRecentJobs(app.db, 50)).map(toJobView));
}
