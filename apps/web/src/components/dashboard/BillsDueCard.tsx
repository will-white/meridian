import { Link } from "react-router";
import type { DashboardView } from "@meridian/shared";
import { money, shortDate } from "../../lib/format.js";
import { Badge, Card, Empty } from "../ui.js";
import { billsSummary } from "./dashboard.js";

/** Active outflows due within 14 days, overdue ones first by date and flagged. */
export function BillsDueCard({ bills, today }: { bills: DashboardView["billsDue"]; today: string }) {
  const summary = billsSummary(bills, today);
  return (
    <Card title="Bills due in 14 days" actions={<Link to="/recurring">Recurring</Link>}>
      {bills.length === 0 ? (
        <Empty>Nothing due through {shortDate(summary.windowEnd)}.</Empty>
      ) : (
        <>
          <table className="table small dash-bills">
            <thead>
              <tr>
                <th>Due</th>
                <th>Bill</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => (
                <tr key={`${b.recurringId}:${b.dueDate}`} className={b.overdue ? "overdue" : ""}>
                  <td className="nowrap">
                    {shortDate(b.dueDate)}
                    {b.overdue && <Badge tone="bad">overdue</Badge>}
                  </td>
                  <td>
                    <Link to={`/recurring?focus=${b.recurringId}`}>{b.name}</Link>
                    <div className="muted small">
                      {b.categoryName ?? "no category"}
                      {b.accountName ? ` · ${b.accountName}` : ""}
                    </div>
                  </td>
                  <td className="num nowrap">{money(b.amountCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>
                  {bills.length} bill{bills.length === 1 ? "" : "s"}
                  {summary.overdue > 0 ? `, ${summary.overdue} overdue` : ""}
                </td>
                <td className="num nowrap">
                  <strong>{money(summary.totalCents)}</strong>
                </td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </Card>
  );
}
