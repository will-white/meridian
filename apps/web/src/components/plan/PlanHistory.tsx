import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { batchUndo, PLAN_HISTORY_ENTITIES, type AuditEntryView, type AuditList } from "@meridian/shared";
import { api, query } from "../../lib/api.js";
import { monthLabel } from "../../lib/plan.js";
import { describeEntry, groupBatches, historyTime, laterChanges, type HistoryBatch, type HistoryNames } from "../../lib/planHistory.js";
import { ErrorText } from "../ui.js";

export interface PlanHistoryProps {
  /** Names the plan knows (categories, groups); accounts are read here. */
  names: Omit<HistoryNames, "account">;
  /** One cell's history (the cell menu's "History"), or null for the whole plan. */
  cell: { month: string; categoryId: string } | null;
  canUndo: boolean;
  today: string;
  onClose: () => void;
  onUndone: (message: string) => void;
}

const PAGE = 100;
const SHOWN_PER_BATCH = 6;

/** The query key and parameters of the history list (shared with the tests). */
export function planHistoryQuery(cell: PlanHistoryProps["cell"], cursor: string | null) {
  const params = cell
    ? { entity: "month_plan", entityId: `${cell.month}:${cell.categoryId}`, limit: PAGE, ...(cursor ? { cursor } : {}) }
    : { entities: PLAN_HISTORY_ENTITIES.join(","), limit: PAGE, ...(cursor ? { cursor } : {}) };
  return { queryKey: ["audit", "plan-history", params] as const, params };
}

/** Every entry of one batch (a plan-from-average over the whole grid can be hundreds). */
async function batchEntries(batchId: string): Promise<AuditEntryView[]> {
  const out: AuditEntryView[] = [];
  let cursor: string | null = null;
  do {
    const page: AuditList = await api<AuditList>(`/audit${query({ batchId, limit: 200, ...(cursor ? { cursor } : {}) })}`);
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/**
 * The plan's edit history (spec, Security: edits to plans keep history so they can be reviewed and
 * reverted; Phase 2 plan decision 11, audit decision A29): the audit entries of plan cells,
 * categories, groups, goals, recurring items and settings, newest first, grouped by the request
 * that wrote them, with who and when. An owner can undo a batch: every cell goes back to its
 * `before` in one PUT /plan/cells and every updated entity through its own PATCH (grid-and-api
 * design §Audit); the undo is a new batch, so it can be undone the same way.
 */
export function PlanHistory({ names: planNames, cell, canUndo, today, onClose, onUndone }: PlanHistoryProps) {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<Array<{ id: string; name: string }>>("/accounts") });
  const names = useMemo<HistoryNames>(() => {
    const accountNames = new Map((accounts.data ?? []).map((a) => [a.id, a.name]));
    return { ...planNames, account: (id) => accountNames.get(id) };
  }, [planNames, accounts.data]);
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const { queryKey, params } = planHistoryQuery(cell, cursor);
  const history = useQuery({ queryKey, queryFn: () => api<AuditList>(`/audit${query(params)}`) });
  const batches = useMemo(() => groupBatches(history.data?.items ?? []), [history.data]);

  const undo = useMutation({
    // A cell's own history undoes that cell only; the plan's history undoes the whole request.
    mutationFn: async (batch: HistoryBatch) => {
      const entries = cell ? batch.entries : await batchEntries(batch.batchId);
      const plan = batchUndo(entries);
      if (plan.blocked.length > 0) throw new Error(`This change cannot be undone here: ${plan.blocked.join("; ")}.`);
      for (const r of plan.requests) await api(r.url, { method: r.method, body: r.body });
      if (plan.cellEdits.length > 0) await api("/plan/cells", { method: "PUT", body: { edits: plan.cellEdits, today } });
      return entries.length;
    },
    onSuccess: (count) => {
      for (const key of [["plan"], ["audit"], ["categories"], ["category-groups"], ["goals"], ["recurring"], ["settings"], ["dashboard"]]) void qc.invalidateQueries({ queryKey: key });
      setCursors([]);
      onUndone(`Undone: ${count} change${count === 1 ? "" : "s"} put back. The undo is in the history too.`);
    },
  });

  const title = cell ? `History of ${names.category(cell.categoryId) ?? "this category"} · ${monthLabel(cell.month)}` : "Plan history";
  return (
    <section className="card plan-history" aria-label={title}>
      <header className="card-head">
        <h2>{title}</h2>
        <div className="card-actions">
          <button type="button" className="link" onClick={onClose}>
            close
          </button>
        </div>
      </header>
      <p className="muted small">
        Planned amounts, categories, groups, goals, recurring items and settings, newest first; each group is one change (a fill-right, a plan from average, an edit).{" "}
        {canUndo ? (cell ? "Undo puts this cell back as it was before that change." : "Undo puts every value of a change back as it was before it.") : "Owners can undo a change."}
      </p>
      <ErrorText error={history.error} />
      <ErrorText error={undo.error} />
      {history.isLoading && <p className="muted small">Loading the history…</p>}
      {history.data && batches.length === 0 && <p className="muted small">No changes recorded{cell ? " for this cell" : ""} yet.</p>}
      <ol className="plan-history-list">
        {batches.map((b, i) => {
          const plan = batchUndo(b.entries);
          const later = laterChanges(
            b,
            batches.slice(0, i).flatMap((x) => x.entries),
          );
          return (
            <li key={b.batchId}>
              <div className="row space wrap">
                <span>
                  <strong>{historyTime(b.at)}</strong> <span className="muted">· {b.username ?? "system"}</span>{" "}
                  <span className="muted small">
                    · {b.entries.length} change{b.entries.length === 1 ? "" : "s"}
                  </span>
                </span>
                {canUndo &&
                  (plan.blocked.length === 0 ? (
                    <button
                      type="button"
                      className="secondary small"
                      disabled={undo.isPending}
                      onClick={() => {
                        if (later > 0 && !window.confirm(`${later} later change${later === 1 ? "" : "s"} touched the same values; undoing this puts them back to before this change too. Undo?`)) return;
                        undo.mutate(b);
                      }}
                    >
                      Undo
                    </button>
                  ) : (
                    <span className="muted small" title={plan.blocked.join("; ")}>
                      not undoable here: {plan.blocked[0]}
                    </span>
                  ))}
              </div>
              <ul className="small">
                {b.entries.slice(0, SHOWN_PER_BATCH).map((e) => (
                  <li key={e.id}>{describeEntry(e, names)}</li>
                ))}
              </ul>
              {b.entries.length > SHOWN_PER_BATCH && (
                <details className="small">
                  <summary>and {b.entries.length - SHOWN_PER_BATCH} more</summary>
                  <ul>
                    {b.entries.slice(SHOWN_PER_BATCH).map((e) => (
                      <li key={e.id}>{describeEntry(e, names)}</li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          );
        })}
      </ol>
      <div className="row">
        {cursors.length > 0 && (
          <button type="button" className="link small" onClick={() => setCursors((c) => c.slice(0, -1))}>
            ‹ newer
          </button>
        )}
        {history.data?.nextCursor && (
          <button type="button" className="link small" onClick={() => setCursors((c) => [...c, history.data!.nextCursor!])}>
            older ›
          </button>
        )}
      </div>
    </section>
  );
}
