import { describe, expect, it } from "vitest";
import { addMonths, addMonthsClamped, ceilDiv, daysInMonth, daysRemainingInMonth, isMonthKey, localDateInTimeZone, monthDiff, monthEnd, monthRange, truncDiv } from "./months.js";

describe("months", () => {
  it("validates and does arithmetic across year boundaries", () => {
    expect(isMonthKey("2026-10")).toBe(true);
    expect(isMonthKey("2026-13")).toBe(false);
    expect(addMonths("2026-10", 14)).toBe("2027-12");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(monthDiff("2026-10", "2027-05")).toBe(7);
    expect(monthDiff("2027-05", "2026-10")).toBe(-7);
    expect(monthRange("2026-11", "2027-01")).toEqual(["2026-11", "2026-12", "2027-01"]);
  });
  it("knows month lengths and days remaining", () => {
    expect(daysInMonth("2028-02")).toBe(29);
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2100-02")).toBe(28);
    expect(daysInMonth("2026-11")).toBe(30);
    expect(monthEnd("2026-02")).toBe("2026-02-28");
    expect(daysRemainingInMonth("2026-10-13")).toBe(19);
    expect(daysRemainingInMonth("2026-10-31")).toBe(1);
    expect(daysRemainingInMonth("2028-02-01")).toBe(29);
  });
  it("clamps when adding months to a date", () => {
    expect(addMonthsClamped("2028-02-29", -12)).toBe("2027-02-28");
    expect(addMonthsClamped("2026-10-31", 1)).toBe("2026-11-30");
    expect(addMonthsClamped("2026-11-30", 3)).toBe("2027-02-28");
  });
  it("divides with one rule and a positive divisor", () => {
    expect(truncDiv(175352n, 19n)).toBe(9229n);
    expect(truncDiv(-7n, 2n)).toBe(-3n);
    expect(ceilDiv(720000n, 12n)).toBe(60000n);
    expect(ceilDiv(300000n, 9n)).toBe(33334n);
    expect(ceilDiv(0n, 5n)).toBe(0n);
    expect(() => truncDiv(1n, 0n)).toThrow();
  });
  it("gives the calendar date in a time zone", () => {
    expect(localDateInTimeZone(new Date("2026-10-14T03:30:00Z"), "America/Denver")).toBe("2026-10-13");
    expect(localDateInTimeZone(new Date("2026-10-14T03:30:00Z"), "UTC")).toBe("2026-10-14");
  });
});
