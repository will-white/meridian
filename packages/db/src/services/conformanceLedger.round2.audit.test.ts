import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoDateToUtcMs, mapCsvRows, mapTradesCsvRows, type CsvMappingInput, type IsoDate, type MappedRow, type SimplefinAccountSet, type TradesCsvMappingInput } from "@meridian/shared";
import type { Db } from "../index.js";
import { account, connection, importLog, rule, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { csvDuplicateIds, importCsvRows } from "./csvImport.js";
import { ingestTransactions } from "./ingest.js";
import { createInvestmentTxn, importTrades } from "./investmentTxns.js";
import { LEDGER_LOCK_ORDER_MESSAGE, lockLedger, setLedgerLockOrderCheck } from "./ledgerLock.js";
import { clearStaleNotTransfer, loadRules, runRules } from "./rules.js";
import { applyAccountSet } from "./sync.js";
import { updateTransaction } from "./transactions.js";
import { pairTransactionsByHand, pairTransfersInDb } from "./transfers.js";

type SfTxn = SimplefinAccountSet["accounts"][number]["transactions"][number];

const unix = (date: IsoDate, hour = 12) => Math.floor(isoDateToUtcMs(date) / 1000) + hour * 3600;
const at = (date: IsoDate) => new Date(`${date}T18:00:00Z`);
const audit = () => ({ userId: null, batchId: randomUUID() });

const TRADES_HEADER = ["Date", "Action", "Symbol", "Quantity", "Price", "Fees", "Amount", "Id"];
const TRADES_MAPPING: TradesCsvMappingInput = {
  hasHeader: true,
  date: { column: "Date", format: "YYYY-MM-DD" },
  action: { column: "Action" },
  symbol: { column: "Symbol" },
  quantity: { column: "Quantity" },
  price: { column: "Price" },
  fee: { columns: ["Fees"] },
  amount: { column: "Amount" },
  externalId: { column: "Id" },
};

const BANK_HEADER = ["Date", "Description", "Amount", "Reference", "Transaction ID"];
const BANK_MAPPING: CsvMappingInput = {
  hasHeader: true,
  date: { column: "Date", format: "YYYY-MM-DD" },
  description: { column: "Description" },
  amount: { mode: "single", column: "Amount" },
};

async function bankRows(lines: string[][], idColumn?: string): Promise<MappedRow[]> {
  const { rows, errors } = await mapCsvRows([BANK_HEADER, ...lines], idColumn ? { ...BANK_MAPPING, externalId: { column: idColumn } } : BANK_MAPPING);
  expect(errors).toEqual([]);
  return rows;
}

/** Wait until another session of this database waits on a lock (the advisory ledger lock, or a row). */
async function untilSomeoneWaits(db: Db): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [r] = await db.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
    if (Number(r?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("nobody waited on a lock");
}

const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => {
      const err = e as { code?: string; cause?: { code?: string; message?: string }; message: string };
      return `failed ${err.cause?.code ?? err.code ?? ""} ${err.cause?.message ?? err.message}`;
    },
  );

/**
 * Audit batch a10-conformance-ledger, second round: the ledger lock taken before a write, a
 * CSV id that names its id column, the household's own transfer decisions kept from the rules,
 * a rule's "not a transfer" gone with the rule, and an undated hold matched over the days it was
 * seen.
 */
describe.skipIf(!TEST_DATABASE_URL)("Phase 1 conformance, second round (audit a10-conformance-ledger)", () => {
  let t: TestDb;
  let n = 0;

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    setLedgerLockOrderCheck(true);
    await t?.cleanup();
  });

  const newAccount = async (name: string, type: "checking" | "savings" | "credit" | "ira" | "brokerage" = "checking") => {
    n++;
    const investment = type === "ira" || type === "brokerage";
    const [row] = await t.db
      .insert(account)
      .values({ name: `${name} ${n}`, type, taxTreatment: type === "ira" ? "pre_tax" : investment ? "taxable" : "none", onBudget: !investment })
      .returning({ id: account.id });
    return row!.id;
  };
  const rowsOf = (accountId: string) => t.db.select().from(transaction).where(eq(transaction.accountId, accountId)).orderBy(asc(transaction.date), asc(transaction.amountCents), asc(transaction.id));
  const rowById = async (id: string) => (await t.db.select().from(transaction).where(eq(transaction.id, id)))[0]!;
  const feed = (accountId: string, items: Array<{ id: string; date: IsoDate; cents: bigint; description: string; pending?: boolean }>) =>
    ingestTransactions(
      t.db,
      items.map((i) => ({ externalId: i.id, date: i.date, amountCents: i.cents, description: i.description, pending: i.pending ?? false })),
      { accountId, source: "simplefin", rules: [] },
    );
  const withRules = async (accountId: string, items: Array<{ id: string; date: IsoDate; cents: bigint; description: string; pending?: boolean }>) =>
    ingestTransactions(
      t.db,
      items.map((i) => ({ externalId: i.id, date: i.date, amountCents: i.cents, description: i.description, pending: i.pending ?? false })),
      { accountId, source: "simplefin", rules: await loadRules(t.db) },
    );
  const addRule = async (name: string, contains: string, actions: Record<string, unknown>) => {
    const [next] = await t.db.select({ n: sql<number>`coalesce(max(${rule.position}), 0)::int + 1` }).from(rule);
    const [row] = await t.db.insert(rule).values({ name, position: next!.n, conditions: { description: { op: "contains", value: contains } }, actions }).returning();
    return row!;
  };

  describe("a10-conformance-ledger-01: the ledger lock is taken before a transaction writes", () => {
    it("a trades commit that marks a bank row a transfer waits for a pairing pass that holds the lock, and both finish", async () => {
      // The real interleaving, without the suites' order check: before the fix the commit wrote first and the two deadlocked.
      setLedgerLockOrderCheck(false);
      try {
        await t.db.delete(rule);
        const ira = await newAccount("CSV Roth", "ira");
        const checking = await newAccount("Checking");
        const [bank] = await t.db
          .insert(transaction)
          .values({ accountId: ira, source: "csv", externalId: "OWN-BANK-2", date: "2026-09-02", amountCents: 100000n, rawDescription: "EFT FROM CHECKING" })
          .returning({ id: transaction.id });
        const [out] = await t.db.insert(transaction).values({ accountId: checking, source: "manual", date: "2026-09-02", amountCents: -100000n, rawDescription: "TRANSFER TO IRA" }).returning({ id: transaction.id });
        const [log] = await t.db.insert(importLog).values({ kind: "csv.trades", status: "ok" }).returning({ id: importLog.id });
        const file = await mapTradesCsvRows(
          [
            TRADES_HEADER,
            // E1 links the bank row (and marks it a transfer); E2 has no twin and goes through the ingest.
            ["2026-09-01", "ELECTRONIC FUNDS TRANSFER RECEIVED", "", "", "", "", "1000.00", "E1"],
            ["2026-09-15", "ELECTRONIC FUNDS TRANSFER RECEIVED", "", "", "", "", "2000.00", "E2"],
          ],
          TRADES_MAPPING,
        );

        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const pass = t.db.transaction(async (tx) => {
          await lockLedger(tx);
          await released;
          return pairTransfersInDb(tx, { since: "2026-09-02", until: "2026-09-02" });
        });
        const commit = importTrades(t.db, { accountId: ira, trades: file.trades, importLogId: log!.id, today: "2026-11-14", ctx: audit() });
        await untilSomeoneWaits(t.db);
        release();
        expect(await Promise.all([outcome(pass), outcome(commit)])).toEqual(["ok", "ok"]);
        expect(await pass).toBe(1);
        const [b, o] = [await rowById(bank!.id), await rowById(out!.id)];
        expect(b).toMatchObject({ isTransfer: true });
        expect(b.transferPairId).not.toBeNull();
        expect(o.transferPairId).toBe(b.transferPairId);
      } finally {
        setLedgerLockOrderCheck(true);
      }
    });

    it("a cash transfer entered by hand between two accounts waits for the lock as well", async () => {
      setLedgerLockOrderCheck(false);
      try {
        await t.db.delete(rule);
        const fed = await newAccount("Brokerage A", "brokerage");
        const other = await newAccount("Brokerage B", "brokerage");
        const checking = await newAccount("Checking");
        // The bank's row of the deposit into the first account, and the checking side it pairs with.
        const [bank] = await t.db
          .insert(transaction)
          .values({ accountId: fed, source: "csv", externalId: "BANK-IN", date: "2026-09-15", amountCents: 50000n, rawDescription: "MONEYLINK FROM CHK" })
          .returning({ id: transaction.id });
        const [out] = await t.db.insert(transaction).values({ accountId: checking, source: "manual", date: "2026-09-15", amountCents: -50000n, rawDescription: "TRANSFER TO BROKERAGE" }).returning({ id: transaction.id });

        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const pass = t.db.transaction(async (tx) => {
          await lockLedger(tx);
          await released;
          return pairTransfersInDb(tx, { since: "2026-09-15", until: "2026-09-15" });
        });
        // The first leg links the bank row (marking it a transfer); the mirror leg gets a derived row, and the pairing pass runs.
        const entry = createInvestmentTxn(
          t.db,
          { accountId: fed, date: "2026-09-15", type: "transfer", direction: "in", amountCents: 50000n, counterpartyAccountId: other },
          { ...audit(), today: "2026-11-14" },
        );
        await untilSomeoneWaits(t.db);
        release();
        expect(await Promise.all([outcome(pass), outcome(entry)])).toEqual(["ok", "ok"]);
        const b = await rowById(bank!.id);
        expect(b).toMatchObject({ isTransfer: true });
        expect((await rowById(out!.id)).transferPairId).toBe(b.transferPairId);
        expect((await entry).items[0]!.ledgerTransactionId).toBe(bank!.id);
      } finally {
        setLedgerLockOrderCheck(true);
      }
    });

    it("under the suites' check, the lock taken after a write is refused; taken first, and again after writes, it is not", async () => {
      const acct = await newAccount("Order check");
      await expect(
        t.db.transaction(async (tx) => {
          await tx.insert(transaction).values({ accountId: acct, source: "manual", date: "2026-10-01", amountCents: -100n, rawDescription: "FIRST" });
          await lockLedger(tx);
        }),
      ).rejects.toThrow(LEDGER_LOCK_ORDER_MESSAGE);
      await t.db.transaction(async (tx) => {
        await lockLedger(tx);
        await tx.insert(transaction).values({ accountId: acct, source: "manual", date: "2026-10-01", amountCents: -100n, rawDescription: "SECOND" });
        await lockLedger(tx);
        await tx.transaction(async (inner) => lockLedger(inner));
      });
      expect((await rowsOf(acct)).map((r) => r.rawDescription)).toEqual(["SECOND"]);
    });
  });

  describe("a10-conformance-ledger-02: a CSV row's id names its id column", () => {
    const lines = [
      ["2026-10-03", "TACO BELL 1234 CO", "-12.40", "REF-1", "9001"],
      ["2026-10-04", "SHELL OIL 57444 FORT COLLINS CO", "-41.07", "REF-2", "9002"],
    ];

    it("the same file imported with one id column, then with another, is one set of rows, in the preview and the commit (both ways)", async () => {
      for (const [first, second] of [
        ["Reference", "Transaction ID"],
        ["Transaction ID", "Reference"],
      ] as const) {
        const acct = await newAccount("Savings", "savings");
        expect(await importCsvRows(t.db, { accountId: acct, rows: await bankRows(lines, first) })).toMatchObject({ created: 2 });
        const again = await bankRows(lines, second);
        expect((await csvDuplicateIds(t.db, acct, again)).size).toBe(2);
        expect(await importCsvRows(t.db, { accountId: acct, rows: again })).toMatchObject({ created: 0, duplicates: 2 });
        expect(await rowsOf(acct)).toHaveLength(2);
        // Both id columns are known now: either file again adds nothing, by its ids (the rows' own, or ids kept for them).
        expect(await importCsvRows(t.db, { accountId: acct, rows: await bankRows(lines, first) })).toMatchObject({ created: 0, duplicates: 0 });
        expect(await importCsvRows(t.db, { accountId: acct, rows: await bankRows(lines, second) })).toMatchObject({ created: 0, duplicates: 2 });
        expect(await rowsOf(acct)).toHaveLength(2);
      }
    });

    it("within one id column the ids decide: two equal coffees of one day are two rows, and a third id is a third row", async () => {
      const acct = await newAccount("Checking");
      const coffees = [
        ["2026-10-05", "BLUE BOTTLE COFFEE", "-4.50", "C-1", "71"],
        ["2026-10-05", "BLUE BOTTLE COFFEE", "-4.50", "C-2", "72"],
      ];
      expect(await importCsvRows(t.db, { accountId: acct, rows: await bankRows(coffees, "Reference") })).toMatchObject({ created: 2 });
      expect(await importCsvRows(t.db, { accountId: acct, rows: await bankRows(coffees, "Reference") })).toMatchObject({ created: 0, duplicates: 0 });
      // Read with the other id column, the two are the same two purchases, and the third is new.
      const three = [...coffees, ["2026-10-05", "BLUE BOTTLE COFFEE", "-4.50", "C-3", "73"]];
      expect(await importCsvRows(t.db, { accountId: acct, rows: await bankRows(three, "Transaction ID") })).toMatchObject({ created: 1, duplicates: 2 });
      expect(await rowsOf(acct)).toHaveLength(3);
    });

    it("rows stored under the earlier csvid: ids, which did not name the column, are recognized by their content", async () => {
      const acct = await newAccount("Checking");
      await t.db.insert(transaction).values([
        { accountId: acct, source: "csv", externalId: "csvid:REF-1", date: "2026-10-03", amountCents: -1240n, rawDescription: "TACO BELL 1234 CO" },
        { accountId: acct, source: "csv", externalId: "csvid:REF-2", date: "2026-10-04", amountCents: -4107n, rawDescription: "SHELL OIL 57444 FORT COLLINS CO" },
      ]);
      const rows = await bankRows(lines, "Reference");
      expect(rows.map((r) => r.externalId)).toEqual(["csvid2:reference:REF-1", "csvid2:reference:REF-2"]);
      expect((await csvDuplicateIds(t.db, acct, rows)).size).toBe(2);
      expect(await importCsvRows(t.db, { accountId: acct, rows })).toMatchObject({ created: 0, duplicates: 2 });
      expect(await rowsOf(acct)).toHaveLength(2);
    });
  });

  describe("a10-conformance-ledger-03: what the household decided by hand about a transfer, the rules leave alone", () => {
    it("a pair made by hand stays a transfer through rule runs that say it is not one (a saved rule's run, uncategorized, all)", async () => {
      await t.db.delete(rule);
      const checking = await newAccount("Checking");
      const venmo = await newAccount("Venmo");
      await feed(checking, [{ id: "V1", date: "2026-10-20", cents: 4000n, description: "VENMO CASHOUT" }]);
      await feed(venmo, [{ id: "W1", date: "2026-10-20", cents: -4000n, description: "TRANSFER TO BANK" }]);
      const [a] = await rowsOf(checking);
      const [b] = await rowsOf(venmo);
      const pairId = await t.db.transaction((tx) => pairTransactionsByHand(tx, a!.id, b!.id, audit()));
      const notTransfer = await addRule("Venmo is not a transfer", "VENMO", { markTransfer: false });
      const [parsed] = (await loadRules(t.db)).filter((r) => r.id === notTransfer.id);
      await runRules(t.db, { scope: "uncategorized", rules: [parsed!] });
      await runRules(t.db, { scope: "uncategorized" });
      await runRules(t.db, { scope: "all" });
      for (const id of [a!.id, b!.id]) expect(await rowById(id)).toMatchObject({ isTransfer: true, transferPairId: pairId, notTransfer: false, transferLocked: true });
      await t.db.delete(rule);
    });

    it("a row marked a transfer by hand, or marked not one, keeps that through rule runs and when it posts", async () => {
      await t.db.delete(rule);
      const checking = await newAccount("Checking");
      await feed(checking, [
        { id: "M1", date: "2026-10-21", cents: -20000n, description: "VENMO PAYMENT RENT SHARE" },
        { id: "M2", date: "2026-10-22", cents: -3000n, description: "ZELLE TO SAM", pending: true },
      ]);
      const [rent, zelle] = (await rowsOf(checking)).sort((x, y) => x.date.localeCompare(y.date));
      await updateTransaction(t.db, rent!.id, { isTransfer: true });
      await updateTransaction(t.db, zelle!.id, { isTransfer: false });
      await addRule("Venmo is not a transfer", "VENMO", { markTransfer: false });
      await addRule("Zelle is a transfer", "ZELLE", { markTransfer: true });
      await runRules(t.db, { scope: "all" });
      expect(await rowById(rent!.id)).toMatchObject({ isTransfer: true, notTransfer: false, transferLocked: true });
      expect(await rowById(zelle!.id)).toMatchObject({ isTransfer: false, transferLocked: true });
      // The pending Zelle payment posts under a new id: the rules run on the row it replaces, and the household's word stays.
      await withRules(checking, [
        { id: "M1", date: "2026-10-21", cents: -20000n, description: "VENMO PAYMENT RENT SHARE" },
        { id: "M2-POSTED", date: "2026-10-23", cents: -3000n, description: "ZELLE TO SAM" },
      ]);
      expect(await rowById(zelle!.id)).toMatchObject({ externalId: "M2-POSTED", pending: false, isTransfer: false, transferLocked: true });
      await t.db.delete(rule);
    });

    it("a row nobody decided by hand still follows the rules, and a pair undone by the household stays undone", async () => {
      await t.db.delete(rule);
      const checking = await newAccount("Checking");
      const savings = await newAccount("Savings", "savings");
      await feed(checking, [
        { id: "R1", date: "2026-10-24", cents: -6000n, description: "VENMO PAYMENT DINNER" },
        { id: "R2", date: "2026-10-24", cents: -15000n, description: "ONLINE TRANSFER TO SAVINGS" },
      ]);
      await feed(savings, [{ id: "R3", date: "2026-10-24", cents: 15000n, description: "ONLINE TRANSFER FROM CHECKING" }]);
      expect(await t.db.transaction((tx) => pairTransfersInDb(tx, { since: "2026-10-24" }))).toBe(1);
      const [, venmoRow] = (await rowsOf(checking)).sort((x, y) => Number(x.amountCents - y.amountCents));
      const transferOut = (await rowsOf(checking)).find((r) => r.amountCents === -15000n)!;
      await updateTransaction(t.db, transferOut.id, { isTransfer: false });
      await addRule("Venmo is a transfer", "VENMO", { markTransfer: true });
      await addRule("Online transfers are transfers", "ONLINE TRANSFER", { markTransfer: true });
      await runRules(t.db, { scope: "all" });
      expect(await rowById(venmoRow!.id)).toMatchObject({ isTransfer: true, transferLocked: false });
      // Undoing the pair was the household's "these are not a transfer": the rule leaves both legs as they were left.
      expect(await rowById(transferOut.id)).toMatchObject({ isTransfer: false, transferPairId: null, transferLocked: true });
      await t.db.delete(rule);
    });
  });

  describe("a10-conformance-ledger-03 (second round): a rule's 'not a transfer' goes with the rule", () => {
    it("deleted, then the rules run: the row it ruled out is no longer, and its other leg pairs with it", async () => {
      await t.db.delete(rule);
      const checking = await newAccount("Checking");
      const savings = await newAccount("Savings", "savings");
      await addRule("Transfers are spending", "TRANSFER", { markTransfer: false });
      await withRules(checking, [{ id: "S1", date: "2026-10-26", cents: -25000n, description: "ONLINE TRANSFER TO SAVINGS" }]);
      const [out] = await rowsOf(checking);
      expect(out).toMatchObject({ notTransfer: true, isTransfer: false });
      await t.db.delete(rule);
      await runRules(t.db, { scope: "all" });
      expect(await rowById(out!.id)).toMatchObject({ notTransfer: false });
      await withRules(savings, [{ id: "S2", date: "2026-10-26", cents: 25000n, description: "ONLINE TRANSFER FROM CHECKING" }]);
      expect(await t.db.transaction((tx) => pairTransfersInDb(tx, { since: "2026-10-26" }))).toBe(1);
      expect(await rowById(out!.id)).toMatchObject({ isTransfer: true });
    });

    it("a run of one rule (saving another rule) leaves the flag a rule still sets; the full run keeps it too", async () => {
      await t.db.delete(rule);
      const checking = await newAccount("Checking");
      await addRule("Venmo is not a transfer", "VENMO", { markTransfer: false });
      await withRules(checking, [{ id: "K1", date: "2026-10-27", cents: -1800n, description: "VENMO PAYMENT LUNCH" }]);
      const tags = await addRule("Tag Venmo", "VENMO", { addTags: ["venmo"] });
      const [parsed] = (await loadRules(t.db)).filter((r) => r.id === tags.id);
      await runRules(t.db, { scope: "all", rules: [parsed!] });
      const [row] = await rowsOf(checking);
      expect(row).toMatchObject({ notTransfer: true });
      await runRules(t.db, { scope: "all" });
      expect(await rowById(row!.id)).toMatchObject({ notTransfer: true });
      await t.db.delete(rule);
    });

    it("when a rule is deleted or changed, the rows only it ruled out lose the flag and may pair; the rows another rule rules out keep it", async () => {
      await t.db.delete(rule);
      // Earlier tests' rows whose rules are gone.
      await clearStaleNotTransfer(t.db);
      const checking = await newAccount("Checking");
      const venmo = await newAccount("Venmo");
      const zelle = await newAccount("Zelle");
      const venmoRule = await addRule("Venmo is not a transfer", "VENMO", { markTransfer: false });
      await addRule("Zelle is not a transfer", "ZELLE", { markTransfer: false });
      await withRules(checking, [
        { id: "Q1", date: "2026-10-28", cents: 7000n, description: "VENMO CASHOUT" },
        { id: "Q2", date: "2026-10-28", cents: 9000n, description: "ZELLE FROM SAM" },
      ]);
      await withRules(venmo, [{ id: "Q3", date: "2026-10-28", cents: -7000n, description: "TRANSFER TO BANK" }]);
      await withRules(zelle, [{ id: "Q4", date: "2026-10-28", cents: -9000n, description: "TRANSFER TO BANK" }]);
      expect(await t.db.transaction((tx) => pairTransfersInDb(tx, { since: "2026-10-28" }))).toBe(0);
      await t.db.delete(rule).where(eq(rule.id, venmoRule.id));
      expect(await clearStaleNotTransfer(t.db)).toEqual({ cleared: 1, transfersPaired: 1 });
      const rows = await rowsOf(checking);
      expect(rows.find((r) => r.externalId === "Q1")).toMatchObject({ notTransfer: false, isTransfer: true });
      expect(rows.find((r) => r.externalId === "Q2")).toMatchObject({ notTransfer: true, isTransfer: false, transferPairId: null });
      // Switched off, the rule no longer rules anything out either.
      await t.db.update(rule).set({ enabled: false }).where(and(eq(rule.name, "Zelle is not a transfer")));
      expect(await clearStaleNotTransfer(t.db)).toEqual({ cleared: 1, transfersPaired: 1 });
      await t.db.delete(rule);
    });
  });

  describe("a10-conformance-ledger-05: an undated hold is matched over the days it was seen pending", () => {
    const hold = (posted: number, id: string, transactedAt?: IsoDate): SfTxn => ({
      id,
      posted,
      ...(transactedAt ? { transacted_at: unix(transactedAt) } : {}),
      amount: "-412.80",
      description: "MARRIOTT DENVER HOLD",
      pending: posted === 0,
    });
    const set = (externalAccountId: string, txns: SfTxn[], asOf: IsoDate): SimplefinAccountSet => ({
      errors: [],
      errlist: [],
      accounts: [{ org: { name: "Bank" }, id: externalAccountId, name: "Card", currency: "USD", balance: "-412.80", "balance-date": unix(asOf, 6), transactions: txns }],
    });
    const seenPending = async (externalAccountId: string, days: IsoDate[]) => {
      const [c] = await t.db.insert(connection).values({ type: "simplefin", name: "Bank" }).returning({ id: connection.id });
      for (const [i, day] of days.entries()) {
        await applyAccountSet(t.db, { connectionId: c!.id, accountSet: set(externalAccountId, [hold(0, "P-1")], day), windowStart: i === 0 ? "2026-09-20" : "2026-10-17", now: at(day) });
      }
      const acct = (await t.db.select({ id: account.id }).from(account).where(eq(account.externalId, externalAccountId)))[0]!.id;
      return { connectionId: c!.id, acct };
    };

    it("posted with only its posting day, nine days after it was first seen: replaced in place, with the household's note", async () => {
      const { connectionId, acct } = await seenPending("A10R2-HOTEL", ["2026-10-24"]);
      const [first] = await rowsOf(acct);
      await t.db.update(transaction).set({ notes: "work trip" }).where(eq(transaction.id, first!.id));
      for (const day of ["2026-10-28", "2026-11-01"] as IsoDate[]) {
        await applyAccountSet(t.db, { connectionId, accountSet: set("A10R2-HOTEL", [hold(0, "P-1")], day), windowStart: "2026-10-17", now: at(day) });
      }
      expect((await rowsOf(acct))[0]).toMatchObject({ id: first!.id, date: "2026-10-24", pending: true });
      expect.soft((await rowsOf(acct))[0]).toMatchObject({ pendingSeenThrough: "2026-11-01" });
      const posted = await applyAccountSet(t.db, { connectionId, accountSet: set("A10R2-HOTEL", [hold(unix("2026-11-02"), "S-1")], "2026-11-02"), windowStart: "2026-10-25", now: at("2026-11-02") });
      expect(posted.stats).toMatchObject({ replacedPending: 1, created: 0, removedPending: 0 });
      const book = await rowsOf(acct);
      expect(book).toHaveLength(1);
      expect(book[0]).toMatchObject({ id: first!.id, externalId: "S-1", date: "2026-11-02", pending: false, notes: "work trip", pendingSeenThrough: null });
    });

    it("a purchase of the same amount that posted days before the hold was first seen is another purchase", async () => {
      const { connectionId, acct } = await seenPending("A10R2-EARLIER", ["2026-10-24", "2026-10-30"]);
      // The hold is gone; a payment of the same amount posted 10-15, nine days before the hold was first seen.
      const later = await applyAccountSet(t.db, { connectionId, accountSet: set("A10R2-EARLIER", [hold(unix("2026-10-15"), "S-0")], "2026-10-31"), windowStart: "2026-10-03", now: at("2026-10-31") });
      expect(later.stats).toMatchObject({ replacedPending: 0, created: 1, removedPending: 1 });
      expect(await rowsOf(acct)).toMatchObject([{ externalId: "S-0", date: "2026-10-15", pending: false }]);
    });
  });
});
