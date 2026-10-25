import { Fragment, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import type { AllocationClassView, AllocationView, HouseholdSettingView } from "@meridian/shared";
import { api, query } from "../../lib/api.js";
import { money, shortDate } from "../../lib/format.js";
import { localToday } from "../../lib/plan.js";
import { asOfFromParams, assetClassLabel, bpToPpInput, driftTone, formatBp, formatPp, lineKindLabel, signedMoney, taxTreatmentLabel } from "../../lib/investments.js";
import { Badge, Card, Empty, ErrorText } from "../../components/ui.js";
import { AccountWarnings } from "../../components/investments/AccountWarnings.js";
import { AllocationBars } from "../../components/investments/AllocationBars.js";
import { AllocationTargetsEditor } from "../../components/investments/AllocationTargetsEditor.js";
import { FidelityBadge } from "../../components/investments/FidelityBadge.js";
import { AsOfPicker } from "../../components/investments/Pickers.js";
import { RebalanceTable } from "../../components/investments/RebalanceTable.js";
import { INVESTMENTS_STALE_MS, useIsViewer } from "../../components/investments/queries.js";
import "./investments.css";
import "./AllocationPage.css";

/**
 * Allocation (plan decision 16): the classified value by asset class against
 * the household's targets, the drift against the band, the lines behind each
 * class, the same sums by tax treatment and by account, balance-only
 * accounts as unclassified, the targets editor (owner) and the deterministic
 * rebalance suggestion. `?asOf=` in the URL. Reads GET /investments/allocation
 * and GET /settings; the editors write PUT /investments/allocation-targets and
 * PATCH /settings.
 */
export function AllocationPage() {
  const today = useMemo(() => localToday(), []);
  const [searchParams] = useSearchParams();
  const asOf = asOfFromParams(searchParams, today);
  const viewer = useIsViewer();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<boolean | null>(null);

  const params = useMemo(() => ({ ...(asOf ? { asOf } : {}), today }), [asOf, today]);
  const allocation = useQuery({
    queryKey: ["investments", "allocation", params],
    queryFn: () => api<AllocationView>(`/investments/allocation${query(params)}`),
    staleTime: INVESTMENTS_STALE_MS,
    placeholderData: keepPreviousData,
  });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<HouseholdSettingView>("/settings"), enabled: !viewer });
  const a = allocation.data;

  const classified = a ? a.byAccount.length > 0 : false;
  const noAccounts = a ? a.byAccount.length === 0 && a.unclassifiedAccounts.length === 0 : false;
  const editorOpen = editing ?? (a ? !a.targetsSet : false);
  const blendedTickers = useMemo(() => {
    const set = new Set<string>();
    for (const c of a?.classes ?? []) for (const l of c.lines) if (l.blended) set.add(l.ticker ?? l.name);
    return [...set];
  }, [a?.classes]);
  const bandPp = a ? bpToPpInput(a.rebalance?.bandBp ?? settings.data?.rebalanceBandBp ?? 500) : "5.0";

  return (
    <>
      <div className="inv-toolbar">
        <h2>Allocation</h2>
        <AsOfPicker value={asOf} today={today} />
      </div>
      <ErrorText error={allocation.error} />
      {!a && allocation.isLoading && <p className="muted">Loading…</p>}
      {a && noAccounts && (
        <Card>
          <Empty>
            No investment accounts yet. Set an account's type to brokerage, 401k, IRA, Roth, HSA or 529 on the <Link to="/accounts">Accounts page</Link>, or{" "}
            <Link to="/connections">connect one</Link>.
          </Empty>
        </Card>
      )}
      {a && !noAccounts && !classified && (
        <Card>
          <Empty>
            Allocation needs positions. Connect a brokerage whose SimpleFIN feed includes holdings, <Link to="/import">import a positions CSV</Link>, or enter positions by hand on an account's
            investments page.
          </Empty>
          <UnclassifiedCard a={a} />
        </Card>
      )}
      {a && classified && (
        <>
          <Card title={a.asOf ? `Classes as of ${shortDate(a.asOf)}` : "Classes"} actions={<span className="muted small">{allocation.isFetching ? "updating…" : a.targetsSet ? `band ${bandPp} pp` : "no targets set"}</span>}>
            <div className="inv-stats">
              <div className="inv-stat">
                <span className="k">Classified value</span>
                <span className="v hero">{money(a.classifiedCents)}</span>
                {BigInt(a.unclassifiedCents) !== 0n && (
                  <span className="sub">
                    of {money(a.totalCents)} total; {money(a.unclassifiedCents)} unclassified
                  </span>
                )}
              </div>
              <div className="inv-stat">
                <span className="k">Out of band</span>
                <span className={`v ${a.classes.some((c) => c.outOfBand) ? "tone-warn" : ""}`}>
                  {a.targetsSet ? (a.classes.filter((c) => c.outOfBand).map((c) => assetClassLabel(c.assetClass)).join(", ") || "none") : "—"}
                </span>
                {a.targetsSet && <span className="sub">drift beyond {bandPp} pp of target</span>}
              </div>
            </div>
            <AllocationBars classes={a.classes} targetsSet={a.targetsSet} />
            <AccountWarnings warnings={a.warnings} accountWarnings={a.accountWarnings} />
          </Card>

          <Card title="By class">
            <div className="scroll">
              <table className="table inv-table alloc-table">
                <thead>
                  <tr>
                    <th>Class</th>
                    <th className="num">Current</th>
                    <th className="num">Current %</th>
                    <th className="num">Target %</th>
                    <th className="num">Drift</th>
                    <th className="num">Drift $</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {a.classes.map((c) => (
                    <ClassRows key={c.assetClass} c={c} targetsSet={a.targetsSet} open={expanded === c.assetClass} onToggle={() => setExpanded(expanded === c.assetClass ? null : c.assetClass)} />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">Percentages are truncated and may not add up to exactly 100%.</p>
          </Card>

          <UnclassifiedCard a={a} />

          <Card title="Targets and rebalancing" actions={!viewer && a.targetsSet ? <button type="button" className="secondary" onClick={() => setEditing(!editorOpen)}>{editorOpen ? "Close editor" : "Edit targets"}</button> : undefined}>
            {viewer ? (
              <p className="muted small">
                {a.targetsSet ? `Targets are set; a class is flagged beyond ${bandPp} pp of drift.` : "No targets set. An owner can set them here."}
              </p>
            ) : (
              <>
                <ErrorText error={settings.error} />
                {editorOpen && <AllocationTargetsEditor classes={a.classes} targetsSet={a.targetsSet} settings={settings.data} />}
                {!editorOpen && settings.data && (
                  <p className="muted small">
                    Rebalance when a class drifts more than {bpToPpInput(settings.data.rebalanceBandBp)} pp; ignore trades under {money(settings.data.rebalanceMinTradeCents)}.
                  </p>
                )}
              </>
            )}
            {a.rebalance ? <RebalanceTable rebalance={a.rebalance} blendedTickers={blendedTickers} /> : <p className="muted">Set targets to get a rebalance suggestion.</p>}
          </Card>

          <div className="alloc-secondary">
            <Card title="By tax treatment">
              <table className="table small inv-table">
                <thead>
                  <tr>
                    <th>Treatment</th>
                    <th className="num">Value</th>
                    <th className="num">Share</th>
                    <th>Classes</th>
                  </tr>
                </thead>
                <tbody>
                  {a.byTaxTreatment.map((t) => (
                    <tr key={t.taxTreatment}>
                      <td>{taxTreatmentLabel(t.taxTreatment)}</td>
                      <td className="num">{money(t.cents)}</td>
                      <td className="num">{formatBp(t.bp)}</td>
                      <td className="muted small">{t.classes.filter((c) => BigInt(c.cents) !== 0n).map((c) => `${assetClassLabel(c.assetClass)} ${money(c.cents)}`).join(" · ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="By account">
              <table className="table small inv-table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th className="num">Value</th>
                    <th className="num">Share</th>
                    <th>Classes</th>
                  </tr>
                </thead>
                <tbody>
                  {a.byAccount.map((acct) => (
                    <tr key={acct.accountId}>
                      <td>
                        {acct.accountName}
                        <FidelityBadge fidelity={acct.fidelity} fidelityNote={acct.fidelityNote} accountId={acct.accountId} />
                      </td>
                      <td className="num">{money(acct.cents)}</td>
                      <td className="num">{formatBp(acct.bp)}</td>
                      <td className="muted small">{acct.classes.filter((c) => BigInt(c.cents) !== 0n).map((c) => `${assetClassLabel(c.assetClass)} ${formatBp(c.bp)}`).join(" · ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        </>
      )}
    </>
  );
}

function ClassRows({ c, targetsSet, open, onToggle }: { c: AllocationClassView; targetsSet: boolean; open: boolean; onToggle: () => void }) {
  const hasLines = c.lines.length > 0;
  return (
    <Fragment>
      <tr className={c.outOfBand ? "out" : ""}>
        <td className="name">
          {hasLines ? (
            <button type="button" className="inv-expand" aria-expanded={open} onClick={onToggle}>
              {assetClassLabel(c.assetClass)}
            </button>
          ) : (
            <span className="muted">{assetClassLabel(c.assetClass)}</span>
          )}
        </td>
        <td className="num">{money(c.currentCents)}</td>
        <td className="num">{formatBp(c.currentBp)}</td>
        <td className="num">{targetsSet ? formatBp(c.targetBp) : "—"}</td>
        <td className="num">
          {targetsSet ? (
            <Badge tone={driftTone(c)}>
              {formatPp(c.driftBp)}
              {c.outOfBand ? " · out of band" : ""}
            </Badge>
          ) : (
            "—"
          )}
        </td>
        <td className="num">{targetsSet ? signedMoney(c.driftCents) : "—"}</td>
        <td className="actions">
          {hasLines && (
            <button type="button" className="link small" onClick={onToggle}>
              {open ? "hide" : `${c.lines.length} line${c.lines.length === 1 ? "" : "s"}`}
            </button>
          )}
        </td>
      </tr>
      {open &&
        c.lines.map((l, i) => (
          <tr className="inv-sub" key={`${l.accountId}-${l.securityId ?? l.kind}-${i}`}>
            <td>
              {l.ticker ? <strong>{l.ticker}</strong> : null} {l.kind === "cash_plug" || l.kind === "carried_flows" ? lineKindLabel(l.kind) : l.name}
              {l.blended && <Badge tone="info">blended</Badge>}
            </td>
            <td className="num">{money(l.cents)}</td>
            <td colSpan={5}>{l.accountName}</td>
          </tr>
        ))}
    </Fragment>
  );
}

function UnclassifiedCard({ a }: { a: AllocationView }) {
  if (a.unclassifiedAccounts.length === 0) return null;
  return (
    <Card title="Not classified">
      <ul className="alloc-unclassified">
        {a.unclassifiedAccounts.map((u) => (
          <li key={u.accountId}>
            <strong>{u.accountName}</strong> ({money(u.cents)}, {u.fidelity === "balance_only" ? "balance only" : u.fidelity}
            {u.bpOfTotal !== null ? `, ${formatBp(u.bpOfTotal)} of the total` : ""}) is not in these percentages. <Link to={`/investments/accounts/${u.accountId}`}>Import positions</Link> to classify
            it.
          </li>
        ))}
      </ul>
    </Card>
  );
}
