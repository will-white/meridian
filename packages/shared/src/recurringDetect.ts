import { addDays, compareIsoDate, dayDiff, type IsoDate } from "./dates.js";
import type { AmountMode, Cadence } from "./enums.js";
import { maxBig, minBig, truncDiv } from "./months.js";
import {
  CADENCES,
  effectiveDay,
  isWeekBased,
  monthIndex,
  nominalPeriodDays,
  occurrence,
  periodIndex,
  periodMonths,
  toleranceDays,
  type Schedule,
} from "./schedule.js";

/**
 * Recurring detection: a pure, deterministic engine (no DB, no clock) that turns one
 * group of charges — the same payee and the same sign, grouped by the caller — into
 * recurring-series detections.
 *
 * Each cadence is fitted from the data (`fitSchedule`) and scored by walking the sorted
 * dates (`scoreCadence`): every later charge is a hit (next period, within tolerance),
 * a skip (one period missed, half credit), an extra (same period, the cursor stays) or
 * a miss. Amounts are classified fixed/variable (`classifyAmounts`). When the whole
 * group fails, the per-account split is tried, then amount clusters (`detectRecurring`).
 *
 * All money is bigint cents; division truncates toward zero. Day counts, indices and
 * basis points are plain integers. Schedule primitives come from `schedule.ts`.
 */

export const LOOKBACK_MONTHS = 36;
export const MIN_CHARGES = 3;
export const MIN_CHARGES_VARIABLE = 4;
export const MIN_HITS = 2;
export const MIN_ON_CYCLE = 3;
export const MIN_SCORE_BP = 6000;
export const FIXED_TOL_MIN_CENTS = 100n;
export const FIXED_TOL_PCT = 1;
export const CLUSTER_PCT = 15;
export const CLUSTER_MIN_CENTS = 100n;
export const TRIAL_SMALL_CENTS = 100n;
export const TRIAL_FULL_MIN_CENTS = 500n;
export const TRIAL_WINDOW_DAYS = 45;
export const TRIAL_RECENT_DAYS = 14;
export const NEW_WINDOW_DAYS = 120;
export const NEW_HISTORY_GUARD_DAYS = 45;
export const AUTO_PAUSE_AFTER_MISSED = 3;
export const TWICE_MONTHLY_MIN_ANCHOR_DISTANCE = 10;

export interface ChargeLike {
  id: string;
  accountId: string;
  date: IsoDate;
  /** Signed, ledger convention (negative = outflow). One group has one sign. */
  amountCents: bigint;
}

export interface CadenceScore {
  cadence: Cadence;
  schedule: Schedule;
  n: number;
  hits: number;
  skips: number;
  extras: number;
  misses: number;
  /** On-cycle charges: the first (when on-cycle) plus hits and skips. */
  onCycle: number;
  /** floor(((2·hits + skips)·10000) / (2·(n − 1))). */
  scoreBp: number;
  /** Σ|residual days| over hits and skips. */
  residualSum: number;
  onCycleIds: string[];
  firstOnCycle: boolean;
}

export interface Detection {
  /** Week-based schedules carry `anchorDate` = the last on-cycle charge. */
  schedule: Schedule;
  scoreBp: number;
  /** floor(scoreBp / 100), 0..100. */
  confidence: number;
  amountMode: AmountMode;
  /** Signed, like the charges. */
  expectedCents: bigint;
  toleranceCents: bigint;
  /** Only on-cycle charges are linked; extras and misses stay unlinked. */
  onCycleIds: string[];
  firstChargeDate: IsoDate;
  lastChargeDate: IsoDate;
  lastChargeCents: bigint;
  lastTransactionId: string;
  /** Account of the last on-cycle charge. */
  accountId: string;
  chargeCount: number;
  nextDueDate: IsoDate;
}

export interface AmountClassification {
  mode: AmountMode;
  /** Absolute value; the caller restores the sign. */
  expectedAbs: bigint;
  toleranceCents: bigint;
  /** Some amount is below half or above twice the series median (bimodal guard). */
  dispersed: boolean;
}

export interface TrialConversion {
  smallTransactionIds: string[];
  firstFull: ChargeLike;
}

function absBig(a: bigint): bigint {
  return a < 0n ? -a : a;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byDateThenId(a: ChargeLike, b: ChargeLike): number {
  return compareIsoDate(a.date, b.date) || compareStrings(a.id, b.id);
}

function sortCharges(charges: readonly ChargeLike[]): ChargeLike[] {
  return [...charges].sort(byDateThenId);
}

function maxOf(xs: readonly bigint[]): bigint {
  return xs.reduce((m, x) => maxBig(m, x));
}

function minOf(xs: readonly bigint[]): bigint {
  return xs.reduce((m, x) => minBig(m, x));
}

/** sorted[floor(n / 2)]: the median of an odd list, the upper of the two middle values of an even one. */
export function upperMedian<T extends bigint | number>(xs: readonly T[]): T {
  if (xs.length === 0) throw new Error("upperMedian of an empty list");
  const sorted = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor(sorted.length / 2)]!;
}

function sumAbsDeviation(days: readonly number[]): number {
  const m = upperMedian(days);
  return days.reduce((sum, d) => sum + Math.abs(d - m), 0);
}

/**
 * Two anchor days from the effective days: the contiguous split of the sorted days with
 * the smallest total absolute deviation from each half's upper median (tie → the smaller
 * split). Needs ≥ 4 charges, ≥ 2 per half and a circular distance ≥ 10 between the anchors.
 */
function fitTwiceMonthly(sortedDates: readonly IsoDate[]): Schedule | undefined {
  const n = sortedDates.length;
  if (n < 4) return undefined;
  const days = sortedDates.map(effectiveDay).sort((a, b) => a - b);
  let bestSplit = 1;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let i = 1; i < n; i++) {
    const cost = sumAbsDeviation(days.slice(0, i)) + sumAbsDeviation(days.slice(i));
    if (cost < bestCost) {
      bestCost = cost;
      bestSplit = i;
    }
  }
  const lo = days.slice(0, bestSplit);
  const hi = days.slice(bestSplit);
  if (lo.length < 2 || hi.length < 2) return undefined;
  const anchorDay = upperMedian(lo);
  const anchorDay2 = upperMedian(hi);
  const gap = anchorDay2 - anchorDay;
  if (Math.min(gap, 30 - gap) < TWICE_MONTHLY_MIN_ANCHOR_DISTANCE) return undefined;
  return { cadence: "twice_monthly", anchorDay, anchorDay2 };
}

/**
 * Fit a schedule of the given cadence to the charge dates.
 * - weekly / biweekly: anchorDate = the earliest date (the walk re-anchors at every charge).
 * - month-based: anchorDay = upper median of the effective days (last day of a month → 31);
 *   multi-month cadences take the residue class (month index mod periodMonths) with the
 *   most charges, tie → the class of the earliest charge, anchorMonth = calendar month of
 *   the earliest charge in that class.
 * - twice_monthly: see `fitTwiceMonthly`; undefined when no valid pair of anchors exists.
 */
export function fitSchedule(dates: readonly IsoDate[], cadence: Cadence): Schedule | undefined {
  if (dates.length === 0) return undefined;
  const sorted = [...dates].sort(compareIsoDate);
  if (isWeekBased(cadence)) return { cadence, anchorDate: sorted[0]! };
  if (cadence === "twice_monthly") return fitTwiceMonthly(sorted);
  const anchorDay = upperMedian(sorted.map(effectiveDay));
  if (cadence === "monthly") return { cadence, anchorDay };
  const p = periodMonths(cadence);
  const classes = new Map<number, { count: number; firstDate: IsoDate }>();
  for (const d of sorted) {
    const residue = ((monthIndex(d) % p) + p) % p;
    const entry = classes.get(residue);
    if (entry) entry.count++;
    else classes.set(residue, { count: 1, firstDate: d });
  }
  let best: { count: number; firstDate: IsoDate } | undefined;
  for (const entry of classes.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  const anchorMonth = Number(best!.firstDate.slice(5, 7));
  return { cadence, anchorDay, anchorMonth };
}

/**
 * Walk the sorted dates against a schedule. `dates` and `ids` are parallel arrays in
 * ascending (date, id) order. For each charge after the first: dk = 0 → extra (the cursor
 * stays); |residual| > tolerance → miss; dk = 1 → hit; dk = 2 → skip; dk ≥ 3 → miss. The
 * cursor advances to the charge on hit, skip and miss. Week-based cadences predict from
 * the cursor (so jitter never accumulates); month-based and twice-monthly use the
 * nearest-occurrence period index.
 */
export function scoreCadence(dates: readonly IsoDate[], ids: readonly string[], schedule: Schedule): CadenceScore {
  const n = dates.length;
  if (n === 0) throw new Error("scoreCadence needs at least one charge");
  if (ids.length !== n) throw new Error("scoreCadence: dates and ids differ in length");
  const cadence = schedule.cadence;
  const tol = toleranceDays(cadence);
  const weekBased = isWeekBased(cadence);
  const period = nominalPeriodDays(cadence);

  let cursor = dates[0]!;
  let kCur: number;
  let firstOnCycle: boolean;
  if (weekBased) {
    kCur = 0;
    firstOnCycle = true;
  } else {
    const first = periodIndex(schedule, cursor);
    kCur = first.k;
    firstOnCycle = Math.abs(first.residualDays) <= tol;
  }

  let hits = 0;
  let skips = 0;
  let extras = 0;
  let misses = 0;
  let residualSum = 0;
  const onCycleIds: string[] = firstOnCycle ? [ids[0]!] : [];

  for (let i = 1; i < n; i++) {
    const d = dates[i]!;
    let k: number;
    let r: number;
    if (weekBased) {
      const diff = dayDiff(cursor, d);
      const dk = Math.floor((2 * diff + period) / (2 * period));
      r = diff - dk * period;
      k = kCur + dk;
    } else {
      const p = periodIndex(schedule, d);
      k = p.k;
      r = p.residualDays;
    }
    const dk = k - kCur;
    if (dk === 0) {
      extras++;
      continue;
    }
    if (Math.abs(r) > tol) {
      misses++;
    } else if (dk === 1) {
      hits++;
      residualSum += Math.abs(r);
      onCycleIds.push(ids[i]!);
    } else if (dk === 2) {
      skips++;
      residualSum += Math.abs(r);
      onCycleIds.push(ids[i]!);
    } else {
      misses++;
    }
    cursor = d;
    kCur = k;
  }

  const gaps = n - 1;
  const scoreBp = gaps > 0 ? Math.floor(((2 * hits + skips) * 10000) / (2 * gaps)) : 0;
  return {
    cadence,
    schedule,
    n,
    hits,
    skips,
    extras,
    misses,
    onCycle: (firstOnCycle ? 1 : 0) + hits + skips,
    scoreBp,
    residualSum,
    onCycleIds,
    firstOnCycle,
  };
}

function fixedTolerance(amountAbs: bigint): bigint {
  return maxBig(FIXED_TOL_MIN_CENTS, truncDiv(amountAbs * BigInt(FIXED_TOL_PCT), 100n));
}

/**
 * Fixed iff the last three amounts lie within max($1, 1% of their median): expected = the
 * last amount (a price change shows immediately), tolerance = max($1, 1%). Otherwise
 * variable: expected = upper median of the last six, tolerance = the band half-width that
 * covers them. `dispersed` flags any amount below half or above twice the series median.
 */
export function classifyAmounts(absAmounts: readonly bigint[]): AmountClassification {
  const n = absAmounts.length;
  if (n === 0) throw new Error("classifyAmounts of an empty list");
  const medianAll = upperMedian(absAmounts);
  const dispersed = absAmounts.some((a) => 2n * a < medianAll || a > 2n * medianAll);
  const last3 = absAmounts.slice(-3);
  const tolFixed = fixedTolerance(upperMedian(last3));
  if (maxOf(last3) - minOf(last3) <= tolFixed) {
    const expectedAbs = absAmounts[n - 1]!;
    return { mode: "fixed", expectedAbs, toleranceCents: fixedTolerance(expectedAbs), dispersed };
  }
  const last6 = absAmounts.slice(-6);
  const expectedAbs = upperMedian(last6);
  const toleranceCents = maxBig(expectedAbs - minOf(last6), maxOf(last6) - expectedAbs);
  return { mode: "variable", expectedAbs, toleranceCents, dispersed };
}

/**
 * Best first: higher score; tie → smaller tolerance-normalised residual (residualSum /
 * (tol · gaps), compared cross-multiplied); tie → longer nominal period.
 */
export function compareScores(a: CadenceScore, b: CadenceScore): number {
  if (a.scoreBp !== b.scoreBp) return b.scoreBp - a.scoreBp;
  const normA = a.residualSum * toleranceDays(b.cadence) * (b.n - 1);
  const normB = b.residualSum * toleranceDays(a.cadence) * (a.n - 1);
  if (normA !== normB) return normA - normB;
  return nominalPeriodDays(b.cadence) - nominalPeriodDays(a.cadence);
}

function isAccepted(score: CadenceScore): boolean {
  return score.scoreBp >= MIN_SCORE_BP && score.hits >= MIN_HITS && score.onCycle >= MIN_ON_CYCLE;
}

/**
 * One series from one set of charges (same payee and sign). Undefined when there are too
 * few charges (3, or 4 for variable amounts), the amounts are dispersed, no cadence is
 * accepted, or the last on-cycle charge is older than two periods.
 */
export function detectSeries(charges: readonly ChargeLike[], today: IsoDate): Detection | undefined {
  if (charges.length < MIN_CHARGES) return undefined;
  const sorted = sortCharges(charges);
  const amounts = classifyAmounts(sorted.map((c) => absBig(c.amountCents)));
  if (amounts.mode === "variable" && (sorted.length < MIN_CHARGES_VARIABLE || amounts.dispersed)) return undefined;

  const dates = sorted.map((c) => c.date);
  const ids = sorted.map((c) => c.id);
  let best: CadenceScore | undefined;
  for (const cadence of CADENCES) {
    const schedule = fitSchedule(dates, cadence);
    if (!schedule) continue;
    const score = scoreCadence(dates, ids, schedule);
    if (!isAccepted(score)) continue;
    if (!best || compareScores(score, best) < 0) best = score;
  }
  if (!best) return undefined;

  const byId = new Map(sorted.map((c) => [c.id, c] as const));
  const onCycle = best.onCycleIds.map((id) => byId.get(id)!);
  const first = onCycle[0]!;
  const last = onCycle[onCycle.length - 1]!;
  if (dayDiff(last.date, today) > 2 * nominalPeriodDays(best.cadence)) return undefined;

  const weekBased = isWeekBased(best.cadence);
  const schedule: Schedule = weekBased ? { cadence: best.cadence, anchorDate: last.date } : best.schedule;
  const nextDueDate = weekBased
    ? addDays(last.date, nominalPeriodDays(best.cadence))
    : occurrence(schedule, periodIndex(schedule, last.date).k + 1);
  const sign = last.amountCents < 0n ? -1n : 1n;
  return {
    schedule,
    scoreBp: best.scoreBp,
    confidence: Math.floor(best.scoreBp / 100),
    amountMode: amounts.mode,
    expectedCents: sign * amounts.expectedAbs,
    toleranceCents: amounts.toleranceCents,
    onCycleIds: best.onCycleIds,
    firstChargeDate: first.date,
    lastChargeDate: last.date,
    lastChargeCents: last.amountCents,
    lastTransactionId: last.id,
    accountId: last.accountId,
    chargeCount: best.onCycleIds.length,
    nextDueDate,
  };
}

/**
 * Greedy clusters by absolute amount, ascending: a charge joins the current cluster while
 * its amount ≤ clusterMin + max($1, 15% of clusterMin). Each cluster comes back in
 * (date, id) order; clusters of any size are returned.
 */
export function clusterByAmount(charges: readonly ChargeLike[]): ChargeLike[][] {
  const byAbs = [...charges].sort((a, b) => {
    const x = absBig(a.amountCents);
    const y = absBig(b.amountCents);
    return x < y ? -1 : x > y ? 1 : byDateThenId(a, b);
  });
  const clusters: ChargeLike[][] = [];
  let current: ChargeLike[] = [];
  let limit = 0n;
  for (const c of byAbs) {
    const a = absBig(c.amountCents);
    if (current.length === 0 || a > limit) {
      if (current.length > 0) clusters.push(current);
      current = [c];
      limit = a + maxBig(CLUSTER_MIN_CENTS, truncDiv(a * BigInt(CLUSTER_PCT), 100n));
    } else {
      current.push(c);
    }
  }
  if (current.length > 0) clusters.push(current);
  return clusters.map((cluster) => cluster.sort(byDateThenId));
}

function byDetectionOrder(a: Detection, b: Detection): number {
  return (
    b.chargeCount - a.chargeCount ||
    compareIsoDate(a.firstChargeDate, b.firstChargeDate) ||
    compareStrings(a.onCycleIds[0] ?? "", b.onCycleIds[0] ?? "")
  );
}

/**
 * Detections for one (payee, sign) group: the whole group; else, when it spans several
 * accounts, each account; else amount clusters of ≥ 3 charges. Levels are never combined.
 * Ordered by chargeCount desc, firstChargeDate asc, first on-cycle id asc.
 */
export function detectRecurring(group: readonly ChargeLike[], today: IsoDate): Detection[] {
  const whole = detectSeries(group, today);
  if (whole) return [whole];

  const results: Detection[] = [];
  const byAccount = new Map<string, ChargeLike[]>();
  for (const c of group) {
    const list = byAccount.get(c.accountId) ?? [];
    list.push(c);
    byAccount.set(c.accountId, list);
  }
  if (byAccount.size >= 2) {
    for (const charges of byAccount.values()) {
      const d = detectSeries(charges, today);
      if (d) results.push(d);
    }
  }
  if (results.length === 0) {
    for (const cluster of clusterByAmount(group)) {
      if (cluster.length < MIN_CHARGES) continue;
      const d = detectSeries(cluster, today);
      if (d) results.push(d);
    }
  }
  return results.sort(byDetectionOrder);
}

/**
 * A series is "new" when its first charge is within 120 days of today and at least 45 days
 * after the account's earliest transaction (so a first sync does not flag every bill).
 */
export function isNewSeries(firstChargeDate: IsoDate, accountHistoryStart: IsoDate, today: IsoDate): boolean {
  return dayDiff(firstChargeDate, today) <= NEW_WINDOW_DAYS && dayDiff(accountHistoryStart, firstChargeDate) >= NEW_HISTORY_GUARD_DAYS;
}

/**
 * Trial conversion over all outflows of one payee (zero and small amounts included;
 * inflows are ignored): the first charge of ≥ $5 fires when every earlier charge is ≤ $1,
 * it follows the last of them within 45 days, and it is at most 14 days old.
 */
export function detectTrialConversion(outflows: readonly ChargeLike[], today: IsoDate): TrialConversion | undefined {
  const sorted = outflows.filter((c) => c.amountCents <= 0n).sort(byDateThenId);
  const i = sorted.findIndex((c) => absBig(c.amountCents) >= TRIAL_FULL_MIN_CENTS);
  if (i < 1) return undefined;
  const earlier = sorted.slice(0, i);
  if (!earlier.every((c) => absBig(c.amountCents) <= TRIAL_SMALL_CENTS)) return undefined;
  const firstFull = sorted[i]!;
  if (dayDiff(earlier[i - 1]!.date, firstFull.date) > TRIAL_WINDOW_DAYS) return undefined;
  if (dayDiff(firstFull.date, today) > TRIAL_RECENT_DAYS) return undefined;
  return { smallTransactionIds: earlier.map((c) => c.id), firstFull };
}
