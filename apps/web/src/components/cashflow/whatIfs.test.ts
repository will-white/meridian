import { describe, expect, it } from "vitest";
import {
  addMove,
  describeWhatIf,
  horizonDays,
  isHorizonChoice,
  isSkipped,
  oneTimeFromForm,
  projectionBody,
  recurringNamesFromEvents,
  removeAt,
  skipIndex,
  toggleSkip,
  type CashFlowEvent,
  type WhatIf,
} from "./whatIfs.js";

const RENT = "11111111-1111-4111-8111-111111111111";
const PAY = "22222222-2222-4222-8222-222222222222";
const CHK = "33333333-3333-4333-8333-333333333333";

const rentEvent: CashFlowEvent = {
  date: "2026-12-01",
  originalDate: "2026-12-01",
  accountId: CHK,
  accountName: "Checking",
  amountCents: "-150000",
  kind: "bill",
  recurringId: RENT,
  label: "Rent",
  applied: true,
  overdue: false,
  moved: false,
};

const names = { recurring: (id: string) => (id === RENT ? "Rent" : id === PAY ? "Paycheck" : "?"), account: (id: string) => (id === CHK ? "Checking" : "?") };

describe("horizon", () => {
  it("maps the selector to days; 12 months is the calendar distance", () => {
    expect(horizonDays("30", "2026-10-13")).toBe(30);
    expect(horizonDays("90", "2026-10-13")).toBe(90);
    expect(horizonDays("180", "2026-10-13")).toBe(180);
    expect(horizonDays("12m", "2026-10-13")).toBe(365);
    expect(horizonDays("12m", "2027-03-01")).toBe(366); // 2028 is a leap year
    expect(horizonDays("12m", "2028-02-29")).toBe(365); // clamps to 2029-02-28
    expect(isHorizonChoice("90")).toBe(true);
    expect(isHorizonChoice("45")).toBe(false);
    expect(isHorizonChoice(null)).toBe(false);
  });
});

describe("projectionBody", () => {
  it("copies the what-ifs and omits accountIds unless given", () => {
    const whatIfs: WhatIf[] = [{ kind: "skipOccurrence", recurringId: RENT, occurrenceDate: "2026-12-01" }];
    const body = projectionBody({ today: "2026-10-13", horizonDays: 90, whatIfs });
    expect(body).toEqual({ today: "2026-10-13", horizonDays: 90, whatIfs });
    expect(body.whatIfs).not.toBe(whatIfs);
    expect(projectionBody({ today: "2026-10-13", horizonDays: 30, whatIfs: [], accountIds: [CHK] }).accountIds).toEqual([CHK]);
    // No horizon: the server falls back to the household's projection_default_days.
    expect(projectionBody({ today: "2026-10-13", whatIfs: [] })).toEqual({ today: "2026-10-13", whatIfs: [] });
  });
});

describe("skip what-ifs", () => {
  it("toggles a skip keyed on the original occurrence date", () => {
    const once = toggleSkip([], rentEvent);
    expect(once).toEqual([{ kind: "skipOccurrence", recurringId: RENT, occurrenceDate: "2026-12-01" }]);
    expect(isSkipped(once, rentEvent)).toBe(true);
    expect(isSkipped(once, { ...rentEvent, originalDate: "2027-01-01" })).toBe(false);
    expect(toggleSkip(once, rentEvent)).toEqual([]);
    expect(skipIndex(once, RENT, "2026-12-01")).toBe(0);
    expect(skipIndex(once, PAY, "2026-12-01")).toBe(-1);
  });

  it("matches a moved event by its original date, not where it landed", () => {
    const moved = { ...rentEvent, date: "2026-12-04", moved: true };
    const list = toggleSkip([], moved);
    expect(list[0]).toEqual({ kind: "skipOccurrence", recurringId: RENT, occurrenceDate: "2026-12-01" });
  });

  it("ignores events with no recurring item (card payments, one-time rows)", () => {
    expect(toggleSkip([], { recurringId: null, originalDate: null })).toEqual([]);
  });
});

describe("move what-ifs", () => {
  it("adds a one-occurrence or an all-occurrences move and rejects bad shifts", () => {
    const one = addMove([], rentEvent, 4, "one");
    expect(one).toEqual([{ kind: "moveOccurrence", recurringId: RENT, shiftDays: 4, occurrenceDate: "2026-12-01" }]);
    const all = addMove(one, rentEvent, -14, "all");
    expect(all[1]).toEqual({ kind: "moveOccurrence", recurringId: RENT, shiftDays: -14 });
    expect(addMove(all, rentEvent, 0, "one")).toEqual(all);
    expect(addMove(all, rentEvent, 367, "all")).toEqual(all);
    expect(addMove(all, rentEvent, 1.5, "all")).toEqual(all);
    expect(removeAt(all, 0)).toEqual([all[1]]);
  });
});

describe("oneTimeFromForm", () => {
  it("signs the amount by direction and strips formatting", () => {
    const r = oneTimeFromForm({ date: "2026-11-20", accountId: CHK, amount: "$800.00", direction: "expense", label: " Tires " });
    expect(r).toEqual({ ok: true, whatIf: { kind: "oneTime", date: "2026-11-20", accountId: CHK, amountCents: "-80000", label: "Tires" } });
    const income = oneTimeFromForm({ date: "2026-11-20", accountId: CHK, amount: "1,250.5", direction: "income", label: "" });
    expect(income).toEqual({ ok: true, whatIf: { kind: "oneTime", date: "2026-11-20", accountId: CHK, amountCents: "125050" } });
  });

  it("explains what is missing", () => {
    expect(oneTimeFromForm({ date: "", accountId: CHK, amount: "1", direction: "expense", label: "" })).toEqual({ ok: false, error: "Pick a date" });
    expect(oneTimeFromForm({ date: "2026-11-20", accountId: "", amount: "1", direction: "expense", label: "" })).toEqual({ ok: false, error: "Pick an account" });
    expect(oneTimeFromForm({ date: "2026-11-20", accountId: CHK, amount: "-5", direction: "expense", label: "" }).ok).toBe(false);
    expect(oneTimeFromForm({ date: "2026-11-20", accountId: CHK, amount: "abc", direction: "expense", label: "" })).toEqual({ ok: false, error: "Not an amount" });
    expect(oneTimeFromForm({ date: "2026-11-20", accountId: CHK, amount: "0", direction: "expense", label: "" })).toEqual({ ok: false, error: "The amount must not be zero" });
  });
});

describe("describeWhatIf", () => {
  it("writes one sentence per what-if", () => {
    expect(describeWhatIf({ kind: "skipOccurrence", recurringId: RENT, occurrenceDate: "2026-12-01" }, names)).toBe("Skip Rent on 12/01/26");
    expect(describeWhatIf({ kind: "moveOccurrence", recurringId: PAY, shiftDays: 4, occurrenceDate: "2026-10-16" }, names)).toBe("Move Paycheck +4 days (the 10/16/26 occurrence)");
    expect(describeWhatIf({ kind: "moveOccurrence", recurringId: PAY, shiftDays: -1 }, names)).toBe("Move Paycheck -1 day (every occurrence)");
    expect(describeWhatIf({ kind: "oneTime", date: "2026-11-20", accountId: CHK, amountCents: "-80000", label: "Tires" }, names)).toBe("One-time Tires -$800.00 on 11/20/26 in Checking");
    expect(describeWhatIf({ kind: "oneTime", date: "2026-11-20", accountId: CHK, amountCents: "5000" }, names)).toBe("One-time $50.00 on 11/20/26 in Checking");
  });
});

describe("recurringNamesFromEvents", () => {
  it("keeps the first label per recurring id and skips rows without one", () => {
    const names = recurringNamesFromEvents([rentEvent, { ...rentEvent, recurringId: null, kind: "card_payment_out", label: "Visa payment" }, { ...rentEvent, originalDate: "2027-01-01", label: "Rent (renamed)" }]);
    expect([...names.entries()]).toEqual([[RENT, "Rent"]]);
  });
});
