import type { BucketTotals, CashFlowProjectionResponse, CashFlowResult, CashFlowSeries, DashboardView } from "@meridian/shared";
import type { DashboardInvestmentsBlock, DashboardResult } from "@meridian/db";

/**
 * Cash-flow and dashboard view mappers: the engines' bigint results → the wire
 * contracts in packages/shared/src/api.ts (cents as decimal strings, dates and
 * months untouched, timestamps as ISO text). Pure; every field name matches its
 * contract so the response serializer accepts the object as is.
 */

const cents = (n: bigint): string => n.toString();
const nullableCents = (n: bigint | null): string | null => (n === null ? null : n.toString());

type SeriesView = CashFlowProjectionResponse["combined"];
type EventView = CashFlowProjectionResponse["events"][number];
type SpreadView = CashFlowProjectionResponse["spreads"][number];
type WhatIfReportView = CashFlowProjectionResponse["whatIfs"][number];

function toSeriesView(s: CashFlowSeries): SeriesView {
  return {
    openingCents: cents(s.openingCents),
    thresholdCents: nullableCents(s.thresholdCents),
    points: s.points.map(cents),
    minCents: cents(s.minCents),
    minDate: s.minDate,
    firstBelowThresholdDate: s.firstBelowThresholdDate,
    alreadyBelow: s.alreadyBelow,
  };
}

/** The projection on the wire: every bigint a decimal string, events decorated with their account's name. */
export function toCashFlowProjectionView(r: CashFlowResult): CashFlowProjectionResponse {
  const nameOf = new Map(r.accounts.map((a) => [a.accountId, a.name]));
  const toEvent = (e: CashFlowResult["events"][number]): EventView => ({
    date: e.date,
    originalDate: e.originalDate,
    accountId: e.accountId,
    accountName: nameOf.get(e.accountId) ?? "",
    amountCents: cents(e.amountCents),
    kind: e.kind,
    recurringId: e.recurringId,
    label: e.label,
    applied: e.applied,
    overdue: e.overdue,
    moved: e.moved,
  });
  const toSpread = (s: CashFlowResult["spreads"][number]): SpreadView => ({
    month: s.month,
    accountId: s.accountId,
    totalCents: cents(s.totalCents),
    windowStart: s.windowStart,
    days: s.days,
    baseCents: cents(s.baseCents),
    extraCentDays: s.extraCentDays,
  });
  const toReport = (w: CashFlowResult["whatIfs"][number]): WhatIfReportView =>
    w.reason === undefined ? { index: w.index, applied: w.applied } : { index: w.index, applied: w.applied, reason: w.reason };
  return {
    today: r.today,
    endDate: r.endDate,
    dates: r.dates,
    accounts: r.accounts.map((a) => ({ ...toSeriesView(a), accountId: a.accountId, name: a.name, type: a.type, balanceDate: a.balanceDate })),
    combined: toSeriesView(r.combined),
    events: r.events.map(toEvent),
    spreads: r.spreads.map(toSpread),
    whatIfs: r.whatIfs.map(toReport),
    warnings: r.warnings,
  };
}

function toBucketTotalsView(t: BucketTotals): DashboardView["plan"]["planned"] {
  return { income: cents(t.income), bills: cents(t.bills), savings: cents(t.savings), spending: cents(t.spending) };
}

/** Phase 3 (views design §4, seams C47): the dashboard's investments block on the wire. */
export function toDashboardInvestmentsView(b: DashboardInvestmentsBlock): NonNullable<DashboardView["investments"]> {
  return {
    asOf: b.asOf,
    totalCents: cents(b.totalCents),
    dayChangeCents: nullableCents(b.dayChangeCents),
    dayChangeBp: b.dayChangeBp,
    staleAccounts: b.staleAccounts.map((a) => ({ id: a.id, name: a.name, valuationDate: a.valuationDate })),
    fidelityCounts: { ...b.fidelityCounts },
    awaitingReconcile: b.awaitingReconcile,
    securitiesNeedingReview: b.securitiesNeedingReview,
    priceFeed: { ...b.priceFeed },
  };
}

/** The dashboard on the wire (docs/phase-2-plan.md §15, grid-and-api `DashboardView`; Phase 3 adds the net-worth breakdown and the investments block). */
export function toDashboardView(d: DashboardResult): DashboardView {
  return {
    today: d.today,
    plan: {
      month: d.plan.month,
      leftToSpendCents: cents(d.plan.leftToSpendCents),
      toAssignCents: cents(d.plan.toAssignCents),
      zeroBased: d.plan.zeroBased,
      warning: d.plan.warning,
      pace: { daysLeft: d.plan.pace.daysLeft, perDayCents: cents(d.plan.pace.perDayCents), overCents: cents(d.plan.pace.overCents) },
      planned: toBucketTotalsView(d.plan.planned),
      actual: toBucketTotalsView(d.plan.actual),
      committed: toBucketTotalsView(d.plan.committed),
      uncategorized: { count: d.plan.uncategorized.count, cents: cents(d.plan.uncategorized.cents) },
    },
    cashFlow: {
      asOf: d.cashFlow.asOf,
      horizonDays: d.cashFlow.horizonDays,
      thresholdCents: cents(d.cashFlow.thresholdCents),
      points: d.cashFlow.points.map((p) => ({ date: p.date, cents: cents(p.cents) })),
      lowPoint: { date: d.cashFlow.lowPoint.date, cents: cents(d.cashFlow.lowPoint.cents) },
      firstBelow: d.cashFlow.firstBelow,
      warnings: d.cashFlow.warnings,
    },
    billsDue: d.billsDue.map((b) => ({
      recurringId: b.recurringId,
      name: b.name,
      categoryName: b.categoryName,
      accountName: b.accountName,
      dueDate: b.dueDate,
      amountCents: cents(b.amountCents),
      overdue: b.overdue,
    })),
    netWorth: {
      asOf: d.netWorth.asOf,
      todayCents: cents(d.netWorth.todayCents),
      yearAgoDate: d.netWorth.yearAgoDate,
      yearAgoCents: nullableCents(d.netWorth.yearAgoCents),
      changeCents: nullableCents(d.netWorth.changeCents),
      newAccounts: d.netWorth.newAccounts.map((a) => ({ id: a.id, name: a.name })),
      breakdown: {
        investmentsCents: cents(d.netWorth.breakdown.investmentsCents),
        investmentsAsOf: d.netWorth.breakdown.investmentsAsOf,
        cashCents: cents(d.netWorth.breakdown.cashCents),
        debtCents: cents(d.netWorth.breakdown.debtCents),
        otherCents: cents(d.netWorth.breakdown.otherCents),
      },
    },
    review: { uncategorized: d.review.uncategorized, suggestedRecurring: d.review.suggestedRecurring, alerts: d.review.alerts },
    sync: {
      lastSyncAt: d.sync.lastSyncAt === null ? null : d.sync.lastSyncAt.toISOString(),
      attention: d.sync.attention.map((c) => ({ connectionId: c.connectionId, name: c.name, status: c.status })),
    },
    retirement: null,
    investments: d.investments === null ? null : toDashboardInvestmentsView(d.investments),
  };
}
