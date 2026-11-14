import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type DbClient } from "../index.js";
import { migrationsFolder, runMigrations } from "../migrate.js";
import { transaction } from "../schema/index.js";
import { TEST_DATABASE_URL, testDatabaseName } from "./db.js";

/**
 * Migration `ledger_decisions` (audit a10-conformance-ledger, second round) on a database written
 * before it: the legs of a pair the household made by hand (pairing by hand audits the pair id it
 * gave each leg) are marked as decided by hand, so the rules leave them alone; an automatic pair,
 * and a hand pair undone since (its legs no longer carry that pair id), are not. Existing pending
 * rows have no last day seen yet: the next sync that lists an undated hold gives it one.
 */
describe.skipIf(!TEST_DATABASE_URL)("migration ledger_decisions on rows written before it", () => {
  const databaseName = testDatabaseName();
  let db: Db;
  let client: DbClient;
  let before: string;
  const ids: Record<string, string> = {};

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
    const cut = journal.entries.findIndex((e) => e.tag.endsWith("_ledger_decisions"));
    expect(cut).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, cut);
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: before, migrationsTable: "__drizzle_migrations" });

    // Written with SQL: the table is as it was before this migration.
    const one = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) => (await db.execute<T>(query))[0]!;
    const acct = async (name: string, type: string) => (await one<{ id: string }>(sql`insert into "account" ("name", "type", "tax_treatment") values (${name}, ${type}, 'none') returning "id"`)).id;
    const checking = await acct("Checking", "checking");
    const venmo = await acct("Venmo", "checking");
    const row = async (key: string, accountId: string, amountCents: bigint, pairId: string | null, isTransfer: boolean, pending = false) => {
      ids[key] = (
        await one<{ id: string }>(sql`
          insert into "transaction" ("account_id", "source", "date", "amount_cents", "raw_description", "transfer_pair_id", "is_transfer", "pending")
          values (${accountId}, 'manual', '2026-10-20', ${amountCents}, ${key}, ${pairId}, ${isTransfer}, ${pending})
          returning "id"`)
      ).id;
    };
    const handAudit = async (rowId: string, pairId: string) => {
      await db.execute(sql`
        insert into "audit_log" ("batch_id", "entity", "entity_id", "action", "before", "after")
        values (${randomUUID()}, 'transaction', ${rowId}, 'update', ${JSON.stringify({ isTransfer: false, transferPairId: null })}::jsonb, ${JSON.stringify({ isTransfer: true, transferPairId: pairId })}::jsonb)`);
    };
    const hand = randomUUID();
    await row("handOut", venmo, -4000n, hand, true);
    await row("handIn", checking, 4000n, hand, true);
    await handAudit(ids["handOut"]!, hand);
    await handAudit(ids["handIn"]!, hand);
    const auto = randomUUID();
    await row("autoOut", checking, -9000n, auto, true);
    await row("autoIn", venmo, 9000n, auto, true);
    // Paired by hand once, undone since, and paired automatically again under another id.
    const undone = randomUUID();
    const again = randomUUID();
    await row("againOut", checking, -1500n, again, true);
    await row("againIn", venmo, 1500n, again, true);
    await handAudit(ids["againOut"]!, undone);
    await handAudit(ids["againIn"]!, undone);
    await row("hold", checking, -41280n, null, false, true);

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

  it("marks the legs of a pair made by hand as decided by hand, and nothing else", async () => {
    expect(await get("handOut")).toMatchObject({ transferLocked: true, isTransfer: true });
    expect(await get("handIn")).toMatchObject({ transferLocked: true, isTransfer: true });
    for (const key of ["autoOut", "autoIn", "againOut", "againIn"]) expect(await get(key), key).toMatchObject({ transferLocked: false, isTransfer: true });
    expect(await get("hold")).toMatchObject({ transferLocked: false, pending: true, pendingSeenThrough: null });
  });
});
