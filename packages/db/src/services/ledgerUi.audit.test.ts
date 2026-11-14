import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isoDateToUtcMs, type IsoDate, type SimplefinAccountSet } from "@meridian/shared";
import { account, category, connection, rule, split, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { runRules } from "./rules.js";
import { applyAccountSet, replayAccountSetTransactions } from "./sync.js";
import { createManualTransaction, getTransaction, listTransactions, setTransactionSplits, updateTransaction } from "./transactions.js";
import { markAsTransfers, pairTransactionsByHand } from "./transfers.js";

type SfAccount = SimplefinAccountSet["accounts"][number];
type SfTxn = SfAccount["transactions"][number];
const unix = (date: IsoDate) => Math.floor(isoDateToUtcMs(date) / 1000) + 12 * 3600;
const posted = (id: string, date: IsoDate, amount: string, description: string): SfTxn => ({ id, posted: unix(date), amount, description, pending: false });
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
});
