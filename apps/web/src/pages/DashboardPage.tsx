import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DashboardView } from "@meridian/shared";
import { api, query } from "../lib/api.js";
import { shortDate } from "../lib/format.js";
import { localToday } from "../lib/plan.js";
import { ErrorText } from "../components/ui.js";
import { BillsDueCard } from "../components/dashboard/BillsDueCard.js";
import { CashFlowCard } from "../components/dashboard/CashFlowCard.js";
import { InvestmentsCard } from "../components/dashboard/InvestmentsCard.js";
import { NetWorthCard } from "../components/dashboard/NetWorthCard.js";
import { PlanCard } from "../components/dashboard/PlanCard.js";
import { ReviewCard } from "../components/dashboard/ReviewCard.js";
import { SyncCard } from "../components/dashboard/SyncCard.js";
import "./DashboardPage.css";

/**
 * The household's morning glance: one card per block of DashboardView. The
 * server computes everything per request (Cache-Control: no-store); the client
 * keeps it 30 s and refetches on focus. `today` is the browser's local date.
 */
export function DashboardPage() {
  const today = useMemo(() => localToday(), []);
  const dash = useQuery({
    queryKey: ["dashboard", { today }],
    queryFn: () => api<DashboardView>(`/dashboard${query({ today })}`),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const d = dash.data;
  return (
    <>
      <div className="row space wrap dash-head">
        <h1>Dashboard</h1>
        {d && (
          <span className="muted small">
            as of {shortDate(d.today)}
            {dash.isFetching ? " · refreshing…" : ""}
          </span>
        )}
      </div>
      <ErrorText error={dash.error} />
      {!d && dash.isLoading && <p className="muted">Loading…</p>}
      {d && (
        <div className="dash-grid">
          <PlanCard plan={d.plan} />
          <NetWorthCard netWorth={d.netWorth} />
          {d.investments && <InvestmentsCard investments={d.investments} />}
          <div className="wide">
            <CashFlowCard cashFlow={d.cashFlow} />
          </div>
          <BillsDueCard bills={d.billsDue} today={d.today} />
          <ReviewCard review={d.review} />
          <SyncCard sync={d.sync} />
        </div>
      )}
    </>
  );
}
