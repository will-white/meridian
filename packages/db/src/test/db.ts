import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { createDb, type Db, type DbClient } from "../index.js";
import { runMigrations } from "../migrate.js";

export interface TestDb {
  db: Db;
  client: DbClient;
  databaseName: string;
  cleanup: () => Promise<void>;
}

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/**
 * Every suite gets its own throwaway database with the real migrations applied, so
 * suites run back to back against one server without touching each other. The
 * role in TEST_DATABASE_URL needs CREATEDB.
 */
export async function createTestDb(): Promise<TestDb> {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set");
  const databaseName = `meridian_test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${databaseName}"`);
  await admin.end();

  const url = withDatabase(TEST_DATABASE_URL, databaseName);
  const { db, client } = createDb(url, { max: 4 });
  await runMigrations(db);

  return {
    db,
    client,
    databaseName,
    cleanup: async () => {
      await client.end();
      const drop = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
      await drop.unsafe(`drop database "${databaseName}" with (force)`);
      await drop.end();
    },
  };
}
