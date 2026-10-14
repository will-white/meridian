import { describe, expect, it } from "vitest";
import { billsSummary, changePercentBp, netWorthChangeText, newAccountsNote, percentText, reviewLinks, sumCents, syncTone } from "./dashboard.js";

describe("changePercentBp / percentText", () => {
  it("truncates toward zero and handles a zero base", () => {
    // Seed: today 575000, a year ago 350000 -> change 225000 -> 225000 * 10000 / 350000 = 6428.57 -> 6428
    expect(changePercentBp(225000n, 350000n)).toBe(6428);
    expect(percentText(6428)).toBe("64.2%");
    expect(changePercentBp(-50000n, 200000n)).toBe(-2500);
    expect(percentText(-2500)).toBe("-25.0%");
    expect(changePercentBp(1n, 0n)).toBeNull();
    // A liability-heavy base: |-100000| is the divisor
    expect(changePercentBp(25000n, -100000n)).toBe(2500);
    expect(percentText(5)).toBe("0.0%");
  });
});

describe("netWorthChangeText", () => {
  it("writes the signed change with its percentage", () => {
    expect(netWorthChangeText({ yearAgoDate: "2025-10-13", yearAgoCents: "350000", changeCents: "225000" })).toEqual({ text: "+$2,250.00 (+64.2%) since 10/13/25", tone: "ok" });
    expect(netWorthChangeText({ yearAgoDate: "2025-10-13", yearAgoCents: "350000", changeCents: "-1000" })).toEqual({ text: "-$10.00 (-0.2%) since 10/13/25", tone: "bad" });
    expect(netWorthChangeText({ yearAgoDate: "2025-10-13", yearAgoCents: "0", changeCents: "1000" })).toEqual({ text: "+$10.00 since 10/13/25", tone: "ok" });
    expect(netWorthChangeText({ yearAgoDate: "2025-10-13", yearAgoCents: null, changeCents: null })).toEqual({ text: "No balances recorded as of 10/13/25 yet", tone: "neutral" });
  });
});

describe("newAccountsNote", () => {
  it("lists the accounts that have no year-old snapshot", () => {
    expect(newAccountsNote([])).toBeNull();
    expect(newAccountsNote([{ id: "a", name: "Visa" }])).toBe("Visa is newer than a year and counts as $0.00 a year ago.");
    expect(newAccountsNote([{ id: "a", name: "Visa" }, { id: "b", name: "Brokerage" }])).toBe("Visa and Brokerage are newer than a year and count as $0.00 a year ago.");
    expect(newAccountsNote([{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }])).toBe("A, B and C are newer than a year and count as $0.00 a year ago.");
  });
});

describe("bills and review", () => {
  it("sums bills due and counts the overdue ones", () => {
    const bills = [
      { recurringId: "r1", name: "Internet", categoryName: null, accountName: null, dueDate: "2026-10-20", amountCents: "-7999", overdue: false },
      { recurringId: "r2", name: "Water", categoryName: null, accountName: null, dueDate: "2026-10-10", amountCents: "-4500", overdue: true },
    ];
    expect(billsSummary(bills, "2026-10-13")).toEqual({ totalCents: "-12499", overdue: 1, windowEnd: "2026-10-27" });
    expect(sumCents([])).toBe("0");
  });

  it("links each review count to its page", () => {
    expect(reviewLinks({ uncategorized: 1, suggestedRecurring: 2, alerts: 0 }).map((l) => [l.to, l.count])).toEqual([
      ["/transactions?uncategorized=true", 1],
      ["/recurring?status=suggested", 2],
      ["/alerts", 0],
    ]);
    expect(syncTone("auth_required")).toBe("warn");
    expect(syncTone("error")).toBe("bad");
    expect(syncTone("ok")).toBe("neutral");
  });
});
