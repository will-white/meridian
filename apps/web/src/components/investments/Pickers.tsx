import { useState } from "react";
import { useSearchParams } from "react-router";
import { isIsoDate } from "@meridian/shared";
import type { InvestmentPeriod } from "@meridian/shared";
import { PERIOD_CHOICES, type PeriodParams } from "../../lib/investments.js";

/**
 * The two URL-state controls the Investments pages share. `PeriodPicker`
 * writes `?period=` (and `?from=&to=` for a custom range); `AsOfPicker`
 * writes `?asOf=` (max today) with "latest" to clear it. Both replace the
 * history entry so the back button leaves the page, not the picker.
 */

function useSetParams() {
  const [, setSearchParams] = useSearchParams();
  return (patch: Record<string, string | null>) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );
}

export function PeriodPicker({ value, today }: { value: PeriodParams; today: string }) {
  const setParams = useSetParams();
  const [draftFrom, setDraftFrom] = useState(value.from ?? "");
  const [draftTo, setDraftTo] = useState(value.to ?? today);
  const custom = value.period === "custom";
  const select = (period: InvestmentPeriod) => setParams({ period, from: null, to: null });
  const applyCustom = () => {
    if (!isIsoDate(draftFrom) || !isIsoDate(draftTo) || draftFrom >= draftTo || draftTo > today) return;
    setParams({ period: "custom", from: draftFrom, to: draftTo });
  };
  const customValid = isIsoDate(draftFrom) && isIsoDate(draftTo) && draftFrom < draftTo && draftTo <= today;
  return (
    <div className="row wrap inv-period">
      <div className="inv-seg" role="group" aria-label="Period">
        {PERIOD_CHOICES.map(([choice, label]) => (
          <button key={choice} type="button" aria-pressed={value.period === choice} onClick={() => select(choice)}>
            {label}
          </button>
        ))}
        <button type="button" aria-pressed={custom} onClick={() => setParams({ period: "custom", from: value.from ?? null, to: value.to ?? null })}>
          Custom
        </button>
      </div>
      {custom && (
        <span className="row wrap inv-custom">
          <input type="date" aria-label="From" value={draftFrom} max={today} onChange={(e) => setDraftFrom(e.target.value)} />
          <span className="muted">to</span>
          <input type="date" aria-label="To" value={draftTo} max={today} onChange={(e) => setDraftTo(e.target.value)} />
          <button type="button" className="secondary" disabled={!customValid} onClick={applyCustom}>
            Apply
          </button>
          {!customValid && <span className="muted small">from must be before to, and to on or before today</span>}
        </span>
      )}
    </div>
  );
}

export function AsOfPicker({ value, today }: { value: string | null; today: string }) {
  const setParams = useSetParams();
  return (
    <label className="inline inv-asof">
      As of
      <input type="date" value={value ?? ""} max={today} onChange={(e) => setParams({ asOf: e.target.value && e.target.value <= today ? e.target.value : null })} />
      {value !== null && (
        <button type="button" className="link small" onClick={() => setParams({ asOf: null })}>
          latest
        </button>
      )}
    </label>
  );
}
