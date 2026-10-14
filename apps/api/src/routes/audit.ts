import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { listAudit } from "@meridian/db";
import { AuditList, AuditQuery } from "@meridian/shared";
import { toAuditEntryView } from "../views/plan.js";
import { usePlanErrors } from "./plan.js";

/** Edit history (spec: Security). Revert is client-side: re-send `before` through the entity's normal edit endpoint. */
export async function auditRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  usePlanErrors(app);

  r.get("/audit", { schema: { querystring: AuditQuery, response: { 200: AuditList } } }, async (request) => {
    const q = request.query;
    const result = await listAudit(app.db, {
      limit: q.limit,
      ...(q.entity !== undefined ? { entity: q.entity } : {}),
      ...(q.entityId !== undefined ? { entityId: q.entityId } : {}),
      ...(q.batchId !== undefined ? { batchId: q.batchId } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
    });
    return { items: result.items.map(toAuditEntryView), nextCursor: result.nextCursor };
  });
}
