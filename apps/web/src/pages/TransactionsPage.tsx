import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { isIsoDate } from "@meridian/shared";
import type { AccountView, CategoryView, GoalView, RecurringList, RuleView, TransactionList, TransactionView } from "@meridian/shared";
import { api, query } from "../lib/api.js";
import { money, shortDate } from "../lib/format.js";
import { TRANSACTION_DRAG_TYPE } from "../lib/plan.js";
import { Badge, Card, Empty, ErrorText } from "../components/ui.js";
import "./TransactionsPage.css";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface RulePrompt {
  transaction: TransactionView;
  categoryId: string | null;
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
  };
}

const FILTER_KEYS = ["accountId", "categoryId", "goalId", "recurringId", "uncategorized", "transfers", "from", "to"] as const;

export function TransactionsPage() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const f = useMemo(() => readFilters(searchParams), [searchParams]);
  const [q, setQ] = useState(() => searchParams.get("q") ?? "");
  const search = useDebounced(q, 250);
  const [prompt, setPrompt] = useState<RulePrompt | null>(null);

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
  const createRule = useMutation({
    mutationFn: (body: unknown) => api<{ rule: RuleView; applied: { examined: number; changed: number } }>("/rules", { method: "POST", body }),
    onSuccess: (res) => {
      setPrompt(null);
      setRuleNotice(`Rule saved. ${res.applied.changed} other transaction${res.applied.changed === 1 ? "" : "s"} categorized.`);
      invalidate();
      void qc.invalidateQueries({ queryKey: ["rules"] });
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
    if (categoryId && t.payeeName) setPrompt({ transaction: t, categoryId });
    else setPrompt(null);
  };

  return (
    <>
      <h1>Transactions</h1>
      <div className="row wrap filters">
        <input placeholder="Search payee, description, notes…" value={q} onChange={(e) => setQ(e.target.value)} className="grow" />
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
        <Card>
          <div className="row wrap space">
            <span>
              Always categorize <strong>{prompt.transaction.payeeName}</strong> as <strong>{categoryName.get(prompt.categoryId ?? "") ?? "—"}</strong>?
              <span className="muted"> Creates a rule and applies it to uncategorized transactions.</span>
            </span>
            <span className="row">
              <button
                onClick={() =>
                  createRule.mutate({
                    name: `${prompt.transaction.payeeName} → ${categoryName.get(prompt.categoryId ?? "")}`,
                    conditions: { payee: { op: "equals", value: prompt.transaction.payeeName } },
                    actions: { setCategoryId: prompt.categoryId },
                    applyTo: "uncategorized",
                  })
                }
                disabled={createRule.isPending}
              >
                Always do this
              </button>
              <button className="secondary" onClick={() => setPrompt(null)}>
                Just this once
              </button>
            </span>
          </div>
          <ErrorText error={createRule.error} />
        </Card>
      )}
      {ruleNotice && (
        <p className="notice">
          {ruleNotice}{" "}
          <button className="link" onClick={() => setRuleNotice(null)}>
            dismiss
          </button>
        </p>
      )}
      {items.length === 0 && !txns.isLoading && <Empty>No transactions match.</Empty>}
      {items.length > 0 && (
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
            {items.map((t) => (
              <tr
                key={t.id}
                className={t.pending ? "pending" : ""}
                draggable={!t.isTransfer}
                onDragStart={(e) => {
                  e.dataTransfer.setData(TRANSACTION_DRAG_TYPE, t.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                title={t.isTransfer ? undefined : "Drag onto a plan category to recategorize"}
              >
                <td className="nowrap">
                  {!t.isTransfer && (
                    <span className="drag-handle" aria-hidden="true">
                      ⠿
                    </span>
                  )}
                  {shortDate(t.date)}
                </td>
                <td className="muted nowrap">{t.accountName}</td>
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
                  ) : (
                    <select value={t.categoryId ?? ""} onChange={(e) => onCategoryChange(t, e.target.value)} className={t.categoryId ? "" : "unset"}>
                      <option value="">— uncategorized —</option>
                      {(categories.data ?? [])
                        .filter((c) => !c.hidden || c.id === t.categoryId)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                  )}
                </td>
                <td className={`num nowrap ${t.amountCents.startsWith("-") ? "neg" : "pos"}`}>{money(t.amountCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
