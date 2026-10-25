import { describe, expect, it } from "vitest";
import {
  awaitingReconcileText,
  billsSummary,
  breakdownText,
  changePercentBp,
  fidelityCountsText,
  investmentsDayChangeText,
  netWorthChangeText,
  newAccountsNote,
  percentText,
  priceFeedText,
  reviewLinks,
  securitiesReviewText,
  staleAccountsText,
  sumCents,
  syncTone,
} from "./dashboard.js";

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

describe("investments block (Phase 3)", () => {
  it("writes the net-worth breakdown line", () => {
    expect(breakdownText({ investmentsCents: "4525200", investmentsAsOf: "2026-10-13", cashCents: "500000", debtCents: "0", otherCents: "0" })).toBe("Investments $45,252.00 (as of 10/13/26) · Cash $5,000.00 · Debt $0.00");
    expect(breakdownText({ investmentsCents: "0", investmentsAsOf: null, cashCents: "620000", debtCents: "-45000", otherCents: "1000000" })).toBe("Investments $0.00 · Cash $6,200.00 · Debt -$450.00 · Other $10,000.00");
  });

  it("counts fidelities and spells the day change", () => {
    expect(fidelityCountsText({ balance_only: 0, positions: 1, full_history: 1 })).toBe("2 accounts: 1 full history, 1 positions");
    expect(fidelityCountsText({ balance_only: 1, positions: 0, full_history: 0 })).toBe("1 account: 1 balance only");
    expect(fidelityCountsText({ balance_only: 0, positions: 0, full_history: 0 })).toBe("0 accounts");
    expect(investmentsDayChangeText({ dayChangeCents: "36000", dayChangeBp: 80 })).toEqual({ text: "+$360.00 (+0.8%) today", tone: "ok" });
    expect(investmentsDayChangeText({ dayChangeCents: "-1200", dayChangeBp: -3 })).toEqual({ text: "-$12.00 (-0.0%) today", tone: "bad" });
    expect(investmentsDayChangeText({ dayChangeCents: "0", dayChangeBp: 0 })).toEqual({ text: "$0.00 (0.0%) today", tone: "neutral" });
    expect(investmentsDayChangeText({ dayChangeCents: null, dayChangeBp: null })).toEqual({ text: "No day change yet: prices or positions are pending", tone: "neutral" });
  });

  it("writes the attention lines", () => {
    expect(awaitingReconcileText(0)).toBeNull();
    expect(awaitingReconcileText(1)).toBe("1 account not yet checked against a statement");
    expect(awaitingReconcileText(2)).toBe("2 accounts not yet checked against a statement");
    expect(securitiesReviewText(0)).toBeNull();
    expect(securitiesReviewText(1)).toBe("1 security to review");
    expect(securitiesReviewText(3)).toBe("3 securities to review");
    expect(staleAccountsText([])).toBeNull();
    expect(staleAccountsText([{ id: "a", name: "Old 401k", valuationDate: "2026-10-01" }, { id: "b", name: "Roth", valuationDate: null }])).toBe("Stale: Old 401k (10/01/26), Roth (no value)");
  });

  it("describes the price feed's health", () => {
    expect(priceFeedText({ configured: false, expectedDate: "2026-10-13", stale: 0, notFound: 0, error: 0 })).toEqual({ text: "Price feed not configured: values use statement, implied and manual prices", tone: "neutral" });
    expect(priceFeedText({ configured: true, expectedDate: "2026-10-13", stale: 0, notFound: 0, error: 0 })).toEqual({ text: "Price feed current through 10/13/26", tone: "ok" });
    expect(priceFeedText({ configured: true, expectedDate: "2026-10-13", stale: 2, notFound: 1, error: 0 })).toEqual({ text: "Price feed behind 10/13/26: 2 stale, 1 not found", tone: "bad" });
  });
});
