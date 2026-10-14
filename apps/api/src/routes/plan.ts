import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { assertPlanRange, closeMonth, getHouseholdSetting, getPlan, householdToday, planAverages, PlanError, setPlanCells, type AuditContext, type PlanCellEditInput } from "@meridian/db";
import {
  addMonths,
  CloseMonthBody,
  CloseMonthResponse,
  dayDiff,
  isIsoDate,
  monthKey,
  PlanAveragesQuery,
  PlanAveragesResponse,
  PlanQuery,
  PlanResponse,
  SetPlanCellsBody,
  SetPlanCellsResponse,
  type IsoDate,
  type MonthKey,
  type PlanCellEdit,
} from "@meridian/shared";
import { badRequest, HttpError } from "../lib/errors.js";
import { toPlanAveragesResponse, toPlanResponse } from "../views/plan.js";

/**
 * Plan grid routes, plus the request helpers every Phase 2 route shares:
 * the client-supplied `today` (bounded to the server date), one audit batch
 * per request, and the mapping of typed service errors onto HttpError.
 */

/** A client's `today` may differ from the server's household date by at most this many days. */
export const TODAY_TOLERANCE_DAYS = 2;

/** The household's calendar date for the server clock (docs/phase-2-plan.md §16). */
export async function serverToday(app: FastifyInstance): Promise<IsoDate> {
  return householdToday(await getHouseholdSetting(app.db), app.now());
}

/**
 * The effective `today`: the client's local date when given (within ±2 days of
 * the server's household date, else 400), otherwise the server's.
 */
export async function resolveToday(app: FastifyInstance, requested: IsoDate | undefined): Promise<IsoDate> {
  const today = await serverToday(app);
  if (requested === undefined) return today;
  if (!isIsoDate(requested)) throw badRequest("today must be a calendar date", "validation");
  if (Math.abs(dayDiff(today, requested)) > TODAY_TOLERANCE_DAYS) throw badRequest("today is too far from the server date", "today_out_of_range");
  return requested;
}

/** One audit batch per request, attributed to the signed-in user. */
export function auditContext(request: FastifyRequest): AuditContext {
  return { userId: "user" in request.auth ? request.auth.user.id : null, batchId: randomUUID() };
}

/** PlanError (a typed service failure) → HttpError with the same status and code; anything else passes through. */
export function toHttpError(error: unknown): unknown {
  return error instanceof PlanError ? new HttpError(error.status, error.message, error.code) : error;
}

/**
 * Scoped error handler for a Phase 2 route plugin: rethrows service errors as
 * HttpErrors so the root handler renders them. (A throwing scoped handler
 * defers to its parent in Fastify.)
 */
export function usePlanErrors(app: FastifyInstance): void {
  app.setErrorHandler((error) => {
    throw toHttpError(error);
  });
}

/** Default columns: the two months before the current one through three after it; from and to default independently. */
export function defaultPlanRange(query: { from?: MonthKey | undefined; to?: MonthKey | undefined }, today: IsoDate): { from: MonthKey; to: MonthKey } {
  const current = monthKey(today);
  return { from: query.from ?? addMonths(current, -2), to: query.to ?? addMonths(current, 3) };
}

function toCellEdit(e: PlanCellEdit): PlanCellEditInput {
  return {
    month: e.month,
    categoryId: e.categoryId,
    source: e.source,
    ...(e.plannedCents !== undefined ? { plannedCents: e.plannedCents === null ? null : BigInt(e.plannedCents) } : {}),
    ...(e.rolloverMode !== undefined ? { rolloverMode: e.rolloverMode } : {}),
    ...(e.carriedInOverrideCents !== undefined ? { carriedInOverrideCents: e.carriedInOverrideCents === null ? null : BigInt(e.carriedInOverrideCents) } : {}),
    ...(e.note !== undefined ? { note: e.note } : {}),
  };
}

export async function planRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  usePlanErrors(app);

  r.get("/plan", { schema: { querystring: PlanQuery, response: { 200: PlanResponse } } }, async (request) => {
    const today = await resolveToday(app, request.query.today);
    const range = defaultPlanRange(request.query, today);
    return toPlanResponse(await getPlan(app.db, { ...range, today }));
  });

  /** Typing, clearing, fill right and plan-from-average all arrive here: one audit batch, identical values write nothing. */
  r.put("/plan/cells", { schema: { body: SetPlanCellsBody, response: { 200: SetPlanCellsResponse } } }, async (request) => {
    const today = await resolveToday(app, request.body.today);
    const range = request.body.range;
    if (range) assertPlanRange(range.from, range.to); // reject a bad re-read range before anything is written
    const ctx = { ...auditContext(request), today };
    const { changed } = await setPlanCells(app.db, request.body.edits.map(toCellEdit), ctx);
    const plan = range ? toPlanResponse(await getPlan(app.db, { from: range.from, to: range.to, today })) : null;
    return { changed, batchId: ctx.batchId, plan };
  });

  r.get("/plan/averages", { schema: { querystring: PlanAveragesQuery, response: { 200: PlanAveragesResponse } } }, async (request) => {
    const today = await resolveToday(app, request.query.today);
    const result = await planAverages(app.db, { months: request.query.months, today, ...(request.query.asOf !== undefined ? { asOf: request.query.asOf } : {}) });
    return toPlanAveragesResponse(result);
  });

  /** Freeze auto-planned values for completed months (the nightly job's work, on demand). Idempotent. */
  r.post("/plan/close-month", { schema: { body: CloseMonthBody, response: { 200: CloseMonthResponse } } }, async (request) => {
    const today = await serverToday(app);
    const currentMonth = monthKey(today);
    const through = request.body.through ?? addMonths(currentMonth, -1);
    if (through >= currentMonth) throw badRequest("through must be a completed month", "validation");
    return closeMonth(app.db, through, { today });
  });
}
