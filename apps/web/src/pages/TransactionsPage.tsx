import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { isIsoDate } from "@meridian/shared";
import type { AccountView, CategoryView, GoalView, RecurringList, TransactionList, TransactionView } from "@meridian/shared";
import { api, query } from "../lib/api.js";
import { money, shortDate } from "../lib/format.js";
import { TRANSACTION_DRAG_TYPE, canDragToRecategorize, recategorizePrompt, ruleSavedNotice, type RulePromptTarget } from "../lib/recategorize.js";
import { amountInCategory, type SplitRequestLine } from "../lib/splits.js";
import { useIsViewer } from "../components/investments/queries.js";
import { RowActions } from "../components/transactions/RowActions.js";
import { RulePrompt } from "../components/transactions/RulePrompt.js";
import { SplitEditor } from "../components/transactions/SplitEditor.js";
import { Badge, Empty, ErrorText } from "../components/ui.js";
import "./TransactionsPage.css";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type Transfers = "include" | "exclude" | "only";

/** Register filters that live in the URL, so plan cells, goals and recurring items can deep-link here. */
interface RegisterFilters {
  accountId: string;
  categoryId: string;
  goalId: string;
  recurringId: string;
  uncategorized: boolean;
  transfers: Transfers;
  from: string;
  to: string;
  /** Set by a plan cell's drill-down: only what the plan counts (on-budget accounts). */
  planScope: boolean;
}

function readFilters(params: URLSearchParams): RegisterFilters {
  const date = (key: string): string => {
    const v = params.get(key) ?? "";
    return isIsoDate(v) ? v : "";
  };
  const t = params.get("transfers");
  return {
    accountId: params.get("accountId") ?? "",
    categoryId: params.get("categoryId") ?? "",
    goalId: params.get("goalId") ?? "",
    recurringId: params.get("recurringId") ?? "",
    uncategorized: params.get("uncategorized") === "true",
    transfers: t === "exclude" || t === "only" ? t : "include",
    from: date("from"),
    to: date("to"),
    planScope: params.get("planScope") === "true",
  };
}

const FILTER_KEYS = ["accountId", "categoryId", "goalId", "recurringId", "uncategorized", "transfers", "from", "to", "planScope"] as const;

export function TransactionsPage() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const f = useMemo(() => readFilters(searchParams), [searchParams]);
  const [q, setQ] = useState(() => searchParams.get("q") ?? "");
  const search = useDebounced(q, 250);
  const [prompt, setPrompt] = useState<RulePromptTarget | null>(null);
  const [splitting, setSplitting] = useState<string | null>(null);
  /** The row whose corrections (pair, mark as transfer, delete) are open. */
  const [correcting, setCorrecting] = useState<string | null>(null);
  const viewer = useIsViewer();

  const setFilter = (patch: Partial<RegisterFilters>) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(patch)) {
          const off = value === "" || value === false || value === undefined || (key === "transfers" && value === "include");
          if (off) next.delete(key);
          else next.set(key, String(value));
        }
        return next;
      },
      { replace: true },
    );
  const clearFilters = () => setFilter(Object.fromEntries(FILTER_KEYS.map((k) => [k, ""])) as Partial<RegisterFilters>);
  const filtered = FILTER_KEYS.some((k) => (k === "transfers" ? f.transfers !== "include" : Boolean(f[k])));

  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<AccountView[]>("/accounts") });
  const categories = useQuery({ queryKey: ["categories"], queryFn: () => api<CategoryView[]>("/categories") });
  // Names for the deep-link chips; fetched only while that filter is on.
  const goals = useQuery({ queryKey: ["goals"], queryFn: () => api<GoalView[]>("/goals"), enabled: f.goalId !== "" });
  const recurring = useQuery({
    queryKey: ["recurring", "list", { status: "all", sort: "due" }],
    queryFn: () => api<RecurringList>(`/recurring${query({ status: "all", sort: "due" })}`),
    enabled: f.recurringId !== "",
  });
  const params = {
    q: search,
    accountId: f.accountId,
    categoryId: f.categoryId,
    goalId: f.goalId,
    recurringId: f.recurringId,
    uncategorized: f.uncategorized || undefined,
    transfers: f.transfers,
    from: f.from,
    to: f.to,
    planScope: f.planScope || undefined,
    limit: 100,
  };
  const txns = useInfiniteQuery({
    queryKey: ["transactions", params],
    queryFn: ({ pageParam }) => api<TransactionList>(`/transactions${query({ ...params, cursor: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["transactions"] });
    void qc.invalidateQueries({ queryKey: ["plan"] });
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
  };
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) => api<TransactionView>(`/transactions/${id}`, { method: "PATCH", body }),
    onSuccess: invalidate,
  });
  const saveSplit = useMutation({
    mutationFn: ({ id, splits }: { id: string; splits: SplitRequestLine[] }) => api<TransactionView>(`/transactions/${id}/splits`, { method: "PUT", body: { splits } }),
    onSuccess: () => {
      setSplitting(null);
      invalidate();
    },
  });
  // Audit a5-ingest-transfers-09 and -12: the register's corrections.
  const correct = useMutation({
    mutationFn: async (v: { id: string; action: "pair"; otherId: string } | { id: string; action: "transfer" } | { id: string; action: "delete" }): Promise<void> => {
      if (v.action === "pair") await api<TransactionView>(`/transactions/${v.id}/pair`, { method: "POST", body: { otherId: v.otherId } });
      else if (v.action === "transfer") await api<TransactionView>(`/transactions/${v.id}`, { method: "PATCH", body: { isTransfer: true } });
      else await api<{ ok: true }>(`/transactions/${v.id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      setCorrecting(null);
      invalidate();
      void qc.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
  const [ruleNotice, setRuleNotice] = useState<string | null>(null);

  const categoryName = useMemo(() => new Map((categories.data ?? []).map((c) => [c.id, c.name])), [categories.data]);
  const goalName = f.goalId ? (goals.data?.find((g) => g.id === f.goalId)?.name ?? "goal") : null;
  const recurringName = f.recurringId ? (recurring.data?.items.find((r) => r.id === f.recurringId)?.name ?? "recurring item") : null;
  const items = txns.data?.pages.flatMap((p) => p.items) ?? [];

  const onCategoryChange = (t: TransactionView, value: string) => {
    const categoryId = value === "" ? null : value;
    update.mutate({ id: t.id, categoryId });
    setPrompt(recategorizePrompt(t, categoryId));
  };

  return (
    <>
      <h1>Transactions</h1>
      <div className="row wrap filters">
        <input placeholder="Search payee, description, notes…" aria-label="Search transactions" value={q} onChange={(e) => setQ(e.target.value)} className="grow" />
        <select value={f.accountId} onChange={(e) => setFilter({ accountId: e.target.value })} aria-label="Account">
          <option value="">All accounts</option>
          {(accounts.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select value={f.categoryId} onChange={(e) => setFilter({ categoryId: e.target.value, uncategorized: false })} aria-label="Category">
          <option value="">All categories</option>
          {(categories.data ?? [])
            .filter((c) => !c.hidden || c.id === f.categoryId)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
        <select value={f.transfers} onChange={(e) => setFilter({ transfers: e.target.value as Transfers })} aria-label="Transfers">
          <option value="include">With transfers</option>
          <option value="exclude">Hide transfers</option>
          <option value="only">Transfers only</option>
        </select>
        <label className="inline">
          <input type="checkbox" checked={f.uncategorized} onChange={(e) => setFilter({ uncategorized: e.target.checked, categoryId: e.target.checked ? "" : f.categoryId })} /> uncategorized only
        </label>
        <label className="inline">
          from <input type="date" value={f.from} max={f.to || undefined} onChange={(e) => setFilter({ from: e.target.value })} aria-label="From date" />
        </label>
        <label className="inline">
          to <input type="date" value={f.to} min={f.from || undefined} onChange={(e) => setFilter({ to: e.target.value })} aria-label="To date" />
        </label>
      </div>
      {(goalName !== null || recurringName !== null || filtered) && (
        <div className="filter-chips">
          {goalName !== null && (
            <span className="chip">
              Goal: <Link to="/goals">{goalName}</Link>
              <button className="link" onClick={() => setFilter({ goalId: "" })} aria-label="Remove goal filter">
                ×
              </button>
            </span>
          )}
          {recurringName !== null && (
            <span className="chip">
              Recurring: <Link to={`/recurring?focus=${f.recurringId}`}>{recurringName}</Link>
              <button className="link" onClick={() => setFilter({ recurringId: "" })} aria-label="Remove recurring filter">
                ×
              </button>
            </span>
          )}
          {f.planScope && (
            <span className="chip" title="The plan counts on-budget accounts only (plus the investment income feed), and a split transaction by its lines">
              As the plan counts it
              <button className="link" onClick={() => setFilter({ planScope: false })} aria-label="Show rows the plan does not count too">
                ×
              </button>
            </span>
          )}
          {filtered && (
            <button className="link small" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      )}
      <ErrorText error={txns.error} />
      <ErrorText error={update.error} />
      {prompt && (
        <RulePrompt
          key={`${prompt.payeeName}|${prompt.categoryId}`}
          target={prompt}
          categoryName={categoryName.get(prompt.categoryId)}
          onSaved={(changed) => {
            setPrompt(null);
            setRuleNotice(ruleSavedNotice(changed));
          }}
          onDismiss={() => setPrompt(null)}
        />
      )}
      {ruleNotice && (
        <p className="notice">
          {ruleNotice}{" "}
          <button className="link" onClick={() => setRuleNotice(null)}>
            dismiss
          </button>
        </p>
      )}
      {/* Only a loaded list can be empty; a failed load shows its error alone (audit b8-web-layout-13). */}
      {txns.data !== undefined && items.length === 0 && <Empty>No transactions match.</Empty>}
      {items.length > 0 && (
        // A wide register scrolls inside its box instead of widening the page (audit b8-web-layout-04).
        <div className="scroll register-scroll">
        <table className="table register">
          <thead>
            <tr>
              <th>Date</th>
              <th>Account</th>
              <th>Payee</th>
              <th>Category</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.flatMap((t) => [
              <tr
                key={t.id}
                className={t.pending ? "pending" : ""}
                draggable={!viewer && canDragToRecategorize(t)}
                onDragStart={(e) => {
                  e.dataTransfer.setData(TRANSACTION_DRAG_TYPE, t.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                title={!viewer && canDragToRecategorize(t) ? "Drag onto a plan category to recategorize" : undefined}
              >
                <td className="nowrap">
                  {!viewer && canDragToRecategorize(t) && (
                    <span className="drag-handle" aria-hidden="true">
                      ⠿
                    </span>
                  )}
                  {shortDate(t.date)}
                </td>
                <td className="muted nowrap register-account">{t.accountName}</td>
                <td>
                  <div>
                    {t.payeeName ?? t.rawDescription}
                    {t.pending && <Badge tone="info">pending</Badge>}
                    {t.isTransfer && <Badge tone="neutral">transfer</Badge>}
                    {t.recurringId && (
                      <Link to={`/recurring?focus=${t.recurringId}`} className="badge badge-info" title="Linked to a recurring item">
                        recurring
                      </Link>
                    )}
                    {t.tags.map((tag) => (
                      <Badge key={tag} tone="neutral">
                        #{tag}
                      </Badge>
                    ))}
                  </div>
                  <div className="muted small" title={t.rawDescription}>
                    {t.rawDescription}
                    {t.memo ? ` · ${t.memo}` : ""}
                    {t.notes ? ` · ${t.notes}` : ""}
                  </div>
                </td>
                <td>
                  {t.isTransfer ? (
                    <button className="link small" onClick={() => update.mutate({ id: t.id, isTransfer: false })} title="Not a transfer: give it a category">
                      transfer · undo
                    </button>
                  ) : t.splits.length > 0 ? (
                    <div className="split-summary">
                      {t.splits.map((s) => (
                        <div key={s.id} className="small">
                          {s.categoryName ?? "—"} <span className="muted">{money(s.amountCents)}</span>
                          {s.memo ? <span className="muted"> · {s.memo}</span> : null}
                        </div>
                      ))}
                      <button className="link small" onClick={() => setSplitting(splitting === t.id ? null : t.id)}>
                        edit split
                      </button>
                    </div>
                  ) : (
                    <>
                      <select
                        value={t.categoryId ?? ""}
                        onChange={(e) => onCategoryChange(t, e.target.value)}
                        className={t.categoryId ? "" : "unset"}
                        aria-label={`Category for ${t.payeeName ?? t.rawDescription}`}
                      >
                        <option value="">— uncategorized —</option>
                        {(categories.data ?? [])
                          .filter((c) => !c.hidden || c.id === t.categoryId)
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                      <button className="link small" onClick={() => setSplitting(splitting === t.id ? null : t.id)} title="Split this transaction across categories">
                        split
                      </button>
                    </>
                  )}
                  <button
                    className="link small"
                    onClick={() => {
                      correct.reset();
                      setCorrecting(correcting === t.id ? null : t.id);
                    }}
                    aria-expanded={correcting === t.id}
                    title={t.isTransfer ? "Delete this transaction" : "Pair with the other leg of a transfer, mark as a transfer, or delete"}
                  >
                    more
                  </button>
                </td>
                <td className={`num nowrap ${t.amountCents.startsWith("-") ? "neg" : "pos"}`}>
                  {f.categoryId && t.splits.length > 0 ? (
                    <span title={`${money(amountInCategory(t, f.categoryId).toString())} of this ${money(t.amountCents)} transaction is in the selected category`}>
                      {money(amountInCategory(t, f.categoryId).toString())}
                      <span className="muted small"> of {money(t.amountCents)}</span>
                    </span>
                  ) : (
                    money(t.amountCents)
                  )}
                </td>
              </tr>,
              splitting === t.id && !t.isTransfer ? (
                <tr key={`${t.id}-split`} className="split-row">
                  <td colSpan={5}>
                    <SplitEditor
                      transaction={t}
                      categories={categories.data ?? []}
                      pending={saveSplit.isPending}
                      error={saveSplit.error}
                      onSave={(splits) => saveSplit.mutate({ id: t.id, splits })}
                      onCancel={() => {
                        setSplitting(null);
                        saveSplit.reset();
                      }}
                    />
                  </td>
                </tr>
              ) : null,
              correcting === t.id ? (
                <tr key={`${t.id}-actions`} className="split-row">
                  <td colSpan={5}>
                    <RowActions
                      transaction={t}
                      viewer={viewer}
                      pending={correct.isPending}
                      error={correct.error}
                      onPair={(otherId) => correct.mutate({ id: t.id, action: "pair", otherId })}
                      onMarkTransfer={() => correct.mutate({ id: t.id, action: "transfer" })}
                      onDelete={() => correct.mutate({ id: t.id, action: "delete" })}
                      onClose={() => setCorrecting(null)}
                    />
                  </td>
                </tr>
              ) : null,
            ])}
          </tbody>
        </table>
        </div>
      )}
      {txns.hasNextPage && (
        <div className="center">
          <button className="secondary" onClick={() => void txns.fetchNextPage()} disabled={txns.isFetchingNextPage}>
            {txns.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </>
  );
}
