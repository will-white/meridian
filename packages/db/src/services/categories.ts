import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { BUCKET_ORDER, isMonthKey, monthKey, type Bucket, type IsoDate, type MonthKey, type RolloverMode } from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { category, categoryGroup, recurring, savingsGoal, split, transaction } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { getHouseholdSetting } from "./settings.js";

export const DEFAULT_CATEGORIES: Array<{ name: string; bucket: "income" | "bills" | "savings" | "spending" }> = [
  { name: "Paycheck", bucket: "income" },
  { name: "Interest & Dividends", bucket: "income" },
  { name: "Other Income", bucket: "income" },
  { name: "Rent / Mortgage", bucket: "bills" },
  { name: "Utilities", bucket: "bills" },
  { name: "Phone & Internet", bucket: "bills" },
  { name: "Insurance", bucket: "bills" },
  { name: "Subscriptions", bucket: "bills" },
  { name: "Loan Payment", bucket: "bills" },
  { name: "Savings", bucket: "savings" },
  { name: "Retirement Contribution", bucket: "savings" },
  { name: "Groceries", bucket: "spending" },
  { name: "Dining", bucket: "spending" },
  { name: "Fuel", bucket: "spending" },
  { name: "Transportation", bucket: "spending" },
  { name: "Shopping", bucket: "spending" },
  { name: "Entertainment", bucket: "spending" },
  { name: "Health", bucket: "spending" },
  { name: "Personal Care", bucket: "spending" },
  { name: "Home", bucket: "spending" },
  { name: "Gifts", bucket: "spending" },
  { name: "Travel", bucket: "spending" },
  { name: "Pets", bucket: "spending" },
  { name: "Fees & Charges", bucket: "spending" },
];

/** Insert the default categories when the table is empty (first run). */
export async function seedDefaultCategories(tx: DbOrTx): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(category);
  if ((row?.n ?? 0) > 0) return 0;
  await tx.insert(category).values(DEFAULT_CATEGORIES).onConflictDoNothing();
  return DEFAULT_CATEGORIES.length;
}

// ---- Phase 2: groups, positions, rollover ----

/** The extended category shape (bigint twin of CategoryDetailView). */
export interface CategoryRow {
  id: string;
  name: string;
  bucket: Bucket;
  hidden: boolean;
  groupId: string | null;
  position: number;
  rolloverMode: RolloverMode;
  rolloverFromMonth: MonthKey | null;
  goalId: string | null;
}

type StoredCategory = typeof category.$inferSelect;

/** Audit shape of a category (the stored columns; goalId is derived and left out). */
export function categoryAuditJson(row: Pick<StoredCategory, "id" | "name" | "bucket" | "hidden" | "groupId" | "position" | "rolloverMode" | "rolloverFromMonth">) {
  return {
    id: row.id,
    name: row.name,
    bucket: row.bucket,
    hidden: row.hidden,
    groupId: row.groupId,
    position: row.position,
    rolloverMode: row.rolloverMode,
    rolloverFromMonth: row.rolloverFromMonth,
  };
}

const bucketRank = (b: Bucket): number => BUCKET_ORDER.indexOf(b);

function compareRows(a: CategoryRow & { groupPosition: number | null; groupName: string | null }, b: typeof a): number {
  if (a.bucket !== b.bucket) return bucketRank(a.bucket) - bucketRank(b.bucket);
  // Grouped rows first (by group position, name), then ungrouped rows.
  const ag = a.groupId === null ? 1 : 0;
  const bg = b.groupId === null ? 1 : 0;
  if (ag !== bg) return ag - bg;
  if (ag === 0) {
    if ((a.groupPosition ?? 0) !== (b.groupPosition ?? 0)) return (a.groupPosition ?? 0) - (b.groupPosition ?? 0);
    if ((a.groupName ?? "") !== (b.groupName ?? "")) return (a.groupName ?? "") < (b.groupName ?? "") ? -1 : 1;
  }
  if (a.position !== b.position) return a.position - b.position;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Every category (hidden included) in display order: bucket → groups by (position, name) → ungrouped; then (position, name). */
export async function listCategories(db: DbOrTx): Promise<CategoryRow[]> {
  const rows = await db
    .select({
      id: category.id,
      name: category.name,
      bucket: category.bucket,
      hidden: category.hidden,
      groupId: category.groupId,
      position: category.position,
      rolloverMode: category.rolloverMode,
      rolloverFromMonth: category.rolloverFromMonth,
      goalId: savingsGoal.id,
      groupPosition: categoryGroup.position,
      groupName: categoryGroup.name,
    })
    .from(category)
    .leftJoin(savingsGoal, eq(savingsGoal.categoryId, category.id))
    .leftJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
    .orderBy(asc(category.name));
  return rows.sort(compareRows).map(({ groupPosition: _gp, groupName: _gn, ...r }) => r);
}

export async function getCategory(db: DbOrTx, id: string): Promise<CategoryRow | undefined> {
  const [row] = await db
    .select({
      id: category.id,
      name: category.name,
      bucket: category.bucket,
      hidden: category.hidden,
      groupId: category.groupId,
      position: category.position,
      rolloverMode: category.rolloverMode,
      rolloverFromMonth: category.rolloverFromMonth,
      goalId: savingsGoal.id,
    })
    .from(category)
    .leftJoin(savingsGoal, eq(savingsGoal.categoryId, category.id))
    .where(eq(category.id, id));
  return row;
}

async function requireGroup(tx: DbOrTx, groupId: string): Promise<typeof categoryGroup.$inferSelect> {
  const [group] = await tx.select().from(categoryGroup).where(eq(categoryGroup.id, groupId));
  if (!group) throw new PlanError(404, "not_found", "Category group not found");
  return group;
}

async function nextPosition(tx: DbOrTx, bucket: Bucket, groupId: string | null): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number>`coalesce(max(${category.position}), 0)::int` })
    .from(category)
    .where(and(eq(category.bucket, bucket), groupId === null ? isNull(category.groupId) : eq(category.groupId, groupId)));
  return (row?.max ?? 0) + 1;
}

export interface CreateCategoryInput {
  name: string;
  bucket: Bucket;
  /** Must belong to `bucket` (400 `bucket_mismatch`). */
  groupId?: string | null;
}

/**
 * Insert a category inside the caller's transaction and return its id (the
 * goals service creates a category and its goal atomically). A hidden category
 * with the same name is un-hidden and returned instead (the Phase 1 behaviour);
 * a visible one is a 409.
 */
export async function insertCategory(tx: DbOrTx, input: CreateCategoryInput, ctx: AuditContext): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new PlanError(400, "validation", "Name is required");
  const groupId = input.groupId ?? null;
  if (groupId !== null) {
    const group = await requireGroup(tx, groupId);
    if (group.bucket !== input.bucket) throw new PlanError(400, "bucket_mismatch", "Category bucket does not match group");
  }
  const [existing] = await tx.select().from(category).where(eq(category.name, name));
  if (existing) {
    if (!existing.hidden) throw new PlanError(409, "conflict", "A category with this name already exists");
    const [after] = await tx.update(category).set({ hidden: false }).where(eq(category.id, existing.id)).returning();
    await writeAudit(tx, { ...ctx, entity: "category", entityId: existing.id, action: "update", before: categoryAuditJson(existing), after: categoryAuditJson(after!) });
    return existing.id;
  }
  const position = await nextPosition(tx, input.bucket, groupId);
  const [row] = await tx.insert(category).values({ name, bucket: input.bucket, groupId, position }).returning();
  await writeAudit(tx, { ...ctx, entity: "category", entityId: row!.id, action: "create", before: null, after: categoryAuditJson(row!) });
  return row!.id;
}

/** Create a category at the end of its group (or of the bucket's ungrouped rows). Audited. */
export async function createCategory(db: Db, input: CreateCategoryInput, ctx: AuditContext): Promise<CategoryRow> {
  const id = await db.transaction((tx) => insertCategory(tx, input, ctx));
  return (await getCategory(db, id))!;
}

export interface UpdateCategoryInput {
  name?: string;
  bucket?: Bucket;
  hidden?: boolean;
  /** null = ungrouped. Must belong to the (new) bucket. */
  groupId?: string | null;
  rolloverMode?: RolloverMode;
  /** The chain start; defaults to the current month when a carrying mode is first enabled. */
  rolloverFromMonth?: MonthKey | null;
}

/**
 * Patch a category. Rules (docs/phase-2-plan.md §1, §9): a goal's category must
 * stay in savings (400 `goal_category`); a bucket change clears a group of another
 * bucket and forces rollover off for income; income never rolls over (400
 * `income_no_rollover`); enabling a carrying mode without a start month uses the
 * month of `today`; mode none clears the start month.
 */
export async function updateCategory(db: Db, id: string, patch: UpdateCategoryInput, ctx: AuditContext & { today: IsoDate }): Promise<CategoryRow> {
  if (patch.rolloverFromMonth !== undefined && patch.rolloverFromMonth !== null && !isMonthKey(patch.rolloverFromMonth)) {
    throw new PlanError(400, "validation", "rolloverFromMonth must be YYYY-MM");
  }
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(category).where(eq(category.id, id));
    if (!existing) throw new PlanError(404, "not_found", "Category not found");
    const [goal] = await tx.select({ id: savingsGoal.id }).from(savingsGoal).where(eq(savingsGoal.categoryId, id));

    const set: Partial<typeof category.$inferInsert> = {};
    const bucket = patch.bucket ?? existing.bucket;
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new PlanError(400, "validation", "Name is required");
      set.name = name;
    }
    if (patch.hidden !== undefined) set.hidden = patch.hidden;

    if (patch.bucket !== undefined && patch.bucket !== existing.bucket) {
      if (goal && patch.bucket !== "savings") throw new PlanError(400, "goal_category", "A goal's category must stay in the savings bucket");
      set.bucket = patch.bucket;
    }

    let groupId = existing.groupId;
    if (patch.groupId !== undefined) {
      groupId = patch.groupId;
    } else if (groupId !== null && set.bucket !== undefined) {
      // Bucket moved: drop a group of the old bucket.
      const [group] = await tx.select().from(categoryGroup).where(eq(categoryGroup.id, groupId));
      if (!group || group.bucket !== bucket) groupId = null;
    }
    if (groupId !== null && (patch.groupId !== undefined || set.bucket !== undefined)) {
      const group = await requireGroup(tx, groupId);
      if (group.bucket !== bucket) throw new PlanError(400, "bucket_mismatch", "Category bucket does not match group");
    }
    if (groupId !== existing.groupId || set.bucket !== undefined) {
      set.groupId = groupId;
      set.position = await nextPosition(tx, bucket, groupId);
    }

    // Rollover.
    let rolloverMode = patch.rolloverMode ?? existing.rolloverMode;
    let rolloverFromMonth = patch.rolloverFromMonth !== undefined ? patch.rolloverFromMonth : existing.rolloverFromMonth;
    if (bucket === "income") {
      if (patch.rolloverMode !== undefined && patch.rolloverMode !== "none") throw new PlanError(400, "income_no_rollover", "Income categories cannot roll over");
      rolloverMode = "none";
      rolloverFromMonth = null;
    } else if (rolloverMode === "none") {
      rolloverFromMonth = null;
    } else if (rolloverFromMonth === null) {
      rolloverFromMonth = monthKey(ctx.today);
    }
    if (rolloverFromMonth !== null) {
      const setting = await getHouseholdSetting(tx, ctx.today);
      if (rolloverFromMonth < setting.planStartMonth) throw new PlanError(400, "before_plan_start", `rolloverFromMonth is before the plan start month ${setting.planStartMonth}`);
    }
    if (rolloverMode !== existing.rolloverMode) set.rolloverMode = rolloverMode;
    if (rolloverFromMonth !== existing.rolloverFromMonth) set.rolloverFromMonth = rolloverFromMonth;

    if (Object.keys(set).length === 0) return;
    const [after] = await tx.update(category).set(set).where(eq(category.id, id)).returning();
    await writeAudit(tx, { ...ctx, entity: "category", entityId: id, action: "update", before: categoryAuditJson(existing), after: categoryAuditJson(after!) });
  });
  return (await getCategory(db, id))!;
}

/** Delete an unused category (month_plan rows cascade). 409 `in_use` when any transaction, split, recurring item or goal references it. */
export async function deleteCategory(db: Db, id: string, ctx: AuditContext): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(category).where(eq(category.id, id));
    if (!existing) throw new PlanError(404, "not_found", "Category not found");
    const countWhere = async (table: typeof transaction | typeof split | typeof recurring | typeof savingsGoal) => {
      const [row] = await tx.select({ n: count() }).from(table).where(eq(table.categoryId, id));
      return row?.n ?? 0;
    };
    const refs = {
      transactions: await countWhere(transaction),
      splits: await countWhere(split),
      recurring: await countWhere(recurring),
      goals: await countWhere(savingsGoal),
    };
    const reasons: string[] = [];
    if (refs.transactions > 0) reasons.push(`${refs.transactions} transaction(s)`);
    if (refs.splits > 0) reasons.push(`${refs.splits} split(s)`);
    if (refs.recurring > 0) reasons.push(`${refs.recurring} recurring item(s)`);
    if (refs.goals > 0) reasons.push("a goal");
    if (reasons.length > 0) throw new PlanError(409, "in_use", `Category is in use by ${reasons.join(", ")}; hide it instead`);
    await tx.delete(category).where(eq(category.id, id));
    await writeAudit(tx, { ...ctx, entity: "category", entityId: id, action: "delete", before: categoryAuditJson(existing), after: null });
  });
}

export interface ReorderCategoriesInput {
  /** Target group, or null for the bucket's ungrouped rows. */
  groupId: string | null;
  ids: readonly string[];
}

/**
 * Move the listed categories into `groupId` (or ungrouped) with positions 1..n in
 * the given order; the group's other members keep their relative order after
 * them. Unknown ids are ignored; a category of another bucket is a 400.
 */
export async function reorderCategories(db: Db, input: ReorderCategoriesInput, ctx: AuditContext): Promise<CategoryRow[]> {
  await db.transaction(async (tx) => {
    const ids = [...new Set(input.ids)];
    const listed = ids.length === 0 ? [] : await tx.select().from(category).where(inArray(category.id, ids));
    const byId = new Map(listed.map((c) => [c.id, c]));
    const ordered = ids.map((id) => byId.get(id)).filter((c): c is StoredCategory => c !== undefined);
    if (ordered.length === 0) return;

    const group = input.groupId === null ? null : await requireGroup(tx, input.groupId);
    if (group) {
      for (const c of ordered) if (c.bucket !== group.bucket) throw new PlanError(400, "bucket_mismatch", "Category bucket does not match group");
    }

    // Ungrouped rows are positioned per bucket; a group has exactly one bucket.
    const buckets = group ? [group.bucket] : [...new Set(ordered.map((c) => c.bucket))];
    for (const bucket of buckets) {
      const head = ordered.filter((c) => c.bucket === bucket);
      const headIds = new Set(head.map((c) => c.id));
      const members = await tx
        .select()
        .from(category)
        .where(and(eq(category.bucket, bucket), group ? eq(category.groupId, group.id) : isNull(category.groupId)))
        .orderBy(asc(category.position), asc(category.name), asc(category.id));
      const tail = members.filter((c) => !headIds.has(c.id));
      let position = 0;
      for (const c of [...head, ...tail]) {
        position++;
        const groupId = group ? group.id : null;
        if (c.position === position && c.groupId === groupId) continue;
        const [after] = await tx.update(category).set({ position, groupId }).where(eq(category.id, c.id)).returning();
        await writeAudit(tx, { ...ctx, entity: "category", entityId: c.id, action: "update", before: categoryAuditJson(c), after: categoryAuditJson(after!) });
      }
    }
  });
  return listCategories(db);
}
