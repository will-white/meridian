import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createGoal, deleteGoal, getGoal, listGoals, updateGoal, type CreateGoalInput, type UpdateGoalInput } from "@meridian/db";
import { CreateGoalBody, GoalView, OkResponse, TodayQuery, UpdateGoalBody, UuidParams } from "@meridian/shared";
import { notFound } from "../lib/errors.js";
import { toGoalView } from "../views/plan.js";
import { auditContext, resolveToday, usePlanErrors } from "./plan.js";

type CreateBody = z.infer<typeof CreateGoalBody>;
type UpdateBody = z.infer<typeof UpdateGoalBody>;

function toCreateInput(b: CreateBody): CreateGoalInput {
  return {
    name: b.name,
    targetCents: BigInt(b.targetCents),
    ...(b.categoryId !== undefined ? { categoryId: b.categoryId } : {}),
    ...(b.newCategory !== undefined ? { newCategory: { name: b.newCategory.name, ...(b.newCategory.groupId !== undefined ? { groupId: b.newCategory.groupId } : {}) } } : {}),
    ...(b.targetDate !== undefined ? { targetDate: b.targetDate } : {}),
    ...(b.linkedAccountId !== undefined ? { linkedAccountId: b.linkedAccountId } : {}),
    ...(b.monthlyContributionCents !== undefined ? { monthlyContributionCents: BigInt(b.monthlyContributionCents) } : {}),
    ...(b.startMonth !== undefined ? { startMonth: b.startMonth } : {}),
    ...(b.startingCents !== undefined ? { startingCents: BigInt(b.startingCents) } : {}),
  };
}

function toUpdateInput(b: UpdateBody): UpdateGoalInput {
  return {
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.categoryId !== undefined ? { categoryId: b.categoryId } : {}),
    ...(b.targetCents !== undefined ? { targetCents: BigInt(b.targetCents) } : {}),
    ...(b.targetDate !== undefined ? { targetDate: b.targetDate } : {}),
    ...(b.linkedAccountId !== undefined ? { linkedAccountId: b.linkedAccountId } : {}),
    ...(b.monthlyContributionCents !== undefined ? { monthlyContributionCents: BigInt(b.monthlyContributionCents) } : {}),
    ...(b.startMonth !== undefined ? { startMonth: b.startMonth } : {}),
    ...(b.startingCents !== undefined ? { startingCents: BigInt(b.startingCents) } : {}),
    ...(b.status !== undefined ? { status: b.status } : {}),
  };
}

/** Savings goals: one per savings-bucket category; progress is the goal category's grid history. */
export async function goalRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  usePlanErrors(app);

  r.get("/goals", { schema: { querystring: TodayQuery, response: { 200: z.array(GoalView) } } }, async (request) => {
    const today = await resolveToday(app, request.query.today);
    return (await listGoals(app.db, { today })).map(toGoalView);
  });

  r.get("/goals/:id", { schema: { params: UuidParams, querystring: TodayQuery, response: { 200: GoalView } } }, async (request) => {
    const today = await resolveToday(app, request.query.today);
    const goal = await getGoal(app.db, request.params.id, { today });
    if (!goal) throw notFound("Goal not found");
    return toGoalView(goal);
  });

  r.post("/goals", { schema: { body: CreateGoalBody, response: { 200: GoalView } } }, async (request) => {
    const today = await resolveToday(app, undefined);
    return toGoalView(await createGoal(app.db, toCreateInput(request.body), { ...auditContext(request), today }));
  });

  r.patch("/goals/:id", { schema: { params: UuidParams, body: UpdateGoalBody, response: { 200: GoalView } } }, async (request) => {
    const today = await resolveToday(app, undefined);
    return toGoalView(await updateGoal(app.db, request.params.id, toUpdateInput(request.body), { ...auditContext(request), today }));
  });

  /** The category stays; its planned cells revert to stored rows or 0. */
  r.delete("/goals/:id", { schema: { params: UuidParams, response: { 200: OkResponse } } }, async (request) => {
    await deleteGoal(app.db, request.params.id, auditContext(request));
    return { ok: true as const };
  });
}
