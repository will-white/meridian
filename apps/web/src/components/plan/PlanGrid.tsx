import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import type { PlanCellEdit, PlanResponse, PlanRow, RolloverMode } from "@meridian/shared";
import { beforePlanStart, cellEdits, fillRightEdits, monthLabel, nextCategoryIndex, rowHeight, stickyBucketIndex, type DrillTarget, type PlanCategoryRow } from "../../lib/plan.js";
import { TRANSACTION_DRAG_TYPE } from "../../lib/recategorize.js";
import { Badge } from "../ui.js";
import { CellMenu, type MenuSection } from "./CellMenu.js";
import { CategoryCell, TotalCell, type CellActions, type MonthState, type MoveDir } from "./PlanCell.js";
import { SummaryStrip } from "./SummaryStrip.js";

export interface PlanGridProps {
  plan: PlanResponse;
  /** Display-ordered rows after the hidden filter; cells align with `plan.months`. */
  rows: PlanRow[];
  compact: boolean;
  zeroBased: boolean;
  /** A write is in flight: menu actions wait, typing does not. */
  busy: boolean;
  /** The signed-in user is a viewer: every value is read-only and nothing is a drop target. */
  readOnly: boolean;
  onEdits: (edits: PlanCellEdit[]) => void;
  onPlanFromAverage: (row: PlanCategoryRow, month: string, months: 3 | 6 | 12) => void;
  onRollover: (row: PlanCategoryRow, mode: RolloverMode, fromMonth: string | null) => void;
  onDropTransaction: (transactionId: string, categoryId: string) => void;
  /** Open the drill-down panel (an actual, the cell menu, the strip's uncategorized badge). */
  onDrill: (target: DrillTarget) => void;
  /** Open one cell's edit history (the cell menu's "History of this cell"). */
  onCellHistory?: (row: PlanCategoryRow, month: string) => void;
}

interface MenuState {
  rowIndex: number;
  col: number;
  anchor: DOMRect;
  section?: MenuSection | undefined;
}

interface FocusTarget {
  rowIndex: number;
  col: number;
}

const BUCKET_LABELS: Record<PlanRow["bucket"], string> = { income: "Income", bills: "Bills", savings: "Savings", spending: "Spending" };
const VIEWER_LOCK = "Read-only: only the household's owner can change the plan";

function rowKey(row: PlanRow): string {
  if (row.kind === "bucket") return `b:${row.bucket}`;
  if (row.kind === "group") return `g:${row.groupId}`;
  return `c:${row.categoryId}`;
}

function hasTransaction(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(TRANSACTION_DRAG_TYPE);
}

/** The name column of a row: label plus goal, rollover and hidden markers. */
function RowName({ row }: { row: PlanRow }) {
  if (row.kind === "bucket") return <strong>{BUCKET_LABELS[row.bucket]}</strong>;
  if (row.kind === "group")
    return (
      <span className="plan-group-name">
        {row.name}
        {row.hidden && <Badge tone="neutral">hidden</Badge>}
      </span>
    );
  return (
    <span className="plan-category-name" title={row.name}>
      <span className="plan-category-label">{row.name}</span>
      {row.goal && (
        <Badge tone={row.goal.progress.onTrack === false ? "warn" : "ok"}>
          goal {Math.floor(row.goal.progress.progressBp / 100)}%
        </Badge>
      )}
      {row.rolloverMode !== "none" && (
        <span className="plan-rollover-mark" title={`Rolls over (${row.rolloverMode === "all" ? "surplus and overspend" : "surplus only"}) from ${row.rolloverFromMonth ?? "the plan start"}`}>
          ↻
        </span>
      )}
      {row.hidden && <Badge tone="neutral">hidden</Badge>}
    </span>
  );
}

/**
 * The virtualized multi-month grid. The summary strip and the current bucket
 * header stick to the top of the scroll container; the name column sticks to
 * the left. Rows are absolutely positioned by the virtualizer and sized to their
 * content (measured), so a cell whose values wrap or carry notes is never
 * covered by the next row.
 */
export function PlanGrid(props: PlanGridProps) {
  const { plan, rows, compact, zeroBased, busy, readOnly, onEdits, onPlanFromAverage, onRollover, onDropTransaction, onDrill, onCellHistory } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [stripHeight, setStripHeight] = useState(96);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const [dragOverCategory, setDragOverCategory] = useState<string | null>(null);
  const months = plan.months;
  const stateByMonth = useMemo(() => new Map(plan.summary.map((s) => [s.month, s.state])), [plan.summary]);
  const monthState = (month: string): MonthState => stateByMonth.get(month) ?? "future";
  const startLock = `Before the plan start month (${monthLabel(plan.startMonth)}): change it in Settings`;
  const lockFor = (month: string): string | null => (readOnly ? VIEWER_LOCK : beforePlanStart(month, plan.startMonth) ? startLock : null);

  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const update = () => setStripHeight(el.offsetHeight);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [headerHeight, setHeaderHeight] = useState(() => rowHeight({ kind: "bucket" }, compact));
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => rowHeight(rows[i] ?? { kind: "category" }, compact),
    getItemKey: (i) => {
      const r = rows[i];
      return r ? rowKey(r) : i;
    },
    overscan: 8,
    scrollMargin: stripHeight,
    // The strip and the sticky bucket header cover the top of the viewport: keep focused rows below them.
    scrollPaddingStart: stripHeight + headerHeight,
  });
  // A density change resizes every row: forget the old sizes and measure the mounted rows again
  // (the rest are measured when they mount).
  useLayoutEffect(() => {
    virtualizer.measure();
    virtualizer.elementsCache.forEach((el) => virtualizer.measureElement(el));
  }, [virtualizer, compact]);

  const items = virtualizer.getVirtualItems();
  const scrollTop = virtualizer.scrollOffset ?? 0;
  const firstVisible = items.find((it) => it.end > scrollTop + stripHeight)?.index ?? items[0]?.index ?? 0;
  const stickyIndex = rows.length > 0 ? stickyBucketIndex(rows, firstVisible) : -1;
  const stickyRow = stickyIndex >= 0 ? rows[stickyIndex] : undefined;
  // The sticky header is as tall as its bucket row measures.
  const measuredHeader = virtualizer.measurementsCache[stickyIndex]?.size;
  useEffect(() => {
    if (measuredHeader !== undefined && measuredHeader !== headerHeight) setHeaderHeight(measuredHeader);
  }, [measuredHeader, headerHeight]);

  // Focus requests outlive one render: the target row may not be mounted until the virtualizer scrolls.
  useEffect(() => {
    if (!focusTarget) return;
    const el = scrollRef.current?.querySelector<HTMLInputElement>(`[data-cell="${focusTarget.rowIndex}:${focusTarget.col}"]`);
    if (el) {
      el.focus();
      el.select();
      setFocusTarget(null);
    }
  });

  const focusCell = useCallback(
    (rowIndex: number, col: number) => {
      virtualizer.scrollToIndex(rowIndex, { align: "auto" });
      setFocusTarget({ rowIndex, col });
    },
    [virtualizer],
  );

  const actions = useMemo<CellActions>(
    () => ({
      apply: (rowIndex, col, commit, fillRight) => {
        const row = rows[rowIndex];
        if (!row || row.kind !== "category") return;
        const edits = cellEdits(row, months, col, commit, { fillRight });
        if (edits.length > 0) onEdits(edits);
      },
      move: (rowIndex, col, dir: MoveDir) => {
        const last = months.length - 1;
        let target: FocusTarget | null = null;
        if (dir === "down" || dir === "up") {
          const next = nextCategoryIndex(rows, rowIndex, dir === "down" ? 1 : -1);
          if (next !== null) target = { rowIndex: next, col };
        } else if (dir === "right") {
          if (col < last) target = { rowIndex, col: col + 1 };
          else {
            const next = nextCategoryIndex(rows, rowIndex, 1);
            if (next !== null) target = { rowIndex: next, col: 0 };
          }
        } else if (col > 0) target = { rowIndex, col: col - 1 };
        else {
          const prev = nextCategoryIndex(rows, rowIndex, -1);
          if (prev !== null) target = { rowIndex: prev, col: last };
        }
        if (!target) return false;
        focusCell(target.rowIndex, target.col);
        return true;
      },
      openMenu: (rowIndex, col, anchor, section) => setMenu({ rowIndex, col, anchor: anchor.getBoundingClientRect(), section }),
      drill: (rowIndex, col) => {
        const row = rows[rowIndex];
        const month = months[col];
        if (row?.kind === "category" && month !== undefined) onDrill({ kind: "category", row, month });
      },
    }),
    [rows, months, onEdits, onDrill, focusCell],
  );

  const closeMenu = useCallback(() => setMenu(null), []);
  const menuRow = menu ? rows[menu.rowIndex] : undefined;
  const menuMonth = menu ? months[menu.col] : undefined;
  const menuCell = menu && menuRow ? menuRow.cells[menu.col] : undefined;

  const onRowDragOver = (row: PlanCategoryRow) => (e: DragEvent<HTMLDivElement>) => {
    if (!hasTransaction(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverCategory !== row.categoryId) setDragOverCategory(row.categoryId);
  };
  const onRowDrop = (row: PlanCategoryRow) => (e: DragEvent<HTMLDivElement>) => {
    setDragOverCategory(null);
    const id = e.dataTransfer.getData(TRANSACTION_DRAG_TYPE);
    if (!id) return;
    e.preventDefault();
    onDropTransaction(id, row.categoryId);
  };

  const renderCells = (row: PlanRow, rowIndex: number) =>
    row.cells.map((cell, col) => {
      const month = months[col] ?? "";
      const state = monthState(month);
      return row.kind === "category" ? (
        <CategoryCell key={month} row={row} cell={cell} month={month} rowIndex={rowIndex} col={col} compact={compact} state={state} lockedReason={lockFor(month)} actions={actions} />
      ) : (
        <TotalCell key={month} cell={cell} bucket={row.bucket} compact={compact} state={state} />
      );
    });

  const renderRow = (row: PlanRow, rowIndex: number, style: CSSProperties, sticky: boolean, measured: boolean) => {
    const dropTarget = row.kind === "category" && !readOnly;
    const classes = ["plan-row", `kind-${row.kind}`, `bucket-${row.bucket}`, sticky ? "plan-sticky-bucket" : "", row.kind === "category" && dragOverCategory === row.categoryId ? "drop-over" : ""]
      .filter(Boolean)
      .join(" ");
    return (
      <div
        key={sticky ? `sticky:${rowKey(row)}` : rowKey(row)}
        ref={measured ? virtualizer.measureElement : undefined}
        data-index={measured ? rowIndex : undefined}
        className={classes}
        style={style}
        role="row"
        data-row-index={rowIndex}
        onDragOver={dropTarget ? onRowDragOver(row) : undefined}
        onDragLeave={dropTarget ? () => setDragOverCategory((c) => (c === row.categoryId ? null : c)) : undefined}
        onDrop={dropTarget ? onRowDrop(row) : undefined}
      >
        <div className="plan-name" role="rowheader">
          <RowName row={row} />
        </div>
        {renderCells(row, rowIndex)}
      </div>
    );
  };

  return (
    <div
      ref={scrollRef}
      className={`plan-scroll ${compact ? "compact" : ""}`}
      style={{ "--plan-cols": months.length, "--plan-strip-h": `${stripHeight}px` } as CSSProperties}
      role="grid"
      aria-rowcount={rows.length}
      aria-colcount={months.length + 1}
      aria-readonly={readOnly || undefined}
    >
      <SummaryStrip
        ref={stripRef}
        summary={plan.summary}
        zeroBased={zeroBased}
        compact={compact}
        startMonth={plan.startMonth}
        onUncategorized={(month) => onDrill({ kind: "uncategorized", month })}
      />
      <div className="plan-body" style={{ height: virtualizer.getTotalSize() }}>
        {stickyRow && renderRow(stickyRow, stickyIndex, { position: "sticky", top: stripHeight, minHeight: rowHeight(stickyRow, compact) }, true, false)}
        {items.map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          return renderRow(
            row,
            item.index,
            {
              position: "absolute",
              top: item.start - virtualizer.options.scrollMargin,
              left: 0,
              right: 0,
              minHeight: rowHeight(row, compact),
              visibility: item.index === stickyIndex ? "hidden" : undefined,
            },
            false,
            true,
          );
        })}
      </div>
      {menu && menuRow && menuRow.kind === "category" && menuMonth !== undefined && menuCell && (
        <CellMenu
          row={menuRow}
          cell={menuCell}
          month={menuMonth}
          currentMonth={plan.currentMonth}
          anchor={menu.anchor}
          initialSection={menu.section}
          canFillRight={menu.col < months.length - 1}
          canEdit={lockFor(menuMonth) === null}
          canSetRollover={!readOnly}
          busy={busy}
          onClose={closeMenu}
          onFillRight={() => {
            const edits = fillRightEdits(menuRow, months, menu.col);
            if (edits.length > 0) onEdits(edits);
            closeMenu();
          }}
          onPlanFromAverage={(n) => {
            onPlanFromAverage(menuRow, menuMonth, n);
            closeMenu();
          }}
          onClear={() => {
            actions.apply(menu.rowIndex, menu.col, { kind: "clear" }, false);
            closeMenu();
          }}
          onRollover={(mode, fromMonth) => {
            onRollover(menuRow, mode, fromMonth);
            closeMenu();
          }}
          onDrillDown={() => {
            closeMenu();
            onDrill({ kind: "category", row: menuRow, month: menuMonth });
          }}
          onHistory={
            onCellHistory
              ? () => {
                  closeMenu();
                  onCellHistory(menuRow, menuMonth);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
