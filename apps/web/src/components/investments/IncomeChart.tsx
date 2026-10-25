import type { IncomeMonthView } from "@meridian/shared";
import { money } from "../../lib/format.js";
import { incomeBars, monthAxisLabel } from "../../lib/performanceView.js";
import { monthLabel } from "../../lib/plan.js";

/**
 * Income by month as stacked bars in plain CSS (the chart bundle registers
 * line charts only, and a dozen monthly bars read fine as a list): interest
 * at the foot, cash dividends above it, reinvested dividends hatched on top.
 * Heights scale to the tallest month; the legend names the three parts and
 * each bar carries its figures as a title.
 */
export function IncomeChart({ months }: { months: readonly IncomeMonthView[] }) {
  const { maxCents, bars } = incomeBars(months);
  if (bars.length === 0) return null;
  return (
    <div className="inc-chart">
      <div className="inc-legend">
        <span>
          <i className="inc-swatch dividends" /> Dividends paid in cash
        </span>
        <span>
          <i className="inc-swatch reinvested" /> Reinvested
        </span>
        <span>
          <i className="inc-swatch interest" /> Interest
        </span>
        <span className="muted small">tallest month {money(maxCents)}</span>
      </div>
      <div className="inc-bars" role="list" aria-label="Income by month">
        {bars.map((b, i) => (
          <div
            key={b.month}
            className="inc-col"
            role="listitem"
            title={`${monthLabel(b.month)}: ${money(b.totalCents)} (${money(b.cashDividendsCents)} dividends in cash, ${money(b.reinvestedCents)} reinvested, ${money(b.interestCents)} interest)`}
          >
            <div className="inc-stack">
              {b.pct.reinvested > 0 && <div className="inc-seg reinvested" style={{ height: `${b.pct.reinvested}%` }} />}
              {b.pct.cashDividends > 0 && <div className="inc-seg dividends" style={{ height: `${b.pct.cashDividends}%` }} />}
              {b.pct.interest > 0 && <div className="inc-seg interest" style={{ height: `${b.pct.interest}%` }} />}
            </div>
            <span className="inc-month">{monthAxisLabel(b.month, i === 0 ? null : (bars[i - 1]?.month ?? null))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
