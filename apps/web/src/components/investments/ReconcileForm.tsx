import { useState } from "react";
import { money } from "../../lib/format.js";
import { emptyRow, parsePastedRows, type ReconcileRowForm } from "../../lib/reconcileView.js";

/**
 * The statement rows (prices design §5, step 2): one line per holding with
 * the ticker (a datalist of known securities; the cash checkbox marks the
 * cash row, whose quantity is its dollars), quantity, optional price and
 * value; "Prefill from app" copies the app's positions on the date, "Paste
 * from CSV" reads symbol, quantity, price, value; the statement total
 * defaults to Σ values. Row errors from the page's validation show inline.
 * Viewers may use the form (the preview is a read); only the commit is the
 * owner's.
 */
export function ReconcileForm({
  rows,
  onChange,
  tickers,
  statementTotal,
  onStatementTotal,
  sumCents,
  errors,
  onPrefill,
  canPrefill,
}: {
  rows: readonly ReconcileRowForm[];
  onChange: (rows: ReconcileRowForm[]) => void;
  tickers: readonly string[];
  statementTotal: string;
  onStatementTotal: (value: string) => void;
  /** Σ of the valid rows' values, the default total; null while a row is invalid. */
  sumCents: bigint | null;
  errors: Record<string, string>;
  onPrefill: () => void;
  canPrefill: boolean;
}) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");

  const edit = (key: string, patch: Partial<ReconcileRowForm>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const remove = (key: string) => onChange(rows.filter((r) => r.key !== key));
  const addPasted = () => {
    const parsed = parsePastedRows(pasteText);
    if (parsed.length === 0) return;
    onChange([...rows.filter((r) => r.ticker.trim() !== "" || r.quantity.trim() !== "" || r.isCash), ...parsed]);
    setPasteText("");
    setPasteOpen(false);
  };
  const hasCashRow = rows.some((r) => r.isCash);

  return (
    <div className="rec-form">
      <datalist id="reconcile-tickers">
        {tickers.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div className="row wrap rec-form-actions">
        <button type="button" className="secondary" onClick={onPrefill} disabled={!canPrefill} title="Copy the app's positions on this date as the starting point">
          Prefill from app
        </button>
        <button type="button" className="secondary" onClick={() => setPasteOpen((v) => !v)} aria-expanded={pasteOpen}>
          Paste from CSV
        </button>
        <button type="button" className="link small" onClick={() => onChange([...rows, emptyRow()])}>
          + add a row
        </button>
        {!hasCashRow && (
          <button type="button" className="link small" onClick={() => onChange([...rows, { ...emptyRow(), ticker: "Cash", isCash: true }])}>
            + cash row
          </button>
        )}
        {rows.length > 0 && (
          <button type="button" className="link small danger" onClick={() => onChange([])}>
            clear
          </button>
        )}
      </div>
      {pasteOpen && (
        <div className="rec-paste">
          <textarea
            rows={5}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={"Symbol,Quantity,Price,Value\nVTI,100,305.25,30525.00\nCash,,,2234.56"}
            aria-label="Pasted statement rows"
          />
          <div className="row wrap">
            <button type="button" className="secondary" onClick={addPasted} disabled={pasteText.trim() === ""}>
              Add rows
            </button>
            <span className="muted small">Columns: symbol, quantity, price, value (a header row is skipped; "Cash" rows take the last number as dollars).</span>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="muted small">No statement rows yet. Prefill from the app, paste the statement, add rows by hand, or enter only the statement total below.</p>
      ) : (
        <div className="scroll">
          <table className="table small inv-table rec-rows">
            <thead>
              <tr>
                <th>Security</th>
                <th>Cash</th>
                <th className="num">Quantity</th>
                <th className="num">Price</th>
                <th className="num">Value</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const err = errors[r.key];
                return (
                  <tr key={r.key} className={err ? "rec-row-error" : ""}>
                    <td>
                      <input
                        list="reconcile-tickers"
                        value={r.ticker}
                        disabled={r.isCash}
                        placeholder="ticker"
                        aria-label="Ticker"
                        onChange={(e) => edit(r.key, { ticker: e.target.value, securityId: null })}
                        className="rec-ticker"
                      />
                      {err && <div className="error small">{err}</div>}
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={r.isCash}
                        aria-label="Cash row"
                        onChange={(e) => edit(r.key, { isCash: e.target.checked, ticker: e.target.checked ? "Cash" : r.ticker === "Cash" ? "" : r.ticker, securityId: null, price: "", value: "" })}
                      />
                    </td>
                    <td className="num">
                      <input inputMode="decimal" value={r.quantity} placeholder={r.isCash ? "dollars" : "shares"} aria-label={r.isCash ? "Cash dollars" : "Quantity"} onChange={(e) => edit(r.key, { quantity: e.target.value })} className="rec-num" />
                    </td>
                    <td className="num">
                      {!r.isCash && <input inputMode="decimal" value={r.price} placeholder="optional" aria-label="Price" onChange={(e) => edit(r.key, { price: e.target.value })} className="rec-num" />}
                    </td>
                    <td className="num">
                      {!r.isCash && <input inputMode="decimal" value={r.value} placeholder="or value" aria-label="Value" onChange={(e) => edit(r.key, { value: e.target.value })} className="rec-num" />}
                    </td>
                    <td className="actions">
                      <button type="button" className="link small danger" onClick={() => remove(r.key)} aria-label="Remove row">
                        remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <label className="rec-total">
        Statement total
        <span className="row">
          <span className="muted">$</span>
          <input inputMode="decimal" value={statementTotal} placeholder={sumCents === null ? "Σ values" : money(sumCents.toString()).replace(/^\$/, "")} onChange={(e) => onStatementTotal(e.target.value)} aria-label="Statement total in dollars" />
          <span className="muted small">{statementTotal.trim() === "" ? "defaults to the sum of the rows" : sumCents !== null ? `rows add up to ${money(sumCents.toString())}` : ""}</span>
        </span>
      </label>
    </div>
  );
}
