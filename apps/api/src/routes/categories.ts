import { asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  alert,
  createCategory,
  createCategoryGroup,
  deleteCategory,
  deleteCategoryGroup,
  listCategories,
  listCategoryGroups,
  payee,
  recurring,
  reorderCategories,
  reorderCategoryGroups,
  transaction,
  updateCategory,
  updateCategoryGroup,
  type UpdateCategoryInput,
} from "@meridian/db";
import {
  CategoryDetailView,
  CategoryGroupView,
  CreateCategoryBodyV2,
  CreateCategoryGroupBody,
  OkResponse,
  PayeeView,
  ReorderCategoriesBody,
  ReorderCategoryGroupsBody,
  UpdateCategoryBodyV2,
  UpdateCategoryGroupBody,
  UpdatePayeeBody,
  UuidParams,
} from "@meridian/shared";
import { badRequest, notFound } from "../lib/errors.js";
import { toCategoryDetailView, toCategoryGroupView } from "../views/plan.js";
import { auditContext, resolveToday, usePlanErrors } from "./plan.js";

/**
 * Categories (Phase 2 shape: group, position, rollover, goal), category groups
 * and payees. Category and group mutations go through the audited db services;
 * bucket/rollover/group rules live there (docs/phase-2-plan.md §1, §9).
 */
export async function categoryRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  usePlanErrors(app);

  // ---- Categories ----

  r.get("/categories", { schema: { response: { 200: z.array(CategoryDetailView) } } }, async () => (await listCategories(app.db)).map(toCategoryDetailView));

  r.post("/categories", { schema: { body: CreateCategoryBodyV2, response: { 200: CategoryDetailView } } }, async (request) => {
    const b = request.body;
    const row = await createCategory(app.db, { name: b.name, bucket: b.bucket, ...(b.groupId !== undefined ? { groupId: b.groupId } : {}) }, auditContext(request));
    return toCategoryDetailView(row);
  });

  r.patch("/categories/:id", { schema: { params: UuidParams, body: UpdateCategoryBodyV2, response: { 200: CategoryDetailView } } }, async (request) => {
    const b = request.body;
    const patch: UpdateCategoryInput = {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.bucket !== undefined ? { bucket: b.bucket } : {}),
      ...(b.hidden !== undefined ? { hidden: b.hidden } : {}),
      ...(b.groupId !== undefined ? { groupId: b.groupId } : {}),
      ...(b.rolloverMode !== undefined ? { rolloverMode: b.rolloverMode } : {}),
      ...(b.rolloverFromMonth !== undefined ? { rolloverFromMonth: b.rolloverFromMonth } : {}),
    };
    if (Object.keys(patch).length === 0) throw badRequest("Nothing to change");
    const today = await resolveToday(app, undefined);
    return toCategoryDetailView(await updateCategory(app.db, request.params.id, patch, { ...auditContext(request), today }));
  });

  /** 409 `in_use` when any transaction, split, recurring item or goal references it; month_plan rows cascade. */
  r.delete("/categories/:id", { schema: { params: UuidParams, response: { 200: OkResponse } } }, async (request) => {
    await deleteCategory(app.db, request.params.id, auditContext(request));
    return { ok: true as const };
  });

  /** Moves the listed categories into `groupId` (or ungrouped) at positions 1..n; the rest keep their relative order after. */
  r.post("/categories/reorder", { schema: { body: ReorderCategoriesBody, response: { 200: z.array(CategoryDetailView) } } }, async (request) => {
    const rows = await reorderCategories(app.db, { groupId: request.body.groupId, ids: request.body.ids }, auditContext(request));
    return rows.map(toCategoryDetailView);
  });

  // ---- Category groups ----

  r.get("/category-groups", { schema: { response: { 200: z.array(CategoryGroupView) } } }, async () => (await listCategoryGroups(app.db)).map(toCategoryGroupView));

  r.post("/category-groups", { schema: { body: CreateCategoryGroupBody, response: { 200: CategoryGroupView } } }, async (request) =>
    toCategoryGroupView(await createCategoryGroup(app.db, { name: request.body.name, bucket: request.body.bucket }, auditContext(request))),
  );

  /** The bucket is immutable: move the categories instead. */
  r.patch("/category-groups/:id", { schema: { params: UuidParams, body: UpdateCategoryGroupBody, response: { 200: CategoryGroupView } } }, async (request) => {
    const b = request.body;
    const patch = { ...(b.name !== undefined ? { name: b.name } : {}), ...(b.hidden !== undefined ? { hidden: b.hidden } : {}) };
    return toCategoryGroupView(await updateCategoryGroup(app.db, request.params.id, patch, auditContext(request)));
  });

  /** Its categories become ungrouped at their existing positions. */
  r.delete("/category-groups/:id", { schema: { params: UuidParams, response: { 200: OkResponse } } }, async (request) => {
    await deleteCategoryGroup(app.db, request.params.id, auditContext(request));
    return { ok: true as const };
  });

  r.post("/category-groups/reorder", { schema: { body: ReorderCategoryGroupsBody, response: { 200: z.array(CategoryGroupView) } } }, async (request) => {
    const rows = await reorderCategoryGroups(app.db, { bucket: request.body.bucket, ids: request.body.ids }, auditContext(request));
    return rows.map(toCategoryGroupView);
  });

  // ---- Payees ----

  const payeeSelect = {
    id: payee.id,
    name: payee.name,
    aliases: payee.aliases,
    defaultCategoryId: payee.defaultCategoryId,
    // Raw identifiers on purpose: drizzle unqualifies interpolated columns in single-table queries.
    transactionCount: sql<number>`(select count(*)::int from "transaction" t where t.payee_id = "payee"."id")`,
  };

  r.get("/payees", { schema: { querystring: z.object({ q: z.string().max(100).optional() }), response: { 200: z.array(PayeeView) } } }, async (request) =>
    app.db
      .select(payeeSelect)
      .from(payee)
      .where(request.query.q ? sql`${payee.name} ilike ${`%${request.query.q}%`}` : undefined)
      .orderBy(asc(payee.name))
      .limit(500),
  );

  r.patch("/payees/:id", { schema: { params: UuidParams, body: UpdatePayeeBody, response: { 200: PayeeView } } }, async (request) => {
    const [target] = await app.db.select().from(payee).where(eq(payee.id, request.params.id));
    if (!target) throw notFound("Payee not found");
    await app.db.transaction(async (tx) => {
      const patch: Partial<typeof payee.$inferInsert> = {};
      if (request.body.name !== undefined) patch.name = request.body.name.trim();
      if (request.body.defaultCategoryId !== undefined) patch.defaultCategoryId = request.body.defaultCategoryId;
      if (request.body.mergeFromId !== undefined && request.body.mergeFromId !== target.id) {
        const [source] = await tx.select().from(payee).where(eq(payee.id, request.body.mergeFromId));
        if (!source) throw notFound("Payee to merge not found");
        // Everything that points at the source payee follows it to the target (recurring and alert cascade on payee delete).
        await tx.update(transaction).set({ payeeId: target.id }).where(eq(transaction.payeeId, source.id));
        await tx.update(recurring).set({ payeeId: target.id }).where(eq(recurring.payeeId, source.id));
        await tx.update(alert).set({ payeeId: target.id }).where(eq(alert.payeeId, source.id));
        patch.aliases = [...new Set([...target.aliases, source.name, ...source.aliases])];
        await tx.delete(payee).where(eq(payee.id, source.id));
      }
      if (Object.keys(patch).length > 0) await tx.update(payee).set(patch).where(eq(payee.id, target.id));
    });
    const [row] = await app.db.select(payeeSelect).from(payee).where(eq(payee.id, target.id));
    return row!;
  });
}
