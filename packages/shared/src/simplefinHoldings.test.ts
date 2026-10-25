import { describe, expect, it } from "vitest";
import { formatFixed8, parseFixed8 } from "./decimal.js";
import { parseSimplefinHoldings, type HoldingsSource } from "./simplefinHoldings.js";

const f = parseFixed8;
// 2026-10-13T14:00:00Z
const BALANCE_DATE = 1_791_900_000;

function account(partial: Partial<HoldingsSource>): HoldingsSource {
  return { "balance-date": BALANCE_DATE, ...partial };
}

const exampleA = [
  { symbol: "VTI", description: "Vanguard Total Stock Market ETF", quantity: "12.345", price: "250.66", market_value: "3,094.40", cost_basis: "2500.00" },
  { symbol: "CASH", market_value: "150.25" },
];

describe("parseSimplefinHoldings: shape A, strings under extra.holdings (imports test 4)", () => {
  it("parses the worked example with the balance-date as the snapshot date", () => {
    const result = parseSimplefinHoldings(account({ extra: { holdings: exampleA } }));
    expect(result.status).toBe("parsed");
    expect(result.container).toBe("extra.holdings");
    expect(result.asOf).toBe("2026-10-13");
    expect(result.rejected).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.positions).toHaveLength(2);
    const [vti, cash] = result.positions;
    expect(vti).toMatchObject({
      index: 0,
      ticker: "VTI",
      name: "Vanguard Total Stock Market ETF",
      cusip: null,
      isin: null,
      quantity: 1_234_500_000n,
      price: 25_066_000_000n,
      valueCents: 309_440n,
      costBasisCents: 250_000n,
      isCash: false,
      asOf: null,
      hints: [],
      warnings: [],
    });
    expect(cash).toMatchObject({
      index: 1,
      ticker: "CASH",
      isCash: true,
      quantity: 15_025_000_000n,
      price: 100_000_000n,
      valueCents: 15_025n,
      costBasisCents: null,
      warnings: [],
    });
    for (const key of ["symbol", "description", "quantity", "price", "market_value", "cost_basis"]) expect(result.keysSeen).toContain(key);
  });

  it("pins the value-mismatch tolerance at max(1 cent, 0.5 %) and keeps the broker's value", () => {
    const within = parseSimplefinHoldings(account({ extra: { holdings: [{ ...exampleA[0], market_value: "3,100.00" }] } }));
    expect(within.positions[0]!.valueCents).toBe(310_000n);
    expect(within.positions[0]!.warnings).toEqual([]);
    const beyond = parseSimplefinHoldings(account({ extra: { holdings: [{ ...exampleA[0], market_value: "3,200.00" }] } }));
    expect(beyond.positions[0]!.valueCents).toBe(320_000n);
    expect(beyond.positions[0]!.warnings).toEqual(["value_mismatch"]);
  });

  it("flags a value with sub-cent digits as rounded", () => {
    const result = parseSimplefinHoldings(account({ extra: { holdings: [{ symbol: "VTI", quantity: "1", price: "3094.405", market_value: "3094.405" }] } }));
    expect(result.positions[0]!.valueCents).toBe(309_441n);
    expect(result.positions[0]!.warnings).toEqual(["value_rounded"]);
  });
});

describe("parseSimplefinHoldings: shape B, keyed objects, dollar-only rows and rejects (imports test 5)", () => {
  it("reads the Bridge's own holdings array with JSON numbers and derives the value from quantity × price", () => {
    const result = parseSimplefinHoldings(account({ holdings: [{ ticker: "FXAIX", shares: 41.2, last_price: 210.1234, cusip: "315911750" }] }));
    expect(result.status).toBe("parsed");
    expect(result.container).toBe("holdings");
    expect(result.positions[0]).toMatchObject({ ticker: "FXAIX", quantity: 4_120_000_000n, price: 21_012_340_000n, valueCents: 865_708n, cusip: "315911750" });
  });

  it("reads an object keyed by symbol and implies the price", () => {
    const result = parseSimplefinHoldings(account({ extra: { positions: { VTI: { shares: "2", market_value: "500.00" } } } }));
    expect(result.status).toBe("parsed");
    expect(result.container).toBe("extra.positions");
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0]).toMatchObject({ ticker: "VTI", quantity: 200_000_000n, valueCents: 50_000n });
    expect(formatFixed8(result.positions[0]!.price!)).toBe("250");
  });

  it("accepts a dollar-only 401(k) position (example E)", () => {
    const result = parseSimplefinHoldings(account({ extra: { holdings: [{ name: "Vanguard Target Retirement 2045 Trust Plus", market_value: "12,345.67" }] } }));
    expect(result.status).toBe("parsed");
    expect(result.positions[0]).toMatchObject({
      ticker: null,
      name: "Vanguard Target Retirement 2045 Trust Plus",
      quantity: null,
      price: null,
      valueCents: 1_234_567n,
      warnings: ["dollar_only"],
    });
  });

  it("rejects unparseable fields, missing values, non-object elements and skips pending activity", () => {
    const result = parseSimplefinHoldings(
      account({
        extra: {
          holdings: [
            { symbol: "VTI", quantity: 1e-9 },
            { symbol: "VTI", shares: "3" },
            { name: "Pending Activity", market_value: "12.34" },
            "junk",
            { symbol: "BND", shares: "0", market_value: "0" },
            { symbol: "VXUS", shares: "4", market_value: "200.00" },
          ],
        },
      }),
    );
    expect(result.status).toBe("partial");
    expect(result.rejected).toEqual([
      { index: 0, reason: "unparseable:quantity", keys: ["symbol", "quantity"] },
      { index: 1, reason: "missing_value", keys: ["symbol", "shares"] },
      { index: 3, reason: "unparseable:element", keys: [] },
    ]);
    expect(result.skipped).toEqual([
      { index: 2, reason: "pending_activity" },
      { index: 4, reason: "zero_position" },
    ]);
    expect(result.positions.map((p) => p.ticker)).toEqual(["VXUS"]);
  });

  it("uses the balance-date and warns every row when the elements' as-of dates disagree", () => {
    const result = parseSimplefinHoldings(
      account({
        extra: {
          holdings: [
            { symbol: "VTI", shares: "1", market_value: "250.00", date: 1_791_900_000 },
            { symbol: "BND", shares: "1", market_value: "70.00", date: "2026-10-12" },
          ],
        },
      }),
    );
    expect(result.asOf).toBe("2026-10-13");
    expect(result.positions.map((p) => p.asOf)).toEqual(["2026-10-13", "2026-10-12"]);
    expect(result.positions.every((p) => p.warnings.includes("asof_mixed"))).toBe(true);
  });

  it("dates the snapshot by the elements when they all agree, never by the clock", () => {
    const result = parseSimplefinHoldings(
      account({
        extra: {
          holdings: [
            { symbol: "VTI", shares: "1", market_value: "250.00", as_of_date: "2026-10-12" },
            { symbol: "BND", shares: "1", market_value: "70.00", as_of_date: "2026-10-12T21:00:00Z" },
          ],
        },
      }),
    );
    expect(result.asOf).toBe("2026-10-12");
    expect(result.positions.every((p) => p.warnings.length === 0)).toBe(true);
  });

  it("keeps type hints and the currency as text, and a fund name in the symbol field becomes the name", () => {
    const result = parseSimplefinHoldings(
      account({ extra: { holdings: [{ symbol: "VANGUARD TARGET 2045 TRUST", market_value: "100.00", security_type: "Mutual Fund", currency: "usd" }] } }),
    );
    expect(result.positions[0]).toMatchObject({ ticker: null, name: "VANGUARD TARGET 2045 TRUST", hints: ["Mutual Fund"], currency: "USD" });
  });

  it("values a cash row reported in units at 1 and never invents a cash position", () => {
    const result = parseSimplefinHoldings(account({ extra: { holdings: [{ symbol: "**CASH**", shares: "150.25" }] } }));
    expect(result.positions[0]).toMatchObject({ isCash: true, quantity: 15_025_000_000n, price: 100_000_000n, valueCents: 15_025n });
    const none = parseSimplefinHoldings(account({ extra: { holdings: [{ symbol: "VTI", shares: "1", market_value: "250.00" }] } }));
    expect(none.positions.some((p) => p.isCash)).toBe(false);
  });
});

describe("parseSimplefinHoldings: unrecognized and none (imports test 6)", () => {
  it("reports a container whose elements have no identity with the keys it saw", () => {
    const result = parseSimplefinHoldings(account({ extra: { positions: [{ foo: 1, bar: "x" }] } }));
    expect(result.status).toBe("unrecognized");
    expect(result.container).toBe("extra.positions");
    expect(result.keysSeen).toEqual(["foo", "bar"]);
    expect(result.rejected).toEqual([{ index: 0, reason: "missing_identity", keys: ["foo", "bar"] }]);
    expect(result.positions).toEqual([]);
  });

  it("returns none when there is no holdings-shaped container", () => {
    expect(parseSimplefinHoldings(account({ extra: { "account-type": "brokerage" } }))).toEqual({
      status: "none",
      container: null,
      asOf: null,
      positions: [],
      rejected: [],
      skipped: [],
      keysSeen: [],
    });
    expect(parseSimplefinHoldings(account({})).status).toBe("none");
    expect(parseSimplefinHoldings(account({ holdings: [] })).status).toBe("none");
    expect(parseSimplefinHoldings(account({ extra: { notes: [{ text: "x", amount: 3 }] } })).status).toBe("none");
  });

  it("accepts an unnamed extra key only when an element carries an identity and a quantity or value", () => {
    const result = parseSimplefinHoldings(account({ extra: { brokerage_positions: [{ Ticker_Symbol: "VTI", Shares: "2", Market_Value: "500.00" }] } }));
    expect(result.status).toBe("parsed");
    expect(result.container).toBe("extra.brokerage_positions");
    expect(result.positions[0]).toMatchObject({ ticker: "VTI", quantity: f("2"), valueCents: 50_000n });
  });

  it("prefers the Bridge's own array over extra and caps the keys it reports", () => {
    const wide: Record<string, unknown> = { symbol: "VTI", shares: "1", market_value: "250.00" };
    for (let i = 0; i < 40; i++) wide[`k${i}`] = i;
    const result = parseSimplefinHoldings(account({ holdings: [wide], extra: { holdings: exampleA } }));
    expect(result.container).toBe("holdings");
    expect(result.keysSeen.length).toBe(30);
  });
});
