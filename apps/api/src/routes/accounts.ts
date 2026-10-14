import { asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { account, balanceSnapshot, connection } from "@meridian/db";
import { AccountView, CreateManualAccountBody, defaultTaxTreatment, toIsoDate, UpdateAccountBody, UuidParams } from "@meridian/shared";
import { badRequest, notFound } from "../lib/errors.js";
import { toAccountView } from "../views.js";

type UpdateBody = z.infer<typeof UpdateAccountBody>;
type AccountPatch = Partial<typeof account.$inferInsert>;

/** The columns the card-payment rules read from the row being patched. */
type CardSettingsRow = Pick<typeof account.$inferSelect, "id" | "type" | "paymentDay" | "paymentFromAccountId" | "statementDay">;

/**
 * Cash-flow settings on PATCH /accounts/:id (docs/design/phase-2/cashflow.md "api"):
 * `paymentDay`, `paymentFromAccountId` and `statementDay` are accepted only while the
 * account is (or becomes) a credit account; `paymentDay` and `paymentFromAccountId`
 * are set or cleared together (checked on the merged row, so changing one while the
 * other stays set is fine); the paying account must be an on-budget checking or
 * savings account other than the card. `statementDay` is independent: null means
 * "pay the balance as of the day before the payment". A card that changes to another
 * type drops its payment settings. Returns the columns to write.
 */
async function cardSettingsPatch(app: FastifyInstance, current: CardSettingsRow, b: UpdateBody): Promise<AccountPatch> {
  const given = b.paymentDay !== undefined || b.paymentFromAccountId !== undefined || b.statementDay !== undefined;
  const effectiveType = b.type ?? current.type;
  if (effectiveType !== "credit") {
    const nonNull = (b.paymentDay ?? null) !== null || (b.paymentFromAccountId ?? null) !== null || (b.statementDay ?? null) !== null;
    if (nonNull) throw badRequest("Card payment settings apply to credit accounts only", "validation");
    // Leaving the credit type (or explicitly clearing) drops the settings so the loader never reads them on a cash account.
    return given || (b.type !== undefined && current.type === "credit") ? { paymentDay: null, paymentFromAccountId: null, statementDay: null } : {};
  }
  if (!given) return {};
  const paymentDay = b.paymentDay !== undefined ? b.paymentDay : current.paymentDay;
  const paymentFromAccountId = b.paymentFromAccountId !== undefined ? b.paymentFromAccountId : current.paymentFromAccountId;
  if ((paymentDay === null) !== (paymentFromAccountId === null)) {
    throw badRequest("paymentDay and paymentFromAccountId must be set or cleared together", "validation");
  }
  if (typeof b.paymentFromAccountId === "string") {
    if (b.paymentFromAccountId === current.id) throw badRequest("A card cannot be paid from itself", "validation");
    const [payer] = await app.db
      .select({ type: account.type, onBudget: account.onBudget })
      .from(account)
      .where(eq(account.id, b.paymentFromAccountId));
    if (!payer || !payer.onBudget || (payer.type !== "checking" && payer.type !== "savings")) {
      throw badRequest("The paying account must be an on-budget checking or savings account", "validation");
    }
  }
  const patch: AccountPatch = {};
  if (b.paymentDay !== undefined) patch.paymentDay = b.paymentDay;
  if (b.paymentFromAccountId !== undefined) patch.paymentFromAccountId = b.paymentFromAccountId;
  if (b.statementDay !== undefined) patch.statementDay = b.statementDay;
  return patch;
}

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
    const b = request.body;
    const [current] = await app.db
      .select({ id: account.id, type: account.type, paymentDay: account.paymentDay, paymentFromAccountId: account.paymentFromAccountId, statementDay: account.statementDay })
      .from(account)
      .where(eq(account.id, request.params.id));
    if (!current) throw notFound("Account not found");
    const patch: AccountPatch = { updatedAt: new Date(), ...(await cardSettingsPatch(app, current, b)) };
    if (b.name !== undefined) patch.name = b.name.trim();
    if (b.type !== undefined) {
      patch.type = b.type;
      // Changing the type re-derives the tax treatment unless one was given explicitly.
      patch.taxTreatment = b.taxTreatment ?? defaultTaxTreatment[b.type];
    } else if (b.taxTreatment !== undefined) {
      patch.taxTreatment = b.taxTreatment;
    }
    if (b.onBudget !== undefined) patch.onBudget = b.onBudget;
    if (b.closed !== undefined) patch.closed = b.closed;
    // Phase 2 cash flow: the per-account low-balance line (null = the household default for cash accounts).
    if (b.lowBalanceThresholdCents !== undefined) patch.lowBalanceThresholdCents = b.lowBalanceThresholdCents === null ? null : BigInt(b.lowBalanceThresholdCents);
    await app.db.update(account).set(patch).where(eq(account.id, current.id));
    return (await list(current.id))[0]!;
  });
}
