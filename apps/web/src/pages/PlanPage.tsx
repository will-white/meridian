import { useCallback, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import type { CategoryDetailView, HouseholdSettingView, PlanAveragesResponse, PlanCellEdit, PlanResponse, RolloverMode, TransactionView } from "@meridian/shared";
import { addMonths, monthDiff } from "@meridian/shared";
import { ManageCategories } from "../components/plan/ManageCategories.js";
import { PlanGrid } from "../components/plan/PlanGrid.js";
import { Empty, ErrorText } from "../components/ui.js";
import { api, query } from "../lib/api.js";
import { money } from "../lib/format.js";
import { MAX_RANGE_MONTHS, applyEdits, defaultRange, localToday, monthLabel, resolveRange, visibleRows, type PlanCategoryRow } from "../lib/plan.js";
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
  const today = localToday();
  const { from, to } = useMemo(() => resolveRange(params.get("from"), params.get("to"), today), [params, today]);
  const [compact, setCompact] = useState(() => readFlag(COMPACT_KEY));
  const [showHidden, setShowHidden] = useState(() => readFlag(SHOW_HIDDEN_KEY));
  const [manage, setManage] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
      setCells.mutate([{ month, categoryId: row.categoryId, plannedCents: cents, source: "average" }]);
      setNotice(`${row.name}, ${monthLabel(month)}: planned ${money(cents)} from the ${months}-month average (${monthsWithData} month${monthsWithData === 1 ? "" : "s"} with data).`);
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

  const dropTransaction = useMutation({
    mutationFn: ({ id, categoryId }: { id: string; categoryId: string }) => api<TransactionView>(`/transactions/${id}`, { method: "PATCH", body: { categoryId } }),
    onSuccess: (t) => {
      for (const key of [["transactions"], ["plan"], ["dashboard"]]) void qc.invalidateQueries({ queryKey: key });
      setNotice(`${t.payeeName ?? t.rawDescription} moved to ${t.categoryName ?? "its category"}.`);
    },
  });

  const onEdits = useCallback((edits: PlanCellEdit[]) => setCells.mutate(edits), [setCells]);
  const onPlanFromAverage = useCallback((row: PlanCategoryRow, month: string, months: 3 | 6 | 12) => average.mutate({ row, month, months }), [average]);
  const onRollover = useCallback(
    (row: PlanCategoryRow, rolloverMode: RolloverMode, rolloverFromMonth: string | null) => patchCategory.mutate({ id: row.categoryId, rolloverMode, rolloverFromMonth }),
    [patchCategory],
  );
  const onDropTransaction = useCallback((id: string, categoryId: string) => dropTransaction.mutate({ id, categoryId }), [dropTransaction]);

  const span = monthDiff(from, to) + 1;
  const setRange = (f: string, t: string) => setParams({ from: f, to: t });
  const reset = () => setParams({});
  const isDefault = useMemo(() => {
    const d = defaultRange(today);
    return d.from === from && d.to === to;
  }, [from, to, today]);

  const zeroBased = settings.isPending && settings.variables !== undefined ? settings.variables : (plan.data?.zeroBased ?? false);
  const rows = useMemo(() => (plan.data ? visibleRows(plan.data.rows, showHidden) : []), [plan.data, showHidden]);
  const busy = setCells.isPending || average.isPending || patchCategory.isPending;

  return (
    <div className="plan-page">
      <div className="row space wrap plan-toolbar">
        <h1>Spending plan</h1>
        <div className="row wrap">
          <button type="button" className="secondary" disabled={span >= MAX_RANGE_MONTHS} onClick={() => setRange(addMonths(from, -1), to)} title="Show one more month before">
            ‹ Earlier
          </button>
          <span className="muted nowrap">
            {monthLabel(from)} – {monthLabel(to)}
          </span>
          <button type="button" className="secondary" disabled={span >= MAX_RANGE_MONTHS} onClick={() => setRange(from, addMonths(to, 1))} title="Show one more month after">
            Later ›
          </button>
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
            <input type="checkbox" checked={zeroBased} disabled={settings.isPending || !plan.data} onChange={(e) => settings.mutate(e.target.checked)} /> zero-based
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
          <button type="button" className="secondary" onClick={() => setManage((m) => !m)}>
            {manage ? "Hide manager" : "Manage categories"}
          </button>
        </div>
      </div>
      <ErrorText error={plan.error} />
      <ErrorText error={setCells.error} />
      <ErrorText error={average.error} />
      <ErrorText error={patchCategory.error} />
      <ErrorText error={settings.error} />
      <ErrorText error={dropTransaction.error} />
      {notice && (
        <p className="notice">
          {notice}{" "}
          <button type="button" className="link" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </p>
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
          onEdits={onEdits}
          onPlanFromAverage={onPlanFromAverage}
          onRollover={onRollover}
          onDropTransaction={onDropTransaction}
        />
      )}
      {plan.data && (
        <p className="muted small plan-help">
          Type a planned amount and press Enter (down), Shift+Enter (up), Tab (next month) or arrows. Esc reverts; Delete on an empty cell restores the automatic value (R recurring, G goal, A
          average). Ctrl+Shift+→ fills the value into later months; Ctrl+Shift+A plans from an average. Drag a transaction from the register onto a category row to categorize it.
        </p>
      )}
      {manage && plan.data && <ManageCategories rows={plan.data.rows} onClose={() => setManage(false)} />}
    </div>
  );
}
