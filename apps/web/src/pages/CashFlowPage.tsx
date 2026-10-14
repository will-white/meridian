import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { dayDiff } from "@meridian/shared";
import type { CashFlowProjectionResponse } from "@meridian/shared";
import { api } from "../lib/api.js";
import { money, shortDate } from "../lib/format.js";
import { localToday } from "../lib/plan.js";
import { Badge, Card, ErrorText } from "../components/ui.js";
import { EChart, useChartTheme } from "../components/charts/EChart.js";
import { cashFlowChartOption, seriesColor, type CashFlowChartSeries } from "../components/charts/chartOptions.js";
import { EventsTable } from "../components/cashflow/EventsTable.js";
import { WhatIfDrawer } from "../components/cashflow/WhatIfDrawer.js";
import {
  addMove,
  HORIZONS,
  horizonDays,
  isHorizonChoice,
  projectionBody,
  recurringNamesFromEvents,
  removeAt,
  toggleSkip,
  type CashFlowEvent,
  type HorizonChoice,
  type MoveScope,
  type WhatIf,
} from "../components/cashflow/whatIfs.js";
import "./CashFlowPage.css";

const COMBINED = "__combined__";

/**
 * Cash-flow projection: every on-budget account rolled forward from today.
 * The horizon lives in the URL (?horizon=30|90|180|12m; absent = the
 * household default), what-ifs in React state only. Every change re-POSTs
 * /cashflow/projection; the server writes nothing.
 */
export function CashFlowPage() {
  const today = useMemo(() => localToday(), []);
  const [searchParams, setSearchParams] = useSearchParams();
  const horizonParam = searchParams.get("horizon");
  const horizon: HorizonChoice | null = isHorizonChoice(horizonParam) ? horizonParam : null;
  const [whatIfs, setWhatIfs] = useState<WhatIf[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const theme = useChartTheme();

  const body = useMemo(
    () => projectionBody({ today, ...(horizon === null ? {} : { horizonDays: horizonDays(horizon, today) }), whatIfs }),
    [today, horizon, whatIfs],
  );
  const projection = useQuery({
    queryKey: ["cashflow", body],
    queryFn: () => api<CashFlowProjectionResponse>("/cashflow/projection", { method: "POST", body }),
    placeholderData: keepPreviousData,
  });
  const p = projection.data;

  const selectHorizon = (choice: HorizonChoice) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("horizon", choice);
        return next;
      },
      { replace: true },
    );
  const activeHorizon: HorizonChoice | null = horizon ?? (p ? (HORIZONS.find(([c]) => horizonDays(c, p.today) === dayDiff(p.today, p.endDate))?.[0] ?? null) : null);

  const accountNames = useMemo(() => new Map((p?.accounts ?? []).map((a) => [a.accountId, a.name])), [p?.accounts]);
  const recurringNames = useMemo(() => recurringNamesFromEvents(p?.events ?? []), [p?.events]);
  const names = useMemo(
    () => ({ recurring: (id: string) => recurringNames.get(id) ?? "recurring item", account: (id: string) => accountNames.get(id) ?? "account" }),
    [recurringNames, accountNames],
  );

  const option = useMemo(() => {
    if (!p) return null;
    const series: CashFlowChartSeries[] = [];
    if (!hidden.has(COMBINED)) {
      series.push({
        key: COMBINED,
        name: "All accounts",
        points: p.combined.points,
        thresholdCents: p.combined.thresholdCents,
        minDate: p.combined.minDate,
        minCents: p.combined.minCents,
        firstBelowThresholdDate: p.combined.firstBelowThresholdDate,
        bold: true,
      });
    }
    p.accounts.forEach((a, i) => {
      if (hidden.has(a.accountId)) return;
      series.push({
        key: a.accountId,
        name: a.name,
        points: a.points,
        thresholdCents: a.thresholdCents,
        minDate: a.minDate,
        minCents: a.minCents,
        firstBelowThresholdDate: a.firstBelowThresholdDate,
        color: seriesColor(i, theme),
      });
    });
    return cashFlowChartOption({ dates: p.dates, series, theme });
  }, [p, hidden, theme]);

  const toggleHidden = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const onToggleSkip = (ev: CashFlowEvent) => {
    setWhatIfs((w) => toggleSkip(w, ev));
    setDrawerOpen(true);
  };
  const onMove = (ev: CashFlowEvent, shiftDays: number, scope: MoveScope) => {
    setWhatIfs((w) => addMove(w, ev, shiftDays, scope));
    setDrawerOpen(true);
  };
  const onRemoveOneTime = (ev: CashFlowEvent) =>
    setWhatIfs((w) => {
      const date = ev.originalDate ?? ev.date;
      const i = w.findIndex((x) => x.kind === "oneTime" && x.date === date && x.accountId === ev.accountId && x.amountCents === ev.amountCents);
      return i >= 0 ? removeAt(w, i) : w;
    });

  const endCents = p?.combined.points[p.combined.points.length - 1];
  const combinedBelow = p ? p.combined.thresholdCents !== null && BigInt(p.combined.minCents) < BigInt(p.combined.thresholdCents) : false;

  return (
    <>
      <div className="cf-toolbar">
        <h1>Cash flow</h1>
        <div className="row wrap">
          <div className="seg" role="group" aria-label="Horizon">
            {HORIZONS.map(([choice, label]) => (
              <button key={choice} type="button" aria-pressed={activeHorizon === choice} onClick={() => selectHorizon(choice)}>
                {label}
              </button>
            ))}
          </div>
          <button className="secondary" onClick={() => setDrawerOpen((v) => !v)} aria-pressed={drawerOpen}>
            What-ifs{whatIfs.length > 0 ? ` (${whatIfs.length})` : ""}
          </button>
        </div>
      </div>
      <ErrorText error={projection.error} />
      {!p && projection.isLoading && <p className="muted">Projecting…</p>}
      {p && (
        <div className={`cf-layout ${drawerOpen ? "" : "closed"}`}>
          <div className="cf-main">
            <Card
              title={`${shortDate(p.today)} to ${shortDate(p.endDate)}`}
              actions={<span className="muted small">{projection.isFetching ? "updating…" : `${p.dates.length} days`}</span>}
            >
              <div className="dash-stats cf-stats">
                <div className="dash-stat">
                  <span className="k">Opening</span>
                  <span className="v">{money(p.combined.openingCents)}</span>
                </div>
                <div className="dash-stat">
                  <span className="k">Lowest</span>
                  <span className={`v ${combinedBelow ? "tone-bad" : ""}`}>
                    {money(p.combined.minCents)} <span className="muted small">on {shortDate(p.combined.minDate)}</span>
                  </span>
                </div>
                <div className="dash-stat">
                  <span className="k">Below threshold</span>
                  <span className={`v ${p.combined.firstBelowThresholdDate ? "tone-bad" : ""}`}>
                    {p.combined.alreadyBelow ? "already" : p.combined.firstBelowThresholdDate ? `from ${shortDate(p.combined.firstBelowThresholdDate)}` : "never"}
                    {p.combined.thresholdCents !== null && <span className="muted small"> (line at {money(p.combined.thresholdCents)})</span>}
                  </span>
                </div>
                <div className="dash-stat">
                  <span className="k">End of horizon</span>
                  <span className="v">{money(endCents)}</span>
                </div>
              </div>
              {p.warnings.length > 0 && (
                <ul className="dash-warnings">
                  {p.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              <div className="cf-legend" role="group" aria-label="Series">
                <label className="inline">
                  <input type="checkbox" checked={!hidden.has(COMBINED)} onChange={() => toggleHidden(COMBINED)} />
                  <span className="cf-swatch bold" style={{ background: theme.ink }} /> All accounts
                </label>
                {p.accounts.map((a, i) => (
                  <label className="inline" key={a.accountId}>
                    <input type="checkbox" checked={!hidden.has(a.accountId)} onChange={() => toggleHidden(a.accountId)} />
                    <span className="cf-swatch" style={{ background: seriesColor(i, theme) }} /> {a.name}
                    {a.firstBelowThresholdDate && <Badge tone="bad">low {shortDate(a.firstBelowThresholdDate)}</Badge>}
                  </label>
                ))}
              </div>
              {option && <EChart option={option} height={320} label={`Projected balances by account from ${shortDate(p.today)} to ${shortDate(p.endDate)}`} />}
            </Card>
            <Card title="Upcoming events">
              <div className="scroll">
                <EventsTable events={p.events} whatIfs={whatIfs} onToggleSkip={onToggleSkip} onMove={onMove} onRemoveOneTime={onRemoveOneTime} />
              </div>
            </Card>
          </div>
          {drawerOpen && (
            <aside className="cf-drawer">
              <WhatIfDrawer
                whatIfs={whatIfs}
                outcomes={projection.isFetching ? undefined : p.whatIfs}
                names={names}
                accounts={p.accounts.map((a) => ({ id: a.accountId, name: a.name }))}
                today={p.today}
                onRemove={(i) => setWhatIfs((w) => removeAt(w, i))}
                onClear={() => setWhatIfs([])}
                onAdd={(w) => setWhatIfs((list) => [...list, w])}
                onClose={() => setDrawerOpen(false)}
              />
            </aside>
          )}
        </div>
      )}
    </>
  );
}
