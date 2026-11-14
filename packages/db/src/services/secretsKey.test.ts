import { randomUUID } from "node:crypto";
import { eq, getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateSecretsKey } from "@meridian/shared";
import * as schema from "../schema/index.js";
import { connection, session, user } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/index.js";
import { checkSecretsKey, CONNECTION_KEY_LOST, ENCRYPTED_COLUMNS, resetSecretsKey, rotateSecretsKey, SECRETS_KEY_MISMATCH, verifySecretsKey } from "./secretsKey.js";

describe("encrypted columns (audit a7-backup-deploy-secrets-09)", () => {
  it("ENCRYPTED_COLUMNS names every *_enc column of the schema, so a rotation misses none", () => {
    const found: string[] = [];
    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      for (const column of Object.values(getTableColumns(value))) if (column.name.endsWith("_enc")) found.push(`${getTableName(value)}.${column.name}`);
    }
    expect(found.sort()).toEqual(ENCRYPTED_COLUMNS.map((c) => `${c.table}.${c.column}`).sort());
  });
});

describe.skipIf(!TEST_DATABASE_URL)("SECRETS_KEY at start-up, rotated and lost (audit a7-backup-deploy-secrets-06, -09)", () => {
  let t: TestDb;
  const keyA = generateSecretsKey();
  const keyB = generateSecretsKey();
  const audit = () => ({ userId: null, batchId: randomUUID() });
  let ownerId: string;
  let connectionId: string;

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => t?.cleanup());

  it("a new install accepts any key; stored secrets must open with it, or start-up stops with the reason", async () => {
    expect(await verifySecretsKey(t.db, keyA)).toBeNull();
    const [owner] = await t.db
      .insert(user)
      .values({ username: "owner", passwordHash: "x", role: "owner", totpSecretEnc: await encryptSecret("JBSWY3DPEHPK3PXP", keyA), totpConfirmedAt: new Date() })
      .returning({ id: user.id });
    ownerId = owner!.id;
    const [conn] = await t.db
      .insert(connection)
      .values({ type: "simplefin", name: "Bridge", accessUrlEnc: await encryptSecret("https://user:pass@bridge.simplefin.org/simplefin", keyA) })
      .returning({ id: connection.id });
    connectionId = conn!.id;

    expect(await verifySecretsKey(t.db, keyA)).toBeNull();
    await expect(verifySecretsKey(t.db, keyB)).rejects.toThrow(SECRETS_KEY_MISMATCH);
    expect(SECRETS_KEY_MISMATCH).toContain("SECRETS_KEY is not the key these secrets were encrypted with");
    expect(await checkSecretsKey(t.db, keyB)).toMatchObject({ stored: 2, readable: 0 });
    // One damaged value among good ones is a warning that names it, not a refusal.
    await t.db.update(user).set({ totpPendingSecretEnc: await encryptSecret("other", keyB) }).where(eq(user.id, ownerId));
    expect(await verifySecretsKey(t.db, keyA)).toContain(`user.totp_pending_secret_enc ${ownerId}`);
    await t.db.update(user).set({ totpPendingSecretEnc: null }).where(eq(user.id, ownerId));
  });

  it("rotate-secrets-key re-encrypts every secret under the new key in one transaction, and can run twice", async () => {
    const result = await rotateSecretsKey(t.db, keyA, keyB, audit());
    expect(result).toEqual({ reencrypted: 2, already: 0 });
    const [owner] = await t.db.select().from(user).where(eq(user.id, ownerId));
    const [conn] = await t.db.select().from(connection).where(eq(connection.id, connectionId));
    expect(await decryptSecret(owner!.totpSecretEnc!, keyB)).toBe("JBSWY3DPEHPK3PXP");
    expect(await decryptSecret(conn!.accessUrlEnc!, keyB)).toBe("https://user:pass@bridge.simplefin.org/simplefin");
    await expect(decryptSecret(conn!.accessUrlEnc!, keyA)).rejects.toThrow(/could not be decrypted with SECRETS_KEY/);
    expect(await verifySecretsKey(t.db, keyB)).toBeNull();
    // Run again with the same settings: nothing left to move.
    expect(await rotateSecretsKey(t.db, keyA, keyB, audit())).toEqual({ reencrypted: 0, already: 2 });

    // A value neither key opens stops the rotation before anything changes.
    const keyC = generateSecretsKey();
    await t.db.insert(connection).values({ type: "simplefin", name: "Stray", claimTokenEnc: await encryptSecret("token", generateSecretsKey()) });
    await expect(rotateSecretsKey(t.db, keyB, keyC, audit())).rejects.toThrow(/decrypts with neither SECRETS_KEY_OLD nor SECRETS_KEY; nothing was changed/);
    const [still] = await t.db.select().from(user).where(eq(user.id, ownerId));
    expect(await decryptSecret(still!.totpSecretEnc!, keyB)).toBe("JBSWY3DPEHPK3PXP");
    await t.db.delete(connection).where(eq(connection.name, "Stray"));
  });

  it("reset-secrets-key clears what the new key cannot open: authenticators as reset-totp does, connections told to be added again", async () => {
    await t.db.insert(session).values({ id: "hashed-session", userId: ownerId, expiresAt: new Date(Date.now() + 86_400_000), idleExpiresAt: new Date(Date.now() + 86_400_000), totpVerified: true });
    const keyLostReplacement = generateSecretsKey();
    const result = await resetSecretsKey(t.db, keyLostReplacement, audit());
    expect(result).toEqual({ members: ["owner"], connections: ["Bridge"] });
    const [owner] = await t.db.select().from(user).where(eq(user.id, ownerId));
    expect(owner).toMatchObject({ totpSecretEnc: null, totpConfirmedAt: null, totpPendingSecretEnc: null });
    expect(await t.db.select().from(session).where(eq(session.userId, ownerId))).toEqual([]);
    const [conn] = await t.db.select().from(connection).where(eq(connection.id, connectionId));
    expect(conn).toMatchObject({ accessUrlEnc: null, claimTokenEnc: null, status: "error", syncPaused: true, lastError: CONNECTION_KEY_LOST });
    // The app now starts with the replacement key.
    expect(await verifySecretsKey(t.db, keyLostReplacement)).toBeNull();
  });
});
