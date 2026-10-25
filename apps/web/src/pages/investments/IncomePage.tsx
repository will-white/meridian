import { Fragment, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import type { IncomeMonthView, IncomeView } from "@meridian/shared";
import { api, query } from "../../lib/api.js";
import { money, shortDate } from "../../lib/format.js";
import { localToday, monthLabel } from "../../lib/plan.js";
import { asOfFromParams, periodFromParams, periodQuery } from "../../lib/investments.js";
import { feedModeLabel, incomeEmptyText, incomeKindLabel, linkStatusLabel, linkStatusTone, yieldText } from "../../lib/performanceView.js";
import { Badge, Card, Empty, ErrorText } from "../../components/ui.js";
import { AccountWarnings } from "../../components/investments/AccountWarnings.js";
import { FidelityBadge } from "../../components/investments/FidelityBadge.js";
import { IncomeChart } from "../../components/investments/IncomeChart.js";
import { IncomeFeedSettings } from "../../components/investments/IncomeFeedSettings.js";
import { AsOfPicker, PeriodPicker } from "../../components/investments/Pickers.js";
import { INVESTMENTS_STALE_MS, useIsViewer } from "../../components/investments/queries.js";
import "./investments.css";
import "./IncomePage.css";

/**
 * Income (plan decision 13): dividends, interest and fees by month from
 * GET /investments/income (the engine's `incomeByMonth` plus the categorized
 * bank rows, each dividend counted once), the totals strip, the rows with
 * their link status into the plan, and the owner's feed settings. URL state:
 * `?period=` (default YTD), `?from=&to=`, `?asOf=`, `?accountId=`.
 */
export function IncomePage() {
  const today = useMemo(() => localToday(), []);
  const [searchParams, setSearchParams] = useSearchParams();
  const period = useMemo(() => periodFromParams(searchParams, today, "ytd"), [searchParams, today]);
  const asOf = asOfFromParams(searchParams, today);
  const accountId = searchParams.get("accountId") ?? "";
  const viewer = useIsViewer();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAllRows, setShowAllRows] = useState(false);

  const params = useMemo(() => ({ ...periodQuery(period), ...(asOf ? { asOf } : {}), ...(accountId ? { accountId } : {}), today }), [period, asOf, accountId, today]);
  const income = useQuery({
    queryKey: ["investments", "income", params],
    queryFn: () => api<IncomeView>(`/investments/income${query(params)}`),
    staleTime: INVESTMENTS_STALE_MS,
    placeholderData: keepPreviousData,
  });
  const v = income.data;
  const accountNames = useMemo(() => new Map((v?.feed.accounts ?? []).map((a) => [a.accountId, a.accountName])), [v?.feed.accounts]);

  const selectAccount = (id: string) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set("accountId", id);
        else next.delete("accountId");
        return next;
      },
      { replace: true },
    );

  const noAccounts = v ? v.feed.accounts.length === 0 : false;
  const hasIncome = v ? v.months.some((m) => BigInt(m.totalCents) !== 0n || BigInt(m.feesCents) !== 0n) || v.rows.length > 0 : false;
  const ROWS_SHOWN = 100;
  const rows = v ? (showAllRows ? v.rows : v.rows.slice(0, ROWS_SHOWN)) : [];

  return (
    <>
      <div className="inv-toolbar">
        <h2>Income</h2>
        <div className="row wrap">
          <PeriodPicker value={period} today={today} />
          <AsOfPicker value={asOf} today={today} />
          {v && v.feed.accounts.length > 1 && (
            <label className="inline">
              Account
              <select value={accountId} onChange={(e) => selectAccount(e.target.value)} aria-label="Account filter">
                <option value="">All accounts</option>
                {v.feed.accounts.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.accountName}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>
      <ErrorText error={income.error} />
      {!v && income.isLoading && <p className="muted">Loading…</p>}
      {v && noAccounts && (
        <Card>
          <Empty>
            No investment accounts yet. Set an account's type to brokerage, 401k, IRA, Roth, HSA or 529 on the <Link to="/accounts">Accounts page</Link>, or{" "}
            <Link to="/connections">connect one</Link>.
          </Empty>
        </Card>
      )}
      {v && !noAccounts && (
        <>
          <Card
            title={v.period ? `Income ${shortDate(v.period.from)} to ${shortDate(v.period.to)}` : "Income"}
            actions={<span className="muted small">{income.isFetching ? "updating…" : v.asOf ? `as of ${shortDate(v.asOf)}` : ""}</span>}
          >
            {!hasIncome ? (
              <Empty>{incomeEmptyText(v.feed.categoryName)}</Empty>
            ) : (
              <>
                <div className="inv-stats">
                  <div className="inv-stat">
                    <span className="k">Period total</span>
                    <span className="v hero">{money(v.totals.totalCents)}</span>
                    <span className="sub">
                      {money(v.totals.dividendsCents)} dividends · {money(v.totals.interestCents)} interest
                      {BigInt(v.totals.feesCents) !== 0n ? ` · ${money(v.totals.feesCents)} fees` : ""}
                    </span>
                  </div>
                  <div className="inv-stat">
                    <span className="k">Of which reinvested</span>
                    <span className="v">{money(v.totals.reinvestedCents)}</span>
                    <span className="sub">never fed to the plan</span>
                  </div>
                  <div className="inv-stat">
                    <span className="k">Trailing 12 months</span>
                    <span className="v">{money(v.trailing12mCents)}</span>
                    <span className="sub">{yieldText(v.yieldBp) ?? "yield unknown (no current value)"}</span>
                  </div>
                </div>
                <IncomeChart months={v.months} />
              </>
            )}
            <AccountWarnings warnings={v.warnings} />
          </Card>

          {hasIncome && (
            <Card title="By month">
              <div className="scroll">
                <table className="table inv-table inc-months">
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th className="num">Dividends</th>
                      <th className="num">of which reinvested</th>
                      <th className="num">Interest</th>
                      <th className="num">Fees</th>
                      <th className="num">Total</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.months.map((m) => (
                      <MonthRows key={m.month} m={m} open={expanded === m.month} onToggle={() => setExpanded(expanded === m.month ? null : m.month)} accountNames={accountNames} />
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total</td>
                      <td className="num">{money(v.totals.dividendsCents)}</td>
                      <td className="num muted">{money(v.totals.reinvestedCents)}</td>
                      <td className="num">{money(v.totals.interestCents)}</td>
                      <td className="num">{money(v.totals.feesCents)}</td>
                      <td className="num">{money(v.totals.totalCents)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p className="muted small">Total = dividends + interest; fees are shown, not netted. Reinvested dividends are a subset of dividends.</p>
            </Card>
          )}

          {v.rows.length > 0 && (
            <Card title="Rows" actions={<span className="muted small">{v.rowsTruncated ? "first 2,000 rows" : `${v.rows.length} rows`}</span>}>
              <div className="scroll">
                <table className="table small inv-table inc-rows">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Account</th>
                      <th>Security</th>
                      <th>Kind</th>
                      <th className="num">Amount</th>
                      <th>Source</th>
                      <th>Plan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td>{shortDate(r.date)}</td>
                        <td>{r.accountName}</td>
                        <td>{r.ticker ?? <span className="muted">account</span>}</td>
                        <td>
                          {incomeKindLabel(r.kind)}
                          {r.reinvested && <Badge tone="neutral">reinvested</Badge>}
                        </td>
                        <td className="num">{money(r.cents)}</td>
                        <td className="muted">{r.source === "investment_txn" ? "trade history" : "bank row"}</td>
                        <td>
                          <Badge tone={linkStatusTone(r.linkStatus)}>{linkStatusLabel(r.linkStatus)}</Badge>
                          {r.fed && r.linkStatus !== "linked" && r.linkStatus !== "created" && <Badge tone="ok">fed</Badge>}
                          {r.ledgerTransactionId && (
                            <Link className="small inc-row-link" to={`/transactions${query({ accountId: r.accountId, from: r.date, to: r.date })}`}>
                              view
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {v.rows.length > ROWS_SHOWN && (
                <button type="button" className="link small" onClick={() => setShowAllRows((s) => !s)}>
                  {showAllRows ? `show the first ${ROWS_SHOWN}` : `show all ${v.rows.length} rows`}
                </button>
              )}
            </Card>
          )}

          <Card title="Feed into the plan">
            {viewer ? (
              <div className="inc-feed-readonly">
                <p className="muted small">
                  Income category: {v.feed.categoryName ?? "none"}.{" "}
                  {v.feed.accounts.map((a) => (
                    <span key={a.accountId} className="inc-feed-chip">
                      {a.accountName} <FidelityBadge fidelity={a.fidelity} /> <Badge tone={a.mode === "off" ? "neutral" : "ok"}>{feedModeLabel(a.mode)}</Badge>
                    </span>
                  ))}
                </p>
              </div>
            ) : (
              <IncomeFeedSettings feed={v.feed} />
            )}
          </Card>
        </>
      )}
    </>
  );
}

function MonthRows({ m, open, onToggle, accountNames }: { m: IncomeMonthView; open: boolean; onToggle: () => void; accountNames: ReadonlyMap<string, string> }) {
  const empty = BigInt(m.totalCents) === 0n && BigInt(m.feesCents) === 0n;
  return (
    <Fragment>
      <tr className={empty ? "inc-empty-month" : ""}>
        <td>
          <button type="button" className="inv-expand" aria-expanded={open} onClick={onToggle} disabled={empty}>
            {monthLabel(m.month)}
          </button>
        </td>
        <td className="num">{money(m.dividendsCents)}</td>
        <td className="num muted">{money(m.reinvestedCents)}</td>
        <td className="num">{money(m.interestCents)}</td>
        <td className="num">{money(m.feesCents)}</td>
        <td className="num">{money(m.totalCents)}</td>
        <td className="actions">
          {!empty && (
            <button type="button" className="link small" onClick={onToggle}>
              {open ? "hide" : "by security"}
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="inv-detail">
          <td colSpan={7}>
            <div className="inc-month-detail">
              <div>
                <strong className="small">By security</strong>
                <ul className="inc-breakdown">
                  {m.bySecurity.map((s, i) => (
                    <li key={`${s.securityId ?? "acct"}-${i}`}>
                      <span>{s.ticker ?? (s.securityId === null ? "account-level" : "unnamed")}</span>
                      <span className="num">{money(s.cents)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <strong className="small">By account</strong>
                <ul className="inc-breakdown">
                  {m.byAccount.map((a) => (
                    <li key={a.accountId}>
                      <span>{accountNames.get(a.accountId) ?? a.accountId}</span>
                      <span className="num">{money(a.cents)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
