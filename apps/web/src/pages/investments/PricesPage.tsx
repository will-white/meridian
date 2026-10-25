import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { HouseholdSettingView, PricesStatusResponse, RefreshPricesResponse } from "@meridian/shared";
import { api } from "../../lib/api.js";
import { shortDate } from "../../lib/format.js";
import { localToday } from "../../lib/plan.js";
import { countsLine, lastRunText, NOT_CONFIGURED_TEXT, refreshResultText, scheduleText } from "../../lib/reconcileView.js";
import { Badge, Card, Empty, ErrorText } from "../../components/ui.js";
import { invalidatePrices } from "../../components/investments/PriceHistoryDrawer.js";
import { PriceStatusTable } from "../../components/investments/PriceStatusTable.js";
import { INVESTMENTS_STALE_MS, useIsViewer } from "../../components/investments/queries.js";
import "./investments.css";
import "./PricesPage.css";

/**
 * Prices (plan decision 10; prices design §5): the feed's state from
 * GET /prices/status (provider, expected close, last run, schedule, counts),
 * the owner's Refresh prices (POST /prices/refresh, every refresh goes through
 * `requestPriceRefresh`), and the per-security table with pricing mode,
 * provider symbol, latest close, status chip, fetch state, retry, history
 * and manual prices (PUT/DELETE /prices/:securityId/:date). The page polls
 * while a fetch job is queued or running.
 */
export function PricesPage() {
  const today = useMemo(() => localToday(), []);
  const viewer = useIsViewer();
  const qc = useQueryClient();
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ["prices", "status"],
    queryFn: () => api<PricesStatusResponse>("/prices/status"),
    staleTime: INVESTMENTS_STALE_MS,
    refetchInterval: (q) => (q.state.data?.activeJob ? 10_000 : false),
  });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<HouseholdSettingView>("/settings"), staleTime: INVESTMENTS_STALE_MS });
  const s = status.data;

  const refresh = useMutation({
    mutationFn: (securityIds?: string[]) => api<RefreshPricesResponse>("/prices/refresh", { method: "POST", body: securityIds ? { securityIds } : {} }),
    onSuccess: (r, securityIds) => {
      setRefreshNote(`${securityIds ? "Retry" : "Refresh"} ${refreshResultText(r)}`);
      setRetryingId(null);
      void qc.invalidateQueries({ queryKey: ["prices", "status"] });
    },
    onError: () => setRetryingId(null),
  });
  const retry = (id: string) => {
    setRetryingId(id);
    refresh.mutate([id]);
  };
  const rebuild = useMutation({
    mutationFn: () => api<{ written: number }>("/prices/rebuild-implied", { method: "POST", body: {} }),
    onSuccess: (r) => {
      setRefreshNote(`Implied prices rebuilt: ${r.written} written`);
      invalidatePrices(qc);
    },
  });

  const lastRun = s ? lastRunText(s.lastRun, s.timezone) : null;

  return (
    <>
      <div className="inv-toolbar">
        <h2>Prices</h2>
        {s && !viewer && (
          <div className="row wrap">
            <button type="button" disabled={!s.configured || s.activeJob !== null || refresh.isPending} onClick={() => refresh.mutate(undefined)} title={s.configured ? "Queue a manual fetch for the held securities" : "No price provider is configured"}>
              {refresh.isPending && retryingId === null ? "Queuing…" : s.activeJob ? `Fetch ${s.activeJob.status}…` : "Refresh prices"}
            </button>
            <button type="button" className="secondary" disabled={rebuild.isPending} onClick={() => rebuild.mutate()} title="Write an implied price for every valued position lacking a provider or manual price">
              {rebuild.isPending ? "Rebuilding…" : "Rebuild implied"}
            </button>
            {refreshNote && <span className="notice small">{refreshNote}</span>}
          </div>
        )}
      </div>
      <ErrorText error={status.error} />
      <ErrorText error={refresh.error} />
      <ErrorText error={rebuild.error} />
      {!s && status.isLoading && <p className="muted">Loading…</p>}
      {s && (
        <>
          {!s.configured && <p className="prices-banner">{NOT_CONFIGURED_TEXT}</p>}
          <Card title="Price feed" actions={<span className="muted small">{status.isFetching ? "updating…" : countsLine(s.counts)}</span>}>
            <div className="inv-stats">
              <div className="inv-stat">
                <span className="k">Provider</span>
                <span className="v">
                  {s.provider ?? "none"} <Badge tone={s.configured ? "ok" : "neutral"}>{s.configured ? "configured" : "not configured"}</Badge>
                </span>
                <span className="sub">{s.configured ? scheduleText(s.fetchHourLocal, s.catchupHourLocal, s.timezone) : "values use statement, implied and manual prices"}</span>
              </div>
              <div className="inv-stat">
                <span className="k">Expected close</span>
                <span className="v">{shortDate(s.expectedDate)}</span>
                <span className="sub">the latest trading day whose close the feed can have (America/New_York)</span>
              </div>
              <div className="inv-stat">
                <span className="k">Last run</span>
                <span className={`v ${s.lastRun?.status === "error" ? "tone-bad" : ""}`}>{lastRun ?? "never"}</span>
                <span className="sub">
                  {s.activeJob ? `a ${s.activeJob.reason} fetch is ${s.activeJob.status} (run at ${shortDate(s.activeJob.runAt.slice(0, 10))})` : s.lastRun?.finishedAt ? `finished ${shortDate(s.lastRun.finishedAt.slice(0, 10))}` : ""}
                </span>
              </div>
            </div>
            {s.counts.stale + s.counts.notFound + s.counts.error > 0 && (
              <p className="muted small">
                {s.counts.stale > 0 ? `${s.counts.stale} securit${s.counts.stale === 1 ? "y is" : "ies are"} behind the expected close` : ""}
                {s.counts.stale > 0 && s.counts.notFound + s.counts.error > 0 ? "; " : ""}
                {s.counts.notFound + s.counts.error > 0 ? `${s.counts.notFound + s.counts.error} could not be fetched (see the fetch column; fix the symbol or switch the pricing mode)` : ""}.
              </p>
            )}
          </Card>

          <Card title="Securities">
            {s.securities.length === 0 ? (
              <Empty>
                No securities yet. <Link to="/import">Import positions or trades</Link>.
              </Empty>
            ) : (
              <PriceStatusTable rows={s.securities} benchmarkSecurityId={settings.data?.benchmarkSecurityId ?? null} viewer={viewer} configured={s.configured} today={today} onRetry={retry} retryingId={retryingId} />
            )}
            <p className="muted small">
              Precedence: a manual close outranks the provider's, which outranks an implied one (a position's value ÷ its quantity). Staleness counts trading days against the expected close and applies to provider-mode securities only;
              cash is fixed at 1 and never priced.
            </p>
          </Card>
        </>
      )}
    </>
  );
}
