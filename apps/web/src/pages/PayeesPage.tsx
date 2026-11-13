import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CategoryView } from "@meridian/shared";
import { api, query } from "../lib/api.js";
import { Card, Empty, ErrorText } from "../components/ui.js";
import { useIsViewer } from "../components/investments/queries.js";

interface PayeeRow {
  id: string;
  name: string;
  aliases: string[];
  defaultCategoryId: string | null;
  transactionCount: number;
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
  const payees = useQuery({ queryKey: ["payees", q], queryFn: () => api<PayeeRow[]>(`/payees${query({ q: q.trim() || undefined })}`) });
  const all = useQuery({ queryKey: ["payees", ""], queryFn: () => api<PayeeRow[]>("/payees") });
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
      if (v.mergeFromId) setNotice(`Merged into ${row.name}; it now answers to ${row.aliases.length} other name${row.aliases.length === 1 ? "" : "s"}.`);
      else if (v.name) setNotice(`Renamed to ${row.name}; the old name stays an alias.`);
      invalidate();
    },
  });
  const rows = payees.data ?? [];
  const others = (id: string) => (all.data ?? []).filter((p) => p.id !== id);

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
        {rows.length === 0 && !payees.isLoading && <Empty>No payees{q ? " match" : " yet"}.</Empty>}
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
                          <select
                            value=""
                            disabled={patch.isPending}
                            aria-label={`Merge ${p.name} into another payee`}
                            onChange={(e) => {
                              const target = others(p.id).find((o) => o.id === e.target.value);
                              if (target && window.confirm(`Merge "${p.name}" into "${target.name}"? Its ${p.transactionCount} transactions move there and "${p.name}" becomes an alias.`)) {
                                patch.mutate({ id: target.id, mergeFromId: p.id });
                              }
                            }}
                          >
                            <option value="">merge into…</option>
                            {others(p.id).map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.name}
                              </option>
                            ))}
                          </select>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
