import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PayeeList, TransactionView } from "@meridian/shared";
import { api, query } from "../../lib/api.js";
import { useDebounced } from "../../lib/useDebounced.js";
import { NOTES_MAX, PAYEE_MAX, transactionEditBody, transactionEditForm, type TransactionEditBody, type TransactionEditForm } from "../../lib/register.js";
import { ErrorText } from "../ui.js";

/**
 * A row's payee, notes and tags (audit a8-ledger-ui-04): the fields the household owns, which a
 * sync never overwrites (phase 1 plan, sync step 4). The payee field suggests existing payees;
 * a name that is new creates a payee, and a payee set here is locked against rules.
 */
export function TransactionEditor({ transaction: t, pending, error, onSave }: { transaction: TransactionView; pending: boolean; error: unknown; onSave: (body: TransactionEditBody) => void }) {
  const [form, setForm] = useState<TransactionEditForm>(() => transactionEditForm(t));
  const [problem, setProblem] = useState<string | null>(null);
  const typed = useDebounced(form.payee.trim(), 250);
  const suggestions = useQuery({
    queryKey: ["payees", "suggest", typed],
    queryFn: () => api<PayeeList>(`/payees${query({ q: typed, limit: 20 })}`),
    enabled: typed.length >= 2 && typed !== (t.payeeName ?? ""),
  });
  const listId = `payees-${t.id}`;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const built = transactionEditBody(t, form);
    if (!built.ok) return setProblem(built.error);
    setProblem(null);
    if (Object.keys(built.body).length === 0) return setProblem("Nothing changed");
    onSave(built.body);
  };
  return (
    <form className="txn-editor" onSubmit={submit}>
      <strong className="small">Payee, notes and tags</strong>
      <label>
        Payee
        <input value={form.payee} onChange={(e) => setForm({ ...form, payee: e.target.value })} list={listId} maxLength={PAYEE_MAX} />
        <datalist id={listId}>
          {(suggestions.data?.items ?? []).map((p) => (
            <option key={p.id} value={p.name} />
          ))}
        </datalist>
      </label>
      <label>
        Tags
        <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="trip, house project" />
        <span className="muted small">Separated by commas.</span>
      </label>
      <label>
        Notes
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={NOTES_MAX} rows={2} />
      </label>
      <span className="row">
        <button type="submit" disabled={pending}>
          Save
        </button>
      </span>
      {problem && <p className="error">{problem}</p>}
      <ErrorText error={error} />
    </form>
  );
}
