import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CategoryView, RuleView } from "@meridian/shared";
import { api } from "../lib/api.js";
import { Badge, Card, Empty, ErrorText } from "../components/ui.js";

function describeConditions(c: RuleView["conditions"], accounts: Map<string, string>): string {
  const parts: string[] = [];
  if (c.payee) parts.push(`payee ${c.payee.op} "${c.payee.value}"`);
  if (c.description) parts.push(`description ${c.description.op} "${c.description.value}"`);
  if (c.amount) parts.push(`amount ${c.amount.minCents ?? "…"}…${c.amount.maxCents ?? "…"} cents`);
  if (c.accountId) parts.push(`account ${accounts.get(c.accountId) ?? c.accountId}`);
  if (c.dayOfMonth) parts.push(`day ${c.dayOfMonth.min}–${c.dayOfMonth.max}`);
  return parts.join(" and ");
}

function describeActions(a: RuleView["actions"], categories: Map<string, string>): string {
  const parts: string[] = [];
  if (a.setPayee) parts.push(`payee → ${a.setPayee}`);
  if (a.setCategoryId !== undefined) parts.push(`category → ${a.setCategoryId ? (categories.get(a.setCategoryId) ?? "?") : "none"}`);
  if (a.addTags?.length) parts.push(`tags +${a.addTags.join(", +")}`);
  if (a.markTransfer !== undefined) parts.push(a.markTransfer ? "mark transfer" : "not a transfer");
  if (a.stop) parts.push("stop");
  return parts.join(", ");
}

export function RulesPage() {
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => api<RuleView[]>("/rules") });
  const categories = useQuery({ queryKey: ["categories"], queryFn: () => api<CategoryView[]>("/categories") });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<Array<{ id: string; name: string }>>("/accounts") });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["rules"] });
    void qc.invalidateQueries({ queryKey: ["transactions"] });
  };
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; enabled?: boolean }) => api(`/rules/${id}`, { method: "PATCH", body }),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: (id: string) => api(`/rules/${id}`, { method: "DELETE" }), onSuccess: invalidate });
  const reorder = useMutation({ mutationFn: (ids: string[]) => api("/rules/reorder", { method: "POST", body: { ids } }), onSuccess: invalidate });
  const run = useMutation({
    mutationFn: (scope: "uncategorized" | "all") => api<{ examined: number; changed: number }>("/rules/run", { method: "POST", body: { scope } }),
    onSuccess: invalidate,
  });

  const catNames = new Map((categories.data ?? []).map((c) => [c.id, c.name]));
  const acctNames = new Map((accounts.data ?? []).map((a) => [a.id, a.name]));
  const list = rules.data ?? [];
  const move = (index: number, delta: number) => {
    const ids = list.map((r) => r.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    reorder.mutate(ids);
  };

  return (
    <>
      <div className="row space">
        <h1>Rules</h1>
        <div className="row">
          <button className="secondary" onClick={() => run.mutate("uncategorized")} disabled={run.isPending}>
            Run on uncategorized
          </button>
          <button className="secondary" onClick={() => run.mutate("all")} disabled={run.isPending} title="Hand-picked categories are never overwritten">
            Run on all
          </button>
        </div>
      </div>
      {run.data && (
        <p className="notice">
          Examined {run.data.examined}, changed {run.data.changed}.
        </p>
      )}
      <ErrorText error={rules.error} />
      <ErrorText error={run.error} />
      <Card>
        <p className="muted">
          Rules run in order on every import. Later rules override earlier ones for the same field; tags accumulate. Create rules from the register with "always
          do this".
        </p>
        {list.length === 0 && <Empty>No rules yet.</Empty>}
        {list.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Name</th>
                <th>When</th>
                <th>Then</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={r.id} className={r.enabled ? "" : "muted"}>
                  <td>{r.position}</td>
                  <td>
                    {r.name || <span className="muted">(unnamed)</span>} {!r.enabled && <Badge tone="neutral">off</Badge>}
                  </td>
                  <td className="small">{describeConditions(r.conditions, acctNames)}</td>
                  <td className="small">{describeActions(r.actions, catNames)}</td>
                  <td className="nowrap">
                    <button className="link" onClick={() => move(i, -1)} disabled={i === 0}>
                      ↑
                    </button>
                    <button className="link" onClick={() => move(i, 1)} disabled={i === list.length - 1}>
                      ↓
                    </button>
                    <button className="link" onClick={() => update.mutate({ id: r.id, enabled: !r.enabled })}>
                      {r.enabled ? "disable" : "enable"}
                    </button>
                    <button className="link danger" onClick={() => remove.mutate(r.id)}>
                      delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
