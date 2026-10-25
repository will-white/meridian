import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  addSecurityAlias,
  createSecurity,
  deleteSecurity,
  getAllocationTargets,
  getSecurity,
  listSecurities,
  mergeSecurities,
  rebuildLotsForAccounts,
  resolveSecurity,
  security,
  setAllocationTargets,
  setSecurityAllocation,
  updateSecurity,
  updateSecurityPricing,
  type CreateSecurityInput,
  type DbOrTx,
  type SecurityListQuery,
  type SecurityMatchedBy,
  type SecurityMutationResult,
  type SecurityPricingPatch,
  type UpdateSecurityInput,
} from "@meridian/db";
import {
  AddSecurityAliasBody,
  AllocationTargetsView,
  CreateSecurityBody,
  isCashKey,
  MergeSecurityBody,
  OkResponse,
  ResolveSecurityQuery,
  ResolveSecurityResponse,
  SecurityQuery,
  SecurityRef,
  SecurityView,
  SetAllocationTargetsBody,
  SetSecurityAllocationBody,
  UpdateSecurityBody,
  UuidParams,
  type SecurityKey,
  type SecuritySuggestion,
} from "@meridian/shared";
import { badRequest, notFound } from "../lib/errors.js";
import { toAllocationTargetsView, toSecurityRefView, toSecurityView } from "../views/investments.js";
import { auditContext, usePlanErrors } from "./plan.js";

/**
 * Security master routes (imports design §4, plan decision 17): list, resolve, create, one
 * PATCH whose pricing fields go through `updateSecurityPricing`, aliases, merge, delete, the
 * per-security allocation (views area) and the household allocation targets. GETs are open
 * to the viewer role; mutations are refused by the auth plugin.
 */

/**
 * `PRICE_PROVIDER !== 'none'` (plan decision 10): a configured provider lets a pricing change
 * or an import queue a `prices.fetch`. `ApiConfig.priceProvider` is null for `none` and absent
 * on a hand-built config (the test apps), both of which mean no provider; the API never reads
 * the environment itself.
 */
export function priceProviderConfigured(app: FastifyInstance): boolean {
  return (app.config.priceProvider ?? null) !== null;
}

export type PreviewResolution = { id: string; matchedBy: SecurityMatchedBy } | { id: null; cash: boolean; suggestion: SecuritySuggestion };

/**
 * Resolve a security key without writing anything: a cash key finds the existing cash
 * security (or reports it as a new one) instead of creating the singleton the way
 * `resolveSecurity` does; every other key resolves with `createIfMissing: false`.
 */
export async function resolveWithoutCreating(db: DbOrTx, key: SecurityKey): Promise<PreviewResolution> {
  if (isCashKey(key)) {
    const currency = (key.currency ?? "USD").toUpperCase();
    const [row] = await db
      .select({ id: security.id })
      .from(security)
      .where(and(eq(security.type, "cash"), eq(security.currency, currency)))
      .limit(1);
    if (row) return { id: row.id, matchedBy: "cash" };
    return { id: null, cash: true, suggestion: { ticker: null, cusip: null, isin: null, name: `Cash (${currency})`, type: "cash", assetClass: "cash" } };
  }
  const resolved = await resolveSecurity(db, key, { createIfMissing: false });
  if (resolved.id === null) return { id: null, cash: false, suggestion: resolved.suggestion };
  if (resolved.matchedBy === "created") throw new Error("resolveSecurity created a row without createIfMissing");
  return { id: resolved.id, matchedBy: resolved.matchedBy };
}

type CreateBody = z.infer<typeof CreateSecurityBody>;
type UpdateBody = z.infer<typeof UpdateSecurityBody>;

function toCreateInput(b: CreateBody): CreateSecurityInput {
  return {
    name: b.name,
    type: b.type,
    assetClass: b.assetClass,
    ...(b.ticker !== undefined ? { ticker: b.ticker } : {}),
    ...(b.expenseRatioPercent !== undefined ? { expenseRatioPercent: b.expenseRatioPercent } : {}),
    ...(b.cusip !== undefined ? { cusip: b.cusip } : {}),
    ...(b.isin !== undefined ? { isin: b.isin } : {}),
    ...(b.currency !== undefined ? { currency: b.currency } : {}),
    ...(b.priceMode !== undefined ? { priceMode: b.priceMode } : {}),
    ...(b.providerSymbol !== undefined ? { providerSymbol: b.providerSymbol } : {}),
    ...(b.alwaysPrice !== undefined ? { alwaysPrice: b.alwaysPrice } : {}),
    ...(b.notes !== undefined ? { notes: b.notes } : {}),
  };
}

function toPricingPatch(b: UpdateBody): SecurityPricingPatch {
  return {
    ...(b.priceMode !== undefined ? { priceMode: b.priceMode } : {}),
    ...(b.providerSymbol !== undefined ? { providerSymbol: b.providerSymbol } : {}),
    ...(b.alwaysPrice !== undefined ? { alwaysPrice: b.alwaysPrice } : {}),
  };
}

function toUpdateInput(b: UpdateBody): UpdateSecurityInput {
  return {
    ...toPricingPatch(b),
    ...(b.ticker !== undefined ? { ticker: b.ticker } : {}),
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.type !== undefined ? { type: b.type } : {}),
    ...(b.assetClass !== undefined ? { assetClass: b.assetClass } : {}),
    ...(b.expenseRatioPercent !== undefined ? { expenseRatioPercent: b.expenseRatioPercent } : {}),
    ...(b.cusip !== undefined ? { cusip: b.cusip } : {}),
    ...(b.isin !== undefined ? { isin: b.isin } : {}),
    ...(b.currency !== undefined ? { currency: b.currency } : {}),
    ...(b.notes !== undefined ? { notes: b.notes } : {}),
    ...(b.needsReview !== undefined ? { needsReview: b.needsReview } : {}),
    ...(b.archived !== undefined ? { archived: b.archived } : {}),
  };
}

const PRICING_KEYS = ["priceMode", "providerSymbol", "alwaysPrice"] as const;

export async function securityRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  usePlanErrors(app);

  r.get("/investments/securities", { schema: { querystring: SecurityQuery, response: { 200: z.array(SecurityView) } } }, async (request) => {
    const q = request.query;
    const query: SecurityListQuery = {
      ...(q.q !== undefined ? { q: q.q } : {}),
      ...(q.needsReview !== undefined ? { needsReview: q.needsReview } : {}),
      ...(q.held !== undefined ? { held: q.held } : {}),
      ...(q.type !== undefined ? { type: q.type } : {}),
      ...(q.includeArchived !== undefined ? { includeArchived: q.includeArchived } : {}),
    };
    return (await listSecurities(app.db, query)).map(toSecurityView);
  });

  /** Typeahead for the preview and the manual forms; never creates (a cash key finds the existing cash security). */
  r.get("/investments/securities/resolve", { schema: { querystring: ResolveSecurityQuery, response: { 200: ResolveSecurityResponse } } }, async (request) => {
    const q = request.query;
    if (!q.ticker && !q.cusip && !q.isin && !q.name) throw badRequest("A ticker, CUSIP, ISIN or name is required", "validation");
    const resolved = await resolveWithoutCreating(app.db, { ticker: q.ticker ?? null, cusip: q.cusip ?? null, isin: q.isin ?? null, name: q.name ?? null });
    if (resolved.id === null) return { status: "unresolved" as const, suggestion: resolved.suggestion };
    const record = await getSecurity(app.db, resolved.id);
    if (!record) throw notFound("Security not found");
    return { status: "resolved" as const, security: toSecurityView(record), matchedBy: resolved.matchedBy };
  });

  r.get("/investments/securities/:id", { schema: { params: UuidParams, response: { 200: SecurityView } } }, async (request) => {
    const record = await getSecurity(app.db, request.params.id);
    if (!record) throw notFound("Security not found");
    return toSecurityView(record);
  });

  /** The owner typed it, so it never needs review. */
  r.post("/investments/securities", { schema: { body: CreateSecurityBody, response: { 200: SecurityView } } }, async (request) => {
    return toSecurityView(await createSecurity(app.db, toCreateInput(request.body), auditContext(request), { needsReview: false }));
  });

  /**
   * One PATCH for every field. A body made only of pricing fields (`priceMode`, `providerSymbol`,
   * `alwaysPrice`) goes through `updateSecurityPricing`, which resets the fetch state and queues
   * the backfill; any other field goes through `updateSecurity`, which applies the same pricing
   * rules atomically with the rest of the row (one audit entry, needsReview cleared unless set).
   */
  r.patch("/investments/securities/:id", { schema: { params: UuidParams, body: UpdateSecurityBody, response: { 200: SecurityView } } }, async (request) => {
    const b = request.body;
    const ctx = auditContext(request);
    const opts = { queueBackfill: priceProviderConfigured(app), now: app.now() };
    const hasPricing = PRICING_KEYS.some((k) => b[k] !== undefined);
    const hasOther = (Object.keys(b) as Array<keyof UpdateBody>).some((k) => !PRICING_KEYS.includes(k as (typeof PRICING_KEYS)[number]) && b[k] !== undefined);
    let result: SecurityMutationResult;
    if (hasPricing && !hasOther) result = await updateSecurityPricing(app.db, request.params.id, toPricingPatch(b), ctx, opts);
    else result = await updateSecurity(app.db, request.params.id, toUpdateInput(b), ctx, opts);
    return toSecurityView(result.security);
  });

  r.delete("/investments/securities/:id", { schema: { params: UuidParams, response: { 200: OkResponse } } }, async (request) => {
    await deleteSecurity(app.db, request.params.id, auditContext(request));
    return { ok: true as const };
  });

  /** `fromId` is merged into `:id` (the survivor); the lots cache of every touched account is rebuilt in the same transaction. */
  r.post("/investments/securities/:id/merge", { schema: { params: UuidParams, body: MergeSecurityBody, response: { 200: SecurityView } } }, async (request) => {
    if (request.body.fromId === request.params.id) throw badRequest("A security cannot be merged into itself", "merge_self");
    const result = await mergeSecurities(app.db, request.params.id, request.body.fromId, auditContext(request), {
      rebuildLots: (tx, accountId) => rebuildLotsForAccounts(tx, [accountId]),
    });
    return toSecurityView(result.security);
  });

  r.post("/investments/securities/:id/aliases", { schema: { params: UuidParams, body: AddSecurityAliasBody, response: { 200: SecurityView } } }, async (request) => {
    return toSecurityView(await addSecurityAlias(app.db, request.params.id, { kind: request.body.kind, value: request.body.value }, auditContext(request)));
  });

  /** The primary class and the blended-fund splits (views area; seams C46). */
  r.put("/investments/securities/:id/allocation", { schema: { params: UuidParams, body: SetSecurityAllocationBody, response: { 200: SecurityRef } } }, async (request) => {
    const ref = await setSecurityAllocation(app.db, request.params.id, { assetClass: request.body.assetClass, splits: request.body.splits }, auditContext(request));
    return toSecurityRefView(ref);
  });

  r.get("/investments/allocation-targets", { schema: { response: { 200: AllocationTargetsView } } }, async () => {
    return toAllocationTargetsView(await getAllocationTargets(app.db));
  });

  /** Replaces the whole set; a non-empty set must sum to 10 000 bp (400 `allocation_sum`); an identical re-send writes nothing. */
  r.put("/investments/allocation-targets", { schema: { body: SetAllocationTargetsBody, response: { 200: AllocationTargetsView } } }, async (request) => {
    const targets = request.body.targets.map((t) => ({ assetClass: t.assetClass, targetBp: t.targetBp }));
    return toAllocationTargetsView(await setAllocationTargets(app.db, targets, auditContext(request)));
  });
}
