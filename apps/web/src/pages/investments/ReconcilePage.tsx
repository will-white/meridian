import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { isInvestmentAccountType, isIsoDate } from "@meridian/shared";
import type { AccountView, CashInference, ReconcileCommitBody, ReconcileCommitResponse, ReconcilePreviewBody, ReconcilePreviewResponse, SecurityView } from "@meridian/shared";
import { api } from "../../lib/api.js";
import { money, shortDate } from "../../lib/format.js";
import { localToday } from "../../lib/plan.js";
import { commitBlockText, commitResultText, defaultStatementDate, dollarsInputToCents, parseReconcileRows, rowsFromLines, type ReconcileRowForm } from "../../lib/reconcileView.js";
import { Badge, Card, Empty, ErrorText } from "../../components/ui.js";
import { FidelityBadge } from "../../components/investments/FidelityBadge.js";
import { ReconcileForm } from "../../components/investments/ReconcileForm.js";
import { invalidateReconcile, ReconcileHistory } from "../../components/investments/ReconcileHistory.js";
import { ReconcilePreview } from "../../components/investments/ReconcilePreview.js";
import { INVESTMENTS_STALE_MS, useIsViewer } from "../../components/investments/queries.js";
import "./investments.css";
import "./ReconcilePage.css";

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/**
 * Reconcile to a statement, the Phase 3 gate (plan decision 14; prices
 * design §5): pick an open investment account and a statement date (`?accountId=`,
 * `?date=`; default the last day of the previous month), enter the
 * statement's rows (prefill from the app, paste, or by hand) and total, watch
 * the live preview (POST /reconcile/preview, a read that writes nothing,
 * debounced 300 ms) with per-row statuses, the headline and both
 * cash-inference readings, then (owner) Accept the statement or Record only
 * (POST /reconcile/commit). Past checks are listed below. A recorded
 * difference of 0 is the gate's evidence.
 */
export function ReconcilePage() {
  const today = useMemo(() => localToday(), []);
  const viewer = useIsViewer();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const accountId = searchParams.get("accountId") ?? "";
  const dateParam = searchParams.get("date");
  const date = dateParam !== null && isIsoDate(dateParam) && dateParam <= today ? dateParam : defaultStatementDate(today);

  const [rows, setRows] = useState<ReconcileRowForm[]>([]);
  const [statementTotal, setStatementTotal] = useState("");
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);

  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<AccountView[]>("/accounts"), staleTime: INVESTMENTS_STALE_MS });
  const securities = useQuery({ queryKey: ["securities", "all"], queryFn: () => api<SecurityView[]>("/investments/securities"), staleTime: INVESTMENTS_STALE_MS });
  const investmentAccounts = useMemo(() => (accounts.data ?? []).filter((a) => isInvestmentAccountType(a.type) && !a.closed), [accounts.data]);
  const account = investmentAccounts.find((a) => a.id === accountId) ?? null;
  const tickers = useMemo(() => (securities.data ?? []).flatMap((s) => (s.ticker && !s.archived ? [s.ticker] : [])), [securities.data]);

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

  // The rows belong to one account and date: switching either starts over.
  useEffect(() => {
    setRows([]);
    setStatementTotal("");
    setResult(null);
  }, [accountId, date]);

  const parsed = useMemo(() => parseReconcileRows(rows), [rows]);
  const totalCents = statementTotal.trim() === "" ? null : dollarsInputToCents(statementTotal);
  const totalError = statementTotal.trim() !== "" && totalCents === null ? "The statement total is not a dollar amount" : null;
  // Accept / Record only wait for rows or a total: an empty statement would be accepted as a $0 manual snapshot.
  const commitBlock = commitBlockText(parsed, statementTotal);
  const body: ReconcilePreviewBody | null = useMemo(() => {
    if (!accountId || !parsed.ok || totalError) return null;
    const b: ReconcilePreviewBody = { accountId, date, rows: parsed.rows, today };
    if (totalCents !== null) b.statementTotalCents = totalCents.toString();
    return b;
  }, [accountId, date, parsed, totalCents, totalError, today]);
  const debouncedBody = useDebounced(body, 300);

  const preview = useQuery({
    queryKey: ["reconcile", "preview", debouncedBody],
    queryFn: () => api<ReconcilePreviewResponse>("/reconcile/preview", { method: "POST", body: debouncedBody }),
    enabled: debouncedBody !== null,
    staleTime: INVESTMENTS_STALE_MS,
    placeholderData: keepPreviousData,
  });
  const p = preview.data;

  const commit = useMutation({
    mutationFn: (b: ReconcileCommitBody) => api<ReconcileCommitResponse>("/reconcile/commit", { method: "POST", body: b }),
    onSuccess: (r, b) => {
      setResult({ text: commitResultText(r, b.date), ok: r.matchesToDollar });
      invalidateReconcile(qc);
    },
  });
  const toggleCash = useMutation({
    mutationFn: ({ id, setting }: { id: string; setting: CashInference }) => api<AccountView>(`/accounts/${id}`, { method: "PATCH", body: { cashInference: setting } }),
    onSuccess: () => invalidateReconcile(qc),
  });

  const onCommit = (accept: boolean, note: string | undefined) => {
    if (body === null) return;
    const b: ReconcileCommitBody = { ...body, accept };
    if (note !== undefined) b.note = note;
    setResult(null);
    commit.mutate(b);
  };
  const prefill = () => {
    if (!p) return;
    setRows(rowsFromLines(p.app.lines));
    setStatementTotal("");
  };

  return (
    <>
      <div className="inv-toolbar">
        <h2>Reconcile to a statement</h2>
        <div className="row wrap">
          <label className="inline">
            Account
            <select value={accountId} onChange={(e) => setParam("accountId", e.target.value)} aria-label="Account">
              <option value="">— choose —</option>
              {investmentAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="inline">
            Statement date
            <input type="date" value={date} max={today} onChange={(e) => setParam("date", e.target.value && e.target.value <= today ? e.target.value : null)} />
          </label>
        </div>
      </div>
      <ErrorText error={accounts.error} />
      {accounts.data && investmentAccounts.length === 0 && (
        <Card>
          <Empty>
            Add a brokerage or retirement account first: set an account's type on the <Link to="/accounts">Accounts page</Link>, or <Link to="/connections">connect one</Link>.
          </Empty>
        </Card>
      )}
      {investmentAccounts.length > 0 && !account && (
        <Card>
          <Empty>Choose the account the statement belongs to.</Empty>
        </Card>
      )}
      {account && (
        <>
          <Card
            title={`${account.name}: statement of ${shortDate(date)}`}
            actions={
              <span className="row wrap">
                <FidelityBadge fidelity={account.investment?.fidelity ?? null} fidelityNote={account.investment?.fidelityNote ?? null} positionsDate={account.investment?.lastSnapshotDate ?? null} accountId={account.id} />
                <Badge tone="neutral">cash inference {account.cashInference}</Badge>
                {account.investment?.lastReconciliation && (
                  <span className="muted small">
                    last checked {shortDate(account.investment.lastReconciliation.statementDate)} ·{" "}
                    {account.investment.lastReconciliation.diffCents === null
                      ? "no app value"
                      : BigInt(account.investment.lastReconciliation.diffCents) === 0n
                        ? "exact"
                        : account.investment.lastReconciliation.reconciled
                          ? "to the dollar"
                          : `off by ${money(account.investment.lastReconciliation.diffCents)}`}
                  </span>
                )}
              </span>
            }
          >
            <p className="muted small">
              Enter what the statement shows on {shortDate(date)}: each holding's shares and price or value, and the cash balance. The app values the account independently on that date and the preview compares the two line by line; a
              difference under {money("100")} counts as reconciled, 0 as exact.
            </p>
            <ReconcileForm
              rows={rows}
              onChange={setRows}
              tickers={tickers}
              statementTotal={statementTotal}
              onStatementTotal={setStatementTotal}
              sumCents={parsed.ok ? parsed.sumCents : null}
              errors={parsed.ok ? {} : parsed.errors}
              onPrefill={prefill}
              canPrefill={p !== undefined && p.app.lines.length > 0}
            />
            {totalError && <ErrorText error={new Error(totalError)} />}
            {!parsed.ok && <p className="muted small">Fix the rows above to see the preview.</p>}
          </Card>

          <Card title="Preview" actions={<span className="muted small">{preview.isFetching ? "updating…" : p ? `statement ${money(p.statementTotalCents)}` : ""}</span>}>
            <ErrorText error={preview.error} />
            {!p && preview.isLoading && <p className="muted">Comparing…</p>}
            {!p && !preview.isLoading && body === null && <p className="muted small">The preview appears once the rows (or just the total) are in.</p>}
            {p && (
              <ReconcilePreview
                preview={p}
                viewer={viewer}
                updating={preview.isFetching || body !== debouncedBody}
                onToggleCashInference={(setting) => toggleCash.mutate({ id: account.id, setting })}
                toggling={toggleCash.isPending}
                onCommit={onCommit}
                committing={commit.isPending}
                commitBlock={commitBlock}
                commitError={commit.error}
              />
            )}
            <ErrorText error={toggleCash.error} />
            {result && <p className={`notice rec-result ${result.ok ? "" : "warn"}`}>{result.text}</p>}
          </Card>

          <Card title="Past checks">
            <ReconcileHistory accountId={account.id} viewer={viewer} />
          </Card>
        </>
      )}
    </>
  );
}
