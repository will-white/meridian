import { asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  account,
  accountFidelities,
  balanceSnapshot,
  connection,
  defaultOnBudget,
  feedCategory,
  holdingSnapshot,
  investmentTxn,
  rebuildLotsForAccounts,
  requestValuation,
  setInvestmentIncomeFeed,
  writeAudit,
} from "@meridian/db";
import { AccountView, CreateManualAccountBody, defaultTaxTreatment, isInvestmentAccountType, toIsoDate, UpdateAccountBody, UuidParams } from "@meridian/shared";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
import { toAccountView } from "../views.js";
import { auditContext, usePlanErrors } from "./plan.js";

type UpdateBody = z.infer<typeof UpdateAccountBody>;
type AccountPatch = Partial<typeof account.$inferInsert>;

/** The columns the card-payment rules read from the row being patched. */
type CardSettingsRow = Pick<typeof account.$inferSelect, "id" | "type" | "paymentDay" | "paymentFromAccountId" | "statementDay">;
/** The Phase 3 per-account settings (plan decision 7; views design "Routes"). */
type InvestmentSettingsRow = Pick<typeof account.$inferSelect, "lotMethod" | "cashInference" | "investmentIncomeFeed">;

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

/**
 * Phase 3 (imports design §4): a `type` change into or out of the investment types is refused
 * with 409 `account_has_investment_data` while the account holds a holding snapshot or an
 * investment transaction, since both only make sense on an investment account. A change
 * between two investment types (roth → 401k) keeps the data and is allowed.
 */
async function assertTypeChangeAllowed(app: FastifyInstance, current: CardSettingsRow, nextType: typeof account.$inferSelect.type): Promise<void> {
  if (nextType === current.type || isInvestmentAccountType(nextType) === isInvestmentAccountType(current.type)) return;
  const [snapshot] = await app.db.select({ id: holdingSnapshot.id }).from(holdingSnapshot).where(eq(holdingSnapshot.accountId, current.id)).limit(1);
  const [txn] = snapshot ? [undefined] : await app.db.select({ id: investmentTxn.id }).from(investmentTxn).where(eq(investmentTxn.accountId, current.id)).limit(1);
  if (snapshot || txn) throw new HttpError(409, "The account has positions or investment transactions; delete them before changing its type", "account_has_investment_data");
}

/**
 * Phase 3: `lotMethod` and `cashInference` apply to investment accounts only (400
 * `not_investment_account`); enabling an income feed needs an investment account and the
 * household's feed category (400 `feed_category_required`, checked here before anything is
 * written so the PATCH stays all-or-nothing; `setInvestmentIncomeFeed` re-checks both).
 */
async function assertInvestmentSettingsAllowed(app: FastifyInstance, effectiveType: typeof account.$inferSelect.type, b: UpdateBody): Promise<void> {
  const investment = isInvestmentAccountType(effectiveType);
  if ((b.lotMethod !== undefined || b.cashInference !== undefined) && !investment) {
    throw badRequest("Lot method and cash inference apply to investment accounts only", "not_investment_account");
  }
  if (b.investmentIncomeFeed !== undefined && b.investmentIncomeFeed !== "off") {
    if (!investment) throw badRequest("An income feed applies to investment accounts only", "not_investment_account");
    if ((await feedCategory(app.db)).id === null) throw badRequest("Set the household's investment income category first", "feed_category_required");
  }
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  usePlanErrors(app);

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
    // Phase 3 (plan decision 7): the derived fidelity record per investment-type account; other types read null.
    const fidelities = await accountFidelities(
      app.db,
      rows.map((row) => row.acct.id),
    );
    return rows.map((row) => toAccountView({ ...row.acct, connectionName: row.connectionName, transactionCount: row.transactionCount }, fidelities.get(row.acct.id)));
  }

  r.get("/accounts", { schema: { response: { 200: z.array(AccountView) } } }, async () => list());

  r.post("/accounts", { schema: { body: CreateManualAccountBody, response: { 200: AccountView } } }, async (request) => {
    const taxTreatment = request.body.taxTreatment ?? defaultTaxTreatment[request.body.type];
    const balanceCents = request.body.balanceCents !== undefined ? BigInt(request.body.balanceCents) : null;
    const today = toIsoDate(new Date());
    const [row] = await app.db
      .insert(account)
      // Investment-type accounts start off-budget (plan decision 15); the Accounts page offers a one-click move.
      .values({ name: request.body.name.trim(), type: request.body.type, taxTreatment, onBudget: defaultOnBudget(request.body.type), balanceCents, balanceDate: balanceCents === null ? null : today })
      .returning({ id: account.id });
    if (balanceCents !== null) {
      await app.db.insert(balanceSnapshot).values({ accountId: row!.id, date: today, balanceCents, source: "manual" }).onConflictDoNothing();
    }
    return (await list(row!.id))[0]!;
  });

  r.patch("/accounts/:id", { schema: { params: UuidParams, body: UpdateAccountBody, response: { 200: AccountView } } }, async (request) => {
    const b = request.body;
    const [current]: Array<CardSettingsRow & InvestmentSettingsRow> = await app.db
      .select({
        id: account.id,
        type: account.type,
        paymentDay: account.paymentDay,
        paymentFromAccountId: account.paymentFromAccountId,
        statementDay: account.statementDay,
        lotMethod: account.lotMethod,
        cashInference: account.cashInference,
        investmentIncomeFeed: account.investmentIncomeFeed,
      })
      .from(account)
      .where(eq(account.id, request.params.id));
    if (!current) throw notFound("Account not found");
    if (b.type !== undefined) await assertTypeChangeAllowed(app, current, b.type);
    await assertInvestmentSettingsAllowed(app, b.type ?? current.type, b);
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
    if (b.lotMethod !== undefined) patch.lotMethod = b.lotMethod;
    if (b.cashInference !== undefined) patch.cashInference = b.cashInference;
    const ctx = auditContext(request);
    const before = { lotMethod: current.lotMethod, cashInference: current.cashInference };
    const after = { lotMethod: b.lotMethod ?? current.lotMethod, cashInference: b.cashInference ?? current.cashInference };
    await app.db.transaction(async (tx) => {
      await tx.update(account).set(patch).where(eq(account.id, current.id));
      if (before.lotMethod === after.lotMethod && before.cashInference === after.cashInference) return;
      await writeAudit(tx, { ...ctx, entity: "account", entityId: current.id, action: "update", before, after });
      // The lots cache reads the account's method when it is built (plan decision 5); the chain's cash plug follows the inference setting (decision 8).
      if (before.lotMethod !== after.lotMethod) await rebuildLotsForAccounts(tx, [current.id]);
      if (before.cashInference !== after.cashInference) await requestValuation(tx, { reason: "setting", accountId: current.id });
    });
    // The feed setting is the income service's (audited as `account`, runs the account inline, queues the job) in the same audit batch.
    if (b.investmentIncomeFeed !== undefined) await setInvestmentIncomeFeed(app.db, current.id, b.investmentIncomeFeed, { ...ctx, now: app.now() });
    return (await list(current.id))[0]!;
  });
}
