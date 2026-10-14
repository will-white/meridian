import { describe, expect, it } from "vitest";
import type { GoalView } from "@meridian/shared";
import { NEW_CATEGORY, buildGoalBody, initialGoalForm, percentFromBp, type GoalFormState } from "./planGoalForm.js";

const CATEGORY = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "44444444-4444-4444-8444-444444444444";

const form = (over: Partial<GoalFormState> = {}): GoalFormState => ({
  name: "Vacation",
  categoryId: CATEGORY,
  newCategoryName: "",
  target: "3,000.00",
  targetDate: "2027-06-30",
  linkedAccountId: "",
  contribution: "250",
  startMonth: "2026-10",
  starting: "",
  status: "active",
  ...over,
});

describe("buildGoalBody", () => {
  it("builds the create body from the grid-and-api Vacation example", () => {
    expect(buildGoalBody(form(), false)).toEqual({
      ok: true,
      body: {
        name: "Vacation",
        categoryId: CATEGORY,
        targetCents: "300000",
        targetDate: "2027-06-30",
        linkedAccountId: null,
        monthlyContributionCents: "25000",
        startMonth: "2026-10",
        startingCents: "0",
      },
    });
  });
  it("creates a category by name when asked, defaulting to the goal's name", () => {
    const r = buildGoalBody(form({ categoryId: NEW_CATEGORY, newCategoryName: " Trip fund " }), false);
    expect(r.ok && r.body.newCategory).toEqual({ name: "Trip fund" });
    expect(r.ok && r.body.categoryId).toBeUndefined();
    const dflt = buildGoalBody(form({ categoryId: NEW_CATEGORY }), false);
    expect(dflt.ok && dflt.body.newCategory).toEqual({ name: "Vacation" });
    expect(buildGoalBody(form({ categoryId: NEW_CATEGORY }), true)).toEqual({ ok: false, error: "Pick an existing savings category" });
  });
  it("carries status, linked account and starting amount on edit", () => {
    const r = buildGoalBody(form({ status: "completed", linkedAccountId: ACCOUNT, starting: "$2,000", targetDate: "" }), true);
    expect(r).toEqual({
      ok: true,
      body: {
        name: "Vacation",
        categoryId: CATEGORY,
        targetCents: "300000",
        targetDate: null,
        linkedAccountId: ACCOUNT,
        monthlyContributionCents: "25000",
        startMonth: "2026-10",
        startingCents: "200000",
        status: "completed",
      },
    });
  });
  it("rejects what the API would reject, with a field name", () => {
    expect(buildGoalBody(form({ name: "  " }), false)).toEqual({ ok: false, error: "Give the goal a name" });
    expect(buildGoalBody(form({ target: "" }), false)).toEqual({ ok: false, error: "Target must be more than $0" });
    expect(buildGoalBody(form({ target: "0" }), false)).toEqual({ ok: false, error: "Target must be more than $0" });
    expect(buildGoalBody(form({ target: "-5" }), false)).toEqual({ ok: false, error: "Target: Amounts can't be negative" });
    expect(buildGoalBody(form({ contribution: "abc" }), false)).toEqual({ ok: false, error: "Monthly contribution: Not an amount" });
    expect(buildGoalBody(form({ starting: "1.234" }), false)).toEqual({ ok: false, error: "Already saved: Use at most two decimals" });
    expect(buildGoalBody(form({ startMonth: "2026-13" }), false)).toEqual({ ok: false, error: "Pick a start month" });
    expect(buildGoalBody(form({ categoryId: "" }), false)).toEqual({ ok: false, error: "Pick a savings category or create one" });
    // On edit a blank category means "leave it alone".
    const edit = buildGoalBody(form({ categoryId: "" }), true);
    expect(edit.ok && edit.body.categoryId).toBeUndefined();
  });
});

describe("initialGoalForm", () => {
  it("starts empty with the current month, or mirrors an existing goal as decimals", () => {
    expect(initialGoalForm(null, "2026-10")).toMatchObject({ name: "", categoryId: "", target: "", startMonth: "2026-10", status: "active" });
    const goal = {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Emergency Fund",
      targetCents: "1000000",
      targetDate: "2027-09-30",
      linkedAccountId: ACCOUNT,
      linkedAccountName: "Savings",
      monthlyContributionCents: "50000",
      startMonth: "2026-09",
      startingCents: "200000",
      status: "active",
      progress: { savedCents: "280000", remainingToTargetCents: "720000", progressBp: 2800, monthsLeft: 12, neededPerMonthCents: "60000", projectedCompletionMonth: "2028-01", onTrack: false },
      categoryId: CATEGORY,
      categoryName: "Emergency Fund",
      history: [],
      createdAt: "2026-09-01T00:00:00Z",
    } satisfies GoalView;
    expect(initialGoalForm(goal, "2026-10")).toEqual({
      name: "Emergency Fund",
      categoryId: CATEGORY,
      newCategoryName: "",
      target: "10000.00",
      targetDate: "2027-09-30",
      linkedAccountId: ACCOUNT,
      contribution: "500.00",
      startMonth: "2026-09",
      starting: "2000.00",
      status: "active",
    });
  });
});

describe("percentFromBp", () => {
  it("keeps one decimal without floating point", () => {
    expect(percentFromBp(2800)).toBe("28.0%");
    expect(percentFromBp(2855)).toBe("28.5%");
    expect(percentFromBp(10000)).toBe("100.0%");
    expect(percentFromBp(0)).toBe("0.0%");
    expect(percentFromBp(9)).toBe("0.0%");
  });
});
