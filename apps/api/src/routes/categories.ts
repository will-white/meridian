import { asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  alert,
  category,
  containsPattern,
  createCategory,
  decodeCursor,
  encodeCursor,
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
  PayeeList,
  PayeeQuery,
  PayeeView,
  ReorderCategoriesBody,
  ReorderCategoryGroupsBody,
  UpdateCategoryBodyV2,
  UpdateCategoryGroupBody,
  UpdatePayeeBody,
  UuidParams,
} from "@meridian/shared";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
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

  /**
   * Audit a8-ledger-ui-03: one page of payees by name with the number that match, so every payee
   * can be reached (the list stopped at the first 500 by name, and so did the merge targets). `q`
   * matches the name or any other name the payee answers to (a merged or earlier name), escaped
   * like every search. The cursor is the offset of the next page (400 `invalid_cursor` for one the
   * server did not issue).
   */
  r.get("/payees", { schema: { querystring: PayeeQuery, response: { 200: PayeeList } } }, async (request) => {
    const { q, limit } = request.query;
    let offset = 0;
    if (request.query.cursor !== undefined) {
      const fields = decodeCursor(request.query.cursor, ["int"]);
      if (!fields || Number(fields[0]) < 0) throw new HttpError(400, "That page marker is not valid; reload the list", "invalid_cursor");
      offset = Number(fields[0]);
    }
    const pattern = q?.trim() ? containsPattern(q.trim()) : undefined;
    // Raw identifiers on purpose, as in payeeSelect.
    const where = pattern ? sql`("payee"."name" ilike ${pattern} or exists (select 1 from jsonb_array_elements_text("payee"."aliases") a where a ilike ${pattern}))` : undefined;
    const [count] = await app.db.select({ n: sql<number>`count(*)::int` }).from(payee).where(where);
    const items = await app.db.select(payeeSelect).from(payee).where(where).orderBy(asc(payee.name), asc(payee.id)).limit(limit).offset(offset);
    const total = count?.n ?? 0;
    return { items, total, nextCursor: offset + items.length < total && items.length > 0 ? encodeCursor([offset + items.length]) : null };
  });

  r.patch("/payees/:id", { schema: { params: UuidParams, body: UpdatePayeeBody, response: { 200: PayeeView } } }, async (request) => {
    const [target] = await app.db.select().from(payee).where(eq(payee.id, request.params.id));
    if (!target) throw notFound("Payee not found");
    // Audit a10-conformance-ledger-07: a default category that does not exist is the caller's 400, not the foreign key's 500.
    if (request.body.defaultCategoryId) {
      const [known] = await app.db.select({ id: category.id }).from(category).where(eq(category.id, request.body.defaultCategoryId));
      if (!known) throw badRequest("That category does not exist (it may have been deleted); choose another", "unknown_category");
    }
    await app.db.transaction(async (tx) => {
      const patch: Partial<typeof payee.$inferInsert> = {};
      let aliases = target.aliases;
      const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
      if (request.body.name !== undefined && request.body.name.trim() !== target.name) {
        const name = request.body.name.trim();
        // Audit a6-text-rules-accounts-10: a name another payee has (or has merged in) is that payee; say so instead of a 500.
        const [taken] = await tx
          .select({ id: payee.id, name: payee.name })
          .from(payee)
          .where(sql`${payee.id} <> ${target.id} and ${payee.id} <> ${request.body.mergeFromId ?? target.id} and (lower(${payee.name}) = lower(${name}) or exists (select 1 from jsonb_array_elements_text(${payee.aliases}) a where lower(a) = lower(${name})))`)
          .limit(1);
        if (taken) throw new HttpError(409, `"${taken.name}" already has that name; merge it into this payee instead`, "name_taken");
        patch.name = name;
        // The old name stays an alias, so the next import of it finds this payee and the rules written on it keep matching.
        aliases = [...new Set([...aliases.filter((a) => !sameName(a, name)), ...(sameName(target.name, name) ? [] : [target.name])])];
        patch.aliases = aliases;
      }
      if (request.body.defaultCategoryId !== undefined) patch.defaultCategoryId = request.body.defaultCategoryId;
      if (request.body.mergeFromId !== undefined && request.body.mergeFromId !== target.id) {
        const [source] = await tx.select().from(payee).where(eq(payee.id, request.body.mergeFromId));
        if (!source) throw notFound("Payee to merge not found");
        // Everything that points at the source payee follows it to the target (recurring and alert cascade on payee delete).
        await tx.update(transaction).set({ payeeId: target.id }).where(eq(transaction.payeeId, source.id));
        await tx.update(recurring).set({ payeeId: target.id }).where(eq(recurring.payeeId, source.id));
        await tx.update(alert).set({ payeeId: target.id }).where(eq(alert.payeeId, source.id));
        patch.aliases = [...new Set([...aliases, source.name, ...source.aliases])].filter((a) => !sameName(a, patch.name ?? target.name));
        await tx.delete(payee).where(eq(payee.id, source.id));
      }
      if (Object.keys(patch).length > 0) await tx.update(payee).set(patch).where(eq(payee.id, target.id));
    });
    const [row] = await app.db.select(payeeSelect).from(payee).where(eq(payee.id, target.id));
    return row!;
  });
}
