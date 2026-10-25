import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isIsoDate } from "@meridian/shared";
import type { PriceHistoryResponse, PriceView } from "@meridian/shared";
import { api, query } from "../../lib/api.js";
import { shortDate } from "../../lib/format.js";
import { formatQuantity } from "../../lib/investments.js";
import { parsePriceInput, priceHistoryPoints } from "../../lib/reconcileView.js";
import { EChart, useChartTheme, type ChartTheme, type EChartOption } from "../charts/EChart.js";
import { axisDate } from "../charts/chartOptions.js";
import { Badge, ErrorText } from "../ui.js";
import { PriceStatusChip } from "./PriceStatusChip.js";
import { invalidateInvestments } from "./queries.js";

const RECENT = 15;

/** Keys a price or pricing change moves: the price status, the security master, every valued view, the accounts and the dashboard: the one editor list. */
export function invalidatePrices(qc: ReturnType<typeof useQueryClient>): void {
  invalidateInvestments(qc);
}

/** The close line with suspect points marked (prices design §5); pure. */
export function priceHistoryOption(items: readonly PriceView[], theme: ChartTheme): EChartOption {
  const p = priceHistoryPoints(items);
  const suspects = p.dates.flatMap((d, i) => (p.suspect[i] ? [{ name: "suspect", coord: [d, p.closes[i]!] as [string, number], value: "suspect" }] : []));
  return {
    animation: false,
    textStyle: { color: theme.ink },
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      backgroundColor: theme.panel,
      borderColor: theme.line,
      textStyle: { color: theme.ink },
      formatter: (params: unknown): string => {
        const first = (Array.isArray(params) ? params[0] : params) as { dataIndex?: number } | undefined;
        const i = first?.dataIndex;
        if (i === undefined) return "";
        const item = [...items].sort((a, b) => (a.date < b.date ? -1 : 1))[i];
        if (!item) return "";
        return `${shortDate(item.date)}<br/>close <strong>${formatQuantity(item.close, 4)}</strong> · ${item.source}${item.suspect ? " · suspect" : ""}`;
      },
    },
    xAxis: { type: "category", data: p.dates, boundaryGap: false, axisLine: { lineStyle: { color: theme.line } }, axisTick: { show: false }, axisLabel: { color: theme.muted, formatter: (v: string) => axisDate(v), hideOverlap: true } },
    yAxis: { type: "value", scale: true, axisLabel: { color: theme.muted }, splitLine: { lineStyle: { color: theme.line } } },
    series: [
      {
        name: "close",
        type: "line",
        data: p.closes,
        showSymbol: p.dates.length <= 60,
        symbolSize: 5,
        lineStyle: { width: 2, color: theme.accent },
        itemStyle: { color: theme.accent },
        ...(suspects.length === 0 ? {} : { markPoint: { symbol: "pin", symbolSize: 28, itemStyle: { color: theme.warn }, label: { show: false }, data: suspects } }),
      },
    ],
  };
}

/**
 * A security's price history (GET /prices/:id): the close line with suspect
 * points marked, the owner's manual price form (PUT /prices/:id/:date, the
 * only place a price is set by hand), and the most recent rows with their
 * source; manual rows carry a delete action (DELETE /prices/:id/:date, manual
 * rows only).
 */
export function PriceHistoryDrawer({ securityId, label, viewer, today }: { securityId: string; label: string; viewer: boolean; today: string }) {
  const qc = useQueryClient();
  const theme = useChartTheme();
  const history = useQuery({
    queryKey: ["prices", "history", securityId],
    queryFn: () => api<PriceHistoryResponse>(`/prices/${securityId}${query({ limit: 400, today })}`),
    staleTime: 30_000,
  });
  const h = history.data;
  const option = useMemo(() => (h && h.items.length > 0 ? priceHistoryOption(h.items, theme) : null), [h, theme]);

  const [date, setDate] = useState(today);
  const [close, setClose] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const setPrice = useMutation({
    mutationFn: ({ d, c }: { d: string; c: string }) => api<PriceView>(`/prices/${securityId}/${d}`, { method: "PUT", body: { close: c, today } }),
    onSuccess: () => {
      setClose("");
      invalidatePrices(qc);
    },
  });
  const remove = useMutation({
    mutationFn: (d: string) => api<{ ok: true }>(`/prices/${securityId}/${d}`, { method: "DELETE" }),
    onSuccess: () => invalidatePrices(qc),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!isIsoDate(date) || date > today) return setFormError("The date must be on or before today");
    const c = parsePriceInput(close);
    if (c === null) return setFormError("Enter the close as a non-negative number");
    setFormError(null);
    setPrice.mutate({ d: date, c });
  };

  return (
    <div className="prices-drawer">
      <ErrorText error={history.error} />
      {history.isLoading && <p className="muted small">Loading the history…</p>}
      {h && (
        <>
          <div className="row wrap prices-drawer-head">
            <span>
              {label}: {h.items.length} close{h.items.length === 1 ? "" : "s"} on file
            </span>
            <PriceStatusChip priceStatus={h.priceStatus} priceDate={h.latest?.date ?? null} tradingDaysBehind={h.tradingDaysBehind} priceSource={h.latest?.source ?? null} />
            <span className="muted small">expected close {shortDate(h.expectedDate)}</span>
          </div>
          {option ? <EChart option={option} height={200} label={`${label} closes`} /> : <p className="muted small">No prices yet.</p>}
          {h.items.some((i) => i.suspect) && <p className="muted small">Pins mark suspect closes (a jump the provider's own series does not explain); they are kept but flagged.</p>}
        </>
      )}

      {!viewer && (
        <form className="row wrap prices-manual" onSubmit={submit} aria-label={`Set a manual price for ${label}`}>
          <label>
            Date
            <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            Close
            <input inputMode="decimal" value={close} placeholder="0.00" onChange={(e) => setClose(e.target.value)} />
          </label>
          <button type="submit" className="secondary" disabled={setPrice.isPending || close.trim() === ""}>
            {setPrice.isPending ? "Saving…" : "Set price"}
          </button>
          <span className="muted small">A manual close outranks the provider's and the implied price for that day.</span>
          {formError && <ErrorText error={new Error(formError)} />}
          <ErrorText error={setPrice.error} />
        </form>
      )}

      {h && h.items.length > 0 && (
        <table className="table small inv-table prices-recent">
          <thead>
            <tr>
              <th>Date</th>
              <th className="num">Close</th>
              <th className="num">Adj. close</th>
              <th>Source</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {h.items.slice(0, RECENT).map((i) => (
              <tr key={i.date}>
                <td>{shortDate(i.date)}</td>
                <td className="num">{formatQuantity(i.close, 4)}</td>
                <td className="num muted">{i.adjClose === null ? "—" : formatQuantity(i.adjClose, 4)}</td>
                <td>
                  <Badge tone={i.source === "manual" ? "info" : i.source === "implied" ? "neutral" : "ok"}>{i.source}</Badge>
                  {i.suspect && <Badge tone="warn">suspect</Badge>}
                </td>
                <td className="actions">
                  {!viewer && i.source === "manual" && (
                    <button type="button" className="link small danger" disabled={remove.isPending} onClick={() => remove.mutate(i.date)} aria-label={`Delete the manual price of ${shortDate(i.date)}`}>
                      delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {h && h.items.length > RECENT && <p className="muted small">Showing the latest {RECENT} of {h.items.length}; the chart has them all.</p>}
      <ErrorText error={remove.error} />
    </div>
  );
}
