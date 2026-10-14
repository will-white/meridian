import { type IsoDate } from "./dates.js";
import { type Bucket, type PlannedSource, type RolloverMode } from "./enums.js";
import {
  addMonths,
  ceilDiv,
  daysRemainingInMonth,
  maxBig,
  maxMonth,
  minBig,
  minMonth,
  monthDiff,
  monthKey,
  monthRange,
  truncDiv,
  type MonthKey,
} from "./months.js";

/**
 * Phase 2 plan engine: the multi-month grid, rollover chains, goal progress and
 * the summary strip, as one pure function over pre-aggregated inputs. No DB, no
 * clock (`today` is an input), bigint cents everywhere. See docs/phase-2-plan.md
 * §4–§9 and docs/design/phase-2/plan-math.md / grid-and-api.md.
 *
 * Conventions: every number is bucket-natural (positive is good). Transaction
 * cents arrive signed (+ in, − out) and are converted exactly once:
 * actual = bucketSign(bucket) × Σ signedCents (+ the goal's net linked transfers).
 * Planned is a non-negative magnitude; carried-in may be negative.
 */

// ---- Inputs ----

export interface PlanGroupInput {
  id: string;
  name: string;
  bucket: Bucket;
  position: number;
  hidden: boolean;
}

export interface PlanCategoryInput {
  id: string;
  name: string;
  bucket: Bucket;
  groupId: string | null;
  position: number;
  hidden: boolean;
  rolloverMode: RolloverMode;
  /** The month this category's carry chain starts; null = the household's plan start month. */
  rolloverFromMonth: MonthKey | null;
  goalId: string | null;
}

export interface MonthPlanRowInput {
  categoryId: string;
  month: MonthKey;
  /** Explicit planned magnitude; null = the auto value applies. */
  plannedCents: bigint | null;
  plannedSource: "manual" | "average" | "recurring" | "goal" | null;
  /** Per-month override of the carry OUT of this month; null = the category's mode. */
  rolloverMode: RolloverMode | null;
  /** Pins this month's carried-in and feeds the chain forward; null = computed. */
  carriedInOverrideCents: bigint | null;
  note: string | null;
}

/** Categorized, non-transfer rows (splits expanded), pre-aggregated per (category, month); signed ledger cents. */
export interface ActualInput {
  categoryId: string;
  month: MonthKey;
  signedCents: bigint;
  /** The part of `signedCents` that is still pending (already inside `signedCents`). */
  pendingSignedCents: bigint;
  count: number;
}

/** Transfer legs in a goal's linked account, net per month (+ in, − out). */
export interface GoalNetInput {
  goalId: string;
  month: MonthKey;
  signedCents: bigint;
  count: number;
}

/** Pre-aggregated auto-planned values: recurring occurrences (bills/income) or goal contributions (savings). */
export interface AutoPlanInput {
  categoryId: string;
  month: MonthKey;
  cents: bigint;
  source: "recurring" | "goal";
}

export interface GoalInput {
  id: string;
  categoryId: string;
  name: string;
  targetCents: bigint;
  targetDate: IsoDate | null;
  linkedAccountId: string | null;
  linkedAccountName: string | null;
  monthlyContributionCents: bigint;
  startMonth: MonthKey;
  startingCents: bigint;
  status: "active" | "completed" | "archived";
}

export interface UncategorizedInput {
  month: MonthKey;
  count: number;
  signedCents: bigint;
}

export interface ComputePlanInput {
  /** household_setting.plan_start_month: the global origin of every carry chain. */
  startMonth: MonthKey;
  from: MonthKey;
  to: MonthKey;
  today: IsoDate;
  zeroBased: boolean;
  groups: PlanGroupInput[];
  categories: PlanCategoryInput[];
  rows: MonthPlanRowInput[];
  /** Must cover [min(from, startMonth, every goal.startMonth), max(to, current month)]. */
  actuals: ActualInput[];
  goalNets: GoalNetInput[];
  autoPlans: AutoPlanInput[];
  goals: GoalInput[];
  uncategorized: UncategorizedInput[];
}

// ---- Outputs (bigint twins of the api.ts views; same field names) ----

export type CarriedInSource = "start" | "chain" | "override" | "none";

export interface PlanCell {
  plannedCents: bigint;
  source: PlannedSource;
  /** True when a month_plan row holds planned_cents (manual, average, or frozen recurring/goal). */
  hasExplicitPlan: boolean;
  carriedInCents: bigint;
  carriedInSource: CarriedInSource;
  availableCents: bigint;
  actualCents: bigint;
  pendingCents: bigint;
  remainingCents: bigint;
  overspendCents: bigint;
  committedCents: bigint;
  /** Effective mode deciding the carry out of this month ('none' for income and before the chain start). */
  rolloverMode: RolloverMode;
  txnCount: number;
  overspent: boolean;
  note: string | null;
}

export interface GoalProgress {
  savedCents: bigint;
  remainingToTargetCents: bigint;
  progressBp: number;
  monthsLeft: number | null;
  neededPerMonthCents: bigint | null;
  projectedCompletionMonth: MonthKey | null;
  onTrack: boolean | null;
}

export interface GoalSummary {
  id: string;
  name: string;
  targetCents: bigint;
  targetDate: IsoDate | null;
  linkedAccountId: string | null;
  linkedAccountName: string | null;
  monthlyContributionCents: bigint;
  startMonth: MonthKey;
  startingCents: bigint;
  status: "active" | "completed" | "archived";
  progress: GoalProgress;
}

export interface PlanBucketRowResult {
  kind: "bucket";
  bucket: Bucket;
  cells: PlanCell[];
}

export interface PlanGroupRowResult {
  kind: "group";
  bucket: Bucket;
  groupId: string;
  name: string;
  position: number;
  hidden: boolean;
  cells: PlanCell[];
}

export interface PlanCategoryRowResult {
  kind: "category";
  bucket: Bucket;
  groupId: string | null;
  categoryId: string;
  name: string;
  position: number;
  /** Effective: the category's own flag or its group's. */
  hidden: boolean;
  rolloverMode: RolloverMode;
  rolloverFromMonth: MonthKey | null;
  goal: GoalSummary | null;
  cells: PlanCell[];
}

export type PlanRowResult = PlanBucketRowResult | PlanGroupRowResult | PlanCategoryRowResult;

export interface BucketTotals {
  income: bigint;
  bills: bigint;
  savings: bigint;
  spending: bigint;
}

export interface PaceResult {
  daysLeft: number;
  perDayCents: bigint;
  overCents: bigint;
}

export interface MonthSummaryResult {
  month: MonthKey;
  state: "past" | "current" | "future";
  planned: BucketTotals;
  actual: BucketTotals;
  committed: BucketTotals;
  /** The spec's literal formula: planned income − planned bills − planned savings − planned spending. */
  plannedLeftToSpendCents: bigint;
  /** Actual-aware: committed income − committed outflows. Shown on the strip; drives pace. */
  leftToSpendCents: bigint;
  /** Zero-based presentation: committed income − planned outflows. */
  toAssignCents: bigint;
  /** The displayed number (toAssign when zero-based, else leftToSpend) is negative. */
  warning: boolean;
  pace: PaceResult | null;
  uncategorized: { count: number; cents: bigint };
}

export interface PlanResult {
  today: IsoDate;
  currentMonth: MonthKey;
  from: MonthKey;
  to: MonthKey;
  months: MonthKey[];
  zeroBased: boolean;
  rows: PlanRowResult[];
  summary: MonthSummaryResult[];
}

// ---- Helpers ----

export const BUCKET_ORDER: readonly Bucket[] = ["income", "bills", "savings", "spending"];

export function bucketSign(bucket: Bucket): 1n | -1n {
  return bucket === "income" ? 1n : -1n;
}

/** What a month passes to the next: none → 0; surplus → max(0, remaining); all → remaining (may be negative). */
export function carryOut(mode: RolloverMode, remaining: bigint): bigint {
  switch (mode) {
    case "none":
      return 0n;
    case "surplus":
      return maxBig(0n, remaining);
    case "all":
      return remaining;
  }
}

/**
 * What a row charges against this month's income for left to spend:
 * max(planned + carriedIn, actual) − max(carriedIn, 0)
 * (identical to planned + min(carriedIn, 0) + overspend). A carried-in surplus
 * is never charged again; a carried-in overspend was charged in the month it
 * happened, so this month funds only the rest of the envelope.
 */
export function committedCents(planned: bigint, carriedIn: bigint, actual: bigint): bigint {
  return maxBig(planned + carriedIn, actual) - maxBig(carriedIn, 0n);
}

/** Daily pace for the current month: today counts (last day → 1); never promises more than exists. */
export function paceCents(leftToSpend: bigint, today: IsoDate): PaceResult {
  const daysLeft = daysRemainingInMonth(today);
  return {
    daysLeft,
    perDayCents: leftToSpend >= 0n ? truncDiv(leftToSpend, BigInt(daysLeft)) : 0n,
    overCents: leftToSpend < 0n ? -leftToSpend : 0n,
  };
}

/** The n completed months before `asOf`: [asOf − n, asOf − 1]. */
export function averageWindow(asOf: MonthKey, months: 3 | 6 | 12): { from: MonthKey; to: MonthKey } {
  return { from: addMonths(asOf, -months), to: addMonths(asOf, -1) };
}

/**
 * Plan from average: Σ actual over the window months on/after the ledger's first
 * transaction month, divided by that count (truncating), clamped at 0 because
 * planned is a magnitude. No counted months → { 0, 0 }.
 */
export function planAverage(
  actualByMonth: ReadonlyMap<MonthKey, bigint>,
  window: { from: MonthKey; to: MonthKey },
  firstLedgerMonth: MonthKey | null,
): { cents: bigint; monthsWithData: number } {
  if (firstLedgerMonth === null) return { cents: 0n, monthsWithData: 0 };
  const counted = monthRange(window.from, window.to).filter((m) => m >= firstLedgerMonth);
  if (counted.length === 0) return { cents: 0n, monthsWithData: 0 };
  let sum = 0n;
  for (const m of counted) sum += actualByMonth.get(m) ?? 0n;
  return { cents: maxBig(0n, truncDiv(sum, BigInt(counted.length))), monthsWithData: counted.length };
}

/**
 * Goal progress from the goal category's bucket-natural actuals (categorized rows
 * plus net linked transfers). Only months in [startMonth, currentMonth] count.
 */
export function goalProgress(goal: GoalInput, actualByMonth: ReadonlyMap<MonthKey, bigint>, currentMonth: MonthKey): GoalProgress {
  let saved = goal.startingCents;
  for (const m of monthRange(goal.startMonth, currentMonth)) saved += actualByMonth.get(m) ?? 0n;
  const target = goal.targetCents;
  const remaining = maxBig(0n, target - saved);
  const progressBp = target > 0n ? Number(minBig(10000n, maxBig(0n, truncDiv(saved * 10000n, target)))) : 0;
  const monthsLeft = goal.targetDate === null ? null : Math.max(1, monthDiff(currentMonth, monthKey(goal.targetDate)) + 1);
  const needed = monthsLeft === null ? null : ceilDiv(remaining, BigInt(monthsLeft));
  const monthly = goal.monthlyContributionCents;
  const projectedCompletionMonth =
    remaining === 0n ? currentMonth : monthly > 0n ? addMonths(currentMonth, Number(ceilDiv(remaining, monthly))) : null;
  return {
    savedCents: saved,
    remainingToTargetCents: remaining,
    progressBp,
    monthsLeft,
    neededPerMonthCents: needed,
    projectedCompletionMonth,
    onTrack: needed === null ? null : monthly >= needed,
  };
}

// ---- computePlan ----

const key = (categoryId: string, month: MonthKey): string => `${categoryId}|${month}`;

function byPositionThenName<T extends { position: number; name: string; id: string }>(a: T, b: T): number {
  if (a.position !== b.position) return a.position - b.position;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function emptyCell(): PlanCell {
  return {
    plannedCents: 0n,
    source: "none",
    hasExplicitPlan: false,
    carriedInCents: 0n,
    carriedInSource: "none",
    availableCents: 0n,
    actualCents: 0n,
    pendingCents: 0n,
    remainingCents: 0n,
    overspendCents: 0n,
    committedCents: 0n,
    rolloverMode: "none",
    txnCount: 0,
    overspent: false,
    note: null,
  };
}

/** Subtotal row: sums of the members' money fields; provenance fields are neutral. */
function sumCells(members: readonly PlanCell[][], monthCount: number): PlanCell[] {
  const out: PlanCell[] = [];
  for (let i = 0; i < monthCount; i++) {
    const cell = emptyCell();
    for (const cells of members) {
      const c = cells[i];
      if (!c) continue;
      cell.plannedCents += c.plannedCents;
      cell.carriedInCents += c.carriedInCents;
      cell.availableCents += c.availableCents;
      cell.actualCents += c.actualCents;
      cell.pendingCents += c.pendingCents;
      cell.remainingCents += c.remainingCents;
      cell.overspendCents += c.overspendCents;
      cell.committedCents += c.committedCents;
      cell.txnCount += c.txnCount;
    }
    cell.overspent = cell.overspendCents > 0n;
    out.push(cell);
  }
  return out;
}

function emptyTotals(): BucketTotals {
  return { income: 0n, bills: 0n, savings: 0n, spending: 0n };
}

interface Indexes {
  rowBy: Map<string, MonthPlanRowInput>;
  autoBy: Map<string, { cents: bigint; source: "recurring" | "goal" }>;
  actualBy: Map<string, { signedCents: bigint; pendingSignedCents: bigint; count: number }>;
  goalNetBy: Map<string, { signedCents: bigint; count: number }>;
  uncategorizedBy: Map<MonthKey, { count: number; cents: bigint }>;
}

function indexInputs(input: ComputePlanInput): Indexes {
  const rowBy = new Map<string, MonthPlanRowInput>();
  for (const r of input.rows) rowBy.set(key(r.categoryId, r.month), r);

  const autoBy = new Map<string, { cents: bigint; source: "recurring" | "goal" }>();
  for (const a of input.autoPlans) {
    const k = key(a.categoryId, a.month);
    const prev = autoBy.get(k);
    autoBy.set(k, prev ? { cents: prev.cents + a.cents, source: prev.source } : { cents: a.cents, source: a.source });
  }

  const actualBy = new Map<string, { signedCents: bigint; pendingSignedCents: bigint; count: number }>();
  for (const a of input.actuals) {
    const k = key(a.categoryId, a.month);
    const prev = actualBy.get(k) ?? { signedCents: 0n, pendingSignedCents: 0n, count: 0 };
    actualBy.set(k, {
      signedCents: prev.signedCents + a.signedCents,
      pendingSignedCents: prev.pendingSignedCents + a.pendingSignedCents,
      count: prev.count + a.count,
    });
  }

  const goalNetBy = new Map<string, { signedCents: bigint; count: number }>();
  for (const g of input.goalNets) {
    const k = key(g.goalId, g.month);
    const prev = goalNetBy.get(k) ?? { signedCents: 0n, count: 0 };
    goalNetBy.set(k, { signedCents: prev.signedCents + g.signedCents, count: prev.count + g.count });
  }

  const uncategorizedBy = new Map<MonthKey, { count: number; cents: bigint }>();
  for (const u of input.uncategorized) {
    const prev = uncategorizedBy.get(u.month) ?? { count: 0, cents: 0n };
    uncategorizedBy.set(u.month, { count: prev.count + u.count, cents: prev.cents + u.signedCents });
  }

  return { rowBy, autoBy, actualBy, goalNetBy, uncategorizedBy };
}

/** Bucket-natural actual of a category in a month: sign × categorized rows + the goal's net linked transfers. */
function actualOf(
  idx: Indexes,
  c: PlanCategoryInput,
  goal: GoalInput | null,
  m: MonthKey,
): { actual: bigint; pending: bigint; count: number } {
  const sign = bucketSign(c.bucket);
  const a = idx.actualBy.get(key(c.id, m));
  const g = goal ? idx.goalNetBy.get(key(goal.id, m)) : undefined;
  return {
    actual: sign * (a?.signedCents ?? 0n) + (g?.signedCents ?? 0n),
    pending: sign * (a?.pendingSignedCents ?? 0n),
    count: (a?.count ?? 0) + (g?.count ?? 0),
  };
}

/** Fold one category's chain and return its visible cells, aligned with `months`. */
function categoryCells(input: ComputePlanInput, idx: Indexes, c: PlanCategoryInput, goal: GoalInput | null): PlanCell[] {
  const isIncome = c.bucket === "income";
  const chainStart = maxMonth(input.startMonth, c.rolloverFromMonth ?? input.startMonth);
  const cells: PlanCell[] = [];
  let carry = 0n;

  for (const m of monthRange(minMonth(input.from, chainStart), input.to)) {
    const row = idx.rowBy.get(key(c.id, m));
    const auto = idx.autoBy.get(key(c.id, m));

    let plannedCents = 0n;
    let source: PlannedSource = "none";
    let hasExplicitPlan = false;
    if (row && row.plannedCents !== null) {
      plannedCents = row.plannedCents;
      source = row.plannedSource ?? "manual";
      hasExplicitPlan = true;
    } else if (auto && auto.cents > 0n) {
      plannedCents = auto.cents;
      source = auto.source;
    }

    const beforeChain = m < chainStart;
    const mode: RolloverMode = isIncome || beforeChain ? "none" : (row?.rolloverMode ?? c.rolloverMode);

    let carriedInCents = 0n;
    let carriedInSource: CarriedInSource = "none";
    if (isIncome || beforeChain) {
      // income never carries; months before the chain start behave as 'none'
    } else if (row && row.carriedInOverrideCents !== null) {
      carriedInCents = row.carriedInOverrideCents;
      carriedInSource = "override";
    } else if (m === chainStart) {
      carriedInSource = "start";
    } else {
      carriedInCents = carry;
      carriedInSource = "chain";
    }

    const { actual, pending, count } = actualOf(idx, c, goal, m);
    const availableCents = plannedCents + carriedInCents;
    const remainingCents = availableCents - actual;
    const overspendCents = isIncome ? 0n : maxBig(0n, -remainingCents);
    carry = carryOut(mode, remainingCents);

    if (m >= input.from) {
      cells.push({
        plannedCents,
        source,
        hasExplicitPlan,
        carriedInCents,
        carriedInSource,
        availableCents,
        actualCents: actual,
        pendingCents: pending,
        remainingCents,
        overspendCents,
        committedCents: committedCents(plannedCents, carriedInCents, actual),
        rolloverMode: mode,
        txnCount: count,
        overspent: overspendCents > 0n,
        note: row?.note ?? null,
      });
    }
  }
  return cells;
}

function goalSummary(input: ComputePlanInput, idx: Indexes, c: PlanCategoryInput, goal: GoalInput, currentMonth: MonthKey): GoalSummary {
  const actualByMonth = new Map<MonthKey, bigint>();
  for (const m of monthRange(goal.startMonth, currentMonth)) actualByMonth.set(m, actualOf(idx, c, goal, m).actual);
  return {
    id: goal.id,
    name: goal.name,
    targetCents: goal.targetCents,
    targetDate: goal.targetDate,
    linkedAccountId: goal.linkedAccountId,
    linkedAccountName: goal.linkedAccountName,
    monthlyContributionCents: goal.monthlyContributionCents,
    startMonth: goal.startMonth,
    startingCents: goal.startingCents,
    status: goal.status,
    progress: goalProgress(goal, actualByMonth, currentMonth),
  };
}

/**
 * The whole grid for [from, to]: display-ordered rows (bucket → groups with their
 * categories → ungrouped categories), per-category rollover chains folded from
 * max(startMonth, rolloverFromMonth), subtotal rows (hidden members included so
 * money never disappears) and the per-month summary strip. Pure and deterministic.
 */
export function computePlan(input: ComputePlanInput): PlanResult {
  if (input.from > input.to) throw new Error(`Invalid plan range: ${input.from} > ${input.to}`);
  const currentMonth = monthKey(input.today);
  const months = monthRange(input.from, input.to);
  const idx = indexInputs(input);

  const goalById = new Map<string, GoalInput>();
  const goalByCategory = new Map<string, GoalInput>();
  for (const g of input.goals) {
    goalById.set(g.id, g);
    goalByCategory.set(g.categoryId, g);
  }
  const groupById = new Map(input.groups.map((g) => [g.id, g]));

  const categoryRows = new Map<string, PlanCategoryRowResult>();
  for (const c of input.categories) {
    const goal = (c.goalId !== null ? goalById.get(c.goalId) : undefined) ?? goalByCategory.get(c.id) ?? null;
    const group = c.groupId !== null ? groupById.get(c.groupId) : undefined;
    const inGroup = group !== undefined && group.bucket === c.bucket;
    categoryRows.set(c.id, {
      kind: "category",
      bucket: c.bucket,
      groupId: inGroup ? group.id : null,
      categoryId: c.id,
      name: c.name,
      position: c.position,
      hidden: c.hidden || (inGroup && group.hidden),
      rolloverMode: c.rolloverMode,
      rolloverFromMonth: c.rolloverFromMonth,
      goal: goal ? goalSummary(input, idx, c, goal, currentMonth) : null,
      cells: categoryCells(input, idx, c, goal),
    });
  }

  const rows: PlanRowResult[] = [];
  const sortedGroups = [...input.groups].sort(byPositionThenName);
  const sortedCategories = [...input.categories].sort(byPositionThenName);
  for (const bucket of BUCKET_ORDER) {
    const bucketRows = sortedCategories.filter((c) => c.bucket === bucket).map((c) => categoryRows.get(c.id)!);
    rows.push({ kind: "bucket", bucket, cells: sumCells(bucketRows.map((r) => r.cells), months.length) });
    for (const g of sortedGroups) {
      if (g.bucket !== bucket) continue;
      const members = bucketRows.filter((r) => r.groupId === g.id);
      rows.push({
        kind: "group",
        bucket,
        groupId: g.id,
        name: g.name,
        position: g.position,
        hidden: g.hidden,
        cells: sumCells(members.map((r) => r.cells), months.length),
      });
      rows.push(...members);
    }
    rows.push(...bucketRows.filter((r) => r.groupId === null));
  }

  const summary: MonthSummaryResult[] = months.map((month, i) => {
    const planned = emptyTotals();
    const actual = emptyTotals();
    const committed = emptyTotals();
    for (const r of categoryRows.values()) {
      const cell = r.cells[i];
      if (!cell) continue;
      planned[r.bucket] += cell.plannedCents;
      actual[r.bucket] += cell.actualCents;
      committed[r.bucket] += cell.committedCents;
    }
    const plannedOutflows = planned.bills + planned.savings + planned.spending;
    const plannedLeftToSpendCents = planned.income - plannedOutflows;
    const leftToSpendCents = committed.income - committed.bills - committed.savings - committed.spending;
    const toAssignCents = committed.income - plannedOutflows;
    const uncategorized = idx.uncategorizedBy.get(month) ?? { count: 0, cents: 0n };
    return {
      month,
      state: month < currentMonth ? "past" : month === currentMonth ? "current" : "future",
      planned,
      actual,
      committed,
      plannedLeftToSpendCents,
      leftToSpendCents,
      toAssignCents,
      warning: (input.zeroBased ? toAssignCents : leftToSpendCents) < 0n,
      pace: month === currentMonth ? paceCents(leftToSpendCents, input.today) : null,
      uncategorized: { count: uncategorized.count, cents: uncategorized.cents },
    };
  });

  return {
    today: input.today,
    currentMonth,
    from: input.from,
    to: input.to,
    months,
    zeroBased: input.zeroBased,
    rows,
    summary,
  };
}
