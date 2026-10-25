import { Fragment, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import type { AssetClass, CreateSecurityBody, PriceSource, SecurityIdentityKind, SecurityType, SecurityView, UpdateSecurityBody } from "@meridian/shared";
import { api, query } from "../../lib/api.js";
import { shortDate } from "../../lib/format.js";
import { ASSET_CLASSES, assetClassLabel, formatQuantity } from "../../lib/investments.js";
import {
  buildCreateSecurity,
  buildSecurityPatch,
  defaultSecurityChip,
  expenseRatioText,
  filterSecurities,
  newSecurityForm,
  SECURITY_TYPES,
  securityDeleteReason,
  securityForm,
  securityLabel,
  securityTypeLabel,
  type SecurityChip,
  type SecurityForm,
} from "../../lib/investmentForms.js";
import { priceModeLabel } from "../../lib/reconcileView.js";
import { Badge, Card, Empty, ErrorText } from "../../components/ui.js";
import { invalidateInvestments, INVESTMENTS_STALE_MS, useIsViewer } from "../../components/investments/queries.js";
import "./investments.css";
import "./SecuritiesPage.css";

const CHIPS: ReadonlyArray<readonly [SecurityChip, string]> = [
  ["all", "All"],
  ["review", "Needs review"],
  ["held", "Held"],
];
const ALIAS_KINDS: readonly SecurityIdentityKind[] = ["ticker", "cusip", "isin", "name"];
const PRICE_MODES: readonly PriceSource[] = ["provider", "implied", "manual"];

function invalidateSecurities(qc: ReturnType<typeof useQueryClient>): void {
  invalidateInvestments(qc);
  void qc.invalidateQueries({ queryKey: ["prices"] });
}

/**
 * The security master (imports design §5): filter chips (Needs review on by
 * default when any exist), a search, and the table with inline edit of
 * ticker, name, type, asset class, expense ratio, pricing mode, provider
 * symbol and always-price (one PATCH; pricing-only bodies go through the
 * pricing path server-side), the latest price with its source, held-in-N
 * accounts, aliases, merge into…, archive and delete (disabled with the
 * reason while held). Owners can add a security by hand; `?q=` from the
 * Reconcile page's unknown-ticker link prefills it.
 */
export function SecuritiesPage() {
  const qc = useQueryClient();
  const viewer = useIsViewer();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const chipParam = searchParams.get("chip");
  const [editing, setEditing] = useState<string | null>(null);
  const [merging, setMerging] = useState<string | null>(null);
  const [aliasing, setAliasing] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(q !== "");

  const securities = useQuery({
    queryKey: ["securities", "list", { includeArchived: true }],
    queryFn: () => api<SecurityView[]>(`/investments/securities${query({ includeArchived: true })}`),
    staleTime: INVESTMENTS_STALE_MS,
  });
  const all = securities.data ?? [];
  const chip: SecurityChip = chipParam === "all" || chipParam === "review" || chipParam === "held" ? chipParam : defaultSecurityChip(all);
  const setParam = (key: string, value: string | null) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );

  const rows = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return filterSecurities(all, chip)
      .filter((s) => showArchived || !s.archived || chip !== "all")
      .filter((s) => needle === "" || (s.ticker ?? "").toUpperCase().includes(needle) || s.name.toUpperCase().includes(needle) || (s.cusip ?? "").toUpperCase() === needle || (s.isin ?? "").toUpperCase() === needle)
      .sort((a, b) => Number(b.needsReview) - Number(a.needsReview) || Number(b.held) - Number(a.held) || (a.ticker ?? a.name).localeCompare(b.ticker ?? b.name));
  }, [all, chip, q, showArchived]);
  const reviewCount = all.filter((s) => s.needsReview && !s.archived).length;
  const noExactMatch = q.trim() !== "" && !all.some((s) => (s.ticker ?? "").toUpperCase() === q.trim().toUpperCase());

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateSecurityBody }) => api<SecurityView>(`/investments/securities/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      setEditing(null);
      invalidateSecurities(qc);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/investments/securities/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateSecurities(qc),
  });
  const merge = useMutation({
    mutationFn: ({ id, fromId }: { id: string; fromId: string }) => api<SecurityView>(`/investments/securities/${id}/merge`, { method: "POST", body: { fromId } }),
    onSuccess: () => {
      setMerging(null);
      invalidateSecurities(qc);
    },
  });
  const addAlias = useMutation({
    mutationFn: ({ id, kind, value }: { id: string; kind: SecurityIdentityKind; value: string }) => api<SecurityView>(`/investments/securities/${id}/aliases`, { method: "POST", body: { kind, value } }),
    onSuccess: () => {
      setAliasing(null);
      invalidateSecurities(qc);
    },
  });
  const create = useMutation({
    mutationFn: (body: CreateSecurityBody) => api<SecurityView>("/investments/securities", { method: "POST", body }),
    onSuccess: () => {
      setCreating(false);
      setParam("q", null);
      invalidateSecurities(qc);
    },
  });

  return (
    <>
      <div className="inv-toolbar">
        <h2>Securities</h2>
        <div className="row wrap">
          <div className="inv-seg" role="group" aria-label="Filter">
            {CHIPS.map(([c, label]) => (
              <button key={c} type="button" aria-pressed={chip === c} onClick={() => setParam("chip", c)}>
                {label}
                {c === "review" && reviewCount > 0 ? ` (${reviewCount})` : ""}
              </button>
            ))}
          </div>
          <input type="search" value={q} onChange={(e) => setParam("q", e.target.value)} placeholder="Search ticker or name" aria-label="Search securities" className="sec-search" />
          {chip === "all" && (
            <label className="inline small">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> show archived
            </label>
          )}
          {!viewer && (
            <button type="button" className="secondary" onClick={() => setCreating((c) => !c)}>
              {creating ? "Close" : "Add a security"}
            </button>
          )}
        </div>
      </div>
      <ErrorText error={securities.error} />
      <ErrorText error={remove.error} />
      {!viewer && creating && <CreateSecurityCard initialTicker={q} pending={create.isPending} error={create.error} onCreate={(body) => create.mutate(body)} onClose={() => setCreating(false)} />}
      {!viewer && !creating && noExactMatch && (
        <p className="muted small">
          No security with the ticker {q.trim().toUpperCase()}.{" "}
          <button type="button" className="link small" onClick={() => setCreating(true)}>
            Create it
          </button>
        </p>
      )}
      {securities.isLoading && <p className="muted">Loading…</p>}
      {securities.data && all.length === 0 && (
        <Card>
          <Empty>
            Securities appear here when positions or trades are imported or synced. <Link to="/import?kind=positions">Import positions</Link> or <Link to="/import?kind=trades">trade history</Link>.
          </Empty>
        </Card>
      )}
      {all.length > 0 && (
        <Card
          title={chip === "review" ? "Needs review" : chip === "held" ? "Held securities" : "All securities"}
          actions={
            <span className="muted small">
              {rows.length} of {all.length}
              {chip === "review" ? " · guessed from a file or feed: confirm the type and asset class" : ""}
            </span>
          }
        >
          {rows.length === 0 ? (
            <Empty>{chip === "review" ? "Nothing to review." : "No securities match."}</Empty>
          ) : (
            <div className="scroll">
              <table className="table small inv-table sec-table">
                <thead>
                  <tr>
                    <th>Security</th>
                    <th>Type</th>
                    <th>Asset class</th>
                    <th className="num">Expense ratio</th>
                    <th>Pricing</th>
                    <th className="num">Latest price</th>
                    <th className="num">Held in</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => {
                    const deleteReason = securityDeleteReason(s);
                    return (
                      <Fragment key={s.id}>
                        <tr className={s.archived ? "muted" : ""}>
                          <td className="name">
                            {s.ticker && <strong>{s.ticker}</strong>} {s.name}
                            {s.needsReview && <Badge tone="warn">needs review</Badge>}
                            {s.archived && <Badge tone="neutral">archived</Badge>}
                            {s.alwaysPrice && <Badge tone="info">always priced</Badge>}
                            {(s.cusip || s.isin || s.aliases.length > 0) && (
                              <div className="muted small">
                                {s.cusip ? `CUSIP ${s.cusip}` : ""}
                                {s.cusip && s.isin ? " · " : ""}
                                {s.isin ? `ISIN ${s.isin}` : ""}
                                {(s.cusip || s.isin) && s.aliases.length > 0 ? " · " : ""}
                                {s.aliases.length > 0 ? `also known as ${s.aliases.map((a) => a.value).join(", ")}` : ""}
                              </div>
                            )}
                          </td>
                          <td>{securityTypeLabel(s.type)}</td>
                          <td>{assetClassLabel(s.assetClass)}</td>
                          <td className="num">{expenseRatioText(s.expenseRatioPpm)}</td>
                          <td>
                            {priceModeLabel(s.priceMode)}
                            {s.providerSymbol && <span className="muted small"> · {s.providerSymbol}</span>}
                          </td>
                          <td className="num">
                            {s.latestPrice ? (
                              <>
                                {formatQuantity(s.latestPrice.close, 4)}
                                <div className="muted small">
                                  {shortDate(s.latestPrice.date)} · {s.latestPrice.source}
                                </div>
                              </>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td className="num">{s.held ? `${s.heldInAccounts} account${s.heldInAccounts === 1 ? "" : "s"}` : <span className="muted">not held</span>}</td>
                          <td className="actions">
                            {!viewer && (
                              <>
                                <button type="button" className="link small" onClick={() => setEditing(editing === s.id ? null : s.id)} aria-expanded={editing === s.id}>
                                  {editing === s.id ? "close" : "edit"}
                                </button>
                                <button type="button" className="link small" onClick={() => setAliasing(aliasing === s.id ? null : s.id)}>
                                  alias
                                </button>
                                {s.type !== "cash" && (
                                  <button type="button" className="link small" onClick={() => setMerging(merging === s.id ? null : s.id)}>
                                    merge into…
                                  </button>
                                )}
                                {s.type !== "cash" && (
                                  <button type="button" className="link small" onClick={() => patch.mutate({ id: s.id, body: { archived: !s.archived } })} disabled={patch.isPending}>
                                    {s.archived ? "unarchive" : "archive"}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="link small danger"
                                  disabled={deleteReason !== null || remove.isPending}
                                  title={deleteReason ?? "Delete this security"}
                                  onClick={() => {
                                    if (confirm(`Delete ${securityLabel(s)}? Its aliases and prices go with it.`)) remove.mutate(s.id);
                                  }}
                                >
                                  delete
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                        {editing === s.id && !viewer && (
                          <tr className="inv-detail">
                            <td colSpan={8}>
                              <SecurityEditForm security={s} pending={patch.isPending} error={patch.error} onSave={(body) => patch.mutate({ id: s.id, body })} onClose={() => setEditing(null)} />
                            </td>
                          </tr>
                        )}
                        {aliasing === s.id && !viewer && (
                          <tr className="inv-detail">
                            <td colSpan={8}>
                              <AliasForm security={s} pending={addAlias.isPending} error={addAlias.error} onAdd={(kind, value) => addAlias.mutate({ id: s.id, kind, value })} onClose={() => setAliasing(null)} />
                            </td>
                          </tr>
                        )}
                        {merging === s.id && !viewer && (
                          <tr className="inv-detail">
                            <td colSpan={8}>
                              <MergeForm survivor={s} candidates={all.filter((o) => o.id !== s.id && o.type !== "cash")} pending={merge.isPending} error={merge.error} onMerge={(fromId) => merge.mutate({ id: s.id, fromId })} onClose={() => setMerging(null)} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">
            A security guessed from a file keeps "needs review" until it is saved here. Pricing: Provider fetches the nightly close (needs a ticker or a provider symbol and a configured feed), Implied derives a price from a
            statement's value ÷ quantity, Manual uses the closes you enter on the <Link to="/investments/prices">Prices page</Link>. The cash security is fixed at 1 and never priced.
          </p>
        </Card>
      )}
    </>
  );
}

function SecurityFields({ form, onChange, isCash }: { form: SecurityForm; onChange: (patch: Partial<SecurityForm>) => void; isCash: boolean }) {
  return (
    <div className="sec-fields">
      <label>
        Ticker
        <input value={form.ticker} onChange={(e) => onChange({ ticker: e.target.value })} maxLength={20} placeholder="none" disabled={isCash} />
      </label>
      <label className="sec-name">
        Name
        <input value={form.name} onChange={(e) => onChange({ name: e.target.value })} maxLength={200} required />
      </label>
      <label>
        Type
        <select value={form.type} onChange={(e) => onChange({ type: e.target.value as SecurityType })} disabled={isCash}>
          {isCash && <option value="cash">Cash</option>}
          {SECURITY_TYPES.map((t) => (
            <option key={t} value={t}>
              {securityTypeLabel(t)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Asset class
        <select value={form.assetClass} onChange={(e) => onChange({ assetClass: e.target.value as AssetClass })} disabled={isCash}>
          {ASSET_CLASSES.map((c) => (
            <option key={c} value={c}>
              {assetClassLabel(c)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Expense ratio <span className="muted">(%)</span>
        <input inputMode="decimal" value={form.expenseRatio} onChange={(e) => onChange({ expenseRatio: e.target.value })} placeholder="0.03" disabled={isCash} className="sec-ratio" />
      </label>
      <label>
        Pricing
        <select value={form.priceMode} onChange={(e) => onChange({ priceMode: e.target.value as PriceSource })} disabled={isCash}>
          {PRICE_MODES.map((m) => (
            <option key={m} value={m}>
              {priceModeLabel(m)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Provider symbol <span className="muted">(when it differs from the ticker)</span>
        <input value={form.providerSymbol} onChange={(e) => onChange({ providerSymbol: e.target.value })} maxLength={32} placeholder={form.ticker || "—"} disabled={isCash || form.priceMode !== "provider"} />
      </label>
      <label className="inline sec-check" title="Fetch its price every night even when nothing holds it (a benchmark, a watchlist fund)">
        <input type="checkbox" checked={form.alwaysPrice} onChange={(e) => onChange({ alwaysPrice: e.target.checked })} disabled={isCash} /> always price
      </label>
      <label className="sec-notes">
        Notes
        <input value={form.notes} onChange={(e) => onChange({ notes: e.target.value })} maxLength={2000} />
      </label>
    </div>
  );
}

function SecurityEditForm({ security, pending, error, onSave, onClose }: { security: SecurityView; pending: boolean; error: unknown; onSave: (body: UpdateSecurityBody) => void; onClose: () => void }) {
  const [form, setForm] = useState<SecurityForm>(() => securityForm(security));
  const [clientError, setClientError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = buildSecurityPatch(form, security);
    if (!r.ok) return setClientError(r.error);
    setClientError(null);
    if (Object.keys(r.patch).length === 0 && !security.needsReview) return onClose();
    // Saving clears needsReview unless the body sets it (an empty body on a reviewed row confirms the guess).
    onSave(security.needsReview ? { ...r.patch, needsReview: false } : r.patch);
  };
  return (
    <form className="sec-edit" onSubmit={submit} aria-label={`Edit ${securityLabel(security)}`}>
      <SecurityFields form={form} onChange={(p) => setForm((f) => ({ ...f, ...p }))} isCash={security.type === "cash"} />
      <div className="row wrap">
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : security.needsReview ? "Save and mark reviewed" : "Save"}
        </button>
        <button type="button" className="secondary" onClick={onClose} disabled={pending}>
          Cancel
        </button>
        <span className="muted small">Changing the pricing mode resets the fetch state and, with a provider, queues a backfill.</span>
      </div>
      {clientError && <ErrorText error={new Error(clientError)} />}
      <ErrorText error={error} />
    </form>
  );
}

function CreateSecurityCard({ initialTicker, pending, error, onCreate, onClose }: { initialTicker: string; pending: boolean; error: unknown; onCreate: (body: CreateSecurityBody) => void; onClose: () => void }) {
  const [form, setForm] = useState<SecurityForm>(() => newSecurityForm(initialTicker));
  const [clientError, setClientError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = buildCreateSecurity(form);
    if (!r.ok) return setClientError(r.error);
    setClientError(null);
    onCreate(r.body);
  };
  return (
    <Card title="Add a security">
      <form className="sec-edit" onSubmit={submit} aria-label="Add a security">
        <SecurityFields form={form} onChange={(p) => setForm((f) => ({ ...f, ...p }))} isCash={false} />
        <div className="row wrap">
          <button type="submit" disabled={pending}>
            {pending ? "Adding…" : "Add"}
          </button>
          <button type="button" className="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <span className="muted small">Imports and syncs create securities by themselves; add one by hand for a position you will enter manually.</span>
        </div>
        {clientError && <ErrorText error={new Error(clientError)} />}
        <ErrorText error={error} />
      </form>
    </Card>
  );
}

function AliasForm({ security, pending, error, onAdd, onClose }: { security: SecurityView; pending: boolean; error: unknown; onAdd: (kind: SecurityIdentityKind, value: string) => void; onClose: () => void }) {
  const [kind, setKind] = useState<SecurityIdentityKind>("ticker");
  const [value, setValue] = useState("");
  return (
    <form
      className="row wrap sec-alias"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim() !== "") onAdd(kind, value.trim());
      }}
      aria-label={`Add an alias for ${securityLabel(security)}`}
    >
      <span className="muted small">Aliases: {security.aliases.length === 0 ? "none" : security.aliases.map((a) => `${a.kind} ${a.value}`).join(", ")}</span>
      <select value={kind} onChange={(e) => setKind(e.target.value as SecurityIdentityKind)} aria-label="Alias kind">
        {ALIAS_KINDS.map((k) => (
          <option key={k} value={k}>
            {k.toUpperCase()}
          </option>
        ))}
      </select>
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="as the file spells it" aria-label="Alias value" maxLength={200} required />
      <button type="submit" disabled={pending}>
        Add alias
      </button>
      <button type="button" className="secondary" onClick={onClose}>
        Close
      </button>
      <ErrorText error={error} />
    </form>
  );
}

function MergeForm({ survivor, candidates, pending, error, onMerge, onClose }: { survivor: SecurityView; candidates: readonly SecurityView[]; pending: boolean; error: unknown; onMerge: (fromId: string) => void; onClose: () => void }) {
  const [fromId, setFromId] = useState("");
  const from = candidates.find((c) => c.id === fromId);
  return (
    <form
      className="row wrap sec-merge"
      onSubmit={(e) => {
        e.preventDefault();
        if (!from) return;
        if (confirm(`Merge ${securityLabel(from)} into ${securityLabel(survivor)}? Its positions, trades, prices and aliases move to ${survivor.ticker ?? survivor.name}${from.held ? ` (held in ${from.heldInAccounts} account${from.heldInAccounts === 1 ? "" : "s"})` : ""}; lots are rebuilt.`))
          onMerge(from.id);
      }}
      aria-label={`Merge another security into ${securityLabel(survivor)}`}
    >
      <span className="muted small">Merge a duplicate into {survivor.ticker ?? survivor.name}:</span>
      <select value={fromId} onChange={(e) => setFromId(e.target.value)} aria-label="Security to merge away" required>
        <option value="">— choose the duplicate —</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {securityLabel(c)}
            {c.held ? ` (held in ${c.heldInAccounts})` : ""}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending || fromId === ""}>
        Merge
      </button>
      <button type="button" className="secondary" onClick={onClose}>
        Close
      </button>
      <ErrorText error={error} />
    </form>
  );
}
