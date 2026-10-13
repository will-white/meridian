import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionView, ImportLogView } from "@meridian/shared";
import { api } from "../lib/api.js";
import { relativeTime } from "../lib/format.js";
import { Badge, Card, Empty, ErrorText } from "../components/ui.js";

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
  const sync = useMutation({
    mutationFn: ({ id, balancesOnly }: { id: string; balancesOnly?: boolean }) =>
      api(`/connections/${id}/sync`, { method: "POST", body: { balancesOnly: balancesOnly ?? false } }),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: (id: string) => api(`/connections/${id}`, { method: "DELETE" }), onSuccess: invalidate });
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
          hours. Nothing here can move money.
        </p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate({ name: name.trim() || "SimpleFIN", token: token.trim() });
          }}
        >
          <input placeholder="Name (e.g. Chase + Fidelity)" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="Paste setup token" value={token} onChange={(e) => setToken(e.target.value)} required className="grow" />
          <button type="submit" disabled={add.isPending}>
            Connect
          </button>
        </form>
        <ErrorText error={add.error} />
        <ErrorText error={sync.error} />
        {connections.isLoading && <p className="muted">Loading…</p>}
        {simplefin.length === 0 && !connections.isLoading && <Empty>No SimpleFIN connections yet.</Empty>}
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
                  <span className="muted">
                    {c.accountCount} account{c.accountCount === 1 ? "" : "s"} · last sync {relativeTime(c.lastSyncAt)}
                    {c.syncedThrough ? ` · through ${c.syncedThrough}` : ""}
                  </span>
                </div>
                {c.lastError && <p className="error small">{c.lastError}</p>}
                {c.lastErrors.length > 0 && (
                  <ul className="errors">
                    {c.lastErrors.map((e, i) => (
                      <li key={i}>
                        <code>{e.code}</code> {e.message}
                        {e.accountId ? ` (account ${e.accountId})` : ""}
                      </li>
                    ))}
                  </ul>
                )}
                {openLog === c.id && <ImportLogs connectionId={c.id} />}
              </div>
              <div className="row">
                <button onClick={() => sync.mutate({ id: c.id })} disabled={sync.isPending || !!c.activeJob || c.status === "disabled"}>
                  Sync now
                </button>
                <button className="secondary" onClick={() => sync.mutate({ id: c.id, balancesOnly: true })} disabled={sync.isPending || !!c.activeJob || c.status !== "ok"}>
                  Balances only
                </button>
                <button className="secondary" onClick={() => setOpenLog(openLog === c.id ? null : c.id)}>
                  {openLog === c.id ? "Hide log" : "Log"}
                </button>
                <button className="secondary" onClick={() => toggle.mutate({ id: c.id, status: c.status === "disabled" ? "ok" : "disabled" })}>
                  {c.status === "disabled" ? "Enable" : "Disable"}
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    if (confirm(`Remove ${c.name}? Accounts and transactions stay; the access URL is deleted.`)) remove.mutate(c.id);
                  }}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="CSV mapping profiles">
        {profiles.length === 0 ? (
          <Empty>No saved mappings. Import a CSV and tick "save this mapping" to add one.</Empty>
        ) : (
          <ul className="list">
            {profiles.map((p) => (
              <li key={p.id} className="list-item">
                <div className="grow">
                  <strong>{p.name}</strong> <span className="muted">· last import {relativeTime(p.lastSyncAt)}</span>
                  {p.csvMapping && (
                    <div className="muted small">
                      date: {String(p.csvMapping.date.column)} ({p.csvMapping.date.format}) · description: {String(p.csvMapping.description.column)} · amount:{" "}
                      {p.csvMapping.amount.mode === "single" ? String(p.csvMapping.amount.column) : `${String(p.csvMapping.amount.debitColumn)} / ${String(p.csvMapping.amount.creditColumn)}`}
                    </div>
                  )}
                </div>
                <button className="danger" onClick={() => remove.mutate(p.id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
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
