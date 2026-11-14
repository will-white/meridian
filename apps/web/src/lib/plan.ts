import { addMonths, formatCents, isMonthKey, monthDiff, monthEnd, monthKey, monthStart, parseDecimalToCents } from "@meridian/shared";
import { MAX_WIRE_CENTS } from "./amounts.js";
import type { MonthSummaryView, PlanCellEdit, PlanCellView, PlanResponse, PlanRow } from "@meridian/shared";
import { query } from "./api.js";
import { money } from "./format.js";

/**
 * Pure helpers for the spending-plan grid: range handling, amount entry,
 * optimistic cell patches, drill-down URLs and row navigation. No React, no
 * DOM, no floats. See docs/design/phase-2/grid-and-api.md ("Web").
 */

export type PlanCategoryRow = Extract<PlanRow, { kind: "category" }>;
export type PlanGroupRow = Extract<PlanRow, { kind: "group" }>;
export type PaceView = NonNullable<MonthSummaryView["pace"]>;

/** The server caps a plan range at this many months. */
export const MAX_RANGE_MONTHS = 24;
/** dataTransfer type a draggable transaction row carries (the transaction id). */
export { TRANSACTION_DRAG_TYPE } from "./recategorize.js";

const pad = (n: number): string => String(n).padStart(2, "0");

/** The browser's local calendar date, which the PWA sends as `today`. */
export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The server's default: two months back through three months ahead (6 columns). */
export function defaultRange(today: string): { from: string; to: string } {
  const current = monthKey(today);
  return { from: addMonths(current, -2), to: addMonths(current, 3) };
}

/**
 * Resolve `?from&to` from the URL. Each side defaults independently; an
 * inverted or over-long range is repaired rather than sent to the server.
 */
export function resolveRange(fromParam: string | null, toParam: string | null, today: string): { from: string; to: string } {
  const d = defaultRange(today);
  const fromGiven = fromParam !== null && isMonthKey(fromParam);
  const toGiven = toParam !== null && isMonthKey(toParam);
  let from = fromGiven ? fromParam : d.from;
  let to = toGiven ? toParam : d.to;
  if (from > to) {
    if (fromGiven && !toGiven) to = addMonths(from, 5);
    else if (toGiven && !fromGiven) from = addMonths(to, -5);
    else return d;
  }
  if (monthDiff(from, to) + 1 > MAX_RANGE_MONTHS) to = addMonths(from, MAX_RANGE_MONTHS - 1);
  return { from, to };
}

export type ParsedAmount = { ok: true; cents: bigint | null } | { ok: false; error: string };

/** The largest amount a request may carry: the wire's cents are at most 15 digits (9,999,999,999,999.99). */
export const MAX_PLANNED_CENTS = MAX_WIRE_CENTS;

/**
 * Parse what a person types into a planned cell: "1,234.50", "$12", "12.5",
 * " 1 000 ". Empty means "no value" (clear). Negatives are rejected; the grid
 * holds magnitudes in the bucket's direction. An amount past the API's bound is
 * refused here, in the person's words, instead of by the request's validation.
 */
export function parseAmountInput(raw: string): ParsedAmount {
  let s = raw.replace(/[$,\s]/g, "");
  if (s === "") return { ok: true, cents: null };
  if (s.startsWith("-") || s.startsWith("(")) return { ok: false, error: "Amounts can't be negative" };
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith(".")) s = `0${s}`;
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (/^\d+\.\d{3,}$/.test(s)) return { ok: false, error: "Use at most two decimals" };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, error: "Not an amount" };
  const cents = parseDecimalToCents(s);
  if (cents > MAX_PLANNED_CENTS) return { ok: false, error: "Too large" };
  return { ok: true, cents };
}

/** The text a planned input shows when nobody is typing: the resolved value, or empty for an auto zero. */
export function plannedInputValue(cell: Pick<PlanCellView, "plannedCents" | "hasExplicitPlan">): string {
  if (!cell.hasExplicitPlan && cell.plannedCents === "0") return "";
  return formatCents(BigInt(cell.plannedCents));
}

/** The one-letter marker shown beside a planned value that was not typed. */
export function sourceMarker(source: PlanCellView["source"]): string | null {
  switch (source) {
    case "recurring":
      return "R";
    case "goal":
      return "G";
    case "average":
      return "A";
    default:
      return null;
  }
}

/**
 * One manual edit per visible month after `fromIndex`, carrying `cents`: by default the
 * displayed (resolved) value of the source cell, which is right for the cell menu (it waits
 * for the plan to be fresh). The keyboard shortcut passes the value it is committing.
 */
export function fillRightEdits(row: PlanCategoryRow, months: readonly string[], fromIndex: number, cents?: bigint): PlanCellEdit[] {
  const source = row.cells[fromIndex];
  if (!source) return [];
  const plannedCents = (cents ?? BigInt(source.plannedCents)).toString();
  const edits: PlanCellEdit[] = [];
  for (let i = fromIndex + 1; i < months.length; i++) {
    const month = months[i];
    if (month !== undefined) edits.push({ month, categoryId: row.categoryId, plannedCents, source: "manual" });
  }
  return edits;
}

/** What leaving a planned input does with its text (Enter, Tab, arrows, blur, the fill-right shortcut). */
export type CellCommit =
  /** Nothing new: the cell keeps the value it shows (`cents`, the resolved value). */
  | { kind: "keep"; cents: bigint }
  /** A new planned amount for the month. */
  | { kind: "set"; cents: bigint }
  /** The typed value is removed, so the automatic value shows through. */
  | { kind: "clear" }
  | { kind: "invalid"; error: string };

/**
 * Decide what a planned input's text means against the cell as the plan last showed it. `text`
 * is null when nobody typed. Re-typing the shown value, or emptying an automatic cell, is no edit.
 */
export function resolveCellCommit(text: string | null, cell: Pick<PlanCellView, "plannedCents" | "hasExplicitPlan">): CellCommit {
  const shown = BigInt(cell.plannedCents);
  if (text === null || text === plannedInputValue(cell)) return { kind: "keep", cents: shown };
  const parsed = parseAmountInput(text);
  if (!parsed.ok) return { kind: "invalid", error: parsed.error };
  if (parsed.cents === null) return cell.hasExplicitPlan ? { kind: "clear" } : { kind: "keep", cents: shown };
  if (cell.hasExplicitPlan && parsed.cents === shown) return { kind: "keep", cents: shown };
  return { kind: "set", cents: parsed.cents };
}

/**
 * The edits one commit sends, in one batch (one request, one audit batch). With `fillRight`
 * (Ctrl/Cmd+Shift+→) every later visible month gets the value being committed: the amount just
 * typed, or the shown value when nothing was typed. Emptying a typed cell sends only the clear:
 * the automatic value it falls back to is known once the server answers, and the cell menu's
 * Fill right copies it from there.
 */
export function cellEdits(row: PlanCategoryRow, months: readonly string[], col: number, commit: CellCommit, opts: { fillRight: boolean }): PlanCellEdit[] {
  const month = months[col];
  if (month === undefined) return [];
  switch (commit.kind) {
    case "invalid":
      return [];
    case "clear":
      return [{ month, categoryId: row.categoryId, plannedCents: null, source: "manual" }];
    case "keep":
      return opts.fillRight ? fillRightEdits(row, months, col, commit.cents) : [];
    case "set": {
      const own: PlanCellEdit = { month, categoryId: row.categoryId, plannedCents: commit.cents.toString(), source: "manual" };
      return opts.fillRight ? [own, ...fillRightEdits(row, months, col, commit.cents)] : [own];
    }
  }
}

/** A month before the household's plan start month takes no plan edits (the API answers 400 `before_plan_start`). */
export function beforePlanStart(month: string, startMonth: string): boolean {
  return month < startMonth;
}

const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** Patch one cell the way the server will, so the grid answers before the round trip. */
export function patchCell(cell: PlanCellView, bucket: PlanRow["bucket"], edit: PlanCellEdit): PlanCellView {
  if (edit.plannedCents === undefined) return cell;
  const cleared = edit.plannedCents === null;
  // A cleared cell reverts to its auto value, which only the server knows; keep the number until it answers.
  const planned = edit.plannedCents === null ? BigInt(cell.plannedCents) : BigInt(edit.plannedCents);
  const carried = BigInt(cell.carriedInCents);
  const actual = BigInt(cell.actualCents);
  const available = planned + carried;
  const remaining = available - actual;
  const overspend = bucket === "income" ? 0n : maxBig(0n, -remaining);
  const committed = maxBig(available, actual) - maxBig(carried, 0n);
  return {
    ...cell,
    plannedCents: planned.toString(),
    source: cleared ? "none" : edit.source,
    hasExplicitPlan: !cleared,
    availableCents: available.toString(),
    remainingCents: remaining.toString(),
    overspendCents: overspend.toString(),
    committedCents: committed.toString(),
    overspent: overspend > 0n,
  };
}

/** Apply edits to the cached plan: category cells only; subtotals and the strip wait for the response. */
export function applyEdits(plan: PlanResponse, edits: readonly PlanCellEdit[]): PlanResponse {
  const byKey = new Map<string, PlanCellEdit>();
  for (const e of edits) byKey.set(`${e.categoryId}|${e.month}`, e);
  return {
    ...plan,
    rows: plan.rows.map((row) => {
      if (row.kind !== "category") return row;
      let touched = false;
      const cells = row.cells.map((cell, i) => {
        const month = plan.months[i];
        const edit = month === undefined ? undefined : byKey.get(`${row.categoryId}|${month}`);
        if (!edit) return cell;
        touched = true;
        return patchCell(cell, row.bucket, edit);
      });
      return touched ? { ...row, cells } : row;
    }),
  };
}

/** What a drill-down shows: the transactions behind a category cell's actual, or a month's uncategorized ones. */
export type DrillTarget = { kind: "category"; row: Pick<PlanCategoryRow, "categoryId" | "goal">; month: string } | { kind: "uncategorized"; month: string };

/**
 * The register query behind a drill-down. `planScope` asks for exactly what the plan counts
 * (on-budget accounts, split transactions by their lines), so the list adds up to the cell.
 * The Plan page's drill-down panel and the register link use the same query.
 */
export function drillDownQuery(target: DrillTarget): Record<string, string | boolean> {
  const from = monthStart(target.month);
  const to = monthEnd(target.month);
  if (target.kind === "uncategorized") return { uncategorized: true, from, to, planScope: true };
  if (target.row.goal) return { goalId: target.row.goal.id, from, to, planScope: true };
  return { categoryId: target.row.categoryId, from, to, transfers: "exclude", planScope: true };
}

/** The register page behind a cell's actual. */
export function drillDownUrl(row: Pick<PlanCategoryRow, "categoryId" | "goal">, month: string): string {
  return `/transactions${query(drillDownQuery({ kind: "category", row, month }))}`;
}

export function uncategorizedUrl(month: string): string {
  return `/transactions${query(drillDownQuery({ kind: "uncategorized", month }))}`;
}

/**
 * What saving a rollover setting will do, in the owner's words. A change applies from the
 * current month on and closed months keep what they carried; a later start month restarts
 * the envelope there; only an earlier start month recomputes history.
 */
export function rolloverChangeNote(
  row: Pick<PlanCategoryRow, "rolloverMode" | "rolloverFromMonth">,
  mode: PlanCategoryRow["rolloverMode"],
  fromMonth: string | null,
  currentMonth: string,
): string {
  const was = row.rolloverMode;
  const wasFrom = row.rolloverFromMonth;
  if (mode === was && (mode === "none" || fromMonth === wasFrom)) return "No change.";
  if (was === "none") {
    if (mode === "none") return "No change.";
    return fromMonth !== null && fromMonth < currentMonth
      ? `Carries from ${monthLabel(fromMonth)} on: the months since then are recomputed with this setting.`
      : `Carries from ${monthLabel(fromMonth ?? currentMonth)} on, starting from zero.`;
  }
  if (mode === "none") return `Stops carrying from ${monthLabel(currentMonth)} on. Earlier months, and what was carried into ${monthLabel(currentMonth)}, stay as they are.`;
  const start = wasFrom ?? fromMonth;
  if (fromMonth !== null && start !== null && fromMonth < start) return `Recomputes the whole chain from ${monthLabel(fromMonth)} with this setting.`;
  if (fromMonth !== null && start !== null && fromMonth > start) {
    return `Restarts the envelope at ${monthLabel(fromMonth)} from zero: what was carried before is not brought forward. Earlier months stay as they are.`;
  }
  return `Applies from ${monthLabel(currentMonth)} on. Earlier months keep what they carried, and so does ${monthLabel(currentMonth)}.`;
}

/**
 * What "plan from average" does with the server's answer: without one complete month of
 * history there is nothing to average, so nothing is written and the notice says why.
 */
export function averagePlanOutcome(input: { name: string; month: string; months: 3 | 6 | 12; cents: string; monthsWithData: number }): { write: boolean; notice: string } {
  const where = `${input.name}, ${monthLabel(input.month)}`;
  if (input.monthsWithData === 0) {
    return { write: false, notice: `${where}: there is no complete month of history to average yet (a month counts once the ledger covers it from the 1st). Nothing was changed.` };
  }
  const months = `${input.monthsWithData} complete month${input.monthsWithData === 1 ? "" : "s"} of history`;
  return { write: true, notice: `${where}: planned ${money(input.cents)} from the ${input.months}-month average (${months}).` };
}

/** "$92.29/day for 19 days" or "over by $50.00". */
export function paceText(pace: PaceView): string {
  if (BigInt(pace.overCents) > 0n) return `over by ${money(pace.overCents)}`;
  return `${money(pace.perDayCents)}/day for ${pace.daysLeft} day${pace.daysLeft === 1 ? "" : "s"}`;
}

/** "+$55.00 in" / "-$60.00 in"; null when nothing carried. */
export function carriedText(carriedInCents: string): string | null {
  const n = BigInt(carriedInCents);
  if (n === 0n) return null;
  return `${n > 0n ? "+" : ""}${money(carriedInCents)} in`;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 2026". */
export function monthLabel(month: string): string {
  const name = MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month.slice(5, 7);
  return `${name} ${month.slice(0, 4)}`;
}

export function rowHeight(row: Pick<PlanRow, "kind">, compact: boolean): number {
  switch (row.kind) {
    case "bucket":
      return 40;
    case "group":
      return 32;
    default:
      return compact ? 28 : 48;
  }
}

/** Rows the grid shows: hidden categories and hidden groups (with their members) only on request. */
export function visibleRows(rows: readonly PlanRow[], showHidden: boolean): PlanRow[] {
  if (showHidden) return [...rows];
  const hiddenGroups = new Set(rows.filter((r): r is PlanGroupRow => r.kind === "group" && r.hidden).map((r) => r.groupId));
  return rows.filter((r) => {
    if (r.kind === "group") return !r.hidden;
    if (r.kind === "category") return !r.hidden && !(r.groupId !== null && hiddenGroups.has(r.groupId));
    return true;
  });
}

/** The bucket row that should sit in the sticky header: the nearest one at or above `firstVisible`. */
export function stickyBucketIndex(rows: readonly Pick<PlanRow, "kind">[], firstVisible: number): number {
  for (let i = Math.min(firstVisible, rows.length - 1); i >= 0; i--) if (rows[i]?.kind === "bucket") return i;
  return 0;
}

/** The next category row in `dir` (skipping bucket and group rows), or null at the edge. */
export function nextCategoryIndex(rows: readonly Pick<PlanRow, "kind">[], from: number, dir: 1 | -1): number | null {
  for (let i = from + dir; i >= 0 && i < rows.length; i += dir) if (rows[i]?.kind === "category") return i;
  return null;
}

/** Swap `id` with its neighbour; unchanged (same array) at the edges or when absent. */
export function moveId(ids: readonly string[], id: string, dir: 1 | -1): string[] {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return [...ids];
  const out = [...ids];
  const a = out[i];
  const b = out[j];
  if (a === undefined || b === undefined) return out;
  out[i] = b;
  out[j] = a;
  return out;
}

export const ROLLOVER_LABELS: Record<PlanCategoryRow["rolloverMode"], string> = {
  none: "None",
  surplus: "Carry surplus only",
  all: "Carry surplus and overspend",
};
