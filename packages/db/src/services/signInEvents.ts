import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { SignInEventKind } from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { signInEvent, user } from "../schema/index.js";

/**
 * Sign-in activity (Settings > Sign-in activity): completed sign-ins and failed attempts on
 * real accounts. Timestamps come from the database clock (`clock_timestamp()`), like the
 * audit log, so rows keep their write order.
 */

/** Kinds that count as a failed attempt. */
export const FAILED_SIGN_IN_KINDS: readonly SignInEventKind[] = ["password_failed", "reauth_failed", "code_failed", "code_lockout", "passkey_failed"];
/** Kinds that are a completed sign-in: they also become the member's `last_sign_in_at`. */
export const SIGNED_IN_KINDS: readonly SignInEventKind[] = ["signed_in", "passkey_signed_in"];
/** How long sign-in activity is kept. */
export const SIGN_IN_EVENT_RETENTION_DAYS = 90;

export interface SignInEventInput {
  userId: string;
  username: string;
  kind: SignInEventKind;
  ip: string | null;
  userAgent: string | null;
}

export interface SignInEventRecord {
  id: string;
  at: Date;
  username: string;
  kind: SignInEventKind;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Keeps one event. A completed sign-in is also written to the member's row
 * (`user.last_sign_in_at`, the same instant), because the activity is kept for 90 days and
 * "Last sign-in" must not turn into "never" when it goes (audit a2-auth-users N3).
 */
export async function recordSignInEvent(db: DbOrTx, event: SignInEventInput): Promise<void> {
  const values = { at: sql`clock_timestamp()`, userId: event.userId, username: event.username, kind: event.kind, ip: event.ip, userAgent: event.userAgent };
  if (!SIGNED_IN_KINDS.includes(event.kind)) {
    await db.insert(signInEvent).values(values);
    return;
  }
  await db.transaction(async (tx) => {
    const [row] = await tx.insert(signInEvent).values(values).returning({ id: signInEvent.id });
    await tx
      .update(user)
      .set({ lastSignInAt: sql`(select e."at" from "sign_in_event" e where e."id" = ${row!.id})` })
      .where(eq(user.id, event.userId));
  });
}

/** Newest first; one member's events when `userId` is given, everyone's otherwise. */
export async function listSignInEvents(db: DbOrTx, query: { userId?: string; limit?: number } = {}): Promise<SignInEventRecord[]> {
  const limit = Math.max(1, Math.min(query.limit ?? 100, 500));
  return db
    .select({ id: signInEvent.id, at: signInEvent.at, username: signInEvent.username, kind: signInEvent.kind, ip: signInEvent.ip, userAgent: signInEvent.userAgent })
    .from(signInEvent)
    .where(query.userId !== undefined ? eq(signInEvent.userId, query.userId) : undefined)
    .orderBy(desc(signInEvent.at), desc(signInEvent.id))
    .limit(limit);
}

/** Failed attempts in the last `days` days (database clock). */
export async function countFailedSignIns(db: DbOrTx, query: { userId?: string; days?: number } = {}): Promise<number> {
  const days = query.days ?? 7;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(signInEvent)
    .where(
      and(
        query.userId !== undefined ? eq(signInEvent.userId, query.userId) : undefined,
        inArray(signInEvent.kind, [...FAILED_SIGN_IN_KINDS]),
        sql`${signInEvent.at} > now() - make_interval(days => ${days})`,
      ),
    );
  return row?.n ?? 0;
}

/** Deletes activity older than the retention period. Returns how many rows went. */
export async function purgeSignInEvents(db: DbOrTx, retentionDays: number = SIGN_IN_EVENT_RETENTION_DAYS): Promise<number> {
  const rows = await db
    .delete(signInEvent)
    .where(sql`${signInEvent.at} < now() - make_interval(days => ${retentionDays})`)
    .returning({ id: signInEvent.id });
  return rows.length;
}
