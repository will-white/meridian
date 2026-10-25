import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AssetClass, SecurityRef, SetSecurityAllocationBody } from "@meridian/shared";
import { api } from "../../lib/api.js";
import { ASSET_CLASSES, assetClassLabel, parseSplitsForm, splitRows, type SplitRowForm } from "../../lib/investments.js";
import { ErrorText } from "../ui.js";
import { invalidateInvestments } from "./queries.js";

/**
 * A security's primary asset class and optional splits (plan decision 16):
 * the primary class select plus split rows (class + percent) that must sum to
 * 100 % and include the primary class; no rows means the primary class only.
 * Saved through PUT /investments/securities/:id/allocation; the server's
 * `split_sum` / `split_primary` messages are shown verbatim. Owner only.
 */
export function SecurityAllocationEditor({ security, onClose }: { security: SecurityRef; onClose: () => void }) {
  const qc = useQueryClient();
  const [primary, setPrimary] = useState<AssetClass>(security.assetClass);
  const [rows, setRows] = useState<SplitRowForm[]>(() => splitRows(security.splits));
  const [clientError, setClientError] = useState<string | null>(null);
  const isCash = security.type === "cash";

  const save = useMutation({
    mutationFn: (body: SetSecurityAllocationBody) => api<SecurityRef>(`/investments/securities/${security.securityId}/allocation`, { method: "PUT", body }),
    onSuccess: () => {
      invalidateInvestments(qc);
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = parseSplitsForm(primary, rows);
    if (!r.ok) return setClientError(r.error);
    setClientError(null);
    save.mutate(r.body);
  };
  const editRow = (i: number, patch: Partial<SplitRowForm>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => {
    const used = new Set(rows.map((r) => r.assetClass));
    const next = ASSET_CLASSES.find((c) => !used.has(c)) ?? "other";
    setRows((rs) => [...rs, { assetClass: next, percent: "" }]);
  };

  return (
    <form className="inv-split-editor" onSubmit={submit} aria-label={`Asset class of ${security.ticker ?? security.name}`}>
      <label>
        Primary class
        <select value={primary} onChange={(e) => setPrimary(e.target.value as AssetClass)}>
          {ASSET_CLASSES.map((c) => (
            <option key={c} value={c}>
              {assetClassLabel(c)}
            </option>
          ))}
        </select>
      </label>
      {!isCash && (
        <div className="inv-split-rows">
          <span className="muted small">Blended fund? Split it across classes (the parts must add up to 100 % and include the primary class). Leave empty for one class.</span>
          {rows.map((row, i) => (
            <div className="row wrap" key={i}>
              <select value={row.assetClass} onChange={(e) => editRow(i, { assetClass: e.target.value as AssetClass })} aria-label={`Split ${i + 1} class`}>
                {ASSET_CLASSES.map((c) => (
                  <option key={c} value={c}>
                    {assetClassLabel(c)}
                  </option>
                ))}
              </select>
              <input inputMode="decimal" value={row.percent} placeholder="0" onChange={(e) => editRow(i, { percent: e.target.value })} aria-label={`Split ${i + 1} percent`} className="inv-split-pct" />
              <span className="muted">%</span>
              <button type="button" className="link small danger" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                remove
              </button>
            </div>
          ))}
          {rows.length < ASSET_CLASSES.length && (
            <button type="button" className="link small" onClick={addRow}>
              + add a class
            </button>
          )}
        </div>
      )}
      {isCash && <span className="muted small">Cash securities are never split.</span>}
      <div className="row wrap">
        <button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
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
