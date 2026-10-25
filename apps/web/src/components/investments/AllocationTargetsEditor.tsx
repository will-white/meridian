import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AllocationTargetsView, AllocationTargetView, AssetClass, HouseholdSettingView } from "@meridian/shared";
import { api } from "../../lib/api.js";
import { money } from "../../lib/format.js";
import { ASSET_CLASSES, assetClassLabel, bpToPpInput, dollarsToCents, formatBp, parseTargetsForm, ppToBp, targetsForm, targetsSumBp, type TargetsForm } from "../../lib/investments.js";
import { ErrorText } from "../ui.js";
import { invalidateInvestments } from "./queries.js";

/**
 * The household's allocation targets (plan decision 16): six percent inputs
 * with a live sum; Save is enabled only when they add up to 100.00 % or are
 * all blank (which clears the targets). The whole set is replaced through
 * PUT /investments/allocation-targets; the server's `400 allocation_sum` is
 * shown verbatim if it disagrees with the client's check. Beside it, the
 * drift band and the minimum trade are saved through PATCH /settings.
 *
 * Owner only: the pages render it after checking the role.
 */
export function AllocationTargetsEditor({
  classes,
  targetsSet,
  settings,
}: {
  classes: ReadonlyArray<{ assetClass: AssetClass; targetBp: number | null; currentBp: number | null }>;
  targetsSet: boolean;
  settings: HouseholdSettingView | undefined;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<TargetsForm>(() => targetsForm(classes, targetsSet));
  const [dirty, setDirty] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!dirty) setForm(targetsForm(classes, targetsSet));
  }, [classes, targetsSet, dirty]);

  const save = useMutation({
    mutationFn: (targets: AllocationTargetView[]) => api<AllocationTargetsView>("/investments/allocation-targets", { method: "PUT", body: { targets } }),
    onSuccess: () => {
      setDirty(false);
      setSaved(true);
      invalidateInvestments(qc);
    },
  });

  const edit = (c: AssetClass, value: string) => {
    setForm((f) => ({ ...f, [c]: value }));
    setDirty(true);
    setSaved(false);
    setClientError(null);
  };
  const sumBp = targetsSumBp(form);
  const allBlank = ASSET_CLASSES.every((c) => form[c].trim() === "");
  const canSave = !save.isPending && (allBlank ? targetsSet : sumBp === 10000);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = parseTargetsForm(form);
    if (!r.ok) return setClientError(r.error);
    setClientError(null);
    save.mutate(r.targets);
  };
  const clear = () => {
    setForm(targetsForm([], false));
    setDirty(true);
    setSaved(false);
    setClientError(null);
    if (targetsSet) save.mutate([]);
  };

  return (
    <div className="inv-targets">
      <form onSubmit={submit} className="inv-targets-form">
        <div className="inv-targets-grid">
          {ASSET_CLASSES.map((c) => (
            <label key={c}>
              {assetClassLabel(c)}
              <span className="row">
                <input inputMode="decimal" value={form[c]} placeholder="0" onChange={(e) => edit(c, e.target.value)} aria-label={`${assetClassLabel(c)} target percent`} />
                <span className="muted">%</span>
              </span>
            </label>
          ))}
        </div>
        <div className="row wrap inv-targets-actions">
          <span className={`inv-targets-sum ${sumBp === null ? "tone-bad" : sumBp === 10000 || allBlank ? "" : "tone-warn"}`}>
            {sumBp === null ? "not a percentage" : `Sum ${formatBp(sumBp, { places: 2 })}`}
          </span>
          <button type="submit" disabled={!canSave || !dirty}>
            {save.isPending ? "Saving…" : "Save targets"}
          </button>
          <button type="button" className="secondary" disabled={save.isPending || (allBlank && !targetsSet)} onClick={clear}>
            Clear targets
          </button>
          {saved && !dirty && <span className="notice">Saved.</span>}
          {!targetsSet && !dirty && !allBlank && <span className="muted small">Prefilled with the current percentages as a starting point.</span>}
        </div>
        {clientError && <ErrorText error={new Error(clientError)} />}
        <ErrorText error={save.error} />
      </form>
      {settings && <RebalanceSettings settings={settings} />}
    </div>
  );
}

interface RebalancePatch {
  rebalanceBandBp?: number;
  rebalanceMinTradeCents?: string;
}

/** The band ("rebalance when a class drifts more than 5.0 pp") and the minimum trade ("ignore trades under $100.00"). */
function RebalanceSettings({ settings }: { settings: HouseholdSettingView }) {
  const qc = useQueryClient();
  const [band, setBand] = useState(() => bpToPpInput(settings.rebalanceBandBp));
  const [minTrade, setMinTrade] = useState(() => money(settings.rebalanceMinTradeCents).replace(/^\$/, ""));
  const [dirty, setDirty] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) {
      setBand(bpToPpInput(settings.rebalanceBandBp));
      setMinTrade(money(settings.rebalanceMinTradeCents).replace(/^\$/, ""));
    }
  }, [settings, dirty]);

  const save = useMutation({
    mutationFn: (patch: RebalancePatch) => api<HouseholdSettingView>("/settings", { method: "PATCH", body: patch }),
    onSuccess: (view) => {
      qc.setQueryData(["settings"], view);
      setDirty(false);
      invalidateInvestments(qc);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const bandBp = ppToBp(band);
    if (bandBp === null) return setClientError("The band is a number of percentage points from 0 to 50 with at most one decimal");
    const cents = dollarsToCents(minTrade);
    if (cents === null) return setClientError("The minimum trade is a dollar amount");
    const patch: RebalancePatch = {};
    if (bandBp !== settings.rebalanceBandBp) patch.rebalanceBandBp = bandBp;
    if (cents !== settings.rebalanceMinTradeCents) patch.rebalanceMinTradeCents = cents;
    setClientError(null);
    if (Object.keys(patch).length === 0) return setDirty(false);
    save.mutate(patch);
  };

  return (
    <form onSubmit={submit} className="inv-rebalance-settings">
      <label>
        Rebalance when a class drifts more than
        <span className="row">
          <input
            inputMode="decimal"
            value={band}
            onChange={(e) => {
              setBand(e.target.value);
              setDirty(true);
            }}
            aria-label="Drift band in percentage points"
          />
          <span className="muted">pp</span>
        </span>
      </label>
      <label>
        Ignore trades under
        <span className="row">
          <span className="muted">$</span>
          <input
            inputMode="decimal"
            value={minTrade}
            onChange={(e) => {
              setMinTrade(e.target.value);
              setDirty(true);
            }}
            aria-label="Minimum trade in dollars"
          />
        </span>
      </label>
      <div className="row wrap">
        <button type="submit" className="secondary" disabled={!dirty || save.isPending}>
          {save.isPending ? "Saving…" : "Save band and minimum"}
        </button>
      </div>
      {clientError && <ErrorText error={new Error(clientError)} />}
      <ErrorText error={save.error} />
    </form>
  );
}
