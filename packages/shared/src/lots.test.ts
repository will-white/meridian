import { describe, expect, it } from "vitest";
import { addDays, type IsoDate } from "./dates.js";
import { allocateLargestRemainder, formatFixed8, mulToCents, parseFixed8, roundDivHalfAway, scaleQty, type Fixed8 } from "./decimal.js";
import type { EngineWarningCode, InvestmentTxnType, LotMethod } from "./enums.js";
import {
  POSITION_TOLERANCE,
  buildLots,
  checkPositions,
  holdingsAsOf,
  incomeByMonth,
  isLongTerm,
  isStalePrice,
  lotKey,
  quantityAt,
  sortInvestmentTxns,
  summarizeGains,
  summarizeRealized,
  txnRank,
  valueLots,
  type EngineLotPick,
  type InvestmentTxnInput,
  type LotBuildResult,
  type LotResult,
  type PriceQuote,
} from "./lots.js";

/**
 * The lots design's hand-calculated cases (§7: TC1–TC10, TC18, TC20, TC22, TC28–TC31, TC34)
 * re-derived under the Phase 3 plan's settlements. Every expectation that changed is marked
 * "re-derived" with the rule that changed it:
 *   - plan decision 6: a reinvested dividend is two rows (`dividend` income, `reinvest` purchase
 *     with amount ≤ 0, cash effect = amount, never income; `reinvestedCents` = Σ −amount);
 *   - seams C4: proceeds across lots by largest remainder (R4);
 *   - seams C5: split scaling R5 per lot without a residual fix;
 *   - seams C2: `formatFixed8` has no trailing zeros ("123.4");
 *   - seams C3: the 5-cent `amountMismatch` check shared with the trade preview;
 *   - plan decisions 4/5: column names (`sequence`, `splitNum/Den`, `costBasisCents`,
 *     `acquiredDate`), signed engine quantities, lot ids stable by (openedByTxnId, ordinal) with
 *     `originLotId` for transfer-in legs.
 */

const f = parseFixed8;
const A = "A";

function txn(o: Partial<InvestmentTxnInput> & { id: string; type: InvestmentTxnType; date: IsoDate }): InvestmentTxnInput {
  return {
    accountId: A,
    securityId: null,
    sequence: 0,
    quantity: null,
    price: null,
    amountCents: null,
    feeCents: null,
    splitNum: null,
    splitDen: null,
    costBasisCents: null,
    acquiredDate: null,
    transferGroupId: null,
    counterpartyAccountId: null,
    ...o,
  };
}
const buy = (id: string, date: IsoDate, sec: string, qty: string, price: string, amount: bigint | null, fee: bigint | null = 0n, sequence = 0) =>
  txn({ id, type: "buy", date, securityId: sec, quantity: f(qty), price: f(price), amountCents: amount, feeCents: fee, sequence });
const sell = (id: string, date: IsoDate, sec: string, qty: string, price: string | null, amount: bigint | null, fee: bigint | null = 0n, sequence = 0) =>
  txn({ id, type: "sell", date, securityId: sec, quantity: -f(qty), price: price === null ? null : f(price), amountCents: amount, feeCents: fee, sequence });
const reinvest = (id: string, date: IsoDate, sec: string, qty: string, price: string, amount: bigint | null, sequence = 0) =>
  txn({ id, type: "reinvest", date, securityId: sec, quantity: f(qty), price: f(price), amountCents: amount, feeCents: 0n, sequence });
const dividend = (id: string, date: IsoDate, sec: string | null, amount: bigint, sequence = 0) => txn({ id, type: "dividend", date, securityId: sec, amountCents: amount, sequence });
const interest = (id: string, date: IsoDate, amount: bigint, sequence = 0) => txn({ id, type: "interest", date, amountCents: amount, sequence });
const fee = (id: string, date: IsoDate, amount: bigint, sec: string | null = null) => txn({ id, type: "fee", date, securityId: sec, amountCents: amount });
const split = (id: string, date: IsoDate, sec: string, num: number, den: number, sequence = 0) =>
  txn({ id, type: "split", date, securityId: sec, splitNum: num, splitDen: den, amountCents: 0n, sequence });
const transferIn = (id: string, date: IsoDate, sec: string, qty: string, o: { costBasisCents?: bigint; acquiredDate?: IsoDate; price?: string } = {}) =>
  txn({
    id,
    type: "transfer",
    date,
    securityId: sec,
    quantity: f(qty),
    amountCents: 0n,
    costBasisCents: o.costBasisCents ?? null,
    acquiredDate: o.acquiredDate ?? null,
    price: o.price === undefined ? null : f(o.price),
  });
const transferOut = (id: string, date: IsoDate, sec: string, qty: string, price?: string) =>
  txn({ id, type: "transfer", date, securityId: sec, quantity: -f(qty), amountCents: 0n, price: price === undefined ? null : f(price) });

const build = (txns: InvestmentTxnInput[], lotMethod: LotMethod = "fifo", lotPicks: EngineLotPick[] = []) => buildLots({ accountId: A, lotMethod, txns, lotPicks });
const lotById = (r: LotBuildResult, id: string): LotResult => {
  const lot = r.lots.find((l) => l.id === id);
  if (!lot) throw new Error(`no lot ${id}`);
  return lot;
};
const lastPosition = (r: LotBuildResult, sec: string) => r.positions[r.positions.length - 1]!.quantityBySecurity.get(sec);
const codes = (r: LotBuildResult) => r.warnings.map((w) => w.code);
const quote = (close: string, date: IsoDate): PriceQuote => ({ close: f(close), date, source: "provider" });

describe("TC1. rounding rules the engine relies on (re-derived: formatFixed8 has no trailing zeros)", () => {
  it("basis consumption and R5 are roundDivHalfAway; the canonical text form drops zeros", () => {
    expect(roundDivHalfAway(100495n * f("70"), f("100"))).toBe(70347n); // 70346.5 → 70347
    expect(roundDivHalfAway(60000n * f("20"), f("50"))).toBe(24000n);
    expect(scaleQty(f("15"), 1, 10)).toBe(f("1.5"));
    expect(scaleQty(f("7"), 1, 3)).toBe(f("2.33333333"));
    expect(formatFixed8(f("123.4"))).toBe("123.4"); // the design's "123.40000000" (C2)
    expect(mulToCents(f("3.5"), f("101.33"))).toBe(35466n);
  });
});

describe("§3.2 ordering: (date, type rank, sequence, id) with split first", () => {
  it("ranks every type and takes a transfer's direction from the quantity sign", () => {
    expect(txnRank(split("s", "2026-01-01", "X", 2, 1))).toBe(0);
    expect(txnRank(transferIn("t", "2026-01-01", "X", "1"))).toBe(1);
    expect(txnRank(txn({ id: "c", type: "transfer", date: "2026-01-01", amountCents: 100n }))).toBe(1); // cash transfer
    expect(txnRank(buy("b", "2026-01-01", "X", "1", "1", -100n))).toBe(2);
    expect(txnRank(reinvest("r", "2026-01-01", "X", "1", "1", -100n))).toBe(3);
    expect(txnRank(dividend("d", "2026-01-01", "X", 1n))).toBe(4);
    expect(txnRank(interest("i", "2026-01-01", 1n))).toBe(4);
    expect(txnRank(fee("f", "2026-01-01", -1n))).toBe(5);
    expect(txnRank(sell("s2", "2026-01-01", "X", "1", "1", 100n))).toBe(6);
    expect(txnRank(transferOut("o", "2026-01-01", "X", "1"))).toBe(7);
  });
  it("sorts without mutating the input", () => {
    const rows = [sell("z", "2026-01-05", "X", "5", "10", 5000n, 0n, 1), buy("a", "2026-01-05", "X", "5", "9", -4500n, 0n, 0), buy("m", "2026-01-04", "X", "1", "8", -800n, 0n, 7)];
    const copy = [...rows];
    expect(sortInvestmentTxns(rows).map((t) => t.id)).toEqual(["m", "a", "z"]);
    expect(rows).toEqual(copy);
  });
});

describe("TC2. FIFO across two lots with commissions, proceeds split by largest remainder (C4)", () => {
  const rows = [buy("b1", "2025-03-03", "VTI", "100", "10", -100495n, 495n), buy("b2", "2025-09-10", "VTI", "50", "12", -60000n, 0n), sell("s1", "2026-04-01", "VTI", "120", "15", 179995n, 5n)];
  it("disposes b1 fully and 20 of b2, allocating 179995 over [100, 20] as [149996, 29999]", () => {
    const r = build(rows);
    expect(r.disposals).toEqual([
      { closeTxnId: "s1", lotId: "b1", accountId: A, securityId: "VTI", kind: "sell", date: "2026-04-01", acquiredDate: "2025-03-03", quantity: f("100"), proceedsCents: 149996n, basisCents: 100495n, gainCents: 49501n, term: "long", basisKnown: true },
      { closeTxnId: "s1", lotId: "b2", accountId: A, securityId: "VTI", kind: "sell", date: "2026-04-01", acquiredDate: "2025-09-10", quantity: f("20"), proceedsCents: 29999n, basisCents: 24000n, gainCents: 5999n, term: "short", basisKnown: true },
    ]);
    expect(lotById(r, "b1")).toEqual({
      id: "b1",
      openedByTxnId: "b1",
      ordinal: 0,
      originLotId: null,
      accountId: A,
      securityId: "VTI",
      openedBy: "buy",
      acquiredDate: "2025-03-03",
      originalQuantity: f("100"),
      quantity: 0n,
      originalCostBasisCents: 100495n,
      costBasisCents: 0n,
      basisKnown: true,
      closedDate: "2026-04-01",
    });
    expect(lotById(r, "b2")).toMatchObject({ quantity: f("30"), costBasisCents: 36000n, originalQuantity: f("50"), originalCostBasisCents: 60000n, closedDate: null });
    expect(lastPosition(r, "VTI")).toBe(f("30"));
    expect(r.cashEffects.map((c) => c.cents)).toEqual([-100495n, -60000n, 179995n]);
    expect(r.warnings).toEqual([]);
    expect(r.income).toEqual([]);
  });
  it("variant: b1 with feeCents null → identical lots and disposals plus amount_mismatch −495 (C3, 5 cents)", () => {
    const base = build(rows);
    const r = build([buy("b1", "2025-03-03", "VTI", "100", "10", -100495n, null), rows[1]!, rows[2]!]);
    expect(r.lots).toEqual(base.lots);
    expect(r.disposals).toEqual(base.disposals);
    expect(r.warnings).toEqual([{ code: "amount_mismatch", txnId: "b1", securityId: "VTI", diffCents: -495n }]);
  });
});

describe("TC3. specific identification with a partial FIFO remainder", () => {
  const rows = [buy("b1", "2025-03-03", "VTI", "100", "10", -100495n, 495n), buy("b2", "2025-09-10", "VTI", "50", "12", -60000n, 0n), sell("s1", "2026-04-01", "VTI", "120", "15", 179995n, 5n)];
  it("takes the pick first, then FIFO; 179995 over [50, 70] → [74998, 104997]", () => {
    const r = build(rows, "specific", [{ sellTxnId: "s1", lotId: "b2", quantity: f("50"), position: 0 }]);
    expect(r.disposals.map((d) => [d.lotId, d.quantity, d.proceedsCents, d.basisCents, d.gainCents, d.term])).toEqual([
      ["b2", f("50"), 74998n, 60000n, 14998n, "short"],
      ["b1", f("70"), 104997n, 70347n, 34650n, "long"],
    ]);
    expect(lotById(r, "b2")).toMatchObject({ quantity: 0n, costBasisCents: 0n, closedDate: "2026-04-01" });
    expect(lotById(r, "b1")).toMatchObject({ quantity: f("30"), costBasisCents: 30148n, closedDate: null });
    expect(r.warnings).toEqual([]);
  });
  it("specific without picks → TC2's disposals plus needs_lot_pick", () => {
    const r = build(rows, "specific");
    expect(r.disposals).toEqual(build(rows).disposals);
    expect(r.warnings).toEqual([{ code: "needs_lot_pick", txnId: "s1", securityId: "VTI" }]);
  });
  it("caps a pick at the lot (pick_exceeds_lot) and at the sale (pick_exceeds_sale)", () => {
    const over = build(rows, "specific", [{ sellTxnId: "s1", lotId: "b2", quantity: f("60"), position: 0 }]);
    expect(over.disposals.map((d) => [d.lotId, d.quantity])).toEqual([
      ["b2", f("50")],
      ["b1", f("70")],
    ]);
    expect(over.warnings).toEqual([{ code: "pick_exceeds_lot", txnId: "s1", securityId: "VTI", quantity: f("60"), detail: "b2" }]);
    const both = build(rows, "specific", [
      { sellTxnId: "s1", lotId: "b2", quantity: f("50"), position: 0 },
      { sellTxnId: "s1", lotId: "b1", quantity: f("100"), position: 1 },
    ]);
    expect(both.disposals.map((d) => [d.lotId, d.quantity])).toEqual([
      ["b2", f("50")],
      ["b1", f("70")],
    ]);
    expect(both.warnings).toEqual([{ code: "pick_exceeds_sale", txnId: "s1", securityId: "VTI", quantity: f("100"), detail: "b1" }]);
  });
  it("a pick for a closed lot, another security or a lot opened later is pick_unavailable and skipped", () => {
    const r = build([...rows, buy("b3", "2026-05-01", "VTI", "1", "10", -1000n), buy("x1", "2025-01-01", "BND", "5", "10", -5000n)], "specific", [
      { sellTxnId: "s1", lotId: "x1", quantity: f("1"), position: 0 },
      { sellTxnId: "s1", lotId: "b3", quantity: f("1"), position: 1 },
      { sellTxnId: "s1", lotId: "b2", quantity: f("50"), position: 2 },
    ]);
    expect(codes(r)).toEqual(["pick_unavailable", "pick_unavailable"]);
    expect(r.disposals.map((d) => [d.lotId, d.quantity])).toEqual([
      ["b2", f("50")],
      ["b1", f("70")],
    ]);
  });
});

describe("TC4. forward split, reverse split and a fractional lot (C5: R5 per lot, no residual fix)", () => {
  it("scales open lots only; basis, acquisition date and original quantity are unchanged", () => {
    const r = build([buy("b1", "2025-03-03", "AAA", "10", "100", -100000n), split("sp", "2025-06-01", "AAA", 3, 2), buy("b2", "2025-08-01", "AAA", "5", "70", -35000n), sell("s1", "2026-07-01", "AAA", "12", "80", 96000n)]);
    expect(r.positions.map((p) => [p.id, p.quantityBySecurity.get("AAA")])).toEqual([
      ["b1", f("10")],
      ["sp", f("15")],
      ["b2", f("20")],
      ["s1", f("8")],
    ]);
    expect(r.disposals).toEqual([
      { closeTxnId: "s1", lotId: "b1", accountId: A, securityId: "AAA", kind: "sell", date: "2026-07-01", acquiredDate: "2025-03-03", quantity: f("12"), proceedsCents: 96000n, basisCents: 80000n, gainCents: 16000n, term: "long", basisKnown: true },
    ]);
    expect(lotById(r, "b1")).toMatchObject({ quantity: f("3"), costBasisCents: 20000n, originalQuantity: f("10"), originalCostBasisCents: 100000n });
    expect(lotById(r, "b2")).toMatchObject({ quantity: f("5"), costBasisCents: 35000n });
    expect(r.warnings).toEqual([]);
  });
  it("reverse splits round per lot at the 8th place", () => {
    const ten = build([buy("b", "2025-01-01", "X", "15", "2", -3000n), split("sp", "2025-02-01", "X", 1, 10)]);
    expect(lotById(ten, "b")).toMatchObject({ quantity: f("1.5"), costBasisCents: 3000n, originalQuantity: f("15") });
    const third = build([buy("b", "2025-01-01", "X", "7", "2", -1400n), split("sp", "2025-02-01", "X", 1, 3)]);
    expect(lotById(third, "b")).toMatchObject({ quantity: f("2.33333333"), costBasisCents: 1400n });
    expect(lastPosition(third, "X")).toBe(f("2.33333333"));
  });
  it("a closed lot is not scaled", () => {
    const r = build([buy("b", "2025-01-01", "X", "10", "2", -2000n), sell("s", "2025-01-15", "X", "10", "3", 3000n), split("sp", "2025-02-01", "X", 2, 1)]);
    expect(lotById(r, "b")).toMatchObject({ quantity: 0n, closedDate: "2025-01-15" });
    expect(lastPosition(r, "X")).toBe(0n);
  });
  it("a bad split ratio is bad_quantity and ignored", () => {
    const r = build([buy("b", "2025-01-01", "X", "10", "2", -2000n), txn({ id: "sp", type: "split", date: "2025-02-01", securityId: "X", splitNum: 0, splitDen: 1, amountCents: 0n })]);
    expect(r.warnings).toEqual([{ code: "bad_quantity", txnId: "sp", securityId: "X", detail: "split ratio" }]);
    expect(lastPosition(r, "X")).toBe(f("10"));
  });
});

describe("TC5. reinvested dividend (re-derived: two rows, plan decision 6)", () => {
  // The design had one `reinvest` row carrying income with cash effect 0. Under the plan the
  // importer lands a `dividend` (+5100, income) and a `reinvest` (−5100, a purchase); the
  // reinvest ranks before the same-day dividend (3 < 4).
  const rows = [
    buy("b1", "2025-01-15", "FND", "100", "20", -200000n),
    dividend("d0", "2025-03-31", "FND", 5100n, 0),
    reinvest("d1", "2025-03-31", "FND", "2.5", "20.4", -5100n, 1),
    dividend("d2", "2025-06-30", "FND", 5200n, 0),
    interest("i1", "2025-06-30", 123n, 1),
    fee("f1", "2025-07-01", -2500n),
    sell("s1", "2026-02-02", "FND", "101", "22", 222200n),
  ];
  it("opens a reinvest lot that is sold FIFO after the original lot", () => {
    const r = build(rows);
    expect(lotById(r, "b1")).toMatchObject({ quantity: 0n, closedDate: "2026-02-02" });
    expect(lotById(r, "d1")).toMatchObject({ openedBy: "reinvest", acquiredDate: "2025-03-31", originalQuantity: f("2.5"), originalCostBasisCents: 5100n, quantity: f("1.5"), costBasisCents: 3060n });
    expect(r.disposals.map((d) => [d.lotId, d.quantity, d.proceedsCents, d.basisCents, d.gainCents, d.term])).toEqual([
      ["b1", f("100"), 220000n, 200000n, 20000n, "long"],
      ["d1", f("1"), 2200n, 2040n, 160n, "short"],
    ]);
    expect(r.warnings).toEqual([]);
  });
  it("income rows: the dividend row is the income, the reinvest row the reinvested sub-total", () => {
    const r = build(rows);
    expect(r.income).toEqual([
      { month: "2025-03", securityId: "FND", dividendCents: 5100n, interestCents: 0n, feeCents: 0n, reinvestedCents: 5100n },
      { month: "2025-06", securityId: null, dividendCents: 0n, interestCents: 123n, feeCents: 0n, reinvestedCents: 0n },
      { month: "2025-06", securityId: "FND", dividendCents: 5200n, interestCents: 0n, feeCents: 0n, reinvestedCents: 0n },
      { month: "2025-07", securityId: null, dividendCents: 0n, interestCents: 0n, feeCents: 2500n, reinvestedCents: 0n },
    ]);
    expect(r.income).toEqual(incomeByMonth(rows));
  });
  it("cash effects (re-derived): the reinvest is a −5100 purchase and the dividend a +5100 receipt", () => {
    const r = build(rows);
    expect(r.cashEffects).toEqual([
      { txnId: "b1", date: "2025-01-15", cents: -200000n },
      { txnId: "d1", date: "2025-03-31", cents: -5100n },
      { txnId: "d0", date: "2025-03-31", cents: 5100n },
      { txnId: "d2", date: "2025-06-30", cents: 5200n },
      { txnId: "i1", date: "2025-06-30", cents: 123n },
      { txnId: "f1", date: "2025-07-01", cents: -2500n },
      { txnId: "s1", date: "2026-02-02", cents: 222200n },
    ]);
  });
});

describe("TC6. transfer in with carried basis and date; transfer out disposes at basis without gain", () => {
  const rows = [
    transferIn("t1", "2026-02-01", "VXUS", "40", { costBasisCents: 200000n, acquiredDate: "2024-01-15", price: "60" }),
    buy("b1", "2026-02-15", "VXUS", "10", "61", -61000n),
    sell("s1", "2026-03-01", "VXUS", "10", "62", 62000n),
    transferOut("t2", "2026-04-01", "VXUS", "35", "63"),
  ];
  it("sells from the carried lot with its carried date, then transfers out FIFO", () => {
    const r = build(rows);
    expect(lotById(r, "t1")).toMatchObject({ openedBy: "transfer_in", acquiredDate: "2024-01-15", basisKnown: true, originalCostBasisCents: 200000n, quantity: 0n, closedDate: "2026-04-01" });
    expect(lotById(r, "b1")).toMatchObject({ quantity: f("5"), costBasisCents: 30500n });
    expect(r.disposals).toEqual([
      { closeTxnId: "s1", lotId: "t1", accountId: A, securityId: "VXUS", kind: "sell", date: "2026-03-01", acquiredDate: "2024-01-15", quantity: f("10"), proceedsCents: 62000n, basisCents: 50000n, gainCents: 12000n, term: "long", basisKnown: true },
      { closeTxnId: "t2", lotId: "t1", accountId: A, securityId: "VXUS", kind: "transfer_out", date: "2026-04-01", acquiredDate: "2024-01-15", quantity: f("30"), proceedsCents: 0n, basisCents: 150000n, gainCents: 0n, term: "none", basisKnown: true },
      { closeTxnId: "t2", lotId: "b1", accountId: A, securityId: "VXUS", kind: "transfer_out", date: "2026-04-01", acquiredDate: "2026-02-15", quantity: f("5"), proceedsCents: 0n, basisCents: 30500n, gainCents: 0n, term: "none", basisKnown: true },
    ]);
    expect(r.transferredOut).toEqual([
      { txnId: "t2", lotId: "t1", securityId: "VXUS", acquiredDate: "2024-01-15", quantity: f("30"), basisCents: 150000n, basisKnown: true },
      { txnId: "t2", lotId: "b1", securityId: "VXUS", acquiredDate: "2026-02-15", quantity: f("5"), basisCents: 30500n, basisKnown: true },
    ]);
    expect(r.cashEffects.map((c) => c.txnId)).toEqual(["b1", "s1"]);
    expect(r.warnings).toEqual([]);
    expect(lastPosition(r, "VXUS")).toBe(f("5"));
  });
  it("the in-leg receives one lot per source lot (ordinals, originLotId) and sells the oldest first (plan decision 5)", () => {
    const out = build(rows);
    const inLeg = buildLots({
      accountId: "B",
      lotMethod: "fifo",
      txns: [transferIn("t3", "2026-04-01", "VXUS", "35"), sell("s2", "2026-05-01", "VXUS", "32", "65", 208000n)],
      lotPicks: [],
      transferSources: new Map([["t3", out.transferredOut]]),
    });
    expect(inLeg.lots.map((l) => [l.id, l.ordinal, l.originLotId, l.acquiredDate, l.originalQuantity, l.originalCostBasisCents, l.quantity, l.costBasisCents])).toEqual([
      ["t3", 0, "t1", "2024-01-15", f("30"), 150000n, 0n, 0n],
      ["t3:1", 1, "b1", "2026-02-15", f("5"), 30500n, f("3"), 18300n],
    ]);
    expect(inLeg.lots.every((l) => l.openedBy === "transfer_in" && l.accountId === "B" && l.openedByTxnId === "t3")).toBe(true);
    expect(inLeg.disposals.map((d) => [d.lotId, d.quantity, d.proceedsCents, d.basisCents, d.gainCents, d.term])).toEqual([
      ["t3", f("30"), 195000n, 150000n, 45000n, "long"],
      ["t3:1", f("2"), 13000n, 12200n, 800n, "short"],
    ]);
    expect(inLeg.warnings).toEqual([]);
  });
  it("sources short of the row quantity add an unknown-basis remainder lot; sources beyond it fall back to the row", () => {
    const sources = [{ txnId: "t2", lotId: "L", securityId: "VXUS", acquiredDate: "2024-01-15", quantity: f("30"), basisCents: 150000n, basisKnown: true }];
    const short = buildLots({ accountId: "B", lotMethod: "fifo", txns: [transferIn("t3", "2026-04-01", "VXUS", "35")], lotPicks: [], transferSources: new Map([["t3", sources]]) });
    expect(short.lots.map((l) => [l.id, l.ordinal, l.originLotId, l.quantity, l.costBasisCents, l.basisKnown, l.acquiredDate])).toEqual([
      ["t3", 0, "L", f("30"), 150000n, true, "2024-01-15"],
      ["t3:1", 1, null, f("5"), 0n, false, "2026-04-01"],
    ]);
    expect(short.warnings).toEqual([{ code: "basis_unknown", txnId: "t3", securityId: "VXUS", quantity: f("5") }]);
    const over = buildLots({
      accountId: "B",
      lotMethod: "fifo",
      txns: [transferIn("t3", "2026-04-01", "VXUS", "20", { costBasisCents: 99000n, acquiredDate: "2025-05-05" })],
      lotPicks: [],
      transferSources: new Map([["t3", sources]]),
    });
    expect(over.lots.map((l) => [l.id, l.originLotId, l.quantity, l.costBasisCents, l.basisKnown, l.acquiredDate])).toEqual([["t3", null, f("20"), 99000n, true, "2025-05-05"]]);
    expect(over.warnings).toEqual([{ code: "bad_quantity", txnId: "t3", securityId: "VXUS", quantity: f("20"), detail: "transfer sources carry 30 shares for a row of 20" }]);
  });
  it("a lot id resolver replaces lotKey and picks and disposals use the resolved ids", () => {
    const r = buildLots({
      accountId: A,
      lotMethod: "specific",
      txns: [buy("b1", "2025-01-01", "X", "5", "10", -5000n), buy("b2", "2025-02-01", "X", "5", "20", -10000n), sell("s1", "2025-03-01", "X", "2", "30", 6000n)],
      lotPicks: [{ sellTxnId: "s1", lotId: "uuid-b2", quantity: f("2"), position: 0 }],
      lotId: (openedByTxnId, ordinal) => `uuid-${openedByTxnId}${ordinal === 0 ? "" : `-${ordinal}`}`,
    });
    expect(r.lots.map((l) => l.id)).toEqual(["uuid-b1", "uuid-b2"]);
    expect(r.disposals.map((d) => [d.lotId, d.basisCents, d.gainCents])).toEqual([["uuid-b2", 4000n, 2000n]]);
    expect(lotKey("b1", 0)).toBe("b1");
    expect(lotKey("b1", 2)).toBe("b1:2");
  });
});

describe("TC7. transfer in without basis", () => {
  const rows = [transferIn("t1", "2026-02-01", "X", "40"), sell("s1", "2026-03-01", "X", "10", "62", 62000n)];
  it("opens an unknown-basis lot and routes its sale to the unknown bucket", () => {
    const r = build(rows);
    expect(lotById(r, "t1")).toMatchObject({ acquiredDate: "2026-02-01", costBasisCents: 0n, originalCostBasisCents: 0n, basisKnown: false, quantity: f("30") });
    expect(r.warnings).toEqual([{ code: "basis_unknown", txnId: "t1", securityId: "X", quantity: f("40") }]);
    expect(r.disposals).toEqual([
      { closeTxnId: "s1", lotId: "t1", accountId: A, securityId: "X", kind: "sell", date: "2026-03-01", acquiredDate: "2026-02-01", quantity: f("10"), proceedsCents: 62000n, basisCents: 0n, gainCents: 62000n, term: "unknown", basisKnown: false },
    ]);
    const realized = summarizeRealized(r.disposals, { from: "2026-01-01", to: "2026-12-31" });
    expect(realized.unknownBasis).toEqual({ proceedsCents: 62000n, quantity: f("10"), count: 1 });
    expect(realized.shortTerm.gainCents).toBe(0n);
    expect(realized.longTerm.gainCents).toBe(0n);
    expect(realized.washSalesApplied).toBe(false);
    const gains = summarizeGains(r.lots, r.disposals, () => f("62"));
    expect(gains).toMatchObject({ unknownBasisProceedsCents: 62000n, realizedCents: 0n, unrealizedCents: 0n, openValueCents: 186000n, openBasisCents: 0n, originalBasisCents: 0n, proceedsCents: 62000n });
    const holdings = holdingsAsOf(r.lots, "2026-03-02", () => quote("62", "2026-03-01"));
    expect(holdings).toEqual([
      { securityId: "X", quantity: f("30"), valueCents: 186000n, costBasisCents: null, unrealizedCents: null, unrealizedShortCents: 0n, unrealizedLongCents: 0n, unknownBasisQuantity: f("30"), lotCount: 1, price: f("62"), priceDate: "2026-03-01", priceSource: "provider", stale: false },
    ]);
    expect(valueLots(r.lots, "2026-03-02", () => quote("62", "2026-03-01"))).toEqual([{ lotId: "t1", valueCents: 186000n, unrealizedCents: null, term: "unknown", basisPerShare: null, priceDate: "2026-03-01", stale: false }]);
  });
});

describe("TC8. oversell", () => {
  it("floors the position at 0 and writes an unmatched_sell piece", () => {
    const r = build([buy("b1", "2026-01-05", "X", "20", "10", -20000n), sell("s1", "2026-03-01", "X", "30", "11", 33000n)]);
    expect(r.disposals).toEqual([
      { closeTxnId: "s1", lotId: "b1", accountId: A, securityId: "X", kind: "sell", date: "2026-03-01", acquiredDate: "2026-01-05", quantity: f("20"), proceedsCents: 22000n, basisCents: 20000n, gainCents: 2000n, term: "short", basisKnown: true },
      { closeTxnId: "s1", lotId: null, accountId: A, securityId: "X", kind: "unmatched_sell", date: "2026-03-01", acquiredDate: null, quantity: f("10"), proceedsCents: 11000n, basisCents: 0n, gainCents: 11000n, term: "unknown", basisKnown: false },
    ]);
    expect(r.warnings).toEqual([{ code: "oversell", txnId: "s1", securityId: "X", quantity: f("10"), date: "2026-03-01" }]);
    expect(lastPosition(r, "X")).toBe(0n);
    expect(lotById(r, "b1")).toMatchObject({ quantity: 0n, closedDate: "2026-03-01" });
  });
  it("an over-transfer keeps kind transfer_out with no lot and is not reported in transferredOut", () => {
    const r = build([buy("b1", "2026-01-05", "X", "20", "10", -20000n), transferOut("t1", "2026-03-01", "X", "25")]);
    expect(r.disposals.map((d) => [d.lotId, d.kind, d.quantity, d.term, d.basisKnown])).toEqual([
      ["b1", "transfer_out", f("20"), "none", true],
      [null, "transfer_out", f("5"), "none", false],
    ]);
    expect(r.transferredOut.map((t) => t.quantity)).toEqual([f("20")]);
    expect(codes(r)).toEqual(["oversell"]);
  });
});

describe("TC9. holding-period boundaries (Pub 550, Rev. Rul. 66-7)", () => {
  it("is long only after the clamped anniversary", () => {
    expect(isLongTerm("2025-02-05", "2026-02-05")).toBe(false);
    expect(isLongTerm("2025-02-05", "2026-02-06")).toBe(true);
    expect(isLongTerm("2024-02-29", "2025-02-28")).toBe(false);
    expect(isLongTerm("2024-02-29", "2025-03-01")).toBe(true);
    expect(isLongTerm("2025-01-31", "2026-01-31")).toBe(false);
    expect(isLongTerm("2025-01-31", "2026-02-01")).toBe(true);
    expect(isLongTerm("2025-03-03", "2026-04-01")).toBe(true); // TC2
    expect(isLongTerm("2025-03-31", "2026-02-02")).toBe(false); // TC5
    expect(isLongTerm("2025-01-15", "2026-01-15")).toBe(false); // TC30
  });
});

describe("TC10. income by month (re-derived: reinvest rows carry reinvestedCents only)", () => {
  const rows = [
    dividend("d1", "2026-03-25", "VTI", 4321n),
    dividend("d2a", "2026-03-27", "VXUS", 3000n, 0),
    reinvest("d2", "2026-03-27", "VXUS", "0.5", "60", -3000n, 1),
    interest("i1", "2026-03-31", 77n),
    dividend("d3", "2026-06-25", "VTI", 4400n),
    fee("f1", "2026-06-30", -1250n),
  ];
  it("groups by (month, security) with account-level rows first", () => {
    expect(incomeByMonth(rows)).toEqual([
      { month: "2026-03", securityId: null, dividendCents: 0n, interestCents: 77n, feeCents: 0n, reinvestedCents: 0n },
      { month: "2026-03", securityId: "VTI", dividendCents: 4321n, interestCents: 0n, feeCents: 0n, reinvestedCents: 0n },
      { month: "2026-03", securityId: "VXUS", dividendCents: 3000n, interestCents: 0n, feeCents: 0n, reinvestedCents: 3000n },
      { month: "2026-06", securityId: null, dividendCents: 0n, interestCents: 0n, feeCents: 1250n, reinvestedCents: 0n },
      { month: "2026-06", securityId: "VTI", dividendCents: 4400n, interestCents: 0n, feeCents: 0n, reinvestedCents: 0n },
    ]);
    expect(incomeByMonth([...rows].reverse())).toEqual(incomeByMonth(rows));
    const r = build(rows);
    expect(lotById(r, "d2")).toMatchObject({ openedBy: "reinvest", quantity: f("0.5"), costBasisCents: 3000n });
    expect(r.income).toEqual(incomeByMonth(rows));
  });
  it("a lone reinvest row is never income (plan decision 6); a security-level fee lands on the security; zero rows are omitted", () => {
    expect(incomeByMonth([reinvest("r", "2026-03-27", "VXUS", "0.5", "60", -3000n)])).toEqual([
      { month: "2026-03", securityId: "VXUS", dividendCents: 0n, interestCents: 0n, feeCents: 0n, reinvestedCents: 3000n },
    ]);
    expect(incomeByMonth([fee("f", "2026-03-27", -250n, "VXUS")])).toEqual([{ month: "2026-03", securityId: "VXUS", dividendCents: 0n, interestCents: 0n, feeCents: 250n, reinvestedCents: 0n }]);
    expect(incomeByMonth([dividend("d", "2026-03-27", "VXUS", 0n), buy("b", "2026-03-27", "VXUS", "1", "1", -100n)])).toEqual([]);
    // A reinvest without an amount resolves from quantity × price, as the lot does.
    expect(incomeByMonth([reinvest("r", "2026-01-21", "Y", "0.25", "55", null)])).toEqual([{ month: "2026-01", securityId: "Y", dividendCents: 0n, interestCents: 0n, feeCents: 0n, reinvestedCents: 1375n }]);
  });
});

describe("TC18. holdings and unrealized gains as of a date", () => {
  const rows = [buy("b1", "2025-03-03", "VTI", "100", "10", -100495n, 495n), buy("b2", "2026-05-10", "VTI", "50", "12", -60000n), transferIn("b3", "2026-02-01", "VXUS", "40")];
  const closes: Record<string, PriceQuote> = { VTI: quote("15.25", "2026-10-13"), VXUS: quote("62.5", "2026-10-13") };
  const priceAt = (id: string) => closes[id] ?? null;
  it("values each lot with its term and basis per share", () => {
    const r = build(rows);
    // Lots are in opening (stream) order: b1 2025-03-03, b3 2026-02-01, b2 2026-05-10.
    expect(valueLots(r.lots, "2026-10-14", priceAt)).toEqual([
      { lotId: "b1", valueCents: 152500n, unrealizedCents: 52005n, term: "long", basisPerShare: f("10.0495"), priceDate: "2026-10-13", stale: false },
      { lotId: "b3", valueCents: 250000n, unrealizedCents: null, term: "unknown", basisPerShare: null, priceDate: "2026-10-13", stale: false },
      { lotId: "b2", valueCents: 76250n, unrealizedCents: 16250n, term: "short", basisPerShare: f("12"), priceDate: "2026-10-13", stale: false },
    ]);
  });
  it("aggregates per security with the short/long split and the unknown-basis quantity", () => {
    const r = build(rows);
    expect(holdingsAsOf(r.lots, "2026-10-14", priceAt)).toEqual([
      { securityId: "VTI", quantity: f("150"), valueCents: 228750n, costBasisCents: 160495n, unrealizedCents: 68255n, unrealizedShortCents: 16250n, unrealizedLongCents: 52005n, unknownBasisQuantity: 0n, lotCount: 2, price: f("15.25"), priceDate: "2026-10-13", priceSource: "provider", stale: false },
      { securityId: "VXUS", quantity: f("40"), valueCents: 250000n, costBasisCents: null, unrealizedCents: null, unrealizedShortCents: 0n, unrealizedLongCents: 0n, unknownBasisQuantity: f("40"), lotCount: 1, price: f("62.5"), priceDate: "2026-10-13", priceSource: "provider", stale: false },
    ]);
    expect(summarizeGains(r.lots, r.disposals, (id) => closes[id]?.close ?? null)).toMatchObject({ unrealizedCents: 68255n, openValueCents: 478750n, openBasisCents: 160495n, originalBasisCents: 160495n, unpricedSecurityIds: [], realizedCents: 0n, totalGainCents: 68255n });
  });
  it("an unpriced security is listed and valued null; a closed lot carries nulls; staleness is the 7-day rule", () => {
    const r = build([...rows, sell("s1", "2026-06-01", "VTI", "150", "14", 210000n)]);
    const none = () => null;
    expect(summarizeGains(r.lots, r.disposals, none).unpricedSecurityIds).toEqual(["VXUS"]);
    expect(holdingsAsOf(r.lots, "2026-10-14", none)).toEqual([
      { securityId: "VXUS", quantity: f("40"), valueCents: null, costBasisCents: null, unrealizedCents: null, unrealizedShortCents: 0n, unrealizedLongCents: 0n, unknownBasisQuantity: f("40"), lotCount: 1, price: null, priceDate: null, priceSource: null, stale: false },
    ]);
    expect(valueLots(r.lots, "2026-10-14", priceAt).find((v) => v.lotId === "b1")).toEqual({ lotId: "b1", valueCents: null, unrealizedCents: null, term: "none", basisPerShare: null, priceDate: null, stale: false });
    const old = (id: string) => (id === "VTI" ? quote("15.25", "2026-10-06") : null);
    expect(holdingsAsOf(build(rows).lots, "2026-10-13", old)[0]?.stale).toBe(false);
    expect(holdingsAsOf(build(rows).lots, "2026-10-14", old)[0]?.stale).toBe(true);
    expect(isStalePrice("2026-01-02", "2026-01-09")).toBe(false);
    expect(isStalePrice("2026-01-02", "2026-01-10")).toBe(true);
  });
});

describe("TC20. determinism: input order, same-day sequencing, type rank and FIFO ties", () => {
  const rows = [sell("z-sell", "2026-01-05", "X", "5", "10", 5000n, 0n, 1), buy("a-buy", "2026-01-05", "X", "5", "9", -4500n, 0n, 0), buy("m-buy", "2026-01-04", "X", "1", "8", -800n, 0n, 7)];
  it("processes [m-buy, a-buy, z-sell] whatever the array order", () => {
    const r = build(rows);
    expect(r.positions.map((p) => p.id)).toEqual(["m-buy", "a-buy", "z-sell"]);
    expect(r.disposals.map((d) => [d.lotId, d.quantity, d.proceedsCents, d.basisCents, d.gainCents, d.term])).toEqual([
      ["m-buy", f("1"), 1000n, 800n, 200n, "short"],
      ["a-buy", f("4"), 4000n, 3600n, 400n, "short"],
    ]);
    expect(build([...rows].reverse())).toEqual(r);
  });
  it("rank beats sequence: a same-day buy precedes the sell even with a lower sell sequence", () => {
    const swapped = [sell("z-sell", "2026-01-05", "X", "5", "10", 5000n, 0n, 0), buy("a-buy", "2026-01-05", "X", "5", "9", -4500n, 0n, 1), rows[2]!];
    expect(build(swapped).disposals).toEqual(build(rows).disposals);
    expect(build(swapped).warnings).toEqual([]);
  });
  it("FIFO ties on the acquisition date break by opening order", () => {
    const r = build([buy("b", "2026-01-05", "X", "5", "9", -4500n, 0n, 0), buy("a", "2026-01-05", "X", "5", "10", -5000n, 0n, 1), sell("s", "2026-02-05", "X", "5", "11", 5500n)]);
    expect(r.disposals.map((d) => [d.lotId, d.gainCents])).toEqual([["b", 1000n]]);
  });
  it("same (date, rank, sequence) falls through to the id", () => {
    const r = build([buy("b", "2026-01-05", "X", "5", "9", -4500n), buy("a", "2026-01-05", "X", "5", "10", -5000n), sell("s", "2026-02-05", "X", "5", "11", 5500n)]);
    expect(r.positions.map((p) => p.id)).toEqual(["a", "b", "s"]);
    expect(r.disposals.map((d) => [d.lotId, d.gainCents])).toEqual([["a", 500n]]);
  });
});

describe("TC22. largest-remainder allocation (R4) as the engine uses it", () => {
  it("matches the design's table and always sums to the input", () => {
    expect(allocateLargestRemainder(179995n, [100n, 20n])).toEqual([149996n, 29999n]);
    expect(allocateLargestRemainder(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocateLargestRemainder(10n, [1n, 1n, 1n, 1n])).toEqual([3n, 3n, 2n, 2n]);
    expect(allocateLargestRemainder(0n, [3n, 7n])).toEqual([0n, 0n]);
    expect(allocateLargestRemainder(-179995n, [100n, 20n])).toEqual([-149996n, -29999n]);
    expect(allocateLargestRemainder(174900n, [20n, 5n])).toEqual([139920n, 34980n]);
    expect(() => allocateLargestRemainder(5n, [0n, 0n])).toThrow();
    for (const [total, weights] of [
      [179995n, [100n, 20n]],
      [7n, [1n, 2n, 3n, 4n]],
    ] as const) {
      expect(allocateLargestRemainder(total, weights).reduce((a, b) => a + b, 0n)).toBe(total);
    }
  });
  it("a three-lot sale splits proceeds to the cent", () => {
    const r = build([buy("a", "2026-01-01", "X", "1", "1", -100n), buy("b", "2026-01-02", "X", "1", "1", -100n), buy("c", "2026-01-03", "X", "1", "1", -100n), sell("s", "2026-02-01", "X", "3", "1", 100n)]);
    expect(r.disposals.map((d) => d.proceedsCents)).toEqual([34n, 33n, 33n]);
  });
});

describe("TC28. amount resolution: null amount, fee in basis, 5-cent tolerance (C3)", () => {
  it("derives a missing amount, flags a mismatch beyond 5 cents, accepts one within it", () => {
    const r = build([
      buy("b1", "2026-01-15", "X", "3.5", "101.33", null, 199n),
      buy("b2", "2026-01-16", "X", "1", "100", -10100n),
      sell("s1", "2026-01-20", "X", "1", "100", 9997n),
      reinvest("r1", "2026-01-21", "Y", "0.25", "55", null),
      buy("z1", "2026-01-01", "Z", "1", "10", -1000n),
      sell("s2", "2026-02-01", "Z", "1", null, null),
    ]);
    expect(r.cashEffects.find((c) => c.txnId === "b1")?.cents).toBe(-35665n);
    expect(lotById(r, "b1")).toMatchObject({ originalCostBasisCents: 35665n, quantity: f("2.5"), costBasisCents: 25475n });
    expect(lotById(r, "b2")).toMatchObject({ originalCostBasisCents: 10100n, quantity: f("1"), costBasisCents: 10100n });
    expect(r.disposals.filter((d) => d.closeTxnId === "s1")).toEqual([
      { closeTxnId: "s1", lotId: "b1", accountId: A, securityId: "X", kind: "sell", date: "2026-01-20", acquiredDate: "2026-01-15", quantity: f("1"), proceedsCents: 9997n, basisCents: 10190n, gainCents: -193n, term: "short", basisKnown: true },
    ]);
    // re-derived: the reinvest is a purchase of −(gross + fee) = −1375; the lot is unchanged, the income row is reinvested only.
    expect(lotById(r, "r1")).toMatchObject({ openedBy: "reinvest", quantity: f("0.25"), costBasisCents: 1375n });
    expect(r.cashEffects.find((c) => c.txnId === "r1")?.cents).toBe(-1375n);
    expect(r.income).toEqual([{ month: "2026-01", securityId: "Y", dividendCents: 0n, interestCents: 0n, feeCents: 0n, reinvestedCents: 1375n }]);
    expect(r.disposals.filter((d) => d.closeTxnId === "s2").map((d) => [d.proceedsCents, d.basisCents, d.gainCents, d.term])).toEqual([[0n, 1000n, -1000n, "short"]]);
    expect(r.cashEffects.find((c) => c.txnId === "s2")?.cents).toBe(0n);
    expect(r.warnings).toEqual([
      { code: "amount_mismatch", txnId: "b2", securityId: "X", diffCents: -100n },
      { code: "amount_missing", txnId: "s2", securityId: "Z" },
    ]);
  });
  it("a mismatch of exactly 5 cents passes and 6 cents does not; a fee-less null fee counts as 0", () => {
    expect(codes(build([buy("b", "2026-01-01", "X", "1", "100", -10005n, 0n)]))).toEqual([]);
    expect(codes(build([buy("b", "2026-01-01", "X", "1", "100", -10006n, 0n)]))).toEqual(["amount_mismatch"]);
    expect(codes(build([sell("s", "2026-01-01", "X", "1", "100", 9995n, null), buy("b", "2025-01-01", "X", "1", "1", -100n)]))).toEqual([]);
  });
  it("a buy recorded as a cash inflow is buy_amount_sign with the amount as basis", () => {
    const r = build([buy("b", "2026-01-01", "X", "1", "100", 10000n)]);
    expect(r.warnings).toEqual([{ code: "buy_amount_sign", txnId: "b", securityId: "X", diffCents: 10000n }]);
    expect(lotById(r, "b")).toMatchObject({ costBasisCents: 10000n });
    expect(r.cashEffects[0]?.cents).toBe(10000n);
  });
  it("a cash transfer in the txns is ignored with cash_transfer_in_txns; bad quantities are ignored", () => {
    const r = build([
      txn({ id: "c", type: "transfer", date: "2026-01-01", amountCents: 50000n }),
      buy("b0", "2026-01-02", "X", "0", "10", 0n),
      sell("s0", "2026-01-03", "X", "0", "10", 0n),
      txn({ id: "t0", type: "transfer", date: "2026-01-04", securityId: "X", quantity: 0n, amountCents: 0n }),
      txn({ id: "b-null", type: "buy", date: "2026-01-05", securityId: "X", quantity: null, amountCents: -100n }),
    ]);
    expect(r.warnings).toEqual([
      { code: "cash_transfer_in_txns", txnId: "c", date: "2026-01-01" },
      { code: "bad_quantity", txnId: "b0", securityId: "X", quantity: 0n },
      { code: "bad_quantity", txnId: "s0", securityId: "X", quantity: 0n },
      { code: "bad_quantity", txnId: "t0", securityId: "X", quantity: 0n },
      { code: "bad_quantity", txnId: "b-null", securityId: "X" },
    ]);
    expect(r.lots).toEqual([]);
    expect(r.positions).toHaveLength(5);
    expect(r.cashEffects).toEqual([]);
  });
});

describe("TC29. a same-day split listed after a same-day buy is still applied first", () => {
  it("orders [b1, sp, b2, s1] and leaves b2 unscaled", () => {
    const r = build([buy("b1", "2025-01-15", "A", "10", "300", -300000n), buy("b2", "2025-06-10", "A", "5", "150", -75000n, 0n, 0), split("sp", "2025-06-10", "A", 2, 1, 1), sell("s1", "2025-07-01", "A", "22", "160", 352000n)]);
    expect(r.positions.map((p) => [p.id, p.quantityBySecurity.get("A")])).toEqual([
      ["b1", f("10")],
      ["sp", f("20")],
      ["b2", f("25")],
      ["s1", f("3")],
    ]);
    expect(r.disposals.map((d) => [d.lotId, d.quantity, d.proceedsCents, d.basisCents, d.gainCents, d.term])).toEqual([
      ["b1", f("20"), 320000n, 300000n, 20000n, "short"],
      ["b2", f("2"), 32000n, 30000n, 2000n, "short"],
    ]);
    expect(lotById(r, "b1")).toMatchObject({ quantity: 0n, closedDate: "2025-07-01" });
    expect(lotById(r, "b2")).toMatchObject({ quantity: f("3"), costBasisCents: 45000n });
  });
});

describe("TC30. gain summary: realized + unrealized reconciles to the cent on a mixed history", () => {
  const rows = [
    buy("b1", "2025-01-15", "A", "10", "100", -100000n),
    buy("b2", "2025-06-15", "A", "10", "120", -120000n),
    dividend("r0", "2025-09-15", "A", 6250n, 0),
    reinvest("r1", "2025-09-15", "A", "0.5", "125", -6250n, 1), // re-derived: the two-row convention
    split("sp", "2025-10-01", "A", 2, 1),
    sell("s1", "2026-01-15", "A", "25", "70", 174900n, 100n),
    transferOut("t1", "2026-02-01", "A", "6", "72"),
  ];
  it("matches the worked numbers and both invariants", () => {
    const r = build(rows);
    expect(r.warnings).toEqual([]);
    expect(r.disposals.map((d) => [d.lotId, d.kind, d.quantity, d.proceedsCents, d.basisCents, d.gainCents, d.term])).toEqual([
      ["b1", "sell", f("20"), 139920n, 100000n, 39920n, "short"],
      ["b2", "sell", f("5"), 34980n, 30000n, 4980n, "short"],
      ["b2", "transfer_out", f("6"), 0n, 36000n, 0n, "none"],
    ]);
    expect(lotById(r, "b1")).toMatchObject({ quantity: 0n, closedDate: "2026-01-15" });
    expect(lotById(r, "b2")).toMatchObject({ quantity: f("9"), costBasisCents: 54000n });
    expect(lotById(r, "r1")).toMatchObject({ quantity: f("1"), costBasisCents: 6250n });
    const s = summarizeGains(r.lots, r.disposals, () => f("75"));
    expect(s).toEqual({
      realizedShortCents: 44900n,
      realizedLongCents: 0n,
      realizedCents: 44900n,
      unknownBasisProceedsCents: 0n,
      unrealizedCents: 14750n,
      totalGainCents: 59650n,
      proceedsCents: 174900n,
      basisConsumedCents: 130000n,
      transferredOutBasisCents: 36000n,
      openValueCents: 75000n,
      openBasisCents: 60250n,
      originalBasisCents: 226250n,
      unpricedSecurityIds: [],
    });
    expect(s.openValueCents + s.proceedsCents + s.transferredOutBasisCents - s.originalBasisCents).toBe(59650n);
    expect(s.openBasisCents + s.basisConsumedCents + s.transferredOutBasisCents).toBe(226250n);
    expect(r.income).toEqual([{ month: "2025-09", securityId: "A", dividendCents: 6250n, interestCents: 0n, feeCents: 0n, reinvestedCents: 6250n }]);
  });
  it("the realized summary over (from, to] buckets sales by term and transfers out apart", () => {
    const r = build(rows);
    expect(summarizeRealized(r.disposals, { from: "2025-12-31", to: "2026-12-31" })).toEqual({
      shortTerm: { proceedsCents: 174900n, basisCents: 130000n, gainCents: 44900n, count: 2 },
      longTerm: { proceedsCents: 0n, basisCents: 0n, gainCents: 0n, count: 0 },
      unknownBasis: { proceedsCents: 0n, quantity: 0n, count: 0 },
      transfersOut: { quantity: f("6"), basisCents: 36000n },
      washSalesApplied: false,
    });
    // `from` is exclusive, `to` inclusive.
    expect(summarizeRealized(r.disposals, { from: "2026-01-15", to: "2026-02-01" }).shortTerm.count).toBe(0);
    expect(summarizeRealized(r.disposals, { from: "2026-01-14", to: "2026-01-15" }).shortTerm.count).toBe(2);
    const long = build([buy("b", "2024-01-01", "A", "1", "1", -100n), sell("s", "2026-01-01", "A", "1", "2", 200n)]);
    expect(summarizeRealized(long.disposals, { from: "2025-12-31", to: "2026-12-31" }).longTerm).toEqual({ proceedsCents: 200n, basisCents: 100n, gainCents: 100n, count: 1 });
  });
});

describe("TC31. position check against the latest statement (plan decision 7 skips)", () => {
  const r = build([buy("v", "2026-01-10", "VTI", "60", "10", -60000n), buy("b", "2026-02-10", "BND", "10.0005", "10", -10001n), buy("c", "2026-03-01", "CASH", "100", "1", -10000n)]);
  it("flags only differences beyond 0.001 shares, on either side", () => {
    expect(checkPositions(r.positions, { date: "2026-09-30", quantities: new Map([["VTI", f("100")], ["BND", f("10")], ["CASH", f("100")]]) })).toEqual([
      { code: "position_mismatch", securityId: "VTI", lotsQuantity: f("60"), snapshotQuantity: f("100"), date: "2026-09-30" },
    ]);
    expect(checkPositions(r.positions, { date: "2026-09-30", quantities: new Map([["VTI", f("60")], ["BND", f("10.002")], ["VXUS", f("5")], ["CASH", f("100")]]) })).toEqual([
      { code: "position_mismatch", securityId: "BND", lotsQuantity: f("10.0005"), snapshotQuantity: f("10.002"), date: "2026-09-30" },
      { code: "position_mismatch", securityId: "VXUS", lotsQuantity: 0n, snapshotQuantity: f("5"), date: "2026-09-30" },
    ]);
    expect(POSITION_TOLERANCE).toBe(f("0.001"));
  });
  it("skips the cash security, cash-class funds and dollar-only rows", () => {
    const warnings = checkPositions(r.positions, {
      date: "2026-09-30",
      quantities: new Map([
        ["VTI", f("60")],
        ["BND", f("10.0005")],
        ["CASH", f("12345.67")],
        ["SPAXX", f("999")],
        ["TRUST", null],
      ]),
      skipSecurityIds: new Set(["CASH", "SPAXX"]),
    });
    expect(warnings).toEqual([]);
  });
  it("compares the lots' position on the statement date, not today's", () => {
    const sold = build([buy("v", "2026-01-10", "VTI", "60", "10", -60000n), sell("s", "2026-10-05", "VTI", "60", "10", 60000n)]);
    expect(checkPositions(sold.positions, { date: "2026-09-30", quantities: new Map([["VTI", f("60")]]) })).toEqual([]);
    expect(checkPositions(sold.positions, { date: "2026-10-05", quantities: new Map([["VTI", f("60")]]) })).toHaveLength(1);
    expect(checkPositions(sold.positions, { date: "2025-12-31", quantities: new Map([["VTI", f("60")]]) })).toEqual([
      { code: "position_mismatch", securityId: "VTI", lotsQuantity: 0n, snapshotQuantity: f("60"), date: "2025-12-31" },
    ]);
    expect(quantityAt(sold.positions, "2025-12-31").size).toBe(0);
    expect(quantityAt(sold.positions, "2026-01-10").get("VTI")).toBe(f("60"));
    expect(quantityAt(sold.positions, "2026-10-04").get("VTI")).toBe(f("60"));
    expect(quantityAt(sold.positions, "2026-10-05").get("VTI")).toBe(0n);
  });
});

// ---- TC34. Property-based invariants (seeded 32-bit LCG, no library) ----

function makeRng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const big = (lo: bigint, hi: bigint): bigint => {
    const span = hi - lo + 1n;
    const r = (BigInt(Math.floor(next() * 67108864)) << 26n) | BigInt(Math.floor(next() * 67108864));
    return lo + (r % span);
  };
  const pick = <T>(arr: readonly T[]): T => arr[int(0, arr.length - 1)]!;
  const shuffle = <T>(arr: readonly T[]): T[] => {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  return { next, int, big, pick, shuffle };
}

const SPLITS: ReadonlyArray<[number, number]> = [
  [1, 2],
  [2, 1],
  [1, 3],
  [3, 2],
  [1, 10],
];
const WEIGHTED_TYPES: ReadonlyArray<[string, number]> = [
  ["buy", 30],
  ["sell", 20],
  ["reinvest", 10],
  ["dividend", 10],
  ["interest", 5],
  ["fee", 5],
  ["split", 7],
  ["transferIn", 8],
  ["transferOut", 5],
];

interface History {
  txns: InvestmentTxnInput[];
  picks: EngineLotPick[];
  lotMethod: LotMethod;
  closes: Map<string, Fixed8>;
}

/** Builds the history row by row, bounding sells and transfers out by the engine's own position so far. */
function genHistory(seed: number): History {
  const rng = makeRng(seed);
  const securities = ["S1", "S2", "S3"].slice(0, rng.int(1, 3));
  const lotMethod: LotMethod = rng.next() < 0.5 ? "fifo" : "specific";
  const n = rng.int(1, 60);
  const txns: InvestmentTxnInput[] = [];
  const picks: EngineLotPick[] = [];
  const weightTotal = WEIGHTED_TYPES.reduce((a, [, w]) => a + w, 0);
  const chooseType = () => {
    let roll = rng.next() * weightTotal;
    for (const [t, w] of WEIGHTED_TYPES) {
      roll -= w;
      if (roll < 0) return t;
    }
    return "buy";
  };
  const roundedQty = (lo: bigint, hi: bigint) => {
    const raw = rng.big(lo, hi);
    const unit = 10n ** BigInt(rng.int(0, 8));
    const q = raw - (raw % unit);
    return q < lo ? lo : q;
  };
  const qty = () => roundedQty(100_000n, 50_000_000_000n); // 0.001–500
  const price = () => roundedQty(50_000_000n, 90_000_000_000n); // 0.5–900
  let date: IsoDate = "2024-01-05";
  let prevRank = 0;
  let i = 0;
  const nextId = () => `t${String(i++).padStart(3, "0")}`;
  const place = (row: InvestmentTxnInput): InvestmentTxnInput => {
    let gap = rng.int(0, 40);
    if (gap === 0 && txnRank(row) < prevRank) gap = 1;
    date = addDays(date, gap);
    prevRank = gap === 0 ? Math.max(prevRank, txnRank(row)) : txnRank(row);
    return { ...row, date, sequence: row.sequence };
  };
  while (txns.length < n) {
    const state = buildLots({ accountId: A, lotMethod, txns, lotPicks: picks });
    const pos = state.positions[state.positions.length - 1]?.quantityBySecurity ?? new Map<string, Fixed8>();
    const sec = rng.pick(securities);
    const held = pos.get(sec) ?? 0n;
    let type = chooseType();
    if ((type === "sell" || type === "transferOut") && held <= 0n) type = "buy";
    const seq = i;
    switch (type) {
      case "buy": {
        const q = qty();
        const p = price();
        const feeCents = BigInt(rng.int(0, 999));
        const amount = -(mulToCents(q, p) + feeCents);
        txns.push(place(txn({ id: nextId(), type: "buy", date, sequence: seq, securityId: sec, quantity: q, price: p, amountCents: rng.next() < 0.7 ? amount : null, feeCents })));
        break;
      }
      case "sell":
      case "transferOut": {
        const q = held <= 1_000_000n || rng.next() < 0.2 ? held : rng.big(1n, held - 1_000_000n);
        const id = nextId();
        if (type === "sell") {
          const p = price();
          const gross = mulToCents(q, p);
          const feeCents = gross === 0n ? 0n : rng.big(0n, gross < 999n ? gross : 999n);
          txns.push(place(txn({ id, type: "sell", date, sequence: seq, securityId: sec, quantity: -q, price: p, amountCents: gross - feeCents, feeCents })));
        } else {
          txns.push(place(txn({ id, type: "transfer", date, sequence: seq, securityId: sec, quantity: -q, amountCents: 0n, price: rng.next() < 0.5 ? price() : null })));
        }
        if (rng.next() < 0.1) {
          const open = rng.shuffle(state.lots.filter((l) => l.securityId === sec && l.quantity > 0n)).slice(0, rng.int(1, 2));
          let remaining = q;
          open.forEach((lot, position) => {
            if (remaining <= 0n) return;
            const cap = lot.quantity < remaining ? lot.quantity : remaining;
            const pq = rng.big(1n, cap);
            picks.push({ sellTxnId: id, lotId: lot.id, quantity: pq, position });
            remaining -= pq;
          });
        }
        break;
      }
      case "reinvest": {
        const q = qty();
        const p = price();
        const x = mulToCents(q, p);
        const first = place(txn({ id: nextId(), type: "reinvest", date, sequence: seq, securityId: sec, quantity: q, price: p, amountCents: -x, feeCents: 0n }));
        txns.push(first);
        txns.push(txn({ id: nextId(), type: "dividend", date: first.date, sequence: seq + 1, securityId: sec, amountCents: x }));
        prevRank = 4;
        break;
      }
      case "dividend":
        txns.push(place(txn({ id: nextId(), type: "dividend", date, sequence: seq, securityId: sec, amountCents: BigInt(rng.int(1, 100000)) })));
        break;
      case "interest":
        txns.push(place(txn({ id: nextId(), type: "interest", date, sequence: seq, amountCents: BigInt(rng.int(1, 10000)) })));
        break;
      case "fee":
        txns.push(place(txn({ id: nextId(), type: "fee", date, sequence: seq, securityId: rng.next() < 0.5 ? sec : null, amountCents: -BigInt(rng.int(1, 5000)) })));
        break;
      case "split": {
        let [num, den] = rng.pick(SPLITS);
        // A reverse split of a lot below one share could round it to 0 shares and strand its basis; keep such lots whole.
        if (num < den && state.lots.some((l) => l.securityId === sec && l.quantity > 0n && l.quantity < 100_000_000n)) [num, den] = [2, 1];
        txns.push(place(txn({ id: nextId(), type: "split", date, sequence: seq, securityId: sec, splitNum: num, splitDen: den, amountCents: 0n })));
        break;
      }
      case "transferIn": {
        const q = qty();
        const basis = rng.big(0n, mulToCents(q, price()));
        const acquired = addDays(date, -rng.int(1, 1000));
        txns.push(place(txn({ id: nextId(), type: "transfer", date, sequence: seq, securityId: sec, quantity: q, amountCents: 0n, costBasisCents: basis, acquiredDate: acquired, price: rng.next() < 0.5 ? price() : null })));
        break;
      }
    }
  }
  const closes = new Map(securities.map((s) => [s, price()] as const));
  return { txns, picks, lotMethod, closes };
}

/** Σ(ins) − Σ(outs) per security with the split applied to the aggregate (differs from the per-lot R5 sum by ≤ 10⁻⁸ per lot). */
function referencePositions(txns: readonly InvestmentTxnInput[]): Map<string, Fixed8> {
  const ref = new Map<string, Fixed8>();
  for (const t of sortInvestmentTxns(txns)) {
    if (t.securityId === null) continue;
    if (t.type === "split") ref.set(t.securityId, scaleQty(ref.get(t.securityId) ?? 0n, t.splitNum!, t.splitDen!));
    else if (t.quantity !== null && (t.type === "buy" || t.type === "sell" || t.type === "reinvest" || t.type === "transfer")) {
      ref.set(t.securityId, (ref.get(t.securityId) ?? 0n) + t.quantity);
    }
  }
  return ref;
}

describe("TC34. property-based invariants over 500 seeded histories", () => {
  const ALLOWED: ReadonlySet<EngineWarningCode> = new Set(["needs_lot_pick"]);
  it("lots sum to the position, basis is conserved, gains reconcile, no warnings, order independent", () => {
    const baseSeed = 20261014;
    for (let k = 0; k < 500; k++) {
      const seed = (baseSeed + k * 7919) >>> 0;
      const h = genHistory(seed);
      const rng = makeRng(seed ^ 0x5bd1e995);
      try {
        const r = buildLots({ accountId: A, lotMethod: h.lotMethod, txns: h.txns, lotPicks: h.picks });
        // (4) no data warnings; no negative quantity or basis
        for (const w of r.warnings) expect(ALLOWED.has(w.code), `warning ${w.code} on ${w.txnId ?? "?"}`).toBe(true);
        for (const lot of r.lots) {
          expect(lot.quantity >= 0n && lot.costBasisCents >= 0n, `lot ${lot.id} negative`).toBe(true);
          expect(lot.basisKnown).toBe(true);
          expect(lot.quantity === 0n ? lot.closedDate !== null : lot.closedDate === null, `lot ${lot.id} closed state`).toBe(true);
        }
        for (const d of r.disposals) expect(d.quantity > 0n && d.kind !== "unmatched_sell" && d.basisKnown, `disposal ${d.closeTxnId}`).toBe(true);
        // (1) Σ open lot quantity = last checkpoint = Σ ins − Σ outs, split-adjusted (R5 per lot, no residual fix → 0.001-share tolerance)
        const last = r.positions[r.positions.length - 1]!.quantityBySecurity;
        const ref = referencePositions(h.txns);
        const securities = new Set([...last.keys(), ...ref.keys()]);
        for (const sec of securities) {
          const open = r.lots.filter((l) => l.securityId === sec).reduce((a, l) => a + l.quantity, 0n);
          expect(open, `position ${sec}`).toBe(last.get(sec) ?? 0n);
          const diff = open - (ref.get(sec) ?? 0n);
          expect(diff <= POSITION_TOLERANCE && diff >= -POSITION_TOLERANCE, `reference position ${sec}: ${formatFixed8(diff)}`).toBe(true);
        }
        // (2) Σ open basis + Σ consumed basis = Σ original basis, per security and overall
        for (const sec of securities) {
          const open = r.lots.filter((l) => l.securityId === sec).reduce((a, l) => a + l.costBasisCents, 0n);
          const consumed = r.disposals.filter((d) => d.securityId === sec).reduce((a, d) => a + d.basisCents, 0n);
          const original = r.lots.filter((l) => l.securityId === sec).reduce((a, l) => a + l.originalCostBasisCents, 0n);
          expect(open + consumed, `basis conservation ${sec}`).toBe(original);
        }
        // (3) realized + unrealized = openValue + proceeds + transferredOutBasis − originalBasis, exactly
        const s = summarizeGains(r.lots, r.disposals, (id) => h.closes.get(id) ?? null);
        expect(s.unpricedSecurityIds).toEqual([]);
        expect(s.realizedCents + s.unrealizedCents, "gain identity").toBe(s.openValueCents + s.proceedsCents + s.transferredOutBasisCents - s.originalBasisCents);
        expect(s.openBasisCents + s.basisConsumedCents + s.transferredOutBasisCents, "basis identity").toBe(s.originalBasisCents);
        expect(s.totalGainCents).toBe(s.realizedCents + s.unrealizedCents);
        // transferred-out pieces are exactly the transfer_out disposals with a lot
        expect(r.transferredOut.reduce((a, t) => a + t.basisCents, 0n)).toBe(s.transferredOutBasisCents);
        // (5) any permutation of the input (and of the picks) gives a deep-equal result
        const shuffled = buildLots({ accountId: A, lotMethod: h.lotMethod, txns: rng.shuffle(h.txns), lotPicks: rng.shuffle(h.picks) });
        expect(shuffled).toEqual(r);
        // income is the same pure function on the stream
        expect(r.income).toEqual(incomeByMonth(h.txns));
        expect(r.positions).toHaveLength(h.txns.length);
      } catch (err) {
        throw new Error(`TC34 failed for seed ${seed} (${h.txns.length} txns, ${h.lotMethod}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
  it("the generator exercises every row type, picks and both methods", () => {
    const seen = new Set<string>();
    let picks = 0;
    const methods = new Set<LotMethod>();
    for (let k = 0; k < 60; k++) {
      const h = genHistory((20261014 + k * 7919) >>> 0);
      for (const t of h.txns) seen.add(t.type === "transfer" ? `transfer_${t.quantity! > 0n ? "in" : "out"}` : t.type);
      picks += h.picks.length;
      methods.add(h.lotMethod);
    }
    expect([...seen].sort()).toEqual(["buy", "dividend", "fee", "interest", "reinvest", "sell", "split", "transfer_in", "transfer_out"]);
    expect(picks).toBeGreaterThan(0);
    expect(methods.size).toBe(2);
  });
});
