import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  addDays,
  computePerformance,
  dayDiff,
  isInvestmentAccountType,
  mulToCents,
  valueAccountOn,
  type AccountPerformance,
  type AssetClass,
  type BalanceAnchorInput,
  type BenchmarkPerformance,
  type BenchmarkSeriesInput,
  type DetailLevel,
  type ExternalFlowInput,
  type Fixed8,
  type IsoDate,
  type PerformanceAccountInput,
  type PerformanceInput,
  type PerformanceResult,
  type PositionSnapshot,
  type PriceSeriesInput,
  type SecurityType,
  type TotalPerformance,
  type TransferredLot,
  type ValuationPointInput,
} from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { account, balanceSnapshot, holdingSnapshot, investmentTxn, price, security, transaction } from "../schema/index.js";
import { accountFidelities, type AccountFidelityRecord } from "./accountFidelity.js";
import { PlanError } from "./audit.js";
import { fixed8FromDb, qtyFromDb } from "./decimalDb.js";
import { latestSnapshot } from "./holdings.js";
import { buildAccountLots } from "./lots.js";
import { loadPriceSeries } from "./prices.js";
import { requireSecurity } from "./securities.js";
import { getHouseholdSetting } from "./settings.js";
import { INCEPTION_DATE, listInvestmentAccounts, loadValuationInput, type LoadedValuationInput } from "./valuation.js";

/**
 * The performance services (lots design §3.7–§3.13, §6.2 under plan decisions 7, 8 and 11;
 * seams C22, C36). Read-only.
 *
 * - `loadFlowRows` / `loadExternalFlows`: the one external-flow loader of decision 11. Cash flows
 *   are the accounts' posted ledger `is_transfer` rows ∪ their `investment_txn` cash transfers,
 *   a cash row dropped when it is linked to a ledger row or an equal-amount ledger transfer of
 *   the same account lies within 3 days (the ledger row wins); securities transfers are valued at
 *   market on their date (the row's price, else the latest close on or before it, else the
 *   latest transaction price, else 0); `loadExternalFlows` adds the opening value of every
 *   investment account the chain cannot value at `from` but can by `to` (the engines recompute
 *   those two kinds themselves, so feeding them the full union never double counts).
 * - `loadPerformanceInput`: full-history accounts (derived fidelity) get their securities rows,
 *   picks, stored lot ids and transfer sources (from the lots service's build), reported balance
 *   anchors, a price series reaching back to the two latest anchors on or before `from` (the
 *   engine prices the anchor's securities for the cash plug and the statement check) and the
 *   latest snapshot for the position check; every other account gets the
 *   valuation chain's points (`valueAccountOn` on its data dates and the window's ends), so the
 *   Performance page's values are the Portfolio's on every date (seams §1.8).
 * - `getPerformance`: validation, defaults (`from` = the day before the selected accounts'
 *   first data, `to` = today, `asOf` = `to`, the household benchmark), the engine, and the
 *   `summary` detail that empties the per-flow and per-lot lists.
 */

// ---- External flows (decision 11) ----

function compareFlows(a: ExternalFlowInput, b: ExternalFlowInput): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1;
  const sa = a.sourceId ?? "";
  const sb = b.sourceId ?? "";
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.amountCents < b.amountCents ? -1 : a.amountCents > b.amountCents ? 1 : 0;
}

/** Days either side of an investment cash row within which an equal-amount ledger transfer is its twin. */
export const FLOW_DEDUPE_DAYS = 3;

/** The latest close on or before `date` from the price table, else the latest transaction price of the account's rows (§3.6, no look-ahead). */
async function marketPriceOn(db: DbOrTx, accountId: string, securityId: string, date: IsoDate): Promise<Fixed8 | null> {
  const [close] = await db
    .select({ close: price.close })
    .from(price)
    .where(and(eq(price.securityId, securityId), lte(price.date, date)))
    .orderBy(desc(price.date))
    .limit(1);
  if (close) return fixed8FromDb(close.close);
  const [txn] = await db
    .select({ price: investmentTxn.price })
    .from(investmentTxn)
    .where(and(eq(investmentTxn.accountId, accountId), eq(investmentTxn.securityId, securityId), lte(investmentTxn.date, date), isNotNull(investmentTxn.price)))
    .orderBy(desc(investmentTxn.date), desc(investmentTxn.sequence), desc(investmentTxn.id))
    .limit(1);
  return txn ? qtyFromDb(txn.price) : null;
}

/**
 * The cash and securities flows of `accountIds` dated in `(from, to]`, each with `accountId`,
 * `kind`, `source`, the counterparty and pair id (seams C36). Opening values are not included
 * (see `loadExternalFlows`). Sorted by (date, kind, accountId, sourceId, amount).
 */
export async function loadFlowRows(db: DbOrTx, accountIds: readonly string[], from: IsoDate, to: IsoDate): Promise<ExternalFlowInput[]> {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0 || to <= from) return [];
  const flows: ExternalFlowInput[] = [];

  // (a) Posted ledger transfers, read a little wider than the window for the dedupe of (c). A row
  // an investment row is linked to is a flow like any other but never a dedupe twin (its own
  // investment row is already dropped by the link).
  const other = alias(transaction, "other_leg");
  const ledgerRows = await db
    .select({
      id: transaction.id,
      accountId: transaction.accountId,
      date: transaction.date,
      amountCents: transaction.amountCents,
      pairId: transaction.transferPairId,
      counterpartyAccountId: other.accountId,
      linked: sql<boolean>`exists (select 1 from ${investmentTxn} where ${investmentTxn.ledgerTransactionId} = ${transaction.id})`,
    })
    .from(transaction)
    .leftJoin(other, and(eq(other.transferPairId, transaction.transferPairId), ne(other.id, transaction.id)))
    .where(
      and(
        inArray(transaction.accountId, ids),
        eq(transaction.isTransfer, true),
        eq(transaction.pending, false),
        gte(transaction.date, addDays(from, 1 - FLOW_DEDUPE_DAYS)),
        lte(transaction.date, addDays(to, FLOW_DEDUPE_DAYS)),
      ),
    )
    .orderBy(asc(transaction.date), asc(transaction.id));
  for (const r of ledgerRows) {
    if (r.date <= from || r.date > to) continue;
    flows.push({
      date: r.date,
      amountCents: r.amountCents,
      kind: "cash",
      source: "ledger",
      accountId: r.accountId,
      counterpartyAccountId: r.counterpartyAccountId ?? null,
      pairId: r.pairId,
      sourceId: r.id,
    });
  }

  // (b) Investment transfers in the window: cash rows (security null) and securities rows.
  const invRows = await db
    .select({
      id: investmentTxn.id,
      accountId: investmentTxn.accountId,
      date: investmentTxn.date,
      amountCents: investmentTxn.amountCents,
      securityId: investmentTxn.securityId,
      quantity: investmentTxn.quantity,
      price: investmentTxn.price,
      transferDirection: investmentTxn.transferDirection,
      counterpartyAccountId: investmentTxn.counterpartyAccountId,
      pairId: investmentTxn.transferGroupId,
      ledgerTransactionId: investmentTxn.ledgerTransactionId,
    })
    .from(investmentTxn)
    .where(and(inArray(investmentTxn.accountId, ids), eq(investmentTxn.type, "transfer"), gt(investmentTxn.date, from), lte(investmentTxn.date, to)))
    .orderBy(asc(investmentTxn.date), asc(investmentTxn.sequence), asc(investmentTxn.id));

  // (c) A cash row linked to a ledger row, or twinned by an equal-amount ledger transfer of the
  // same account within 3 days (nearest, then earliest, each ledger row used once), is dropped.
  const usedLedger = new Set<string>();
  for (const r of invRows) {
    if (r.securityId !== null) continue;
    if (r.ledgerTransactionId !== null) continue;
    let twin: (typeof ledgerRows)[number] | null = null;
    let twinDistance = Number.POSITIVE_INFINITY;
    for (const l of ledgerRows) {
      if (l.linked || usedLedger.has(l.id) || l.accountId !== r.accountId || l.amountCents !== r.amountCents) continue;
      const distance = Math.abs(dayDiff(l.date, r.date));
      if (distance > FLOW_DEDUPE_DAYS) continue;
      if (distance < twinDistance || (distance === twinDistance && twin !== null && (l.date < twin.date || (l.date === twin.date && l.id < twin.id)))) {
        twin = l;
        twinDistance = distance;
      }
    }
    if (twin) {
      usedLedger.add(twin.id);
      continue;
    }
    flows.push({
      date: r.date,
      amountCents: r.amountCents,
      kind: "cash",
      source: "investment_txn",
      accountId: r.accountId,
      counterpartyAccountId: r.counterpartyAccountId,
      pairId: r.pairId,
      sourceId: r.id,
    });
  }

  // Securities transfers at market on their date; unpriced → 0 (the position is valued 0 by the same rule).
  for (const r of invRows) {
    if (r.securityId === null) continue;
    const quantity = qtyFromDb(r.quantity);
    if (quantity === null) continue;
    const unitPrice = qtyFromDb(r.price) ?? (await marketPriceOn(db, r.accountId, r.securityId, r.date));
    const cents = unitPrice === null ? 0n : mulToCents(quantity, unitPrice);
    flows.push({
      date: r.date,
      amountCents: r.transferDirection === "out" ? -cents : cents,
      kind: "securities",
      source: "investment_txn",
      accountId: r.accountId,
      counterpartyAccountId: r.counterpartyAccountId,
      pairId: r.pairId,
      sourceId: r.id,
    });
  }

  return flows.sort(compareFlows);
}

/** The dates on which the loaded chain input can change an account's value (snapshot sets, reported balances, lot checkpoints). */
function dataDatesOf(input: LoadedValuationInput, accountId: string): Set<IsoDate> {
  const dates = new Set<IsoDate>();
  for (const s of input.snapshots) if (s.accountId === accountId) dates.add(s.date);
  for (const b of input.balances) if (b.accountId === accountId && b.source !== "computed") dates.add(b.date);
  for (const p of input.tradePositions) if (p.accountId === accountId) dates.add(p.date);
  return dates;
}

/** The opening value of an account the chain cannot value at `from` but can on a data date in `(from, to]` (D18). */
function openingValueFlow(input: LoadedValuationInput, accountId: string, from: IsoDate, to: IsoDate): ExternalFlowInput | null {
  if (valueAccountOn(input, accountId, from).valueCents !== null) return null;
  const dates = [...dataDatesOf(input, accountId)].filter((d) => d > from && d <= to).sort();
  for (const date of dates) {
    const v = valueAccountOn(input, accountId, date).valueCents;
    if (v === null) continue;
    return { date, amountCents: v, kind: "opening_value", source: "engine", accountId, counterpartyAccountId: null, pairId: null, sourceId: null };
  }
  return null;
}

export interface LoadExternalFlowsOptions {
  /** Add the opening values of investment accounts entering after `from` (default true). */
  openingValues?: boolean;
  /** The clock for the chain's price statuses (values do not depend on it); default now. */
  now?: Date;
  fidelities?: ReadonlyMap<string, AccountFidelityRecord>;
}

/**
 * Decision 11's loader: `loadFlowRows` plus the opening value of every investment account among
 * `accountIds` that the chain values first on a date in `(from, to]`. Accounts of other types
 * contribute their ledger transfers only.
 */
export async function loadExternalFlows(db: DbOrTx, accountIds: readonly string[], from: IsoDate, to: IsoDate, opts: LoadExternalFlowsOptions = {}): Promise<ExternalFlowInput[]> {
  const ids = [...new Set(accountIds)];
  const flows = await loadFlowRows(db, ids, from, to);
  if (opts.openingValues === false || ids.length === 0 || to <= from) return flows;
  const rows = await db.select({ id: account.id, type: account.type }).from(account).where(inArray(account.id, ids));
  const investment = rows.filter((r) => isInvestmentAccountType(r.type)).map((r) => r.id);
  if (investment.length === 0) return flows;
  const input = await loadValuationInput(db, { accountIds: investment, from, to, now: opts.now ?? new Date(), ...(opts.fidelities ? { fidelities: opts.fidelities } : {}) });
  for (const id of investment) {
    const opening = openingValueFlow(input, id, from, to);
    if (opening) flows.push(opening);
  }
  return flows.sort(compareFlows);
}

// ---- The loader (§6.2) ----

export interface SecurityMetaRecord {
  id: string;
  ticker: string | null;
  name: string;
  type: SecurityType;
  assetClass: AssetClass;
}

export interface LoadPerformanceInputQuery {
  from: IsoDate;
  to: IsoDate;
  asOf: IsoDate;
  accountIds: readonly string[];
  /** Null = no benchmark. */
  benchmarkSecurityId: string | null;
  /** The clock for the chain's price statuses; default now. */
  now?: Date;
  fidelities?: ReadonlyMap<string, AccountFidelityRecord>;
}

export interface LoadedPerformanceInput extends PerformanceInput {
  accounts: PerformanceAccountInput[];
  /** Every security the input references (holdings, lots, flows, benchmark), for the view's tickers and names. */
  securities: Map<string, SecurityMetaRecord>;
  accountNames: Map<string, string>;
}

/** The chain's points for a non-full account: its data dates in the window, the latest one before it, and the window's ends when priced there. */
function chainPoints(input: LoadedValuationInput, accountId: string, from: IsoDate, to: IsoDate): ValuationPointInput[] {
  const dates = dataDatesOf(input, accountId);
  const candidates = new Set<IsoDate>([from, to]);
  let latestBefore: IsoDate | null = null;
  for (const d of dates) {
    if (d > from && d <= to) candidates.add(d);
    else if (d <= from && (latestBefore === null || d > latestBefore)) latestBefore = d;
  }
  if (latestBefore !== null) candidates.add(latestBefore);
  const points: ValuationPointInput[] = [];
  for (const date of [...candidates].sort()) {
    const v = valueAccountOn(input, accountId, date);
    if (v.valueCents === null) continue;
    // A balance carried onto a non-data date is the engine's own carry (flagged `valuation_carried`).
    if (!dates.has(date) && v.basis === "balance") continue;
    points.push({ date, valueCents: v.valueCents });
  }
  return points;
}

/** The latest snapshot set as the engine's position check reads it (cash-like securities skipped). */
async function latestPositionSnapshot(db: DbOrTx, accountId: string): Promise<PositionSnapshot | null> {
  const snapshot = await latestSnapshot(db, accountId);
  if (!snapshot) return null;
  const ids = snapshot.rows.map((r) => r.securityId);
  const meta = ids.length === 0 ? [] : await db.select({ id: security.id, type: security.type, assetClass: security.assetClass }).from(security).where(inArray(security.id, ids));
  const skip = new Set(meta.filter((m) => m.type === "cash" || m.assetClass === "cash").map((m) => m.id));
  return { date: snapshot.date, quantities: new Map(snapshot.rows.map((r) => [r.securityId, r.quantity])), skipSecurityIds: skip };
}

async function securityMeta(db: DbOrTx, ids: Iterable<string>): Promise<Map<string, SecurityMetaRecord>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.select({ id: security.id, ticker: security.ticker, name: security.name, type: security.type, assetClass: security.assetClass }).from(security).where(inArray(security.id, unique));
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Everything `computePerformance` needs for `accountIds` over `(from, to]` with holdings as of
 * `asOf` (lots design §6.2 under decisions 7 and 8): full-history accounts from their rows and
 * reported balances, the others from the chain's points; price series for the full accounts'
 * securities (from the earlier of `from` and their two latest anchors on or before it) and the
 * benchmark (adjusted closes when every row has one).
 */
export async function loadPerformanceInput(db: DbOrTx, q: LoadPerformanceInputQuery): Promise<LoadedPerformanceInput> {
  if (q.to <= q.from) throw new PlanError(400, "validation", `to ${q.to} must be after from ${q.from}`);
  const accounts = await listInvestmentAccounts(db, { accountIds: q.accountIds, includeClosed: true });
  const ids = accounts.map((a) => a.id);
  const fidelities = q.fidelities ? new Map([...q.fidelities].filter(([id]) => ids.includes(id))) : await accountFidelities(db, ids);
  const through = q.asOf > q.to ? q.asOf : q.to;
  const now = q.now ?? new Date();

  const full = accounts.filter((a) => fidelities.get(a.id)?.fidelity === "full_history");
  const nonFull = accounts.filter((a) => fidelities.get(a.id)?.fidelity !== "full_history");

  // A full account rolls cash forward from its latest anchor, or from inception without one: its flows are read since inception.
  const flowFrom = full.length > 0 ? INCEPTION_DATE : addDays(q.from, -1);
  const flowRows = ids.length === 0 ? [] : await loadFlowRows(db, ids, flowFrom, through);
  const flowsByAccount = new Map<string, ExternalFlowInput[]>();
  for (const f of flowRows) {
    const list = flowsByAccount.get(f.accountId) ?? [];
    list.push(f);
    flowsByAccount.set(f.accountId, list);
  }

  const chain = nonFull.length === 0 ? null : await loadValuationInput(db, { accountIds: nonFull.map((a) => a.id), from: q.from, to: q.to, now, fidelities });

  const securityIds = new Set<string>();
  // The engine prices a full account's securities at its cash anchor (D19) and, for the statement
  // check, at the anchor before the one it checks; the latest two reported balances on or before
  // `from` can predate it, so the price series must reach back to them (a close between such an
  // anchor and `from` would otherwise hide the anchor's own close and misprice the cash plug).
  let priceFrom = q.from;
  const inputs: PerformanceAccountInput[] = [];
  for (const a of accounts) {
    const fidelity = fidelities.get(a.id)?.fidelity ?? "balance_only";
    const base = { accountId: a.id, name: a.name, type: a.type, taxTreatment: a.taxTreatment, fidelity, lotMethod: a.lotMethod, cashFlows: flowsByAccount.get(a.id) ?? [] };
    if (fidelity === "full_history") {
      const build = await buildAccountLots(db, a.id);
      const lotIds = new Map(build.result.lots.map((l) => [`${l.openedByTxnId}:${l.ordinal}`, l.id]));
      const transferSources = new Map<string, TransferredLot[]>();
      for (const l of build.result.lots) {
        if (l.openedBy !== "transfer_in" || l.originLotId === null) continue;
        const list = transferSources.get(l.openedByTxnId) ?? [];
        list[l.ordinal] = { txnId: l.openedByTxnId, lotId: l.originLotId, securityId: l.securityId, acquiredDate: l.acquiredDate, quantity: l.originalQuantity, basisCents: l.originalCostBasisCents, basisKnown: l.basisKnown };
        transferSources.set(l.openedByTxnId, list);
      }
      for (const t of build.txns) if (t.securityId !== null) securityIds.add(t.securityId);
      const anchors = await db
        .select({ date: balanceSnapshot.date, balanceCents: balanceSnapshot.balanceCents })
        .from(balanceSnapshot)
        .where(and(eq(balanceSnapshot.accountId, a.id), ne(balanceSnapshot.source, "computed"), lte(balanceSnapshot.date, through)))
        .orderBy(asc(balanceSnapshot.date));
      const cashAnchors: BalanceAnchorInput[] = anchors.map((r) => ({ date: r.date, balanceCents: r.balanceCents }));
      for (const r of cashAnchors.filter((r) => r.date <= q.from).slice(-2)) if (r.date < priceFrom) priceFrom = r.date;
      inputs.push({
        ...base,
        txns: build.txns,
        lotPicks: build.picks,
        transferSources,
        lotId: (openedByTxnId, ordinal) => lotIds.get(`${openedByTxnId}:${ordinal}`) ?? `${openedByTxnId}:${ordinal}`,
        cashAnchors,
        valuations: [],
        latestHoldingSnapshot: await latestPositionSnapshot(db, a.id),
      });
    } else {
      inputs.push({ ...base, txns: [], lotPicks: [], cashAnchors: [], valuations: chain ? chainPoints(chain, a.id, q.from, q.to) : [], latestHoldingSnapshot: null });
    }
  }

  const series = await loadPriceSeries(db, [...securityIds], priceFrom, through);
  const prices: PriceSeriesInput[] = [...series.values()].map((s) => ({ securityId: s.securityId, points: s.points.map((p) => ({ date: p.date, close: p.close, source: p.source })) }));

  let benchmark: BenchmarkSeriesInput | null = null;
  if (q.benchmarkSecurityId !== null) {
    const row = await requireSecurity(db, q.benchmarkSecurityId);
    if (row.type === "cash") throw new PlanError(400, "validation", "The cash security cannot be a benchmark");
    const [s] = [...(await loadPriceSeries(db, [row.id], q.from, q.to, { adjusted: true })).values()];
    benchmark = { securityId: row.id, adjusted: s?.adjusted ?? false, points: (s?.points ?? []).map((p) => ({ date: p.date, close: p.close, source: p.source })) };
    securityIds.add(row.id);
  }

  const counterparties = new Set<string>();
  for (const f of flowRows) if (f.counterpartyAccountId) counterparties.add(f.counterpartyAccountId);
  const accountNames = new Map(accounts.map((a) => [a.id, a.name]));
  const missingNames = [...counterparties].filter((id) => !accountNames.has(id));
  if (missingNames.length > 0) {
    const rows = await db.select({ id: account.id, name: account.name }).from(account).where(inArray(account.id, missingNames));
    for (const r of rows) accountNames.set(r.id, r.name);
  }

  return { from: q.from, to: q.to, asOf: q.asOf, accounts: inputs, prices, benchmark, securities: await securityMeta(db, securityIds), accountNames };
}

// ---- getPerformance ----

export interface GetPerformanceQuery {
  /** Default: the day before the selected accounts' first data (since inception). */
  from?: IsoDate;
  /** Default: today; `from < to ≤ today`. */
  to?: IsoDate;
  /** Holdings valuation date; default `to`. */
  asOf?: IsoDate;
  /** Default: every open investment account. */
  accountIds?: readonly string[];
  /** Absent → the household benchmark; null → none. */
  benchmarkSecurityId?: string | null;
  today: IsoDate;
  detail?: DetailLevel;
  now?: Date;
}

/** Bigint twin of `PerformanceResponse` plus what the mapper needs for names (tickers, account names). */
export interface PerformanceRecord extends PerformanceResult {
  today: IsoDate;
  detail: DetailLevel;
  securities: Map<string, SecurityMetaRecord>;
  accountNames: Map<string, string>;
}

/** The day before the earliest transaction, posted ledger transfer, reported balance or snapshot of the accounts; null without data. */
async function inceptionFrom(db: DbOrTx, accountIds: readonly string[]): Promise<IsoDate | null> {
  if (accountIds.length === 0) return null;
  const ids = [...accountIds];
  const [txn] = await db.select({ first: sql<string | null>`min(${investmentTxn.date})::text` }).from(investmentTxn).where(inArray(investmentTxn.accountId, ids));
  const [ledger] = await db
    .select({ first: sql<string | null>`min(${transaction.date})::text` })
    .from(transaction)
    .where(and(inArray(transaction.accountId, ids), eq(transaction.isTransfer, true), eq(transaction.pending, false)));
  const [balance] = await db
    .select({ first: sql<string | null>`min(${balanceSnapshot.date})::text` })
    .from(balanceSnapshot)
    .where(and(inArray(balanceSnapshot.accountId, ids), ne(balanceSnapshot.source, "computed")));
  const [snapshot] = await db.select({ first: sql<string | null>`min(${holdingSnapshot.date})::text` }).from(holdingSnapshot).where(inArray(holdingSnapshot.accountId, ids));
  let earliest: IsoDate | null = null;
  for (const d of [txn?.first, ledger?.first, balance?.first, snapshot?.first]) {
    if (d && (earliest === null || d < earliest)) earliest = d;
  }
  return earliest === null ? null : addDays(earliest, -1);
}

function stripBenchmark(b: BenchmarkPerformance | null): BenchmarkPerformance | null {
  return b === null ? null : { ...b, xirr: { ...b.xirr, investorFlows: [] }, legs: [] };
}

function stripAccount(a: AccountPerformance): AccountPerformance {
  return { ...a, subPeriods: [], flows: [], lots: [], disposals: [], xirr: { ...a.xirr, investorFlows: [] }, benchmark: stripBenchmark(a.benchmark) };
}

function stripTotal(t: TotalPerformance): TotalPerformance {
  return { ...t, subPeriods: [], flows: [], xirr: { ...t.xirr, investorFlows: [] }, benchmark: stripBenchmark(t.benchmark) };
}

/** `summary` detail: the per-flow and per-lot lists are emptied (lots design §6.2); figures are unchanged. */
export function applyDetail(result: PerformanceResult, detail: DetailLevel): PerformanceResult {
  if (detail === "full") return result;
  return { ...result, accounts: result.accounts.map(stripAccount), total: stripTotal(result.total), benchmark: stripBenchmark(result.benchmark) };
}

/**
 * `POST /api/investments/performance` and the Performance view: validates the range
 * (`from < to ≤ today`, `asOf ≤ today`, investment accounts only), loads the input and runs the
 * engine. Runs inline and writes nothing.
 */
export async function getPerformance(db: DbOrTx, q: GetPerformanceQuery): Promise<PerformanceRecord> {
  const to = q.to ?? q.today;
  if (to > q.today) throw new PlanError(400, "validation", `to ${to} is after today ${q.today}`);
  const asOf = q.asOf ?? to;
  if (asOf > q.today) throw new PlanError(400, "validation", `asOf ${asOf} is after today ${q.today}`);
  const accounts = await listInvestmentAccounts(db, q.accountIds ? { accountIds: q.accountIds } : {});
  const ids = accounts.map((a) => a.id);
  let from = q.from ?? null;
  if (from === null) {
    const inception = await inceptionFrom(db, ids);
    from = inception !== null && inception < to ? inception : addDays(to, -1);
  }
  if (from >= to) throw new PlanError(400, "validation", `from ${from} must be before to ${to}`);
  let benchmarkSecurityId: string | null;
  if (q.benchmarkSecurityId === undefined) benchmarkSecurityId = (await getHouseholdSetting(db, q.today)).benchmarkSecurityId;
  else benchmarkSecurityId = q.benchmarkSecurityId;
  const detail = q.detail ?? "summary";

  const input = await loadPerformanceInput(db, { from, to, asOf, accountIds: ids, benchmarkSecurityId, ...(q.now ? { now: q.now } : {}) });
  const result = applyDetail(computePerformance(input), detail);
  const securityIds = new Set<string>(input.securities.keys());
  for (const a of result.accounts) {
    for (const h of a.holdings) if (h.securityId) securityIds.add(h.securityId);
    for (const w of a.warnings) if (w.securityId) securityIds.add(w.securityId);
    for (const i of a.income) if (i.securityId) securityIds.add(i.securityId);
  }
  for (const w of result.warnings) if (w.securityId) securityIds.add(w.securityId);
  const securities = securityIds.size === input.securities.size ? input.securities : await securityMeta(db, securityIds);
  return { ...result, today: q.today, detail, securities, accountNames: input.accountNames };
}
