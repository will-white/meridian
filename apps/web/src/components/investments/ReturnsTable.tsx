import { Fragment, type ReactNode } from "react";
import type { AccountRef, PerformanceBenchmarkView, ReturnBlockView } from "@meridian/shared";
import { money } from "../../lib/format.js";
import { changeTone, formatRate, signedMoney } from "../../lib/investments.js";
import { excessText, flowsSourceLabel, methodLabel, methodTone, mwrCell, openingValueText, twrCell } from "../../lib/performanceView.js";
import { Badge } from "../ui.js";
import { FidelityBadge } from "./FidelityBadge.js";

export interface ReturnsRow {
  key: string;
  name: string;
  /** Null for the household total. */
  account: AccountRef | null;
  block: ReturnBlockView;
}

/**
 * The Performance table (views design §5): the total and each account with
 * the method badge, start value (and the opening value when the account
 * entered mid-period), contributions, withdrawals, end value, growth, TWR
 * (period, annualized when the engine returned one), MWR (period under a
 * year, annualized otherwise), the benchmark's TWR, the excess, the shadow
 * value "in VTI", the flows provenance chip and the partial marker. A row
 * expands into whatever the page renders for it (flows and the engine's
 * detail).
 */
export function ReturnsTable({
  rows,
  days,
  benchmark,
  partial,
  expanded,
  onExpand,
  renderDetail,
}: {
  rows: readonly ReturnsRow[];
  days: number;
  /** Null hides the benchmark columns. */
  benchmark: PerformanceBenchmarkView | null;
  partial: boolean;
  expanded: string | null;
  onExpand: (key: string | null) => void;
  renderDetail: (row: ReturnsRow) => ReactNode;
}) {
  const benchLabel = benchmark?.ticker ?? benchmark?.name ?? "benchmark";
  const cols = 12 + (benchmark ? 3 : 0);
  return (
    <div className="scroll">
      <table className="table inv-table perf-table">
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Start</th>
            <th className="num">Added</th>
            <th className="num">Withdrawn</th>
            <th className="num">End</th>
            <th className="num">Growth</th>
            <th className="num">TWR</th>
            <th className="num">MWR</th>
            {benchmark && (
              <>
                <th className="num">{benchLabel} TWR</th>
                <th className="num">Excess</th>
                <th className="num">In {benchLabel}</th>
              </>
            )}
            <th>Flows</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const b = row.block;
            const open = expanded === row.key;
            const twr = twrCell(b.twr);
            const mwr = mwrCell(b.xirr, days);
            const opening = openingValueText(b.openingValue);
            const bench = b.benchmark;
            return (
              <Fragment key={row.key}>
                <tr className={row.account === null ? "perf-total" : ""}>
                  <td className="name">
                    <button type="button" className="inv-expand" aria-expanded={open} onClick={() => onExpand(open ? null : row.key)}>
                      {row.name}
                    </button>
                    {row.account && <FidelityBadge fidelity={row.account.fidelity} fidelityNote={row.account.fidelityNote} accountId={row.account.accountId} />}
                    <Badge tone={methodTone(b.method)}>{methodLabel(b.method)}</Badge>
                    {partial && row.account === null && <Badge tone="warn">partial period</Badge>}
                  </td>
                  <td className="num">
                    {money(b.startValueCents)}
                    {opening && <div className="muted small">{opening}</div>}
                  </td>
                  <td className="num">{money(b.contributionsCents)}</td>
                  <td className="num">{money(b.withdrawalsCents)}</td>
                  <td className="num">{money(b.endValueCents)}</td>
                  <td className={`num ${changeTone(b.growthCents)}`}>{signedMoney(b.growthCents)}</td>
                  <td className={`num ${twr.failed ? "muted" : changeTone(b.twr.rate ?? null)}`} title={twr.failed ? (b.readable[0] ?? "") : ""}>
                    {twr.text}
                    {twr.caption && <div className="muted small">{twr.caption}</div>}
                  </td>
                  <td className={`num ${mwr.failed ? "muted" : changeTone(days < 365 ? (b.xirr.period ?? null) : (b.xirr.annualized ?? null))}`}>
                    {mwr.text}
                    {mwr.caption && <div className="muted small">{mwr.caption}</div>}
                  </td>
                  {benchmark && (
                    <>
                      <td className="num">
                        {bench === null || bench.twr === null ? <span className="muted">—</span> : formatRate(bench.twr, true)}
                        {bench !== null && bench.twrAnnualized !== null && <div className="muted small">{formatRate(bench.twrAnnualized, true)} annualized</div>}
                        {bench !== null && bench.reason !== null && <div className="muted small">{bench.reason.replace(/_/g, " ")}</div>}
                      </td>
                      <td className={`num ${changeTone(bench?.excessTwr ?? null)}`}>{excessText(bench?.excessTwr ?? null)}</td>
                      <td className="num" title={`the same deposits in ${benchLabel} would be worth this`}>
                        {bench === null ? "—" : money(bench.shadowValueCents)}
                      </td>
                    </>
                  )}
                  <td>
                    <span className="inv-chip">{flowsSourceLabel(b.flowsSource)}</span>
                    {b.uncategorizedRows > 0 && (
                      <div className="muted small">
                        {b.uncategorizedRows} uncategorized row{b.uncategorizedRows === 1 ? "" : "s"}
                      </div>
                    )}
                  </td>
                  <td className="actions">
                    <button type="button" className="link small" onClick={() => onExpand(open ? null : row.key)}>
                      {open ? "hide" : "details"}
                    </button>
                  </td>
                </tr>
                {open && (
                  <tr className="inv-detail">
                    <td colSpan={cols}>{renderDetail(row)}</td>
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
