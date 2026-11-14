import { describe, expect, it } from "vitest";
import { parseFixed8 } from "./decimal.js";
import { modifiedDietz, trueTwr } from "./performance.js";
import { batchUndo, entityRevert, planCellUndoEdits, type UndoableEntry } from "./planHistory.js";
import { priceStatusOf, valueAccountOn, type ValuationInput, type ValuationSecurity } from "./valuation.js";

/**
 * Audit batch b9-conformance-plan-investments: the pure-engine findings
 * (docs/audit/phases-1-3/b9-conformance-plan-investments.md). Hand figures in the comments.
 */

const f = parseFixed8;
const A = "acct-brokerage";
const VTI = "sec-vti";
const BND = "sec-bnd";

const SECURITIES: ValuationSecurity[] = [
  { id: VTI, ticker: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf", assetClass: "us_stock", priceMode: "provider" },
  { id: BND, ticker: "BND", name: "Vanguard Total Bond Market ETF", type: "etf", assetClass: "bonds", priceMode: "provider" },
];

describe("b9-08: no price provider means no price is 'behind'", () => {
  // A statement on Thu 2026-11-12 (VTI 10 @ 280.00, BND 20 @ 72.50 = 4,250.00, balance 4,250.00) and its implied
  // rows, viewed on Fri 11-13 with the expected close 11-13: one trading day after the statement.
  const input = (priceFeed?: boolean): ValuationInput => ({
    expectedThrough: "2026-11-13",
    ...(priceFeed === undefined ? {} : { priceFeed }),
    accounts: [{ id: A, name: "Brokerage", type: "brokerage", taxTreatment: "taxable", fidelity: "positions", cashInference: "auto" }],
    securities: SECURITIES,
    prices: [
      { securityId: VTI, date: "2026-11-12", close: f("280"), source: "implied" },
      { securityId: BND, date: "2026-11-12", close: f("72.5"), source: "implied" },
    ],
    snapshots: [
      { accountId: A, securityId: VTI, date: "2026-11-12", quantity: f("10"), price: f("280"), valueCents: 280_000n },
      { accountId: A, securityId: BND, date: "2026-11-12", quantity: f("20"), price: f("72.5"), valueCents: 145_000n },
    ],
    balances: [{ accountId: A, date: "2026-11-12", balanceCents: 425_000n, source: "csv" }],
    flows: [],
    tradePositions: [],
  });

  it("with a provider configured (the default), a statement price a day old is one trading day behind", () => {
    const v = valueAccountOn(input(), A, "2026-11-13");
    expect(v.valueCents).toBe(425_000n);
    expect(v.priceStatus).toBe("stale");
    expect(v.stalest).toMatchObject({ priceDate: "2026-11-12", tradingDaysBehind: 1 });
    expect(v.lines.find((l) => l.securityId === VTI)).toMatchObject({ priceStatus: "stale", tradingDaysBehind: 1 });
  });

  it("without one, the statement's price is the expected source: implied, not stale, and the value is unchanged", () => {
    const v = valueAccountOn(input(false), A, "2026-11-13");
    expect(v.valueCents).toBe(425_000n);
    expect(v.priceStatus).toBe("implied");
    expect(v.stalest).toBeNull();
    for (const id of [VTI, BND]) expect(v.lines.find((l) => l.securityId === id)).toMatchObject({ priceStatus: "implied", tradingDaysBehind: 0, priceDate: "2026-11-12" });
  });

  it("priceStatusOf: a provider-mode price behind the expected close without a feed reports its source; cash, missing and the other modes are unchanged", () => {
    const vti = SECURITIES[0]!;
    expect(priceStatusOf(vti, "2026-11-12", "2026-11-13", "2026-11-13", "missing", undefined, false)).toEqual({ priceStatus: "implied", tradingDaysBehind: 0 });
    expect(priceStatusOf(vti, "2026-11-12", "2026-11-13", "2026-11-13", "missing", undefined, false, "implied")).toEqual({ priceStatus: "implied", tradingDaysBehind: 0 });
    expect(priceStatusOf(vti, "2026-11-12", "2026-11-13", "2026-11-13", "missing", undefined, false, "txn")).toEqual({ priceStatus: "implied", tradingDaysBehind: 0 });
    expect(priceStatusOf(vti, "2026-11-12", "2026-11-13", "2026-11-13", "missing", undefined, false, "manual")).toEqual({ priceStatus: "manual", tradingDaysBehind: 0 });
    // A close on the expected date is current with or without a feed (an old feed's row, or a statement dated that day).
    expect(priceStatusOf(vti, "2026-11-13", "2026-11-13", "2026-11-13", "missing", undefined, false, "provider")).toEqual({ priceStatus: "current", tradingDaysBehind: 0 });
    expect(priceStatusOf(vti, "2026-11-13", "2026-11-13", "2026-11-13", "missing", undefined, false, "implied")).toEqual({ priceStatus: "current", tradingDaysBehind: 0 });
    expect(priceStatusOf(vti, "2026-11-12", "2026-11-13", "2026-11-13", "missing", undefined, true)).toEqual({ priceStatus: "stale", tradingDaysBehind: 1 });
    expect(priceStatusOf(vti, "2026-11-12", "2026-11-13", "2026-11-13", "missing", undefined, true, "implied")).toEqual({ priceStatus: "stale", tradingDaysBehind: 1 });
    expect(priceStatusOf(vti, null, "2026-11-13", "2026-11-13", "missing", undefined, false)).toEqual({ priceStatus: "missing", tradingDaysBehind: 0 });
    expect(priceStatusOf({ type: "cash", priceMode: "provider" }, "2026-11-12", "2026-11-13", "2026-11-13", "missing", undefined, false)).toEqual({ priceStatus: "cash", tradingDaysBehind: 0 });
    expect(priceStatusOf({ type: "fund", priceMode: "manual" }, "2026-11-12", "2026-11-13", "2026-11-13", "missing", undefined, false)).toEqual({ priceStatus: "manual", tradingDaysBehind: 0 });
  });
});

describe("b9-06: a return is annualized over the time the account was invested, not the request's range", () => {
  // A 1-year request (2025-11-13 to 2026-11-13). The Roth enters on 2026-10-13 at 8,850.00 (its opening value, a
  // contribution at the start of that day) and is worth 9,200.00 on 11-13: 9,200 / 8,850 − 1 = 0.039548…, held from
  // the 10-12 close: 32 days, under a year, so not annualized (D21).
  const from = "2025-11-13";
  const to = "2026-11-13";
  const entry = [{ date: "2026-10-13", amountCents: 885_000n }];
  const value = (d: string): bigint => (d < "2026-10-13" ? 0n : d < "2026-11-13" ? 885_000n : 920_000n);

  it("true TWR: an account that entered 32 days before `to` has a period rate and no annualized rate", () => {
    const r = trueTwr(from, to, entry, value);
    expect(r.rate).toBeCloseTo(920_000 / 885_000 - 1, 12);
    expect(r.annualized).toBeNull();
    expect(r.subPeriods.map((sp) => [sp.from, sp.to, sp.skipped])).toEqual([
      ["2025-11-13", "2026-10-12", true],
      ["2026-10-12", "2026-11-13", false],
    ]);
  });

  it("Modified Dietz (a positions or balance-only account): the same rule", () => {
    const r = modifiedDietz(from, to, entry, [
      { date: "2026-10-13", valueCents: 885_000n },
      { date: "2026-11-13", valueCents: 920_000n },
    ]);
    expect(r.rate).toBeCloseTo(920_000 / 885_000 - 1, 12);
    expect(r.annualized).toBeNull();
  });

  it("an account valued at `from` is annualized over the whole range, as before", () => {
    // 10,000.00 on 2025-11-13 to 11,020.00 on 2026-11-13, no flows: 365 days, the annualized rate is the rate itself.
    const r = trueTwr(from, to, [], (d) => (d < to ? 1_000_000n : 1_102_000n));
    expect(r.rate).toBeCloseTo(0.102, 12);
    expect(r.annualized).toBe(r.rate);
    const d = modifiedDietz(from, to, [], [
      { date: from, valueCents: 1_000_000n },
      { date: to, valueCents: 1_102_000n },
    ]);
    expect(d.annualized).toBe(d.rate);
  });

  it("an account that entered at the start of 2025-11-14 has held 365 days by the 2026-11-13 close: annualized", () => {
    const r = trueTwr("2025-11-01", to, [{ date: "2025-11-14", amountCents: 1_000_000n }], (d) => (d < "2025-11-14" ? 0n : d < to ? 1_000_000n : 1_050_000n));
    expect(r.rate).toBeCloseTo(0.05, 12);
    expect(r.annualized).toBe(r.rate);
    const longer = trueTwr("2025-11-01", to, [{ date: "2025-11-15", amountCents: 1_000_000n }], (d) => (d < "2025-11-15" ? 0n : d < to ? 1_000_000n : 1_050_000n));
    expect(longer.annualized).toBeNull();
  });
});

describe("b9-03: undoing a batch of the plan's history", () => {
  const CAT = "11111111-1111-4111-8111-111111111111";
  const GOAL = "22222222-2222-4222-8222-222222222222";
  const REC = "33333333-3333-4333-8333-333333333333";
  let n = 0;
  const entry = (over: Partial<UndoableEntry>): UndoableEntry => ({
    id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    at: `2026-11-13T10:00:${String(n).padStart(2, "0")}.000Z`,
    batchId: "b",
    entity: "month_plan",
    entityId: `2026-11:${CAT}`,
    action: "update",
    before: null,
    after: null,
    ...over,
  });
  const cell = (plannedCents: string | null, source: string | null, extra: Record<string, unknown> = {}) => ({ plannedCents, source, rolloverMode: null, carriedInOverrideCents: null, note: null, ...extra });

  it("a cell changed twice in one batch goes back to its state before the first change; a created cell is cleared", () => {
    // Newest first, as GET /audit lists them.
    const entries = [
      entry({ at: "2026-11-13T10:00:03.000Z", entityId: `2026-12:${CAT}`, action: "create", before: null, after: cell("25000", "manual") }),
      entry({ at: "2026-11-13T10:00:02.000Z", action: "update", before: cell("30000", "manual"), after: cell("25000", "manual") }),
      entry({ at: "2026-11-13T10:00:01.000Z", action: "update", before: cell("12000", "average", { note: "car" }), after: cell("30000", "manual", { note: "car" }) }),
    ];
    expect(planCellUndoEdits(entries)).toEqual([
      { month: "2026-11", categoryId: CAT, plannedCents: "12000", source: "average", rolloverMode: null, carriedInOverrideCents: null, note: "car" },
      { month: "2026-12", categoryId: CAT, plannedCents: null, source: "manual", rolloverMode: null, carriedInOverrideCents: null, note: null },
    ]);
  });

  it("a frozen recurring value comes back as a typed amount; a rollover pin and a deleted row come back whole", () => {
    expect(planCellUndoEdits([entry({ action: "update", before: cell("1549", "recurring"), after: cell("1700", "manual") })])[0]).toMatchObject({ plannedCents: "1549", source: "manual" });
    expect(planCellUndoEdits([entry({ action: "delete", before: cell(null, null, { rolloverMode: "surplus_only" }), after: null })])[0]).toMatchObject({ plannedCents: null, rolloverMode: "surplus_only" });
  });

  it("an updated goal, setting, category or recurring item is put back through its PATCH with the changed fields only", () => {
    const goal = entry({ entity: "savings_goal", entityId: GOAL, before: { id: GOAL, name: "Fund", monthlyContributionCents: "50000", status: "active" }, after: { id: GOAL, name: "Fund", monthlyContributionCents: "40000", status: "active" } });
    expect(entityRevert(goal)).toEqual({ ok: true, request: { method: "PATCH", url: `/goals/${GOAL}`, body: { monthlyContributionCents: "50000" } } });
    const rollover = entry({ entity: "category", entityId: CAT, before: { id: CAT, name: "Dining", rolloverMode: "none", rolloverFromMonth: null, position: 2 }, after: { id: CAT, name: "Dining", rolloverMode: "surplus_only", rolloverFromMonth: "2026-11", position: 2 } });
    expect(entityRevert(rollover)).toEqual({ ok: true, request: { method: "PATCH", url: `/categories/${CAT}`, body: { rolloverMode: "none", rolloverFromMonth: null } } });
    const pause = entry({ entity: "recurring", entityId: REC, before: { id: REC, status: "active", statusReason: null }, after: { id: REC, status: "paused", statusReason: null } });
    expect(entityRevert(pause)).toEqual({ ok: true, request: { method: "PATCH", url: `/recurring/${REC}`, body: { status: "active" } } });
  });

  it("what cannot be put back from the history says why, and blocks its whole batch", () => {
    expect(entityRevert(entry({ entity: "category", entityId: CAT, action: "create", before: null, after: { id: CAT, name: "Coffee" } }))).toEqual({ ok: false, reason: "a new item is removed on its own page" });
    expect(entityRevert(entry({ entity: "category", entityId: CAT, before: { id: CAT, position: 1 }, after: { id: CAT, position: 2 } }))).toMatchObject({ ok: false, reason: expect.stringMatching(/Manage categories/) });
    expect(entityRevert(entry({ entity: "recurring", entityId: REC, before: { id: REC, status: "suggested" }, after: { id: REC, status: "active" } }))).toMatchObject({ ok: false, reason: expect.stringMatching(/Recurring page/) });
    expect(entityRevert(entry({ entity: "rule", entityId: CAT }))).toMatchObject({ ok: false });
    const mixed = batchUndo([
      entry({ entity: "category", entityId: CAT, action: "delete", before: { id: CAT, name: "Old" }, after: null }),
      entry({ action: "delete", before: cell("5000", "manual"), after: null }),
    ]);
    expect(mixed.blocked).toEqual(["a deleted item is created again on its own page"]);
  });

  it("an entity changed twice in one batch is reverted newest change first, so it ends at its first before", () => {
    const first = entry({ at: "2026-11-13T10:00:01.000Z", entity: "savings_goal", entityId: GOAL, before: { monthlyContributionCents: "10000" }, after: { monthlyContributionCents: "20000" } });
    const second = entry({ at: "2026-11-13T10:00:02.000Z", entity: "savings_goal", entityId: GOAL, before: { monthlyContributionCents: "20000" }, after: { monthlyContributionCents: "30000" } });
    expect(batchUndo([second, first]).requests.map((r) => r.body)).toEqual([{ monthlyContributionCents: "20000" }, { monthlyContributionCents: "10000" }]);
  });
});
