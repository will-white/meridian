import { and, desc, eq, or, sql } from "drizzle-orm";
import type { AuditAction, AuditEntity } from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { auditLog, user } from "../schema/index.js";

/**
 * Audit log for plan, category, group, goal, recurring, rule and settings edits
 * (spec: Security — edits keep history), plus the typed error every Phase 2
 * service throws. This module has no service dependencies, so every other
 * Phase 2 service can import from it without a cycle.
 */

/** A service-level failure the API maps 1:1 onto an HTTP status and error code. */
export class PlanError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlanError";
  }
}

/** One batch per request: a fill-right's N cells or a reorder form one reviewable unit. */
export interface AuditContext {
  userId: string | null;
  batchId: string;
}

export interface AuditEntry extends AuditContext {
  entity: AuditEntity;
  entityId: string;
  action: AuditAction;
  /** The API view of the row before/after (cents as strings); null when created/deleted. */
  before: unknown;
  after: unknown;
}

export interface AuditRow {
  id: string;
  at: Date;
  userId: string | null;
  username: string | null;
  batchId: string;
  entity: AuditEntity;
  entityId: string;
  action: AuditAction;
  before: unknown;
  after: unknown;
}

export interface ListAuditQuery {
  entity?: AuditEntity;
  entityId?: string;
  batchId?: string;
  limit: number;
  cursor?: string;
}

/** Plain JSON: bigint → decimal string, Date → ISO, undefined dropped. */
export function toAuditJson(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toAuditJson);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = toAuditJson(v);
    }
    return out;
  }
  return value;
}

/** Structural equality over normalized JSON values. */
export function auditJsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => auditJsonEqual(v, b[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>).sort();
  const kb = Object.keys(b as Record<string, unknown>).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => auditJsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Append one audit row. Skipped (returns false) when `before` deep-equals `after`
 * so identical re-sends never write history. `at` uses clock_timestamp() so rows
 * written inside one transaction keep their write order.
 */
export async function writeAudit(tx: DbOrTx, entry: AuditEntry): Promise<boolean> {
  const before = toAuditJson(entry.before);
  const after = toAuditJson(entry.after);
  if (auditJsonEqual(before, after)) return false;
  await tx.insert(auditLog).values({
    at: sql`clock_timestamp()`,
    userId: entry.userId,
    batchId: entry.batchId,
    entity: entry.entity,
    entityId: entry.entityId,
    action: entry.action,
    before,
    after,
  });
  return true;
}

function decodeCursor(cursor: string): { at: string; id: string } | undefined {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const i = raw.lastIndexOf("|");
    if (i <= 0) return undefined;
    return { at: raw.slice(0, i), id: raw.slice(i + 1) };
  } catch {
    return undefined;
  }
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, "utf8").toString("base64url");
}

/** Newest first, keyset-paginated on (at, id). The cursor carries the full-precision timestamp text. */
export async function listAudit(db: DbOrTx, query: ListAuditQuery): Promise<{ items: AuditRow[]; nextCursor: string | null }> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  const limit = Math.max(1, Math.min(query.limit, 200));
  const rows = await db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      atText: sql<string>`${auditLog.at}::text`,
      userId: auditLog.userId,
      username: user.username,
      batchId: auditLog.batchId,
      entity: auditLog.entity,
      entityId: auditLog.entityId,
      action: auditLog.action,
      before: auditLog.before,
      after: auditLog.after,
    })
    .from(auditLog)
    .leftJoin(user, eq(user.id, auditLog.userId))
    .where(
      and(
        query.entity ? eq(auditLog.entity, query.entity) : undefined,
        query.entityId ? eq(auditLog.entityId, query.entityId) : undefined,
        query.batchId ? eq(auditLog.batchId, query.batchId) : undefined,
        cursor
          ? or(
              sql`${auditLog.at} < ${cursor.at}::timestamptz`,
              and(sql`${auditLog.at} = ${cursor.at}::timestamptz`, sql`${auditLog.id} < ${cursor.id}::uuid`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(({ atText: _atText, ...r }) => r),
    nextCursor: rows.length > limit && last ? encodeCursor(last.atText, last.id) : null,
  };
}
