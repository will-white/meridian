import type { AggregatePriceStatus, ValuationSource } from "./api.js";
import { addDays, dayDiff, type IsoDate } from "./dates.js";
import { FIXED8_SCALE, fixed8ToCents, impliedPrice, mulToCents, type Fixed8 } from "./decimal.js";
import type {
  AccountType,
  AssetClass,
  CashInference,
  ExternalFlowKind,
  HoldingPriceSource,
  InvestmentFidelity,
  InvestmentPeriod,
  LineKind,
  PriceSource,
  PriceStatus,
  SecurityType,
  TaxTreatment,
  ValuationBasis,
  ValueSource,
} from "./enums.js";
import { periodStart } from "./investments.js";
import { dayOfWeek, previousTradingDay, tradingDaysBetween } from "./marketCalendar.js";
import { formatCents } from "./money.js";
import { monthEnd, monthKey, truncDiv } from "./months.js";
import { expectedCloseFor } from "./prices.js";

/**
 * The valuation chain (prices design §3.4, §3.7–§3.9 under plan decisions 8 and 12; seams
 * C19–C24, C26, C30). Pure and deterministic: no clock, no DB. `valueAccountOn` is the ONE
 * definition of an investment account's value on a date; every consumer (Portfolio, Holdings,
 * Allocation, the dashboard block, the reconcile preview, day and period change, the
 * performance engine's points for non-full accounts, the `investments.valuation` job) reads it.
 *
 * The chain, for account A on date D:
 *
 *   1. `snapshot`  – a holding snapshot dated D: every line at its statement value.
 *   2. `lots`      – derived fidelity `full_history` and the latest lot-derived position
 *                    checkpoint on or before D is newer than the latest snapshot: the
 *                    checkpoint's quantities priced on D (`mulToCents`, R1).
 *   3. `positions` – the latest snapshot on or before D, repriced: a line is `mulToCents(quantity,
 *                    close)` only when a price STRICTLY newer than the snapshot exists on or
 *                    before D, else the statement value carried; dollar-only rows (no quantity)
 *                    always at the statement value; cash securities at 1.
 *   4. `balance`   – the latest reported balance on or before D.
 *   5. `none`.
 *
 * Cash is anchored the same way for every valued basis (decision 8, the lots design's D19):
 * `anchor` = the latest REPORTED balance (`source ≠ computed`) on or before D;
 * `cash_plug = anchor.balance − Σ positions priced on anchor.date`, carried forward. A positive
 * plug is a `cash_plug` line "Cash (from balance)"; a negative one is a `negative_residual`
 * warning and never negative cash. Cash transfers after the anchor are carried as a
 * `carried_flows` line; on the lots basis the trades' own cash legs after the anchor (buys −,
 * sells +, dividends, interest, fees) are a `cash` line "Cash (from trades)". `cash_inference =
 * off` disables all of it: the value is the positions alone.
 *
 * Price status (§3.4, C26) is user-facing freshness: trading days behind the expected close,
 * for `provider`-mode securities only; `implied` and `manual` modes report their mode;
 * `statement` on the snapshot date; `carried` for a value without any price (dollar-only);
 * `cash`; `missing` when a lots-basis position has no price at all (the account value is then
 * null and the security is listed in `missing`). The engine's 7-day `stale_price` warning
 * (lots.ts) is a separate, engine-level rule.
 *
 * Treat a `ValuationInput` as immutable once passed in: the per-input indexes are cached by
 * identity so a series over 3,660 days costs binary searches, not rescans.
 */

// ---- Input (filled by the db loader, step 8) ----

export interface ValuationAccount {
  id: string;
  name: string;
  type: AccountType;
  taxTreatment: TaxTreatment;
  /** Derived (decision 7); the lots step runs only for `full_history`. */
  fidelity: InvestmentFidelity;
  cashInference: CashInference;
}

export interface ValuationSecurity {
  id: string;
  ticker: string | null;
  name: string;
  type: SecurityType;
  assetClass: AssetClass | null;
  priceMode: PriceSource;
}

/** A `price` row's source, or `txn` when the loader adds trade prices for full-history accounts. */
export type ValuationPriceSource = Exclude<HoldingPriceSource, "statement" | "cash">;

export interface ValuationPrice {
  securityId: string;
  date: IsoDate;
  close: Fixed8;
  source: ValuationPriceSource;
}

/** One `holding_snapshot` row. `quantity` null = dollar-only (value known, units not reported). */
export interface ValuationSnapshotLine {
  accountId: string;
  securityId: string;
  date: IsoDate;
  quantity: Fixed8 | null;
  price: Fixed8 | null;
  valueCents: bigint;
}

/** One `balance_snapshot` row; `computed` rows are ignored by the engine (they are its own output). */
export interface ValuationBalance {
  accountId: string;
  date: IsoDate;
  balanceCents: bigint;
  source: ValuationSource;
}

/** A signed external flow from `loadExternalFlows` (decision 11); only `cash` flows are carried as cash. */
export interface ValuationFlow {
  accountId: string;
  date: IsoDate;
  amountCents: bigint;
  kind: ExternalFlowKind;
}

/**
 * A lot-derived position checkpoint (the lot engine's `positions`, one per date the quantities
 * changed; several on one date → the last given wins). Read only for `full_history` accounts.
 */
export interface ValuationTradePosition {
  accountId: string;
  date: IsoDate;
  quantityBySecurity: ReadonlyMap<string, Fixed8>;
}

/** The lot engine's `cashEffects` (trade legs, dividends, interest, fees); rolls cash forward on the lots basis. */
export interface ValuationCashEffect {
  accountId: string;
  date: IsoDate;
  cents: bigint;
}

export interface ValuationInput {
  /** `expectedPriceDate(now)`: the latest close the feed can have. */
  expectedThrough: IsoDate;
  accounts: readonly ValuationAccount[];
  securities: readonly ValuationSecurity[];
  prices: readonly ValuationPrice[];
  snapshots: readonly ValuationSnapshotLine[];
  balances: readonly ValuationBalance[];
  flows: readonly ValuationFlow[];
  tradePositions: readonly ValuationTradePosition[];
  cashEffects?: readonly ValuationCashEffect[];
}

// ---- Output ----

export interface LineValuation {
  /** Null for the synthetic cash lines (`cash_plug`, `carried_flows`, the lots basis' `cash`). */
  securityId: string | null;
  ticker: string | null;
  name: string;
  kind: LineKind;
  quantity: Fixed8 | null;
  price: Fixed8 | null;
  /** The price's date; for a synthetic line the date it is carried from. */
  priceDate: IsoDate | null;
  priceSource: HoldingPriceSource | null;
  priceStatus: PriceStatus;
  tradingDaysBehind: number;
  valueCents: bigint | null;
  valueSource: ValueSource;
}

export interface StalestPrice {
  securityId: string;
  priceDate: IsoDate;
  tradingDaysBehind: number;
}

export type ValuationWarningCode = "negative_residual" | "anchor_unpriced";

export interface ValuationWarning {
  code: ValuationWarningCode;
  message: string;
  cents: bigint | null;
}

export interface AccountValuation {
  accountId: string;
  name: string;
  type: AccountType;
  taxTreatment: TaxTreatment;
  fidelity: InvestmentFidelity;
  cashInference: CashInference;
  date: IsoDate;
  basis: ValuationBasis;
  /** The date of the data the value rests on (the statement, the checkpoint or the balance). */
  asOf: IsoDate | null;
  /** Σ lines; null when a lots-basis line is unpriced or the basis is `none`. */
  valueCents: bigint | null;
  priceStatus: AggregatePriceStatus;
  stalest: StalestPrice | null;
  /** Securities without any usable price (lots basis only). */
  missing: string[];
  /** value − the reported balance dated D, when one exists and the basis is valued. */
  balanceDiffCents: bigint | null;
  /** The reported balance the cash plug is anchored on. */
  cashAnchor: IsoDate | null;
  /** Position and cash lines in security id order, then the synthetic cash lines. */
  lines: LineValuation[];
  warnings: ValuationWarning[];
}

export const CASH_PLUG_NAME = "Cash (from balance)";
export const TRADE_CASH_NAME = "Cash (from trades)";

// ---- Prepared context (cached per input by identity) ----

interface DatedSums {
  dates: IsoDate[];
  /** cum[i] = Σ amounts of items 0..i in date order. */
  cum: bigint[];
}

interface AccountData {
  account: ValuationAccount;
  snapshotDates: IsoDate[];
  /** Lines per snapshot date, sorted by security id. */
  snapshotLines: Map<IsoDate, ValuationSnapshotLine[]>;
  /** Reported rows only, one per date, ascending. */
  balances: ValuationBalance[];
  balanceDates: IsoDate[];
  cashFlows: DatedSums;
  allFlows: DatedSums;
  cashEffects: DatedSums;
  /** One per date, ascending; empty unless `full_history`. */
  checkpoints: ValuationTradePosition[];
  checkpointDates: IsoDate[];
  firstDataDate: IsoDate | null;
}

interface PriceIndex {
  dates: IsoDate[];
  rows: ValuationPrice[];
}

interface Context {
  input: ValuationInput;
  accounts: Map<string, AccountData>;
  securities: Map<string, ValuationSecurity>;
  prices: Map<string, PriceIndex>;
  countBehind: (from: IsoDate, to: IsoDate) => number;
}

const contexts = new WeakMap<ValuationInput, Context>();

function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Index of the first date > `date` in an ascending array (= the count of dates ≤ `date`). */
function upperBound(dates: readonly IsoDate[], date: IsoDate): number {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (dates[mid]! <= date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function groupByAccount<T extends { accountId: string }>(items: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const list = out.get(item.accountId);
    if (list) list.push(item);
    else out.set(item.accountId, [item]);
  }
  return out;
}

function datedSums<T>(items: readonly T[], dateOf: (t: T) => IsoDate, amountOf: (t: T) => bigint): DatedSums {
  const sorted = [...items].sort((a, b) => compareDates(dateOf(a), dateOf(b)));
  const dates: IsoDate[] = [];
  const cum: bigint[] = [];
  let acc = 0n;
  for (const item of sorted) {
    acc += amountOf(item);
    dates.push(dateOf(item));
    cum.push(acc);
  }
  return { dates, cum };
}

/** Σ of the items dated ≤ `date`. */
function sumThrough(s: DatedSums, date: IsoDate): bigint {
  const i = upperBound(s.dates, date);
  return i === 0 ? 0n : s.cum[i - 1]!;
}

/** Σ of the items dated in (`after`, `through`]; from inception when `after` is null. */
function sumBetween(s: DatedSums, after: IsoDate | null, through: IsoDate): bigint {
  return sumThrough(s, through) - (after === null ? 0n : sumThrough(s, after));
}

/** Keep the last item per date of an ascending (stably sorted) list. */
function lastPerDate<T extends { date: IsoDate }>(sorted: readonly T[]): T[] {
  const out: T[] = [];
  for (const item of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.date === item.date) out[out.length - 1] = item;
    else out.push(item);
  }
  return out;
}

function buildAccount(
  account: ValuationAccount,
  snapshots: readonly ValuationSnapshotLine[],
  balances: readonly ValuationBalance[],
  flows: readonly ValuationFlow[],
  checkpoints: readonly ValuationTradePosition[],
  cashEffects: readonly ValuationCashEffect[],
): AccountData {
  const snapshotLines = new Map<IsoDate, ValuationSnapshotLine[]>();
  for (const line of snapshots) {
    const list = snapshotLines.get(line.date);
    if (list) list.push(line);
    else snapshotLines.set(line.date, [line]);
  }
  for (const lines of snapshotLines.values()) lines.sort((a, b) => compareIds(a.securityId, b.securityId));
  const snapshotDates = [...snapshotLines.keys()].sort(compareDates);

  const reported = lastPerDate(balances.filter((b) => b.source !== "computed").sort((a, b) => compareDates(a.date, b.date)));
  const full = account.fidelity === "full_history";
  const cps = full ? lastPerDate([...checkpoints].sort((a, b) => compareDates(a.date, b.date))) : [];

  const candidates = [snapshotDates[0], reported[0]?.date, cps[0]?.date].filter((d): d is IsoDate => d !== undefined);
  const firstDataDate = candidates.length === 0 ? null : candidates.reduce((min, d) => (d < min ? d : min));

  return {
    account,
    snapshotDates,
    snapshotLines,
    balances: reported,
    balanceDates: reported.map((b) => b.date),
    cashFlows: datedSums(
      flows.filter((f) => f.kind === "cash"),
      (f) => f.date,
      (f) => f.amountCents,
    ),
    allFlows: datedSums(
      flows,
      (f) => f.date,
      (f) => f.amountCents,
    ),
    cashEffects: datedSums(
      cashEffects,
      (e) => e.date,
      (e) => e.cents,
    ),
    checkpoints: cps,
    checkpointDates: cps.map((c) => c.date),
    firstDataDate,
  };
}

function buildContext(input: ValuationInput): Context {
  const securities = new Map<string, ValuationSecurity>();
  for (const s of input.securities) securities.set(s.id, s);

  const rowsBySecurity = new Map<string, ValuationPrice[]>();
  for (const p of input.prices) {
    const list = rowsBySecurity.get(p.securityId);
    if (list) list.push(p);
    else rowsBySecurity.set(p.securityId, [p]);
  }
  const prices = new Map<string, PriceIndex>();
  for (const [securityId, list] of rowsBySecurity) {
    const rows = lastPerDate(list.sort((a, b) => compareDates(a.date, b.date)));
    prices.set(securityId, { dates: rows.map((r) => r.date), rows });
  }

  const snapshots = groupByAccount(input.snapshots);
  const balances = groupByAccount(input.balances);
  const flows = groupByAccount(input.flows);
  const checkpoints = groupByAccount(input.tradePositions);
  const cashEffects = groupByAccount(input.cashEffects ?? []);
  const accounts = new Map<string, AccountData>();
  for (const account of input.accounts) {
    accounts.set(
      account.id,
      buildAccount(
        account,
        snapshots.get(account.id) ?? [],
        balances.get(account.id) ?? [],
        flows.get(account.id) ?? [],
        checkpoints.get(account.id) ?? [],
        cashEffects.get(account.id) ?? [],
      ),
    );
  }

  // Trading days behind, memoized per `from` and extended incrementally as `to` advances
  // (a series sweeps dates forward, so each call costs the days since the previous one).
  const behindMemo = new Map<IsoDate, { to: IsoDate; count: number }>();
  const countBehind = (from: IsoDate, to: IsoDate): number => {
    const memo = behindMemo.get(from);
    const count = memo && to >= memo.to ? memo.count + tradingDaysBetween(memo.to, to) : tradingDaysBetween(from, to);
    behindMemo.set(from, { to, count });
    return count;
  };

  return { input, accounts, securities, prices, countBehind };
}

function contextOf(input: ValuationInput): Context {
  let ctx = contexts.get(input);
  if (!ctx) {
    ctx = buildContext(input);
    contexts.set(input, ctx);
  }
  return ctx;
}

function accountOf(ctx: Context, accountId: string): AccountData {
  const acct = ctx.accounts.get(accountId);
  if (!acct) throw new Error(`valuation: unknown account ${accountId}`);
  return acct;
}

function securityOf(ctx: Context, securityId: string): ValuationSecurity {
  const sec = ctx.securities.get(securityId);
  if (!sec) throw new Error(`valuation: unknown security ${securityId}`);
  return sec;
}

function priceRowOn(ctx: Context, securityId: string, date: IsoDate): ValuationPrice | null {
  const index = ctx.prices.get(securityId);
  if (!index) return null;
  const i = upperBound(index.dates, date);
  return i === 0 ? null : index.rows[i - 1]!;
}

function latestBalance(acct: AccountData, date: IsoDate): ValuationBalance | null {
  const i = upperBound(acct.balanceDates, date);
  return i === 0 ? null : acct.balances[i - 1]!;
}

function latestCheckpoint(acct: AccountData, date: IsoDate): ValuationTradePosition | null {
  const i = upperBound(acct.checkpointDates, date);
  return i === 0 ? null : acct.checkpoints[i - 1]!;
}

function latestSnapshotDate(acct: AccountData, date: IsoDate): IsoDate | null {
  const i = upperBound(acct.snapshotDates, date);
  return i === 0 ? null : acct.snapshotDates[i - 1]!;
}

// ---- §3.4 Price lookup and status ----

/** The latest price row dated on or before `date` (any source), or null. */
export function priceOn(input: ValuationInput, securityId: string, date: IsoDate): ValuationPrice | null {
  return priceRowOn(contextOf(input), securityId, date);
}

export interface PriceStatusResult {
  priceStatus: PriceStatus;
  tradingDaysBehind: number;
}

/**
 * User-facing freshness of a price dated `priceDate` used on `date` (§3.4, C26): cash securities
 * are `cash`; no price → `fallback` (`carried` when a statement value stands in, else `missing`);
 * `provider` mode → `stale` with the trading days between the price and the expected close for
 * `date` (capped at `expectedThrough`), or `current`; `implied` and `manual` modes report the mode.
 */
export function priceStatusOf(
  security: Pick<ValuationSecurity, "type" | "priceMode">,
  priceDate: IsoDate | null,
  date: IsoDate,
  expectedThrough: IsoDate,
  fallback: "carried" | "missing" = "missing",
  countBehind: (from: IsoDate, to: IsoDate) => number = tradingDaysBetween,
): PriceStatusResult {
  if (security.type === "cash") return { priceStatus: "cash", tradingDaysBehind: 0 };
  if (priceDate === null) return { priceStatus: fallback, tradingDaysBehind: 0 };
  switch (security.priceMode) {
    case "provider": {
      const expected = expectedCloseFor(date, expectedThrough);
      if (priceDate < expected) return { priceStatus: "stale", tradingDaysBehind: countBehind(priceDate, expected) };
      return { priceStatus: "current", tradingDaysBehind: 0 };
    }
    case "implied":
      return { priceStatus: "implied", tradingDaysBehind: 0 };
    case "manual":
      return { priceStatus: "manual", tradingDaysBehind: 0 };
  }
}

// ---- Lines ----

function lineBase(security: ValuationSecurity): Pick<LineValuation, "securityId" | "ticker" | "name"> {
  return { securityId: security.id, ticker: security.ticker, name: security.name };
}

/** A snapshot row valued on `date` (its own date, or later: repriced only by a strictly newer price). */
function snapshotLine(ctx: Context, line: ValuationSnapshotLine, date: IsoDate): LineValuation {
  const security = securityOf(ctx, line.securityId);
  const onDate = line.date === date;
  const base = lineBase(security);
  if (security.type === "cash") {
    const valueCents = onDate || line.quantity === null ? line.valueCents : fixed8ToCents(line.quantity);
    return {
      ...base,
      kind: "cash",
      quantity: line.quantity,
      price: FIXED8_SCALE,
      priceDate: line.date,
      priceSource: "cash",
      priceStatus: "cash",
      tradingDaysBehind: 0,
      valueCents,
      valueSource: onDate ? "statement" : "priced",
    };
  }
  if (line.quantity === null) {
    return {
      ...base,
      kind: "position",
      quantity: null,
      price: null,
      priceDate: line.date,
      priceSource: "statement",
      priceStatus: onDate ? "statement" : "carried",
      tradingDaysBehind: 0,
      valueCents: line.valueCents,
      valueSource: onDate ? "statement" : "carried",
    };
  }
  const row = onDate ? null : priceRowOn(ctx, security.id, date);
  if (row && row.date > line.date) {
    return {
      ...base,
      kind: "position",
      quantity: line.quantity,
      price: row.close,
      priceDate: row.date,
      priceSource: row.source,
      ...priceStatusOf(security, row.date, date, ctx.input.expectedThrough, "missing", ctx.countBehind),
      valueCents: mulToCents(line.quantity, row.close),
      valueSource: "priced",
    };
  }
  const price = line.price ?? (line.quantity === 0n ? null : impliedPrice(line.valueCents, line.quantity));
  const status: PriceStatusResult = onDate
    ? { priceStatus: "statement", tradingDaysBehind: 0 }
    : priceStatusOf(security, line.date, date, ctx.input.expectedThrough, "carried", ctx.countBehind);
  return {
    ...base,
    kind: "position",
    quantity: line.quantity,
    price,
    priceDate: line.date,
    priceSource: "statement",
    ...status,
    valueCents: line.valueCents,
    valueSource: onDate ? "statement" : "carried",
  };
}

/** A lot-derived quantity priced on `date`; unpriced when the security has no price row at all. */
function lotsLine(ctx: Context, security: ValuationSecurity, quantity: Fixed8, date: IsoDate): LineValuation {
  const base = lineBase(security);
  if (security.type === "cash") {
    return {
      ...base,
      kind: "cash",
      quantity,
      price: FIXED8_SCALE,
      priceDate: date,
      priceSource: "cash",
      priceStatus: "cash",
      tradingDaysBehind: 0,
      valueCents: fixed8ToCents(quantity),
      valueSource: "priced",
    };
  }
  const row = priceRowOn(ctx, security.id, date);
  if (!row) {
    return {
      ...base,
      kind: "position",
      quantity,
      price: null,
      priceDate: null,
      priceSource: null,
      priceStatus: "missing",
      tradingDaysBehind: 0,
      valueCents: null,
      valueSource: "unpriced",
    };
  }
  return {
    ...base,
    kind: "position",
    quantity,
    price: row.close,
    priceDate: row.date,
    priceSource: row.source,
    ...priceStatusOf(security, row.date, date, ctx.input.expectedThrough, "missing", ctx.countBehind),
    valueCents: mulToCents(quantity, row.close),
    valueSource: "priced",
  };
}

function syntheticLine(kind: Extract<LineKind, "cash" | "cash_plug" | "carried_flows">, name: string, priceDate: IsoDate | null, valueCents: bigint): LineValuation {
  return {
    securityId: null,
    ticker: null,
    name,
    kind,
    quantity: null,
    price: null,
    priceDate,
    priceSource: null,
    priceStatus: "cash",
    tradingDaysBehind: 0,
    valueCents,
    valueSource: "carried",
  };
}

/** Lines of the snapshot dated `snapshotDate` valued on `date`; rows that are empty either way are dropped. */
function snapshotLinesOn(ctx: Context, acct: AccountData, snapshotDate: IsoDate, date: IsoDate): LineValuation[] {
  const rows = acct.snapshotLines.get(snapshotDate) ?? [];
  return rows.filter((r) => !(r.quantity === 0n && r.valueCents === 0n)).map((r) => snapshotLine(ctx, r, date));
}

/** Σ of a snapshot's lines valued on `date` (never null: a statement value always stands in). */
function snapshotSecuritiesOn(ctx: Context, acct: AccountData, snapshotDate: IsoDate, date: IsoDate): bigint {
  let sum = 0n;
  for (const line of snapshotLinesOn(ctx, acct, snapshotDate, date)) sum += line.valueCents ?? 0n;
  return sum;
}

function checkpointEntries(checkpoint: ValuationTradePosition): Array<[string, Fixed8]> {
  return [...checkpoint.quantityBySecurity.entries()].filter(([, q]) => q !== 0n).sort(([a], [b]) => compareIds(a, b));
}

/** Σ of the lot-derived positions on `date` priced on `date`; null when any is unpriced. */
function checkpointSecuritiesOn(ctx: Context, acct: AccountData, date: IsoDate): bigint | null {
  const checkpoint = latestCheckpoint(acct, date);
  if (!checkpoint) return 0n;
  let sum = 0n;
  for (const [securityId, quantity] of checkpointEntries(checkpoint)) {
    const line = lotsLine(ctx, securityOf(ctx, securityId), quantity, date);
    if (line.valueCents === null) return null;
    sum += line.valueCents;
  }
  return sum;
}

// ---- Cash inference (decision 8) ----

interface CashBlock {
  anchor: ValuationBalance | null;
  lines: LineValuation[];
  warnings: ValuationWarning[];
}

/**
 * The anchored plug, the lots basis' trade cash and the carried transfers. `securitiesAt(d)` is
 * Σ of the current basis' positions priced on `d`; `carriedFrom` is where carried cash starts
 * without an anchor (the snapshot date for the snapshot/positions bases, inception for lots).
 */
function inferCash(
  ctx: Context,
  acct: AccountData,
  date: IsoDate,
  basis: "snapshot" | "positions" | "lots",
  securitiesAt: (d: IsoDate) => bigint | null,
  carriedFrom: IsoDate | null,
): CashBlock {
  if (acct.account.cashInference === "off") return { anchor: null, lines: [], warnings: [] };
  const lines: LineValuation[] = [];
  const warnings: ValuationWarning[] = [];
  const anchor = latestBalance(acct, date);
  if (anchor) {
    const securities = securitiesAt(anchor.date);
    if (securities === null) {
      warnings.push({
        code: "anchor_unpriced",
        message: `Cash could not be inferred from the ${anchor.date} balance: a position has no price on that date`,
        cents: null,
      });
    } else {
      const plug = anchor.balanceCents - securities;
      if (plug > 0n) lines.push(syntheticLine("cash_plug", CASH_PLUG_NAME, anchor.date, plug));
      else if (plug < 0n) {
        warnings.push({
          code: "negative_residual",
          message: `Holdings exceed the account value by $${formatCents(-plug)}: the positions are newer than the balance, or the balance is stale`,
          cents: plug,
        });
      }
    }
  }
  const after = anchor ? anchor.date : carriedFrom;
  if (basis === "lots") {
    const tradeCash = sumBetween(acct.cashEffects, after, date);
    if (tradeCash !== 0n) lines.push(syntheticLine("cash", TRADE_CASH_NAME, after, tradeCash));
  }
  const carried = sumBetween(acct.cashFlows, after, date);
  if (carried !== 0n) lines.push(syntheticLine("carried_flows", after === null ? "Transfers" : `Transfers since ${after}`, after, carried));
  return { anchor, lines, warnings };
}

// ---- §3.7 valueAccountOn ----

function aggregateStatus(lines: readonly LineValuation[]): { priceStatus: AggregatePriceStatus; stalest: StalestPrice | null } {
  let stalest: StalestPrice | null = null;
  let implied = false;
  for (const line of lines) {
    if (line.kind !== "position" || line.securityId === null) continue;
    if (line.priceStatus === "stale" && line.priceDate !== null) {
      if (!stalest || line.tradingDaysBehind > stalest.tradingDaysBehind) {
        stalest = { securityId: line.securityId, priceDate: line.priceDate, tradingDaysBehind: line.tradingDaysBehind };
      }
    } else if (line.priceStatus === "implied" || line.priceStatus === "carried") implied = true;
  }
  if (stalest) return { priceStatus: "stale", stalest };
  return { priceStatus: implied ? "implied" : "current", stalest: null };
}

/** The one definition of an investment account's value on a date (plan decision 8). */
export function valueAccountOn(input: ValuationInput, accountId: string, date: IsoDate): AccountValuation {
  const ctx = contextOf(input);
  const acct = accountOf(ctx, accountId);
  const account = acct.account;
  const snapshotDate = latestSnapshotDate(acct, date);
  const checkpoint = latestCheckpoint(acct, date);
  const balance = latestBalance(acct, date);
  const head = {
    accountId: account.id,
    name: account.name,
    type: account.type,
    taxTreatment: account.taxTreatment,
    fidelity: account.fidelity,
    cashInference: account.cashInference,
    date,
  };

  let basis: ValuationBasis;
  let asOf: IsoDate;
  let positionLines: LineValuation[];
  let cash: CashBlock;
  if (snapshotDate === date) {
    basis = "snapshot";
    asOf = snapshotDate;
    positionLines = snapshotLinesOn(ctx, acct, snapshotDate, date);
    cash = inferCash(ctx, acct, date, basis, (d) => snapshotSecuritiesOn(ctx, acct, snapshotDate, d), snapshotDate);
  } else if (checkpoint && (snapshotDate === null || checkpoint.date > snapshotDate)) {
    basis = "lots";
    asOf = checkpoint.date;
    positionLines = checkpointEntries(checkpoint).map(([securityId, quantity]) => lotsLine(ctx, securityOf(ctx, securityId), quantity, date));
    cash = inferCash(ctx, acct, date, basis, (d) => checkpointSecuritiesOn(ctx, acct, d), null);
  } else if (snapshotDate !== null) {
    basis = "positions";
    asOf = snapshotDate;
    positionLines = snapshotLinesOn(ctx, acct, snapshotDate, date);
    cash = inferCash(ctx, acct, date, basis, (d) => snapshotSecuritiesOn(ctx, acct, snapshotDate, d), snapshotDate);
  } else if (balance) {
    return {
      ...head,
      basis: "balance",
      asOf: balance.date,
      valueCents: balance.balanceCents,
      priceStatus: "n/a",
      stalest: null,
      missing: [],
      balanceDiffCents: null,
      cashAnchor: null,
      lines: [],
      warnings: [],
    };
  } else {
    return {
      ...head,
      basis: "none",
      asOf: null,
      valueCents: null,
      priceStatus: "n/a",
      stalest: null,
      missing: [],
      balanceDiffCents: null,
      cashAnchor: null,
      lines: [],
      warnings: [],
    };
  }

  const lines = [...positionLines, ...cash.lines];
  const missing = positionLines.filter((l) => l.valueSource === "unpriced" && l.securityId !== null).map((l) => l.securityId!);
  let valueCents: bigint | null = 0n;
  for (const line of lines) {
    if (line.valueCents === null) {
      valueCents = null;
      break;
    }
    valueCents += line.valueCents;
  }
  const { priceStatus, stalest } = aggregateStatus(positionLines);
  return {
    ...head,
    basis,
    asOf,
    valueCents,
    priceStatus,
    stalest,
    missing,
    balanceDiffCents: balance && balance.date === date && valueCents !== null ? valueCents - balance.balanceCents : null,
    cashAnchor: cash.anchor?.date ?? null,
    lines,
    warnings: cash.warnings,
  };
}

/** The earliest date the account can be valued on: its first snapshot, reported balance or (full history) checkpoint. */
export function firstDataDate(input: ValuationInput, accountId: string): IsoDate | null {
  return accountOf(contextOf(input), accountId).firstDataDate;
}

// ---- §3.8 valueSeries ----

export const MAX_SERIES_DAYS = 3660;

export type SeriesStep = "day" | "week" | "month";

export interface SeriesPoint {
  date: IsoDate;
  /** Σ of the valued accounts; null when none is valued. */
  valueCents: bigint | null;
  /** True when any selected account has no value on the date. */
  partial: boolean;
  /** Account ids without a value. */
  missing: string[];
  /** The worst over the valued accounts: stale > implied > current; n/a when none is valued. */
  priceStatus: AggregatePriceStatus;
}

export interface SeriesAccount {
  accountId: string;
  name: string;
  type: AccountType;
  fidelity: InvestmentFidelity;
  firstDataDate: IsoDate | null;
  /** One per `dates` entry. */
  values: Array<bigint | null>;
}

export interface ValueSeries {
  dates: IsoDate[];
  accounts: SeriesAccount[];
  portfolio: SeriesPoint[];
}

/**
 * The dates of a series: every day (`day`), the Fridays (`week`) or the month ends (`month`)
 * in `from..to`, always ending on `to`. Throws a RangeError when `to < from` or the range is
 * longer than `MAX_SERIES_DAYS` (the service maps it to `400 validation`).
 */
export function seriesDates(from: IsoDate, to: IsoDate, step: SeriesStep = "day"): IsoDate[] {
  if (to < from) throw new RangeError(`series range ends before it starts (${from}..${to})`);
  const days = dayDiff(from, to);
  if (days > MAX_SERIES_DAYS) throw new RangeError(`series range of ${days} days exceeds ${MAX_SERIES_DAYS}`);
  const dates: IsoDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (step === "day" || (step === "week" && dayOfWeek(d) === 5) || (step === "month" && d === monthEnd(monthKey(d)))) dates.push(d);
  }
  if (dates[dates.length - 1] !== to) dates.push(to);
  return dates;
}

const STATUS_RANK: Record<AggregatePriceStatus, number> = { "n/a": 0, current: 1, implied: 2, stale: 3 };

function worstStatus(statuses: readonly AggregatePriceStatus[]): AggregatePriceStatus {
  let worst: AggregatePriceStatus = "n/a";
  for (const s of statuses) if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
  return worst;
}

/** Per-account values and the portfolio total on every series date, by the one chain. */
export function valueSeries(input: ValuationInput, accountIds: readonly string[], from: IsoDate, to: IsoDate, step: SeriesStep = "day"): ValueSeries {
  const ctx = contextOf(input);
  const dates = seriesDates(from, to, step);
  const accounts: SeriesAccount[] = accountIds.map((id) => {
    const acct = accountOf(ctx, id);
    return { accountId: id, name: acct.account.name, type: acct.account.type, fidelity: acct.account.fidelity, firstDataDate: acct.firstDataDate, values: [] };
  });
  const portfolio: SeriesPoint[] = [];
  for (const date of dates) {
    let total: bigint | null = null;
    const missing: string[] = [];
    const statuses: AggregatePriceStatus[] = [];
    accounts.forEach((entry) => {
      const v = valueAccountOn(input, entry.accountId, date);
      entry.values.push(v.valueCents);
      if (v.valueCents === null) missing.push(entry.accountId);
      else {
        total = (total ?? 0n) + v.valueCents;
        statuses.push(v.priceStatus);
      }
    });
    portfolio.push({ date, valueCents: total, partial: missing.length > 0, missing, priceStatus: worstStatus(statuses) });
  }
  return { dates, accounts, portfolio };
}

// ---- §3.9 dayChange ----

export type DayChangeReason = "no_prices" | "balance_only" | "no_value" | "missing_price" | "missing_prior_price";

export interface PricePoint {
  date: IsoDate;
  close: Fixed8;
  source: ValuationPriceSource;
}

export interface DayChangeLine {
  securityId: string;
  ticker: string | null;
  name: string;
  quantity: Fixed8;
  /** `mulToCents(q, close(asOf)) − mulToCents(q, close(prior))`; null when a close is missing. */
  cents: bigint | null;
  asOfPrice: PricePoint | null;
  priorPrice: PricePoint | null;
  /** The line's status in the valuation on the requested date. */
  priceStatus: PriceStatus;
}

export interface AccountDayChange {
  accountId: string;
  cents: bigint | null;
  asOf: IsoDate | null;
  prior: IsoDate | null;
  reason: DayChangeReason | null;
  lines: DayChangeLine[];
}

export interface PortfolioDayChange {
  /** Σ over the included accounts; null when none is included. */
  cents: bigint | null;
  asOf: IsoDate | null;
  prior: IsoDate | null;
  reason: DayChangeReason | null;
  /** cents ÷ the included accounts' prior value, in basis points (truncated); null without a positive base. */
  bp: number | null;
  partial: boolean;
  excluded: Array<{ accountId: string; reason: DayChangeReason }>;
  accounts: AccountDayChange[];
}

function pricePoint(row: ValuationPrice): PricePoint {
  return { date: row.date, close: row.close, source: row.source };
}

function accountDayChange(ctx: Context, valuation: AccountValuation, asOf: IsoDate, prior: IsoDate): AccountDayChange {
  if (valuation.basis === "balance") return { accountId: valuation.accountId, cents: null, asOf, prior, reason: "balance_only", lines: [] };
  if (valuation.basis === "none") return { accountId: valuation.accountId, cents: null, asOf, prior, reason: "no_value", lines: [] };
  const lines: DayChangeLine[] = [];
  let cents = 0n;
  let reason: DayChangeReason | null = null;
  for (const line of valuation.lines) {
    if (line.kind !== "position" || line.securityId === null || line.quantity === null) continue;
    const security = securityOf(ctx, line.securityId);
    if (security.type === "cash") continue;
    const current = priceRowOn(ctx, security.id, asOf);
    const previous = priceRowOn(ctx, security.id, prior);
    const lineCents = current && previous ? mulToCents(line.quantity, current.close) - mulToCents(line.quantity, previous.close) : null;
    if (lineCents === null) {
      if (!current) reason = "missing_price";
      else if (reason === null) reason = "missing_prior_price";
    } else cents += lineCents;
    lines.push({
      securityId: security.id,
      ticker: security.ticker,
      name: security.name,
      quantity: line.quantity,
      cents: lineCents,
      asOfPrice: current ? pricePoint(current) : null,
      priorPrice: previous ? pricePoint(previous) : null,
      priceStatus: line.priceStatus,
    });
  }
  return { accountId: valuation.accountId, cents: reason === null ? cents : null, asOf, prior, reason, lines };
}

/**
 * Price movement on the quantities held on `date` (decision 12): `asOf` = the latest price date
 * on or before `min(date, expectedThrough)` among the selected accounts' provider-mode positions,
 * `prior` = the trading day before it. Balance-only accounts are excluded with a reason and the
 * total is marked partial; cash, plug and carried lines move nothing.
 */
export function dayChange(input: ValuationInput, accountIds: readonly string[], date: IsoDate): PortfolioDayChange {
  const ctx = contextOf(input);
  const valuations = accountIds.map((id) => valueAccountOn(input, id, date));
  const cap = date < input.expectedThrough ? date : input.expectedThrough;
  let asOf: IsoDate | null = null;
  for (const v of valuations) {
    for (const line of v.lines) {
      if (line.kind !== "position" || line.securityId === null) continue;
      const security = securityOf(ctx, line.securityId);
      if (security.priceMode !== "provider") continue;
      const row = priceRowOn(ctx, security.id, cap);
      if (row && (asOf === null || row.date > asOf)) asOf = row.date;
    }
  }
  if (asOf === null) {
    // Nothing to price: each account says why in its own terms (a balance-only account is not
    // waiting for prices); the portfolio repeats the reason only when every account shares it.
    const reasonFor = (v: AccountValuation): DayChangeReason => (v.basis === "balance" ? "balance_only" : v.basis === "none" ? "no_value" : "no_prices");
    const excluded = valuations.map((v) => ({ accountId: v.accountId, reason: reasonFor(v) }));
    const shared = excluded.length > 0 && excluded.every((e) => e.reason === excluded[0]!.reason) ? excluded[0]!.reason : "no_prices";
    return {
      cents: null,
      asOf: null,
      prior: null,
      reason: shared,
      bp: null,
      partial: accountIds.length > 0,
      excluded,
      accounts: valuations.map((v) => ({ accountId: v.accountId, cents: null, asOf: null, prior: null, reason: reasonFor(v), lines: [] })),
    };
  }
  const prior = previousTradingDay(asOf);
  const accounts = valuations.map((v) => accountDayChange(ctx, v, asOf, prior));
  const excluded: PortfolioDayChange["excluded"] = [];
  let cents = 0n;
  let priorValue = 0n;
  let included = 0;
  accounts.forEach((a, i) => {
    if (a.cents === null) excluded.push({ accountId: a.accountId, reason: a.reason ?? "no_value" });
    else {
      included += 1;
      cents += a.cents;
      priorValue += (valuations[i]!.valueCents ?? 0n) - a.cents;
    }
  });
  return {
    cents: included > 0 ? cents : null,
    asOf,
    prior,
    reason: included > 0 ? null : (excluded[0]?.reason ?? null),
    bp: included > 0 && priorValue > 0n ? Number(truncDiv(cents * 10_000n, priorValue)) : null,
    partial: excluded.length > 0,
    excluded,
    accounts,
  };
}

// ---- §3.9 periodChange ----

export interface PeriodChangeOptions {
  period: InvestmentPeriod;
  end: IsoDate;
  /** The start of a `custom` period. */
  from?: IsoDate | null;
}

export type GrowthReason = "flows_not_in_value";

export interface AccountPeriodChange {
  accountId: string;
  name: string;
  startCents: bigint | null;
  endCents: bigint | null;
  changeCents: bigint | null;
  /** External flows in the window, or the opening value (plus later flows) of a new account. */
  netFlowsCents: bigint;
  growthCents: bigint | null;
  growthReason: GrowthReason | null;
  /** Unvalued at the start, valued by the end. */
  isNew: boolean;
  openingCents: bigint | null;
  openingDate: IsoDate | null;
  endBasis: ValuationBasis;
}

export interface NewAccount {
  id: string;
  name: string;
  openingCents: bigint;
}

/** `ChangeSummaryView` minus `incomeCents` and `uncategorizedRows`, which the service fills. */
export interface PeriodChange {
  period: InvestmentPeriod;
  from: IsoDate;
  to: IsoDate;
  /** Σ over the accounts valued at the start; null when none is. */
  startCents: bigint | null;
  /** Σ over the accounts valued at the end. */
  endCents: bigint;
  changeCents: bigint | null;
  changeBp: number | null;
  /** External flows in (from, to] over the accounts valued at the start, plus new accounts' opening values. */
  netFlowsCents: bigint;
  /** change − net flows; null with a reason when a value cannot contain its flows. */
  growthCents: bigint | null;
  growthReason: GrowthReason | null;
  newAccounts: NewAccount[];
  accounts: AccountPeriodChange[];
}

/** The account's first non-null value on a data date in (`after`, `through`]. */
function firstValueAfter(ctx: Context, input: ValuationInput, acct: AccountData, after: IsoDate, through: IsoDate): { date: IsoDate; cents: bigint } | null {
  const dates = [...new Set([...acct.snapshotDates, ...acct.balanceDates, ...acct.checkpointDates])].sort(compareDates);
  for (const date of dates) {
    if (date <= after || date > through) continue;
    const v = valueAccountOn(input, acct.account.id, date).valueCents;
    if (v !== null) return { date, cents: v };
  }
  return null;
}

/** Flows in the window that the account's end value cannot contain (positions carried from a statement, or lots without cash). */
function flowsNotInValue(acct: AccountData, end: AccountValuation, windowStart: IsoDate): bigint {
  if (end.cashInference !== "off") return 0n;
  if (end.basis === "lots") return sumBetween(acct.allFlows, windowStart, end.date);
  if (end.basis === "positions" && end.asOf !== null) return sumBetween(acct.allFlows, end.asOf > windowStart ? end.asOf : windowStart, end.date);
  return 0n;
}

/**
 * One computation of a period's change (decision 12): `start = periodStart(period, end)`,
 * `change = V(end) − V(start)`, `netFlows` = external flows in (start, end] over the accounts
 * valued at the start plus the opening value of every account that enters after the start
 * (and its flows after that opening), `growth = change − netFlows`. When no selected account
 * is valued at the start the change is null and nothing is "new". Null when the period has no
 * start (`all` without data, `custom` without `from`).
 */
export function periodChange(input: ValuationInput, accountIds: readonly string[], opts: PeriodChangeOptions): PeriodChange | null {
  const ctx = contextOf(input);
  let earliest: IsoDate | null = null;
  for (const id of accountIds) {
    const first = accountOf(ctx, id).firstDataDate;
    if (first !== null && (earliest === null || first < earliest)) earliest = first;
  }
  const start = periodStart(opts.period, opts.end, { earliest, from: opts.from ?? null });
  if (start === null || start > opts.end) return null;
  const end = opts.end;

  const rows = accountIds.map((id) => ({ acct: accountOf(ctx, id), atStart: valueAccountOn(input, id, start), atEnd: valueAccountOn(input, id, end) }));
  const anyAtStart = rows.some((r) => r.atStart.valueCents !== null);
  const accounts: AccountPeriodChange[] = [];
  const newAccounts: NewAccount[] = [];
  let startCents = 0n;
  let endCents = 0n;
  let netFlowsCents = 0n;
  let uncontained = false;

  for (const { acct, atStart, atEnd } of rows) {
    const name = acct.account.name;
    const endValue = atEnd.valueCents;
    if (endValue !== null) endCents += endValue;
    const base = { accountId: acct.account.id, name, endCents: endValue, endBasis: atEnd.basis };
    if (!anyAtStart) {
      accounts.push({ ...base, startCents: null, changeCents: null, netFlowsCents: 0n, growthCents: null, growthReason: null, isNew: false, openingCents: null, openingDate: null });
      continue;
    }
    if (atStart.valueCents !== null) {
      const flows = sumBetween(acct.allFlows, start, end);
      startCents += atStart.valueCents;
      netFlowsCents += flows;
      const change = endValue === null ? null : endValue - atStart.valueCents;
      const missingFlows = flowsNotInValue(acct, atEnd, start);
      if (missingFlows !== 0n) uncontained = true;
      accounts.push({
        ...base,
        startCents: atStart.valueCents,
        changeCents: change,
        netFlowsCents: flows,
        growthCents: change === null || missingFlows !== 0n ? null : change - flows,
        growthReason: missingFlows !== 0n ? "flows_not_in_value" : null,
        isNew: false,
        openingCents: null,
        openingDate: null,
      });
    } else if (endValue !== null) {
      const opening = firstValueAfter(ctx, input, acct, start, end) ?? { date: end, cents: endValue };
      const flows = opening.cents + sumBetween(acct.allFlows, opening.date, end);
      netFlowsCents += flows;
      newAccounts.push({ id: acct.account.id, name, openingCents: opening.cents });
      const missingFlows = flowsNotInValue(acct, atEnd, opening.date);
      if (missingFlows !== 0n) uncontained = true;
      accounts.push({
        ...base,
        startCents: null,
        changeCents: endValue,
        netFlowsCents: flows,
        growthCents: missingFlows !== 0n ? null : endValue - flows,
        growthReason: missingFlows !== 0n ? "flows_not_in_value" : null,
        isNew: true,
        openingCents: opening.cents,
        openingDate: opening.date,
      });
    } else {
      accounts.push({ ...base, startCents: null, changeCents: null, netFlowsCents: 0n, growthCents: null, growthReason: null, isNew: false, openingCents: null, openingDate: null });
    }
  }

  if (!anyAtStart) {
    return { period: opts.period, from: start, to: end, startCents: null, endCents, changeCents: null, changeBp: null, netFlowsCents: 0n, growthCents: null, growthReason: null, newAccounts: [], accounts };
  }
  const changeCents = endCents - startCents;
  return {
    period: opts.period,
    from: start,
    to: end,
    startCents,
    endCents,
    changeCents,
    changeBp: startCents > 0n ? Number(truncDiv(changeCents * 10_000n, startCents)) : null,
    netFlowsCents,
    growthCents: uncontained ? null : changeCents - netFlowsCents,
    growthReason: uncontained ? "flows_not_in_value" : null,
    newAccounts,
    accounts,
  };
}
