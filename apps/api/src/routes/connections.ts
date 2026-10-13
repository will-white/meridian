import { desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { activeJobsByConnection, connection, enqueueJob, importLog, listRecentJobs } from "@meridian/db";
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
import { badRequest, notFound } from "../lib/errors.js";
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
    const [row] = await app.db.update(connection).set(patch).where(eq(connection.id, request.params.id)).returning();
    if (!row) throw notFound("Connection not found");
    return (await listConnections()).find((c) => c.id === row.id)!;
  });

  r.delete("/connections/:id", { schema: { params: UuidParams, response: { 200: OkResponse } } }, async (request) => {
    const deleted = await app.db.delete(connection).where(eq(connection.id, request.params.id)).returning({ id: connection.id });
    if (deleted.length === 0) throw notFound("Connection not found");
    return { ok: true as const };
  });

  /** Queue a sync now. The worker picks it up within its poll interval. */
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
      if (row.status === "claiming" && row.claimTokenEnc) {
        return toJobView(await enqueueJob(app.db, "simplefin.claim", { connectionId: row.id }, { dedupe: true }));
      }
      if (!row.accessUrlEnc) throw badRequest("This connection has no access URL yet; paste a new setup token", "no_access_url");
      const type = request.body.balancesOnly ? "simplefin.balances" : "simplefin.sync";
      const payload: Record<string, unknown> = { connectionId: row.id, manual: true };
      if (request.body.fullResync) payload["fullResync"] = true;
      return toJobView(await enqueueJob(app.db, type, payload, { dedupe: true }));
    },
  );

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
