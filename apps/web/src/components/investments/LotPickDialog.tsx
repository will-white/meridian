import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatFixed8, parseFixed8 } from "@meridian/shared";
import type { InvestmentTxnView, LotsResponse, SetLotPicksResponse } from "@meridian/shared";
import { api, query } from "../../lib/api.js";
import { shortDate } from "../../lib/format.js";
import { changeTone, formatQuantity, signedMoney } from "../../lib/investments.js";
import { estimatedLotGain, parseLotPicks, pickableLots } from "../../lib/investmentForms.js";
import { Badge, ErrorText } from "../ui.js";
import { invalidateInvestments, INVESTMENTS_STALE_MS } from "./queries.js";

/**
 * Specific identification for a sale or a transfer out (plan decision 5,
 * seams C7): the security's lots open on the sale date (GET /investments/lots
 * as of that date) with acquired date, open quantity, basis per share, term
 * and the gain a pick would realize; the owner types quantities; the
 * validation mirrors the route (each pick ≤ the lot, Σ ≤ the sale; FIFO
 * covers the remainder). Saves through PUT /investments/txns/:id/lot-picks;
 * an empty set clears the picks. The engine's warnings come back with the
 * response and are shown.
 */
export function LotPickDialog({ txn, today, onClose }: { txn: InvestmentTxnView; today: string; onClose: () => void }) {
  const qc = useQueryClient();
  const params = { accountId: txn.accountId, securityId: txn.securityId ?? "", asOf: txn.date <= today ? txn.date : today, includeClosed: "true", today };
  const lots = useQuery({
    queryKey: ["lots", params],
    queryFn: () => api<LotsResponse>(`/investments/lots${query(params)}`),
    enabled: txn.securityId !== null,
    staleTime: INVESTMENTS_STALE_MS,
  });
  const candidates = useMemo(() => (lots.data && txn.securityId ? pickableLots(lots.data.lots, txn.securityId, txn.date) : []), [lots.data, txn.securityId, txn.date]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [clientError, setClientError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SetLotPicksResponse | null>(null);

  // Start from the picks already on the row.
  useEffect(() => {
    setDrafts(Object.fromEntries(txn.lotPicks.map((p) => [p.lotId, p.quantity])));
  }, [txn.id, txn.lotPicks]);

  const save = useMutation({
    mutationFn: (picks: Array<{ lotId: string; quantity: string }>) => api<SetLotPicksResponse>(`/investments/txns/${txn.id}/lot-picks`, { method: "PUT", body: { picks, today } }),
    onSuccess: (r) => {
      setSaved(r);
      invalidateInvestments(qc);
      void qc.invalidateQueries({ queryKey: ["investment-transactions"] });
      void qc.invalidateQueries({ queryKey: ["lots"] });
    },
  });

  const parsed = parseLotPicks(drafts, candidates, txn.quantity ?? "0");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!parsed.ok) return setClientError(parsed.error);
    setClientError(null);
    save.mutate(parsed.picks);
  };
  const remainder = parsed.ok && txn.quantity ? remainderText(txn.quantity, parsed.sumQuantity) : null;

  return (
    <form className="inv-lot-picks" onSubmit={submit} aria-label="Lot picks">
      <div className="row space wrap">
        <strong>
          Lots for {txn.type === "sell" ? "the sale" : "the transfer"} of {txn.quantity ? formatQuantity(txn.quantity, 8) : "?"} {txn.ticker ?? txn.securityName ?? ""} on {shortDate(txn.date)}
        </strong>
        <span className="muted small">{txn.price ? `at ${formatQuantity(txn.price, 4)}` : "no price on the row"}</span>
      </div>
      <ErrorText error={lots.error} />
      {lots.isLoading && <p className="muted small">Loading the lots…</p>}
      {lots.data && candidates.length === 0 && <p className="muted small">No lots of this security were open on {shortDate(txn.date)}; the engine reports the sale as unmatched.</p>}
      {candidates.length > 0 && <p className="muted small">"Open today" is what remains after every sale to date (this one included under FIFO); a pick may use up to the lot's quantity, and the server checks it against the lots open on the sale date.</p>}
      {candidates.length > 0 && (
        <div className="scroll">
          <table className="table small inv-table">
            <thead>
              <tr>
                <th>Acquired</th>
                <th className="num">Lot</th>
                <th className="num">Open today</th>
                <th className="num">Basis / share</th>
                <th>Term</th>
                <th className="num">Pick</th>
                <th className="num">Est. gain</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((lot) => {
                const gain = estimatedLotGain(lot, txn.price, drafts[lot.id] ?? "");
                return (
                  <tr key={lot.id}>
                    <td>
                      {shortDate(lot.acquiredDate)}
                      {lot.openedBy !== "buy" && <Badge tone="neutral">{lot.openedBy.replace("_", " ")}</Badge>}
                      {lot.originLotId && <span className="muted small"> (transferred)</span>}
                    </td>
                    <td className="num">{formatQuantity(lot.originalQuantity, 8)}</td>
                    <td className="num muted">{formatQuantity(lot.quantity, 8)}</td>
                    <td className="num">{lot.basisKnown && lot.basisPerShare ? formatQuantity(lot.basisPerShare, 4) : <span className="muted">unknown</span>}</td>
                    <td>
                      <Badge tone={lot.term === "long" ? "ok" : lot.term === "short" ? "warn" : "neutral"}>{lot.term}</Badge>
                    </td>
                    <td className="num">
                      <input
                        inputMode="decimal"
                        value={drafts[lot.id] ?? ""}
                        onChange={(e) => {
                          setDrafts((d) => ({ ...d, [lot.id]: e.target.value }));
                          setClientError(null);
                          setSaved(null);
                        }}
                        placeholder="0"
                        aria-label={`Shares from the lot acquired ${lot.acquiredDate}`}
                        className="inv-cell-input"
                      />
                    </td>
                    <td className={`num ${gain === null ? "muted" : changeTone(gain.toString())}`}>{gain === null ? (drafts[lot.id] ? "—" : "") : signedMoney(gain.toString())}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="row wrap">
        <span className={`small ${parsed.ok ? "muted" : "error"}`}>{parsed.ok ? `Picked ${formatQuantity(parsed.sumQuantity, 8)} of ${txn.quantity ? formatQuantity(txn.quantity, 8) : "?"}${remainder && remainder !== "0" ? ` · ${remainder} by FIFO` : ""}` : parsed.error}</span>
      </div>
      <div className="row wrap">
        <button type="submit" disabled={save.isPending || !parsed.ok || candidates.length === 0}>
          {save.isPending ? "Saving…" : parsed.ok && parsed.picks.length === 0 ? "Clear picks (FIFO)" : "Save picks"}
        </button>
        <button type="button" className="secondary" onClick={onClose} disabled={save.isPending}>
          Close
        </button>
        {saved && <span className="notice small">Saved: {saved.picks.length === 0 ? "FIFO" : `${saved.picks.length} pick${saved.picks.length === 1 ? "" : "s"}`}.</span>}
      </div>
      {saved && saved.warnings.length > 0 && (
        <ul className="inv-warnings">
          {saved.warnings.map((w, i) => (
            <li key={i}>
              {w.code.replace(/_/g, " ")}
              {w.detail ? `: ${w.detail}` : ""}
              {w.quantity ? ` (${formatQuantity(w.quantity, 8)} sh)` : ""}
            </li>
          ))}
        </ul>
      )}
      {clientError && <ErrorText error={new Error(clientError)} />}
      <ErrorText error={save.error} />
      <p className="muted small">Picks apply under the account's specific-identification method (set in the header); with FIFO they are kept but the oldest lots are consumed.</p>
    </form>
  );
}

/** The shares FIFO will cover: the sale's quantity minus the picks (canonical Fixed8 strings), "0" when nothing is left. */
function remainderText(saleQuantity: string, picked: string): string {
  const units = parseFixed8(saleQuantity) - parseFixed8(picked);
  return units <= 0n ? "0" : formatQuantity(formatFixed8(units), 8);
}
