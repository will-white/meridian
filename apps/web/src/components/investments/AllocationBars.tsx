import type { AllocationClassView } from "@meridian/shared";
import { money } from "../../lib/format.js";
import { assetClassLabel, barScaleBp, barWidth, formatBp, formatPp } from "../../lib/investments.js";

/**
 * Paired horizontal bars per asset class: the current share over the target
 * share, with the drift label; an out-of-band class is outlined in the warn
 * colour. Plain CSS (no chart library): six rows read better as a list than
 * as a canvas, and they stay readable at phone width.
 */
export function AllocationBars({ classes, targetsSet }: { classes: readonly AllocationClassView[]; targetsSet: boolean }) {
  const scale = barScaleBp(classes);
  return (
    <div className="inv-bars" role="list" aria-label="Allocation by asset class">
      {classes.map((c) => (
        <div key={c.assetClass} className={`inv-bar-row ${c.outOfBand ? "out" : ""}`} role="listitem">
          <div className="inv-bar-label">
            <span>{assetClassLabel(c.assetClass)}</span>
            <span className="muted small">{money(c.currentCents)}</span>
          </div>
          <div className="inv-bar-track" title={`current ${formatBp(c.currentBp)}${targetsSet ? `, target ${formatBp(c.targetBp)}` : ""}`}>
            <div className={`inv-bar current slot-${c.assetClass}`} style={{ width: `${barWidth(c.currentBp, scale)}%` }} />
            {targetsSet && <div className="inv-bar target" style={{ width: `${barWidth(c.targetBp, scale)}%` }} />}
          </div>
          <div className="inv-bar-figures num">
            <span>{formatBp(c.currentBp)}</span>
            {targetsSet && (
              <>
                <span className="muted">/ {formatBp(c.targetBp)}</span>
                <span className={c.outOfBand ? "tone-warn" : "muted"}>{formatPp(c.driftBp)}</span>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
