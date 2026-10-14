import { useState, type FormEvent } from "react";
import { Cadence, type AccountView, type Bucket, type CategoryView, type PayeeView, type RecurringView } from "@meridian/shared";
import { ErrorText } from "../ui.js";
import { CADENCE_LABELS, MONTH_NAMES, expectedLabel, scheduleSummary } from "./recurringFormat.js";
import { createBodyFromForm, emptyForm, formFromItem, type CreateBody, type RecurringFormState, type UpdateBody, updateBodyFromForm } from "./recurringForm.js";

const BUCKETS: Array<[Bucket, string]> = [
  ["bills", "Bills"],
  ["income", "Income"],
  ["savings", "Savings"],
  ["spending", "Spending"],
];

interface BaseProps {
  categories: CategoryView[];
  accounts: AccountView[];
  /** Existing payees for the datalist on the manual form. */
  payees?: PayeeView[] | undefined;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
}

type Props = BaseProps &
  (
    | { mode: "create"; onSubmit: (body: CreateBody) => void }
    | {
        /** `confirm` activates a suggestion (or re-activates a dismissed/cancelled item): the category becomes required and `status: 'active'` is sent. */
        mode: "edit" | "confirm";
        item: RecurringView;
        onSubmit: (body: UpdateBody) => void;
      }
  );

export function RecurringForm(props: Props) {
  const { categories, accounts, pending, error, onCancel } = props;
  const [form, setForm] = useState<RecurringFormState>(() => (props.mode === "create" ? emptyForm() : formFromItem(props.item)));
  const [showDetails, setShowDetails] = useState(props.mode !== "confirm");
  const [formError, setFormError] = useState<string | null>(null);
  const set = <K extends keyof RecurringFormState>(key: K, value: RecurringFormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (props.mode === "create") {
      const res = createBodyFromForm(form);
      if (!res.ok) return setFormError(res.error);
      props.onSubmit(res.value);
      return;
    }
    const res = updateBodyFromForm(form, props.item, props.mode === "confirm" ? "active" : undefined);
    if (!res.ok) return setFormError(res.error);
    if (Object.keys(res.value).length === 0) return onCancel();
    props.onSubmit(res.value);
  };

  const item = props.mode === "create" ? null : props.item;
  const submitLabel = props.mode === "create" ? "Add recurring" : props.mode === "confirm" ? (item?.status === "suggested" ? "Confirm" : "Reactivate") : "Save changes";
  const visibleCategories = categories.filter((c) => !c.hidden || c.id === form.categoryId);
  const visibleAccounts = accounts.filter((a) => !a.closed || a.id === form.accountId || a.id === form.transferAccountId);

  return (
    <form className="rec-form" onSubmit={submit}>
      <div className="rec-form-grid">
        <label>
          Name
          <input value={form.name} onChange={(e) => set("name", e.target.value)} required maxLength={200} />
        </label>
        {props.mode === "create" ? (
          <label>
            Payee <span className="muted small">(as the bank names it; defaults to the name)</span>
            <input value={form.payeeName} onChange={(e) => set("payeeName", e.target.value)} list="rec-payees" maxLength={200} />
            {props.payees && (
              <datalist id="rec-payees">
                {props.payees.map((p) => (
                  <option key={p.id} value={p.name} />
                ))}
              </datalist>
            )}
          </label>
        ) : (
          <label>
            Payee
            <input value={form.payeeName} readOnly disabled />
          </label>
        )}
        <label>
          Category{props.mode === "confirm" && <span className="muted small"> (required)</span>}
          <select value={form.categoryId} onChange={(e) => set("categoryId", e.target.value)} className={form.categoryId ? "" : "unset"}>
            <option value="">— choose a category —</option>
            {BUCKETS.map(([bucket, label]) => {
              const rows = visibleCategories.filter((c) => c.bucket === bucket);
              if (rows.length === 0) return null;
              return (
                <optgroup key={bucket} label={label}>
                  {rows.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </label>
        <label>
          Account
          <select value={form.accountId} onChange={(e) => set("accountId", e.target.value)} className={form.accountId ? "" : "unset"}>
            <option value="">— choose an account —</option>
            {visibleAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Transfer to / from <span className="muted small">(optional: makes it a transfer)</span>
          <select value={form.transferAccountId} onChange={(e) => set("transferAccountId", e.target.value)}>
            <option value="">— not a transfer —</option>
            {visibleAccounts
              .filter((a) => a.id !== form.accountId)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
      </div>

      {!showDetails && item && (
        <p className="rec-form-summary">
          {scheduleSummary(item)} · {expectedLabel(item)} {item.expectedCents.startsWith("-") ? "out" : "in"}
          <button type="button" className="link small" onClick={() => setShowDetails(true)}>
            Adjust schedule or amount
          </button>
        </p>
      )}

      {showDetails && (
        <>
          <div className="rec-form-grid">
            <label>
              Repeats
              <select value={form.cadence} onChange={(e) => set("cadence", e.target.value as Cadence)}>
                {Cadence.options.map((c) => (
                  <option key={c} value={c}>
                    {CADENCE_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
            {(form.cadence === "weekly" || form.cadence === "biweekly") && (
              <label>
                Date of one charge <span className="muted small">(later ones follow every {form.cadence === "weekly" ? 7 : 14} days)</span>
                <input type="date" value={form.anchorDate} onChange={(e) => set("anchorDate", e.target.value)} />
              </label>
            )}
            {form.cadence === "twice_monthly" && (
              <>
                <label>
                  First day of month
                  <input type="number" min={1} max={31} value={form.anchorDay} onChange={(e) => set("anchorDay", e.target.value)} inputMode="numeric" />
                </label>
                <label>
                  Second day <span className="muted small">(31 = last day)</span>
                  <input type="number" min={1} max={31} value={form.anchorDay2} onChange={(e) => set("anchorDay2", e.target.value)} inputMode="numeric" />
                </label>
              </>
            )}
            {form.cadence !== "weekly" && form.cadence !== "biweekly" && form.cadence !== "twice_monthly" && (
              <label>
                Day of month <span className="muted small">(31 = last day)</span>
                <input type="number" min={1} max={31} value={form.anchorDay} onChange={(e) => set("anchorDay", e.target.value)} inputMode="numeric" />
              </label>
            )}
            {(form.cadence === "bimonthly" || form.cadence === "quarterly" || form.cadence === "semiannual" || form.cadence === "yearly") && (
              <label>
                {form.cadence === "yearly" ? "Month" : "One month it falls in"}
                <select value={form.anchorMonth} onChange={(e) => set("anchorMonth", e.target.value)} className={form.anchorMonth ? "" : "unset"}>
                  <option value="">— month —</option>
                  {MONTH_NAMES.map((m, i) => (
                    <option key={m} value={String(i + 1)}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="rec-form-grid">
            <label>
              Direction
              <select value={form.direction} onChange={(e) => set("direction", e.target.value as RecurringFormState["direction"])}>
                <option value="outflow">Money out (bill, subscription)</option>
                <option value="inflow">Money in (paycheck, income)</option>
              </select>
            </label>
            <label>
              Amount
              <input value={form.amount} onChange={(e) => set("amount", e.target.value)} inputMode="decimal" placeholder="15.49" required />
            </label>
            <label>
              Amount is
              <select value={form.amountMode} onChange={(e) => set("amountMode", e.target.value as RecurringFormState["amountMode"])}>
                <option value="fixed">Fixed (alert on price increases)</option>
                <option value="variable">Variable (utilities; no price alerts)</option>
              </select>
            </label>
            <label>
              Tolerance ± <span className="muted small">{props.mode === "create" ? "(blank: $1 or 1%)" : "(blank: unchanged)"}</span>
              <input value={form.tolerance} onChange={(e) => set("tolerance", e.target.value)} inputMode="decimal" placeholder="1.00" />
            </label>
          </div>
          <label>
            Notes
            <textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} maxLength={2000} />
          </label>
          {item && (item.amountLocked || item.scheduleLocked) && (
            <p className="muted small">
              {item.scheduleLocked && "The schedule is locked to your edits; the detector will not move it. "}
              {item.amountLocked && "The amount is locked to your edits; new charges will not change it."}
            </p>
          )}
          {item && !(item.amountLocked && item.scheduleLocked) && (
            <p className="muted small">Editing the schedule or the amount locks that part to your values; the detector keeps refreshing the rest.</p>
          )}
        </>
      )}

      {formError && <p className="error">{formError}</p>}
      <ErrorText error={error} />
      <div className="row">
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
