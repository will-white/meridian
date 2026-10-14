import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { BUCKET_ORDER, type Bucket } from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { category, categoryGroup } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";

/**
 * Category groups: named sections under a bucket header in the grid. A group's
 * bucket is immutable (move the categories instead); a category may only sit in
 * a group of its own bucket.
 */

export interface CategoryGroupRow {
  id: string;
  name: string;
  bucket: Bucket;
  position: number;
  hidden: boolean;
  categoryCount: number;
}

type StoredGroup = typeof categoryGroup.$inferSelect;

export function categoryGroupAuditJson(row: Pick<StoredGroup, "id" | "name" | "bucket" | "position" | "hidden">) {
  return { id: row.id, name: row.name, bucket: row.bucket, position: row.position, hidden: row.hidden };
}

const bucketRank = (b: Bucket): number => BUCKET_ORDER.indexOf(b);

async function selectGroups(db: DbOrTx, where?: ReturnType<typeof eq>): Promise<CategoryGroupRow[]> {
  const rows = await db
    .select({
      id: categoryGroup.id,
      name: categoryGroup.name,
      bucket: categoryGroup.bucket,
      position: categoryGroup.position,
      hidden: categoryGroup.hidden,
      // Raw identifiers on purpose: drizzle unqualifies interpolated columns in single-table queries.
      categoryCount: sql<number>`(select count(*)::int from "category" c where c.group_id = "category_group"."id")`,
    })
    .from(categoryGroup)
    .where(where)
    .orderBy(asc(categoryGroup.position), asc(categoryGroup.name), asc(categoryGroup.id));
  return rows.sort((a, b) => bucketRank(a.bucket) - bucketRank(b.bucket) || a.position - b.position || a.name.localeCompare(b.name));
}

/** All groups in display order: bucket, then (position, name). */
export async function listCategoryGroups(db: DbOrTx): Promise<CategoryGroupRow[]> {
  return selectGroups(db);
}

export async function getCategoryGroup(db: DbOrTx, id: string): Promise<CategoryGroupRow | undefined> {
  const [row] = await selectGroups(db, eq(categoryGroup.id, id));
  return row;
}

async function requireStored(tx: DbOrTx, id: string): Promise<StoredGroup> {
  const [row] = await tx.select().from(categoryGroup).where(eq(categoryGroup.id, id));
  if (!row) throw new PlanError(404, "not_found", "Category group not found");
  return row;
}

async function assertNameFree(tx: DbOrTx, bucket: Bucket, name: string, exceptId?: string): Promise<void> {
  const [dupe] = await tx
    .select({ id: categoryGroup.id })
    .from(categoryGroup)
    .where(and(eq(categoryGroup.bucket, bucket), eq(categoryGroup.name, name)));
  if (dupe && dupe.id !== exceptId) throw new PlanError(409, "conflict", "A group with this name already exists in that bucket");
}

/** Create a group at the end of its bucket (position = max + 1). 409 on a duplicate (bucket, name). */
export async function createCategoryGroup(db: Db, input: { name: string; bucket: Bucket }, ctx: AuditContext): Promise<CategoryGroupRow> {
  const name = input.name.trim();
  if (!name) throw new PlanError(400, "validation", "Name is required");
  const id = await db.transaction(async (tx) => {
    await assertNameFree(tx, input.bucket, name);
    const [max] = await tx
      .select({ max: sql<number>`coalesce(max(${categoryGroup.position}), 0)::int` })
      .from(categoryGroup)
      .where(eq(categoryGroup.bucket, input.bucket));
    const [row] = await tx
      .insert(categoryGroup)
      .values({ name, bucket: input.bucket, position: (max?.max ?? 0) + 1 })
      .returning();
    await writeAudit(tx, { ...ctx, entity: "category_group", entityId: row!.id, action: "create", before: null, after: categoryGroupAuditJson(row!) });
    return row!.id;
  });
  return (await getCategoryGroup(db, id))!;
}

/** Rename or hide a group. The bucket is immutable. */
export async function updateCategoryGroup(db: Db, id: string, patch: { name?: string; hidden?: boolean }, ctx: AuditContext): Promise<CategoryGroupRow> {
  await db.transaction(async (tx) => {
    const existing = await requireStored(tx, id);
    const set: Partial<typeof categoryGroup.$inferInsert> = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new PlanError(400, "validation", "Name is required");
      if (name !== existing.name) {
        await assertNameFree(tx, existing.bucket, name, id);
        set.name = name;
      }
    }
    if (patch.hidden !== undefined && patch.hidden !== existing.hidden) set.hidden = patch.hidden;
    if (Object.keys(set).length === 0) return;
    const [after] = await tx
      .update(categoryGroup)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(categoryGroup.id, id))
      .returning();
    await writeAudit(tx, { ...ctx, entity: "category_group", entityId: id, action: "update", before: categoryGroupAuditJson(existing), after: categoryGroupAuditJson(after!) });
  });
  return (await getCategoryGroup(db, id))!;
}

/** Delete a group; its categories become ungrouped at their existing positions. */
export async function deleteCategoryGroup(db: Db, id: string, ctx: AuditContext): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await requireStored(tx, id);
    // category.group_id carries no FK (Phase 1 table), so detach by hand.
    await tx.update(category).set({ groupId: null }).where(eq(category.groupId, id));
    await tx.delete(categoryGroup).where(eq(categoryGroup.id, id));
    await writeAudit(tx, { ...ctx, entity: "category_group", entityId: id, action: "delete", before: categoryGroupAuditJson(existing), after: null });
  });
}

/**
 * Positions 1..n for the listed groups of `bucket` in the given order; the
 * bucket's other groups keep their relative order after them. Unknown ids are
 * ignored; a group of another bucket is a 400.
 */
export async function reorderCategoryGroups(db: Db, input: { bucket: Bucket; ids: readonly string[] }, ctx: AuditContext): Promise<CategoryGroupRow[]> {
  await db.transaction(async (tx) => {
    const ids = [...new Set(input.ids)];
    const listed = ids.length === 0 ? [] : await tx.select().from(categoryGroup).where(inArray(categoryGroup.id, ids));
    const byId = new Map(listed.map((g) => [g.id, g]));
    const head = ids.map((id) => byId.get(id)).filter((g): g is StoredGroup => g !== undefined);
    for (const g of head) if (g.bucket !== input.bucket) throw new PlanError(400, "bucket_mismatch", "Group does not belong to that bucket");
    const headIds = new Set(head.map((g) => g.id));
    const members = await tx
      .select()
      .from(categoryGroup)
      .where(eq(categoryGroup.bucket, input.bucket))
      .orderBy(asc(categoryGroup.position), asc(categoryGroup.name), asc(categoryGroup.id));
    const tail = members.filter((g) => !headIds.has(g.id));
    let position = 0;
    for (const g of [...head, ...tail]) {
      position++;
      if (g.position === position) continue;
      const [after] = await tx.update(categoryGroup).set({ position, updatedAt: new Date() }).where(eq(categoryGroup.id, g.id)).returning();
      await writeAudit(tx, { ...ctx, entity: "category_group", entityId: g.id, action: "update", before: categoryGroupAuditJson(g), after: categoryGroupAuditJson(after!) });
    }
  });
  return listCategoryGroups(db);
}
