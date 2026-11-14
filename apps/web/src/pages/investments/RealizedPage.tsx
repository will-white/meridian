import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { formatFixed8, isIsoDate, parseFixed8 } from "@meridian/shared";
import type { AccountView, LotDisposalView, RealizedGainsResponse } from "@meridian/shared";
import { api, query } from "../../lib/api.js";
import { accountTypeLabel, money, shortDate } from "../../lib/format.js";
import { localToday } from "../../lib/plan.js";
import { changeTone, formatQuantity, investmentAccountOptions, signedMoney } from "../../lib/investments.js";
import { disposalNote, realizedRange, realizedYears, splitDisposals, termLabel } from "../../lib/lots.js";
import { Badge, Card, Empty, ErrorText } from "../../components/ui.js";
import { INVESTMENTS_STALE_MS } from "../../components/investments/queries.js";
import "./investments.css";

/** The query key and parameters of the page's GET /investments/realized (shared with the tests). */
export function realizedQuery(range: { from: string; to: string }, accountId: string, today: string) {
  const params = { from: range.from, to: range.to, ...(accountId ? { accountId } : {}), today };
  return { queryKey: ["investments", "realized", params] as const, params };
}

/**
 * Realized gains (lots design §5 "Realized gains report"; audit finding
 * b9-conformance-plan-investments-01): one row per disposal of the period from
 * GET /investments/realized (date, account, security, shares, acquired,
 * proceeds, basis, gain, term), unknown-basis and unmatched sales flagged,
 * short- and long-term totals, the unknown-basis proceeds, transfers out
 * listed apart (they realize nothing), and the footer "Wash sales are not
 * applied". URL state: `?year=` (default this year) or `?from=&to=` (the first
 * and last day), `?accountId=`.
 */
export function RealizedPage() {
  const today = useMemo(() => localToday(), []);
  const [searchParams, setSearchParams] = useSearchParams();
  const range = useMemo(() => realizedRange(searchParams, today), [searchParams, today]);
  const accountId = searchParams.get("accountId") ?? "";
  const [draftFrom, setDraftFrom] = useState(range.choice === "custom" ? range.first : `${today.slice(0, 4)}-01-01`);
  const [draftTo, setDraftTo] = useState(range.choice === "custom" ? range.to : today);
  const [custom, setCustom] = useState(range.choice === "custom");

  const { queryKey, params } = realizedQuery(range, accountId, today);
  const realized = useQuery({
    queryKey,
    queryFn: () => api<RealizedGainsResponse>(`/investments/realized${query(params)}`),
    staleTime: INVESTMENTS_STALE_MS,
    placeholderData: keepPreviousData,
  });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<AccountView[]>("/accounts"), staleTime: INVESTMENTS_STALE_MS });
  const accountOptions = useMemo(() => investmentAccountOptions(accounts.data ?? [], accountId), [accounts.data, accountId]);

  const setParams = (patch: Record<string, string | null>) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );
  const customValid = isIsoDate(draftFrom) && isIsoDate(draftTo) && draftFrom <= draftTo && draftTo <= today;
  const r = realized.data;
  const parts = r ? splitDisposals(r.disposals) : null;
  const s = r?.summary;
  const totalGain = s ? (BigInt(s.shortTerm.gainCents) + BigInt(s.longTerm.gainCents)).toString() : null;

  return (
    <>
      <div className="inv-toolbar">
        <h2>Realized gains</h2>
        <div className="row wrap">
          <label className="inline">
            Period
            <select
              aria-label="Period"
              value={custom ? "custom" : range.choice}
              onChange={(e) => {
                if (e.target.value === "custom") return setCustom(true);
                setCustom(false);
                setParams({ year: e.target.value, from: null, to: null });
              }}
            >
              {realizedYears(today).map((y) => (
                <option key={y} value={y}>
                  {y === today.slice(0, 4) ? `${y} (this year)` : y}
                </option>
              ))}
              <option value="custom">Custom dates…</option>
            </select>
          </label>
          {custom && (
            <span className="row wrap inv-custom">
              <input type="date" aria-label="From" value={draftFrom} max={today} onChange={(e) => setDraftFrom(e.target.value)} />
              <span className="muted">to</span>
              <input type="date" aria-label="To" value={draftTo} max={today} onChange={(e) => setDraftTo(e.target.value)} />
              <button type="button" className="secondary" disabled={!customValid} onClick={() => customValid && setParams({ year: null, from: draftFrom, to: draftTo })}>
                Apply
              </button>
              {!customValid && <span className="muted small">from must be on or before to, and to on or before today</span>}
            </span>
          )}
          <label className="inline">
            Account
            <select value={accountId} aria-label="Account filter" onChange={(e) => setParams({ accountId: e.target.value || null })}>
              <option value="">All accounts</option>
              {accountOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({accountTypeLabel(a.type)})
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <ErrorText error={realized.error} />
      <ErrorText error={accounts.error} />
      {!r && realized.isLoading && <p className="muted">Loading…</p>}
      {r && s && parts && (
        <Card
          title={`Realized gains · ${range.choice === "custom" ? `${shortDate(range.first)} to ${shortDate(range.to)}` : range.label}`}
          actions={<span className="muted small">{realized.isFetching ? "updating…" : `${parts.sales.length} sale${parts.sales.length === 1 ? "" : "s"}`}</span>}
        >
          <div className="inv-stats">
            <div className="inv-stat">
              <span className="k">Short-term gain</span>
              <span className={`v ${changeTone(s.shortTerm.gainCents)}`}>{signedMoney(s.shortTerm.gainCents)}</span>
              <span className="sub">
                proceeds {money(s.shortTerm.proceedsCents)}, basis {money(s.shortTerm.basisCents)}
              </span>
            </div>
            <div className="inv-stat">
              <span className="k">Long-term gain</span>
              <span className={`v ${changeTone(s.longTerm.gainCents)}`}>{signedMoney(s.longTerm.gainCents)}</span>
              <span className="sub">
                proceeds {money(s.longTerm.proceedsCents)}, basis {money(s.longTerm.basisCents)}
              </span>
            </div>
            <div className="inv-stat">
              <span className="k">Total realized</span>
              <span className={`v hero ${changeTone(totalGain)}`}>{signedMoney(totalGain)}</span>
              <span className="sub">short and long term, known basis only</span>
            </div>
            {s.unknownBasis.count > 0 && (
              <div className="inv-stat">
                <span className="k">Basis unknown</span>
                <span className="v tone-warn">{money(s.unknownBasis.proceedsCents)}</span>
                <span className="sub">
                  proceeds of {formatQuantity(s.unknownBasis.quantity, 4)} sh in {s.unknownBasis.count} disposal{s.unknownBasis.count === 1 ? "" : "s"}, not in the totals
                </span>
              </div>
            )}
          </div>
          {parts.sales.length === 0 ? (
            <Empty>
              No sales in this period. Sales come from a <Link to="/import">trade-history import</Link> or a sale entered on an account's investments page; an account with positions only
              has no lots to realize.
            </Empty>
          ) : (
            <DisposalsTable rows={parts.sales} showAccount={!accountId} />
          )}
          {!accountId && r.byAccount.length > 1 && (
            <div className="scroll">
              <table className="table small inv-table" aria-label="Realized gains by account">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th className="num">Short-term</th>
                    <th className="num">Long-term</th>
                    <th className="num">Basis unknown (proceeds)</th>
                  </tr>
                </thead>
                <tbody>
                  {r.byAccount.map((a) => (
                    <tr key={a.accountId}>
                      <td>{a.name}</td>
                      <td className={`num ${changeTone(a.summary.shortTerm.gainCents)}`}>{signedMoney(a.summary.shortTerm.gainCents)}</td>
                      <td className={`num ${changeTone(a.summary.longTerm.gainCents)}`}>{signedMoney(a.summary.longTerm.gainCents)}</td>
                      <td className="num">{a.summary.unknownBasis.count > 0 ? money(a.summary.unknownBasis.proceedsCents) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {parts.transfers.length > 0 && (
            <details>
              <summary className="small">
                Transferred out: {formatQuantity(s.transfersOut.quantity, 4)} sh carrying {money(s.transfersOut.basisCents)} of basis to another account (not a sale, nothing realized)
              </summary>
              <DisposalsTable rows={parts.transfers} showAccount={!accountId} />
            </details>
          )}
          <p className="muted small">
            Wash sales are not applied. Gains are the lot engine's: FIFO unless the account uses specific lots and a sale has picks; a term is long after more than a year held. Check the
            figures against your brokerage's 1099-B.
          </p>
        </Card>
      )}
    </>
  );
}

function DisposalsTable({ rows, showAccount }: { rows: readonly LotDisposalView[]; showAccount: boolean }) {
  return (
    <div className="scroll">
      <table className="table inv-table" aria-label="Disposals">
        <thead>
          <tr>
            <th>Date</th>
            {showAccount && <th>Account</th>}
            <th>Security</th>
            <th className="num">Shares</th>
            <th>Acquired</th>
            <th className="num">Proceeds</th>
            <th className="num">Basis</th>
            <th className="num">Gain</th>
            <th>Term</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const note = disposalNote(d);
            return (
              <tr key={`${d.closeTxnId}:${d.lotId ?? "unmatched"}`}>
                <td className="nowrap">{shortDate(d.date)}</td>
                {showAccount && <td>{d.accountName}</td>}
                <td>
                  <strong>{d.ticker ?? "—"}</strong>
                </td>
                <td className="num">{formatQuantity(d.quantity, 4)}</td>
                <td className="nowrap">{d.acquiredDate ? shortDate(d.acquiredDate) : "—"}</td>
                <td className="num">{d.kind === "transfer_out" ? "—" : money(d.proceedsCents)}</td>
                <td className="num">{d.basisCents === null ? "—" : money(d.basisCents)}</td>
                <td className={`num ${changeTone(d.gainCents)}`}>
                  {d.gainCents === null || d.kind === "transfer_out" ? "—" : signedMoney(d.gainCents)}
                  {note && (
                    <div>
                      <Badge tone="warn">{note}</Badge>
                    </div>
                  )}
                </td>
                <td>{termLabel(d.term)}</td>
              </tr>
            );
          })}
        </tbody>
        {rows.length > 1 && (
          <tfoot>
            <tr>
              <th colSpan={showAccount ? 3 : 2}>Total</th>
              <th className="num">{formatQuantity(sumQuantity(rows), 4)}</th>
              <th></th>
              <th className="num">{money(sumCents(rows.filter((d) => d.kind !== "transfer_out").map((d) => d.proceedsCents)))}</th>
              <th className="num">{money(sumCents(rows.map((d) => d.basisCents)))}</th>
              <th className={`num ${changeTone(sumCents(rows.filter((d) => d.kind !== "transfer_out").map((d) => d.gainCents)))}`}>
                {signedMoney(sumCents(rows.filter((d) => d.kind !== "transfer_out").map((d) => d.gainCents)))}
              </th>
              <th></th>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function sumCents(values: ReadonlyArray<string | null>): string {
  return values.reduce((acc, v) => acc + (v === null ? 0n : BigInt(v)), 0n).toString();
}

function sumQuantity(rows: readonly LotDisposalView[]): string {
  return formatFixed8(rows.reduce((acc, d) => acc + parseFixed8(d.quantity), 0n));
}
