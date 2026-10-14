import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AccountType, TaxTreatment, formatCents, parseDecimalToCents, type AccountView } from "@meridian/shared";
import { api } from "../lib/api.js";
import { money, shortDate, titleCase } from "../lib/format.js";
import { Badge, Card, Empty, ErrorText } from "../components/ui.js";
import "./AccountsPage.css";

const GROUPS: Array<[string, AccountView["type"][]]> = [
  ["Cash", ["checking", "savings"]],
  ["Credit and loans", ["credit", "loan"]],
  ["Investments", ["brokerage", "401k", "ira", "roth", "hsa", "529"]],
  ["Other assets", ["asset"]],
];

const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

function sum(accounts: AccountView[]): string {
  return accounts.reduce((acc, a) => acc + (a.balanceCents ? BigInt(a.balanceCents) : 0n), 0n).toString();
}

/** Wire shape of the cash-flow fields on PATCH /accounts/:id (UpdateAccountBody). */
interface CashFlowPatch {
  lowBalanceThresholdCents?: string | null;
  paymentDay?: number | null;
  paymentFromAccountId?: string | null;
  statementDay?: number | null;
}

interface EditorForm {
  threshold: string;
  paymentDay: string;
  paymentFromAccountId: string;
  statementDay: string;
}

function editorForm(a: AccountView): EditorForm {
  return {
    threshold: a.lowBalanceThresholdCents === null ? "" : formatCents(BigInt(a.lowBalanceThresholdCents)),
    paymentDay: a.paymentDay === null ? "" : String(a.paymentDay),
    paymentFromAccountId: a.paymentFromAccountId ?? "",
    statementDay: a.statementDay === null ? "" : String(a.statementDay),
  };
}

/** Only the fields that changed; payment day and paying account always travel together (the API requires it). */
function buildCashFlowPatch(form: EditorForm, a: AccountView): { ok: true; patch: CashFlowPatch } | { ok: false; error: string } {
  const patch: CashFlowPatch = {};
  const raw = form.threshold.replace(/[$,\s]/g, "");
  let threshold: string | null = null;
  if (raw !== "") {
    try {
      threshold = parseDecimalToCents(raw).toString();
    } catch {
      return { ok: false, error: "The threshold is not an amount" };
    }
  }
  if (threshold !== a.lowBalanceThresholdCents) patch.lowBalanceThresholdCents = threshold;
  if (a.type === "credit") {
    const day = form.paymentDay === "" ? null : Number(form.paymentDay);
    const from = form.paymentFromAccountId === "" ? null : form.paymentFromAccountId;
    if ((day === null) !== (from === null)) return { ok: false, error: "Set the payment day and the paying account together, or clear both" };
    if (day !== a.paymentDay || from !== a.paymentFromAccountId) {
      patch.paymentDay = day;
      patch.paymentFromAccountId = from;
    }
    const statement = form.statementDay === "" ? null : Number(form.statementDay);
    if (statement !== a.statementDay) patch.statementDay = statement;
  }
  return { ok: true, patch };
}

/** One line under the account: its threshold and, for a card, how it is paid in the projection. */
function cashFlowSummary(a: AccountView, nameOf: (id: string) => string): string {
  const parts: string[] = [];
  if (a.lowBalanceThresholdCents !== null) parts.push(`alert below ${money(a.lowBalanceThresholdCents)}`);
  else if (a.type === "checking" || a.type === "savings") parts.push("household threshold");
  if (a.type === "credit") {
    if (a.paymentDay !== null && a.paymentFromAccountId !== null) {
      parts.push(`paid on day ${a.paymentDay} from ${nameOf(a.paymentFromAccountId)}${a.statementDay !== null ? `, closes day ${a.statementDay}` : ""}`);
    } else parts.push("no payment day");
  }
  return parts.join(" · ") || "no threshold";
}

function CashFlowEditor({ account, accounts, pending, error, onSave, onClose }: { account: AccountView; accounts: AccountView[]; pending: boolean; error: unknown; onSave: (patch: CashFlowPatch) => void; onClose: () => void }) {
  const [form, setForm] = useState<EditorForm>(() => editorForm(account));
  const [clientError, setClientError] = useState<string | null>(null);
  const payers = accounts.filter((x) => x.id !== account.id && x.onBudget && !x.closed && (x.type === "checking" || x.type === "savings"));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = buildCashFlowPatch(form, account);
    if (!r.ok) return setClientError(r.error);
    setClientError(null);
    if (Object.keys(r.patch).length === 0) return onClose();
    onSave(r.patch);
  };
  const inherits = account.type === "checking" || account.type === "savings";
  return (
    <form className="acct-form" onSubmit={submit}>
      <label>
        Low-balance threshold
        <input inputMode="decimal" placeholder={inherits ? "household default" : "none"} value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} />
        <span className="muted small">{inherits ? "Blank uses the household threshold from Settings." : "Blank means no low-balance warning for this account."}</span>
      </label>
      {account.type === "credit" && (
        <>
          <label>
            Payment day
            <select value={form.paymentDay} onChange={(e) => setForm({ ...form, paymentDay: e.target.value })}>
              <option value="">— not modeled —</option>
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <span className="muted small">The projection pays the statement balance on this day each month.</span>
          </label>
          <label>
            Paid from
            <select value={form.paymentFromAccountId} onChange={(e) => setForm({ ...form, paymentFromAccountId: e.target.value })}>
              <option value="">— choose an account —</option>
              {payers.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            <span className="muted small">An on-budget checking or savings account.</span>
          </label>
          <label>
            Statement closes on day
            <select value={form.statementDay} onChange={(e) => setForm({ ...form, statementDay: e.target.value })}>
              <option value="">— day before payment —</option>
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <span className="row acct-form-actions">
        <button type="submit" disabled={pending}>
          Save
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
      </span>
      {clientError && <ErrorText error={new Error(clientError)} />}
      <ErrorText error={error} />
    </form>
  );
}

export function AccountsPage() {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<AccountView[]>("/accounts") });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["accounts"] });
    void qc.invalidateQueries({ queryKey: ["cashflow"] });
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
  };
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) => api<AccountView>(`/accounts/${id}`, { method: "PATCH", body }),
    onSuccess: invalidate,
  });
  const saveCashFlow = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & CashFlowPatch) => api<AccountView>(`/accounts/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      setEditing(null);
      invalidate();
    },
  });
  const create = useMutation({
    mutationFn: (body: { name: string; type: string; balanceCents?: string }) => api<AccountView>("/accounts", { method: "POST", body }),
    onSuccess: () => {
      setNewName("");
      setNewBalance("");
      void qc.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
  const [showClosed, setShowClosed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<AccountView["type"]>("checking");
  const [newBalance, setNewBalance] = useState("");

  const all = accounts.data ?? [];
  const visible = all.filter((a) => showClosed || !a.closed);
  const netWorth = sum(visible);
  const nameOf = (id: string): string => all.find((a) => a.id === id)?.name ?? "an account";

  return (
    <>
      <div className="row space">
        <h1>Accounts</h1>
        <div className="row">
          <label className="inline">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> show closed
          </label>
          <strong>Net worth {money(netWorth)}</strong>
        </div>
      </div>
      <ErrorText error={accounts.error} />
      <ErrorText error={update.error} />
      {all.length === 0 && !accounts.isLoading && <Empty>No accounts yet. Connect SimpleFIN or add a manual account below.</Empty>}
      {GROUPS.map(([label, types]) => {
        const rows = visible.filter((a) => types.includes(a.type));
        if (rows.length === 0) return null;
        return (
          <Card key={label} title={label} actions={<strong>{money(sum(rows))}</strong>}>
            <div className="scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Institution</th>
                  <th>Type</th>
                  <th>Tax</th>
                  <th className="num">Balance</th>
                  <th className="num">Available</th>
                  <th>As of</th>
                  <th>Budget</th>
                  <th>Cash flow</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <RowGroup key={a.id}>
                    <tr className={a.closed ? "muted" : ""}>
                      <td>
                        <strong>{a.name}</strong>
                        <div className="muted small">
                          {a.transactionCount} txns{a.connectionName ? ` · ${a.connectionName}` : " · manual"}
                        </div>
                      </td>
                      <td>{a.institution ?? "—"}</td>
                      <td>
                        <select value={a.type} onChange={(e) => update.mutate({ id: a.id, type: e.target.value })}>
                          {AccountType.options.map((t) => (
                            <option key={t} value={t}>
                              {titleCase(t)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select value={a.taxTreatment} onChange={(e) => update.mutate({ id: a.id, taxTreatment: e.target.value })}>
                          {TaxTreatment.options.map((t) => (
                            <option key={t} value={t}>
                              {titleCase(t)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className={`num ${a.balanceCents?.startsWith("-") ? "neg" : ""}`}>{money(a.balanceCents, a.currency)}</td>
                      <td className="num muted">{money(a.availableCents, a.currency)}</td>
                      <td className="muted">{shortDate(a.balanceDate)}</td>
                      <td>
                        <label className="inline">
                          <input type="checkbox" checked={a.onBudget} onChange={(e) => update.mutate({ id: a.id, onBudget: e.target.checked })} /> on budget
                        </label>
                      </td>
                      <td className="acct-cf">
                        <button className="link small" onClick={() => setEditing(editing === a.id ? null : a.id)} aria-expanded={editing === a.id}>
                          {editing === a.id ? "close" : "edit"}
                        </button>
                        <div className="muted small">{cashFlowSummary(a, nameOf)}</div>
                      </td>
                      <td>
                        {a.closed ? (
                          <button className="link" onClick={() => update.mutate({ id: a.id, closed: false })}>
                            Reopen
                          </button>
                        ) : (
                          <button className="link" onClick={() => update.mutate({ id: a.id, closed: true })}>
                            Close
                          </button>
                        )}
                        {a.closed && <Badge tone="neutral">closed</Badge>}
                      </td>
                    </tr>
                    {editing === a.id && (
                      <tr className="acct-editor">
                        <td colSpan={10}>
                          <CashFlowEditor
                            key={a.id}
                            account={a}
                            accounts={all}
                            pending={saveCashFlow.isPending}
                            error={saveCashFlow.error}
                            onSave={(patch) => saveCashFlow.mutate({ id: a.id, ...patch })}
                            onClose={() => {
                              saveCashFlow.reset();
                              setEditing(null);
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </RowGroup>
                ))}
              </tbody>
            </table>
            </div>
          </Card>
        );
      })}
      <Card title="Add a manual account">
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            const cents = newBalance.trim() ? String(Math.round(Number(newBalance) * 100)) : undefined;
            create.mutate({ name: newName.trim(), type: newType, ...(cents !== undefined && !Number.isNaN(Number(cents)) ? { balanceCents: cents } : {}) });
          }}
        >
          <input placeholder="Name (e.g. House, Car loan, Cash)" value={newName} onChange={(e) => setNewName(e.target.value)} required />
          <select value={newType} onChange={(e) => setNewType(e.target.value as AccountView["type"])}>
            {AccountType.options.map((t) => (
              <option key={t} value={t}>
                {titleCase(t)}
              </option>
            ))}
          </select>
          <input placeholder="Balance (e.g. 12500.00)" value={newBalance} onChange={(e) => setNewBalance(e.target.value)} inputMode="decimal" />
          <button type="submit" disabled={create.isPending}>
            Add
          </button>
        </form>
        <ErrorText error={create.error} />
      </Card>
    </>
  );
}

/** A fragment with a key: lets one account render its row and its editor row as siblings in the tbody. */
function RowGroup({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
