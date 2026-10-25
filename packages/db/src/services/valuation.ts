import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, notExists, or, sql } from "drizzle-orm";
import {
  addDays,
  dayChange,
  dayDiff,
  expectedPriceDate,
  INVESTMENT_ACCOUNT_TYPES,
  isInvestmentAccountType,
  MAX_SERIES_DAYS,
  periodChange,
  periodStart,
  valueAccountOn,
  valueSeries,
  type AccountDayChange,
  type AccountType,
  type AccountValuation,
  type AggregatePriceStatus,
  type CashInference,
  type InvestmentIncomeFeed,
  type InvestmentPeriod,
  type IsoDate,
  type LotMethod,
  type PeriodChange,
  type PortfolioDayChange,
  type SeriesAccount,
  type SeriesPoint,
  type SeriesStep,
  type TaxTreatment,
  type ValuationAccount,
  type ValuationBalance,
  type ValuationCashEffect,
  type ValuationFlow,
  type ValuationInput,
  type ValuationPrice,
  type ValuationSecurity,
  type ValuationSnapshotLine,
  type ValuationTradePosition,
} from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { account, balanceSnapshot, holdingSnapshot, householdSetting, investmentTxn, price, security, transaction } from "../schema/index.js";
import { accountFidelities, type AccountFidelityRecord, type LastReconciliationRecord } from "./accountFidelity.js";
import { PlanError } from "./audit.js";
import { fixed8FromDb, qtyFromDb } from "./decimalDb.js";
import { buildAccountLots } from "./lots.js";
import { loadFlowRows } from "./performance.js";

/**
 * The valuation services (prices design §3.8–§3.9, §6.1 under plan decisions 8, 11 and 12;
 * seams C19–C24). Everything here is read-only: the loader fills the pure chain's input from
 * `holding_snapshot`, `price`, `balance_snapshot` (reported rows only), `loadFlowRows` and, for
 * accounts whose derived fidelity is `full_history`, the lot engine's position checkpoints and
 * cash effects; the summary and the series are `valueAccountOn` / `valueSeries` / `dayChange` /
 * `periodChange` over that input, plus the two ledger-derived figures of the period change
 * (`incomeCents`, `uncategorizedRows`). Mappers in the API stringify the records.
 *
 * Windowing: the loader reads the rows the chain can reach from `[from, to]`: the latest snapshot
 * set and the latest reported balance on or before `from` per account (the chain's statement
 * and cash anchor), everything in `(from, to]`, prices from a week before the earliest of those
 * anchors (the day change's prior close) plus the two latest rows before that, and flows since
 * the day before the earliest anchor (carried transfers roll from the anchor forward). The lot
 * engine's checkpoints are complete by construction. The true first data date per account is
 * read separately (`firstDataDates`) because the window hides it from the engine.
 *
 * `valuation.ts` and `performance.ts` import each other (the chain carries the flow loader's
 * cash legs; the performance loader feeds the chain's points): every cross-use is inside a
 * function body, as with `securities.ts` and `prices.ts`.
 */

// ---- Accounts ----

export interface InvestmentAccountRecord {
  id: string;
  name: string;
  type: AccountType;
  taxTreatment: TaxTreatment;
  closed: boolean;
  lotMethod: LotMethod;
  cashInference: CashInference;
  investmentIncomeFeed: InvestmentIncomeFeed;
}

export interface ListInvestmentAccountsOptions {
  /** Validate and keep only these (400 `bad_request` for an unknown, non-investment or closed id). */
  accountIds?: readonly string[];
  /** Accept closed accounts (the valuation job values history; the routes never do). */
  includeClosed?: boolean;
}

function toAccountRecord(r: typeof account.$inferSelect): InvestmentAccountRecord {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    taxTreatment: r.taxTreatment,
    closed: r.closed,
    lotMethod: r.lotMethod,
    cashInference: r.cashInference,
    investmentIncomeFeed: r.investmentIncomeFeed,
  };
}

function byNameThenId(a: { name: string; id: string }, b: { name: string; id: string }): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The investment accounts a valuation covers, ordered by name then id: every open account of the
 * six investment types, or the requested ids validated (prices design §3.8: an entry outside
 * that set → `400 bad_request`).
 */
export async function listInvestmentAccounts(db: DbOrTx, opts: ListInvestmentAccountsOptions = {}): Promise<InvestmentAccountRecord[]> {
  if (opts.accountIds) {
    const ids = [...new Set(opts.accountIds)];
    if (ids.length === 0) return [];
    const rows = await db.select().from(account).where(inArray(account.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: InvestmentAccountRecord[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) throw new PlanError(400, "bad_request", `Unknown account ${id}`);
      if (!isInvestmentAccountType(row.type)) throw new PlanError(400, "bad_request", `${row.name} is a ${row.type} account, not an investment account`);
      if (row.closed && !opts.includeClosed) throw new PlanError(400, "bad_request", `${row.name} is closed`);
      out.push(toAccountRecord(row));
    }
    return out.sort(byNameThenId);
  }
  const rows = await db
    .select()
    .from(account)
    .where(and(inArray(account.type, [...INVESTMENT_ACCOUNT_TYPES]), opts.includeClosed ? undefined : eq(account.closed, false)))
    .orderBy(asc(account.name), asc(account.id));
  return rows.map(toAccountRecord);
}

/** The ids of `listInvestmentAccounts`, in its order. */
export async function investmentAccountIds(db: DbOrTx, accountIds?: readonly string[], opts: { includeClosed?: boolean } = {}): Promise<string[]> {
  const accounts = await listInvestmentAccounts(db, { ...(accountIds ? { accountIds } : {}), ...opts });
  return accounts.map((a) => a.id);
}

// ---- First data dates ----

function minDate(a: IsoDate | null, b: IsoDate | null | undefined): IsoDate | null {
  if (b === null || b === undefined) return a;
  if (a === null) return b;
  return b < a ? b : a;
}

/**
 * The earliest date each account can be valued on (the engine's `firstDataDate` rule over the
 * whole table rather than the loaded window): its first holding snapshot, first reported balance
 * or, for a full-history account, first securities transaction. Null without any.
 */
export async function firstDataDates(db: DbOrTx, accountIds: readonly string[], fidelities: ReadonlyMap<string, Pick<AccountFidelityRecord, "fidelity">>): Promise<Map<string, IsoDate | null>> {
  const ids = [...new Set(accountIds)];
  const out = new Map<string, IsoDate | null>(ids.map((id) => [id, null]));
  if (ids.length === 0) return out;
  const snapshots = await db
    .select({ accountId: holdingSnapshot.accountId, first: sql<string>`min(${holdingSnapshot.date})::text` })
    .from(holdingSnapshot)
    .where(inArray(holdingSnapshot.accountId, ids))
    .groupBy(holdingSnapshot.accountId);
  const balances = await db
    .select({ accountId: balanceSnapshot.accountId, first: sql<string>`min(${balanceSnapshot.date})::text` })
    .from(balanceSnapshot)
    .where(and(inArray(balanceSnapshot.accountId, ids), ne(balanceSnapshot.source, "computed")))
    .groupBy(balanceSnapshot.accountId);
  const full = ids.filter((id) => fidelities.get(id)?.fidelity === "full_history");
  const txns =
    full.length === 0
      ? []
      : await db
          .select({ accountId: investmentTxn.accountId, first: sql<string>`min(${investmentTxn.date})::text` })
          .from(investmentTxn)
          .where(and(inArray(investmentTxn.accountId, full), sql`not (${investmentTxn.type} = 'transfer' and ${investmentTxn.securityId} is null)`))
          .groupBy(investmentTxn.accountId);
  for (const r of [...snapshots, ...balances, ...txns]) out.set(r.accountId, minDate(out.get(r.accountId) ?? null, r.first));
  return out;
}

/** The earliest of a map's dates, or null. */
export function earliestDataDate(dates: ReadonlyMap<string, IsoDate | null>): IsoDate | null {
  let earliest: IsoDate | null = null;
  for (const d of dates.values()) earliest = minDate(earliest, d);
  return earliest;
}

// ---- The loader (§6.1) ----

/** Calendar days of prices read before the earliest anchor, so the day change's prior close is in memory even over a long weekend. */
const PRICE_LOOKBACK_DAYS = 7;
/** Before any ledger: "since inception" for the flow loaders. */
export const INCEPTION_DATE: IsoDate = "1900-01-01";

export interface LoadValuationInputQuery {
  accountIds: readonly string[];
  from: IsoDate;
  to: IsoDate;
  /** `expectedThrough = expectedPriceDate(now)`. */
  now: Date;
  /** Reuse an `accountFidelities` result (the position check runs the lot engine per account). */
  fidelities?: ReadonlyMap<string, AccountFidelityRecord>;
}

export interface LoadedValuationInput extends ValuationInput {
  accounts: ValuationAccount[];
  fidelities: Map<string, AccountFidelityRecord>;
  /** The true first data date per account (the engine's own is bound to the loaded window). */
  firstDataDates: Map<string, IsoDate | null>;
}

async function loadAccountRows(db: DbOrTx, ids: readonly string[]): Promise<InvestmentAccountRecord[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(account).where(inArray(account.id, [...ids]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) throw new PlanError(400, "bad_request", `Unknown account ${id}`);
    if (!isInvestmentAccountType(row.type)) throw new PlanError(400, "bad_request", `${row.name} is a ${row.type} account, not an investment account`);
    return toAccountRecord(row);
  });
}

/**
 * Fill the chain's input for `accountIds` over `[from, to]` (prices design §6.1): accounts with
 * their derived fidelity, the securities their snapshots and lots reference, prices, snapshot
 * sets, reported balances, external flows and, for full-history accounts, the lot engine's
 * checkpoints and cash effects. Pure engine calls follow; nothing is written.
 */
export async function loadValuationInput(db: DbOrTx, q: LoadValuationInputQuery): Promise<LoadedValuationInput> {
  if (q.to < q.from) throw new PlanError(400, "validation", `to ${q.to} is before from ${q.from}`);
  const ids = [...new Set(q.accountIds)];
  const rows = await loadAccountRows(db, ids);
  const fidelities = q.fidelities ? new Map([...q.fidelities].filter(([id]) => ids.includes(id))) : await accountFidelities(db, ids);
  const accounts: ValuationAccount[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    taxTreatment: r.taxTreatment,
    fidelity: fidelities.get(r.id)?.fidelity ?? "balance_only",
    cashInference: r.cashInference,
  }));
  const expectedThrough = expectedPriceDate(q.now);
  if (ids.length === 0) {
    return { expectedThrough, accounts, securities: [], prices: [], snapshots: [], balances: [], flows: [], tradePositions: [], cashEffects: [], fidelities, firstDataDates: new Map() };
  }

  // The anchors on or before `from`: the latest reported balance and the latest snapshot set per account.
  const balanceAnchors = await db
    .selectDistinctOn([balanceSnapshot.accountId], { accountId: balanceSnapshot.accountId, date: balanceSnapshot.date, balanceCents: balanceSnapshot.balanceCents, source: balanceSnapshot.source })
    .from(balanceSnapshot)
    .where(and(inArray(balanceSnapshot.accountId, ids), ne(balanceSnapshot.source, "computed"), lte(balanceSnapshot.date, q.from)))
    .orderBy(asc(balanceSnapshot.accountId), desc(balanceSnapshot.date));
  const snapshotAnchors = await db
    .select({ accountId: holdingSnapshot.accountId, date: sql<string>`max(${holdingSnapshot.date})::text` })
    .from(holdingSnapshot)
    .where(and(inArray(holdingSnapshot.accountId, ids), lte(holdingSnapshot.date, q.from)))
    .groupBy(holdingSnapshot.accountId);
  let lo = q.from;
  for (const a of balanceAnchors) if (a.date < lo) lo = a.date;
  for (const a of snapshotAnchors) if (a.date < lo) lo = a.date;

  const balanceWindow = await db
    .select({ accountId: balanceSnapshot.accountId, date: balanceSnapshot.date, balanceCents: balanceSnapshot.balanceCents, source: balanceSnapshot.source })
    .from(balanceSnapshot)
    .where(and(inArray(balanceSnapshot.accountId, ids), ne(balanceSnapshot.source, "computed"), gt(balanceSnapshot.date, q.from), lte(balanceSnapshot.date, q.to)));
  const balances: ValuationBalance[] = [...balanceAnchors, ...balanceWindow].map((b) => ({ accountId: b.accountId, date: b.date, balanceCents: b.balanceCents, source: b.source }));

  const snapshotRows = await db
    .select({
      accountId: holdingSnapshot.accountId,
      securityId: holdingSnapshot.securityId,
      date: holdingSnapshot.date,
      quantity: holdingSnapshot.quantity,
      price: holdingSnapshot.price,
      valueCents: holdingSnapshot.valueCents,
    })
    .from(holdingSnapshot)
    .where(
      and(
        inArray(holdingSnapshot.accountId, ids),
        or(and(gt(holdingSnapshot.date, q.from), lte(holdingSnapshot.date, q.to)), ...snapshotAnchors.map((a) => and(eq(holdingSnapshot.accountId, a.accountId), eq(holdingSnapshot.date, a.date)))),
      ),
    );
  const snapshots: ValuationSnapshotLine[] = snapshotRows.map((r) => ({
    accountId: r.accountId,
    securityId: r.securityId,
    date: r.date,
    quantity: qtyFromDb(r.quantity),
    price: qtyFromDb(r.price),
    valueCents: r.valueCents,
  }));
  const securityIds = new Set<string>(snapshotRows.map((r) => r.securityId));

  // Full-history accounts: the lot engine's checkpoints (complete) and the trades' cash legs.
  const tradePositions: ValuationTradePosition[] = [];
  const cashEffects: ValuationCashEffect[] = [];
  for (const a of accounts) {
    if (a.fidelity !== "full_history") continue;
    const build = await buildAccountLots(db, a.id);
    for (const p of build.result.positions) {
      tradePositions.push({ accountId: a.id, date: p.date, quantityBySecurity: p.quantityBySecurity });
      for (const [securityId, quantity] of p.quantityBySecurity) if (quantity !== 0n) securityIds.add(securityId);
    }
    for (const e of build.result.cashEffects) cashEffects.push({ accountId: a.id, date: e.date, cents: e.cents });
  }

  const securityRows =
    securityIds.size === 0
      ? []
      : await db
          .select({ id: security.id, ticker: security.ticker, name: security.name, type: security.type, assetClass: security.assetClass, priceMode: security.priceMode })
          .from(security)
          .where(inArray(security.id, [...securityIds]));
  const securities: ValuationSecurity[] = securityRows.map((s) => ({ id: s.id, ticker: s.ticker, name: s.name, type: s.type, assetClass: s.assetClass, priceMode: s.priceMode }));

  // Prices: the window back to a week before the earliest anchor, plus the two latest rows before that per security.
  const prices: ValuationPrice[] = [];
  if (securityIds.size > 0) {
    const secIds = [...securityIds];
    const priceLo = addDays(lo, -PRICE_LOOKBACK_DAYS);
    const window = await db
      .select({ securityId: price.securityId, date: price.date, close: price.close, source: price.source })
      .from(price)
      .where(and(inArray(price.securityId, secIds), gt(price.date, priceLo), lte(price.date, q.to)));
    const ranked = db
      .select({
        securityId: price.securityId,
        date: price.date,
        close: price.close,
        source: price.source,
        rn: sql<number>`row_number() over (partition by ${price.securityId} order by ${price.date} desc)`.as("rn"),
      })
      .from(price)
      .where(and(inArray(price.securityId, secIds), lte(price.date, priceLo)))
      .as("ranked");
    const older = await db.select({ securityId: ranked.securityId, date: ranked.date, close: ranked.close, source: ranked.source }).from(ranked).where(lte(ranked.rn, 2));
    for (const r of [...older, ...window]) prices.push({ securityId: r.securityId, date: r.date, close: fixed8FromDb(r.close), source: r.source });
  }

  // Carried transfers roll from the anchor forward; a full-history account without an anchor rolls its cash from inception.
  const flowFrom = tradePositions.length > 0 ? INCEPTION_DATE : addDays(lo, -1);
  const flowRows = await loadFlowRows(db, ids, flowFrom, q.to);
  const flows: ValuationFlow[] = flowRows.map((f) => ({ accountId: f.accountId, date: f.date, amountCents: f.amountCents, kind: f.kind }));

  const firsts = await firstDataDates(db, ids, fidelities);
  return { expectedThrough, accounts, securities, prices, snapshots, balances, flows, tradePositions, cashEffects, fidelities, firstDataDates: firsts };
}

/** The chain on one date for several accounts (the reconcile preview, the views' context, the valuation job). */
export async function valueAccountsOn(db: DbOrTx, q: { accountIds: readonly string[]; date: IsoDate; now: Date; fidelities?: ReadonlyMap<string, AccountFidelityRecord> }): Promise<AccountValuation[]> {
  const ids = [...new Set(q.accountIds)];
  const input = await loadValuationInput(db, { accountIds: ids, from: q.date, to: q.date, now: q.now, ...(q.fidelities ? { fidelities: q.fidelities } : {}) });
  return ids.map((id) => valueAccountOn(input, id, q.date));
}

// ---- Period-change figures the engine leaves to the service (views design §3.9, §3.13) ----

/**
 * Income in `(from, to]`: dividend and interest `investment_txn` rows of the accounts plus the
 * accounts' ledger rows in the household feed category that no investment row is linked to
 * (views design §3.13, the union that never double counts).
 */
export async function incomeInWindow(db: DbOrTx, accountIds: readonly string[], from: IsoDate, to: IsoDate): Promise<bigint> {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return 0n;
  const [inv] = await db
    .select({ sum: sql<string>`coalesce(sum(${investmentTxn.amountCents}), 0)::text` })
    .from(investmentTxn)
    .where(and(inArray(investmentTxn.accountId, ids), inArray(investmentTxn.type, ["dividend", "interest"]), gt(investmentTxn.date, from), lte(investmentTxn.date, to)));
  let total = BigInt(inv?.sum ?? "0");
  const [setting] = await db.select({ categoryId: householdSetting.investmentIncomeCategoryId }).from(householdSetting).where(eq(householdSetting.id, 1));
  if (setting?.categoryId) {
    const [ledger] = await db
      .select({ sum: sql<string>`coalesce(sum(${transaction.amountCents}), 0)::text` })
      .from(transaction)
      .where(
        and(
          inArray(transaction.accountId, ids),
          eq(transaction.categoryId, setting.categoryId),
          eq(transaction.isTransfer, false),
          eq(transaction.pending, false),
          ne(transaction.source, "investment"),
          gt(transaction.date, from),
          lte(transaction.date, to),
          notExists(db.select({ one: sql`1` }).from(investmentTxn).where(eq(investmentTxn.ledgerTransactionId, transaction.id))),
        ),
      );
    total += BigInt(ledger?.sum ?? "0");
  }
  return total;
}

/**
 * Ledger rows of the accounts in `(from, to]` that are neither transfers nor categorized nor
 * pending nor linked to an investment row (views design §3.9): an unmarked contribution is the
 * usual reason a return looks wrong.
 */
export async function uncategorizedRowsInWindow(db: DbOrTx, accountIds: readonly string[], from: IsoDate, to: IsoDate): Promise<number> {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transaction)
    .where(
      and(
        inArray(transaction.accountId, ids),
        eq(transaction.isTransfer, false),
        isNull(transaction.categoryId),
        eq(transaction.pending, false),
        gt(transaction.date, from),
        lte(transaction.date, to),
        notExists(db.select({ one: sql`1` }).from(investmentTxn).where(eq(investmentTxn.ledgerTransactionId, transaction.id))),
      ),
    );
  return row?.n ?? 0;
}

// ---- Summary (`GET /api/valuation/summary`) ----

export interface ValuationSummaryQueryInput {
  /** Defaults to `today`; must not be after it. */
  asOf?: IsoDate;
  today: IsoDate;
  /** The server clock, for `expectedPriceDate`. */
  now: Date;
  /** Default: every open investment account. */
  accountIds?: readonly string[];
  /** Default `1m`. */
  period?: InvestmentPeriod;
  /** The start of a `custom` period. */
  from?: IsoDate | null;
}

/** The engine's period change plus the two ledger-derived figures (bigint twin of `PeriodChangeView`). */
export interface PeriodChangeRecord extends PeriodChange {
  incomeCents: bigint;
  uncategorizedRows: number;
}

/** Bigint twin of `AccountValuationView`. */
export interface AccountValuationRecord extends AccountValuation {
  dayChange: AccountDayChange;
  lastReconciliation: LastReconciliationRecord | null;
}

/** Bigint twin of `ValuationSummaryResponse`. */
export interface ValuationSummaryRecord {
  asOf: IsoDate;
  today: IsoDate;
  expectedDate: IsoDate;
  totalCents: bigint | null;
  partial: boolean;
  missing: string[];
  priceStatus: AggregatePriceStatus;
  dayChange: PortfolioDayChange;
  periodChange: PeriodChangeRecord | null;
  accounts: AccountValuationRecord[];
}

const STATUS_RANK: Record<AggregatePriceStatus, number> = { "n/a": 0, current: 1, implied: 2, stale: 3 };

function worstStatus(statuses: readonly AggregatePriceStatus[]): AggregatePriceStatus {
  let worst: AggregatePriceStatus = "n/a";
  for (const s of statuses) if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
  return worst;
}

/**
 * The Portfolio's numbers on `asOf`: every account by the chain, the day change (price movement
 * on the quantities held), the period change (one computation, decision 12) with income and
 * uncategorized rows, and the household total with its partial/missing state.
 */
export async function valuationSummary(db: DbOrTx, q: ValuationSummaryQueryInput): Promise<ValuationSummaryRecord> {
  const asOf = q.asOf ?? q.today;
  if (asOf > q.today) throw new PlanError(400, "validation", `asOf ${asOf} is after today ${q.today}`);
  const period = q.period ?? "1m";
  const from = q.from ?? null;
  if (period === "custom") {
    if (from === null) throw new PlanError(400, "validation", "A custom period needs from");
    if (from > asOf) throw new PlanError(400, "validation", `from ${from} is after asOf ${asOf}`);
  }
  const accounts = await listInvestmentAccounts(db, q.accountIds ? { accountIds: q.accountIds } : {});
  const ids = accounts.map((a) => a.id);
  const fidelities = await accountFidelities(db, ids);
  const firsts = await firstDataDates(db, ids, fidelities);
  const start = periodStart(period, asOf, { earliest: earliestDataDate(firsts), from });
  const loadFrom = start !== null && start < asOf ? start : asOf;
  const input = await loadValuationInput(db, { accountIds: ids, from: loadFrom, to: asOf, now: q.now, fidelities });

  const valuations = ids.map((id) => valueAccountOn(input, id, asOf));
  const day = dayChange(input, ids, asOf);
  const change = periodChange(input, ids, { period, end: asOf, from });
  let periodRecord: PeriodChangeRecord | null = null;
  if (change) {
    const [incomeCents, uncategorizedRows] = await Promise.all([incomeInWindow(db, ids, change.from, change.to), uncategorizedRowsInWindow(db, ids, change.from, change.to)]);
    periodRecord = { ...change, incomeCents, uncategorizedRows };
  }

  let totalCents: bigint | null = null;
  const missing: string[] = [];
  const statuses: AggregatePriceStatus[] = [];
  for (const v of valuations) {
    if (v.valueCents === null) missing.push(v.accountId);
    else {
      totalCents = (totalCents ?? 0n) + v.valueCents;
      statuses.push(v.priceStatus);
    }
  }
  return {
    asOf,
    today: q.today,
    expectedDate: input.expectedThrough,
    totalCents,
    partial: missing.length > 0,
    missing,
    priceStatus: worstStatus(statuses),
    dayChange: day,
    periodChange: periodRecord,
    accounts: valuations.map((v, i) => ({
      ...v,
      dayChange: day.accounts[i] ?? { accountId: v.accountId, cents: null, asOf: null, prior: null, reason: "no_value", lines: [] },
      lastReconciliation: fidelities.get(v.accountId)?.lastReconciliation ?? null,
    })),
  };
}

// ---- Series (`GET /api/valuation/series`) ----

export interface ValuationSeriesQueryInput {
  from: IsoDate;
  to: IsoDate;
  today: IsoDate;
  now: Date;
  accountIds?: readonly string[];
  step?: SeriesStep;
}

/** Bigint twin of `ValuationSeriesResponse`. */
export interface ValuationSeriesRecord {
  from: IsoDate;
  to: IsoDate;
  expectedDate: IsoDate;
  dates: IsoDate[];
  accounts: SeriesAccount[];
  portfolio: SeriesPoint[];
}

/** The value-over-time line (prices design §3.8): `from ≤ to ≤ today`, at most `MAX_SERIES_DAYS` days. */
export async function valuationSeries(db: DbOrTx, q: ValuationSeriesQueryInput): Promise<ValuationSeriesRecord> {
  if (q.to < q.from) throw new PlanError(400, "validation", `to ${q.to} is before from ${q.from}`);
  if (q.to > q.today) throw new PlanError(400, "validation", `to ${q.to} is after today ${q.today}`);
  if (dayDiff(q.from, q.to) > MAX_SERIES_DAYS) throw new PlanError(400, "validation", `A series covers at most ${MAX_SERIES_DAYS} days`);
  const ids = await investmentAccountIds(db, q.accountIds);
  const input = await loadValuationInput(db, { accountIds: ids, from: q.from, to: q.to, now: q.now });
  let series;
  try {
    series = valueSeries(input, ids, q.from, q.to, q.step ?? "day");
  } catch (err) {
    if (err instanceof RangeError) throw new PlanError(400, "validation", err.message);
    throw err;
  }
  return {
    from: q.from,
    to: q.to,
    expectedDate: input.expectedThrough,
    dates: series.dates,
    accounts: series.accounts.map((a) => ({ ...a, firstDataDate: input.firstDataDates.get(a.accountId) ?? a.firstDataDate })),
    portfolio: series.portfolio,
  };
}
