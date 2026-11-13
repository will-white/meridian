import { describe, expect, it } from "vitest";
import type { RecurringView, TransactionView } from "@meridian/shared";
import { formFromItem, updateBodyFromForm } from "./recurringForm.js";
import { chargeLinkAction, isAutoPaused, recurringTotalsLabel } from "./recurringFormat.js";

/** Audit batch b5 (recurring, subscriptions, alerts, cash flow): the web side of findings 09, 10, 12 and 14. */

const ITEM = "33333333-3333-4333-8333-333333333333";
const OTHER = "33333333-3333-4333-8333-444444444444";
const PAYEE = "44444444-4444-4444-8444-444444444444";
const ACCT = "22222222-2222-4222-8222-222222222222";

const netflix: RecurringView = {
  id: ITEM,
  payeeId: PAYEE,
  payeeName: "Netflix",
  name: "Netflix",
  categoryId: "11111111-1111-4111-8111-111111111111",
  categoryName: "Subscriptions",
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
  status: "active",
  statusReason: null,
  statusChangedAt: "2026-10-13T00:00:00.000Z",
  monthlyEquivalentCents: "-1549",
  yearlyCents: "-18588",
  notes: null,
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
};

function tx(overrides: Partial<TransactionView>): TransactionView {
  return { id: "55555555-5555-4555-8555-555555555555", payeeId: PAYEE, amountCents: "-1549", recurringId: null, isTransfer: false, ...overrides } as TransactionView;
}

describe("b5-09: an active item's form needs an account", () => {
  it("editing an active item without an account is refused; a paused one may lose it", () => {
    const cleared = { ...formFromItem(netflix), accountId: "" };
    expect(updateBodyFromForm(cleared, netflix)).toEqual({ ok: false, error: "Choose the account it is charged to." });
    const paused: RecurringView = { ...netflix, status: "paused" };
    expect(updateBodyFromForm({ ...formFromItem(paused), accountId: "" }, paused)).toEqual({ ok: true, value: { accountId: null } });
    // Another account is fine.
    expect(updateBodyFromForm({ ...formFromItem(netflix), accountId: "22222222-2222-4222-8222-999999999999" }, netflix)).toEqual({ ok: true, value: { accountId: "22222222-2222-4222-8222-999999999999" } });
  });
});

describe("b5-10: the auto-paused badge reads the status reason", () => {
  it("is shown while the item is paused for missed charges, whatever the missed count says now", () => {
    expect(isAutoPaused({ status: "paused", statusReason: "missed_3", consecutiveMissed: 0 })).toBe(true);
    expect(isAutoPaused({ status: "paused", statusReason: null, consecutiveMissed: 3 })).toBe(false);
    expect(isAutoPaused({ status: "active", statusReason: null, consecutiveMissed: 1 })).toBe(false);
  });
});

describe("b5-12: the link search only offers what the server accepts", () => {
  it("links a free charge of the same payee and direction, moves one linked elsewhere, offers nothing else", () => {
    expect(chargeLinkAction(tx({}), netflix)).toBe("link");
    expect(chargeLinkAction(tx({ recurringId: OTHER }), netflix)).toBe("move");
    expect(chargeLinkAction(tx({ recurringId: ITEM }), netflix)).toBeNull();
    expect(chargeLinkAction(tx({ payeeId: "44444444-4444-4444-8444-999999999999" }), netflix)).toBeNull();
    expect(chargeLinkAction(tx({ payeeId: null }), netflix)).toBeNull();
    expect(chargeLinkAction(tx({ amountCents: "1549" }), netflix)).toBeNull();
    expect(chargeLinkAction(tx({ amountCents: "0" }), netflix)).toBeNull();
    expect(chargeLinkAction(tx({ isTransfer: true }), netflix)).toBeNull();
  });
});

describe("b5-14: the list totals keep the direction of a net figure", () => {
  it("says net out or net in when both directions are listed, and plain magnitudes for one direction", () => {
    const out = { monthlyEquivalentCents: "-181549", yearlyCents: "-2178588" };
    expect(recurringTotalsLabel(2, out, "")).toBe("2 items · net out $1,815.49/mo · $21,785.88/yr");
    expect(recurringTotalsLabel(3, { monthlyEquivalentCents: "318451", yearlyCents: "3821412" }, "")).toBe("3 items · net in $3,184.51/mo · $38,214.12/yr");
    expect(recurringTotalsLabel(2, { monthlyEquivalentCents: "0", yearlyCents: "0" }, "")).toBe("2 items · net $0.00/mo · $0.00/yr");
    expect(recurringTotalsLabel(1, out, "outflow")).toBe("1 item · $1,815.49/mo · $21,785.88/yr");
  });
});
