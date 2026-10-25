import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReconciliationListResponse } from "@meridian/shared";
import { api, query } from "../../lib/api.js";
import { money, shortDate } from "../../lib/format.js";
import { signedMoney } from "../../lib/investments.js";
import { recordOutcome } from "../../lib/reconcileView.js";
import { Badge, Empty, ErrorText } from "../ui.js";
import { invalidateInvestments } from "./queries.js";

/** Keys a reconciliation changes: the records, the accounts' last-check line, the manual snapshot an accepted statement writes, every valued view and the dashboard's awaiting count: the one editor list. */
export function invalidateReconcile(qc: ReturnType<typeof useQueryClient>): void {
  invalidateInvestments(qc);
}

/**
 * Past reconciliations of an account (GET /reconcile/history), newest first:
 * the statement date, the outcome (exact / to the dollar / off by), the app
 * and statement values, whether the statement was accepted, the setting in
 * force and the note. Owners may delete a record (DELETE /reconcile/:id; the
 * snapshot it wrote stays). A recorded difference of 0 is the gate's evidence.
 */
export function ReconcileHistory({ accountId, viewer }: { accountId: string; viewer: boolean }) {
  const qc = useQueryClient();
  const history = useQuery({
    queryKey: ["reconcile", "history", accountId],
    queryFn: () => api<ReconciliationListResponse>(`/reconcile/history${query({ accountId, limit: 50 })}`),
    staleTime: 30_000,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/reconcile/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateReconcile(qc),
  });
  const items = history.data?.items ?? [];
  return (
    <div className="rec-history">
      <ErrorText error={history.error} />
      <ErrorText error={remove.error} />
      {history.isLoading && <p className="muted small">Loading…</p>}
      {history.data && items.length === 0 && <Empty>Not yet checked against a statement.</Empty>}
      {items.length > 0 && (
        <div className="scroll">
          <table className="table small inv-table">
            <thead>
              <tr>
                <th>Statement</th>
                <th>Outcome</th>
                <th className="num">App</th>
                <th className="num">Statement</th>
                <th className="num">Difference</th>
                <th>Accepted</th>
                <th>Cash inference</th>
                <th>Note</th>
                <th>Recorded</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => {
                const outcome = recordOutcome(r);
                return (
                  <tr key={r.id}>
                    <td>{shortDate(r.date)}</td>
                    <td>
                      <Badge tone={outcome.tone}>{outcome.text}</Badge>
                    </td>
                    <td className="num">
                      {money(r.appValueCents)}
                      <div className="muted small">
                        {r.appBasis}
                        {r.appAsOf ? ` · ${shortDate(r.appAsOf)}` : ""}
                      </div>
                    </td>
                    <td className="num">{money(r.statementTotalCents)}</td>
                    <td className="num">{r.differenceCents === null ? "—" : signedMoney(r.differenceCents)}</td>
                    <td>{r.accepted ? <Badge tone="ok">accepted{r.holdingSnapshotDate ? ` · snapshot ${shortDate(r.holdingSnapshotDate)}` : ""}</Badge> : <Badge tone="neutral">recorded only</Badge>}</td>
                    <td className="muted">{r.cashInference}</td>
                    <td className="muted small">{r.note ?? ""}</td>
                    <td className="muted small">{shortDate(r.createdAt.slice(0, 10))}</td>
                    <td className="actions">
                      {!viewer && (
                        <button type="button" className="link small danger" disabled={remove.isPending} onClick={() => remove.mutate(r.id)} aria-label={`Delete the record of ${shortDate(r.date)}`}>
                          delete
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
