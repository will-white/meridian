import { describe, expect, it } from "vitest";
import {
  projectCashFlow,
  spreadEvenly,
  splitByWeights,
  type CashFlowAccount,
  type CashFlowInput,
  type CashFlowRecurring,
  type CashFlowResult,
  type RecurringKind,
} from "./cashflow.js";
import { addDays, dayDiff, type IsoDate } from "./dates.js";
import type { AccountType } from "./enums.js";
import { occurrencesInRange, type Schedule } from "./schedule.js";

/** Hand-calculated cases from docs/design/phase-2/cashflow.md, translated to schedules per docs/phase-2-plan.md §14. */

const TODAY = "2026-10-13";

function acct(id: string, type: AccountType, openingCents: bigint, lowBalanceThresholdCents: bigint | null = null): CashFlowAccount {
  return { id, name: id, type, openingCents, balanceDate: TODAY, lowBalanceThresholdCents };
}

function rec(
  id: string,
  kind: RecurringKind,
  accountId: string,
  schedule: Schedule,
  nextDueDate: IsoDate,
  amountCents: bigint,
  transferAccountId: string | null = null,
): CashFlowRecurring {
  return { id, name: id, kind, accountId, transferAccountId, schedule, nextDueDate, amountCents };
}

function run(over: Partial<CashFlowInput>): CashFlowResult {
  return projectCashFlow({
    today: TODAY,
    horizonDays: 90,
    accounts: [],
    recurring: [],
    cardPayments: [],
    spendingPlan: [],
    spendingWeights: [],
    primaryAccountId: null,
    defaultThresholdCents: 0n,
    whatIfs: [],
    ...over,
  });
}

function series(r: CashFlowResult, id: string) {
  if (id === "combined") return r.combined;
  const s = r.accounts.find((a) => a.accountId === id);
  if (!s) throw new Error(`no series ${id}`);
  return s;
}

function at(r: CashFlowResult, id: string, date: IsoDate): bigint {
  const p = series(r, id).points[dayDiff(r.today, date)];
  if (p === undefined) throw new Error(`no point on ${date}`);
  return p;
}

/** Every end-of-day balance in [from, to] equals `value`. */
function expectFlat(r: CashFlowResult, id: string, from: IsoDate, to: IsoDate, value: bigint): void {
  for (let d = from; d <= to; d = addDays(d, 1)) expect(at(r, id, d), `${id} on ${d}`).toBe(value);
}

const PAY = rec("pay", "income", "chk", { cadence: "biweekly", anchorDate: "2026-10-16" }, "2026-10-16", 200_000n);
const RENT = rec("rent", "bill", "chk", { cadence: "monthly", anchorDay: 1 }, "2026-11-01", -150_000n);
const test1 = (): Partial<CashFlowInput> => ({ accounts: [acct("chk", "checking", 250_000n)], recurring: [PAY, RENT] });
const PAYDAYS = ["2026-10-16", "2026-10-30", "2026-11-13", "2026-11-27", "2026-12-11", "2026-12-25", "2027-01-08"];

describe("projectCashFlow", () => {
  it("1. checking with one biweekly paycheck and one monthly rent over 90 days", () => {
    const r = run(test1());
    expect(r.endDate).toBe("2027-01-11");
    expect(r.dates).toHaveLength(91);
    expect(r.dates[0]).toBe(TODAY);
    expect(r.dates[90]).toBe("2027-01-11");
    expect(r.events.filter((e) => e.recurringId === "pay").map((e) => e.date)).toEqual(PAYDAYS);
    expect(r.events.filter((e) => e.recurringId === "rent").map((e) => e.date)).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
    expect(r.events).toHaveLength(10);
    expect(r.events.every((e) => e.applied && !e.overdue && !e.moved)).toBe(true);
    expectFlat(r, "chk", "2026-10-13", "2026-10-15", 250_000n);
    expectFlat(r, "chk", "2026-10-16", "2026-10-29", 450_000n);
    expectFlat(r, "chk", "2026-10-30", "2026-10-31", 650_000n);
    expectFlat(r, "chk", "2026-11-01", "2026-11-12", 500_000n);
    expectFlat(r, "chk", "2026-11-13", "2026-11-26", 700_000n);
    expectFlat(r, "chk", "2026-11-27", "2026-11-30", 900_000n);
    expectFlat(r, "chk", "2026-12-01", "2026-12-10", 750_000n);
    expectFlat(r, "chk", "2026-12-11", "2026-12-24", 950_000n);
    expectFlat(r, "chk", "2026-12-25", "2026-12-31", 1_150_000n);
    expectFlat(r, "chk", "2027-01-01", "2027-01-07", 1_000_000n);
    expectFlat(r, "chk", "2027-01-08", "2027-01-11", 1_200_000n);
    const chk = series(r, "chk");
    expect(chk.minCents).toBe(250_000n);
    expect(chk.minDate).toBe("2026-10-13");
    expect(chk.firstBelowThresholdDate).toBeNull();
    expect(chk.alreadyBelow).toBe(false);
    expect(chk.thresholdCents).toBe(0n);
    expect(r.combined.points).toEqual(chk.points);
    expect(r.combined.openingCents).toBe(250_000n);
    expect(r.spreads).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("2. quarterly bill inside the horizon with month-end clamping", () => {
    const water = rec("water", "bill", "chk", { cadence: "quarterly", anchorMonth: 11, anchorDay: 30 }, "2026-11-30", -9_000n);
    const r = run({ horizonDays: 150, accounts: [acct("chk", "checking", 100_000n)], recurring: [water] });
    expect(r.endDate).toBe("2027-03-12");
    expect(r.dates).toHaveLength(151);
    expect(r.events.map((e) => e.date)).toEqual(["2026-11-30", "2027-02-28"]);
    expectFlat(r, "chk", "2026-10-13", "2026-11-29", 100_000n);
    expectFlat(r, "chk", "2026-11-30", "2027-02-27", 91_000n);
    expectFlat(r, "chk", "2027-02-28", "2027-03-12", 82_000n);
    expect(occurrencesInRange(water.schedule, "2026-10-13", "2027-12-31")).toEqual(["2026-11-30", "2027-02-28", "2027-05-30", "2027-08-30", "2027-11-30"]);
    expect(occurrencesInRange({ cadence: "weekly", anchorDate: "2026-10-14" }, "2026-10-13", "2026-11-12")).toEqual([
      "2026-10-14",
      "2026-10-21",
      "2026-10-28",
      "2026-11-04",
      "2026-11-11",
    ]);
  });

  const cardAccounts = () => [acct("chk", "checking", 300_000n), acct("card", "credit", -45_000n)];

  it("3. credit-card payment with a statement day: a transfer between two accounts, combined unchanged", () => {
    const r = run({
      horizonDays: 60,
      accounts: cardAccounts(),
      cardPayments: [{ cardAccountId: "card", fromAccountId: "chk", payDay: 25, statementDay: 5, knownStatementBalanceCents: -40_000n }],
    });
    expect(r.endDate).toBe("2026-12-12");
    expect(r.dates).toHaveLength(61);
    expectFlat(r, "chk", "2026-10-13", "2026-10-24", 300_000n);
    expectFlat(r, "chk", "2026-10-25", "2026-11-24", 260_000n);
    expectFlat(r, "chk", "2026-11-25", "2026-12-12", 255_000n);
    expectFlat(r, "card", "2026-10-13", "2026-10-24", -45_000n);
    expectFlat(r, "card", "2026-10-25", "2026-11-24", -5_000n);
    expectFlat(r, "card", "2026-11-25", "2026-12-12", 0n);
    expectFlat(r, "combined", "2026-10-13", "2026-12-12", 255_000n);
    expect(r.events).toHaveLength(4);
    expect(r.events.map((e) => [e.date, e.accountId, e.kind, e.amountCents])).toEqual([
      ["2026-10-25", "card", "card_payment_in", 40_000n],
      ["2026-10-25", "chk", "card_payment_out", -40_000n],
      ["2026-11-25", "card", "card_payment_in", 5_000n],
      ["2026-11-25", "chk", "card_payment_out", -5_000n],
    ]);
    expect(series(r, "card").thresholdCents).toBeNull();
    for (const s of [...r.accounts, r.combined]) expect(s.firstBelowThresholdDate).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it("4. card payment with statementDay null pays the balance as of the day before", () => {
    const r = run({
      horizonDays: 30,
      accounts: cardAccounts(),
      cardPayments: [{ cardAccountId: "card", fromAccountId: "chk", payDay: 25, statementDay: null, knownStatementBalanceCents: null }],
    });
    expect(r.endDate).toBe("2026-11-12");
    expect(r.dates).toHaveLength(31);
    expectFlat(r, "chk", "2026-10-13", "2026-10-24", 300_000n);
    expectFlat(r, "chk", "2026-10-25", "2026-11-12", 255_000n);
    expectFlat(r, "card", "2026-10-13", "2026-10-24", -45_000n);
    expectFlat(r, "card", "2026-10-25", "2026-11-12", 0n);
    expectFlat(r, "combined", "2026-10-13", "2026-11-12", 255_000n);
    expect(r.events).toHaveLength(2);
    expect(r.events.map((e) => e.amountCents)).toEqual([45_000n, -45_000n]);
  });

  it("5. spending spread with a cent remainder across the current and a full future month", () => {
    const r = run({
      horizonDays: 45,
      accounts: [acct("chk", "checking", 100_000n)],
      primaryAccountId: "chk",
      spendingPlan: [
        { month: "2026-10", remainingCents: 25_000n },
        { month: "2026-11", remainingCents: 40_000n },
      ],
    });
    expect(r.endDate).toBe("2026-11-27");
    expect(at(r, "chk", "2026-10-13")).toBe(98_684n);
    expect(at(r, "chk", "2026-10-14")).toBe(97_368n);
    expect(at(r, "chk", "2026-10-27")).toBe(80_260n);
    expect(at(r, "chk", "2026-10-28")).toBe(78_945n);
    expect(at(r, "chk", "2026-10-31")).toBe(75_000n);
    expect(at(r, "chk", "2026-11-01")).toBe(73_666n);
    expect(at(r, "chk", "2026-11-10")).toBe(61_660n);
    expect(at(r, "chk", "2026-11-11")).toBe(60_327n);
    expect(at(r, "chk", "2026-11-27")).toBe(38_999n);
    expect(r.spreads).toEqual([
      { month: "2026-10", accountId: "chk", totalCents: 25_000n, windowStart: "2026-10-13", days: 19, baseCents: 1_315n, extraCentDays: 15 },
      { month: "2026-11", accountId: "chk", totalCents: 40_000n, windowStart: "2026-11-01", days: 30, baseCents: 1_333n, extraCentDays: 10 },
    ]);
    expect(r.events).toEqual([]);
  });

  it("6. spending split across accounts by largest remainder, then spread per account; a card without a payment day warns", () => {
    const r = run({
      horizonDays: 18,
      accounts: [acct("chk", "checking", 100_000n), acct("card", "credit", -45_000n)],
      spendingPlan: [{ month: "2026-10", remainingCents: 25_000n }],
      spendingWeights: [
        { accountId: "chk", weightCents: 20_000n },
        { accountId: "card", weightCents: 10_000n },
      ],
    });
    expect(r.endDate).toBe("2026-10-31");
    expect(at(r, "chk", "2026-10-13")).toBe(99_122n);
    expect(at(r, "chk", "2026-10-16")).toBe(96_488n);
    expect(at(r, "chk", "2026-10-17")).toBe(95_611n);
    expect(at(r, "chk", "2026-10-23")).toBe(90_349n);
    expect(at(r, "chk", "2026-10-31")).toBe(83_333n);
    expect(at(r, "card", "2026-10-13")).toBe(-45_439n);
    expect(at(r, "card", "2026-10-23")).toBe(-49_829n);
    expect(at(r, "card", "2026-10-24")).toBe(-50_267n);
    expect(at(r, "card", "2026-10-31")).toBe(-53_333n);
    expect(at(r, "combined", "2026-10-31")).toBe(30_000n);
    expect(r.spreads).toEqual([
      { month: "2026-10", accountId: "chk", totalCents: 16_667n, windowStart: "2026-10-13", days: 19, baseCents: 877n, extraCentDays: 4 },
      { month: "2026-10", accountId: "card", totalCents: 8_333n, windowStart: "2026-10-13", days: 19, baseCents: 438n, extraCentDays: 11 },
    ]);
    expect(r.warnings).toContain("card card has no payment day");
  });

  it("7. low-balance threshold: the first crossing is strict, the minimum is separate, combined uses the default", () => {
    const r = run({
      horizonDays: 30,
      accounts: [acct("chk", "checking", 60_000n, 50_000n)],
      recurring: [
        rec("pay", "income", "chk", { cadence: "biweekly", anchorDate: "2026-10-30" }, "2026-10-30", 200_000n),
        RENT,
      ],
      primaryAccountId: "chk",
      spendingPlan: [
        { month: "2026-10", remainingCents: 19_000n },
        { month: "2026-11", remainingCents: 0n },
      ],
    });
    expect(at(r, "chk", "2026-10-13")).toBe(59_000n);
    expect(at(r, "chk", "2026-10-22")).toBe(50_000n);
    expect(at(r, "chk", "2026-10-23")).toBe(49_000n);
    expect(at(r, "chk", "2026-10-29")).toBe(43_000n);
    expect(at(r, "chk", "2026-10-30")).toBe(242_000n);
    expect(at(r, "chk", "2026-10-31")).toBe(241_000n);
    expectFlat(r, "chk", "2026-11-01", "2026-11-12", 91_000n);
    const chk = series(r, "chk");
    expect(chk.thresholdCents).toBe(50_000n);
    expect(chk.firstBelowThresholdDate).toBe("2026-10-23");
    expect(chk.minCents).toBe(43_000n);
    expect(chk.minDate).toBe("2026-10-29");
    expect(chk.alreadyBelow).toBe(false);
    expect(r.combined.thresholdCents).toBe(0n);
    expect(r.combined.firstBelowThresholdDate).toBeNull();
    expect(r.combined.minCents).toBe(43_000n);
  });

  it("8. what-if: skip one rent occurrence; skipping a non-occurrence is reported, not applied", () => {
    const r = run({
      ...test1(),
      whatIfs: [
        { kind: "skipOccurrence", recurringId: "rent", occurrenceDate: "2026-12-01" },
        { kind: "skipOccurrence", recurringId: "rent", occurrenceDate: "2026-12-02" },
      ],
    });
    expect(at(r, "chk", "2026-11-30")).toBe(900_000n);
    expect(at(r, "chk", "2026-12-01")).toBe(900_000n);
    expect(at(r, "chk", "2026-12-11")).toBe(1_100_000n);
    expect(at(r, "chk", "2026-12-25")).toBe(1_300_000n);
    expect(at(r, "chk", "2027-01-01")).toBe(1_150_000n);
    expectFlat(r, "chk", "2027-01-08", "2027-01-11", 1_350_000n);
    expect(r.events).toHaveLength(10);
    const skipped = r.events.find((e) => e.recurringId === "rent" && e.date === "2026-12-01");
    expect(skipped).toMatchObject({ applied: false, amountCents: -150_000n, kind: "bill", originalDate: "2026-12-01" });
    expect(r.whatIfs).toEqual([
      { index: 0, applied: true },
      { index: 1, applied: false, reason: "no occurrence of rent on 2026-12-02" },
    ]);
  });

  it("9a. what-if: move one payday +4", () => {
    const r = run({ ...test1(), whatIfs: [{ kind: "moveOccurrence", recurringId: "pay", shiftDays: 4, occurrenceDate: "2026-10-16" }] });
    expectFlat(r, "chk", "2026-10-16", "2026-10-19", 250_000n);
    expect(at(r, "chk", "2026-10-20")).toBe(450_000n);
    expect(at(r, "chk", "2026-10-30")).toBe(650_000n);
    expect(at(r, "chk", "2027-01-11")).toBe(1_200_000n);
    const paychecks = r.events.filter((e) => e.recurringId === "pay");
    expect(paychecks).toHaveLength(7);
    const moved = paychecks.find((e) => e.moved);
    expect(moved).toMatchObject({ moved: true, originalDate: "2026-10-16", date: "2026-10-20", overdue: false, applied: true });
    expect(paychecks.filter((e) => e.moved)).toHaveLength(1);
    expect(r.whatIfs).toEqual([{ index: 0, applied: true }]);
  });

  it("9b. what-if: shift all paydays +3 (the last one lands exactly on endDate)", () => {
    const r = run({ ...test1(), whatIfs: [{ kind: "moveOccurrence", recurringId: "pay", shiftDays: 3 }] });
    expect(r.events.filter((e) => e.recurringId === "pay").map((e) => e.date)).toEqual([
      "2026-10-19",
      "2026-11-02",
      "2026-11-16",
      "2026-11-30",
      "2026-12-14",
      "2026-12-28",
      "2027-01-11",
    ]);
    expect(r.events.filter((e) => e.recurringId === "pay").every((e) => e.moved)).toBe(true);
    expect(at(r, "chk", "2026-10-18")).toBe(250_000n);
    expect(at(r, "chk", "2026-10-19")).toBe(450_000n);
    expect(at(r, "chk", "2026-11-01")).toBe(300_000n);
    expect(at(r, "chk", "2026-11-02")).toBe(500_000n);
    expect(at(r, "chk", "2027-01-10")).toBe(1_000_000n);
    expect(at(r, "chk", "2027-01-11")).toBe(1_200_000n);
    expect(r.whatIfs).toEqual([{ index: 0, applied: true }]);
  });

  it("10. what-if: shift all paydays −14 pulls an occurrence into the horizon and clamps one to today", () => {
    const r = run({ ...test1(), whatIfs: [{ kind: "moveOccurrence", recurringId: "pay", shiftDays: -14 }] });
    const paychecks = r.events.filter((e) => e.recurringId === "pay");
    expect(paychecks).toHaveLength(8);
    expect(paychecks[0]).toMatchObject({ date: "2026-10-13", originalDate: "2026-10-16", overdue: true, moved: true, applied: true });
    expect(paychecks.map((e) => e.date)).toEqual(["2026-10-13", "2026-10-16", "2026-10-30", "2026-11-13", "2026-11-27", "2026-12-11", "2026-12-25", "2027-01-08"]);
    expect(paychecks[7]).toMatchObject({ originalDate: "2027-01-22", overdue: false, moved: true });
    expect(at(r, "chk", "2026-10-13")).toBe(450_000n);
    expect(at(r, "chk", "2026-10-16")).toBe(650_000n);
    expectFlat(r, "chk", "2027-01-08", "2027-01-11", 1_400_000n);
    expect(series(r, "chk").minCents).toBe(450_000n);
    expect(series(r, "chk").minDate).toBe("2026-10-13");
  });

  it("11. what-if: a one-time expense, plus out-of-range and non-projected one-time items", () => {
    const r = run({
      ...test1(),
      whatIfs: [
        { kind: "oneTime", date: "2026-11-20", amountCents: -80_000n, accountId: "chk" },
        { kind: "oneTime", date: "2026-10-01", amountCents: -1_000n, accountId: "chk" },
        { kind: "oneTime", date: "2027-02-01", amountCents: -1_000n, accountId: "chk" },
        { kind: "oneTime", date: "2026-11-01", amountCents: -1_000n, accountId: "brk" },
      ],
    });
    expect(at(r, "chk", "2026-10-13")).toBe(249_000n);
    expect(at(r, "chk", "2026-11-19")).toBe(699_000n);
    expectFlat(r, "chk", "2026-11-20", "2026-11-26", 619_000n);
    expect(at(r, "chk", "2026-11-27")).toBe(819_000n);
    expect(at(r, "chk", "2027-01-11")).toBe(1_119_000n);
    expect(r.whatIfs).toEqual([
      { index: 0, applied: true },
      { index: 1, applied: true, reason: "moved to today" },
      { index: 2, applied: false, reason: "after horizon" },
      { index: 3, applied: false, reason: "account not projected" },
    ]);
    const oneTime = r.events.filter((e) => e.kind === "one_time");
    expect(oneTime).toHaveLength(2);
    expect(oneTime[0]).toMatchObject({ date: "2026-10-13", originalDate: "2026-10-01", amountCents: -1_000n, accountId: "chk", applied: true, moved: true });
    expect(oneTime[1]).toMatchObject({ date: "2026-11-20", originalDate: "2026-11-20", amountCents: -80_000n, accountId: "chk", applied: true, moved: false });
    expect(r.events).toHaveLength(12);
  });

  it("12. twelve-month horizon with a yearly item and a monthly item anchored on the 31st", () => {
    const r = run({
      horizonDays: 365,
      accounts: [acct("chk", "checking", 500_000n)],
      recurring: [
        rec("ins", "bill", "chk", { cadence: "yearly", anchorMonth: 11, anchorDay: 30 }, "2026-11-30", -120_000n),
        rec("m31", "bill", "chk", { cadence: "monthly", anchorDay: 31 }, "2026-10-31", -1_000n),
      ],
    });
    expect(r.endDate).toBe("2027-10-13");
    expect(r.dates).toHaveLength(366);
    expect(r.events.filter((e) => e.recurringId === "ins").map((e) => e.date)).toEqual(["2026-11-30"]);
    expect(r.events.filter((e) => e.recurringId === "m31").map((e) => e.date)).toEqual([
      "2026-10-31",
      "2026-11-30",
      "2026-12-31",
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
      "2027-05-31",
      "2027-06-30",
      "2027-07-31",
      "2027-08-31",
      "2027-09-30",
    ]);
    expect(r.events).toHaveLength(13);
    expect(at(r, "chk", "2026-10-13")).toBe(500_000n);
    expect(at(r, "chk", "2026-10-31")).toBe(499_000n);
    expect(at(r, "chk", "2026-11-30")).toBe(378_000n);
    expect(at(r, "chk", "2027-02-28")).toBe(375_000n);
    expect(at(r, "chk", "2027-09-30")).toBe(368_000n);
    expect(at(r, "chk", "2027-10-13")).toBe(368_000n);
    expect(series(r, "chk").minCents).toBe(368_000n);
    expect(series(r, "chk").minDate).toBe("2027-09-30");
  });

  it("13. an account with no recurring items stays flat and still joins the combined sum", () => {
    const base = test1();
    const r = run({ ...base, accounts: [...(base.accounts ?? []), acct("sav", "savings", 1_000_000n)] });
    const sav = series(r, "sav");
    expect(sav.points).toHaveLength(91);
    expect(sav.points.every((p) => p === 1_000_000n)).toBe(true);
    expect(sav.minCents).toBe(1_000_000n);
    expect(sav.minDate).toBe("2026-10-13");
    expect(sav.firstBelowThresholdDate).toBeNull();
    expect(sav.alreadyBelow).toBe(false);
    expect(sav.thresholdCents).toBe(0n);
    expect(at(r, "combined", "2026-10-13")).toBe(1_250_000n);
    expect(at(r, "combined", "2026-10-16")).toBe(1_450_000n);
    expect(at(r, "combined", "2027-01-11")).toBe(2_200_000n);
  });

  it("14. a partial last month keeps the full-month per-day rate", () => {
    const r = run({
      horizonDays: 20,
      accounts: [acct("chk", "checking", 100_000n)],
      primaryAccountId: "chk",
      spendingPlan: [
        { month: "2026-10", remainingCents: 19_000n },
        { month: "2026-11", remainingCents: 31_000n },
      ],
    });
    expect(r.endDate).toBe("2026-11-02");
    expect(at(r, "chk", "2026-10-31")).toBe(81_000n);
    expect(at(r, "chk", "2026-11-01")).toBe(79_966n);
    expect(at(r, "chk", "2026-11-02")).toBe(78_932n);
    expect(r.spreads[1]).toEqual({ month: "2026-11", accountId: "chk", totalCents: 31_000n, windowStart: "2026-11-01", days: 30, baseCents: 1_033n, extraCentDays: 10 });
  });

  it("15a. a 3-day-late rent rolls to today", () => {
    const r = run({
      accounts: [acct("chk", "checking", 200_000n)],
      recurring: [rec("rent", "bill", "chk", { cadence: "monthly", anchorDay: 10 }, "2026-10-10", -150_000n)],
    });
    expect(r.events.map((e) => [e.date, e.originalDate, e.overdue])).toEqual([
      ["2026-10-13", "2026-10-10", true],
      ["2026-11-10", "2026-11-10", false],
      ["2026-12-10", "2026-12-10", false],
      ["2027-01-10", "2027-01-10", false],
    ]);
    expectFlat(r, "chk", "2026-10-13", "2026-11-09", 50_000n);
    expect(at(r, "chk", "2026-11-10")).toBe(-100_000n);
    expectFlat(r, "chk", "2027-01-10", "2027-01-11", -400_000n);
    const chk = series(r, "chk");
    expect(chk.firstBelowThresholdDate).toBe("2026-11-10");
    expect(chk.minCents).toBe(-400_000n);
    expect(chk.minDate).toBe("2027-01-10");
    expect(chk.alreadyBelow).toBe(false);
  });

  it("15b. a 3-month-stale item collapses to one occurrence", () => {
    const r = run({
      horizonDays: 30,
      accounts: [acct("chk", "checking", 200_000n)],
      recurring: [rec("gym", "bill", "chk", { cadence: "monthly", anchorDay: 5 }, "2026-07-05", -5_000n)],
    });
    expect(r.events.map((e) => [e.date, e.originalDate, e.overdue])).toEqual([
      ["2026-10-13", "2026-10-05", true],
      ["2026-11-05", "2026-11-05", false],
    ]);
    expectFlat(r, "chk", "2026-10-13", "2026-11-04", 195_000n);
    expectFlat(r, "chk", "2026-11-05", "2026-11-12", 190_000n);
  });

  it("16. recurring transfers: an on-budget destination cancels in the combined line, an off-budget one does not", () => {
    const r = run({
      accounts: [acct("chk", "checking", 250_000n), acct("sav", "savings", 1_000_000n)],
      recurring: [
        rec("toSav", "transfer", "chk", { cadence: "monthly", anchorDay: 1 }, "2026-11-01", -50_000n, "sav"),
        rec("toBrk", "transfer", "chk", { cadence: "monthly", anchorDay: 1 }, "2026-11-01", -50_000n, "brk"),
      ],
    });
    expect(at(r, "chk", "2026-10-31")).toBe(250_000n);
    expect(at(r, "chk", "2026-11-01")).toBe(150_000n);
    expect(at(r, "chk", "2026-12-01")).toBe(50_000n);
    expectFlat(r, "chk", "2027-01-01", "2027-01-11", -50_000n);
    expect(series(r, "chk").firstBelowThresholdDate).toBe("2027-01-01");
    expect(at(r, "sav", "2026-11-01")).toBe(1_050_000n);
    expect(at(r, "sav", "2027-01-11")).toBe(1_150_000n);
    expect(at(r, "combined", "2026-10-31")).toBe(1_250_000n);
    expect(at(r, "combined", "2026-11-01")).toBe(1_200_000n);
    expect(at(r, "combined", "2026-12-01")).toBe(1_150_000n);
    expect(at(r, "combined", "2027-01-01")).toBe(1_100_000n);
    expect(r.events).toHaveLength(9);
    expect(r.events.slice(0, 3).map((e) => [e.date, e.accountId, e.kind, e.recurringId, e.amountCents])).toEqual([
      ["2026-11-01", "chk", "transfer_out", "toBrk", -50_000n],
      ["2026-11-01", "chk", "transfer_out", "toSav", -50_000n],
      ["2026-11-01", "sav", "transfer_in", "toSav", 50_000n],
    ]);
    expect(r.events.filter((e) => e.recurringId === "toBrk").every((e) => e.accountId === "chk")).toBe(true);
  });

  it("17. twice_monthly occurrence generation, explicit and derived second day", () => {
    expect(occurrencesInRange({ cadence: "twice_monthly", anchorDay: 15, anchorDay2: 31 }, "2026-10-15", "2027-01-11")).toEqual([
      "2026-10-15",
      "2026-10-31",
      "2026-11-15",
      "2026-11-30",
      "2026-12-15",
      "2026-12-31",
    ]);
    expect(occurrencesInRange({ cadence: "twice_monthly", anchorDay: 20, anchorDay2: 5 }, "2026-10-20", "2026-12-31")).toEqual([
      "2026-10-20",
      "2026-11-05",
      "2026-11-20",
      "2026-12-05",
      "2026-12-20",
    ]);
    expect(occurrencesInRange({ cadence: "twice_monthly", anchorDay: 16, anchorDay2: null }, "2027-01-16", "2027-03-01")).toEqual([
      "2027-01-16",
      "2027-02-01",
      "2027-02-16",
      "2027-03-01",
    ]);
    expect(occurrencesInRange({ cadence: "twice_monthly", anchorDay: 15, anchorDay2: null }, "2026-10-15", "2026-11-30")).toEqual([
      "2026-10-15",
      "2026-10-30",
      "2026-11-15",
      "2026-11-30",
    ]);
    // (e) full engine
    const r = run({
      accounts: [acct("chk", "checking", 0n)],
      recurring: [rec("tm", "income", "chk", { cadence: "twice_monthly", anchorDay: 15, anchorDay2: 31 }, "2026-10-15", 100_000n)],
    });
    expect(r.events.map((e) => e.date)).toEqual(["2026-10-15", "2026-10-31", "2026-11-15", "2026-11-30", "2026-12-15", "2026-12-31"]);
    expect(r.events.every((e) => e.kind === "income")).toBe(true);
    expect(at(r, "chk", "2027-01-11")).toBe(600_000n);
  });

  it("18. opening already below the per-account threshold", () => {
    const r = run({ horizonDays: 10, accounts: [acct("chk", "checking", 40_000n, 50_000n)] });
    const chk = series(r, "chk");
    expect(chk.points).toHaveLength(11);
    expect(chk.points.every((p) => p === 40_000n)).toBe(true);
    expect(chk.alreadyBelow).toBe(true);
    expect(chk.firstBelowThresholdDate).toBe("2026-10-13");
    expect(chk.minCents).toBe(40_000n);
    expect(chk.minDate).toBe("2026-10-13");
  });

  it("19. credit cards do not inherit the household threshold; an explicit override still applies", () => {
    const first = run({ horizonDays: 10, defaultThresholdCents: 50_000n, accounts: [acct("chk", "checking", 100_000n), acct("card", "credit", -45_000n)] });
    expect(series(first, "card").thresholdCents).toBeNull();
    expect(series(first, "card").firstBelowThresholdDate).toBeNull();
    expect(series(first, "chk").thresholdCents).toBe(50_000n);
    expect(series(first, "chk").firstBelowThresholdDate).toBeNull();
    expect(first.combined.openingCents).toBe(55_000n);
    expect(first.combined.thresholdCents).toBe(50_000n);
    expect(first.combined.firstBelowThresholdDate).toBeNull();

    const second = run({ horizonDays: 10, defaultThresholdCents: 50_000n, accounts: [acct("chk", "checking", 100_000n), acct("card", "credit", -45_000n, -40_000n)] });
    expect(series(second, "card").thresholdCents).toBe(-40_000n);
    expect(series(second, "card").firstBelowThresholdDate).toBe("2026-10-13");
    expect(series(second, "card").alreadyBelow).toBe(true);
  });

  it("20. spending on a card, then paid from checking on the payment day using the previous day's balance", () => {
    const r = run({
      horizonDays: 18,
      accounts: [acct("chk", "checking", 150_000n), acct("card", "credit", -20_000n)],
      cardPayments: [{ cardAccountId: "card", fromAccountId: "chk", payDay: 20, statementDay: null, knownStatementBalanceCents: null }],
      spendingPlan: [{ month: "2026-10", remainingCents: 25_001n }],
      spendingWeights: [
        { accountId: "chk", weightCents: 30_000n },
        { accountId: "card", weightCents: 45_000n },
      ],
    });
    expect(r.spreads).toEqual([
      { month: "2026-10", accountId: "chk", totalCents: 10_000n, windowStart: "2026-10-13", days: 19, baseCents: 526n, extraCentDays: 6 },
      { month: "2026-10", accountId: "card", totalCents: 15_001n, windowStart: "2026-10-13", days: 19, baseCents: 789n, extraCentDays: 10 },
    ]);
    expect(at(r, "chk", "2026-10-13")).toBe(149_473n);
    expect(at(r, "card", "2026-10-13")).toBe(-20_790n);
    expect(at(r, "combined", "2026-10-13")).toBe(128_683n);
    expect(at(r, "chk", "2026-10-19")).toBe(146_312n);
    expect(at(r, "card", "2026-10-19")).toBe(-25_530n);
    expect(at(r, "chk", "2026-10-20")).toBe(120_256n);
    expect(at(r, "card", "2026-10-20")).toBe(-790n);
    expect(at(r, "combined", "2026-10-20")).toBe(119_466n);
    expect(at(r, "chk", "2026-10-21")).toBe(119_730n);
    expect(at(r, "card", "2026-10-21")).toBe(-1_580n);
    expect(at(r, "chk", "2026-10-31")).toBe(114_470n);
    expect(at(r, "card", "2026-10-31")).toBe(-9_471n);
    expect(at(r, "combined", "2026-10-31")).toBe(104_999n);
    expect(series(r, "chk").minCents).toBe(114_470n);
    expect(series(r, "chk").minDate).toBe("2026-10-31");
    expect(series(r, "card").minCents).toBe(-25_530n);
    expect(series(r, "card").minDate).toBe("2026-10-19");
    expect(r.events.map((e) => [e.date, e.accountId, e.kind, e.amountCents])).toEqual([
      ["2026-10-20", "card", "card_payment_in", 25_530n],
      ["2026-10-20", "chk", "card_payment_out", -25_530n],
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("21. household transfer, overdue bill applied today and a derived twice-monthly salary in one run", () => {
    const r = run({
      horizonDays: 48,
      accounts: [acct("chk", "checking", 100_000n), acct("sav", "savings", 500_000n)],
      recurring: [
        rec("autosave", "transfer", "chk", { cadence: "monthly", anchorDay: 1 }, "2026-11-01", -50_000n, "sav"),
        rec("water", "bill", "chk", { cadence: "monthly", anchorDay: 10 }, "2026-10-10", -7_500n),
        rec("salary", "income", "chk", { cadence: "twice_monthly", anchorDay: 15, anchorDay2: null }, "2026-10-15", 200_000n),
      ],
    });
    expect(r.endDate).toBe("2026-11-30");
    expect(r.events.filter((e) => e.recurringId === "salary").map((e) => e.date)).toEqual(["2026-10-15", "2026-10-30", "2026-11-15", "2026-11-30"]);
    expect(r.events.filter((e) => e.recurringId === "water").map((e) => [e.date, e.originalDate, e.overdue])).toEqual([
      ["2026-10-13", "2026-10-10", true],
      ["2026-11-10", "2026-11-10", false],
    ]);
    expect(at(r, "chk", "2026-10-13")).toBe(92_500n);
    expect(at(r, "chk", "2026-10-15")).toBe(292_500n);
    expectFlat(r, "chk", "2026-10-30", "2026-10-31", 492_500n);
    expect(at(r, "chk", "2026-11-01")).toBe(442_500n);
    expect(at(r, "chk", "2026-11-10")).toBe(435_000n);
    expect(at(r, "chk", "2026-11-15")).toBe(635_000n);
    expect(at(r, "chk", "2026-11-30")).toBe(835_000n);
    expectFlat(r, "sav", "2026-10-13", "2026-10-31", 500_000n);
    expectFlat(r, "sav", "2026-11-01", "2026-11-30", 550_000n);
    expect(at(r, "combined", "2026-10-13")).toBe(592_500n);
    expect(at(r, "combined", "2026-10-31")).toBe(992_500n);
    expect(at(r, "combined", "2026-11-01")).toBe(992_500n);
    expect(at(r, "combined", "2026-11-30")).toBe(1_385_000n);
    expect(series(r, "chk").minCents).toBe(92_500n);
    expect(series(r, "chk").minDate).toBe("2026-10-13");
  });

  it("22. today is the last day of the month: N = 1", () => {
    const r = run({
      today: "2026-10-31",
      horizonDays: 5,
      accounts: [{ ...acct("chk", "checking", 100_000n), balanceDate: "2026-10-31" }],
      primaryAccountId: "chk",
      spendingPlan: [
        { month: "2026-10", remainingCents: 12_345n },
        { month: "2026-11", remainingCents: 30_000n },
      ],
    });
    expect(r.endDate).toBe("2026-11-05");
    expect(r.spreads).toEqual([
      { month: "2026-10", accountId: "chk", totalCents: 12_345n, windowStart: "2026-10-31", days: 1, baseCents: 12_345n, extraCentDays: 0 },
      { month: "2026-11", accountId: "chk", totalCents: 30_000n, windowStart: "2026-11-01", days: 30, baseCents: 1_000n, extraCentDays: 0 },
    ]);
    expect(at(r, "chk", "2026-10-31")).toBe(87_655n);
    expect(at(r, "chk", "2026-11-01")).toBe(86_655n);
    expect(at(r, "chk", "2026-11-05")).toBe(82_655n);
  });

  it("23. payment day 31 in February clamps; a statement day equal to the payment day resolves to the previous month", () => {
    const r = run({
      today: "2027-02-10",
      horizonDays: 25,
      accounts: [acct("chk", "checking", 100_000n), acct("card", "credit", -30_000n)],
      cardPayments: [{ cardAccountId: "card", fromAccountId: "chk", payDay: 31, statementDay: 31, knownStatementBalanceCents: -25_000n }],
    });
    expect(r.endDate).toBe("2027-03-07");
    expect(r.events.map((e) => [e.date, e.accountId, e.kind, e.amountCents])).toEqual([
      ["2027-02-28", "card", "card_payment_in", 25_000n],
      ["2027-02-28", "chk", "card_payment_out", -25_000n],
    ]);
    expectFlat(r, "chk", "2027-02-10", "2027-02-27", 100_000n);
    expectFlat(r, "chk", "2027-02-28", "2027-03-07", 75_000n);
    expectFlat(r, "card", "2027-02-10", "2027-02-27", -30_000n);
    expectFlat(r, "card", "2027-02-28", "2027-03-07", -5_000n);
  });

  it("24. helpers: spreadEvenly and splitByWeights exactness", () => {
    expect(spreadEvenly(30_000n, 19)).toEqual({ baseCents: 1_578n, extraCentDays: 18 });
    expect(19n * 1_578n).toBe(29_982n);
    expect(18n * 1_579n + 1_578n).toBe(30_000n);
    expect(spreadEvenly(0n, 5)).toEqual({ baseCents: 0n, extraCentDays: 0 });
    const weights = [
      { accountId: "chk", weightCents: 30_000n },
      { accountId: "card", weightCents: 45_000n },
    ];
    expect(splitByWeights(25_001n, weights)).toEqual(
      new Map([
        ["chk", 10_000n],
        ["card", 15_001n],
      ]),
    );
    expect(splitByWeights(25_000n, weights)).toEqual(
      new Map([
        ["chk", 10_000n],
        ["card", 15_000n],
      ]),
    );
    expect(
      splitByWeights(10n, [
        { accountId: "chk", weightCents: 0n },
        { accountId: "card", weightCents: 0n },
      ]),
    ).toBeNull();
    expect(
      splitByWeights(25_000n, [
        { accountId: "chk", weightCents: 20_000n },
        { accountId: "card", weightCents: 10_000n },
      ]),
    ).toEqual(
      new Map([
        ["chk", 16_667n],
        ["card", 8_333n],
      ]),
    );
  });

  it("25. determinism and idempotency", () => {
    const input: CashFlowInput = {
      today: TODAY,
      horizonDays: 60,
      accounts: cardAccounts(),
      recurring: [PAY, RENT],
      cardPayments: [{ cardAccountId: "card", fromAccountId: "chk", payDay: 25, statementDay: 5, knownStatementBalanceCents: -40_000n }],
      spendingPlan: [{ month: "2026-10", remainingCents: 25_000n }],
      spendingWeights: [],
      primaryAccountId: "chk",
      defaultThresholdCents: 0n,
      whatIfs: [{ kind: "skipOccurrence", recurringId: "rent", occurrenceDate: "2026-12-01" }],
    };
    const a = projectCashFlow(input);
    const b = projectCashFlow({
      ...input,
      accounts: [...input.accounts].reverse(),
      recurring: [...input.recurring].reverse(),
      cardPayments: [...input.cardPayments].reverse(),
      spendingWeights: [...input.spendingWeights].reverse(),
    });
    const c = projectCashFlow(input);
    expect(b.accounts.map((s) => s.accountId)).toEqual(["card", "chk"]);
    expect({ ...b, accounts: [...b.accounts].reverse() }).toEqual(a);
    expect(c).toEqual(a);
    expect(a.events.map((e) => e.kind)).toContain("card_payment_out");
    expect(a.spreads).toHaveLength(1);
  });
});

describe("projectCashFlow edge cases", () => {
  it("skip beats move on the same occurrence; an unknown recurring id is reported", () => {
    const r = run({
      ...test1(),
      whatIfs: [
        { kind: "moveOccurrence", recurringId: "rent", shiftDays: 2, occurrenceDate: "2026-11-01" },
        { kind: "skipOccurrence", recurringId: "rent", occurrenceDate: "2026-11-01" },
        { kind: "moveOccurrence", recurringId: "nope", shiftDays: 2 },
        { kind: "skipOccurrence", recurringId: "nope", occurrenceDate: "2026-11-01" },
      ],
    });
    expect(r.whatIfs).toEqual([
      { index: 0, applied: true },
      { index: 1, applied: true },
      { index: 2, applied: false, reason: "unknown recurring id" },
      { index: 3, applied: false, reason: "unknown recurring id" },
    ]);
    const rent = r.events.filter((e) => e.recurringId === "rent");
    expect(rent[0]).toMatchObject({ date: "2026-11-03", originalDate: "2026-11-01", applied: false, moved: true });
    expectFlat(r, "chk", "2026-11-01", "2026-11-12", 650_000n);
  });

  it("several moves on one occurrence add up; a move past the horizon drops the occurrence", () => {
    const r = run({
      ...test1(),
      whatIfs: [
        { kind: "moveOccurrence", recurringId: "rent", shiftDays: 3, occurrenceDate: "2026-11-01" },
        { kind: "moveOccurrence", recurringId: "rent", shiftDays: 4, occurrenceDate: "2026-11-01" },
        { kind: "moveOccurrence", recurringId: "rent", shiftDays: 30, occurrenceDate: "2027-01-01" },
      ],
    });
    expect(r.events.filter((e) => e.recurringId === "rent").map((e) => e.date)).toEqual(["2026-11-08", "2026-12-01"]);
    expect(at(r, "chk", "2026-11-07")).toBe(650_000n);
    expect(at(r, "chk", "2026-11-08")).toBe(500_000n);
    expect(at(r, "chk", "2027-01-11")).toBe(1_350_000n);
  });

  it("a card paid from an account that is not projected warns and is not paid", () => {
    const r = run({
      horizonDays: 20,
      accounts: [acct("card", "credit", -45_000n)],
      cardPayments: [{ cardAccountId: "card", fromAccountId: "chk", payDay: 25, statementDay: null, knownStatementBalanceCents: null }],
    });
    expect(r.events).toEqual([]);
    expect(r.warnings).toEqual(["card card is paid from an account that is not projected"]);
    expectFlat(r, "card", "2026-10-13", "2026-11-02", -45_000n);
  });

  it("a card in credit on its payment day makes no payment", () => {
    const r = run({
      horizonDays: 20,
      accounts: [acct("chk", "checking", 100_000n), acct("card", "credit", 1_000n)],
      cardPayments: [{ cardAccountId: "card", fromAccountId: "chk", payDay: 25, statementDay: null, knownStatementBalanceCents: null }],
    });
    expect(r.events).toEqual([]);
    expectFlat(r, "chk", "2026-10-13", "2026-11-02", 100_000n);
  });

  it("spending with no weights falls back to the primary, then the first checking by name, then the first account; none warns", () => {
    const plan = [{ month: "2026-10", remainingCents: 19_000n }];
    const byPrimary = run({ horizonDays: 18, accounts: [acct("b-chk", "checking", 0n), acct("sav", "savings", 0n)], primaryAccountId: "sav", spendingPlan: plan });
    expect(byPrimary.spreads.map((s) => s.accountId)).toEqual(["sav"]);
    const byChecking = run({ horizonDays: 18, accounts: [acct("b-chk", "checking", 0n), acct("a-chk", "checking", 0n), acct("sav", "savings", 0n)], spendingPlan: plan });
    expect(byChecking.spreads.map((s) => s.accountId)).toEqual(["a-chk"]);
    const byFirst = run({ horizonDays: 18, accounts: [acct("sav", "savings", 0n), acct("brk", "brokerage", 0n)], spendingPlan: plan });
    expect(byFirst.spreads.map((s) => s.accountId)).toEqual(["brk"]);
    const none = run({ horizonDays: 18, spendingPlan: plan });
    expect(none.spreads).toEqual([]);
    expect(none.warnings).toEqual(["no projected account to carry planned spending"]);
    expect(none.combined.points).toHaveLength(19);
  });

  it("negative remaining (overspent) spreads nothing; months outside the window are ignored", () => {
    const r = run({
      horizonDays: 18,
      accounts: [acct("chk", "checking", 100_000n)],
      primaryAccountId: "chk",
      spendingPlan: [
        { month: "2026-09", remainingCents: 50_000n },
        { month: "2026-10", remainingCents: -5_000n },
        { month: "2026-11", remainingCents: 50_000n },
      ],
    });
    expect(r.spreads).toEqual([{ month: "2026-10", accountId: "chk", totalCents: 0n, windowStart: "2026-10-13", days: 19, baseCents: 0n, extraCentDays: 0 }]);
    expectFlat(r, "chk", "2026-10-13", "2026-10-31", 100_000n);
  });

  it("a transfer whose source is off budget posts only the inbound leg and raises the combined line", () => {
    const r = run({
      horizonDays: 30,
      accounts: [acct("chk", "checking", 10_000n)],
      recurring: [rec("fromBrk", "transfer", "brk", { cadence: "monthly", anchorDay: 20 }, "2026-10-20", -30_000n, "chk")],
    });
    expect(r.events.map((e) => [e.date, e.accountId, e.kind, e.amountCents])).toEqual([["2026-10-20", "chk", "transfer_in", 30_000n]]);
    expect(at(r, "combined", "2026-10-20")).toBe(40_000n);
  });

  it("a stale item that is also moved forward is no longer overdue; two identical skips are one skip", () => {
    const r = run({
      horizonDays: 30,
      accounts: [acct("chk", "checking", 200_000n)],
      recurring: [rec("gym", "bill", "chk", { cadence: "monthly", anchorDay: 5 }, "2026-07-05", -5_000n)],
      whatIfs: [
        { kind: "moveOccurrence", recurringId: "gym", shiftDays: 10, occurrenceDate: "2026-10-05" },
        { kind: "skipOccurrence", recurringId: "gym", occurrenceDate: "2026-11-05" },
        { kind: "skipOccurrence", recurringId: "gym", occurrenceDate: "2026-11-05" },
      ],
    });
    expect(r.events.map((e) => [e.date, e.originalDate, e.overdue, e.moved, e.applied])).toEqual([
      ["2026-10-15", "2026-10-05", false, true, true],
      ["2026-11-05", "2026-11-05", false, false, false],
    ]);
    expect(r.whatIfs.every((w) => w.applied)).toBe(true);
    expectFlat(r, "chk", "2026-10-13", "2026-10-14", 200_000n);
    expectFlat(r, "chk", "2026-10-15", "2026-11-12", 195_000n);
  });

  it("rejects a horizon outside 1..366 and a non-positive spread window", () => {
    expect(() => run({ horizonDays: 0 })).toThrow(/horizonDays/);
    expect(() => run({ horizonDays: 367 })).toThrow(/horizonDays/);
    expect(() => spreadEvenly(10n, 0)).toThrow(/days/);
  });
});
