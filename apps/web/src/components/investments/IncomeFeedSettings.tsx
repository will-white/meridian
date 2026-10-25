import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { AccountView, CategoryDetailView, HouseholdSettingView, IncomeView, InvestmentIncomeFeed, RunIncomeFeedResponse } from "@meridian/shared";
import { api } from "../../lib/api.js";
import { ErrorText } from "../ui.js";
import { FEED_EXPLANATION, feedModeHelp, feedModeLabel } from "../../lib/performanceView.js";
import { FidelityBadge } from "./FidelityBadge.js";
import { invalidateInvestments } from "./queries.js";

const MODES: readonly InvestmentIncomeFeed[] = ["off", "link", "create"];

/**
 * The feed of dividends and interest into the spending plan (plan decision
 * 13), owner only: the household's income category (an income-bucket
 * category; PATCH /settings), each account's mode (off / link / create;
 * PATCH /accounts/:id `investmentIncomeFeed`) with the suggested mode and the
 * row counts, and "Run feed now" (POST /investments/income/feed/run). Link
 * and create need a category first; the server says so too
 * (`feed_category_required`).
 */
export function IncomeFeedSettings({ feed }: { feed: IncomeView["feed"] }) {
  const qc = useQueryClient();
  const categories = useQuery({ queryKey: ["categories"], queryFn: () => api<CategoryDetailView[]>("/categories") });
  const incomeCategories = (categories.data ?? []).filter((c) => c.bucket === "income" && !c.hidden);
  const [runResult, setRunResult] = useState<RunIncomeFeedResponse | null>(null);

  const invalidate = () => {
    invalidateInvestments(qc);
    void qc.invalidateQueries({ queryKey: ["transactions"] });
  };
  const setCategory = useMutation({
    mutationFn: (id: string | null) => api<HouseholdSettingView>("/settings", { method: "PATCH", body: { investmentIncomeCategoryId: id } }),
    onSuccess: (view) => {
      qc.setQueryData(["settings"], view);
      invalidate();
    },
  });
  const setMode = useMutation({
    mutationFn: ({ accountId, mode }: { accountId: string; mode: InvestmentIncomeFeed }) => api<AccountView>(`/accounts/${accountId}`, { method: "PATCH", body: { investmentIncomeFeed: mode } }),
    onSuccess: invalidate,
  });
  const run = useMutation({
    mutationFn: () => api<RunIncomeFeedResponse>("/investments/income/feed/run", { method: "POST", body: {} }),
    onSuccess: (r) => {
      setRunResult(r);
      invalidate();
    },
  });
  const hasCategory = feed.categoryId !== null;
  const anyOn = feed.accounts.some((a) => a.mode !== "off");

  return (
    <div className="inc-feed">
      <div className="row wrap inc-feed-category">
        <label>
          Income category
          <select value={feed.categoryId ?? ""} disabled={setCategory.isPending || categories.isLoading} onChange={(e) => setCategory.mutate(e.target.value === "" ? null : e.target.value)} aria-label="Investment income category">
            <option value="">— none (feeds off) —</option>
            {incomeCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {feed.categoryId !== null && !incomeCategories.some((c) => c.id === feed.categoryId) && <option value={feed.categoryId}>{feed.categoryName ?? "current category"}</option>}
          </select>
        </label>
        <span className="muted small">
          An income-bucket category the fed rows land in. {incomeCategories.length === 0 && categories.data !== undefined ? <Link to="/plan">Create one on the Plan page.</Link> : <Link to="/plan">Manage categories.</Link>}
        </span>
        <ErrorText error={setCategory.error} />
        <ErrorText error={categories.error} />
      </div>

      <div className="scroll">
        <table className="table small inv-table inc-feed-table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Mode</th>
              <th className="num">Linked</th>
              <th className="num">Created</th>
              <th className="num">Awaiting</th>
              <th className="num">Fed</th>
            </tr>
          </thead>
          <tbody>
            {feed.accounts.map((a) => (
              <tr key={a.accountId}>
                <td className="name">
                  {a.accountName}
                  <FidelityBadge fidelity={a.fidelity} fidelityNote={a.fidelityNote} accountId={a.accountId} />
                  <div className="muted small">
                    {a.hasLedger ? "has a bank feed" : "no bank feed"}
                    {a.suggestedMode !== a.mode ? ` · suggested: ${feedModeLabel(a.suggestedMode).toLowerCase()}` : ""}
                  </div>
                </td>
                <td>
                  <div className="inc-modes" role="radiogroup" aria-label={`${a.accountName} feed mode`}>
                    {MODES.map((m) => (
                      <label key={m} className="inline" title={feedModeHelp(m)}>
                        <input
                          type="radio"
                          name={`feed-${a.accountId}`}
                          value={m}
                          checked={a.mode === m}
                          disabled={setMode.isPending || (m !== "off" && !hasCategory)}
                          onChange={() => setMode.mutate({ accountId: a.accountId, mode: m })}
                        />
                        {feedModeLabel(m)}
                      </label>
                    ))}
                  </div>
                </td>
                <td className="num">{a.linked}</td>
                <td className="num">{a.created}</td>
                <td className={`num ${a.awaiting > 0 ? "tone-warn" : ""}`}>{a.awaiting}</td>
                <td className="num">{a.fed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!hasCategory && <p className="muted small">Pick an income category to turn a feed on.</p>}
      <ErrorText error={setMode.error} />

      <div className="row wrap">
        <button type="button" className="secondary" disabled={run.isPending || !hasCategory || !anyOn} onClick={() => run.mutate()}>
          {run.isPending ? "Running…" : "Run feed now"}
        </button>
        {runResult && (
          <span className="notice">
            Fed: {runResult.categorized} categorized, {runResult.created} created, {runResult.upgraded} upgraded, {runResult.awaiting} awaiting a bank row, {runResult.unchanged} unchanged
            {runResult.deleted > 0 ? `, ${runResult.deleted} removed` : ""}.
          </span>
        )}
        <ErrorText error={run.error} />
      </div>
      <p className="muted small inc-feed-explain">{FEED_EXPLANATION}</p>
    </div>
  );
}
