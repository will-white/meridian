import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { AccountType, TaxTreatment, formatCents, isInvestmentAccountType, type AccountView, type LinkFeedAccountResult } from "@meridian/shared";
import { api, query } from "../lib/api.js";
import { accountTypeLabel, money, shortDate } from "../lib/format.js";
import { lastReconciliationText, positionsMatchText } from "../lib/investmentForms.js";
import { taxTreatmentLabel } from "../lib/investments.js";
import { linkableFeedAccounts, linkConfirmText, linkResultText } from "../lib/ledgerCorrections.js";
import { balanceFieldLabel, closeQuestion, isDebtType, netWorthCents, owedText, parseManualBalance, parseThreshold, reopenNotice, typeChangeQuestion, typeChangeRefusal } from "../lib/accountForms.js";
import { Badge, Card, Empty, ErrorText } from "../components/ui.js";
import { FidelityBadge } from "../components/investments/FidelityBadge.js";
import { useIsViewer } from "../components/investments/queries.js";
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
  // String math, bounded like every amount (audit a8-ledger-ui-14).
  const parsed = parseThreshold(form.threshold);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const threshold = parsed.cents === null ? null : parsed.cents.toString();
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

/**
 * A manual account's balance on a day (audit a6-text-rules-accounts-03): a house revalued, a
 * loan paid down. A card or a loan takes the amount owed (-05); the date is optional (today).
 */
function BalanceEditor({ account, pending, error, onSave, onClose }: { account: AccountView; pending: boolean; error: unknown; onSave: (body: { balanceCents: string; date?: string }) => void; onClose: () => void }) {
  const [amount, setAmount] = useState(() => owedText(account.balanceCents, account.type));
  const [date, setDate] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseManualBalance(amount, account.type);
    if (!parsed.ok) return setClientError(parsed.error);
    if (parsed.cents === null) return setClientError(`Enter the ${balanceFieldLabel(account.type).toLowerCase()}`);
    setClientError(null);
    onSave({ balanceCents: parsed.cents.toString(), ...(date ? { date } : {}) });
  };
  return (
    <form className="acct-form" onSubmit={submit}>
      <label>
        {balanceFieldLabel(account.type)}
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label={`${account.name} ${balanceFieldLabel(account.type).toLowerCase()}`} />
        {isDebtType(account.type) && <span className="muted small">What is owed, as a positive amount; it lowers net worth.</span>}
      </label>
      <label>
        As of
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <span className="muted small">Blank is today. An earlier date goes into the history; the account shows its latest balance.</span>
      </label>
      <span className="row acct-form-actions">
        <button type="submit" disabled={pending}>
          Save balance
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
  const viewer = useIsViewer();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<AccountView[]>("/accounts") });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["accounts"] });
    void qc.invalidateQueries({ queryKey: ["cashflow"] });
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
  };
  const [notice, setNotice] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) => api<AccountView>(`/accounts/${id}`, { method: "PATCH", body }),
    onSuccess: (a, v) => {
      // Audit a8-ledger-ui-02: a reopened feed account's missed transactions are being read again.
      setNotice(v["closed"] === false ? reopenNotice(a) : null);
      invalidate();
      if (v["closed"] === false && a.connectionId !== null) void qc.invalidateQueries({ queryKey: ["connections"] });
    },
  });
  // Audit a8-ledger-ui-01, second round: a type change the API would refuse is said here, never asked and then refused.
  const [typeRefusal, setTypeRefusal] = useState<string | null>(null);
  const changeType = (a: AccountView, next: AccountView["type"]) => {
    const refusal = typeChangeRefusal(a, next);
    setTypeRefusal(refusal);
    if (refusal !== null) return;
    // Audit a8-ledger-ui-01: say what the balance becomes before a hand-entered balance changes sign.
    const question = typeChangeQuestion(a, next);
    if (question !== null && !window.confirm(question)) return;
    update.mutate({ id: a.id, type: next });
  };
  const close = (a: AccountView) => {
    // Audit a8-ledger-ui-02: closing stops a feed account's transactions; it is a deliberate act.
    if (window.confirm(closeQuestion(a))) update.mutate({ id: a.id, closed: true });
  };
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
      invalidate();
    },
  });
  const recordBalance = useMutation({
    mutationFn: ({ id, ...body }: { id: string; balanceCents: string; date?: string }) => api<AccountView>(`/accounts/${id}/balances`, { method: "POST", body }),
    onSuccess: () => {
      setBalanceEditing(null);
      invalidate();
    },
  });
  // Audit a5-ingest-transfers-02: an account without a connection takes over the feed account the sync created for it.
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const link = useMutation({
    mutationFn: (v: { id: string; feedAccountId: string }) => api<LinkFeedAccountResult>(`/accounts/${v.id}/link-feed`, { method: "POST", body: { feedAccountId: v.feedAccountId } }),
    onSuccess: (r) => {
      setLinkNotice(linkResultText(r));
      invalidate();
      void qc.invalidateQueries({ queryKey: ["transactions"] });
    },
  });
  const [showClosed, setShowClosed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<AccountView["type"]>("checking");
  const [newBalance, setNewBalance] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [balanceEditing, setBalanceEditing] = useState<string | null>(null);

  const all = accounts.data ?? [];
  const visible = all.filter((a) => showClosed || !a.closed);
  // Today's net worth leaves closed accounts out whatever is listed (Phase 2 plan A16; audit a8-ledger-ui-17).
  const netWorth = netWorthCents(all);
  const nameOf = (id: string): string => all.find((a) => a.id === id)?.name ?? "an account";

  return (
    <>
      <div className="row space">
        <h1>Accounts</h1>
        <div className="row">
          <label className="inline">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> show closed
          </label>
          {/* A total of accounts that were never loaded is not $0.00 (audit b8-web-layout-13). */}
          {accounts.data !== undefined && <strong>Net worth {money(netWorth)}</strong>}
        </div>
      </div>
      <ErrorText error={accounts.error} />
      <ErrorText error={update.error} />
      {typeRefusal && <ErrorText error={new Error(typeRefusal)} />}
      <ErrorText error={link.error} />
      {accounts.isPending && <p className="muted">Loading accounts…</p>}
      {linkNotice && <p className="notice">{linkNotice}</p>}
      {notice && <p className="notice">{notice}</p>}
      {accounts.data !== undefined && all.length === 0 && <Empty>No accounts yet. Connect SimpleFIN or add a manual account below.</Empty>}
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
                        {!viewer && linkableFeedAccounts(a, all).length > 0 && (
                          <div className="small">
                            <select
                              value=""
                              aria-label={`${a.name} is the same account as a feed account`}
                              title={
                                a.connectionId === null
                                  ? "The bank connection created a second account for this one (it was re-linked, or this account's history came from a CSV): fold that account into this one"
                                  : "The Bridge no longer sends this account: if a re-link gave it a new id, fold the new account into this one"
                              }
                              disabled={link.isPending}
                              onChange={(e) => {
                                const feed = all.find((x) => x.id === e.target.value);
                                if (feed && window.confirm(linkConfirmText(a, feed))) {
                                  link.mutate({ id: a.id, feedAccountId: feed.id });
                                }
                              }}
                            >
                              <option value="">same as a feed account…</option>
                              {linkableFeedAccounts(a, all).map((f) => (
                                <option key={f.id} value={f.id}>
                                  {f.name}
                                  {f.connectionName ? ` (${f.connectionName})` : ""}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        {isInvestmentAccountType(a.type) && <InvestmentBlock a={a} />}
                      </td>
                      <td>{a.institution ?? "—"}</td>
                      <td>
                        {viewer ? (
                          accountTypeLabel(a.type)
                        ) : (
                          <select value={a.type} onChange={(e) => changeType(a, e.target.value as AccountView["type"])} aria-label={`${a.name} type`} disabled={update.isPending}>
                            {AccountType.options.map((t) => (
                              <option key={t} value={t}>
                                {accountTypeLabel(t)}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td>
                        {viewer ? (
                          taxTreatmentLabel(a.taxTreatment)
                        ) : (
                          <select value={a.taxTreatment} onChange={(e) => update.mutate({ id: a.id, taxTreatment: e.target.value })} aria-label={`${a.name} tax treatment`}>
                            {TaxTreatment.options.map((t) => (
                              <option key={t} value={t}>
                                {taxTreatmentLabel(t)}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className={`num ${a.balanceCents?.startsWith("-") ? "neg" : ""}`}>
                        {money(a.balanceCents, a.currency)}
                        {!viewer && a.connectionName === null && !a.closed && (
                          <div className="small">
                            <button className="link small" onClick={() => setBalanceEditing(balanceEditing === a.id ? null : a.id)} aria-expanded={balanceEditing === a.id}>
                              {balanceEditing === a.id ? "close" : "update balance"}
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="num muted">{money(a.availableCents, a.currency)}</td>
                      <td className="muted">{shortDate(a.balanceDate)}</td>
                      <td>
                        {viewer ? (
                          a.onBudget ? "on budget" : "off budget"
                        ) : (
                          <label className="inline">
                            <input type="checkbox" checked={a.onBudget} onChange={(e) => update.mutate({ id: a.id, onBudget: e.target.checked })} /> on budget
                          </label>
                        )}
                        {isInvestmentAccountType(a.type) && a.onBudget && !viewer && (
                          <div className="small">
                            <button type="button" className="link small" onClick={() => update.mutate({ id: a.id, onBudget: false })} disabled={update.isPending} title="Investment accounts are usually off budget: their buys and sells are not spending">
                              move off budget?
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="acct-cf">
                        {!viewer && (
                          <button className="link small" onClick={() => setEditing(editing === a.id ? null : a.id)} aria-expanded={editing === a.id}>
                            {editing === a.id ? "close" : "edit"}
                          </button>
                        )}
                        <div className="muted small">{cashFlowSummary(a, nameOf)}</div>
                      </td>
                      <td>
                        {!viewer &&
                          (a.closed ? (
                            <button className="link" onClick={() => update.mutate({ id: a.id, closed: false })} disabled={update.isPending}>
                              Reopen
                            </button>
                          ) : (
                            <button className="link" onClick={() => close(a)} disabled={update.isPending}>
                              Close
                            </button>
                          ))}
                        {a.closed && <Badge tone="neutral">closed</Badge>}
                      </td>
                    </tr>
                    {balanceEditing === a.id && (
                      <tr className="acct-editor">
                        <td colSpan={10}>
                          <BalanceEditor
                            key={a.id}
                            account={a}
                            pending={recordBalance.isPending}
                            error={recordBalance.error}
                            onSave={(body) => recordBalance.mutate({ id: a.id, ...body })}
                            onClose={() => {
                              recordBalance.reset();
                              setBalanceEditing(null);
                            }}
                          />
                        </td>
                      </tr>
                    )}
                    {editing === a.id && !viewer && (
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
      {!viewer && (
        <Card title="Add a manual account">
          <form
            className="row wrap"
            onSubmit={(e) => {
              e.preventDefault();
              // Integer cents by string math (audit a6-text-rules-accounts-09); a card or a loan takes the amount owed (-05).
              const parsed = parseManualBalance(newBalance, newType);
              if (!parsed.ok) return setCreateError(parsed.error);
              setCreateError(null);
              create.mutate({ name: newName.trim(), type: newType, ...(parsed.cents !== null ? { balanceCents: parsed.cents.toString() } : {}) });
            }}
          >
            <input placeholder="Name (e.g. House, Car loan, Cash)" aria-label="Account name" value={newName} onChange={(e) => setNewName(e.target.value)} required />
            <select value={newType} onChange={(e) => setNewType(e.target.value as AccountView["type"])} aria-label="Account type">
              {AccountType.options.map((t) => (
                <option key={t} value={t}>
                  {accountTypeLabel(t)}
                </option>
              ))}
            </select>
            <input
              placeholder={isDebtType(newType) ? "Amount owed (e.g. 15000.00)" : "Balance (e.g. 12500.00)"}
              aria-label={balanceFieldLabel(newType)}
              value={newBalance}
              onChange={(e) => setNewBalance(e.target.value)}
              inputMode="decimal"
            />
            <button type="submit" disabled={create.isPending}>
              Add
            </button>
          </form>
          <p className="muted small">Houses, vehicles and loans start off budget, so they stay out of the cash-flow projection; the Budget column switches that.</p>
          {createError && <ErrorText error={new Error(createError)} />}
          <ErrorText error={create.error} />
        </Card>
      )}
    </>
  );
}

/** A fragment with a key: lets one account render its row and its editor row as siblings in the tbody. */
function RowGroup({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/**
 * The Phase 3 block under an investment account (plan decision 7): the derived
 * fidelity badge, the positions check, the last statement check, securities to
 * review, and links to the account's positions and trades, the importers and
 * the Reconcile page.
 */
function InvestmentBlock({ a }: { a: AccountView }) {
  const inv = a.investment;
  const match = inv ? positionsMatchText(inv) : null;
  const rec = inv ? lastReconciliationText(inv.lastReconciliation) : null;
  return (
    <div className="acct-inv small">
      <div className="row wrap">
        <FidelityBadge fidelity={inv?.fidelity ?? "balance_only"} fidelityNote={inv?.fidelityNote ?? null} positionsDate={inv?.lastSnapshotDate ?? null} accountId={a.id} />
        {match && !inv?.fidelityNote && <span className={`tone-${match.tone}`}>{match.text}</span>}
        {rec ? <span className={`tone-${rec.tone}`}>{rec.text}</span> : inv && inv.fidelity !== "balance_only" ? <Badge tone="warn">not reconciled</Badge> : null}
        {inv && inv.needsReviewCount > 0 && <Link to="/investments/securities?chip=review">{inv.needsReviewCount} securit{inv.needsReviewCount === 1 ? "y" : "ies"} to review</Link>}
      </div>
      <div className="row wrap acct-inv-links">
        <Link to={`/investments/accounts/${a.id}`}>Positions</Link>
        <Link to={`/investments/accounts/${a.id}?tab=trades`}>Trades</Link>
        <Link to="/import?kind=positions">Import</Link>
        <Link to={`/investments/reconcile${query({ accountId: a.id, ...(inv?.lastSnapshotDate ? { date: inv.lastSnapshotDate } : {}) })}`}>Reconcile to statement</Link>
      </div>
    </div>
  );
}
