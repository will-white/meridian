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
 * Migration `sync_attempts` on a database that already has connections: the scheduler now
 * spaces syncs from `last_attempt_at`, so the statement written by hand has to give the
 * connections that were syncing a value, or every one of them would be due at once.
 */
describe.skipIf(!TEST_DATABASE_URL)("migration sync_attempts on existing connections", () => {
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
    const cut = journal.entries.findIndex((e) => e.tag.endsWith("_sync_attempts"));
    expect(cut).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, cut);
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: before, migrationsTable: "__drizzle_migrations" });

    await db.execute(sql`
      insert into "connection" ("type", "name", "status", "last_sync_at", "synced_through") values
        ('simplefin', 'Syncing', 'ok', '2026-11-10T03:00:00Z', '2026-11-10'),
        ('simplefin', 'Never worked', 'error', null, null),
        ('csv', 'Credit Union', 'ok', '2026-10-01T12:00:00Z', null)
    `);
  });
  afterAll(async () => {
    await client?.end();
    if (before) rmSync(before, { recursive: true, force: true });
    const drop = postgres(TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    await drop.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await drop.end();
  });

  it("dates the last attempt of a syncing connection from its last sync, pauses nothing and leaves the mark alone", async () => {
    await runMigrations(db);
    const rows = [
      ...(await db.execute<{ name: string; attempt: string | null; sync: string | null; paused: boolean; through: string | null }>(
        sql`select "name", "last_attempt_at"::text as attempt, "last_sync_at"::text as sync, "sync_paused" as paused, "synced_through"::text as through from "connection" order by "name"`,
      )),
    ];
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    // Spaced from 03:00: the next scheduled sync is at 09:00, as it would have been.
    expect(byName["Syncing"]!.attempt).toBe(byName["Syncing"]!.sync);
    expect(byName["Syncing"]).toMatchObject({ paused: false, through: "2026-11-10" });
    // Never tried as far as the old schema knows: due once, then spaced from that attempt.
    expect(byName["Never worked"]).toMatchObject({ attempt: null, paused: false });
    // A csv profile's "last sync" is its last import; it has no attempts.
    expect(byName["Credit Union"]).toMatchObject({ attempt: null, paused: false });
    expect(byName["Credit Union"]!.sync).not.toBeNull();
  });
});
