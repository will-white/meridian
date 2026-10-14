import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { AlertKind, AlertView, IsoDate } from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { alert, payee, recurring } from "../schema/index.js";

/**
 * Alerts raised by the recurring engine (price_increase, new_recurring, missed_charge,
 * trial_converted). Raising lives in `recurring.ts` (`raiseAlert`, deduped by key); this
 * module reads them and records user dismissals. `dismissed_at` is the user's choice,
 * `resolved_at` the system's (late charge arrived, suggestion confirmed or dismissed);
 * an alert is open while both are null.
 */

/** Bigint twin of AlertView. */
export interface AlertRecord {
  id: string;
  kind: AlertKind;
  recurringId: string | null;
  recurringName: string | null;
  payeeId: string;
  payeeName: string;
  transactionId: string | null;
  dueDate: IsoDate | null;
  oldCents: bigint | null;
  newCents: bigint | null;
  createdAt: Date;
  dismissedAt: Date | null;
  resolvedAt: Date | null;
}

export interface ListAlertsQuery {
  includeDismissed?: boolean;
  includeResolved?: boolean;
  kind?: AlertKind;
  /** Default 100. */
  limit?: number;
}

const openWhere = and(isNull(alert.dismissedAt), isNull(alert.resolvedAt));

async function loadRecords(db: DbOrTx, where: ReturnType<typeof and>, limit?: number): Promise<AlertRecord[]> {
  const q = db
    .select({ row: alert, recurringName: recurring.name, payeeName: payee.name })
    .from(alert)
    .innerJoin(payee, eq(payee.id, alert.payeeId))
    .leftJoin(recurring, eq(recurring.id, alert.recurringId))
    .where(where)
    .orderBy(desc(alert.createdAt), desc(alert.id));
  const rows = limit === undefined ? await q : await q.limit(limit);
  return rows.map(({ row, recurringName, payeeName }) => ({
    id: row.id,
    kind: row.kind,
    recurringId: row.recurringId,
    recurringName,
    payeeId: row.payeeId,
    payeeName,
    transactionId: row.transactionId,
    dueDate: row.dueDate,
    oldCents: row.oldCents,
    newCents: row.newCents,
    createdAt: row.createdAt,
    dismissedAt: row.dismissedAt,
    resolvedAt: row.resolvedAt,
  }));
}

/** Newest first; open alerts only unless the flags say otherwise. */
export async function listAlerts(db: DbOrTx, query: ListAlertsQuery = {}): Promise<AlertRecord[]> {
  const limit = Math.max(1, Math.min(query.limit ?? 100, 500));
  return loadRecords(
    db,
    and(
      query.includeDismissed ? undefined : isNull(alert.dismissedAt),
      query.includeResolved ? undefined : isNull(alert.resolvedAt),
      query.kind ? eq(alert.kind, query.kind) : undefined,
    ),
    limit,
  );
}

export async function getAlert(db: DbOrTx, id: string): Promise<AlertRecord | undefined> {
  const [record] = await loadRecords(db, and(eq(alert.id, id)));
  return record;
}

/** Mark an alert dismissed by the user; a second call leaves the first timestamp. Undefined when unknown. */
export async function dismissAlert(db: DbOrTx, id: string, now: Date = new Date()): Promise<AlertRecord | undefined> {
  await db
    .update(alert)
    .set({ dismissedAt: now })
    .where(and(eq(alert.id, id), isNull(alert.dismissedAt)));
  return getAlert(db, id);
}

/** Dismiss every open alert (optionally of one kind); returns how many were dismissed. */
export async function dismissAllAlerts(db: DbOrTx, kind?: AlertKind, now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(alert)
    .set({ dismissedAt: now })
    .where(and(openWhere, kind ? eq(alert.kind, kind) : undefined))
    .returning({ id: alert.id });
  return rows.length;
}

/** Open alerts: neither dismissed nor resolved (the dashboard's review count). */
export async function countOpenAlerts(db: DbOrTx): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(alert)
    .where(openWhere);
  return row?.n ?? 0;
}

export function toAlertView(a: AlertRecord): AlertView {
  return {
    ...a,
    oldCents: a.oldCents === null ? null : a.oldCents.toString(),
    newCents: a.newCents === null ? null : a.newCents.toString(),
    createdAt: a.createdAt.toISOString(),
    dismissedAt: a.dismissedAt === null ? null : a.dismissedAt.toISOString(),
    resolvedAt: a.resolvedAt === null ? null : a.resolvedAt.toISOString(),
  };
}
