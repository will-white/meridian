import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AccountType, TaxTreatment, type AccountView } from "@meridian/shared";
import { api } from "../lib/api.js";
import { money, shortDate, titleCase } from "../lib/format.js";
import { Badge, Card, Empty, ErrorText } from "../components/ui.js";

const GROUPS: Array<[string, AccountView["type"][]]> = [
  ["Cash", ["checking", "savings"]],
  ["Credit and loans", ["credit", "loan"]],
  ["Investments", ["brokerage", "401k", "ira", "roth", "hsa", "529"]],
  ["Other assets", ["asset"]],
];

function sum(accounts: AccountView[]): string {
  return accounts.reduce((acc, a) => acc + (a.balanceCents ? BigInt(a.balanceCents) : 0n), 0n).toString();
}

export function AccountsPage() {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<AccountView[]>("/accounts") });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) => api<AccountView>(`/accounts/${id}`, { method: "PATCH", body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["accounts"] }),
  });
  const create = useMutation({
    mutationFn: (body: { name: string; type: string; balanceCents?: string }) => api<AccountView>("/accounts", { method: "POST", body }),
    onSuccess: () => {
      setNewName("");
      setNewBalance("");
      void qc.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
  const [showClosed, setShowClosed] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<AccountView["type"]>("checking");
  const [newBalance, setNewBalance] = useState("");

  const all = accounts.data ?? [];
  const visible = all.filter((a) => showClosed || !a.closed);
  const netWorth = sum(visible);

  return (
    <>
      <div className="row space">
        <h1>Accounts</h1>
        <div className="row">
          <label className="inline">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> show closed
          </label>
          <strong>Net worth {money(netWorth)}</strong>
        </div>
      </div>
      <ErrorText error={accounts.error} />
      <ErrorText error={update.error} />
      {all.length === 0 && !accounts.isLoading && <Empty>No accounts yet. Connect SimpleFIN or add a manual account below.</Empty>}
      {GROUPS.map(([label, types]) => {
        const rows = visible.filter((a) => types.includes(a.type));
        if (rows.length === 0) return null;
        return (
          <Card key={label} title={label} actions={<strong>{money(sum(rows))}</strong>}>
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Institution</th>
                  <th>Type</th>
                  <th>Tax</th>
                  <th className="num">Balance</th>
                  <th className="num">Available</th>
                  <th>As of</th>
                  <th>Budget</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className={a.closed ? "muted" : ""}>
                    <td>
                      <strong>{a.name}</strong>
                      <div className="muted small">
                        {a.transactionCount} txns{a.connectionName ? ` · ${a.connectionName}` : " · manual"}
                      </div>
                    </td>
                    <td>{a.institution ?? "—"}</td>
                    <td>
                      <select value={a.type} onChange={(e) => update.mutate({ id: a.id, type: e.target.value })}>
                        {AccountType.options.map((t) => (
                          <option key={t} value={t}>
                            {titleCase(t)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select value={a.taxTreatment} onChange={(e) => update.mutate({ id: a.id, taxTreatment: e.target.value })}>
                        {TaxTreatment.options.map((t) => (
                          <option key={t} value={t}>
                            {titleCase(t)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={`num ${a.balanceCents?.startsWith("-") ? "neg" : ""}`}>{money(a.balanceCents, a.currency)}</td>
                    <td className="num muted">{money(a.availableCents, a.currency)}</td>
                    <td className="muted">{shortDate(a.balanceDate)}</td>
                    <td>
                      <label className="inline">
                        <input type="checkbox" checked={a.onBudget} onChange={(e) => update.mutate({ id: a.id, onBudget: e.target.checked })} /> on budget
                      </label>
                    </td>
                    <td>
                      {a.closed ? (
                        <button className="link" onClick={() => update.mutate({ id: a.id, closed: false })}>
                          Reopen
                        </button>
                      ) : (
                        <button className="link" onClick={() => update.mutate({ id: a.id, closed: true })}>
                          Close
                        </button>
                      )}
                      {a.closed && <Badge tone="neutral">closed</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        );
      })}
      <Card title="Add a manual account">
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            const cents = newBalance.trim() ? String(Math.round(Number(newBalance) * 100)) : undefined;
            create.mutate({ name: newName.trim(), type: newType, ...(cents !== undefined && !Number.isNaN(Number(cents)) ? { balanceCents: cents } : {}) });
          }}
        >
          <input placeholder="Name (e.g. House, Car loan, Cash)" value={newName} onChange={(e) => setNewName(e.target.value)} required />
          <select value={newType} onChange={(e) => setNewType(e.target.value as AccountView["type"])}>
            {AccountType.options.map((t) => (
              <option key={t} value={t}>
                {titleCase(t)}
              </option>
            ))}
          </select>
          <input placeholder="Balance (e.g. 12500.00)" value={newBalance} onChange={(e) => setNewBalance(e.target.value)} inputMode="decimal" />
          <button type="submit" disabled={create.isPending}>
            Add
          </button>
        </form>
        <ErrorText error={create.error} />
      </Card>
    </>
  );
}
