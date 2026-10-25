import { Fragment, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import type { AccountValuationView, PortfolioAccountView, PortfolioView, ValuationSeriesResponse, ValuationSummaryResponse } from "@meridian/shared";
import { api, query } from "../../lib/api.js";
import { money, shortDate } from "../../lib/format.js";
import { localToday } from "../../lib/plan.js";
import {
  asOfFromParams,
  asOfLine,
  autoSeriesStep,
  changeSentence,
  changeTone,
  changeWindows,
  chartRange,
  dayChangeReasonText,
  dayChangeSentence,
  formatBp,
  formatQuantity,
  growthReasonText,
  lineKindLabel,
  periodFromParams,
  periodQuery,
  signedMoney,
  valuationDescription,
  type SeriesStep,
} from "../../lib/investments.js";
import { Badge, Card, Empty, ErrorText } from "../../components/ui.js";
import { EChart, useChartTheme } from "../../components/charts/EChart.js";
import { seriesColor } from "../../components/charts/chartOptions.js";
import { valueOverTimeOption, type ValueSeries } from "../../components/charts/investmentOptions.js";
import { AccountWarnings } from "../../components/investments/AccountWarnings.js";
import { ChangePanel } from "../../components/investments/ChangePanel.js";
import { FidelityBadge } from "../../components/investments/FidelityBadge.js";
import { AsOfPicker, PeriodPicker } from "../../components/investments/Pickers.js";
import { PriceStatusChip } from "../../components/investments/PriceStatusChip.js";
import { INVESTMENTS_STALE_MS } from "../../components/investments/queries.js";
import "./investments.css";
import "./PortfolioPage.css";

const TOTAL = "__total__";
const STEP_CHOICES: ReadonlyArray<readonly [SeriesStep | "auto", string]> = [
  ["auto", "Auto"],
  ["day", "Daily"],
  ["week", "Weekly"],
  ["month", "Monthly"],
];
const FEED_LABELS = { off: "feed off", link: "feed: link", create: "feed: create" } as const;

/**
 * Portfolio: every open investment account valued by the one valuation chain
 * on the as-of date (plan decision 8), the day and period change, the value
 * over time and an accounts table with a per-account detail (the chain's
 * lines with their price status) and a "why?" panel (the change attributed
 * per holding, `ChangePanel`). Period and as-of live in the URL
 * (`?period=`, `?from=&to=`, `?asOf=`). Reads: GET /investments/portfolio,
 * GET /valuation/summary (the lines), GET /valuation/series (the chart) and
 * GET /investments/accounts/:id/changes (the panel).
 */
export function PortfolioPage() {
  const today = useMemo(() => localToday(), []);
  const [searchParams] = useSearchParams();
  const period = useMemo(() => periodFromParams(searchParams, today, "1y"), [searchParams, today]);
  const asOf = asOfFromParams(searchParams, today);
  const theme = useChartTheme();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const [stepChoice, setStepChoice] = useState<SeriesStep | "auto">("auto");

  const portfolioParams = useMemo(() => ({ ...periodQuery(period), ...(asOf ? { asOf } : {}), today }), [period, asOf, today]);
  const portfolio = useQuery({
    queryKey: ["investments", "portfolio", portfolioParams],
    queryFn: () => api<PortfolioView>(`/investments/portfolio${query(portfolioParams)}`),
    staleTime: INVESTMENTS_STALE_MS,
    placeholderData: keepPreviousData,
  });
  const p = portfolio.data;

  const summaryParams = p?.asOf ? { asOf: p.asOf, today } : null;
  const summary = useQuery({
    queryKey: ["valuation", "summary", summaryParams],
    queryFn: () => api<ValuationSummaryResponse>(`/valuation/summary${query(summaryParams!)}`),
    enabled: summaryParams !== null,
    staleTime: INVESTMENTS_STALE_MS,
    placeholderData: keepPreviousData,
  });

  const range = p?.asOf ? chartRange(p.asOf, p.period) : null;
  const step: SeriesStep = range ? (stepChoice === "auto" ? autoSeriesStep(range.from, range.to) : stepChoice) : "day";
  const seriesParams = range ? { from: range.from, to: range.to, step, today } : null;
  const series = useQuery({
    queryKey: ["valuation", "series", seriesParams],
    queryFn: () => api<ValuationSeriesResponse>(`/valuation/series${query(seriesParams!)}`),
    enabled: seriesParams !== null,
    staleTime: INVESTMENTS_STALE_MS,
    placeholderData: keepPreviousData,
  });
  const s = series.data;

  const accountIndex = useMemo(() => new Map((p?.accounts ?? []).map((a, i) => [a.accountId, i])), [p?.accounts]);
  const accountNames = useMemo(() => new Map((p?.accounts ?? []).map((a) => [a.accountId, a.accountName])), [p?.accounts]);
  const option = useMemo(() => {
    if (!s) return null;
    const list: ValueSeries[] = [];
    if (!hidden.has(TOTAL)) list.push({ key: TOTAL, name: "Portfolio", points: s.portfolio.map((pt) => pt.valueCents), bold: true });
    for (const a of s.accounts) {
      if (hidden.has(a.accountId)) continue;
      list.push({ key: a.accountId, name: a.name, points: a.values, color: seriesColor(accountIndex.get(a.accountId) ?? 0, theme) });
    }
    return valueOverTimeOption({ dates: s.dates, series: list, theme });
  }, [s, hidden, theme, accountIndex]);
  const anyPartial = s?.portfolio.some((pt) => pt.partial) ?? false;

  const toggleHidden = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const valuationByAccount = useMemo(() => new Map((summary.data?.accounts ?? []).map((a) => [a.accountId, a])), [summary.data]);
  const accountWarnings = useMemo(() => (p?.accounts ?? []).flatMap((a) => a.warnings), [p?.accounts]);

  return (
    <>
      <div className="inv-toolbar">
        <h2>Portfolio</h2>
        <div className="row wrap">
          <PeriodPicker value={period} today={today} />
          <AsOfPicker value={asOf} today={today} />
        </div>
      </div>
      <ErrorText error={portfolio.error} />
      {!p && portfolio.isLoading && <p className="muted">Loading…</p>}
      {p && p.accounts.length === 0 && (
        <Card>
          <Empty>
            No investment accounts yet. Set an account's type to brokerage, 401k, IRA, Roth, HSA or 529 on the <Link to="/accounts">Accounts page</Link>, or{" "}
            <Link to="/connections">connect one</Link>.
          </Empty>
        </Card>
      )}
      {p && p.accounts.length > 0 && p.asOf === null && (
        <Card>
          <Empty>No values yet: SimpleFIN balances arrive with the next sync, prices after market close; or import positions.</Empty>
          <AccountsTable portfolio={p} accounts={p.accounts} valuations={valuationByAccount} expanded={expanded} onExpand={setExpanded} why={why} onWhy={setWhy} today={today} />
        </Card>
      )}
      {p && p.asOf !== null && (
        <>
          <Card title={`Value as of ${shortDate(p.asOf)}`} actions={<span className="muted small">{portfolio.isFetching ? "updating…" : p.period ? `${shortDate(p.period.from)} to ${shortDate(p.period.to)}` : ""}</span>}>
            <div className="inv-stats">
              <div className="inv-stat">
                <span className="k">Total value</span>
                <span className="v hero">{money(p.totalCents)}</span>
                <span className="sub">
                  as of {shortDate(p.asOf)} · {asOfLine(p.accounts)}
                </span>
              </div>
              <div className="inv-stat">
                <span className="k">Day change</span>
                <span className={`v ${changeTone(p.dayChange.cents)}`}>{dayChangeSentence(p.dayChange)}</span>
                {p.dayChange.partial && p.dayChange.excluded.length > 0 && (
                  <span className="sub">
                    partial: {p.dayChange.excluded.map((e) => `${accountNames.get(e.accountId) ?? "an account"} (${dayChangeReasonText(e.reason)})`).join(", ")} excluded
                  </span>
                )}
              </div>
              <div className="inv-stat">
                <span className="k">Period change{p.period ? ` (${p.period.kind === "custom" ? "custom" : p.period.kind.toUpperCase()})` : ""}</span>
                <span className={`v ${changeTone(p.periodChange?.changeCents ?? null)}`}>{p.periodChange ? changeSentence(p.periodChange) : "—"}</span>
                {p.periodChange?.growthReason && <span className="sub">{growthReasonText(p.periodChange.growthReason)}</span>}
                {p.period?.partial && <span className="sub">{p.period.note ?? "The period starts before the first data"}</span>}
                {p.periodChange !== null && p.periodChange.uncategorizedRows > 0 && (
                  <span className="sub">
                    {p.periodChange.uncategorizedRows} uncategorized row{p.periodChange.uncategorizedRows === 1 ? "" : "s"} in the period may be contributions
                  </span>
                )}
              </div>
            </div>
            <AccountWarnings warnings={p.warnings} accountWarnings={accountWarnings} />
          </Card>

          <Card
            title="Value over time"
            actions={
              <div className="inv-seg" role="group" aria-label="Chart points">
                {STEP_CHOICES.map(([choice, label]) => (
                  <button key={choice} type="button" aria-pressed={stepChoice === choice} onClick={() => setStepChoice(choice)}>
                    {label}
                  </button>
                ))}
              </div>
            }
          >
            <ErrorText error={series.error} />
            {s && (
              <>
                <div className="inv-legend" role="group" aria-label="Series">
                  <label className="inline">
                    <input type="checkbox" checked={!hidden.has(TOTAL)} onChange={() => toggleHidden(TOTAL)} />
                    <span className="inv-swatch bold" style={{ background: theme.ink }} /> Portfolio
                  </label>
                  {s.accounts.map((a) => (
                    <label className="inline" key={a.accountId}>
                      <input type="checkbox" checked={!hidden.has(a.accountId)} onChange={() => toggleHidden(a.accountId)} />
                      <span className="inv-swatch" style={{ background: seriesColor(accountIndex.get(a.accountId) ?? 0, theme) }} /> {a.name}
                      {a.firstDataDate === null && <Badge tone="neutral">no data</Badge>}
                    </label>
                  ))}
                </div>
                {option && <EChart option={option} height={300} label={`Portfolio value from ${shortDate(s.from)} to ${shortDate(s.to)}`} />}
                <p className="muted small inv-chart-note">
                  {step === "week" ? "Weekly points. " : step === "month" ? "Monthly points. " : ""}
                  {anyPartial ? "Partial: on some days not every account had a value; gaps are days without one. " : "Gaps are days without a value."}
                  {series.isFetching ? " updating…" : ""}
                </p>
              </>
            )}
            {!s && series.isLoading && <p className="muted">Loading the series…</p>}
          </Card>

          <Card title="Accounts" actions={<span className="muted small">{fidelitySummary(p.fidelityCounts)}</span>}>
            <ErrorText error={summary.error} />
            <AccountsTable portfolio={p} accounts={p.accounts} valuations={valuationByAccount} expanded={expanded} onExpand={setExpanded} why={why} onWhy={setWhy} today={today} />
          </Card>
        </>
      )}
    </>
  );
}

function fidelitySummary(c: PortfolioView["fidelityCounts"]): string {
  const total = c.balance_only + c.positions + c.full_history;
  const parts: string[] = [];
  if (c.full_history > 0) parts.push(`${c.full_history} full history`);
  if (c.positions > 0) parts.push(`${c.positions} positions`);
  if (c.balance_only > 0) parts.push(`${c.balance_only} balance only`);
  return `${total} account${total === 1 ? "" : "s"}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`;
}

function AccountsTable({
  portfolio,
  accounts,
  valuations,
  expanded,
  onExpand,
  why,
  onWhy,
  today,
}: {
  portfolio: Pick<PortfolioView, "asOf" | "dayChange">;
  accounts: PortfolioAccountView[];
  valuations: Map<string, AccountValuationView>;
  expanded: string | null;
  onExpand: (id: string | null) => void;
  /** The account whose "why?" panel is open. */
  why: string | null;
  onWhy: (id: string | null) => void;
  today: string;
}) {
  return (
    <div className="scroll">
      <table className="table inv-table pf-table">
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Value</th>
            <th>As of</th>
            <th className="num">Day change</th>
            <th>Period</th>
            <th className="num">Cash</th>
            <th>Feed</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => {
            const open = expanded === a.accountId;
            const whyOpen = why === a.accountId;
            const windows = changeWindows(portfolio, a);
            const canWhy = windows.day !== null || windows.period !== null;
            const v = valuations.get(a.accountId);
            return (
              <Fragment key={a.accountId}>
                <tr>
                  <td className="name">
                    <button type="button" className="inv-expand" aria-expanded={open} onClick={() => onExpand(open ? null : a.accountId)}>
                      {a.accountName}
                    </button>
                    <FidelityBadge fidelity={a.fidelity} fidelityNote={a.fidelityNote} positionsDate={a.positionsDate} accountId={a.accountId} />
                    {a.closed && <Badge tone="neutral">closed</Badge>}
                  </td>
                  <td className="num">{money(a.valueCents)}</td>
                  <td>
                    {a.valuationDate ? shortDate(a.valuationDate) : "—"}
                    {a.valuationStale && a.valuationDate && <Badge tone="warn">stale · {shortDate(a.valuationDate)}</Badge>}
                    {a.positionsStale && a.positionsDate && <Badge tone="warn">positions {shortDate(a.positionsDate)}</Badge>}
                    <div className="muted small hide-narrow">{valuationDescription(a)}</div>
                  </td>
                  <td className={`num ${changeTone(a.dayChangeCents)}`}>
                    {signedMoney(a.dayChangeCents)}
                    {a.dayChangeBp !== null && <span className="muted small"> {formatBp(a.dayChangeBp, { places: 2, sign: true })}</span>}
                  </td>
                  <td className="pf-period">
                    {a.period ? (
                      <>
                        <span className={changeTone(a.period.changeCents)}>{signedMoney(a.period.changeCents)}</span>
                        <div className="muted small">{periodDetail(a.period)}</div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="num">
                    {a.cashCents === null && a.residualCents === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <>
                        {money(a.cashCents ?? "0")}
                        {a.residualCents !== null && BigInt(a.residualCents) !== 0n && (
                          <div className="muted small" title="Cash (from balance): the account's balance minus its priced positions, carried forward">
                            + {money(a.residualCents)} unlisted
                          </div>
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    <span className="inv-chip">{FEED_LABELS[a.investmentIncomeFeed]}</span>
                  </td>
                  <td className="actions">
                    <button type="button" className="link small" onClick={() => onExpand(open ? null : a.accountId)}>
                      {open ? "hide" : "details"}
                    </button>
                    <button
                      type="button"
                      className="link small"
                      aria-expanded={whyOpen}
                      disabled={!canWhy}
                      title={canWhy ? "Attribute the change to price, quantity, cash, flows and income" : "No day or period change to explain yet"}
                      onClick={() => onWhy(whyOpen ? null : a.accountId)}
                    >
                      {whyOpen ? "hide why" : "why?"}
                    </button>
                    <Link className="small" to={`/investments/reconcile${query({ accountId: a.accountId, ...(a.positionsDate ? { date: a.positionsDate } : {}) })}`}>
                      reconcile
                    </Link>
                  </td>
                </tr>
                {open && (
                  <tr className="inv-detail">
                    <td colSpan={8}>{v ? <AccountDetail v={v} /> : <span className="muted">Loading the valuation…</span>}</td>
                  </tr>
                )}
                {whyOpen && canWhy && (
                  <tr className="inv-detail">
                    <td colSpan={8}>
                      <ChangePanel account={a} windows={windows} today={today} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function periodDetail(p: NonNullable<PortfolioAccountView["period"]>): string {
  if (p.changeCents === null) return `no value at ${shortDate(p.from)}`;
  const parts: string[] = [];
  const net = BigInt(p.netFlowsCents);
  if (net !== 0n) parts.push(`${money((net < 0n ? -net : net).toString())} ${net > 0n ? "added" : "withdrawn"}`);
  parts.push(p.growthCents === null ? `growth unknown${p.growthReason ? ` (${growthReasonText(p.growthReason)})` : ""}` : `${money(p.growthCents)} growth`);
  if (BigInt(p.incomeCents) !== 0n) parts.push(`incl. ${money(p.incomeCents)} income`);
  return parts.join(" · ");
}

/** The chain's lines behind an account's value (GET /valuation/summary): quantity, price with its status, value. */
function AccountDetail({ v }: { v: AccountValuationView }) {
  const lastRec = v.lastReconciliation;
  const stalestLine = v.stalest ? v.lines.find((l) => l.securityId === v.stalest?.securityId) : undefined;
  return (
    <div className="pf-detail">
      <div className="row wrap pf-detail-head">
        <span>
          Basis: <strong>{v.basis}</strong>
          {v.asOf && <span className="muted"> (data as of {shortDate(v.asOf)})</span>}
        </span>
        <span>
          Prices: <Badge tone={v.priceStatus === "current" ? "ok" : v.priceStatus === "stale" ? "warn" : "neutral"}>{v.priceStatus}</Badge>
          {v.stalest && (
            <span className="muted small">
              {" "}
              stalest {stalestLine?.ticker ?? stalestLine?.name ?? "a security"} {shortDate(v.stalest.priceDate)} ({v.stalest.tradingDaysBehind} trading days behind)
            </span>
          )}
        </span>
        {v.balanceDiffCents !== null && BigInt(v.balanceDiffCents) !== 0n && <span className="muted small">differs from the reported balance by {signedMoney(v.balanceDiffCents)}</span>}
        {v.cashAnchor && <span className="muted small">cash anchored on the {shortDate(v.cashAnchor)} balance</span>}
        <span className="muted small">cash inference {v.cashInference}</span>
        {lastRec ? (
          <span className="muted small">
            Reconciled {shortDate(lastRec.statementDate)} ·{" "}
            {lastRec.diffCents === null ? "no app value that day" : BigInt(lastRec.diffCents) === 0n ? "exact" : lastRec.reconciled ? "to the dollar" : `off by ${money(lastRec.diffCents)}`}
          </span>
        ) : (
          <span className="muted small">not yet checked against a statement</span>
        )}
      </div>
      {v.lines.length === 0 ? (
        <p className="muted small">No holdings behind this value{v.basis === "balance" ? ": balance only" : ""}.</p>
      ) : (
        <table className="table small inv-table">
          <thead>
            <tr>
              <th>Line</th>
              <th>Kind</th>
              <th className="num">Shares</th>
              <th className="num">Price</th>
              <th>Status</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {v.lines.map((l, i) => (
              <tr key={`${l.securityId ?? l.kind}-${i}`}>
                <td>
                  {l.ticker ? <strong>{l.ticker}</strong> : null} {l.name}
                </td>
                <td className="muted">{lineKindLabel(l.kind)}</td>
                <td className="num">{l.quantity === null ? <span className="muted">value only</span> : formatQuantity(l.quantity, 4)}</td>
                <td className="num">{l.price === null ? "—" : formatQuantity(l.price, 4)}</td>
                <td>
                  <PriceStatusChip priceStatus={l.priceStatus} priceDate={l.priceDate} tradingDaysBehind={l.tradingDaysBehind} priceSource={l.priceSource} valueSource={l.valueSource} />
                </td>
                <td className="num">{money(l.valueCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {v.warnings.length > 0 && <AccountWarnings warnings={v.warnings} />}
    </div>
  );
}
