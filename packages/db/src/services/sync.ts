import {
  describeSimplefinError,
  parseDecimalToCents,
  sanitizeText,
  simplefinTransactionDate,
  type IsoDate,
  type SimplefinAccountSet,
} from "@meridian/shared";
import type { Db } from "../index.js";
import type { ConnectionError } from "../schema/index.js";
import { upsertSimplefinAccount } from "./accounts.js";
import { ingestTransactions, type IncomingTransaction, type IngestStats } from "./ingest.js";
import { loadRules } from "./rules.js";
import { pairTransfersInDb } from "./transfers.js";

export interface ApplyAccountSetOptions {
  connectionId: string;
  importLogId?: string;
  accountSet: SimplefinAccountSet;
  /** Start of the requested window. Required unless balancesOnly. */
  windowStart?: IsoDate;
  balancesOnly?: boolean;
}

export interface ApplyAccountSetResult {
  accounts: number;
  accountsCreated: number;
  stats: Omit<IngestStats, "insertedIds">;
  transfersPaired: number;
  errors: ConnectionError[];
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

/** Persist a parsed Account Set: accounts, balances, transactions, transfers. */
export async function applyAccountSet(db: Db, options: ApplyAccountSetOptions): Promise<ApplyAccountSetResult> {
  const rules = await loadRules(db);
  const totals: ApplyAccountSetResult["stats"] = { created: 0, updated: 0, replacedPending: 0, removedPending: 0, skipped: 0 };
  let accountsCreated = 0;
  let earliest: IsoDate | undefined;

  for (const sf of options.accountSet.accounts) {
    const { id: accountId, created } = await db.transaction((tx) => upsertSimplefinAccount(tx, options.connectionId, sf));
    if (created) accountsCreated++;
    if (options.balancesOnly) continue;
    const incoming = sf.transactions.map((t) => toIncomingTransaction(t));
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

  return {
    accounts: options.accountSet.accounts.length,
    accountsCreated,
    stats: totals,
    transfersPaired,
    errors: errorsFromAccountSet(options.accountSet),
  };
}
