import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type DbClient } from "../index.js";
import { migrationsFolder, runMigrations } from "../migrate.js";
import { connection, importLog, transaction } from "../schema/index.js";
import { TEST_DATABASE_URL, testDatabaseName } from "./db.js";

/**
 * Migration `ledger_conformance` (audit a10-conformance-ledger) on a database written before it:
 * a pair a rule's "not a transfer" broke (-03), a pair whose amounts no longer match (-06) and a
 * pair id left on one row (-01) are released, the ruled-out leg keeps the rule's choice, a
 * released leg gets its payee's default category back unless the household categorized it, a
 * healthy pair is untouched, and removing a connection no longer deletes its import logs (-04).
 */
describe.skipIf(!TEST_DATABASE_URL)("migration ledger_conformance on rows written before it", () => {
  const databaseName = testDatabaseName();
  let db: Db;
  let client: DbClient;
  let before: string;
  const ids: Record<string, string> = {};
  let connectionId: string;
  let logId: string;

  beforeAll(async () => {
    const admin = postgres(TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${databaseName}"`);
    await admin.end();
    const url = new URL(TEST_DATABASE_URL!);
    url.pathname = `/${databaseName}`;
    ({ db, client } = createDb(url.toString(), { max: 2 }));

    before = mkdtempSync(path.join(tmpdir(), "meridian-migrations-"));
    cpSync(migrationsFolder, before, { recursive: true });
    const journalPath = path.join(before, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
    const cut = journal.entries.findIndex((e) => e.tag.endsWith("_ledger_conformance"));
    expect(cut).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, cut);
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: before, migrationsTable: "__drizzle_migrations" });

    // Written with SQL: the tables are as they were before this migration.
    const one = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) => (await db.execute<T>(query))[0]!;
    const dining = (await one<{ id: string }>(sql`insert into "category" ("name", "bucket", "position") values ('Dining', 'spending', 1) returning "id"`)).id;
    const travel = (await one<{ id: string }>(sql`insert into "category" ("name", "bucket", "position") values ('Travel', 'spending', 2) returning "id"`)).id;
    const coffeePayee = (await one<{ id: string }>(sql`insert into "payee" ("name", "default_category_id") values ('Blue Bottle Coffee', ${dining}) returning "id"`)).id;
    const acct = async (name: string, type: string) => (await one<{ id: string }>(sql`insert into "account" ("name", "type", "tax_treatment") values (${name}, ${type}, 'none') returning "id"`)).id;
    const checking = await acct("Checking", "checking");
    const card = await acct("Card", "credit");
    const savings = await acct("Savings", "savings");
    const row = async (key: string, accountId: string, date: string, amountCents: bigint, description: string, pairId: string | null, isTransfer: boolean, extra: { payeeId?: string; categoryId?: string; locked?: boolean } = {}) => {
      ids[key] = (
        await one<{ id: string }>(sql`
          insert into "transaction" ("account_id", "source", "date", "amount_cents", "raw_description", "transfer_pair_id", "is_transfer", "payee_id", "category_id", "category_locked")
          values (${accountId}, 'manual', ${date}, ${amountCents}, ${description}, ${pairId}, ${isTransfer}, ${extra.payeeId ?? null}, ${extra.categoryId ?? null}, ${extra.locked ?? false})
          returning "id"`)
      ).id;
    };
    // -03: the rule ran on the Venmo leg and left the pair id; the coffee kept both.
    await row("venmo", checking, "2026-11-02", 4000n, "VENMO CASHOUT", "00000000-0000-4000-8000-0000000000a1", false);
    await row("coffee", card, "2026-11-03", -4000n, "BLUE BOTTLE COFFEE", "00000000-0000-4000-8000-0000000000a1", true, { payeeId: coffeePayee });
    // -01: a pair id on one row; the household had categorized it by hand.
    await row("lone", savings, "2026-10-10", 10000n, "TRANSFER IN", "00000000-0000-4000-8000-0000000000a2", true, { categoryId: travel, locked: true });
    // -06: the checking leg posted for another amount under its id.
    await row("outA", checking, "2026-10-10", -45000n, "ONLINE TRANSFER TO SAVINGS", "00000000-0000-4000-8000-0000000000a3", true);
    await row("inB", savings, "2026-10-11", 50000n, "ONLINE TRANSFER FROM CHECKING", "00000000-0000-4000-8000-0000000000a3", true);
    // A healthy pair.
    await row("out", checking, "2026-10-20", -20000n, "CARD PAYMENT", "00000000-0000-4000-8000-0000000000a4", true);
    await row("in", card, "2026-10-21", 20000n, "PAYMENT THANK YOU", "00000000-0000-4000-8000-0000000000a4", true);

    connectionId = (await one<{ id: string }>(sql`insert into "connection" ("type", "name") values ('simplefin', 'Bank') returning "id"`)).id;
    logId = (await one<{ id: string }>(sql`insert into "import_log" ("connection_id", "kind", "status", "raw_payload") values (${connectionId}, 'simplefin.sync', 'ok', '{"accounts": []}'::jsonb) returning "id"`)).id;

    await runMigrations(db);
  });

  afterAll(async () => {
    await client?.end();
    if (before) rmSync(before, { recursive: true, force: true });
    const drop = postgres(TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    await drop.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await drop.end();
  });

  const get = async (key: string) => (await db.select().from(transaction).where(eq(transaction.id, ids[key]!)))[0]!;

  it("releases the pairs that are not two equal and opposite transfers, and keeps the rule's choice on the ruled-out leg", async () => {
    expect(await get("venmo")).toMatchObject({ transferPairId: null, isTransfer: false, notTransfer: true });
    const dining = (await db.execute<{ id: string }>(sql`select "id" from "category" where "name" = 'Dining'`))[0]!.id;
    expect(await get("coffee")).toMatchObject({ transferPairId: null, isTransfer: false, notTransfer: false, categoryId: dining });
    const travel = (await db.execute<{ id: string }>(sql`select "id" from "category" where "name" = 'Travel'`))[0]!.id;
    expect(await get("lone")).toMatchObject({ transferPairId: null, isTransfer: false, categoryId: travel, categoryLocked: true });
    expect(await get("outA")).toMatchObject({ transferPairId: null, isTransfer: false });
    expect(await get("inB")).toMatchObject({ transferPairId: null, isTransfer: false });
    expect(await get("out")).toMatchObject({ transferPairId: "00000000-0000-4000-8000-0000000000a4", isTransfer: true, notTransfer: false });
    expect(await get("in")).toMatchObject({ transferPairId: "00000000-0000-4000-8000-0000000000a4", isTransfer: true });
  });

  it("keeps a connection's import logs when the connection is removed", async () => {
    await db.delete(connection).where(eq(connection.id, connectionId));
    expect(await db.select({ connectionId: importLog.connectionId }).from(importLog).where(eq(importLog.id, logId))).toEqual([{ connectionId: null }]);
  });
});
