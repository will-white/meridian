import { useState } from "react";
import { Link } from "react-router";
import type { CashInference, ReconcilePreviewResponse } from "@meridian/shared";
import { money, shortDate } from "../../lib/format.js";
import { changeTone, formatQuantity, priceSourceLabel, signedMoney } from "../../lib/investments.js";
import { cashInferenceHintText, cashInferenceReadings, differenceHeadline, rowStatusLabel, rowStatusTone, unexplainedText, type CashInferenceReading } from "../../lib/reconcileView.js";
import { Badge, ErrorText } from "../ui.js";

/**
 * The preview (prices design §5, step 3): one row per security with the
 * app's quantity, price (source and date) and value beside the statement's,
 * the three diffs and the status badge; the totals line; the headline
 * ("Matches to the dollar" / "Off by $1.00"); the bank-balance line; both
 * cash-inference readings with the owner's one-click toggle; the
 * already-reconciled bar; and the owner's Accept / Record only buttons with
 * a note. Both buttons wait while `commitBlock` names what is missing
 * (rows or a total, or a row that does not parse), and Accept confirms a
 * $0.00 statement, since accepting replaces the date's positions and
 * balance. Nothing here writes: the page owns the mutations.
 */
export function ReconcilePreview({
  preview,
  viewer,
  updating,
  onToggleCashInference,
  toggling,
  onCommit,
  committing,
  commitBlock,
  commitError,
}: {
  preview: ReconcilePreviewResponse;
  viewer: boolean;
  updating: boolean;
  onToggleCashInference: (setting: CashInference) => void;
  toggling: boolean;
  onCommit: (accept: boolean, note: string | undefined) => void;
  committing: boolean;
  /** Why neither button may run yet (`commitBlockText`); null when the statement is in. */
  commitBlock: string | null;
  commitError: unknown;
}) {
  const [note, setNote] = useState("");
  const accept = () => {
    if (BigInt(preview.statementTotalCents) === 0n && !window.confirm("The statement total is $0.00. Accepting writes an empty statement as this date's positions and a $0.00 balance. Continue?")) return;
    onCommit(true, note.trim() || undefined);
  };
  const headline = differenceHeadline(preview.differenceCents, preview.matchesToDollar);
  const readings = cashInferenceReadings(preview);
  const unknown = preview.rows.filter((r) => r.status === "unknown_ticker");
  const unexplained = unexplainedText(preview.unexplainedCents);
  const app = preview.app;
  const lastSnapshot = app.basis === "snapshot" || app.basis === "positions" ? app.asOf : null;

  return (
    <div className="rec-preview">
      <div className="rec-headline-row">
        <div className={`rec-headline tone-${headline.tone}`}>{headline.text}</div>
        <div className="muted">
          App {money(app.valueCents)} · Statement {money(preview.statementTotalCents)} · Difference {preview.differenceCents === null ? "—" : signedMoney(preview.differenceCents)}
          {updating ? " · updating…" : ""}
        </div>
        <div className="muted small">
          App value {app.basis === "none" ? "unknown" : `from ${app.basis === "lots" ? "trade history" : app.basis === "snapshot" ? "the statement on file" : app.basis === "positions" ? "positions repriced" : "the reported balance"}`}
          {app.asOf ? ` (data as of ${shortDate(app.asOf)})` : ""}; tolerance {money(preview.toleranceCents)}; a difference of 0 is exact.
        </div>
      </div>

      {preview.alreadyReconciled && <p className="rec-bar info">A statement for {shortDate(preview.date)} is already on file; accepting replaces it.</p>}
      {unexplained && <p className="muted small">{unexplained}</p>}

      <div className="scroll">
        <table className="table small inv-table rec-table">
          <thead>
            <tr>
              <th>Security</th>
              <th className="num">App qty</th>
              <th className="num">App price</th>
              <th className="num">App value</th>
              <th className="num">Stmt qty</th>
              <th className="num">Stmt price</th>
              <th className="num">Stmt value</th>
              <th className="num">Δ qty</th>
              <th className="num">Δ price</th>
              <th className="num">Δ value</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((r, i) => (
              <tr key={`${r.securityId ?? r.ticker ?? "cash"}-${i}`}>
                <td>
                  {r.ticker ? <strong>{r.ticker}</strong> : null} {r.name ?? (r.isCash ? "Cash" : r.ticker ?? "—")}
                  {r.status === "unknown_ticker" && (
                    <div className="small">
                      <Link to={`/investments/securities${r.ticker ? `?q=${encodeURIComponent(r.ticker)}` : ""}`}>create security</Link>
                    </div>
                  )}
                </td>
                <td className="num">{r.app?.quantity === null || r.app === null ? <span className="muted">{r.app === null ? "—" : "value only"}</span> : formatQuantity(r.app.quantity, 4)}</td>
                <td className="num">
                  {r.app?.price === null || r.app === null ? <span className="muted">—</span> : formatQuantity(r.app.price, 4)}
                  {r.app?.price !== null && r.app !== null && (
                    <div className="muted small">
                      {priceSourceLabel(r.app.priceSource)}
                      {r.app.priceDate ? ` · ${shortDate(r.app.priceDate)}` : ""}
                    </div>
                  )}
                </td>
                <td className="num">{r.app === null ? <span className="muted">—</span> : money(r.app.valueCents)}</td>
                <td className="num">{r.statement === null ? <span className="muted">—</span> : r.isCash ? <span className="muted">dollars</span> : formatQuantity(r.statement.quantity, 4)}</td>
                <td className="num">{r.statement?.price === null || r.statement === null ? <span className="muted">—</span> : formatQuantity(r.statement.price, 4)}</td>
                <td className="num">{r.statement === null ? <span className="muted">—</span> : money(r.statement.valueCents)}</td>
                <td className={`num ${r.quantityDiff !== null && r.quantityDiff !== "0" ? "tone-warn" : "muted"}`}>{r.quantityDiff === null ? "—" : formatQuantity(r.quantityDiff, 4)}</td>
                <td className={`num ${r.priceDiff !== null && r.priceDiff !== "0" ? "tone-warn" : "muted"}`}>{r.priceDiff === null ? "—" : formatQuantity(r.priceDiff, 4)}</td>
                <td className={`num ${changeTone(r.valueDiffCents)}`}>{r.valueDiffCents === null ? "—" : signedMoney(r.valueDiffCents)}</td>
                <td>
                  <Badge tone={rowStatusTone(r.status)}>{rowStatusLabel(r.status)}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {preview.balance.balanceCents !== null && (
        <p className="muted small">
          Bank balance {money(preview.balance.balanceCents)}
          {preview.balance.balanceDate ? ` on ${shortDate(preview.balance.balanceDate)}` : ""}
          {preview.balance.differenceCents !== null ? `; ${BigInt(preview.balance.differenceCents) === 0n ? "equal to the statement" : `${signedMoney(preview.balance.differenceCents)} against the statement`}` : ""}.
        </p>
      )}

      <div className="rec-readings">
        <ReadingCard reading={readings.current} current />
        {readings.alternative ? (
          <ReadingCard reading={readings.alternative} current={false} onToggle={viewer ? undefined : () => onToggleCashInference(readings.alternative!.setting)} toggling={toggling} />
        ) : (
          <div className="rec-reading muted small">Cash inference {app.cashInference === "auto" ? "on" : "off"}: the other setting would not change this value.</div>
        )}
      </div>
      {preview.cashInferenceHint && <p className="rec-bar hint">{cashInferenceHintText(preview.cashInferenceHint, lastSnapshot)}</p>}
      {app.warnings.length > 0 && (
        <ul className="inv-warnings">
          {app.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {!viewer && (
        <div className="rec-commit">
          <label className="grow">
            Note (optional)
            <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. September statement, page 3" />
          </label>
          <div className="row wrap">
            <button type="button" disabled={committing || updating || commitBlock !== null || unknown.length > 0} onClick={accept} title="Write the statement as the app's positions and balance for this date">
              {committing ? "Saving…" : "Accept statement"}
            </button>
            <button type="button" className="secondary" disabled={committing || updating || commitBlock !== null} onClick={() => onCommit(false, note.trim() || undefined)} title="Record the check without changing holdings">
              Record only
            </button>
          </div>
          {commitBlock && <span className="muted small">{commitBlock}</span>}
          {unknown.length > 0 && (
            <span className="muted small">
              Accepting needs every ticker known: {unknown.map((r) => r.ticker ?? "?").join(", ")} {unknown.length === 1 ? "is" : "are"} not in the security master.
            </span>
          )}
          <ErrorText error={commitError} />
        </div>
      )}
    </div>
  );
}

function ReadingCard({ reading, current, onToggle, toggling = false }: { reading: CashInferenceReading; current: boolean; onToggle?: (() => void) | undefined; toggling?: boolean }) {
  return (
    <div className={`rec-reading ${current ? "current" : ""}`}>
      <div className="row wrap">
        <strong>Infer cash from balance: {reading.setting === "auto" ? "on" : "off"}</strong>
        {current && <Badge tone="neutral">current setting</Badge>}
        <Badge tone={reading.reconciles ? "ok" : "warn"}>{reading.reconciles ? "reconciles" : "does not reconcile"}</Badge>
      </div>
      <div>
        App {money(reading.valueCents)} · difference {reading.differenceCents === null ? "—" : signedMoney(reading.differenceCents)}
      </div>
      <div className="muted small">{reading.note}</div>
      {onToggle && (
        <button type="button" className="link small" disabled={toggling} onClick={onToggle}>
          {toggling ? "switching…" : `switch this account to ${reading.setting === "auto" ? "on" : "off"} and re-preview`}
        </button>
      )}
    </div>
  );
}
