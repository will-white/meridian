import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  AUTO_PAUSE_AFTER_MISSED,
  LOOKBACK_MONTHS,
  MIN_CHARGES,
  addDays,
  addMonthsClamped,
  classifyAmounts,
  detectRecurring,
  detectTrialConversion,
  effectiveDay,
  fitSchedule,
  graceDays,
  isIsoDate,
  isMissed,
  isNewSeries,
  isWeekBased,
  maxBig,
  monthlyEquivalentCents,
  nominalPeriodDays,
  occurrence,
  periodIndex,
  truncDiv,
  upperMedian,
  validateSchedule,
  yearlyCents,
  type AlertKind,
  type AmountMode,
  type Cadence,
  type ChargeLike,
  type Detection,
  type IsoDate,
  type RecurringSource,
  type RecurringStatus,
  type Schedule,
} from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { account, alert, category, payee, recurring, transaction } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { resolvePayee } from "./payees.js";
import { notInvestmentIncomeRow } from "./transfers.js";

/**
 * Recurring persistence: the detector run, the matcher, the per-item refresh of the
 * denormalised columns, alerts, status transitions, manual items and the list and
 * subscription views (recurring design, section C).
 *
 * The pure engine lives in @meridian/shared (`recurringDetect.ts`, `schedule.ts`); this
 * module only loads rows, applies the engine's results and keeps `transaction.recurring_id`
 * links in step. Series identity across runs is link overlap. Every denormalised column
 * (`next_due_date`, the charge summary, `consecutive_missed`) is a pure function of the
 * links, the lock flags and `today`, recomputed by `refreshRecurringItem`. Money is bigint
 * cents; dates are YYYY-MM-DD strings. `transaction.recurring_id` carries no foreign key,
 * so links are nulled here whenever a row is deleted.
 */

/** A recurring-service failure the API maps 1:1 onto an HTTP status and error code. */
export class RecurringError extends PlanError {
  constructor(status: number, code: RecurringErrorCode, message: string) {
    super(status, code, message);
    this.name = "RecurringError";
  }
}

export type RecurringErrorCode = "invalid_transition" | "category_required" | "account_required" | "validation" | "not_found" | "conflict";

const LIVE_STATUSES: readonly RecurringStatus[] = ["active", "paused", "dismissed"];

type StoredRecurring = typeof recurring.$inferSelect;
type RecurringPatch = Partial<typeof recurring.$inferInsert>;

export type RecurringRowWithLinks = StoredRecurring & { linkedIds: string[] };

interface LinkedCharge {
  id: string;
  accountId: string;
  date: IsoDate;
  amountCents: bigint;
}

function absBig(a: bigint): bigint {
  return a < 0n ? -a : a;
}

function signOf(cents: bigint): 1n | -1n {
  return cents < 0n ? -1n : 1n;
}

function groupKey(payeeId: string, sign: 1n | -1n): string {
  return `${payeeId}|${sign === -1n ? "-1" : "1"}`;
}

function parseGroupKey(key: string): { payeeId: string; sign: 1n | -1n } {
  const i = key.lastIndexOf("|");
  return { payeeId: key.slice(0, i), sign: key.slice(i + 1) === "-1" ? -1n : 1n };
}

function scheduleOf(row: Pick<StoredRecurring, "cadence" | "anchorDay" | "anchorDay2" | "anchorMonth" | "anchorDate">): Schedule {
  return { cadence: row.cadence, anchorDay: row.anchorDay, anchorDay2: row.anchorDay2, anchorMonth: row.anchorMonth, anchorDate: row.anchorDate };
}

function compareDateId(a: { date: IsoDate; id: string }, b: { date: IsoDate; id: string }): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The largest k with occurrence(k) < date: the period just before a missed clock starts. */
function lastPeriodBefore(s: Schedule, date: IsoDate): number {
  let k = periodIndex(s, addDays(date, -1)).k;
  while (occurrence(s, k) >= date) k--;
  while (occurrence(s, k + 1) < date) k++;
  return k;
}

async function loadRow(tx: DbOrTx, id: string): Promise<StoredRecurring> {
  const [row] = await tx.select().from(recurring).where(eq(recurring.id, id));
  if (!row) throw new RecurringError(404, "not_found", "Recurring item not found");
  return row;
}

async function loadLinks(tx: DbOrTx, id: string): Promise<LinkedCharge[]> {
  return tx
    .select({ id: transaction.id, accountId: transaction.accountId, date: transaction.date, amountCents: transaction.amountCents })
    .from(transaction)
    .where(eq(transaction.recurringId, id))
    .orderBy(asc(transaction.date), asc(transaction.id));
}

/** Audit shape of a recurring row (cents as strings, the denormalised charge summary left out). */
export function recurringAuditJson(row: StoredRecurring) {
  return {
    id: row.id,
    payeeId: row.payeeId,
    categoryId: row.categoryId,
    accountId: row.accountId,
    transferAccountId: row.transferAccountId,
    name: row.name,
    cadence: row.cadence,
    anchorDay: row.anchorDay,
    anchorDay2: row.anchorDay2,
    anchorMonth: row.anchorMonth,
    anchorDate: row.anchorDate,
    expectedCents: row.expectedCents.toString(),
    toleranceCents: row.toleranceCents.toString(),
    amountMode: row.amountMode,
    amountLocked: row.amountLocked,
    scheduleLocked: row.scheduleLocked,
    source: row.source,
    status: row.status,
    statusReason: row.statusReason,
    notes: row.notes,
  };
}

// ---- Alerts ----

export interface RaiseAlertInput {
  kind: AlertKind;
  /** 'price:<recurringId>:<txId>' | 'new:<recurringId>' | 'missed:<recurringId>:<dueDate>' | 'trial:<payeeId>:<txId>' */
  dedupeKey: string;
  recurringId?: string | null;
  payeeId: string;
  transactionId?: string | null;
  dueDate?: IsoDate | null;
  oldCents?: bigint | null;
  newCents?: bigint | null;
}

/** Insert an alert; `on conflict (dedupe_key) do nothing`. False when it already existed. */
export async function raiseAlert(tx: DbOrTx, input: RaiseAlertInput): Promise<boolean> {
  const rows = await tx
    .insert(alert)
    .values({
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      recurringId: input.recurringId ?? null,
      payeeId: input.payeeId,
      transactionId: input.transactionId ?? null,
      dueDate: input.dueDate ?? null,
      oldCents: input.oldCents ?? null,
      newCents: input.newCents ?? null,
    })
    .onConflictDoNothing({ target: alert.dedupeKey })
    .returning({ id: alert.id });
  return rows.length > 0;
}

async function resolveAlerts(tx: DbOrTx, recurringId: string, kind: AlertKind, now: Date, dueDate?: IsoDate): Promise<void> {
  await tx
    .update(alert)
    .set({ resolvedAt: now })
    .where(and(eq(alert.recurringId, recurringId), eq(alert.kind, kind), isNull(alert.resolvedAt), dueDate ? eq(alert.dueDate, dueDate) : undefined));
}

// ---- Detection input ----

export interface DetectionInput {
  /** (payee, sign) groups keyed `${payeeId}|${sign}` (sign "1" | "-1"); charges in (date, id) order. */
  groups: Map<string, ChargeLike[]>;
  /** Earliest transaction date per account: the new-series history guard. */
  historyStartByAccount: Map<string, IsoDate>;
  /** Every outflow per payee, zero amounts included (trial-conversion detection). */
  outflowsByPayee: Map<string, ChargeLike[]>;
}

/**
 * Charges for the detector: non-transfer, posted (not pending) transactions with a payee
 * in the 36-month lookback, grouped by payee and sign (zero amounts excluded from the
 * series groups, kept for trial detection), plus each account's history start.
 */
export async function loadDetectionInput(db: DbOrTx, today: IsoDate): Promise<DetectionInput> {
  const from = addMonthsClamped(today, -LOOKBACK_MONTHS);
  const rows = await db
    .select({ id: transaction.id, accountId: transaction.accountId, payeeId: transaction.payeeId, date: transaction.date, amountCents: transaction.amountCents })
    .from(transaction)
    .where(
      and(
        isNotNull(transaction.payeeId),
        eq(transaction.isTransfer, false),
        eq(transaction.pending, false),
        gte(transaction.date, from),
        lte(transaction.date, today),
        // Phase 3: feed rows and rows linked to income investment rows never form a series (views design §3.13).
        notInvestmentIncomeRow(db),
      ),
    )
    .orderBy(asc(transaction.payeeId), asc(transaction.date), asc(transaction.id));

  const groups = new Map<string, ChargeLike[]>();
  const outflowsByPayee = new Map<string, ChargeLike[]>();
  for (const r of rows) {
    const payeeId = r.payeeId!;
    const charge: ChargeLike = { id: r.id, accountId: r.accountId, date: r.date, amountCents: r.amountCents };
    if (r.amountCents <= 0n) {
      const list = outflowsByPayee.get(payeeId) ?? [];
      list.push(charge);
      outflowsByPayee.set(payeeId, list);
    }
    if (r.amountCents === 0n) continue;
    const key = groupKey(payeeId, signOf(r.amountCents));
    const list = groups.get(key) ?? [];
    list.push(charge);
    groups.set(key, list);
  }

  const starts = await db
    .select({ accountId: transaction.accountId, min: sql<string>`min(${transaction.date})::text` })
    .from(transaction)
    .groupBy(transaction.accountId);
  const historyStartByAccount = new Map<string, IsoDate>();
  for (const s of starts) historyStartByAccount.set(s.accountId, s.min);

  return { groups, historyStartByAccount, outflowsByPayee };
}

/**
 * The rows of one (payee, sign) group with their links, read under `FOR UPDATE` inside the run's
 * transaction (audit decision A10, second round). The run maps and rewrites what these rows hold
 * now, not what they held when it started: an edit, confirm or dismiss that committed meanwhile
 * is what it builds on, and one still in flight is waited for (it holds the row) and then read.
 * An edit that starts after this read waits for the run instead and lands on top of its rewrite.
 * Ordered by (created_at, id), the identity mapping's tie order.
 */
async function lockGroupRows(tx: DbOrTx, payeeId: string, sign: 1n | -1n): Promise<RecurringRowWithLinks[]> {
  const rows = await tx
    .select()
    .from(recurring)
    .where(and(eq(recurring.payeeId, payeeId), sign < 0n ? lt(recurring.expectedCents, 0n) : gte(recurring.expectedCents, 0n)))
    .orderBy(asc(recurring.createdAt), asc(recurring.id))
    .for("update");
  if (rows.length === 0) return [];
  const links = await tx
    .select({ id: transaction.id, recurringId: transaction.recurringId })
    .from(transaction)
    .where(inArray(transaction.recurringId, rows.map((r) => r.id)));
  const linksByRow = new Map<string, string[]>();
  for (const l of links) {
    const list = linksByRow.get(l.recurringId!) ?? [];
    list.push(l.id);
    linksByRow.set(l.recurringId!, list);
  }
  return rows.map((row) => ({ ...row, linkedIds: linksByRow.get(row.id) ?? [] }));
}

/** The (payee, sign) group keys that have a cancelled row: those groups are upserted even without a detection. */
async function groupsWithCancelledRows(tx: DbOrTx): Promise<Set<string>> {
  const rows = await tx.selectDistinct({ payeeId: recurring.payeeId, outflow: sql<boolean>`${recurring.expectedCents} < 0` }).from(recurring).where(eq(recurring.status, "cancelled"));
  return new Set(rows.map((r) => groupKey(r.payeeId, r.outflow ? -1n : 1n)));
}

/** The most common category among the given transactions (tie → smaller id); null when none is categorized. */
async function modalCategory(tx: DbOrTx, transactionIds: readonly string[]): Promise<string | null> {
  if (transactionIds.length === 0) return null;
  const [row] = await tx
    .select({ categoryId: transaction.categoryId, n: sql<number>`count(*)::int` })
    .from(transaction)
    .where(and(inArray(transaction.id, [...transactionIds]), isNotNull(transaction.categoryId)))
    .groupBy(transaction.categoryId)
    .orderBy(sql`count(*) desc`, asc(transaction.categoryId))
    .limit(1);
  return row?.categoryId ?? null;
}

function detectionColumns(d: Detection, chargeCount: number): RecurringPatch {
  return {
    cadence: d.schedule.cadence,
    anchorDay: d.schedule.anchorDay ?? null,
    anchorDay2: d.schedule.anchorDay2 ?? null,
    anchorMonth: d.schedule.anchorMonth ?? null,
    anchorDate: d.schedule.anchorDate ?? null,
    expectedCents: d.expectedCents,
    toleranceCents: d.toleranceCents,
    amountMode: d.amountMode,
    confidence: d.confidence,
    nextDueDate: d.nextDueDate,
    firstChargeDate: d.firstChargeDate,
    lastChargeDate: d.lastChargeDate,
    lastChargeCents: d.lastChargeCents,
    lastTransactionId: d.lastTransactionId,
    accountId: d.accountId,
    chargeCount,
    consecutiveMissed: 0,
  };
}

export interface UpsertStats {
  created: number;
  updated: number;
  alertsCreated: number;
}

/** The occurrence after the period of `lastChargeDate` on `schedule`, or `fallback` when the schedule is not valid. */
function nextDueAfter(schedule: Schedule, lastChargeDate: IsoDate, fallback: IsoDate): IsoDate {
  if (validateSchedule(schedule) !== null) return fallback;
  return occurrence(schedule, periodIndex(schedule, lastChargeDate).k + 1);
}

/**
 * The rewrite of a mapped suggestion (audit decision A10): the detector refreshes what the owner
 * has not taken over. A locked amount keeps expected, tolerance and mode; a locked schedule keeps
 * cadence and anchors (next due follows the locked schedule); a category is only filled when the
 * row has none; the account follows the detection only when its last charge is a new one, so an
 * account the owner chose stands until a later charge arrives.
 */
function suggestionRewrite(best: StoredRecurring, d: Detection, chargeCount: number, categoryId: string | null): RecurringPatch {
  const set: RecurringPatch = { ...detectionColumns(d, chargeCount) };
  if (best.amountLocked) {
    delete set.expectedCents;
    delete set.toleranceCents;
    delete set.amountMode;
  }
  if (best.scheduleLocked) {
    delete set.cadence;
    delete set.anchorDay;
    delete set.anchorDay2;
    delete set.anchorMonth;
    delete set.anchorDate;
    set.nextDueDate = nextDueAfter(scheduleOf(best), d.lastChargeDate, d.nextDueDate);
  }
  if (best.categoryId === null) set.categoryId = categoryId;
  if (best.accountId !== null && best.lastTransactionId === d.lastTransactionId) delete set.accountId;
  return set;
}

/** The pure engine threw for one group inside `upsertDetections`, before it wrote anything. */
class DetectionEngineError extends Error {
  constructor(readonly engineError: unknown) {
    super("recurring detection failed for one payee group");
  }
}

/**
 * A cancelled row keeps the series it was cancelled with: charges dated after its cancel cannot
 * belong to it. The group's charges after the cancel (`status_changed_at`) that no cancelled row
 * holds are detected on their own (audit decision A11), whether or not a detection of the whole
 * group mapped to the row: a resubscription billed on another day does not score as one series
 * with the old charges, so the whole group often yields nothing.
 */
function resubscriptionDetections(cancelled: RecurringRowWithLinks, endedIds: ReadonlySet<string>, groupCharges: readonly ChargeLike[], today: IsoDate): Detection[] {
  const cancelledOn = cancelled.statusChangedAt.toISOString().slice(0, 10);
  const after = groupCharges.filter((c) => c.date > cancelledOn && !endedIds.has(c.id));
  return after.length >= MIN_CHARGES ? detectRecurring(after, today) : [];
}

/**
 * Map one group's detections onto its rows by link overlap (largest overlap wins, tie → oldest
 * row; each row is claimed once). The rows are read here under lock (`lockGroupRows`), so the
 * mapping and the rewrite use what the owner has done up to now. A mapped suggestion is
 * rewritten in place (keeping what the owner locked or chose, `suggestionRewrite`) and relinked;
 * a mapped row of any other status only gets `detected_at` (its parameters and links belong to
 * the user and the matcher). An unmapped detection inserts a new suggestion, with a
 * `new_recurring` alert for a new outflow series.
 *
 * Then every cancelled row of the group hands the charges after its cancel to detections of
 * their own (`resubscriptionDetections`), mapped the same way: the suggestion of an earlier run
 * is updated in place, a dismissed one absorbs them as designed, and a new series becomes a
 * suggestion. Such a detection is dropped when it shares a charge with a series this run already
 * placed on a row that is not cancelled (another series of the payee, or a resubscription the
 * whole group already proposes), so nothing is suggested twice. `groupCharges` is the group the
 * detections came from.
 */
export async function upsertDetections(
  tx: DbOrTx,
  payeeId: string,
  sign: 1n | -1n,
  detections: readonly Detection[],
  runStart: Date,
  today: IsoDate,
  historyStartByAccount: ReadonlyMap<string, IsoDate>,
  groupCharges: readonly ChargeLike[] = [],
): Promise<UpsertStats> {
  const stats: UpsertStats = { created: 0, updated: 0, alertsCreated: 0 };
  const candidates = await lockGroupRows(tx, payeeId, sign);
  const cancelled = candidates.filter((r) => r.status === "cancelled");
  if (detections.length === 0 && cancelled.length === 0) return stats;
  // Detected before anything is written, so an engine error leaves the group's rows untouched.
  const endedIds = new Set(cancelled.flatMap((r) => r.linkedIds));
  let resubscriptions: Detection[][];
  try {
    resubscriptions = cancelled.map((c) => resubscriptionDetections(c, endedIds, groupCharges, today));
  } catch (error) {
    throw new DetectionEngineError(error);
  }
  const claimed = new Set<string>();
  // Charges linked to a user-owned row are never re-pointed by the detector.
  const protectedIds = new Set(candidates.filter((r) => r.status !== "suggested").flatMap((r) => r.linkedIds));
  // Charges of the series this run placed on a row that is not cancelled, or inserted.
  const covered = new Set<string>();
  const [payeeRow] = await tx.select({ name: payee.name, defaultCategoryId: payee.defaultCategoryId }).from(payee).where(eq(payee.id, payeeId));
  if (!payeeRow) return stats;

  const place = async (d: Detection): Promise<void> => {
    const onCycle = new Set(d.onCycleIds);
    let best: RecurringRowWithLinks | undefined;
    let bestOverlap = 0;
    for (const r of candidates) {
      if (claimed.has(r.id)) continue;
      const overlap = r.linkedIds.filter((id) => onCycle.has(id)).length;
      if (overlap === 0) continue;
      const older = best !== undefined && (r.createdAt < best.createdAt || (r.createdAt.getTime() === best.createdAt.getTime() && r.id < best.id));
      if (overlap > bestOverlap || (overlap === bestOverlap && older)) {
        best = r;
        bestOverlap = overlap;
      }
    }

    if (best) {
      claimed.add(best.id);
      if (best.status !== "cancelled") for (const id of [...d.onCycleIds, ...best.linkedIds]) covered.add(id);
      if (best.status !== "suggested") {
        await tx.update(recurring).set({ detectedAt: runStart }).where(eq(recurring.id, best.id));
        return;
      }
      const linkIds = d.onCycleIds.filter((id) => !protectedIds.has(id));
      const categoryId = best.categoryId ?? (await modalCategory(tx, linkIds)) ?? payeeRow.defaultCategoryId ?? null;
      await tx
        .update(recurring)
        .set({ ...suggestionRewrite(best, d, linkIds.length, categoryId), detectedAt: runStart, updatedAt: runStart })
        .where(eq(recurring.id, best.id));
      const drop = best.linkedIds.filter((id) => !onCycle.has(id));
      if (drop.length > 0) await tx.update(transaction).set({ recurringId: null }).where(and(inArray(transaction.id, drop), eq(transaction.recurringId, best.id)));
      if (linkIds.length > 0) await tx.update(transaction).set({ recurringId: best.id }).where(inArray(transaction.id, linkIds));
      stats.updated++;
      return;
    }

    for (const id of d.onCycleIds) covered.add(id);
    const linkIds = d.onCycleIds.filter((id) => !protectedIds.has(id));
    const categoryId = (await modalCategory(tx, linkIds)) ?? payeeRow.defaultCategoryId ?? null;
    const [inserted] = await tx
      .insert(recurring)
      .values({
        ...detectionColumns(d, linkIds.length),
        payeeId,
        categoryId,
        name: payeeRow.name,
        cadence: d.schedule.cadence,
        expectedCents: d.expectedCents,
        source: "detected",
        status: "suggested",
        statusChangedAt: runStart,
        detectedAt: runStart,
        createdAt: runStart,
        updatedAt: runStart,
      })
      .returning({ id: recurring.id });
    const id = inserted!.id;
    if (linkIds.length > 0) await tx.update(transaction).set({ recurringId: id }).where(inArray(transaction.id, linkIds));
    stats.created++;
    // B9: the history of the account the series started on, not the one it is charged to now.
    const historyStart = historyStartByAccount.get(d.firstAccountId) ?? d.firstChargeDate;
    if (d.expectedCents < 0n && isNewSeries(d.firstChargeDate, historyStart, today)) {
      if (await raiseAlert(tx, { kind: "new_recurring", dedupeKey: `new:${id}`, recurringId: id, payeeId })) stats.alertsCreated++;
    }
  };

  for (const d of detections) await place(d);
  for (const d of resubscriptions.flat()) {
    if (d.onCycleIds.some((id) => covered.has(id))) continue;
    await place(d);
  }
  return stats;
}

export interface DetectionRunStats {
  groups: number;
  suggestionsCreated: number;
  suggestionsUpdated: number;
  suggestionsDeleted: number;
  groupsSkipped: number;
  itemsMatched: number;
  alertsCreated: number;
}

export interface DetectionRunOptions {
  today: IsoDate;
  now: Date;
  /** Called when the engine throws for one payee group; that group is skipped and its rows left untouched. */
  onGroupError?: (payeeId: string, error: unknown) => void;
}

/**
 * The `recurring.detect` job: one full run in one transaction. Every (payee, sign) group is
 * detected and upserted; suggestions the run did not reproduce are deleted (links nulled,
 * alerts cascade); then the matcher links new charges to live items and refreshes them, and
 * trial conversions raise their alerts. Idempotent: a second run with the same ledger
 * changes nothing but `detected_at`.
 */
export async function runRecurringDetection(db: Db, opts: DetectionRunOptions): Promise<DetectionRunStats> {
  const { today, now: runStart } = opts;
  const stats: DetectionRunStats = { groups: 0, suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsDeleted: 0, groupsSkipped: 0, itemsMatched: 0, alertsCreated: 0 };

  await db.transaction(async (tx) => {
    const input = await loadDetectionInput(tx, today);
    const cancelledKeys = await groupsWithCancelledRows(tx);
    const skippedPayees = new Set<string>();

    for (const [key, charges] of input.groups) {
      stats.groups++;
      const { payeeId, sign } = parseGroupKey(key);
      let detections: Detection[];
      try {
        detections = detectRecurring(charges, today);
      } catch (error) {
        skippedPayees.add(payeeId);
        stats.groupsSkipped++;
        opts.onGroupError?.(payeeId, error);
        continue;
      }
      if (detections.length === 0 && !cancelledKeys.has(key)) continue;
      let r: UpsertStats;
      try {
        r = await upsertDetections(tx, payeeId, sign, detections, runStart, today, input.historyStartByAccount, charges);
      } catch (error) {
        if (!(error instanceof DetectionEngineError)) throw error;
        skippedPayees.add(payeeId);
        stats.groupsSkipped++;
        opts.onGroupError?.(payeeId, error.engineError);
        continue;
      }
      stats.suggestionsCreated += r.created;
      stats.suggestionsUpdated += r.updated;
      stats.alertsCreated += r.alertsCreated;
    }

    const stale = await tx
      .select({ id: recurring.id })
      .from(recurring)
      .where(
        and(
          eq(recurring.status, "suggested"),
          eq(recurring.source, "detected"),
          skippedPayees.size > 0 ? notInArray(recurring.payeeId, [...skippedPayees]) : undefined,
          or(isNull(recurring.detectedAt), lt(recurring.detectedAt, runStart)),
        ),
      )
      // Locked and re-checked: a suggestion confirmed or dismissed meanwhile is no longer one, and is kept.
      .for("update");
    if (stale.length > 0) {
      const ids = stale.map((s) => s.id);
      await tx.update(transaction).set({ recurringId: null }).where(inArray(transaction.recurringId, ids));
      await tx.delete(recurring).where(inArray(recurring.id, ids));
      stats.suggestionsDeleted = ids.length;
    }

    const matchStats = { alertsCreated: 0 };
    stats.itemsMatched = await matchRecurringItems(tx, today, runStart, { stats: matchStats });
    stats.alertsCreated += matchStats.alertsCreated;

    for (const [payeeId, outflows] of input.outflowsByPayee) {
      const trial = detectTrialConversion(outflows, today);
      if (!trial) continue;
      const raised = await raiseAlert(tx, {
        kind: "trial_converted",
        dedupeKey: `trial:${payeeId}:${trial.firstFull.id}`,
        payeeId,
        transactionId: trial.firstFull.id,
        newCents: trial.firstFull.amountCents,
      });
      if (raised) stats.alertsCreated++;
    }
  });

  return stats;
}

// ---- Matcher ----

interface SiblingRow {
  id: string;
  payeeId: string;
  expectedCents: bigint;
  accountId: string | null;
}

/** Link the unlinked charges of one item's payee to free periods (C2); returns the newly linked ids in date order. */
async function matchOne(tx: DbOrTx, item: StoredRecurring, siblings: readonly SiblingRow[], today: IsoDate): Promise<string[]> {
  const schedule = scheduleOf(item);
  if (validateSchedule(schedule) !== null) return [];
  const sign = signOf(item.expectedCents);
  // Two live items of one payee on different accounts (two Spotify accounts) each keep to their own account.
  const restrictToAccount = siblings.some((s) => s.id !== item.id && s.payeeId === item.payeeId && signOf(s.expectedCents) === sign && s.accountId !== item.accountId);
  const period = nominalPeriodDays(item.cadence);
  const dateFilter = item.lastChargeDate
    ? gt(transaction.date, item.lastChargeDate)
    : gte(transaction.date, addDays(item.missedFromDate ?? today, -period));
  const candidates = await tx
    .select({ id: transaction.id, date: transaction.date, amountCents: transaction.amountCents })
    .from(transaction)
    .where(
      and(
        eq(transaction.payeeId, item.payeeId),
        isNull(transaction.recurringId),
        eq(transaction.isTransfer, false),
        ne(transaction.amountCents, 0n),
        sign < 0n ? lt(transaction.amountCents, 0n) : gt(transaction.amountCents, 0n),
        dateFilter,
        restrictToAccount ? (item.accountId ? eq(transaction.accountId, item.accountId) : sql`false`) : undefined,
        notInvestmentIncomeRow(tx),
      ),
    )
    .orderBy(asc(transaction.date), asc(transaction.id));
  if (candidates.length === 0) return [];

  const expectedAbs = absBig(item.expectedCents);
  const linked = await loadLinks(tx, item.id);
  // Amount gate: fixed → ½× to 2× the expected amount; variable → ⅓× the smallest to 3× the
  // largest of the expected amount and the last six linked charges, so a seasonal bill whose
  // winter charges swing past 3× its median keeps matching (audit decision A9).
  const gate = item.amountMode === "fixed" ? 2n : 3n;
  const band = item.amountMode === "fixed" ? [] : linked.slice(-6).map((l) => absBig(l.amountCents));
  const gateLow = band.reduce((m, a) => (a < m ? a : m), expectedAbs);
  const gateHigh = band.reduce((m, a) => (a > m ? a : m), expectedAbs);
  const kLast = item.lastChargeDate ? periodIndex(schedule, item.lastChargeDate).k : Number.NEGATIVE_INFINITY;
  const taken = new Set(linked.map((l) => periodIndex(schedule, l.date).k));
  const grace = graceDays(item.cadence);

  const bestByPeriod = new Map<number, { id: string; date: IsoDate; residual: number }>();
  for (const c of candidates) {
    const a = absBig(c.amountCents);
    if (gate * a < gateLow || a > gate * gateHigh) continue;
    const { k, residualDays } = periodIndex(schedule, c.date);
    if (!(k > kLast) || taken.has(k)) continue;
    const onTime = Math.abs(residualDays) <= grace;
    const onAmount = absBig(a - expectedAbs) <= item.toleranceCents;
    if (!onTime && !onAmount) continue;
    const residual = Math.abs(residualDays);
    const cur = bestByPeriod.get(k);
    if (!cur || residual < cur.residual || (residual === cur.residual && compareDateId(c, cur) < 0)) bestByPeriod.set(k, { id: c.id, date: c.date, residual });
  }
  const chosen = [...bestByPeriod.values()].sort(compareDateId).map((b) => b.id);
  if (chosen.length > 0) await tx.update(transaction).set({ recurringId: item.id }).where(inArray(transaction.id, chosen));
  return chosen;
}

export interface MatchOptions {
  /** Only these items (e.g. a just-created manual item); default every live item. */
  ids?: string[];
  /** Accumulates the alerts raised by the refreshes this call performs. */
  stats?: { alertsCreated: number };
}

/**
 * Link new charges to every active, paused and dismissed item (suggestions belong to the
 * detector; cancelled items never match) and refresh each one. Returns the number of items
 * that gained at least one link.
 */
export async function matchRecurringItems(tx: DbOrTx, today: IsoDate, now: Date, opts: MatchOptions = {}): Promise<number> {
  if (opts.ids && opts.ids.length === 0) return 0;
  const items = await tx
    .select()
    .from(recurring)
    .where(and(inArray(recurring.status, [...LIVE_STATUSES]), opts.ids ? inArray(recurring.id, opts.ids) : undefined))
    .orderBy(asc(recurring.createdAt), asc(recurring.id));
  if (items.length === 0) return 0;
  const siblings: SiblingRow[] = await tx
    .select({ id: recurring.id, payeeId: recurring.payeeId, expectedCents: recurring.expectedCents, accountId: recurring.accountId })
    .from(recurring)
    .where(inArray(recurring.status, ["active", "paused"]));

  let matched = 0;
  for (const item of items) {
    const newlyLinkedIds = await matchOne(tx, item, siblings, today);
    if (newlyLinkedIds.length > 0) matched++;
    const r = await refreshRecurringItem(tx, item.id, today, now, { newlyLinkedIds });
    if (opts.stats) opts.stats.alertsCreated += r.alertsCreated;
  }
  return matched;
}

// ---- Refresh ----

export interface RefreshResult {
  alertsCreated: number;
  autoPaused: boolean;
}

/**
 * Recompute the derived state of one item from its links, its locks and `today` (C3):
 * charge summary; the account, which follows the last charge when that charge is newly
 * linked (so an account the owner chose stands until a later charge arrives, audit decision
 * A12); amounts (unless amount_locked); anchors (unless schedule_locked); missed evaluation
 * with one `missed_charge` alert per missed occurrence and auto-pause after three (active
 * items); `next_due_date`; `price_increase` alerts for fixed outflows on newly linked charges;
 * and resolution of the missed alert a late charge belongs to. Idempotent.
 */
export async function refreshRecurringItem(tx: DbOrTx, id: string, today: IsoDate, now: Date, opts: { newlyLinkedIds?: string[] } = {}): Promise<RefreshResult> {
  const result: RefreshResult = { alertsCreated: 0, autoPaused: false };
  const [row] = await tx.select().from(recurring).where(eq(recurring.id, id));
  if (!row) return result;
  const links = await loadLinks(tx, id);
  const set: RecurringPatch = { updatedAt: now };
  const previousSchedule = scheduleOf(row);
  const previousLastCents = row.lastChargeCents;
  const previousLastDate = row.lastChargeDate;
  const previousTolerance = row.toleranceCents;
  const previousMode = row.amountMode;
  const sign = signOf(row.expectedCents);
  let schedule = previousSchedule;
  let lastChargeDate: IsoDate | null = null;
  const newlyLinked = new Set(opts.newlyLinkedIds ?? []);

  const last = links[links.length - 1];
  if (last) {
    lastChargeDate = last.date;
    set.firstChargeDate = links[0]!.date;
    set.lastChargeDate = last.date;
    set.lastChargeCents = last.amountCents;
    set.lastTransactionId = last.id;
    set.chargeCount = links.length;
    if (newlyLinked.has(last.id)) set.accountId = last.accountId;
    if (!row.amountLocked) {
      const amounts = classifyAmounts(links.map((l) => absBig(l.amountCents)));
      set.expectedCents = sign * amounts.expectedAbs;
      set.toleranceCents = amounts.toleranceCents;
      set.amountMode = amounts.mode;
    }
    if (!row.scheduleLocked) {
      if (isWeekBased(row.cadence)) {
        schedule = { ...schedule, anchorDate: last.date };
      } else if (row.cadence === "twice_monthly") {
        const fit = fitSchedule(
          links.slice(-12).map((l) => l.date),
          "twice_monthly",
        );
        if (fit) schedule = { ...schedule, anchorDay: fit.anchorDay ?? null, anchorDay2: fit.anchorDay2 ?? null };
      } else {
        schedule = { ...schedule, anchorDay: upperMedian(links.slice(-6).map((l) => effectiveDay(l.date))) };
      }
      set.anchorDate = schedule.anchorDate ?? null;
      set.anchorDay = schedule.anchorDay ?? null;
      set.anchorDay2 = schedule.anchorDay2 ?? null;
    }
  } else {
    set.firstChargeDate = null;
    set.lastChargeDate = null;
    set.lastChargeCents = null;
    set.lastTransactionId = null;
    set.chargeCount = 0;
  }

  let consecutiveMissed = 0;
  let nextDueDate: IsoDate | null = null;
  if (validateSchedule(schedule) === null && row.status !== "cancelled") {
    const kLast = lastChargeDate ? periodIndex(schedule, lastChargeDate).k : lastPeriodBefore(schedule, row.missedFromDate ?? today);
    let k = kLast + 1;
    if (row.status === "active") {
      // Occurrences before the missed clock started (resume, manual create) are skipped.
      const floor = row.missedFromDate ?? today;
      for (let guard = 0; guard < 10_000; guard++, k++) {
        const due = occurrence(schedule, k);
        if (due < floor) continue;
        if (!isMissed(due, today, row.cadence)) break;
        if (await raiseAlert(tx, { kind: "missed_charge", dedupeKey: `missed:${id}:${due}`, recurringId: id, payeeId: row.payeeId, dueDate: due })) result.alertsCreated++;
        consecutiveMissed++;
      }
    } else if (row.status !== "suggested") {
      // paused, dismissed: the next occurrence on or after today.
      for (let guard = 0; guard < 10_000 && occurrence(schedule, k) < today; guard++) k++;
    }
    nextDueDate = occurrence(schedule, k);
  }
  set.consecutiveMissed = consecutiveMissed;
  set.nextDueDate = nextDueDate;
  if (row.status === "active" && consecutiveMissed >= AUTO_PAUSE_AFTER_MISSED) {
    set.status = "paused";
    set.statusReason = "missed_3";
    set.statusChangedAt = now;
    result.autoPaused = true;
  }

  if (newlyLinked.size > 0) {
    let baseline = previousLastCents;
    for (const l of links) {
      if (!newlyLinked.has(l.id)) continue;
      // Price increases are about charges (spec step 5): a raise on a paycheck is not one.
      if (row.status === "active" && sign < 0n && previousMode === "fixed" && baseline !== null && (previousLastDate === null || l.date >= previousLastDate)) {
        if (absBig(l.amountCents) - absBig(baseline) > previousTolerance) {
          const raised = await raiseAlert(tx, {
            kind: "price_increase",
            dedupeKey: `price:${id}:${l.id}`,
            recurringId: id,
            payeeId: row.payeeId,
            transactionId: l.id,
            oldCents: baseline,
            newCents: l.amountCents,
          });
          if (raised) result.alertsCreated++;
        }
        baseline = l.amountCents;
      }
      if (validateSchedule(previousSchedule) === null) {
        const due = occurrence(previousSchedule, periodIndex(previousSchedule, l.date).k);
        await resolveAlerts(tx, id, "missed_charge", now, due);
      }
    }
  }

  await tx.update(recurring).set(set).where(eq(recurring.id, id));
  return result;
}

// ---- Status transitions (C4) ----

const TRANSITIONS: Record<RecurringStatus, readonly RecurringStatus[]> = {
  suggested: ["active", "dismissed"],
  active: ["paused", "cancelled"],
  paused: ["active", "cancelled"],
  cancelled: ["active"],
  dismissed: ["active"],
};

export interface StatusOptions {
  today: IsoDate;
  now: Date;
  audit?: AuditContext;
}

/**
 * Move an item to a new status. suggested → active (confirm) needs a category and an account, starts the
 * missed clock at the last charge, resolves the new_recurring alert and fills the payee's
 * default category; suggested → dismissed keeps the links so the series stays dismissed;
 * paused/cancelled/dismissed → active start the missed clock today; cancel clears
 * next_due_date. Same status is a no-op; anything else is 400 `invalid_transition`.
 */
export async function setRecurringStatus(tx: DbOrTx, id: string, status: RecurringStatus, opts: StatusOptions): Promise<void> {
  const row = await loadRow(tx, id);
  if (row.status === status) return;
  if (!TRANSITIONS[row.status].includes(status)) {
    throw new RecurringError(400, "invalid_transition", `A ${row.status} item cannot become ${status}`);
  }
  const { today, now } = opts;
  const set: RecurringPatch = { status, statusReason: null, statusChangedAt: now, updatedAt: now };
  if (status === "active") {
    if (!row.categoryId) throw new RecurringError(400, "category_required", "Pick a category before activating");
    if (!row.accountId) throw new RecurringError(400, "account_required", "Pick the account it is charged to before activating");
    set.consecutiveMissed = 0;
    set.missedFromDate = row.status === "suggested" ? (row.lastChargeDate ?? today) : today;
    await tx.update(payee).set({ defaultCategoryId: row.categoryId }).where(and(eq(payee.id, row.payeeId), isNull(payee.defaultCategoryId)));
  }
  if (row.status === "suggested" || (status === "active" && row.status === "dismissed")) await resolveAlerts(tx, id, "new_recurring", now);
  if (status === "cancelled") {
    set.nextDueDate = null;
    set.consecutiveMissed = 0;
  }
  await tx.update(recurring).set(set).where(eq(recurring.id, id));
  await refreshRecurringItem(tx, id, today, now);
  if (opts.audit) {
    const after = await loadRow(tx, id);
    await writeAudit(tx, { ...opts.audit, entity: "recurring", entityId: id, action: "update", before: recurringAuditJson(row), after: recurringAuditJson(after) });
  }
}

// ---- Manual items and edits ----

interface ScheduleColumns {
  anchorDay: number | null;
  anchorDay2: number | null;
  anchorMonth: number | null;
  anchorDate: IsoDate | null;
}

function intInRange(value: number | null | undefined, min: number, max: number, what: string): void {
  if (value == null) return;
  if (!Number.isInteger(value) || value < min || value > max) throw new RecurringError(400, "validation", `${what} must be between ${min} and ${max}`);
}

/** Validate a schedule and keep only the anchors its cadence uses. */
function normalizeSchedule(s: Schedule): ScheduleColumns {
  intInRange(s.anchorDay, 1, 31, "anchorDay");
  intInRange(s.anchorDay2, 1, 31, "anchorDay2");
  intInRange(s.anchorMonth, 1, 12, "anchorMonth");
  if (s.anchorDate != null && !isIsoDate(s.anchorDate)) throw new RecurringError(400, "validation", "anchorDate must be YYYY-MM-DD");
  const problem = validateSchedule(s);
  if (problem) throw new RecurringError(400, "validation", problem);
  if (isWeekBased(s.cadence)) return { anchorDay: null, anchorDay2: null, anchorMonth: null, anchorDate: s.anchorDate! };
  if (s.cadence === "twice_monthly") {
    if (s.anchorDay2 != null && s.anchorDay2 <= s.anchorDay!) throw new RecurringError(400, "validation", "anchorDay2 must be after anchorDay");
    return { anchorDay: s.anchorDay!, anchorDay2: s.anchorDay2 ?? null, anchorMonth: null, anchorDate: null };
  }
  if (s.cadence === "monthly") return { anchorDay: s.anchorDay!, anchorDay2: null, anchorMonth: null, anchorDate: null };
  return { anchorDay: s.anchorDay!, anchorDay2: null, anchorMonth: s.anchorMonth!, anchorDate: null };
}

async function assertCategory(tx: DbOrTx, categoryId: string): Promise<void> {
  const [row] = await tx.select({ id: category.id }).from(category).where(eq(category.id, categoryId));
  if (!row) throw new RecurringError(400, "validation", "Category not found");
}

async function assertAccount(tx: DbOrTx, accountId: string, what: string): Promise<void> {
  const [row] = await tx.select({ id: account.id }).from(account).where(eq(account.id, accountId));
  if (!row) throw new RecurringError(400, "validation", `${what} not found`);
}

export interface CreateRecurringInput {
  name: string;
  /** One of payeeId / payeeName (the name resolves or creates the payee). */
  payeeId?: string;
  payeeName?: string;
  categoryId: string;
  accountId?: string | null;
  transferAccountId?: string | null;
  cadence: Cadence;
  anchorDay?: number | null;
  anchorDay2?: number | null;
  anchorMonth?: number | null;
  anchorDate?: IsoDate | null;
  /** Signed, non-zero. */
  expectedCents: bigint;
  /** Default max(100, |expected| / 100). */
  toleranceCents?: bigint;
  amountMode?: AmountMode;
  notes?: string | null;
}

/**
 * A hand-made item: source manual, status active, both locks on, missed clock from today;
 * then the matcher links the current period's charge. Returns the new id.
 */
export async function createManualRecurring(tx: DbOrTx, input: CreateRecurringInput, today: IsoDate, opts: { now?: Date; audit?: AuditContext } = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const name = input.name.trim();
  if (!name) throw new RecurringError(400, "validation", "Name is required");
  if (input.expectedCents === 0n) throw new RecurringError(400, "validation", "expectedCents must not be zero");
  if (input.toleranceCents !== undefined && input.toleranceCents < 0n) throw new RecurringError(400, "validation", "toleranceCents must not be negative");
  if ((input.payeeId === undefined) === (input.payeeName === undefined)) throw new RecurringError(400, "validation", "Give payeeId or payeeName, not both");

  let payeeId: string;
  if (input.payeeId !== undefined) {
    const [p] = await tx.select({ id: payee.id }).from(payee).where(eq(payee.id, input.payeeId));
    if (!p) throw new RecurringError(400, "validation", "Payee not found");
    payeeId = p.id;
  } else {
    payeeId = (await resolvePayee(tx, input.payeeName!)).id;
  }
  await assertCategory(tx, input.categoryId);
  // The item is active from the start, and an active item needs an account (plan decision 12).
  if (!input.accountId) throw new RecurringError(400, "account_required", "Pick the account it is charged to");
  await assertAccount(tx, input.accountId, "Account");
  if (input.transferAccountId) await assertAccount(tx, input.transferAccountId, "Transfer account");
  const anchors = normalizeSchedule({
    cadence: input.cadence,
    anchorDay: input.anchorDay ?? null,
    anchorDay2: input.anchorDay2 ?? null,
    anchorMonth: input.anchorMonth ?? null,
    anchorDate: input.anchorDate ?? null,
  });
  const toleranceCents = input.toleranceCents ?? maxBig(100n, truncDiv(absBig(input.expectedCents), 100n));

  const [row] = await tx
    .insert(recurring)
    .values({
      payeeId,
      categoryId: input.categoryId,
      accountId: input.accountId,
      transferAccountId: input.transferAccountId ?? null,
      name,
      cadence: input.cadence,
      ...anchors,
      expectedCents: input.expectedCents,
      toleranceCents,
      amountMode: input.amountMode ?? "fixed",
      amountLocked: true,
      scheduleLocked: true,
      missedFromDate: today,
      source: "manual",
      status: "active",
      statusChangedAt: now,
      notes: input.notes ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const id = row!.id;
  await matchRecurringItems(tx, today, now, { ids: [id] });
  if (opts.audit) {
    const after = await loadRow(tx, id);
    await writeAudit(tx, { ...opts.audit, entity: "recurring", entityId: id, action: "create", before: null, after: recurringAuditJson(after) });
  }
  return id;
}

export interface UpdateRecurringInput {
  name?: string;
  categoryId?: string | null;
  accountId?: string | null;
  transferAccountId?: string | null;
  cadence?: Cadence;
  anchorDay?: number | null;
  anchorDay2?: number | null;
  anchorMonth?: number | null;
  anchorDate?: IsoDate | null;
  expectedCents?: bigint;
  toleranceCents?: bigint;
  amountMode?: AmountMode;
  notes?: string | null;
  status?: "active" | "paused" | "cancelled" | "dismissed";
}

/**
 * Apply a user edit. Amount fields set amount_locked, schedule fields set schedule_locked
 * (the merged schedule is validated), a chosen account stands until a later charge is linked,
 * an active item keeps a category and an account (400 category_required, account_required), a
 * status goes through `setRecurringStatus`, and every edit ends with a refresh so
 * next_due_date is current.
 */
export async function updateRecurring(tx: DbOrTx, id: string, patch: UpdateRecurringInput, today: IsoDate, now: Date, opts: { audit?: AuditContext } = {}): Promise<void> {
  const row = await loadRow(tx, id);
  const set: RecurringPatch = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new RecurringError(400, "validation", "Name is required");
    set.name = name;
  }
  if (patch.categoryId !== undefined) {
    if (patch.categoryId) await assertCategory(tx, patch.categoryId);
    set.categoryId = patch.categoryId;
  }
  if (patch.accountId !== undefined) {
    if (patch.accountId) await assertAccount(tx, patch.accountId, "Account");
    set.accountId = patch.accountId;
  }
  if (patch.transferAccountId !== undefined) {
    if (patch.transferAccountId) await assertAccount(tx, patch.transferAccountId, "Transfer account");
    set.transferAccountId = patch.transferAccountId;
  }
  if (patch.notes !== undefined) set.notes = patch.notes;

  const scheduleEdited =
    patch.cadence !== undefined || patch.anchorDay !== undefined || patch.anchorDay2 !== undefined || patch.anchorMonth !== undefined || patch.anchorDate !== undefined;
  if (scheduleEdited) {
    const cadence = patch.cadence ?? row.cadence;
    const anchors = normalizeSchedule({
      cadence,
      anchorDay: patch.anchorDay !== undefined ? patch.anchorDay : row.anchorDay,
      anchorDay2: patch.anchorDay2 !== undefined ? patch.anchorDay2 : row.anchorDay2,
      anchorMonth: patch.anchorMonth !== undefined ? patch.anchorMonth : row.anchorMonth,
      anchorDate: patch.anchorDate !== undefined ? patch.anchorDate : row.anchorDate,
    });
    Object.assign(set, { cadence, ...anchors, scheduleLocked: true });
  }

  const amountEdited = patch.expectedCents !== undefined || patch.toleranceCents !== undefined || patch.amountMode !== undefined;
  if (amountEdited) {
    if (patch.expectedCents !== undefined) {
      if (patch.expectedCents === 0n) throw new RecurringError(400, "validation", "expectedCents must not be zero");
      if (row.chargeCount > 0 && signOf(patch.expectedCents) !== signOf(row.expectedCents)) {
        throw new RecurringError(400, "validation", "expectedCents must keep the item's direction");
      }
      set.expectedCents = patch.expectedCents;
    }
    if (patch.toleranceCents !== undefined) {
      if (patch.toleranceCents < 0n) throw new RecurringError(400, "validation", "toleranceCents must not be negative");
      set.toleranceCents = patch.toleranceCents;
    }
    if (patch.amountMode !== undefined) set.amountMode = patch.amountMode;
    set.amountLocked = true;
  }

  const finalStatus = patch.status ?? row.status;
  const finalCategory = patch.categoryId !== undefined ? patch.categoryId : row.categoryId;
  const finalAccount = patch.accountId !== undefined ? patch.accountId : row.accountId;
  if (finalStatus === "active" && !finalCategory) throw new RecurringError(400, "category_required", "An active item needs a category");
  // Plan decision 12: account_id is required to activate, so an active item keeps one.
  if (finalStatus === "active" && !finalAccount) throw new RecurringError(400, "account_required", "An active item needs the account it is charged to");

  if (Object.keys(set).length > 0) {
    set.updatedAt = now;
    await tx.update(recurring).set(set).where(eq(recurring.id, id));
  }
  if (patch.status !== undefined && patch.status !== row.status) await setRecurringStatus(tx, id, patch.status, { today, now });
  else await refreshRecurringItem(tx, id, today, now);
  if (opts.audit) {
    const after = await loadRow(tx, id);
    await writeAudit(tx, { ...opts.audit, entity: "recurring", entityId: id, action: "update", before: recurringAuditJson(row), after: recurringAuditJson(after) });
  }
}

/** Hard delete: links nulled, alerts cascade. A detected series is re-suggested on the next run. */
export async function deleteRecurring(tx: DbOrTx, id: string, opts: { audit?: AuditContext } = {}): Promise<boolean> {
  const [row] = await tx.select().from(recurring).where(eq(recurring.id, id));
  if (!row) return false;
  await tx.update(transaction).set({ recurringId: null }).where(eq(transaction.recurringId, id));
  await tx.delete(recurring).where(eq(recurring.id, id));
  if (opts.audit) await writeAudit(tx, { ...opts.audit, entity: "recurring", entityId: id, action: "delete", before: recurringAuditJson(row), after: null });
  return true;
}

// ---- Links ----

/**
 * Manual link: same payee and sign, not a transfer, and a free period (409 otherwise). A charge
 * linked to another item is a 409 too, unless `move` is set: then, once every check above has
 * passed, it leaves that item (which is refreshed) and joins this one, in the caller's
 * transaction.
 */
export async function linkTransaction(tx: DbOrTx, id: string, transactionId: string, today: IsoDate, now: Date, opts: { move?: boolean } = {}): Promise<void> {
  const row = await loadRow(tx, id);
  const [t] = await tx
    .select({ id: transaction.id, payeeId: transaction.payeeId, amountCents: transaction.amountCents, date: transaction.date, isTransfer: transaction.isTransfer, recurringId: transaction.recurringId })
    .from(transaction)
    .where(eq(transaction.id, transactionId));
  if (!t) throw new RecurringError(404, "not_found", "Transaction not found");
  if (t.recurringId === id) return;
  if (t.recurringId && !opts.move) throw new RecurringError(409, "conflict", "That transaction is linked to another recurring item");
  if (t.payeeId !== row.payeeId) throw new RecurringError(400, "validation", "The transaction's payee differs from the item's");
  if (t.isTransfer) throw new RecurringError(400, "validation", "Transfers cannot be linked");
  if (t.amountCents === 0n || signOf(t.amountCents) !== signOf(row.expectedCents)) throw new RecurringError(400, "validation", "The transaction's direction differs from the item's");
  const schedule = scheduleOf(row);
  if (validateSchedule(schedule) === null) {
    const k = periodIndex(schedule, t.date).k;
    const links = await loadLinks(tx, id);
    if (links.some((l) => periodIndex(schedule, l.date).k === k)) throw new RecurringError(409, "conflict", "That period already has a charge");
  }
  await tx.update(transaction).set({ recurringId: id }).where(eq(transaction.id, transactionId));
  if (t.recurringId) await refreshRecurringItem(tx, t.recurringId, today, now);
  await refreshRecurringItem(tx, id, today, now, { newlyLinkedIds: [transactionId] });
}

/** Remove one charge from an item (404 when it is not linked to it) and refresh. */
export async function unlinkTransaction(tx: DbOrTx, id: string, transactionId: string, today: IsoDate, now: Date): Promise<void> {
  await loadRow(tx, id);
  const rows = await tx
    .update(transaction)
    .set({ recurringId: null })
    .where(and(eq(transaction.id, transactionId), eq(transaction.recurringId, id)))
    .returning({ id: transaction.id });
  if (rows.length === 0) throw new RecurringError(404, "not_found", "That transaction is not linked to this item");
  await refreshRecurringItem(tx, id, today, now);
}

/**
 * Ledger hook (C5): drop a transaction's link, whichever item holds it, and refresh that
 * item. Returns the old item's id, or null when the transaction was not linked. The
 * transactions service calls this on a payee change, a transfer flag or a sign change.
 */
export async function unlinkTransactionFromRecurring(tx: DbOrTx, transactionId: string, opts: { today: IsoDate; now: Date }): Promise<string | null> {
  const [t] = await tx.select({ recurringId: transaction.recurringId }).from(transaction).where(eq(transaction.id, transactionId));
  if (!t?.recurringId) return null;
  await tx.update(transaction).set({ recurringId: null }).where(eq(transaction.id, transactionId));
  await refreshRecurringItem(tx, t.recurringId, opts.today, opts.now);
  return t.recurringId;
}

// ---- Views ----

/** Bigint twin of RecurringView. */
export interface RecurringRecord {
  id: string;
  payeeId: string;
  payeeName: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  accountId: string | null;
  accountName: string | null;
  transferAccountId: string | null;
  transferAccountName: string | null;
  cadence: Cadence;
  anchorDay: number | null;
  anchorDay2: number | null;
  anchorMonth: number | null;
  anchorDate: IsoDate | null;
  expectedCents: bigint;
  toleranceCents: bigint;
  amountMode: AmountMode;
  amountLocked: boolean;
  scheduleLocked: boolean;
  nextDueDate: IsoDate | null;
  firstChargeDate: IsoDate | null;
  lastChargeDate: IsoDate | null;
  lastChargeCents: bigint | null;
  chargeCount: number;
  consecutiveMissed: number;
  /** status active and at least one missed occurrence. */
  overdue: boolean;
  confidence: number | null;
  source: RecurringSource;
  status: RecurringStatus;
  statusReason: string | null;
  statusChangedAt: Date;
  monthlyEquivalentCents: bigint;
  yearlyCents: bigint;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListRecurringQuery {
  /** Default: everything except dismissed. */
  status?: RecurringStatus | "all";
  direction?: "inflow" | "outflow";
  /**
   * Explicit order; without it suggestions sort by confidence desc then |yearly| desc and
   * come first, the rest by next due date (nulls last).
   */
  sort?: "cost" | "due" | "name" | "confidence";
}

const transferAccount = alias(account, "transfer_account");

async function loadRecords(db: DbOrTx, where?: ReturnType<typeof and>): Promise<RecurringRecord[]> {
  const rows = await db
    .select({ row: recurring, payeeName: payee.name, categoryName: category.name, accountName: account.name, transferAccountName: transferAccount.name })
    .from(recurring)
    .innerJoin(payee, eq(payee.id, recurring.payeeId))
    .leftJoin(category, eq(category.id, recurring.categoryId))
    .leftJoin(account, eq(account.id, recurring.accountId))
    .leftJoin(transferAccount, eq(transferAccount.id, recurring.transferAccountId))
    .where(where);
  return rows.map(({ row, payeeName, categoryName, accountName, transferAccountName }) => ({
    id: row.id,
    payeeId: row.payeeId,
    payeeName,
    name: row.name,
    categoryId: row.categoryId,
    categoryName,
    accountId: row.accountId,
    accountName,
    transferAccountId: row.transferAccountId,
    transferAccountName,
    cadence: row.cadence,
    anchorDay: row.anchorDay,
    anchorDay2: row.anchorDay2,
    anchorMonth: row.anchorMonth,
    anchorDate: row.anchorDate,
    expectedCents: row.expectedCents,
    toleranceCents: row.toleranceCents,
    amountMode: row.amountMode,
    amountLocked: row.amountLocked,
    scheduleLocked: row.scheduleLocked,
    nextDueDate: row.nextDueDate,
    firstChargeDate: row.firstChargeDate,
    lastChargeDate: row.lastChargeDate,
    lastChargeCents: row.lastChargeCents,
    chargeCount: row.chargeCount,
    consecutiveMissed: row.consecutiveMissed,
    overdue: row.status === "active" && row.consecutiveMissed > 0,
    confidence: row.confidence,
    source: row.source,
    status: row.status,
    statusReason: row.statusReason,
    statusChangedAt: row.statusChangedAt,
    monthlyEquivalentCents: monthlyEquivalentCents(row.expectedCents, row.cadence),
    yearlyCents: yearlyCents(row.expectedCents, row.cadence),
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

function compareName(a: RecurringRecord, b: RecurringRecord): number {
  return a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function compareDue(a: RecurringRecord, b: RecurringRecord): number {
  if (a.nextDueDate === b.nextDueDate) return compareName(a, b);
  if (a.nextDueDate === null) return 1;
  if (b.nextDueDate === null) return -1;
  return a.nextDueDate < b.nextDueDate ? -1 : 1;
}

function compareCost(a: RecurringRecord, b: RecurringRecord): number {
  const x = absBig(a.yearlyCents);
  const y = absBig(b.yearlyCents);
  return x === y ? compareName(a, b) : x > y ? -1 : 1;
}

function compareConfidence(a: RecurringRecord, b: RecurringRecord): number {
  const x = a.confidence ?? -1;
  const y = b.confidence ?? -1;
  return x === y ? compareCost(a, b) : y - x;
}

function compareDefault(a: RecurringRecord, b: RecurringRecord): number {
  const sa = a.status === "suggested" ? 0 : 1;
  const sb = b.status === "suggested" ? 0 : 1;
  if (sa !== sb) return sa - sb;
  return sa === 0 ? compareConfidence(a, b) : compareDue(a, b);
}

const COMPARATORS: Record<NonNullable<ListRecurringQuery["sort"]>, (a: RecurringRecord, b: RecurringRecord) => number> = {
  cost: compareCost,
  due: compareDue,
  name: compareName,
  confidence: compareConfidence,
};

/** View-shaped rows with totals over the listed items (monthly = yearly total / 12, truncated). */
export async function listRecurring(
  db: DbOrTx,
  query: ListRecurringQuery = {},
): Promise<{ items: RecurringRecord[]; totals: { yearlyCents: bigint; monthlyEquivalentCents: bigint } }> {
  const statusFilter = query.status === undefined ? ne(recurring.status, "dismissed") : query.status === "all" ? undefined : eq(recurring.status, query.status);
  const directionFilter = query.direction === "inflow" ? gt(recurring.expectedCents, 0n) : query.direction === "outflow" ? lt(recurring.expectedCents, 0n) : undefined;
  const items = await loadRecords(db, and(statusFilter, directionFilter));
  items.sort(query.sort ? COMPARATORS[query.sort] : compareDefault);
  const yearly = items.reduce((sum, r) => sum + r.yearlyCents, 0n);
  return { items, totals: { yearlyCents: yearly, monthlyEquivalentCents: truncDiv(yearly, 12n) } };
}

export async function getRecurring(db: DbOrTx, id: string): Promise<RecurringRecord | undefined> {
  const [record] = await loadRecords(db, and(eq(recurring.id, id)));
  return record;
}

// ---- Subscriptions (B11) ----

/** Bigint twin of SubscriptionRow. */
export interface SubscriptionRecord {
  id: string;
  name: string;
  payeeName: string;
  categoryName: string | null;
  cadence: Cadence;
  expectedCents: bigint;
  monthlyEquivalentCents: bigint;
  yearlyCents: bigint;
  nextDueDate: IsoDate | null;
  lastChargeDate: IsoDate | null;
  lastChargeCents: bigint | null;
  amountMode: AmountMode;
  consecutiveMissed: number;
  status: RecurringStatus;
  /** 'missed_3' when the item was auto-paused; consecutive_missed goes back to 0 on the next refresh, this stays. */
  statusReason: string | null;
}

export interface SubscriptionsResult {
  /** Active outflows, most expensive first (yearly ascending: most negative first). */
  items: SubscriptionRecord[];
  /** Paused outflows (auto-paused included), outside the totals. */
  pausedItems: SubscriptionRecord[];
  /** yearly total / 12, truncated; never a sum of rounded rows. */
  totalMonthlyCents: bigint;
  totalYearlyCents: bigint;
}

function compareSubscription(a: SubscriptionRecord, b: SubscriptionRecord): number {
  if (a.yearlyCents !== b.yearlyCents) return a.yearlyCents < b.yearlyCents ? -1 : 1;
  return a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1);
}

/**
 * Active and paused recurring outflows (B11). A transfer item (transfer_account_id set) moves
 * money between the household's own accounts and is not spending (plan decision 12), so it is
 * neither listed nor counted (audit decision A13).
 */
export async function listSubscriptions(db: DbOrTx): Promise<SubscriptionsResult> {
  const rows = await db
    .select({ row: recurring, payeeName: payee.name, categoryName: category.name })
    .from(recurring)
    .innerJoin(payee, eq(payee.id, recurring.payeeId))
    .leftJoin(category, eq(category.id, recurring.categoryId))
    .where(and(inArray(recurring.status, ["active", "paused"]), lt(recurring.expectedCents, 0n), isNull(recurring.transferAccountId)));
  const records: SubscriptionRecord[] = rows.map(({ row, payeeName, categoryName }) => ({
    id: row.id,
    name: row.name,
    payeeName,
    categoryName,
    cadence: row.cadence,
    expectedCents: row.expectedCents,
    monthlyEquivalentCents: monthlyEquivalentCents(row.expectedCents, row.cadence),
    yearlyCents: yearlyCents(row.expectedCents, row.cadence),
    nextDueDate: row.nextDueDate,
    lastChargeDate: row.lastChargeDate,
    lastChargeCents: row.lastChargeCents,
    amountMode: row.amountMode,
    consecutiveMissed: row.consecutiveMissed,
    status: row.status,
    statusReason: row.statusReason,
  }));
  const items = records.filter((r) => r.status === "active").sort(compareSubscription);
  const pausedItems = records.filter((r) => r.status === "paused").sort(compareSubscription);
  const totalYearlyCents = items.reduce((sum, r) => sum + r.yearlyCents, 0n);
  return { items, pausedItems, totalMonthlyCents: truncDiv(totalYearlyCents, 12n), totalYearlyCents };
}
