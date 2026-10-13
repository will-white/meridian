import { asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { category, payee, transaction } from "@meridian/db";
import { CategoryView, CreateCategoryBody, PayeeView, UpdateCategoryBody, UpdatePayeeBody, UuidParams } from "@meridian/shared";
import { badRequest, notFound } from "../lib/errors.js";
import { toCategoryView } from "../views.js";

export async function categoryRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  const payeeSelect = {
    id: payee.id,
    name: payee.name,
    aliases: payee.aliases,
    defaultCategoryId: payee.defaultCategoryId,
    // Raw identifiers on purpose: drizzle unqualifies interpolated columns in single-table queries.
    transactionCount: sql<number>`(select count(*)::int from "transaction" t where t.payee_id = "payee"."id")`,
  };

  r.get("/categories", { schema: { response: { 200: z.array(CategoryView) } } }, async () =>
    (await app.db.select().from(category).orderBy(asc(category.bucket), asc(category.name))).map(toCategoryView),
  );

  r.post("/categories", { schema: { body: CreateCategoryBody, response: { 200: CategoryView } } }, async (request) => {
    const [row] = await app.db
      .insert(category)
      .values({ name: request.body.name.trim(), bucket: request.body.bucket })
      .onConflictDoUpdate({ target: category.name, set: { hidden: false } })
      .returning();
    return toCategoryView(row!);
  });

  r.patch("/categories/:id", { schema: { params: UuidParams, body: UpdateCategoryBody, response: { 200: CategoryView } } }, async (request) => {
    const patch: Partial<typeof category.$inferInsert> = {};
    if (request.body.name !== undefined) patch.name = request.body.name.trim();
    if (request.body.bucket !== undefined) patch.bucket = request.body.bucket;
    if (request.body.hidden !== undefined) patch.hidden = request.body.hidden;
    if (Object.keys(patch).length === 0) throw badRequest("Nothing to change");
    const [row] = await app.db.update(category).set(patch).where(eq(category.id, request.params.id)).returning();
    if (!row) throw notFound("Category not found");
    return toCategoryView(row);
  });

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
        await tx.update(transaction).set({ payeeId: target.id }).where(eq(transaction.payeeId, source.id));
        patch.aliases = [...new Set([...target.aliases, source.name, ...source.aliases])];
        await tx.delete(payee).where(eq(payee.id, source.id));
      }
      if (Object.keys(patch).length > 0) await tx.update(payee).set(patch).where(eq(payee.id, target.id));
    });
    const [row] = await app.db.select(payeeSelect).from(payee).where(eq(payee.id, target.id));
    return row!;
  });
}
