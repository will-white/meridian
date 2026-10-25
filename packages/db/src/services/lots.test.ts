import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { incomeByMonth, parseFixed8, type IsoDate } from "@meridian/shared";
import { account, investmentTxn, lot, lotDisposal, lotPick } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { INV_SEED_TODAY, seedInvestmentFixture, type InvestmentSeed } from "../test/investmentSeed.js";
import { listAudit } from "./audit.js";
import { deleteInvestmentTxn } from "./investmentTxns.js";
import { buildAccountLots, computeHoldings, listLots, listRealized, loadInvestmentTxns, rebuildLots, setLotPicks } from "./lots.js";

const f8 = parseFixed8;
const ctx = (batchId = randomUUID()) => ({ userId: null, batchId });

/**
 * Lots design TC26 (service integration) under the plan's names: TC2's rows stored, rebuilt
 * twice, picked as in TC3, then s1 deleted; TC10's rows in a second account; the stored
 * realized rows equal the engine's. Every number is the design's hand calculation.
 */
describe.skipIf(!TEST_DATABASE_URL)("lots service (TC26)", () => {
  let t: TestDb;
  let S: InvestmentSeed;
  let A: string; // TC2's brokerage
  let A2: string; // TC10's account
  let b1: string;
  let b2: string;
  let s1: string;
  let d2: string;

  const insertTxn = async (row: Omit<typeof investmentTxn.$inferInsert, "source"> & { source?: "manual" | "csv" }) => {
    const [r] = await t.db
      .insert(investmentTxn)
      .values({ source: "manual", ...row })
      .returning({ id: investmentTxn.id });
    return r!.id;
  };
  const lotsOf = async (accountId: string) =>
    (await t.db.select().from(lot).where(eq(lot.accountId, accountId)).orderBy(asc(lot.acquiredDate), asc(lot.ordinal))).map((l) => ({
      id: l.id,
      openedByTxnId: l.openedByTxnId,
      ordinal: l.ordinal,
      openedBy: l.openedBy,
      acquiredDate: l.acquiredDate,
      originalQuantity: f8(l.originalQuantity),
      quantity: f8(l.quantity),
      originalCostBasisCents: l.originalCostBasisCents,
      costBasisCents: l.costBasisCents,
      basisKnown: l.basisKnown,
      closedDate: l.closedDate,
    }));
  const disposalsOf = async (accountId: string) =>
    (await t.db.select().from(lotDisposal).where(eq(lotDisposal.accountId, accountId)).orderBy(asc(lotDisposal.date), asc(lotDisposal.acquiredDate))).map((d) => ({
      closeTxnId: d.closeTxnId,
      lotId: d.lotId,
      kind: d.kind,
      quantity: f8(d.quantity),
      proceedsCents: d.proceedsCents,
      basisCents: d.basisCents,
      gainCents: d.gainCents,
      term: d.term,
      acquiredDate: d.acquiredDate,
      basisKnown: d.basisKnown,
    }));

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedInvestmentFixture(t.db);
    const rows = await t.db
      .insert(account)
      .values([
        { name: "TC2 Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false },
        { name: "TC10 Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false },
      ])
      .returning({ id: account.id, name: account.name });
    A = rows.find((r) => r.name === "TC2 Brokerage")!.id;
    A2 = rows.find((r) => r.name === "TC10 Brokerage")!.id;
    const VTI = S.securities.vti;
    const VXUS = S.securities.vxus;
    // TC2: b1 buy 100 @ 10 (fee 495, −100495); b2 buy 50 @ 12 (−60000); s1 sell 120 @ 15 (fee 5, +179995).
    b1 = await insertTxn({ accountId: A, securityId: VTI, date: "2025-03-03", type: "buy", quantity: "100", price: "10", amountCents: -100495n, feeCents: 495n });
    b2 = await insertTxn({ accountId: A, securityId: VTI, date: "2025-09-10", type: "buy", quantity: "50", price: "12", amountCents: -60000n, feeCents: 0n });
    s1 = await insertTxn({ accountId: A, securityId: VTI, date: "2026-04-01", type: "sell", quantity: "120", price: "15", amountCents: 179995n, feeCents: 5n });
    // TC10: d1 dividend 4321 VTI 03-25; d2 reinvest 0.5 VXUS @ 60 (−3000) 03-27; i1 interest 77 03-31; d3 dividend 4400 VTI 06-25; f1 fee −1250 06-30.
    await insertTxn({ accountId: A2, securityId: VTI, date: "2026-03-25", type: "dividend", amountCents: 4321n });
    d2 = await insertTxn({ accountId: A2, securityId: VXUS, date: "2026-03-27", type: "reinvest", quantity: "0.5", price: "60", amountCents: -3000n });
    await insertTxn({ accountId: A2, securityId: null, date: "2026-03-31", type: "interest", amountCents: 77n });
    await insertTxn({ accountId: A2, securityId: VTI, date: "2026-06-25", type: "dividend", amountCents: 4400n });
    await insertTxn({ accountId: A2, securityId: null, date: "2026-06-30", type: "fee", amountCents: -1250n });
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("stores TC2's lots and disposals; a second rebuild keeps every id (rebuilt_at aside)", async () => {
    const first = await t.db.transaction((tx) => rebuildLots(tx, A));
    expect(first).toMatchObject({ lots: 2, disposals: 2, warnings: [] });
    const lotsA = await lotsOf(A);
    expect(lotsA).toEqual([
      { id: lotsA[0]!.id, openedByTxnId: b1, ordinal: 0, openedBy: "buy", acquiredDate: "2025-03-03", originalQuantity: f8("100"), quantity: 0n, originalCostBasisCents: 100495n, costBasisCents: 0n, basisKnown: true, closedDate: "2026-04-01" },
      { id: lotsA[1]!.id, openedByTxnId: b2, ordinal: 0, openedBy: "buy", acquiredDate: "2025-09-10", originalQuantity: f8("50"), quantity: f8("30"), originalCostBasisCents: 60000n, costBasisCents: 36000n, basisKnown: true, closedDate: null },
    ]);
    const lotB1 = lotsA[0]!.id;
    const lotB2 = lotsA[1]!.id;
    // Proceeds 179995 over [100, 20]: 149995.83 / 29999.17 → largest remainder gives 149996 / 29999.
    expect(await disposalsOf(A)).toEqual([
      { closeTxnId: s1, lotId: lotB1, kind: "sell", quantity: f8("100"), proceedsCents: 149996n, basisCents: 100495n, gainCents: 49501n, term: "long", acquiredDate: "2025-03-03", basisKnown: true },
      { closeTxnId: s1, lotId: lotB2, kind: "sell", quantity: f8("20"), proceedsCents: 29999n, basisCents: 24000n, gainCents: 5999n, term: "short", acquiredDate: "2025-09-10", basisKnown: true },
    ]);

    const again = await t.db.transaction((tx) => rebuildLots(tx, A));
    expect(again).toMatchObject({ lots: 2, disposals: 2 });
    expect(await lotsOf(A)).toEqual(lotsA);
    expect((await disposalsOf(A)).map((d) => d.lotId)).toEqual([lotB1, lotB2]);
  });

  it("the stored realized rows equal the engine's disposals (GET /api/investments/realized)", async () => {
    const engine = await buildAccountLots(t.db, A);
    const stored = await listRealized(t.db, { from: "2025-12-31", to: "2026-10-14", accountId: A });
    expect(stored.disposals.map(({ accountName: _a, ticker: _t, ...d }) => d)).toEqual(engine.result.disposals);
    expect(stored.summary).toEqual({
      shortTerm: { proceedsCents: 29999n, basisCents: 24000n, gainCents: 5999n, count: 1 },
      longTerm: { proceedsCents: 149996n, basisCents: 100495n, gainCents: 49501n, count: 1 },
      unknownBasis: { proceedsCents: 0n, quantity: 0n, count: 0 },
      transfersOut: { quantity: 0n, basisCents: 0n },
      washSalesApplied: false,
    });
    expect(stored.byAccount).toEqual([{ accountId: A, name: "TC2 Brokerage", summary: stored.summary }]);
    // Before the sale nothing was realized; the range is (from, to].
    expect((await listRealized(t.db, { from: "2025-01-01", to: "2026-03-31", accountId: A })).disposals).toEqual([]);
    expect((await listRealized(t.db, { from: "2026-03-31", to: "2026-04-01", accountId: A })).disposals).toHaveLength(2);
  });

  it("TC3 through setLotPicks: picks apply, lot ids stay, one lot_pick audit entry; bad picks are refused", async () => {
    await t.db.update(account).set({ lotMethod: "specific" }).where(eq(account.id, A));
    const before = await lotsOf(A);
    const lotB1 = before[0]!.id;
    const lotB2 = before[1]!.id;
    const batch = randomUUID();
    const set = await setLotPicks(t.db, s1, [{ lotId: lotB2, quantity: f8("50") }], ctx(batch));
    expect(set.picks).toHaveLength(1);
    expect(set.picks[0]).toMatchObject({ sellTxnId: s1, lotId: lotB2, quantity: f8("50"), position: 0 });
    expect(set.warnings).toEqual([]);
    // b2 50 sh → proceeds 74998 (179995 × 50/120 = 74997.9), basis 60000, gain 14998; b1 70 sh → 104997, basis round(100495 × 70/100) = 70347, gain 34650.
    expect(await disposalsOf(A)).toEqual([
      { closeTxnId: s1, lotId: lotB1, kind: "sell", quantity: f8("70"), proceedsCents: 104997n, basisCents: 70347n, gainCents: 34650n, term: "long", acquiredDate: "2025-03-03", basisKnown: true },
      { closeTxnId: s1, lotId: lotB2, kind: "sell", quantity: f8("50"), proceedsCents: 74998n, basisCents: 60000n, gainCents: 14998n, term: "short", acquiredDate: "2025-09-10", basisKnown: true },
    ]);
    const after = await lotsOf(A);
    expect(after.map((l) => l.id)).toEqual([lotB1, lotB2]);
    expect(after[0]).toMatchObject({ quantity: f8("30"), costBasisCents: 30148n, closedDate: null });
    expect(after[1]).toMatchObject({ quantity: 0n, costBasisCents: 0n, closedDate: "2026-04-01" });
    const audit = await listAudit(t.db, { entity: "lot_pick", limit: 10 });
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ batchId: batch, entityId: s1, action: "create", before: null, after: [{ lotId: lotB2, quantity: "50", position: 0 }] });

    // A pick beyond the lot's open quantity as of the sale, a pick on a row that is not a sale, an unknown lot, a lot of another account.
    await expect(setLotPicks(t.db, s1, [{ lotId: lotB2, quantity: f8("60") }], ctx())).rejects.toMatchObject({ status: 400, code: "pick_exceeds_lot" });
    await expect(setLotPicks(t.db, d2, [{ lotId: lotB1, quantity: f8("10") }], ctx())).rejects.toMatchObject({ status: 400, code: "not_a_sale" });
    await expect(setLotPicks(t.db, s1, [{ lotId: randomUUID(), quantity: f8("1") }], ctx())).rejects.toMatchObject({ status: 400, code: "lot_not_found" });
    await expect(setLotPicks(t.db, s1, [{ lotId: lotB2, quantity: f8("50") }, { lotId: lotB1, quantity: f8("100") }], ctx())).rejects.toMatchObject({ status: 400, code: "picks_exceed_sale" });
    await expect(setLotPicks(t.db, randomUUID(), [], ctx())).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect((await t.db.select().from(lotPick).where(eq(lotPick.sellTxnId, s1))).map((p) => p.lotId)).toEqual([lotB2]);

    // Clearing the picks under `specific` leaves the FIFO result and a needs_lot_pick warning on the sale.
    const cleared = await setLotPicks(t.db, s1, [], ctx());
    expect(cleared.picks).toEqual([]);
    expect(cleared.warnings.map((w) => w.code)).toEqual(["needs_lot_pick"]);
    expect((await disposalsOf(A)).map((d) => [d.lotId, d.quantity])).toEqual([
      [lotB1, f8("100")],
      [lotB2, f8("20")],
    ]);
    expect((await listAudit(t.db, { entity: "lot_pick", limit: 10 })).items[0]).toMatchObject({ entityId: s1, action: "delete", after: null });
  });

  it("deleting s1 leaves both lots open with their original basis; holdings and the lots list value them", async () => {
    const ids = (await lotsOf(A)).map((l) => l.id);
    await deleteInvestmentTxn(t.db, s1, {}, ctx());
    expect(await disposalsOf(A)).toEqual([]);
    const open = await lotsOf(A);
    expect(open.map((l) => l.id)).toEqual(ids);
    expect(open.map((l) => [l.quantity, l.costBasisCents, l.closedDate])).toEqual([
      [f8("100"), 100495n, null],
      [f8("50"), 60000n, null],
    ]);

    // VTI's latest close in the seed is 312.5 on 2026-10-13: 150 × 312.5 = 46 875.00; basis 160 495.
    const holdings = await computeHoldings(t.db, { accountIds: [A], asOf: INV_SEED_TODAY });
    expect(holdings.rows).toHaveLength(1);
    expect(holdings.rows[0]).toMatchObject({
      accountId: A,
      securityId: S.securities.vti,
      ticker: "VTI",
      quantity: f8("150"),
      valueCents: 4687500n,
      costBasisCents: 160495n,
      unrealizedCents: 4687500n - 160495n,
      lotCount: 2,
      priceDate: "2026-10-13",
      priceSource: "provider",
      stale: false,
      basisSource: "lots",
    });
    // Long-term for b1 (2025-03-03 + 12 months < 2026-10-14), short for b2 (2025-09-10 + 12 m = 2026-09-10 < 2026-10-14 → long too).
    expect(holdings.rows[0]!.unrealizedLongCents).toBe(4687500n - 160495n);
    expect(holdings.rows[0]!.unrealizedShortCents).toBe(0n);

    const listed = await listLots(t.db, { accountId: A, asOf: INV_SEED_TODAY });
    expect(listed.lots.map((l) => [l.id, l.valueCents, l.unrealizedCents, l.term, l.basisPerShare])).toEqual([
      [ids[0], 3125000n, 3125000n - 100495n, "long", f8("10.0495")],
      [ids[1], 1562500n, 1562500n - 60000n, "long", f8("12")],
    ]);
    expect(listed.accounts).toEqual([{ accountId: A, fidelity: "full_history", lotMethod: "specific", positionCheckDate: null, warnings: [] }]);
    // As of a date before b2, only b1 exists and it is still short-term.
    const early = await computeHoldings(t.db, { accountIds: [A], asOf: "2025-06-01" });
    expect(early.rows[0]).toMatchObject({ quantity: f8("100"), lotCount: 1, valueCents: null, unrealizedShortCents: 0n });
  });

  it("TC10's income rows come straight from the stored rows; the reinvest opened a lot", async () => {
    const txns = await loadInvestmentTxns(t.db, A2);
    const VTI = S.securities.vti;
    const VXUS = S.securities.vxus;
    expect(incomeByMonth(txns)).toEqual([
      { month: "2026-03", securityId: null, dividendCents: 0n, interestCents: 77n, feeCents: 0n, reinvestedCents: 0n },
      ...[
        { month: "2026-03", securityId: VTI, dividendCents: 4321n, interestCents: 0n, feeCents: 0n, reinvestedCents: 0n },
        { month: "2026-03", securityId: VXUS, dividendCents: 0n, interestCents: 0n, feeCents: 0n, reinvestedCents: 3000n },
      ].sort((a, b) => (a.securityId < b.securityId ? -1 : 1)),
      { month: "2026-06", securityId: null, dividendCents: 0n, interestCents: 0n, feeCents: 1250n, reinvestedCents: 0n },
      { month: "2026-06", securityId: VTI, dividendCents: 4400n, interestCents: 0n, feeCents: 0n, reinvestedCents: 0n },
    ]);
    await t.db.transaction((tx) => rebuildLots(tx, A2));
    const lots = await lotsOf(A2);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ openedByTxnId: d2, openedBy: "reinvest", quantity: f8("0.5"), costBasisCents: 3000n });
  });

  it("loadInvestmentTxns applies the sign for sells and transfers out and can drop cash transfers", async () => {
    const C = (await t.db.insert(account).values({ name: "Sign check", type: "ira", taxTreatment: "pre_tax", onBudget: false }).returning({ id: account.id }))[0]!.id;
    const VTI = S.securities.vti;
    const dates: IsoDate[] = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"];
    await insertTxn({ accountId: C, securityId: VTI, date: dates[0]!, type: "buy", quantity: "10", price: "100", amountCents: -100000n });
    await insertTxn({ accountId: C, securityId: VTI, date: dates[1]!, type: "sell", quantity: "4", price: "110", amountCents: 44000n });
    await insertTxn({ accountId: C, securityId: VTI, date: dates[2]!, type: "transfer", transferDirection: "out", quantity: "2", amountCents: 0n });
    await insertTxn({ accountId: C, securityId: null, date: dates[3]!, type: "transfer", transferDirection: "in", amountCents: 5000n });
    const all = await loadInvestmentTxns(t.db, C);
    expect(all.map((x) => [x.date, x.type, x.quantity])).toEqual([
      ["2026-01-05", "buy", f8("10")],
      ["2026-01-06", "sell", f8("-4")],
      ["2026-01-07", "transfer", f8("-2")],
      ["2026-01-08", "transfer", null],
    ]);
    expect((await loadInvestmentTxns(t.db, C, { securitiesOnly: true })).map((x) => x.date)).toEqual(dates.slice(0, 3));
    expect((await loadInvestmentTxns(t.db, C, { through: "2026-01-06" })).map((x) => x.date)).toEqual(dates.slice(0, 2));
    const rebuilt = await t.db.transaction((tx) => rebuildLots(tx, C));
    expect(rebuilt).toMatchObject({ lots: 1, disposals: 2, warnings: [] });
    expect((await disposalsOf(C)).map((d) => [d.kind, d.quantity, d.proceedsCents, d.basisCents, d.gainCents, d.term])).toEqual([
      ["sell", f8("4"), 44000n, 40000n, 4000n, "short"],
      ["transfer_out", f8("2"), 0n, 20000n, 0n, "none"],
    ]);
  });
});
