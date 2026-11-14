import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CategoryView, PayeeList, PayeeView } from "@meridian/shared";
import { api, query } from "../lib/api.js";
import { useDebounced } from "../lib/useDebounced.js";
import { Card, Empty, ErrorText } from "../components/ui.js";
import { useIsViewer } from "../components/investments/queries.js";
import "./PayeesPage.css";

type PayeeRow = PayeeView;

/** "Showing 100 of 617 payees" while the list is cut (audit a8-ledger-ui-03). */
export function payeeCountText(shown: number, total: number, q: string): string {
  const what = q ? `payees matching "${q}"` : "payees";
  return shown < total ? `Showing ${shown} of ${total} ${what}, by name.` : `${total} ${what}.`;
}

/**
 * The payee another one is merged into (audit a8-ledger-ui-03): a search over every payee, by
 * name and by the names merged into it, instead of a select of the first page.
 */
function MergePicker({ source, pending, onPick, onCancel }: { source: PayeeRow; pending: boolean; onPick: (target: PayeeRow) => void; onCancel: () => void }) {
  const [q, setQ] = useState("");
  const search = useDebounced(q.trim(), 250);
  const found = useQuery({
    queryKey: ["payees", "merge", search],
    queryFn: () => api<PayeeList>(`/payees${query({ q: search, limit: 20 })}`),
    enabled: search.length > 0,
  });
  const targets = (found.data?.items ?? []).filter((p) => p.id !== source.id);
  return (
    <div className="merge-picker">
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find the payee to merge into" aria-label={`Payee to merge ${source.name} into`} maxLength={100} autoFocus />
      <button type="button" className="link small" onClick={onCancel}>
        cancel
      </button>
      {search && found.data && targets.length === 0 && <div className="muted small">No other payee matches.</div>}
      <ErrorText error={found.error} />
      <ul className="plain">
        {targets.map((p) => (
          <li key={p.id} className="small">
            <button type="button" className="link small" disabled={pending} onClick={() => onPick(p)}>
              merge into {p.name}
            </button>{" "}
            <span className="muted">
              {p.transactionCount} transactions{p.aliases.length > 0 ? ` · also ${p.aliases.slice(0, 3).join(", ")}` : ""}
            </span>
          </li>
        ))}
      </ul>
      {found.data && found.data.total > targets.length + 1 && <div className="muted small">{found.data.total} match; type more to narrow them.</div>}
    </div>
  );
}

/**
 * Payees (audit a6-text-rules-accounts-10): rename one (its old name stays an alias, so the
 * next import of it lands here and rules written on it keep matching), merge variants into one
 * (spec: "aliases merge variants"), and set a default category.
 */
export function PayeesPage() {
  const qc = useQueryClient();
  const viewer = useIsViewer();
  const [q, setQ] = useState("");
  const search = useDebounced(q.trim(), 250);
  // Audit a8-ledger-ui-03: every payee is reachable, a page at a time, and the page says when the list is cut.
  const payees = useInfiniteQuery({
    queryKey: ["payees", "list", search],
    queryFn: ({ pageParam }) => api<PayeeList>(`/payees${query({ q: search || undefined, limit: 100, cursor: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const [merging, setMerging] = useState<string | null>(null);
  const categories = useQuery({ queryKey: ["categories"], queryFn: () => api<CategoryView[]>("/categories") });
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["payees"] });
    void qc.invalidateQueries({ queryKey: ["transactions"] });
    void qc.invalidateQueries({ queryKey: ["recurring"] });
  };
  const patch = useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; defaultCategoryId?: string | null; mergeFromId?: string }) => api<PayeeRow>(`/payees/${id}`, { method: "PATCH", body }),
    onSuccess: (row, v) => {
      setRenaming(null);
      setMerging(null);
      if (v.mergeFromId) setNotice(`Merged into ${row.name}; it now answers to ${row.aliases.length} other name${row.aliases.length === 1 ? "" : "s"}.`);
      else if (v.name) setNotice(`Renamed to ${row.name}; the old name stays an alias.`);
      invalidate();
    },
  });
  const rows = payees.data?.pages.flatMap((p) => p.items) ?? [];
  const total = payees.data?.pages[0]?.total ?? 0;

  return (
    <>
      <div className="row space wrap">
        <h1>Payees</h1>
        <input type="search" placeholder="Search payees" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search payees" maxLength={100} />
      </div>
      {notice && <p className="notice">{notice}</p>}
      <ErrorText error={payees.error} />
      <ErrorText error={patch.error} />
      <Card>
        <p className="muted">
          A payee groups one merchant's descriptions. Merge the variants of one merchant into one payee; the merged names become aliases, so later imports and the rules written on
          those names find it.
        </p>
        {payees.isPending && <p className="muted">Loading payees…</p>}
        {payees.data !== undefined && rows.length === 0 && <Empty>No payees{search ? " match" : " yet"}.</Empty>}
        {rows.length > 0 && <p className="muted small payee-count">{payeeCountText(rows.length, total, search)}</p>}
        {rows.length > 0 && (
          <div className="scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Payee</th>
                  <th>Also known as</th>
                  <th className="num">Transactions</th>
                  <th>Default category</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {renaming?.id === p.id ? (
                        <form
                          className="row"
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (renaming.name.trim() && renaming.name.trim() !== p.name) patch.mutate({ id: p.id, name: renaming.name.trim() });
                            else setRenaming(null);
                          }}
                        >
                          <input value={renaming.name} onChange={(e) => setRenaming({ id: p.id, name: e.target.value })} maxLength={200} aria-label={`New name for ${p.name}`} autoFocus />
                          <button type="submit" disabled={patch.isPending}>
                            Save
                          </button>
                          <button type="button" className="secondary" onClick={() => setRenaming(null)}>
                            Cancel
                          </button>
                        </form>
                      ) : (
                        <strong>{p.name}</strong>
                      )}
                    </td>
                    <td className="small muted">{p.aliases.join(", ") || "—"}</td>
                    <td className="num">{p.transactionCount}</td>
                    <td>
                      <select
                        value={p.defaultCategoryId ?? ""}
                        disabled={viewer || patch.isPending}
                        onChange={(e) => patch.mutate({ id: p.id, defaultCategoryId: e.target.value || null })}
                        aria-label={`Default category for ${p.name}`}
                      >
                        <option value="">none</option>
                        {(categories.data ?? []).map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="nowrap">
                      {!viewer && (
                        <>
                          <button className="link" onClick={() => setRenaming({ id: p.id, name: p.name })}>
                            rename
                          </button>
                          <button className="link" onClick={() => setMerging(merging === p.id ? null : p.id)} aria-expanded={merging === p.id}>
                            merge into…
                          </button>
                          {merging === p.id && (
                            <MergePicker
                              source={p}
                              pending={patch.isPending}
                              onCancel={() => setMerging(null)}
                              onPick={(target) => {
                                if (window.confirm(`Merge "${p.name}" into "${target.name}"? Its ${p.transactionCount} transactions move there and "${p.name}" becomes an alias.`)) {
                                  patch.mutate({ id: target.id, mergeFromId: p.id });
                                }
                              }}
                            />
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {payees.hasNextPage && (
          <div className="center">
            <button className="secondary" onClick={() => void payees.fetchNextPage()} disabled={payees.isFetchingNextPage}>
              {payees.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </Card>
    </>
  );
}
