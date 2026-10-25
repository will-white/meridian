import { Link } from "react-router";
import type { ExternalFlowView } from "@meridian/shared";
import { money, shortDate } from "../../lib/format.js";
import { changeTone, signedMoney } from "../../lib/investments.js";
import { flowKindLabel, flowLink, flowSourceLabel, internalReasonText } from "../../lib/performanceView.js";
import { Badge, Empty } from "../ui.js";

/**
 * The external flows behind a return (plan decision 11): ledger transfers,
 * investment cash transfers, securities transfers at market and the engine's
 * opening values, each with its kind, source, counterparty and a link to
 * where it can be inspected. Flows the engine excluded as internal to the
 * selection (both sides in the total, or before the first valuation) are
 * struck through with their reason. The footer sums what counted.
 */
export function ExternalFlowsTable({ flows, accountNames, showAccount = false }: { flows: readonly ExternalFlowView[]; accountNames?: ReadonlyMap<string, string>; showAccount?: boolean }) {
  if (flows.length === 0) return <Empty>No external flows in this period.</Empty>;
  const counted = flows.filter((f) => !f.internal).reduce((acc, f) => acc + BigInt(f.amountCents), 0n);
  const internal = flows.filter((f) => f.internal).length;
  return (
    <div className="scroll">
      <table className="table small inv-table perf-flows">
        <thead>
          <tr>
            <th>Date</th>
            {showAccount && <th>Account</th>}
            <th>Kind</th>
            <th>Source</th>
            <th className="num">Amount</th>
            <th>Counterparty</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {flows.map((f, i) => {
            const link = flowLink(f);
            const reason = internalReasonText(f.internalReason);
            return (
              <tr key={`${f.sourceId ?? f.kind}-${f.date}-${i}`} className={f.internal ? "perf-flow-internal" : ""}>
                <td>{shortDate(f.date)}</td>
                {showAccount && <td>{accountNames?.get(f.accountId) ?? f.accountId}</td>}
                <td>
                  {flowKindLabel(f.kind)}
                  {f.internal && (
                    <Badge tone="neutral">
                      <span title={reason ?? "internal"}>internal{reason ? `: ${reason}` : ""}</span>
                    </Badge>
                  )}
                </td>
                <td className="muted">{flowSourceLabel(f.source)}</td>
                <td className={`num ${f.internal ? "muted" : changeTone(f.amountCents)}`}>{signedMoney(f.amountCents)}</td>
                <td className="muted">{f.counterpartyAccountName ?? (f.counterpartyAccountId ? "another account" : "—")}</td>
                <td className="actions">{link && <Link to={link}>view</Link>}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={showAccount ? 4 : 3} className="muted">
              Net flows counted{internal > 0 ? ` (${internal} internal excluded)` : ""}
            </td>
            <td className={`num ${changeTone(counted.toString())}`}>{signedMoney(counted.toString())}</td>
            <td colSpan={2} className="muted small">
              positive = money in; {money(counted < 0n ? (-counted).toString() : counted.toString())} {counted < 0n ? "withdrawn" : "added"}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
