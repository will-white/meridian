import { asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { account, balanceSnapshot, connection } from "@meridian/db";
import { AccountView, CreateManualAccountBody, defaultTaxTreatment, toIsoDate, UpdateAccountBody, UuidParams } from "@meridian/shared";
import { notFound } from "../lib/errors.js";
import { toAccountView } from "../views.js";

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  async function list(id?: string) {
    const rows = await app.db
      .select({
        acct: account,
        connectionName: connection.name,
        transactionCount: sql<number>`(select count(*)::int from "transaction" t where t.account_id = "account"."id")`,
      })
      .from(account)
      .leftJoin(connection, eq(connection.id, account.connectionId))
      .where(id ? eq(account.id, id) : undefined)
      .orderBy(asc(account.closed), asc(account.type), asc(account.name));
    return rows.map((row) => toAccountView({ ...row.acct, connectionName: row.connectionName, transactionCount: row.transactionCount }));
  }

  r.get("/accounts", { schema: { response: { 200: z.array(AccountView) } } }, async () => list());

  r.post("/accounts", { schema: { body: CreateManualAccountBody, response: { 200: AccountView } } }, async (request) => {
    const taxTreatment = request.body.taxTreatment ?? defaultTaxTreatment[request.body.type];
    const balanceCents = request.body.balanceCents !== undefined ? BigInt(request.body.balanceCents) : null;
    const today = toIsoDate(new Date());
    const [row] = await app.db
      .insert(account)
      .values({ name: request.body.name.trim(), type: request.body.type, taxTreatment, balanceCents, balanceDate: balanceCents === null ? null : today })
      .returning({ id: account.id });
    if (balanceCents !== null) {
      await app.db.insert(balanceSnapshot).values({ accountId: row!.id, date: today, balanceCents, source: "manual" }).onConflictDoNothing();
    }
    return (await list(row!.id))[0]!;
  });

  r.patch("/accounts/:id", { schema: { params: UuidParams, body: UpdateAccountBody, response: { 200: AccountView } } }, async (request) => {
    const patch: Partial<typeof account.$inferInsert> = { updatedAt: new Date() };
    if (request.body.name !== undefined) patch.name = request.body.name.trim();
    if (request.body.type !== undefined) {
      patch.type = request.body.type;
      // Changing the type re-derives the tax treatment unless one was given explicitly.
      patch.taxTreatment = request.body.taxTreatment ?? defaultTaxTreatment[request.body.type];
    } else if (request.body.taxTreatment !== undefined) {
      patch.taxTreatment = request.body.taxTreatment;
    }
    if (request.body.onBudget !== undefined) patch.onBudget = request.body.onBudget;
    if (request.body.closed !== undefined) patch.closed = request.body.closed;
    const updated = await app.db.update(account).set(patch).where(eq(account.id, request.params.id)).returning({ id: account.id });
    if (updated.length === 0) throw notFound("Account not found");
    return (await list(request.params.id))[0]!;
  });
}
