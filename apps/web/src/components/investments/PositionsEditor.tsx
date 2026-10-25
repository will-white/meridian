import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HoldingSnapshotView, ManualPositionsBody, SecurityView } from "@meridian/shared";
import { api } from "../../lib/api.js";
import { money } from "../../lib/format.js";
import { buildPositionsBody, derivedPriceText, derivedValueText, emptyPositionRow, parsePositionRows, positionRowsFromSnapshot, statementTotalNote, type PositionRowForm } from "../../lib/investmentForms.js";
import { ErrorText } from "../ui.js";
import { invalidateInvestments, INVESTMENTS_STALE_MS } from "./queries.js";
import { SecurityPicker } from "./SecurityPicker.js";

/**
 * Enter or correct an account's positions by hand (imports design §3.10):
 * rows prefilled from a snapshot (security, quantity, price or value with
 * the other shown derived, optional cost basis), the as-of date and the
 * statement total (seams C40: the balance row becomes the total, the
 * difference is the account's cash). Saves a `manual` snapshot through
 * PUT /investments/accounts/:id/positions, which outranks every import.
 */
export function PositionsEditor({ accountId, initial, defaultDate, today, onClose, onSaved }: { accountId: string; initial: HoldingSnapshotView | null; defaultDate: string; today: string; onClose: () => void; onSaved: (snapshot: HoldingSnapshotView) => void }) {
  const qc = useQueryClient();
  const securities = useQuery({ queryKey: ["securities", "all"], queryFn: () => api<SecurityView[]>("/investments/securities"), staleTime: INVESTMENTS_STALE_MS });
  const [rows, setRows] = useState<PositionRowForm[]>(() => (initial ? positionRowsFromSnapshot(initial) : [emptyPositionRow()]));
  const [asOfDate, setAsOfDate] = useState(defaultDate);
  const [statementTotal, setStatementTotal] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: (body: ManualPositionsBody) => api<HoldingSnapshotView>(`/investments/accounts/${accountId}/positions`, { method: "PUT", body }),
    onSuccess: (snapshot) => {
      invalidateInvestments(qc);
      void qc.invalidateQueries({ queryKey: ["snapshots", accountId] });
      void qc.invalidateQueries({ queryKey: ["prices"] });
      onSaved(snapshot);
    },
  });

  const parsed = useMemo(() => parsePositionRows(rows), [rows]);
  const sumCents = parsed.ok ? parsed.sumCents : null;
  const edit = (key: string, patch: Partial<PositionRowForm>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setClientError(null);
    setRowErrors({});
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = buildPositionsBody(rows, asOfDate, statementTotal, today);
    if (!r.ok) {
      setClientError(r.error);
      setRowErrors(r.rowErrors);
      return;
    }
    setClientError(null);
    save.mutate(r.body);
  };

  return (
    <form className="inv-positions-editor" onSubmit={submit} aria-label="Positions editor">
      <div className="row wrap">
        <label className="inline">
          As of
          <input type="date" value={asOfDate} max={today} onChange={(e) => setAsOfDate(e.target.value)} required />
        </label>
        <label className="inline">
          Statement total
          <input inputMode="decimal" value={statementTotal} onChange={(e) => setStatementTotal(e.target.value)} placeholder={sumCents === null ? "Σ positions" : money(sumCents.toString()).replace(/^\$/, "")} aria-label="Statement total in dollars" className="inv-positions-total" />
        </label>
        <span className="muted small">The total sets the account's balance; the difference from the positions is the account's cash. Blank uses Σ positions.</span>
      </div>
      <div className="scroll">
        <table className="table small inv-table">
          <thead>
            <tr>
              <th>Security</th>
              <th className="num">Quantity</th>
              <th className="num">Price</th>
              <th className="num">Value</th>
              <th className="num">Cost basis</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const valueHint = derivedValueText(row.quantity, row.price);
              const priceHint = derivedPriceText(row.value, row.quantity);
              return (
                <tr key={row.key} className={rowErrors[row.key] ? "inv-row-error" : ""}>
                  <td className="name">
                    <SecurityPicker securityId={row.securityId} create={row.create} securities={securities.data ?? []} label={`Security of row ${row.key}`} onChange={(next) => edit(row.key, { ...next, label: "" })} />
                    {rowErrors[row.key] && <div className="error small">{rowErrors[row.key]}</div>}
                  </td>
                  <td className="num">
                    <input inputMode="decimal" value={row.quantity} onChange={(e) => edit(row.key, { quantity: e.target.value })} placeholder="value only" aria-label="Quantity" className="inv-cell-input" />
                  </td>
                  <td className="num">
                    <input inputMode="decimal" value={row.price} onChange={(e) => edit(row.key, { price: e.target.value })} placeholder={row.price === "" && priceHint ? `≈ ${priceHint}` : ""} aria-label="Price" className="inv-cell-input" />
                  </td>
                  <td className="num">
                    <input inputMode="decimal" value={row.value} onChange={(e) => edit(row.key, { value: e.target.value })} placeholder={row.value === "" && valueHint ? `≈ ${valueHint}` : ""} aria-label="Value in dollars" className="inv-cell-input" />
                  </td>
                  <td className="num">
                    <input inputMode="decimal" value={row.cost} onChange={(e) => edit(row.key, { cost: e.target.value })} placeholder="optional" aria-label="Cost basis in dollars" className="inv-cell-input" />
                  </td>
                  <td className="actions">
                    <button type="button" className="link small danger" onClick={() => setRows((rs) => rs.filter((r) => r.key !== row.key))} aria-label="Remove row">
                      remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>
                <button type="button" className="link small" onClick={() => setRows((rs) => [...rs, emptyPositionRow()])}>
                  + add a position
                </button>
              </td>
              <td className="num">
                <strong>{sumCents === null ? "—" : money(sumCents.toString())}</strong>
              </td>
              <td colSpan={2} className="muted small">
                {sumCents !== null ? (statementTotalNote(sumCents, statementTotal) ?? "") : "some rows need attention"}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="muted small">A price with a quantity gives the value; a value alone (no quantity) is a value-only position. A manual snapshot outranks imports and SimpleFIN for its date.</p>
      <div className="row wrap">
        <button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : `Save positions as of ${asOfDate || "…"}`}
        </button>
        <button type="button" className="secondary" onClick={onClose} disabled={save.isPending}>
          Cancel
        </button>
      </div>
      {clientError && <ErrorText error={new Error(clientError)} />}
      <ErrorText error={save.error} />
    </form>
  );
}
