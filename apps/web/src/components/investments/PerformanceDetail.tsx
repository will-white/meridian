import { useQuery } from "@tanstack/react-query";
import type { AccountPerformanceView, BenchmarkPerformanceView, PerformanceRequestBody, PerformanceResponse, StatementCheckView } from "@meridian/shared";
import { api } from "../../lib/api.js";
import { money, shortDate } from "../../lib/format.js";
import { changeTone, formatQuantity, formatRate, signedMoney } from "../../lib/investments.js";
import { methodLabel, subPeriodFlags } from "../../lib/performanceView.js";
import { Badge, ErrorText } from "../ui.js";
import { ExternalFlowsTable } from "./ExternalFlowsTable.js";
import { INVESTMENTS_STALE_MS } from "./queries.js";

/**
 * "How this was computed" (lots design §5): the engine's own detail from
 * POST /api/investments/performance with `detail: full` (a readOnly POST, so
 * a viewer may open it): the TWR sub-period table with carried and skipped
 * flags, the XIRR investor-flow list with the sign convention stated, the
 * benchmark legs (date, amount, price used and its date, units), the
 * statement check and the flow list with internal flows struck through.
 */
export function PerformanceDetail({ body, accountId, accountNames }: { body: PerformanceRequestBody; accountId: string | null; accountNames: ReadonlyMap<string, string> }) {
  const detail = useQuery({
    queryKey: ["investments", "performance-detail", body],
    queryFn: () => api<PerformanceResponse>("/investments/performance", { method: "POST", body }),
    staleTime: INVESTMENTS_STALE_MS,
  });
  const d = detail.data;
  if (detail.isLoading) return <p className="muted small">Computing…</p>;
  if (detail.error) return <ErrorText error={detail.error} />;
  if (!d) return null;
  const account: AccountPerformanceView | null = accountId === null ? null : (d.accounts.find((a) => a.accountId === accountId) ?? null);
  const block = account ?? d.total;
  if (accountId !== null && account === null) return <p className="muted small">This account is not in the computation.</p>;
  const benchmark: BenchmarkPerformanceView | null = block.benchmark;
  return (
    <div className="perf-detail">
      <div className="row wrap perf-detail-head">
        <span>
          Method <Badge tone={block.method === "true_twr" ? "ok" : "info"}>{methodLabel(block.method)}</Badge>
        </span>
        <span className="muted small">
          {shortDate(d.from)} to {shortDate(d.to)} ({d.days} days), valued as of {shortDate(d.asOf)}
        </span>
        {accountId === null && d.total.excludedInternalFlows > 0 && <span className="muted small">{d.total.excludedInternalFlows} internal flows excluded from the total</span>}
        {accountId === null && d.total.partialGains && <span className="muted small">gains cover the full-history accounts only</span>}
      </div>

      {account?.statementCheck && <StatementCheck check={account.statementCheck} />}

      <h4>Time-weighted sub-periods</h4>
      {block.subPeriods.length === 0 ? (
        <p className="muted small">No sub-periods: the return was computed from the start and end values and the dated flows (Modified Dietz).</p>
      ) : (
        <div className="scroll">
          <table className="table small inv-table">
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th className="num">Begin</th>
                <th className="num">Flow</th>
                <th className="num">End</th>
                <th className="num">Rate</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {block.subPeriods.map((sp, i) => (
                <tr key={`${sp.from}-${i}`} className={sp.skipped ? "perf-skipped" : ""}>
                  <td>{shortDate(sp.from)}</td>
                  <td>{shortDate(sp.to)}</td>
                  <td className="num">{money(sp.beginValueCents)}</td>
                  <td className={`num ${changeTone(sp.flowCents)}`}>{signedMoney(sp.flowCents)}</td>
                  <td className="num">{money(sp.endValueCents)}</td>
                  <td className={`num ${changeTone(sp.rate ?? null)}`}>{sp.rate === null ? "—" : formatRate(sp.rate, true)}</td>
                  <td className="muted small">{subPeriodFlags(sp).join("; ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4>Money-weighted (XIRR) investor flows</h4>
      <p className="muted small">Negative = money you put in; the end value is the final positive flow. Invested {block.xirr.investedDays} days.</p>
      {block.xirr.investorFlows.length === 0 ? (
        <p className="muted small">No flows: the money-weighted return is undefined.</p>
      ) : (
        <ul className="perf-investor-flows">
          {block.xirr.investorFlows.map((f, i) => (
            <li key={`${f.date}-${i}`}>
              <span>{shortDate(f.date)}</span>
              <span className={`num ${changeTone(f.amountCents)}`}>{signedMoney(f.amountCents)}</span>
            </li>
          ))}
        </ul>
      )}
      {block.xirr.warnings.length > 0 && (
        <ul className="inv-notes">
          {block.xirr.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {benchmark && (
        <>
          <h4>
            Benchmark {benchmark.ticker ?? benchmark.name} legs {benchmark.adjusted ? <Badge tone="ok">adjusted closes</Badge> : <Badge tone="neutral">price only</Badge>}
          </h4>
          <p className="muted small">
            Every flow buys cents ÷ close units at the latest close on or before its date; {formatQuantity(benchmark.startPrice, 4)} at the start, {formatQuantity(benchmark.endPrice, 4)} at the end; the shadow value is{" "}
            {money(benchmark.shadowValueCents)}.
          </p>
          {benchmark.legs.length > 0 && (
            <div className="scroll">
              <table className="table small inv-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="num">Amount</th>
                    <th className="num">Price used</th>
                    <th>Price date</th>
                    <th className="num">Units</th>
                  </tr>
                </thead>
                <tbody>
                  {benchmark.legs.map((l, i) => (
                    <tr key={`${l.date}-${i}`}>
                      <td>{shortDate(l.date)}</td>
                      <td className={`num ${changeTone(l.cents)}`}>{signedMoney(l.cents)}</td>
                      <td className="num">{formatQuantity(l.price, 4)}</td>
                      <td className="muted">{shortDate(l.priceDate)}</td>
                      <td className="num">{formatQuantity(l.units, 4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <h4>External flows</h4>
      <ExternalFlowsTable flows={block.flows} accountNames={accountNames} showAccount={accountId === null} />

      {block.warnings.length > 0 && (
        <details className="perf-raw-warnings">
          <summary className="muted small">{block.warnings.length} engine warning{block.warnings.length === 1 ? "" : "s"} (raw)</summary>
          <ul className="inv-notes">
            {block.warnings.map((w, i) => (
              <li key={`${w.code}-${i}`}>
                <code>{w.code}</code> {w.ticker ? `${w.ticker} ` : ""}
                {w.date ? `${shortDate(w.date)} ` : ""}
                {w.detail ?? ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** "statement $1,057.50, securities $1,050.00, tracked cash $7.00, difference $0.50" (lots design §5). */
function StatementCheck({ check }: { check: StatementCheckView }) {
  const diff = BigInt(check.differenceCents);
  return (
    <p className={`perf-statement-check ${diff === 0n ? "tone-ok" : "tone-warn"}`}>
      Statement check {shortDate(check.date)}: statement {money(check.statementCents)}, securities {money(check.securitiesCents)}, tracked cash {money(check.trackedCashCents)} (since{" "}
      {check.trackedFrom === "inception" ? "inception" : shortDate(check.trackedFrom)}), implied cash {money(check.impliedCashCents)}, difference {signedMoney(check.differenceCents)}.
    </p>
  );
}
