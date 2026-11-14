import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuditList, CategoryView, RuleView } from "@meridian/shared";
import { api, query } from "../lib/api.js";
import { money, relativeTime } from "../lib/format.js";
import {
  buildRule,
  describeRuleEntry,
  emptyRuleForm,
  revertPlan,
  ruleAccountOptions,
  ruleCategoryOptions,
  ruleFormFrom,
  STRING_OPS,
  type RevertStep,
  type RuleForm,
  type StringField,
} from "../lib/rulesForm.js";
import { Badge, Card, Empty, ErrorText } from "../components/ui.js";
import { useIsViewer } from "../components/investments/queries.js";
import "./RulesPage.css";

function describeConditions(c: RuleView["conditions"], accounts: Map<string, string>): string {
  const parts: string[] = [];
  const op = (o: string) => STRING_OPS.find(([k]) => k === o)?.[1] ?? o;
  if (c.payee) parts.push(`payee ${op(c.payee.op)} "${c.payee.value}"`);
  if (c.description) parts.push(`description ${op(c.description.op)} "${c.description.value}"`);
  if (c.amount) parts.push(`amount ${c.amount.minCents !== undefined ? money(c.amount.minCents) : "…"} to ${c.amount.maxCents !== undefined ? money(c.amount.maxCents) : "…"}`);
  if (c.accountId) parts.push(`account ${accounts.get(c.accountId) ?? "(removed)"}`);
  if (c.dayOfMonth) parts.push(`day ${c.dayOfMonth.min}–${c.dayOfMonth.max}`);
  return parts.join(" and ");
}

function describeActions(a: RuleView["actions"], categories: Map<string, string>): string {
  const parts: string[] = [];
  if (a.setPayee) parts.push(`payee → ${a.setPayee}`);
  if (a.setCategoryId !== undefined) parts.push(`category → ${a.setCategoryId ? (categories.get(a.setCategoryId) ?? "(deleted category: sets nothing)") : "none"}`);
  if (a.addTags?.length) parts.push(`tags +${a.addTags.join(", +")}`);
  if (a.markTransfer !== undefined) parts.push(a.markTransfer ? "mark transfer" : "not a transfer");
  if (a.stop) parts.push("stop");
  return parts.join(", ");
}

function StringCondition({ label, field, onChange }: { label: string; field: StringField; onChange: (f: StringField) => void }) {
  return (
    <div className="row wrap">
      <span className="rule-label">{label}</span>
      <select value={field.op} onChange={(e) => onChange({ ...field, op: e.target.value as StringField["op"] })} aria-label={`${label} match`}>
        {STRING_OPS.map(([op, text]) => (
          <option key={op} value={op}>
            {text}
          </option>
        ))}
      </select>
      <input value={field.value} onChange={(e) => onChange({ ...field, value: e.target.value })} aria-label={`${label} text`} placeholder={field.op === "regex" ? "pattern (RE2: no look-ahead or back-references)" : "text"} maxLength={500} />
      <label className="inline small">
        <input type="checkbox" checked={field.caseSensitive} onChange={(e) => onChange({ ...field, caseSensitive: e.target.checked })} /> match case
      </label>
    </div>
  );
}

/** Create or edit a rule with every condition and action (audit a6-text-rules-accounts-13). */
function RuleEditor({
  initial,
  creating,
  categories,
  accounts,
  pending,
  error,
  onSave,
  onClose,
}: {
  initial: RuleForm;
  creating: boolean;
  categories: CategoryView[];
  accounts: Array<{ id: string; name: string; closed: boolean }>;
  pending: boolean;
  error: unknown;
  onSave: (built: Extract<ReturnType<typeof buildRule>, { ok: true }>, applyTo: "none" | "uncategorized" | "all") => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<RuleForm>(initial);
  const [applyTo, setApplyTo] = useState<"none" | "uncategorized" | "all">("uncategorized");
  const [clientError, setClientError] = useState<string | null>(null);
  const set = (patch: Partial<RuleForm>) => setForm({ ...form, ...patch });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const built = buildRule(form);
    if (!built.ok) return setClientError(built.error);
    setClientError(null);
    onSave(built, applyTo);
  };
  return (
    <form className="rule-editor" onSubmit={submit}>
      <label>
        Name <input value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={100} placeholder="(optional)" />
      </label>
      <fieldset>
        <legend>When every one of these holds</legend>
        <StringCondition label="Payee" field={form.payee} onChange={(payee) => set({ payee })} />
        <StringCondition label="Description" field={form.description} onChange={(description) => set({ description })} />
        <div className="row wrap">
          <span className="rule-label">Amount</span>
          <input inputMode="decimal" value={form.minAmount} onChange={(e) => set({ minAmount: e.target.value })} placeholder="from (e.g. -100.00)" aria-label="Smallest amount" />
          <input inputMode="decimal" value={form.maxAmount} onChange={(e) => set({ maxAmount: e.target.value })} placeholder="to (e.g. -20.00)" aria-label="Largest amount" />
          <span className="muted small">Spending is negative.</span>
        </div>
        <div className="row wrap">
          <span className="rule-label">Account</span>
          <select value={form.accountId} onChange={(e) => set({ accountId: e.target.value })} aria-label="Account">
            <option value="">any account</option>
            {/* The rule's own account stays listed when it is closed (audit a8-ledger-ui-08). */}
            {ruleAccountOptions(accounts, initial.accountId).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="row wrap">
          <span className="rule-label">Day of month</span>
          <input type="number" min={1} max={31} value={form.dayMin} onChange={(e) => set({ dayMin: e.target.value })} aria-label="First day" />
          <input type="number" min={1} max={31} value={form.dayMax} onChange={(e) => set({ dayMax: e.target.value })} aria-label="Last day" />
          <span className="muted small">28 to 3 spans the month end; 31 means the last day of every month.</span>
        </div>
      </fieldset>
      <fieldset>
        <legend>Then</legend>
        <div className="row wrap">
          <span className="rule-label">Set payee</span>
          <input value={form.setPayee} onChange={(e) => set({ setPayee: e.target.value })} maxLength={200} aria-label="Set payee" />
        </div>
        <div className="row wrap">
          <span className="rule-label">Category</span>
          <select value={form.setCategory} onChange={(e) => set({ setCategory: e.target.value })} aria-label="Set category">
            <option value="">leave as it is</option>
            <option value="none">clear the category</option>
            {/* The rule's own category stays listed when it is hidden or gone (audit a8-ledger-ui-08). */}
            {ruleCategoryOptions(categories, initial.setCategory).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="row wrap">
          <span className="rule-label">Add tags</span>
          <input value={form.addTags} onChange={(e) => set({ addTags: e.target.value })} placeholder="trip, house" aria-label="Add tags" />
        </div>
        <div className="row wrap">
          <span className="rule-label">Transfer</span>
          <select value={form.markTransfer} onChange={(e) => set({ markTransfer: e.target.value as RuleForm["markTransfer"] })} aria-label="Transfer">
            <option value="">leave as it is</option>
            <option value="yes">mark as a transfer</option>
            <option value="no">not a transfer</option>
          </select>
          <label className="inline small">
            <input type="checkbox" checked={form.stop} onChange={(e) => set({ stop: e.target.checked })} /> stop: no later rule runs on a match
          </label>
        </div>
      </fieldset>
      {creating && (
        <label>
          Run it now on{" "}
          <select value={applyTo} onChange={(e) => setApplyTo(e.target.value as typeof applyTo)}>
            <option value="uncategorized">uncategorized transactions</option>
            <option value="all">all transactions (hand-picked categories stay)</option>
            <option value="none">nothing: only new imports</option>
          </select>
        </label>
      )}
      <span className="row">
        <button type="submit" disabled={pending}>
          {creating ? "Create rule" : "Save rule"}
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

export function RulesPage() {
  const qc = useQueryClient();
  const viewer = useIsViewer();
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => api<RuleView[]>("/rules") });
  const categories = useQuery({ queryKey: ["categories"], queryFn: () => api<CategoryView[]>("/categories") });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<Array<{ id: string; name: string; closed: boolean }>>("/accounts") });
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const history = useQuery({ queryKey: ["audit", "rule", historyCursor], queryFn: () => api<AuditList>(`/audit${query({ entity: "rule", limit: 30, ...(historyCursor ? { cursor: historyCursor } : {}) })}`) });
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["rules"] });
    void qc.invalidateQueries({ queryKey: ["audit", "rule"] });
    void qc.invalidateQueries({ queryKey: ["transactions"] });
  };
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) => api(`/rules/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      setEditing(null);
      invalidate();
    },
  });
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ applied: { examined: number; changed: number } }>("/rules", { method: "POST", body }),
    onSuccess: (r) => {
      setEditing(null);
      setNotice(`Rule created; it changed ${r.applied.changed} of ${r.applied.examined} transactions.`);
      invalidate();
    },
  });
  // Audit a8-ledger-ui-07: enable and disable have their own mutation, so a failure shows on the page, not only in an open editor.
  const toggle = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api(`/rules/${id}`, { method: "PATCH", body: { enabled } }), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => api(`/rules/${id}`, { method: "DELETE" }), onSuccess: invalidate });
  const reorder = useMutation({ mutationFn: (ids: string[]) => api("/rules/reorder", { method: "POST", body: { ids } }), onSuccess: invalidate });
  const run = useMutation({
    mutationFn: (scope: "uncategorized" | "all") => api<{ examined: number; changed: number }>("/rules/run", { method: "POST", body: { scope } }),
    onSuccess: invalidate,
  });
  const revert = useMutation({
    mutationFn: async (steps: RevertStep[]) => {
      for (const step of steps) {
        if (step.kind === "patch") await api(`/rules/${step.id}`, { method: "PATCH", body: step.body });
        else if (step.kind === "reorder") await api("/rules/reorder", { method: "POST", body: { ids: step.ids } });
        else if (step.kind === "delete") await api(`/rules/${step.id}`, { method: "DELETE" });
        else await api("/rules", { method: "POST", body: step.body });
      }
    },
    onSuccess: () => {
      setNotice("Reverted. The change is in the history too, so it can be undone the same way.");
      invalidate();
    },
  });

  const catNames = new Map((categories.data ?? []).map((c) => [c.id, c.name]));
  const acctNames = new Map((accounts.data ?? []).map((a) => [a.id, a.name]));
  const list = rules.data ?? [];
  const move = (index: number, delta: number) => {
    const ids = list.map((r) => r.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    reorder.mutate(ids);
  };
  const editorFor = (r: RuleView | null) => (
    <RuleEditor
      key={r?.id ?? "new"}
      initial={r ? ruleFormFrom(r) : emptyRuleForm()}
      creating={r === null}
      categories={categories.data ?? []}
      accounts={accounts.data ?? []}
      pending={create.isPending || update.isPending}
      error={r ? update.error : create.error}
      onSave={(built, applyTo) => (r ? update.mutate({ id: r.id, name: built.name, conditions: built.conditions, actions: built.actions }) : create.mutate({ name: built.name, conditions: built.conditions, actions: built.actions, applyTo }))}
      onClose={() => {
        create.reset();
        update.reset();
        setEditing(null);
      }}
    />
  );

  return (
    <>
      <div className="row space wrap">
        <h1>Rules</h1>
        <div className="row wrap">
          {!viewer && (
            <button onClick={() => setEditing(editing === "new" ? null : "new")} aria-expanded={editing === "new"}>
              New rule
            </button>
          )}
          <button className="secondary" onClick={() => run.mutate("uncategorized")} disabled={run.isPending || viewer}>
            Run on uncategorized
          </button>
          <button className="secondary" onClick={() => run.mutate("all")} disabled={run.isPending || viewer} title="Hand-picked categories are never overwritten">
            Run on all
          </button>
        </div>
      </div>
      {run.data && (
        <p className="notice">
          Examined {run.data.examined}, changed {run.data.changed}.
        </p>
      )}
      {notice && <p className="notice">{notice}</p>}
      <ErrorText error={rules.error} />
      <ErrorText error={toggle.error} />
      <ErrorText error={run.error} />
      <ErrorText error={remove.error} />
      <ErrorText error={reorder.error} />
      <ErrorText error={revert.error} />
      {editing === "new" && <Card title="New rule">{editorFor(null)}</Card>}
      <Card>
        <p className="muted">
          Rules run in order on every import. Later rules override earlier ones for the same field; tags accumulate. A payee condition also matches the names merged into a
          payee. The register's "always do this" writes a rule too.
        </p>
        {/* Audit a8-ledger-ui-06: only a loaded list can be empty. */}
        {rules.isPending && <p className="muted">Loading rules…</p>}
        {rules.data !== undefined && list.length === 0 && <Empty>No rules yet.</Empty>}
        {list.length > 0 && (
          <div className="scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>When</th>
                  <th>Then</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((r, i) => (
                  <RuleRow key={r.id}>
                    <tr className={r.enabled ? "" : "muted"}>
                      <td>{r.position}</td>
                      <td>
                        {r.name || <span className="muted">(unnamed)</span>} {!r.enabled && <Badge tone="neutral">off</Badge>}
                      </td>
                      <td className="small">{describeConditions(r.conditions, acctNames)}</td>
                      <td className="small">{describeActions(r.actions, catNames)}</td>
                      <td className="nowrap">
                        {!viewer && (
                          <>
                            <button className="link" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${r.name || "rule"} up`}>
                              ↑
                            </button>
                            <button className="link" onClick={() => move(i, 1)} disabled={i === list.length - 1} aria-label={`Move ${r.name || "rule"} down`}>
                              ↓
                            </button>
                            <button className="link" onClick={() => setEditing(editing === r.id ? null : r.id)} aria-expanded={editing === r.id}>
                              edit
                            </button>
                            <button className="link" onClick={() => toggle.mutate({ id: r.id, enabled: !r.enabled })} disabled={toggle.isPending}>
                              {r.enabled ? "disable" : "enable"}
                            </button>
                            <button
                              className="link danger"
                              onClick={() => {
                                if (window.confirm(`Delete the rule ${r.name ? `"${r.name}"` : `#${r.position}`}? It can be restored from the history below.`)) remove.mutate(r.id);
                              }}
                            >
                              delete
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                    {editing === r.id && (
                      <tr>
                        <td colSpan={5}>{editorFor(r)}</td>
                      </tr>
                    )}
                  </RuleRow>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="History">
        <p className="muted small">Every change to a rule is kept. Revert sends the earlier state back; a deleted rule comes back at its old place and does not run over existing transactions.</p>
        <ErrorText error={history.error} />
        {history.data && history.data.items.length === 0 && <Empty>No changes yet.</Empty>}
        {history.data && history.data.items.length > 0 && (
          <ul className="rule-history">
            {history.data.items.map((entry) => {
              // Audit a8-ledger-ui-06: a revert is planned against the rules as they are, so not before they have loaded.
              const plan = rules.data !== undefined ? revertPlan(entry, rules.data) : null;
              return (
                <li key={entry.id} className="row wrap">
                  <span className="muted small" title={entry.at}>
                    {relativeTime(entry.at)}
                    {entry.username ? ` · ${entry.username}` : ""}
                  </span>
                  <span>{describeRuleEntry(entry)}</span>
                  {!viewer &&
                    plan !== null &&
                    (plan.ok ? (
                      <button className="link small" disabled={revert.isPending} onClick={() => revert.mutate(plan.steps)}>
                        revert
                      </button>
                    ) : (
                      <span className="muted small">{plan.reason}</span>
                    ))}
                </li>
              );
            })}
          </ul>
        )}
        <div className="row">
          {historyCursor && (
            <button className="link small" onClick={() => setHistoryCursor(null)}>
              newest
            </button>
          )}
          {history.data?.nextCursor && (
            <button className="link small" onClick={() => setHistoryCursor(history.data!.nextCursor)}>
              older…
            </button>
          )}
        </div>
      </Card>
    </>
  );
}

/** A keyed fragment: a rule's row and its editor row are siblings in the tbody. */
function RuleRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
