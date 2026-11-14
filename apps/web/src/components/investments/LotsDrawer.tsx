import { useQuery } from "@tanstack/react-query";
import type { LotsResponse } from "@meridian/shared";
import { api, query } from "../../lib/api.js";
import { money, shortDate } from "../../lib/format.js";
import { changeTone, formatQuantity, signedMoney } from "../../lib/investments.js";
import { drawerLots, openedByLabel, securityWarnings, termLabel } from "../../lib/lots.js";
import { Badge, ErrorText } from "../ui.js";
import { INVESTMENTS_STALE_MS } from "./queries.js";

export interface LotsDrawerProps {
  accountId: string;
  accountName: string;
  securityId: string;
  /** The ticker, or the security's name. */
  label: string;
  /** The Holdings page's `?asOf=`, or null for today. */
  asOf: string | null;
  today: string;
}

/** The query key and parameters of the drawer's GET /investments/lots (shared with the tests). */
export function lotsDrawerQuery(p: Pick<LotsDrawerProps, "accountId" | "securityId" | "asOf" | "today">) {
  const params = { accountId: p.accountId, securityId: p.securityId, asOf: p.asOf ?? p.today, includeClosed: "true", today: p.today };
  return { queryKey: ["lots", params] as const, params };
}

/**
 * The lots drawer (lots design §5; views design D17): one security's lots in one account as they
 * stood at the end of the Holdings page's date (GET /investments/lots, the lots as of `asOf`,
 * priced on it): acquired, how the lot was opened, shares, cost basis, basis per share, value,
 * unrealized gain and term; closed lots collapsed; the engine's warnings about the security.
 * Opened from a Holdings sub-row that has lots (audit finding b9-conformance-plan-investments-01).
 */
export function LotsDrawer(props: LotsDrawerProps) {
  const { queryKey, params } = lotsDrawerQuery(props);
  const lots = useQuery({ queryKey, queryFn: () => api<LotsResponse>(`/investments/lots${query(params)}`), staleTime: INVESTMENTS_STALE_MS });
  const data = lots.data;
  const view = data ? drawerLots(data.lots, props.accountId, props.securityId) : null;
  const warnings = data ? securityWarnings(data.accounts.find((a) => a.accountId === props.accountId)?.warnings ?? [], props.securityId, props.label) : [];
  return (
    <section className="inv-lots" aria-label={`Lots of ${props.label} in ${props.accountName}`}>
      <div className="row space wrap">
        <strong>
          Lots of {props.label} in {props.accountName}
        </strong>
        <span className="muted small">as of {shortDate(data?.asOf ?? params.asOf)}; term at that date</span>
      </div>
      <ErrorText error={lots.error} />
      {lots.isLoading && <p className="muted small">Loading the lots…</p>}
      {view && view.open.length === 0 && <p className="muted small">No lot of {props.label} is open in this account on {shortDate(params.asOf)}.</p>}
      {view && view.open.length > 0 && (
        <div className="scroll">
          <table className="table small inv-table">
            <thead>
              <tr>
                <th>Acquired</th>
                <th className="num">Shares</th>
                <th className="num">Cost basis</th>
                <th className="num">Basis/share</th>
                <th className="num">Value</th>
                <th className="num">Gain</th>
                <th>Term</th>
              </tr>
            </thead>
            <tbody>
              {view.open.map((l) => (
                <tr key={l.id}>
                  <td>
                    {shortDate(l.acquiredDate)} <span className="muted">· {openedByLabel(l)}</span>
                  </td>
                  <td className="num">{formatQuantity(l.quantity, 8)}</td>
                  <td className="num">{l.basisKnown ? money(l.costBasisCents) : <Badge tone="warn">basis unknown</Badge>}</td>
                  <td className="num">{l.basisPerShare === null ? "—" : formatQuantity(l.basisPerShare, 4)}</td>
                  <td className="num">
                    {money(l.valueCents)}
                    {l.priceDate && l.priceDate !== params.asOf && <div className="muted">price {shortDate(l.priceDate)}</div>}
                  </td>
                  <td className={`num ${changeTone(l.unrealizedCents)}`}>{l.unrealizedCents === null ? "—" : signedMoney(l.unrealizedCents)}</td>
                  <td>{termLabel(l.term)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>
                  {view.open.length} open lot{view.open.length === 1 ? "" : "s"}
                </th>
                <th className="num">{formatQuantity(view.totals.quantity, 8)}</th>
                <th className="num">{money(view.totals.basisCents)}</th>
                <th></th>
                <th className="num">{money(view.totals.valueCents)}</th>
                <th className={`num ${changeTone(view.totals.gainCents)}`}>{view.totals.gainCents === null ? "—" : signedMoney(view.totals.gainCents)}</th>
                <th className="muted">{view.totals.unknownBasisLots > 0 ? `basis and gain exclude ${view.totals.unknownBasisLots} lot${view.totals.unknownBasisLots === 1 ? "" : "s"} of unknown basis` : ""}</th>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {view && view.closed.length > 0 && (
        <details>
          <summary className="small">
            {view.closed.length} closed lot{view.closed.length === 1 ? "" : "s"}
          </summary>
          <div className="scroll">
            <table className="table small inv-table">
              <thead>
                <tr>
                  <th>Acquired</th>
                  <th>Closed</th>
                  <th className="num">Shares bought</th>
                  <th className="num">Original basis</th>
                </tr>
              </thead>
              <tbody>
                {view.closed.map((l) => (
                  <tr key={l.id}>
                    <td>
                      {shortDate(l.acquiredDate)} <span className="muted">· {openedByLabel(l)}</span>
                    </td>
                    <td>{l.closedDate ? shortDate(l.closedDate) : "—"}</td>
                    <td className="num">{formatQuantity(l.originalQuantity, 8)}</td>
                    <td className="num">{l.basisKnown ? money(l.originalCostBasisCents) : "unknown"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">What each sale realized is on the Realized gains page.</p>
        </details>
      )}
      {warnings.length > 0 && (
        <ul className="dash-warnings">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
