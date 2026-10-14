import { Link } from "react-router";
import type { DashboardView } from "@meridian/shared";
import { money, shortDate } from "../../lib/format.js";
import { Card } from "../ui.js";
import { netWorthChangeText, newAccountsNote } from "./dashboard.js";

/** Net worth from the latest balance snapshots with the 12-month change. */
export function NetWorthCard({ netWorth }: { netWorth: DashboardView["netWorth"] }) {
  const change = netWorthChangeText(netWorth);
  const note = newAccountsNote(netWorth.newAccounts);
  return (
    <Card title="Net worth" actions={<Link to="/accounts">Accounts</Link>}>
      <div className={`dash-hero ${netWorth.todayCents.startsWith("-") ? "warn" : ""}`}>{money(netWorth.todayCents)}</div>
      <p className={`dash-sub tone-${change.tone}`}>{change.text}</p>
      {netWorth.yearAgoCents !== null && (
        <p className="small muted">
          {money(netWorth.yearAgoCents)} on {shortDate(netWorth.yearAgoDate)} · {money(netWorth.todayCents)} as of {shortDate(netWorth.asOf)}
        </p>
      )}
      {note && <p className="small muted dash-note">{note}</p>}
    </Card>
  );
}
