import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import type { AccountChangesView, PortfolioAccountView } from "@meridian/shared";
import { api, query } from "../../lib/api.js";
import { money, shortDate } from "../../lib/format.js";
import { attributionTotals, changeSentence, changeTone, formatQuantity, fromToText, growthReasonText, lineKindLabel, marketOrUnknownText, signedMoney, type ChangeWindow } from "../../lib/investments.js";
import { incomeKindLabel } from "../../lib/performanceView.js";
import { Badge, Empty, ErrorText } from "../ui.js";
import { ExternalFlowsTable } from "./ExternalFlowsTable.js";
import { INVESTMENTS_STALE_MS } from "./queries.js";

type WindowKind = "day" | "period";

/**
 * "Why did it change" (views design §3.9, plan decision 12): the Portfolio
 * row's change attributed through GET /investments/accounts/:id/changes for
 * the day (prior close → as-of) or the period: per holding the price effect
 * (`mulToCents(qFrom, pTo) − vFrom`) and the quantity effect (the rest of the
 * holding's Δ), the "cash & other" residual line, the external flows with
 * links, the income rows, and the uncategorized-rows note linking to the
 * register. The effects and the residual sum to the change exactly; a
 * footer that does not add up is flagged. A balance-only account has no
 * holdings: its growth is one "market or unknown" line.
 */
export function ChangePanel({ account, windows, today }: { account: Pick<PortfolioAccountView, "accountId" | "accountName" | "fidelity">; windows: { day: ChangeWindow | null; period: ChangeWindow | null }; today: string }) {
  const [which, setWhich] = useState<WindowKind>(windows.period ? "period" : "day");
  const w = which === "day" ? windows.day : windows.period;
  const params = w ? { accountId: account.accountId, from: w.from, to: w.to, today } : null;
  const changes = useQuery({
    queryKey: ["investments", "changes", params],
    queryFn: () => api<AccountChangesView>(`/investments/accounts/${account.accountId}/changes${query({ from: params!.from, to: params!.to, today })}`),
    enabled: params !== null,
    staleTime: INVESTMENTS_STALE_MS,
    placeholderData: keepPreviousData,
  });
  const c = changes.data;
  const totals = c ? attributionTotals(c) : null;

  return (
    <div className="pf-why">
      <div className="row wrap pf-why-head">
        <div className="inv-seg" role="group" aria-label="Window">
          <button type="button" aria-pressed={which === "day"} disabled={windows.day === null} onClick={() => setWhich("day")} title={windows.day ? `${shortDate(windows.day.from)} to ${shortDate(windows.day.to)}` : "no prior close to measure the day from"}>
            Day
          </button>
          <button type="button" aria-pressed={which === "period"} disabled={windows.period === null} onClick={() => setWhich("period")} title={windows.period ? `${shortDate(windows.period.from)} to ${shortDate(windows.period.to)}` : "no value at the period start"}>
            Period
          </button>
        </div>
        {w && (
          <span className="muted small">
            {account.accountName}, {shortDate(w.from)} to {shortDate(w.to)}
            {changes.isFetching ? " · updating…" : ""}
          </span>
        )}
        {c && <span className={changeTone(c.summary.changeCents)}>{changeSentence(c.summary)}</span>}
        {c?.summary.growthReason && <span className="muted small">{growthReasonText(c.summary.growthReason)}</span>}
      </div>
      <ErrorText error={changes.error} />
      {w === null && <p className="muted small">Nothing to explain yet: the day needs a prior close and the period a value at its start.</p>}
      {w !== null && !c && changes.isLoading && <p className="muted small">Attributing…</p>}
      {w !== null && c && (
        <>
          {c.holdings.length === 0 ? (
            <p className="muted small">
              No holdings to attribute{account.fidelity === "balance_only" ? " (balance only)" : ""}: {marketOrUnknownText(c.summary)}.
            </p>
          ) : (
            <div className="scroll">
              <table className="table small inv-table pf-why-table">
                <thead>
                  <tr>
                    <th>Holding</th>
                    <th className="num">Shares</th>
                    <th className="num">Price</th>
                    <th className="num">Value</th>
                    <th className="num">Δ</th>
                    <th className="num">Price effect</th>
                    <th className="num">Quantity effect</th>
                  </tr>
                </thead>
                <tbody>
                  {c.holdings.map((h, i) => (
                    <tr key={`${h.securityId ?? h.name}-${i}`}>
                      <td>
                        {h.ticker ? <strong>{h.ticker}</strong> : null} {h.name}
                        {h.kind !== "position" && <span className="muted small"> {lineKindLabel(h.kind)}</span>}
                      </td>
                      <td className="num">{fromToText(h.quantityFrom, h.quantityTo, (q) => formatQuantity(q, 4))}</td>
                      <td className="num">{fromToText(h.priceFrom, h.priceTo, (p) => formatQuantity(p, 4))}</td>
                      <td className="num">{fromToText(h.valueFromCents, h.valueToCents, money)}</td>
                      <td className={`num ${changeTone(h.deltaCents)}`}>{signedMoney(h.deltaCents)}</td>
                      <td className={`num ${changeTone(h.priceEffectCents)}`}>{signedMoney(h.priceEffectCents)}</td>
                      <td className={`num ${changeTone(h.quantityEffectCents)}`}>{signedMoney(h.quantityEffectCents)}</td>
                    </tr>
                  ))}
                  <tr className="inv-sub">
                    <td colSpan={4} title="The cash, balance-plug and carried-transfer lines: what the holdings do not explain">
                      Cash &amp; other
                    </td>
                    <td className={`num ${changeTone(c.residualEffectCents)}`}>{signedMoney(c.residualEffectCents)}</td>
                    <td className="num muted">—</td>
                    <td className="num muted">—</td>
                  </tr>
                </tbody>
                {totals && (
                  <tfoot>
                    <tr>
                      <td colSpan={4}>
                        Total {!totals.balanced && <span className="muted">(the rows do not add up to the change)</span>}
                      </td>
                      <td className={`num ${changeTone(totals.totalCents.toString())}`}>{signedMoney(totals.totalCents.toString())}</td>
                      <td className={`num ${changeTone(totals.priceEffectCents.toString())}`}>{signedMoney(totals.priceEffectCents.toString())}</td>
                      <td className={`num ${changeTone(totals.quantityEffectCents.toString())}`}>{signedMoney(totals.quantityEffectCents.toString())}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
          {c.summary.uncategorizedRows > 0 && (
            <p className="muted small">
              {c.summary.uncategorizedRows} uncategorized row{c.summary.uncategorizedRows === 1 ? "" : "s"} in this window may be contributions nobody marked as transfers:{" "}
              <Link to={`/transactions${query({ accountId: account.accountId, uncategorized: true, from: w.from, to: w.to })}`}>review them</Link>.
            </p>
          )}

          <h4>Flows</h4>
          <ExternalFlowsTable flows={c.flows} />

          <h4>Income</h4>
          {c.income.length === 0 ? (
            <Empty>No dividends or interest in this window.</Empty>
          ) : (
            <div className="scroll">
              <table className="table small inv-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Security</th>
                    <th>Kind</th>
                    <th className="num">Amount</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {c.income.map((r) => (
                    <tr key={r.id}>
                      <td>{shortDate(r.date)}</td>
                      <td>{r.ticker ?? <span className="muted">account</span>}</td>
                      <td>
                        {incomeKindLabel(r.kind)}
                        {r.reinvested && <Badge tone="neutral">reinvested</Badge>}
                      </td>
                      <td className="num">{money(r.cents)}</td>
                      <td className="actions">
                        {r.ledgerTransactionId && (
                          <Link className="small" to={`/transactions${query({ accountId: r.accountId, from: r.date, to: r.date })}`}>
                            view
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {c.warnings.length > 0 && (
            <ul className="inv-warnings">
              {c.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
