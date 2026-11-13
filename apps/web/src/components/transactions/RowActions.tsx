import { useQuery } from "@tanstack/react-query";
import type { TransactionView, TransferCandidateView } from "@meridian/shared";
import { api } from "../../lib/api.js";
import { canDelete, candidateLabel, deleteWarning } from "../../lib/ledgerCorrections.js";
import { ErrorText } from "../ui.js";

/**
 * The register's corrections for one row (audit a5-ingest-transfers-09 and -12): pair it with
 * the other leg of a transfer the automatic pairing missed, mark it as a transfer whose other
 * leg is not in the app, or delete it (a duplicate, a typo, a row imported by mistake).
 */
export function RowActions({
  transaction: t,
  viewer,
  pending,
  error,
  onPair,
  onMarkTransfer,
  onDelete,
  onClose,
}: {
  transaction: TransactionView;
  viewer: boolean;
  pending: boolean;
  error: unknown;
  onPair: (otherId: string) => void;
  onMarkTransfer: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const candidates = useQuery({
    queryKey: ["transactions", "transfer-candidates", t.id],
    queryFn: () => api<TransferCandidateView[]>(`/transactions/${t.id}/transfer-candidates`),
    enabled: !t.isTransfer,
  });
  return (
    <div className="row-actions">
      {!t.isTransfer && (
        <div>
          <strong className="small">Pair with the other leg of a transfer</strong>
          {candidates.isLoading && <div className="muted small">Looking for equal and opposite rows…</div>}
          {candidates.data && candidates.data.length === 0 && <div className="muted small">No equal and opposite row in another account within two weeks.</div>}
          <ul className="plain">
            {(candidates.data ?? []).map((c) => (
              <li key={c.id} className="small">
                {candidateLabel(c)}{" "}
                {!viewer && (
                  <button className="link small" disabled={pending} onClick={() => onPair(c.id)}>
                    pair
                  </button>
                )}
              </li>
            ))}
          </ul>
          {!viewer && (
            <button className="link small" disabled={pending} onClick={onMarkTransfer} title="A move to an account that is not in the app: it leaves the plan">
              mark as a transfer without its other leg
            </button>
          )}
        </div>
      )}
      {!viewer && canDelete(t) && (
        <div>
          <button
            className="link small danger"
            disabled={pending}
            onClick={() => {
              if (window.confirm(deleteWarning(t))) onDelete();
            }}
          >
            delete this transaction
          </button>
        </div>
      )}
      <ErrorText error={error} />
      <button className="link small" onClick={onClose}>
        close
      </button>
    </div>
  );
}
