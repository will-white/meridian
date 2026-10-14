import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createManualRecurring,
  deleteRecurring,
  dismissAlert,
  dismissAllAlerts,
  enqueueJob,
  getRecurring,
  linkTransaction,
  listAlerts,
  listRecurring,
  listSubscriptions,
  listTransactions,
  unlinkTransaction,
  updateRecurring,
  type CreateRecurringInput,
  type UpdateRecurringInput,
} from "@meridian/db";
import {
  AlertList,
  AlertQuery,
  AlertView,
  CreateRecurringBody,
  DetectResponse,
  DismissAllAlertsBody,
  isWeekBased,
  LinkTransactionBody,
  OkResponse,
  RecurringList,
  RecurringQuery,
  RecurringView,
  SubscriptionsResponse,
  TransactionList,
  UpdateRecurringBody,
  UuidParams,
  type Cadence,
  type IsoDate,
} from "@meridian/shared";
import { badRequest, notFound } from "../lib/errors.js";
import { toTransactionView } from "../views.js";
import { toAlertView, toRecurringList, toRecurringView, toSubscriptionsResponse } from "../views/recurring.js";
import { auditContext, serverToday, usePlanErrors } from "./plan.js";

/**
 * Recurring items (detected suggestions and hand-made bills), their charge links, the
 * Subscriptions page and alerts (recurring design, "api"). `today` is always the
 * server's household date: these routes take no client date. Typed service failures
 * (RecurringError: invalid_transition, category_required, validation, conflict,
 * not_found) are rendered by the plan error handler with their own status codes.
 */

type CreateBody = z.infer<typeof CreateRecurringBody>;
type UpdateBody = z.infer<typeof UpdateRecurringBody>;

interface ScheduleFields {
  cadence: Cadence;
  anchorDay: number | null;
  anchorDay2: number | null;
  anchorMonth: number | null;
  anchorDate: IsoDate | null;
}

/**
 * The schedule invariants per cadence (design: the body's superRefine): weekly/biweekly
 * need anchorDate; twice_monthly needs anchorDay and anchorDay2 > anchorDay; monthly
 * needs anchorDay; the longer month-based cadences need anchorDay and anchorMonth.
 * Anchors a cadence does not use are ignored. Returns the first problem, or null.
 */
export function scheduleProblem(s: ScheduleFields): string | null {
  if (isWeekBased(s.cadence)) return s.anchorDate === null ? `${s.cadence} needs anchorDate` : null;
  if (s.anchorDay === null) return `${s.cadence} needs anchorDay`;
  if (s.cadence === "twice_monthly") {
    if (s.anchorDay2 === null) return "twice_monthly needs anchorDay2";
    if (s.anchorDay2 <= s.anchorDay) return "anchorDay2 must be after anchorDay";
    return null;
  }
  if (s.cadence !== "monthly" && s.anchorMonth === null) return `${s.cadence} needs anchorMonth`;
  return null;
}

function assertSchedule(s: ScheduleFields): void {
  const problem = scheduleProblem(s);
  if (problem) throw badRequest(problem, "validation");
}

function toCreateInput(b: CreateBody): CreateRecurringInput {
  assertSchedule({ cadence: b.cadence, anchorDay: b.anchorDay ?? null, anchorDay2: b.anchorDay2 ?? null, anchorMonth: b.anchorMonth ?? null, anchorDate: b.anchorDate ?? null });
  return {
    name: b.name,
    ...(b.payeeId !== undefined ? { payeeId: b.payeeId } : {}),
    ...(b.payeeName !== undefined ? { payeeName: b.payeeName } : {}),
    categoryId: b.categoryId,
    accountId: b.accountId,
    ...(b.transferAccountId !== undefined ? { transferAccountId: b.transferAccountId } : {}),
    cadence: b.cadence,
    ...(b.anchorDay !== undefined ? { anchorDay: b.anchorDay } : {}),
    ...(b.anchorDay2 !== undefined ? { anchorDay2: b.anchorDay2 } : {}),
    ...(b.anchorMonth !== undefined ? { anchorMonth: b.anchorMonth } : {}),
    ...(b.anchorDate !== undefined ? { anchorDate: b.anchorDate } : {}),
    expectedCents: BigInt(b.expectedCents),
    ...(b.toleranceCents !== undefined ? { toleranceCents: BigInt(b.toleranceCents) } : {}),
    ...(b.amountMode !== undefined ? { amountMode: b.amountMode } : {}),
    ...(b.notes !== undefined ? { notes: b.notes } : {}),
  };
}

function toUpdateInput(b: UpdateBody, current: ScheduleFields): UpdateRecurringInput {
  const scheduleEdited = b.cadence !== undefined || b.anchorDay !== undefined || b.anchorDay2 !== undefined || b.anchorMonth !== undefined || b.anchorDate !== undefined;
  if (scheduleEdited) {
    // The merged schedule must satisfy the invariants of the (possibly new) cadence.
    assertSchedule({
      cadence: b.cadence ?? current.cadence,
      anchorDay: b.anchorDay !== undefined ? b.anchorDay : current.anchorDay,
      anchorDay2: b.anchorDay2 !== undefined ? b.anchorDay2 : current.anchorDay2,
      anchorMonth: b.anchorMonth !== undefined ? b.anchorMonth : current.anchorMonth,
      anchorDate: b.anchorDate !== undefined ? b.anchorDate : current.anchorDate,
    });
  }
  return {
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.categoryId !== undefined ? { categoryId: b.categoryId } : {}),
    ...(b.accountId !== undefined ? { accountId: b.accountId } : {}),
    ...(b.transferAccountId !== undefined ? { transferAccountId: b.transferAccountId } : {}),
    ...(b.cadence !== undefined ? { cadence: b.cadence } : {}),
    ...(b.anchorDay !== undefined ? { anchorDay: b.anchorDay } : {}),
    ...(b.anchorDay2 !== undefined ? { anchorDay2: b.anchorDay2 } : {}),
    ...(b.anchorMonth !== undefined ? { anchorMonth: b.anchorMonth } : {}),
    ...(b.anchorDate !== undefined ? { anchorDate: b.anchorDate } : {}),
    ...(b.expectedCents !== undefined ? { expectedCents: BigInt(b.expectedCents) } : {}),
    ...(b.toleranceCents !== undefined ? { toleranceCents: BigInt(b.toleranceCents) } : {}),
    ...(b.amountMode !== undefined ? { amountMode: b.amountMode } : {}),
    ...(b.notes !== undefined ? { notes: b.notes } : {}),
    ...(b.status !== undefined ? { status: b.status } : {}),
  };
}

const LinkParams = z.object({ id: z.string().uuid(), transactionId: z.string().uuid() });
const PageQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), cursor: z.string().optional() });
const DismissAllResponse = z.object({ dismissed: z.number().int() });

export async function recurringRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  usePlanErrors(app);

  async function view(id: string): Promise<RecurringView> {
    const record = await getRecurring(app.db, id);
    if (!record) throw notFound("Recurring item not found");
    return toRecurringView(record);
  }

  /**
   * Default status: everything except dismissed. The contract's default sort "due" is the
   * design's default ordering: suggestions first (confidence desc, then |yearly| desc),
   * then the rest by next due date (nulls last); the other sorts apply to the whole list.
   */
  r.get("/recurring", { schema: { querystring: RecurringQuery, response: { 200: RecurringList } } }, async (request) => {
    const q = request.query;
    const result = await listRecurring(app.db, {
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.direction !== undefined ? { direction: q.direction } : {}),
      ...(q.sort !== "due" ? { sort: q.sort } : {}),
    });
    return toRecurringList(result);
  });

  /** Active outflows by yearly cost (most expensive first), paused ones apart, totals from the yearly sum. */
  r.get("/recurring/subscriptions", { schema: { response: { 200: SubscriptionsResponse } } }, async () => toSubscriptionsResponse(await listSubscriptions(app.db)));

  /** "Scan now": one `recurring.detect` job at a time; a queued or running one is returned instead. */
  r.post("/recurring/detect", { schema: { response: { 202: DetectResponse } } }, async (_request, reply) => {
    const job = await enqueueJob(app.db, "recurring.detect", { reason: "manual" }, { dedupe: true });
    return reply.status(202).send({ jobId: job.id, created: job.created });
  });

  /** A hand-made item: source manual, status active, both locks on; the current period's charge is linked at once. */
  r.post("/recurring", { schema: { body: CreateRecurringBody, response: { 201: RecurringView } } }, async (request, reply) => {
    const today = await serverToday(app);
    const input = toCreateInput(request.body);
    const id = await app.db.transaction((tx) => createManualRecurring(tx, input, today, { now: app.now(), audit: auditContext(request) }));
    return reply.status(201).send(await view(id));
  });

  r.get("/recurring/:id", { schema: { params: UuidParams, response: { 200: RecurringView } } }, async (request) => view(request.params.id));

  /** Edits lock what they touch (amount / schedule); `status` runs the transition matrix (400 invalid_transition, category_required). */
  r.patch("/recurring/:id", { schema: { params: UuidParams, body: UpdateRecurringBody, response: { 200: RecurringView } } }, async (request) => {
    const current = await getRecurring(app.db, request.params.id);
    if (!current) throw notFound("Recurring item not found");
    const today = await serverToday(app);
    const input = toUpdateInput(request.body, current);
    await app.db.transaction((tx) => updateRecurring(tx, current.id, input, today, app.now(), { audit: auditContext(request) }));
    return view(current.id);
  });

  /** Hard delete: links nulled, alerts cascade. A detected series is re-suggested on the next run; dismiss means "never again". */
  r.delete("/recurring/:id", { schema: { params: UuidParams, response: { 200: OkResponse } } }, async (request) => {
    const deleted = await app.db.transaction((tx) => deleteRecurring(tx, request.params.id, { audit: auditContext(request) }));
    if (!deleted) throw notFound("Recurring item not found");
    return { ok: true as const };
  });

  /** The charges linked to one item, newest first. */
  r.get("/recurring/:id/transactions", { schema: { params: UuidParams, querystring: PageQuery, response: { 200: TransactionList } } }, async (request) => {
    await view(request.params.id);
    const result = await listTransactions(app.db, {
      recurringId: request.params.id,
      limit: request.query.limit,
      ...(request.query.cursor !== undefined ? { cursor: request.query.cursor } : {}),
    });
    return { items: result.items.map(toTransactionView), nextCursor: result.nextCursor };
  });

  /** Manual link: same payee and direction, not a transfer, not linked elsewhere, and a free period (409 otherwise). */
  r.post("/recurring/:id/link", { schema: { params: UuidParams, body: LinkTransactionBody, response: { 200: RecurringView } } }, async (request) => {
    const today = await serverToday(app);
    await app.db.transaction((tx) => linkTransaction(tx, request.params.id, request.body.transactionId, today, app.now()));
    return view(request.params.id);
  });

  r.delete("/recurring/:id/link/:transactionId", { schema: { params: LinkParams, response: { 200: RecurringView } } }, async (request) => {
    const today = await serverToday(app);
    await app.db.transaction((tx) => unlinkTransaction(tx, request.params.id, request.params.transactionId, today, app.now()));
    return view(request.params.id);
  });

  // ---- Alerts ----

  /** Open alerts, newest first, unless the flags include dismissed or resolved ones. */
  r.get("/alerts", { schema: { querystring: AlertQuery, response: { 200: AlertList } } }, async (request) => {
    const q = request.query;
    const items = await listAlerts(app.db, {
      includeDismissed: q.includeDismissed,
      includeResolved: q.includeResolved,
      limit: q.limit,
      ...(q.kind !== undefined ? { kind: q.kind } : {}),
    });
    return { items: items.map(toAlertView) };
  });

  /** Dismiss every open alert, optionally of one kind. */
  r.post("/alerts/dismiss-all", { schema: { body: DismissAllAlertsBody, response: { 200: DismissAllResponse } } }, async (request) => ({
    dismissed: await dismissAllAlerts(app.db, request.body.kind, app.now()),
  }));

  /** Idempotent: a second dismissal keeps the first timestamp. */
  r.post("/alerts/:id/dismiss", { schema: { params: UuidParams, response: { 200: AlertView } } }, async (request) => {
    const record = await dismissAlert(app.db, request.params.id, app.now());
    if (!record) throw notFound("Alert not found");
    return toAlertView(record);
  });
}
