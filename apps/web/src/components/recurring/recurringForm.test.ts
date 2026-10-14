import { describe, expect, it } from "vitest";
import type { RecurringView } from "@meridian/shared";
import { amountFromForm, centsToInput, createBodyFromForm, emptyForm, formFromItem, parseMoneyInput, scheduleFromForm, updateBodyFromForm } from "./recurringForm.js";

const CAT = "11111111-1111-4111-8111-111111111111";
const CAT2 = "11111111-1111-4111-8111-222222222222";
const ACCT = "22222222-2222-4222-8222-222222222222";
const ACCT2 = "22222222-2222-4222-8222-333333333333";

const netflix: RecurringView = {
  id: "33333333-3333-4333-8333-333333333333",
  payeeId: "44444444-4444-4444-8444-444444444444",
  payeeName: "Netflix",
  name: "Netflix",
  categoryId: null,
  categoryName: null,
  accountId: ACCT,
  accountName: "Checking",
  transferAccountId: null,
  transferAccountName: null,
  cadence: "monthly",
  anchorDay: 15,
  anchorDay2: null,
  anchorMonth: null,
  anchorDate: null,
  expectedCents: "-1549",
  toleranceCents: "100",
  amountMode: "fixed",
  amountLocked: false,
  scheduleLocked: false,
  nextDueDate: "2026-10-15",
  firstChargeDate: "2026-04-15",
  lastChargeDate: "2026-09-15",
  lastChargeCents: "-1549",
  chargeCount: 6,
  consecutiveMissed: 0,
  overdue: false,
  confidence: 100,
  source: "detected",
  status: "suggested",
  statusReason: null,
  statusChangedAt: "2026-10-13T00:00:00.000Z",
  monthlyEquivalentCents: "-1549",
  yearlyCents: "-18588",
  notes: null,
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
};

describe("parseMoneyInput / centsToInput", () => {
  it("accepts $ and thousands separators and rejects junk", () => {
    expect(parseMoneyInput("15.49")).toBe(1549n);
    expect(parseMoneyInput("$1,234.5")).toBe(123450n);
    expect(parseMoneyInput(" 12 ")).toBe(1200n);
    expect(parseMoneyInput("")).toBeNull();
    expect(parseMoneyInput("abc")).toBeNull();
    expect(parseMoneyInput("1.234")).toBeNull();
  });
  it("renders cents magnitudes for inputs", () => {
    expect(centsToInput("-1549")).toBe("15.49");
    expect(centsToInput("5")).toBe("0.05");
    expect(centsToInput("0")).toBe("0.00");
  });
});

describe("scheduleFromForm", () => {
  it("validates per cadence and nulls unused anchors", () => {
    expect(scheduleFromForm(emptyForm({ cadence: "monthly", anchorDay: "31" }))).toEqual({
      ok: true,
      value: { cadence: "monthly", anchorDay: 31, anchorDay2: null, anchorMonth: null, anchorDate: null },
    });
    expect(scheduleFromForm(emptyForm({ cadence: "monthly", anchorDay: "0" })).ok).toBe(false);
    expect(scheduleFromForm(emptyForm({ cadence: "monthly", anchorDay: "" })).ok).toBe(false);
    expect(scheduleFromForm(emptyForm({ cadence: "weekly", anchorDate: "2026-10-02" }))).toEqual({
      ok: true,
      value: { cadence: "weekly", anchorDay: null, anchorDay2: null, anchorMonth: null, anchorDate: "2026-10-02" },
    });
    expect(scheduleFromForm(emptyForm({ cadence: "biweekly", anchorDate: "" })).ok).toBe(false);
    expect(scheduleFromForm(emptyForm({ cadence: "quarterly", anchorDay: "5", anchorMonth: "10" }))).toEqual({
      ok: true,
      value: { cadence: "quarterly", anchorDay: 5, anchorDay2: null, anchorMonth: 10, anchorDate: null },
    });
    expect(scheduleFromForm(emptyForm({ cadence: "quarterly", anchorDay: "5", anchorMonth: "" })).ok).toBe(false);
    expect(scheduleFromForm(emptyForm({ cadence: "yearly", anchorDay: "15", anchorMonth: "13" })).ok).toBe(false);
  });
  it("orders twice-monthly days and derives the second one", () => {
    expect(scheduleFromForm(emptyForm({ cadence: "twice_monthly", anchorDay: "15", anchorDay2: "1" }))).toEqual({
      ok: true,
      value: { cadence: "twice_monthly", anchorDay: 1, anchorDay2: 15, anchorMonth: null, anchorDate: null },
    });
    expect(scheduleFromForm(emptyForm({ cadence: "twice_monthly", anchorDay: "20", anchorDay2: "" }))).toEqual({
      ok: true,
      value: { cadence: "twice_monthly", anchorDay: 5, anchorDay2: 20, anchorMonth: null, anchorDate: null },
    });
    expect(scheduleFromForm(emptyForm({ cadence: "twice_monthly", anchorDay: "15", anchorDay2: "15" })).ok).toBe(false);
  });
});

describe("amountFromForm", () => {
  it("signs by direction and parses the tolerance", () => {
    expect(amountFromForm(emptyForm({ amount: "15.49", direction: "outflow" }))).toEqual({ ok: true, value: { expectedCents: "-1549", toleranceCents: null, amountMode: "fixed" } });
    expect(amountFromForm(emptyForm({ amount: "2,450", direction: "inflow", tolerance: "0", amountMode: "variable" }))).toEqual({
      ok: true,
      value: { expectedCents: "245000", toleranceCents: "0", amountMode: "variable" },
    });
    expect(amountFromForm(emptyForm({ amount: "0" })).ok).toBe(false);
    expect(amountFromForm(emptyForm({ amount: "-5" })).ok).toBe(false);
    expect(amountFromForm(emptyForm({ amount: "5", tolerance: "x" })).ok).toBe(false);
  });
});

describe("createBodyFromForm", () => {
  it("builds the manual create body with the payee defaulting to the name", () => {
    const form = emptyForm({ name: " Rent ", categoryId: CAT, accountId: ACCT, cadence: "monthly", anchorDay: "1", amount: "1800", notes: " " });
    expect(createBodyFromForm(form)).toEqual({
      ok: true,
      value: {
        name: "Rent",
        payeeName: "Rent",
        categoryId: CAT,
        accountId: ACCT,
        cadence: "monthly",
        anchorDay: 1,
        anchorDay2: null,
        anchorMonth: null,
        anchorDate: null,
        expectedCents: "-180000",
        amountMode: "fixed",
      },
    });
  });
  it("carries optional fields and reports the first missing one", () => {
    const form = emptyForm({ name: "Paycheck", payeeName: "ACME", categoryId: CAT, accountId: ACCT, transferAccountId: ACCT2, cadence: "biweekly", anchorDate: "2026-10-02", direction: "inflow", amount: "2450.00", tolerance: "50", amountMode: "variable", notes: "net pay" });
    const res = createBodyFromForm(form);
    expect(res.ok && res.value).toMatchObject({ payeeName: "ACME", transferAccountId: ACCT2, anchorDate: "2026-10-02", expectedCents: "245000", toleranceCents: "5000", amountMode: "variable", notes: "net pay" });
    expect(createBodyFromForm(emptyForm({ amount: "5", categoryId: CAT, accountId: ACCT }))).toEqual({ ok: false, error: "Enter a name." });
    expect(createBodyFromForm(emptyForm({ name: "X", amount: "5", accountId: ACCT }))).toEqual({ ok: false, error: "Choose a category." });
    expect(createBodyFromForm(emptyForm({ name: "X", amount: "5", categoryId: CAT }))).toEqual({ ok: false, error: "Choose the account it is charged to." });
    expect(createBodyFromForm(emptyForm({ name: "X", categoryId: CAT, accountId: ACCT }))).toEqual({ ok: false, error: "Enter an amount greater than zero." });
  });
});

describe("formFromItem / updateBodyFromForm", () => {
  it("round-trips an item into an empty diff", () => {
    const form = formFromItem(netflix);
    expect(form).toMatchObject({ name: "Netflix", categoryId: "", accountId: ACCT, cadence: "monthly", anchorDay: "15", anchorDay2: "", direction: "outflow", amount: "15.49", tolerance: "1.00", amountMode: "fixed", notes: "" });
    expect(updateBodyFromForm(form, netflix)).toEqual({ ok: true, value: {} });
  });
  it("confirming a suggestion sends status active with the category and only the changed fields", () => {
    const form = { ...formFromItem(netflix), categoryId: CAT };
    expect(updateBodyFromForm(form, netflix, "active")).toEqual({ ok: true, value: { categoryId: CAT, status: "active" } });
    expect(updateBodyFromForm(formFromItem(netflix), netflix, "active")).toEqual({ ok: false, error: "Choose a category to activate this item." });
    expect(updateBodyFromForm({ ...formFromItem(netflix), categoryId: CAT, accountId: "" }, netflix, "active")).toEqual({ ok: false, error: "Choose the account it is charged to." });
  });
  it("a schedule edit sends the whole schedule, an amount edit only the amount fields", () => {
    const moved = { ...formFromItem(netflix), cadence: "quarterly" as const, anchorDay: "20", anchorMonth: "1" };
    expect(updateBodyFromForm(moved, netflix)).toEqual({ ok: true, value: { cadence: "quarterly", anchorDay: 20, anchorDay2: null, anchorMonth: 1, anchorDate: null } });
    const repriced = { ...formFromItem(netflix), amount: "17.99", tolerance: "", amountMode: "variable" as const };
    expect(updateBodyFromForm(repriced, netflix)).toEqual({ ok: true, value: { expectedCents: "-1799", amountMode: "variable" } });
    const flipped = { ...formFromItem(netflix), direction: "inflow" as const };
    expect(updateBodyFromForm(flipped, netflix)).toEqual({ ok: true, value: { expectedCents: "1549" } });
  });
  it("clears nullable fields with null and keeps untouched ones out", () => {
    const withCat: RecurringView = { ...netflix, categoryId: CAT, categoryName: "Streaming", notes: "shared with Sam", transferAccountId: ACCT2, transferAccountName: "Savings" };
    const form = { ...formFromItem(withCat), categoryId: CAT2, notes: "", transferAccountId: "" };
    expect(updateBodyFromForm(form, withCat)).toEqual({ ok: true, value: { categoryId: CAT2, transferAccountId: null, notes: null } });
    expect(updateBodyFromForm({ ...formFromItem(withCat), name: "" }, withCat)).toEqual({ ok: false, error: "Enter a name." });
  });
});
