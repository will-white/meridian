import { useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { Link } from "react-router";
import type { PlanCellView, PlanRow } from "@meridian/shared";
import { money } from "../../lib/format.js";
import { carriedText, drillDownUrl, parseAmountInput, plannedInputValue, sourceMarker, type PlanCategoryRow } from "../../lib/plan.js";

export type MoveDir = "up" | "down" | "left" | "right";
export type MonthState = "past" | "current" | "future";

/** What a category cell can ask the grid to do. Row and column are indexes into the visible rows / months. */
export interface CellActions {
  /** Commit a planned value; null restores the automatic value. */
  commit: (rowIndex: number, col: number, cents: bigint | null) => void;
  /** Focus the neighbouring cell; false when there is none (so Tab can leave the grid). */
  move: (rowIndex: number, col: number, dir: MoveDir) => boolean;
  fillRight: (rowIndex: number, col: number) => void;
  openMenu: (rowIndex: number, col: number, anchor: HTMLElement, section?: "average") => void;
}

const SOURCE_TITLES: Record<string, string> = {
  recurring: "Automatic: from recurring bills and income",
  goal: "Automatic: the goal's monthly contribution",
  average: "Planned from an average",
};

export function cellTitle(cell: PlanCellView, editable = true): string {
  const carried = carriedText(cell.carriedInCents);
  return [
    `Planned ${money(cell.plannedCents)}${editable && !cell.hasExplicitPlan ? " (auto)" : ""}`,
    carried ? `Carried ${carried}` : null,
    `Actual ${money(cell.actualCents)}`,
    `Remaining ${money(cell.remainingCents)}`,
    cell.pendingCents !== "0" ? `incl. ${money(cell.pendingCents)} pending` : null,
    cell.note ? `Note: ${cell.note}` : null,
  ]
    .filter((s) => s !== null)
    .join("\n");
}

interface CategoryCellProps {
  row: PlanCategoryRow;
  cell: PlanCellView;
  month: string;
  rowIndex: number;
  col: number;
  compact: boolean;
  state: MonthState;
  actions: CellActions;
}

/** One editable month of a category row: planned input, actual (drill-down), remaining and notes. */
export function CategoryCell({ row, cell, month, rowIndex, col, compact, state, actions }: CategoryCellProps) {
  const display = plannedInputValue(cell);
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const setDraftBoth = (v: string | null) => {
    draftRef.current = v;
    setDraft(v);
  };
  const reset = () => {
    setDraftBoth(null);
    setError(null);
  };

  /** Commit the draft when it differs from what the cell shows. False when the text is not an amount. */
  const commitIfChanged = (): boolean => {
    const text = draftRef.current;
    if (text === null || text === display) {
      reset();
      return true;
    }
    const parsed = parseAmountInput(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return false;
    }
    reset();
    if (parsed.cents === null) {
      if (cell.hasExplicitPlan) actions.commit(rowIndex, col, null);
      return true;
    }
    if (cell.hasExplicitPlan && parsed.cents.toString() === cell.plannedCents) return true;
    actions.commit(rowIndex, col, parsed.cents);
    return true;
  };

  const onFocus = (e: FocusEvent<HTMLInputElement>) => {
    if (draftRef.current === null) setDraftBoth(display);
    e.currentTarget.select();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.key === "ArrowRight") {
      e.preventDefault();
      if (commitIfChanged()) actions.fillRight(rowIndex, col);
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      if (commitIfChanged() && inputRef.current) actions.openMenu(rowIndex, col, inputRef.current, "average");
      return;
    }
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        if (commitIfChanged()) actions.move(rowIndex, col, e.shiftKey ? "up" : "down");
        return;
      case "Tab":
        if (!commitIfChanged()) {
          e.preventDefault();
          return;
        }
        // At the grid's edge the browser's own Tab order takes over.
        if (actions.move(rowIndex, col, e.shiftKey ? "left" : "right")) e.preventDefault();
        return;
      case "ArrowDown":
        e.preventDefault();
        if (commitIfChanged()) actions.move(rowIndex, col, "down");
        return;
      case "ArrowUp":
        e.preventDefault();
        if (commitIfChanged()) actions.move(rowIndex, col, "up");
        return;
      case "Escape":
        e.preventDefault();
        reset();
        e.currentTarget.select();
        return;
      case "Delete":
        if ((draftRef.current ?? display) === "") {
          e.preventDefault();
          reset();
          if (cell.hasExplicitPlan) actions.commit(rowIndex, col, null);
        }
        return;
      default:
        return;
    }
  };

  const marker = sourceMarker(cell.source);
  const auto = !cell.hasExplicitPlan;
  const carried = carriedText(cell.carriedInCents);
  const pending = cell.pendingCents !== "0" ? `incl. ${money(cell.pendingCents)} pending` : null;
  const remaining = remainingParts(cell.remainingCents, row.bucket);
  const classes = ["plan-cell", "editable", state, cell.overspent ? "overspent" : "", auto ? "auto" : "", error ? "invalid" : ""].filter(Boolean).join(" ");

  return (
    <div className={classes} title={cellTitle(cell)}>
      <div className="plan-planned">
        <input
          ref={inputRef}
          data-cell={`${rowIndex}:${col}`}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          aria-label={`${row.name} planned for ${month}`}
          aria-invalid={error ? true : undefined}
          value={draft ?? display}
          onFocus={onFocus}
          onChange={(e) => {
            setDraftBoth(e.target.value);
            if (error) setError(null);
          }}
          onBlur={() => void commitIfChanged()}
          onKeyDown={onKeyDown}
        />
        {marker && (
          <span className={`plan-src src-${cell.source}`} title={SOURCE_TITLES[cell.source]}>
            {marker}
          </span>
        )}
        <button type="button" className="plan-menu-btn" aria-label={`Actions for ${row.name}, ${month}`} onClick={(e) => actions.openMenu(rowIndex, col, e.currentTarget)}>
          ⋯
        </button>
      </div>
      {compact ? (
        <span className={`plan-remaining ${remaining.className}`}>{remaining.amount}</span>
      ) : (
        <div className="plan-sub">
          <Link className="plan-actual" to={drillDownUrl(row, month)} title={`${cell.txnCount} transaction${cell.txnCount === 1 ? "" : "s"}; click to review`}>
            {money(cell.actualCents)}
          </Link>
          <span className={`plan-remaining ${remaining.className}`}>
            {remaining.amount} {remaining.label}
          </span>
          {carried && <span className="plan-carried">{carried}</span>}
          {pending && <span className="plan-pending">{pending}</span>}
        </div>
      )}
      {error && <span className="plan-cell-error">{error}</span>}
    </div>
  );
}

/**
 * How to show "remaining": red when an outflow bucket is over, green when income
 * came in above plan (a negative remaining is good news there).
 */
export function remainingParts(remainingCents: string, bucket: PlanRow["bucket"]): { amount: string; label: string; className: string; bad: boolean } {
  const negative = remainingCents.startsWith("-");
  if (bucket === "income") {
    if (negative) return { amount: money(remainingCents.slice(1)), label: "extra", className: "pos", bad: false };
    return { amount: money(remainingCents), label: "to come", className: "", bad: false };
  }
  return { amount: money(remainingCents), label: "left", className: negative ? "neg" : "", bad: negative };
}

/** A bucket or group subtotal month: planned, actual and remaining as plain text. */
export function TotalCell({ cell, bucket, compact, state }: { cell: PlanCellView; bucket: PlanRow["bucket"]; compact: boolean; state: MonthState }) {
  const remaining = remainingParts(cell.remainingCents, bucket);
  return (
    <div className={`plan-cell total ${state} ${remaining.bad ? "overspent" : ""}`} title={cellTitle(cell, false)}>
      {!compact && <span className="plan-total-planned">{money(cell.plannedCents)}</span>}
      {!compact && <span className="plan-total-actual">{money(cell.actualCents)}</span>}
      <span className={`plan-remaining ${remaining.className}`} title={remaining.label}>
        {remaining.amount}
      </span>
    </div>
  );
}
