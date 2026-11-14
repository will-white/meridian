import { useCallback, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import type { CategoryDetailView, HouseholdSettingView, PlanAveragesResponse, PlanCellEdit, PlanResponse, RolloverMode, TransactionView } from "@meridian/shared";
import { monthDiff, monthKey } from "@meridian/shared";
import { useIsViewer } from "../components/investments/queries.js";
import { DrillPanel, type DrillCategory } from "../components/plan/DrillPanel.js";
import { ManageCategories } from "../components/plan/ManageCategories.js";
import { PlanGrid } from "../components/plan/PlanGrid.js";
import { PlanHistory } from "../components/plan/PlanHistory.js";
import { RulePrompt } from "../components/transactions/RulePrompt.js";
import { Empty, ErrorText } from "../components/ui.js";
import { api, query } from "../lib/api.js";
import {
  MAX_RANGE_MONTH,
  MAX_RANGE_MONTHS,
  MIN_RANGE_MONTH,
  applyEdits,
  averagePlanOutcome,
  defaultRange,
  monthLabel,
  resizeRange,
  resolveRange,
  shiftRange,
  visibleRows,
  type DrillTarget,
  type PlanCategoryRow,
} from "../lib/plan.js";
import { recategorizePrompt, ruleSavedNotice, type RulePromptTarget } from "../lib/recategorize.js";
import { useLocalToday } from "../lib/useLocalToday.js";
import "./PlanPage.css";

interface SetPlanCellsResponse {
  changed: number;
  batchId: string;
  plan: PlanResponse | null;
}

const COMPACT_KEY = "meridian.plan.compact";
const SHOW_HIDDEN_KEY = "meridian.plan.showHidden";

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // private mode or blocked storage: the toggle still works for this visit
  }
}

export function PlanPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const today = useLocalToday();
  const viewer = useIsViewer();
  const { from, to } = useMemo(() => resolveRange(params.get("from"), params.get("to"), today), [params, today]);
  const [compact, setCompact] = useState(() => readFlag(COMPACT_KEY));
  const [showHidden, setShowHidden] = useState(() => readFlag(SHOW_HIDDEN_KEY));
  const [manage, setManage] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const [rulePrompt, setRulePrompt] = useState<{ target: RulePromptTarget; categoryName: string | undefined } | null>(null);
  // The history panel: the whole plan's (cell null) or one cell's (audit decision A30).
  const [history, setHistory] = useState<{ cell: { month: string; categoryId: string } | null } | null>(null);

  const planKey = useMemo(() => ["plan", from, to, today] as const, [from, to, today]);
  const plan = useQuery({
    queryKey: planKey,
    queryFn: () => api<PlanResponse>(`/plan${query({ from, to, today })}`),
    placeholderData: keepPreviousData,
  });
  const invalidatePlanDependents = useCallback(() => {
    for (const key of [["dashboard"], ["goals"]]) void qc.invalidateQueries({ queryKey: key });
  }, [qc]);

  const setCells = useMutation({
    mutationKey: ["plan-cells"],
    mutationFn: (edits: PlanCellEdit[]) => api<SetPlanCellsResponse>("/plan/cells", { method: "PUT", body: { edits, range: { from, to }, today } }),
    onMutate: async (edits) => {
      await qc.cancelQueries({ queryKey: ["plan"] });
      const prev = qc.getQueryData<PlanResponse>(planKey);
      if (prev) qc.setQueryData(planKey, applyEdits(prev, edits));
      return { prev };
    },
    onError: (_error, _edits, ctx) => {
      if (ctx?.prev) qc.setQueryData(planKey, ctx.prev);
      void qc.invalidateQueries({ queryKey: ["plan"] });
    },
    onSuccess: (res) => {
      // The response carries the fresh plan (subtotals, carries, strip). A later edit may
      // already be in flight; its response supersedes this one, so only the last writer applies.
      const last = qc.isMutating({ mutationKey: ["plan-cells"] }) <= 1;
      if (!last) return;
      if (res.plan) qc.setQueryData(planKey, res.plan);
      else void qc.invalidateQueries({ queryKey: ["plan"] });
    },
    onSettled: invalidatePlanDependents,
  });

  const average = useMutation({
    mutationFn: async ({ row, month, months }: { row: PlanCategoryRow; month: string; months: 3 | 6 | 12 }) => {
      const current = plan.data?.currentMonth ?? today.slice(0, 7);
      const asOf = month < current ? month : current;
      const res = await api<PlanAveragesResponse>(`/plan/averages${query({ months, asOf, today })}`);
      const avg = res.averages.find((a) => a.categoryId === row.categoryId);
      if (!avg) throw new Error("No average for this category");
      return { row, month, months, cents: avg.averageCents, monthsWithData: res.window.monthsWithData };
    },
    onSuccess: ({ row, month, months, cents, monthsWithData }) => {
      const outcome = averagePlanOutcome({ name: row.name, month, months, cents, monthsWithData });
      if (outcome.write) setCells.mutate([{ month, categoryId: row.categoryId, plannedCents: cents, source: "average" }]);
      setNotice(outcome.notice);
    },
  });

  const patchCategory = useMutation({
    mutationFn: ({ id, ...body }: { id: string; rolloverMode: RolloverMode; rolloverFromMonth: string | null }) =>
      api<CategoryDetailView>(`/categories/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      for (const key of [["plan"], ["categories"], ["dashboard"]]) void qc.invalidateQueries({ queryKey: key });
    },
  });

  const settings = useMutation({
    mutationFn: (zeroBased: boolean) => api<HouseholdSettingView>("/settings", { method: "PATCH", body: { zeroBased } }),
    onSuccess: () => {
      for (const key of [["plan"], ["settings"], ["dashboard"]]) void qc.invalidateQueries({ queryKey: key });
    },
  });

  // Drag onto a category row, or the drill-down panel's select: the register's PATCH, then its rule prompt.
  const recategorize = useMutation({
    mutationFn: ({ id, categoryId }: { id: string; categoryId: string }) => api<TransactionView>(`/transactions/${id}`, { method: "PATCH", body: { categoryId } }),
    onSuccess: (t, { categoryId }) => {
      for (const key of [["transactions"], ["plan"], ["dashboard"], ["goals"]]) void qc.invalidateQueries({ queryKey: key });
      setNotice(`${t.payeeName ?? t.rawDescription} moved to ${t.categoryName ?? "its category"}.`);
      const target = recategorizePrompt(t, categoryId);
      setRulePrompt(target ? { target, categoryName: t.categoryName ?? undefined } : null);
    },
  });

  const onEdits = useCallback((edits: PlanCellEdit[]) => setCells.mutate(edits), [setCells]);
  const onPlanFromAverage = useCallback((row: PlanCategoryRow, month: string, months: 3 | 6 | 12) => average.mutate({ row, month, months }), [average]);
  const onRollover = useCallback(
    (row: PlanCategoryRow, rolloverMode: RolloverMode, rolloverFromMonth: string | null) => patchCategory.mutate({ id: row.categoryId, rolloverMode, rolloverFromMonth }),
    [patchCategory],
  );
  const onDropTransaction = useCallback((id: string, categoryId: string) => recategorize.mutate({ id, categoryId }), [recategorize]);
  const onDrill = useCallback((target: DrillTarget) => setDrill(target), []);
  const onCellHistory = useCallback((row: PlanCategoryRow, month: string) => setHistory({ cell: { month, categoryId: row.categoryId } }), []);

  const span = monthDiff(from, to) + 1;
  const moveRange = (r: { from: string; to: string }) => setParams({ from: r.from, to: r.to });
  const reset = () => setParams({});
  const isDefault = useMemo(() => {
    const d = defaultRange(today);
    return d.from === from && d.to === to;
  }, [from, to, today]);

  const zeroBased = settings.isPending && settings.variables !== undefined ? settings.variables : (plan.data?.zeroBased ?? false);
  const rows = useMemo(() => (plan.data ? visibleRows(plan.data.rows, showHidden) : []), [plan.data, showHidden]);
  const busy = setCells.isPending || average.isPending || patchCategory.isPending;
  const drillCategories = useMemo<DrillCategory[]>(
    () => (plan.data ? visibleRows(plan.data.rows, false) : []).filter((r): r is PlanCategoryRow => r.kind === "category").map((r) => ({ id: r.categoryId, name: r.name, bucket: r.bucket })),
    [plan.data],
  );
  const drillName = (categoryId: string): string => {
    const row = plan.data?.rows.find((r): r is PlanCategoryRow => r.kind === "category" && r.categoryId === categoryId);
    return row?.name ?? "Category";
  };
  const historyNames = useMemo(() => {
    const categoryNames = new Map<string, string>();
    const groupNames = new Map<string, string>();
    for (const r of plan.data?.rows ?? []) {
      if (r.kind === "category") categoryNames.set(r.categoryId, r.name);
      else if (r.kind === "group") groupNames.set(r.groupId, r.name);
    }
    return { category: (id: string) => categoryNames.get(id), group: (id: string) => groupNames.get(id) };
  }, [plan.data]);
  const drillTitle = drill ? `${drill.kind === "uncategorized" ? "Uncategorized" : drillName(drill.row.categoryId)} · ${monthLabel(drill.month)}` : "";

  return (
    <div className={`plan-page ${drill ? "with-drill" : ""}`}>
      <div className="row space wrap plan-toolbar">
        <h1>Spending plan</h1>
        <div className="row wrap">
          <button type="button" className="secondary" disabled={from <= MIN_RANGE_MONTH} onClick={() => moveRange(shiftRange({ from, to }, -1))} title="Move the months shown one month earlier">
            ‹ Earlier
          </button>
          <span className="muted nowrap">
            {monthLabel(from)} – {monthLabel(to)}
          </span>
          <button type="button" className="secondary" disabled={to >= MAX_RANGE_MONTH} onClick={() => moveRange(shiftRange({ from, to }, 1))} title="Move the months shown one month later">
            Later ›
          </button>
          <label className="inline" title={`How many months to show side by side (at most ${MAX_RANGE_MONTHS})`}>
            <select aria-label="Months shown" value={span} onChange={(e) => moveRange(resizeRange({ from, to }, Number(e.target.value), monthKey(today)))}>
              {Array.from({ length: MAX_RANGE_MONTHS }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n} month{n === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </label>
          {!isDefault && (
            <button type="button" className="link" onClick={reset}>
              This month
            </button>
          )}
        </div>
        <div className="row wrap">
          <label className="inline">
            <input
              type="checkbox"
              checked={compact}
              onChange={(e) => {
                setCompact(e.target.checked);
                writeFlag(COMPACT_KEY, e.target.checked);
              }}
            />{" "}
            compact
          </label>
          <label className="inline" title="Show 'to assign' (income received minus everything planned) instead of 'left to spend'">
            <input type="checkbox" checked={zeroBased} disabled={viewer || settings.isPending || !plan.data} onChange={(e) => settings.mutate(e.target.checked)} /> zero-based
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => {
                setShowHidden(e.target.checked);
                writeFlag(SHOW_HIDDEN_KEY, e.target.checked);
              }}
            />{" "}
            show hidden
          </label>
          <button type="button" className="secondary" aria-pressed={history !== null && history.cell === null} onClick={() => setHistory((h) => (h && h.cell === null ? null : { cell: null }))}>
            History
          </button>
          {!viewer && (
            <button type="button" className="secondary" onClick={() => setManage((m) => !m)}>
              {manage ? "Hide manager" : "Manage categories"}
            </button>
          )}
        </div>
      </div>
      <ErrorText error={plan.error} />
      <ErrorText error={setCells.error} />
      <ErrorText error={average.error} />
      <ErrorText error={patchCategory.error} />
      <ErrorText error={settings.error} />
      <ErrorText error={recategorize.error} />
      {notice && (
        <p className="notice">
          {notice}{" "}
          <button type="button" className="link" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </p>
      )}
      {rulePrompt && !viewer && (
        <RulePrompt
          key={`${rulePrompt.target.payeeName}|${rulePrompt.target.categoryId}`}
          target={rulePrompt.target}
          categoryName={rulePrompt.categoryName}
          onSaved={(changed) => {
            setRulePrompt(null);
            setNotice(ruleSavedNotice(changed));
          }}
          onDismiss={() => setRulePrompt(null)}
        />
      )}
      {plan.isLoading && <p className="muted">Loading the plan…</p>}
      {plan.data && plan.data.rows.length === 0 && <Empty>No categories yet. Create a few below, then plan your first month.</Empty>}
      {plan.data && plan.data.rows.length > 0 && (
        <PlanGrid
          plan={plan.data}
          rows={rows}
          compact={compact}
          zeroBased={zeroBased}
          busy={busy}
          readOnly={viewer}
          onEdits={onEdits}
          onPlanFromAverage={onPlanFromAverage}
          onRollover={onRollover}
          onDropTransaction={onDropTransaction}
          onDrill={onDrill}
          onCellHistory={onCellHistory}
        />
      )}
      {drill && plan.data && (
        <DrillPanel
          target={drill}
          title={drillTitle}
          categories={drillCategories}
          canEdit={!viewer}
          onRecategorize={(t, categoryId) => recategorize.mutate({ id: t.id, categoryId })}
          onClose={() => setDrill(null)}
        />
      )}
      {history && (
        <PlanHistory
          key={history.cell ? `${history.cell.month}:${history.cell.categoryId}` : "plan"}
          names={historyNames}
          cell={history.cell}
          canUndo={!viewer}
          today={today}
          onClose={() => setHistory(null)}
          onUndone={(message) => setNotice(message)}
        />
      )}
      {plan.data &&
        (viewer ? (
          <p className="muted small plan-help">You are signed in as a viewer: the plan is read-only. Click an actual to see its transactions.</p>
        ) : (
          <p className="muted small plan-help">
            Type a planned amount and press Enter (down), Shift+Enter (up), Tab (next month) or arrows. Esc reverts; Delete on an empty cell restores the automatic value (R recurring, G goal, A
            average). Ctrl+Shift+→ copies the value into later months; Ctrl+Shift+A plans from an average. Click an actual to list its transactions under the grid, then drag one onto a category
            row to move it there.
            {plan.data.months.some((m) => m < plan.data!.startMonth) && ` Months before the plan start (${monthLabel(plan.data.startMonth)}) are read-only: change the start month in Settings.`}
          </p>
        ))}
      {manage && plan.data && !viewer && <ManageCategories rows={plan.data.rows} onClose={() => setManage(false)} />}
    </div>
  );
}
