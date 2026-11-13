import { describe, expect, it } from "vitest";
import { monthIndex, monthsInPeriod, periodMonths, periodStart, planClock, yearOfMonth, yearShare } from "./clock.js";
import { EngineInputError } from "./errors.js";

// The plan clock (seams §2.2, C14, C15; plan decision 2): months, never days.

const plan = (startYear: number, startMonth: string, firstYearMonths: number, endYear: number) =>
  ({ startYear, startMonth, firstYearMonths, endYear, stepsPerYear: 1, currency: "USD" }) as const;

describe("the plan clock", () => {
  it("month numbers are year × 12 + month − 1", () => {
    expect(monthIndex("2026-10")).toBe(2026 * 12 + 9);
    expect(monthIndex("2027-01")).toBe(2027 * 12);
    expect(yearOfMonth(monthIndex("2035-06"))).toBe(2035);
    expect(yearOfMonth(monthIndex("2035-12"))).toBe(2035);
    expect(() => monthIndex("2035-13")).toThrow(EngineInputError);
    expect(() => monthIndex("2035-6")).toThrow(EngineInputError);
  });

  it("the inputs fixture's plan: October 2026, three months in year 0 (f = 3/12), 47 years", () => {
    const c = planClock(plan(2026, "2026-10", 3, 2072));
    expect(c.years).toBe(47);
    expect(c.firstYearFraction).toBe(0.25);
    expect(periodStart(c, 0)).toBe(monthIndex("2026-10"));
    expect(periodMonths(c, 0)).toBe(3);
    expect(periodStart(c, 1)).toBe(monthIndex("2027-01"));
    expect(periodMonths(c, 1)).toBe(12);
  });

  it("C15: a window counts its months inside the period; yearShare turns them into a full-year rate", () => {
    const c = planClock(plan(2026, "2026-10", 3, 2072));
    // Alex retires June 2035: spending from 2035-06 runs 7 of 12 months of 2035 (t = 9).
    expect(monthsInPeriod(c, 9, monthIndex("2035-06"), Number.POSITIVE_INFINITY)).toBe(7);
    expect(yearShare(c, 9, monthIndex("2035-06"), Number.POSITIVE_INFINITY)).toBe(7 / 12);
    // Salary [2026-10, 2035-06): all of year 0's three months (share 1), five months of 2035.
    expect(yearShare(c, 0, monthIndex("2026-10"), monthIndex("2035-06"))).toBe(1);
    expect(monthsInPeriod(c, 9, monthIndex("2026-10"), monthIndex("2035-06"))).toBe(5);
    // A window that starts in November of year 0 runs 2 of its 3 months.
    expect(yearShare(c, 0, monthIndex("2026-11"), Number.POSITIVE_INFINITY)).toBe(2 / 3);
    // Before and after the window: 0.
    expect(yearShare(c, 8, monthIndex("2035-06"), Number.POSITIVE_INFINITY)).toBe(0);
    expect(yearShare(c, 10, monthIndex("2026-10"), monthIndex("2035-06"))).toBe(0);
    // An empty window (start at or after the end) has no months.
    expect(monthsInPeriod(c, 9, monthIndex("2035-08"), monthIndex("2035-06"))).toBe(0);
  });

  it("the clock's fields must agree, and a plan runs 1 to 120 years", () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as EngineInputError).code;
      }
      return undefined;
    };
    expect(code(() => planClock(plan(2026, "2026-10", 2, 2072)))).toBe("plan_invalid");
    expect(code(() => planClock(plan(2027, "2026-10", 3, 2072)))).toBe("plan_invalid");
    expect(code(() => planClock(plan(2027, "2027-01", 12, 2026)))).toBe("plan_invalid");
    expect(code(() => planClock(plan(2027, "2027-01", 12, 2147)))).toBe("horizon_too_long");
    expect(planClock(plan(2027, "2027-01", 12, 2146)).years).toBe(120);
    expect(planClock(plan(2027, "2027-12", 1, 2027)).years).toBe(1);
  });
});
