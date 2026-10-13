import { describe, expect, it } from "vitest";
import { effectiveDay, isMissed, monthIndex, monthlyEquivalentCents, occurrence, occurrencesInRange, periodIndex, validateSchedule, yearlyCents, type Schedule } from "./schedule.js";

describe("occurrence and periodIndex", () => {
  it("monthly on the 31st clamps to month ends and reads a late post as the previous period", () => {
    const s: Schedule = { cadence: "monthly", anchorDay: 31 };
    expect(occurrencesInRange(s, "2026-11-01", "2027-02-28")).toEqual(["2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"]);
    expect(periodIndex(s, "2026-06-01")).toEqual({ k: monthIndex("2026-05-01"), residualDays: 1 });
    expect(effectiveDay("2026-02-28")).toBe(31);
    expect(effectiveDay("2026-02-27")).toBe(27);
  });
  it("monthly on the 5th: absolute month index and signed residual", () => {
    const s: Schedule = { cadence: "monthly", anchorDay: 5 };
    expect(monthIndex("2026-10-13")).toBe(24321);
    expect(periodIndex(s, "2026-10-12")).toEqual({ k: 24321, residualDays: 7 });
    expect(periodIndex(s, "2026-11-03")).toEqual({ k: 24322, residualDays: -2 });
    expect(occurrence(s, 24321)).toBe("2026-10-05");
  });
  it("quarterly from an anchor month never drifts", () => {
    const s: Schedule = { cadence: "quarterly", anchorMonth: 11, anchorDay: 10 };
    expect(occurrencesInRange(s, "2026-10-01", "2027-12-31")).toEqual(["2026-11-10", "2027-02-10", "2027-05-10", "2027-08-10", "2027-11-10"]);
    const eom: Schedule = { cadence: "quarterly", anchorMonth: 11, anchorDay: 30 };
    expect(occurrencesInRange(eom, "2026-10-13", "2027-12-31")).toEqual(["2026-11-30", "2027-02-28", "2027-05-30", "2027-08-30", "2027-11-30"]);
  });
  it("semiannual and yearly", () => {
    expect(occurrencesInRange({ cadence: "semiannual", anchorMonth: 4, anchorDay: 3 }, "2026-10-13", "2027-12-31")).toEqual(["2027-04-03", "2027-10-03"]);
    expect(occurrencesInRange({ cadence: "yearly", anchorMonth: 3, anchorDay: 14 }, "2026-10-13", "2028-12-31")).toEqual(["2027-03-14", "2028-03-14"]);
    expect(occurrencesInRange({ cadence: "yearly", anchorMonth: 11, anchorDay: 30 }, "2026-10-13", "2027-10-13")).toEqual(["2026-11-30"]);
  });
  it("bimonthly steps two months from the anchor month", () => {
    expect(occurrencesInRange({ cadence: "bimonthly", anchorMonth: 2, anchorDay: 12 }, "2026-08-13", "2027-02-28")).toEqual(["2026-10-12", "2026-12-12", "2027-02-12"]);
  });
  it("weekly and biweekly from an anchor date", () => {
    expect(occurrencesInRange({ cadence: "weekly", anchorDate: "2026-10-14" }, "2026-10-13", "2026-11-12")).toEqual(["2026-10-14", "2026-10-21", "2026-10-28", "2026-11-04", "2026-11-11"]);
    expect(occurrencesInRange({ cadence: "biweekly", anchorDate: "2026-10-16" }, "2026-10-13", "2027-01-11")).toEqual([
      "2026-10-16", "2026-10-30", "2026-11-13", "2026-11-27", "2026-12-11", "2026-12-25", "2027-01-08",
    ]);
    expect(periodIndex({ cadence: "weekly", anchorDate: "2026-10-06" }, "2026-10-13")).toEqual({ k: 1, residualDays: 0 });
    expect(periodIndex({ cadence: "biweekly", anchorDate: "2026-10-16" }, "2026-10-10")).toEqual({ k: 0, residualDays: -6 });
  });
  it("twice monthly: explicit and derived second days, clamped", () => {
    expect(occurrencesInRange({ cadence: "twice_monthly", anchorDay: 15, anchorDay2: 31 }, "2026-10-15", "2027-01-11")).toEqual([
      "2026-10-15", "2026-10-31", "2026-11-15", "2026-11-30", "2026-12-15", "2026-12-31",
    ]);
    expect(occurrencesInRange({ cadence: "twice_monthly", anchorDay: 20, anchorDay2: 5 }, "2026-10-20", "2026-12-31")).toEqual([
      "2026-10-20", "2026-11-05", "2026-11-20", "2026-12-05", "2026-12-20",
    ]);
    expect(occurrencesInRange({ cadence: "twice_monthly", anchorDay: 16 }, "2027-01-16", "2027-03-01")).toEqual(["2027-01-16", "2027-02-01", "2027-02-16", "2027-03-01"]);
    expect(occurrencesInRange({ cadence: "twice_monthly", anchorDay: 15 }, "2026-10-15", "2026-11-30")).toEqual(["2026-10-15", "2026-10-30", "2026-11-15", "2026-11-30"]);
    expect(occurrencesInRange({ cadence: "twice_monthly", anchorDay: 1, anchorDay2: 15 }, "2026-10-01", "2026-10-31")).toEqual(["2026-10-01", "2026-10-15"]);
    // Jul 31 posting for the Aug 1 payday lands in August's first slot with residual −1.
    const p = periodIndex({ cadence: "twice_monthly", anchorDay: 1, anchorDay2: 15 }, "2026-07-31");
    expect(occurrence({ cadence: "twice_monthly", anchorDay: 1, anchorDay2: 15 }, p.k)).toBe("2026-08-01");
    expect(p.residualDays).toBe(-1);
  });
  it("validates schedules", () => {
    expect(validateSchedule({ cadence: "weekly" })).toMatch(/anchorDate/);
    expect(validateSchedule({ cadence: "quarterly", anchorDay: 1 })).toMatch(/anchorMonth/);
    expect(validateSchedule({ cadence: "monthly", anchorDay: 1 })).toBeNull();
  });
});

describe("grace and costs", () => {
  it("isMissed flips the day after the grace period", () => {
    expect(isMissed("2026-10-05", "2026-10-07", "weekly")).toBe(false);
    expect(isMissed("2026-10-05", "2026-10-08", "weekly")).toBe(true);
    expect(isMissed("2026-10-05", "2026-10-10", "monthly")).toBe(false);
    expect(isMissed("2026-10-05", "2026-10-11", "monthly")).toBe(true);
    expect(isMissed("2026-10-05", "2026-10-19", "yearly")).toBe(false);
    expect(isMissed("2026-10-05", "2026-10-20", "yearly")).toBe(true);
  });
  it("yearly and monthly-equivalent costs truncate toward zero", () => {
    expect(yearlyCents(-1549n, "monthly")).toBe(-18588n);
    expect(monthlyEquivalentCents(-1549n, "monthly")).toBe(-1549n);
    expect(monthlyEquivalentCents(198765n, "biweekly")).toBe(430657n);
    expect(monthlyEquivalentCents(245000n, "twice_monthly")).toBe(490000n);
    expect(monthlyEquivalentCents(-4500n, "quarterly")).toBe(-1500n);
    expect(monthlyEquivalentCents(-11988n, "yearly")).toBe(-999n);
    expect(monthlyEquivalentCents(-54n, "yearly")).toBe(-4n);
    expect(monthlyEquivalentCents(-1000n, "weekly")).toBe(-4333n);
    expect(monthlyEquivalentCents(-61250n, "semiannual")).toBe(-10208n);
    expect(monthlyEquivalentCents(-6200n, "bimonthly")).toBe(-3100n);
  });
});
