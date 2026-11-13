import { forwardRef } from "react";
import { Link } from "react-router";
import type { MonthSummaryView } from "@meridian/shared";
import { money } from "../../lib/format.js";
import { beforePlanStart, monthLabel, paceText, uncategorizedUrl } from "../../lib/plan.js";
import { Badge } from "../ui.js";

interface Props {
  summary: MonthSummaryView[];
  zeroBased: boolean;
  compact: boolean;
  /** The household's plan start month: earlier months are read-only and say so. */
  startMonth: string;
  /** Open the drill-down panel on a month's uncategorized transactions; without it the badge links to the register. */
  onUncategorized?: (month: string) => void;
}

const BUCKETS: ReadonlyArray<[keyof MonthSummaryView["committed"], string]> = [
  ["income", "Income"],
  ["bills", "Bills"],
  ["savings", "Savings"],
  ["spending", "Spending"],
];

/**
 * The sticky strip above the grid: one column per month with the month label, left to spend
 * (or to assign), the committed bucket totals (each named, in compact mode too), the pace line
 * for the current month and an uncategorized badge that opens the drill-down panel.
 */
export const SummaryStrip = forwardRef<HTMLDivElement, Props>(function SummaryStrip({ summary, zeroBased, compact, startMonth, onUncategorized }, ref) {
  const keyLabel = zeroBased ? "To assign" : "Left to spend";
  return (
    <div ref={ref} className={`plan-strip plan-row ${compact ? "compact" : ""}`} role="row">
      <div className="plan-name plan-strip-labels">
        <span className="plan-strip-month">Month</span>
        <span className="plan-strip-key muted">{keyLabel}</span>
        <span className="plan-strip-caption muted small">Committed this month, by bucket</span>
        <span className="plan-strip-pace muted small">Pace</span>
      </div>
      {summary.map((s) => {
        const value = zeroBased ? s.toAssignCents : s.leftToSpendCents;
        const warn = value.startsWith("-");
        const early = beforePlanStart(s.month, startMonth);
        const badge = <Badge tone="warn">{s.uncategorized.count} uncategorized</Badge>;
        const badgeTitle = `${money(s.uncategorized.cents)} not in any category; click to review`;
        return (
          <div key={s.month} className={`plan-cell plan-strip-cell ${s.state} ${warn ? "warn" : ""}`} role="cell">
            <span className="plan-strip-month">
              <span>{monthLabel(s.month)}</span>
              {s.state === "current" && <Badge tone="info">now</Badge>}
              {s.uncategorized.count > 0 &&
                (onUncategorized ? (
                  <button type="button" className="plan-uncat" title={badgeTitle} onClick={() => onUncategorized(s.month)}>
                    {badge}
                  </button>
                ) : (
                  <Link to={uncategorizedUrl(s.month)} className="plan-uncat" title={badgeTitle}>
                    {badge}
                  </Link>
                ))}
            </span>
            <span className="plan-strip-key" title={`${keyLabel}: ${money(value)}${zeroBased ? "" : ` (planned ${money(s.plannedLeftToSpendCents)})`}`}>
              {money(value)}
            </span>
            <dl className="plan-strip-totals small" title="Committed this month: the larger of planned and actual, per bucket">
              {BUCKETS.map(([bucket, label]) => (
                <div key={bucket} className={`plan-strip-total bucket-${bucket}`}>
                  <dt>{label}</dt>
                  <dd className={bucket === "income" ? "pos" : undefined}>{money(s.committed[bucket])}</dd>
                </div>
              ))}
            </dl>
            <span className="plan-strip-pace small">
              {s.pace ? (
                paceText(s.pace)
              ) : early ? (
                <Link to="/settings" title={`The plan starts in ${monthLabel(startMonth)}: earlier months show what happened and take no plan edits. Change the start month in Settings.`}>
                  before the plan start
                </Link>
              ) : s.state === "future" ? (
                "upcoming"
              ) : (
                "closed"
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
});
