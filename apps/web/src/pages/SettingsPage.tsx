import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatCents, localDateInTimeZone, parseDecimalToCents } from "@meridian/shared";
import type { AccountView, HouseholdSettingView } from "@meridian/shared";
import { api } from "../lib/api.js";
import { money, titleCase } from "../lib/format.js";
import { Card, ErrorText } from "../components/ui.js";
import "./SettingsPage.css";

interface Form {
  planStartMonth: string;
  zeroBased: boolean;
  threshold: string;
  primaryAccountId: string;
  projectionDefaultDays: string;
  timezone: string;
}

/** Wire shape of PATCH /settings (UpdateHouseholdSettingBody); only changed fields are sent. */
interface Patch {
  planStartMonth?: string;
  zeroBased?: boolean;
  lowBalanceThresholdCents?: string;
  primaryAccountId?: string | null;
  projectionDefaultDays?: number;
  timezone?: string;
}

const HORIZON_PRESETS = [30, 60, 90, 180, 365] as const;
/** Keys that depend on the settings: plan start month moves carried-in, threshold and horizon move the projection. */
const DEPENDENT_KEYS = [["settings"], ["plan"], ["dashboard"], ["cashflow"]] as const;

function fromView(v: HouseholdSettingView): Form {
  return {
    planStartMonth: v.planStartMonth,
    zeroBased: v.zeroBased,
    threshold: formatCents(BigInt(v.lowBalanceThresholdCents)),
    primaryAccountId: v.primaryAccountId ?? "",
    projectionDefaultDays: String(v.projectionDefaultDays),
    timezone: v.timezone,
  };
}

/** The fields that differ from the saved settings, parsed; or what is wrong. */
function buildPatch(form: Form, current: HouseholdSettingView): { ok: true; patch: Patch } | { ok: false; error: string } {
  const patch: Patch = {};
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(form.planStartMonth)) return { ok: false, error: "Plan start month must be a month (YYYY-MM)" };
  if (form.planStartMonth !== current.planStartMonth) patch.planStartMonth = form.planStartMonth;
  if (form.zeroBased !== current.zeroBased) patch.zeroBased = form.zeroBased;
  let threshold: bigint;
  try {
    threshold = parseDecimalToCents(form.threshold.replace(/[$,\s]/g, "") || "0");
  } catch {
    return { ok: false, error: "The low-balance threshold is not an amount" };
  }
  if (threshold.toString() !== current.lowBalanceThresholdCents) patch.lowBalanceThresholdCents = threshold.toString();
  const primary = form.primaryAccountId === "" ? null : form.primaryAccountId;
  if (primary !== current.primaryAccountId) patch.primaryAccountId = primary;
  const days = Number(form.projectionDefaultDays);
  if (!Number.isInteger(days) || days < 1 || days > 366) return { ok: false, error: "Projection default must be a whole number of days from 1 to 366" };
  if (days !== current.projectionDefaultDays) patch.projectionDefaultDays = days;
  const tz = form.timezone.trim();
  if (tz === "") return { ok: false, error: "Time zone is required" };
  if (tz !== current.timezone) patch.timezone = tz;
  return { ok: true, patch };
}

function zoneKnownHere(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function zoneList(): string[] {
  try {
    return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  } catch {
    return [];
  }
}

/**
 * Household settings (one row): plan start month, zero-based presentation,
 * the cash-flow threshold and primary account, the default projection horizon
 * and the IANA time zone that defines "today" for the worker. The server
 * validates the time zone and the primary account; its message is shown as is.
 */
export function SettingsPage() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<HouseholdSettingView>("/settings") });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<AccountView[]>("/accounts") });
  const [form, setForm] = useState<Form | null>(null);
  const [dirty, setDirty] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const zones = useMemo(zoneList, []);

  useEffect(() => {
    if (settings.data && !dirty) setForm(fromView(settings.data));
  }, [settings.data, dirty]);

  const save = useMutation({
    mutationFn: (patch: Patch) => api<HouseholdSettingView>("/settings", { method: "PATCH", body: patch }),
    onSuccess: (view) => {
      qc.setQueryData(["settings"], view);
      setForm(fromView(view));
      setDirty(false);
      setSaved(true);
      for (const queryKey of DEPENDENT_KEYS) void qc.invalidateQueries({ queryKey });
    },
  });

  const edit = (patch: Partial<Form>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setDirty(true);
    setSaved(false);
    setClientError(null);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form || !settings.data) return;
    const r = buildPatch(form, settings.data);
    if (!r.ok) return setClientError(r.error);
    if (Object.keys(r.patch).length === 0) {
      setDirty(false);
      return;
    }
    setClientError(null);
    save.mutate(r.patch);
  };

  const candidates = (accounts.data ?? []).filter((a) => a.onBudget && !a.closed);
  const current = settings.data;
  const primaryMissing = form !== null && form.primaryAccountId !== "" && accounts.data !== undefined && !candidates.some((a) => a.id === form.primaryAccountId);
  const tzKnown = form === null || form.timezone.trim() === "" || zoneKnownHere(form.timezone.trim());
  const tzToday = form && tzKnown && form.timezone.trim() !== "" ? localDateInTimeZone(new Date(), form.timezone.trim()) : null;

  return (
    <>
      <h1>Settings</h1>
      <ErrorText error={settings.error} />
      <ErrorText error={accounts.error} />
      {!form && settings.isLoading && <p className="muted">Loading…</p>}
      {form && current && (
        <form className="settings-form" onSubmit={submit}>
          <Card title="Spending plan">
            <div className="settings-fields">
              <label>
                Plan start month
                <input type="month" value={form.planStartMonth} onChange={(e) => edit({ planStartMonth: e.target.value })} required />
                <span className="muted small">Rollovers are computed from this month forward; nothing earlier is carried in.</span>
              </label>
              <label className="inline settings-check">
                <input type="checkbox" checked={form.zeroBased} onChange={(e) => edit({ zeroBased: e.target.checked })} /> Zero-based: show "to assign" (income minus everything planned) instead of "left to spend"
              </label>
            </div>
          </Card>
          <Card title="Cash flow">
            <div className="settings-fields">
              <label>
                Low-balance threshold
                <input inputMode="decimal" value={form.threshold} onChange={(e) => edit({ threshold: e.target.value })} placeholder="500.00" />
                <span className="muted small">
                  Checking and savings accounts without their own threshold warn below this line (currently {money(current.lowBalanceThresholdCents)}). Per-account thresholds are set on the Accounts
                  page.
                </span>
              </label>
              <label>
                Primary account
                <select value={form.primaryAccountId} onChange={(e) => edit({ primaryAccountId: e.target.value })}>
                  <option value="">— none (first checking account) —</option>
                  {candidates.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({titleCase(a.type)})
                    </option>
                  ))}
                  {primaryMissing && <option value={form.primaryAccountId}>(current: not an on-budget open account)</option>}
                </select>
                <span className="muted small">Planned spending that cannot be attributed to an account is drawn from here.</span>
              </label>
              <label>
                Default projection horizon (days)
                <span className="row wrap">
                  <input type="number" min={1} max={366} step={1} value={form.projectionDefaultDays} onChange={(e) => edit({ projectionDefaultDays: e.target.value })} required />
                  {HORIZON_PRESETS.map((d) => (
                    <button key={d} type="button" className="link small" onClick={() => edit({ projectionDefaultDays: String(d) })}>
                      {d}
                    </button>
                  ))}
                </span>
              </label>
            </div>
          </Card>
          <Card title="Household">
            <div className="settings-fields">
              <label>
                Time zone
                <input list="settings-zones" value={form.timezone} onChange={(e) => edit({ timezone: e.target.value })} placeholder="America/Denver" required autoComplete="off" spellCheck={false} />
                <datalist id="settings-zones">
                  {zones.map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
                <span className="muted small">
                  An IANA name such as America/Denver. Nightly jobs and "today" use it.
                  {tzToday ? ` Today there is ${tzToday}.` : ""}
                  {!tzKnown ? " This browser does not recognise that zone; the server will say whether it is valid." : ""}
                </span>
              </label>
            </div>
          </Card>
          <div className="row wrap settings-actions">
            <button type="submit" disabled={!dirty || save.isPending}>
              {save.isPending ? "Saving…" : "Save settings"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!dirty || save.isPending}
              onClick={() => {
                setForm(fromView(current));
                setDirty(false);
                setClientError(null);
              }}
            >
              Discard changes
            </button>
            {saved && !dirty && <span className="notice">Saved.</span>}
            <span className="muted small">Last changed {new Date(current.updatedAt).toLocaleString()}</span>
          </div>
          {clientError && <ErrorText error={new Error(clientError)} />}
          <ErrorText error={save.error} />
        </form>
      )}
    </>
  );
}
