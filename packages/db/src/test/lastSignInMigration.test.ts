import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type DbClient } from "../index.js";
import { migrationsFolder, runMigrations } from "../migrate.js";
import { TEST_DATABASE_URL, testDatabaseName } from "./db.js";

/**
 * Migration `last_sign_in` (audit a2-auth-users N3) on a database that already has members:
 * the last sign-in moves from the sign-in activity (kept 90 days) to the member's row, so the
 * statement written by hand fills it from the activity there is, sign-ins only.
 */
describe.skipIf(!TEST_DATABASE_URL)("migration last_sign_in on existing members", () => {
  const databaseName = testDatabaseName();
  let db: Db;
  let client: DbClient;
  let before: string;

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
    const cut = journal.entries.findIndex((e) => e.tag.endsWith("_last_sign_in"));
    expect(cut).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, cut);
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: before, migrationsTable: "__drizzle_migrations" });

    await db.execute(sql`
      insert into "user" ("username", "password_hash", "role") values
        ('owner', 'hash', 'owner'), ('Sam', 'hash', 'viewer'), ('Pat', 'hash', 'viewer'), ('Robin', 'hash', 'viewer')
    `);
    await db.execute(sql`
      insert into "sign_in_event" ("at", "user_id", "username", "kind")
      select v.at::timestamptz, u.id, u.username, v.kind
      from (values
        ('owner', '2026-11-10T18:00:00.123456Z', 'signed_in'),
        ('owner', '2026-11-12T07:30:00.654321Z', 'passkey_signed_in'),
        ('owner', '2026-11-13T09:00:00Z', 'password_failed'),
        ('Sam', '2026-11-11T20:15:00Z', 'signed_in'),
        ('Sam', '2026-11-12T21:00:00Z', 'code_lockout'),
        ('Pat', '2026-11-12T08:00:00Z', 'password_failed')
      ) as v(username, at, kind)
      join "user" u on u.username = v.username
    `);
  });
  afterAll(async () => {
    await client?.end();
    if (before) rmSync(before, { recursive: true, force: true });
    const drop = postgres(TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    await drop.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await drop.end();
  });

  it("gives each member the time of their latest sign-in, password or passkey, and nothing to one who never signed in", async () => {
    await runMigrations(db);
    const rows = [...(await db.execute<{ username: string; last: string | null }>(sql`select "username", to_char("last_sign_in_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as last from "user" order by "username"`))];
    expect(Object.fromEntries(rows.map((r) => [r.username, r.last]))).toEqual({
      owner: "2026-11-12T07:30:00.654321", // the passkey sign-in, not the wrong password after it
      Pat: null, // a wrong password is not a sign-in
      Robin: null,
      Sam: "2026-11-11T20:15:00.000000",
    });
  });
});
