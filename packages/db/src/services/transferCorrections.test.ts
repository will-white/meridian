import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isoDateToUtcMs, mapCsvRows, type IsoDate, type SimplefinAccountSet } from "@meridian/shared";
import { account, auditLog, category, connection, importLog, rule, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { importCsvRows, undoCsvImport } from "./csvImport.js";
import { applyAccountSet } from "./sync.js";
import { createManualTransaction, deleteTransaction, updateTransaction } from "./transactions.js";
import { pairTransactionsByHand, transferCandidates } from "./transfers.js";

type SfAccount = SimplefinAccountSet["accounts"][number];
type SfTxn = SfAccount["transactions"][number];
const unix = (date: IsoDate) => Math.floor(isoDateToUtcMs(date) / 1000) + 12 * 3600;
const pending = (id: string, date: IsoDate, amount: string, description: string): SfTxn => ({ id, posted: 0, transacted_at: unix(date), amount, description, pending: true });
const posted = (id: string, date: IsoDate, amount: string, description: string): SfTxn => ({ id, posted: unix(date), amount, description, pending: false });
const audit = () => ({ userId: null, batchId: randomUUID() });

/** Audit batch a5-ingest-transfers: what the household corrects stays corrected. */
describe.skipIf(!TEST_DATABASE_URL)("transfer and ledger corrections (audit a5-ingest-transfers)", () => {
  let t: TestDb;
  let connectionId: string;
  const acct = (id: string, name: string, transactions: SfTxn[]): SfAccount => ({
    org: { name: "Bank" },
    id,
    name,
    currency: "USD",
    balance: "100.00",
    "balance-date": unix("2026-10-19"),
    transactions,
  });
  const sync = (accounts: SfAccount[], windowStart: IsoDate, now: IsoDate) =>
    applyAccountSet(t.db, { connectionId, accountSet: { errors: [], errlist: [], accounts }, windowStart, now: new Date(`${now}T18:00:00Z`) });
  const row = async (externalId: string) => (await t.db.select().from(transaction).where(eq(transaction.externalId, externalId)))[0]!;
  const categoryId = async (name: string) => {
    const [r] = await t.db.insert(category).values({ name, bucket: "spending", position: 60 }).onConflictDoNothing().returning({ id: category.id });
    return r?.id ?? (await t.db.select({ id: category.id }).from(category).where(eq(category.name, name)))[0]!.id;
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
    const [conn] = await t.db.insert(connection).values({ type: "simplefin", name: "Bank" }).returning({ id: connection.id });
    connectionId = conn!.id;
  });

  it("a5-ingest-transfers-04: 'transfer · undo' lasts through the next sync and the next CSV import, with the categories the owner gave", async () => {
    const dinner = posted("D1", "2026-10-10", "-84.00", "CORNER BISTRO");
    const deposit = posted("R1", "2026-10-12", "84.00", "MOBILE DEPOSIT");
    expect((await sync([acct("CARD", "Sapphire Visa", [dinner]), acct("CHK", "Everyday Checking", [deposit])], "2026-10-01", "2026-10-12")).transfersPaired).toBe(1);
    expect((await row("D1")).isTransfer).toBe(true);

    await updateTransaction(t.db, (await row("D1")).id, { isTransfer: false });
    const after = await Promise.all([row("D1"), row("R1")]);
    expect(after.map((r) => [r.isTransfer, r.transferPairId])).toEqual([
      [false, null],
      [false, null],
    ]);
    // Undone but not yet categorized: an unrelated sync does not pair them again.
    const coffee = posted("K1", "2026-10-13", "-4.50", "SQ *BLUE BOTTLE");
    expect((await sync([acct("CARD", "Sapphire Visa", [dinner, coffee]), acct("CHK", "Everyday Checking", [deposit])], "2026-10-05", "2026-10-13")).transfersPaired).toBe(0);
    const [savings] = await t.db.insert(account).values({ name: "Savings", type: "savings", taxTreatment: "none" }).returning({ id: account.id });
    const { rows } = await mapCsvRows([["Date", "Description", "Amount"], ["2026-10-11", "INTEREST", "0.42"]], {
      hasHeader: true,
      date: { column: "Date", format: "YYYY-MM-DD" },
      description: { column: "Description" },
      amount: { mode: "single", column: "Amount" },
    });
    expect((await importCsvRows(t.db, { accountId: savings!.id, rows })).transfersPaired).toBe(0);
    expect((await row("D1")).isTransfer).toBe(false);

    // Categorized by hand: still apart, categories kept.
    const dining = await categoryId("Dining (a5-04)");
    const income = await categoryId("Other Income (a5-04)");
    await updateTransaction(t.db, (await row("D1")).id, { categoryId: dining });
    await updateTransaction(t.db, (await row("R1")).id, { categoryId: income });
    const later = posted("K2", "2026-10-14", "-3.75", "SQ *BLUE BOTTLE");
    expect((await sync([acct("CARD", "Sapphire Visa", [dinner, coffee, later]), acct("CHK", "Everyday Checking", [deposit])], "2026-10-06", "2026-10-14")).transfersPaired).toBe(0);
    expect([await row("D1"), await row("R1")].map((r) => [r.isTransfer, r.categoryId])).toEqual([
      [false, dining],
      [false, income],
    ]);
  });

  it("a5-ingest-transfers-04: a row the owner categorized by hand is not paired by automation", async () => {
    await sync([acct("CHK", "Everyday Checking", [posted("G1", "2026-10-10", "-250.00", "GIFT TO JORDAN")])], "2026-10-01", "2026-10-10");
    await updateTransaction(t.db, (await row("G1")).id, { categoryId: await categoryId("Gifts (a5-04)") });
    expect((await sync([acct("SAV", "Joint Savings", [posted("S1", "2026-10-11", "250.00", "ZELLE FROM JORDAN")])], "2026-10-01", "2026-10-11")).transfersPaired).toBe(0);
  });

  it("a5-ingest-transfers-05: removing a paired pending leg releases its partner, which pairs with the posted payment", async () => {
    const card = acct("CARD", "Sapphire Visa", [posted("C1", "2026-10-11", "500.00", "PAYMENT THANK YOU")]);
    const first = await sync([acct("CHK", "Everyday Checking", [pending("P-PMT", "2026-10-10", "-500.00", "ONLINE PMT VISA CARD")]), card], "2026-10-01", "2026-10-11");
    expect(first.transfersPaired).toBe(1);
    // The bank drops the pending item before the posted one appears.
    const second = await sync([acct("CHK", "Everyday Checking", []), card], "2026-10-04", "2026-10-12");
    expect(second.stats).toMatchObject({ removedPending: 1, releasedTransfers: 1 });
    expect(await row("C1")).toMatchObject({ isTransfer: false, transferPairId: null });
    const third = await sync([acct("CHK", "Everyday Checking", [posted("T1", "2026-10-12", "-500.00", "ONLINE PMT VISA CARD")]), card], "2026-10-05", "2026-10-13");
    expect(third).toMatchObject({ stats: { created: 1 }, transfersPaired: 1 });
    const [a, b] = [await row("T1"), await row("C1")];
    expect(a.isTransfer && b.isTransfer && a.transferPairId !== null && a.transferPairId === b.transferPairId).toBe(true);
  });

  it("a5-ingest-transfers-09: a row can be deleted; its partner is released, a feed row and a CSV row do not come back, an import can be undone", async () => {
    // A manual entry with a typo.
    const [cash] = await t.db.insert(account).values({ name: "Cash", type: "checking", taxTreatment: "none" }).returning({ id: account.id });
    const typo = await createManualTransaction(t.db, { accountId: cash!.id, date: "2026-10-10", amountCents: -45000n, payeeName: "Farmers market" });
    expect(await deleteTransaction(t.db, typo.id, audit())).toBe(true);
    expect(await deleteTransaction(t.db, typo.id, audit())).toBe(false);
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.entityId, typo.id));
    expect(audits.map((a) => [a.entity, a.action])).toEqual([["transaction", "delete"]]);

    // A feed row the owner deletes (a duplicate) is not brought back; its transfer partner is released.
    const accounts = [acct("CHK", "Everyday Checking", [posted("T2", "2026-10-06", "-500.00", "ONLINE PMT VISA CARD")]), acct("CARD", "Sapphire Visa", [posted("C1", "2026-10-07", "500.00", "PAYMENT THANK YOU")])];
    expect((await sync(accounts, "2026-10-01", "2026-10-08")).transfersPaired).toBe(1);
    expect(await deleteTransaction(t.db, (await row("T2")).id, audit())).toBe(true);
    expect(await row("C1")).toMatchObject({ isTransfer: false, transferPairId: null });
    expect((await sync(accounts, "2026-10-01", "2026-10-09")).stats).toMatchObject({ created: 0, duplicates: 1 });
    expect(await t.db.select().from(transaction).where(eq(transaction.externalId, "T2"))).toEqual([]);

    // A CSV import into the wrong account is undone, and can then be imported again; a single deleted CSV row does not come back.
    const { rows } = await mapCsvRows(
      [
        ["Date", "Description", "Amount"],
        ["2026-10-02", "GROCERY OUTLET", "-54.10"],
        ["2026-10-03", "ACME PAYROLL", "2500.00"],
      ],
      { hasHeader: true, date: { column: "Date", format: "YYYY-MM-DD" }, description: { column: "Description" }, amount: { mode: "single", column: "Amount" } },
    );
    const [log] = await t.db.insert(importLog).values({ kind: "csv", status: "ok" }).returning({ id: importLog.id });
    expect(await importCsvRows(t.db, { accountId: cash!.id, rows, importLogId: log!.id })).toMatchObject({ created: 2 });
    expect(await undoCsvImport(t.db, log!.id, audit())).toMatchObject({ removed: 2 });
    expect(await t.db.select().from(transaction).where(eq(transaction.accountId, cash!.id))).toEqual([]);
    await expect(undoCsvImport(t.db, log!.id, audit())).rejects.toMatchObject({ status: 409, code: "already_undone" });
    expect(await importCsvRows(t.db, { accountId: cash!.id, rows })).toMatchObject({ created: 2 });
    const grocery = (await t.db.select().from(transaction).where(eq(transaction.accountId, cash!.id)).orderBy(asc(transaction.date)))[0]!;
    expect(await deleteTransaction(t.db, grocery.id, audit())).toBe(true);
    expect(await importCsvRows(t.db, { accountId: cash!.id, rows })).toMatchObject({ created: 0, duplicates: 1 });
    expect(await t.db.select().from(transaction).where(eq(transaction.accountId, cash!.id))).toHaveLength(1);

    // Investment rows belong to the investment flows.
    const [inv] = await t.db.insert(transaction).values({ accountId: cash!.id, source: "investment", externalId: "inv:x", date: "2026-10-04", amountCents: 100n, rawDescription: "Dividend" }).returning({ id: transaction.id });
    await expect(deleteTransaction(t.db, inv!.id, audit())).rejects.toMatchObject({ status: 400, code: "investment_row" });
  });

  it("a5-ingest-transfers-12: two rows can be paired by hand and a row marked as a transfer loses an automatic category", async () => {
    const groceries = await categoryId("Groceries (a5-12)");
    await t.db.insert(rule).values({ name: "pmt", position: 1, conditions: { description: { op: "contains", value: "PMT" } }, actions: { setCategoryId: groceries } });
    // A card payment that posted five days apart: too far for automatic pairing.
    await sync(
      [acct("CHK", "Everyday Checking", [posted("T1", "2026-10-02", "-500.00", "ONLINE PMT VISA CARD")]), acct("CARD", "Sapphire Visa", [posted("C1", "2026-10-07", "500.00", "PAYMENT THANK YOU")])],
      "2026-09-25",
      "2026-10-08",
    );
    const [out, inflow] = [await row("T1"), await row("C1")];
    expect(out).toMatchObject({ isTransfer: false, categoryId: groceries });
    const candidates = await transferCandidates(t.db, out.id);
    expect(candidates.map((c) => c.id)).toEqual([inflow.id]);
    const pairId = await pairTransactionsByHand(t.db, out.id, inflow.id, audit());
    const [a, b] = [await row("T1"), await row("C1")];
    expect([a, b].map((r) => [r.isTransfer, r.transferPairId, r.categoryId])).toEqual([
      [true, pairId, null],
      [true, pairId, null],
    ]);
    await expect(pairTransactionsByHand(t.db, out.id, inflow.id, audit())).rejects.toMatchObject({ status: 409, code: "already_paired" });
    // Undo, then pair again by hand: the owner's choice wins over the dismissal.
    await updateTransaction(t.db, out.id, { isTransfer: false });
    expect(await transferCandidates(t.db, out.id)).toHaveLength(1);
    await pairTransactionsByHand(t.db, out.id, inflow.id, audit());
    expect((await row("C1")).isTransfer).toBe(true);

    // Not equal and opposite, or the same account: refused.
    const [x] = await t.db.select().from(transaction).where(inArray(transaction.externalId, ["T1"]));
    const [cash] = await t.db.insert(account).values({ name: "Wallet", type: "checking", taxTreatment: "none" }).returning({ id: account.id });
    const other = await createManualTransaction(t.db, { accountId: cash!.id, date: "2026-10-03", amountCents: 499n, payeeName: "Refund" });
    await expect(pairTransactionsByHand(t.db, other.id, x!.id, audit())).rejects.toMatchObject({ status: 400, code: "not_opposite" });

    // Marking a row as a transfer by hand clears a category automation gave it; a hand-picked one stays.
    const lone = await createManualTransaction(t.db, { accountId: cash!.id, date: "2026-10-04", amountCents: -2000n, payeeName: "Move to envelope" });
    await t.db.update(transaction).set({ categoryId: groceries, categoryLocked: false }).where(eq(transaction.id, lone.id));
    expect(await updateTransaction(t.db, lone.id, { isTransfer: true })).toMatchObject({ isTransfer: true, categoryId: null });
  });
});
