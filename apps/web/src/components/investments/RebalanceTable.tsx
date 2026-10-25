import { Fragment } from "react";
import type { RebalanceView } from "@meridian/shared";
import { money } from "../../lib/format.js";
import { assetClassLabel, bpToPpInput, formatQuantity, groupTrades, signedMoney, taxTreatmentLabel, tradeSentence } from "../../lib/investments.js";
import { Badge } from "../ui.js";

const ACTION_LABELS = { sell: "Sell", buy: "Buy", use_cash: "Use cash", hold_cash: "Hold cash" } as const;

/**
 * The deterministic rebalance suggestion (plan decision 16) as a table
 * grouped by account in the order the server generated it: account rank
 * (tax-advantaged first), sells before buys. Each row is the trade sentence
 * plus the class, the approximate share count, the estimated gain on a
 * taxable sell and the server's note. Below: the residual the suggestion
 * could not place, the trades left out under the minimum, and the footer
 * reminding that nothing is executed.
 */
export function RebalanceTable({ rebalance, blendedTickers }: { rebalance: RebalanceView; blendedTickers: readonly string[] }) {
  const band = bpToPpInput(rebalance.bandBp);
  if (!rebalance.triggered) {
    return (
      <div className="inv-rebalance">
        <p className="notice">Within the {band} pp band — nothing to do.</p>
        <Footer blendedTickers={blendedTickers} />
      </div>
    );
  }
  const groups = groupTrades(rebalance.trades);
  const left = rebalance.trades.length === 0 && BigInt(rebalance.belowMinimumCents) > 0n;
  return (
    <div className="inv-rebalance">
      {rebalance.trades.length > 0 && (
        <div className="scroll">
          <table className="table small inv-trades">
            <thead>
              <tr>
                <th>Account</th>
                <th>Action</th>
                <th>Trade</th>
                <th>Class</th>
                <th className="num">Amount</th>
                <th className="num">~Shares</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g, gi) => (
                <Fragment key={`${g.accountId}-${gi}`}>
                  {g.trades.map((t, i) => (
                    <tr key={`${g.accountId}-${gi}-${i}`}>
                      <td>
                        {i === 0 && (
                          <>
                            {g.accountName}
                            <Badge tone="neutral">{taxTreatmentLabel(g.taxTreatment)}</Badge>
                          </>
                        )}
                      </td>
                      <td>
                        <Badge tone={t.action === "sell" || t.action === "use_cash" ? "warn" : "info"}>{ACTION_LABELS[t.action]}</Badge>
                      </td>
                      <td>
                        {tradeSentence(t)}
                        {!t.inAccount && t.ticker && <span className="muted small"> (new to this account)</span>}
                      </td>
                      <td className="muted">{assetClassLabel(t.assetClass)}</td>
                      <td className="num">{money(t.amountCents)}</td>
                      <td className="num muted">{t.approxQuantity ? `${formatQuantity(t.approxQuantity, 4)} @ ${formatQuantity(t.price, 2)}` : "—"}</td>
                      <td className="muted small">
                        {t.estimatedGainCents !== null && (
                          <span className={BigInt(t.estimatedGainCents) > 0n ? "tone-warn" : ""}>may realize about {signedMoney(t.estimatedGainCents)} of gains; the lots view shows which lots. </span>
                        )}
                        {t.note}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {left && <p className="muted">Every suggested trade was under the minimum of {money(rebalance.minTradeCents)}.</p>}
      {BigInt(rebalance.belowMinimumCents) > 0n && !left && (
        <p className="muted small">
          {money(rebalance.belowMinimumCents)} of trades under {money(rebalance.minTradeCents)} were left out.
        </p>
      )}
      {rebalance.residual.length > 0 && (
        <p className="inv-residual">
          Not fully rebalanced:{" "}
          {rebalance.residual.map((r, i) => (
            <span key={r.assetClass}>
              {i > 0 ? ", " : ""}
              {assetClassLabel(r.assetClass)} {signedMoney(r.amountCents)}
            </span>
          ))}
          . This needs money moved between accounts, or a class is held only through blended funds.
        </p>
      )}
      {rebalance.notes.length > 0 && (
        <ul className="inv-notes">
          {rebalance.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <Footer blendedTickers={blendedTickers} />
    </div>
  );
}

function Footer({ blendedTickers }: { blendedTickers: readonly string[] }) {
  return (
    <p className="muted small inv-rebalance-foot">
      {blendedTickers.length > 0 ? `Blended funds (${blendedTickers.join(", ")}) are held constant. ` : ""}
      Nothing is executed; the app never moves money.
    </p>
  );
}
