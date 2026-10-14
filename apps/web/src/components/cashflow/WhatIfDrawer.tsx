import { useState, type FormEvent } from "react";
import { Badge, Card, ErrorText } from "../ui.js";
import { describeWhatIf, oneTimeFromForm, type NameLookup, type OneTimeForm, type WhatIf, type WhatIfOutcome } from "./whatIfs.js";

interface Props {
  whatIfs: readonly WhatIf[];
  /** The server's verdict per what-if (index-aligned); absent while a request is in flight. */
  outcomes: readonly WhatIfOutcome[] | undefined;
  names: NameLookup;
  accounts: ReadonlyArray<{ id: string; name: string }>;
  today: string;
  onRemove: (index: number) => void;
  onClear: () => void;
  onAdd: (whatIf: WhatIf) => void;
  onClose: () => void;
}

const MAX_WHAT_IFS = 50;

/**
 * The what-if list lives in React state only: nothing here is saved. Each
 * entry shows whether the last projection could apply it (a stale skip after
 * a due date advances is kept visible with the server's reason).
 */
export function WhatIfDrawer({ whatIfs, outcomes, names, accounts, today, onRemove, onClear, onAdd, onClose }: Props) {
  const [form, setForm] = useState<OneTimeForm>({ date: today, accountId: accounts[0]?.id ?? "", amount: "", direction: "expense", label: "" });
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = oneTimeFromForm({ ...form, accountId: form.accountId || (accounts[0]?.id ?? "") });
    if (!r.ok) return setError(r.error);
    setError(null);
    onAdd(r.whatIf);
    setForm((f) => ({ ...f, amount: "", label: "" }));
  };
  const full = whatIfs.length >= MAX_WHAT_IFS;
  return (
    <Card
      title={`What-ifs (${whatIfs.length})`}
      actions={
        <>
          {whatIfs.length > 0 && (
            <button className="link small" onClick={onClear}>
              Clear all
            </button>
          )}
          <button className="link small" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <p className="muted small">Try a change without saving it. Skip or move an event from the table, or add a one-time amount below. Nothing here is stored.</p>
      {whatIfs.length === 0 ? (
        <p className="muted small">No what-ifs yet.</p>
      ) : (
        <ol className="cf-whatifs">
          {whatIfs.map((w, i) => {
            const outcome = outcomes?.[i];
            return (
              <li key={i}>
                <span>{describeWhatIf(w, names)}</span>{" "}
                {outcome && !outcome.applied && <Badge tone="warn">{outcome.reason ?? "not applied"}</Badge>}
                {outcome?.applied && outcome.reason && <Badge tone="info">{outcome.reason}</Badge>}
                <button className="link small danger" onClick={() => onRemove(i)} aria-label="Remove what-if">
                  remove
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <form className="cf-onetime" onSubmit={submit}>
        <strong>Add a one-time amount</strong>
        <label>
          Date
          <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
        </label>
        <label>
          Account
          <select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <label className="grow">
            Amount
            <input inputMode="decimal" placeholder="800.00" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
          </label>
          <label>
            Direction
            <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value as OneTimeForm["direction"] })}>
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </select>
          </label>
        </div>
        <label>
          Label <span className="muted">(optional)</span>
          <input maxLength={100} placeholder="New tires" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </label>
        <button type="submit" disabled={full || accounts.length === 0}>
          Add what-if
        </button>
        {full && <p className="muted small">At most {MAX_WHAT_IFS} what-ifs per projection.</p>}
        {error && <ErrorText error={new Error(error)} />}
      </form>
    </Card>
  );
}
