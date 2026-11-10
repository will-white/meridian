import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type DbClient } from "../index.js";
import { migrationsFolder, runMigrations } from "../migrate.js";
import { account, category, investmentTxn, security, transaction } from "../schema/index.js";
import { loadFlowRows } from "../services/performance.js";
import { TEST_DATABASE_URL } from "./db.js";

/**
 * Migration `linked_cash_transfers` on a database whose trade history was imported before the
 * linker marked the bank rows it matched (docs/phase-3-plan.md, audit decision A5): a bank row
 * an investment cash transfer is linked to becomes a transfer, an unlocked category goes and a
 * locked one stays; rows linked to income, and rows nothing is linked to, are left alone.
 */
describe.skipIf(!TEST_DATABASE_URL)("migration linked_cash_transfers on links made before it", () => {
  const databaseName = `meridian_test_${randomBytes(6).toString("hex")}`;
  let db: Db;
  let client: DbClient;
  let before: string;
  let brokerage: string;

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
    const cut = journal.entries.findIndex((e) => e.tag.endsWith("_linked_cash_transfers"));
    expect(cut).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, cut);
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: before, migrationsTable: "__drizzle_migrations" });

    const [a] = await db.insert(account).values({ name: "Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false }).returning({ id: account.id });
    brokerage = a!.id;
    const [income] = await db.insert(category).values({ name: "Other income", bucket: "income", position: 1 }).returning({ id: category.id });
    const [vti] = await db.insert(security).values({ ticker: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf", assetClass: "us_stock", priceMode: "provider" }).returning({ id: security.id });
    const bank = await db
      .insert(transaction)
      .values([
        // Linked deposits the ingest classifier did not recognise: one with a payee-default category, one the owner categorized by hand.
        { accountId: brokerage, source: "simplefin", externalId: "B1", date: "2026-09-14", amountCents: 500000n, rawDescription: "MONEYLINK TXN FROM CHK 1234", categoryId: income!.id },
        { accountId: brokerage, source: "simplefin", externalId: "B2", date: "2026-09-18", amountCents: 250000n, rawDescription: "BRANCH CREDIT 0042", categoryId: income!.id, categoryLocked: true },
        // A linked withdrawal (outflows were never classified).
        { accountId: brokerage, source: "simplefin", externalId: "B3", date: "2026-09-25", amountCents: -20000n, rawDescription: "ACH WITHDRAWAL" },
        // Linked to a dividend, and a row nothing is linked to: neither is a transfer.
        { accountId: brokerage, source: "simplefin", externalId: "B4", date: "2026-09-28", amountCents: 1234n, rawDescription: "DIV VTI", categoryId: income!.id },
        { accountId: brokerage, source: "simplefin", externalId: "B5", date: "2026-09-29", amountCents: 900n, rawDescription: "MISC CREDIT", categoryId: income!.id },
        // Already a transfer: untouched.
        { accountId: brokerage, source: "simplefin", externalId: "B6", date: "2026-09-30", amountCents: 100000n, rawDescription: "ELECTRONIC FUNDS TRANSFER RECEIVED", isTransfer: true },
      ])
      .returning({ id: transaction.id, externalId: transaction.externalId });
    const id = (ext: string) => bank.find((r) => r.externalId === ext)!.id;
    const cash = (date: string, amountCents: bigint, ext: string) => ({
      accountId: brokerage,
      securityId: null,
      date,
      type: "transfer" as const,
      transferDirection: amountCents > 0n ? ("in" as const) : ("out" as const),
      amountCents,
      source: "csv" as const,
      ledgerTransactionId: id(ext),
    });
    await db.insert(investmentTxn).values([
      cash("2026-09-14", 500000n, "B1"),
      cash("2026-09-18", 250000n, "B2"),
      cash("2026-09-25", -20000n, "B3"),
      { accountId: brokerage, securityId: vti!.id, date: "2026-09-28", type: "dividend", amountCents: 1234n, source: "csv", ledgerTransactionId: id("B4") },
      cash("2026-09-30", 100000n, "B6"),
    ]);
  });
  afterAll(async () => {
    await client?.end();
    if (before) rmSync(before, { recursive: true, force: true });
    const drop = postgres(TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    await drop.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await drop.end();
  });

  it("marks the bank rows of linked deposits and withdrawals as transfers and leaves the rest alone", async () => {
    await runMigrations(db);
    const rows = await db
      .select({ externalId: transaction.externalId, isTransfer: transaction.isTransfer, categorized: transaction.categoryId, locked: transaction.categoryLocked, amountCents: transaction.amountCents, date: transaction.date })
      .from(transaction)
      .where(eq(transaction.accountId, brokerage))
      .orderBy(asc(transaction.externalId));
    expect(rows.map((r) => [r.externalId, r.isTransfer, r.categorized !== null, r.locked, r.amountCents, r.date])).toEqual([
      ["B1", true, false, false, 500000n, "2026-09-14"],
      ["B2", true, true, true, 250000n, "2026-09-18"],
      ["B3", true, false, false, -20000n, "2026-09-25"],
      ["B4", false, true, false, 1234n, "2026-09-28"],
      ["B5", false, true, false, 900n, "2026-09-29"],
      ["B6", true, false, false, 100000n, "2026-09-30"],
    ]);
    // Each deposit and the withdrawal is one flow, read from the ledger: 5,000.00 + 2,500.00 − 200.00 + 1,000.00.
    const flows = await loadFlowRows(db, [brokerage], "2026-09-01", "2026-09-30");
    expect(flows.map((f) => [f.date, f.amountCents, f.source])).toEqual([
      ["2026-09-14", 500000n, "ledger"],
      ["2026-09-18", 250000n, "ledger"],
      ["2026-09-25", -20000n, "ledger"],
      ["2026-09-30", 100000n, "ledger"],
    ]);
  });
});
