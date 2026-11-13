import { describe, expect, it } from "vitest";
import type { CashFlowProjectionResponse } from "@meridian/shared";
import { newRecurringLink, unscheduledRows } from "./unscheduled.js";

/** Audit batch b5, finding b5-recurring-cashflow-03: the Cash flow page names what it does not forecast. */

type Item = CashFlowProjectionResponse["unscheduled"][number];
const UTIL = "11111111-1111-4111-8111-111111111111";
const PAY = "11111111-1111-4111-8111-222222222222";
const items: Item[] = [
  { month: "2026-12", categoryId: PAY, categoryName: "Paycheck", bucket: "income", amountCents: "400000" },
  { month: "2026-12", categoryId: UTIL, categoryName: "Utilities", bucket: "bills", amountCents: "15000" },
  { month: "2027-01", categoryId: UTIL, categoryName: "Utilities", bucket: "bills", amountCents: "60000" },
];

describe("unscheduledRows", () => {
  it("one row per category with its months and signed total, income in and bills out", () => {
    expect(unscheduledRows(items)).toEqual([
      { categoryId: PAY, categoryName: "Paycheck", bucket: "income", months: "Dec 2026", totalCents: "400000", link: newRecurringLink(items[0]!) },
      { categoryId: UTIL, categoryName: "Utilities", bucket: "bills", months: "Dec 2026, Jan 2027", totalCents: "-75000", link: newRecurringLink(items[1]!) },
    ]);
    expect(unscheduledRows([])).toEqual([]);
  });

  it("links to the Recurring page's add form with the category and direction filled in", () => {
    expect(newRecurringLink(items[0]!)).toBe(`/recurring?new=1&category=${PAY}&direction=inflow`);
    expect(newRecurringLink(items[1]!)).toBe(`/recurring?new=1&category=${UTIL}&direction=outflow`);
  });
});
