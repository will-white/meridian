import { formatCents } from "@meridian/shared";
import type { GoalStatus, GoalView } from "@meridian/shared";
import { parseAmountInput } from "./plan.js";

/** Wire shape of POST/PATCH /goals (the CreateGoalBody / UpdateGoalBody fields the form uses). */
export interface GoalBody {
  name: string;
  categoryId?: string;
  newCategory?: { name: string };
  targetCents: string;
  targetDate: string | null;
  linkedAccountId: string | null;
  monthlyContributionCents: string;
  startMonth: string;
  startingCents: string;
  status?: GoalStatus;
}

/** Raw text of the goal form; money as typed, parsed once on submit. */
export interface GoalFormState {
  name: string;
  /** A category id, "" (none yet) or NEW_CATEGORY. */
  categoryId: string;
  newCategoryName: string;
  target: string;
  targetDate: string;
  linkedAccountId: string;
  contribution: string;
  startMonth: string;
  starting: string;
  status: GoalStatus;
}

export const NEW_CATEGORY = "__new__";

export function initialGoalForm(goal: GoalView | null, currentMonth: string): GoalFormState {
  return {
    name: goal?.name ?? "",
    categoryId: goal?.categoryId ?? "",
    newCategoryName: "",
    target: goal ? formatCents(BigInt(goal.targetCents)) : "",
    targetDate: goal?.targetDate ?? "",
    linkedAccountId: goal?.linkedAccountId ?? "",
    contribution: goal ? formatCents(BigInt(goal.monthlyContributionCents)) : "",
    startMonth: goal?.startMonth ?? currentMonth,
    starting: goal ? formatCents(BigInt(goal.startingCents)) : "",
    status: goal?.status ?? "active",
  };
}

export type GoalBodyResult = { ok: true; body: GoalBody } | { ok: false; error: string };

/** Turn the form into a request body, or explain what is wrong. `editing` = PATCH (status allowed, no new category). */
export function buildGoalBody(f: GoalFormState, editing: boolean): GoalBodyResult {
  const name = f.name.trim();
  if (!name) return { ok: false, error: "Give the goal a name" };
  const target = parseAmountInput(f.target);
  if (!target.ok) return { ok: false, error: `Target: ${target.error}` };
  if (target.cents === null || target.cents <= 0n) return { ok: false, error: "Target must be more than $0" };
  const contribution = parseAmountInput(f.contribution);
  if (!contribution.ok) return { ok: false, error: `Monthly contribution: ${contribution.error}` };
  const starting = parseAmountInput(f.starting);
  if (!starting.ok) return { ok: false, error: `Already saved: ${starting.error}` };
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(f.startMonth)) return { ok: false, error: "Pick a start month" };
  const body: GoalBody = {
    name,
    targetCents: target.cents.toString(),
    targetDate: f.targetDate || null,
    linkedAccountId: f.linkedAccountId || null,
    monthlyContributionCents: (contribution.cents ?? 0n).toString(),
    startMonth: f.startMonth,
    startingCents: (starting.cents ?? 0n).toString(),
  };
  if (f.categoryId === NEW_CATEGORY) {
    if (editing) return { ok: false, error: "Pick an existing savings category" };
    body.newCategory = { name: f.newCategoryName.trim() || name };
  } else if (f.categoryId) body.categoryId = f.categoryId;
  else if (!editing) return { ok: false, error: "Pick a savings category or create one" };
  if (editing) body.status = f.status;
  return { ok: true, body };
}

/** "28.5%" from basis points, integer arithmetic only. */
export function percentFromBp(bp: number): string {
  const whole = Math.floor(bp / 100);
  const tenth = Math.floor((bp % 100) / 10);
  return `${whole}.${tenth}%`;
}
