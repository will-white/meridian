import { and, eq } from "drizzle-orm";
import {
  describeSimplefinError,
  impliedPrice,
  isInvestmentAccountType,
  parseSimplefinAmount,
  parseSimplefinHoldings,
  sanitizeText,
  simplefinFeedHealth,
  simplefinTransactionDate,
  toIsoDate,
  unixToIsoDate,
  type AccountType,
  type Fixed8,
  type HoldingsParseResult,
  type IsoDate,
  type SimplefinAccountSet,
  type SimplefinReadProblem,
} from "@meridian/shared";
import type { Db } from "../index.js";
import { account, type ConnectionError } from "../schema/index.js";
import { upsertSimplefinAccount } from "./accounts.js";
import { PlanError } from "./audit.js";
import { errorMessageOf } from "./driverError.js";
import { rebuildImpliedPrices, replaceHoldingSnapshot, type SnapshotPosition } from "./holdings.js";
import { ingestTransactions, type IncomingTransaction, type IngestStats } from "./ingest.js";
import { linkUnlinkedInvestmentTxns } from "./investmentTxns.js";
import { loadRules } from "./rules.js";
import { resolveSecurity } from "./securities.js";
import { readHouseholdToday } from "./settings.js";
import { pairTransfersInDb } from "./transfers.js";

export interface ApplyAccountSetOptions {
  connectionId: string;
  importLogId?: string;
  accountSet: SimplefinAccountSet;
  /** Start of the requested window. Required unless balancesOnly. */
  windowStart?: IsoDate;
  balancesOnly?: boolean;
  /** The clock (the worker's `ctx.now()`): the household's day for a pending item without a date, and the holdings' `today` check. Default: now. */
  now?: Date;
  /**
   * What `readSimplefinAccountSet` skipped (audit a4-sync-parse-03). Reported with the
   * connection's entries; an account it skipped makes the response incomplete (unless the
   * household closed it), and an account some of whose transactions it skipped keeps its
   * unmatched pending rows. An `errlist` it could not read (second round) makes the response
   * incomplete and keeps every account's unmatched pending rows, as a connection problem does.
   */
  readProblems?: readonly SimplefinReadProblem[];
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
  /**
   * Accounts the feed names that were found without a connection (left behind when the
   * household removed one) and attached to this one instead of created again (audit
   * a5-ingest-transfers-02). They appear on this connection for the first time, as created ones do.
   */
  accountsReattached: number;
  stats: Omit<IngestStats, "insertedIds" | "earliestReleased">;
  transfersPaired: number;
  errors: ConnectionError[];
  /** Phase 3: holdings applied per account from `account.holdings` / `extra`. */
  holdings: HoldingsStats;
  /** Phase 3: unlinked dividend / interest / fee / cash-transfer rows that found their bank twin in this sync. */
  investmentTxnsLinked: number;
  /** Phase 3: synced investment accounts with an income feed on (the worker queues `investments.income_feed` when > 0 after a full sync). */
  incomeFeedAccounts: number;
  /**
   * The Bridge reported a connection or account problem (`simplefinFeedHealth`), its problem
   * report could not be read, or an open account could not be read at all: the data of the
   * accounts it covers may be stale or partial. Their pending rows were kept, and the connection's high-water mark must not move.
   * Problems with accounts the household closed are left out.
   */
  incomplete: boolean;
  /** The balance date of every account in the response the household has not closed: how fresh the Bridge's copy of each is. */
  balanceDates: IsoDate[];
}

/**
 * Map one SimpleFIN transaction to the ingest shape, sanitizing every text field. The amount
 * is read by the caller (`parseSimplefinAmount`), so that one it cannot read skips only this
 * transaction; `fallbackDate` is the household's day, for a pending item without a date (marked
 * `undated`, so a row already stored keeps the day it was first seen).
 */
export function toIncomingTransaction(t: SimplefinAccountSet["accounts"][number]["transactions"][number], amountCents: bigint, fallbackDate: IsoDate): IncomingTransaction {
  const pending = t.pending === true || t.posted === 0;
  const out: IncomingTransaction = {
    externalId: t.id,
    date: simplefinTransactionDate(t, fallbackDate),
    amountCents,
    description: sanitizeText(t.description, 500),
    pending,
  };
  // No date of its own: the household's day dates a new row, and a stored row keeps the day it was first seen (a10-conformance-ledger-05).
  if (!(t.transacted_at && t.transacted_at > 0) && !(t.posted && t.posted > 0)) out.undated = true;
  const payee = sanitizeText(t.payee, 200);
  if (payee) out.payee = payee;
  const memo = sanitizeText(t.memo, 500);
  if (memo) out.memo = memo;
  if (t.posted > 0) out.postedAt = new Date(t.posted * 1000);
  return out;
}

/**
 * The connection's entries for a response: each `errlist` entry, described, then each plain
 * string in `errors` that does not repeat one (a Bridge may send the same text in both).
 * An entry about one account (`act.*`) names it as the household knows it (audit
 * a8-ledger-ui-11): `accountName` gives the local name for the Bridge's account id, and the
 * message starts with it, as the sync's own per-account entries do. An id the app has no
 * account for is said as the Bridge's id. The page shows the message; the id stays in
 * `accountId` for the code that reads it.
 */
export function errorsFromAccountSet(set: SimplefinAccountSet, accountName: (bridgeAccountId: string) => string | undefined = () => undefined): ConnectionError[] {
  const out: ConnectionError[] = set.errlist.map((e) => {
    const described = describeSimplefinError(e);
    if (!e.account_id) return { code: sanitizeText(e.code, 50), message: described };
    const id = sanitizeText(e.account_id, 100);
    const name = sanitizeText(accountName(e.account_id), 100);
    return { code: sanitizeText(e.code, 50), message: name ? `${name}: ${described}` : `${described} (Bridge account ${id})`, accountId: id };
  });
  const said = new Set([...set.errlist.map((e) => sanitizeText(e.msg, 300)), ...out.map((e) => e.message)]);
  for (const s of set.errors) {
    const message = sanitizeText(s, 300);
    if (message && !said.has(message)) {
      said.add(message);
      out.push({ code: "error", message });
    }
  }
  return out;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

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

/** The later of two days: a feed's holdings may be dated up to the household's day or the UTC day (the Bridge dates in UTC), whichever is later. */
const laterDay = (a: IsoDate, b: IsoDate): IsoDate => (a > b ? a : b);

/**
 * Persist a parsed Account Set: accounts, balances, holdings (Phase 3, per account in its own
 * transaction so one bad container never fails the sync), transactions, transfers, then the
 * links from unlinked investment rows to the bank rows this sync delivered.
 *
 * An account covered by an `errlist` problem (the Bridge could not read it, read part of it,
 * or its bank needs re-authentication) is applied like any other, except that its list is
 * not taken as complete: pending rows missing from it stay.
 *
 * One odd value costs only itself (audit a4-sync-parse-01): a transaction whose amount cannot
 * be read is skipped, a balance that cannot be read keeps the last known one, and each is
 * reported for its account, as are amounts rounded to the cent. An account the household
 * closed gets its balance and holdings but no transactions (a4-sync-parse-09): it no longer
 * needs them.
 */
export async function applyAccountSet(db: Db, options: ApplyAccountSetOptions): Promise<ApplyAccountSetResult> {
  const rules = await loadRules(db);
  const totals: ApplyAccountSetResult["stats"] = { created: 0, updated: 0, replacedPending: 0, removedPending: 0, skipped: 0, duplicates: 0, releasedTransfers: 0 };
  const holdings = emptyHoldingsStats();
  const holdingErrors: ConnectionError[] = [];
  const investmentAccountIds: string[] = [];
  let incomeFeedAccounts = 0;
  let accountsCreated = 0;
  let accountsReattached = 0;
  let earliest: IsoDate | undefined;
  const now = options.now ?? new Date();
  const householdDay = await readHouseholdToday(db, now);
  const today = laterDay(householdDay, toIsoDate(now));
  const closedIds = (
    await db
      .select({ externalId: account.externalId })
      .from(account)
      .where(and(eq(account.connectionId, options.connectionId), eq(account.closed, true)))
  ).flatMap((r) => (r.externalId ? [r.externalId] : []));
  const health = simplefinFeedHealth(options.accountSet.errlist, { closedAccountIds: closedIds });
  const closedLabels = new Set(closedIds.map((id) => sanitizeText(id, 100)));
  const readProblems = options.readProblems ?? [];
  // An open account the reader could not read sent none of its transactions: the same hole as act.failed.
  const unreadableAccount = readProblems.some((p) => p.code === "account.unreadable" && !(p.accountId !== undefined && closedLabels.has(p.accountId)));
  // A problem report that could not be read may cover any account: as a con.* problem would (a4-sync-parse-03, second round).
  const unreadableErrlist = readProblems.some((p) => p.code === "errlist.unreadable");
  const partlyRead = new Set(readProblems.flatMap((p) => (p.code === "transaction.unreadable" && p.accountId !== undefined ? [p.accountId] : [])));
  const feedErrors: ConnectionError[] = [];
  const balanceDates: IsoDate[] = [];

  for (const sf of options.accountSet.accounts) {
    const upserted = await db.transaction((tx) => upsertSimplefinAccount(tx, options.connectionId, sf));
    const { id: accountId, created } = upserted;
    if (created) accountsCreated++;
    if (upserted.reattached) accountsReattached++;
    const [row] = await db
      .select({ name: account.name, type: account.type, closed: account.closed, investmentIncomeFeed: account.investmentIncomeFeed })
      .from(account)
      .where(eq(account.id, accountId));
    if (!row?.closed) balanceDates.push(unixToIsoDate(sf["balance-date"]));
    const accountName = row?.name ?? (sanitizeText(sf.name, 100) || "Account");
    const label = sanitizeText(accountName, 100) || "Account";
    const accountLabel = sanitizeText(sf.id, 100);
    let rounded = upserted.rounded;
    if (upserted.balanceUnreadable) {
      feedErrors.push({ code: "balance.unreadable", message: `${label}: the balance from the Bridge could not be read, so it was not changed`, accountId: accountLabel });
    } else if (upserted.availableUnreadable) {
      feedErrors.push({ code: "balance.unreadable", message: `${label}: the available balance from the Bridge could not be read, so it was not changed`, accountId: accountLabel });
    }
    const reportRounded = () => {
      if (rounded > 0) {
        feedErrors.push({
          code: "amount.rounded",
          message: `${label}: ${rounded} ${plural(rounded, "amount", "amounts")} had digits below a cent and ${plural(rounded, "was", "were")} rounded to the cent`,
          accountId: accountLabel,
        });
      }
    };
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
      const message = errorMessageOf(err);
      holdingErrors.push({ code: "holdings.parse_error", message: sanitizeText(`${accountName}: ${message}`, 300), accountId: sanitizeText(sf.id, 100) });
    }

    if (options.balancesOnly || row?.closed) {
      reportRounded();
      continue;
    }
    const incoming: IncomingTransaction[] = [];
    let unreadable = 0;
    for (const t of sf.transactions) {
      const amount = parseSimplefinAmount(t.amount);
      if (!amount) {
        unreadable++;
        continue;
      }
      if (amount.rounded) rounded++;
      incoming.push(toIncomingTransaction(t, amount.cents, householdDay));
    }
    if (unreadable > 0) {
      feedErrors.push({
        code: "amount.unreadable",
        message: `${label}: ${unreadable} ${plural(unreadable, "transaction was", "transactions were")} skipped because ${plural(unreadable, "its amount", "their amounts")} could not be read`,
        accountId: accountLabel,
      });
    }
    reportRounded();
    for (const t of incoming) if (!earliest || t.date < earliest) earliest = t.date;
    const ingestOptions: Parameters<typeof ingestTransactions>[2] = { accountId, source: "simplefin", rules };
    if (options.importLogId) ingestOptions.importLogId = options.importLogId;
    if (options.windowStart) ingestOptions.windowStart = options.windowStart;
    // A list with a transaction left out is not the whole list: a pending row missing from it may be that one.
    if (health.affects(sf) || unreadableErrlist || unreadable > 0 || partlyRead.has(accountLabel)) ingestOptions.keepUnmatchedPending = true;
    const stats = await ingestTransactions(db, incoming, ingestOptions);
    totals.created += stats.created;
    totals.updated += stats.updated;
    totals.replacedPending += stats.replacedPending;
    totals.removedPending += stats.removedPending;
    totals.skipped += stats.skipped;
    totals.duplicates += stats.duplicates;
    totals.releasedTransfers += stats.releasedTransfers;
    // A partner released from a removed pending leg may pair with the leg that replaces it (a5-ingest-transfers-05).
    if (stats.earliestReleased && (!earliest || stats.earliestReleased < earliest)) earliest = stats.earliestReleased;
  }

  let transfersPaired = 0;
  // The household's names for the connection's accounts, by the Bridge's id: an act.* entry names its account (audit a8-ledger-ui-11).
  const accountNames = new Map(
    (await db.select({ externalId: account.externalId, name: account.name }).from(account).where(eq(account.connectionId, options.connectionId))).flatMap((a) =>
      a.externalId ? [[a.externalId, a.name] as const] : [],
    ),
  );
  if (!options.balancesOnly && (totals.created > 0 || totals.replacedPending > 0 || totals.releasedTransfers > 0)) {
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
    accountsReattached,
    stats: totals,
    transfersPaired,
    errors: [...errorsFromAccountSet(options.accountSet, (id) => accountNames.get(id)), ...readProblems.map((p) => ({ ...p })), ...feedErrors, ...holdingErrors],
    holdings,
    investmentTxnsLinked,
    incomeFeedAccounts,
    incomplete: health.incomplete || unreadableAccount || unreadableErrlist,
    balanceDates,
  };
}

export interface ReplayAccountSetResult {
  accounts: number;
  /** Feed accounts in the payload with no open account on the connection. */
  accountsUnknown: number;
  stats: Omit<IngestStats, "insertedIds" | "earliestReleased">;
  transfersPaired: number;
}

/**
 * Audit a5-ingest-transfers-13: replay one stored payload's transactions (`import_log.raw_payload`
 * of a sync) after a reader or ingest fix, including items older than the Bridge's 93-day window
 * that a full resync cannot reach. Replay mode (`ingestTransactions` with `replay`): posted
 * items the ledger lacks are inserted (or recognized as rows it has under another id, or as
 * rows the household deleted); a known row is left as it is, because the live feed keeps its
 * bank-owned fields current; pending items are never inserted and no pending row is replaced or
 * removed, because an old payload is not the feed's current view. Accounts, balances and
 * holdings are not touched (holdings have their own replay). Running it twice changes nothing.
 */
export async function replayAccountSetTransactions(db: Db, options: { connectionId: string; accountSet: SimplefinAccountSet; importLogId?: string; now?: Date }): Promise<ReplayAccountSetResult> {
  const rules = await loadRules(db);
  const householdDay = await readHouseholdToday(db, options.now ?? new Date());
  const totals: ReplayAccountSetResult["stats"] = { created: 0, updated: 0, replacedPending: 0, removedPending: 0, skipped: 0, duplicates: 0, releasedTransfers: 0 };
  const accounts = await db
    .select({ id: account.id, externalId: account.externalId, type: account.type, closed: account.closed })
    .from(account)
    .where(eq(account.connectionId, options.connectionId));
  const byExternalId = new Map(accounts.filter((a) => a.externalId !== null && !a.closed).map((a) => [a.externalId!, a]));
  let accountsUnknown = 0;
  let earliest: IsoDate | undefined;
  for (const sf of options.accountSet.accounts) {
    const acct = byExternalId.get(sf.id);
    if (!acct) {
      accountsUnknown++;
      continue;
    }
    const incoming: IncomingTransaction[] = [];
    for (const t of sf.transactions) {
      const amount = parseSimplefinAmount(t.amount);
      if (!amount) continue;
      const item = toIncomingTransaction(t, amount.cents, householdDay);
      if (item.pending) continue;
      incoming.push(item);
      if (!earliest || item.date < earliest) earliest = item.date;
    }
    const stats = await ingestTransactions(db, incoming, { accountId: acct.id, accountType: acct.type, source: "simplefin", rules, replay: true, ...(options.importLogId ? { importLogId: options.importLogId } : {}) });
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += stats[key];
  }
  const transfersPaired = totals.created > 0 && earliest ? await db.transaction((tx) => pairTransfersInDb(tx, { since: earliest! })) : 0;
  return { accounts: options.accountSet.accounts.length, accountsUnknown, stats: totals, transfersPaired };
}
