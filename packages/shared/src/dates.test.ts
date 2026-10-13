import { describe, expect, it } from "vitest";
import { addDays, dayDiff, dayOfMonth, isIsoDate, unixToIsoDate } from "./dates.js";

describe("dates", () => {
  it("validates ISO dates", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-2-3")).toBe(false);
  });
  it("computes day differences across month ends", () => {
    expect(dayDiff("2026-09-29", "2026-10-02")).toBe(3);
    expect(dayDiff("2026-10-02", "2026-09-29")).toBe(-3);
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(dayOfMonth("2026-09-15")).toBe(15);
  });
  it("converts unix seconds", () => {
    expect(unixToIsoDate(1760000000)).toBe("2025-10-09");
  });
});
