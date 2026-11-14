import { defaultRunSettings, ProfileResponse, RetirementProfileDoc, SimRunView, type BaselineChange, type PlanIssue, type ScenarioSummary } from "@meridian/shared";
import { fixtureBaseline, fixtureProfileDoc, IDS } from "@meridian/shared/src/retirement/testFixtures.js";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import { inlineIssues } from "./retirementForms.js";
import {
  accountGroups,
  activeNav,
  ageMonthsText,
  baselineBanner,
  baselineChangeLines,
  baselineConflictText,
  deleteScenarioConfirm,
  effectiveChangeLines,
  issueFieldId,
  issueLinks,
  NO_RUNS_TEXT,
  parseResultsQuery,
  pendingLimitsNote,
  percentileErrorText,
  profilePageState,
  resultsPageState,
  resultsSearch,
  retirementCapabilities,
  retirementKey,
  revisionConflictText,
  ruleSetOptions,
  runButtonState,
  runFailureText,
  runProgressView,
  runResponseView,
  runRows,
  scenarioListNote,
  scenarioRows,
  ssPreviewTable,
  staleTablesNote,
  stepOfPath,
  STRATEGY_CARDS,
} from "./retirementStates.js";

const SCENARIO_ID = "b0000000-0000-4000-8000-000000000001";

function run(patch: Partial<SimRunView> = {}): SimRunView {
  return SimRunView.parse({
    id: "d0000000-0000-4000-8000-000000000001",
    scenarioId: SCENARIO_ID,
    scenarioName: "Base plan",
    status: "done",
    cancelRequested: false,
    stalled: false,
    paths: 10000,
    pathsDone: 10000,
    progressBp: 10000,
    seed: 1,
    returnModel: "bootstrap",
    strategy: "constant_dollar",
    taxRuleSet: "current_law",
    baselineAsOf: "2026-11-08",
    dataVersion: "2026.11.1",
    engineVersion: "1.0.1",
    threads: 3,
    inputHash: "0".repeat(64),
    successPaths: 9402,
    successBp: 9402,
    medianEndingRealCents: "120000000",
    p10EndingRealCents: "0",
    errorCode: null,
    errorMessage: null,
    pinned: false,
    note: null,
    createdAt: "2026-11-08",
    startedAt: "2026-11-08",
    finishedAt: "2026-11-08",
    durationMs: 1900,
    current: true,
    ...patch,
  });
}

const NOW = Date.parse("2026-11-08T00:01:05.000Z");

describe("§5.1 the shell and the Results page's URL state", () => {
  it("a run keeps Results active, a scenario Scenarios", () => {
    expect(activeNav("/retirement/runs/abc")).toBe("/retirement");
    expect(activeNav("/retirement/")).toBe("/retirement");
    expect(activeNav("/retirement/scenarios/abc")).toBe("/retirement/scenarios");
    expect(activeNav("/retirement/profile")).toBe("/retirement/profile");
    expect(activeNav("/retirement/history")).toBe("/retirement/history");
  });

  it("?scenario=, ?p= (1 to 99, default 50), ?dollars=, ?view= round-trip with the defaults left out", () => {
    expect(parseResultsQuery("")).toEqual({ percentile: 50, dollars: "today", view: "portfolio" });
    const q = parseResultsQuery(`?scenario=${SCENARIO_ID}&p=10&dollars=nominal&view=spending`);
    expect(q).toEqual({ scenario: SCENARIO_ID, percentile: 10, dollars: "nominal", view: "spending" });
    expect(resultsSearch(q)).toBe(`?scenario=${SCENARIO_ID}&p=10&dollars=nominal&view=spending`);
    expect(resultsSearch(parseResultsQuery("?p=100&dollars=euro&view=x&scenario=not-a-uuid"))).toBe("");
    expect(retirementKey("run", { id: "x" })).toEqual(["retirement", "run", { id: "x" }]);
    expect(retirementKey("meta")).toEqual(["retirement", "meta"]);
  });
});

describe("§5.9 the viewer", () => {
  it("reads everything and changes nothing", () => {
    expect(Object.values(retirementCapabilities(true)).every((v) => v === false)).toBe(true);
    expect(Object.values(retirementCapabilities(false)).every((v) => v === true)).toBe(true);
  });
});

describe("§5.5 the Results page's states", () => {
  const base = { isViewer: false, profileExists: true, scenarioId: SCENARIO_ID, nowMs: NOW };

  it("loading, and a query error", () => {
    expect(resultsPageState({ ...base, profileExists: undefined, run: undefined })).toEqual({ kind: "loading" });
    expect(resultsPageState({ ...base, run: undefined })).toEqual({ kind: "loading" });
    const error = new ApiError(500, "boom");
    expect(resultsPageState({ ...base, run: null, error })).toEqual({ kind: "error", error });
  });

  it("no profile: a link for the owner; the viewer is told none exists", () => {
    expect(resultsPageState({ ...base, profileExists: false, run: null })).toEqual({ kind: "no_profile", text: "Set up your retirement profile to run a plan", link: { to: "/retirement/profile", label: "Set up your profile" } });
    expect(resultsPageState({ ...base, isViewer: true, profileExists: false, run: null })).toEqual({ kind: "no_profile", text: "No retirement plan has been set up yet" });
  });

  it("a profile and no run of this scenario: a link to its run settings", () => {
    expect(resultsPageState({ ...base, run: null })).toEqual({ kind: "no_run", text: "No run yet for this scenario", link: { to: `/retirement/scenarios/${SCENARIO_ID}`, label: "Run settings" } });
  });

  it("queued or running: progress, elapsed, Cancel for the owner; the previous run stays underneath", () => {
    const active = run({ status: "running", pathsDone: 6200, progressBp: 6200, startedAt: "2026-11-08T00:00:00.000Z", finishedAt: null, successBp: null, successPaths: null });
    const state = resultsPageState({ ...base, run: active, previousDone: run({ id: "d0000000-0000-4000-8000-000000000009" }) });
    expect(state).toEqual({
      kind: "active",
      runId: active.id,
      progress: { percentText: "62%", progressBp: 6200, pathsText: "6,200 of 10,000 paths", elapsedText: "1 min 5 s", statusText: "Simulating", stalled: false, canCancel: true },
      previousRunId: "d0000000-0000-4000-8000-000000000009",
      previousLabel: "Previous run",
    });
  });

  it("stalled reads 'the worker stopped responding'; queued waits; a requested cancel shows; the viewer cannot cancel", () => {
    const stalled = run({ status: "running", stalled: true, progressBp: 100, pathsDone: 100 });
    expect(runProgressView(stalled, NOW, false).statusText).toBe("The worker stopped responding");
    expect(runProgressView(run({ status: "queued", progressBp: 0, pathsDone: 0, startedAt: null }), NOW, false).statusText).toBe("Waiting for the worker");
    const cancelling = runProgressView(run({ status: "running", cancelRequested: true }), NOW, false);
    expect([cancelling.statusText, cancelling.canCancel]).toEqual(["Cancelling…", false]);
    expect(runProgressView(stalled, NOW, true).canCancel).toBe(false);
  });

  it("failed: the code as a plain sentence for the engine's errors, else the message; Run again for the owner", () => {
    expect(resultsPageState({ ...base, run: run({ status: "failed", errorCode: "horizon_too_long", errorMessage: "Y = 130" }) })).toEqual({
      kind: "failed",
      runId: "d0000000-0000-4000-8000-000000000001",
      text: "The plan runs longer than the engine's limit of 120 years.",
      canRunAgain: true,
    });
    expect(runFailureText("something_new", "It broke")).toBe("It broke (something_new)");
    expect(runFailureText(null, null)).toBe("The run failed.");
    expect(runFailureText("worker_error", null)).toBe("A simulation thread stopped unexpectedly. Running the plan again usually works.");
    expect(resultsPageState({ ...base, isViewer: true, run: run({ status: "failed", errorCode: "timeout" }) })).toMatchObject({ canRunAgain: false });
  });

  it("cancelled, and ready", () => {
    expect(resultsPageState({ ...base, run: run({ status: "cancelled" }) })).toEqual({ kind: "cancelled", runId: "d0000000-0000-4000-8000-000000000001", text: "This run was cancelled", canRunAgain: true });
    expect(resultsPageState({ ...base, run: run() })).toEqual({ kind: "ready", runId: "d0000000-0000-4000-8000-000000000001" });
  });

  it("409 engine_changed and not_reproducible on a percentile", () => {
    expect(percentileErrorText(new ApiError(409, "x", "engine_changed"))).toMatch(/stored percentiles \(5, 10, 25, 50, 75, 90 and 95\) still show/);
    expect(percentileErrorText(new ApiError(409, "x", "not_reproducible"))).toBe("This path could not be reproduced; run the plan again.");
    expect(percentileErrorText(new Error("x"))).toBeNull();
  });
});

describe("§5.4 the Run button and its response", () => {
  const error: PlanIssue = { code: "no_accounts", severity: "error", path: "accounts", message: "No account is included in the plan" };
  const warning: PlanIssue = { code: "baseline_stale", severity: "warning", path: "", message: "Balances are 9 days old" };

  it("hidden for the viewer; disabled with the first error; disabled while a run is active", () => {
    expect(runButtonState({ isViewer: true, issues: [], activeRunId: null })).toEqual({ visible: false, disabled: true });
    expect(runButtonState({ isViewer: false, issues: [warning, error], activeRunId: null })).toEqual({ visible: true, disabled: true, reason: "No account is included in the plan" });
    expect(runButtonState({ isViewer: false, issues: [warning], activeRunId: "x" })).toEqual({ visible: true, disabled: true, reason: "A run of this scenario is in progress" });
    expect(runButtonState({ isViewer: false, issues: [warning], activeRunId: null })).toEqual({ visible: true, disabled: false });
  });

  it("a reused run reads 'identical inputs, showing the run from 11/08/26'; the baseline changes are listed", () => {
    const changes: BaselineChange[] = [{ kind: "account_value", path: "accounts.k", label: "401(k)", deltaCents: "1230000", material: true }];
    expect(runResponseView({ run: run(), created: false, reused: true, baselineChanges: changes })).toEqual({
      navigateTo: "/retirement/runs/d0000000-0000-4000-8000-000000000001",
      reusedText: "Identical inputs, showing the run from 11/08/26",
      changes: ["401(k) +$12,300"],
    });
  });
});

function profile(patch: Partial<ProfileResponse> = {}): ProfileResponse {
  return ProfileResponse.parse({
    exists: true,
    revision: 3,
    doc: RetirementProfileDoc.parse(fixtureProfileDoc()),
    updatedAt: "2026-11-08T00:00:00.000Z",
    baseline: fixtureBaseline(),
    baselineStored: true,
    baselineHash: "0".repeat(64),
    baselineAgeDays: 1,
    baselineStale: false,
    effective: null,
    issues: [],
    scenarioIssues: [],
    defaultScenarioId: SCENARIO_ID,
    ...patch,
  });
}

describe("§5.2 and inputs §5 the profile page", () => {
  it("loading and errors", () => {
    expect(profilePageState({ isViewer: false, profile: undefined })).toEqual({ kind: "loading" });
    expect(profilePageState({ isViewer: false, profile: undefined, error: new Error("x") }).kind).toBe("error");
  });

  it("no profile: the wizard with its banner and expectedRevision 0 (owner); the viewer sees the empty state", () => {
    const none = profile({ exists: false, revision: 0, doc: null });
    expect(profilePageState({ isViewer: false, profile: none })).toEqual({
      kind: "form",
      creating: true,
      expectedRevision: 0,
      readOnly: false,
      issues: [],
      notices: [],
      banner: "Seeded from your accounts and the last 12 months of your plan. Review and save.",
    });
    expect(profilePageState({ isViewer: true, profile: none })).toEqual({ kind: "empty", text: "No retirement plan has been set up yet" });
  });

  it("saved with errors: the issue list, errors first, linked to the step and field; Run disabled with the first error", () => {
    const issues: PlanIssue[] = [
      { code: "baseline_stale", severity: "warning", path: "", message: "Balances are 9 days old" },
      { code: "glide_order", severity: "error", path: "allocation.glidePath.points", message: "Glide-path ages must rise" },
      { code: "claim_in_past", severity: "error", path: "socialSecurity.p2", message: "Sam's claim is in the past" },
    ];
    const state = profilePageState({ isViewer: false, profile: profile({ issues }) });
    expect(state).toMatchObject({ kind: "form", creating: false, expectedRevision: 3, firstError: "Glide-path ages must rise" });
    if (state.kind !== "form") return;
    expect(state.issues.map((i) => [i.code, i.step, i.fieldId])).toEqual([
      ["glide_order", "accounts", "field-allocation-glidePath-points"],
      ["claim_in_past", "social_security", "field-socialSecurity-p2"],
      ["baseline_stale", "people", "field-"],
    ]);
  });

  it("the viewer reads the saved profile without inputs", () => {
    expect(profilePageState({ isViewer: true, profile: profile() })).toMatchObject({ kind: "form", readOnly: true });
  });

  it("empty states: no investment account; fewer than three months of ledger", () => {
    const b = fixtureBaseline();
    const thin = profile({ baseline: { ...b, accounts: b.accounts.filter((a) => a.bucket === "cash" || a.bucket === undefined), window: { ...b.window, monthsWithData: 2 } } });
    const state = profilePageState({ isViewer: false, profile: thin });
    expect(state.kind === "form" && state.notices).toEqual([
      { text: "Connect or add an investment account", link: { to: "/accounts", label: "Accounts" } },
      { text: "Fewer than three full months of spending are recorded: enter your yearly spending" },
    ]);
  });

  it("steps and field ids from document paths", () => {
    expect(stepOfPath("people.p1.retirementAge")).toBe("people");
    expect(stepOfPath("state")).toBe("people");
    expect(stepOfPath("accounts.a0000000-0000-4000-8000-000000000001.owner")).toBe("accounts");
    expect(stepOfPath("incomes.pen1")).toBe("income");
    expect(stepOfPath("spending.goals.roof")).toBe("spending");
    expect(stepOfPath("rothConversions.conv1")).toBe("savings");
    expect(issueFieldId("spending.phases.0.fromAge")).toBe("field-spending-phases-0-fromAge");
    expect(issueLinks([])).toEqual([]);
  });

  it("conflicts: revision_conflict and baseline_changed in words; other errors are not theirs", () => {
    expect(revisionConflictText(new ApiError(409, "x", "revision_conflict"))).toMatch(/^The profile or this scenario changed in another window/);
    expect(revisionConflictText(new ApiError(409, "x", "baseline_changed"))).toBeNull();
    expect(baselineConflictText(new ApiError(409, "x", "baseline_changed"))).toBe("The balances changed again while this was open; the list now shows the latest changes.");
  });
});

describe("the baseline banner and refresh dialog (inputs §5, §3.6)", () => {
  it("'Balances as of 10/13/26', stale past seven days, Refresh for the owner", () => {
    expect(baselineBanner(profile(), false)).toEqual({ text: "Balances as of 10/13/26", stale: false, canRefresh: true });
    expect(baselineBanner(profile({ baselineStale: true, baselineAgeDays: 9 }), true)).toEqual({ text: "Balances as of 10/13/26", stale: true, staleText: "These balances are 9 days old.", canRefresh: false });
  });

  it("inputs test 15's rows: material first, deltas for values, before → after for spending; the as-of row left out", () => {
    const rows: BaselineChange[] = [
      { kind: "as_of", path: "asOf", label: "As of", material: false },
      { kind: "account_value", path: "accounts.k", label: "Acme 401(k)", beforeCents: "15000000", afterCents: "15250000", deltaCents: "250000", material: true },
      { kind: "bucket_total", path: "totals.pre_tax", label: "Pre-tax", beforeCents: "15000000", afterCents: "15250000", deltaCents: "250000", material: true },
      { kind: "total", path: "totals", label: "Total", beforeCents: "22582700", afterCents: "22832700", deltaCents: "250000", material: true },
      { kind: "spending_category", path: "spending.groceries", label: "Groceries", beforeCents: "955000", afterCents: "1000000", deltaCents: "45000", material: false },
      { kind: "spending_uncategorized", path: "spending.uncategorized", label: "Uncategorized", beforeCents: "45000", afterCents: "0", note: "2 → 1", material: false },
      { kind: "account_added", path: "accounts.x", label: "New brokerage", material: true },
    ];
    expect(baselineChangeLines(rows)).toEqual([
      "Acme 401(k) +$2,500",
      "Pre-tax +$2,500",
      "Total +$2,500",
      "New brokerage",
      "Groceries $9,550 → $10,000",
      "Uncategorized $450 → $0",
    ]);
  });

  it("what the refresh does to the plan: base spending, contributions, the included total", () => {
    const before = { includedTotalCents: "22582700", byBucketCents: {}, baseSpendingCents: "4000000", essentialSpendingCents: "2400000", contributionsCents: "2960000", employerCents: "600000", accounts: [] };
    const after = { ...before, includedTotalCents: "22832700" };
    expect(effectiveChangeLines(before, after)).toEqual(["Base spending $40,000", "Contributions $29,600", "Included balances $225,827 → $228,327"]);
    expect(effectiveChangeLines(before, null)).toEqual([]);
  });
});

describe("the Social Security preview and the rules page (seams C42)", () => {
  it("benefit by claiming age with the full retirement age marked (HC-S1's factors for 3,000 at 67)", () => {
    const resp = {
      people: [
        {
          fraMonths: 804,
          survivorFraMonths: 804,
          piaAtStartCents: "300000",
          byClaimAge: [
            { claimAgeMonths: 744, factorBp: 7000, monthlyCents: "210000", spousalMonthlyCents: "0" },
            { claimAgeMonths: 804, factorBp: 10000, monthlyCents: "300000", spousalMonthlyCents: "0" },
            { claimAgeMonths: 840, factorBp: 12400, monthlyCents: "372000", spousalMonthlyCents: "0" },
          ],
          survivorMonthlyAtFraCents: "300000",
        },
      ],
    };
    expect(ssPreviewTable(resp, ["Alex"])).toEqual([
      {
        name: "Alex",
        fullRetirementAge: "67",
        rows: [
          { age: "62", factor: "70%", monthly: "$2,100.00", spousal: "$0.00", atFullAge: false },
          { age: "67", factor: "100%", monthly: "$3,000.00", spousal: "$0.00", atFullAge: true },
          { age: "70", factor: "124%", monthly: "$3,720.00", spousal: "$0.00", atFullAge: false },
        ],
        survivorAtFullAge: "$3,000.00",
      },
    ]);
    expect(ageMonthsText(798)).toBe("66 and 6 months");
    expect(ageMonthsText(793)).toBe("66 and 1 month");
  });

  it("the stale-tables note, pending limits and the rule-set picker", () => {
    expect(staleTablesNote({ stale: false, lastPublishedYear: 2027 })).toBeNull();
    expect(staleTablesNote({ stale: true, lastPublishedYear: 2027 })).toBe("The tax tables end with 2027; later years are indexed by each path's inflation until the planner's data is updated.");
    expect(pendingLimitsNote({ pendingLimits: [] })).toBeNull();
    expect(pendingLimitsNote({ pendingLimits: [{ year: 2028, fields: ["ira", "hsaSelf"] }] })).toBe("Not yet published, carried at the previous year's amounts: 2028 (ira, hsaSelf).");
    expect(
      ruleSetOptions({
        ruleSets: [
          { id: "current_law", label: "Current law", illustrative: false, lawChanges: [] },
          { id: "tcja_sunset", label: "Higher rates from 2030", illustrative: true, lawChanges: [{ id: "rates_2017", label: "2017 brackets return", description: "", illustrative: true }] },
        ],
      }),
    ).toEqual([
      { value: "current_law", label: "Current law", description: "The law as enacted." },
      { value: "tcja_sunset", label: "Higher rates from 2030 (illustrative)", description: "2017 brackets return" },
    ]);
  });
});

function summaryRow(patch: Partial<ScenarioSummary> = {}): ScenarioSummary {
  return { id: SCENARIO_ID, name: "Base plan", notes: null, isDefault: true, archived: false, position: 0, revision: 1, updatedAt: "2026-11-08", changeCount: 0, latestRun: null, activeRunId: null, ...patch };
}

describe("§5.3 scenarios", () => {
  it("rows: changes, the latest run's rate, an active run; the default is never deleted or archived; the viewer only opens", () => {
    const rows = scenarioRows(
      [
        summaryRow({ latestRun: run() }),
        summaryRow({ id: "b0000000-0000-4000-8000-000000000002", name: "Retire at 62", isDefault: false, changeCount: 3, latestRun: run({ status: "running", progressBp: 4100, successBp: null, id: "d0000000-0000-4000-8000-000000000003" }), activeRunId: "d0000000-0000-4000-8000-000000000003" }),
        summaryRow({ id: "b0000000-0000-4000-8000-000000000003", name: "Spend less", isDefault: false, changeCount: 1 }),
      ],
      false,
    );
    expect(rows.map((r) => [r.name, r.changesText, r.latestRunText, r.activeText])).toEqual([
      ["Base plan", "No changes", "94% · run 11/08/26", undefined],
      ["Retire at 62", "3 changes", "In progress · 11/08/26", "Simulating: 41%"],
      ["Spend less", "1 change", "No run yet", undefined],
    ]);
    expect(rows[0]!.actions).toEqual(["open", "duplicate", "rename"]);
    expect(rows[1]!.actions).toEqual(["open", "duplicate", "rename", "make_default", "archive", "delete"]);
    expect(scenarioRows([summaryRow()], true)[0]!.actions).toEqual(["open"]);
  });

  it("with only the default scenario, the explaining line; the delete confirmation names the runs", () => {
    expect(scenarioListNote([summaryRow()])).toMatch(/^A scenario is a set of changes on top of your profile/);
    expect(scenarioListNote([summaryRow(), summaryRow({ id: "b0000000-0000-4000-8000-000000000002", isDefault: false })])).toBeNull();
    expect(deleteScenarioConfirm("Retire at 62")).toBe('Delete "Retire at 62"? Its runs are deleted with it. This cannot be undone.');
  });
});

describe("§5.6 history", () => {
  it("rows with model, strategy, rate, wealth, duration and versions; Cancel while active, Delete only when not; the empty text", () => {
    const [done, active] = runRows([run({ pinned: true, note: "before the raise" }), run({ id: "d0000000-0000-4000-8000-000000000002", status: "running", progressBp: 2500, successBp: null, medianEndingRealCents: null, durationMs: null })], false);
    expect(done).toEqual({
      id: "d0000000-0000-4000-8000-000000000001",
      started: "11/08/26",
      scenario: "Base plan",
      returnModel: "Block bootstrap",
      strategy: "Constant inflation-adjusted",
      paths: "10,000",
      seed: "1",
      success: "94%",
      medianEnding: "$1,200,000",
      duration: "1.9 s",
      versions: "engine 1.0.1, data 2026.11.1",
      status: "Done",
      pinned: true,
      note: "before the raise",
      actions: ["open", "pin", "delete"],
    });
    expect([active!.status, active!.progress, active!.success, active!.duration, active!.actions]).toEqual(["Running", "25%", "—", "—", ["open", "pin", "cancel"]]);
    expect(runRows([run()], true)[0]!.actions).toEqual(["open"]);
    expect(NO_RUNS_TEXT).toBe("No runs yet.");
  });

  it("the strategy cards in the order of STRATEGY_INFO", () => {
    expect(STRATEGY_CARDS.map((c) => c.kind)).toEqual(["constant_dollar", "fixed_percentage", "guardrails", "vpw", "floor_ceiling"]);
    expect(STRATEGY_CARDS[0]!.label).toBe("Constant inflation-adjusted");
  });
});

describe("§5.2 the Accounts step: the live accounts by bucket", () => {
  it("the fixture: groups in bucket order with balance, date, owner, basis, the allocation's source and the account's warnings; the 529 apart", () => {
    const doc = RetirementProfileDoc.parse(fixtureProfileDoc());
    const resolved = inlineIssues({ doc, baseline: fixtureBaseline(), settings: defaultRunSettings() }, { dataVersion: "2026.11.1", minStartYear: 2026, ruleSets: [{ id: "current_law", label: "Current law" }] }, "2026-10-14");
    const { groups, outside } = accountGroups(fixtureBaseline(), resolved.effective ?? null, resolved.issues, { p1: "Alex", p2: "Sam" });
    expect(groups.map((g) => [g.label, g.accounts.map((a) => a.name)])).toEqual([
      ["Taxable", ["Old Brokerage", "Brokerage"]],
      ["Pre-tax", ["Acme 401(k)"]],
      ["Roth", ["Roth IRA"]],
      ["HSA", ["HealthEquity HSA"]],
      ["Cash", ["Checking", "Savings"]],
    ]);
    const old = groups[0]!.accounts[0]!;
    expect(old).toMatchObject({ accountId: IDS.T, balance: "$4,325.00", valuationDate: "10/13/26", included: true, owner: "Joint", basis: "cost basis partly unknown", allocation: "from the holdings" });
    expect(old.warnings.length).toBeGreaterThan(0);
    expect(old.warnings).toEqual(resolved.issues.filter((i) => i.accountId === IDS.T).map((i) => i.message));
    const k = groups[1]!.accounts[0]!;
    expect(k).toMatchObject({ owner: "Alex", allocation: "the household targets (assumed)" });
    expect(k.basis).toBeUndefined();
    expect(groups.every((g) => g.link.to === "/accounts")).toBe(true);
    expect(outside).toEqual([{ name: "College 529", reason: "An education account is not part of the retirement plan" }]);
  });
});
