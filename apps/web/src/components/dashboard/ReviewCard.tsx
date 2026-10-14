import { Link } from "react-router";
import type { DashboardView } from "@meridian/shared";
import { Card } from "../ui.js";
import { reviewLinks } from "./dashboard.js";

/** Counts of things waiting for a decision, each linking to where it is handled. */
export function ReviewCard({ review }: { review: DashboardView["review"] }) {
  const links = reviewLinks(review);
  const total = links.reduce((n, l) => n + l.count, 0);
  return (
    <Card title="To review" actions={total === 0 ? <span className="muted small">all clear</span> : undefined}>
      <ul className="dash-review">
        {links.map((l) => (
          <li key={l.to}>
            <Link to={l.to}>{l.label}</Link>
            <span className={`count ${l.count === 0 ? "zero" : ""}`}>{l.count}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
