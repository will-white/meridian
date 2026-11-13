import { useEffect, useState, type ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { RecurringView, TransactionList, TransactionView } from "@meridian/shared";
import { api, query } from "../../lib/api.js";
import { money, shortDate } from "../../lib/format.js";
import { Badge, Empty, ErrorText } from "../ui.js";
import { chargeLinkAction } from "./recurringFormat.js";
import type { RecurringMutations } from "./useRecurringMutations.js";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function ChargeRow({ t, action }: { t: TransactionView; action: ReactNode }) {
  return (
    <tr className={t.pending ? "pending" : ""}>
      <td className="nowrap">{shortDate(t.date)}</td>
      <td className="muted nowrap rec-col-account">{t.accountName}</td>
      <td>
        {t.payeeName ?? t.rawDescription}
        {t.pending && <Badge tone="info">pending</Badge>}
        {t.isTransfer && <Badge tone="neutral">transfer</Badge>}
        {t.categoryName && <span className="muted small"> · {t.categoryName}</span>}
      </td>
      <td className={`num nowrap ${t.amountCents.startsWith("-") ? "neg" : "pos"}`}>{money(t.amountCents)}</td>
      <td className="nowrap">{action}</td>
    </tr>
  );
}

/** The charges linked to one recurring item, with unlink, plus a search to link another transaction. */
export function ChargesPanel({ item, mutations }: { item: RecurringView; mutations: RecurringMutations }) {
  const charges = useInfiniteQuery({
    queryKey: ["transactions", "recurring", item.id],
    queryFn: ({ pageParam }) => api<TransactionList>(`/recurring/${item.id}/transactions${query({ limit: 50, cursor: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const [linking, setLinking] = useState(false);
  const [q, setQ] = useState(item.payeeName);
  const search = useDebounced(q, 250);
  const candidates = useQuery({
    queryKey: ["transactions", "link-candidates", item.id, search],
    queryFn: () => api<TransactionList>(`/transactions${query({ q: search, limit: 50, transfers: "exclude" })}`),
    enabled: linking,
  });

  const linked = charges.data?.pages.flatMap((p) => p.items) ?? [];
  // Only what the link route accepts: the item's payee and direction; a charge of another item is moved.
  const linkable = (candidates.data?.items ?? []).flatMap((t) => {
    const action = chargeLinkAction(t, item);
    return action === null ? [] : [{ t, action }];
  });

  return (
    <div className="rec-charges">
      <div className="row space wrap">
        <strong>
          {item.chargeCount} linked charge{item.chargeCount === 1 ? "" : "s"}
        </strong>
        <button className="link small" onClick={() => setLinking((v) => !v)}>
          {linking ? "Done linking" : "Link a charge…"}
        </button>
      </div>
      <ErrorText error={charges.error} />
      <ErrorText error={mutations.unlink.error} />
      {linked.length === 0 && !charges.isLoading && <Empty>No charges are linked yet.</Empty>}
      {linked.length > 0 && (
        <table className="table small register rec-charge-table">
          <tbody>
            {linked.map((t) => (
              <ChargeRow
                key={t.id}
                t={t}
                action={
                  <button className="link small" onClick={() => mutations.unlink.mutate({ id: item.id, transactionId: t.id })} disabled={mutations.unlink.isPending} title="Remove this charge from the series">
                    unlink
                  </button>
                }
              />
            ))}
          </tbody>
        </table>
      )}
      {charges.hasNextPage && (
        <button className="link small" onClick={() => void charges.fetchNextPage()} disabled={charges.isFetchingNextPage}>
          {charges.isFetchingNextPage ? "Loading…" : "Older charges"}
        </button>
      )}
      {linking && (
        <div className="rec-link">
          <div className="row wrap">
            <input className="grow" placeholder="Search payee or description…" value={q} onChange={(e) => setQ(e.target.value)} />
            <span className="muted small">Same payee and direction only; one charge per period.</span>
          </div>
          <ErrorText error={candidates.error} />
          <ErrorText error={mutations.link.error} />
          {candidates.isLoading && <p className="muted small">Searching…</p>}
          {!candidates.isLoading && linkable.length === 0 && <Empty>No matching transactions to link.</Empty>}
          {linkable.length > 0 && (
            <table className="table small register rec-charge-table">
              <tbody>
                {linkable.map(({ t, action }) => (
                  <ChargeRow
                    key={t.id}
                    t={t}
                    action={
                      <button
                        className="link small"
                        onClick={() => mutations.link.mutate({ id: item.id, transactionId: t.id, move: action === "move" })}
                        disabled={mutations.link.isPending}
                        title={action === "move" ? "Linked to another recurring item: moves it to this one" : undefined}
                      >
                        {action === "move" ? "move here" : "link"}
                      </button>
                    }
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
