import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csvExternalId, mapTradesCsvRows, parseFixed8, type TradesCsvMappingInput } from "@meridian/shared";
import { account, investmentTxn, job, lot, lotDisposal, lotPick, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { INV_SEED_TODAY, seedInvestmentFixture, type InvestmentSeed } from "../test/investmentSeed.js";
import { listAudit } from "./audit.js";
import { createGoal, listGoals } from "./goals.js";
import {
  assertTxnShape,
  createInvestmentTxn,
  deleteInvestmentTxn,
  getInvestmentTxn,
  importTrades,
  linkUnlinkedInvestmentTxns,
  listInvestmentTxns,
  updateInvestmentTxn,
} from "./investmentTxns.js";
import { computeHoldings, rebuildLots, setLotPicks } from "./lots.js";
import { createSecurity } from "./securities.js";

const TODAY = INV_SEED_TODAY;
const f8 = parseFixed8;
const ctx = (batchId: string = randomUUID()) => ({ userId: null, batchId, today: TODAY });

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

/** The imports design's Test 11 file with a file id column (so a changed row keeps its identity). */
const FILE11 = [
  ["2026-10-01", "YOU BOUGHT", "VTI", "10", "250.00", "", "-2500.00", "T1"],
  ["2026-10-01", "YOU BOUGHT", "VTI", "10", "250.00", "", "-2500.00", "T2"],
  ["2026-09-15", "DIVIDEND RECEIVED", "VTI", "", "", "", "12.34", "T3"],
  ["2026-09-15", "REINVESTMENT", "VTI", "0.0523", "", "", "-12.34", "T4"],
  ["2026-10-05", "Sold", "VTI", "4", "249.65", "0", "998.60", "T5"],
];
/** The §3.8 worked file (newest first; the journal row is unclassified until mapped). */
const FILE38 = [
  ["2026-10-12", "JOURNALED SPP PURCHASE CREDIT (Cash)", "", "", "", "", "0.00", ""],
  ["2026-10-09", "YOU SOLD", "VTI", "-4", "130.00", "0.02", "519.98", ""],
  ["2026-10-06", "REINVESTMENT", "VTI", "0.1", "123.40", "", "-12.34", ""],
  ["2026-10-05", "DIVIDEND RECEIVED", "VTI", "", "", "", "12.34", ""],
  ["2026-10-02", "YOU BOUGHT", "VTI", "10", "123.45", "", "-1234.50", ""],
  ["2026-10-01", "ELECTRONIC FUNDS TRANSFER RECEIVED", "", "", "", "", "5000.00", ""],
];

describe.skipIf(!TEST_DATABASE_URL)("investment transactions (imports tests 13–16, 22, 23, 27)", () => {
  let t: TestDb;
  let S: InvestmentSeed;
  let brk13: string;
  let rcv: string;
  let brk16: string;
  let chk: string;
  let A15: string;
  let B15: string;
  let C15: string;
  let lnk: string;
  let man: string;
  let VTI: string;

  const mapFile = async (rows: string[][], actionMap: Record<string, "skip"> = {}) => mapTradesCsvRows([HEADER, ...rows], { ...mapping, actionMap });
  const commit = async (accountId: string, rows: string[][], opts: { actionMap?: Record<string, "skip">; batchId?: string; today?: string } = {}) => {
    const mapped = await mapFile(rows, opts.actionMap);
    expect(mapped.errors).toEqual([]);
    return importTrades(t.db, {
      accountId,
      trades: mapped.trades,
      unknownActionKeys: mapped.actionsFound.filter((a) => a.kind === null).map((a) => a.key),
      today: opts.today ?? TODAY,
      ctx: ctx(opts.batchId),
    });
  };
  const rowByExt = async (accountId: string, externalId: string) => (await t.db.select().from(investmentTxn).where(and(eq(investmentTxn.accountId, accountId), eq(investmentTxn.externalId, externalId))))[0]!;
  const lotsOf = async (accountId: string) => t.db.select().from(lot).where(eq(lot.accountId, accountId)).orderBy(asc(lot.acquiredDate), asc(lot.openedByTxnId), asc(lot.ordinal));
  const disposalsOf = async (accountId: string) => t.db.select().from(lotDisposal).where(eq(lotDisposal.accountId, accountId)).orderBy(asc(lotDisposal.date), asc(lotDisposal.acquiredDate));
  const newAccount = async (name: string, type: "brokerage" | "ira" | "checking", extra: Partial<typeof account.$inferInsert> = {}) =>
    (await t.db.insert(account).values({ name, type, taxTreatment: type === "checking" ? "none" : type === "ira" ? "pre_tax" : "taxable", onBudget: type === "checking", ...extra }).returning({ id: account.id }))[0]!.id;

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedInvestmentFixture(t.db);
    VTI = S.securities.vti;
    brk13 = await newAccount("Trades Brokerage", "brokerage");
    rcv = await newAccount("Receiving IRA", "ira");
    brk16 = await newAccount("CSV-only Brokerage", "brokerage");
    chk = await newAccount("Household Checking", "checking");
    A15 = await newAccount("Pair A", "brokerage");
    B15 = await newAccount("Pair B", "ira");
    C15 = await newAccount("Pair C", "ira");
    lnk = await newAccount("Link Brokerage", "brokerage");
    man = await newAccount("Manual Brokerage", "brokerage");
    await t.db.insert(transaction).values({ accountId: chk, source: "manual", date: "2026-09-30", amountCents: -500000n, rawDescription: "TRANSFER TO BROKERAGE" });
    await createGoal(t.db, { name: "Brokerage goal", newCategory: { name: "Brokerage savings" }, targetCents: 10000000n, linkedAccountId: brk16, startMonth: "2026-01" }, ctx());
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("commits the Test 11 file: five rows, stable lot ids, the engine's disposal numbers (tests 13, 27)", async () => {
    const r = await commit(brk13, FILE11);
    expect(r).toMatchObject({ created: 5, updated: 0, unchanged: 0, skippedEdited: 0, linked: 0, ledgerCreated: 0, ledgerSkipped: 0, transfersPaired: 0, securitiesCreated: 0, lotsRebuilt: 1, warnings: [] });
    expect(r.jobs.incomeFeed).not.toBeNull();
    expect(r.jobs.recurringDetect).toBeNull();
    expect(r.jobs.priceRefresh).toBeNull();
    const t1 = await rowByExt(brk13, "csvid:T1");
    expect(t1).toMatchObject({ type: "buy", date: "2026-10-01", sequence: 0, amountCents: -250000n, feeCents: 0n, source: "csv", userEdited: false, rawDescription: "YOU BOUGHT" });
    expect((await rowByExt(brk13, "csvid:T2")).sequence).toBe(1);
    expect(await rowByExt(brk13, "csvid:T4")).toMatchObject({ type: "reinvest", amountCents: -1234n, sequence: 1 });
    expect(f8((await rowByExt(brk13, "csvid:T4")).quantity!)).toBe(f8("0.0523"));

    // Lots: T4 (09-15), T1 and T2 (10-01); ids survive a second rebuild.
    const lots = await lotsOf(brk13);
    const key = (l: { openedByTxnId: string; openedBy: string; acquiredDate: string }) => `${l.acquiredDate}|${l.openedBy}|${l.openedByTxnId}`;
    expect(lots.map(key).sort()).toEqual(
      [
        { openedByTxnId: (await rowByExt(brk13, "csvid:T4")).id, openedBy: "reinvest", acquiredDate: "2026-09-15" },
        { openedByTxnId: t1.id, openedBy: "buy", acquiredDate: "2026-10-01" },
        { openedByTxnId: (await rowByExt(brk13, "csvid:T2")).id, openedBy: "buy", acquiredDate: "2026-10-01" },
      ]
        .map(key)
        .sort(),
    );
    await t.db.transaction((tx) => rebuildLots(tx, brk13));
    expect((await lotsOf(brk13)).map((l) => l.id)).toEqual(lots.map((l) => l.id));

    // FIFO by acquisition date: the sell of 4 takes the 0.0523 reinvest lot (basis 1 234) then 3.9477 of T1
    // (round(250 000 × 3.9477 / 10) = 98 693); proceeds 99 860 split 1 306 / 98 554 by largest remainder.
    const sell = await rowByExt(brk13, "csvid:T5");
    const disposals = await disposalsOf(brk13);
    expect(disposals.map((d) => [d.closeTxnId, d.kind, f8(d.quantity), d.proceedsCents, d.basisCents, d.term])).toEqual([
      [sell.id, "sell", f8("0.0523"), 1306n, 1234n, "short"],
      [sell.id, "sell", f8("3.9477"), 98554n, 98693n, "short"],
    ]);
    expect(disposals.reduce((acc, d) => acc + f8(d.quantity), 0n)).toBe(f8("4"));
    expect(disposals.reduce((acc, d) => acc + d.proceedsCents, 0n)).toBe(99860n);
    const holdings = await computeHoldings(t.db, { accountIds: [brk13], asOf: TODAY });
    expect(holdings.rows.map((h) => [h.ticker, h.quantity, h.lotCount])).toEqual([["VTI", f8("16.0523"), 2]]);
  });

  it("moves 6 VTI to another account: the receiving lot carries the origin, basis and date; the out leg disposes at basis (tests 15, 27)", async () => {
    const batch = randomUUID();
    const created = await createInvestmentTxn(t.db, { accountId: brk13, date: "2026-10-06", type: "transfer", direction: "out", securityId: VTI, quantity: f8("6"), counterpartyAccountId: rcv }, ctx(batch));
    expect(created.items).toHaveLength(2);
    const [out, inLeg] = created.items;
    expect(out).toMatchObject({ accountId: brk13, transferDirection: "out", amountCents: 0n, counterpartyAccountId: rcv, source: "manual", externalId: null });
    expect(inLeg).toMatchObject({ accountId: rcv, transferDirection: "in", amountCents: 0n, counterpartyAccountId: brk13, transferGroupId: out!.transferGroupId });
    expect(out!.transferGroupId).not.toBeNull();
    const audit = await listAudit(t.db, { batchId: batch, limit: 10 });
    expect(audit.items.map((e) => [e.entity, e.action])).toEqual([
      ["investment_txn", "create"],
      ["investment_txn", "create"],
    ]);

    // After the sell T1 holds 6.0523 sh with basis 151 307; the transfer takes 6 → round(151 307 × 6 / 6.0523) = 150 000.
    const t1 = await rowByExt(brk13, "csvid:T1");
    const t1Lot = (await lotsOf(brk13)).find((l) => l.openedByTxnId === t1.id)!;
    const received = await lotsOf(rcv);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ openedByTxnId: inLeg!.id, ordinal: 0, originLotId: t1Lot.id, openedBy: "transfer_in", acquiredDate: "2026-10-01", costBasisCents: 150000n, originalCostBasisCents: 150000n, basisKnown: true });
    expect(f8(received[0]!.quantity)).toBe(f8("6"));
    const outDisposal = (await disposalsOf(brk13)).find((d) => d.closeTxnId === out!.id)!;
    expect(outDisposal).toMatchObject({ kind: "transfer_out", proceedsCents: 0n, basisCents: 150000n, gainCents: 0n, term: "none", lotId: t1Lot.id });
    expect(f8(t1Lot.quantity)).toBe(f8("0.0523"));

    // A paired leg refuses a quantity change; the group deletes together.
    await expect(updateInvestmentTxn(t.db, inLeg!.id, { quantity: f8("5") }, ctx())).rejects.toMatchObject({ status: 409, code: "transfer_leg_linked" });
    await expect(deleteInvestmentTxn(t.db, out!.id, {}, ctx())).rejects.toMatchObject({ status: 409, code: "transfer_leg_linked" });
    const gone = await deleteInvestmentTxn(t.db, out!.id, { deleteGroup: true }, ctx());
    expect(gone.deleted).toBe(2);
    expect(await getInvestmentTxn(t.db, inLeg!.id)).toBeUndefined();
    expect(await lotsOf(rcv)).toEqual([]);
    expect((await disposalsOf(brk13)).every((d) => d.closeTxnId !== out!.id)).toBe(true);
  });

  it("re-imports write the diff, skip owner-edited rows, clear picks on a type change, and recreate deleted rows (test 13)", async () => {
    const t1 = await rowByExt(brk13, "csvid:T1");
    const t5 = await rowByExt(brk13, "csvid:T5");
    const t1Lot = (await lotsOf(brk13)).find((l) => l.openedByTxnId === t1.id)!;
    const memoBatch = randomUUID();
    const memo = await updateInvestmentTxn(t.db, t1.id, { memo: "first lot" }, ctx(memoBatch));
    expect(memo.item).toMatchObject({ memo: "first lot", userEdited: false });
    expect((await listAudit(t.db, { batchId: memoBatch, limit: 5 })).items).toHaveLength(1);
    await setLotPicks(t.db, t5.id, [{ lotId: t1Lot.id, quantity: f8("4") }], ctx());
    expect((await disposalsOf(brk13)).map((d) => [d.lotId, d.basisCents, d.proceedsCents])).toEqual([[t1Lot.id, 100000n, 99860n]]);

    const FILE2 = FILE11.map((r) => (r[7] === "T5" ? [...r.slice(0, 6), "998.75", "T5"] : r));
    const second = await commit(brk13, FILE2);
    expect(second).toMatchObject({ created: 0, updated: 1, unchanged: 4, skippedEdited: 0, lotsRebuilt: 1 });
    expect((await rowByExt(brk13, "csvid:T5")).amountCents).toBe(99875n);
    expect((await t.db.select().from(lotPick).where(eq(lotPick.sellTxnId, t5.id))).map((p) => [p.lotId, f8(p.quantity)])).toEqual([[t1Lot.id, f8("4")]]);
    expect((await rowByExt(brk13, "csvid:T1")).memo).toBe("first lot");
    expect((await disposalsOf(brk13)).map((d) => [d.lotId, d.basisCents, d.proceedsCents])).toEqual([[t1Lot.id, 100000n, 99875n]]);

    const edited = await updateInvestmentTxn(t.db, t5.id, { price: f8("249.70") }, ctx());
    expect(edited.item.userEdited).toBe(true);
    const third = await commit(brk13, FILE2);
    expect(third).toMatchObject({ created: 0, updated: 0, unchanged: 4, skippedEdited: 1 });
    expect(f8((await rowByExt(brk13, "csvid:T5")).price!)).toBe(f8("249.7"));

    // The sell becomes a buy with the same file id; the owner's edit flag is reset by hand.
    await t.db.update(investmentTxn).set({ userEdited: false }).where(eq(investmentTxn.id, t5.id));
    const FILE3 = FILE11.map((r) => (r[7] === "T5" ? ["2026-10-05", "YOU BOUGHT", "VTI", "4", "249.65", "0", "-998.60", "T5"] : r));
    const fourth = await commit(brk13, FILE3);
    expect(fourth).toMatchObject({ created: 0, updated: 1, unchanged: 4 });
    expect(fourth.warnings).toEqual([{ rowIndex: 5, code: "lot_picks_cleared", message: expect.any(String) }]);
    expect(await rowByExt(brk13, "csvid:T5")).toMatchObject({ type: "buy", amountCents: -99860n });
    expect(await t.db.select().from(lotPick).where(eq(lotPick.sellTxnId, t5.id))).toEqual([]);
    expect(await disposalsOf(brk13)).toEqual([]);
    expect((await lotsOf(brk13)).map((l) => l.openedByTxnId)).toContain(t5.id);

    const delBatch = randomUUID();
    await deleteInvestmentTxn(t.db, t1.id, {}, ctx(delBatch));
    expect((await listAudit(t.db, { batchId: delBatch, limit: 5 })).items[0]).toMatchObject({ entity: "investment_txn", entityId: t1.id, action: "delete", after: null });
    const fifth = await commit(brk13, FILE3);
    expect(fifth).toMatchObject({ created: 1, updated: 0, unchanged: 4 });
    expect((await rowByExt(brk13, "csvid:T1")).id).not.toBe(t1.id);
  });

  it("pairs share transfers across accounts from two files; a far in-leg stays alone; cash legs mirror with derived ledger rows (test 15)", async () => {
    const outFile = [["2026-09-06", "JOURNAL DELIVERED", "VTI", "10", "", "", "", "J1"]];
    const inFile = [["2026-09-08", "TRANSFER OF SHARES RECEIVED", "VTI", "10", "", "", "", "J2"]];
    const farFile = [["2026-09-22", "TRANSFER OF SHARES RECEIVED", "VTI", "10", "", "", "", "J3"]];
    const a = await commit(A15, outFile);
    expect(a).toMatchObject({ created: 1, transfersPaired: 0 });
    const b = await commit(B15, inFile);
    expect(b).toMatchObject({ created: 1, transfersPaired: 1 });
    const outLeg = await rowByExt(A15, "csvid:J1");
    const inLeg = await rowByExt(B15, "csvid:J2");
    expect(outLeg.transferGroupId).not.toBeNull();
    expect(inLeg.transferGroupId).toBe(outLeg.transferGroupId);
    expect([outLeg.counterpartyAccountId, inLeg.counterpartyAccountId]).toEqual([B15, A15]);
    expect(b.lotsRebuilt).toBe(2);
    const c = await commit(C15, farFile);
    expect(c).toMatchObject({ created: 1, transfersPaired: 0 });
    expect((await rowByExt(C15, "csvid:J3")).transferGroupId).toBeNull();
    // The out leg had nothing to give (A15 holds no VTI), so the in leg's basis is unknown and the engine says so.
    expect(b.rebuildWarnings.map((w) => w.code)).toContain("basis_unknown");
    expect((await lotsOf(B15))[0]).toMatchObject({ basisKnown: false, costBasisCents: 0n, openedBy: "transfer_in" });

    const cash = await createInvestmentTxn(t.db, { accountId: A15, date: "2026-10-07", type: "transfer", direction: "in", amountCents: 50000n, counterpartyAccountId: B15 }, ctx());
    expect(cash.items.map((i) => [i.accountId, i.transferDirection, i.amountCents, i.securityId])).toEqual([
      [A15, "in", 50000n, null],
      [B15, "out", -50000n, null],
    ]);
    const ledgerA = (await t.db.select().from(transaction).where(eq(transaction.id, cash.items[0]!.ledgerTransactionId!)))[0]!;
    const ledgerB = (await t.db.select().from(transaction).where(eq(transaction.id, cash.items[1]!.ledgerTransactionId!)))[0]!;
    expect(ledgerA).toMatchObject({ accountId: A15, amountCents: 50000n, isTransfer: true, source: "manual", rawDescription: "Transfer in" });
    expect(ledgerB).toMatchObject({ accountId: B15, amountCents: -50000n, isTransfer: true });
    expect(ledgerA.transferPairId).not.toBeNull();
    expect(ledgerB.transferPairId).toBe(ledgerA.transferPairId);
    await expect(createInvestmentTxn(t.db, { accountId: A15, date: "2026-10-07", type: "transfer", direction: "in", amountCents: -5n }, ctx())).rejects.toMatchObject({ status: 400, code: "txn_invalid", message: expect.stringContaining("itx_transfer") });
    await expect(createInvestmentTxn(t.db, { accountId: A15, date: "2026-10-07", type: "transfer", direction: "in", amountCents: 5n, counterpartyAccountId: A15 }, ctx())).rejects.toMatchObject({ status: 400, code: "transfer_same_account" });

    // Deleting the group takes the derived ledger rows with it.
    await deleteInvestmentTxn(t.db, cash.items[0]!.id, { deleteGroup: true }, ctx());
    expect(await t.db.select().from(transaction).where(eq(transaction.id, ledgerA.id))).toEqual([]);
    expect(await t.db.select().from(transaction).where(eq(transaction.id, ledgerB.id))).toEqual([]);
  });

  it("refuses unknown actions; mapping them to skip lets the commit through (test 14)", async () => {
    const mapped = await mapFile(FILE38);
    expect(mapped.unknownActions).toBe(1);
    expect(mapped.actionsFound.find((a) => a.kind === null)).toMatchObject({ key: "journaled spp purchase credit (cash)", count: 1, fromProfile: false });
    await expect(commit(brk16, FILE38)).rejects.toMatchObject({ status: 400, code: "unknown_action", message: expect.stringContaining("journaled spp purchase credit (cash)") });
    const remapped = await mapFile(FILE38, { journaled: "skip" });
    expect(remapped.unknownActions).toBe(0);
    expect(remapped.skipped).toEqual([{ rowIndex: 1, reason: "skip", text: expect.stringContaining("JOURNALED") }]);
    expect(remapped.rowOrder).toBe("newest_first");
  });

  it("cash rows reach the ledger for CSV-only accounts only (test 16)", async () => {
    const first = await commit(brk16, FILE38, { actionMap: { journaled: "skip" } });
    expect(first).toMatchObject({ created: 5, updated: 0, unchanged: 0, linked: 0, ledgerCreated: 1, ledgerSkipped: 0, transfersPaired: 1, securitiesCreated: 0, lotsRebuilt: 1 });
    const cashRow = (await t.db.select().from(investmentTxn).where(and(eq(investmentTxn.accountId, brk16), eq(investmentTxn.type, "transfer"))))[0]!;
    expect(cashRow).toMatchObject({ securityId: null, transferDirection: "in", amountCents: 500000n, date: "2026-10-01" });
    const ledger = (await t.db.select().from(transaction).where(eq(transaction.id, cashRow.ledgerTransactionId!)))[0]!;
    expect(ledger).toMatchObject({ accountId: brk16, source: "csv", isTransfer: true, amountCents: 500000n, date: "2026-10-01", categoryId: null });
    expect(ledger.externalId).toBe(await csvExternalId("2026-10-01", 500000n, "ELECTRONIC FUNDS TRANSFER RECEIVED", 0));
    const checking = (await t.db.select().from(transaction).where(and(eq(transaction.accountId, chk), eq(transaction.amountCents, -500000n))))[0]!;
    expect(checking.transferPairId).not.toBeNull();
    expect(ledger.transferPairId).toBe(checking.transferPairId);
    const goal = (await listGoals(t.db, { today: TODAY })).find((g) => g.linkedAccountId === brk16)!;
    expect(goal.history.find((h) => h.month === "2026-10")?.actualCents).toBe(500000n);
    expect(first.jobs.recurringDetect).not.toBeNull();
    const detect = (await t.db.select().from(job).where(eq(job.id, first.jobs.recurringDetect!)))[0]!;
    expect(detect).toMatchObject({ type: "recurring.detect", status: "queued", payload: { reason: "ledger" } });
    // The sell of 4 VTI on 10-09 consumes the 10-02 buy: 4 × 123 450 / 10 = 49 380 basis against 51 998 proceeds.
    expect((await disposalsOf(brk16)).map((d) => [d.kind, f8(d.quantity), d.proceedsCents, d.basisCents, d.gainCents])).toEqual([["sell", f8("4"), 51998n, 49380n, 2618n]]);

    const second = await commit(brk16, FILE38, { actionMap: { journaled: "skip" } });
    expect(second).toMatchObject({ created: 0, updated: 0, unchanged: 5, ledgerCreated: 0, ledgerSkipped: 1, transfersPaired: 0, lotsRebuilt: 0 });
    expect(second.jobs.incomeFeed).toBeNull();

    // The same file into the SimpleFIN-fed brokerage whose Bridge delivered the EFT one day later: linked, never created.
    const B = S.accounts.brokerage;
    const [bridge] = await t.db
      .insert(transaction)
      .values({ accountId: B, source: "simplefin", externalId: "BRIDGE-EFT-1", date: "2026-10-02", amountCents: 500000n, rawDescription: "EFT RECEIVED", isTransfer: true })
      .returning({ id: transaction.id });
    const fed = await commit(B, FILE38, { actionMap: { journaled: "skip" } });
    expect(fed).toMatchObject({ created: 5, linked: 1, ledgerCreated: 0, ledgerSkipped: 0, transfersPaired: 0 });
    const fedCash = (await t.db.select().from(investmentTxn).where(and(eq(investmentTxn.accountId, B), eq(investmentTxn.type, "transfer"))))[0]!;
    expect(fedCash.ledgerTransactionId).toBe(bridge!.id);
    expect(fed.jobs.recurringDetect).toBeNull();
  });

  it("links dividends and fees to the ledger by amount within three days (test 22)", async () => {
    await t.db.insert(transaction).values([
      { accountId: lnk, source: "simplefin", externalId: "L1", date: "2026-09-16", amountCents: 1234n, rawDescription: "DIVIDEND VTI" },
      { accountId: lnk, source: "simplefin", externalId: "L2", date: "2026-09-30", amountCents: 1234n, rawDescription: "DIVIDEND BND" },
    ]);
    const r = await commit(lnk, [
      ["2026-09-15", "DIVIDEND RECEIVED", "VTI", "", "", "", "12.34", "D1"],
      ["2026-09-29", "DIVIDEND RECEIVED", "BND", "", "", "", "12.34", "D2"],
      ["2026-09-17", "DIVIDEND RECEIVED", "VXUS", "", "", "", "12.34", "D3"],
    ]);
    expect(r).toMatchObject({ created: 3, linked: 2, ledgerCreated: 0 });
    const ledgerId = async (ext: string) => (await t.db.select({ id: transaction.id }).from(transaction).where(and(eq(transaction.accountId, lnk), eq(transaction.externalId, ext))))[0]!.id;
    expect((await rowByExt(lnk, "csvid:D1")).ledgerTransactionId).toBe(await ledgerId("L1"));
    expect((await rowByExt(lnk, "csvid:D2")).ledgerTransactionId).toBe(await ledgerId("L2"));
    expect((await rowByExt(lnk, "csvid:D3")).ledgerTransactionId).toBeNull();

    await t.db.insert(transaction).values({ accountId: lnk, source: "simplefin", externalId: "L3", date: "2026-10-06", amountCents: -495n, rawDescription: "ADVISORY FEE" });
    const fee = await createInvestmentTxn(t.db, { accountId: lnk, date: "2026-10-02", type: "fee", amountCents: -495n }, ctx());
    expect(fee.items[0]!.ledgerTransactionId).toBeNull();
    await t.db.insert(transaction).values({ accountId: lnk, source: "simplefin", externalId: "L4", date: "2026-10-03", amountCents: -495n, rawDescription: "ADVISORY FEE" });
    expect(await t.db.transaction((tx) => linkUnlinkedInvestmentTxns(tx, { accountIds: [lnk] }))).toBe(1);
    expect((await getInvestmentTxn(t.db, fee.items[0]!.id))!.ledgerTransactionId).toBe(await ledgerId("L4"));
    expect(await t.db.transaction((tx) => linkUnlinkedInvestmentTxns(tx))).toBe(0);

    const batch = randomUUID();
    const unlinked = await updateInvestmentTxn(t.db, fee.items[0]!.id, { ledgerTransactionId: null }, ctx(batch));
    expect(unlinked.item).toMatchObject({ ledgerTransactionId: null, userEdited: false });
    const entry = (await listAudit(t.db, { batchId: batch, limit: 5 })).items[0]!;
    expect(entry).toMatchObject({ entity: "investment_txn", action: "update" });
    expect((entry.before as { ledgerTransactionId: string | null }).ledgerTransactionId).toBe(await ledgerId("L4"));
    expect((entry.after as { ledgerTransactionId: string | null }).ledgerTransactionId).toBeNull();
    await expect(updateInvestmentTxn(t.db, fee.items[0]!.id, { ledgerTransactionId: await ledgerId("L1") }, ctx())).rejects.toMatchObject({ status: 409, code: "ledger_linked" });
  });

  it("manual trades: defaults, sequences, validation, picks, type change and audit (test 23)", async () => {
    const abc = (await createSecurity(t.db, { ticker: "ABC", name: "ABC Corp", type: "stock", assetClass: "us_stock" }, ctx())).id;
    const xyz = (await createSecurity(t.db, { ticker: "XYZ", name: "XYZ Corp", type: "stock", assetClass: "us_stock" }, ctx())).id;
    // 5 × 48.123 = 240.615 → 24 062 (half away); amount −(24 062 + 495).
    const buyBatch = randomUUID();
    const buy = await createInvestmentTxn(t.db, { accountId: man, date: "2026-10-02", type: "buy", securityId: abc, quantity: f8("5"), price: f8("48.123"), feeCents: 495n }, ctx(buyBatch));
    expect(buy.items[0]).toMatchObject({ amountCents: -24557n, sequence: 0, source: "manual", externalId: null, feeCents: 495n, userEdited: false, lotPicks: [] });
    expect((await listAudit(t.db, { batchId: buyBatch, limit: 5 })).items).toHaveLength(1);
    const buy2 = await createInvestmentTxn(t.db, { accountId: man, date: "2026-10-02", type: "buy", securityId: abc, quantity: f8("7"), price: f8("51.37"), feeCents: 495n }, ctx());
    expect(buy2.items[0]).toMatchObject({ amountCents: -36454n, sequence: 1 });

    const sell = await createInvestmentTxn(t.db, { accountId: man, date: "2026-10-03", type: "sell", securityId: abc, quantity: f8("4"), price: f8("249.65") }, ctx());
    expect(sell.items[0]!.amountCents).toBe(99860n);
    await expect(createInvestmentTxn(t.db, { accountId: man, date: "2026-10-03", type: "sell", securityId: abc, quantity: f8("4"), price: f8("249.65"), amountCents: -1n }, ctx())).rejects.toMatchObject({ status: 400, code: "txn_invalid", message: expect.stringContaining("itx_sell") });
    await expect(createInvestmentTxn(t.db, { accountId: man, date: "2026-10-03", type: "sell", securityId: abc, quantity: 0n, price: f8("249.65") }, ctx())).rejects.toMatchObject({ status: 400, code: "validation" });

    const split = await createInvestmentTxn(t.db, { accountId: man, date: "2026-10-04", type: "split", securityId: abc, splitNum: 2, splitDen: 1 }, ctx());
    expect(split.items[0]).toMatchObject({ amountCents: 0n, quantity: null, splitNum: 2, splitDen: 1 });
    await expect(createInvestmentTxn(t.db, { accountId: man, date: "2026-10-04", type: "split", securityId: abc, splitNum: 0, splitDen: 1 }, ctx())).rejects.toMatchObject({ status: 400, code: "validation" });
    // 0.0523 × 236.04 = 12.3449 → 1 234.
    const reinvest = await createInvestmentTxn(t.db, { accountId: man, date: "2026-10-05", type: "reinvest", securityId: abc, quantity: f8("0.0523"), price: f8("236.04") }, ctx());
    expect(reinvest.items[0]!.amountCents).toBe(-1234n);
    const dividend = await createInvestmentTxn(t.db, { accountId: man, date: "2026-10-05", type: "dividend", amountCents: 1234n }, ctx());
    expect(dividend.items[0]).toMatchObject({ securityId: null, amountCents: 1234n });
    await expect(createInvestmentTxn(t.db, { accountId: man, date: "2026-10-05", type: "dividend" }, ctx())).rejects.toMatchObject({ status: 400, code: "amount_required" });
    await expect(createInvestmentTxn(t.db, { accountId: man, date: "2026-10-15", type: "dividend", amountCents: 1n }, ctx())).rejects.toMatchObject({ status: 400, code: "future_date" });
    await expect(createInvestmentTxn(t.db, { accountId: chk, date: "2026-10-05", type: "buy", securityId: abc, quantity: f8("1"), price: f8("1") }, ctx())).rejects.toMatchObject({ status: 400, code: "not_investment_account" });
    await expect(createInvestmentTxn(t.db, { accountId: man, date: "2026-10-05", type: "fee", amountCents: 100n }, ctx())).rejects.toMatchObject({ status: 400, code: "txn_invalid", message: expect.stringContaining("itx_fee") });

    // Lots A (10) and B (5) of XYZ; a sell of 15 with picks.
    const lotA = await createInvestmentTxn(t.db, { accountId: man, date: "2026-10-01", type: "buy", securityId: xyz, quantity: f8("10"), price: f8("10") }, ctx());
    const lotB = await createInvestmentTxn(t.db, { accountId: man, date: "2026-10-02", type: "buy", securityId: xyz, quantity: f8("5"), price: f8("10") }, ctx());
    const lotIdOf = async (txnId: string) => (await lotsOf(man)).find((l) => l.openedByTxnId === txnId)!.id;
    const A = await lotIdOf(lotA.items[0]!.id);
    const Bl = await lotIdOf(lotB.items[0]!.id);
    const picked = await createInvestmentTxn(t.db, { accountId: man, date: "2026-10-03", type: "sell", securityId: xyz, quantity: f8("15"), price: f8("11"), lotPicks: [{ lotId: A, quantity: f8("10") }, { lotId: Bl, quantity: f8("5") }] }, ctx());
    expect(picked.items[0]!.lotPicks.map((p) => [p.lotId, p.quantity, p.position])).toEqual([
      [A, f8("10"), 0],
      [Bl, f8("5"), 1],
    ]);
    expect((await disposalsOf(man)).filter((d) => d.closeTxnId === picked.items[0]!.id).map((d) => [d.lotId, f8(d.quantity)])).toEqual([
      [A, f8("10")],
      [Bl, f8("5")],
    ]);
    await deleteInvestmentTxn(t.db, picked.items[0]!.id, {}, ctx());
    const partial = await createInvestmentTxn(t.db, { accountId: man, date: "2026-10-03", type: "sell", securityId: xyz, quantity: f8("15"), price: f8("11"), lotPicks: [{ lotId: A, quantity: f8("10") }] }, ctx());
    expect(partial.items[0]!.lotPicks).toHaveLength(1);
    await deleteInvestmentTxn(t.db, partial.items[0]!.id, {}, ctx());
    const sellOf = (picks: Array<{ lotId: string; quantity: bigint }>) => createInvestmentTxn(t.db, { accountId: man, date: "2026-10-03", type: "sell", securityId: xyz, quantity: f8("15"), price: f8("11"), lotPicks: picks }, ctx());
    await expect(sellOf([{ lotId: A, quantity: f8("11") }, { lotId: Bl, quantity: f8("4") }])).rejects.toMatchObject({ status: 400, code: "pick_exceeds_lot" });
    await expect(sellOf([{ lotId: await lotIdOf(buy.items[0]!.id), quantity: f8("1") }])).rejects.toMatchObject({ status: 400, code: "pick_security_mismatch" });
    await expect(sellOf([{ lotId: randomUUID(), quantity: f8("1") }])).rejects.toMatchObject({ status: 400, code: "lot_not_found" });
    await expect(sellOf([{ lotId: A, quantity: f8("10") }, { lotId: Bl, quantity: f8("6") }])).rejects.toMatchObject({ status: 400, code: "picks_exceed_sale" });

    // A type change on a manual row is re-validated as a whole and rebuilds the lots.
    const flipBatch = randomUUID();
    const flipped = await updateInvestmentTxn(t.db, buy2.items[0]!.id, { type: "sell", amountCents: 36454n }, ctx(flipBatch));
    expect(flipped.item).toMatchObject({ type: "sell", amountCents: 36454n, userEdited: false });
    expect((await listAudit(t.db, { batchId: flipBatch, limit: 5 })).items).toHaveLength(1);
    expect((await disposalsOf(man)).some((d) => d.closeTxnId === buy2.items[0]!.id)).toBe(true);
    await expect(updateInvestmentTxn(t.db, buy2.items[0]!.id, { type: "buy" }, ctx())).rejects.toMatchObject({ status: 400, code: "txn_invalid" });
    await expect(updateInvestmentTxn(t.db, randomUUID(), { memo: "x" }, ctx())).rejects.toMatchObject({ status: 404, code: "not_found" });

    // Register: newest first with a keyset cursor.
    const page1 = await listInvestmentTxns(t.db, { accountId: man, limit: 3 });
    expect(page1.items).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listInvestmentTxns(t.db, { accountId: man, limit: 3, cursor: page1.nextCursor! });
    expect(page2.items.map((i) => i.id)).not.toContain(page1.items[0]!.id);
    const all = await listInvestmentTxns(t.db, { accountId: man, limit: 100 });
    const keys = all.items.map((i) => `${i.date}|${i.sequence}|${i.id}`);
    expect([...keys].sort().reverse()).toEqual(keys);
  });

  it("assertTxnShape names the rule it mirrors", () => {
    const base = { securityId: "s", quantity: f8("1"), price: f8("1"), amountCents: -100n, feeCents: 0n, splitNum: null, splitDen: null, transferDirection: null, costBasisCents: null, acquiredDate: null };
    expect(() => assertTxnShape({ ...base, type: "buy" })).not.toThrow();
    expect(() => assertTxnShape({ ...base, type: "buy", amountCents: 1n })).toThrow(/itx_buy/);
    expect(() => assertTxnShape({ ...base, type: "sell", amountCents: 100n, quantity: 0n })).toThrow(/itx_sell/);
    expect(() => assertTxnShape({ ...base, type: "dividend", amountCents: 5n, splitNum: 2 })).toThrow(/itx_split/);
    expect(() => assertTxnShape({ ...base, type: "transfer", transferDirection: "in", securityId: null, amountCents: -5n })).toThrow(/itx_transfer/);
    expect(() => assertTxnShape({ ...base, type: "transfer", transferDirection: "out", amountCents: 0n, costBasisCents: 1n })).toThrow(/itx_basis_only_in/);
    expect(() => assertTxnShape({ ...base, type: "transfer", transferDirection: "in", amountCents: 0n, costBasisCents: 1n, acquiredDate: "2026-01-01" })).not.toThrow();
    expect(() => assertTxnShape({ ...base, type: "fee", amountCents: 1n, quantity: null, price: null })).toThrow(/itx_fee/);
    expect(() => assertTxnShape({ ...base, type: "buy", feeCents: -1n })).toThrow(/itx_fee_nonneg/);
  });
});
