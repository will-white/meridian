import { Fragment, useMemo, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router";
import { formatCents, formatFixed8, isInvestmentAccountType, parseLooseDecimal } from "@meridian/shared";
import type { AccountView, CashInference, HoldingSnapshotView, InvestmentIncomeFeed, InvestmentTxnList, InvestmentTxnView, LotMethod, SecurityView, SnapshotSummaryView, UpdateInvestmentTxnBody } from "@meridian/shared";
import { api, query } from "../../lib/api.js";
import { money, shortDate, titleCase } from "../../lib/format.js";
import { localToday } from "../../lib/plan.js";
import { changeTone, formatQuantity, signedMoney, taxTreatmentLabel } from "../../lib/investments.js";
import { accountTabFromParam, dollarsToCentsSigned, isDisposal, lastReconciliationText, lotPickLabel, positionsMatchText, tradeTypeLabel, tradeTypeTone, txnSourceText, txnSummary } from "../../lib/investmentForms.js";
import { reconciliationLine } from "../../lib/importMapping.js";
import { feedModeLabel } from "../../lib/performanceView.js";
import { Badge, Card, Empty, ErrorText } from "../../components/ui.js";
import { FidelityBadge } from "../../components/investments/FidelityBadge.js";
import { LotPickDialog } from "../../components/investments/LotPickDialog.js";
import { PositionsEditor } from "../../components/investments/PositionsEditor.js";
import { TradeForm } from "../../components/investments/TradeForm.js";
import { invalidateInvestments, INVESTMENTS_STALE_MS, useIsViewer } from "../../components/investments/queries.js";
import "./investments.css";
import "./AccountInvestmentsPage.css";

const LOT_METHODS: ReadonlyArray<readonly [LotMethod, string]> = [
  ["fifo", "FIFO"],
  ["specific", "Specific identification"],
];
const CASH_INFERENCE: ReadonlyArray<readonly [CashInference, string]> = [
  ["auto", "Infer cash from the balance"],
  ["off", "Positions only"],
];
const FEED_MODES: readonly InvestmentIncomeFeed[] = ["off", "link", "create"];

/**
 * One investment account (imports design §5): the header with its derived
 * fidelity, the positions check, the last statement check and the owner's
 * settings (lot method, cash inference, income feed; PATCH /accounts/:id), a
 * Positions tab (the snapshot on a date with its reconciliation line, the
 * editor, the snapshot history with delete) and a Trades tab (the rows
 * newest first with lot picks, edit and delete, and the trade form). URL:
 * `?tab=positions|trades`, `?date=` for the snapshot.
 */
export function AccountInvestmentsPage() {
  const { id = "" } = useParams();
  const today = useMemo(() => localToday(), []);
  const viewer = useIsViewer();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = accountTabFromParam(searchParams.get("tab"));
  const dateParam = searchParams.get("date");

  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<AccountView[]>("/accounts"), staleTime: INVESTMENTS_STALE_MS });
  const securities = useQuery({ queryKey: ["securities", "all"], queryFn: () => api<SecurityView[]>("/investments/securities"), staleTime: INVESTMENTS_STALE_MS });
  const account = (accounts.data ?? []).find((a) => a.id === id) ?? null;
  const investment = account && isInvestmentAccountType(account.type) ? account : null;

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

  const settings = useMutation({
    mutationFn: (body: { lotMethod?: LotMethod; cashInference?: CashInference; investmentIncomeFeed?: InvestmentIncomeFeed }) => api<AccountView>(`/accounts/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      invalidateInvestments(qc);
      void qc.invalidateQueries({ queryKey: ["lots"] });
      void qc.invalidateQueries({ queryKey: ["reconcile"] });
    },
  });

  if (accounts.isLoading) return <p className="muted">Loading…</p>;
  if (accounts.error) return <ErrorText error={accounts.error} />;
  if (!account) return <Empty>No such account.</Empty>;
  if (!investment) {
    return (
      <Empty>
        {account.name} is a {titleCase(account.type)} account. Set its type to brokerage, 401k, IRA, Roth, HSA or 529 on the <Link to="/accounts">Accounts page</Link> to track positions and trades.
      </Empty>
    );
  }
  const inv = investment.investment;
  const match = inv ? positionsMatchText(inv) : null;
  const lastRec = inv ? lastReconciliationText(inv.lastReconciliation) : null;

  return (
    <>
      <div className="inv-toolbar">
        <h2>
          {investment.name}
          {investment.closed && <Badge tone="neutral">closed</Badge>}
        </h2>
        <div className="row wrap small">
          <Link to={`/investments/reconcile${query({ accountId: id, ...(inv?.lastSnapshotDate ? { date: inv.lastSnapshotDate } : {}) })}`}>Reconcile to statement</Link>
          <Link to={`/investments/holdings?accountId=${id}`}>Holdings</Link>
          <Link to={`/investments/performance?accountId=${id}`}>Performance</Link>
          <Link to={`/investments/income?accountId=${id}`}>Income</Link>
        </div>
      </div>

      <Card>
        <div className="row wrap acct-inv-head">
          <span>
            {titleCase(investment.type)} · {taxTreatmentLabel(investment.taxTreatment)}
            {investment.connectionName ? ` · ${investment.connectionName}` : " · no bank feed"}
          </span>
          <FidelityBadge fidelity={inv?.fidelity ?? null} fidelityNote={inv?.fidelityNote ?? null} positionsDate={inv?.lastSnapshotDate ?? null} />
          {match && <span className={`small tone-${match.tone}`}>{match.text}</span>}
          {lastRec ? <span className={`small tone-${lastRec.tone}`}>{lastRec.text}</span> : <span className="small muted">not yet checked against a statement</span>}
          {inv && (
            <span className="small muted">
              {inv.securityCount} securit{inv.securityCount === 1 ? "y" : "ies"}
              {inv.needsReviewCount > 0 && (
                <>
                  {" · "}
                  <Link to="/investments/securities?chip=review">{inv.needsReviewCount} to review</Link>
                </>
              )}
              {inv.lastTradeDate ? ` · last trade ${shortDate(inv.lastTradeDate)}` : ""}
            </span>
          )}
        </div>
        <div className="row wrap acct-inv-settings">
          <label className="inline">
            Lot method
            <select value={investment.lotMethod} disabled={viewer || settings.isPending} onChange={(e) => settings.mutate({ lotMethod: e.target.value as LotMethod })} aria-label="Lot method">
              {LOT_METHODS.map(([m, label]) => (
                <option key={m} value={m}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="inline" title="Auto: the latest reported balance anchors a 'Cash (from balance)' line and transfers after it are carried as cash. Off: positions only.">
            Cash
            <select value={investment.cashInference} disabled={viewer || settings.isPending} onChange={(e) => settings.mutate({ cashInference: e.target.value as CashInference })} aria-label="Cash inference">
              {CASH_INFERENCE.map(([m, label]) => (
                <option key={m} value={m}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="inline" title="Feed dividends and interest into the spending plan: link the bank's own rows, or create rows when the bank sends none. Needs the household's investment income category.">
            Income feed
            <select value={investment.investmentIncomeFeed} disabled={viewer || settings.isPending} onChange={(e) => settings.mutate({ investmentIncomeFeed: e.target.value as InvestmentIncomeFeed })} aria-label="Income feed">
              {FEED_MODES.map((m) => (
                <option key={m} value={m}>
                  {feedModeLabel(m)}
                </option>
              ))}
            </select>
          </label>
          {!viewer && (
            <span className="small muted">
              Feed category and benchmark are on the <Link to="/settings">Settings page</Link>.
            </span>
          )}
        </div>
        <ErrorText error={settings.error} />
      </Card>

      <div className="inv-seg acct-inv-tabs" role="tablist" aria-label="Account views">
        {(["positions", "trades"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} aria-pressed={tab === t} onClick={() => setParam("tab", t === "positions" ? null : t)}>
            {t === "positions" ? "Positions" : "Trades"}
          </button>
        ))}
      </div>

      {tab === "positions" && <PositionsTab accountId={id} dateParam={dateParam} onDate={(d) => setParam("date", d)} today={today} viewer={viewer} />}
      {tab === "trades" && <TradesTab account={investment} accounts={accounts.data ?? []} securities={securities.data ?? []} today={today} viewer={viewer} />}
    </>
  );
}

function PositionsTab({ accountId, dateParam, onDate, today, viewer }: { accountId: string; dateParam: string | null; onDate: (d: string | null) => void; today: string; viewer: boolean }) {
  const qc = useQueryClient();
  const [editor, setEditor] = useState<"closed" | "edit" | "new">("closed");
  const snapshots = useQuery({ queryKey: ["snapshots", accountId], queryFn: () => api<SnapshotSummaryView[]>(`/investments/accounts/${accountId}/snapshots`), staleTime: INVESTMENTS_STALE_MS });
  const list = snapshots.data ?? [];
  const date = dateParam && list.some((s) => s.date === dateParam) ? dateParam : (list[0]?.date ?? null);
  const snapshot = useQuery({
    queryKey: ["snapshots", accountId, date],
    queryFn: () => api<HoldingSnapshotView>(`/investments/accounts/${accountId}/snapshots/${date}`),
    enabled: date !== null,
    staleTime: INVESTMENTS_STALE_MS,
  });
  const s = snapshot.data ?? null;
  const line = s ? reconciliationLine(s) : null;
  const remove = useMutation({
    mutationFn: (d: string) => api<{ ok: true }>(`/investments/accounts/${accountId}/snapshots/${d}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidateInvestments(qc);
      void qc.invalidateQueries({ queryKey: ["snapshots", accountId] });
      void qc.invalidateQueries({ queryKey: ["prices"] });
      onDate(null);
    },
  });
  const onSaved = (saved: HoldingSnapshotView) => {
    setEditor("closed");
    onDate(saved.date);
  };

  return (
    <>
      <Card
        title={date ? `Positions as of ${shortDate(date)}` : "Positions"}
        actions={
          <div className="row wrap">
            {list.length > 1 && (
              <select value={date ?? ""} onChange={(e) => onDate(e.target.value || null)} aria-label="Snapshot date">
                {list.map((sn) => (
                  <option key={sn.date} value={sn.date}>
                    {shortDate(sn.date)} · {sn.source} · {sn.positions} position{sn.positions === 1 ? "" : "s"} · {money(sn.totalValueCents)}
                  </option>
                ))}
              </select>
            )}
            {!viewer && editor === "closed" && (
              <>
                {s && (
                  <button type="button" className="secondary" onClick={() => setEditor("edit")}>
                    Edit positions
                  </button>
                )}
                <button type="button" className="secondary" onClick={() => setEditor("new")}>
                  {s ? "New snapshot" : "Enter positions"}
                </button>
              </>
            )}
            <Link to="/import?kind=positions" className="small">
              Import positions CSV
            </Link>
          </div>
        }
      >
        <ErrorText error={snapshots.error} />
        <ErrorText error={snapshot.error} />
        <ErrorText error={remove.error} />
        {editor !== "closed" && !viewer && (
          <PositionsEditor key={`${editor}-${date ?? "none"}`} accountId={accountId} initial={editor === "edit" ? s : null} defaultDate={editor === "edit" && date ? date : today} today={today} onClose={() => setEditor("closed")} onSaved={onSaved} />
        )}
        {editor === "closed" && snapshots.data && list.length === 0 && (
          <Empty>
            No positions yet. <Link to="/import?kind=positions">Import a positions CSV</Link>, enter them by hand, or wait for a SimpleFIN sync that includes holdings. Until then the account is valued at its balance.
          </Empty>
        )}
        {editor === "closed" && s && (
          <>
            <div className="scroll">
              <table className="table small inv-table">
                <thead>
                  <tr>
                    <th>Security</th>
                    <th className="num">Quantity</th>
                    <th className="num">Price</th>
                    <th className="num">Value</th>
                    <th className="num">Cost basis</th>
                  </tr>
                </thead>
                <tbody>
                  {s.rows.map((r) => (
                    <tr key={r.securityId}>
                      <td className="name">
                        {r.ticker && <strong>{r.ticker}</strong>} {r.name}
                      </td>
                      <td className="num">{r.quantity === null ? <span className="muted">value only</span> : formatQuantity(r.quantity, 4)}</td>
                      <td className="num">{r.price === null ? "—" : formatQuantity(r.price, 4)}</td>
                      <td className="num">{money(r.valueCents)}</td>
                      <td className="num muted">{r.reportedCostBasisCents === null ? "—" : money(r.reportedCostBasisCents)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>
                      <strong>Total</strong> <span className="muted small">· {s.source} snapshot</span>
                    </td>
                    <td className="num">
                      <strong>{money(s.totalValueCents)}</strong>
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {line ? <p className={`acct-inv-line tone-${line.tone}`}>{line.text}</p> : <p className="muted small">No reported balance on this date to compare with.</p>}
            {!viewer && s.source !== "simplefin" && (
              <button
                type="button"
                className="link small danger"
                disabled={remove.isPending}
                onClick={() => {
                  if (confirm(`Delete the ${s.source} snapshot of ${shortDate(s.date)}? Its balance row goes with it.`)) remove.mutate(s.date);
                }}
              >
                delete this snapshot
              </button>
            )}
          </>
        )}
      </Card>
      {list.length > 0 && (
        <Card title="Snapshot history">
          <div className="scroll">
            <table className="table small inv-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Source</th>
                  <th className="num">Positions</th>
                  <th className="num">Total</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((sn) => (
                  <tr key={sn.date} className={sn.date === date ? "acct-inv-current" : ""}>
                    <td>
                      <button type="button" className="link" onClick={() => onDate(sn.date)}>
                        {shortDate(sn.date)}
                      </button>
                    </td>
                    <td>
                      <Badge tone={sn.source === "manual" ? "info" : "neutral"}>{sn.source}</Badge>
                    </td>
                    <td className="num">{sn.positions}</td>
                    <td className="num">{money(sn.totalValueCents)}</td>
                    <td className="actions">
                      {!viewer && sn.source !== "simplefin" && (
                        <button
                          type="button"
                          className="link small danger"
                          disabled={remove.isPending}
                          onClick={() => {
                            if (confirm(`Delete the ${sn.source} snapshot of ${shortDate(sn.date)}?`)) remove.mutate(sn.date);
                          }}
                        >
                          delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">Precedence on one date: a manual snapshot outranks a CSV import, which outranks SimpleFIN; SimpleFIN snapshots are regenerated by the next sync and cannot be deleted here.</p>
        </Card>
      )}
    </>
  );
}

function TradesTab({ account, accounts, securities, today, viewer }: { account: AccountView; accounts: readonly AccountView[]; securities: readonly SecurityView[]; today: string; viewer: boolean }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<"closed" | "trade" | "move">("closed");
  const [picking, setPicking] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const txns = useInfiniteQuery({
    queryKey: ["investment-transactions", { accountId: account.id }],
    queryFn: ({ pageParam }) => api<InvestmentTxnList>(`/investments/txns${query({ accountId: account.id, limit: 100, cursor: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: INVESTMENTS_STALE_MS,
  });
  const rows = txns.data?.pages.flatMap((p) => p.items) ?? [];
  const invalidate = () => {
    invalidateInvestments(qc);
    void qc.invalidateQueries({ queryKey: ["investment-transactions"] });
    void qc.invalidateQueries({ queryKey: ["transactions"] });
    void qc.invalidateQueries({ queryKey: ["lots"] });
  };
  const remove = useMutation({
    mutationFn: ({ id, deleteGroup }: { id: string; deleteGroup: boolean }) => api<{ ok: true }>(`/investments/txns/${id}${query({ deleteGroup: deleteGroup || undefined })}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateInvestmentTxnBody }) => api<InvestmentTxnView>(`/investments/txns/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      setEditing(null);
      invalidate();
    },
  });
  const others = accounts.filter((a) => a.id !== account.id && isInvestmentAccountType(a.type) && !a.closed);

  return (
    <Card
      title="Trades"
      actions={
        <div className="row wrap">
          {!viewer && form === "closed" && (
            <>
              <button type="button" className="secondary" onClick={() => setForm("trade")}>
                Record trade
              </button>
              {others.length > 0 && (
                <button type="button" className="secondary" onClick={() => setForm("move")}>
                  Move to another account
                </button>
              )}
            </>
          )}
          <Link to="/import?kind=trades" className="small">
            Import trade history
          </Link>
        </div>
      }
    >
      {form !== "closed" && !viewer && (
        <TradeForm
          key={form}
          accountId={account.id}
          accounts={accounts}
          securities={securities}
          today={today}
          initialType={form === "move" ? "transfer" : "buy"}
          counterpartyAccountId={form === "move" ? (others[0]?.id ?? "") : ""}
          onClose={() => setForm("closed")}
          onSaved={() => setForm("closed")}
        />
      )}
      <ErrorText error={txns.error} />
      <ErrorText error={remove.error} />
      {txns.isLoading && <p className="muted">Loading…</p>}
      {txns.data && rows.length === 0 && (
        <Empty>
          No trades recorded. <Link to="/import?kind=trades">Import trade history</Link> or record trades by hand; with a complete history the account's value comes from its lots and gains are computed per lot.
        </Empty>
      )}
      {rows.length > 0 && (
        <div className="scroll">
          <table className="table small inv-table acct-inv-txns">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Security</th>
                <th className="num">Quantity</th>
                <th className="num">Price</th>
                <th className="num">Fee</th>
                <th className="num">Amount</th>
                <th>Lots</th>
                <th>Source</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <Fragment key={t.id}>
                  <tr>
                    <td className="nowrap">{shortDate(t.date)}</td>
                    <td>
                      <Badge tone={tradeTypeTone(t.type)}>{tradeTypeLabel(t.type)}</Badge>
                      <div className="muted small">{txnSummary(t, (q) => formatQuantity(q, 4))}</div>
                    </td>
                    <td className="name">
                      {t.securityId === null ? <span className="muted">cash</span> : <>{t.ticker && <strong>{t.ticker}</strong>} {t.securityName}</>}
                      {(t.memo || t.rawDescription) && <div className="muted small">{t.memo ?? t.rawDescription}</div>}
                    </td>
                    <td className="num">{t.quantity === null ? "" : formatQuantity(t.quantity, 4)}</td>
                    <td className="num">{t.price === null ? "" : formatQuantity(t.price, 4)}</td>
                    <td className="num muted">{BigInt(t.feeCents) === 0n ? "" : money(t.feeCents)}</td>
                    <td className={`num ${changeTone(t.amountCents)}`}>{signedMoney(t.amountCents)}</td>
                    <td>
                      {isDisposal(t) && (
                        <>
                          <span className="small">{lotPickLabel(t)}</span>
                          {!viewer && (
                            <button type="button" className="link small" onClick={() => setPicking(picking === t.id ? null : t.id)} aria-expanded={picking === t.id}>
                              {picking === t.id ? "close" : "lots"}
                            </button>
                          )}
                        </>
                      )}
                      {t.type === "transfer" && t.securityId !== null && t.transferDirection === "in" && (
                        <span className="muted small">{t.costBasisCents === null ? "basis unknown" : `basis ${money(t.costBasisCents)}${t.acquiredDate ? ` · acquired ${shortDate(t.acquiredDate)}` : ""}`}</span>
                      )}
                    </td>
                    <td className="muted small">
                      {txnSourceText(t)}
                      {t.ledgerTransactionId && (
                        <>
                          {" · "}
                          <Link to={`/transactions?accountId=${account.id}&from=${t.date}&to=${t.date}&transfers=include`}>ledger</Link>
                        </>
                      )}
                      {t.transferGroupId && <span> · paired</span>}
                    </td>
                    <td className="actions">
                      {!viewer && (
                        <>
                          <button type="button" className="link small" onClick={() => setEditing(editing === t.id ? null : t.id)} aria-expanded={editing === t.id}>
                            {editing === t.id ? "close" : "edit"}
                          </button>
                          <button
                            type="button"
                            className="link small danger"
                            disabled={remove.isPending}
                            onClick={() => {
                              const paired = t.transferGroupId !== null;
                              if (confirm(paired ? "Delete both legs of this transfer?" : `Delete this ${tradeTypeLabel(t.type).toLowerCase()} of ${shortDate(t.date)}? Lots are rebuilt.`)) remove.mutate({ id: t.id, deleteGroup: paired });
                            }}
                          >
                            delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                  {picking === t.id && !viewer && (
                    <tr className="inv-detail">
                      <td colSpan={10}>
                        <LotPickDialog txn={t} today={today} onClose={() => setPicking(null)} />
                      </td>
                    </tr>
                  )}
                  {editing === t.id && !viewer && (
                    <tr className="inv-detail">
                      <td colSpan={10}>
                        <TxnEditForm txn={t} today={today} pending={update.isPending} error={update.error} onSave={(body) => update.mutate({ id: t.id, body })} onClose={() => setEditing(null)} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {txns.hasNextPage && (
        <button type="button" className="link small" onClick={() => void txns.fetchNextPage()} disabled={txns.isFetchingNextPage}>
          {txns.isFetchingNextPage ? "Loading…" : "Load older trades"}
        </button>
      )}
      <p className="muted small">
        Newest first. Reinvested dividends are two rows (a dividend and a reinvest purchase); a transfer between two of your investment accounts is paired and counts as internal. Rows edited by hand are no longer refreshed by re-imports.
      </p>
    </Card>
  );
}

/** The fields of an existing row the owner may correct; the API re-validates the whole row and marks imported rows as edited. */
function TxnEditForm({ txn, today, pending, error, onSave, onClose }: { txn: InvestmentTxnView; today: string; pending: boolean; error: unknown; onSave: (body: UpdateInvestmentTxnBody) => void; onClose: () => void }) {
  const [date, setDate] = useState(txn.date);
  const [quantity, setQuantity] = useState(txn.quantity ?? "");
  const [price, setPrice] = useState(txn.price ?? "");
  const [amount, setAmount] = useState(formatCents(BigInt(txn.amountCents)));
  const [fee, setFee] = useState(formatCents(BigInt(txn.feeCents)));
  const [memo, setMemo] = useState(txn.memo ?? "");
  const [clientError, setClientError] = useState<string | null>(null);
  const hasShares = txn.type === "buy" || txn.type === "sell" || txn.type === "reinvest" || (txn.type === "transfer" && txn.securityId !== null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: UpdateInvestmentTxnBody = { today };
    if (date !== txn.date) {
      if (date > today) return setClientError("The date cannot be in the future");
      body.date = date;
    }
    if (hasShares && quantity !== (txn.quantity ?? "")) {
      const q = parseLooseDecimal(quantity);
      if (q === undefined || q <= 0n) return setClientError("The quantity is a positive number of shares");
      body.quantity = formatFixed8(q);
    }
    if (hasShares && price !== (txn.price ?? "")) {
      const p = parseLooseDecimal(price);
      if (p === undefined || p < 0n) return setClientError("The price is not a number");
      body.price = formatFixed8(p);
    }
    const amountCents = dollarsToCentsSigned(amount);
    if (amountCents === null) return setClientError("The amount is a dollar amount");
    if (amountCents.toString() !== txn.amountCents) body.amountCents = amountCents.toString();
    const feeCents = dollarsToCentsSigned(fee);
    if (feeCents === null || feeCents < 0n) return setClientError("The fee is a non-negative dollar amount");
    if (feeCents.toString() !== txn.feeCents) body.feeCents = feeCents.toString();
    const m = memo.trim();
    if (m !== (txn.memo ?? "")) body.memo = m === "" ? null : m;
    setClientError(null);
    if (Object.keys(body).length === 1) return onClose();
    onSave(body);
  };
  return (
    <form className="row wrap acct-inv-edit" onSubmit={submit} aria-label="Edit trade">
      <label className="inline">
        Date
        <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
      </label>
      {hasShares && (
        <>
          <label className="inline">
            Quantity
            <input inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="inv-cell-input" />
          </label>
          <label className="inline">
            Price
            <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} className="inv-cell-input" />
          </label>
        </>
      )}
      <label className="inline">
        Amount
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="inv-cell-input" />
      </label>
      <label className="inline">
        Fee
        <input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} className="inv-cell-input" />
      </label>
      <label className="inline grow">
        Memo
        <input value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={2000} className="grow" />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </button>
      <button type="button" className="secondary" onClick={onClose} disabled={pending}>
        Cancel
      </button>
      {txn.source !== "manual" && !txn.userEdited && <span className="muted small">Editing an imported row keeps it: re-imports will no longer refresh it.</span>}
      {txn.transferGroupId && <span className="muted small">A paired leg keeps its type, security and quantity; delete the pair to change those.</span>}
      {clientError && <ErrorText error={new Error(clientError)} />}
      <ErrorText error={error} />
    </form>
  );
}
