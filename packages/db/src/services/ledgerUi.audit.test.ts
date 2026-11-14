import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isoDateToUtcMs, type IsoDate, type SimplefinAccountSet } from "@meridian/shared";
import { account, category, connection, importLog, job, rule, split, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { runRules } from "./rules.js";
import { applyAccountSet, replayAccountSetTransactions } from "./sync.js";
import { createManualTransaction, getTransaction, listTransactions, setTransactionSplits, updateTransaction } from "./transactions.js";
import { markAsTransfers, pairTransactionsByHand } from "./transfers.js";

type SfAccount = SimplefinAccountSet["accounts"][number];
type SfTxn = SfAccount["transactions"][number];
const unix = (date: IsoDate) => Math.floor(isoDateToUtcMs(date) / 1000) + 12 * 3600;
const posted = (id: string, date: IsoDate, amount: string, description: string, transactedOn?: IsoDate): SfTxn => ({
  id,
  posted: unix(date),
  amount,
  description,
  pending: false,
  ...(transactedOn ? { transacted_at: unix(transactedOn) } : {}),
});
const pendingItem = (id: string, date: IsoDate, amount: string, description: string): SfTxn => ({ id, posted: 0, transacted_at: unix(date), amount, description, pending: true });
const audit = () => ({ userId: null, batchId: randomUUID() });

/**
 * Audit batch a8-ledger-ui (the ledger pages in the web app): the database side of the findings
 * whose fix is in a service. The routes are in apps/api/src/ledgerUi.audit.test.ts, the pages in
 * apps/web/src/components/ledgerAudit.test.tsx.
 */
describe.skipIf(!TEST_DATABASE_URL)("ledger pages, the services behind them (audit a8-ledger-ui)", () => {
  let t: TestDb;
  let connectionId: string;
  let checking: string;
  let savings: string;
  let groceries: string;
  let home: string;
  let gifts: string;

  const acct = (id: string, name: string, transactions: SfTxn[]): SfAccount => ({ org: { name: "Bank" }, id, name, currency: "USD", balance: "100.00", "balance-date": unix("2026-10-29"), transactions });
  const sync = (accounts: SfAccount[], errlist: SimplefinAccountSet["errlist"], windowStart: IsoDate, now: IsoDate) =>
    applyAccountSet(t.db, { connectionId, accountSet: { errors: [], errlist, accounts }, windowStart, now: new Date(`${now}T18:00:00Z`) });
  const splitLines = async (id: string) => t.db.select().from(split).where(eq(split.transactionId, id));
  const costco = async () => {
    const row = await createManualTransaction(t.db, { accountId: checking, date: "2026-11-02", amountCents: -123456n, payeeName: "Costco" });
    await setTransactionSplits(t.db, row.id, [
      { categoryId: groceries, amountCents: -100000n },
      { categoryId: home, amountCents: -25456n },
      { categoryId: gifts, amountCents: 2000n },
    ]);
    expect(await splitLines(row.id)).toHaveLength(3);
    return row.id;
  };
  const inGroceries = async () => (await listTransactions(t.db, { categoryId: groceries, planScope: true, from: "2026-11-01", to: "2026-11-30", limit: 100 })).items.map((r) => r.payeeName);

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
    [{ id: checking }] = (await t.db.insert(account).values({ name: "Checking", type: "checking", taxTreatment: "none" }).returning({ id: account.id })) as [{ id: string }];
    [{ id: savings }] = (await t.db.insert(account).values({ name: "Savings", type: "savings", taxTreatment: "none" }).returning({ id: account.id })) as [{ id: string }];
    const cat = async (name: string) => {
      const [r] = await t.db.insert(category).values({ name, bucket: "spending", position: 70 }).onConflictDoNothing().returning({ id: category.id });
      return r?.id ?? (await t.db.select({ id: category.id }).from(category).where(eq(category.name, name)))[0]!.id;
    };
    groceries = await cat("A8 Groceries");
    home = await cat("A8 Home");
    gifts = await cat("A8 Gifts");
  });

  describe("a8-ledger-ui-10: a row that becomes a transfer loses its split lines (a transfer has no split)", () => {
    it("marked as a transfer without its other leg", async () => {
      const id = await costco();
      expect(await inGroceries()).toEqual(["Costco"]);
      await updateTransaction(t.db, id, { isTransfer: true });
      expect(await splitLines(id)).toEqual([]);
      expect((await getTransaction(t.db, id))!.splits).toEqual([]);
      // The register's category filter (plan scope or not) no longer lists it as Groceries spending.
      expect(await inGroceries()).toEqual([]);
      expect((await listTransactions(t.db, { categoryId: groceries, limit: 100 })).items).toEqual([]);
    });

    it("paired by hand with the other leg", async () => {
      const id = await costco();
      const other = await createManualTransaction(t.db, { accountId: savings, date: "2026-11-03", amountCents: 123456n, payeeName: "Transfer from checking" });
      await t.db.transaction((tx) => pairTransactionsByHand(tx, id, other.id, audit()));
      expect(await splitLines(id)).toEqual([]);
      expect(await inGroceries()).toEqual([]);
    });

    it("marked by a rule run over every row", async () => {
      const id = await costco();
      // A feed row split by hand: its payee is the feed's, so "Run on all" still examines it.
      await t.db.update(transaction).set({ payeeLocked: false }).where(eq(transaction.id, id));
      await t.db.insert(rule).values({ name: "costco is a transfer", position: 1, conditions: { payee: { op: "equals", value: "Costco" } }, actions: { markTransfer: true } });
      await runRules(t.db, { scope: "all" });
      expect((await getTransaction(t.db, id))!.isTransfer).toBe(true);
      expect(await splitLines(id)).toEqual([]);
      expect(await inGroceries()).toEqual([]);
    });

    it("linked to an investment cash transfer (markAsTransfers)", async () => {
      const id = await costco();
      // A split is a hand categorization: the linker leaves it alone, as pairing does (audit b3 second round, Phase 3 decision A5).
      await t.db.transaction((tx) => markAsTransfers(tx, [id]));
      expect((await getTransaction(t.db, id))!.isTransfer).toBe(false);
      expect(await splitLines(id)).toHaveLength(3);
      expect(await inGroceries()).toEqual(["Costco"]);
      // A link set by hand marks it, and the lines go.
      await t.db.transaction((tx) => markAsTransfers(tx, [id], { byHand: true }));
      expect((await getTransaction(t.db, id))!.isTransfer).toBe(true);
      expect(await splitLines(id)).toEqual([]);
      expect(await inGroceries()).toEqual([]);
    });

    it("a row that stays a transfer keeps nothing, and a row that is not one keeps its lines", async () => {
      const id = await costco();
      const other = await createManualTransaction(t.db, { accountId: checking, date: "2026-11-05", amountCents: -2000n, payeeName: "Target" });
      await setTransactionSplits(t.db, other.id, [
        { categoryId: groceries, amountCents: -1500n },
        { categoryId: home, amountCents: -500n },
      ]);
      // Undoing the transfer leaves the row uncategorized; the lines are not restored.
      await updateTransaction(t.db, id, { isTransfer: true });
      await updateTransaction(t.db, id, { isTransfer: false });
      expect(await splitLines(id)).toEqual([]);
      expect((await getTransaction(t.db, id))!.categoryId).toBeNull();
      expect(await splitLines(other.id)).toHaveLength(2);
    });
  });

  it("a8-ledger-ui-10: migration 0008 removes the lines of rows that were made transfers before the fix, and only theirs", async () => {
    const id = await costco();
    const kept = await createManualTransaction(t.db, { accountId: checking, date: "2026-11-05", amountCents: -2000n, payeeName: "Target" });
    await setTransactionSplits(t.db, kept.id, [
      { categoryId: groceries, amountCents: -1500n },
      { categoryId: home, amountCents: -500n },
    ]);
    // The state the old code left: a transfer that kept its lines.
    await t.db.update(transaction).set({ isTransfer: true }).where(eq(transaction.id, id));
    const sqlText = readFileSync(new URL("../../drizzle/0008_transfer_splits.sql", import.meta.url), "utf8");
    await t.db.execute(sql.raw(sqlText));
    expect(await splitLines(id)).toEqual([]);
    expect(await splitLines(kept.id)).toHaveLength(2);
  });

  it("a8-ledger-ui-11: an act.* entry names the account by the name the household knows, not the Bridge's id", async () => {
    const result = await sync(
      [acct("ACT-9f8e7d6c-5b4a", "Joint Checking", [])],
      [
        { code: "act.missingdata", account_id: "ACT-9f8e7d6c-5b4a" },
        { code: "act.failed", account_id: "ACT-gone" },
      ],
      "2026-10-01",
      "2026-10-29",
    );
    const missing = result.errors.find((e) => e.code === "act.missingdata")!;
    expect(missing.message).toBe("Joint Checking: The Bridge returned incomplete data for this account. It will retry on the next sync.");
    // An account the app does not have keeps the Bridge's id, said as such.
    expect(result.errors.find((e) => e.code === "act.failed")!.message).toContain("(Bridge account ACT-gone)");

    // A renamed account is named as the household renamed it.
    await t.db.update(account).set({ name: "Our checking" }).where(eq(account.externalId, "ACT-9f8e7d6c-5b4a"));
    const again = await sync([acct("ACT-9f8e7d6c-5b4a", "Joint Checking", [])], [{ code: "act.missingdata", account_id: "ACT-9f8e7d6c-5b4a" }], "2026-10-01", "2026-10-29");
    expect(again.errors[0]!.message.startsWith("Our checking: ")).toBe(true);
  });

  it("a8-ledger-ui-12: each leg of a pair names its other leg (account and date); a hand-marked transfer names none", async () => {
    const out = await createManualTransaction(t.db, { accountId: checking, date: "2026-11-02", amountCents: -100000n, payeeName: "To savings" });
    const inflow = await createManualTransaction(t.db, { accountId: savings, date: "2026-11-03", amountCents: 100000n, payeeName: "From checking" });
    const lone = await createManualTransaction(t.db, { accountId: checking, date: "2026-11-04", amountCents: -5000n, payeeName: "To brokerage elsewhere" });
    await t.db.transaction((tx) => pairTransactionsByHand(tx, out.id, inflow.id, audit()));
    await updateTransaction(t.db, lone.id, { isTransfer: true });
    const items = (await listTransactions(t.db, { transfers: "only", limit: 100 })).items;
    const byId = new Map(items.map((r) => [r.id, r]));
    expect(byId.get(out.id)!.transferPartner).toEqual({ id: inflow.id, accountId: savings, accountName: "Savings", date: "2026-11-03" });
    expect(byId.get(inflow.id)!.transferPartner).toEqual({ id: out.id, accountId: checking, accountName: "Checking", date: "2026-11-02" });
    expect(byId.get(lone.id)!.transferPartner).toBeNull();
    expect((await getTransaction(t.db, out.id))!.transferPartner).toMatchObject({ accountName: "Savings" });
  });

  it("a8-ledger-ui-02: a feed account's transactions skipped while it was closed are read again from the stored payloads once it is reopened", async () => {
    const day1 = acct("SAV", "Savings", [posted("S1", "2026-09-28", "-10.00", "FEE")]);
    await sync([day1], [], "2026-09-01", "2026-09-30");
    const [sav] = await t.db.select().from(account).where(eq(account.externalId, "SAV"));
    await t.db.update(account).set({ closed: true }).where(eq(account.id, sav!.id));
    // Closed from Oct 1: the weekly syncs carry its transactions, which it does not take.
    const weekly = [
      acct("SAV", "Savings", [posted("S2", "2026-10-03", "25.00", "INTEREST"), posted("S3", "2026-10-06", "-40.00", "WITHDRAWAL")]),
      acct("SAV", "Savings", [posted("S4", "2026-10-13", "500.00", "DEPOSIT")]),
    ];
    for (const set of weekly) await sync([set], [], "2026-10-01", "2026-10-15");
    const ids = async () => (await t.db.select({ ext: transaction.externalId }).from(transaction).where(eq(transaction.accountId, sav!.id))).map((r) => r.ext).sort();
    expect(await ids()).toEqual(["S1"]);

    await t.db.update(account).set({ closed: false }).where(eq(account.id, sav!.id));
    // What the reopen queues (simplefin.reprocess_transactions) replays every stored payload; these are the payloads.
    for (const set of [day1, ...weekly]) await replayAccountSetTransactions(t.db, { connectionId, accountSet: { errors: [], errlist: [], accounts: [set] }, now: new Date("2026-10-30T18:00:00Z") });
    expect(await ids()).toEqual(["S1", "S2", "S3", "S4"]);
  });

  /**
   * Second round (the reviewer's probe chk11Reopen): a purchase pending when the account was
   * closed usually posts under the same id while it is closed. The replay skipped a known id,
   * so the row stayed pending, and the next live sync, whose window starts after the day it
   * posted, deleted it as a pending row the feed no longer lists.
   */
  describe("a8-ledger-ui-02, second round: a purchase pending when the account was closed is not lost when it posts while it is closed", () => {
    const rows = async (accountId: string) =>
      (await t.db.select({ id: transaction.id, ext: transaction.externalId, pending: transaction.pending, date: transaction.date, amount: transaction.amountCents, notes: transaction.notes, categoryId: transaction.categoryId }).from(transaction).where(eq(transaction.accountId, accountId)))
        .map((r) => ({ ...r, amount: r.amount.toString() }))
        .sort((a, b) => (a.ext ?? "").localeCompare(b.ext ?? ""));
    const replayAll = async (sets: SfAccount[]) => {
      for (const set of sets) await replayAccountSetTransactions(t.db, { connectionId, accountSet: { errors: [], errlist: [], accounts: [set] }, now: new Date("2026-10-30T18:00:00Z") });
    };
    /** Sep 30: the hardware store purchase is pending, and the household categorizes it and writes a note on it. */
    const openWithPending = async () => {
      const first = acct("SAV", "Savings", [pendingItem("T1", "2026-09-29", "-42.00", "HARDWARE STORE")]);
      await sync([first], [], "2026-09-23", "2026-09-30");
      const [sav] = await t.db.select().from(account).where(eq(account.externalId, "SAV"));
      const [row] = await t.db.select().from(transaction).where(eq(transaction.accountId, sav!.id));
      await updateTransaction(t.db, row!.id, { categoryId: home, notes: "the new shelf" });
      await t.db.update(account).set({ closed: true }).where(eq(account.id, sav!.id));
      return { sav: sav!.id, rowId: row!.id, first };
    };

    it("posted under the same id: the replay posts the row, with the household's category and note, and the next sync keeps it", async () => {
      const { sav, rowId, first } = await openWithPending();
      // Oct 8 and Oct 22, closed: the purchase has posted (Oct 2) under its id; interest comes in. The sync takes none of it.
      const oct8 = acct("SAV", "Savings", [posted("T1", "2026-10-02", "-42.00", "HARDWARE STORE", "2026-09-29")]);
      const oct22 = acct("SAV", "Savings", [posted("T9", "2026-10-20", "5.00", "INTEREST")]);
      await sync([oct8], [], "2026-09-23", "2026-10-08");
      await sync([oct22], [], "2026-10-01", "2026-10-22");
      expect((await rows(sav)).map((r) => `${r.ext}:${r.pending ? "pending" : "posted"}`)).toEqual(["T1:pending"]);

      // Oct 30: reopened; the queued replay reads every stored payload, then the next sync asks from the mark.
      await t.db.update(account).set({ closed: false }).where(eq(account.id, sav));
      await replayAll([first, oct8, oct22]);
      expect(await rows(sav)).toEqual([
        { id: rowId, ext: "T1", pending: false, date: "2026-09-29", amount: "-4200", notes: "the new shelf", categoryId: home },
        expect.objectContaining({ ext: "T9", pending: false, amount: "500" }),
      ]);
      await sync([acct("SAV", "Savings", [posted("T10", "2026-10-29", "-3.00", "FEE")])], [], "2026-10-15", "2026-10-30");
      expect((await rows(sav)).map((r) => `${r.ext}:${r.pending ? "pending" : "posted"}`)).toEqual(["T1:posted", "T10:posted", "T9:posted"]);
      // Replayed again, nothing changes.
      await replayAll([first, oct8, oct22]);
      expect(await rows(sav)).toHaveLength(3);
    });

    it("posted under a new id: the replay replaces the pending row in place, as the sync would have, so it is one row and keeps its edits", async () => {
      const { sav, rowId, first } = await openWithPending();
      const oct8 = acct("SAV", "Savings", [posted("T1-POSTED", "2026-10-02", "-42.00", "HARDWARE STORE #12")]);
      await sync([oct8], [], "2026-09-23", "2026-10-08");
      await t.db.update(account).set({ closed: false }).where(eq(account.id, sav));
      await replayAll([first, oct8]);
      expect(await rows(sav)).toEqual([{ id: rowId, ext: "T1-POSTED", pending: false, date: "2026-10-02", amount: "-4200", notes: "the new shelf", categoryId: home }]);
      await sync([acct("SAV", "Savings", [])], [], "2026-10-15", "2026-10-30");
      expect(await rows(sav)).toHaveLength(1);
    });

    it("a sync that runs before the reopen's replay keeps the account's pending rows; once the replay is done, a pending row the bank dropped goes as usual", async () => {
      const { sav, rowId, first } = await openWithPending();
      // A second purchase, pending at the close, that the bank then drops (a hold released).
      const withHold = acct("SAV", "Savings", [pendingItem("T1", "2026-09-29", "-42.00", "HARDWARE STORE"), pendingItem("H1", "2026-09-30", "-100.00", "HOTEL HOLD")]);
      await t.db.update(account).set({ closed: false }).where(eq(account.id, sav));
      await sync([withHold], [], "2026-09-23", "2026-09-30");
      await t.db.update(account).set({ closed: true }).where(eq(account.id, sav));
      const oct8 = acct("SAV", "Savings", [posted("T1", "2026-10-02", "-42.00", "HARDWARE STORE", "2026-09-29")]);
      await sync([oct8], [], "2026-09-23", "2026-10-08");

      // Reopened: the API queues the replay; a sync already due runs first, with a window that starts after Oct 2.
      await t.db.update(account).set({ closed: false }).where(eq(account.id, sav));
      const [waiting] = await t.db
        .insert(job)
        .values({ type: "simplefin.reprocess_transactions", payload: { connectionId, reason: "account_reopened", accountId: sav, dedupeKey: `account_reopened:${sav}` }, status: "queued", runAt: new Date("2026-10-30T18:00:00Z") })
        .returning({ id: job.id });
      try {
        await sync([acct("SAV", "Savings", [])], [], "2026-10-15", "2026-10-30");
        expect((await rows(sav)).map((r) => `${r.ext}:${r.pending ? "pending" : "posted"}`)).toEqual(["H1:pending", "T1:pending"]);
        await replayAll([first, withHold, oct8]);
        await t.db.update(job).set({ status: "done" }).where(eq(job.id, waiting!.id));
        await sync([acct("SAV", "Savings", [])], [], "2026-10-15", "2026-10-31");
        expect(await rows(sav)).toEqual([{ id: rowId, ext: "T1", pending: false, date: "2026-09-29", amount: "-4200", notes: "the new shelf", categoryId: home }]);
      } finally {
        await t.db.delete(job).where(eq(job.id, waiting!.id));
      }
    });

    it("guard: a replay never gives an old posted item a pending row the ledger got after that payload was fetched", async () => {
      // Oct 8's response carried a coffee an older reader missed; Oct 10's sync brought a second coffee, still pending.
      const [l8, l10] = await t.db
        .insert(importLog)
        .values([
          { connectionId, kind: "simplefin.sync", status: "ok", startedAt: new Date("2026-10-08T18:00:00Z") },
          { connectionId, kind: "simplefin.sync", status: "ok", startedAt: new Date("2026-10-10T18:00:00Z") },
        ])
        .returning({ id: importLog.id });
      const oct10 = acct("CHK", "Everyday", [pendingItem("COF-NEW", "2026-10-09", "-4.50", "SQ *BLUE BOTTLE")]);
      await applyAccountSet(t.db, { connectionId, accountSet: { errors: [], errlist: [], accounts: [oct10] }, windowStart: "2026-10-01", importLogId: l10!.id, now: new Date("2026-10-10T18:00:00Z") });
      const [chk] = await t.db.select().from(account).where(eq(account.externalId, "CHK"));
      const oct8 = acct("CHK", "Everyday", [posted("COF-OLD", "2026-10-07", "-4.50", "SQ *BLUE BOTTLE")]);
      await replayAccountSetTransactions(t.db, { connectionId, accountSet: { errors: [], errlist: [], accounts: [oct8] }, importLogId: l8!.id, now: new Date("2026-10-30T18:00:00Z") });
      expect((await rows(chk!.id)).map((r) => `${r.ext}:${r.pending ? "pending" : "posted"}`)).toEqual(["COF-NEW:pending", "COF-OLD:posted"]);
    });
  });
});
