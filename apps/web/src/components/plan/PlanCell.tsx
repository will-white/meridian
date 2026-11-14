import { useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import type { PlanCellView, PlanRow } from "@meridian/shared";
import { money } from "../../lib/format.js";
import { carriedText, plannedInputValue, resolveCellCommit, sourceMarker, type CellCommit, type PlanCategoryRow } from "../../lib/plan.js";

export type MoveDir = "up" | "down" | "left" | "right";
export type MonthState = "past" | "current" | "future";

/** What a category cell can ask the grid to do. Row and column are indexes into the visible rows / months. */
export interface CellActions {
  /**
   * Commit what the input holds. With `fillRight` (Ctrl/Cmd+Shift+→) the committed value also
   * goes into every later visible month, in the same batch (lib/plan.ts `cellEdits`).
   */
  apply: (rowIndex: number, col: number, commit: CellCommit, fillRight: boolean) => void;
  /** Focus the neighbouring cell; false when there is none (so Tab can leave the grid). */
  move: (rowIndex: number, col: number, dir: MoveDir) => boolean;
  openMenu: (rowIndex: number, col: number, anchor: HTMLElement, section?: "average") => void;
  /** Open the drill-down panel with the transactions behind the cell's actual. */
  drill: (rowIndex: number, col: number) => void;
}

const SOURCE_TITLES: Record<string, string> = {
  recurring: "Automatic: from this category's recurring items",
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
  /** Null when the planned value can be typed; otherwise why not (a viewer, a month before the plan start). */
  lockedReason: string | null;
  actions: CellActions;
}

/**
 * One month of a category row: planned input, actual (opens the drill-down), remaining and
 * notes. A locked cell keeps a read-only input, so the keyboard still walks the grid. In compact
 * mode the cell shows the remaining; the planned input covers it only while it has focus.
 */
export function CategoryCell({ row, cell, month, rowIndex, col, compact, state, lockedReason, actions }: CategoryCellProps) {
  const display = plannedInputValue(cell);
  const editable = lockedReason === null;
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

  /** Commit the draft (and with `fillRight` copy it into later months). False when the text is not an amount. */
  const commit = (fillRight = false): boolean => {
    if (!editable) {
      reset();
      return true;
    }
    const result = resolveCellCommit(draftRef.current, cell);
    if (result.kind === "invalid") {
      setError(result.error);
      return false;
    }
    reset();
    actions.apply(rowIndex, col, result, fillRight);
    return true;
  };

  const onFocus = (e: FocusEvent<HTMLInputElement>) => {
    if (editable && draftRef.current === null) setDraftBoth(display);
    e.currentTarget.select();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.key === "ArrowRight") {
      e.preventDefault();
      if (editable) commit(true);
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      if (editable && commit() && inputRef.current) actions.openMenu(rowIndex, col, inputRef.current, "average");
      return;
    }
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        if (commit()) actions.move(rowIndex, col, e.shiftKey ? "up" : "down");
        return;
      case "Tab":
        if (!commit()) {
          e.preventDefault();
          return;
        }
        // At the grid's edge the browser's own Tab order takes over.
        if (actions.move(rowIndex, col, e.shiftKey ? "left" : "right")) e.preventDefault();
        return;
      case "ArrowDown":
        e.preventDefault();
        if (commit()) actions.move(rowIndex, col, "down");
        return;
      case "ArrowUp":
        e.preventDefault();
        if (commit()) actions.move(rowIndex, col, "up");
        return;
      case "Escape":
        e.preventDefault();
        reset();
        e.currentTarget.select();
        return;
      case "Delete":
        if (editable && (draftRef.current ?? display) === "") {
          e.preventDefault();
          reset();
          if (cell.hasExplicitPlan) actions.apply(rowIndex, col, { kind: "clear" }, false);
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
  const classes = ["plan-cell", "editable", state, cell.overspent ? "overspent" : "", auto ? "auto" : "", error ? "invalid" : "", editable ? "" : "locked"].filter(Boolean).join(" ");
  const title = editable ? cellTitle(cell) : `${cellTitle(cell, false)}\n${lockedReason}`;

  return (
    <div className={classes} title={title}>
      <div className="plan-planned">
        <input
          ref={inputRef}
          className={compact ? "plan-compact-input" : undefined}
          data-cell={`${rowIndex}:${col}`}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          aria-label={`${row.name} planned for ${month}`}
          aria-invalid={error ? true : undefined}
          readOnly={!editable}
          value={draft ?? display}
          onFocus={onFocus}
          onChange={(e) => {
            setDraftBoth(e.target.value);
            if (error) setError(null);
          }}
          onBlur={() => void commit()}
          onKeyDown={onKeyDown}
        />
        {marker && !compact && (
          <span className={`plan-src src-${cell.source}`} title={SOURCE_TITLES[cell.source]}>
            {marker}
          </span>
        )}
        {compact && (
          <span className={`plan-remaining ${remaining.className}`} title={remaining.label}>
            {remaining.amount}
          </span>
        )}
        <button type="button" className="plan-menu-btn" aria-label={`Actions for ${row.name}, ${month}`} onClick={(e) => actions.openMenu(rowIndex, col, e.currentTarget)}>
          ⋯
        </button>
      </div>
      {!compact && (
        <>
          <div className="plan-sub">
            <button
              type="button"
              className="plan-actual"
              onClick={() => actions.drill(rowIndex, col)}
              title={`${cell.txnCount} transaction${cell.txnCount === 1 ? "" : "s"}; click to see them`}
            >
              {money(cell.actualCents)}
            </button>
            <span className={`plan-remaining ${remaining.className}`}>
              {remaining.amount} {remaining.label}
            </span>
          </div>
          {(carried || pending) && (
            <div className="plan-notes">
              {carried && <span className="plan-carried">{carried}</span>}
              {pending && <span className="plan-pending">{pending}</span>}
            </div>
          )}
        </>
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

/**
 * A bucket or group subtotal month, laid out like a category cell: planned on the first line,
 * actual and the labelled remaining under it (compact: the remaining only).
 */
export function TotalCell({ cell, bucket, compact, state }: { cell: PlanCellView; bucket: PlanRow["bucket"]; compact: boolean; state: MonthState }) {
  const remaining = remainingParts(cell.remainingCents, bucket);
  return (
    <div className={`plan-cell total ${state} ${remaining.bad ? "overspent" : ""}`} title={cellTitle(cell, false)}>
      {compact ? (
        <span className={`plan-remaining ${remaining.className}`} title={remaining.label}>
          {remaining.amount}
        </span>
      ) : (
        <>
          <span className="plan-total-planned" title="Planned">
            {money(cell.plannedCents)}
          </span>
          <div className="plan-sub">
            <span className="plan-total-actual" title="Actual">
              {money(cell.actualCents)}
            </span>
            <span className={`plan-remaining ${remaining.className}`}>
              {remaining.amount} {remaining.label}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
