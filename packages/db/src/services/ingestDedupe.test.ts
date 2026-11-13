import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isoDateToUtcMs, mapCsvRows, type IsoDate, type MappedRow, type SimplefinAccountSet } from "@meridian/shared";
import { account, category, connection, payee, rule, tag, transaction, transactionTag } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { linkFeedAccount } from "./accounts.js";
import { csvDuplicateIds, importCsvRows } from "./csvImport.js";
import { addPayeeAlias } from "./payees.js";
import { runRules } from "./rules.js";
import { applyAccountSet } from "./sync.js";
import { setTransactionTags } from "./tags.js";

type SfAccount = SimplefinAccountSet["accounts"][number];
type SfTxn = SfAccount["transactions"][number];

const unix = (date: IsoDate, hour = 12) => Math.floor(isoDateToUtcMs(date) / 1000) + hour * 3600;
const pending = (id: string, date: IsoDate, amount: string, description: string): SfTxn => ({ id, posted: 0, transacted_at: unix(date), amount, description, pending: true });
const posted = (id: string, date: IsoDate, amount: string, description: string, postedOn?: IsoDate): SfTxn => ({
  id,
  posted: unix(postedOn ?? date),
  ...(postedOn ? { transacted_at: unix(date) } : {}),
  amount,
  description,
  pending: false,
});

const CSV_MAPPING = {
  hasHeader: true,
  date: { column: "Date", format: "YYYY-MM-DD" as const },
  description: { column: "Description" },
  amount: { mode: "single" as const, column: "Amount" },
};
async function csvRows(lines: Array<[IsoDate, string, string]>): Promise<MappedRow[]> {
  const { rows, errors } = await mapCsvRows([["Date", "Description", "Amount"], ...lines.map(([d, desc, amt]) => [d, desc, amt])], CSV_MAPPING);
  expect(errors).toEqual([]);
  return rows;
}

/**
 * Audit batch a5-ingest-transfers: one purchase is one row, whichever way it arrives (the
 * feed, a bank CSV over the same days, a reconnected bank, a re-keyed feed, a pending item
 * that posts late, with a tip, or next to its pending copy).
 */
describe.skipIf(!TEST_DATABASE_URL)("one row per purchase across sources (audit a5-ingest-transfers)", () => {
  let t: TestDb;
  let connectionId: string;

  const acct = (id: string, name: string, transactions: SfTxn[], balance = "1000.00", asOf: IsoDate = "2026-10-19"): SfAccount => ({
    org: { name: "First Example Bank" },
    id,
    name,
    currency: "USD",
    balance,
    "balance-date": unix(asOf, 6),
    transactions,
  });
  const set = (accounts: SfAccount[], errlist: SimplefinAccountSet["errlist"] = []): SimplefinAccountSet => ({ errors: [], errlist, accounts });
  const sync = (accounts: SfAccount[], windowStart: IsoDate, now: IsoDate, errlist: SimplefinAccountSet["errlist"] = [], conn = connectionId) =>
    applyAccountSet(t.db, { connectionId: conn, accountSet: set(accounts, errlist), windowStart, now: new Date(`${now}T18:00:00Z`) });
  const ledger = (accountExternalId?: string) =>
    t.db
      .select({
        id: transaction.id,
        ext: transaction.externalId,
        source: transaction.source,
        date: transaction.date,
        amount: transaction.amountCents,
        pending: transaction.pending,
        payee: payee.name,
        categoryId: transaction.categoryId,
        notes: transaction.notes,
        isTransfer: transaction.isTransfer,
        pairId: transaction.transferPairId,
        account: account.externalId,
        accountId: transaction.accountId,
      })
      .from(transaction)
      .innerJoin(account, eq(account.id, transaction.accountId))
      .leftJoin(payee, eq(payee.id, transaction.payeeId))
      .where(accountExternalId ? eq(account.externalId, accountExternalId) : undefined)
      .orderBy(asc(transaction.date), asc(transaction.amountCents));
  const sum = (rows: Array<{ amount: bigint }>) => rows.reduce((s, r) => s + r.amount, 0n);
  const accountId = async (externalId: string) => (await t.db.select({ id: account.id }).from(account).where(eq(account.externalId, externalId)))[0]!.id;
  const categoryId = async (name: string) => {
    const [row] = await t.db.insert(category).values({ name, bucket: "spending", position: 50 }).onConflictDoNothing().returning({ id: category.id });
    return row?.id ?? (await t.db.select({ id: category.id }).from(category).where(eq(category.name, name)))[0]!.id;
  };

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.cleanup();
  });
  beforeEach(async () => {
    await t.db.delete(transaction);
    await t.db.delete(account);
    await t.db.delete(connection);
    await t.db.delete(rule);
    await t.db.delete(payee);
    const [conn] = await t.db.insert(connection).values({ type: "simplefin", name: "Bank" }).returning({ id: connection.id });
    connectionId = conn!.id;
  });

  it("a5-ingest-transfers-01: a bank CSV over days the sync covers is flagged in the preview and adds only the rows the feed lacks; sync, CSV, sync again", async () => {
    await sync(
      [
        acct("CHK", "Everyday Checking", [
          posted("T1", "2026-10-05", "-45.32", "KING SOOPERS #0123 DENVER CO"),
          posted("T2", "2026-10-10", "-12.50", "SQ *BLUE BOTTLE COFFEE"),
          pending("P1", "2026-10-18", "-60.00", "TST* TAPHOUSE DENVER"),
        ]),
      ],
      "2026-09-20",
      "2026-10-19",
    );
    const checking = await accountId("CHK");
    // The bank's export for 10-01 to 10-19: its own descriptions and dates, the taphouse already posted, and one row the feed never sent.
    const rows = await csvRows([
      ["2026-10-06", "KING SOOPERS 0123", "-45.32"],
      ["2026-10-10", "BLUE BOTTLE COFFEE", "-12.50"],
      ["2026-10-12", "NETFLIX.COM", "-15.49"],
      ["2026-10-19", "TAPHOUSE DENVER", "-60.00"],
    ]);
    const dupes = await csvDuplicateIds(t.db, checking, rows);
    expect(rows.filter((r) => dupes.has(r.externalId)).map((r) => r.description)).toEqual(["KING SOOPERS 0123", "BLUE BOTTLE COFFEE", "TAPHOUSE DENVER"]);

    const first = await importCsvRows(t.db, { accountId: checking, rows });
    expect(first).toMatchObject({ created: 1, duplicates: 3, replacedPending: 0 });
    let book = await ledger("CHK");
    expect(book.map((r) => [r.ext, r.source, r.pending])).toEqual([
      ["T1", "simplefin", false],
      ["T2", "simplefin", false],
      [rows[2]!.externalId, "csv", false],
      ["P1", "simplefin", true],
    ]);
    // A re-import (the same file, or the preview after the commit) knows every row.
    expect((await csvDuplicateIds(t.db, checking, rows)).size).toBe(4);
    expect(await importCsvRows(t.db, { accountId: checking, rows })).toMatchObject({ created: 0, duplicates: 3, updated: 0 });

    // The next sync posts the taphouse under a new id; the pending row is replaced in place, never doubled by the CSV's copy.
    const again = await sync(
      [
        acct("CHK", "Everyday Checking", [
          posted("T1", "2026-10-05", "-45.32", "KING SOOPERS #0123 DENVER CO"),
          posted("T2", "2026-10-10", "-12.50", "SQ *BLUE BOTTLE COFFEE"),
          posted("T3", "2026-10-18", "-60.00", "TST* TAPHOUSE DENVER", "2026-10-20"),
        ]),
      ],
      "2026-10-12",
      "2026-10-20",
    );
    expect(again.stats).toMatchObject({ created: 0, replacedPending: 1, removedPending: 0 });
    book = await ledger("CHK");
    expect(book).toHaveLength(4);
    expect(sum(book)).toBe(-4532n - 1250n - 1549n - 6000n);
    expect(await importCsvRows(t.db, { accountId: checking, rows })).toMatchObject({ created: 0 });
    expect(await ledger("CHK")).toHaveLength(4);
  });

  it("a5-ingest-transfers-01: rows imported from a CSV first are taken over by the feed's items, not doubled, and a re-import stays idempotent", async () => {
    await sync([acct("CHK", "Everyday Checking", [])], "2026-09-20", "2026-09-30");
    const checking = await accountId("CHK");
    const dining = await categoryId("Dining (a5)");
    const rows = await csvRows([
      ["2026-10-02", "KING SOOPERS 0123", "-45.32"],
      ["2026-10-03", "SHELL OIL 57442", "-40.00"],
      ["2026-10-03", "SHELL OIL 57442", "-40.00"],
    ]);
    expect(await importCsvRows(t.db, { accountId: checking, rows })).toMatchObject({ created: 3, duplicates: 0 });
    const csvKing = (await ledger("CHK"))[0]!;
    await t.db.update(transaction).set({ categoryId: dining, categoryLocked: true, notes: "mine" }).where(eq(transaction.id, csvKing.id));

    // The feed brings the King Soopers row and one of the two fills (the other has not posted yet).
    const result = await sync(
      [
        acct("CHK", "Everyday Checking", [
          posted("T1", "2026-10-01", "-45.32", "KING SOOPERS #0123 DENVER CO", "2026-10-02"),
          posted("T2", "2026-10-03", "-40.00", "SHELL OIL 57442 DENVER CO"),
        ]),
      ],
      "2026-09-23",
      "2026-10-04",
    );
    expect(result.stats).toMatchObject({ created: 0, duplicates: 2 });
    let book = await ledger("CHK");
    expect(book).toHaveLength(3);
    const king = book.find((r) => r.id === csvKing.id)!;
    // The feed's id and date, the household's category and note.
    expect(king).toMatchObject({ ext: "T1", source: "simplefin", date: "2026-10-01", categoryId: dining, notes: "mine" });
    expect(book.filter((r) => r.ext === "T2")).toHaveLength(1);

    expect(await importCsvRows(t.db, { accountId: checking, rows })).toMatchObject({ created: 0, duplicates: 2, updated: 0 });
    const next = await sync(
      [
        acct("CHK", "Everyday Checking", [
          posted("T1", "2026-10-01", "-45.32", "KING SOOPERS #0123 DENVER CO", "2026-10-02"),
          posted("T2", "2026-10-03", "-40.00", "SHELL OIL 57442 DENVER CO"),
          posted("T9", "2026-10-03", "-40.00", "SHELL OIL 57442 DENVER CO", "2026-10-05"),
        ]),
      ],
      "2026-09-26",
      "2026-10-06",
    );
    expect(next.stats).toMatchObject({ created: 0, duplicates: 1 });
    book = await ledger("CHK");
    expect(book).toHaveLength(3);
    expect(book.map((r) => r.ext).sort()).toEqual(["T1", "T2", "T9"]);
    expect(sum(book)).toBe(-4532n - 8000n);
  });

  it("a5-ingest-transfers-02: removing a connection and adding it again re-attaches its accounts, so nothing is doubled", async () => {
    const accounts = [
      acct("CHK", "Everyday Checking", [posted("T1", "2026-10-05", "-45.32", "KING SOOPERS #0123"), posted("T2", "2026-10-06", "-500.00", "ONLINE PMT VISA CARD")], "1000.00"),
      acct("CARD", "Sapphire Visa", [posted("C1", "2026-10-07", "500.00", "PAYMENT THANK YOU")], "-200.00"),
    ];
    const first = await sync(accounts, "2026-09-20", "2026-10-19");
    expect(first).toMatchObject({ accountsCreated: 2, transfersPaired: 1 });
    const before = await ledger();

    await t.db.delete(connection).where(eq(connection.id, connectionId));
    const [conn2] = await t.db.insert(connection).values({ type: "simplefin", name: "Bank again" }).returning({ id: connection.id });
    const second = await sync(accounts, "2026-07-18", "2026-10-19", [], conn2!.id);
    expect(second).toMatchObject({ accountsCreated: 0, accountsReattached: 2, stats: { created: 0 } });
    const all = await t.db.select({ id: account.id, connectionId: account.connectionId, balance: account.balanceCents }).from(account);
    expect(all).toHaveLength(2);
    expect(all.every((a) => a.connectionId === conn2!.id)).toBe(true);
    expect(all.reduce((s, a) => s + (a.balance ?? 0n), 0n)).toBe(80000n);
    expect((await ledger()).map((r) => [r.id, r.ext, r.pairId])).toEqual(before.map((r) => [r.id, r.ext, r.pairId]));
  });

  it("a5-ingest-transfers-02: a feed that re-keys the transaction ids of an account keeps one row per purchase", async () => {
    await sync([acct("CHK", "Everyday Checking", [posted("T1", "2026-10-05", "-45.32", "KING SOOPERS #0123"), posted("T2", "2026-10-10", "-12.50", "SQ *BLUE BOTTLE")])], "2026-09-20", "2026-10-19");
    const rekeyed = await sync(
      [acct("CHK", "Everyday Checking", [posted("TRN-T1", "2026-10-05", "-45.32", "KING SOOPERS #0123"), posted("TRN-T2", "2026-10-10", "-12.50", "SQ *BLUE BOTTLE")])],
      "2026-07-18",
      "2026-10-20",
    );
    expect(rekeyed.stats).toMatchObject({ created: 0, duplicates: 2 });
    expect((await ledger()).map((r) => r.ext)).toEqual(["TRN-T1", "TRN-T2"]);
    // The old ids, should they come back, are known too.
    expect((await sync([acct("CHK", "Everyday Checking", [posted("T1", "2026-10-05", "-45.32", "KING SOOPERS #0123")])], "2026-10-01", "2026-10-21")).stats.created).toBe(0);
    expect(await ledger()).toHaveLength(2);
  });

  it("a5-ingest-transfers-02: an account the Bridge re-issued under a new id, or one with CSV history, can be linked to the feed account without doubling", async () => {
    const accounts = (chkId: string) => [
      acct(chkId, "Everyday Checking", [posted("T1", "2026-10-05", "-45.32", "KING SOOPERS #0123"), posted("T2", "2026-10-06", "-500.00", "ONLINE PMT VISA CARD")], "1000.00"),
      acct("CARD", "Sapphire Visa", [posted("C1", "2026-10-07", "500.00", "PAYMENT THANK YOU")], "-200.00"),
    ];
    await sync(accounts("ACT-CHK"), "2026-09-20", "2026-10-19");
    const oldChecking = await accountId("ACT-CHK");
    const groceries = await categoryId("Groceries (a5)");
    await t.db.update(transaction).set({ categoryId: groceries, categoryLocked: true }).where(eq(transaction.externalId, "T1"));
    await t.db.delete(connection).where(eq(connection.id, connectionId));
    const [conn2] = await t.db.insert(connection).values({ type: "simplefin", name: "Bank again" }).returning({ id: connection.id });
    // The Bridge re-linked the bank: the checking account comes back under a new id (and new transaction ids).
    const relinked = accounts("ACT-CHK-NEW").map((a) => (a.id === "ACT-CHK-NEW" ? { ...a, transactions: a.transactions.map((x) => ({ ...x, id: `N-${x.id}` })) } : a));
    const second = await sync(relinked, "2026-07-18", "2026-10-19", [], conn2!.id);
    expect(second).toMatchObject({ accountsCreated: 1, accountsReattached: 1 });
    const feedChecking = await accountId("ACT-CHK-NEW");

    const linked = await linkFeedAccount(t.db, { accountId: oldChecking, feedAccountId: feedChecking });
    expect(linked).toMatchObject({ merged: 2, moved: 0 });
    const accts = await t.db.select({ id: account.id, ext: account.externalId, connectionId: account.connectionId, balance: account.balanceCents }).from(account).orderBy(asc(account.externalId));
    expect(accts.map((a) => [a.id === oldChecking, a.ext, a.connectionId === conn2!.id])).toEqual([
      [true, "ACT-CHK-NEW", true],
      [false, "CARD", true],
    ]);
    let book = await ledger();
    expect(book).toHaveLength(3);
    expect(book.find((r) => r.amount === -4532n)).toMatchObject({ ext: "N-T1", categoryId: groceries, accountId: oldChecking });
    // The card payment is still one transfer.
    const payment = book.filter((r) => r.amount === -50000n || r.amount === 50000n);
    expect(payment.every((r) => r.isTransfer && r.pairId !== null && r.pairId === payment[0]!.pairId)).toBe(true);
    const third = await sync(relinked, "2026-10-12", "2026-10-20", [], conn2!.id);
    expect(third.stats.created).toBe(0);
    book = await ledger();
    expect(book).toHaveLength(3);

    // CSV history in a manual account, then a feed account for the same bank account: linking it merges the overlap.
    const [manual] = await t.db.insert(account).values({ name: "Credit Union", type: "savings", taxTreatment: "none" }).returning({ id: account.id });
    await importCsvRows(t.db, {
      accountId: manual!.id,
      rows: await csvRows([
        ["2026-10-01", "DIVIDEND EARNED", "1.23"],
        ["2026-10-08", "ACH DEPOSIT ACME PAYROLL", "2500.00"],
      ]),
    });
    await sync([acct("CU-SAV", "Credit Union Savings", [posted("S1", "2026-10-08", "2500.00", "ACH DEPOSIT ACME PAYROLL"), posted("S2", "2026-10-15", "-20.00", "FEE")])], "2026-07-18", "2026-10-19", [], conn2!.id);
    const feedSavings = await accountId("CU-SAV");
    expect(await linkFeedAccount(t.db, { accountId: manual!.id, feedAccountId: feedSavings })).toMatchObject({ merged: 1, moved: 1 });
    const savings = await t.db.select({ ext: transaction.externalId, source: transaction.source }).from(transaction).where(eq(transaction.accountId, manual!.id)).orderBy(asc(transaction.date));
    expect(savings.map((r) => r.source)).toEqual(["csv", "simplefin", "simplefin"]);
    expect(savings.map((r) => r.ext).slice(1)).toEqual(["S1", "S2"]);
  });

  it("a5-ingest-transfers-03: a hold pending for weeks is replaced when it posts, and one that dropped is removed", async () => {
    const hold = pending("P-CAR", "2026-10-01", "-412.00", "HERTZ RENT-A-CAR DENVER");
    const hotel = pending("P-HTL", "2026-10-02", "-300.00", "MARRIOTT DENVER TECH");
    await sync([acct("CARD", "Sapphire Visa", [hold, hotel])], "2026-09-25", "2026-10-02");
    for (const [windowStart, now] of [
      ["2026-09-25", "2026-10-09"],
      ["2026-10-02", "2026-10-16"],
      ["2026-10-09", "2026-10-19"],
    ] as const) {
      expect((await sync([acct("CARD", "Sapphire Visa", [hold, hotel])], windowStart, now)).stats).toMatchObject({ created: 0, removedPending: 0 });
    }
    // 10-20: the rental posts (transacted 10-01) and the hotel authorization has dropped.
    const posting = await sync([acct("CARD", "Sapphire Visa", [posted("T-CAR", "2026-10-01", "-412.00", "HERTZ RENT-A-CAR DENVER", "2026-10-20")])], "2026-10-12", "2026-10-20");
    expect(posting.stats).toMatchObject({ created: 0, replacedPending: 1, removedPending: 1 });
    const book = await ledger();
    expect(book.map((r) => [r.ext, r.pending, r.amount])).toEqual([["T-CAR", false, -41200n]]);
  });

  it("a5-ingest-transfers-06: a pending charge that posts with a tip, or a hold that settles higher under an account problem, keeps its row and the owner's edits", async () => {
    await sync(
      [acct("CHK", "Everyday Checking", [pending("P1", "2026-10-10", "-50.00", "TST* TAPHOUSE DENVER")]), acct("CARD", "Sapphire Visa", [pending("H1", "2026-10-02", "-120.00", "MARRIOTT DENVER TECH")])],
      "2026-09-25",
      "2026-10-10",
    );
    const dining = await categoryId("Dining (a5)");
    const travel = await categoryId("Travel (a5)");
    const [tap] = await t.db.select({ id: transaction.id }).from(transaction).where(eq(transaction.externalId, "P1"));
    await t.db.update(transaction).set({ categoryId: dining, categoryLocked: true, notes: "team dinner, expense it" }).where(eq(transaction.id, tap!.id));
    await setTransactionTags(t.db, tap!.id, ["work"]);
    await t.db.update(transaction).set({ categoryId: travel, categoryLocked: true, notes: "conference hotel" }).where(eq(transaction.externalId, "H1"));

    const result = await sync(
      [
        acct("CHK", "Everyday Checking", [posted("T1", "2026-10-10", "-60.00", "TAPHOUSE DENVER CO", "2026-10-11")]),
        acct("CARD", "Sapphire Visa", [posted("T2", "2026-10-02", "-135.40", "MARRIOTT DENVER TECH CTR", "2026-10-06")]),
      ],
      "2026-10-03",
      "2026-10-11",
      [{ code: "act.missingdata", msg: "Some data missing", account_id: "CARD" }],
    );
    expect(result.stats).toMatchObject({ created: 0, replacedPending: 2, removedPending: 0 });
    const book = await ledger();
    expect(book).toHaveLength(2);
    expect(book.find((r) => r.ext === "T1")).toMatchObject({ id: tap!.id, amount: -6000n, pending: false, categoryId: dining, notes: "team dinner, expense it" });
    const tags = await t.db.select({ name: tag.name }).from(transactionTag).innerJoin(tag, eq(tag.id, transactionTag.tagId)).where(eq(transactionTag.transactionId, tap!.id));
    expect(tags.map((x) => x.name)).toEqual(["work"]);
    expect(book.find((r) => r.ext === "T2")).toMatchObject({ amount: -13540n, categoryId: travel, notes: "conference hotel" });
  });

  it("a5-ingest-transfers-07: a posted charge from another merchant never takes over a pending row's payee, category or notes", async () => {
    await sync([acct("CHK", "Everyday Checking", [pending("P-SHELL", "2026-10-10", "-40.00", "SHELL OIL 57442")])], "2026-10-01", "2026-10-10");
    const fuel = await categoryId("Fuel (a5)");
    await t.db.update(transaction).set({ categoryId: fuel, categoryLocked: true, notes: "road trip fill-up" }).where(eq(transaction.externalId, "P-SHELL"));
    const result = await sync([acct("CHK", "Everyday Checking", [posted("T-COSTCO", "2026-10-12", "-40.00", "COSTCO WHSE #1234 AURORA CO")])], "2026-10-03", "2026-10-12");
    expect(result.stats).toMatchObject({ created: 1, replacedPending: 0, removedPending: 1 });
    const book = await ledger();
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ ext: "T-COSTCO", categoryId: null, notes: null });
    expect(book[0]!.payee).not.toBe("Shell Oil");
  });

  it("a5-ingest-transfers-08: rules at import see the merged payee, so a rule on it applies to every merged variant", async () => {
    await sync([acct("CHK", "Everyday Checking", [posted("A1", "2026-10-05", "-5.00", "STARBUCKS STORE 00123"), posted("A2", "2026-10-06", "-6.00", "SBUX MOBILE ORDER")])], "2026-09-20", "2026-10-07");
    const payees = await t.db.select().from(payee);
    const starbucks = payees.find((p) => p.name === "Starbucks Store")!;
    const sbux = payees.find((p) => p.name === "Sbux Mobile Order")!;
    // What PATCH /payees/:id { mergeFromId } does.
    await t.db.update(transaction).set({ payeeId: starbucks.id }).where(eq(transaction.payeeId, sbux.id));
    await addPayeeAlias(t.db, starbucks.id, sbux.name);
    await t.db.delete(payee).where(eq(payee.id, sbux.id));
    const dining = await categoryId("Dining (a5)");
    await t.db.insert(rule).values({ name: "Starbucks", position: 1, conditions: { payee: { op: "equals", value: "Starbucks Store" } }, actions: { setCategoryId: dining } });
    expect((await runRules(t.db, { scope: "uncategorized" })).changed).toBe(2);

    await sync(
      [
        acct("CHK", "Everyday Checking", [
          posted("A1", "2026-10-05", "-5.00", "STARBUCKS STORE 00123"),
          posted("A2", "2026-10-06", "-6.00", "SBUX MOBILE ORDER"),
          posted("A3", "2026-10-08", "-5.00", "STARBUCKS STORE 00123"),
          posted("A4", "2026-10-09", "-6.50", "SBUX MOBILE ORDER"),
        ]),
      ],
      "2026-10-01",
      "2026-10-10",
    );
    const book = await ledger();
    expect(book.map((r) => [r.ext, r.payee, r.categoryId])).toEqual([
      ["A1", "Starbucks Store", dining],
      ["A2", "Starbucks Store", dining],
      ["A3", "Starbucks Store", dining],
      ["A4", "Starbucks Store", dining],
    ]);
    // No payee was created for the alias.
    expect((await t.db.select({ n: sql<number>`count(*)::int` }).from(payee).where(eq(payee.name, "Sbux Mobile Order")))[0]!.n).toBe(0);
  });

  it("a5-ingest-transfers-11: a pending item listed next to its posted form is one row, with the owner's edits, while both are listed and after", async () => {
    await sync([acct("CHK", "Everyday Checking", [pending("P1", "2026-10-18", "-60.00", "TST* TAPHOUSE DENVER")])], "2026-10-10", "2026-10-18");
    await t.db.update(transaction).set({ notes: "birthday dinner" }).where(eq(transaction.externalId, "P1"));
    const both = [pending("P1", "2026-10-18", "-60.00", "TST* TAPHOUSE DENVER"), posted("T1", "2026-10-18", "-60.00", "TAPHOUSE DENVER CO", "2026-10-19")];
    expect((await sync([acct("CHK", "Everyday Checking", both)], "2026-10-11", "2026-10-19")).stats).toMatchObject({ created: 0, replacedPending: 1 });
    expect((await sync([acct("CHK", "Everyday Checking", both)], "2026-10-12", "2026-10-20")).stats).toMatchObject({ created: 0 });
    expect((await sync([acct("CHK", "Everyday Checking", [both[1]!])], "2026-10-13", "2026-10-21")).stats).toMatchObject({ created: 0, removedPending: 0 });
    const book = await ledger();
    expect(book.map((r) => [r.ext, r.pending, r.notes])).toEqual([["T1", false, "birthday dinner"]]);
  });

  it("keeps two purchases of one amount at one merchant on one day apart (no false merge)", async () => {
    await sync([acct("CHK", "Everyday Checking", [posted("C1", "2026-10-05", "-4.50", "SQ *BLUE BOTTLE COFFEE")])], "2026-09-28", "2026-10-05");
    const second = await sync(
      [acct("CHK", "Everyday Checking", [posted("C1", "2026-10-05", "-4.50", "SQ *BLUE BOTTLE COFFEE"), posted("C2", "2026-10-05", "-4.50", "SQ *BLUE BOTTLE COFFEE")])],
      "2026-09-28",
      "2026-10-06",
    );
    expect(second.stats).toMatchObject({ created: 1, duplicates: 0 });
    const checking = await accountId("CHK");
    // A CSV with both coffees and a third the feed does not have.
    const rows = await csvRows([
      ["2026-10-05", "BLUE BOTTLE COFFEE", "-4.50"],
      ["2026-10-05", "BLUE BOTTLE COFFEE", "-4.50"],
      ["2026-10-06", "BLUE BOTTLE COFFEE", "-4.50"],
    ]);
    expect(await importCsvRows(t.db, { accountId: checking, rows })).toMatchObject({ created: 1, duplicates: 2 });
    expect(await ledger()).toHaveLength(3);
    expect(
      (await t.db.select({ n: sql<number>`count(*)::int` }).from(transaction).where(and(eq(transaction.accountId, checking), eq(transaction.source, "csv"))))[0]!.n,
    ).toBe(1);
  });
});
