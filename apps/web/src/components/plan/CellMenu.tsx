import { useEffect, useRef, useState } from "react";
import type { PlanCellView, RolloverMode } from "@meridian/shared";
import { RolloverMode as RolloverModeEnum } from "@meridian/shared";
import { money } from "../../lib/format.js";
import { ROLLOVER_LABELS, monthLabel, type PlanCategoryRow } from "../../lib/plan.js";

export type MenuSection = "average" | "rollover";

export interface CellMenuProps {
  row: PlanCategoryRow;
  cell: PlanCellView;
  month: string;
  currentMonth: string;
  /** Where the menu opens (the "⋯" button or the input). */
  anchor: DOMRect;
  initialSection?: MenuSection | undefined;
  canFillRight: boolean;
  busy: boolean;
  onClose: () => void;
  onFillRight: () => void;
  onPlanFromAverage: (months: 3 | 6 | 12) => void;
  onClear: () => void;
  onRollover: (mode: RolloverMode, fromMonth: string | null) => void;
  onDrillDown: () => void;
}

const MENU_WIDTH = 280;

/** The "⋯" popover on a category cell. Fixed-positioned so the grid's scroll clipping never hides it. */
export function CellMenu(props: CellMenuProps) {
  const { row, cell, month, currentMonth, anchor, initialSection, canFillRight, busy, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<MenuSection | null>(initialSection ?? null);
  const [mode, setMode] = useState<RolloverMode>(row.rolloverMode);
  const [fromMonth, setFromMonth] = useState<string>(row.rolloverFromMonth ?? currentMonth);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button, select, input")?.focus();
  }, []);

  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));
  const top = anchor.bottom + 4 + 320 > window.innerHeight ? Math.max(8, anchor.top - 4 - 320) : anchor.bottom + 4;
  const isIncome = row.bucket === "income";

  return (
    <div ref={ref} className="plan-menu" style={{ left, top, width: MENU_WIDTH }} role="menu" aria-label={`${row.name}, ${monthLabel(month)}`}>
      <div className="plan-menu-head">
        <strong>{row.name}</strong>
        <span className="muted small">
          {monthLabel(month)} · planned {money(cell.plannedCents)}
          {cell.hasExplicitPlan ? "" : " (auto)"}
        </span>
      </div>
      {section === null && (
        <ul>
          <li>
            <button type="button" className="link" disabled={!canFillRight || busy} onClick={props.onFillRight} title="Copy this value into every later visible month (Ctrl+Shift+→)">
              Fill right
            </button>
          </li>
          <li>
            <button type="button" className="link" disabled={busy} onClick={() => setSection("average")} title="Plan this month from the average of past months (Ctrl+Shift+A)">
              Plan from average…
            </button>
          </li>
          <li>
            <button type="button" className="link" disabled={!cell.hasExplicitPlan || busy} onClick={props.onClear} title="Remove the typed value so the automatic value shows through">
              Clear (use automatic value)
            </button>
          </li>
          <li>
            <button type="button" className="link" onClick={() => setSection("rollover")}>
              Rollover: {ROLLOVER_LABELS[row.rolloverMode]}…
            </button>
          </li>
          <li>
            <button type="button" className="link" onClick={props.onDrillDown}>
              Show transactions ({cell.txnCount})
            </button>
          </li>
        </ul>
      )}
      {section === "average" && (
        <div className="plan-menu-section">
          <p className="small muted">Average of the complete months before {monthLabel(month < currentMonth ? month : currentMonth)}, divided by the months that have data.</p>
          <div className="row">
            {([3, 6, 12] as const).map((n) => (
              <button key={n} type="button" className="secondary" disabled={busy} onClick={() => props.onPlanFromAverage(n)}>
                {n} months
              </button>
            ))}
          </div>
          <button type="button" className="link small" onClick={() => setSection(null)}>
            back
          </button>
        </div>
      )}
      {section === "rollover" && (
        <div className="plan-menu-section">
          {isIncome ? (
            <p className="small muted">Income categories don't roll over.</p>
          ) : (
            <>
              <label>
                Carry remaining into the next month
                <select value={mode} onChange={(e) => setMode(e.target.value as RolloverMode)}>
                  {RolloverModeEnum.options.map((m) => (
                    <option key={m} value={m}>
                      {ROLLOVER_LABELS[m]}
                    </option>
                  ))}
                </select>
              </label>
              {mode !== "none" && (
                <label>
                  Starting with
                  <input type="month" value={fromMonth} onChange={(e) => setFromMonth(e.target.value)} />
                </label>
              )}
              <div className="row">
                <button type="button" disabled={busy || (mode !== "none" && !/^\d{4}-\d{2}$/.test(fromMonth))} onClick={() => props.onRollover(mode, mode === "none" ? null : fromMonth)}>
                  Save
                </button>
                <button type="button" className="secondary" onClick={() => setSection(null)}>
                  Back
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
