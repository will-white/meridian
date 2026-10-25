import { addDays, dayDiff, type IsoDate } from "./dates.js";
import { FIXED8_SCALE, RECONCILE_TOLERANCE_CENTS, centsToFixed8, mulToCents, quantityForCents, type Fixed8 } from "./decimal.js";
import type {
  AccountType,
  EngineWarningCode,
  ExternalFlowKind,
  ExternalFlowSource,
  InvestmentFidelity,
  LotMethod,
  PriceSource,
  ReturnFailureReason,
  ReturnMethod,
  TaxTreatment,
} from "./enums.js";
import {
  buildLots,
  checkPositions,
  holdingsAsOf,
  incomeByMonth,
  isStalePrice,
  quantityAt,
  sortInvestmentTxns,
  summarizeGains,
  summarizeRealized,
  type DisposalResult,
  type EngineIncomeMonth,
  type EngineLotPick,
  type EngineWarning,
  type GainSummary,
  type HoldingRow,
  type InvestmentTxnInput,
  type LotBuildResult,
  type LotResult,
  type PositionSnapshot,
  type PriceLookup,
  type PriceQuote,
  type RealizedSummary,
  type TransferredLot,
} from "./lots.js";

/**
 * The performance engine (lots design §3.6–§3.13, §4.1 under plan decision 11 and seams C22,
 * C36). Pure and deterministic: no clock, no DB, no randomness; `Math.pow` is the only
 * platform-dependent operation. Rates are the only floats and never feed back into cents.
 *
 * - **Valuation of a full-history account** (`valueFullAccount`, D19): securities at the latest
 *   close on or before the date (carry-forward; `stale_price` past 7 days; `price_from_txn` when
 *   only a transaction price exists; `no_price` → 0 for that security), cash anchored on the
 *   latest reported `balance_snapshot` on or before the date (`cash = anchor − securities at the
 *   anchor + cash effects and cash flows after it`), or tracked from inception without one.
 * - **External flows** (§3.8, plan decision 11): the engine takes cash flows as the loader gives
 *   them (ledger transfers ∪ investment cash transfers, already deduplicated by ledger link or
 *   the 3-day rule), derives securities transfers at market (`securitiesFlows`) and the opening
 *   value of a non-full account entering after `from` (D18). Flows are timed start of day (D16):
 *   a flow dated d joins the closing value of d − 1 and lives through d's market move.
 * - **True TWR** for full accounts (GIPS 2020 §2.A.2–2.A.4: a boundary the day before every flow,
 *   sub-period returns chain-linked); **Modified Dietz** between the available valuations for
 *   `positions` and `balance_only` accounts (day-weighted flows); the method is named.
 * - **XIRR** exactly as Microsoft defines it, solved by a fixed-grid bracket nearest the 10 %
 *   guess and bisection to 1e−10; typed failure reasons; annualized by definition, with the
 *   period figure `(1 + r)^(investedDays/365) − 1` for sub-year ranges.
 * - **Annualization** only when `days ≥ 365` (D21).
 * - **Benchmark**: a shadow portfolio buying `cents ÷ close` units with the start value and every
 *   flow (R2), valued `units × close(to)` (R1); adjusted closes when the series says so.
 * - **Household total**: values summed per date; a flow is internal only when its paired
 *   counterpart leg is itself an active flow of a selected account; `true_twr` when every
 *   account in the total is full, else `modified_dietz` over the non-full accounts' valuation
 *   dates. An account with no valuation on or before `to` is left out of the total's values and
 *   flows (`excludedAccountIds`, a `no_valuations` warning per account) instead of being read as
 *   a loss of its contributions.
 */

// ---- Prices ----

/** One close of a price series; `source` is the price row's (seams C29). */
export interface PriceSeriesPoint {
  date: IsoDate;
  close: Fixed8;
  source: PriceSource;
}

/** Ascending, unique dates (the latest close on or before the window plus the window); throws otherwise. */
export interface PriceSeriesInput {
  securityId: string;
  points: readonly PriceSeriesPoint[];
}

export interface BenchmarkSeriesInput extends PriceSeriesInput {
  /** True when the points are adjusted closes (plan decision 10); the UI says "price only" otherwise. */
  adjusted: boolean;
}

/** The latest close on or before a date, or null before the first point. */
export function closeOnOrBefore(points: readonly PriceSeriesPoint[], date: IsoDate): PriceSeriesPoint | null {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid]!.date <= date) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? null : points[lo - 1]!;
}

function assertAscending(series: PriceSeriesInput): void {
  for (let i = 1; i < series.points.length; i++) {
    if (series.points[i]!.date <= series.points[i - 1]!.date) {
      throw new Error(`price series for ${series.securityId} must be ascending with unique dates`);
    }
  }
}

/** The §3.6 price for a security on a date: the latest close ≤ date, else the latest transaction price ≤ date, else null. */
export type PriceOn = (securityId: string, date: IsoDate) => PriceQuote | null;

/**
 * Build the fallback chain of §3.6 over price series and (optionally) the account's transactions:
 * a close on or before the date wins; otherwise the latest `investment_txn.price` on or before it
 * (stream order) is reported with `source = 'txn'`.
 */
export function priceLookup(series: readonly PriceSeriesInput[], txns: readonly InvestmentTxnInput[] = []): PriceOn {
  const bySecurity = new Map<string, readonly PriceSeriesPoint[]>();
  for (const s of series) {
    if (bySecurity.has(s.securityId)) throw new Error(`duplicate price series for ${s.securityId}`);
    assertAscending(s);
    bySecurity.set(s.securityId, s.points);
  }
  const txnPrices = new Map<string, Array<{ date: IsoDate; price: Fixed8 }>>();
  for (const t of sortInvestmentTxns(txns)) {
    if (t.securityId === null || t.price === null) continue;
    const list = txnPrices.get(t.securityId);
    const entry = { date: t.date, price: t.price };
    if (list) list.push(entry);
    else txnPrices.set(t.securityId, [entry]);
  }
  return (securityId, date) => {
    const point = closeOnOrBefore(bySecurity.get(securityId) ?? [], date);
    if (point) return { close: point.close, date: point.date, source: point.source };
    const list = txnPrices.get(securityId);
    if (!list) return null;
    let hit: { date: IsoDate; price: Fixed8 } | null = null;
    for (const entry of list) {
      if (entry.date > date) break;
      hit = entry;
    }
    return hit ? { close: hit.price, date: hit.date, source: "txn" } : null;
  };
}

/** A fixed-date lookup for the lot engine's `valueLots` / `holdingsAsOf` / `summarizeGains`. */
export function priceLookupAt(priceOn: PriceOn, date: IsoDate): PriceLookup {
  return (securityId) => priceOn(securityId, date);
}

// ---- Flows ----

/** One external flow as the loader (plan decision 11) or the engine (`securitiesFlows`, opening values) produces it. */
export interface ExternalFlowInput {
  date: IsoDate;
  /** Signed from the account's view: + capital in, − capital out. */
  amountCents: bigint;
  kind: ExternalFlowKind;
  source: ExternalFlowSource;
  accountId: string;
  counterpartyAccountId: string | null;
  /** `transfer_pair_id` (ledger) or `transfer_group_id` (investment rows); the total drops a pair whose two legs are both active. */
  pairId: string | null;
  /** The ledger transaction or investment transaction id. */
  sourceId: string | null;
}

export type InternalFlowReason = "counterparty_in_total" | "before_first_valuation";

export interface FlowResult extends ExternalFlowInput {
  internal: boolean;
  internalReason: InternalFlowReason | null;
}

/** The minimum a return helper needs from a flow; `internal` flows are skipped. */
export interface FlowLike {
  date: IsoDate;
  amountCents: bigint;
  internal?: boolean;
}

function compareFlows(a: ExternalFlowInput, b: ExternalFlowInput): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1;
  const sa = a.sourceId ?? "";
  const sb = b.sourceId ?? "";
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.amountCents < b.amountCents ? -1 : a.amountCents > b.amountCents ? 1 : 0;
}

/** Active flows strictly after `from` and on or before `to`, in date order. */
function activeInWindow<T extends FlowLike>(flows: readonly T[], from: IsoDate, to: IsoDate): T[] {
  return flows.filter((f) => f.internal !== true && f.date > from && f.date <= to).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

type WarningFields = { [K in keyof Omit<EngineWarning, "code">]?: EngineWarning[K] | undefined };

function warning(code: EngineWarningCode, fields: WarningFields = {}): EngineWarning {
  const w: EngineWarning = { code };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (w as unknown as Record<string, unknown>)[key] = value;
  }
  return w;
}

function tagAccount(warnings: readonly EngineWarning[], accountId: string): EngineWarning[] {
  return warnings.map((w) => ({ ...w, accountId }));
}

/**
 * §3.8: every securities transfer of the account valued at market on its date,
 * `mulToCents(|quantity|, txn.price ?? price(date))` with the §3.6 fallback chain; with no price at
 * all the flow is 0 and `securities_flow_unpriced` is reported (no look-ahead to a later close).
 */
export function securitiesFlows(account: { accountId: string; txns: readonly InvestmentTxnInput[] }, priceOn: PriceOn): { flows: ExternalFlowInput[]; warnings: EngineWarning[] } {
  const flows: ExternalFlowInput[] = [];
  const warnings: EngineWarning[] = [];
  for (const txn of sortInvestmentTxns(account.txns)) {
    if (txn.type !== "transfer" || txn.securityId === null || txn.quantity === null || txn.quantity === 0n) continue;
    const quantity = txn.quantity < 0n ? -txn.quantity : txn.quantity;
    const price = txn.price ?? priceOn(txn.securityId, txn.date)?.close ?? null;
    let amountCents = 0n;
    if (price === null) {
      warnings.push(warning("securities_flow_unpriced", { txnId: txn.id, securityId: txn.securityId, date: txn.date, quantity: txn.quantity }));
    } else {
      const cents = mulToCents(quantity, price);
      amountCents = txn.quantity < 0n ? -cents : cents;
    }
    flows.push({
      date: txn.date,
      amountCents,
      kind: "securities",
      source: "investment_txn",
      accountId: account.accountId,
      counterpartyAccountId: txn.counterpartyAccountId,
      pairId: txn.transferGroupId,
      sourceId: txn.id,
    });
  }
  return { flows, warnings };
}

// ---- Valuation of a full-history account (§3.6) ----

/** A reported `balance_snapshot` row (`source <> 'computed'`) of the account. */
export interface BalanceAnchorInput {
  date: IsoDate;
  balanceCents: bigint;
}

export interface FullAccountValuationInput {
  accountId: string;
  /** `buildLots(...)` of the account. */
  lots: LotBuildResult;
  /** The §3.6 price chain (`priceLookup(series, txns)`). */
  priceOn: PriceOn;
  /** The account's external flows; only `kind = 'cash'` rows move cash. */
  cashFlows: readonly ExternalFlowInput[];
  /** Reported balance snapshots, any order. */
  cashAnchors: readonly BalanceAnchorInput[];
  /** Cash at inception when no anchor exists (tests only; default 0). */
  openingCashCents?: bigint;
}

export interface FullValuation {
  date: IsoDate;
  valueCents: bigint;
  securitiesCents: bigint;
  cashCents: bigint;
  /** The reported balance the cash rests on, or null when tracked from inception. */
  cashAnchor: IsoDate | null;
  warnings: EngineWarning[];
}

/** Σ over the securities held on `date` of R1(quantity, price), with the price warnings when `warnings` is given. */
function securitiesOn(input: FullAccountValuationInput, date: IsoDate, warnings: EngineWarning[] | null): bigint {
  const quantities = quantityAt(input.lots.positions, date);
  let total = 0n;
  for (const securityId of [...quantities.keys()].sort()) {
    const quantity = quantities.get(securityId)!;
    if (quantity <= 0n) continue;
    const quote = input.priceOn(securityId, date);
    if (!quote) {
      warnings?.push(warning("no_price", { securityId, date }));
      continue;
    }
    total += mulToCents(quantity, quote.close);
    if (warnings) {
      if (quote.source === "txn") warnings.push(warning("price_from_txn", { securityId, date }));
      if (isStalePrice(quote.date, date)) warnings.push(warning("stale_price", { securityId, date, priceDate: quote.date }));
    }
  }
  return total;
}

function latestAnchor(anchors: readonly BalanceAnchorInput[], date: IsoDate, strict: boolean): BalanceAnchorInput | null {
  let best: BalanceAnchorInput | null = null;
  for (const a of anchors) {
    if (strict ? a.date >= date : a.date > date) continue;
    if (!best || a.date >= best.date) best = a;
  }
  return best;
}

/** Cash effects and cash flows dated in `(after, through]` (`after` null = from inception). */
function cashMovement(input: FullAccountValuationInput, after: IsoDate | null, through: IsoDate): bigint {
  let sum = 0n;
  for (const e of input.lots.cashEffects) {
    if (e.date <= through && (after === null || e.date > after)) sum += e.cents;
  }
  for (const f of input.cashFlows) {
    if (f.kind !== "cash") continue;
    if (f.date <= through && (after === null || f.date > after)) sum += f.amountCents;
  }
  return sum;
}

/**
 * D19: `V(d) = cash(d) + securities(d)`. With an anchor (the latest reported balance on or before
 * `d`): `cash = anchor.balance − securities(anchor.date) + Σ cash effects and cash flows in
 * (anchor.date, d]`, so on a statement date the value is the statement balance exactly; without
 * one, cash is tracked from inception (`openingCashCents`, default 0).
 */
export function valueFullAccount(input: FullAccountValuationInput, date: IsoDate): FullValuation {
  const warnings: EngineWarning[] = [];
  const securitiesCents = securitiesOn(input, date, warnings);
  const anchor = latestAnchor(input.cashAnchors, date, false);
  let cashCents: bigint;
  if (anchor) {
    cashCents = anchor.balanceCents - securitiesOn(input, anchor.date, null) + cashMovement(input, anchor.date, date);
  } else {
    cashCents = (input.openingCashCents ?? 0n) + cashMovement(input, null, date);
  }
  return { date, valueCents: cashCents + securitiesCents, securitiesCents, cashCents, cashAnchor: anchor?.date ?? null, warnings };
}

export interface StatementCheck {
  date: IsoDate;
  statementCents: bigint;
  securitiesCents: bigint;
  /** statement − securities. */
  impliedCashCents: bigint;
  /** Cash rolled forward from the previous anchor (or inception) to `date`. */
  trackedCashCents: bigint;
  trackedFrom: IsoDate | "inception";
  /** implied − tracked: money the ledger did not see, or a price difference. */
  differenceCents: bigint;
}

/** §3.6: compare the cash a statement implies with the cash the engine tracked up to it; null without a snapshot on `date`. */
export function statementCheck(input: FullAccountValuationInput, date: IsoDate): StatementCheck | null {
  const anchor = input.cashAnchors.find((a) => a.date === date);
  if (!anchor) return null;
  const securitiesCents = securitiesOn(input, date, null);
  const impliedCashCents = anchor.balanceCents - securitiesCents;
  const previous = latestAnchor(input.cashAnchors, date, true);
  const trackedCashCents = previous
    ? previous.balanceCents - securitiesOn(input, previous.date, null) + cashMovement(input, previous.date, date)
    : (input.openingCashCents ?? 0n) + cashMovement(input, null, date);
  return {
    date,
    statementCents: anchor.balanceCents,
    securitiesCents,
    impliedCashCents,
    trackedCashCents,
    trackedFrom: previous?.date ?? "inception",
    differenceCents: impliedCashCents - trackedCashCents,
  };
}

// ---- Valuation points of non-full accounts (§3.7) ----

/** A value of a `positions` or `balance_only` account on a date, from the valuation chain. */
export interface ValuationPointInput {
  date: IsoDate;
  valueCents: bigint;
}

export interface ValuationAt {
  valueCents: bigint;
  /** True when the value is carried forward from an earlier date. */
  carried: boolean;
}

function sortedValuations(valuations: readonly ValuationPointInput[]): ValuationPointInput[] {
  return [...valuations].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** The latest valuation on or before a date, carried forward; 0 (not carried) before the first. */
export function carriedValueAt(valuations: readonly ValuationPointInput[]): (date: IsoDate) => ValuationAt {
  const sorted = sortedValuations(valuations);
  return (date) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid]!.date <= date) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return { valueCents: 0n, carried: false };
    const point = sorted[lo - 1]!;
    return { valueCents: point.valueCents, carried: point.date !== date };
  };
}

// ---- Returns ----

export interface ReturnFigure {
  rate: number | null;
  annualized: number | null;
  reason: ReturnFailureReason | null;
  reasonDate: IsoDate | null;
}

export interface SubPeriod {
  from: IsoDate;
  to: IsoDate;
  /** V(from), before the flow. */
  beginValueCents: bigint;
  /** Σ flows of the sub-period (dated from + 1 under true TWR; in (from, to] under Dietz). */
  flowCents: bigint;
  /** Dietz only: Σ wⱼ · CFⱼ in dollars. */
  weightedFlowDollars: number | null;
  endValueCents: bigint;
  rate: number | null;
  skipped: boolean;
  beginCarried: boolean;
  endCarried: boolean;
}

export interface ChainResult extends ReturnFigure {
  subPeriods: SubPeriod[];
  warnings: EngineWarning[];
}

/** D21: `(1 + rate)^(365/days) − 1` when `days ≥ 365` (the rate itself at exactly 365), else null. */
export function annualize(rate: number, days: number): number | null {
  if (days < 365) return null;
  return days === 365 ? rate : Math.pow(1 + rate, 365 / days) - 1;
}

function uniqueSortedDates(dates: Iterable<IsoDate>): IsoDate[] {
  return [...new Set(dates)].sort();
}

function finishChain(from: IsoDate, to: IsoDate, subPeriods: SubPeriod[], warnings: EngineWarning[], failure: { reason: ReturnFailureReason; date: IsoDate } | null): ChainResult {
  if (failure) return { rate: null, annualized: null, reason: failure.reason, reasonDate: failure.date, subPeriods, warnings };
  const computed = subPeriods.filter((s) => !s.skipped);
  if (computed.length === 0) return { rate: null, annualized: null, reason: "no_valuations", reasonDate: to, subPeriods, warnings };
  let product = 1;
  for (const s of computed) product *= 1 + s.rate!;
  const rate = product - 1;
  return { rate, annualized: annualize(rate, dayDiff(from, to)), reason: null, reasonDate: null, subPeriods, warnings };
}

/**
 * §3.9, GIPS true time-weighted return: a boundary at `from`, `to` and the day before every
 * active flow in `(from, to]`; for consecutive boundaries `begin = V(b₀) + flows dated b₀ + 1`,
 * `end = V(b₁)`, `r = end / begin − 1`; `begin = end = 0` skips the sub-period, `begin = 0`
 * otherwise is `zero_denominator`, `begin < 0` is `negative_capital`; chain-linked.
 */
export function trueTwr(from: IsoDate, to: IsoDate, flows: readonly FlowLike[], valueAt: (date: IsoDate) => bigint): ChainResult {
  if (to <= from) throw new Error("to must be after from");
  const active = activeInWindow(flows, from, to);
  const boundaries = uniqueSortedDates([from, to, ...active.map((f) => addDays(f.date, -1))]);
  const values = new Map<IsoDate, bigint>();
  const value = (d: IsoDate) => {
    let v = values.get(d);
    if (v === undefined) {
      v = valueAt(d);
      values.set(d, v);
    }
    return v;
  };
  const subPeriods: SubPeriod[] = [];
  let failure: { reason: ReturnFailureReason; date: IsoDate } | null = null;
  for (let i = 1; i < boundaries.length; i++) {
    const b0 = boundaries[i - 1]!;
    const b1 = boundaries[i]!;
    const flowDate = addDays(b0, 1);
    const flowCents = active.filter((f) => f.date === flowDate).reduce((acc, f) => acc + f.amountCents, 0n);
    const beginValueCents = value(b0);
    const endValueCents = value(b1);
    const begin = beginValueCents + flowCents;
    const sp: SubPeriod = { from: b0, to: b1, beginValueCents, flowCents, weightedFlowDollars: null, endValueCents, rate: null, skipped: false, beginCarried: false, endCarried: false };
    if (begin === 0n && endValueCents === 0n) sp.skipped = true;
    else if (begin === 0n) failure ??= { reason: "zero_denominator", date: b0 };
    else if (begin < 0n) failure ??= { reason: "negative_capital", date: b0 };
    else sp.rate = Number(endValueCents) / Number(begin) - 1;
    subPeriods.push(sp);
  }
  return finishChain(from, to, subPeriods, [], failure);
}

/**
 * §3.10, Modified Dietz over given boundaries: for `(b₀, b₁)` with `D = dayDiff(b₀, b₁)`, flows
 * in `(b₀, b₁]` weighted `(dayDiff(date, b₁) + 1) / D` (start of day), `r = (V₁ − V₀ − ΣCF) /
 * (V₀ + Σ w·CF)` in dollars; `V₀ = V₁ = 0, ΣCF = 0` skips; denominator 0 is `zero_denominator`,
 * negative is `negative_capital`; chain-linked. Carried boundary values are flagged and warned.
 */
export function modifiedDietzOver(from: IsoDate, to: IsoDate, flows: readonly FlowLike[], boundaries: Iterable<IsoDate>, valueAt: (date: IsoDate) => ValuationAt): ChainResult {
  if (to <= from) throw new Error("to must be after from");
  const active = activeInWindow(flows, from, to);
  const dates = uniqueSortedDates([from, to, ...[...boundaries].filter((d) => d > from && d < to)]);
  const values = new Map<IsoDate, ValuationAt>();
  const value = (d: IsoDate) => {
    let v = values.get(d);
    if (v === undefined) {
      v = valueAt(d);
      values.set(d, v);
    }
    return v;
  };
  const warnings: EngineWarning[] = [];
  const warnedCarried = new Set<IsoDate>();
  const noteCarried = (d: IsoDate, v: ValuationAt) => {
    if (v.carried && !warnedCarried.has(d)) {
      warnedCarried.add(d);
      warnings.push(warning("valuation_carried", { date: d }));
    }
  };
  const subPeriods: SubPeriod[] = [];
  let failure: { reason: ReturnFailureReason; date: IsoDate } | null = null;
  for (let i = 1; i < dates.length; i++) {
    const b0 = dates[i - 1]!;
    const b1 = dates[i]!;
    const days = dayDiff(b0, b1);
    const v0 = value(b0);
    const v1 = value(b1);
    noteCarried(b0, v0);
    noteCarried(b1, v1);
    let flowCents = 0n;
    let weighted = 0;
    for (const f of active) {
      if (f.date <= b0 || f.date > b1) continue;
      flowCents += f.amountCents;
      weighted += (Number(f.amountCents) / 100) * ((dayDiff(f.date, b1) + 1) / days);
    }
    const sp: SubPeriod = {
      from: b0,
      to: b1,
      beginValueCents: v0.valueCents,
      flowCents,
      weightedFlowDollars: weighted,
      endValueCents: v1.valueCents,
      rate: null,
      skipped: false,
      beginCarried: v0.carried,
      endCarried: v1.carried,
    };
    const denominator = Number(v0.valueCents) / 100 + weighted;
    if (v0.valueCents === 0n && v1.valueCents === 0n && flowCents === 0n) sp.skipped = true;
    else if (denominator === 0) failure ??= { reason: "zero_denominator", date: b0 };
    else if (denominator < 0) failure ??= { reason: "negative_capital", date: b0 };
    else sp.rate = (Number(v1.valueCents) / 100 - Number(v0.valueCents) / 100 - Number(flowCents) / 100) / denominator;
    subPeriods.push(sp);
  }
  return finishChain(from, to, subPeriods, warnings, failure);
}

/** Modified Dietz with boundaries at `from`, `to` and every valuation date in between, values carried forward (0 before the first). */
export function modifiedDietz(from: IsoDate, to: IsoDate, flows: readonly FlowLike[], valuations: readonly ValuationPointInput[]): ChainResult {
  return modifiedDietzOver(
    from,
    to,
    flows,
    valuations.map((v) => v.date),
    carriedValueAt(valuations),
  );
}

// ---- XIRR (§3.11) ----

export interface InvestorFlow {
  date: IsoDate;
  amountCents: bigint;
}

export interface XirrSolution {
  rate: number | null;
  reason: ReturnFailureReason | null;
  iterations: number;
  warnings: string[];
  bracket: [number, number] | null;
}

/** The fixed grid the bracket search evaluates; an exact zero at a grid point is the answer. */
export const XIRR_GRID: readonly number[] = [-0.999999, -0.99, -0.9, -0.75, -0.5, -0.25, -0.1, 0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 100, 1000, 10000, 100000, 1000000];
/** Excel's default guess; the bracket containing it (else the nearest, lower on ties) is solved. */
export const XIRR_GUESS = 0.1;

/**
 * Microsoft's XIRR: the r with Σ Pᵢ · (1 + r)^(−(dᵢ − d₀)/365) = 0 in dollars. Zero flows are
 * dropped; fewer than two flows → `too_few_flows`; all one sign → `no_sign_change`; no sign change
 * on the grid → `no_bracket`; several brackets → `multiple_roots` in `warnings`. Bisection until
 * `hi − lo ≤ tol` (1e−10) or `maxIter` (200); the midpoint is returned.
 */
export function xirr(flows: readonly InvestorFlow[], opts: { tol?: number; maxIter?: number } = {}): XirrSolution {
  const tol = opts.tol ?? 1e-10;
  const maxIter = opts.maxIter ?? 200;
  const nonZero = flows.filter((f) => f.amountCents !== 0n).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (nonZero.length < 2) return { rate: null, reason: "too_few_flows", iterations: 0, warnings: [], bracket: null };
  if (!nonZero.some((f) => f.amountCents > 0n) || !nonZero.some((f) => f.amountCents < 0n)) {
    return { rate: null, reason: "no_sign_change", iterations: 0, warnings: [], bracket: null };
  }
  const d0 = nonZero[0]!.date;
  const terms = nonZero.map((f) => ({ t: dayDiff(d0, f.date) / 365, p: Number(f.amountCents) / 100 }));
  const f = (r: number) => terms.reduce((acc, term) => acc + term.p * Math.pow(1 + r, -term.t), 0);
  const values = XIRR_GRID.map(f);
  const exact = values.findIndex((v) => v === 0);
  if (exact >= 0) {
    const g = XIRR_GRID[exact]!;
    return { rate: g, reason: null, iterations: 0, warnings: [], bracket: [g, g] };
  }
  const brackets: Array<[number, number]> = [];
  for (let i = 1; i < XIRR_GRID.length; i++) {
    if (values[i - 1]! < 0 !== values[i]! < 0) brackets.push([XIRR_GRID[i - 1]!, XIRR_GRID[i]!]);
  }
  if (brackets.length === 0) return { rate: null, reason: "no_bracket", iterations: 0, warnings: [], bracket: null };
  const distance = ([lo, hi]: [number, number]) => (lo <= XIRR_GUESS && XIRR_GUESS <= hi ? 0 : Math.min(Math.abs(lo - XIRR_GUESS), Math.abs(hi - XIRR_GUESS)));
  let chosen = brackets[0]!;
  for (const b of brackets.slice(1)) if (distance(b) < distance(chosen)) chosen = b;
  const warnings = brackets.length > 1 ? ["multiple_roots"] : [];
  let [lo, hi] = chosen;
  let fLo = f(lo);
  let iterations = 0;
  while (hi - lo > tol && iterations < maxIter) {
    const mid = (lo + hi) / 2;
    const fMid = f(mid);
    iterations++;
    if (fMid === 0) {
      lo = mid;
      hi = mid;
      break;
    }
    if (fMid < 0 === fLo < 0) {
      lo = mid;
      fLo = fMid;
    } else {
      hi = mid;
    }
  }
  return { rate: (lo + hi) / 2, reason: null, iterations, warnings, bracket: chosen };
}

export interface XirrFigure {
  /** XIRR is annual by definition. */
  annualized: number | null;
  /** `(1 + annualized)^(investedDays/365) − 1`, the figure shown for sub-year ranges. */
  period: number | null;
  /** From the later of `from` and the first non-zero investor flow, to `to`. */
  investedDays: number;
  reason: ReturnFailureReason | null;
  warnings: string[];
  investorFlows: InvestorFlow[];
}

/** The investor's dated flows: `−V(from)`, `−flow` for every active flow in `(from, to]`, `+V(to)`. */
export function investorFlows(from: IsoDate, to: IsoDate, vFrom: bigint, flows: readonly FlowLike[], vTo: bigint): InvestorFlow[] {
  const out: InvestorFlow[] = [{ date: from, amountCents: -vFrom }];
  for (const f of activeInWindow(flows, from, to)) out.push({ date: f.date, amountCents: -f.amountCents });
  out.push({ date: to, amountCents: vTo });
  return out;
}

/** The money-weighted figure of a period: `xirr` over `investorFlows` plus the period conversion. */
export function xirrFigure(from: IsoDate, to: IsoDate, vFrom: bigint, flows: readonly FlowLike[], vTo: bigint): XirrFigure {
  const list = investorFlows(from, to, vFrom, flows, vTo);
  const solution = xirr(list);
  const firstNonZero = list.find((f) => f.amountCents !== 0n)?.date ?? from;
  const investedDays = dayDiff(firstNonZero > from ? firstNonZero : from, to);
  const period = solution.rate === null ? null : Math.pow(1 + solution.rate, investedDays / 365) - 1;
  return { annualized: solution.rate, period, investedDays, reason: solution.reason, warnings: solution.warnings, investorFlows: list };
}

function failedXirr(reason: ReturnFailureReason): XirrFigure {
  return { annualized: null, period: null, investedDays: 0, reason, warnings: [], investorFlows: [] };
}

function failedReturn(reason: ReturnFailureReason, date: IsoDate): ReturnFigure {
  return { rate: null, annualized: null, reason, reasonDate: date };
}

/** The chain failures that are also engine warning codes (the XIRR-only reasons are reported in `XirrFigure.reason`). */
function chainWarning(chain: ChainResult): EngineWarning | null {
  switch (chain.reason) {
    case "zero_denominator":
    case "negative_capital":
    case "no_valuations":
      return warning(chain.reason, { date: chain.reasonDate ?? undefined });
    default:
      return null;
  }
}

// ---- Benchmark (§3.12) ----

export interface BenchmarkLeg {
  date: IsoDate;
  cents: bigint;
  price: Fixed8;
  priceDate: IsoDate;
  units: Fixed8;
}

export interface BenchmarkPerformance {
  securityId: string;
  adjusted: boolean;
  twr: ReturnFigure;
  xirr: XirrFigure;
  /** The shadow portfolio's value on `to`. */
  shadowValueCents: bigint;
  startPrice: Fixed8;
  endPrice: Fixed8;
  legs: BenchmarkLeg[];
}

/** The latest positive close on or before a date (a benchmark never closes at 0). */
function benchmarkClose(points: readonly PriceSeriesPoint[], date: IsoDate): PriceSeriesPoint | null {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid]!.date <= date) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo - 1; i >= 0; i--) if (points[i]!.close > 0n) return points[i]!;
  return null;
}

/**
 * The shadow portfolio: `units = R2(V(from), B(from)) + Σ R2(flow, B(date))` over the active flows
 * of `(from, to]` (withdrawals subtract units), valued `R1(units, B(to))`; benchmark TWR is
 * `B(to) / B(from) − 1`; benchmark XIRR runs the investor's flows against the shadow value.
 * No close on or before `from` → null with `no_benchmark_price`.
 */
export function benchmarkOf(from: IsoDate, to: IsoDate, vFrom: bigint, flows: readonly FlowLike[], series: BenchmarkSeriesInput): { benchmark: BenchmarkPerformance | null; warnings: EngineWarning[] } {
  if (to <= from) throw new Error("to must be after from");
  assertAscending(series);
  const start = benchmarkClose(series.points, from);
  if (!start) return { benchmark: null, warnings: [warning("no_benchmark_price", { securityId: series.securityId, date: from })] };
  const end = benchmarkClose(series.points, to)!;
  const legs: BenchmarkLeg[] = [{ date: from, cents: vFrom, price: start.close, priceDate: start.date, units: quantityForCents(vFrom, start.close) }];
  for (const f of activeInWindow(flows, from, to)) {
    const close = benchmarkClose(series.points, f.date)!;
    legs.push({ date: f.date, cents: f.amountCents, price: close.close, priceDate: close.date, units: quantityForCents(f.amountCents, close.close) });
  }
  const units = legs.reduce((acc, leg) => acc + leg.units, 0n);
  const shadowValueCents = mulToCents(units, end.close);
  const rate = Number(end.close) / Number(start.close) - 1;
  return {
    benchmark: {
      securityId: series.securityId,
      adjusted: series.adjusted,
      twr: { rate, annualized: annualize(rate, dayDiff(from, to)), reason: null, reasonDate: null },
      xirr: xirrFigure(from, to, vFrom, flows, shadowValueCents),
      shadowValueCents,
      startPrice: start.close,
      endPrice: end.close,
      legs,
    },
    warnings: [],
  };
}

// ---- computePerformance (§3.13) ----

export interface PerformanceAccountInput {
  accountId: string;
  name: string;
  type: AccountType;
  taxTreatment: TaxTreatment;
  /** Derived (plan decision 7); `full_history` accounts are priced from lots, the others from `valuations`. */
  fidelity: InvestmentFidelity;
  lotMethod: LotMethod;
  txns: readonly InvestmentTxnInput[];
  lotPicks: readonly EngineLotPick[];
  /** In-leg transfer txn id → the counterparty's transferred-out pieces (see `LotBuildInput`). */
  transferSources?: ReadonlyMap<string, readonly TransferredLot[]>;
  /** Lot id resolver (the service hands back the stored uuid for `(openedByTxnId, ordinal)`). */
  lotId?: (openedByTxnId: string, ordinal: number) => string;
  /** Cash at inception for full accounts without an anchor (tests only; default 0). */
  openingCashCents?: bigint;
  /** The loader's cash flows (ledger ∪ investment cash transfers, deduplicated); other kinds are ignored here. */
  cashFlows: readonly ExternalFlowInput[];
  /** Reported balance snapshots (full accounts' cash anchors). */
  cashAnchors: readonly BalanceAnchorInput[];
  /** The valuation chain's points for a non-full account. */
  valuations: readonly ValuationPointInput[];
  /** The latest holding snapshot, for the position check of a full account. */
  latestHoldingSnapshot: PositionSnapshot | null;
}

export interface PerformanceInput {
  from: IsoDate;
  to: IsoDate;
  /** Holdings valuation date. */
  asOf: IsoDate;
  accounts: readonly PerformanceAccountInput[];
  prices: readonly PriceSeriesInput[];
  benchmark: BenchmarkSeriesInput | null;
}

/** A holding row of a full account; `securityId` null is the account's cash line. */
export type PerformanceHolding = Omit<HoldingRow, "securityId"> & { securityId: string | null };

export interface OpeningValue {
  date: IsoDate;
  cents: bigint;
}

export interface PerformanceBlock {
  method: ReturnMethod | null;
  startValueCents: bigint;
  endValueCents: bigint;
  openingValue: OpeningValue | null;
  contributionsCents: bigint;
  withdrawalsCents: bigint;
  /** contributions − withdrawals. */
  netFlowsCents: bigint;
  /** end − start − netFlows − openingValue. */
  growthCents: bigint;
  twr: ReturnFigure;
  xirr: XirrFigure;
  benchmark: BenchmarkPerformance | null;
  subPeriods: SubPeriod[];
  /** Flows in `(from, to]`, internal ones marked. */
  flows: FlowResult[];
  realized: RealizedSummary | null;
  gains: GainSummary | null;
  income: EngineIncomeMonth[];
  warnings: EngineWarning[];
}

export interface AccountPerformance extends PerformanceBlock {
  accountId: string;
  name: string;
  type: AccountType;
  taxTreatment: TaxTreatment;
  fidelity: InvestmentFidelity;
  holdings: PerformanceHolding[];
  lots: LotResult[];
  disposals: DisposalResult[];
  statementCheck: StatementCheck | null;
}

export interface TotalPerformance extends PerformanceBlock {
  accountIds: string[];
  /** True when a selected account is not full history (its gains are not in the totals). */
  partialGains: boolean;
  excludedInternalFlows: number;
  /**
   * Selected accounts with no valuation on or before `to` (their own block says `no_valuations`):
   * valued 0 on every date, they are left out of the total's values and flows rather than
   * charged as a loss, and each is reported as a `no_valuations` warning on the total.
   */
  excludedAccountIds: string[];
}

export interface PerformanceResult {
  from: IsoDate;
  to: IsoDate;
  asOf: IsoDate;
  days: number;
  accounts: AccountPerformance[];
  total: TotalPerformance;
  benchmark: BenchmarkPerformance | null;
  /** Every account's warnings (tagged `accountId`) followed by the total's. */
  warnings: EngineWarning[];
}

interface AccountContext {
  result: AccountPerformance;
  valueAt: (date: IsoDate) => ValuationAt;
  /** Non-full accounts: valuation dates in (from, to). */
  boundaries: IsoDate[];
  noValuations: boolean;
}

function memoValueAt(fn: (date: IsoDate) => ValuationAt): (date: IsoDate) => ValuationAt {
  const cache = new Map<IsoDate, ValuationAt>();
  return (date) => {
    let v = cache.get(date);
    if (v === undefined) {
      v = fn(date);
      cache.set(date, v);
    }
    return v;
  };
}

/** Contributions and withdrawals by sign over the active flows; opening values summed under their earliest date. */
function flowTotals(flows: readonly FlowResult[]): { contributionsCents: bigint; withdrawalsCents: bigint; openingValue: OpeningValue | null } {
  let contributionsCents = 0n;
  let withdrawalsCents = 0n;
  let openingDate: IsoDate | null = null;
  let openingCents = 0n;
  for (const f of flows) {
    if (f.internal) continue;
    if (f.kind === "opening_value") {
      if (openingDate === null || f.date < openingDate) openingDate = f.date;
      openingCents += f.amountCents;
    } else if (f.amountCents > 0n) contributionsCents += f.amountCents;
    else withdrawalsCents -= f.amountCents;
  }
  return { contributionsCents, withdrawalsCents, openingValue: openingDate === null ? null : { date: openingDate, cents: openingCents } };
}

function dedupeKey(w: EngineWarning): string {
  return `${w.code}|${w.securityId ?? ""}|${w.priceDate ?? ""}`;
}

function emptyGains(): GainSummary {
  return {
    realizedShortCents: 0n,
    realizedLongCents: 0n,
    realizedCents: 0n,
    unknownBasisProceedsCents: 0n,
    unrealizedCents: 0n,
    totalGainCents: 0n,
    proceedsCents: 0n,
    basisConsumedCents: 0n,
    transferredOutBasisCents: 0n,
    openValueCents: 0n,
    openBasisCents: 0n,
    originalBasisCents: 0n,
    unpricedSecurityIds: [],
  };
}

function sumGains(list: readonly GainSummary[]): GainSummary {
  const total = emptyGains();
  const unpriced = new Set<string>();
  for (const g of list) {
    total.realizedShortCents += g.realizedShortCents;
    total.realizedLongCents += g.realizedLongCents;
    total.realizedCents += g.realizedCents;
    total.unknownBasisProceedsCents += g.unknownBasisProceedsCents;
    total.unrealizedCents += g.unrealizedCents;
    total.totalGainCents += g.totalGainCents;
    total.proceedsCents += g.proceedsCents;
    total.basisConsumedCents += g.basisConsumedCents;
    total.transferredOutBasisCents += g.transferredOutBasisCents;
    total.openValueCents += g.openValueCents;
    total.openBasisCents += g.openBasisCents;
    total.originalBasisCents += g.originalBasisCents;
    for (const id of g.unpricedSecurityIds) unpriced.add(id);
  }
  total.unpricedSecurityIds = [...unpriced].sort();
  return total;
}

function sumRealized(list: readonly RealizedSummary[]): RealizedSummary {
  const total: RealizedSummary = {
    shortTerm: { proceedsCents: 0n, basisCents: 0n, gainCents: 0n, count: 0 },
    longTerm: { proceedsCents: 0n, basisCents: 0n, gainCents: 0n, count: 0 },
    unknownBasis: { proceedsCents: 0n, quantity: 0n, count: 0 },
    transfersOut: { quantity: 0n, basisCents: 0n },
    washSalesApplied: false,
  };
  for (const r of list) {
    for (const term of ["shortTerm", "longTerm"] as const) {
      total[term].proceedsCents += r[term].proceedsCents;
      total[term].basisCents += r[term].basisCents;
      total[term].gainCents += r[term].gainCents;
      total[term].count += r[term].count;
    }
    total.unknownBasis.proceedsCents += r.unknownBasis.proceedsCents;
    total.unknownBasis.quantity += r.unknownBasis.quantity;
    total.unknownBasis.count += r.unknownBasis.count;
    total.transfersOut.quantity += r.transfersOut.quantity;
    total.transfersOut.basisCents += r.transfersOut.basisCents;
  }
  return total;
}

function mergeIncome(lists: readonly (readonly EngineIncomeMonth[])[]): EngineIncomeMonth[] {
  const rows = new Map<string, EngineIncomeMonth>();
  for (const list of lists) {
    for (const r of list) {
      const key = `${r.month}|${r.securityId ?? ""}`;
      const row = rows.get(key);
      if (row) {
        row.dividendCents += r.dividendCents;
        row.interestCents += r.interestCents;
        row.feeCents += r.feeCents;
        row.reinvestedCents += r.reinvestedCents;
      } else rows.set(key, { ...r });
    }
  }
  return [...rows.values()].sort((a, b) => {
    if (a.month !== b.month) return a.month < b.month ? -1 : 1;
    if (a.securityId === b.securityId) return 0;
    if (a.securityId === null) return -1;
    if (b.securityId === null) return 1;
    return a.securityId < b.securityId ? -1 : 1;
  });
}

function performAccount(input: PerformanceInput, acct: PerformanceAccountInput): AccountContext {
  const { from, to, asOf } = input;
  const accountId = acct.accountId;
  const warnings: EngineWarning[] = [];
  const priceOn = priceLookup(input.prices, acct.txns);
  const cashFlows = acct.cashFlows.filter((f) => f.kind === "cash");
  const securities = securitiesFlows({ accountId, txns: acct.txns }, priceOn);
  warnings.push(...tagAccount(securities.warnings, accountId));
  const rawFlows = [...cashFlows, ...securities.flows].sort(compareFlows);

  let valueAt: (date: IsoDate) => ValuationAt;
  let flows: FlowResult[];
  let chain: ChainResult;
  let boundaries: IsoDate[] = [];
  let noValuations = false;
  let method: ReturnMethod;

  let lots: LotBuildResult | null = null;
  let valuationInput: FullAccountValuationInput | null = null;

  if (acct.fidelity === "full_history") {
    method = "true_twr";
    lots = buildLots({
      accountId,
      lotMethod: acct.lotMethod,
      txns: acct.txns,
      lotPicks: acct.lotPicks,
      ...(acct.transferSources !== undefined ? { transferSources: acct.transferSources } : {}),
      ...(acct.lotId !== undefined ? { lotId: acct.lotId } : {}),
    });
    warnings.push(...tagAccount(lots.warnings, accountId));
    valuationInput = {
      accountId,
      lots,
      priceOn,
      cashFlows,
      cashAnchors: acct.cashAnchors,
      ...(acct.openingCashCents !== undefined ? { openingCashCents: acct.openingCashCents } : {}),
    };
    const vi = valuationInput;
    const seen = new Set<string>();
    const valuations = new Map<IsoDate, FullValuation>();
    const valueFull = (date: IsoDate) => {
      let v = valuations.get(date);
      if (v === undefined) {
        v = valueFullAccount(vi, date);
        valuations.set(date, v);
      }
      return v;
    };
    valueAt = (date) => ({ valueCents: valueFull(date).valueCents, carried: false });
    for (const date of uniqueSortedDates([from, to, asOf])) {
      for (const w of valueFull(date).warnings) {
        const key = dedupeKey(w);
        if (seen.has(key)) continue;
        seen.add(key);
        warnings.push({ ...w, accountId });
      }
    }
    flows = rawFlows.filter((f) => f.date > from && f.date <= to).map((f) => ({ ...f, internal: false, internalReason: null }));
    chain = trueTwr(from, to, flows, (d) => valueAt(d).valueCents);
  } else {
    method = "modified_dietz";
    const sorted = sortedValuations(acct.valuations);
    const first = sorted[0];
    const carried = carriedValueAt(sorted);
    if (!first || first.date > to) {
      noValuations = true;
      valueAt = () => ({ valueCents: 0n, carried: false });
      flows = rawFlows.filter((f) => f.date > from && f.date <= to).map((f) => ({ ...f, internal: false, internalReason: null }));
      chain = { ...failedReturn("no_valuations", to), subPeriods: [], warnings: [] };
    } else {
      const d1 = first.date;
      valueAt = (date) => (date < d1 ? { valueCents: 0n, carried: false } : carried(date));
      boundaries = sorted.map((v) => v.date).filter((d) => d > from && d < to);
      flows = rawFlows.filter((f) => f.date > from && f.date <= to).map((f) => ({ ...f, internal: false, internalReason: null }));
      if (d1 > from) {
        for (const f of flows) {
          if (f.date <= d1) {
            f.internal = true;
            f.internalReason = "before_first_valuation";
            warnings.push(warning("flow_before_first_valuation", { accountId, date: f.date, detail: `${f.amountCents.toString()} cents folded into the opening value of ${d1}` }));
          }
        }
        flows.push({
          date: d1,
          amountCents: first.valueCents,
          kind: "opening_value",
          source: "engine",
          accountId,
          counterpartyAccountId: null,
          pairId: null,
          sourceId: null,
          internal: false,
          internalReason: null,
        });
        flows.sort(compareFlows);
      }
      chain = modifiedDietzOver(from, to, flows, boundaries, valueAt);
    }
  }
  valueAt = memoValueAt(valueAt);
  warnings.push(...tagAccount(chain.warnings, accountId));
  const failed = chainWarning(chain);
  if (failed) warnings.push({ ...failed, accountId });

  const startValueCents = valueAt(from).valueCents;
  const endValueCents = valueAt(to).valueCents;
  const totals = flowTotals(flows);
  const netFlowsCents = totals.contributionsCents - totals.withdrawalsCents;
  const growthCents = endValueCents - startValueCents - netFlowsCents - (totals.openingValue?.cents ?? 0n);
  const xirrResult = noValuations ? failedXirr("no_valuations") : xirrFigure(from, to, startValueCents, flows, endValueCents);
  if (xirrResult.warnings.includes("multiple_roots")) warnings.push(warning("multiple_roots", { accountId }));
  let benchmark: BenchmarkPerformance | null = null;
  if (input.benchmark && !noValuations) {
    const b = benchmarkOf(from, to, startValueCents, flows, input.benchmark);
    benchmark = b.benchmark;
    warnings.push(...tagAccount(b.warnings, accountId));
  }

  let holdings: PerformanceHolding[] = [];
  let realized: RealizedSummary | null = null;
  let gains: GainSummary | null = null;
  let income: EngineIncomeMonth[] = [];
  let check: StatementCheck | null = null;
  if (lots && valuationInput) {
    const asOfValuation = valueFullAccount(valuationInput, asOf);
    holdings = [
      ...holdingsAsOf(lots.lots, asOf, priceLookupAt(priceOn, asOf)),
      {
        securityId: null,
        quantity: centsToFixed8(asOfValuation.cashCents),
        valueCents: asOfValuation.cashCents,
        costBasisCents: null,
        unrealizedCents: null,
        unrealizedShortCents: 0n,
        unrealizedLongCents: 0n,
        unknownBasisQuantity: 0n,
        lotCount: 0,
        price: FIXED8_SCALE,
        priceDate: asOf,
        priceSource: "cash",
        stale: false,
      },
    ];
    realized = summarizeRealized(lots.disposals, { from, to });
    gains = summarizeGains(lots.lots, lots.disposals, (securityId) => priceOn(securityId, asOf)?.close ?? null);
    income = incomeByMonth(acct.txns.filter((t) => t.date > from && t.date <= to));
    const checkAnchor = latestAnchor(acct.cashAnchors, to, false);
    if (checkAnchor) {
      check = statementCheck(valuationInput, checkAnchor.date);
      if (check) {
        const abs = check.differenceCents < 0n ? -check.differenceCents : check.differenceCents;
        if (abs >= RECONCILE_TOLERANCE_CENTS) warnings.push(warning("statement_mismatch", { accountId, date: check.date, diffCents: check.differenceCents }));
      }
    }
    if (acct.latestHoldingSnapshot) warnings.push(...tagAccount(checkPositions(lots.positions, acct.latestHoldingSnapshot), accountId));
  }

  const result: AccountPerformance = {
    accountId,
    name: acct.name,
    type: acct.type,
    taxTreatment: acct.taxTreatment,
    fidelity: acct.fidelity,
    method,
    startValueCents,
    endValueCents,
    openingValue: totals.openingValue,
    contributionsCents: totals.contributionsCents,
    withdrawalsCents: totals.withdrawalsCents,
    netFlowsCents,
    growthCents,
    twr: { rate: chain.rate, annualized: chain.annualized, reason: chain.reason, reasonDate: chain.reasonDate },
    xirr: xirrResult,
    benchmark,
    subPeriods: chain.subPeriods,
    flows,
    realized,
    gains,
    income,
    warnings,
    holdings,
    lots: lots?.lots ?? [],
    disposals: lots?.disposals ?? [],
    statementCheck: check,
  };
  return { result, valueAt, boundaries, noValuations };
}

/**
 * One or many accounts over `(from, to]` with holdings as of `asOf`. Throws only on programming
 * errors (`to ≤ from`, a duplicate account, an unsorted price series); every data problem is a
 * typed warning. Deep-equal output for any order of `accounts`, `flows` and `txns`.
 */
export function computePerformance(input: PerformanceInput): PerformanceResult {
  const { from, to, asOf } = input;
  if (to <= from) throw new Error("to must be after from");
  const ids = new Set<string>();
  for (const a of input.accounts) {
    if (ids.has(a.accountId)) throw new Error(`duplicate account ${a.accountId}`);
    ids.add(a.accountId);
  }
  for (const s of input.prices) assertAscending(s);

  const contexts = input.accounts.map((acct) => performAccount(input, acct));
  const accounts = contexts.map((c) => c.result);

  // An account with no valuation on or before `to` is valued 0 on every date: folding its flows
  // into the total would charge them as a pure loss, so it is left out of the total's values and
  // flows (its own block still says `no_valuations`) and named on the total.
  const included = contexts.filter((c) => !c.noValuations);
  const excludedAccountIds = contexts.filter((c) => c.noValuations).map((c) => c.result.accountId);

  // Flows of the total: every included account's in-window flows; a pair whose two legs are both
  // active flows of selected accounts is internal to the total (both legs dropped).
  const totalFlows: FlowResult[] = included.flatMap((c) => c.result.flows.map((f) => ({ ...f })));
  const paired = totalFlows.filter(
    (f) =>
      !f.internal &&
      f.pairId !== null &&
      f.counterpartyAccountId !== null &&
      ids.has(f.counterpartyAccountId) &&
      totalFlows.some((g) => g !== f && !g.internal && g.pairId === f.pairId && g.accountId === f.counterpartyAccountId),
  );
  for (const f of paired) {
    f.internal = true;
    f.internalReason = "counterparty_in_total";
  }
  const excludedInternalFlows = paired.length;
  totalFlows.sort(compareFlows);

  const totalWarnings: EngineWarning[] = [];
  for (const accountId of excludedAccountIds) {
    totalWarnings.push(warning("no_valuations", { accountId, date: to, detail: `excluded from the total: no valuation on or before ${to}` }));
  }
  // The method follows the accounts that are in the total; `partialGains` still speaks of the selection.
  const allFull = included.every((c) => c.result.fidelity === "full_history");
  const everyFailed = included.length === 0;
  const valueT = memoValueAt((date) => {
    let valueCents = 0n;
    let carried = false;
    for (const c of included) {
      const v = c.valueAt(date);
      valueCents += v.valueCents;
      carried ||= v.carried;
    }
    return { valueCents, carried };
  });
  let chain: ChainResult;
  if (everyFailed) chain = { ...failedReturn("no_valuations", to), subPeriods: [], warnings: [] };
  else if (allFull) chain = trueTwr(from, to, totalFlows, (d) => valueT(d).valueCents);
  else chain = modifiedDietzOver(from, to, totalFlows, included.flatMap((c) => c.boundaries), valueT);
  totalWarnings.push(...chain.warnings);
  const failed = chainWarning(chain);
  if (failed) totalWarnings.push(failed);

  const startValueCents = valueT(from).valueCents;
  const endValueCents = valueT(to).valueCents;
  const totals = flowTotals(totalFlows);
  const netFlowsCents = totals.contributionsCents - totals.withdrawalsCents;
  const growthCents = endValueCents - startValueCents - netFlowsCents - (totals.openingValue?.cents ?? 0n);
  const xirrResult = everyFailed ? failedXirr("no_valuations") : xirrFigure(from, to, startValueCents, totalFlows, endValueCents);
  if (xirrResult.warnings.includes("multiple_roots")) totalWarnings.push(warning("multiple_roots"));
  let benchmark: BenchmarkPerformance | null = null;
  if (input.benchmark && !everyFailed) {
    const b = benchmarkOf(from, to, startValueCents, totalFlows, input.benchmark);
    benchmark = b.benchmark;
    totalWarnings.push(...b.warnings);
  }
  const fullAccounts = accounts.filter((a) => a.fidelity === "full_history");
  const total: TotalPerformance = {
    accountIds: accounts.map((a) => a.accountId),
    partialGains: !contexts.every((c) => c.result.fidelity === "full_history"),
    excludedInternalFlows,
    excludedAccountIds,
    method: contexts.length === 0 ? null : allFull ? "true_twr" : "modified_dietz",
    startValueCents,
    endValueCents,
    openingValue: totals.openingValue,
    contributionsCents: totals.contributionsCents,
    withdrawalsCents: totals.withdrawalsCents,
    netFlowsCents,
    growthCents,
    twr: { rate: chain.rate, annualized: chain.annualized, reason: chain.reason, reasonDate: chain.reasonDate },
    xirr: xirrResult,
    benchmark,
    subPeriods: chain.subPeriods,
    flows: totalFlows,
    realized: fullAccounts.length === 0 ? null : sumRealized(fullAccounts.map((a) => a.realized!)),
    gains: fullAccounts.length === 0 ? null : sumGains(fullAccounts.map((a) => a.gains!)),
    income: mergeIncome(fullAccounts.map((a) => a.income)),
    warnings: totalWarnings,
  };

  return {
    from,
    to,
    asOf,
    days: dayDiff(from, to),
    accounts,
    total,
    benchmark,
    warnings: [...accounts.flatMap((a) => a.warnings), ...totalWarnings],
  };
}
