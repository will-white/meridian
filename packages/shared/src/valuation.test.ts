import { describe, expect, it } from "vitest";
import { addDays } from "./dates.js";
import { parseFixed8 } from "./decimal.js";
import type { ValuationSource } from "./api.js";
import {
  CASH_PLUG_NAME,
  MAX_SERIES_DAYS,
  TRADE_CASH_NAME,
  dayChange,
  firstDataDate,
  periodChange,
  priceOn,
  priceStatusOf,
  seriesDates,
  valueAccountOn,
  valueSeries,
  type AccountValuation,
  type LineValuation,
  type ValuationFlow,
  type ValuationInput,
  type ValuationPrice,
  type ValuationPriceSource,
  type ValuationSecurity,
  type ValuationSnapshotLine,
} from "./valuation.js";

const f = parseFixed8;

/** A fixture the tests may mutate before first use; assignable to the engine's readonly input. */
type Fixture = { -readonly [K in keyof ValuationInput]: ValuationInput[K] extends readonly (infer U)[] | undefined ? U[] : ValuationInput[K] };

// ---- Fixture: prices design §3.7–§3.8 scenario S1 (+ B, C) ----

const A = "acct-a";
const B = "acct-b";
const C = "acct-c";
const VTI = "sec-vti";
const VFIAX = "sec-vfiax";
const CASH = "sec-cash";
const FXAIX = "sec-fxaix";
const TGT = "sec-tgt2045";

function securities(): ValuationSecurity[] {
  return [
    { id: VTI, ticker: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf", assetClass: "us_stock", priceMode: "provider" },
    { id: VFIAX, ticker: "VFIAX", name: "Vanguard 500 Index Admiral", type: "fund", assetClass: "us_stock", priceMode: "provider" },
    { id: CASH, ticker: null, name: "Cash", type: "cash", assetClass: "cash", priceMode: "manual" },
    { id: FXAIX, ticker: "FXAIX", name: "Fidelity 500 Index", type: "fund", assetClass: "us_stock", priceMode: "provider" },
    { id: TGT, ticker: null, name: "Target 2045 Trust", type: "fund", assetClass: "other", priceMode: "implied" },
  ];
}

function price(securityId: string, date: string, close: string, source: ValuationPriceSource = "provider"): ValuationPrice {
  return { securityId, date, close: f(close), source };
}

function snap(accountId: string, securityId: string, date: string, quantity: string | null, price: string | null, valueCents: bigint): ValuationSnapshotLine {
  return { accountId, securityId, date, quantity: quantity === null ? null : f(quantity), price: price === null ? null : f(price), valueCents };
}

function bal(accountId: string, date: string, balanceCents: bigint, source: ValuationSource = "csv") {
  return { accountId, date, balanceCents, source };
}

function flow(accountId: string, date: string, amountCents: bigint, kind: ValuationFlow["kind"] = "cash"): ValuationFlow {
  return { accountId, date, amountCents, kind };
}

/**
 * S1: account A (brokerage, positions, auto): snapshot 09-30 VTI 100 @ 300 = 30,000.00;
 * VFIAX 50.123 @ 500 = 25,061.50; Cash 1,234.56; balance 09-30 = 56,296.06 (plug 0);
 * transfer in +1,000.00 on 10-05. Implied rows from the import (09-30) and provider closes
 * 10-09, 10-12, 10-13. B: 401(k) balance-only, 10-01 = 10,000.00, 10-10 = 10,200.00.
 * C: IRA positions, first snapshot 10-12 FXAIX 10 @ 200 = 2,000.00; close 10-13 202.00.
 */
function s1(): Fixture {
  return {
    expectedThrough: "2026-10-20",
    accounts: [
      { id: A, name: "Brokerage", type: "brokerage", taxTreatment: "taxable", fidelity: "positions", cashInference: "auto" },
      { id: B, name: "401(k)", type: "401k", taxTreatment: "pre_tax", fidelity: "balance_only", cashInference: "auto" },
      { id: C, name: "IRA", type: "ira", taxTreatment: "pre_tax", fidelity: "positions", cashInference: "auto" },
    ],
    securities: securities(),
    prices: [
      price(VTI, "2026-09-30", "300", "implied"),
      price(VFIAX, "2026-09-30", "500", "implied"),
      price(VTI, "2026-10-09", "301.10"),
      price(VTI, "2026-10-12", "303"),
      price(VTI, "2026-10-13", "305.25"),
      price(VFIAX, "2026-10-09", "498.75"),
      price(VFIAX, "2026-10-12", "502"),
      price(VFIAX, "2026-10-13", "505.10"),
      price(FXAIX, "2026-10-12", "200", "implied"),
      price(FXAIX, "2026-10-13", "202"),
    ],
    snapshots: [
      snap(A, VTI, "2026-09-30", "100", "300", 3_000_000n),
      snap(A, VFIAX, "2026-09-30", "50.123", "500", 2_506_150n),
      snap(A, CASH, "2026-09-30", "1234.56", "1", 123_456n),
      snap(C, FXAIX, "2026-10-12", "10", "200", 200_000n),
    ],
    balances: [bal(A, "2026-09-30", 5_629_606n), bal(B, "2026-10-01", 1_000_000n, "simplefin"), bal(B, "2026-10-10", 1_020_000n, "simplefin"), bal(C, "2026-10-12", 200_000n)],
    flows: [flow(A, "2026-10-05", 100_000n)],
    tradePositions: [],
  };
}

/** S2: VFIAX's 10-12 close is missing. */
function s2(): Fixture {
  const input = s1();
  return { ...input, prices: input.prices.filter((p) => !(p.securityId === VFIAX && p.date === "2026-10-12")) };
}

function line(v: AccountValuation, securityId: string): LineValuation {
  const found = v.lines.find((l) => l.securityId === securityId);
  if (!found) throw new Error(`no line for ${securityId}`);
  return found;
}

function kindLine(v: AccountValuation, kind: LineValuation["kind"]): LineValuation | undefined {
  return v.lines.find((l) => l.kind === kind);
}

const VTI_SEC = securities()[0]!;

// ---- §3.4 price lookup and status (prices test 6) ----

describe("priceOn and priceStatusOf", () => {
  const input: ValuationInput = {
    ...s1(),
    prices: [price(VFIAX, "2026-10-09", "498.75"), price(VFIAX, "2026-10-13", "505.10"), price(TGT, "2026-09-30", "10", "implied")],
  };
  const vfiax = securities()[1]!;

  it("takes the latest row on or before the date and counts trading days behind the expected close", () => {
    // D 10-11 (Sunday): row 10-09, expected close 10-09 → current
    expect(priceOn(input, VFIAX, "2026-10-11")?.date).toBe("2026-10-09");
    expect(priceStatusOf(vfiax, "2026-10-09", "2026-10-11", "2026-10-20")).toEqual({ priceStatus: "current", tradingDaysBehind: 0 });
    // D 10-12 (Columbus Day, open): expected 10-12 → stale, 1 behind
    expect(priceOn(input, VFIAX, "2026-10-12")?.date).toBe("2026-10-09");
    expect(priceStatusOf(vfiax, "2026-10-09", "2026-10-12", "2026-10-20")).toEqual({ priceStatus: "stale", tradingDaysBehind: 1 });
    expect(priceStatusOf(vfiax, "2026-10-13", "2026-10-13", "2026-10-20")).toEqual({ priceStatus: "current", tradingDaysBehind: 0 });
    // D 10-16: row 10-13, expected 10-16 → 10-14, 10-15, 10-16 = 3 behind
    expect(priceOn(input, VFIAX, "2026-10-16")?.date).toBe("2026-10-13");
    expect(priceStatusOf(vfiax, "2026-10-13", "2026-10-16", "2026-10-20")).toEqual({ priceStatus: "stale", tradingDaysBehind: 3 });
    // the expected close is capped at expectedThrough: D 10-16 with the feed only through 10-13 → current
    expect(priceStatusOf(vfiax, "2026-10-13", "2026-10-16", "2026-10-13")).toEqual({ priceStatus: "current", tradingDaysBehind: 0 });
  });

  it("has no row before the first price; the fallback says whether a statement value stands in", () => {
    expect(priceOn(input, VFIAX, "2026-10-08")).toBeNull();
    expect(priceStatusOf(vfiax, null, "2026-10-08", "2026-10-20", "carried")).toEqual({ priceStatus: "carried", tradingDaysBehind: 0 });
    expect(priceStatusOf(vfiax, null, "2026-10-08", "2026-10-20")).toEqual({ priceStatus: "missing", tradingDaysBehind: 0 });
    expect(priceOn(input, "sec-unknown", "2026-10-13")).toBeNull();
  });

  it("reports the mode for implied and manual securities and `cash` for the cash security", () => {
    const tgt = securities()[4]!;
    expect(priceOn(input, TGT, "2026-10-12")).toEqual(price(TGT, "2026-09-30", "10", "implied"));
    expect(priceStatusOf(tgt, "2026-09-30", "2026-10-12", "2026-10-20")).toEqual({ priceStatus: "implied", tradingDaysBehind: 0 });
    const manualFund: ValuationSecurity = { id: "sec-mm", ticker: null, name: "Money market", type: "fund", assetClass: "cash", priceMode: "manual" };
    const withManual: ValuationInput = { ...input, securities: [...input.securities, manualFund], prices: [...input.prices, price("sec-mm", "2024-01-02", "1", "manual")] };
    const row = priceOn(withManual, "sec-mm", "2026-10-13");
    expect(row?.close).toBe(f("1"));
    expect(priceStatusOf(manualFund, row!.date, "2026-10-13", "2026-10-20")).toEqual({ priceStatus: "manual", tradingDaysBehind: 0 });
    expect(priceStatusOf(securities()[2]!, null, "2026-10-13", "2026-10-20")).toEqual({ priceStatus: "cash", tradingDaysBehind: 0 });
  });
});

// ---- §3.7 valueAccountOn (prices test 9) ----

describe("valueAccountOn: scenario S1", () => {
  it("values the snapshot date at the statement (09-30 = 5,629,606)", () => {
    const v = valueAccountOn(s1(), A, "2026-09-30");
    expect(v.basis).toBe("snapshot");
    expect(v.asOf).toBe("2026-09-30");
    expect(v.valueCents).toBe(5_629_606n);
    expect(v.fidelity).toBe("positions");
    expect(v.priceStatus).toBe("current");
    expect(v.stalest).toBeNull();
    expect(v.cashAnchor).toBe("2026-09-30");
    expect(v.balanceDiffCents).toBe(0n);
    expect(kindLine(v, "cash_plug")).toBeUndefined();
    expect(kindLine(v, "carried_flows")).toBeUndefined();
    const vti = line(v, VTI);
    expect(vti).toMatchObject({ kind: "position", ticker: "VTI", quantity: f("100"), price: f("300"), priceDate: "2026-09-30", priceSource: "statement", priceStatus: "statement", tradingDaysBehind: 0, valueCents: 3_000_000n, valueSource: "statement" });
    expect(line(v, CASH)).toMatchObject({ kind: "cash", quantity: f("1234.56"), price: f("1"), priceSource: "cash", priceStatus: "cash", valueCents: 123_456n, valueSource: "statement" });
    // lines are in security id order
    expect(v.lines.map((l) => l.securityId)).toEqual([CASH, VFIAX, VTI]);
  });

  it("reprices the carried snapshot after its date and carries the transfer (10-09 = 5,734,341)", () => {
    const v = valueAccountOn(s1(), A, "2026-10-09");
    expect(v.basis).toBe("positions");
    expect(v.asOf).toBe("2026-09-30");
    // VTI 100 × 301.10 = 30,110.00; VFIAX 50.123 × 498.75 = 24,998.84625 → 24,998.85; cash 1,234.56; transfer 1,000.00
    expect(line(v, VTI)).toMatchObject({ price: f("301.10"), priceDate: "2026-10-09", priceSource: "provider", priceStatus: "current", valueCents: 3_011_000n, valueSource: "priced" });
    expect(line(v, VFIAX)).toMatchObject({ valueCents: 2_499_885n, priceStatus: "current" });
    expect(line(v, CASH)).toMatchObject({ kind: "cash", priceStatus: "cash", valueCents: 123_456n, valueSource: "priced" });
    expect(kindLine(v, "carried_flows")).toMatchObject({ securityId: null, name: "Transfers since 2026-09-30", priceDate: "2026-09-30", valueCents: 100_000n, valueSource: "carried", priceStatus: "cash" });
    expect(kindLine(v, "cash_plug")).toBeUndefined();
    expect(v.valueCents).toBe(5_734_341n);
    expect(v.priceStatus).toBe("current");
    expect(v.cashAnchor).toBe("2026-09-30");
    expect(v.balanceDiffCents).toBeNull();
    expect(v.missing).toEqual([]);
  });

  it("carries Friday's closes over the weekend as current (10-10, 10-11 = 5,734,341)", () => {
    for (const d of ["2026-10-10", "2026-10-11"]) {
      const v = valueAccountOn(s1(), A, d);
      expect(v.valueCents).toBe(5_734_341n);
      expect(v.priceStatus).toBe("current");
      expect(line(v, VTI).priceDate).toBe("2026-10-09");
    }
  });

  it("follows the closes on 10-12 and 10-13 (5,769,631 and 5,807,669)", () => {
    // 10-12: 30,300.00 + 25,161.75 (50.123 × 502 = 25,161.746) + 1,234.56 + 1,000.00
    expect(valueAccountOn(s1(), A, "2026-10-12").valueCents).toBe(5_769_631n);
    // 10-13: 30,525.00 + 25,317.13 (25,317.1273) + 1,234.56 + 1,000.00
    const v = valueAccountOn(s1(), A, "2026-10-13");
    expect(v.valueCents).toBe(5_807_669n);
    expect(line(v, VTI).valueCents).toBe(3_052_500n);
    expect(line(v, VFIAX).valueCents).toBe(2_531_713n);
  });

  it("is `none` before any data", () => {
    const v = valueAccountOn(s1(), A, "2026-09-29");
    expect(v).toMatchObject({ basis: "none", asOf: null, valueCents: null, priceStatus: "n/a", lines: [], cashAnchor: null, balanceDiffCents: null });
  });

  it("marks the statement's own price stale once the feed should have a newer close (10-05)", () => {
    // no close newer than 09-30 yet: VTI carried at the statement; a provider security's 09-30
    // price is behind the 10-05 close by 10-01, 10-02, 10-05 = 3 trading days
    const v = valueAccountOn(s1(), A, "2026-10-05");
    expect(v.valueCents).toBe(5_729_606n);
    expect(line(v, VTI)).toMatchObject({ price: f("300"), priceDate: "2026-09-30", priceSource: "statement", priceStatus: "stale", tradingDaysBehind: 3, valueCents: 3_000_000n, valueSource: "carried" });
    expect(v.priceStatus).toBe("stale");
    expect(v.stalest).toEqual({ securityId: VFIAX, priceDate: "2026-09-30", tradingDaysBehind: 3 });
  });

  it("with cash inference off carries neither the plug nor the transfer (10-13 = 5,707,669)", () => {
    const input = s1();
    input.accounts[0]!.cashInference = "off";
    const v = valueAccountOn(input, A, "2026-10-13");
    expect(v.valueCents).toBe(5_707_669n);
    expect(kindLine(v, "carried_flows")).toBeUndefined();
    expect(v.cashAnchor).toBeNull();
    expect(valueAccountOn(input, A, "2026-10-09").valueCents).toBe(5_634_341n);
    expect(valueAccountOn(input, A, "2026-10-12").valueCents).toBe(5_669_631n);
  });

  it("S2: a missing close makes the line and the account stale (10-12 = 5,753,341)", () => {
    const v = valueAccountOn(s2(), A, "2026-10-12");
    // VFIAX falls back to the 10-09 close: 30,300.00 + 24,998.85 + 1,234.56 + 1,000.00
    expect(v.valueCents).toBe(5_753_341n);
    expect(v.priceStatus).toBe("stale");
    expect(v.stalest).toEqual({ securityId: VFIAX, priceDate: "2026-10-09", tradingDaysBehind: 1 });
    expect(line(v, VFIAX)).toMatchObject({ priceStatus: "stale", tradingDaysBehind: 1, valueCents: 2_499_885n });
    expect(line(v, VTI).priceStatus).toBe("current");
    const next = valueAccountOn(s2(), A, "2026-10-13");
    expect(next.valueCents).toBe(5_807_669n);
    expect(next.priceStatus).toBe("current");
  });

  it("throws on an account the input does not know", () => {
    expect(() => valueAccountOn(s1(), "acct-x", "2026-10-13")).toThrow(/unknown account/);
  });
});

// ---- Cash plug (prices test 10; views test 9c) ----

describe("cash plug", () => {
  function withoutCashLine(): Fixture {
    const input = s1();
    return { ...input, snapshots: input.snapshots.filter((s) => s.securityId !== CASH), balances: [bal(A, "2026-09-30", 5_680_000n), ...input.balances.slice(1)] };
  }

  it("plugs the balance's unlisted cash and carries it (09-30 = 5,680,000; 10-13 = 5,858,063)", () => {
    const on = valueAccountOn(withoutCashLine(), A, "2026-09-30");
    // 56,800.00 − 55,061.50 = 1,738.50
    expect(kindLine(on, "cash_plug")).toMatchObject({ securityId: null, kind: "cash_plug", name: CASH_PLUG_NAME, quantity: null, price: null, priceDate: "2026-09-30", priceSource: null, priceStatus: "cash", valueCents: 173_850n, valueSource: "carried" });
    expect(on.valueCents).toBe(5_680_000n);
    expect(on.balanceDiffCents).toBe(0n);
    expect(on.cashAnchor).toBe("2026-09-30");
    const later = valueAccountOn(withoutCashLine(), A, "2026-10-13");
    // 30,525.00 + 25,317.13 + 1,738.50 + 1,000.00
    expect(later.valueCents).toBe(5_858_063n);
    expect(kindLine(later, "cash_plug")?.valueCents).toBe(173_850n);
    expect(later.lines.map((l) => l.kind)).toEqual(["position", "position", "cash_plug", "carried_flows"]);
  });

  it("plugs nothing without a balance, and nothing when inference is off", () => {
    const noBalance: ValuationInput = { ...withoutCashLine(), balances: s1().balances.slice(1) };
    const v = valueAccountOn(noBalance, A, "2026-09-30");
    expect(v.valueCents).toBe(5_506_150n);
    expect(kindLine(v, "cash_plug")).toBeUndefined();
    expect(v.cashAnchor).toBeNull();
    // without an anchor the transfers after the snapshot are still carried
    expect(valueAccountOn(noBalance, A, "2026-10-13").valueCents).toBe(3_052_500n + 2_531_713n + 100_000n);

    const off = withoutCashLine();
    off.accounts[0]!.cashInference = "off";
    const v2 = valueAccountOn(off, A, "2026-09-30");
    expect(v2.valueCents).toBe(5_506_150n);
    expect(kindLine(v2, "cash_plug")).toBeUndefined();
    expect(v2.balanceDiffCents).toBe(-173_850n);
    expect(v2.warnings).toEqual([]);
  });

  it("emits no line for a plug of exactly 0", () => {
    const v = valueAccountOn(s1(), A, "2026-10-13");
    expect(v.lines.some((l) => l.kind === "cash_plug")).toBe(false);
  });

  it("reports a negative residual as a warning and never as negative cash", () => {
    const input = s1();
    input.balances[0] = bal(A, "2026-09-30", 5_500_000n);
    const v = valueAccountOn(input, A, "2026-09-30");
    // 55,000.00 − 56,296.06 = −1,296.06
    expect(v.valueCents).toBe(5_629_606n);
    expect(kindLine(v, "cash_plug")).toBeUndefined();
    expect(v.warnings).toEqual([
      { code: "negative_residual", message: "Holdings exceed the account value by $1296.06: the positions are newer than the balance, or the balance is stale", cents: -129_606n },
    ]);
    expect(v.balanceDiffCents).toBe(129_606n);
    expect(v.cashAnchor).toBe("2026-09-30");
  });

  it("anchors on the latest reported balance, repricing the positions on the anchor date", () => {
    const input = s1();
    input.balances.push(bal(A, "2026-10-12", 5_800_000n, "simplefin"));
    // on the anchor date the value is the balance
    const on = valueAccountOn(input, A, "2026-10-12");
    expect(on.valueCents).toBe(5_800_000n);
    expect(on.balanceDiffCents).toBe(0n);
    // plug = 58,000.00 − (30,300.00 + 25,161.75 + 1,234.56) = 1,303.69; the 10-05 transfer is inside the balance
    expect(kindLine(on, "cash_plug")?.valueCents).toBe(130_369n);
    expect(kindLine(on, "carried_flows")).toBeUndefined();
    const later = valueAccountOn(input, A, "2026-10-13");
    expect(later.cashAnchor).toBe("2026-10-12");
    expect(later.valueCents).toBe(3_052_500n + 2_531_713n + 123_456n + 130_369n);
    // before the new anchor the old one still applies
    expect(valueAccountOn(input, A, "2026-10-09").valueCents).toBe(5_734_341n);
  });

  it("ignores computed balance rows", () => {
    const input = s1();
    input.balances.push(bal(A, "2026-10-12", 9_999_999n, "computed"));
    const v = valueAccountOn(input, A, "2026-10-13");
    expect(v.cashAnchor).toBe("2026-09-30");
    expect(v.valueCents).toBe(5_807_669n);
    expect(valueAccountOn(input, A, "2026-10-12").balanceDiffCents).toBeNull();
  });
});

// ---- Lots basis (prices test 11, plus the anchored cash of decision 8 on lot-derived positions) ----

describe("lots basis", () => {
  function fullHistory(): Fixture {
    const input = s1();
    input.accounts[0]!.fidelity = "full_history";
    return {
      ...input,
      tradePositions: [
        { accountId: A, date: "2026-09-15", quantityBySecurity: new Map([[VTI, f("100")], [VFIAX, f("50.123")]]) },
        // buy 0.5 VTI @ 301.10 on 10-06
        { accountId: A, date: "2026-10-06", quantityBySecurity: new Map([[VTI, f("100.5")], [VFIAX, f("50.123")]]) },
      ],
      cashEffects: [
        { accountId: A, date: "2026-09-15", cents: -5_506_150n },
        { accountId: A, date: "2026-10-06", cents: -15_055n },
      ],
    };
  }

  it("ignores the checkpoints while the derived fidelity is `positions`", () => {
    const input = fullHistory();
    input.accounts[0]!.fidelity = "positions";
    const v = valueAccountOn(input, A, "2026-10-13");
    expect(v.basis).toBe("positions");
    expect(v.valueCents).toBe(5_807_669n);
    expect(firstDataDate(input, A)).toBe("2026-09-30");
  });

  it("uses the snapshot while it is newer than the latest checkpoint, then the lots", () => {
    const input = fullHistory();
    expect(firstDataDate(input, A)).toBe("2026-09-15");
    const before = valueAccountOn(input, A, "2026-10-05");
    expect(before.basis).toBe("positions");
    expect(before.valueCents).toBe(5_729_606n);

    const on = valueAccountOn(input, A, "2026-10-06");
    expect(on.basis).toBe("lots");
    expect(on.asOf).toBe("2026-10-06");
    // positions at the 09-30 anchor from the checkpoints: 100 × 300 + 50.123 × 500 = 55,061.50 → plug 1,234.56 (the statement's cash)
    expect(kindLine(on, "cash_plug")).toMatchObject({ name: CASH_PLUG_NAME, priceDate: "2026-09-30", valueCents: 123_456n });
    // the buy's cash leg after the anchor
    expect(kindLine(on, "cash")).toMatchObject({ securityId: null, name: TRADE_CASH_NAME, priceDate: "2026-09-30", valueCents: -15_055n, valueSource: "carried" });
    expect(kindLine(on, "carried_flows")?.valueCents).toBe(100_000n);
    // VTI 100.5 × 300 (the 09-30 implied row; 4 trading days behind the 10-06 close) + VFIAX 50.123 × 500
    expect(line(on, VTI)).toMatchObject({ quantity: f("100.5"), price: f("300"), priceSource: "implied", priceStatus: "stale", tradingDaysBehind: 4, valueCents: 3_015_000n, valueSource: "priced" });
    expect(on.valueCents).toBe(3_015_000n + 2_506_150n + 123_456n - 15_055n + 100_000n);
    expect(on.cashAnchor).toBe("2026-09-30");

    const later = valueAccountOn(input, A, "2026-10-13");
    expect(later.basis).toBe("lots");
    // 100.5 × 305.25 = 30,677.625 → 30,677.63
    expect(line(later, VTI).valueCents).toBe(3_067_763n);
    expect(later.valueCents).toBe(3_067_763n + 2_531_713n + 123_456n - 15_055n + 100_000n);
    expect(later.priceStatus).toBe("current");
  });

  it("returns to the statement when a later one is accepted, and to the lots after the next trade", () => {
    const input = fullHistory();
    // statement 10-15: VTI 100.5 @ 306 = 30,753.00; VFIAX 50.123 @ 506 = 25,362.24 (25,362.238); cash 2,084.01; total 58,199.25
    input.snapshots.push(snap(A, VTI, "2026-10-15", "100.5", "306", 3_075_300n), snap(A, VFIAX, "2026-10-15", "50.123", "506", 2_536_224n), snap(A, CASH, "2026-10-15", "2084.01", "1", 208_401n));
    input.balances.push(bal(A, "2026-10-15", 5_819_925n, "manual"));
    input.prices.push(price(VTI, "2026-10-15", "306", "implied"), price(VFIAX, "2026-10-15", "506", "implied"));
    const statement = valueAccountOn(input, A, "2026-10-15");
    expect(statement.basis).toBe("snapshot");
    expect(statement.valueCents).toBe(5_819_925n);
    const carried = valueAccountOn(input, A, "2026-10-16");
    expect(carried.basis).toBe("positions");
    expect(carried.asOf).toBe("2026-10-15");
    expect(carried.valueCents).toBe(5_819_925n);

    // buy 0.5 VTI @ 306 on 10-19 (−153.00)
    const traded: ValuationInput = {
      ...input,
      tradePositions: [...input.tradePositions, { accountId: A, date: "2026-10-19", quantityBySecurity: new Map([[VTI, f("101")], [VFIAX, f("50.123")]]) }],
      cashEffects: [...(input.cashEffects ?? []), { accountId: A, date: "2026-10-19", cents: -15_300n }],
    };
    const lots = valueAccountOn(traded, A, "2026-10-19");
    expect(lots.basis).toBe("lots");
    expect(lots.asOf).toBe("2026-10-19");
    expect(lots.cashAnchor).toBe("2026-10-15");
    // anchor 10-15: 58,199.25 − (100.5 × 306 + 50.123 × 506) = 2,084.01, the statement's cash
    expect(kindLine(lots, "cash_plug")?.valueCents).toBe(208_401n);
    expect(kindLine(lots, "cash")?.valueCents).toBe(-15_300n);
    // 101 × 306 = 30,906.00; no price moved, so the total is the statement rolled forward: unchanged
    expect(line(lots, VTI).valueCents).toBe(3_090_600n);
    expect(lots.valueCents).toBe(5_819_925n);
  });

  it("values the positions alone when cash inference is off", () => {
    const input = fullHistory();
    input.accounts[0]!.cashInference = "off";
    const v = valueAccountOn(input, A, "2026-10-13");
    expect(v.basis).toBe("lots");
    expect(v.lines.map((l) => l.kind)).toEqual(["position", "position"]);
    expect(v.valueCents).toBe(3_067_763n + 2_531_713n);
  });

  it("leaves an unpriced position null, lists it as missing and warns when the anchor cannot be priced (prices test 12)", () => {
    const input = fullHistory();
    input.tradePositions[1]!.quantityBySecurity = new Map([[VTI, f("100.5")], [VFIAX, f("50.123")], [TGT, f("10")]]);
    const v = valueAccountOn(input, A, "2026-10-13");
    expect(line(v, TGT)).toMatchObject({ price: null, priceDate: null, priceSource: null, priceStatus: "missing", valueCents: null, valueSource: "unpriced" });
    expect(v.valueCents).toBeNull();
    expect(v.missing).toEqual([TGT]);
    expect(v.priceStatus).toBe("current");
    expect(v.warnings).toEqual([]);
    const point = valueSeries(input, [A, B], "2026-10-13", "2026-10-13").portfolio[0]!;
    expect(point).toEqual({ date: "2026-10-13", valueCents: 1_020_000n, partial: true, missing: [A], priceStatus: "n/a" });

    // the unpriced security already held on the anchor date: the plug cannot be computed
    input.tradePositions[0]!.quantityBySecurity = new Map([[VTI, f("100")], [VFIAX, f("50.123")], [TGT, f("10")]]);
    const anchored = valueAccountOn(input, A, "2026-10-13");
    expect(anchored.warnings).toEqual([{ code: "anchor_unpriced", message: "Cash could not be inferred from the 2026-09-30 balance: a position has no price on that date", cents: null }]);
    expect(kindLine(anchored, "cash_plug")).toBeUndefined();
  });
});

// ---- Dollar-only, balance-only and unknown (prices tests 12, 13) ----

describe("dollar-only, balance-only and unknown accounts", () => {
  it("carries a dollar-only 401(k) line at its statement value with an implied account status", () => {
    const input = s1();
    input.accounts.push({ id: "acct-d", name: "Old 401(k)", type: "401k", taxTreatment: "pre_tax", fidelity: "positions", cashInference: "auto" });
    input.snapshots.push(snap("acct-d", TGT, "2026-10-01", null, null, 1_234_567n));
    const on = valueAccountOn(input, "acct-d", "2026-10-01");
    expect(on.basis).toBe("snapshot");
    expect(line(on, TGT)).toMatchObject({ quantity: null, price: null, priceSource: "statement", priceStatus: "statement", valueCents: 1_234_567n, valueSource: "statement" });
    for (const d of ["2026-10-02", "2026-10-13", "2027-01-15"]) {
      const v = valueAccountOn(input, "acct-d", d);
      expect(v.basis).toBe("positions");
      expect(v.valueCents).toBe(1_234_567n);
      expect(line(v, TGT)).toMatchObject({ quantity: null, price: null, priceDate: "2026-10-01", priceSource: "statement", priceStatus: "carried", tradingDaysBehind: 0, valueCents: 1_234_567n, valueSource: "carried" });
      expect(v.priceStatus).toBe("implied");
      expect(v.missing).toEqual([]);
    }
  });

  it("B: the reported balance, carried; C: nothing, then the snapshot, then repriced positions", () => {
    const input = s1();
    expect(valueAccountOn(input, B, "2026-10-09")).toMatchObject({ basis: "balance", asOf: "2026-10-01", valueCents: 1_000_000n, priceStatus: "n/a", lines: [] });
    for (const d of ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"]) {
      expect(valueAccountOn(input, B, d)).toMatchObject({ basis: "balance", asOf: "2026-10-10", valueCents: 1_020_000n });
    }
    expect(valueAccountOn(input, B, "2026-09-30")).toMatchObject({ basis: "none", valueCents: null });
    expect(valueAccountOn(input, C, "2026-10-11")).toMatchObject({ basis: "none", valueCents: null });
    expect(valueAccountOn(input, C, "2026-10-12")).toMatchObject({ basis: "snapshot", valueCents: 200_000n, balanceDiffCents: 0n });
    const c13 = valueAccountOn(input, C, "2026-10-13");
    expect(c13).toMatchObject({ basis: "positions", asOf: "2026-10-12", valueCents: 202_000n, priceStatus: "current" });
    expect(line(c13, FXAIX)).toMatchObject({ price: f("202"), priceSource: "provider", valueCents: 202_000n });
  });

  it("never reads a computed balance as the balance basis", () => {
    const input = s1();
    input.balances.push(bal(B, "2026-10-13", 9_999_999n, "computed"));
    expect(valueAccountOn(input, B, "2026-10-13")).toMatchObject({ asOf: "2026-10-10", valueCents: 1_020_000n });
    const onlyComputed: ValuationInput = { ...input, balances: input.balances.filter((b) => b.accountId !== B || b.source === "computed") };
    expect(valueAccountOn(onlyComputed, B, "2026-10-13").basis).toBe("none");
    expect(firstDataDate(onlyComputed, B)).toBeNull();
  });
});

// ---- Views design test 9: holding valuation rule, dollar-only, residuals, staleness ----

describe("views test 9 through the chain", () => {
  const VB = "acct-vb";
  const VR = "acct-vr";
  const BND = "sec-bnd";
  const TR = "sec-tr2050";
  const POOL = "sec-pool";

  function views(): Fixture {
    return {
      expectedThrough: "2026-10-13",
      accounts: [
        { id: VB, name: "B", type: "brokerage", taxTreatment: "taxable", fidelity: "positions", cashInference: "auto" },
        { id: VR, name: "R", type: "ira", taxTreatment: "pre_tax", fidelity: "positions", cashInference: "auto" },
      ],
      securities: [
        ...securities(),
        { id: BND, ticker: "BND", name: "Vanguard Total Bond Market ETF", type: "etf", assetClass: "bonds", priceMode: "provider" },
        { id: TR, ticker: null, name: "Target Retirement 2050 Trust", type: "fund", assetClass: "other", priceMode: "implied" },
      ],
      prices: [
        price(VTI, "2026-10-09", "309", "implied"),
        price(VTI, "2026-10-12", "310"),
        price(VTI, "2026-10-13", "312.50"),
        price(BND, "2026-10-09", "74.50", "implied"),
        price(BND, "2026-10-12", "74.90"),
        price(BND, "2026-10-13", "74.80"),
        price(TR, "2026-10-09", "42", "implied"),
      ],
      snapshots: [
        snap(VB, VTI, "2026-10-12", "40", "310", 1_240_000n),
        snap(VB, VTI, "2026-10-13", "40", "312.50", 1_250_000n),
        snap(VR, VTI, "2026-10-09", "20", "309", 618_000n),
        snap(VR, BND, "2026-10-09", "100", "74.50", 745_000n),
        snap(VR, TR, "2026-10-09", "100", null, 420_000n),
        snap(VR, CASH, "2026-10-09", "270", "1", 27_000n),
      ],
      balances: [bal(VB, "2026-10-12", 1_240_000n), bal(VB, "2026-10-13", 1_393_200n), bal(VR, "2026-10-09", 1_810_000n)],
      flows: [],
      tradePositions: [],
    };
  }

  it("(a) statement value unless a strictly newer price exists", () => {
    const b12 = valueAccountOn(views(), VB, "2026-10-12");
    expect(line(b12, VTI)).toMatchObject({ valueCents: 1_240_000n, priceSource: "statement", valueSource: "statement" });
    const r12 = valueAccountOn(views(), VR, "2026-10-12");
    expect(line(r12, VTI)).toMatchObject({ valueCents: 620_000n, price: f("310"), priceSource: "provider" });
    expect(line(r12, BND)).toMatchObject({ valueCents: 749_000n, price: f("74.90") });
    expect(line(r12, TR)).toMatchObject({ valueCents: 420_000n, price: f("42"), priceDate: "2026-10-09", priceSource: "statement", priceStatus: "implied", valueSource: "carried" });
    expect(r12.valueCents).toBe(1_816_000n);

    // 10-13: B's own 10-13 snapshot (the close is not strictly newer); R repriced
    const b13 = valueAccountOn(views(), VB, "2026-10-13");
    expect(line(b13, VTI)).toMatchObject({ valueCents: 1_250_000n, priceSource: "statement", priceStatus: "statement" });
    // B's balance 13,932.00 − 12,500.00 = 1,432.00 unlisted cash ("Cash (unlisted)" in the views design)
    expect(kindLine(b13, "cash_plug")).toMatchObject({ name: CASH_PLUG_NAME, valueCents: 143_200n });
    expect(b13.valueCents).toBe(1_393_200n);
    const r13 = valueAccountOn(views(), VR, "2026-10-13");
    expect(line(r13, VTI)).toMatchObject({ valueCents: 625_000n, price: f("312.50"), priceSource: "provider", priceStatus: "current" });
    expect(line(r13, BND)).toMatchObject({ valueCents: 748_000n, price: f("74.80") });
    expect(line(r13, TR).valueCents).toBe(420_000n);
    expect(line(r13, CASH)).toMatchObject({ kind: "cash", valueCents: 27_000n });
    expect(r13.valueCents).toBe(1_820_000n);
    expect(r13.priceStatus).toBe("implied");
    expect(r13.warnings).toEqual([]);
    expect(kindLine(r13, "cash_plug")).toBeUndefined();
  });

  it("(b) a dollar-only row is carried at its value", () => {
    const input = views();
    input.securities.push({ id: POOL, ticker: null, name: "Fidelity Freedom 2050 Pool", type: "fund", assetClass: "other", priceMode: "implied" });
    input.snapshots.push(snap(VR, POOL, "2026-10-09", null, null, 100_000n));
    input.balances[2] = bal(VR, "2026-10-09", 1_910_000n);
    const v = valueAccountOn(input, VR, "2026-10-13");
    expect(line(v, POOL)).toMatchObject({ quantity: null, price: null, priceSource: "statement", priceStatus: "carried", valueCents: 100_000n, valueSource: "carried" });
    expect(v.valueCents).toBe(1_920_000n);
    expect(v.warnings).toEqual([]);
  });

  it("(c) holdings above a reported balance are a negative residual, never negative cash", () => {
    const input = views();
    input.balances.push(bal(VR, "2026-10-13", 1_810_000n, "simplefin"));
    const v = valueAccountOn(input, VR, "2026-10-13");
    expect(v.valueCents).toBe(1_820_000n);
    expect(v.warnings).toEqual([
      { code: "negative_residual", message: "Holdings exceed the account value by $100.00: the positions are newer than the balance, or the balance is stale", cents: -10_000n },
    ]);
    expect(v.balanceDiffCents).toBe(10_000n);
    expect(kindLine(v, "cash_plug")).toBeUndefined();
  });

  it("(d) a statement price with no newer close is stale by trading days, not calendar days", () => {
    const input = views();
    input.snapshots = input.snapshots.map((s) => (s.accountId === VR ? { ...s, date: "2026-09-30" } : s));
    input.balances[2] = bal(VR, "2026-09-30", 1_810_000n);
    input.prices = input.prices.filter((p) => p.securityId !== BND);
    const v = valueAccountOn(input, VR, "2026-10-13");
    // 10-01, 02, 05, 06, 07, 08, 09, 12, 13 = 9 sessions (13 calendar days)
    expect(line(v, BND)).toMatchObject({ priceDate: "2026-09-30", priceSource: "statement", priceStatus: "stale", tradingDaysBehind: 9, valueCents: 745_000n, valueSource: "carried" });
    expect(v.stalest).toEqual({ securityId: BND, priceDate: "2026-09-30", tradingDaysBehind: 9 });
    expect(v.priceStatus).toBe("stale");
  });
});

// ---- §3.8 valueSeries (prices test 14) ----

describe("valueSeries", () => {
  it("sweeps S1 + B + C over 10-09..10-13", () => {
    const series = valueSeries(s1(), [A, B, C], "2026-10-09", "2026-10-13");
    expect(series.dates).toEqual(["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"]);
    expect(series.accounts.map((a) => [a.accountId, a.fidelity, a.firstDataDate])).toEqual([
      [A, "positions", "2026-09-30"],
      [B, "balance_only", "2026-10-01"],
      [C, "positions", "2026-10-12"],
    ]);
    expect(series.accounts[0]!.values).toEqual([5_734_341n, 5_734_341n, 5_734_341n, 5_769_631n, 5_807_669n]);
    expect(series.accounts[1]!.values).toEqual([1_000_000n, 1_020_000n, 1_020_000n, 1_020_000n, 1_020_000n]);
    expect(series.accounts[2]!.values).toEqual([null, null, null, 200_000n, 202_000n]);
    expect(series.portfolio).toEqual([
      { date: "2026-10-09", valueCents: 6_734_341n, partial: true, missing: [C], priceStatus: "current" },
      { date: "2026-10-10", valueCents: 6_754_341n, partial: true, missing: [C], priceStatus: "current" },
      { date: "2026-10-11", valueCents: 6_754_341n, partial: true, missing: [C], priceStatus: "current" },
      { date: "2026-10-12", valueCents: 6_989_631n, partial: false, missing: [], priceStatus: "current" },
      { date: "2026-10-13", valueCents: 7_029_669n, partial: false, missing: [], priceStatus: "current" },
    ]);
    // Σ of the non-null account points equals the portfolio point on every date
    series.portfolio.forEach((point, i) => {
      const sum = series.accounts.reduce((acc, a) => acc + (a.values[i] ?? 0n), 0n);
      expect(point.valueCents).toBe(sum);
    });
  });

  it("S2: the portfolio is stale on 10-12 and unchanged on 10-13", () => {
    const series = valueSeries(s2(), [A, B, C], "2026-10-12", "2026-10-13");
    expect(series.portfolio[0]).toEqual({ date: "2026-10-12", valueCents: 6_973_341n, partial: false, missing: [], priceStatus: "stale" });
    expect(series.portfolio[1]!.valueCents).toBe(7_029_669n);
  });

  it("is null when no account is valued and n/a when only balances are", () => {
    const series = valueSeries(s1(), [B, C], "2026-09-30", "2026-10-01");
    expect(series.portfolio[0]).toEqual({ date: "2026-09-30", valueCents: null, partial: true, missing: [B, C], priceStatus: "n/a" });
    expect(series.portfolio[1]).toEqual({ date: "2026-10-01", valueCents: 1_000_000n, partial: true, missing: [C], priceStatus: "n/a" });
  });

  it("steps by Fridays or month ends, always ending on `to`, and refuses ranges over 3,660 days", () => {
    expect(seriesDates("2026-10-05", "2026-10-13", "week")).toEqual(["2026-10-09", "2026-10-13"]);
    expect(seriesDates("2026-09-15", "2026-10-13", "month")).toEqual(["2026-09-30", "2026-10-13"]);
    expect(seriesDates("2026-10-09", "2026-10-09", "week")).toEqual(["2026-10-09"]);
    expect(seriesDates("2026-10-13", "2026-10-13")).toEqual(["2026-10-13"]);
    expect(valueSeries(s1(), [A], "2026-10-05", "2026-10-13", "week").accounts[0]!.values).toEqual([5_734_341n, 5_807_669n]);
    expect(MAX_SERIES_DAYS).toBe(3660);
    expect(() => seriesDates(addDays("2026-10-13", -3661), "2026-10-13")).toThrow(RangeError);
    expect(() => valueSeries(s1(), [A], addDays("2026-10-13", -3661), "2026-10-13")).toThrow(/3660/);
    expect(seriesDates(addDays("2026-10-13", -3660), "2026-10-13", "month").at(-1)).toBe("2026-10-13");
    expect(() => seriesDates("2026-10-14", "2026-10-13")).toThrow(RangeError);
  });
});

// ---- §3.9 dayChange (prices test 15) ----

describe("dayChange", () => {
  it("is the price movement on today's quantities; balance-only accounts are excluded (10-13: +400.38 partial)", () => {
    const dc = dayChange(s1(), [A, B, C], "2026-10-13");
    expect(dc.asOf).toBe("2026-10-13");
    expect(dc.prior).toBe("2026-10-12");
    const a = dc.accounts[0]!;
    // VTI 100 × (305.25 − 303.00) = 225.00; VFIAX 25,317.13 − 25,161.75 = 155.38
    expect(a.cents).toBe(38_038n);
    expect(a.lines.map((l) => [l.securityId, l.cents])).toEqual([
      [VFIAX, 15_538n],
      [VTI, 22_500n],
    ]);
    expect(a.lines[1]).toMatchObject({ quantity: f("100"), asOfPrice: { date: "2026-10-13", close: f("305.25"), source: "provider" }, priorPrice: { date: "2026-10-12", close: f("303"), source: "provider" }, priceStatus: "current" });
    expect(dc.accounts[1]).toEqual({ accountId: B, cents: null, asOf: "2026-10-13", prior: "2026-10-12", reason: "balance_only", lines: [] });
    expect(dc.accounts[2]!.cents).toBe(2_000n);
    expect(dc.cents).toBe(40_038n);
    expect(dc.partial).toBe(true);
    expect(dc.excluded).toEqual([{ accountId: B, reason: "balance_only" }]);
    expect(dc.reason).toBeNull();
    // 400.38 over the included accounts' prior value (57,696.31 + 2,000.00) = 67.07 bp
    expect(dc.bp).toBe(67);
  });

  it("uses the last completed session before the feed catches up (10-14 at 09:00 ET)", () => {
    const input: ValuationInput = { ...s1(), expectedThrough: "2026-10-13" };
    const dc = dayChange(input, [A, B, C], "2026-10-14");
    expect(dc).toMatchObject({ asOf: "2026-10-13", prior: "2026-10-12", cents: 40_038n, partial: true });
  });

  it("reaches back over the weekend and to the statement's implied rows", () => {
    // 10-12 → prior 10-09: VTI 100 × (303 − 301.10) = 190.00; VFIAX 25,161.75 − 24,998.85 = 162.90
    const d12 = dayChange(s1(), [A], "2026-10-12");
    expect(d12).toMatchObject({ asOf: "2026-10-12", prior: "2026-10-09", cents: 35_290n, partial: false, excluded: [] });
    // 10-09 → prior 10-08 carries the 09-30 implied rows: VTI 30,110.00 − 30,000.00; VFIAX 24,998.85 − 25,061.50
    const d09 = dayChange(s1(), [A], "2026-10-09");
    expect(d09).toMatchObject({ asOf: "2026-10-09", prior: "2026-10-08", cents: 4_735n });
    expect(d09.accounts[0]!.lines.map((l) => [l.securityId, l.cents, l.priorPrice?.source])).toEqual([
      [VFIAX, -6_265n, "implied"],
      [VTI, 11_000n, "implied"],
    ]);
  });

  it("S2 on 10-12: the stale line moves nothing (+190.00)", () => {
    const dc = dayChange(s2(), [A], "2026-10-12");
    expect(dc.cents).toBe(19_000n);
    const vfiax = dc.accounts[0]!.lines.find((l) => l.securityId === VFIAX)!;
    expect(vfiax).toMatchObject({ cents: 0n, priceStatus: "stale", asOfPrice: { date: "2026-10-09" }, priorPrice: { date: "2026-10-09" } });
  });

  it("is null with a reason without prices, a prior close, or a market-valued account", () => {
    const none: ValuationInput = { ...s1(), prices: [] };
    expect(dayChange(none, [A, B], "2026-10-13")).toEqual({
      cents: null,
      asOf: null,
      prior: null,
      reason: "no_prices",
      bp: null,
      partial: true,
      excluded: [
        { accountId: A, reason: "no_prices" },
        { accountId: B, reason: "balance_only" },
      ],
      accounts: [
        { accountId: A, cents: null, asOf: null, prior: null, reason: "no_prices", lines: [] },
        { accountId: B, cents: null, asOf: null, prior: null, reason: "balance_only", lines: [] },
      ],
    });
    // a balance-only account with balances on both days: flows are not market moves
    const input = s1();
    input.balances.push(bal(B, "2026-10-12", 1_030_000n, "simplefin"), bal(B, "2026-10-13", 1_040_000n, "simplefin"));
    const dc = dayChange(input, [B], "2026-10-13");
    expect(dc).toMatchObject({ cents: null, reason: "balance_only", partial: true, excluded: [{ accountId: B, reason: "balance_only" }] });
    // C on 10-12: FXAIX has only its 10-12 implied row → no prior close
    const c = dayChange(s1(), [C], "2026-10-12");
    expect(c.accounts[0]).toMatchObject({ cents: null, reason: "missing_prior_price" });
    expect(c.accounts[0]!.lines[0]).toMatchObject({ cents: null, priorPrice: null });
    expect(c.reason).toBe("missing_prior_price");
  });
});

// ---- §3.9 periodChange (prices test 16) ----

describe("periodChange", () => {
  it("1w at 10-13 over S1 + B + C: change +3,000.63, C enters with its opening value", () => {
    const pc = periodChange(s1(), [A, B, C], { period: "1w", end: "2026-10-13" });
    expect(pc).toMatchObject({ period: "1w", from: "2026-10-06", to: "2026-10-13" });
    // A(10-06) = 30,000.00 + 25,061.50 + 1,234.56 + carried 1,000.00 = 57,296.06; B 10,000.00; C null
    expect(pc!.startCents).toBe(6_729_606n);
    expect(pc!.endCents).toBe(7_029_669n);
    expect(pc!.changeCents).toBe(300_063n);
    // 300,063 × 10,000 / 6,729,606 = 445.8 → 445
    expect(pc!.changeBp).toBe(445);
    expect(pc!.newAccounts).toEqual([{ id: C, name: "IRA", openingCents: 200_000n }]);
    expect(pc!.netFlowsCents).toBe(200_000n);
    expect(pc!.growthCents).toBe(100_063n);
    expect(pc!.growthReason).toBeNull();
    expect(pc!.accounts.map((a) => [a.accountId, a.startCents, a.endCents, a.changeCents, a.netFlowsCents, a.growthCents, a.isNew])).toEqual([
      [A, 5_729_606n, 5_807_669n, 78_063n, 0n, 78_063n, false],
      [B, 1_000_000n, 1_020_000n, 20_000n, 0n, 20_000n, false],
      [C, null, 202_000n, 202_000n, 200_000n, 2_000n, true],
    ]);
    expect(pc!.accounts[2]).toMatchObject({ openingCents: 200_000n, openingDate: "2026-10-12", endBasis: "positions" });
  });

  it("A alone 09-30 → 10-13: change +1,780.63, flows 1,000.00, growth +780.63; off → growth null", () => {
    const pc = periodChange(s1(), [A], { period: "custom", end: "2026-10-13", from: "2026-09-30" });
    expect(pc).toMatchObject({ from: "2026-09-30", startCents: 5_629_606n, endCents: 5_807_669n, changeCents: 178_063n, netFlowsCents: 100_000n, growthCents: 78_063n, growthReason: null, newAccounts: [] });
    const off = s1();
    off.accounts[0]!.cashInference = "off";
    const pcOff = periodChange(off, [A], { period: "custom", end: "2026-10-13", from: "2026-09-30" });
    expect(pcOff).toMatchObject({ changeCents: 78_063n, netFlowsCents: 100_000n, growthCents: null, growthReason: "flows_not_in_value" });
    expect(pcOff!.accounts[0]).toMatchObject({ growthCents: null, growthReason: "flows_not_in_value" });
  });

  it("ytd at 10-13: no account has data at the start, so nothing is measured", () => {
    const pc = periodChange(s1(), [A, B, C], { period: "ytd", end: "2026-10-13" });
    expect(pc).toMatchObject({ from: "2025-12-31", startCents: null, endCents: 7_029_669n, changeCents: null, changeBp: null, netFlowsCents: 0n, growthCents: null, growthReason: null, newAccounts: [] });
    expect(pc!.accounts.every((a) => a.startCents === null && a.changeCents === null && !a.isNew)).toBe(true);
  });

  it("uses the one periodStart: 1m, 1y, 3m, all (earliest data), custom without a start → null", () => {
    expect(periodChange(s1(), [A], { period: "1m", end: "2026-10-13" })?.from).toBe("2026-09-13");
    expect(periodChange(s1(), [A], { period: "1y", end: "2026-10-13" })?.from).toBe("2025-10-13");
    expect(periodChange(s1(), [A], { period: "3m", end: "2026-10-13" })?.from).toBe("2026-07-13");
    const all = periodChange(s1(), [A, B, C], { period: "all", end: "2026-10-13" });
    expect(all?.from).toBe("2026-09-30");
    expect(all?.startCents).toBe(5_629_606n);
    expect(periodChange(s1(), [A], { period: "custom", end: "2026-10-13" })).toBeNull();
    expect(periodChange(s1(), [A], { period: "custom", end: "2026-10-13", from: "2026-10-14" })).toBeNull();
    const empty: ValuationInput = { ...s1(), snapshots: [], balances: [], flows: [] };
    expect(periodChange(empty, [A, B, C], { period: "all", end: "2026-10-13" })).toBeNull();
  });

  it("counts a new account's later transfers as flows", () => {
    const input = s1();
    input.flows.push(flow(C, "2026-10-13", 50_000n));
    const pc = periodChange(input, [A, B, C], { period: "1w", end: "2026-10-13" });
    // C's 10-13 value is still 2,020.00 (the carried flow is in it): flows = opening 2,000.00 + 500.00
    expect(pc!.accounts[2]).toMatchObject({ endCents: 252_000n, netFlowsCents: 250_000n, growthCents: 2_000n });
    expect(pc!.netFlowsCents).toBe(250_000n);
    expect(pc!.growthCents).toBe(100_063n);
  });
});

// ---- Determinism ----

describe("determinism", () => {
  it("gives the same result for any input order", () => {
    const base = s1();
    const shuffled: ValuationInput = {
      ...base,
      accounts: [...base.accounts].reverse(),
      securities: [...base.securities].reverse(),
      prices: [...base.prices].reverse(),
      snapshots: [...base.snapshots].reverse(),
      balances: [...base.balances].reverse(),
      flows: [...base.flows].reverse(),
    };
    for (const d of ["2026-09-30", "2026-10-05", "2026-10-13"]) {
      expect(valueAccountOn(shuffled, A, d)).toEqual(valueAccountOn(base, A, d));
    }
    expect(valueSeries(shuffled, [A, B, C], "2026-10-09", "2026-10-13")).toEqual(valueSeries(base, [A, B, C], "2026-10-09", "2026-10-13"));
    expect(dayChange(shuffled, [A, B, C], "2026-10-13")).toEqual(dayChange(base, [A, B, C], "2026-10-13"));
    expect(periodChange(shuffled, [A, B, C], { period: "1w", end: "2026-10-13" })).toEqual(periodChange(base, [A, B, C], { period: "1w", end: "2026-10-13" }));
  });

  it("keeps the last of several checkpoints or price rows on one date", () => {
    const input = s1();
    input.accounts[0]!.fidelity = "full_history";
    input.tradePositions = [
      { accountId: A, date: "2026-10-06", quantityBySecurity: new Map([[VTI, f("100")], [VFIAX, f("50.123")]]) },
      { accountId: A, date: "2026-10-06", quantityBySecurity: new Map([[VTI, f("100.5")], [VFIAX, f("50.123")]]) },
    ];
    input.prices.push(price(VTI, "2026-10-13", "305.26", "manual"));
    const v = valueAccountOn(input, A, "2026-10-13");
    expect(line(v, VTI)).toMatchObject({ quantity: f("100.5"), price: f("305.26"), priceSource: "manual", priceStatus: "current" });
    expect(VTI_SEC.priceMode).toBe("provider");
  });
});
