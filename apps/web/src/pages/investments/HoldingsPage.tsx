import { Fragment, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { isInvestmentAccountType, parseFixed8 } from "@meridian/shared";
import type { AccountView, BasisSource, HoldingRowView, HoldingsView } from "@meridian/shared";
import { api, query } from "../../lib/api.js";
import { money, shortDate, titleCase } from "../../lib/format.js";
import { localToday } from "../../lib/plan.js";
import {
  asOfFromParams,
  assetClassLabel,
  changeTone,
  concentrationTone,
  coverageLabel,
  formatBp,
  formatPpm,
  formatQuantity,
  priceSourceLabel,
  signedMoney,
  splitLabel,
} from "../../lib/investments.js";
import { Badge, Card, Empty, ErrorText } from "../../components/ui.js";
import { AccountWarnings } from "../../components/investments/AccountWarnings.js";
import { FidelityBadge } from "../../components/investments/FidelityBadge.js";
import { AsOfPicker } from "../../components/investments/Pickers.js";
import { PriceStatusChip } from "../../components/investments/PriceStatusChip.js";
import { SecurityAllocationEditor } from "../../components/investments/SecurityAllocationEditor.js";
import { INVESTMENTS_STALE_MS, useIsViewer } from "../../components/investments/queries.js";
import "./investments.css";
import "./HoldingsPage.css";

/**
 * Holdings (plan decision 16): one row per security across the classified
 * accounts with quantity and value from the chain, cost basis and gains from
 * the lots (coverage full / partial / none, or the statement's basis), the
 * weighted expense ratio and concentration warnings; each row expands to its
 * per-account sub-rows. `?accountId=` filters to one account, `?asOf=` dates
 * the view. Owners edit a security's class and splits inline. Reads
 * GET /investments/holdings and GET /accounts (the filter).
 */
export function HoldingsPage() {
  const today = useMemo(() => localToday(), []);
  const [searchParams, setSearchParams] = useSearchParams();
  const asOf = asOfFromParams(searchParams, today);
  const accountId = searchParams.get("accountId") ?? "";
  const viewer = useIsViewer();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);

  const params = useMemo(() => ({ ...(asOf ? { asOf } : {}), ...(accountId ? { accountId } : {}), today }), [asOf, accountId, today]);
  const holdings = useQuery({
    queryKey: ["investments", "holdings", params],
    queryFn: () => api<HoldingsView>(`/investments/holdings${query(params)}`),
    staleTime: INVESTMENTS_STALE_MS,
    placeholderData: keepPreviousData,
  });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<AccountView[]>("/accounts"), staleTime: INVESTMENTS_STALE_MS });
  const h = holdings.data;
  const investmentAccounts = useMemo(() => (accounts.data ?? []).filter((a) => isInvestmentAccountType(a.type) && !a.closed), [accounts.data]);

  const selectAccount = (id: string) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set("accountId", id);
        else next.delete("accountId");
        return next;
      },
      { replace: true },
    );
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const noAccounts = h ? h.rows.length === 0 && h.excludedAccounts.length === 0 && investmentAccounts.length === 0 && accounts.data !== undefined : false;
  const coveredBp = h?.weightedExpenseRatio.coveredBp ?? null;

  return (
    <>
      <div className="inv-toolbar">
        <h2>Holdings</h2>
        <div className="row wrap">
          <label className="inline">
            Account
            <select value={accountId} onChange={(e) => selectAccount(e.target.value)} aria-label="Account filter">
              <option value="">All accounts</option>
              {investmentAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({titleCase(a.type)})
                </option>
              ))}
              {accountId && !investmentAccounts.some((a) => a.id === accountId) && <option value={accountId}>(selected account)</option>}
            </select>
          </label>
          <AsOfPicker value={asOf} today={today} />
        </div>
      </div>
      <ErrorText error={holdings.error} />
      <ErrorText error={accounts.error} />
      {!h && holdings.isLoading && <p className="muted">Loading…</p>}
      {h && noAccounts && (
        <Card>
          <Empty>
            No investment accounts yet. Set an account's type to brokerage, 401k, IRA, Roth, HSA or 529 on the <Link to="/accounts">Accounts page</Link>, or{" "}
            <Link to="/connections">connect one</Link>.
          </Empty>
        </Card>
      )}
      {h && !noAccounts && h.rows.length === 0 && (
        <Card>
          <Empty>
            Holdings need positions. Connect a brokerage whose SimpleFIN feed includes holdings, <Link to="/import">import a positions CSV</Link>, or enter positions by hand on an account's
            investments page.
          </Empty>
          {h.excludedAccounts.length > 0 && <p className="muted small">Not shown: {h.excludedAccounts.map((e) => `${e.accountName} (${e.fidelity === "balance_only" ? "balance only" : e.fidelity})`).join(", ")}</p>}
          <AccountWarnings warnings={h.warnings} accountWarnings={h.accountWarnings} />
        </Card>
      )}
      {h && h.rows.length > 0 && (
        <>
          <Card title={h.asOf ? `Holdings as of ${shortDate(h.asOf)}` : "Holdings"} actions={<span className="muted small">{holdings.isFetching ? "updating…" : `${h.rows.length} securities`}</span>}>
            <div className="inv-stats">
              <div className="inv-stat">
                <span className="k">Total</span>
                <span className="v hero">{money(h.totalCents)}</span>
              </div>
              <div className="inv-stat">
                <span className="k">Securities</span>
                <span className="v">{money(h.holdingsCents)}</span>
              </div>
              <div className="inv-stat">
                <span className="k">Cash</span>
                <span className="v">{money(h.cashCents)}</span>
                {BigInt(h.residualCents) !== 0n && <span className="sub">+ {money(h.residualCents)} from balance (not in the positions list)</span>}
              </div>
              <div className="inv-stat">
                <span className="k">Weighted expense ratio</span>
                <span className="v">
                  {formatPpm(h.weightedExpenseRatio.ppm)}
                  {h.weightedExpenseRatio.ppm !== null && <span className="muted small"> (≈ {money(h.weightedExpenseRatio.annualCostCents)}/yr)</span>}
                </span>
                {coveredBp !== null && <span className="sub">over {formatBp(coveredBp)} of holdings{coveredBp < 10000 ? " (funds without a known ratio excluded)" : ""}</span>}
              </div>
            </div>
            <div className="scroll">
              <table className="table inv-table hold-table">
                <thead>
                  <tr>
                    <th>Security</th>
                    <th className="num">Shares</th>
                    <th className="num">Price</th>
                    <th className="num">Value</th>
                    <th className="num">Weight</th>
                    <th className="num">Cost basis</th>
                    <th className="num">Gain</th>
                    <th className="num">ER</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {h.rows.map((r) => (
                    <HoldingRows key={r.securityId} r={r} open={expanded.has(r.securityId)} onToggle={() => toggle(r.securityId)} editing={editing === r.securityId} onEdit={viewer ? null : (on) => setEditing(on ? r.securityId : null)} />
                  ))}
                </tbody>
              </table>
            </div>
            {h.concentration.length > 0 && (
              <ul className="hold-concentration">
                {h.concentration.map((c) => (
                  <li key={c.securityId} className={`tone-${concentrationTone(c.level)}`}>
                    <Badge tone={concentrationTone(c.level)}>{c.level}</Badge> {c.message}{" "}
                    <span className="muted small">
                      ({formatBp(c.weightBp)} of the classified total; flagged at {formatBp(c.thresholdBp, { places: 0 })})
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {h.excludedAccounts.length > 0 && (
              <p className="muted small">
                Not shown: {h.excludedAccounts.map((e) => `${e.accountName} (${e.fidelity === "balance_only" ? "balance only" : e.fidelity}${e.cents !== null ? `, ${money(e.cents)}` : ""})`).join(", ")}
              </p>
            )}
            <AccountWarnings warnings={h.warnings} accountWarnings={h.accountWarnings} />
          </Card>
        </>
      )}
    </>
  );
}

const TYPE_LABELS: Record<HoldingRowView["type"], string> = { stock: "stock", etf: "ETF", fund: "fund", bond: "bond", cash: "cash", cd: "CD", other: "other" };

function HoldingRows({ r, open, onToggle, editing, onEdit }: { r: HoldingRowView; open: boolean; onToggle: () => void; editing: boolean; onEdit: ((on: boolean) => void) | null }) {
  const split = splitLabel(r.splits);
  const sources = r.accounts.map((a) => a.basisSource).filter((b): b is BasisSource => b !== null);
  const basisSource: BasisSource | null = sources.length === 0 ? null : sources.every((b) => b === "statement") ? "statement" : "lots";
  const mixed = sources.includes("statement") && sources.includes("lots");
  const basisMarker = r.costBasisCents === null ? null : [coverageLabel(r.coverage, basisSource), mixed ? "partly from statement" : null].filter((m) => m !== null).join(" · ") || null;
  const span = 9;
  return (
    <Fragment>
      <tr>
        <td className="name">
          <button type="button" className="inv-expand" aria-expanded={open} onClick={onToggle}>
            {r.ticker ? <strong>{r.ticker}</strong> : <strong>{r.name}</strong>}
          </button>
          <Badge tone="neutral">{TYPE_LABELS[r.type]}</Badge>
          {r.needsReview && <Badge tone="warn">needs review</Badge>}
          <div className="muted small">
            {r.ticker ? `${r.name} · ` : ""}
            {assetClassLabel(r.assetClass)}
            {split ? ` (${split})` : ""}
          </div>
        </td>
        <td className="num">{r.quantity === null ? <span className="muted">value only</span> : formatQuantity(r.quantity, 4)}</td>
        <td className="num">
          {r.price === null ? "—" : formatQuantity(r.price, 2)}
          <div>
            <PriceStatusChip priceStatus={r.priceStatus} priceDate={r.priceDate} priceSource={r.priceSource} />
          </div>
        </td>
        <td className="num">{money(r.valueCents)}</td>
        <td className="num">{formatBp(r.weightBp)}</td>
        <td className="num">
          {money(r.costBasisCents)}
          {basisMarker && <div className="muted small">{basisMarker}</div>}
        </td>
        <td className={`num ${changeTone(r.gainCents)}`}>
          {signedMoney(r.gainCents)}
          {r.gainBp !== null && <div className="small">{formatBp(r.gainBp, { sign: true })}</div>}
        </td>
        <td className="num">{formatPpm(r.expenseRatioPpm)}</td>
        <td className="actions">
          <button type="button" className="link small" onClick={onToggle}>
            {open ? "hide" : `${r.accounts.length} account${r.accounts.length === 1 ? "" : "s"}`}
          </button>
          {onEdit && (
            <button type="button" className="link small" onClick={() => onEdit(!editing)}>
              {editing ? "cancel" : "class"}
            </button>
          )}
        </td>
      </tr>
      {editing && onEdit && (
        <tr className="inv-detail">
          <td colSpan={span}>
            <SecurityAllocationEditor security={r} onClose={() => onEdit(false)} />
          </td>
        </tr>
      )}
      {open &&
        r.accounts.map((a, i) => (
          <tr className="inv-sub" key={`${a.accountId}-${a.kind}-${i}`}>
            <td>
              {a.accountName}
              <FidelityBadge fidelity={a.fidelity} fidelityNote={a.fidelityNote} accountId={a.accountId} />
              {a.kind === "cash" && <span className="muted small"> · reported</span>}
              {(a.kind === "cash_plug" || a.kind === "carried_flows") && <span className="muted small"> · unlisted (balance − positions)</span>}
              {a.dollarOnly && <Badge tone="neutral">value only</Badge>}
            </td>
            <td className="num">{a.quantity === null ? <span className="muted">value only</span> : formatQuantity(a.quantity, 4)}</td>
            <td className="num muted small">
              {priceSourceLabel(a.priceSource)}
              {a.snapshotDate && (
                <div>
                  snapshot {shortDate(a.snapshotDate)}
                  {a.snapshotSource ? ` · ${a.snapshotSource}` : ""}
                </div>
              )}
            </td>
            <td className="num">{money(a.valueCents)}</td>
            <td></td>
            <td className="num">
              {money(a.costBasisCents)}
              {a.basisSource === "statement" && <div className="muted small">from statement</div>}
              {a.unknownBasisQuantity !== null && parseFixed8(a.unknownBasisQuantity) !== 0n && <div className="tone-warn small">basis unknown for {formatQuantity(a.unknownBasisQuantity, 4)} sh</div>}
            </td>
            <td className={`num ${changeTone(a.gainCents)}`}>{signedMoney(a.gainCents)}</td>
            <td className="num muted small">{a.lotCount !== null ? `${a.lotCount} lot${a.lotCount === 1 ? "" : "s"}` : ""}</td>
            <td className="actions">
              <Link className="small" to={`/investments/accounts/${a.accountId}`}>
                activity
              </Link>
            </td>
          </tr>
        ))}
    </Fragment>
  );
}
