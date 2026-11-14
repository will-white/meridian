import { and, count, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { DbOrTx } from "../index.js";
import { user } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { deleteUserPasskeys } from "./passkeys.js";
import { deleteUserSessions } from "./sessions.js";

/**
 * Household members: the owner (created once, at first run) and the viewers the owner adds.
 * Password hashing and authenticator codes live in the API; this module stores what it is
 * handed, keeps the invariants (one owner, unique names, a code step used once) and writes
 * the audit rows. Nothing here returns or audits a password hash or an authenticator secret.
 */

type StoredUser = typeof user.$inferSelect;

/** What the audit log keeps about a member: who they are and when their sign-in details last changed. */
export function userAuditJson(row: Pick<StoredUser, "username" | "role" | "passwordChangedAt" | "totpConfirmedAt">) {
  return { username: row.username, role: row.role, passwordChangedAt: row.passwordChangedAt, totpConfirmedAt: row.totpConfirmedAt };
}

/**
 * Postgres advisory lock taken by everything that adds a member (first-run setup, adding a
 * viewer), so the check that comes before the insert ("no user yet", "no one by this name in
 * any case") and the insert are decided one request at a time.
 */
const MEMBER_LOCK = 0x4d_52_44_4e; // "MRDN"

/**
 * First-run setup: creates the owner if, and only if, no user exists. The check and the
 * insert run under a transaction-scoped advisory lock, so of any number of requests that
 * arrive together exactly one creates an account; the rest get 403 `already_setup`.
 */
export async function createOwner(db: DbOrTx, input: { username: string; passwordHash: string }, batchId: string): Promise<{ id: string; username: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${MEMBER_LOCK})`);
    const [existing] = await tx.select({ n: count() }).from(user);
    if ((existing?.n ?? 0) > 0) throw new PlanError(403, "already_setup", "The owner account already exists");
    const [created] = await tx.insert(user).values({ username: input.username, passwordHash: input.passwordHash, role: "owner" }).returning();
    await writeAudit(tx, { userId: created!.id, batchId, entity: "user", entityId: created!.id, action: "create", before: null, after: userAuditJson(created!) });
    return { id: created!.id, username: created!.username };
  });
}

export interface UserRecord {
  id: string;
  username: string;
  role: "owner" | "viewer";
  totpEnrolled: boolean;
  createdAt: Date;
  passwordChangedAt: Date;
  lastSignInAt: Date | null;
  activeSessions: number;
}

/** Everyone in the household: the owner first, then viewers by name. */
export async function listUsers(db: DbOrTx, now: Date): Promise<UserRecord[]> {
  const nowText = now.toISOString();
  const rows = await db
    .select({
      id: user.id,
      username: user.username,
      role: user.role,
      totpConfirmedAt: user.totpConfirmedAt,
      createdAt: user.createdAt,
      passwordChangedAt: user.passwordChangedAt,
      // Kept on the row, not derived from the activity, which is deleted after 90 days (audit a2-auth-users N3).
      lastSignInAt: user.lastSignInAt,
      // A correlated subquery, spelled with qualified names: Drizzle leaves the table off a column in a single-table select.
      activeSessions: sql<number>`(select count(*)::int from "session" s where s."user_id" = "user"."id" and s."totp_verified" and s."expires_at" > ${nowText}::timestamptz and s."idle_expires_at" > ${nowText}::timestamptz)`,
    })
    .from(user)
    .orderBy(sql`case when ${user.role} = 'owner' then 0 else 1 end`, sql`lower(${user.username})`, user.id);
  return rows.map(({ totpConfirmedAt, ...r }) => ({ ...r, totpEnrolled: totpConfirmedAt !== null }));
}

export async function getUser(db: DbOrTx, id: string, now: Date): Promise<UserRecord | undefined> {
  return (await listUsers(db, now)).find((u) => u.id === id);
}

const isUniqueViolation = (error: unknown) => typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";

/**
 * The owner adds a viewer: a read-only member with their own password. The account starts
 * without a second factor; the viewer enrolls their own authenticator at first sign-in,
 * before anything opens. Names are unique whatever their case ("Sam" and "sam" are one name,
 * plan decision 19). The column's UNIQUE is exact, so the case-blind check runs under the
 * member lock: of two requests for "Pat" and "pat" sent together, the second waits, then
 * sees the first's row (audit a2-auth-users N1).
 */
export async function createViewer(db: DbOrTx, input: { username: string; passwordHash: string }, ctx: AuditContext): Promise<{ id: string }> {
  const taken = new PlanError(409, "username_taken", `There is already a member named "${input.username}"`);
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${MEMBER_LOCK})`);
      const [clash] = await tx.select({ id: user.id }).from(user).where(sql`lower(${user.username}) = lower(${input.username})`).limit(1);
      if (clash) throw taken;
      const [created] = await tx.insert(user).values({ username: input.username, passwordHash: input.passwordHash, role: "viewer" }).returning();
      await writeAudit(tx, { ...ctx, entity: "user", entityId: created!.id, action: "create", before: null, after: userAuditJson(created!) });
      return { id: created!.id };
    });
  } catch (error) {
    throw isUniqueViolation(error) ? taken : error;
  }
}

async function loadUser(tx: DbOrTx, id: string): Promise<StoredUser> {
  const [row] = await tx.select().from(user).where(eq(user.id, id));
  if (!row) throw new PlanError(404, "not_found", "No such member");
  return row;
}

/** Removes a viewer: their sessions end at once. The owner account cannot be removed. */
export async function removeViewer(db: DbOrTx, id: string, ctx: AuditContext): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await loadUser(tx, id);
    if (row.role === "owner") throw new PlanError(400, "cannot_remove_owner", "The owner account cannot be removed");
    await tx.delete(user).where(eq(user.id, id)); // sessions cascade; audit and sign-in history keep the name
    await writeAudit(tx, { ...ctx, entity: "user", entityId: id, action: "delete", before: userAuditJson(row), after: null });
  });
}

/**
 * Stores a new password hash and signs the user out everywhere, except on `keepSessionId`
 * (the session that made the change, when a member changes their own password).
 * Returns how many sessions ended.
 */
export async function setPassword(db: DbOrTx, input: { userId: string; passwordHash: string; now: Date; keepSessionId?: string }, ctx: AuditContext): Promise<number> {
  return db.transaction(async (tx) => {
    const before = await loadUser(tx, input.userId);
    const [after] = await tx.update(user).set({ passwordHash: input.passwordHash, passwordChangedAt: input.now }).where(eq(user.id, input.userId)).returning();
    await writeAudit(tx, { ...ctx, entity: "user", entityId: input.userId, action: "update", before: userAuditJson(before), after: userAuditJson(after!) });
    return deleteUserSessions(tx, input.userId, input.keepSessionId);
  });
}

/**
 * Clears a member's second factor (a lost phone): the authenticator secret, the pending
 * replacement, the last used step and the member's passkeys are removed and every session ends. They enroll a
 * new authenticator at their next sign-in, before anything opens.
 */
export async function resetSecondFactor(db: DbOrTx, userId: string, ctx: AuditContext): Promise<void> {
  await db.transaction(async (tx) => {
    const before = await loadUser(tx, userId);
    const [after] = await tx.update(user).set({ totpSecretEnc: null, totpConfirmedAt: null, totpLastStep: null, totpPendingSecretEnc: null }).where(eq(user.id, userId)).returning();
    // The lost phone may hold the member's passkeys as well (audit a10-conformance-ledger-09): they go with the authenticator.
    const passkeys = await deleteUserPasskeys(tx, userId);
    await writeAudit(tx, { ...ctx, entity: "user", entityId: userId, action: "update", before: { ...userAuditJson(before), passkeys }, after: { ...userAuditJson(after!), passkeys: 0 } });
    await deleteUserSessions(tx, userId);
  });
}

/** Enrollment, step 1: a fresh secret (encrypted by the caller), not in force until a code proves it. No-op once enrolled. */
export async function startTotpEnrollment(db: DbOrTx, userId: string, secretEnc: string): Promise<boolean> {
  const rows = await db
    .update(user)
    .set({ totpSecretEnc: secretEnc, totpLastStep: null })
    .where(and(eq(user.id, userId), isNull(user.totpConfirmedAt)))
    .returning({ id: user.id });
  return rows.length > 0;
}

/** Enrollment, step 2: the code at `step` proved the secret. False when the user was enrolled already. */
export async function confirmTotpEnrollment(db: DbOrTx, input: { userId: string; step: number; now: Date }, ctx: AuditContext): Promise<boolean> {
  return db.transaction(async (tx) => {
    const before = await loadUser(tx, input.userId);
    const [after] = await tx
      .update(user)
      .set({ totpConfirmedAt: input.now, totpLastStep: input.step })
      .where(and(eq(user.id, input.userId), isNull(user.totpConfirmedAt), isNotNull(user.totpSecretEnc)))
      .returning();
    if (!after) return false;
    await writeAudit(tx, { ...ctx, entity: "user", entityId: input.userId, action: "update", before: userAuditJson(before), after: userAuditJson(after) });
    return true;
  });
}

/**
 * Takes a code's 30-second step if, and only if, it is later than the last one accepted for
 * this user (RFC 6238 section 5.2). One statement, so two requests carrying the same code
 * cannot both win. False means the code was already used (or an older one was replayed).
 */
export async function acceptTotpStep(db: DbOrTx, userId: string, step: number): Promise<boolean> {
  const rows = await db
    .update(user)
    .set({ totpLastStep: step })
    .where(and(eq(user.id, userId), or(isNull(user.totpLastStep), lt(user.totpLastStep, step))))
    .returning({ id: user.id });
  return rows.length > 0;
}

/** Replacing an authenticator, step 1: the new secret waits beside the current one, which stays in force. */
export async function setPendingTotpSecret(db: DbOrTx, userId: string, secretEnc: string | null): Promise<void> {
  await db.update(user).set({ totpPendingSecretEnc: secretEnc }).where(eq(user.id, userId));
}

/**
 * Replacing an authenticator, step 2: a code at `step` from the new one was proven, so it
 * takes over and the old secret is gone. Other sessions end (`keepSessionId` stays).
 * Returns how many sessions ended, or null when no replacement was pending.
 */
export async function activatePendingTotp(db: DbOrTx, input: { userId: string; step: number; now: Date; keepSessionId?: string }, ctx: AuditContext): Promise<number | null> {
  return db.transaction(async (tx) => {
    const before = await loadUser(tx, input.userId);
    const [after] = await tx
      .update(user)
      .set({ totpSecretEnc: sql`${user.totpPendingSecretEnc}`, totpPendingSecretEnc: null, totpConfirmedAt: input.now, totpLastStep: input.step })
      .where(and(eq(user.id, input.userId), isNotNull(user.totpPendingSecretEnc)))
      .returning();
    if (!after) return null;
    await writeAudit(tx, { ...ctx, entity: "user", entityId: input.userId, action: "update", before: userAuditJson(before), after: userAuditJson(after) });
    return deleteUserSessions(tx, input.userId, input.keepSessionId);
  });
}
