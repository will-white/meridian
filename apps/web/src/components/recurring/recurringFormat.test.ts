import { describe, expect, it } from "vitest";
import {
  alertLink,
  alertMessage,
  confidenceLabel,
  cycleMonths,
  dueLabel,
  expectedLabel,
  localToday,
  ordinal,
  percentLabel,
  scheduleSummary,
  shareBp,
  twiceMonthlyDays,
} from "./recurringFormat.js";

describe("ordinal", () => {
  it("handles the teens and the 1/2/3 endings", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st"]);
  });
});

describe("cycleMonths", () => {
  it("lists the months on a multi-month cycle from any anchor month", () => {
    expect(cycleMonths(10, "quarterly")).toEqual([1, 4, 7, 10]);
    expect(cycleMonths(2, "quarterly")).toEqual([2, 5, 8, 11]);
    expect(cycleMonths(9, "semiannual")).toEqual([3, 9]);
    expect(cycleMonths(12, "bimonthly")).toEqual([2, 4, 6, 8, 10, 12]);
    expect(cycleMonths(3, "yearly")).toEqual([3]);
  });
});

describe("twiceMonthlyDays", () => {
  it("derives the second day like the schedule module and sorts given days", () => {
    expect(twiceMonthlyDays(1, null)).toEqual([1, 16]);
    expect(twiceMonthlyDays(20, null)).toEqual([5, 20]);
    expect(twiceMonthlyDays(15, 31)).toEqual([15, 31]);
    expect(twiceMonthlyDays(31, 15)).toEqual([15, 31]);
  });
});

describe("scheduleSummary", () => {
  const base = { anchorDay: null, anchorDay2: null, anchorMonth: null, anchorDate: null };
  it("describes each cadence", () => {
    expect(scheduleSummary({ ...base, cadence: "monthly", anchorDay: 15 })).toBe("Monthly on the 15th");
    expect(scheduleSummary({ ...base, cadence: "monthly", anchorDay: 31 })).toBe("Monthly on the last day");
    expect(scheduleSummary({ ...base, cadence: "twice_monthly", anchorDay: 1, anchorDay2: 15 })).toBe("Twice a month on the 1st and the 15th");
    expect(scheduleSummary({ ...base, cadence: "twice_monthly", anchorDay: 15, anchorDay2: 31 })).toBe("Twice a month on the 15th and the last day");
    expect(scheduleSummary({ ...base, cadence: "quarterly", anchorDay: 5, anchorMonth: 10 })).toBe("Quarterly on the 5th (Jan, Apr, Jul, Oct)");
    expect(scheduleSummary({ ...base, cadence: "bimonthly", anchorDay: 2, anchorMonth: 1 })).toBe("Every 2 months on the 2nd (Jan, Mar, May, Jul, Sep, Nov)");
    expect(scheduleSummary({ ...base, cadence: "semiannual", anchorDay: 1, anchorMonth: 9 })).toBe("Twice a year on the 1st (Mar, Sep)");
    expect(scheduleSummary({ ...base, cadence: "yearly", anchorDay: 15, anchorMonth: 3 })).toBe("Yearly on Mar 15");
    expect(scheduleSummary({ ...base, cadence: "yearly", anchorDay: 31, anchorMonth: 12 })).toBe("Yearly at the end of Dec");
    // 2026-10-02 is a Friday.
    expect(scheduleSummary({ ...base, cadence: "biweekly", anchorDate: "2026-10-02" })).toBe("Every 2 weeks on Fridays");
    expect(scheduleSummary({ ...base, cadence: "weekly", anchorDate: "2026-10-05" })).toBe("Weekly on Mondays");
  });
  it("falls back to the cadence label when anchors are missing", () => {
    expect(scheduleSummary({ ...base, cadence: "monthly" })).toBe("Monthly");
    expect(scheduleSummary({ ...base, cadence: "weekly" })).toBe("Weekly");
  });
});

describe("dueLabel", () => {
  const today = "2026-10-13";
  it("is relative within two weeks and a date beyond", () => {
    expect(dueLabel(null, today)).toBe("—");
    expect(dueLabel("2026-10-13", today)).toBe("Due today");
    expect(dueLabel("2026-10-14", today)).toBe("Due tomorrow");
    expect(dueLabel("2026-10-18", today)).toBe("Due in 5 days");
    expect(dueLabel("2026-10-27", today)).toBe("Due in 14 days");
    expect(dueLabel("2026-10-28", today)).toBe("Due 10/28/26");
    expect(dueLabel("2026-10-12", today)).toBe("1 day past due");
    expect(dueLabel("2026-10-10", today)).toBe("3 days past due");
  });
});

describe("confidenceLabel", () => {
  it("bands the detector's score", () => {
    expect(confidenceLabel(100)).toBe("100% · high");
    expect(confidenceLabel(85)).toBe("85% · high");
    expect(confidenceLabel(70)).toBe("70% · medium");
    expect(confidenceLabel(60)).toBe("60% · low");
    expect(confidenceLabel(null)).toBe("manual");
  });
});

describe("expectedLabel", () => {
  it("shows magnitudes, with the band for variable items", () => {
    expect(expectedLabel({ expectedCents: "-1549", toleranceCents: "100", amountMode: "fixed" })).toBe("$15.49");
    expect(expectedLabel({ expectedCents: "-13380", toleranceCents: "4740", amountMode: "variable" })).toBe("~$133.80 ± $47.40");
    expect(expectedLabel({ expectedCents: "245000", toleranceCents: "0", amountMode: "variable" })).toBe("~$2,450.00");
  });
});

describe("alertMessage", () => {
  const base = { recurringName: "Netflix", payeeName: "NETFLIX.COM", dueDate: null, oldCents: null, newCents: null };
  it("renders each kind", () => {
    expect(alertMessage({ ...base, kind: "price_increase", oldCents: "-1549", newCents: "-1799" })).toBe("Netflix went up from $15.49 to $17.99 (+$2.50).");
    expect(alertMessage({ ...base, kind: "price_increase" })).toBe("Netflix changed its price.");
    expect(alertMessage({ ...base, kind: "new_recurring" })).toBe("Netflix looks like a new subscription or bill. Review it under Suggested.");
    expect(alertMessage({ ...base, kind: "missed_charge", dueDate: "2026-10-05" })).toBe("Netflix was due 10/05/26 and has not been charged.");
    expect(alertMessage({ ...base, kind: "missed_charge" })).toBe("A charge for Netflix was missed.");
    expect(alertMessage({ ...base, kind: "trial_converted", recurringName: null, newCents: "-1799" })).toBe("A free trial at NETFLIX.COM turned into a $17.99 charge.");
    expect(alertMessage({ ...base, kind: "trial_converted", recurringName: null })).toBe("A free trial at NETFLIX.COM turned into a paid charge.");
  });
  it("uses the payee when the alert has no item", () => {
    expect(alertMessage({ ...base, kind: "missed_charge", recurringName: null, dueDate: "2026-10-05" })).toBe("NETFLIX.COM was due 10/05/26 and has not been charged.");
  });
});

describe("alertLink", () => {
  it("points at the item, else the payee's transactions", () => {
    expect(alertLink({ recurringId: "11111111-1111-4111-8111-111111111111", payeeName: "Netflix" })).toEqual({ to: "/recurring?focus=11111111-1111-4111-8111-111111111111", label: "View item" });
    expect(alertLink({ recurringId: null, payeeName: "A&B Trial" })).toEqual({ to: "/transactions?q=A%26B%20Trial", label: "View transactions" });
  });
});

describe("shareBp / percentLabel", () => {
  it("is integer basis points of magnitudes, truncated", () => {
    expect(shareBp(-2160000n, -2454576n)).toBe(8799); // 87.99…%
    expect(shareBp(-18588n, -2454576n)).toBe(75); // 0.757…%
    expect(shareBp(5n, 0n)).toBe(0);
    expect(percentLabel(8799)).toBe("87.9%");
    expect(percentLabel(75)).toBe("0.7%");
    expect(percentLabel(10000)).toBe("100.0%");
  });
});

describe("localToday", () => {
  it("formats the local calendar date", () => {
    expect(localToday(new Date(2026, 9, 13, 23, 30))).toBe("2026-10-13");
    expect(localToday(new Date(2026, 0, 5, 0, 1))).toBe("2026-01-05");
  });
});
