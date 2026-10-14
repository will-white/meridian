import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { AccountView, CategoryDetailView, GoalStatus, GoalView } from "@meridian/shared";
import { GoalStatus as GoalStatusEnum } from "@meridian/shared";
import { Badge, Card, Empty, ErrorText } from "../components/ui.js";
import { api, query } from "../lib/api.js";
import { money, shortDate, titleCase } from "../lib/format.js";
import { localToday, monthLabel } from "../lib/plan.js";
import { NEW_CATEGORY, buildGoalBody, initialGoalForm, percentFromBp, type GoalBody, type GoalFormState } from "../lib/planGoalForm.js";
import "./GoalsPage.css";

interface GoalFormProps {
  goal: GoalView | null;
  categories: CategoryDetailView[];
  accounts: AccountView[];
  currentMonth: string;
  pending: boolean;
  error: unknown;
  onSubmit: (body: GoalBody) => void;
  onCancel: () => void;
}

function GoalForm({ goal, categories, accounts, currentMonth, pending, error, onSubmit, onCancel }: GoalFormProps) {
  const [f, setF] = useState<GoalFormState>(() => initialGoalForm(goal, currentMonth));
  const [formError, setFormError] = useState<string | null>(null);
  const set = <K extends keyof GoalFormState>(key: K, value: GoalFormState[K]) => setF((prev) => ({ ...prev, [key]: value }));
  const editing = goal !== null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const built = buildGoalBody(f, editing);
    if (!built.ok) {
      setFormError(built.error);
      return;
    }
    setFormError(null);
    onSubmit(built.body);
  };

  return (
    <form className="goal-form" onSubmit={submit}>
      <div className="goal-form-grid">
        <label>
          Name
          <input value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={100} required placeholder="Emergency fund" />
        </label>
        <label>
          Savings category
          <select value={f.categoryId} onChange={(e) => set("categoryId", e.target.value)} required>
            <option value="">— choose —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {!editing && <option value={NEW_CATEGORY}>+ New savings category…</option>}
          </select>
        </label>
        {f.categoryId === NEW_CATEGORY && (
          <label>
            New category name
            <input value={f.newCategoryName} onChange={(e) => set("newCategoryName", e.target.value)} maxLength={100} placeholder={f.name || "Same as the goal"} />
          </label>
        )}
        <label>
          Target amount
          <input value={f.target} onChange={(e) => set("target", e.target.value)} inputMode="decimal" placeholder="10,000.00" required />
        </label>
        <label>
          Target date (optional)
          <input type="date" value={f.targetDate} onChange={(e) => set("targetDate", e.target.value)} />
        </label>
        <label>
          Monthly contribution
          <input value={f.contribution} onChange={(e) => set("contribution", e.target.value)} inputMode="decimal" placeholder="500.00" />
        </label>
        <label>
          Linked account (transfers in count as progress)
          <select value={f.linkedAccountId} onChange={(e) => set("linkedAccountId", e.target.value)}>
            <option value="">— none —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.closed ? " (closed)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Counting from
          <input type="month" value={f.startMonth} onChange={(e) => set("startMonth", e.target.value)} required />
        </label>
        <label>
          Already saved when the goal started
          <input value={f.starting} onChange={(e) => set("starting", e.target.value)} inputMode="decimal" placeholder="0.00" />
        </label>
        {editing && (
          <label>
            Status
            <select value={f.status} onChange={(e) => set("status", e.target.value as GoalStatus)}>
              {GoalStatusEnum.options.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {formError && <p className="error">{formError}</p>}
      <ErrorText error={error} />
      <div className="row">
        <button type="submit" disabled={pending}>
          {editing ? "Save changes" : "Create goal"}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function GoalCard({ goal, onEdit, onDelete, deleting }: { goal: GoalView; onEdit: () => void; onDelete: () => void; deleting: boolean }) {
  const [showHistory, setShowHistory] = useState(false);
  const p = goal.progress;
  const done = p.remainingToTargetCents === "0";
  const tone = goal.status !== "active" ? "neutral" : done ? "ok" : p.onTrack === null ? "info" : p.onTrack ? "ok" : "warn";
  const trackLabel = goal.status !== "active" ? titleCase(goal.status) : done ? "reached" : p.onTrack === null ? "no target date" : p.onTrack ? "on track" : "behind";
  const history = [...goal.history].reverse();
  return (
    <Card>
      <div className="goal-head">
        <div className="goal-title">
          <strong>{goal.name}</strong>
          <Badge tone={tone}>{trackLabel}</Badge>
          <span className="muted small">
            {goal.categoryName}
            {goal.linkedAccountName ? ` · linked to ${goal.linkedAccountName}` : " · no linked account"}
          </span>
        </div>
        <div className="row">
          <Link className="small" to={`/transactions${query({ goalId: goal.id })}`}>
            transactions
          </Link>
          <button type="button" className="link" onClick={onEdit}>
            Edit
          </button>
          <button type="button" className="link danger" disabled={deleting} onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>
      <div className={`goal-bar ${done ? "done" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(p.progressBp / 100)} aria-label={`${goal.name} progress`}>
        <div className="goal-fill" style={{ width: `${Math.min(100, p.progressBp / 100)}%` }} />
      </div>
      <div className="goal-stats">
        <span>
          <strong>{money(p.savedCents)}</strong> of {money(goal.targetCents)} <span className="muted">({percentFromBp(p.progressBp)})</span>
        </span>
        <span>
          {done ? "Target reached" : `${money(p.remainingToTargetCents)} to go`}
          {goal.targetDate && ` · by ${shortDate(goal.targetDate)}`}
        </span>
        {p.monthsLeft !== null && p.neededPerMonthCents !== null && !done && (
          <span>
            {p.monthsLeft} month{p.monthsLeft === 1 ? "" : "s"} left · needs <strong>{money(p.neededPerMonthCents)}</strong>/mo
          </span>
        )}
        <span>
          contributing {money(goal.monthlyContributionCents)}/mo
          {p.projectedCompletionMonth && !done && ` · projected ${monthLabel(p.projectedCompletionMonth)}`}
          {!p.projectedCompletionMonth && !done && goal.monthlyContributionCents === "0" && " · no projection without a contribution"}
        </span>
        <span className="muted small">
          counting from {monthLabel(goal.startMonth)}
          {goal.startingCents !== "0" && ` with ${money(goal.startingCents)} already saved`}
        </span>
      </div>
      {goal.history.length > 0 && (
        <button type="button" className="link small" onClick={() => setShowHistory((s) => !s)}>
          {showHistory ? "hide history" : `history (${goal.history.length} month${goal.history.length === 1 ? "" : "s"})`}
        </button>
      )}
      {showHistory && (
        <table className="table small goal-history">
          <thead>
            <tr>
              <th>Month</th>
              <th className="num">Planned</th>
              <th className="num">Actual</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.month}>
                <td>{monthLabel(h.month)}</td>
                <td className="num muted">{money(h.plannedCents)}</td>
                <td className={`num ${h.actualCents.startsWith("-") ? "neg" : ""}`}>{money(h.actualCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function GoalsPage() {
  const qc = useQueryClient();
  const currentMonth = localToday().slice(0, 7);
  const goals = useQuery({ queryKey: ["goals"], queryFn: () => api<GoalView[]>("/goals") });
  const categories = useQuery({ queryKey: ["categories"], queryFn: () => api<CategoryDetailView[]>("/categories") });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<AccountView[]>("/accounts") });
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const invalidate = () => {
    for (const key of [["goals"], ["plan"], ["categories"], ["dashboard"]]) void qc.invalidateQueries({ queryKey: key });
  };
  const create = useMutation({
    mutationFn: (body: GoalBody) => api<GoalView>("/goals", { method: "POST", body }),
    onSuccess: () => {
      setCreating(false);
      invalidate();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: GoalBody }) => api<GoalView>(`/goals/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      setEditingId(null);
      invalidate();
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => api<{ ok: true }>(`/goals/${id}`, { method: "DELETE" }), onSuccess: invalidate });

  const all = goals.data ?? [];
  const visible = all.filter((g) => showInactive || g.status === "active");
  const takenCategories = useMemo(() => new Set(all.map((g) => g.categoryId)), [all]);
  /** Savings categories without a goal (plus the one being edited). */
  const freeCategories = (keep: string | null) =>
    (categories.data ?? []).filter((c) => c.bucket === "savings" && !c.hidden && (c.id === keep || (!takenCategories.has(c.id) && !c.goalId)));
  const openAccounts = (accounts.data ?? []).filter((a) => !a.closed);
  const totalSaved = visible.reduce((acc, g) => acc + BigInt(g.progress.savedCents), 0n).toString();
  const totalTarget = visible.reduce((acc, g) => acc + BigInt(g.targetCents), 0n).toString();

  return (
    <div className="goals-page">
      <div className="row space wrap">
        <h1>Savings goals</h1>
        <div className="row wrap">
          {visible.length > 0 && (
            <span className="muted">
              {money(totalSaved)} saved of {money(totalTarget)}
            </span>
          )}
          <label className="inline">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> show completed and archived
          </label>
          <button type="button" onClick={() => setCreating(true)} disabled={creating}>
            New goal
          </button>
        </div>
      </div>
      <ErrorText error={goals.error} />
      <ErrorText error={remove.error} />
      {creating && (
        <Card title="New goal">
          <GoalForm
            goal={null}
            categories={freeCategories(null)}
            accounts={openAccounts}
            currentMonth={currentMonth}
            pending={create.isPending}
            error={create.error}
            onSubmit={(body) => create.mutate(body)}
            onCancel={() => {
              setCreating(false);
              create.reset();
            }}
          />
        </Card>
      )}
      {!goals.isLoading && all.length === 0 && !creating && <Empty>No goals yet. A goal lives on a savings category; its monthly contribution plans that row for you.</Empty>}
      {!goals.isLoading && all.length > 0 && visible.length === 0 && <Empty>Every goal is completed or archived.</Empty>}
      {visible.map((g) =>
        editingId === g.id ? (
          <Card key={g.id} title={`Edit ${g.name}`}>
            <GoalForm
              goal={g}
              categories={freeCategories(g.categoryId)}
              accounts={openAccounts}
              currentMonth={currentMonth}
              pending={update.isPending}
              error={update.error}
              onSubmit={(body) => update.mutate({ id: g.id, body })}
              onCancel={() => {
                setEditingId(null);
                update.reset();
              }}
            />
          </Card>
        ) : (
          <GoalCard
            key={g.id}
            goal={g}
            onEdit={() => {
              setCreating(false);
              setEditingId(g.id);
            }}
            onDelete={() => {
              if (window.confirm(`Delete the goal "${g.name}"? The category stays; its planned amounts revert to what you typed or zero.`)) remove.mutate(g.id);
            }}
            deleting={remove.isPending}
          />
        ),
      )}
    </div>
  );
}
