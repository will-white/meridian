import { describe, expect, it } from "vitest";
import { ageMonth, planStart } from "./clock.js";

describe("2. start rule (inputs-and-data decision 19, §3.4 R2)", () => {
  it.each([
    ["2026-11-09", 2026, "2026-11", 2],
    ["2026-10-13", 2026, "2026-10", 3],
    ["2026-11-16", 2026, "2026-12", 1],
    ["2026-12-15", 2026, "2026-12", 1],
    ["2026-12-18", 2027, "2027-01", 12],
    ["2026-01-15", 2026, "2026-01", 12],
    ["2026-01-16", 2026, "2026-02", 11],
  ] as const)("2 %s → (%i, %s, %i)", (asOf, startYear, startMonth, firstYearMonths) => {
    expect(planStart(asOf)).toEqual({ startYear, startMonth, firstYearMonths });
  });

  it("2 the 15th is the last day that keeps the month; a bad date throws", () => {
    expect(planStart("2027-02-15").startMonth).toBe("2027-02");
    expect(planStart("2027-02-28").startMonth).toBe("2027-03");
    expect(() => planStart("2026-02-30")).toThrow(RangeError);
    expect(() => planStart("2026-10")).toThrow(RangeError);
  });
});

describe("3. age months (inputs-and-data decision 20)", () => {
  it("3 the design's cases", () => {
    expect(ageMonth(1975, 6, 60)).toBe("2035-06");
    expect(ageMonth(1977, 9, 62)).toBe("2039-09");
    expect(ageMonth(1975, 6, 67)).toBe("2042-06");
    expect(ageMonth(1977, 9, 67)).toBe("2044-09");
    // Month 9 + 8 = 17 carries into the next year: 2043-09 + 8 months = 2044-05.
    expect(ageMonth(1977, 9, 66, 8)).toBe("2044-05");
    expect(ageMonth(1975, 6, 65)).toBe("2040-06");
  });

  it("3 59½ and 0 months; bad arguments throw", () => {
    expect(ageMonth(1962, 1, 59, 6)).toBe("2021-07");
    expect(ageMonth(1975, 12, 0)).toBe("1975-12");
    expect(ageMonth(1975, 12, 0, 1)).toBe("1976-01");
    expect(() => ageMonth(1975, 13, 60)).toThrow(RangeError);
    expect(() => ageMonth(1975, 6, 60.5)).toThrow(RangeError);
    expect(() => ageMonth(1975, 6, 60, -1)).toThrow(RangeError);
  });
});
