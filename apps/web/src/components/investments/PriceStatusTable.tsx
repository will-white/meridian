import { Fragment, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PriceSource, SecurityPriceStatusView, SecurityView } from "@meridian/shared";
import { api } from "../../lib/api.js";
import { shortDate } from "../../lib/format.js";
import { formatQuantity } from "../../lib/investments.js";
import { fetchStatusLabel, fetchStatusTone, priceModeLabel, sortPriceRows } from "../../lib/reconcileView.js";
import { Badge, ErrorText } from "../ui.js";
import { invalidatePrices, PriceHistoryDrawer } from "./PriceHistoryDrawer.js";
import { PriceStatusChip } from "./PriceStatusChip.js";

const MODES: readonly PriceSource[] = ["provider", "implied", "manual"];

/**
 * The Prices page's table (prices design §5), sorted by status severity then
 * ticker: the security with its held / always-priced / benchmark markers,
 * the pricing mode (owner select → PATCH /investments/securities/:id, the one
 * route for pricing fields), the provider symbol (owner, inline), the latest
 * close with its date and the status chip, the fetch state with its message,
 * and the actions: retry (a refresh for that id) and the history drawer with
 * the manual price form.
 */
export function PriceStatusTable({
  rows,
  benchmarkSecurityId,
  viewer,
  configured,
  today,
  onRetry,
  retryingId,
}: {
  rows: readonly SecurityPriceStatusView[];
  benchmarkSecurityId: string | null;
  viewer: boolean;
  configured: boolean;
  today: string;
  onRetry: (securityId: string) => void;
  retryingId: string | null;
}) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [symbolDraft, setSymbolDraft] = useState<{ id: string; value: string } | null>(null);
  const sorted = sortPriceRows(rows);

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { priceMode?: PriceSource; providerSymbol?: string | null } }) => api<SecurityView>(`/investments/securities/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      setSymbolDraft(null);
      invalidatePrices(qc);
    },
  });
  const saveSymbol = (row: SecurityPriceStatusView) => {
    if (symbolDraft === null || symbolDraft.id !== row.securityId) return;
    const value = symbolDraft.value.trim();
    if (value === (row.providerSymbol ?? "")) return setSymbolDraft(null);
    patch.mutate({ id: row.securityId, body: { providerSymbol: value === "" ? null : value } });
  };

  return (
    <>
      <ErrorText error={patch.error} />
      <div className="scroll">
        <table className="table inv-table prices-table">
          <thead>
            <tr>
              <th>Security</th>
              <th>Pricing</th>
              <th>Symbol</th>
              <th className="num">Latest close</th>
              <th>Status</th>
              <th>Fetch</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const open = expanded === r.securityId;
              const isCash = r.priceStatus === "cash";
              const editingSymbol = symbolDraft?.id === r.securityId;
              return (
                <Fragment key={r.securityId}>
                  <tr>
                    <td className="name">
                      <button type="button" className="inv-expand" aria-expanded={open} onClick={() => setExpanded(open ? null : r.securityId)}>
                        {r.ticker ? <strong>{r.ticker}</strong> : r.name}
                      </button>
                      {r.ticker && <span className="muted small hide-narrow"> {r.name}</span>}
                      {r.held && <Badge tone="neutral">held</Badge>}
                      {r.alwaysPrice && <Badge tone="info">always priced</Badge>}
                      {benchmarkSecurityId === r.securityId && <Badge tone="info">benchmark</Badge>}
                    </td>
                    <td>
                      {isCash ? (
                        <span className="muted">fixed at 1</span>
                      ) : viewer ? (
                        priceModeLabel(r.priceMode)
                      ) : (
                        <select
                          value={r.priceMode}
                          aria-label={`Pricing of ${r.ticker ?? r.name}`}
                          disabled={patch.isPending}
                          onChange={(e) => patch.mutate({ id: r.securityId, body: { priceMode: e.target.value as PriceSource } })}
                        >
                          {MODES.map((m) => (
                            <option key={m} value={m} disabled={m === "provider" && r.ticker === null && r.providerSymbol === null}>
                              {priceModeLabel(m)}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>
                      {isCash ? (
                        <span className="muted">—</span>
                      ) : viewer || r.priceMode !== "provider" ? (
                        <span className={r.providerSymbol ? "" : "muted"}>{r.providerSymbol ?? r.ticker ?? "—"}</span>
                      ) : editingSymbol ? (
                        <input
                          className="prices-symbol"
                          value={symbolDraft.value}
                          autoFocus
                          aria-label={`Provider symbol of ${r.ticker ?? r.name}`}
                          onChange={(e) => setSymbolDraft({ id: r.securityId, value: e.target.value })}
                          onBlur={() => saveSymbol(r)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveSymbol(r);
                            if (e.key === "Escape") setSymbolDraft(null);
                          }}
                        />
                      ) : (
                        <button type="button" className="link small" title="Edit the provider symbol" onClick={() => setSymbolDraft({ id: r.securityId, value: r.providerSymbol ?? "" })}>
                          {r.providerSymbol ?? (r.ticker ? `${r.ticker} (ticker)` : "set symbol")}
                        </button>
                      )}
                    </td>
                    <td className="num">
                      {r.latestClose === null ? <span className="muted">—</span> : formatQuantity(r.latestClose, 4)}
                      {r.latestPriceDate && <div className="muted small">{shortDate(r.latestPriceDate)}</div>}
                    </td>
                    <td>
                      <PriceStatusChip priceStatus={r.priceStatus} priceDate={r.latestPriceDate} tradingDaysBehind={r.tradingDaysBehind} priceSource={r.latestSource} />
                    </td>
                    <td>
                      {r.priceMode === "provider" && !isCash ? (
                        <>
                          <span title={r.fetchMessage ?? ""}>
                            <Badge tone={fetchStatusTone(r.fetchStatus)}>{fetchStatusLabel(r.fetchStatus)}</Badge>
                          </span>
                          {r.fetchMessage && r.fetchStatus !== "ok" && <div className="muted small prices-msg">{r.fetchMessage}</div>}
                          {r.failures > 0 && (
                            <div className="muted small">
                              {r.failures} failure{r.failures === 1 ? "" : "s"}
                              {r.nextAttemptAt ? `, next try ${shortDate(r.nextAttemptAt.slice(0, 10))}` : ""}
                            </div>
                          )}
                          {r.backfilledFrom && <div className="muted small">backfilled from {shortDate(r.backfilledFrom)}</div>}
                        </>
                      ) : (
                        <span className="muted small">{isCash ? "never fetched" : "not fetched in this mode"}</span>
                      )}
                    </td>
                    <td className="actions">
                      {!viewer && configured && r.priceMode === "provider" && !isCash && (
                        <button type="button" className="link small" disabled={retryingId === r.securityId} onClick={() => onRetry(r.securityId)}>
                          {retryingId === r.securityId ? "queued…" : "retry"}
                        </button>
                      )}
                      {!isCash && (
                        <button type="button" className="link small" onClick={() => setExpanded(open ? null : r.securityId)}>
                          {open ? "hide" : viewer ? "history" : "history / set a price"}
                        </button>
                      )}
                    </td>
                  </tr>
                  {open && (
                    <tr className="inv-detail">
                      <td colSpan={7}>
                        <PriceHistoryDrawer securityId={r.securityId} label={r.ticker ?? r.name} viewer={viewer} today={today} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
