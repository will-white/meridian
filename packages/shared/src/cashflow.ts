import { addDays, dayDiff, dayOfMonth, type IsoDate } from "./dates.js";
import type { AccountType } from "./enums.js";
import { addMonths, daysInMonth, maxBig, monthEnd, monthKey, monthStart, truncDiv, type MonthKey } from "./months.js";
import { occurrencesInRange, type Schedule } from "./schedule.js";

/**
 * Cash-flow projection: one pure, deterministic function that rolls every projected
 * account forward from `today` through `today + horizonDays` inclusive (horizonDays + 1
 * points). No DB, no clock, bigint cents. See docs/phase-2-plan.md §14 and
 * docs/design/phase-2/cashflow.md.
 *
 * Per account: opening balance + recurring income − bills ± transfer legs (each leg posts
 * only when its account is projected, so on-budget transfers cancel in the combined line)
 * − card payments (the card's statement balance, paid on `payDay` from the paying account)
 * − the month's remaining planned spending spread over the remaining days of the month.
 *
 * Occurrences come from `schedule.ts` (the only generator): `occurrencesInRange(schedule,
 * nextDueDate, endDate + maxShift)`. Occurrences dated before today collapse to the single
 * latest one, posted today and flagged overdue. What-ifs match on ORIGINAL occurrence
 * dates, apply in body order and are each reported back as applied or not with a reason.
 *
 * Integer rules: the only divisions are `share / days` and `(total · weight) / Σweights`
 * on non-negative dividends, so bigint truncation is floor; remainders are handed out one
 * cent at a time (earliest days for the daily spread, largest remainder for the account
 * split), so every spread and split sums exactly to its input.
 */

// ---- Inputs ----

export type RecurringKind = "income" | "bill" | "transfer";

export interface CashFlowAccount {
  id: string;
  name: string;
  type: AccountType;
  /** Posted balance plus pending transactions. */
  openingCents: bigint;
  balanceDate: IsoDate | null;
  /** Per-account override; null → checking/savings inherit the household default, other types get none. */
  lowBalanceThresholdCents: bigint | null;
}

export interface CashFlowRecurring {
  id: string;
  name: string;
  kind: RecurringKind;
  /** The account the money enters (income) or leaves (bill, transfer). */
  accountId: string;
  /** Destination of a transfer; null for bills and income. */
  transferAccountId: string | null;
  schedule: Schedule;
  nextDueDate: IsoDate;
  /** Signed like `transaction.amount_cents`: + into `accountId`, − out of it. */
  amountCents: bigint;
}

export interface CashFlowCardPayment {
  cardAccountId: string;
  fromAccountId: string;
  /** 1..31; clamped to the month's length (31 = last day). */
  payDay: number;
  /** Statement close day (1..31, clamped); null = the balance as of the day before the payment. */
  statementDay: number | null;
  /** Ledger-derived balance at the last close before today, when the loader could compute it. */
  knownStatementBalanceCents: bigint | null;
}

export interface CashFlowSpendingMonth {
  month: MonthKey;
  /** Remaining planned spending (spending bucket only); negative is treated as 0. */
  remainingCents: bigint;
}

export interface CashFlowSpendingWeight {
  accountId: string;
  weightCents: bigint;
}

export type CashFlowWhatIf =
  | { kind: "skipOccurrence"; recurringId: string; occurrenceDate: IsoDate }
  | { kind: "moveOccurrence"; recurringId: string; shiftDays: number; occurrenceDate?: IsoDate }
  | { kind: "oneTime"; date: IsoDate; amountCents: bigint; accountId: string; label?: string };

export interface CashFlowInput {
  today: IsoDate;
  /** 1..366. */
  horizonDays: number;
  accounts: CashFlowAccount[];
  recurring: CashFlowRecurring[];
  cardPayments: CashFlowCardPayment[];
  spendingPlan: CashFlowSpendingMonth[];
  spendingWeights: CashFlowSpendingWeight[];
  primaryAccountId: string | null;
  defaultThresholdCents: bigint;
  whatIfs: CashFlowWhatIf[];
}

// ---- Outputs ----

export type CashFlowEventKind = "income" | "bill" | "transfer_out" | "transfer_in" | "card_payment_out" | "card_payment_in" | "one_time";

export interface CashFlowEvent {
  /** The day the amount posts (today for overdue items). */
  date: IsoDate;
  /** The schedule's date (recurring) or the requested date (one-time); null for card payments. */
  originalDate: IsoDate | null;
  accountId: string;
  amountCents: bigint;
  kind: CashFlowEventKind;
  recurringId: string | null;
  label: string;
  /** False when skipped by a what-if: listed, nothing posted. */
  applied: boolean;
  overdue: boolean;
  moved: boolean;
}

export interface CashFlowSeries {
  openingCents: bigint;
  thresholdCents: bigint | null;
  /** End-of-day balances; index i ↔ dates[i]. */
  points: bigint[];
  minCents: bigint;
  minDate: IsoDate;
  /** First date whose end-of-day balance is strictly below the threshold; may be today. */
  firstBelowThresholdDate: IsoDate | null;
  alreadyBelow: boolean;
}

export interface CashFlowAccountSeries extends CashFlowSeries {
  accountId: string;
  name: string;
  type: AccountType;
  balanceDate: IsoDate | null;
}

export interface CashFlowSpread {
  month: MonthKey;
  accountId: string;
  totalCents: bigint;
  windowStart: IsoDate;
  /** Days in the spread window (the full remaining month, even when the horizon ends sooner). */
  days: number;
  baseCents: bigint;
  /** The first `extraCentDays` days of the window carry one extra cent. */
  extraCentDays: number;
}

export interface CashFlowWhatIfReport {
  index: number;
  applied: boolean;
  reason?: string;
}

export interface CashFlowResult {
  today: IsoDate;
  endDate: IsoDate;
  dates: IsoDate[];
  accounts: CashFlowAccountSeries[];
  combined: CashFlowSeries;
  events: CashFlowEvent[];
  spreads: CashFlowSpread[];
  whatIfs: CashFlowWhatIfReport[];
  warnings: string[];
}

// ---- Helpers ----

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEvents(a: CashFlowEvent, b: CashFlowEvent): number {
  return (
    cmpStr(a.date, b.date) ||
    cmpStr(a.accountId, b.accountId) ||
    cmpStr(a.kind, b.kind) ||
    cmpStr(a.recurringId ?? "", b.recurringId ?? "") ||
    cmpStr(a.originalDate ?? "", b.originalDate ?? "")
  );
}

function clampedDate(month: MonthKey, day: number): IsoDate {
  return `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, "0")}`;
}

/**
 * Spread a non-negative total over `days` days: base = floor(total / days) and the first
 * (total mod days) days carry one extra cent, so the window sums exactly to the total.
 */
export function spreadEvenly(totalCents: bigint, days: number): { baseCents: bigint; extraCentDays: number } {
  if (!Number.isInteger(days) || days < 1) throw new Error("days must be a positive integer");
  const total = maxBig(0n, totalCents);
  const n = BigInt(days);
  const baseCents = truncDiv(total, n);
  return { baseCents, extraCentDays: Number(total - baseCents * n) };
}

/**
 * Split a non-negative total across accounts in proportion to their weights by largest
 * remainder (ties by input order). Returns null when the weights sum to zero. The map
 * keeps the weights' input order and its values sum exactly to the total.
 */
export function splitByWeights(totalCents: bigint, weights: readonly CashFlowSpendingWeight[]): Map<string, bigint> | null {
  let sum = 0n;
  for (const w of weights) sum += maxBig(0n, w.weightCents);
  if (sum === 0n) return null;
  const total = maxBig(0n, totalCents);
  const shares = new Map<string, bigint>();
  const remainders: Array<{ accountId: string; remainder: bigint; order: number }> = [];
  let assigned = 0n;
  weights.forEach((w, order) => {
    const product = total * maxBig(0n, w.weightCents);
    const share = product / sum;
    assigned += share;
    shares.set(w.accountId, (shares.get(w.accountId) ?? 0n) + share);
    remainders.push({ accountId: w.accountId, remainder: product - share * sum, order });
  });
  remainders.sort((a, b) => (a.remainder === b.remainder ? a.order - b.order : a.remainder > b.remainder ? -1 : 1));
  let left = total - assigned; // 0 ≤ left < number of weights
  for (const r of remainders) {
    if (left === 0n) break;
    shares.set(r.accountId, (shares.get(r.accountId) ?? 0n) + 1n);
    left -= 1n;
  }
  return shares;
}

/** Statement close for a payment on `payDate`: the day before, or the latest clamped `statementDay` strictly before it. */
function statementDate(payDate: IsoDate, statementDay: number | null): IsoDate {
  if (statementDay === null) return addDays(payDate, -1);
  const month = monthKey(payDate);
  const sameMonth = clampedDate(month, statementDay);
  return sameMonth < payDate ? sameMonth : clampedDate(addMonths(month, -1), statementDay);
}

interface Occurrence {
  item: CashFlowRecurring;
  originalDate: IsoDate;
  shiftDays: number;
  skipped: boolean;
}

function seriesStats(openingCents: bigint, points: bigint[], dates: IsoDate[], thresholdCents: bigint | null): CashFlowSeries {
  let minCents = openingCents;
  let minDate = dates[0] ?? "";
  let firstBelowThresholdDate: IsoDate | null = null;
  points.forEach((p, i) => {
    const date = dates[i] ?? "";
    if (i === 0 || p < minCents) {
      minCents = p;
      minDate = date;
    }
    if (thresholdCents !== null && firstBelowThresholdDate === null && p < thresholdCents) firstBelowThresholdDate = date;
  });
  return {
    openingCents,
    thresholdCents,
    points,
    minCents,
    minDate,
    firstBelowThresholdDate,
    alreadyBelow: thresholdCents !== null && openingCents < thresholdCents,
  };
}

// ---- Engine ----

export function projectCashFlow(input: CashFlowInput): CashFlowResult {
  const { today, horizonDays } = input;
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 366) throw new Error("horizonDays must be an integer in 1..366");

  // 1. Window.
  const endDate = addDays(today, horizonDays);
  const dates: IsoDate[] = [];
  for (let i = 0; i <= horizonDays; i++) dates.push(addDays(today, i));
  const idx = (d: IsoDate): number => dayDiff(today, d);

  const accountById = new Map<string, CashFlowAccount>();
  const delta = new Map<string, bigint[]>();
  for (const a of input.accounts) {
    accountById.set(a.id, a);
    delta.set(a.id, Array.from({ length: horizonDays + 1 }, () => 0n));
  }
  const has = (id: string | null): id is string => id !== null && accountById.has(id);
  const post = (accountId: string, i: number, amountCents: bigint): void => {
    const row = delta.get(accountId);
    if (row) row[i] = (row[i] ?? 0n) + amountCents;
  };

  const events: CashFlowEvent[] = [];
  const warnings: string[] = [];
  const whatIfReports: CashFlowWhatIfReport[] = [];
  const report = (index: number, applied: boolean, reason?: string): void => {
    whatIfReports.push(reason === undefined ? { index, applied } : { index, applied, reason });
  };

  // 2. Occurrences, in id order, generated through endDate + maxShift; pre-today ones collapse to the latest.
  let maxShift = 0;
  for (const w of input.whatIfs) if (w.kind === "moveOccurrence") maxShift = Math.max(maxShift, Math.abs(w.shiftDays));
  const generateThrough = addDays(endDate, maxShift);
  const items = [...input.recurring].sort((a, b) => cmpStr(a.id, b.id));
  const occurrencesByItem = new Map<string, Occurrence[]>();
  const occurrences: Occurrence[] = [];
  for (const item of items) {
    const all = occurrencesInRange(item.schedule, item.nextDueDate, generateThrough);
    const past = all.filter((d) => d < today);
    const upcoming = all.filter((d) => d >= today);
    const latestPast = past[past.length - 1];
    const kept = latestPast === undefined ? upcoming : [latestPast, ...upcoming];
    const list = kept.map((originalDate): Occurrence => ({ item, originalDate, shiftDays: 0, skipped: false }));
    occurrencesByItem.set(item.id, list);
    occurrences.push(...list);
  }

  // 3 + 5. What-ifs in body order: skips and moves mark occurrences; one-time items post directly.
  input.whatIfs.forEach((w, index) => {
    if (w.kind === "oneTime") {
      if (!has(w.accountId)) {
        report(index, false, "account not projected");
      } else if (w.date > endDate) {
        report(index, false, "after horizon");
      } else {
        const movedToToday = w.date < today;
        const date = movedToToday ? today : w.date;
        post(w.accountId, idx(date), w.amountCents);
        events.push({
          date,
          originalDate: w.date,
          accountId: w.accountId,
          amountCents: w.amountCents,
          kind: "one_time",
          recurringId: null,
          label: w.label ?? "One-time",
          applied: true,
          overdue: false,
          moved: movedToToday,
        });
        if (movedToToday) report(index, true, "moved to today");
        else report(index, true);
      }
      return;
    }
    const list = occurrencesByItem.get(w.recurringId);
    if (!list) {
      report(index, false, "unknown recurring id");
      return;
    }
    const wanted = w.occurrenceDate;
    if (wanted === undefined) {
      // Only a move may omit the date: shift every occurrence of the item.
      if (w.kind === "moveOccurrence") for (const o of list) o.shiftDays += w.shiftDays;
      report(index, true);
      return;
    }
    const occurrence = list.find((o) => o.originalDate === wanted);
    if (!occurrence) {
      report(index, false, `no occurrence of ${w.recurringId} on ${wanted}`);
      return;
    }
    if (w.kind === "skipOccurrence") occurrence.skipped = true;
    else occurrence.shiftDays += w.shiftDays;
    report(index, true);
  });

  // 4. Post the recurring events: shift, clamp to today (overdue), drop past the horizon.
  for (const o of occurrences) {
    const { item } = o;
    let date = addDays(o.originalDate, o.shiftDays);
    let overdue = false;
    if (date < today) {
      date = today;
      overdue = true;
    }
    if (date > endDate) continue;
    const applied = !o.skipped;
    const moved = o.shiftDays !== 0;
    const i = idx(date);
    const outbound = item.amountCents < 0n;
    if (has(item.accountId)) {
      const kind: CashFlowEventKind = item.kind === "transfer" ? (outbound ? "transfer_out" : "transfer_in") : item.kind;
      events.push({ date, originalDate: o.originalDate, accountId: item.accountId, amountCents: item.amountCents, kind, recurringId: item.id, label: item.name, applied, overdue, moved });
      if (applied) post(item.accountId, i, item.amountCents);
    }
    if (has(item.transferAccountId)) {
      const kind: CashFlowEventKind = outbound ? "transfer_in" : "transfer_out";
      events.push({ date, originalDate: o.originalDate, accountId: item.transferAccountId, amountCents: -item.amountCents, kind, recurringId: item.id, label: item.name, applied, overdue, moved });
      if (applied) post(item.transferAccountId, i, -item.amountCents);
    }
  }

  // 6. Spending spread: split each month's remaining across accounts, then over the month's remaining days.
  const spreads: CashFlowSpread[] = [];
  const projectedWeights = input.spendingWeights.filter((w) => accountById.has(w.accountId));
  const fallbackAccount = (): CashFlowAccount | null => {
    const primary = input.primaryAccountId === null ? undefined : accountById.get(input.primaryAccountId);
    if (primary) return primary;
    const byName = [...input.accounts].sort((a, b) => cmpStr(a.name, b.name) || cmpStr(a.id, b.id));
    return byName.find((a) => a.type === "checking") ?? byName[0] ?? null;
  };
  let warnedNoSpendingAccount = false;
  const plan = [...input.spendingPlan].sort((a, b) => cmpStr(a.month, b.month));
  for (const m of plan) {
    const first = monthStart(m.month);
    const last = monthEnd(m.month);
    if (last < today || first > endDate) continue;
    const total = maxBig(0n, m.remainingCents);
    const windowStart = first > today ? first : today;
    const days = dayDiff(windowStart, last) + 1;
    let shares = splitByWeights(total, projectedWeights);
    if (shares === null) {
      const carrier = fallbackAccount();
      if (!carrier) {
        if (!warnedNoSpendingAccount) warnings.push("no projected account to carry planned spending");
        warnedNoSpendingAccount = true;
        continue;
      }
      shares = new Map([[carrier.id, total]]);
    }
    const startIdx = idx(windowStart);
    for (const [accountId, share] of shares) {
      const { baseCents, extraCentDays } = spreadEvenly(share, days);
      for (let d = 0; d < days && startIdx + d <= horizonDays; d++) {
        post(accountId, startIdx + d, -(baseCents + (d < extraCentDays ? 1n : 0n)));
      }
      spreads.push({ month: m.month, accountId, totalCents: share, windowStart, days, baseCents, extraCentDays });
    }
  }

  // 7. Day loop: card payments read earlier end-of-day balances, then every account's point.
  const points = new Map<string, bigint[]>();
  for (const a of input.accounts) points.set(a.id, []);
  const payments = [...input.cardPayments]
    .filter((p) => accountById.has(p.cardAccountId))
    .sort((a, b) => cmpStr(a.cardAccountId, b.cardAccountId) || cmpStr(a.fromAccountId, b.fromAccountId));
  const paidCards = new Set(payments.map((p) => p.cardAccountId));
  for (const a of input.accounts) if (a.type === "credit" && !paidCards.has(a.id)) warnings.push(`card ${a.name} has no payment day`);
  const activePayments = payments.filter((p) => {
    if (accountById.has(p.fromAccountId)) return true;
    warnings.push(`card ${accountById.get(p.cardAccountId)?.name ?? p.cardAccountId} is paid from an account that is not projected`);
    return false;
  });
  for (let i = 0; i <= horizonDays; i++) {
    const d = dates[i] ?? today;
    const payDayOfMonth = daysInMonth(monthKey(d));
    for (const p of activePayments) {
      if (dayOfMonth(d) !== Math.min(p.payDay, payDayOfMonth)) continue;
      const card = accountById.get(p.cardAccountId);
      if (!card) continue;
      const s = statementDate(d, p.statementDay);
      const balance = s >= today ? (points.get(card.id)?.[idx(s)] ?? card.openingCents) : (p.knownStatementBalanceCents ?? card.openingCents);
      const owed = maxBig(0n, -balance);
      if (owed === 0n) continue;
      post(p.fromAccountId, i, -owed);
      post(p.cardAccountId, i, owed);
      const label = `${card.name} payment`;
      events.push({ date: d, originalDate: null, accountId: p.fromAccountId, amountCents: -owed, kind: "card_payment_out", recurringId: null, label, applied: true, overdue: false, moved: false });
      events.push({ date: d, originalDate: null, accountId: p.cardAccountId, amountCents: owed, kind: "card_payment_in", recurringId: null, label, applied: true, overdue: false, moved: false });
    }
    for (const a of input.accounts) {
      const row = points.get(a.id);
      if (!row) continue;
      const previous = i === 0 ? a.openingCents : (row[i - 1] ?? a.openingCents);
      row.push(previous + (delta.get(a.id)?.[i] ?? 0n));
    }
  }

  // 8. Series stats.
  const accounts: CashFlowAccountSeries[] = input.accounts.map((a) => {
    const thresholdCents = a.lowBalanceThresholdCents ?? (a.type === "checking" || a.type === "savings" ? input.defaultThresholdCents : null);
    return {
      accountId: a.id,
      name: a.name,
      type: a.type,
      balanceDate: a.balanceDate,
      ...seriesStats(a.openingCents, points.get(a.id) ?? [], dates, thresholdCents),
    };
  });
  const combinedPoints = dates.map((_, i) => accounts.reduce((sum, s) => sum + (s.points[i] ?? 0n), 0n));
  const combinedOpening = input.accounts.reduce((sum, a) => sum + a.openingCents, 0n);
  const combined = seriesStats(combinedOpening, combinedPoints, dates, input.defaultThresholdCents);

  // 9. Determinism: events sorted by (date, accountId, kind, recurringId, originalDate); accounts in input order.
  events.sort(compareEvents);

  return { today, endDate, dates, accounts, combined, events, spreads, whatIfs: whatIfReports, warnings };
}
