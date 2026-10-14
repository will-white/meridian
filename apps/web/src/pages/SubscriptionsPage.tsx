import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import type { SubscriptionsResponse } from "@meridian/shared";
import { api } from "../lib/api.js";
import { money, shortDate } from "../lib/format.js";
import { Badge, Card, Empty, ErrorText } from "../components/ui.js";
import { CADENCE_LABELS, absCents, dueLabel, expectedLabel, localToday, percentLabel, shareBp } from "../components/recurring/recurringFormat.js";
import { useRecurringMutations } from "../components/recurring/useRecurringMutations.js";
import "./SubscriptionsPage.css";

type Row = SubscriptionsResponse["items"][number];

export function SubscriptionsPage() {
  const subs = useQuery({ queryKey: ["recurring", "subscriptions"], queryFn: () => api<SubscriptionsResponse>("/recurring/subscriptions") });
  const mutations = useRecurringMutations();
  const today = useMemo(() => localToday(), []);
  const data = subs.data;
  const totalYearly = data ? BigInt(data.totalYearlyCents) : 0n;

  const nameCell = (row: Row) => (
    <td>
      <Link to={`/recurring?focus=${row.id}`}>
        <strong>{row.name}</strong>
      </Link>
      {row.amountMode === "variable" && <Badge tone="neutral">variable</Badge>}
      <div className="muted small">
        {row.payeeName !== row.name ? `${row.payeeName} · ` : ""}
        {row.categoryName ?? "no category"}
      </div>
    </td>
  );

  return (
    <>
      <div className="row space wrap">
        <h1>Subscriptions</h1>
        <Link to="/recurring" className="small">
          Manage recurring items →
        </Link>
      </div>
      <ErrorText error={subs.error} />
      <ErrorText error={mutations.update.error} />
      {subs.isLoading && <p className="muted">Loading…</p>}
      {data && (
        <div className="subs-totals">
          <div className="subs-stat">
            <span className="muted small">Per month</span>
            <strong>{money(absCents(data.totalMonthlyCents))}</strong>
          </div>
          <div className="subs-stat">
            <span className="muted small">Per year</span>
            <strong>{money(absCents(data.totalYearlyCents))}</strong>
          </div>
          <div className="subs-stat">
            <span className="muted small">Active</span>
            <strong>{data.items.length}</strong>
            {data.pausedItems.length > 0 && (
              <span className="muted small">
                {data.pausedItems.length} paused (not counted)
              </span>
            )}
          </div>
        </div>
      )}
      {data && data.items.length === 0 && <Empty>No active bills or subscriptions yet. Confirm the detector's suggestions on the Recurring page, or add one by hand.</Empty>}
      {data && data.items.length > 0 && (
        <Card title="Active" actions={<span className="muted small">most expensive first · monthly = yearly ÷ 12</span>}>
          <div className="scroll">
            <table className="table subs-table">
              <thead>
                <tr>
                  <th>Subscription</th>
                  <th className="subs-col-cadence">Repeats</th>
                  <th className="num subs-col-each">Each</th>
                  <th className="num">Monthly</th>
                  <th className="num">Yearly</th>
                  <th className="subs-col-share">Share</th>
                  <th>Next due</th>
                  <th className="subs-col-last">Last paid</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => {
                  const bp = shareBp(BigInt(row.yearlyCents), totalYearly);
                  return (
                    <tr key={row.id}>
                      {nameCell(row)}
                      <td className="subs-col-cadence nowrap">{CADENCE_LABELS[row.cadence]}</td>
                      <td className="num nowrap subs-col-each">{expectedLabel(row)}</td>
                      <td className="num nowrap">{money(absCents(row.monthlyEquivalentCents))}</td>
                      <td className="num nowrap">
                        <strong>{money(absCents(row.yearlyCents))}</strong>
                      </td>
                      <td className="subs-col-share">
                        <div className="subs-share" title={`${percentLabel(bp)} of the yearly total`}>
                          <div className="subs-bar">
                            <span style={{ width: `${bp / 100}%` }} />
                          </div>
                          <span className="muted small nowrap">{percentLabel(bp)}</span>
                        </div>
                      </td>
                      <td className="nowrap">
                        {dueLabel(row.nextDueDate, today)}
                        {row.consecutiveMissed > 0 && <Badge tone="bad">{row.consecutiveMissed} missed</Badge>}
                        {row.nextDueDate && <div className="muted small">{shortDate(row.nextDueDate)}</div>}
                      </td>
                      <td className="subs-col-last nowrap">
                        {row.lastChargeDate ? (
                          <>
                            {shortDate(row.lastChargeDate)}
                            <div className="muted small">{money(row.lastChargeCents ? absCents(row.lastChargeCents) : null)}</div>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} className="subs-col-foot">
                    Total · {data.items.length} item{data.items.length === 1 ? "" : "s"}
                  </td>
                  <td className="num nowrap">
                    <strong>{money(absCents(data.totalMonthlyCents))}</strong>
                  </td>
                  <td className="num nowrap">
                    <strong>{money(absCents(data.totalYearlyCents))}</strong>
                  </td>
                  <td colSpan={3}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}
      {data && data.pausedItems.length > 0 && (
        <Card title="Paused" actions={<span className="muted small">not counted in the totals</span>}>
          <div className="scroll">
            <table className="table subs-table">
              <thead>
                <tr>
                  <th>Subscription</th>
                  <th className="subs-col-cadence">Repeats</th>
                  <th className="num subs-col-each">Each</th>
                  <th className="num">Monthly</th>
                  <th className="num">Yearly</th>
                  <th className="subs-col-last">Last paid</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.pausedItems.map((row) => (
                  <tr key={row.id} className="muted">
                    {nameCell(row)}
                    <td className="subs-col-cadence nowrap">{CADENCE_LABELS[row.cadence]}</td>
                    <td className="num nowrap subs-col-each">{expectedLabel(row)}</td>
                    <td className="num nowrap">{money(absCents(row.monthlyEquivalentCents))}</td>
                    <td className="num nowrap">{money(absCents(row.yearlyCents))}</td>
                    <td className="subs-col-last nowrap">{row.lastChargeDate ? shortDate(row.lastChargeDate) : "—"}</td>
                    <td className="nowrap">
                      {row.consecutiveMissed >= 3 && <Badge tone="warn">auto-paused</Badge>}
                      <button className="link" onClick={() => mutations.update.mutate({ id: row.id, status: "active" })} disabled={mutations.update.isPending}>
                        Resume
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
