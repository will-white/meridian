import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccountView, CategoryView, RuleView, TransactionList, TransactionView } from "@meridian/shared";
import { api, query } from "../lib/api.js";
import { money, shortDate } from "../lib/format.js";
import { Badge, Card, Empty, ErrorText } from "../components/ui.js";

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

export function TransactionsPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [accountId, setAccountId] = useState("");
  const [uncategorized, setUncategorized] = useState(false);
  const [transfers, setTransfers] = useState<"include" | "exclude" | "only">("include");
  const search = useDebounced(q, 250);
  const [prompt, setPrompt] = useState<RulePrompt | null>(null);

  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<AccountView[]>("/accounts") });
  const categories = useQuery({ queryKey: ["categories"], queryFn: () => api<CategoryView[]>("/categories") });
  const params = { q: search, accountId, uncategorized: uncategorized || undefined, transfers, limit: 100 };
  const txns = useInfiniteQuery({
    queryKey: ["transactions", params],
    queryFn: ({ pageParam }) => api<TransactionList>(`/transactions${query({ ...params, cursor: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["transactions"] });
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
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">All accounts</option>
          {(accounts.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select value={transfers} onChange={(e) => setTransfers(e.target.value as typeof transfers)}>
          <option value="include">With transfers</option>
          <option value="exclude">Hide transfers</option>
          <option value="only">Transfers only</option>
        </select>
        <label className="inline">
          <input type="checkbox" checked={uncategorized} onChange={(e) => setUncategorized(e.target.checked)} /> uncategorized only
        </label>
      </div>
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
              <tr key={t.id} className={t.pending ? "pending" : ""}>
                <td className="nowrap">{shortDate(t.date)}</td>
                <td className="muted nowrap">{t.accountName}</td>
                <td>
                  <div>
                    {t.payeeName ?? t.rawDescription}
                    {t.pending && <Badge tone="info">pending</Badge>}
                    {t.isTransfer && <Badge tone="neutral">transfer</Badge>}
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
