import type { AlertView, RecurringList, RecurringView, SubscriptionsResponse } from "@meridian/shared";
import type { AlertRecord, RecurringRecord, SubscriptionRecord, SubscriptionsResult } from "@meridian/db";

/**
 * Recurring, subscription and alert view mappers: bigint service records → the wire
 * contracts in packages/shared/src/api.ts (cents as decimal strings, timestamps as
 * ISO text, dates untouched). Pure; every field name matches its contract.
 */

const cents = (n: bigint): string => n.toString();
const nullableCents = (n: bigint | null): string | null => (n === null ? null : n.toString());
const iso = (d: Date): string => d.toISOString();
const nullableIso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function toRecurringView(r: RecurringRecord): RecurringView {
  return {
    id: r.id,
    payeeId: r.payeeId,
    payeeName: r.payeeName,
    name: r.name,
    categoryId: r.categoryId,
    categoryName: r.categoryName,
    accountId: r.accountId,
    accountName: r.accountName,
    transferAccountId: r.transferAccountId,
    transferAccountName: r.transferAccountName,
    cadence: r.cadence,
    anchorDay: r.anchorDay,
    anchorDay2: r.anchorDay2,
    anchorMonth: r.anchorMonth,
    anchorDate: r.anchorDate,
    expectedCents: cents(r.expectedCents),
    toleranceCents: cents(r.toleranceCents),
    amountMode: r.amountMode,
    amountLocked: r.amountLocked,
    scheduleLocked: r.scheduleLocked,
    nextDueDate: r.nextDueDate,
    firstChargeDate: r.firstChargeDate,
    lastChargeDate: r.lastChargeDate,
    lastChargeCents: nullableCents(r.lastChargeCents),
    chargeCount: r.chargeCount,
    consecutiveMissed: r.consecutiveMissed,
    overdue: r.overdue,
    confidence: r.confidence,
    source: r.source,
    status: r.status,
    statusReason: r.statusReason,
    statusChangedAt: iso(r.statusChangedAt),
    monthlyEquivalentCents: cents(r.monthlyEquivalentCents),
    yearlyCents: cents(r.yearlyCents),
    notes: r.notes,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

export function toRecurringList(result: { items: RecurringRecord[]; totals: { yearlyCents: bigint; monthlyEquivalentCents: bigint } }): RecurringList {
  return {
    items: result.items.map(toRecurringView),
    totals: { yearlyCents: cents(result.totals.yearlyCents), monthlyEquivalentCents: cents(result.totals.monthlyEquivalentCents) },
  };
}

export function toSubscriptionRow(r: SubscriptionRecord): SubscriptionsResponse["items"][number] {
  return {
    id: r.id,
    name: r.name,
    payeeName: r.payeeName,
    categoryName: r.categoryName,
    cadence: r.cadence,
    expectedCents: cents(r.expectedCents),
    monthlyEquivalentCents: cents(r.monthlyEquivalentCents),
    yearlyCents: cents(r.yearlyCents),
    nextDueDate: r.nextDueDate,
    lastChargeDate: r.lastChargeDate,
    lastChargeCents: nullableCents(r.lastChargeCents),
    amountMode: r.amountMode,
    consecutiveMissed: r.consecutiveMissed,
    status: r.status,
  };
}

export function toSubscriptionsResponse(s: SubscriptionsResult): SubscriptionsResponse {
  return {
    items: s.items.map(toSubscriptionRow),
    pausedItems: s.pausedItems.map(toSubscriptionRow),
    totalMonthlyCents: cents(s.totalMonthlyCents),
    totalYearlyCents: cents(s.totalYearlyCents),
  };
}

export function toAlertView(a: AlertRecord): AlertView {
  return {
    id: a.id,
    kind: a.kind,
    recurringId: a.recurringId,
    recurringName: a.recurringName,
    payeeId: a.payeeId,
    payeeName: a.payeeName,
    transactionId: a.transactionId,
    dueDate: a.dueDate,
    oldCents: nullableCents(a.oldCents),
    newCents: nullableCents(a.newCents),
    createdAt: iso(a.createdAt),
    dismissedAt: nullableIso(a.dismissedAt),
    resolvedAt: nullableIso(a.resolvedAt),
  };
}
