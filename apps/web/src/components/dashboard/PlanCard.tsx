import { Link } from "react-router";
import type { DashboardView } from "@meridian/shared";
import { money } from "../../lib/format.js";
import { monthLabel, paceText, uncategorizedUrl } from "../../lib/plan.js";
import { Card } from "../ui.js";

type PlanView = DashboardView["plan"];

const BUCKETS: ReadonlyArray<[keyof PlanView["committed"], string]> = [
  ["income", "Income"],
  ["bills", "Bills"],
  ["savings", "Savings"],
  ["spending", "Spending"],
];

/** Left to spend (or "to assign" for a zero-based household) with the daily pace and the month's bucket totals. */
export function PlanCard({ plan }: { plan: PlanView }) {
  const headline = plan.zeroBased ? plan.toAssignCents : plan.leftToSpendCents;
  const title = plan.zeroBased ? "To assign" : "Left to spend";
  const unc = plan.uncategorized;
  return (
    <Card title={`${title} · ${monthLabel(plan.month)}`} actions={<Link to="/plan">Open plan</Link>}>
      <div className={`dash-hero ${plan.warning ? "warn" : ""}`}>{money(headline)}</div>
      <p className="dash-sub muted">{paceText(plan.pace)}</p>
      <table className="table small dash-buckets">
        <thead>
          <tr>
            <th>Bucket</th>
            <th>Planned</th>
            <th>Actual</th>
            <th>Committed</th>
          </tr>
        </thead>
        <tbody>
          {BUCKETS.map(([bucket, label]) => (
            <tr key={bucket}>
              <td>{label}</td>
              <td>{money(plan.planned[bucket])}</td>
              <td>{money(plan.actual[bucket])}</td>
              <td>{money(plan.committed[bucket])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {unc.count > 0 && (
        <p className="small dash-note">
          <Link to={uncategorizedUrl(plan.month)}>
            {unc.count} uncategorized transaction{unc.count === 1 ? "" : "s"} ({money(unc.cents)})
          </Link>{" "}
          <span className="muted">not counted above</span>
        </p>
      )}
    </Card>
  );
}
