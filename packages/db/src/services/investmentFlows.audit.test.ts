import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mapTradesCsvRows, type IsoDate, type TradesCsvMappingInput } from "@meridian/shared";
import { account, investmentTxn, rule, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { INV_SEED_NOW, INV_SEED_TODAY, seedInvestmentFixture, type InvestmentSeed } from "../test/investmentSeed.js";
import { createGoal, listGoals } from "./goals.js";
import { ingestTransactions } from "./ingest.js";
import { createInvestmentTxn, importTrades, updateInvestmentTxn } from "./investmentTxns.js";
import { getPerformance, loadExternalFlows } from "./performance.js";
import { loadRules, runRules } from "./rules.js";
import { updateTransaction } from "./transactions.js";

const TODAY = INV_SEED_TODAY;
const ctx = () => ({ userId: null, batchId: randomUUID(), today: TODAY });
const HEADER = ["Date", "Action", "Symbol", "Quantity", "Price", "Fees", "Amount", "Id"];
const mapping: TradesCsvMappingInput = {
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

/**
 * Audit b3-investment-flows, second round: the investment linker is automation, so it marks a
 * bank row a transfer only where automatic pairing may (docs/phase-3-plan.md, audit decision
 * A5 as amended): never a row a rule said is not a transfer (Phase 1 decision 106), never a row
 * the household categorized by hand (decision 48). The investment row is then the flow
 * (A5(2)), so the account's value and return are unchanged, and a rules run after the link
 * finds nothing to reverse. A link the household sets by hand is the household's word and
 * marks the row as a hand mark does.
 */
describe.skipIf(!TEST_DATABASE_URL)("an automatic link leaves the household's choices on the bank row (b3 second round)", () => {
  let t: TestDb;
  let S: InvestmentSeed;

  const newAccount = async (name: string, type: "brokerage" | "ira") =>
    (await t.db.insert(account).values({ name, type, taxTreatment: type === "ira" ? "pre_tax" : "taxable", onBudget: false }).returning({ id: account.id }))[0]!.id;
  const commit = async (accountId: string, rows: string[][]) => {
    const mapped = await mapTradesCsvRows([HEADER, ...rows], mapping);
    expect(mapped.errors).toEqual([]);
    return importTrades(t.db, { accountId, trades: mapped.trades, today: TODAY, ctx: ctx() });
  };
  const bankRows = async (accountId: string, rows: Array<{ externalId: string; date: IsoDate; amountCents: bigint; description: string }>) => {
    await ingestTransactions(
      t.db,
      rows.map((r) => ({ ...r, pending: false })),
      { accountId, source: "csv", rules: await loadRules(t.db) },
    );
    const stored = await t.db.select().from(transaction).where(eq(transaction.accountId, accountId));
    return (externalId: string) => stored.find((r) => r.externalId === externalId)!.id;
  };
  const ledgerRow = async (id: string) => (await t.db.select().from(transaction).where(eq(transaction.id, id)))[0]!;
  const rowByExt = async (accountId: string, externalId: string) => (await t.db.select().from(investmentTxn).where(and(eq(investmentTxn.accountId, accountId), eq(investmentTxn.externalId, externalId))))[0]!;
  const goalMonth = async (accountId: string, month: string) => (await listGoals(t.db, { today: TODAY })).find((g) => g.linkedAccountId === accountId)!.history.find((h) => h.month === month)?.actualCents ?? 0n;
  const flowsOf = async (accountId: string, from: IsoDate, to: IsoDate) =>
    (await loadExternalFlows(t.db, [accountId], from, to, { openingValues: false })).map((f) => [f.date, f.amountCents, f.source, f.sourceId]);
  const perf = async (accountId: string) => (await getPerformance(t.db, { from: "2026-09-13", to: "2026-10-13", today: TODAY, accountIds: [accountId], benchmarkSecurityId: null, now: INV_SEED_NOW })).accounts[0]!;

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedInvestmentFixture(t.db);
    // The household's rule: "MONEYLINK" rows are not transfers.
    await t.db.insert(rule).values({ name: "Moneylink is not a transfer", position: 1, conditions: { description: { op: "contains", value: "MONEYLINK" } }, actions: { markTransfer: false } });
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  /**
   * A brokerage whose bank rows are +5,000.00 "MONEYLINK TXN FROM CHK 1234" on 09-14 (the rule:
   * not a transfer), +2,500.00 "BRANCH CREDIT 0042" on 09-18 (categorized by hand as Dividends)
   * and −200.00 "ACH WITHDRAWAL" on 09-25 (nothing decided). The trade history has both deposits
   * and a buy of 20 VTI @ 290.00 (−5,800.00); the withdrawal is entered by hand. By hand on
   * 10-13 (VTI 312.50): 20 × 312.50 = 6,250.00 plus cash 7,500.00 − 5,800.00 − 200.00 = 1,500.00
   * is 7,750.00; contributions 7,500.00, withdrawals 200.00, growth 7,750.00 − 7,500.00 + 200.00
   * = 450.00. The goal's September holds the one ledger transfer, −200.00.
   */
  it("a rule's 'not a transfer' and a hand category hold over the link; a rules run after it reverses nothing", async () => {
    const acct = await newAccount("Ruled Brokerage", "brokerage");
    await createGoal(t.db, { name: "Ruled goal", newCategory: { name: "Ruled savings" }, targetCents: 10000000n, linkedAccountId: acct, startMonth: "2026-09" }, ctx());
    const id = await bankRows(acct, [
      { externalId: "RB-1", date: "2026-09-14", amountCents: 500000n, description: "MONEYLINK TXN FROM CHK 1234" },
      { externalId: "RB-2", date: "2026-09-18", amountCents: 250000n, description: "BRANCH CREDIT 0042" },
      { externalId: "RB-3", date: "2026-09-25", amountCents: -20000n, description: "ACH WITHDRAWAL" },
    ]);
    expect(await ledgerRow(id("RB-1"))).toMatchObject({ isTransfer: false, notTransfer: true });
    await updateTransaction(t.db, id("RB-2"), { categoryId: S.categories.dividends });

    const imported = await commit(acct, [
      ["2026-09-14", "ELECTRONIC FUNDS TRANSFER RECEIVED", "", "", "", "", "5000.00", "R1"],
      ["2026-09-18", "ELECTRONIC FUNDS TRANSFER RECEIVED", "", "", "", "", "2500.00", "R2"],
      ["2026-09-21", "YOU BOUGHT", "VTI", "20", "290.00", "", "-5800.00", "R3"],
    ]);
    expect(imported).toMatchObject({ created: 3, linked: 2, ledgerCreated: 0 });
    const r1 = await rowByExt(acct, "csvid:R1");
    const r2 = await rowByExt(acct, "csvid:R2");
    expect([r1.ledgerTransactionId, r2.ledgerTransactionId]).toEqual([id("RB-1"), id("RB-2")]);
    const out = await createInvestmentTxn(t.db, { accountId: acct, date: "2026-09-25", type: "transfer", direction: "out", amountCents: -20000n }, ctx());
    expect(out.items[0]!.ledgerTransactionId).toBe(id("RB-3"));

    const check = async () => {
      // Linked, but as the household left them; the withdrawal nobody decided is a transfer (A5).
      expect(await ledgerRow(id("RB-1"))).toMatchObject({ isTransfer: false, notTransfer: true, amountCents: 500000n, date: "2026-09-14" });
      expect(await ledgerRow(id("RB-2"))).toMatchObject({ isTransfer: false, categoryId: S.categories.dividends, categoryLocked: true });
      expect(await ledgerRow(id("RB-3"))).toMatchObject({ isTransfer: true });
      // The investment rows are the deposits' flows (A5(2)): value and return count the money.
      expect(await flowsOf(acct, "2026-09-13", "2026-10-13")).toEqual([
        ["2026-09-14", 500000n, "investment_txn", r1.id],
        ["2026-09-18", 250000n, "investment_txn", r2.id],
        ["2026-09-25", -20000n, "ledger", id("RB-3")],
      ]);
      expect(await perf(acct)).toMatchObject({ endValueCents: 775000n, contributionsCents: 750000n, withdrawalsCents: 20000n, growthCents: 45000n });
      expect(await goalMonth(acct, "2026-09")).toBe(-20000n);
    };
    await check();
    // The rules run the household starts from the Rules page: the rule finds its row as it left it.
    await runRules(t.db, { scope: "all" });
    await check();
    // The same file again: nothing changes.
    expect(await commit(acct, [["2026-09-14", "ELECTRONIC FUNDS TRANSFER RECEIVED", "", "", "", "", "5000.00", "R1"]])).toMatchObject({ unchanged: 1 });
    await check();

    // The household marks the hand-categorized deposit a transfer: the ledger row is the flow now, counted once.
    await updateTransaction(t.db, id("RB-2"), { isTransfer: true });
    expect(await flowsOf(acct, "2026-09-13", "2026-10-13")).toEqual([
      ["2026-09-14", 500000n, "investment_txn", r1.id],
      ["2026-09-18", 250000n, "ledger", id("RB-2")],
      ["2026-09-25", -20000n, "ledger", id("RB-3")],
    ]);
    expect(await perf(acct)).toMatchObject({ endValueCents: 775000n, contributionsCents: 750000n, withdrawalsCents: 20000n, growthCents: 45000n });
    expect(await goalMonth(acct, "2026-09")).toBe(230000n);
  });

  it("a cash row's derived ledger row keeps a rule's 'not a transfer'; a rules run after the import reverses nothing", async () => {
    const acct = await newAccount("Ruled IRA", "ira");
    await t.db.insert(rule).values({ name: "Nothing in the Ruled IRA is a transfer", position: 2, conditions: { accountId: acct }, actions: { markTransfer: false } });
    const imported = await commit(acct, [["2026-10-01", "ELECTRONIC FUNDS TRANSFER RECEIVED", "", "", "", "", "1000.00", "D1"]]);
    expect(imported).toMatchObject({ created: 1, linked: 0, ledgerCreated: 1 });
    const d1 = await rowByExt(acct, "csvid:D1");
    const check = async () => {
      expect(await ledgerRow(d1.ledgerTransactionId!)).toMatchObject({ accountId: acct, isTransfer: false, notTransfer: true, transferPairId: null, amountCents: 100000n });
      expect(await flowsOf(acct, "2026-09-30", "2026-10-13")).toEqual([["2026-10-01", 100000n, "investment_txn", d1.id]]);
    };
    await check();
    await runRules(t.db, { scope: "all" });
    await check();
  });

  it("a row that becomes a cash transfer while linked leaves a rule's 'not a transfer' on its bank row", async () => {
    const acct = await newAccount("Retyped Brokerage", "brokerage");
    const id = await bankRows(acct, [{ externalId: "RT-1", date: "2026-09-15", amountCents: 1234n, description: "MONEYLINK CREDIT" }]);
    const entered = await createInvestmentTxn(t.db, { accountId: acct, date: "2026-09-15", type: "dividend", securityId: S.securities.vti, amountCents: 1234n }, ctx());
    expect(entered.items[0]!.ledgerTransactionId).toBe(id("RT-1"));
    const retyped = await updateInvestmentTxn(t.db, entered.items[0]!.id, { type: "transfer", securityId: null, transferDirection: "in" }, ctx());
    expect(retyped.item).toMatchObject({ type: "transfer", ledgerTransactionId: id("RT-1") });
    expect(await ledgerRow(id("RT-1"))).toMatchObject({ isTransfer: false, notTransfer: true });
    await runRules(t.db, { scope: "all" });
    expect(await ledgerRow(id("RT-1"))).toMatchObject({ isTransfer: false, notTransfer: true });
    expect(await flowsOf(acct, "2026-09-13", "2026-09-30")).toEqual([["2026-09-15", 1234n, "investment_txn", entered.items[0]!.id]]);
  });

  it("a link the household sets by hand is its word: the bank row becomes a transfer, the rule's 'not a transfer' cleared", async () => {
    const acct = await newAccount("Hand-linked Brokerage", "brokerage");
    await createGoal(t.db, { name: "Hand-linked goal", newCategory: { name: "Hand-linked savings" }, targetCents: 10000000n, linkedAccountId: acct, startMonth: "2026-09" }, ctx());
    // Eight days after the transfer: outside the linker's three days.
    const id = await bankRows(acct, [{ externalId: "HB-1", date: "2026-09-28", amountCents: 30000n, description: "MONEYLINK TXN FROM CHK 1234" }]);
    const entered = await createInvestmentTxn(t.db, { accountId: acct, date: "2026-09-20", type: "transfer", direction: "in", amountCents: 30000n }, ctx());
    expect(entered.items[0]!.ledgerTransactionId).not.toBe(id("HB-1"));
    await updateInvestmentTxn(t.db, entered.items[0]!.id, { ledgerTransactionId: id("HB-1") }, ctx());
    expect(await ledgerRow(id("HB-1"))).toMatchObject({ isTransfer: true, notTransfer: false, amountCents: 30000n, date: "2026-09-28" });
    expect(await flowsOf(acct, "2026-09-13", "2026-09-30")).toEqual([["2026-09-28", 30000n, "ledger", id("HB-1")]]);
    expect(await goalMonth(acct, "2026-09")).toBe(30000n);
  });
});
