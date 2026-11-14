import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoDateToUtcMs, mapCsvRows, type CsvMappingInput, type IsoDate, type MappedRow, type SimplefinAccountSet } from "@meridian/shared";
import { account, category, connection, importLog, payee, rule, transaction, transactionAlias } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { PlanError } from "./audit.js";
import { csvDuplicateIds, importCsvRows, undoCsvImport } from "./csvImport.js";
import { ingestTransactions, type IncomingTransaction } from "./ingest.js";
import { loadRules, runRules } from "./rules.js";
import { applyAccountSet } from "./sync.js";
import { createManualTransaction, updateTransaction } from "./transactions.js";
import { pairTransfersInDb } from "./transfers.js";

type SfAccount = SimplefinAccountSet["accounts"][number];
type SfTxn = SfAccount["transactions"][number];

const unix = (date: IsoDate, hour = 12) => Math.floor(isoDateToUtcMs(date) / 1000) + hour * 3600;
const at = (date: IsoDate) => new Date(`${date}T18:00:00Z`);

const MAPPING: CsvMappingInput = {
  hasHeader: true,
  date: { column: "Date", format: "YYYY-MM-DD" },
  description: { column: "Description" },
  amount: { mode: "single", column: "Amount" },
};
const WITH_ID: CsvMappingInput = { ...MAPPING, externalId: { column: "Reference" } };

async function mapped(lines: string[][], mapping: CsvMappingInput = MAPPING, header = ["Date", "Description", "Amount", "Reference"]): Promise<MappedRow[]> {
  const { rows, errors } = await mapCsvRows([header, ...lines], mapping);
  expect(errors).toEqual([]);
  return rows;
}

/**
 * Audit batch a10-conformance-ledger (Phase 1 conformance): one purchase is one row whichever
 * import runs when, CSV ids that do not depend on a heuristic, a rule's "not a transfer", the
 * stored responses of a removed connection, pending dates, paired amounts and manual entry.
 */
describe.skipIf(!TEST_DATABASE_URL)("Phase 1 conformance (audit a10-conformance-ledger)", () => {
  let t: TestDb;
  let n = 0;

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const newConnection = async (name = "Bank") => (await t.db.insert(connection).values({ type: "simplefin", name }).returning({ id: connection.id }))[0]!.id;
  const newAccount = async (name: string, connectionId: string | null = null, type: "checking" | "savings" | "credit" = "checking") => {
    n++;
    const [row] = await t.db
      .insert(account)
      .values({ name: `${name} ${n}`, type, taxTreatment: "none", connectionId, externalId: connectionId ? `EXT-${n}` : null })
      .returning({ id: account.id });
    return row!.id;
  };
  const rowsOf = (accountId: string) => t.db.select().from(transaction).where(eq(transaction.accountId, accountId)).orderBy(asc(transaction.date), asc(transaction.amountCents), asc(transaction.id));
  const categoryId = async (name: string) => {
    const [row] = await t.db.insert(category).values({ name, bucket: "spending", position: 70 }).returning({ id: category.id });
    return row!.id;
  };

  describe("a10-conformance-ledger-01: imports and syncs of one account run one at a time", () => {
    it("a CSV commit and a feed ingest of the same 30 purchases at the same time leave 30 rows, every round", async () => {
      const conn = await newConnection();
      for (let round = 0; round < 5; round++) {
        const acct = await newAccount("Checking", conn);
        const lines = Array.from({ length: 30 }, (_, i) => [`2026-10-${String(i + 1).padStart(2, "0")}`, `ACME STORE ${100 + i}`, `-${10 + i}.${String(round).padStart(2, "0")}`]);
        const csv = await mapped(lines);
        const feed: IncomingTransaction[] = lines.map(([date, description], i) => ({
          externalId: `F${round}-${i}`,
          date: date as IsoDate,
          amountCents: csv[i]!.amountCents,
          description: `POS ${description} DENVER CO`,
          pending: false,
          postedAt: at(date as IsoDate),
        }));
        const rules = await loadRules(t.db);
        await Promise.all([importCsvRows(t.db, { accountId: acct, rows: csv }), ingestTransactions(t.db, feed, { accountId: acct, source: "simplefin", rules, windowStart: "2026-09-25" })]);
        const book = await rowsOf(acct);
        expect(book).toHaveLength(30);
        // The same again in the other order changes nothing.
        await Promise.all([ingestTransactions(t.db, feed, { accountId: acct, source: "simplefin", rules, windowStart: "2026-09-25" }), importCsvRows(t.db, { accountId: acct, rows: csv })]);
        expect(await rowsOf(acct)).toHaveLength(30);
      }
    });

    it("two pairing passes at the same time never leave a pair id on one row", async () => {
      for (let round = 0; round < 8; round++) {
        const out = await newAccount("Checking");
        const inA = await newAccount("Savings", null, "savings");
        const inB = await newAccount("Brokerage cash", null, "savings");
        const cents = BigInt(10_000 + round);
        // The outflow on 10-12 is within 3 days of both inflows; one pass sees the first, the other the second.
        const [o] = await t.db.insert(transaction).values({ accountId: out, source: "manual", date: "2026-10-12", amountCents: -cents, rawDescription: "TRANSFER OUT" }).returning({ id: transaction.id });
        await t.db.insert(transaction).values([
          { accountId: inA, source: "manual", date: "2026-10-10", amountCents: cents, rawDescription: "TRANSFER IN" },
          { accountId: inB, source: "manual", date: "2026-10-14", amountCents: cents, rawDescription: "TRANSFER IN" },
        ]);
        await Promise.all([
          t.db.transaction((tx) => pairTransfersInDb(tx, { since: "2026-10-10", until: "2026-10-10" })),
          t.db.transaction((tx) => pairTransfersInDb(tx, { since: "2026-10-14", until: "2026-10-14" })),
        ]);
        const legs = await t.db.select({ id: transaction.id, pairId: transaction.transferPairId }).from(transaction).where(eq(transaction.amountCents, cents));
        const [outRow] = await t.db.select({ pairId: transaction.transferPairId }).from(transaction).where(eq(transaction.id, o!.id));
        expect(outRow!.pairId).not.toBeNull();
        // Exactly one inflow carries the outflow's pair id, and no row carries a pair id alone.
        expect(legs.filter((l) => l.pairId !== null)).toHaveLength(1);
        expect(legs.find((l) => l.pairId !== null)!.pairId).toBe(outRow!.pairId);
      }
    });
  });

  describe("a10-conformance-ledger-02: a CSV row's id does not depend on the id column chosen or on the payee normalizer", () => {
    const lines = [
      ["2026-10-03", "TACO BELL 1234 CO", "-12.40", "REF-1"],
      ["2026-10-04", "SHELL OIL 57444 FORT COLLINS CO", "-41.07", "REF-2"],
    ];

    it("the same file committed with its id column, then without it, is one set of rows (and the reverse)", async () => {
      const acct = await newAccount("Savings");
      const withIds = await mapped(lines, WITH_ID);
      expect(withIds.map((r) => r.externalId)).toEqual(["csvid:REF-1", "csvid:REF-2"]);
      expect(await importCsvRows(t.db, { accountId: acct, rows: withIds })).toMatchObject({ created: 2 });
      const withoutIds = await mapped(lines);
      expect(withoutIds.every((r) => r.externalId.startsWith("csv2:"))).toBe(true);
      // The preview marks both, and the commit adds nothing.
      expect((await csvDuplicateIds(t.db, acct, withoutIds)).size).toBe(2);
      expect(await importCsvRows(t.db, { accountId: acct, rows: withoutIds })).toMatchObject({ created: 0, duplicates: 2 });
      expect(await rowsOf(acct)).toHaveLength(2);
      expect(await importCsvRows(t.db, { accountId: acct, rows: withoutIds })).toMatchObject({ created: 0 });
      expect(await importCsvRows(t.db, { accountId: acct, rows: withIds })).toMatchObject({ created: 0 });
      expect(await rowsOf(acct)).toHaveLength(2);

      const other = await newAccount("Checking");
      expect(await importCsvRows(t.db, { accountId: other, rows: withoutIds })).toMatchObject({ created: 2 });
      expect((await csvDuplicateIds(t.db, other, withIds)).size).toBe(2);
      expect(await importCsvRows(t.db, { accountId: other, rows: withIds })).toMatchObject({ created: 0, duplicates: 2 });
      expect(await rowsOf(other)).toHaveLength(2);
    });

    it("rows stored under the earlier csv: ids (before the payee normalizer changed) are recognized, as rows and as ids kept for feed rows", async () => {
      const conn = await newConnection();
      const acct = await newAccount("Checking", conn);
      const rows = await mapped([...lines.map((l) => l.slice(0, 3)), ["2026-10-05", "KING SOOPERS 0123", "-45.32"]]);
      // What an import before this fix left behind: the rows under ids hashed from the old normalizer's output...
      const legacy = rows.slice(0, 2).map((r, i) => ({ ...r, externalId: `csv:legacy${i}` }));
      expect(await importCsvRows(t.db, { accountId: acct, rows: legacy })).toMatchObject({ created: 2 });
      // ...and a row the feed already had, whose csv: id points at the feed's row.
      await ingestTransactions(t.db, [{ externalId: "K1", date: "2026-10-05", amountCents: -4532n, description: "KING SOOPERS #0123 DENVER CO", pending: false }], { accountId: acct, source: "simplefin", rules: [] });
      const [king] = await t.db.select().from(transaction).where(and(eq(transaction.accountId, acct), eq(transaction.externalId, "K1")));
      await t.db.insert(transactionAlias).values({ accountId: acct, externalId: "csv:legacy-king", transactionId: king!.id, source: "csv" });
      expect(await rowsOf(acct)).toHaveLength(3);

      expect((await csvDuplicateIds(t.db, acct, rows)).size).toBe(3);
      expect(await importCsvRows(t.db, { accountId: acct, rows })).toMatchObject({ created: 0, duplicates: 3 });
      expect(await rowsOf(acct)).toHaveLength(3);
      // The ids this import recorded are known from now on.
      expect(await importCsvRows(t.db, { accountId: acct, rows })).toMatchObject({ created: 0, duplicates: 3 });
      expect(await rowsOf(acct)).toHaveLength(3);
    });

    it("two equal purchases on one day stay two rows across id schemes, and a third one is added", async () => {
      const acct = await newAccount("Checking");
      const coffee = [
        ["2026-10-08", "BLUE BOTTLE COFFEE", "-4.50", "R-10"],
        ["2026-10-08", "BLUE BOTTLE COFFEE", "-4.50", "R-11"],
      ];
      expect(await importCsvRows(t.db, { accountId: acct, rows: await mapped(coffee, WITH_ID) })).toMatchObject({ created: 2 });
      const noIds = await mapped(coffee);
      expect(noIds.map((r) => r.externalId)).toEqual([noIds[0]!.externalId, `${noIds[0]!.externalId}:1`]);
      expect(await importCsvRows(t.db, { accountId: acct, rows: noIds })).toMatchObject({ created: 0, duplicates: 2 });
      // A later export of the day with a third coffee adds exactly one row.
      expect(await importCsvRows(t.db, { accountId: acct, rows: await mapped([...coffee, ["2026-10-08", "BLUE BOTTLE COFFEE", "-4.50", ""]]) })).toMatchObject({ created: 1 });
      expect(await rowsOf(acct)).toHaveLength(3);
    });

    it("undoing an import that recognized rows of another id scheme forgets those ids and removes nothing else", async () => {
      const acct = await newAccount("Checking");
      expect(await importCsvRows(t.db, { accountId: acct, rows: await mapped(lines, WITH_ID) })).toMatchObject({ created: 2 });
      const [log] = await t.db.insert(importLog).values({ kind: "csv" }).returning({ id: importLog.id });
      expect(await importCsvRows(t.db, { accountId: acct, rows: await mapped(lines), importLogId: log!.id })).toMatchObject({ created: 0, duplicates: 2 });
      expect(await undoCsvImport(t.db, log!.id, { userId: null, batchId: "00000000-0000-4000-8000-00000000a10a" })).toEqual({ removed: 0, forgotten: 2 });
      expect(await rowsOf(acct)).toHaveLength(2);
    });
  });

  describe("a10-conformance-ledger-03: a rule's 'not a transfer' holds over pairing", () => {
    it("a row a rule marks as not a transfer is not paired at import, and its would-be partner stays spending", async () => {
      await t.db.delete(rule);
      await t.db.insert(rule).values({ name: "Venmo is not a transfer", position: 1, conditions: { description: { op: "contains", value: "VENMO" } }, actions: { markTransfer: false } });
      const checking = await newAccount("Checking");
      const card = await newAccount("Card", null, "credit");
      const rules = await loadRules(t.db);
      await ingestTransactions(t.db, [{ externalId: "V1", date: "2026-10-20", amountCents: 4000n, description: "VENMO CASHOUT", pending: false }], { accountId: checking, source: "simplefin", rules });
      await ingestTransactions(t.db, [{ externalId: "B1", date: "2026-10-21", amountCents: -4000n, description: "BLUE BOTTLE COFFEE", pending: false }], { accountId: card, source: "simplefin", rules });
      expect(await t.db.transaction((tx) => pairTransfersInDb(tx, { since: "2026-10-20" }))).toBe(0);
      const [venmo] = await rowsOf(checking);
      const [coffee] = await rowsOf(card);
      expect(venmo).toMatchObject({ isTransfer: false, transferPairId: null, notTransfer: true });
      expect(coffee).toMatchObject({ isTransfer: false, transferPairId: null });
      await t.db.delete(rule);
    });

    it("run on demand, the rule unpairs a pair it rules out: both legs lose the pair id and the partner is free to pair again", async () => {
      await t.db.delete(rule);
      const dining = await categoryId("Dining (a10-03)");
      await t.db.insert(payee).values({ name: "Blue Bottle Coffee", defaultCategoryId: dining }).onConflictDoUpdate({ target: payee.name, set: { defaultCategoryId: dining } });
      const checking = await newAccount("Checking");
      const card = await newAccount("Card", null, "credit");
      await ingestTransactions(t.db, [{ externalId: "V2", date: "2026-11-02", amountCents: 4100n, description: "VENMO CASHOUT", pending: false }], { accountId: checking, source: "simplefin", rules: [] });
      await ingestTransactions(t.db, [{ externalId: "B2", date: "2026-11-03", amountCents: -4100n, description: "BLUE BOTTLE COFFEE", pending: false }], { accountId: card, source: "simplefin", rules: [] });
      expect(await t.db.transaction((tx) => pairTransfersInDb(tx, { since: "2026-11-02" }))).toBe(1);
      expect((await rowsOf(checking))[0]).toMatchObject({ isTransfer: true });

      await t.db.insert(rule).values({ name: "Venmo is not a transfer", position: 1, conditions: { description: { op: "contains", value: "VENMO" } }, actions: { markTransfer: false } });
      await runRules(t.db, { scope: "all" });
      const [venmo] = await rowsOf(checking);
      const [coffee] = await rowsOf(card);
      expect(venmo).toMatchObject({ isTransfer: false, transferPairId: null, notTransfer: true });
      // The coffee is spending again, with its payee's category back.
      expect(coffee).toMatchObject({ isTransfer: false, transferPairId: null, categoryId: dining });
      expect(await t.db.transaction((tx) => pairTransfersInDb(tx, { since: "2026-11-02" }))).toBe(0);

      // A real transfer of the same amount pairs with the coffee's account as before.
      const savings = await newAccount("Savings", null, "savings");
      await ingestTransactions(t.db, [{ externalId: "S2", date: "2026-11-03", amountCents: 4100n, description: "ONLINE TRANSFER FROM CARD", pending: false }], { accountId: savings, source: "simplefin", rules: await loadRules(t.db) });
      expect(await t.db.transaction((tx) => pairTransfersInDb(tx, { since: "2026-11-03" }))).toBe(1);
      expect((await rowsOf(card))[0]!.transferPairId).toBe((await rowsOf(savings))[0]!.transferPairId);

      // Marking the row a transfer by hand lifts what the rule said.
      await updateTransaction(t.db, venmo!.id, { isTransfer: true });
      expect((await rowsOf(checking))[0]).toMatchObject({ isTransfer: true, notTransfer: false });
      await t.db.delete(rule);
    });
  });

  describe("a10-conformance-ledger-04: a removed connection keeps its stored responses", () => {
    const sfAccount = (id: string, transactions: SfTxn[]): SfAccount => ({ org: { name: "Bank" }, id, name: "Everyday Checking", currency: "USD", balance: "100.00", "balance-date": unix("2026-10-19", 6), transactions });

    it("the import logs stay when the connection goes, and the connection added again takes over the responses of its accounts", async () => {
      const first = await newConnection("Bank (old)");
      const accountSet: SimplefinAccountSet = { errors: [], errlist: [], accounts: [sfAccount("A10-CHK", [{ id: "T1", posted: unix("2026-10-05"), amount: "-45.32", description: "KING SOOPERS", pending: false }])] };
      const [log] = await t.db.insert(importLog).values({ connectionId: first, kind: "simplefin.sync", status: "ok", rawPayload: accountSet }).returning({ id: importLog.id });
      await applyAccountSet(t.db, { connectionId: first, importLogId: log!.id, accountSet, windowStart: "2026-09-20", now: at("2026-10-19") });
      const [other] = await t.db.insert(importLog).values({ connectionId: first, kind: "simplefin.sync", status: "ok", rawPayload: { errors: [], errlist: [], accounts: [sfAccount("SOMEONE-ELSE", [])] } }).returning({ id: importLog.id });

      await t.db.delete(connection).where(eq(connection.id, first));
      const kept = await t.db.select({ id: importLog.id, connectionId: importLog.connectionId }).from(importLog).where(sql`${importLog.id} in (${log!.id}, ${other!.id})`);
      expect(kept).toHaveLength(2);
      expect(kept.every((k) => k.connectionId === null)).toBe(true);

      const second = await newConnection("Bank (new)");
      const result = await applyAccountSet(t.db, { connectionId: second, accountSet, windowStart: "2026-09-20", now: at("2026-10-20") });
      expect(result.accountsReattached).toBe(1);
      const [adopted] = await t.db.select({ connectionId: importLog.connectionId }).from(importLog).where(eq(importLog.id, log!.id));
      expect(adopted!.connectionId).toBe(second);
      // A response that lists none of this connection's accounts stays with no connection.
      const [left] = await t.db.select({ connectionId: importLog.connectionId }).from(importLog).where(eq(importLog.id, other!.id));
      expect(left!.connectionId).toBeNull();
    });

    it("a CSV mapping profile that is deleted leaves its imports, and they can still be undone", async () => {
      const acct = await newAccount("Checking");
      const [profile] = await t.db.insert(connection).values({ type: "csv", name: "First Bank", csvMapping: MAPPING as Record<string, unknown> }).returning({ id: connection.id });
      const [log] = await t.db.insert(importLog).values({ connectionId: profile!.id, kind: "csv", status: "ok" }).returning({ id: importLog.id });
      expect(await importCsvRows(t.db, { accountId: acct, rows: await mapped([["2026-10-09", "NETFLIX.COM", "-15.49"]]), importLogId: log!.id })).toMatchObject({ created: 1 });
      await t.db.delete(connection).where(eq(connection.id, profile!.id));
      expect((await rowsOf(acct))[0]!.importLogId).toBe(log!.id);
      expect(await undoCsvImport(t.db, log!.id, { userId: null, batchId: "00000000-0000-4000-8000-00000000a10a" })).toEqual({ removed: 1, forgotten: 0 });
      expect(await t.db.select().from(importLog).where(and(eq(importLog.id, log!.id), isNull(importLog.connectionId)))).toHaveLength(1);
    });
  });

  describe("a10-conformance-ledger-05: an undated pending item keeps the day it was first seen", () => {
    it("a hold pending for a week keeps its date and is replaced in place, with the household's note, when it posts", async () => {
      const conn = await newConnection();
      const hold = (posted: number, id: string, transactedAt?: IsoDate): SfTxn => ({
        id,
        posted,
        ...(transactedAt ? { transacted_at: unix(transactedAt) } : {}),
        amount: "-412.80",
        description: "MARRIOTT DENVER HOLD",
        pending: posted === 0,
      });
      const set = (txns: SfTxn[], asOf: IsoDate): SimplefinAccountSet => ({ errors: [], errlist: [], accounts: [{ org: { name: "Bank" }, id: "A10-HOTEL", name: "Card", currency: "USD", balance: "-412.80", "balance-date": unix(asOf, 6), transactions: txns }] });
      await applyAccountSet(t.db, { connectionId: conn, accountSet: set([hold(0, "P-1")], "2026-10-24"), windowStart: "2026-09-20", now: at("2026-10-24") });
      const acct = (await t.db.select({ id: account.id }).from(account).where(eq(account.externalId, "A10-HOTEL")))[0]!.id;
      const [first] = await rowsOf(acct);
      expect(first).toMatchObject({ date: "2026-10-24", pending: true });
      await t.db.update(transaction).set({ notes: "work trip" }).where(eq(transaction.id, first!.id));

      for (const day of ["2026-10-28", "2026-11-01"] as IsoDate[]) {
        await applyAccountSet(t.db, { connectionId: conn, accountSet: set([hold(0, "P-1")], day), windowStart: "2026-10-17", now: at(day) });
        expect((await rowsOf(acct))[0]).toMatchObject({ id: first!.id, date: "2026-10-24", pending: true });
      }
      // It posts on 11-02, dated by when it happened.
      const posted = await applyAccountSet(t.db, { connectionId: conn, accountSet: set([hold(unix("2026-11-02"), "S-1", "2026-10-24")], "2026-11-02"), windowStart: "2026-10-25", now: at("2026-11-02") });
      expect(posted.stats).toMatchObject({ replacedPending: 1, created: 0, removedPending: 0 });
      const book = await rowsOf(acct);
      expect(book).toHaveLength(1);
      expect(book[0]).toMatchObject({ id: first!.id, externalId: "S-1", date: "2026-10-24", pending: false, notes: "work trip" });
    });

    it("a pending item that gains a date takes it", async () => {
      const conn = await newConnection();
      const set = (txn: SfTxn, asOf: IsoDate): SimplefinAccountSet => ({ errors: [], errlist: [], accounts: [{ org: { name: "Bank" }, id: "A10-GAIN", name: "Card", currency: "USD", balance: "-10.00", "balance-date": unix(asOf, 6), transactions: [txn] }] });
      await applyAccountSet(t.db, { connectionId: conn, accountSet: set({ id: "P-2", posted: 0, amount: "-10.00", description: "PARKING", pending: true }, "2026-10-24"), windowStart: "2026-09-20", now: at("2026-10-24") });
      await applyAccountSet(t.db, { connectionId: conn, accountSet: set({ id: "P-2", posted: 0, transacted_at: unix("2026-10-22"), amount: "-10.00", description: "PARKING", pending: true }, "2026-10-25"), windowStart: "2026-10-17", now: at("2026-10-25") });
      const acct = (await t.db.select({ id: account.id }).from(account).where(eq(account.externalId, "A10-GAIN")))[0]!.id;
      expect((await rowsOf(acct))[0]).toMatchObject({ date: "2026-10-22" });
    });
  });

  describe("a10-conformance-ledger-06: a paired row whose amount changes under the same id is released", () => {
    it("checking -500.00 pending and savings +500.00 are paired; the checking row posts at -450.00: no pair is left, and each leg may pair again", async () => {
      const checking = await newAccount("Checking");
      const savings = await newAccount("Savings", null, "savings");
      const rules = await loadRules(t.db);
      await ingestTransactions(t.db, [{ externalId: "A-1", date: "2026-10-10", amountCents: -50000n, description: "ONLINE TRANSFER TO SAVINGS", pending: true }], { accountId: checking, source: "simplefin", rules });
      await ingestTransactions(t.db, [{ externalId: "B-1", date: "2026-10-11", amountCents: 50000n, description: "ONLINE TRANSFER FROM CHECKING", pending: false }], { accountId: savings, source: "simplefin", rules });
      expect(await t.db.transaction((tx) => pairTransfersInDb(tx, { since: "2026-10-10" }))).toBe(1);

      const stats = await ingestTransactions(t.db, [{ externalId: "A-1", date: "2026-10-10", amountCents: -45000n, description: "ONLINE TRANSFER TO SAVINGS", pending: false }], { accountId: checking, source: "simplefin", rules });
      expect(stats).toMatchObject({ updated: 1, releasedTransfers: 1, earliestReleased: "2026-10-10" });
      const [a] = await rowsOf(checking);
      const [b] = await rowsOf(savings);
      expect(a).toMatchObject({ amountCents: -45000n, transferPairId: null, isTransfer: false });
      expect(b).toMatchObject({ amountCents: 50000n, transferPairId: null, isTransfer: false });
      expect(await t.db.transaction((tx) => pairTransfersInDb(tx, { since: stats.earliestReleased! }))).toBe(0);
    });
  });

  describe("a10-conformance-ledger-07: a row entered by hand is checked before it is written", () => {
    it("refuses a zero amount, a date after today, an unknown account and an unknown category", async () => {
      const acct = await newAccount("Checking");
      const base = { accountId: acct, date: "2026-11-14" as IsoDate, amountCents: -1234n, payeeName: "Farmers market", today: "2026-11-14" as IsoDate };
      const refused = async (input: Parameters<typeof createManualTransaction>[1]) => {
        try {
          await createManualTransaction(t.db, input);
        } catch (err) {
          expect(err).toBeInstanceOf(PlanError);
          return [(err as PlanError).status, (err as PlanError).code];
        }
        return "accepted";
      };
      expect(await refused({ ...base, amountCents: 0n })).toEqual([400, "zero_amount"]);
      expect(await refused({ ...base, date: "2026-11-15" })).toEqual([400, "future_date"]);
      expect(await refused({ ...base, accountId: "00000000-0000-4000-8000-000000000000" })).toEqual([404, "not_found"]);
      expect(await refused({ ...base, categoryId: "00000000-0000-4000-8000-000000000000" })).toEqual([400, "unknown_category"]);
      expect(await rowsOf(acct)).toHaveLength(0);
      const made = await createManualTransaction(t.db, base);
      expect(made).toMatchObject({ date: "2026-11-14", amountCents: -1234n, source: "manual" });
    });

    it("an edit to an unknown category is refused, not a database error", async () => {
      const acct = await newAccount("Checking");
      const made = await createManualTransaction(t.db, { accountId: acct, date: "2026-11-01", amountCents: -500n, payeeName: "Kiosk", today: "2026-11-14" });
      await expect(updateTransaction(t.db, made.id, { categoryId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ status: 400, code: "unknown_category" });
    });
  });
});
