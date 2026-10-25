import { Link } from "react-router";
import type { DashboardView } from "@meridian/shared";
import { money, shortDate } from "../../lib/format.js";
import { Badge, Card } from "../ui.js";
import { awaitingReconcileText, fidelityCountsText, investmentsDayChangeText, priceFeedText, securitiesReviewText, staleAccountsText } from "./dashboard.js";

/**
 * The investments block (views design §5, seams C47): the portfolio's value
 * from the one valuation chain, the day change with its tone, stale accounts,
 * the fidelity counts, the accounts awaiting a statement check, securities to
 * review and the price feed's health. Hidden by the page when the block is
 * null (no open investment accounts).
 */
export function InvestmentsCard({ investments }: { investments: NonNullable<DashboardView["investments"]> }) {
  const change = investmentsDayChangeText(investments);
  const stale = staleAccountsText(investments.staleAccounts);
  const awaiting = awaitingReconcileText(investments.awaitingReconcile);
  const review = securitiesReviewText(investments.securitiesNeedingReview);
  const feed = priceFeedText(investments.priceFeed);
  return (
    <Card title="Investments" actions={<Link to="/investments">Open investments</Link>}>
      <div className="dash-hero">{money(investments.totalCents)}</div>
      <p className={`dash-sub tone-${change.tone}`}>{change.text}</p>
      <p className="small muted">
        as of {shortDate(investments.asOf)} · {fidelityCountsText(investments.fidelityCounts)}
      </p>
      {stale && <p className="small dash-warnings-line">{stale}</p>}
      <ul className="dash-review">
        <li>
          <Link to="/investments/reconcile">{awaiting ?? "Every positions account is checked against a statement"}</Link>
          <span className={`count ${investments.awaitingReconcile === 0 ? "zero" : ""}`}>{investments.awaitingReconcile}</span>
        </li>
        <li>
          <Link to="/investments/securities?chip=review">{review ?? "No securities to review"}</Link>
          <span className={`count ${investments.securitiesNeedingReview === 0 ? "zero" : ""}`}>{investments.securitiesNeedingReview}</span>
        </li>
        <li>
          <Link to="/investments/prices">{feed.text}</Link>
          <Badge tone={feed.tone === "ok" ? "ok" : feed.tone === "bad" ? "warn" : "neutral"}>{investments.priceFeed.configured ? "feed" : "no feed"}</Badge>
        </li>
      </ul>
    </Card>
  );
}
