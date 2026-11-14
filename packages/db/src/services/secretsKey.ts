import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { user } from "../schema/auth.js";
import { connection } from "../schema/sources.js";
import { writeAudit, type AuditContext } from "./audit.js";
import { resetSecondFactor } from "./users.js";

/**
 * Everything stored encrypted with SECRETS_KEY (audit a7-backup-deploy-secrets-06 and -09).
 * A test checks this list against every `*_enc` column of the schema.
 */
export const ENCRYPTED_COLUMNS = [
  { table: "user", column: "totp_secret_enc" },
  { table: "user", column: "totp_pending_secret_enc" },
  { table: "connection", column: "access_url_enc" },
  { table: "connection", column: "claim_token_enc" },
] as const;

interface StoredSecret {
  table: "user" | "connection";
  column: (typeof ENCRYPTED_COLUMNS)[number]["column"];
  id: string;
  value: string;
}

async function storedSecrets(db: DbOrTx): Promise<StoredSecret[]> {
  const users = await db.select({ id: user.id, totp: user.totpSecretEnc, pending: user.totpPendingSecretEnc }).from(user);
  const connections = await db.select({ id: connection.id, accessUrl: connection.accessUrlEnc, claimToken: connection.claimTokenEnc }).from(connection);
  const out: StoredSecret[] = [];
  for (const u of users) {
    if (u.totp) out.push({ table: "user", column: "totp_secret_enc", id: u.id, value: u.totp });
    if (u.pending) out.push({ table: "user", column: "totp_pending_secret_enc", id: u.id, value: u.pending });
  }
  for (const c of connections) {
    if (c.accessUrl) out.push({ table: "connection", column: "access_url_enc", id: c.id, value: c.accessUrl });
    if (c.claimToken) out.push({ table: "connection", column: "claim_token_enc", id: c.id, value: c.claimToken });
  }
  return out;
}

async function opens(value: string, key: string): Promise<boolean> {
  try {
    await decryptSecret(value, key);
    return true;
  } catch {
    return false;
  }
}

export interface SecretsKeyCheck {
  /** How many encrypted values the database holds. */
  stored: number;
  /** How many of them `key` decrypts. */
  readable: number;
  /** The ones it does not ("user.totp_secret_enc <id>"). */
  unreadable: string[];
}

/** Try `key` on every stored secret (a handful of rows: the members and the connections). */
export async function checkSecretsKey(db: DbOrTx, key: string): Promise<SecretsKeyCheck> {
  const secrets = await storedSecrets(db);
  const unreadable: string[] = [];
  for (const s of secrets) if (!(await opens(s.value, key))) unreadable.push(`${s.table}.${s.column} ${s.id}`);
  return { stored: secrets.length, readable: secrets.length - unreadable.length, unreadable };
}

export const SECRETS_KEY_MISMATCH =
  "SECRETS_KEY is not the key these secrets were encrypted with: none of the stored secrets (authenticator secrets, SimpleFIN access URLs) decrypts with it. " +
  "Put the original key back in .env (or its secret file). If it is lost for good, run `node apps/api/dist/admin.js reset-secrets-key` (README, \"The encryption key\").";

/**
 * The start-up check of the API and the worker. Throws SECRETS_KEY_MISMATCH when secrets are
 * stored and the key opens none of them; returns a warning (or null) when only some do not.
 * A database without secrets (a new install) accepts any key.
 */
export async function verifySecretsKey(db: DbOrTx, key: string): Promise<string | null> {
  const check = await checkSecretsKey(db, key);
  if (check.stored > 0 && check.readable === 0) throw new Error(SECRETS_KEY_MISMATCH);
  if (check.unreadable.length > 0) return `${check.unreadable.length} stored secret(s) do not decrypt with SECRETS_KEY and are damaged or left from another key: ${check.unreadable.join(", ")}`;
  return null;
}

export interface RotationResult {
  reencrypted: number;
  /** Values that the new key already opened (a rotation that was run before). */
  already: number;
}

/**
 * Re-encrypt every stored secret from `oldKey` to `newKey` in one transaction: either all of
 * them move or none does. A value neither key opens stops the rotation and names it.
 */
export async function rotateSecretsKey(db: Db, oldKey: string, newKey: string, ctx: AuditContext): Promise<RotationResult> {
  if (oldKey === newKey) throw new Error("SECRETS_KEY_OLD and SECRETS_KEY are the same key; generate a new one with `openssl rand -base64 32`");
  return db.transaction(async (tx) => {
    let reencrypted = 0;
    let already = 0;
    for (const s of await storedSecrets(tx)) {
      let plaintext: string;
      try {
        plaintext = await decryptSecret(s.value, oldKey);
      } catch {
        if (await opens(s.value, newKey)) {
          already++;
          continue;
        }
        throw new Error(`${s.table}.${s.column} ${s.id} decrypts with neither SECRETS_KEY_OLD nor SECRETS_KEY; nothing was changed`);
      }
      const value = await encryptSecret(plaintext, newKey);
      if (s.table === "user") {
        await tx.update(user).set(s.column === "totp_secret_enc" ? { totpSecretEnc: value } : { totpPendingSecretEnc: value }).where(eq(user.id, s.id));
      } else {
        await tx.update(connection).set(s.column === "access_url_enc" ? { accessUrlEnc: value } : { claimTokenEnc: value }).where(eq(connection.id, s.id));
      }
      await writeAudit(tx, { ...ctx, entity: s.table, entityId: s.id, action: "update", before: { [s.column]: "encrypted with the previous key" }, after: { [s.column]: "encrypted with the new key" } });
      reencrypted++;
    }
    return { reencrypted, already };
  });
}

export const CONNECTION_KEY_LOST =
  "The encryption key was replaced, so this connection's access URL can no longer be read. Remove the connection and add it again with a new setup token from the SimpleFIN Bridge; its accounts are kept.";

export interface ResetResult {
  /** Members whose authenticator was cleared (they enroll a new one at their next sign-in). */
  members: string[];
  /** Connections that need a new setup token. */
  connections: string[];
}

/**
 * The key is lost: clear every stored secret that `key` (the new one) cannot open. Members'
 * authenticators are cleared as `reset-totp` does (sessions ended, audited); connections lose
 * their access URL and setup token, stop syncing and say what to do. Values the key opens stay.
 */
export async function resetSecretsKey(db: Db, key: string, ctx: AuditContext): Promise<ResetResult> {
  const result: ResetResult = { members: [], connections: [] };
  const lost = new Map<string, Set<string>>();
  for (const s of await storedSecrets(db)) {
    if (await opens(s.value, key)) continue;
    const ids = lost.get(s.table) ?? new Set<string>();
    ids.add(s.id);
    lost.set(s.table, ids);
  }
  for (const id of lost.get("user") ?? []) {
    await resetSecondFactor(db, id, ctx);
    const [row] = await db.select({ username: user.username }).from(user).where(eq(user.id, id));
    result.members.push(row?.username ?? id);
  }
  for (const id of lost.get("connection") ?? []) {
    await db.transaction(async (tx) => {
      const [before] = await tx.select({ name: connection.name, status: connection.status }).from(connection).where(eq(connection.id, id));
      await tx
        .update(connection)
        .set({ accessUrlEnc: null, claimTokenEnc: null, status: "error", syncPaused: true, lastError: CONNECTION_KEY_LOST, updatedAt: new Date() })
        .where(eq(connection.id, id));
      await writeAudit(tx, { ...ctx, entity: "connection", entityId: id, action: "update", before: { status: before?.status ?? null, secrets: "unreadable" }, after: { status: "error", secrets: "cleared" } });
      result.connections.push(before?.name ?? id);
    });
  }
  return result;
}
