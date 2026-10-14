import type { z } from "zod";
import type {
  AuditEntryView,
  CategoryDetailView,
  CategoryGroupView,
  GoalSummary,
  GoalSummaryView,
  GoalView,
  HouseholdSettingView,
  MonthSummaryResult,
  MonthSummaryView,
  PlanAveragesResponse,
  PlanCell,
  PlanCellView,
  PlanResponse,
  PlanResult,
  PlanRow,
  PlanRowResult,
} from "@meridian/shared";
import type { AuditRow, CategoryGroupRow, CategoryRow, GoalRecord, HouseholdSettingRow, PlanAveragesResult } from "@meridian/db";

/**
 * Phase 2 view mappers: bigint service results → the wire contracts in
 * packages/shared/src/api.ts (cents as decimal strings, dates as ISO text).
 * Pure; every field name matches its contract so the response serializer
 * accepts the object as is.
 */

const cents = (n: bigint): string => n.toString();
const nullableCents = (n: bigint | null): string | null => (n === null ? null : n.toString());

function toPlanCellView(c: PlanCell): PlanCellView {
  return {
    plannedCents: cents(c.plannedCents),
    source: c.source,
    hasExplicitPlan: c.hasExplicitPlan,
    carriedInCents: cents(c.carriedInCents),
    carriedInSource: c.carriedInSource,
    availableCents: cents(c.availableCents),
    actualCents: cents(c.actualCents),
    pendingCents: cents(c.pendingCents),
    remainingCents: cents(c.remainingCents),
    overspendCents: cents(c.overspendCents),
    committedCents: cents(c.committedCents),
    rolloverMode: c.rolloverMode,
    txnCount: c.txnCount,
    overspent: c.overspent,
    note: c.note,
  };
}

export function toGoalSummaryView(g: GoalSummary): GoalSummaryView {
  return {
    id: g.id,
    name: g.name,
    targetCents: cents(g.targetCents),
    targetDate: g.targetDate,
    linkedAccountId: g.linkedAccountId,
    linkedAccountName: g.linkedAccountName,
    monthlyContributionCents: cents(g.monthlyContributionCents),
    startMonth: g.startMonth,
    startingCents: cents(g.startingCents),
    status: g.status,
    progress: {
      savedCents: cents(g.progress.savedCents),
      remainingToTargetCents: cents(g.progress.remainingToTargetCents),
      progressBp: g.progress.progressBp,
      monthsLeft: g.progress.monthsLeft,
      neededPerMonthCents: nullableCents(g.progress.neededPerMonthCents),
      projectedCompletionMonth: g.progress.projectedCompletionMonth,
      onTrack: g.progress.onTrack,
    },
  };
}

function toPlanRowView(row: PlanRowResult): PlanRow {
  const cells = row.cells.map(toPlanCellView);
  switch (row.kind) {
    case "bucket":
      return { kind: "bucket", bucket: row.bucket, cells };
    case "group":
      return { kind: "group", bucket: row.bucket, groupId: row.groupId, name: row.name, position: row.position, hidden: row.hidden, cells };
    case "category":
      return {
        kind: "category",
        bucket: row.bucket,
        groupId: row.groupId,
        categoryId: row.categoryId,
        name: row.name,
        position: row.position,
        hidden: row.hidden,
        rolloverMode: row.rolloverMode,
        rolloverFromMonth: row.rolloverFromMonth,
        goal: row.goal ? toGoalSummaryView(row.goal) : null,
        cells,
      };
  }
}

function toMonthSummaryView(s: MonthSummaryResult): MonthSummaryView {
  const totals = (t: { income: bigint; bills: bigint; savings: bigint; spending: bigint }) => ({
    income: cents(t.income),
    bills: cents(t.bills),
    savings: cents(t.savings),
    spending: cents(t.spending),
  });
  return {
    month: s.month,
    state: s.state,
    planned: totals(s.planned),
    actual: totals(s.actual),
    committed: totals(s.committed),
    plannedLeftToSpendCents: cents(s.plannedLeftToSpendCents),
    leftToSpendCents: cents(s.leftToSpendCents),
    toAssignCents: cents(s.toAssignCents),
    warning: s.warning,
    pace: s.pace ? { daysLeft: s.pace.daysLeft, perDayCents: cents(s.pace.perDayCents), overCents: cents(s.pace.overCents) } : null,
    uncategorized: { count: s.uncategorized.count, cents: cents(s.uncategorized.cents) },
  };
}

export function toPlanResponse(result: PlanResult): PlanResponse {
  return {
    today: result.today,
    currentMonth: result.currentMonth,
    from: result.from,
    to: result.to,
    months: result.months,
    zeroBased: result.zeroBased,
    rows: result.rows.map(toPlanRowView),
    summary: result.summary.map(toMonthSummaryView),
  };
}

export function toPlanAveragesResponse(result: PlanAveragesResult): PlanAveragesResponse {
  return {
    window: { from: result.window.from, to: result.window.to, monthsWithData: result.window.monthsWithData },
    averages: result.averages.map((a) => ({ categoryId: a.categoryId, averageCents: cents(a.averageCents) })),
  };
}

export function toGoalView(g: GoalRecord): GoalView {
  return {
    ...toGoalSummaryView(g),
    categoryId: g.categoryId,
    categoryName: g.categoryName,
    history: g.history.map((h) => ({ month: h.month, actualCents: cents(h.actualCents), plannedCents: cents(h.plannedCents) })),
    createdAt: g.createdAt.toISOString(),
  };
}

export function toCategoryDetailView(r: CategoryRow): CategoryDetailView {
  return {
    id: r.id,
    name: r.name,
    bucket: r.bucket,
    hidden: r.hidden,
    groupId: r.groupId,
    position: r.position,
    rolloverMode: r.rolloverMode,
    rolloverFromMonth: r.rolloverFromMonth,
    goalId: r.goalId,
  };
}

export function toCategoryGroupView(r: CategoryGroupRow): CategoryGroupView {
  return { id: r.id, name: r.name, bucket: r.bucket, position: r.position, hidden: r.hidden, categoryCount: r.categoryCount };
}

export function toAuditEntryView(r: AuditRow): z.infer<typeof AuditEntryView> {
  return {
    id: r.id,
    at: r.at.toISOString(),
    userId: r.userId,
    username: r.username,
    batchId: r.batchId,
    entity: r.entity,
    entityId: r.entityId,
    action: r.action,
    before: r.before ?? null,
    after: r.after ?? null,
  };
}

export function toHouseholdSettingView(r: HouseholdSettingRow): HouseholdSettingView {
  return {
    planStartMonth: r.planStartMonth,
    zeroBased: r.zeroBased,
    lowBalanceThresholdCents: cents(r.lowBalanceThresholdCents),
    primaryAccountId: r.primaryAccountId,
    projectionDefaultDays: r.projectionDefaultDays,
    timezone: r.timezone,
    updatedAt: r.updatedAt.toISOString(),
  };
}
