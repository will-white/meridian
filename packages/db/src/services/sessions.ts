import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, lte, ne, or, sql } from "drizzle-orm";
import type { DbOrTx } from "../index.js";
import { session, user } from "../schema/index.js";

/**
 * Sign-in sessions. The cookie carries a random 256-bit id; the table stores only its
 * SHA-256, so a database dump or a backup holds nothing a browser could present. A session
 * ends at `expires_at` (absolute) or `idle_expires_at` (inactivity), whichever comes first.
 *
 * Two kinds of row:
 *   - password-only (`totp_verified = false`): ten minutes, good for nothing but the
 *     two-factor routes, deleted at the fifth wrong code;
 *   - signed in (`totp_verified = true`): a new id issued when the code is accepted, never
 *     the password-only row promoted.
 */

/** How long a password-only session may wait for its authenticator code (or for enrollment). */
export const PENDING_SESSION_MS = 10 * 60_000;
/** Wrong codes a password-only session survives; the next one deletes it. */
export const MAX_FAILED_CODES = 5;
/** `last_seen_at` is written at most this often, so reads do not turn into a write per request. */
export const SESSION_TOUCH_MS = 5 * 60_000;

export function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/** The stored id for a cookie's session id. */
export function sessionIdOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface NewSession {
  userId: string;
  totpVerified: boolean;
  /** Absolute lifetime. */
  ttlMs: number;
  /** Allowed inactivity; capped at the absolute lifetime. */
  idleMs: number;
  now: Date;
  ip: string | null;
  userAgent: string | null;
}

export interface IssuedSession {
  /** Goes into the cookie and nowhere else. */
  token: string;
  /** What the table stores: SHA-256 of `token`. */
  id: string;
  expiresAt: Date;
}

export async function createSession(db: DbOrTx, s: NewSession): Promise<IssuedSession> {
  const token = newSessionToken();
  const id = sessionIdOf(token);
  const expiresAt = new Date(s.now.getTime() + s.ttlMs);
  const idleExpiresAt = new Date(Math.min(expiresAt.getTime(), s.now.getTime() + s.idleMs));
  await db.insert(session).values({ id, userId: s.userId, expiresAt, idleExpiresAt, lastSeenAt: s.now, createdAt: s.now, totpVerified: s.totpVerified, ip: s.ip, userAgent: s.userAgent });
  return { token, id, expiresAt };
}

export interface LiveSession {
  id: string;
  totpVerified: boolean;
  expiresAt: Date;
  lastSeenAt: Date;
  userId: string;
  username: string;
  role: "owner" | "viewer";
  totpConfirmedAt: Date | null;
}

const live = (now: Date) => and(gt(session.expiresAt, now), gt(session.idleExpiresAt, now));

/** The session a cookie's id names, with its user, when it has not expired. */
export async function findLiveSession(db: DbOrTx, token: string, now: Date): Promise<LiveSession | undefined> {
  const [row] = await db
    .select({
      id: session.id,
      totpVerified: session.totpVerified,
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
      userId: user.id,
      username: user.username,
      role: user.role,
      totpConfirmedAt: user.totpConfirmedAt,
    })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(and(eq(session.id, sessionIdOf(token)), live(now)));
  return row;
}

/** Records use: moves `last_seen_at` to now and the idle end to now + `idleMs` (never past the absolute end). */
export async function touchSession(db: DbOrTx, id: string, now: Date, idleMs: number): Promise<void> {
  await db
    .update(session)
    .set({ lastSeenAt: now, idleExpiresAt: sql`least(${session.expiresAt}, ${new Date(now.getTime() + idleMs).toISOString()}::timestamptz)` })
    .where(and(eq(session.id, id), lte(session.lastSeenAt, new Date(now.getTime() - SESSION_TOUCH_MS))));
}

/**
 * Replaces a session with a new one under a new id (after the second factor, after a password
 * change). Null, and nothing created, when the old session no longer exists: a request that
 * arrived on a session ended in the meantime gets no new one.
 */
export async function rotateSession(db: DbOrTx, oldId: string, s: NewSession): Promise<IssuedSession | null> {
  return db.transaction(async (tx) => {
    const ended = await tx.delete(session).where(eq(session.id, oldId)).returning({ id: session.id });
    return ended.length === 0 ? null : createSession(tx, s);
  });
}

export async function deleteSession(db: DbOrTx, id: string): Promise<void> {
  await db.delete(session).where(eq(session.id, id));
}

/** Signs a user out everywhere, or everywhere but `exceptId`. Returns how many sessions ended. */
export async function deleteUserSessions(db: DbOrTx, userId: string, exceptId?: string): Promise<number> {
  const rows = await db
    .delete(session)
    .where(and(eq(session.userId, userId), exceptId !== undefined ? ne(session.id, exceptId) : undefined))
    .returning({ id: session.id });
  return rows.length;
}

/** One of a user's own sessions, by its stored id. Returns whether a row was deleted. */
export async function deleteOwnSession(db: DbOrTx, userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(session)
    .where(and(eq(session.userId, userId), eq(session.id, id)))
    .returning({ id: session.id });
  return rows.length > 0;
}

export interface SessionRecord {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

/** A user's signed-in sessions that have not expired, most recently used first. */
export async function listSessions(db: DbOrTx, userId: string, now: Date): Promise<SessionRecord[]> {
  return db
    .select({ id: session.id, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, expiresAt: sql<Date>`least(${session.expiresAt}, ${session.idleExpiresAt})`.mapWith(session.expiresAt), ip: session.ip, userAgent: session.userAgent })
    .from(session)
    .where(and(eq(session.userId, userId), eq(session.totpVerified, true), live(now)))
    .orderBy(desc(session.lastSeenAt), desc(session.createdAt), session.id);
}

/**
 * Counts a wrong authenticator code against a password-only session. At `MAX_FAILED_CODES`
 * the session is deleted: the password has to be entered again before another code is tried.
 */
export async function recordFailedCode(db: DbOrTx, id: string): Promise<{ failedCodes: number; ended: boolean }> {
  const [row] = await db
    .update(session)
    .set({ failedCodes: sql`${session.failedCodes} + 1` })
    .where(eq(session.id, id))
    .returning({ failedCodes: session.failedCodes });
  // No row: the session is gone already (a second request raced the one that used or ended it).
  if (!row) return { failedCodes: 0, ended: false };
  const ended = row.failedCodes >= MAX_FAILED_CODES;
  if (ended) await deleteSession(db, id);
  return { failedCodes: row.failedCodes, ended };
}

/** Deletes sessions past their absolute or idle end (one user's, or everyone's). Returns how many. */
export async function purgeExpiredSessions(db: DbOrTx, now: Date, userId?: string): Promise<number> {
  const rows = await db
    .delete(session)
    .where(and(userId !== undefined ? eq(session.userId, userId) : undefined, or(lte(session.expiresAt, now), lte(session.idleExpiresAt, now))))
    .returning({ id: session.id });
  return rows.length;
}
