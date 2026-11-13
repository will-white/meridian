import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type DbClient } from "../index.js";
import { migrationsFolder, runMigrations } from "../migrate.js";
import { findLiveSession, sessionIdOf } from "../services/sessions.js";
import { TEST_DATABASE_URL, testDatabaseName } from "./db.js";

/**
 * Migration `auth_hardening` on a database that already has people signed in: the
 * statements written by hand (hashing the stored session ids, dropping password-only
 * sessions, backfilling the new NOT NULL column) are run against rows created under the
 * previous schema.
 */
describe.skipIf(!TEST_DATABASE_URL)("migration auth_hardening on existing sessions", () => {
  const databaseName = testDatabaseName();
  let db: Db;
  let client: DbClient;
  let before: string;
  let userId: string;
  const signedIn = "a".repeat(64); // the id a signed-in browser holds in its cookie
  const passwordOnly = "b".repeat(64);
  const expiresAt = "2026-12-01T00:00:00.000Z";

  beforeAll(async () => {
    const admin = postgres(TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${databaseName}"`);
    await admin.end();
    const url = new URL(TEST_DATABASE_URL!);
    url.pathname = `/${databaseName}`;
    ({ db, client } = createDb(url.toString(), { max: 2 }));

    // The migrations as they were before this one: the same folder with the journal cut just ahead of it.
    before = mkdtempSync(path.join(tmpdir(), "meridian-migrations-"));
    cpSync(migrationsFolder, before, { recursive: true });
    const journalPath = path.join(before, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
    const cut = journal.entries.findIndex((e) => e.tag.endsWith("_auth_hardening"));
    expect(cut).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, cut);
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: before, migrationsTable: "__drizzle_migrations" });

    const [u] = await db.execute<{ id: string }>(sql`insert into "user" ("username", "password_hash", "created_at") values ('owner', 'hash', '2026-01-05T08:00:00Z') returning "id"`);
    userId = u!.id;
    await db.execute(sql`insert into "session" ("id", "user_id", "expires_at", "totp_verified") values (${signedIn}, ${userId}, ${expiresAt}, true), (${passwordOnly}, ${userId}, ${expiresAt}, false)`);
  });
  afterAll(async () => {
    await client?.end();
    if (before) rmSync(before, { recursive: true, force: true });
    const drop = postgres(TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    await drop.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await drop.end();
  });

  it("keeps a signed-in browser signed in under the hash of its id, and drops the password-only session", async () => {
    await runMigrations(db);
    const rows = [...(await db.execute<{ id: string; idle: string; expires: string; failed_codes: number }>(sql`select "id", "idle_expires_at"::text as idle, "expires_at"::text as expires, "failed_codes" from "session"`))];
    expect(rows).toHaveLength(1);
    // SHA-256 of 64 "a" characters, computed here independently of the service.
    expect(rows[0]!.id).toBe(createHash("sha256").update(signedIn).digest("hex"));
    expect(rows[0]!.id).toBe(sessionIdOf(signedIn));
    expect(rows[0]!.idle).toBe(rows[0]!.expires);
    expect(rows[0]!.failed_codes).toBe(0);

    // The cookie the browser already holds still names its session; the old stored value names nothing.
    expect(await findLiveSession(db, signedIn, new Date("2026-11-10T09:00:00Z"))).toMatchObject({ userId, username: "owner", totpVerified: true });
    expect(await findLiveSession(db, passwordOnly, new Date("2026-11-10T09:00:00Z"))).toBeUndefined();
  });

  it("dates the existing password from the account's creation and starts with no used authenticator step", async () => {
    const [u] = await db.execute<{ changed: string; created: string; step: number | null; pending: string | null }>(
      sql`select "password_changed_at"::text as changed, "created_at"::text as created, "totp_last_step" as step, "totp_pending_secret_enc" as pending from "user"`,
    );
    expect(u!.changed).toBe(u!.created);
    expect(u).toMatchObject({ step: null, pending: null });
  });

  it("creates sign_in_event with its indexes", async () => {
    const indexes = [...(await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where tablename in ('sign_in_event', 'session') order by indexname`))].map((r) => r.indexname);
    expect(indexes).toEqual(["session_expires_idx", "session_pkey", "session_user_idx", "sign_in_event_at_idx", "sign_in_event_pkey", "sign_in_event_user_idx"]);
  });
});
