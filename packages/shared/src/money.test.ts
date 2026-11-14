import { describe, expect, it } from "vitest";
import { formatCents, formatDollars, parseDecimalToCents } from "./money.js";

describe("parseDecimalToCents", () => {
  it("parses SimpleFIN-style amounts", () => {
    expect(parseDecimalToCents("100.23")).toBe(10023n);
    expect(parseDecimalToCents("-33293.43")).toBe(-3329343n);
    expect(parseDecimalToCents("5")).toBe(500n);
    expect(parseDecimalToCents("0.5")).toBe(50n);
    expect(parseDecimalToCents("-0.05")).toBe(-5n);
  });

  it("rejects non-money input", () => {
    expect(() => parseDecimalToCents("1.234")).toThrow();
    expect(() => parseDecimalToCents("abc")).toThrow();
    expect(() => parseDecimalToCents("")).toThrow();
  });
});

describe("formatCents", () => {
  it("round-trips", () => {
    for (const s of ["100.23", "-33293.43", "0.05", "-0.05", "0.00"]) {
      expect(formatCents(parseDecimalToCents(s))).toBe(s);
    }
  });
});

describe("formatDollars (audit a8-ledger-ui-01, second round)", () => {
  it("signs, groups and keeps the cents", () => {
    expect(formatDollars(-1234567n)).toBe("-$12,345.67");
    expect(formatDollars(5000n)).toBe("$50.00");
    expect(formatDollars(-5n)).toBe("-$0.05");
    expect(formatDollars(0n)).toBe("$0.00");
    expect(formatDollars(999999999999999n)).toBe("$9,999,999,999,999.99");
  });
});
