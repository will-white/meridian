import { describe, expect, it } from "vitest";
import {
  SPECIAL_CLOSURES,
  dayOfWeek,
  easterSunday,
  isTradingDay,
  lastTradingDayOnOrBefore,
  nextTradingDay,
  nyseHolidays,
  previousTradingDay,
  tradingDaysBetween,
} from "./marketCalendar.js";

/** Prices design §3.2 and test 4. */
describe("marketCalendar", () => {
  it("computes Easter by the Gregorian algorithm", () => {
    expect(easterSunday(2025)).toBe("2025-04-20");
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
    expect(easterSunday(2028)).toBe("2028-04-16");
  });
  it("lists exactly the ten rule-based holidays of 2026 and 2027", () => {
    expect(nyseHolidays(2026)).toEqual([
      "2026-01-01",
      "2026-01-19",
      "2026-02-16",
      "2026-04-03",
      "2026-05-25",
      "2026-06-19",
      "2026-07-03",
      "2026-09-07",
      "2026-11-26",
      "2026-12-25",
    ]);
    expect(nyseHolidays(2027)).toEqual([
      "2027-01-01",
      "2027-01-18",
      "2027-02-15",
      "2027-03-26",
      "2027-05-31",
      "2027-06-18",
      "2027-07-05",
      "2027-09-06",
      "2027-11-25",
      "2027-12-24",
    ]);
  });
  it("observes Sunday holidays on Monday and skips a Saturday New Year's Day", () => {
    // 2022-01-01 was a Saturday: not observed on 2021-12-31; 2023-01-01 was a Sunday: observed 2023-01-02.
    expect(nyseHolidays(2022)).not.toContain("2021-12-31");
    expect(nyseHolidays(2022)).toHaveLength(9);
    expect(nyseHolidays(2023)).toContain("2023-01-02");
    expect(nyseHolidays(2023)).toHaveLength(10);
    // 2021-12-25 Saturday → Friday 12-24; 2022-12-25 Sunday → Monday 12-26
    expect(nyseHolidays(2021)).toContain("2021-12-24");
    expect(nyseHolidays(2022)).toContain("2022-12-26");
    expect(nyseHolidays(2025)).toEqual([
      "2025-01-01",
      "2025-01-20",
      "2025-02-17",
      "2025-04-18",
      "2025-05-26",
      "2025-06-19",
      "2025-07-04",
      "2025-09-01",
      "2025-11-27",
      "2025-12-25",
    ]);
  });
  it("knows trading days (prices test 4)", () => {
    expect(isTradingDay("2026-04-03")).toBe(false); // Good Friday
    expect(isTradingDay("2026-06-19")).toBe(false);
    expect(isTradingDay("2026-07-03")).toBe(false);
    expect(isTradingDay("2026-07-06")).toBe(true);
    expect(isTradingDay("2026-10-12")).toBe(true); // Columbus Day: open
    expect(isTradingDay("2026-11-27")).toBe(true); // early close is a trading day
    expect(isTradingDay("2025-01-09")).toBe(false); // special closure
    expect(isTradingDay("2021-12-31")).toBe(true);
    expect(isTradingDay("2027-12-24")).toBe(false);
    expect(isTradingDay("2026-10-17")).toBe(false); // Saturday
    expect(isTradingDay("2026-10-18")).toBe(false); // Sunday
    expect(isTradingDay("2026-10-14")).toBe(true);
    expect(SPECIAL_CLOSURES).toContain("2025-01-09");
    expect(dayOfWeek("2026-10-14")).toBe(3);
  });
  it("walks to the last, previous and next trading days", () => {
    expect(lastTradingDayOnOrBefore("2026-04-05")).toBe("2026-04-02");
    expect(lastTradingDayOnOrBefore("2026-07-05")).toBe("2026-07-02");
    expect(lastTradingDayOnOrBefore("2026-12-27")).toBe("2026-12-24");
    expect(lastTradingDayOnOrBefore("2027-01-03")).toBe("2026-12-31");
    expect(lastTradingDayOnOrBefore("2026-10-17")).toBe("2026-10-16");
    expect(lastTradingDayOnOrBefore("2026-10-14")).toBe("2026-10-14");
    expect(previousTradingDay("2026-06-22")).toBe("2026-06-18");
    expect(previousTradingDay("2026-10-12")).toBe("2026-10-09");
    expect(previousTradingDay("2026-10-14")).toBe("2026-10-13");
    expect(nextTradingDay("2026-10-16")).toBe("2026-10-19");
    expect(nextTradingDay("2026-04-02")).toBe("2026-04-06");
    expect(nextTradingDay("2026-12-31")).toBe("2027-01-04");
  });
  it("counts trading days in (from, to]", () => {
    expect(tradingDaysBetween("2026-10-09", "2026-10-13")).toBe(2);
    expect(tradingDaysBetween("2026-10-09", "2026-10-20")).toBe(7);
    expect(tradingDaysBetween("2026-10-13", "2026-10-16")).toBe(3);
    expect(tradingDaysBetween("2026-10-13", "2026-10-13")).toBe(0);
    expect(tradingDaysBetween("2026-10-16", "2026-10-13")).toBe(0);
    expect(tradingDaysBetween("2026-04-01", "2026-04-06")).toBe(2); // 04-02 and 04-06 (Good Friday closed)
  });
});
