import { useMemo } from "react";
import { Link } from "react-router";
import type { DashboardView } from "@meridian/shared";
import { money, shortDate } from "../../lib/format.js";
import { EChart, useChartTheme } from "../charts/EChart.js";
import { cashFlowChartOption } from "../charts/chartOptions.js";
import { Card } from "../ui.js";

type CashFlowView = DashboardView["cashFlow"];

/** The combined on-budget line for the next 30 days with its low point and the household threshold. */
export function CashFlowCard({ cashFlow }: { cashFlow: CashFlowView }) {
  const theme = useChartTheme();
  const option = useMemo(
    () =>
      cashFlowChartOption({
        dates: cashFlow.points.map((p) => p.date),
        series: [
          {
            key: "combined",
            name: "All accounts",
            points: cashFlow.points.map((p) => p.cents),
            thresholdCents: cashFlow.thresholdCents,
            minDate: cashFlow.lowPoint.date,
            minCents: cashFlow.lowPoint.cents,
            firstBelowThresholdDate: cashFlow.firstBelow,
            bold: true,
            color: theme.accent,
          },
        ],
        theme,
      }),
    [cashFlow, theme],
  );
  const below = BigInt(cashFlow.lowPoint.cents) < BigInt(cashFlow.thresholdCents);
  return (
    <Card title={`Cash flow · next ${cashFlow.horizonDays} days`} actions={<Link to="/cashflow">Open cash flow</Link>}>
      <EChart option={option} height={220} label={`Projected combined balance from ${shortDate(cashFlow.asOf)}, lowest ${money(cashFlow.lowPoint.cents)} on ${shortDate(cashFlow.lowPoint.date)}`} />
      <div className="dash-stats">
        <div className="dash-stat">
          <span className="k">Low point</span>
          <span className={`v ${below ? "tone-bad" : ""}`}>
            {money(cashFlow.lowPoint.cents)} <span className="muted small">on {shortDate(cashFlow.lowPoint.date)}</span>
          </span>
        </div>
        <div className="dash-stat">
          <span className="k">Threshold</span>
          <span className="v">{money(cashFlow.thresholdCents)}</span>
        </div>
        <div className="dash-stat">
          <span className="k">Below threshold</span>
          <span className={`v ${cashFlow.firstBelow ? "tone-bad" : ""}`}>{cashFlow.firstBelow ? `from ${shortDate(cashFlow.firstBelow)}` : "never"}</span>
        </div>
      </div>
      {cashFlow.warnings.length > 0 && (
        <ul className="dash-warnings">
          {cashFlow.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
