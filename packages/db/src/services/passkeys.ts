import { and, asc, eq, lt } from "drizzle-orm";
import type { DbOrTx } from "../index.js";
import { passkey, user, webauthnChallenge } from "../schema/index.js";
import { writeAudit, type AuditContext } from "./audit.js";

/**
 * Audit a10-conformance-ledger-09 (spec, Security and backups: "optional passkeys"): the stored
 * side of passkeys. The WebAuthn ceremonies (options, verification) run in the API; this keeps
 * the challenges they wait on and the credentials they create.
 */

/** How long a member has to answer a passkey prompt. */
export const WEBAUTHN_CHALLENGE_MS = 5 * 60_000;

export type WebauthnPurpose = (typeof webauthnChallenge.$inferSelect)["purpose"];

/** Store a challenge (adding a passkey: tied to the member and the session that asked) and return its id. Expired ones are removed on the way. */
export async function createWebauthnChallenge(db: DbOrTx, input: { purpose: WebauthnPurpose; challenge: string; userId?: string; sessionId?: string; now: Date }): Promise<string> {
  await db.delete(webauthnChallenge).where(lt(webauthnChallenge.expiresAt, input.now));
  const [row] = await db
    .insert(webauthnChallenge)
    .values({
      purpose: input.purpose,
      challenge: input.challenge,
      userId: input.userId ?? null,
      sessionId: input.sessionId ?? null,
      expiresAt: new Date(input.now.getTime() + WEBAUTHN_CHALLENGE_MS),
      createdAt: input.now,
    })
    .returning({ id: webauthnChallenge.id });
  return row!.id;
}

/**
 * Take a challenge for its answer: it is deleted whatever happens next (one answer per
 * challenge). Null when it does not exist, has expired, is for something else, or was issued
 * to another session.
 */
export async function takeWebauthnChallenge(db: DbOrTx, input: { id: string; purpose: WebauthnPurpose; sessionId?: string; now: Date }): Promise<{ challenge: string; userId: string | null } | null> {
  const [row] = await db.delete(webauthnChallenge).where(eq(webauthnChallenge.id, input.id)).returning();
  if (!row || row.purpose !== input.purpose || row.expiresAt.getTime() <= input.now.getTime()) return null;
  if (input.sessionId !== undefined && row.sessionId !== input.sessionId) return null;
  return { challenge: row.challenge, userId: row.userId };
}

export type PasskeyRow = typeof passkey.$inferSelect;

/** A member's passkeys, oldest first. */
export async function listPasskeys(db: DbOrTx, userId: string): Promise<PasskeyRow[]> {
  return db.select().from(passkey).where(eq(passkey.userId, userId)).orderBy(asc(passkey.createdAt), asc(passkey.id));
}

/** The passkey an answer names, with its member. */
export async function findPasskeyByCredentialId(db: DbOrTx, credentialId: string): Promise<(PasskeyRow & { username: string; role: "owner" | "viewer"; totpConfirmedAt: Date | null }) | undefined> {
  const [row] = await db
    .select({ passkey, username: user.username, role: user.role, totpConfirmedAt: user.totpConfirmedAt })
    .from(passkey)
    .innerJoin(user, eq(user.id, passkey.userId))
    .where(eq(passkey.credentialId, credentialId));
  return row ? { ...row.passkey, username: row.username, role: row.role, totpConfirmedAt: row.totpConfirmedAt } : undefined;
}

const names = (rows: readonly PasskeyRow[]) => rows.map((r) => r.name);

/** Add a verified passkey to a member. Audited as `user` (the names before and after, never a key). */
export async function addPasskey(
  db: DbOrTx,
  input: { userId: string; credentialId: string; publicKey: string; counter: number; transports: string[]; name: string; backedUp: boolean; now: Date },
  ctx: AuditContext,
): Promise<PasskeyRow> {
  return db.transaction(async (tx) => {
    const before = await listPasskeys(tx, input.userId);
    const [row] = await tx
      .insert(passkey)
      .values({ userId: input.userId, credentialId: input.credentialId, publicKey: input.publicKey, counter: input.counter, transports: input.transports, name: input.name, backedUp: input.backedUp, createdAt: input.now })
      .returning();
    await writeAudit(tx, { ...ctx, entity: "user", entityId: input.userId, action: "update", before: { passkeys: names(before) }, after: { passkeys: [...names(before), row!.name] } });
    return row!;
  });
}

/** After a sign-in with it: the authenticator's new counter and when it was used. */
export async function recordPasskeyUse(db: DbOrTx, id: string, counter: number, now: Date): Promise<void> {
  await db.update(passkey).set({ counter, lastUsedAt: now }).where(eq(passkey.id, id));
}

/** Remove one of a member's passkeys. False when the member has no such passkey. Audited as `user`. */
export async function deletePasskey(db: DbOrTx, userId: string, id: string, ctx: AuditContext): Promise<boolean> {
  return db.transaction(async (tx) => {
    const before = await listPasskeys(tx, userId);
    const gone = await tx.delete(passkey).where(and(eq(passkey.id, id), eq(passkey.userId, userId))).returning({ id: passkey.id });
    if (gone.length === 0) return false;
    await writeAudit(tx, { ...ctx, entity: "user", entityId: userId, action: "update", before: { passkeys: names(before) }, after: { passkeys: names(before.filter((p) => p.id !== id)) } });
    return true;
  });
}

/** Every passkey of a member goes (their second factor is cleared: a lost phone may hold them). Returns how many. */
export async function deleteUserPasskeys(db: DbOrTx, userId: string): Promise<number> {
  const gone = await db.delete(passkey).where(eq(passkey.userId, userId)).returning({ id: passkey.id });
  return gone.length;
}
