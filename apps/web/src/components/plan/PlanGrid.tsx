import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { useNavigate } from "react-router";
import type { PlanCellEdit, PlanResponse, PlanRow, RolloverMode } from "@meridian/shared";
import {
  TRANSACTION_DRAG_TYPE,
  drillDownUrl,
  fillRightEdits,
  nextCategoryIndex,
  rowHeight,
  stickyBucketIndex,
  type PlanCategoryRow,
} from "../../lib/plan.js";
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
  onEdits: (edits: PlanCellEdit[]) => void;
  onPlanFromAverage: (row: PlanCategoryRow, month: string, months: 3 | 6 | 12) => void;
  onRollover: (row: PlanCategoryRow, mode: RolloverMode, fromMonth: string | null) => void;
  onDropTransaction: (transactionId: string, categoryId: string) => void;
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
const BUCKET_HEADER_HEIGHT = 40;

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
 * the left. Rows are absolutely positioned by the virtualizer.
 */
export function PlanGrid(props: PlanGridProps) {
  const { plan, rows, compact, zeroBased, busy, onEdits, onPlanFromAverage, onRollover, onDropTransaction } = props;
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [stripHeight, setStripHeight] = useState(96);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const [dragOverCategory, setDragOverCategory] = useState<string | null>(null);
  const months = plan.months;
  const stateByMonth = useMemo(() => new Map(plan.summary.map((s) => [s.month, s.state])), [plan.summary]);
  const monthState = (month: string): MonthState => stateByMonth.get(month) ?? "future";

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
    scrollPaddingStart: stripHeight + BUCKET_HEADER_HEIGHT,
  });
  // Row heights depend on density only; re-measure when it changes.
  const measure = virtualizer.measure;
  useEffect(() => measure(), [measure, compact]);

  const items = virtualizer.getVirtualItems();
  const scrollTop = virtualizer.scrollOffset ?? 0;
  const firstVisible = items.find((it) => it.end > scrollTop + stripHeight)?.index ?? items[0]?.index ?? 0;
  const stickyIndex = rows.length > 0 ? stickyBucketIndex(rows, firstVisible) : -1;
  const stickyRow = stickyIndex >= 0 ? rows[stickyIndex] : undefined;

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
      commit: (rowIndex, col, cents) => {
        const row = rows[rowIndex];
        const month = months[col];
        if (!row || row.kind !== "category" || month === undefined) return;
        onEdits([{ month, categoryId: row.categoryId, plannedCents: cents === null ? null : cents.toString(), source: "manual" }]);
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
      fillRight: (rowIndex, col) => {
        const row = rows[rowIndex];
        if (!row || row.kind !== "category") return;
        const edits = fillRightEdits(row, months, col);
        if (edits.length > 0) onEdits(edits);
      },
      openMenu: (rowIndex, col, anchor, section) => setMenu({ rowIndex, col, anchor: anchor.getBoundingClientRect(), section }),
    }),
    [rows, months, onEdits, focusCell],
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
        <CategoryCell key={month} row={row} cell={cell} month={month} rowIndex={rowIndex} col={col} compact={compact} state={state} actions={actions} />
      ) : (
        <TotalCell key={month} cell={cell} bucket={row.bucket} compact={compact} state={state} />
      );
    });

  const renderRow = (row: PlanRow, rowIndex: number, style: CSSProperties, sticky: boolean) => {
    const isCategory = row.kind === "category";
    const classes = ["plan-row", `kind-${row.kind}`, `bucket-${row.bucket}`, sticky ? "plan-sticky-bucket" : "", isCategory && dragOverCategory === row.categoryId ? "drop-over" : ""]
      .filter(Boolean)
      .join(" ");
    return (
      <div
        key={sticky ? `sticky:${rowKey(row)}` : rowKey(row)}
        className={classes}
        style={style}
        role="row"
        data-row-index={rowIndex}
        onDragOver={isCategory ? onRowDragOver(row) : undefined}
        onDragLeave={isCategory ? () => setDragOverCategory((c) => (c === row.categoryId ? null : c)) : undefined}
        onDrop={isCategory ? onRowDrop(row) : undefined}
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
    >
      <SummaryStrip ref={stripRef} summary={plan.summary} zeroBased={zeroBased} compact={compact} />
      <div className="plan-body" style={{ height: virtualizer.getTotalSize() }}>
        {stickyRow && renderRow(stickyRow, stickyIndex, { position: "sticky", top: stripHeight, height: rowHeight(stickyRow, compact) }, true)}
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
              height: item.size,
              visibility: item.index === stickyIndex ? "hidden" : undefined,
            },
            false,
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
          busy={busy}
          onClose={closeMenu}
          onFillRight={() => {
            actions.fillRight(menu.rowIndex, menu.col);
            closeMenu();
          }}
          onPlanFromAverage={(n) => {
            onPlanFromAverage(menuRow, menuMonth, n);
            closeMenu();
          }}
          onClear={() => {
            actions.commit(menu.rowIndex, menu.col, null);
            closeMenu();
          }}
          onRollover={(mode, fromMonth) => {
            onRollover(menuRow, mode, fromMonth);
            closeMenu();
          }}
          onDrillDown={() => {
            closeMenu();
            void navigate(drillDownUrl(menuRow, menuMonth));
          }}
        />
      )}
    </div>
  );
}
