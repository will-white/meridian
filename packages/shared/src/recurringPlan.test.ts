import { describe, expect, it } from "vitest";
import { recurringPlanCounts, type RecurringPlanItem } from "./recurringPlan.js";
import type { Schedule } from "./schedule.js";

const monthly = (anchorDay: number): Schedule => ({ cadence: "monthly", anchorDay });
const counts = (item: RecurringPlanItem, from: string, to: string, today: string) => Object.fromEntries(recurringPlanCounts(item, { from, to, today }));

describe("recurringPlanCounts", () => {
  it("plans a linked charge in the month it posted, early or late (rent on the 1st)", () => {
    // Jan 1 taken Jan 2; Feb 1 taken Jan 30; Mar 1 taken Feb 27; Apr 1 still to come.
    const rent: RecurringPlanItem = { schedule: monthly(1), status: "active", expectedFrom: "2026-01-02", nextDueDate: "2026-04-01", chargeDates: ["2026-01-02", "2026-01-30", "2026-02-27"] };
    expect(counts(rent, "2026-01", "2026-04", "2026-03-20")).toEqual({ "2026-01": 2, "2026-02": 1, "2026-04": 1 });
  });

  it("does the same for a twice-monthly salary paid before weekends", () => {
    const salary: RecurringPlanItem = {
      schedule: { cadence: "twice_monthly", anchorDay: 1, anchorDay2: 15 },
      status: "active",
      expectedFrom: "2026-01-02",
      nextDueDate: "2026-04-01",
      chargeDates: ["2026-01-02", "2026-01-15", "2026-01-30", "2026-02-13", "2026-02-27", "2026-03-13"],
    };
    // Jan: 2, 15, 30 | Feb: 13, 27 | Mar: 13 (the Mar 1 and Mar 15 paydays are both paid) | Apr: 1 and 15 to come.
    expect(counts(salary, "2026-01", "2026-04", "2026-03-20")).toEqual({ "2026-01": 3, "2026-02": 2, "2026-03": 1, "2026-04": 2 });
  });

  it("keeps what a paused or cancelled item was paid and plans nothing ahead", () => {
    const gym: RecurringPlanItem = { schedule: monthly(8), status: "paused", expectedFrom: "2027-01-12", nextDueDate: "2027-02-08", chargeDates: ["2027-01-08"] };
    expect(counts(gym, "2027-01", "2027-03", "2027-01-20")).toEqual({ "2027-01": 1 });
    expect(counts({ ...gym, status: "cancelled", nextDueDate: null }, "2027-01", "2027-03", "2027-01-20")).toEqual({ "2027-01": 1 });
  });

  it("does not back-fill the months an item was on hold when it resumes", () => {
    // Paid Jan 8, on hold Jan 20 to Apr 3: February and March stay empty; Apr 8 and May 8 are expected.
    const gym: RecurringPlanItem = { schedule: monthly(8), status: "active", expectedFrom: "2027-04-03", nextDueDate: "2027-04-08", chargeDates: ["2027-01-08"] };
    expect(counts(gym, "2027-01", "2027-05", "2027-04-03")).toEqual({ "2027-01": 1, "2027-04": 1, "2027-05": 1 });
  });

  it("holds an overdue occurrence from last month in the current month while it is awaited", () => {
    // Due Jan 30, not posted by Feb 1 (inside the grace): February holds it next to its own Feb 28 occurrence.
    const water: RecurringPlanItem = { schedule: monthly(30), status: "active", expectedFrom: "2027-01-05", nextDueDate: "2027-01-30", chargeDates: [] };
    expect(counts(water, "2027-01", "2027-03", "2027-02-01")).toEqual({ "2027-02": 2, "2027-03": 1 });
    // Once the refresh writes it off (next due moves to Feb 28) it is planned nowhere.
    expect(counts({ ...water, nextDueDate: "2027-02-28" }, "2027-01", "2027-03", "2027-02-10")).toEqual({ "2027-02": 1, "2027-03": 1 });
    // It posted on Feb 2: a February charge, and the Feb 28 occurrence is still to come.
    expect(counts({ ...water, nextDueDate: "2027-02-28", chargeDates: ["2027-02-02"] }, "2027-01", "2027-03", "2027-02-03")).toEqual({ "2027-02": 2, "2027-03": 1 });
  });

  it("keeps a missed occurrence planned for the rest of its own month", () => {
    // Due Jan 5, nothing posted by Jan 20 (missed, next due Feb 5): January still holds the bill back.
    const net: RecurringPlanItem = { schedule: monthly(5), status: "active", expectedFrom: "2026-12-05", nextDueDate: "2027-02-05", chargeDates: ["2026-12-05"] };
    expect(counts(net, "2026-12", "2027-02", "2027-01-20")).toEqual({ "2026-12": 1, "2027-01": 1, "2027-02": 1 });
  });

  it("expects nothing before the day the item began: a bill on the 5th created on the 12th starts next month", () => {
    const net: RecurringPlanItem = { schedule: monthly(5), status: "active", expectedFrom: "2027-01-12", nextDueDate: "2027-02-05", chargeDates: [] };
    expect(counts(net, "2027-01", "2027-02", "2027-01-12")).toEqual({ "2027-02": 1 });
    // ...unless this month's charge is found and linked.
    expect(counts({ ...net, chargeDates: ["2027-01-05"] }, "2027-01", "2027-02", "2027-01-12")).toEqual({ "2027-01": 1, "2027-02": 1 });
  });

  it("lands quarterly and weekly occurrences in their own months", () => {
    const water: RecurringPlanItem = { schedule: { cadence: "quarterly", anchorDay: 15, anchorMonth: 2 }, status: "active", expectedFrom: "2027-01-12", nextDueDate: "2027-02-15", chargeDates: [] };
    expect(counts(water, "2027-01", "2027-05", "2027-01-12")).toEqual({ "2027-02": 1, "2027-05": 1 });
    // Fridays from 2027-01-01: Jan 1 and 8 paid; Jan 15, 22, 29 and Feb 5, 12, 19, 26 to come.
    const allowance: RecurringPlanItem = { schedule: { cadence: "weekly", anchorDate: "2027-01-01" }, status: "active", expectedFrom: "2027-01-01", nextDueDate: "2027-01-15", chargeDates: ["2027-01-01", "2027-01-08"] };
    expect(counts(allowance, "2027-01", "2027-02", "2027-01-12")).toEqual({ "2027-01": 5, "2027-02": 4 });
  });

  it("counts both twice-monthly occurrences when they clamp to the same day", () => {
    // The 30th and the 31st both fall on Feb 28, 2027; one is paid, the other still expected.
    const item: RecurringPlanItem = { schedule: { cadence: "twice_monthly", anchorDay: 30, anchorDay2: 31 }, status: "active", expectedFrom: "2027-02-01", nextDueDate: "2027-02-28", chargeDates: [] };
    expect(counts(item, "2027-02", "2027-02", "2027-02-10")).toEqual({ "2027-02": 2 });
    expect(counts({ ...item, chargeDates: ["2027-02-28"] }, "2027-02", "2027-02", "2027-02-28")).toEqual({ "2027-02": 2 });
  });

  it("gives completed months only their charges, and an item without a usable schedule only its charges", () => {
    const rent: RecurringPlanItem = { schedule: monthly(1), status: "active", expectedFrom: "2026-01-02", nextDueDate: "2026-04-01", chargeDates: ["2026-01-02", "2026-01-30", "2026-02-27"] };
    expect(counts(rent, "2026-01", "2026-02", "2026-03-20")).toEqual({ "2026-01": 2, "2026-02": 1 });
    expect(counts({ ...rent, schedule: { cadence: "monthly" } }, "2026-01", "2026-04", "2026-03-20")).toEqual({ "2026-01": 2, "2026-02": 1 });
    expect(counts(rent, "2026-04", "2026-03", "2026-03-20")).toEqual({});
  });

  it("skips an occurrence that was already paid early when planning a future range", () => {
    // Today Feb 28: the Mar 1 rent posted on Feb 27, so March expects nothing.
    const rent: RecurringPlanItem = { schedule: monthly(1), status: "active", expectedFrom: "2026-01-02", nextDueDate: "2026-04-01", chargeDates: ["2026-02-27"] };
    expect(counts(rent, "2026-03", "2026-04", "2026-02-28")).toEqual({ "2026-04": 1 });
  });
});
