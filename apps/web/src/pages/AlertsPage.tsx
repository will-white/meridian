import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { AlertKind, AlertList, type AlertView } from "@meridian/shared";
import { api, query } from "../lib/api.js";
import { relativeTime, shortDate } from "../lib/format.js";
import { Badge, Empty, ErrorText } from "../components/ui.js";
import { ALERT_TITLES, ALERT_TONES, alertLink, alertMessage } from "../components/recurring/recurringFormat.js";
import "./AlertsPage.css";

type KindFilter = "" | AlertKind;

export function AlertsPage() {
  const qc = useQueryClient();
  const [kind, setKind] = useState<KindFilter>("");
  const [showDismissed, setShowDismissed] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const params = { kind: kind || undefined, includeDismissed: showDismissed, includeResolved: showResolved, limit: 200 };
  const alerts = useQuery({
    queryKey: ["alerts", params],
    queryFn: () => api<typeof AlertList._output>(`/alerts${query(params)}`),
    placeholderData: keepPreviousData,
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["alerts"] });
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
  };
  const dismiss = useMutation({
    mutationFn: (id: string) => api<AlertView>(`/alerts/${id}/dismiss`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const dismissAll = useMutation({
    mutationFn: (k: KindFilter) => api<{ dismissed: number }>("/alerts/dismiss-all", { method: "POST", body: k ? { kind: k } : {} }),
    onSuccess: (res) => {
      setNotice(`Dismissed ${res.dismissed} alert${res.dismissed === 1 ? "" : "s"}.`);
      invalidate();
    },
  });

  const items = alerts.data?.items ?? [];
  const openCount = items.filter((a) => !a.dismissedAt && !a.resolvedAt).length;

  return (
    <>
      <div className="row space wrap">
        <h1>Alerts</h1>
        <button
          className="secondary"
          onClick={() => dismissAll.mutate(kind)}
          disabled={dismissAll.isPending || openCount === 0}
          title={kind ? `Dismiss every open ${ALERT_TITLES[kind].toLowerCase()} alert` : "Dismiss every open alert"}
        >
          Dismiss all{kind ? ` ${ALERT_TITLES[kind].toLowerCase()}` : ""} ({openCount})
        </button>
      </div>
      <div className="alerts-toolbar">
        <select value={kind} onChange={(e) => setKind(e.target.value as KindFilter)} aria-label="Kind">
          <option value="">All kinds</option>
          {AlertKind.options.map((k) => (
            <option key={k} value={k}>
              {ALERT_TITLES[k]}
            </option>
          ))}
        </select>
        <label className="inline">
          <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} /> show dismissed
        </label>
        <label className="inline">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> show resolved
        </label>
      </div>
      <ErrorText error={alerts.error} />
      <ErrorText error={dismiss.error} />
      <ErrorText error={dismissAll.error} />
      {notice && (
        <p className="notice">
          {notice}{" "}
          <button className="link" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </p>
      )}
      {alerts.isLoading && <p className="muted">Loading…</p>}
      {!alerts.isLoading && items.length === 0 && (
        <Empty>
          {showDismissed || showResolved || kind ? "No alerts match." : "No open alerts. Price increases, new recurring charges, missed charges and converted free trials show up here."}
        </Empty>
      )}
      {items.length > 0 && (
        <ul className="alerts-list">
          {items.map((a) => {
            const closed = a.dismissedAt !== null || a.resolvedAt !== null;
            const link = alertLink(a);
            return (
              <li key={a.id} className={`alert-item alert-${a.kind}${closed ? " closed" : ""}`}>
                <div className="alert-body">
                  <div>
                    <Badge tone={ALERT_TONES[a.kind]}>{ALERT_TITLES[a.kind]}</Badge>
                    {a.resolvedAt && <Badge tone="ok">resolved</Badge>}
                    {a.dismissedAt && <Badge tone="neutral">dismissed</Badge>}
                  </div>
                  <div>{alertMessage(a)}</div>
                  <div className="alert-meta">
                    <span title={a.createdAt}>
                      {relativeTime(a.createdAt)} · {shortDate(a.createdAt)}
                    </span>
                    {a.kind === "missed_charge" && !a.resolvedAt && !a.dismissedAt && <span>Clears itself when the charge arrives late.</span>}
                    {a.kind === "new_recurring" && !a.resolvedAt && !a.dismissedAt && <span>Clears itself once the suggestion is confirmed or dismissed.</span>}
                  </div>
                </div>
                <div className="alert-actions">
                  <Link to={link.to} className="small">
                    {link.label}
                  </Link>
                  {a.transactionId && a.recurringId && (
                    <Link to={`/transactions?q=${encodeURIComponent(a.payeeName)}`} className="small">
                      Transactions
                    </Link>
                  )}
                  {!closed && (
                    <button className="secondary" onClick={() => dismiss.mutate(a.id)} disabled={dismiss.isPending}>
                      Dismiss
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
