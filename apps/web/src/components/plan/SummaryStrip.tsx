import { forwardRef } from "react";
import { Link } from "react-router";
import type { MonthSummaryView } from "@meridian/shared";
import { money } from "../../lib/format.js";
import { monthLabel, paceText, uncategorizedUrl } from "../../lib/plan.js";
import { Badge } from "../ui.js";

interface Props {
  summary: MonthSummaryView[];
  zeroBased: boolean;
  compact: boolean;
}

/**
 * The sticky strip above the grid: one column per month with the month label,
 * committed bucket totals, left to spend (or to assign), the pace line for the
 * current month and an uncategorized badge that links to the register.
 */
export const SummaryStrip = forwardRef<HTMLDivElement, Props>(function SummaryStrip({ summary, zeroBased, compact }, ref) {
  const keyLabel = zeroBased ? "To assign" : "Left to spend";
  return (
    <div ref={ref} className={`plan-strip plan-row ${compact ? "compact" : ""}`} role="row">
      <div className="plan-name plan-strip-labels">
        <span className="plan-strip-month">Month</span>
        <span className="plan-strip-key muted">{keyLabel}</span>
        {!compact && <span className="plan-strip-totals muted small">committed: income · bills · savings · spending</span>}
        <span className="plan-strip-pace muted small">pace</span>
      </div>
      {summary.map((s) => {
        const value = zeroBased ? s.toAssignCents : s.leftToSpendCents;
        const warn = value.startsWith("-");
        return (
          <div key={s.month} className={`plan-cell plan-strip-cell ${s.state} ${warn ? "warn" : ""}`} role="cell">
            <span className="plan-strip-month">
              <span>{monthLabel(s.month)}</span>
              {s.state === "current" && <Badge tone="info">now</Badge>}
              {s.uncategorized.count > 0 && (
                <Link to={uncategorizedUrl(s.month)} className="plan-uncat" title={`${money(s.uncategorized.cents)} not in any category; click to review`}>
                  <Badge tone="warn">{s.uncategorized.count} uncategorized</Badge>
                </Link>
              )}
            </span>
            <span className="plan-strip-key" title={`${keyLabel}: ${money(value)}${zeroBased ? "" : ` (planned ${money(s.plannedLeftToSpendCents)})`}`}>
              {money(value)}
            </span>
            {!compact && (
              <span className="plan-strip-totals small" title="Committed this month: income · bills · savings · spending">
                <span className="pos">{money(s.committed.income)}</span>
                <span>{money(s.committed.bills)}</span>
                <span>{money(s.committed.savings)}</span>
                <span>{money(s.committed.spending)}</span>
              </span>
            )}
            <span className="plan-strip-pace small">{s.pace ? paceText(s.pace) : s.state === "future" ? "upcoming" : "closed"}</span>
          </div>
        );
      })}
    </div>
  );
});
