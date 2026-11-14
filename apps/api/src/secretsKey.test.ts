import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connection, SECRETS_KEY_MISMATCH, user } from "@meridian/db";
import { decryptSecret, encryptSecret, generateSecretsKey } from "@meridian/shared";
import { prepareDatabase } from "./boot.js";
import { ADMIN_USAGE, runAdminCommand } from "./lib/adminCommands.js";
import { createTestApp, signInOwner, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/**
 * SECRETS_KEY at start-up, rotated and lost (audit a7-backup-deploy-secrets-06 and -09): the
 * API refuses to start with a key that opens none of the stored secrets, and the recovery
 * command line can move the secrets to a new key or clear what a lost one locked.
 */
describe.skipIf(!TEST_DATABASE_URL)("SECRETS_KEY: start-up check, rotate-secrets-key, reset-secrets-key", () => {
  let t: TestApp;
  let ownerId: string;
  beforeAll(async () => {
    t = await createTestApp();
    await signInOwner(t);
    ownerId = (await t.db.db.select({ id: user.id }).from(user))[0]!.id;
    await t.db.db.insert(connection).values({ type: "simplefin", name: "Bridge", accessUrlEnc: await encryptSecret("https://u:p@bridge.simplefin.org/simplefin", t.app.config.secretsKey) });
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  async function run(env: NodeJS.ProcessEnv, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runAdminCommand(t.db.db, argv, { out: (line) => out.push(line), err: (line) => err.push(line), env });
    return { code, out, err };
  }

  it("a7-backup-deploy-secrets-06: the API does not start with a key that opens none of the stored secrets", async () => {
    expect(await prepareDatabase(t.db.db, { secretsKey: t.app.config.secretsKey })).toBeNull();
    await expect(prepareDatabase(t.db.db, { secretsKey: generateSecretsKey() })).rejects.toThrow(SECRETS_KEY_MISMATCH);
  });

  it("a7-backup-deploy-secrets-09: rotate-secrets-key moves every secret to the new key; the old one no longer starts the API", async () => {
    const oldKey = t.app.config.secretsKey;
    const newKey = generateSecretsKey();
    const missing = await run({ SECRETS_KEY: newKey }, "rotate-secrets-key");
    expect(missing.code).toBe(1);
    expect(missing.err[0]).toContain("SECRETS_KEY_OLD (or SECRETS_KEY_OLD_FILE) must be set");
    const bad = await run({ SECRETS_KEY: newKey, SECRETS_KEY_OLD: "ab".repeat(32) }, "rotate-secrets-key");
    expect(bad.err[0]).toContain("SECRETS_KEY_OLD must be 32 random bytes in base64");

    const done = await run({ SECRETS_KEY: newKey, SECRETS_KEY_OLD: oldKey }, "rotate-secrets-key");
    expect(done).toMatchObject({ code: 0, out: ["Re-encrypted 2 stored secret(s) with the new SECRETS_KEY.", expect.stringContaining("remove SECRETS_KEY_OLD")] });
    const [owner] = await t.db.db.select().from(user).where(eq(user.id, ownerId));
    expect(await decryptSecret(owner!.totpSecretEnc!, newKey)).toMatch(/^[A-Z2-7]+=*$/);
    expect(await prepareDatabase(t.db.db, { secretsKey: newKey })).toBeNull();
    await expect(prepareDatabase(t.db.db, { secretsKey: oldKey })).rejects.toThrow(SECRETS_KEY_MISMATCH);
    t.app.config.secretsKey = newKey;
  });

  it("a7-backup-deploy-secrets-09: reset-secrets-key shows what a lost key locked, and clears it only with --confirm", async () => {
    const replacement = generateSecretsKey();
    const preview = await run({ SECRETS_KEY: replacement }, "reset-secrets-key");
    expect(preview.code).toBe(1);
    expect(preview.out[0]).toBe("SECRETS_KEY opens 0 of the 2 stored secret(s). These cannot be read with it:");
    expect(preview.out.join("\n")).toContain(`user.totp_secret_enc ${ownerId}`);
    expect((await t.db.db.select().from(user).where(eq(user.id, ownerId)))[0]!.totpSecretEnc).not.toBeNull();

    expect((await run({ SECRETS_KEY: replacement }, "reset-secrets-key", "--yes")).code).toBe(2);
    const done = await run({ SECRETS_KEY: replacement }, "reset-secrets-key", "--confirm");
    expect(done.code).toBe(0);
    expect(done.out).toEqual([expect.stringContaining("Authenticator cleared (sign in with the password and set up a new one now): owner"), expect.stringContaining("new setup token (remove each and add it again on the Connections page): Bridge")]);
    expect(await prepareDatabase(t.db.db, { secretsKey: replacement })).toBeNull();
    expect((await run({ SECRETS_KEY: replacement }, "reset-secrets-key")).out[0]).toContain("there is nothing to reset");
    expect(ADMIN_USAGE).toContain("rotate-secrets-key");
  });
});
