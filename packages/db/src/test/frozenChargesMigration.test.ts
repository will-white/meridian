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
 * Migration `frozen_charges` (audit b1-plan-math, second round) on a database whose completed
 * months were already frozen: `month_plan.frozen_charge_ids` records the linked charges a
 * value frozen from recurring items counts, so `plan.close_month` can add a charge dated in
 * the month that reaches the ledger later. Rows frozen before the column existed are given the
 * charges their category's planning items hold in that month now (the statement written by
 * hand); typed, averaged and goal rows, and rows without a planned value, get nothing.
 */
describe.skipIf(!TEST_DATABASE_URL)("migration frozen_charges on months already frozen", () => {
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

    // The migrations as they were before this one: the same folder with the journal cut just ahead of it.
    before = mkdtempSync(path.join(tmpdir(), "meridian-migrations-"));
    cpSync(migrationsFolder, before, { recursive: true });
    const journalPath = path.join(before, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
    const cut = journal.entries.findIndex((e) => e.tag.endsWith("_frozen_charges"));
    expect(cut).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, cut);
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: before, migrationsTable: "__drizzle_migrations" });

    const one = async (key: string, query: ReturnType<typeof sql>) => {
      const [row] = [...(await db.execute<{ id: string }>(query))];
      ids[key] = row!.id;
    };
    await one("checking", sql`insert into "account" ("name", "type", "tax_treatment") values ('Checking', 'checking', 'none') returning "id"`);
    for (const [key, name, bucket] of [
      ["rentCat", "Rent", "bills"],
      ["homeCat", "Home", "bills"],
      ["diningCat", "Dining", "spending"],
    ] as const) {
      await one(key, sql`insert into "category" ("name", "bucket") values (${name}, ${bucket}) returning "id"`);
    }
    for (const [key, name] of [
      ["landlord", "Landlord"],
      ["alarmCo", "Alarm Co"],
      ["gymCo", "Gym Co"],
    ] as const) {
      await one(key, sql`insert into "payee" ("name") values (${name}) returning "id"`);
    }
    const item = (key: string, payee: string, name: string, categoryKey: string, anchorDay: number, cents: bigint, status: string) =>
      one(
        key,
        sql`insert into "recurring" ("payee_id", "name", "category_id", "account_id", "cadence", "anchor_day", "expected_cents", "source", "status")
            values (${ids[payee]!}, ${name}, ${ids[categoryKey]!}, ${ids["checking"]!}, 'monthly', ${anchorDay}, ${cents}, 'manual', ${status}) returning "id"`,
      );
    await item("rent", "landlord", "Rent", "rentCat", 1, -150000n, "active");
    await item("alarm", "alarmCo", "Alarm", "homeCat", 10, -3000n, "cancelled"); // a cancelled item keeps what it was paid
    await item("gym", "gymCo", "Gym", "homeCat", 12, -4000n, "suggested"); // a suggestion plans nothing
    const charge = (key: string, date: string, cents: bigint, recurringKey: string | null) =>
      one(
        key,
        sql`insert into "transaction" ("account_id", "source", "date", "amount_cents", "raw_description", "recurring_id")
            values (${ids["checking"]!}, 'manual', ${date}, ${cents}, ${key}, ${recurringKey === null ? null : ids[recurringKey]!}) returning "id"`,
      );
    await charge("rentJan2", "2026-01-02", -150000n, "rent");
    await charge("rentJan30", "2026-01-30", -150000n, "rent"); // the February rent paid early
    await charge("rentFeb27", "2026-02-27", -150000n, "rent");
    await charge("alarmJan10", "2026-01-10", -3000n, "alarm");
    await charge("gymJan12", "2026-01-12", -4000n, "gym");
    await charge("dinner", "2026-01-15", -6000n, null);
    const cell = (key: string, categoryKey: string, month: string, cents: bigint | null, source: string | null, note: string | null = null) =>
      one(
        key,
        sql`insert into "month_plan" ("category_id", "month", "planned_cents", "planned_source", "note") values (${ids[categoryKey]!}, ${month}, ${cents}, ${source}, ${note}) returning "id"`,
      );
    await cell("rentJanCell", "rentCat", "2026-01", 300000n, "recurring");
    await cell("homeJanCell", "homeCat", "2026-01", 3000n, "recurring");
    await cell("diningJanCell", "diningCat", "2026-01", 20000n, "manual");
    await cell("rentFebCell", "rentCat", "2026-02", 150000n, "recurring");
    await cell("homeFebCell", "homeCat", "2026-02", null, null, "check the alarm contract");
    await cell("rentMarCell", "rentCat", "2026-03", 150000n, "recurring"); // nothing linked in March (yet)
  });
  afterAll(async () => {
    await client?.end();
    if (before) rmSync(before, { recursive: true, force: true });
    const drop = postgres(TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    await drop.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await drop.end();
  });

  it("gives each row frozen from recurring items the charges its category's items hold in its month, and nothing to the others", async () => {
    await runMigrations(db);
    const rows = [...(await db.execute<{ id: string; ids: string[] | null }>(sql`select "id", "frozen_charge_ids"::text[] as ids from "month_plan"`))];
    const label = (id: string) => Object.keys(ids).find((k) => ids[k] === id);
    const byCell = Object.fromEntries(rows.map((r) => [label(r.id), r.ids === null ? null : r.ids.map(label).sort()]));
    expect(byCell).toEqual({
      rentJanCell: ["rentJan2", "rentJan30"],
      homeJanCell: ["alarmJan10"], // not the suggested gym's charge
      diningJanCell: null,
      rentFebCell: ["rentFeb27"],
      homeFebCell: null,
      rentMarCell: [],
    });
    // The values themselves are left as they were.
    const [jan] = [...(await db.execute<{ cents: string }>(sql`select "planned_cents"::text as cents from "month_plan" where "id" = ${ids["rentJanCell"]!}`))];
    expect(jan!.cents).toBe("300000");
  });
});
