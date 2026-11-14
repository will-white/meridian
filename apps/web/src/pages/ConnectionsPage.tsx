import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionView, ImportLogView, JobView } from "@meridian/shared";
import { api } from "../lib/api.js";
import { syncAdvice, syncControls, syncSummary } from "../lib/connections.js";
import { relativeTime } from "../lib/format.js";
import { csvKindLabel } from "../lib/importMapping.js";
import { Badge, Card, Empty, ErrorText } from "../components/ui.js";
import { useIsViewer } from "../components/investments/queries.js";

const STATUS_TONE: Record<ConnectionView["status"], "ok" | "warn" | "bad" | "info" | "neutral"> = {
  ok: "ok",
  claiming: "info",
  auth_required: "warn",
  error: "bad",
  disabled: "neutral",
};

const STATUS_LABEL: Record<ConnectionView["status"], string> = {
  ok: "Connected",
  claiming: "Claiming token…",
  auth_required: "Needs re-authentication",
  error: "Error",
  disabled: "Disabled",
};

export function ConnectionsPage() {
  const qc = useQueryClient();
  const viewer = useIsViewer();
  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: () => api<ConnectionView[]>("/connections"),
    refetchInterval: (q) => (q.state.data?.some((c) => c.activeJob) ? 3000 : 30_000),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["connections"] });
    void qc.invalidateQueries({ queryKey: ["accounts"] });
    void qc.invalidateQueries({ queryKey: ["transactions"] });
  };
  const add = useMutation({
    mutationFn: (body: { name: string; token: string }) => api<ConnectionView>("/connections/simplefin", { method: "POST", body }),
    onSuccess: () => {
      setName("");
      setToken("");
      invalidate();
    },
  });
  // A full resync asks the Bridge for the whole first-sync window again (after a bank was unreadable for a while).
  const sync = useMutation({
    mutationFn: ({ id, balancesOnly, fullResync }: { id: string; balancesOnly?: boolean; fullResync?: boolean }) =>
      api(`/connections/${id}/sync`, { method: "POST", body: { balancesOnly: balancesOnly ?? false, fullResync: fullResync ?? false } }),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: (id: string) => api(`/connections/${id}`, { method: "DELETE" }), onSuccess: invalidate });
  // A CSV profile's delete has its own mutation, so its error shows beside the profiles (audit a8-ledger-ui-07).
  const removeProfile = useMutation({ mutationFn: (id: string) => api(`/connections/${id}`, { method: "DELETE" }), onSuccess: invalidate });
  // Phase 3: replay the stored sync payloads through the holdings parser (plan decision 18).
  // Audit a5-ingest-transfers-13: replay the stored payloads' transactions.
  const reprocessTransactions = useMutation({
    mutationFn: (id: string) => api<JobView>(`/connections/${id}/reprocess-transactions`, { method: "POST", body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["connections"] }),
  });
  const reprocess = useMutation({
    mutationFn: (id: string) => api<JobView>(`/connections/${id}/reprocess-holdings`, { method: "POST", body: {} }),
    onSuccess: () => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ["investments"] });
      void qc.invalidateQueries({ queryKey: ["valuation"] });
    },
  });
  const toggle = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "ok" | "disabled" }) => api(`/connections/${id}`, { method: "PATCH", body: { status } }),
    onSuccess: invalidate,
  });
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [openLog, setOpenLog] = useState<string | null>(null);

  const simplefin = connections.data?.filter((c) => c.type === "simplefin") ?? [];
  const profiles = connections.data?.filter((c) => c.type === "csv") ?? [];

  return (
    <>
      <h1>Connections</h1>
      <Card title="SimpleFIN">
        <p className="muted">
          Create a setup token at the SimpleFIN Bridge and paste it here. The worker exchanges it for an access URL, stores that encrypted, and syncs every 6
          hours. While a bank needs attention at the Bridge nothing is lost: the first complete sync afterwards fetches everything since the last one. Nothing
          here can move money.
        </p>
        {/* Audit a8-ledger-ui-05: a viewer reads the connections and changes none of them. */}
        {!viewer && (
          <form
            className="row wrap"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate({ name: name.trim() || "SimpleFIN", token: token.trim() });
            }}
          >
            <input placeholder="Name (e.g. Chase + Fidelity)" aria-label="Connection name" value={name} onChange={(e) => setName(e.target.value)} />
            <input placeholder="Paste setup token" aria-label="SimpleFIN setup token" value={token} onChange={(e) => setToken(e.target.value)} required className="grow" />
            <button type="submit" disabled={add.isPending}>
              Connect
            </button>
          </form>
        )}
        <ErrorText error={add.error} />
        <ErrorText error={sync.error} />
        <ErrorText error={reprocess.error} />
        <ErrorText error={reprocessTransactions.error} />
        {/* Audit a8-ledger-ui-07: a failed Disable, Enable or Remove says so. */}
        <ErrorText error={toggle.error} />
        <ErrorText error={remove.error} />
        {/* Audit a8-ledger-ui-06: a list that did not load is an error, never "no connections". */}
        <ErrorText error={connections.error} />
        {connections.isLoading && <p className="muted">Loading…</p>}
        {connections.data !== undefined && simplefin.length === 0 && <Empty>No SimpleFIN connections yet.</Empty>}
        <ul className="list">
          {simplefin.map((c) => (
            <li key={c.id} className="list-item">
              <div className="grow">
                <div className="row wrap">
                  <strong>{c.name}</strong>
                  <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
                  {c.activeJob && (
                    <Badge tone="info">
                      {c.activeJob.type.replace("simplefin.", "")} {c.activeJob.status}
                    </Badge>
                  )}
                  <span className="muted">{syncSummary(c, relativeTime)}</span>
                </div>
                {c.lastError && <p className="error small">{c.lastError}</p>}
                {syncAdvice(c) && <p className="muted small">{syncAdvice(c)}</p>}
                <HoldingsLine connection={c} />
                {c.lastErrors.filter((e) => !e.code.startsWith("holdings.")).length > 0 && (
                  <ul className="errors">
                    {c.lastErrors
                      .filter((e) => !e.code.startsWith("holdings."))
                      .map((e, i) => (
                        <li key={i}>
                          {/* The message names the account (audit a8-ledger-ui-11); the Bridge's id means nothing here. */}
                          <code>{e.code}</code> {e.message}
                        </li>
                      ))}
                  </ul>
                )}
                {openLog === c.id && <ImportLogs connectionId={c.id} />}
              </div>
              <div className="row wrap conn-actions">
                {!viewer && (
                  <button onClick={() => sync.mutate({ id: c.id })} disabled={sync.isPending || !syncControls(c).syncNow}>
                    Sync now
                  </button>
                )}
                {!viewer && (
                  <button className="secondary" onClick={() => sync.mutate({ id: c.id, balancesOnly: true })} disabled={sync.isPending || !syncControls(c).balancesOnly}>
                    Balances only
                  </button>
                )}
                {!viewer && (
                  <button
                    className="secondary"
                    onClick={() => sync.mutate({ id: c.id, fullResync: true })}
                    disabled={sync.isPending || !syncControls(c).fullResync}
                    title="Ask the Bridge again for everything a first sync asks for (about three months). Use it after a bank was unreadable for a while; nothing is added twice"
                  >
                    Full resync
                  </button>
                )}
                {!viewer && (
                  <button
                    className="secondary"
                    onClick={() => reprocess.mutate(c.id)}
                    disabled={reprocess.isPending || !!c.activeJob || c.status === "disabled"}
                    title="Re-read the holdings in the stored sync payloads (after a parser change); no bank call is made"
                  >
                    Re-process holdings
                  </button>
                )}
                {!viewer && (
                  <button
                    className="secondary"
                    onClick={() => reprocessTransactions.mutate(c.id)}
                    disabled={reprocessTransactions.isPending || !!c.activeJob || c.status === "disabled"}
                    title="Re-read the transactions in every stored sync payload, also those older than the Bridge's three months (after an update); rows the ledger has are left as they are and nothing is added twice. No bank call is made"
                  >
                    Re-read transactions
                  </button>
                )}
                <button className="secondary" onClick={() => setOpenLog(openLog === c.id ? null : c.id)}>
                  {openLog === c.id ? "Hide log" : "Log"}
                </button>
                {!viewer && (
                  <button className="secondary" onClick={() => toggle.mutate({ id: c.id, status: c.status === "disabled" ? "ok" : "disabled" })} disabled={toggle.isPending}>
                    {c.status === "disabled" ? "Enable" : "Disable"}
                  </button>
                )}
                {!viewer && (
                  <button
                    className="danger"
                    onClick={() => {
                      if (confirm(`Remove ${c.name}? Accounts and transactions stay; the access URL is deleted. Adding the connection again attaches the same accounts.`)) remove.mutate(c.id);
                    }}
                    disabled={remove.isPending}
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="CSV mapping profiles">
        <ErrorText error={removeProfile.error} />
        {connections.data === undefined ? null : profiles.length === 0 ? (
          <Empty>No saved mappings. Import a CSV and tick "save this mapping" to add one.</Empty>
        ) : (
          <ul className="list">
            {profiles.map((p) => (
              <li key={p.id} className="list-item">
                <div className="grow">
                  <strong>{p.name}</strong> <span className="muted">· {csvKindLabel(p.csvKind)} · last import {relativeTime(p.lastSyncAt)}</span>
                  {p.csvMapping && (
                    <div className="muted small">
                      date: {String(p.csvMapping.date.column)} ({p.csvMapping.date.format}) · description: {String(p.csvMapping.description.column)} · amount:{" "}
                      {p.csvMapping.amount.mode === "single" ? String(p.csvMapping.amount.column) : `${String(p.csvMapping.amount.debitColumn)} / ${String(p.csvMapping.amount.creditColumn)}`}
                    </div>
                  )}
                  {p.positionsMapping && (
                    <div className="muted small">
                      symbol: {p.positionsMapping.symbol ? String(p.positionsMapping.symbol.column) : "—"} · name: {p.positionsMapping.name ? String(p.positionsMapping.name.column) : "—"} · quantity:{" "}
                      {p.positionsMapping.quantity ? String(p.positionsMapping.quantity.column) : "—"} · value: {p.positionsMapping.value ? String(p.positionsMapping.value.column) : "—"} · date:{" "}
                      {p.positionsMapping.asOf.mode === "column" ? `${String(p.positionsMapping.asOf.column)} (${p.positionsMapping.asOf.format})` : "entered at import"}
                    </div>
                  )}
                  {p.tradesMapping && (
                    <div className="muted small">
                      date: {String(p.tradesMapping.date.column)} ({p.tradesMapping.date.format}) · action: {String(p.tradesMapping.action.column)} · symbol: {p.tradesMapping.symbol ? String(p.tradesMapping.symbol.column) : "—"} · amount:{" "}
                      {p.tradesMapping.amount ? String(p.tradesMapping.amount.column) : "derived"} · {Object.keys(p.tradesMapping.actionMap).length} mapped action{Object.keys(p.tradesMapping.actionMap).length === 1 ? "" : "s"} · reinvest rows{" "}
                      {p.tradesMapping.reinvestRows}
                    </div>
                  )}
                </div>
                {!viewer && (
                  <button className="danger" onClick={() => removeProfile.mutate(p.id)} disabled={removeProfile.isPending}>
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/** The holdings read by the last sync: accounts with positions from the stats, and the `holdings.*` notes (unrecognised or partial `extra` shapes) per account. */
function HoldingsLine({ connection }: { connection: ConnectionView }) {
  const notes = connection.lastErrors.filter((e) => e.code.startsWith("holdings."));
  if (notes.length === 0) return null;
  return (
    <div className="muted small">
      Holdings: {notes.length} account{notes.length === 1 ? "" : "s"} with notes
      <ul className="errors">
        {notes.map((e, i) => (
          <li key={i}>
            <code>{e.code}</code> {e.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ImportLogs({ connectionId }: { connectionId: string }) {
  const logs = useQuery({ queryKey: ["imports", connectionId], queryFn: () => api<ImportLogView[]>(`/connections/${connectionId}/imports`) });
  if (logs.isLoading) return <p className="muted small">Loading log…</p>;
  if (!logs.data?.length) return <p className="muted small">No imports yet.</p>;
  return (
    <table className="table small">
      <thead>
        <tr>
          <th>Started</th>
          <th>Kind</th>
          <th>Status</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        {logs.data.map((l) => (
          <tr key={l.id}>
            <td>{new Date(l.startedAt).toLocaleString()}</td>
            <td>{l.kind}</td>
            <td>
              <Badge tone={l.status === "ok" ? "ok" : l.status === "error" ? "bad" : "info"}>{l.status}</Badge>
            </td>
            <td>
              {l.stats
                ? Object.entries(l.stats)
                    .filter(([, v]) => v !== 0)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(" · ")
                : l.message}
              {l.errors.length > 0 && <span className="error"> · {l.errors.length} error(s)</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
