import {
  PLANNER_DISCLAIMER,
  STRATEGY_INFO,
  type AllocationSource,
  type BaselineChange,
  type BasisCoverage,
  type EffectiveInputsView,
  type OwnerId,
  type PlanBucket,
  type PlanIssue,
  type ProfileResponse,
  type RetirementRulesView,
  type RunRequestResponse,
  type ScenarioSummary,
  type SimRunView,
  type SocialSecurityPreviewResponse,
} from "@meridian/shared";
import { ApiError } from "./api.js";
import { money, shortDate } from "./format.js";
import { successText } from "./retirementCard.js";
import { clampPercentile } from "./retirementSummary.js";
import { BUCKETS, bucketLabel, countText, durationText, percentText, returnModelLabel, strategyLabel, wholeDollars } from "./retirementFormat.js";

/**
 * The retirement pages' states as pure view models (strategies-outputs-web §5.1 to §5.9 and
 * inputs-and-data §5): which state a page is in, what it says, and what the owner may do. Every
 * page of step 30 renders one of these; the viewer's capabilities come from one function (§5.9).
 */

// ---- §5.1 Shell, routes and URL state ----

export interface NavItem {
  to: string;
  label: string;
}

/** The sub-navigation of `RetirementLayout` (§5.1). */
export const RETIREMENT_NAV: readonly NavItem[] = [
  { to: "/retirement", label: "Results" },
  { to: "/retirement/profile", label: "Profile" },
  { to: "/retirement/scenarios", label: "Scenarios" },
  { to: "/retirement/history", label: "History" },
];

/** The active entry: a run's page keeps Results active, a scenario's page Scenarios (§5.1). */
export function activeNav(pathname: string): string {
  const path = pathname.replace(/\/+$/, "");
  if (path.startsWith("/retirement/profile")) return "/retirement/profile";
  if (path.startsWith("/retirement/scenarios")) return "/retirement/scenarios";
  if (path.startsWith("/retirement/history")) return "/retirement/history";
  return "/retirement";
}

export interface ResultsQuery {
  scenario?: string;
  /** 1 to 99, default 50. */
  percentile: number;
  dollars: "today" | "nominal";
  view: "portfolio" | "spending";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Results page's URL state (§5.1): `?scenario=`, `?p=` (1 to 99, default 50), `?dollars=today|nominal`, `?view=portfolio|spending`. Anything else reads as the default. */
export function parseResultsQuery(search: string | URLSearchParams): ResultsQuery {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const scenario = params.get("scenario");
  const out: ResultsQuery = {
    percentile: clampPercentile(params.get("p")),
    dollars: params.get("dollars") === "nominal" ? "nominal" : "today",
    view: params.get("view") === "spending" ? "spending" : "portfolio",
  };
  if (scenario !== null && UUID.test(scenario)) out.scenario = scenario;
  return out;
}

/** The query string for a state, defaults left out: "" for the defaults, "?p=10&dollars=nominal" otherwise. */
export function resultsSearch(q: ResultsQuery): string {
  const params = new URLSearchParams();
  if (q.scenario !== undefined) params.set("scenario", q.scenario);
  if (q.percentile !== 50) params.set("p", String(q.percentile));
  if (q.dollars !== "today") params.set("dollars", q.dollars);
  if (q.view !== "portfolio") params.set("view", q.view);
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

/** Query keys live under `['retirement', view, params]` (§5.1), so invalidating `['retirement']` refreshes every page. */
export function retirementKey(view: string, params?: Record<string, string | number | boolean | undefined>): readonly unknown[] {
  return params === undefined ? ["retirement", view] : ["retirement", view, params];
}

// ---- §5.9 The viewer ----

export interface RetirementCapabilities {
  edit: boolean;
  refreshBaseline: boolean;
  run: boolean;
  cancel: boolean;
  pin: boolean;
  revert: boolean;
  delete: boolean;
}

/** The viewer reads everything and changes nothing (§5.9; the API refuses the mutations anyway). */
export function retirementCapabilities(isViewer: boolean): RetirementCapabilities {
  const can = !isViewer;
  return { edit: can, refreshBaseline: can, run: can, cancel: can, pin: can, revert: can, delete: can };
}

// ---- Runs: progress, failures, the Run button (§5.4, §5.5, inputs §5) ----

export interface RunProgressView {
  /** "62%". */
  percentText: string;
  progressBp: number;
  /** "6,200 of 10,000 paths". */
  pathsText: string;
  /** Since the run started (queued: since it was requested). */
  elapsedText: string;
  statusText: string;
  /** `stalled`: the worker stopped responding (§5.5). */
  stalled: boolean;
  canCancel: boolean;
}

/** A queued or running run (§5.5 "Queued or running"): progress, elapsed time, the stalled note, Cancel for the owner. */
export function runProgressView(run: Pick<SimRunView, "status" | "progressBp" | "pathsDone" | "paths" | "startedAt" | "createdAt" | "stalled" | "cancelRequested">, nowMs: number, isViewer: boolean): RunProgressView {
  const progressBp = Math.max(0, Math.min(10_000, run.progressBp));
  const since = Date.parse(run.startedAt ?? run.createdAt);
  const statusText = run.cancelRequested
    ? "Cancelling…"
    : run.stalled
      ? "The worker stopped responding"
      : run.status === "queued"
        ? "Waiting for the worker"
        : "Simulating";
  return {
    percentText: percentText(progressBp, 0),
    progressBp,
    pathsText: `${countText(run.pathsDone)} of ${countText(run.paths)} paths`,
    elapsedText: Number.isFinite(since) ? durationText(Math.max(0, nowMs - since)) : "—",
    statusText,
    stalled: run.stalled,
    canCancel: !isViewer && !run.cancelRequested,
  };
}

const FAILURE_TEXT: Record<string, string> = {
  timeout: "The run took longer than its time limit and was stopped.",
  worker_error: "A simulation thread stopped unexpectedly. Running the plan again usually works.",
  engine_error: "The engine hit an internal error. The run's input is kept so the problem can be reproduced.",
  not_reproducible: "A stored path could not be reproduced from the run's input; run the plan again.",
  horizon_too_long: "The plan runs longer than the engine's limit of 120 years.",
  historical_horizon_too_long: "The plan is longer than the historical record allows for complete sequences.",
  path_years_too_many: "Too many paths for a plan this long: lower the number of paths.",
  data_version_mismatch: "The run was frozen for a different version of the planner's data; run the plan again.",
  plan_invalid: "The plan's years do not fit together; check the people's ages and life expectancy.",
  start_year_unsupported: "The plan starts before the first year of the tax data.",
  correlation_not_positive_definite: "The custom return model's correlations do not form a valid correlation matrix.",
  result_out_of_range: "A result was too large to store; check the custom return model.",
  too_many_accounts: "The plan has more accounts than the engine accepts (32).",
  too_many_incomes: "The plan has more income streams than the engine accepts (40).",
  too_many_conversions: "The plan has more Roth conversions than the engine accepts (120).",
};

/** A failed run in a plain sentence (§5.5 "Failed"): the engine's and the job's known codes, else the run's own message with its code. */
export function runFailureText(code: string | null, message: string | null): string {
  if (code !== null && FAILURE_TEXT[code] !== undefined) return FAILURE_TEXT[code]!;
  if (message !== null && message.trim() !== "") return code === null ? message : `${message} (${code})`;
  return code === null ? "The run failed." : `The run failed (${code}).`;
}

/** What the percentile picker says when a percentile cannot be shown (§5.5: `409 engine_changed`, `409 not_reproducible`). */
export function percentileErrorText(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === "engine_changed") return "This run was made with an earlier engine or data version: the stored percentiles (5, 10, 25, 50, 75, 90 and 95) still show, and other percentiles need a new run.";
  if (error.code === "not_reproducible") return "This path could not be reproduced; run the plan again.";
  if (error.code === "run_not_done") return "The run has not finished yet.";
  return null;
}

export interface RunButtonState {
  visible: boolean;
  disabled: boolean;
  /** The first error issue, or why a run cannot start now. */
  reason?: string;
}

/** The Run button (§5.4): owner only; disabled with the first error issue, or while a run of the scenario is active. */
export function runButtonState(s: { isViewer: boolean; issues: readonly PlanIssue[]; activeRunId: string | null; pending?: boolean }): RunButtonState {
  if (s.isViewer) return { visible: false, disabled: true };
  const firstError = s.issues.find((i) => i.severity === "error");
  if (firstError !== undefined) return { visible: true, disabled: true, reason: firstError.message };
  if (s.activeRunId !== null) return { visible: true, disabled: true, reason: "A run of this scenario is in progress" };
  if (s.pending === true) return { visible: true, disabled: true, reason: "Starting the run…" };
  return { visible: true, disabled: false };
}

/** After `POST /scenarios/:id/runs` (§5.4): where to go, the reused-run sentence, and the baseline changes the refresh brought. */
export function runResponseView(resp: RunRequestResponse): { navigateTo: string; reusedText?: string; changes: string[] } {
  const out: { navigateTo: string; reusedText?: string; changes: string[] } = { navigateTo: `/retirement/runs/${resp.run.id}`, changes: baselineChangeLines(resp.baselineChanges) };
  if (resp.reused) out.reusedText = `Identical inputs, showing the run from ${shortDate(resp.run.finishedAt ?? resp.run.createdAt)}`;
  return out;
}

// ---- §5.5 Results page states ----

export type ResultsState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "no_profile"; text: string; link?: NavItem }
  | { kind: "no_run"; text: string; link?: NavItem }
  | { kind: "active"; runId: string; progress: RunProgressView; previousRunId?: string; previousLabel?: string }
  | { kind: "failed"; runId: string; text: string; canRunAgain: boolean }
  | { kind: "cancelled"; runId: string; text: string; canRunAgain: boolean }
  | { kind: "ready"; runId: string };

/**
 * The Results page's state (§5.5's table): `run` is the run to show (by id, or the newest of the
 * scenario; null when there is none), `previousDone` the scenario's newest finished run while one
 * is active, whose result stays visible underneath marked "Previous run".
 */
export function resultsPageState(s: {
  isViewer: boolean;
  profileExists: boolean | undefined;
  scenarioId?: string | undefined;
  run: SimRunView | null | undefined;
  previousDone?: SimRunView | null | undefined;
  error?: unknown;
  nowMs: number;
}): ResultsState {
  if (s.error !== undefined && s.error !== null) return { kind: "error", error: s.error };
  if (s.profileExists === undefined || s.run === undefined) return { kind: "loading" };
  if (!s.profileExists) {
    return s.isViewer
      ? { kind: "no_profile", text: "No retirement plan has been set up yet" }
      : { kind: "no_profile", text: "Set up your retirement profile to run a plan", link: { to: "/retirement/profile", label: "Set up your profile" } };
  }
  const run = s.run;
  if (run === null) {
    const state: ResultsState = { kind: "no_run", text: "No run yet for this scenario" };
    if (s.scenarioId !== undefined) state.link = { to: `/retirement/scenarios/${s.scenarioId}`, label: "Run settings" };
    return state;
  }
  const canRunAgain = !s.isViewer;
  switch (run.status) {
    case "queued":
    case "running": {
      const state: ResultsState = { kind: "active", runId: run.id, progress: runProgressView(run, s.nowMs, s.isViewer) };
      if (s.previousDone) {
        state.previousRunId = s.previousDone.id;
        state.previousLabel = "Previous run";
      }
      return state;
    }
    case "failed":
      return { kind: "failed", runId: run.id, text: runFailureText(run.errorCode, run.errorMessage), canRunAgain };
    case "cancelled":
      return { kind: "cancelled", runId: run.id, text: "This run was cancelled", canRunAgain };
    case "done":
      return { kind: "ready", runId: run.id };
  }
}

/** The disclaimer every result view carries (§1 decision 40). */
export const RESULTS_DISCLAIMER = PLANNER_DISCLAIMER;

// ---- §5.2 and inputs §5: the profile page ----

export type ProfileStepId = "people" | "accounts" | "income" | "social_security" | "spending" | "savings";

/** The wizard's six steps (inputs §5) and the document paths each covers; `rothConversions` are edited with the savings. */
export const PROFILE_STEPS: ReadonlyArray<{ id: ProfileStepId; label: string; prefixes: readonly string[] }> = [
  { id: "people", label: "People", prefixes: ["people", "state"] },
  { id: "accounts", label: "Accounts", prefixes: ["accounts", "allocation"] },
  { id: "income", label: "Income", prefixes: ["incomes"] },
  { id: "social_security", label: "Social Security", prefixes: ["socialSecurity"] },
  { id: "spending", label: "Spending", prefixes: ["spending"] },
  { id: "savings", label: "Savings", prefixes: ["contributions", "rothConversions"] },
];

/** The step a document path belongs to; the first step for a path outside every step (an issue of the whole plan). */
export function stepOfPath(path: string): ProfileStepId {
  const head = path.split(".")[0] ?? "";
  return PROFILE_STEPS.find((s) => s.prefixes.includes(head))?.id ?? "people";
}

/** The element id of a field, for the issue list's links (§5.2 "the issue list links to each field"). */
export function issueFieldId(path: string): string {
  return `field-${path.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

export interface IssueLink {
  code: string;
  severity: PlanIssue["severity"];
  message: string;
  step: ProfileStepId;
  fieldId: string;
}

/** The issue list, errors first, each linked to its step and field. */
export function issueLinks(issues: readonly PlanIssue[]): IssueLink[] {
  const rank = (i: PlanIssue) => (i.severity === "error" ? 0 : 1);
  return [...issues]
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => rank(a.issue) - rank(b.issue) || a.index - b.index)
    .map(({ issue }) => ({ code: issue.code, severity: issue.severity, message: issue.message, step: stepOfPath(issue.path), fieldId: issueFieldId(issue.path) }));
}

export type ProfilePageState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "empty"; text: string }
  | {
      kind: "form";
      /** No profile yet: the wizard starts from `defaultProfileDoc` and saves with `expectedRevision: 0`. */
      creating: boolean;
      expectedRevision: number;
      banner?: string;
      readOnly: boolean;
      issues: IssueLink[];
      /** The first error issue: Run is disabled with it. */
      firstError?: string;
      notices: Array<{ text: string; link?: NavItem }>;
    };

/** Accounts the planner can invest from: a bucket other than cash. */
function hasInvestmentAccount(baseline: ProfileResponse["baseline"]): boolean {
  return baseline.accounts.some((a) => a.bucket !== undefined && a.bucket !== "cash");
}

/**
 * The profile page (§5.2, inputs §5): no profile → the wizard with its banner (the owner) or "No
 * retirement plan has been set up yet" (the viewer); saved → the form, read-only for the viewer,
 * with the issue list (errors first) and the first error that disables Run; the empty states
 * "Connect or add an investment account" and, with fewer than three months of ledger, "enter your
 * yearly spending".
 */
export function profilePageState(s: { isViewer: boolean; profile: ProfileResponse | undefined; error?: unknown }): ProfilePageState {
  if (s.error !== undefined && s.error !== null) return { kind: "error", error: s.error };
  const p = s.profile;
  if (p === undefined) return { kind: "loading" };
  if (!p.exists && s.isViewer) return { kind: "empty", text: "No retirement plan has been set up yet" };
  const notices: Array<{ text: string; link?: NavItem }> = [];
  if (!hasInvestmentAccount(p.baseline)) notices.push({ text: "Connect or add an investment account", link: { to: "/accounts", label: "Accounts" } });
  if (p.baseline.window.monthsWithData < 3) notices.push({ text: "Fewer than three full months of spending are recorded: enter your yearly spending" });
  const issues = issueLinks(p.issues);
  const state: ProfilePageState = { kind: "form", creating: !p.exists, expectedRevision: p.revision, readOnly: s.isViewer, issues, notices };
  if (!p.exists) state.banner = "Seeded from your accounts and the last 12 months of your plan. Review and save.";
  const firstError = issues.find((i) => i.severity === "error");
  if (firstError !== undefined) state.firstError = firstError.message;
  return state;
}

/** What a save conflict means (`409 revision_conflict`, inputs §4.8). */
export function revisionConflictText(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== "revision_conflict") return null;
  return "The profile or this scenario changed in another window. Reload to see the latest version; your edits here were not saved.";
}

// ---- The baseline banner and refresh dialog (§5.2, inputs §5) ----

export interface BaselineBanner {
  /** "Balances as of 11/08/26". */
  text: string;
  stale: boolean;
  /** "These balances are 9 days old." */
  staleText?: string;
  canRefresh: boolean;
}

/** The banner over the profile form (inputs §5): the as-of date, the stale note past seven days, Refresh for the owner. */
export function baselineBanner(p: Pick<ProfileResponse, "baseline" | "baselineStale" | "baselineAgeDays">, isViewer: boolean): BaselineBanner {
  const banner: BaselineBanner = { text: `Balances as of ${shortDate(p.baseline.asOf)}`, stale: p.baselineStale, canRefresh: !isViewer };
  if (p.baselineStale) banner.staleText = `These balances are ${countText(p.baselineAgeDays)} days old.`;
  return banner;
}

const DELTA_KINDS = new Set(["account_value", "account_basis", "bucket_total", "total", "contribution"]);

/** One baseline change in words: "401(k) +$12,300", "Base spending $84,200 → $86,050", or the label and its note. */
function changeLine(c: BaselineChange): string {
  if (DELTA_KINDS.has(c.kind) && c.deltaCents !== undefined) {
    const delta = BigInt(c.deltaCents);
    return `${c.label} ${delta > 0n ? "+" : ""}${wholeDollars(delta)}`;
  }
  if (c.beforeCents !== undefined && c.afterCents !== undefined) return `${c.label} ${wholeDollars(c.beforeCents)} → ${wholeDollars(c.afterCents)}`;
  return c.note === undefined ? c.label : `${c.label} (${c.note})`;
}

/** The refresh dialog's rows (inputs §3.6): material ones first, in the diff's order otherwise; the as-of row is left out. */
export function baselineChangeLines(changes: readonly BaselineChange[]): string[] {
  const rows = changes.filter((c) => c.kind !== "as_of");
  return [...rows.filter((c) => c.material), ...rows.filter((c) => !c.material)].map(changeLine);
}

/** What the refresh does to the plan (inputs §3.6): base spending, contributions and the included total, before → after. */
export function effectiveChangeLines(before: EffectiveInputsView | null, after: EffectiveInputsView | null): string[] {
  if (after === null) return [];
  const line = (label: string, a: string | undefined, b: string) => (a === undefined || a === b ? `${label} ${wholeDollars(b)}` : `${label} ${wholeDollars(a)} → ${wholeDollars(b)}`);
  return [
    line("Base spending", before?.baseSpendingCents, after.baseSpendingCents),
    line("Contributions", before?.contributionsCents, after.contributionsCents),
    line("Included balances", before?.includedTotalCents, after.includedTotalCents),
  ];
}

/** `409 baseline_changed` on Apply: the balances moved again while the dialog was open. */
export function baselineConflictText(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== "baseline_changed") return null;
  return "The balances changed again while this was open; the list now shows the latest changes.";
}

// ---- The Social Security preview (route 24, seams C42) ----

/** "67", "66 and 6 months". */
export function ageMonthsText(months: number): string {
  const years = Math.trunc(months / 12);
  const rest = months % 12;
  return rest === 0 ? String(years) : `${years} and ${rest} ${rest === 1 ? "month" : "months"}`;
}

export interface SsPreviewPerson {
  name: string;
  fullRetirementAge: string;
  rows: Array<{ age: string; factor: string; monthly: string; spousal: string; atFullAge: boolean }>;
  survivorAtFullAge: string;
}

/** The benefit-by-claiming-age table of profile step 4 from `POST /social-security-preview`. Factors are the engine's basis points, truncated to tenths of a percent. */
export function ssPreviewTable(resp: SocialSecurityPreviewResponse, names: readonly string[]): SsPreviewPerson[] {
  return resp.people.map((p, i) => ({
    name: names[i] ?? `Person ${i + 1}`,
    fullRetirementAge: ageMonthsText(p.fraMonths),
    rows: p.byClaimAge.map((r) => ({ age: ageMonthsText(r.claimAgeMonths), factor: percentText(r.factorBp), monthly: money(r.monthlyCents), spousal: money(r.spousalMonthlyCents), atFullAge: r.claimAgeMonths === p.fraMonths })),
    survivorAtFullAge: money(p.survivorMonthlyAtFraCents),
  }));
}

// ---- The rules page and the rule-set picker (seams C42) ----

/** The stale-tables note for the Results and Rules pages: the tables end before this year. */
export function staleTablesNote(rules: Pick<RetirementRulesView, "stale" | "lastPublishedYear">): string | null {
  if (!rules.stale) return null;
  return `The tax tables end with ${rules.lastPublishedYear}; later years are indexed by each path's inflation until the planner's data is updated.`;
}

/** Retirement-plan limits still carried at an earlier year's amounts. */
export function pendingLimitsNote(rules: Pick<RetirementRulesView, "pendingLimits">): string | null {
  const pending = rules.pendingLimits.filter((p) => p.fields.length > 0);
  if (pending.length === 0) return null;
  return `Not yet published, carried at the previous year's amounts: ${pending.map((p) => `${p.year} (${p.fields.join(", ")})`).join("; ")}.`;
}

/** The rule-set picker (seams C42): each rule set by its label, an illustrative one marked. */
export function ruleSetOptions(rules: Pick<RetirementRulesView, "ruleSets">): Array<{ value: string; label: string; description: string }> {
  return rules.ruleSets.map((r) => ({
    value: r.id,
    label: r.illustrative ? `${r.label} (illustrative)` : r.label,
    description: r.lawChanges.length === 0 ? "The law as enacted." : r.lawChanges.map((c) => c.label).join("; "),
  }));
}

// ---- §5.3 Scenarios ----

export interface ScenarioRow {
  id: string;
  name: string;
  isDefault: boolean;
  changesText: string;
  latestRunText: string;
  activeText?: string;
  actions: Array<"open" | "duplicate" | "rename" | "make_default" | "archive" | "delete">;
}

/** The scenario list (§5.3): name, default badge, the number of changes, the latest run's rate, an active run; owner actions (never Delete or Archive for the default). */
export function scenarioRows(items: readonly ScenarioSummary[], isViewer: boolean): ScenarioRow[] {
  return items.map((s) => {
    const run = s.latestRun;
    const row: ScenarioRow = {
      id: s.id,
      name: s.name,
      isDefault: s.isDefault,
      changesText: s.changeCount === 0 ? "No changes" : `${countText(s.changeCount)} ${s.changeCount === 1 ? "change" : "changes"}`,
      latestRunText:
        run === null ? "No run yet" : run.successBp === null ? `${run.status === "failed" ? "Failed" : run.status === "cancelled" ? "Cancelled" : "In progress"} · ${shortDate(run.createdAt)}` : `${successText(run.successBp)} · run ${shortDate(run.finishedAt ?? run.createdAt)}`,
      actions: isViewer ? ["open"] : s.isDefault ? ["open", "duplicate", "rename"] : ["open", "duplicate", "rename", "make_default", "archive", "delete"],
    };
    if (s.activeRunId !== null) row.activeText = run !== null && run.id === s.activeRunId ? `Simulating: ${percentText(run.progressBp, 0)}` : "Simulating";
    return row;
  });
}

/** The line shown when only the default scenario exists (§5.3). */
export function scenarioListNote(items: readonly ScenarioSummary[]): string | null {
  if (items.filter((s) => !s.archived).length > 1) return null;
  return "A scenario is a set of changes on top of your profile: retire earlier, spend less, or try another strategy, and compare the results.";
}

/** The Delete confirmation (§5.3): the scenario's runs go with it. */
export function deleteScenarioConfirm(name: string): string {
  return `Delete "${name}"? Its runs are deleted with it. This cannot be undone.`;
}

// ---- §5.6 History ----

export interface RunRow {
  id: string;
  started: string;
  scenario: string;
  returnModel: string;
  strategy: string;
  paths: string;
  seed: string;
  success: string;
  medianEnding: string;
  duration: string;
  versions: string;
  status: string;
  pinned: boolean;
  note: string;
  progress?: string;
  actions: Array<"open" | "pin" | "cancel" | "delete">;
}

const STATUS_TEXT: Record<SimRunView["status"], string> = { queued: "Queued", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled" };

/** The run list (§5.6): one row per run; active runs show progress and Cancel; Delete for the owner, never while active. */
export function runRows(items: readonly SimRunView[], isViewer: boolean): RunRow[] {
  return items.map((r) => {
    const active = r.status === "queued" || r.status === "running";
    const actions: RunRow["actions"] = ["open"];
    if (!isViewer) {
      actions.push("pin");
      if (active && !r.cancelRequested) actions.push("cancel");
      if (!active) actions.push("delete");
    }
    const row: RunRow = {
      id: r.id,
      started: shortDate(r.startedAt ?? r.createdAt),
      scenario: r.scenarioName,
      returnModel: returnModelLabel(r.returnModel),
      strategy: strategyLabel(r.strategy),
      paths: countText(r.paths),
      seed: String(r.seed),
      success: r.successBp === null ? "—" : successText(r.successBp),
      medianEnding: r.medianEndingRealCents === null ? "—" : wholeDollars(r.medianEndingRealCents),
      duration: durationText(r.durationMs),
      versions: `engine ${r.engineVersion ?? "—"}, data ${r.dataVersion}`,
      status: STATUS_TEXT[r.status],
      pinned: r.pinned,
      note: r.note ?? "",
      actions,
    };
    if (active) row.progress = percentText(Math.max(0, Math.min(10_000, r.progressBp)), 0);
    return row;
  });
}

/** The empty history (§5.6). */
export const NO_RUNS_TEXT = "No runs yet.";

/** The strategy card texts, re-exported for the run-settings page with their labels in display order. */
export const STRATEGY_CARDS = (Object.keys(STRATEGY_INFO) as Array<keyof typeof STRATEGY_INFO>).map((kind) => ({ kind, ...STRATEGY_INFO[kind] }));

// ---- The profile's Accounts step (§5.2) ----

const ALLOCATION_SOURCE_TEXT: Record<AllocationSource, string> = {
  holdings: "from the holdings",
  override: "typed",
  profile_default: "your mix for unclassified accounts",
  household_target: "the household targets (assumed)",
  household_actual: "the household's overall mix (assumed)",
  assumed: "60% stocks, 40% bonds (assumed)",
  cash: "cash",
  pretax_mix: "the pre-tax accounts' mix",
};

const COVERAGE_TEXT: Record<BasisCoverage, string> = { full: "cost basis known", partial: "cost basis partly unknown", none: "cost basis unknown", manual: "cost basis typed" };

export interface AccountRow {
  accountId: string;
  name: string;
  balance: string;
  valuationDate: string;
  included: boolean;
  owner?: string;
  basis?: string;
  allocation?: string;
  /** The account's issues (a borrowed allocation, an unknown basis), as their messages. */
  warnings: string[];
}

export interface AccountGroup {
  bucket: PlanBucket;
  label: string;
  link: NavItem;
  accounts: AccountRow[];
}

/**
 * The live accounts grouped by bucket (§5.2 "Accounts step"): balance, valuation date, owner, basis
 * coverage, the allocation's source and the account's warnings from `issues`, each group linking to
 * Accounts. Accounts outside every bucket (a 529, a credit card) are listed apart with the reason.
 */
export function accountGroups(
  baseline: ProfileResponse["baseline"],
  effective: EffectiveInputsView | null,
  issues: readonly PlanIssue[],
  people: { p1?: string; p2?: string } = {},
): { groups: AccountGroup[]; outside: Array<{ name: string; reason: string }> } {
  const ownerText = (o: OwnerId) => (o === "joint" ? "Joint" : (people[o] ?? (o === "p1" ? "Person 1" : "Person 2")));
  const groups: AccountGroup[] = [];
  for (const bucket of BUCKETS) {
    const accounts = baseline.accounts.filter((a) => a.bucket === bucket);
    if (accounts.length === 0) continue;
    groups.push({
      bucket,
      label: bucketLabel(bucket),
      link: { to: "/accounts", label: "Accounts" },
      accounts: accounts.map((a) => {
        const e = effective?.accounts.find((x) => x.accountId === a.accountId);
        const row: AccountRow = {
          accountId: a.accountId,
          name: a.name,
          balance: a.valueCents === undefined ? "—" : money(a.valueCents),
          valuationDate: shortDate(a.valuationDate),
          included: e?.included ?? false,
          warnings: issues.filter((i) => i.accountId === a.accountId).map((i) => i.message),
        };
        if (e?.owner !== undefined) row.owner = ownerText(e.owner);
        const coverage = e?.basisCoverage ?? a.basis?.coverage;
        if (bucket === "taxable" && coverage !== undefined) row.basis = COVERAGE_TEXT[coverage];
        if (e?.allocationSource !== undefined) row.allocation = ALLOCATION_SOURCE_TEXT[e.allocationSource];
        return row;
      }),
    });
  }
  const outside = baseline.accounts
    .filter((a) => a.bucket === undefined)
    .map((a) => ({ name: a.name, reason: a.ineligible === "education" ? "An education account is not part of the retirement plan" : "Not an account the planner draws from" }));
  return { groups, outside };
}
