import { eq } from "drizzle-orm";
import {
  describeSimplefinError,
  impliedPrice,
  isInvestmentAccountType,
  parseDecimalToCents,
  parseSimplefinHoldings,
  sanitizeText,
  simplefinTransactionDate,
  toIsoDate,
  type AccountType,
  type Fixed8,
  type HoldingsParseResult,
  type IsoDate,
  type SimplefinAccountSet,
} from "@meridian/shared";
import type { Db } from "../index.js";
import { account, householdSetting, type ConnectionError } from "../schema/index.js";
import { upsertSimplefinAccount } from "./accounts.js";
import { PlanError } from "./audit.js";
import { rebuildImpliedPrices, replaceHoldingSnapshot, type SnapshotPosition } from "./holdings.js";
import { ingestTransactions, type IncomingTransaction, type IngestStats } from "./ingest.js";
import { linkUnlinkedInvestmentTxns } from "./investmentTxns.js";
import { loadRules } from "./rules.js";
import { resolveSecurity } from "./securities.js";
import { DEFAULT_TIMEZONE, householdToday } from "./settings.js";
import { pairTransfersInDb } from "./transfers.js";

export interface ApplyAccountSetOptions {
  connectionId: string;
  importLogId?: string;
  accountSet: SimplefinAccountSet;
  /** Start of the requested window. Required unless balancesOnly. */
  windowStart?: IsoDate;
  balancesOnly?: boolean;
  /** The clock (the worker's `ctx.now()`): dates the holdings' `today` check. Default: now. */
  now?: Date;
}

/** Phase 3 (imports design §3.3 step 5): the holdings part of a sync's `import_log.stats`. */
export interface HoldingsStats {
  /** Accounts whose holdings were written (or re-written unchanged). */
  holdingsAccounts: number;
  holdingsPositions: number;
  /** Snapshot rows inserted, changed and removed across the accounts (all 0 on an identical re-sync). */
  holdingsInserted: number;
  holdingsUpdated: number;
  holdingsDeleted: number;
  holdingsRejected: number;
  holdingsUnrecognizedAccounts: number;
  /** Accounts of a non-investment type that carried a holdings container (nothing written). */
  holdingsIgnoredAccounts: number;
  /** Accounts whose csv or manual snapshot for the date outranked the feed's. */
  holdingsSnapshotsKept: number;
  securitiesCreated: number;
  impliedPrices: number;
}

export function emptyHoldingsStats(): HoldingsStats {
  return {
    holdingsAccounts: 0,
    holdingsPositions: 0,
    holdingsInserted: 0,
    holdingsUpdated: 0,
    holdingsDeleted: 0,
    holdingsRejected: 0,
    holdingsUnrecognizedAccounts: 0,
    holdingsIgnoredAccounts: 0,
    holdingsSnapshotsKept: 0,
    securitiesCreated: 0,
    impliedPrices: 0,
  };
}

export function mergeHoldingsStats(into: HoldingsStats, add: Readonly<HoldingsStats>): HoldingsStats {
  for (const key of Object.keys(into) as Array<keyof HoldingsStats>) into[key] += add[key];
  return into;
}

export interface ApplyAccountSetResult {
  accounts: number;
  accountsCreated: number;
  stats: Omit<IngestStats, "insertedIds">;
  transfersPaired: number;
  errors: ConnectionError[];
  /** Phase 3: holdings applied per account from `account.holdings` / `extra`. */
  holdings: HoldingsStats;
  /** Phase 3: unlinked dividend / interest / fee / cash-transfer rows that found their bank twin in this sync. */
  investmentTxnsLinked: number;
  /** Phase 3: synced investment accounts with an income feed on (the worker queues `investments.income_feed` when > 0 after a full sync). */
  incomeFeedAccounts: number;
}

/** Map one SimpleFIN transaction to the ingest shape, sanitizing every text field. */
export function toIncomingTransaction(t: SimplefinAccountSet["accounts"][number]["transactions"][number], now = new Date()): IncomingTransaction {
  const pending = t.pending === true || t.posted === 0;
  const out: IncomingTransaction = {
    externalId: t.id,
    date: simplefinTransactionDate(t, now),
    amountCents: parseDecimalToCents(t.amount),
    description: sanitizeText(t.description, 500),
    pending,
  };
  const payee = sanitizeText(t.payee, 200);
  if (payee) out.payee = payee;
  const memo = sanitizeText(t.memo, 500);
  if (memo) out.memo = memo;
  if (t.posted > 0) out.postedAt = new Date(t.posted * 1000);
  return out;
}

export function errorsFromAccountSet(set: SimplefinAccountSet): ConnectionError[] {
  const out: ConnectionError[] = set.errlist.map((e) => {
    const err: ConnectionError = { code: sanitizeText(e.code, 50), message: describeSimplefinError(e) };
    if (e.account_id) err.accountId = sanitizeText(e.account_id, 100);
    return err;
  });
  for (const s of set.errors) {
    const message = sanitizeText(s, 300);
    if (message && !out.some((e) => e.message === message)) out.push({ code: "error", message });
  }
  return out;
}

// ---- Phase 3: holdings from the feed (imports design §3.3; plan decision 18) ----

export interface ApplySimplefinHoldingsInput {
  accountId: string;
  accountName: string;
  accountType: AccountType;
  /** The Bridge's account id, named in error entries. */
  simplefinAccountId: string;
  parsed: HoldingsParseResult;
  importLogId?: string | null;
  /** The snapshot date must not be after this day (400 `future_date` otherwise). */
  today: IsoDate;
}

export interface ApplySimplefinHoldingsResult {
  /** A snapshot set was written (or re-written unchanged). */
  written: boolean;
  stats: HoldingsStats;
  /** `holdings.unrecognized`, `holdings.partial` or `holdings.parse_error` entries for the connection. */
  errors: ConnectionError[];
  /** Snapshot rows inserted + updated + deleted (0 on an identical re-sync). */
  changed: number;
  snapshotDate: IsoDate | null;
}

interface Aggregate {
  quantities: Array<Fixed8 | null>;
  prices: Array<Fixed8 | null>;
  valueCents: bigint;
  costs: Array<bigint | null>;
}

function holdingsMessage(name: string, parsed: HoldingsParseResult): string {
  const seen = parsed.positions.length + parsed.rejected.length + parsed.skipped.length;
  const keys = parsed.keysSeen.slice(0, 12).join(", ");
  return sanitizeText(`${name}: ${parsed.rejected.length} of ${seen} holding rows could not be read${keys ? ` (keys: ${keys})` : ""}`, 300);
}

/**
 * Write one account's parsed holdings as its `simplefin` snapshot for the feed's as-of date:
 * each position resolved to a security (created with `needs_review` when unknown; the cash
 * key to the cash security), aggregated per security, written through
 * `replaceHoldingSnapshot` (never the balance row: the feed's own balance is already
 * recorded), then the implied prices rebuilt for that date. A csv or manual snapshot for
 * the date outranks the feed (counted as `holdingsSnapshotsKept`), a non-investment account
 * with junk in `extra` is ignored, and an unreadable container is reported per account, so a
 * holdings problem never fails the sync. Runs in its own transaction.
 */
export async function applySimplefinHoldings(db: Db, input: ApplySimplefinHoldingsInput): Promise<ApplySimplefinHoldingsResult> {
  const stats = emptyHoldingsStats();
  const errors: ConnectionError[] = [];
  const done = (written: boolean, changed = 0, snapshotDate: IsoDate | null = null): ApplySimplefinHoldingsResult => ({ written, stats, errors, changed, snapshotDate });
  const { parsed } = input;
  if (parsed.status === "none") return done(false);
  if (!isInvestmentAccountType(input.accountType)) {
    stats.holdingsIgnoredAccounts++;
    return done(false);
  }
  const name = sanitizeText(input.accountName, 100) || "Account";
  if (parsed.status === "unrecognized") {
    stats.holdingsUnrecognizedAccounts++;
    errors.push({ code: "holdings.unrecognized", message: holdingsMessage(name, parsed), accountId: sanitizeText(input.simplefinAccountId, 100) });
    return done(false);
  }
  if (parsed.status === "partial") {
    errors.push({ code: "holdings.partial", message: holdingsMessage(name, parsed), accountId: sanitizeText(input.simplefinAccountId, 100) });
  }
  stats.holdingsRejected += parsed.rejected.length;
  // Only pending or zero rows: nothing to say about the positions.
  if (parsed.positions.length === 0) return done(false);
  const asOf = parsed.asOf;
  if (asOf === null) {
    errors.push({ code: "holdings.parse_error", message: sanitizeText(`${name}: the holdings carry no as-of date`, 300), accountId: sanitizeText(input.simplefinAccountId, 100) });
    return done(false);
  }
  if (asOf > input.today) {
    errors.push({ code: "holdings.parse_error", message: sanitizeText(`${name}: holdings dated ${asOf} are after today (${input.today})`, 300), accountId: sanitizeText(input.simplefinAccountId, 100) });
    return done(false);
  }

  return db.transaction(async (tx) => {
    const aggregated = new Map<string, Aggregate>();
    for (const p of parsed.positions) {
      const resolved = await resolveSecurity(
        tx,
        { ticker: p.ticker, name: p.name, cusip: p.cusip, isin: p.isin, currency: p.currency, hints: p.hints },
        { createIfMissing: true, source: "simplefin" },
      );
      if (resolved.id === null) continue;
      if (resolved.created) stats.securitiesCreated++;
      const agg = aggregated.get(resolved.id) ?? { quantities: [], prices: [], valueCents: 0n, costs: [] };
      agg.quantities.push(p.quantity);
      agg.prices.push(p.price);
      agg.valueCents += p.valueCents;
      agg.costs.push(p.costBasisCents);
      aggregated.set(resolved.id, agg);
    }
    const positions: SnapshotPosition[] = [...aggregated.entries()].map(([securityId, agg]) => {
      const quantity = agg.quantities.every((q) => q !== null) ? agg.quantities.reduce((acc, q) => acc + q!, 0n) : null;
      const agreed = agg.prices.every((pr) => pr !== null && pr === agg.prices[0]) ? agg.prices[0]! : null;
      // The reported price when every row agrees, else the implied one (null for dollar-only or zero quantities).
      const price = agreed ?? (quantity !== null && quantity !== 0n ? impliedPrice(agg.valueCents, quantity) : null);
      const reportedCostBasisCents = agg.costs.every((c) => c !== null) ? agg.costs.reduce((acc, c) => acc + c!, 0n) : null;
      return { securityId, quantity, price, valueCents: agg.valueCents, reportedCostBasisCents };
    });

    let replaced;
    try {
      replaced = await replaceHoldingSnapshot(tx, {
        accountId: input.accountId,
        date: asOf,
        source: "simplefin",
        importLogId: input.importLogId ?? null,
        positions,
        setBalance: false,
        today: input.today,
      });
    } catch (err) {
      if (err instanceof PlanError && err.code === "snapshot_precedence") {
        stats.holdingsSnapshotsKept++;
        return done(false, 0, asOf);
      }
      throw err;
    }
    const implied = await rebuildImpliedPrices(tx, { securityIds: replaced.securityIds, dates: [asOf] });
    stats.holdingsAccounts++;
    stats.holdingsPositions += positions.length;
    stats.holdingsInserted += replaced.inserted;
    stats.holdingsUpdated += replaced.updated;
    stats.holdingsDeleted += replaced.deleted;
    stats.impliedPrices += implied.written;
    return done(true, replaced.inserted + replaced.updated + replaced.deleted, asOf);
  });
}

/**
 * The day a feed's holdings may not be dated after: the later of the household's day and the
 * UTC day (the Bridge dates in UTC). Read without `getHouseholdSetting`, which would create the
 * singleton before the first sync's transactions fix `plan_start_month`.
 */
async function syncToday(db: Db, now: Date): Promise<IsoDate> {
  const [row] = await db.select({ timezone: householdSetting.timezone }).from(householdSetting).where(eq(householdSetting.id, 1));
  const household = householdToday(row ?? { timezone: DEFAULT_TIMEZONE }, now);
  const utc = toIsoDate(now);
  return household > utc ? household : utc;
}

/**
 * Persist a parsed Account Set: accounts, balances, holdings (Phase 3, per account in its own
 * transaction so one bad container never fails the sync), transactions, transfers, then the
 * links from unlinked investment rows to the bank rows this sync delivered.
 */
export async function applyAccountSet(db: Db, options: ApplyAccountSetOptions): Promise<ApplyAccountSetResult> {
  const rules = await loadRules(db);
  const totals: ApplyAccountSetResult["stats"] = { created: 0, updated: 0, replacedPending: 0, removedPending: 0, skipped: 0 };
  const holdings = emptyHoldingsStats();
  const holdingErrors: ConnectionError[] = [];
  const investmentAccountIds: string[] = [];
  let incomeFeedAccounts = 0;
  let accountsCreated = 0;
  let earliest: IsoDate | undefined;
  const now = options.now ?? new Date();
  const today = await syncToday(db, now);

  for (const sf of options.accountSet.accounts) {
    const { id: accountId, created } = await db.transaction((tx) => upsertSimplefinAccount(tx, options.connectionId, sf));
    if (created) accountsCreated++;
    const [row] = await db
      .select({ name: account.name, type: account.type, investmentIncomeFeed: account.investmentIncomeFeed })
      .from(account)
      .where(eq(account.id, accountId));
    const accountName = row?.name ?? (sanitizeText(sf.name, 100) || "Account");
    const accountType: AccountType = row?.type ?? "checking";
    if (row && isInvestmentAccountType(row.type)) {
      investmentAccountIds.push(accountId);
      if (row.investmentIncomeFeed !== "off") incomeFeedAccounts++;
    }

    // Holdings: for full and balances-only syncs alike, never fatal for the sync or for another account.
    try {
      const parsed = parseSimplefinHoldings(sf);
      const applied = await applySimplefinHoldings(db, {
        accountId,
        accountName,
        accountType,
        simplefinAccountId: sf.id,
        parsed,
        importLogId: options.importLogId ?? null,
        today,
      });
      mergeHoldingsStats(holdings, applied.stats);
      holdingErrors.push(...applied.errors);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      holdingErrors.push({ code: "holdings.parse_error", message: sanitizeText(`${accountName}: ${message}`, 300), accountId: sanitizeText(sf.id, 100) });
    }

    if (options.balancesOnly) continue;
    const incoming = sf.transactions.map((t) => toIncomingTransaction(t, now));
    for (const t of incoming) if (!earliest || t.date < earliest) earliest = t.date;
    const ingestOptions: Parameters<typeof ingestTransactions>[2] = { accountId, source: "simplefin", rules };
    if (options.importLogId) ingestOptions.importLogId = options.importLogId;
    if (options.windowStart) ingestOptions.windowStart = options.windowStart;
    const stats = await ingestTransactions(db, incoming, ingestOptions);
    totals.created += stats.created;
    totals.updated += stats.updated;
    totals.replacedPending += stats.replacedPending;
    totals.removedPending += stats.removedPending;
    totals.skipped += stats.skipped;
  }

  let transfersPaired = 0;
  if (!options.balancesOnly && (totals.created > 0 || totals.replacedPending > 0)) {
    const since = options.windowStart && earliest ? (earliest < options.windowStart ? earliest : options.windowStart) : earliest;
    transfersPaired = await db.transaction((tx) => pairTransfersInDb(tx, since ? { since } : {}));
  }

  // The bank side of dividends, interest, fees and cash transfers entered from a trade file or by hand (plan decision 18).
  let investmentTxnsLinked = 0;
  if (!options.balancesOnly && investmentAccountIds.length > 0) {
    investmentTxnsLinked = await db.transaction((tx) => linkUnlinkedInvestmentTxns(tx, { accountIds: investmentAccountIds }));
  }

  return {
    accounts: options.accountSet.accounts.length,
    accountsCreated,
    stats: totals,
    transfersPaired,
    errors: [...errorsFromAccountSet(options.accountSet), ...holdingErrors],
    holdings,
    investmentTxnsLinked,
    incomeFeedAccounts,
  };
}
