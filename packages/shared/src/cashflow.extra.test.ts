import { describe, expect, it } from "vitest";
import { projectCashFlow, type CashFlowAccount, type CashFlowInput, type CashFlowRecurring } from "./cashflow.js";

/** Adversarial probes of the engine beyond the design's 25 cases (review only). */

const chk: CashFlowAccount = { id: "chk", name: "chk", type: "checking", openingCents: 200000n, balanceDate: null, lowBalanceThresholdCents: null };
const card: CashFlowAccount = { id: "card", name: "card", type: "credit", openingCents: -30000n, balanceDate: null, lowBalanceThresholdCents: null };
const sav: CashFlowAccount = { id: "sav", name: "sav", type: "savings", openingCents: 500000n, balanceDate: null, lowBalanceThresholdCents: null };

function base(over: Partial<CashFlowInput>): CashFlowInput {
  return {
    today: "2026-10-13",
    horizonDays: 30,
    accounts: [chk],
    recurring: [],
    cardPayments: [],
    spendingPlan: [],
    spendingWeights: [],
    primaryAccountId: null,
    defaultThresholdCents: 0n,
    whatIfs: [],
    ...over,
  };
}

const at = (r: ReturnType<typeof projectCashFlow>, id: string, date: string) => r.accounts.find((a) => a.accountId === id)!.points[r.dates.indexOf(date)];

describe("cash-flow engine review probes", () => {
  it("A1. a skip aimed at the collapsed overdue occurrence (its original date) keeps the event unapplied", () => {
    const rent: CashFlowRecurring = { id: "rent", name: "rent", kind: "bill", accountId: "chk", transferAccountId: null, schedule: { cadence: "monthly", anchorDay: 10 }, nextDueDate: "2026-10-10", amountCents: -150000n };
    const r = projectCashFlow(base({ recurring: [rent], whatIfs: [{ kind: "skipOccurrence", recurringId: "rent", occurrenceDate: "2026-10-10" }] }));
    expect(r.whatIfs).toEqual([{ index: 0, applied: true }]);
    const ev = r.events.find((e) => e.originalDate === "2026-10-10")!;
    expect(ev).toMatchObject({ date: "2026-10-13", overdue: true, applied: false, amountCents: -150000n });
    expect(at(r, "chk", "2026-10-13")).toBe(200000n);
    expect(at(r, "chk", "2026-11-09")).toBe(200000n);
    expect(at(r, "chk", "2026-11-10")).toBe(50000n);
  });

  it("A2. a statement close that falls on today reads today's end-of-day balance (spread included)", () => {
    const r = projectCashFlow(
      base({
        horizonDays: 18,
        accounts: [chk, card],
        cardPayments: [{ cardAccountId: "card", fromAccountId: "chk", payDay: 14, statementDay: 13, knownStatementBalanceCents: null }],
        spendingPlan: [{ month: "2026-10", remainingCents: 19000n }],
        spendingWeights: [{ accountId: "card", weightCents: 1n }],
      }),
    );
    // card: −30000 − 1000 on 10-13 = −31000 → paid 31000 on 10-14.
    expect(at(r, "card", "2026-10-13")).toBe(-31000n);
    expect(at(r, "chk", "2026-10-14")).toBe(200000n - 31000n);
    expect(at(r, "card", "2026-10-14")).toBe(-31000n - 1000n + 31000n);
    expect(r.combined.points[r.dates.indexOf("2026-10-14")]).toBe(200000n - 30000n - 2000n);
    expect(r.events.filter((e) => e.kind.startsWith("card_payment")).map((e) => [e.date, e.accountId, e.amountCents])).toEqual([
      ["2026-10-14", "card", 31000n],
      ["2026-10-14", "chk", -31000n],
    ]);
  });

  it("A3. a backward 'all' shift on a stale item: the collapsed occurrence clamps to today, the next one moves into the window", () => {
    const gym: CashFlowRecurring = { id: "gym", name: "gym", kind: "bill", accountId: "chk", transferAccountId: null, schedule: { cadence: "monthly", anchorDay: 5 }, nextDueDate: "2026-07-05", amountCents: -5000n };
    const r = projectCashFlow(base({ recurring: [gym], whatIfs: [{ kind: "moveOccurrence", recurringId: "gym", shiftDays: -14 }] }));
    expect(r.events.map((e) => [e.date, e.originalDate, e.overdue, e.moved])).toEqual([
      ["2026-10-13", "2026-10-05", true, true],
      ["2026-10-22", "2026-11-05", false, true],
    ]);
    expect(at(r, "chk", "2026-11-12")).toBe(190000n);
  });

  it("A4. skipping a transfer occurrence leaves both legs unapplied and both balances untouched", () => {
    const t: CashFlowRecurring = { id: "t", name: "toSav", kind: "transfer", accountId: "chk", transferAccountId: "sav", schedule: { cadence: "monthly", anchorDay: 1 }, nextDueDate: "2026-11-01", amountCents: -50000n };
    const r = projectCashFlow(base({ accounts: [chk, sav], recurring: [t], whatIfs: [{ kind: "skipOccurrence", recurringId: "t", occurrenceDate: "2026-11-01" }] }));
    expect(r.events.map((e) => [e.accountId, e.kind, e.applied])).toEqual([
      ["chk", "transfer_out", false],
      ["sav", "transfer_in", false],
    ]);
    expect(at(r, "chk", "2026-11-12")).toBe(200000n);
    expect(at(r, "sav", "2026-11-12")).toBe(500000n);
  });

  it("A5. twice_monthly with the second day below the first collapses stale occurrences to one and continues on both days", () => {
    const tm: CashFlowRecurring = { id: "tm", name: "tm", kind: "income", accountId: "chk", transferAccountId: null, schedule: { cadence: "twice_monthly", anchorDay: 20, anchorDay2: 5 }, nextDueDate: "2026-09-20", amountCents: 1000n };
    const r = projectCashFlow(base({ recurring: [tm] }));
    expect(r.events.map((e) => [e.date, e.originalDate, e.overdue])).toEqual([
      ["2026-10-13", "2026-10-05", true],
      ["2026-10-20", "2026-10-20", false],
      ["2026-11-05", "2026-11-05", false],
    ]);
    expect(at(r, "chk", "2026-11-12")).toBe(203000n);
  });
});
