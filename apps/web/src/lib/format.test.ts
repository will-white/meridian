import { describe, expect, it } from "vitest";
import { money, shortDate } from "./format.js";

describe("money", () => {
  it("formats cents with grouping and sign", () => {
    expect(money("-1234567")).toBe("-$12,345.67");
    expect(money("5")).toBe("$0.05");
    expect(money("0")).toBe("$0.00");
    expect(money("100000000")).toBe("$1,000,000.00");
    expect(money(null)).toBe("—");
  });
});

describe("shortDate", () => {
  it("renders MM/DD/YY", () => {
    expect(shortDate("2026-09-05")).toBe("09/05/26");
  });
});
