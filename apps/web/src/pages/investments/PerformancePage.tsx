import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { isInvestmentAccountType } from "@meridian/shared";
import type { AccountView, PerformanceView, SecurityView } from "@meridian/shared";
import { api, query } from "../../lib/api.js";
import { money, shortDate } from "../../lib/format.js";
import { localToday } from "../../lib/plan.js";
import { asOfFromParams, changeTone, formatRate, periodFromParams, periodQuery, signedMoney } from "../../lib/investments.js";
import { benchmarkFromParams, benchmarkNote, detailRequestBody, excessText, growthEndText, mwrCell, twrCell } from "../../lib/performanceView.js";
import { Badge, Card, Empty, ErrorText } from "../../components/ui.js";
import { useChartTheme } from "../../components/charts/EChart.js";
import { seriesColor } from "../../components/charts/chartOptions.js";
import { AccountWarnings } from "../../components/investments/AccountWarnings.js";
import { ExternalFlowsTable } from "../../components/investments/ExternalFlowsTable.js";
import { GrowthChart, type GrowthLine } from "../../components/investments/GrowthChart.js";
import { PerformanceDetail } from "../../components/investments/PerformanceDetail.js";
import { AsOfPicker, PeriodPicker } from "../../components/investments/Pickers.js";
import { ReturnsTable, type ReturnsRow } from "../../components/investments/ReturnsTable.js";
import { INVESTMENTS_STALE_MS } from "../../components/investments/queries.js";
import "./investments.css";
import "./PerformancePage.css";

const TOTAL = "__total__";
const BENCH = "__bench__";

/**
 * Performance (plan decisions 11 and 12; views design §5): the household's
 * and each account's returns over the period from GET /investments/performance
 * (true TWR for full-history accounts, Modified Dietz otherwise; XIRR; the
 * benchmark shadow portfolio), the growth-of-$10,000 chart, and per row the
 * external flows and the engine's own detail (POST /investments/performance
 * with `detail: full`). URL state: `?period=`, `?from=&to=`, `?asOf=`,
 * `?accountId=` (one account or all) and `?benchmark=` (a security id, `none`,
 * or absent for the household's).
 */
export function PerformancePage() {
  const today = useMemo(() => localToday(), []);
  const [searchParams, setSearchParams] = useSearchParams();
  const period = useMemo(() => periodFromParams(searchParams, today, "1y"), [searchParams, today]);
  const asOf = asOfFromParams(searchParams, today);
  const benchmarkParam = benchmarkFromParams(searchParams);
  const accountId = searchParams.get("accountId") ?? "";
  const theme = useChartTheme();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState<ReadonlySet<string>>(new Set());

  const params = useMemo(
    () => ({
      ...periodQuery(period),
      ...(asOf ? { asOf } : {}),
      ...(accountId ? { accountIds: accountId } : {}),
      ...(typeof benchmarkParam === "string" ? { benchmarkSecurityId: benchmarkParam } : {}),
      today,
    }),
    [period, asOf, accountId, benchmarkParam, today],
  );
  const performance = useQuery({
    queryKey: ["investments", "performance", params],
    queryFn: () => api<PerformanceView>(`/investments/performance${query(params)}`),
    staleTime: INVESTMENTS_STALE_MS,
    placeholderData: keepPreviousData,
  });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<AccountView[]>("/accounts"), staleTime: INVESTMENTS_STALE_MS });
  const held = useQuery({ queryKey: ["securities", { held: true }], queryFn: () => api<SecurityView[]>(`/investments/securities${query({ held: "true" })}`), staleTime: INVESTMENTS_STALE_MS });
  const v = performance.data;

  const investmentAccounts = useMemo(() => (accounts.data ?? []).filter((a) => isInvestmentAccountType(a.type) && !a.closed), [accounts.data]);
  const accountNames = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a.name])), [accounts.data]);
  const showBenchmark = benchmarkParam !== null && v?.benchmark !== null && v?.benchmark !== undefined;
  const benchmark = showBenchmark && v ? v.benchmark : null;
  const benchmarkOptions = useMemo(() => {
    const list = (held.data ?? []).filter((s) => s.type !== "cash").map((s) => ({ id: s.id, label: s.ticker ?? s.name }));
    if (v?.benchmark && !list.some((o) => o.id === v.benchmark!.securityId)) list.unshift({ id: v.benchmark.securityId, label: v.benchmark.ticker ?? v.benchmark.name });
    return list;
  }, [held.data, v?.benchmark]);

  const setParam = (key: string, value: string | null) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );

  const rows: ReturnsRow[] = useMemo(() => {
    if (!v || v.total === null) return [];
    return [{ key: TOTAL, name: accountId ? "Selected account" : "Household total", account: null, block: v.total }, ...v.accounts.map((a) => ({ key: a.accountId, name: a.accountName, account: a, block: a.block }))];
  }, [v, accountId]);

  const lines: GrowthLine[] = useMemo(() => {
    if (!v || v.total === null) return [];
    const out: GrowthLine[] = [];
    if (!hidden.has(TOTAL)) out.push({ key: TOTAL, name: "Portfolio", points: v.total.series, color: theme.ink, bold: true });
    if (benchmark && !hidden.has(BENCH)) out.push({ key: BENCH, name: benchmark.ticker ?? benchmark.name, points: benchmark.series, color: theme.muted, dashed: true });
    v.accounts.forEach((a, i) => {
      if (v.accounts.length > 1 && !hidden.has(a.accountId)) out.push({ key: a.accountId, name: a.accountName, points: a.block.series, color: seriesColor(i, theme) });
    });
    return out;
  }, [v, benchmark, hidden, theme]);

  const toggleHidden = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleDetail = (key: string) =>
    setDetailOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const days = v?.period?.days ?? 0;
  const total = v?.total ?? null;
  const totalTwr = total ? twrCell(total.twr) : null;
  const totalMwr = total ? mwrCell(total.xirr, days) : null;
  const readable = useMemo(() => {
    const out: string[] = [...(v?.warnings ?? [])];
    for (const s of total?.readable ?? []) if (!out.includes(s)) out.push(s);
    return out;
  }, [v?.warnings, total?.readable]);

  return (
    <>
      <div className="inv-toolbar">
        <h2>Performance</h2>
        <div className="row wrap">
          <PeriodPicker value={period} today={today} />
          <AsOfPicker value={asOf} today={today} />
          <label className="inline perf-filter">
            Account
            <select value={accountId} onChange={(e) => setParam("accountId", e.target.value)} aria-label="Account filter">
              <option value="">All accounts</option>
              {investmentAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="inline perf-filter">
            Benchmark
            <select value={benchmarkParam === undefined ? "" : benchmarkParam === null ? "none" : benchmarkParam} onChange={(e) => setParam("benchmark", e.target.value)} aria-label="Benchmark">
              <option value="">Household default{v?.benchmark && benchmarkParam === undefined ? ` (${v.benchmark.ticker ?? v.benchmark.name})` : ""}</option>
              <option value="none">None</option>
              {benchmarkOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <ErrorText error={performance.error} />
      {!v && performance.isLoading && <p className="muted">Loading…</p>}
      {v && v.accounts.length === 0 && (
        <Card>
          <Empty>
            No investment accounts yet. Set an account's type to brokerage, 401k, IRA, Roth, HSA or 529 on the <Link to="/accounts">Accounts page</Link>, or{" "}
            <Link to="/connections">connect one</Link>.
          </Empty>
        </Card>
      )}
      {v && total && (
        <>
          <Card
            title={v.period ? `Returns ${shortDate(v.period.from)} to ${shortDate(v.period.to)}` : "Returns"}
            actions={<span className="muted small">{performance.isFetching ? "updating…" : v.period ? `${v.period.days} days${v.asOf ? ` · as of ${shortDate(v.asOf)}` : ""}` : ""}</span>}
          >
            <div className="inv-stats">
              <div className="inv-stat">
                <span className="k">Time-weighted return</span>
                <span className={`v hero ${totalTwr?.failed ? "muted" : changeTone(total.twr.rate ?? null)}`}>{totalTwr?.text}</span>
                <span className="sub">{totalTwr?.failed ? (total.readable[0] ?? "not computable") : totalTwr?.caption}</span>
              </div>
              <div className="inv-stat">
                <span className="k">Money-weighted return</span>
                <span className={`v ${totalMwr?.failed ? "muted" : changeTone(days < 365 ? (total.xirr.period ?? null) : (total.xirr.annualized ?? null))}`}>{totalMwr?.text}</span>
                {totalMwr?.caption && <span className="sub">{totalMwr.caption}</span>}
              </div>
              <div className="inv-stat">
                <span className="k">Growth</span>
                <span className={`v ${changeTone(total.growthCents)}`}>{signedMoney(total.growthCents)}</span>
                <span className="sub">
                  {money(total.startValueCents)} → {money(total.endValueCents)}; {money(total.contributionsCents)} added, {money(total.withdrawalsCents)} withdrawn
                  {total.openingValue ? `, ${money(total.openingValue.cents)} entered ${shortDate(total.openingValue.date)}` : ""}
                </span>
              </div>
              {benchmark && total.benchmark && (
                <div className="inv-stat">
                  <span className="k">vs {benchmark.ticker ?? benchmark.name}</span>
                  <span className={`v ${changeTone(total.benchmark.excessTwr)}`}>{total.benchmark.twr === null ? "—" : `${formatRate(total.benchmark.twr, true)} · excess ${excessText(total.benchmark.excessTwr)}`}</span>
                  <span className="sub">
                    {total.benchmark.shadowValueCents !== null ? `the same deposits in ${benchmark.ticker ?? benchmark.name} would be worth ${money(total.benchmark.shadowValueCents)}` : (total.benchmark.reason?.replace(/_/g, " ") ?? "")}
                    {benchmarkNote(benchmark.adjusted) ? ` · ${benchmarkNote(benchmark.adjusted)}` : ""}
                  </span>
                </div>
              )}
            </div>
            {v.period?.partial && (
              <p className="muted small">
                <Badge tone="warn">partial</Badge> {v.period.note ?? "The period starts before the first data; accounts entering later carry an opening value."}
              </p>
            )}
            {benchmarkParam === null && (
              <p className="muted small">
                Benchmark off. The household's benchmark is set in <Link to="/settings">Settings</Link>.
              </p>
            )}
            {benchmarkParam === undefined && v.benchmark === null && (
              <p className="muted small">
                No benchmark set; choose one above or in <Link to="/settings">Settings</Link>.
              </p>
            )}
            <AccountWarnings warnings={readable} />
          </Card>

          <Card title="Growth of $10,000" actions={<span className="muted small">{growthEndText(total.series) ?? ""}</span>}>
            <div className="inv-legend" role="group" aria-label="Series">
              <label className="inline">
                <input type="checkbox" checked={!hidden.has(TOTAL)} onChange={() => toggleHidden(TOTAL)} />
                <span className="inv-swatch bold" style={{ background: theme.ink }} /> Portfolio
              </label>
              {benchmark && (
                <label className="inline">
                  <input type="checkbox" checked={!hidden.has(BENCH)} onChange={() => toggleHidden(BENCH)} />
                  <span className="inv-swatch dashed" style={{ background: theme.muted }} /> {benchmark.ticker ?? benchmark.name}
                  {!benchmark.adjusted && <Badge tone="neutral">price only</Badge>}
                </label>
              )}
              {v.accounts.length > 1 &&
                v.accounts.map((a, i) => (
                  <label className="inline" key={a.accountId}>
                    <input type="checkbox" checked={!hidden.has(a.accountId)} onChange={() => toggleHidden(a.accountId)} />
                    <span className="inv-swatch" style={{ background: seriesColor(i, theme) }} /> {a.accountName}
                  </label>
                ))}
            </div>
            <GrowthChart lines={lines} theme={theme} label={`Growth of $10,000${v.period ? ` from ${shortDate(v.period.from)} to ${shortDate(v.period.to)}` : ""}`} />
            <p className="muted small inv-chart-note">Points are the engine's sub-period boundaries (every external flow); the benchmark is a shadow portfolio buying the same deposits.</p>
          </Card>

          <Card title="By account">
            <ReturnsTable
              rows={rows}
              days={days}
              benchmark={benchmark}
              partial={v.period?.partial ?? false}
              expanded={expanded}
              onExpand={setExpanded}
              renderDetail={(row) => (
                <div className="perf-row-detail">
                  {row.block.readable.length > 0 && <AccountWarnings warnings={row.block.readable} />}
                  {row.block.uncategorizedRows > 0 && (
                    <p className="muted small">
                      {row.block.uncategorizedRows} uncategorized row{row.block.uncategorizedRows === 1 ? "" : "s"} in the period may be contributions:{" "}
                      <Link to={`/transactions${query({ ...(row.account ? { accountId: row.account.accountId } : accountId ? { accountId } : {}), uncategorized: "true" })}`}>review them</Link>.
                    </p>
                  )}
                  <h4>External flows</h4>
                  <ExternalFlowsTable flows={row.block.flows} accountNames={accountNames} showAccount={row.account === null} />
                  <button type="button" className="link small" aria-expanded={detailOpen.has(row.key)} onClick={() => toggleDetail(row.key)}>
                    {detailOpen.has(row.key) ? "hide how this was computed" : "how this was computed"}
                  </button>
                  {detailOpen.has(row.key) && (
                    <PerformanceDetail
                      body={detailRequestBody({
                        period: v.period,
                        asOf: v.asOf ?? today,
                        today,
                        ...(row.account ? { accountIds: [row.account.accountId] } : accountId ? { accountIds: [accountId] } : {}),
                        benchmarkSecurityId: benchmarkParam,
                      })}
                      accountId={row.account?.accountId ?? null}
                      accountNames={accountNames}
                    />
                  )}
                </div>
              )}
            />
            <p className="muted small">
              TWR removes the timing of deposits; MWR (XIRR, Microsoft's definition) is the rate your actual deposits earned. Balance-only accounts use Modified Dietz from snapshots and flows and show no income.
            </p>
          </Card>
        </>
      )}
    </>
  );
}
