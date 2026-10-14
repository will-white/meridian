import { eq } from "drizzle-orm";
import { computePlan, goalProgress, isMonthKey, monthKey, monthRange, type GoalProgress, type IsoDate, type MonthKey, type PlanCategoryRowResult } from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { account, category, savingsGoal } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { insertCategory } from "./categories.js";
import { loadPlanInput } from "./plan.js";

/**
 * Savings goals: one per savings-bucket category. Progress and history come from
 * the plan engine over [start_month, current month], so the numbers on the Goals
 * page are exactly the goal category's grid cells.
 */

export interface GoalHistoryMonth {
  month: MonthKey;
  /** Bucket-natural actual: categorized rows plus net transfer legs in the linked account. */
  actualCents: bigint;
  plannedCents: bigint;
}

/** Bigint twin of GoalView. */
export interface GoalRecord {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
  targetCents: bigint;
  targetDate: IsoDate | null;
  linkedAccountId: string | null;
  linkedAccountName: string | null;
  monthlyContributionCents: bigint;
  startMonth: MonthKey;
  startingCents: bigint;
  status: "active" | "completed" | "archived";
  progress: GoalProgress;
  history: GoalHistoryMonth[];
  createdAt: Date;
}

type StoredGoal = typeof savingsGoal.$inferSelect;

export function goalAuditJson(row: StoredGoal) {
  return {
    id: row.id,
    name: row.name,
    categoryId: row.categoryId,
    targetCents: row.targetCents.toString(),
    targetDate: row.targetDate,
    linkedAccountId: row.linkedAccountId,
    monthlyContributionCents: row.monthlyContributionCents.toString(),
    startMonth: row.startMonth,
    startingCents: row.startingCents.toString(),
    status: row.status,
  };
}

async function loadStored(db: DbOrTx, id?: string) {
  const q = db
    .select({ goal: savingsGoal, categoryName: category.name, linkedAccountName: account.name })
    .from(savingsGoal)
    .innerJoin(category, eq(category.id, savingsGoal.categoryId))
    .leftJoin(account, eq(account.id, savingsGoal.linkedAccountId));
  return id ? q.where(eq(savingsGoal.id, id)) : q;
}

async function buildRecords(db: DbOrTx, rows: Awaited<ReturnType<typeof loadStored>>, today: IsoDate): Promise<GoalRecord[]> {
  if (rows.length === 0) return [];
  const currentMonth = monthKey(today);
  let from = currentMonth;
  for (const r of rows) if (r.goal.startMonth < from) from = r.goal.startMonth;
  // The engine directly (not getPlan): an old goal's history may span more than the grid's 24 months.
  const plan = computePlan(await loadPlanInput(db, { from, to: currentMonth, today }));
  const rowByCategory = new Map<string, PlanCategoryRowResult>();
  for (const r of plan.rows) if (r.kind === "category") rowByCategory.set(r.categoryId, r);

  return rows
    .map(({ goal, categoryName, linkedAccountName }) => {
      const row = rowByCategory.get(goal.categoryId);
      const history: GoalHistoryMonth[] = [];
      const actualByMonth = new Map<MonthKey, bigint>();
      if (goal.startMonth <= currentMonth) {
        for (const m of monthRange(goal.startMonth, currentMonth)) {
          const cell = row?.cells[plan.months.indexOf(m)];
          const actualCents = cell?.actualCents ?? 0n;
          actualByMonth.set(m, actualCents);
          history.push({ month: m, actualCents, plannedCents: cell?.plannedCents ?? 0n });
        }
      }
      const progress =
        row?.goal?.id === goal.id
          ? row.goal.progress
          : goalProgress({ ...goal, linkedAccountName, status: goal.status }, actualByMonth, currentMonth);
      return {
        id: goal.id,
        name: goal.name,
        categoryId: goal.categoryId,
        categoryName,
        targetCents: goal.targetCents,
        targetDate: goal.targetDate,
        linkedAccountId: goal.linkedAccountId,
        linkedAccountName,
        monthlyContributionCents: goal.monthlyContributionCents,
        startMonth: goal.startMonth,
        startingCents: goal.startingCents,
        status: goal.status,
        progress,
        history,
        createdAt: goal.createdAt,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

export async function listGoals(db: DbOrTx, q: { today: IsoDate }): Promise<GoalRecord[]> {
  return buildRecords(db, await loadStored(db), q.today);
}

export async function getGoal(db: DbOrTx, id: string, q: { today: IsoDate }): Promise<GoalRecord | undefined> {
  const [record] = await buildRecords(db, await loadStored(db, id), q.today);
  return record;
}

export interface CreateGoalInput {
  name: string;
  /** An existing savings-bucket category without a goal... */
  categoryId?: string;
  /** ...or a new savings category by name. */
  newCategory?: { name: string; groupId?: string };
  targetCents: bigint;
  targetDate?: IsoDate | null;
  linkedAccountId?: string | null;
  monthlyContributionCents?: bigint;
  /** Progress and auto-planning begin here; default: the month of `today`. */
  startMonth?: MonthKey;
  startingCents?: bigint;
}

async function assertGoalCategory(tx: DbOrTx, categoryId: string, exceptGoalId?: string): Promise<void> {
  const [cat] = await tx.select({ id: category.id, bucket: category.bucket }).from(category).where(eq(category.id, categoryId));
  if (!cat) throw new PlanError(404, "not_found", "Category not found");
  if (cat.bucket !== "savings") throw new PlanError(400, "goal_category", "Goals need a savings category");
  const [taken] = await tx.select({ id: savingsGoal.id }).from(savingsGoal).where(eq(savingsGoal.categoryId, categoryId));
  if (taken && taken.id !== exceptGoalId) throw new PlanError(409, "conflict", "That category already has a goal");
}

async function assertAccount(tx: DbOrTx, accountId: string): Promise<void> {
  const [row] = await tx.select({ id: account.id }).from(account).where(eq(account.id, accountId));
  if (!row) throw new PlanError(400, "validation", "Linked account not found");
}

function validateAmounts(input: { targetCents?: bigint; monthlyContributionCents?: bigint; startingCents?: bigint; startMonth?: MonthKey; targetDate?: IsoDate | null }): void {
  if (input.targetCents !== undefined && input.targetCents <= 0n) throw new PlanError(400, "validation", "targetCents must be positive");
  if (input.monthlyContributionCents !== undefined && input.monthlyContributionCents < 0n) throw new PlanError(400, "validation", "monthlyContributionCents must not be negative");
  if (input.startingCents !== undefined && input.startingCents < 0n) throw new PlanError(400, "validation", "startingCents must not be negative");
  if (input.startMonth !== undefined && !isMonthKey(input.startMonth)) throw new PlanError(400, "validation", "startMonth must be YYYY-MM");
}

/** Create a goal on a savings category (400 `goal_category` otherwise; 409 when the category already has one). Audited. */
export async function createGoal(db: Db, input: CreateGoalInput, ctx: AuditContext & { today: IsoDate }): Promise<GoalRecord> {
  const name = input.name.trim();
  if (!name) throw new PlanError(400, "validation", "Name is required");
  if ((input.categoryId === undefined) === (input.newCategory === undefined)) throw new PlanError(400, "validation", "Give categoryId or newCategory, not both");
  validateAmounts(input);

  const id = await db.transaction(async (tx) => {
    let categoryId = input.categoryId;
    if (input.newCategory) {
      categoryId = await insertCategory(tx, { name: input.newCategory.name, bucket: "savings", groupId: input.newCategory.groupId ?? null }, ctx);
    }
    await assertGoalCategory(tx, categoryId!);
    if (input.linkedAccountId) await assertAccount(tx, input.linkedAccountId);
    const [row] = await tx
      .insert(savingsGoal)
      .values({
        name,
        categoryId: categoryId!,
        targetCents: input.targetCents,
        targetDate: input.targetDate ?? null,
        linkedAccountId: input.linkedAccountId ?? null,
        monthlyContributionCents: input.monthlyContributionCents ?? 0n,
        startMonth: input.startMonth ?? monthKey(ctx.today),
        startingCents: input.startingCents ?? 0n,
      })
      .returning();
    await writeAudit(tx, { ...ctx, entity: "savings_goal", entityId: row!.id, action: "create", before: null, after: goalAuditJson(row!) });
    return row!.id;
  });
  return (await getGoal(db, id, { today: ctx.today }))!;
}

export interface UpdateGoalInput {
  name?: string;
  /** Move to another savings category without a goal. */
  categoryId?: string;
  targetCents?: bigint;
  targetDate?: IsoDate | null;
  linkedAccountId?: string | null;
  monthlyContributionCents?: bigint;
  startMonth?: MonthKey;
  startingCents?: bigint;
  status?: "active" | "completed" | "archived";
}

export async function updateGoal(db: Db, id: string, patch: UpdateGoalInput, ctx: AuditContext & { today: IsoDate }): Promise<GoalRecord> {
  validateAmounts(patch);
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(savingsGoal).where(eq(savingsGoal.id, id));
    if (!existing) throw new PlanError(404, "not_found", "Goal not found");
    const set: Partial<typeof savingsGoal.$inferInsert> = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new PlanError(400, "validation", "Name is required");
      set.name = name;
    }
    if (patch.categoryId !== undefined && patch.categoryId !== existing.categoryId) {
      await assertGoalCategory(tx, patch.categoryId, id);
      set.categoryId = patch.categoryId;
    }
    if (patch.targetCents !== undefined) set.targetCents = patch.targetCents;
    if (patch.targetDate !== undefined) set.targetDate = patch.targetDate;
    if (patch.linkedAccountId !== undefined) {
      if (patch.linkedAccountId) await assertAccount(tx, patch.linkedAccountId);
      set.linkedAccountId = patch.linkedAccountId;
    }
    if (patch.monthlyContributionCents !== undefined) set.monthlyContributionCents = patch.monthlyContributionCents;
    if (patch.startMonth !== undefined) set.startMonth = patch.startMonth;
    if (patch.startingCents !== undefined) set.startingCents = patch.startingCents;
    if (patch.status !== undefined) set.status = patch.status;
    if (Object.keys(set).length === 0) return;
    const [after] = await tx
      .update(savingsGoal)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(savingsGoal.id, id))
      .returning();
    await writeAudit(tx, { ...ctx, entity: "savings_goal", entityId: id, action: "update", before: goalAuditJson(existing), after: goalAuditJson(after!) });
  });
  return (await getGoal(db, id, { today: ctx.today }))!;
}

/** Delete a goal. The category stays; its planned cells revert to stored rows or 0. */
export async function deleteGoal(db: Db, id: string, ctx: AuditContext): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(savingsGoal).where(eq(savingsGoal.id, id));
    if (!existing) throw new PlanError(404, "not_found", "Goal not found");
    await tx.delete(savingsGoal).where(eq(savingsGoal.id, id));
    await writeAudit(tx, { ...ctx, entity: "savings_goal", entityId: id, action: "delete", before: goalAuditJson(existing), after: null });
  });
}
