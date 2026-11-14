import { and, eq, gte, inArray, lte } from "drizzle-orm";
import {
  addDays,
  classifyInvestmentInflow,
  csvIdScheme,
  evaluateRules,
  matchPendingToPosted,
  normalizePayee,
  STRONG_SIMILARITY,
  type AccountType,
  type CsvIdScheme,
  type IsoDate,
  type PendingRow,
  type PostedIncoming,
  type RuleLike,
} from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { account, transaction, transactionAlias } from "../schema/index.js";
import { PayeeCache } from "./payees.js";
import { addTransactionTags } from "./tags.js";
import { lockLedger } from "./ledgerLock.js";
import { applyRulesToRow } from "./rules.js";
import { dropSplitsAfterAmountChange } from "./transactions.js";
import { releaseTransferPairs, releaseTransferPartners } from "./transfers.js";

export interface IncomingTransaction {
  externalId: string;
  date: IsoDate;
  amountCents: bigint;
  description: string;
  payee?: string;
  memo?: string;
  pending: boolean;
  postedAt?: Date;
  /**
   * The feed gave the item no date (a pending item with neither `transacted_at` nor `posted`):
   * `date` is the household's day it was read (plan decision 33). A row already stored keeps
   * its date, the day the item was first seen, so a hold pending for weeks is not moved to each
   * sync's day (audit a10-conformance-ledger-05).
   */
  undated?: boolean;
}

export interface IngestOptions {
  accountId: string;
  source: "simplefin" | "csv";
  importLogId?: string;
  /**
   * Start of the fetched window (SimpleFIN). Local pending rows the feed no longer returns and
   * that did not post are deleted, whatever their date (audit a5-ingest-transfers-03: the
   * feed's pending list is not bounded by the window). Posted feed rows dated in the window
   * that the feed no longer lists by id are the candidates for a re-keyed account (decision
   * 43). CSV imports leave this unset: a file is never a complete view of pending items.
   */
  windowStart?: IsoDate;
  /**
   * The feed's list for this account is known to be incomplete (the Bridge reported a problem
   * with the account or its bank connection): a pending row it does not return has not
   * vanished, so none is deleted. A posted item still replaces its pending row in place.
   */
  keepUnmatchedPending?: boolean;
  rules: readonly RuleLike[];
  /**
   * Phase 3: the account's type, for the contribution classifier (an inflow into an
   * investment-type account that reads like a contribution is an unpaired transfer).
   * Looked up once from the account row when the caller does not pass it.
   */
  accountType?: AccountType;
  /**
   * Replaying a stored payload (audit a5-ingest-transfers-13): posted items are upserted by id
   * (or found as duplicates) and inserted when the ledger lacks them; pending items are never
   * inserted, no pending row is replaced or removed, and no re-keyed row is looked for, because
   * an old payload is not the feed's current view.
   */
  replay?: boolean;
}

export interface IngestStats {
  created: number;
  updated: number;
  replacedPending: number;
  removedPending: number;
  skipped: number;
  /**
   * Items the ledger already had under another id (audit a5-ingest-transfers-01, -02, -11): a
   * CSV row the feed or the household had, a feed item that took over a CSV or manual row or a
   * row the feed re-keyed, a pending copy of a posted row, or an id the household deleted.
   */
  duplicates: number;
  /** Transfer partners of removed or re-amounted rows, released so that they can pair again (a5-ingest-transfers-05). */
  releasedTransfers: number;
  insertedIds: string[];
  /** The earliest date of a released partner: the pairing pass after the ingest covers it. */
  earliestReleased?: IsoDate;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The days around an item within which another row can be the same purchase (decision 42). */
export const DUPLICATE_MAX_DAYS = 5;

type TxnRow = typeof transaction.$inferSelect;

const asCandidate = (r: TxnRow): PendingRow => ({ id: r.id, amountCents: r.amountCents, date: r.date, description: r.rawDescription });
const asIncoming = (i: IncomingTransaction): PostedIncoming => ({ externalId: i.externalId, amountCents: i.amountCents, date: i.date, description: i.description });

/**
 * The rows of an account that are the same purchases as `items` from another source (decision
 * 42): equal amount, dates at most `DUPLICATE_MAX_DAYS` apart, descriptions that share something
 * (best similarity, then the closest date; each row once). Returns item external id -> row.
 *
 * - Items from a CSV file match rows from the feed (pending or posted) or entered by hand that
 *   no CSV id of the item's id scheme points at yet (`csvIdScheme`). Audit
 *   a10-conformance-ledger-02: within one scheme the ids decide (two equal coffees of one file
 *   are two rows), but the same file read with another id column, or rows stored under the ids
 *   the payee normalizer used to shape, carry ids of another scheme, so across schemes the
 *   content decides. In order: a CSV row of another scheme with the same date, amount and
 *   description (similarity at least `STRONG_SIMILARITY`); a feed or manual row no CSV id points
 *   at; a feed or manual row only ids of another scheme point at.
 * - Items from the feed match CSV and manual rows that no feed id points at yet; a pending item
 *   only a posted row. `rekeyed` adds the account's posted feed rows that the feed stopped
 *   listing by id (a re-keyed account).
 */
export async function findSameTransactions(
  tx: DbOrTx,
  accountId: string,
  source: "simplefin" | "csv",
  items: readonly IncomingTransaction[],
  options: { exclude?: ReadonlySet<string>; rekeyed?: readonly TxnRow[] } = {},
): Promise<Map<string, TxnRow>> {
  const out = new Map<string, TxnRow>();
  if (items.length === 0) return out;
  const dates = items.map((i) => i.date).sort();
  const from = addDays(dates[0]!, -DUPLICATE_MAX_DAYS);
  const to = addDays(dates[dates.length - 1]!, DUPLICATE_MAX_DAYS);
  const amounts = [...new Set(items.map((i) => i.amountCents))];
  const otherSources = source === "csv" ? (["simplefin", "manual", "csv"] as const) : (["csv", "manual"] as const);
  const rows: TxnRow[] = [];
  for (let i = 0; i < amounts.length; i += 500) {
    rows.push(
      ...(await tx
        .select()
        .from(transaction)
        .where(
          and(
            eq(transaction.accountId, accountId),
            inArray(transaction.source, [...otherSources]),
            inArray(transaction.amountCents, amounts.slice(i, i + 500)),
            gte(transaction.date, from),
            lte(transaction.date, to),
          ),
        )),
    );
  }
  // The ids of this source that already point at each row: that id's purchase, not this one's (for a CSV file, per id scheme).
  const pointing = new Map<string, string[]>();
  if (rows.length > 0) {
    for (let i = 0; i < rows.length; i += 500) {
      const ids = rows.slice(i, i + 500).map((r) => r.id);
      const aliases = await tx
        .select({ transactionId: transactionAlias.transactionId, externalId: transactionAlias.externalId })
        .from(transactionAlias)
        .where(and(inArray(transactionAlias.transactionId, ids), eq(transactionAlias.source, source)));
      for (const a of aliases) if (a.transactionId) pointing.set(a.transactionId, [...(pointing.get(a.transactionId) ?? []), a.externalId]);
    }
  }
  const exclude = options.exclude ?? new Set<string>();
  const open = rows.filter((r) => !exclude.has(r.id));
  if (source === "csv") {
    const used = new Set<string>();
    const schemesOf = (r: TxnRow): Set<CsvIdScheme> => {
      const ids = [...(pointing.get(r.id) ?? []), ...(r.source === "csv" && r.externalId ? [r.externalId] : [])];
      return new Set(ids.map((id) => csvIdScheme(id) ?? "csv"));
    };
    const byScheme = new Map<CsvIdScheme, IncomingTransaction[]>();
    for (const item of items) {
      const scheme = csvIdScheme(item.externalId) ?? "csv2";
      byScheme.set(scheme, [...(byScheme.get(scheme) ?? []), item]);
    }
    for (const [scheme, group] of byScheme) {
      let left = group;
      const take = (candidates: TxnRow[], match: Parameters<typeof matchPendingToPosted>[2]) => {
        if (left.length === 0 || candidates.length === 0) return;
        for (const [ext, id] of matchPendingToPosted(candidates.map(asCandidate), left.map(asIncoming), match)) {
          out.set(ext, candidates.find((r) => r.id === id)!);
          used.add(id);
        }
        left = left.filter((i) => !out.has(i.externalId));
      };
      const free = () => open.filter((r) => !used.has(r.id));
      // The same file under another id scheme: one of its rows, the same day, amount and description.
      take(
        free().filter((r) => r.source === "csv" && !schemesOf(r).has(scheme)),
        { changedAmounts: false, maxDays: 0, minSimilarity: STRONG_SIMILARITY },
      );
      // A feed or manual row no file has named yet (decision 42).
      take(
        free().filter((r) => r.source !== "csv" && schemesOf(r).size === 0),
        { changedAmounts: false, maxDays: DUPLICATE_MAX_DAYS },
      );
      // A feed or manual row only another id scheme named: the same file's purchase, read before under another id.
      take(
        free().filter((r) => r.source !== "csv" && schemesOf(r).size > 0 && !schemesOf(r).has(scheme)),
        { changedAmounts: false, maxDays: DUPLICATE_MAX_DAYS },
      );
    }
    return out;
  }
  const claimed = new Set(pointing.keys());
  // A feed id pointing at a CSV or manual row is a pending copy (a posted item takes the row over), so the posted form may still take it.
  const postedItems = items.filter((i) => !i.pending);
  const postedCandidates = [...open, ...(options.rekeyed ?? []).filter((r) => !exclude.has(r.id))];
  const used = new Set<string>();
  for (const [ext, id] of matchPendingToPosted(postedCandidates.map(asCandidate), postedItems.map(asIncoming), { changedAmounts: false, maxDays: DUPLICATE_MAX_DAYS })) {
    out.set(ext, postedCandidates.find((r) => r.id === id)!);
    used.add(id);
  }
  // The feed may still list a purchase as pending that the bank's CSV already shows posted.
  const pendingItems = items.filter((i) => i.pending);
  const left = open.filter((r) => !used.has(r.id) && !claimed.has(r.id) && !r.pending);
  for (const [ext, id] of matchPendingToPosted(left.map(asCandidate), pendingItems.map(asIncoming), { changedAmounts: false, maxDays: DUPLICATE_MAX_DAYS })) {
    out.set(ext, left.find((r) => r.id === id)!);
  }
  return out;
}

/**
 * Upsert a batch of bank transactions for one account.
 *
 * - Dedupe key is (account, external id). Known rows get their bank-owned fields refreshed. An
 *   id kept in `transaction_alias` (a copy of another row, or a row the household deleted) is
 *   counted as a duplicate and left alone.
 * - Feed only: a posted item with a new id replaces a matching local pending row in place (same
 *   row id, user edits kept): any pending row of the account the feed no longer lists, by equal
 *   amount (or a changed one for a tip or a settled hold, `matchPendingToPosted`), then a
 *   pending row the feed still lists next to its posted form, whose pending id is then ignored.
 * - An item that is the same purchase as a row from another source (`findSameTransactions`) is
 *   not inserted: a CSV item's id points at that row; a posted feed item takes the row over
 *   (its id, source and bank-owned fields; the household's edits stay; the old id points at
 *   the row); a pending feed item's id points at the posted row.
 * - New rows get a normalized payee, resolved through aliases, the rules (evaluated against the
 *   resolved payee), and the payee's default category.
 * - Phase 3 (plan decision 15): after the rules, when no rule set a transfer or a category,
 *   an inflow into an investment-type account that reads like a contribution is inserted
 *   with `is_transfer = true` and no category (`classifyInvestmentInflow`); cross-account
 *   pairing may still pair it later.
 * - Pending rows the feed stopped returning are removed (SimpleFIN only, and only when the
 *   feed's list for the account is complete: `keepUnmatchedPending`), after their transfer
 *   partners are released.
 *
 * Takes a db or a transaction handle (a nested call becomes a savepoint), so the trades
 * importer can write the cash rows of a file inside its own transaction.
 */
export async function ingestTransactions(db: DbOrTx, incoming: readonly IncomingTransaction[], options: IngestOptions): Promise<IngestStats> {
  const stats: IngestStats = { created: 0, updated: 0, replacedPending: 0, removedPending: 0, skipped: 0, duplicates: 0, releasedTransfers: 0, insertedIds: [] };
  let accountType = options.accountType;
  if (accountType === undefined) {
    const [row] = await db.select({ type: account.type }).from(account).where(eq(account.id, options.accountId));
    if (!row) throw new Error(`Account ${options.accountId} not found`);
    accountType = row.type;
  }
  const resolvedAccountType = accountType;
  const feed = options.source === "simplefin";

  // Last occurrence wins when a feed repeats an id inside one payload.
  const byId = new Map<string, IncomingTransaction>();
  for (const item of incoming) {
    if (byId.has(item.externalId)) stats.skipped++;
    byId.set(item.externalId, item);
  }
  const items = [...byId.values()];
  const incomingIds = items.map((i) => i.externalId);
  const noteReleased = (released: ReadonlyArray<{ date: IsoDate }>) => {
    stats.releasedTransfers += released.length;
    for (const r of released) if (!stats.earliestReleased || r.date < stats.earliestReleased) stats.earliestReleased = r.date;
  };

  await db.transaction(async (tx) => {
    // One ingest at a time (a10-conformance-ledger-01): a CSV commit and a sync of the same days must each see the other's rows.
    await lockLedger(tx);
    const payees = new PayeeCache(tx);
    const existing = new Map<string, TxnRow>();
    const aliased = new Set<string>();
    for (const ids of chunk(incomingIds, 500)) {
      const rows = await tx
        .select()
        .from(transaction)
        .where(and(eq(transaction.accountId, options.accountId), inArray(transaction.externalId, ids)));
      for (const r of rows) existing.set(r.externalId!, r);
      const aliases = await tx
        .select({ externalId: transactionAlias.externalId })
        .from(transactionAlias)
        .where(and(eq(transactionAlias.accountId, options.accountId), inArray(transactionAlias.externalId, ids)));
      for (const a of aliases) aliased.add(a.externalId);
    }

    const fresh: IncomingTransaction[] = [];
    for (const item of items) {
      const row = existing.get(item.externalId);
      if (!row) {
        if (aliased.has(item.externalId)) stats.duplicates++;
        else if (options.replay && item.pending) stats.skipped++;
        else fresh.push(item);
        continue;
      }
      // A replayed payload is older than the live feed, which keeps a known row's bank-owned fields current.
      if (options.replay) continue;
      const patch: Partial<typeof transaction.$inferInsert> = {};
      if (row.date !== item.date && !item.undated) patch.date = item.date;
      if (row.amountCents !== item.amountCents) patch.amountCents = item.amountCents;
      if (row.rawDescription !== item.description) patch.rawDescription = item.description;
      if ((row.memo ?? null) !== (item.memo ?? null)) patch.memo = item.memo ?? null;
      if (row.pending !== item.pending) patch.pending = item.pending;
      const postedAt = item.postedAt ?? null;
      if ((row.postedAt?.getTime() ?? null) !== (postedAt?.getTime() ?? null)) patch.postedAt = postedAt;
      if (Object.keys(patch).length > 0) {
        patch.updatedAt = new Date();
        await tx.update(transaction).set(patch).where(eq(transaction.id, row.id));
        // Split lines must add up to the row: a changed amount sends a split row back to review.
        if (patch.amountCents !== undefined) await dropSplitsAfterAmountChange(tx, row.id);
        // A pair is no longer equal and opposite (a10-conformance-ledger-06, as for a replaced pending row): both legs are released and may pair again.
        if (patch.amountCents !== undefined && row.transferPairId !== null) {
          const released = await releaseTransferPairs(tx, [row.id], options.rules);
          noteReleased(released.filter((r) => r.id !== row.id));
          for (const r of released) if (!stats.earliestReleased || r.date < stats.earliestReleased) stats.earliestReleased = r.date;
        }
        stats.updated++;
      }
    }

    // Pending rows the feed might have re-issued under a new id: every pending row of the account (a5-ingest-transfers-03).
    const localPending: TxnRow[] = feed && !options.replay ? await tx.select().from(transaction).where(and(eq(transaction.accountId, options.accountId), eq(transaction.pending, true))) : [];
    const replacements = new Map<string, { local: TxnRow; listed: boolean }>();
    if (localPending.length > 0) {
      const freshPosted = fresh.filter((f) => !f.pending).map(asIncoming);
      const unlisted = localPending.filter((p) => p.externalId === null || !byId.has(p.externalId));
      for (const [ext, id] of matchPendingToPosted(unlisted.map(asCandidate), freshPosted)) replacements.set(ext, { local: unlisted.find((p) => p.id === id)!, listed: false });
      // A pending item the feed still lists next to its posted form (a5-ingest-transfers-11): equal amount, the same merchant.
      const listed = localPending.filter((p) => p.externalId !== null && byId.get(p.externalId)?.pending === true);
      const rest = freshPosted.filter((f) => !replacements.has(f.externalId));
      for (const [ext, id] of matchPendingToPosted(listed.map(asCandidate), rest, { changedAmounts: false, minSimilarity: STRONG_SIMILARITY })) {
        replacements.set(ext, { local: listed.find((p) => p.id === id)!, listed: true });
      }
    }

    // A re-keyed account (decision 43): none of its posted feed rows in the window is listed by id any more, yet the feed sends posted items.
    let rekeyed: TxnRow[] = [];
    if (feed && !options.replay && options.windowStart && !options.keepUnmatchedPending && fresh.some((f) => !f.pending)) {
      const inWindow = await tx
        .select()
        .from(transaction)
        .where(and(eq(transaction.accountId, options.accountId), eq(transaction.source, "simplefin"), eq(transaction.pending, false), gte(transaction.date, options.windowStart)));
      if (inWindow.length > 0 && inWindow.every((r) => r.externalId === null || !byId.has(r.externalId))) rekeyed = inWindow;
    }
    const remaining = fresh.filter((f) => !replacements.has(f.externalId));
    const replacedIds = new Set([...replacements.values()].map((r) => r.local.id));
    const sameAs = await findSameTransactions(tx, options.accountId, options.source, remaining, { exclude: replacedIds, rekeyed });

    for (const item of fresh) {
      const replacement = replacements.get(item.externalId);
      if (replacement) {
        const { local, listed } = replacement;
        const patch: Partial<typeof transaction.$inferInsert> = {
          externalId: item.externalId,
          date: item.date,
          amountCents: item.amountCents,
          rawDescription: item.description,
          memo: item.memo ?? local.memo,
          pending: false,
          postedAt: item.postedAt ?? null,
          source: options.source,
          updatedAt: new Date(),
        };
        if (options.importLogId) patch.importLogId = options.importLogId;
        let payeeName = "";
        let payeeAliases: readonly string[] = [];
        let payeeId = local.payeeId;
        let payeeDefaultCategoryId: string | null = null;
        if (!local.payeeLocked) {
          const p = await payees.resolve(normalizePayee(item.payee?.trim() || item.description) || "Unknown");
          patch.payeeId = p.id;
          payeeName = p.name;
          payeeAliases = p.aliases;
          payeeId = p.id;
          payeeDefaultCategoryId = p.defaultCategoryId;
        }
        await tx.update(transaction).set(patch).where(eq(transaction.id, local.id));
        // The pending copy the feed still lists is this row now: its id is ignored from here on.
        if (listed && local.externalId) {
          await tx.insert(transactionAlias).values({ accountId: options.accountId, externalId: local.externalId, transactionId: local.id, source: "simplefin", importLogId: options.importLogId ?? null }).onConflictDoNothing();
        }
        if (item.amountCents !== local.amountCents) {
          // A tip or a settled hold (a5-ingest-transfers-06): split lines no longer add up, and a pair is no longer equal and opposite.
          await dropSplitsAfterAmountChange(tx, local.id);
          if (local.transferPairId) {
            noteReleased(await releaseTransferPartners(tx, [local.id], options.rules));
            await tx.update(transaction).set({ transferPairId: null, isTransfer: false }).where(eq(transaction.id, local.id));
            if (!stats.earliestReleased || item.date < stats.earliestReleased) stats.earliestReleased = item.date;
          }
        }
        if (!local.categoryLocked) {
          const releasedByRule: Array<{ id: string; date: IsoDate }> = [];
          await applyRulesToRow(
            tx,
            options.rules,
            {
              id: local.id,
              accountId: options.accountId,
              date: item.date,
              amountCents: item.amountCents,
              rawDescription: item.description,
              payeeName,
              payeeAliases,
              payeeId,
              payeeDefaultCategoryId,
              categoryId: local.categoryId,
              categoryLocked: local.categoryLocked,
              payeeLocked: local.payeeLocked,
              isTransfer: local.isTransfer && (local.transferPairId === null || item.amountCents === local.amountCents),
              notTransfer: local.notTransfer,
              transferPairId: item.amountCents === local.amountCents ? local.transferPairId : null,
            },
            { payees, released: releasedByRule },
          );
          noteReleased(releasedByRule);
        }
        stats.replacedPending++;
        continue;
      }

      const same = sameAs.get(item.externalId);
      if (same) {
        stats.duplicates++;
        if (!feed || item.pending) {
          // A CSV row the ledger has, or the feed's pending copy of a posted row: the id points at the row.
          await tx.insert(transactionAlias).values({ accountId: options.accountId, externalId: item.externalId, transactionId: same.id, source: options.source, importLogId: options.importLogId ?? null }).onConflictDoNothing();
          continue;
        }
        // The feed's posted item takes the row over; the household's edits stay, the old id points at the row.
        const patch: Partial<typeof transaction.$inferInsert> = {
          externalId: item.externalId,
          source: "simplefin",
          date: item.date,
          rawDescription: item.description,
          memo: item.memo ?? same.memo,
          pending: false,
          postedAt: item.postedAt ?? null,
          updatedAt: new Date(),
        };
        if (options.importLogId) patch.importLogId = options.importLogId;
        await tx.update(transaction).set(patch).where(eq(transaction.id, same.id));
        if (same.externalId) {
          await tx
            .insert(transactionAlias)
            .values({ accountId: options.accountId, externalId: same.externalId, transactionId: same.id, source: same.source === "csv" ? "csv" : "simplefin", importLogId: same.source === "csv" ? same.importLogId : null })
            .onConflictDoNothing();
        }
        continue;
      }

      // Rules see the payee the name resolves to, aliases included (a5-ingest-transfers-08).
      const baseName = normalizePayee(item.payee?.trim() || item.description) || "Unknown";
      const known = await payees.find(baseName);
      const outcome = evaluateRules(options.rules, {
        payee: known?.name ?? baseName,
        payeeAliases: known?.aliases ?? [],
        description: item.description,
        amountCents: item.amountCents,
        accountId: options.accountId,
        date: item.date,
      });
      const p = outcome.payee !== undefined ? await payees.resolve(outcome.payee) : (known ?? (await payees.resolve(baseName)));
      // The contribution classifier runs after the rules and only when no rule decided the row.
      const contribution =
        outcome.transfer === undefined && outcome.categoryId === undefined
          ? classifyInvestmentInflow(resolvedAccountType, item.payee?.trim() || item.description, item.amountCents)
          : null;
      const categoryId = contribution !== null ? null : outcome.categoryId !== undefined ? outcome.categoryId : p.defaultCategoryId;
      const [inserted] = await tx
        .insert(transaction)
        .values({
          accountId: options.accountId,
          externalId: item.externalId,
          source: options.source,
          importLogId: options.importLogId ?? null,
          date: item.date,
          postedAt: item.postedAt ?? null,
          amountCents: item.amountCents,
          payeeId: p.id,
          rawDescription: item.description,
          memo: item.memo ?? null,
          categoryId: categoryId ?? null,
          pending: item.pending,
          isTransfer: contribution !== null ? true : (outcome.transfer ?? false),
          // A rule's "not a transfer" holds over the pairing pass (a10-conformance-ledger-03).
          notTransfer: outcome.transfer === false,
        })
        .onConflictDoNothing()
        .returning({ id: transaction.id });
      if (!inserted) {
        stats.skipped++;
        continue;
      }
      if (outcome.tags.length > 0) await addTransactionTags(tx, inserted.id, outcome.tags);
      stats.created++;
      stats.insertedIds.push(inserted.id);
    }

    if (feed && options.windowStart && !options.keepUnmatchedPending && !options.replay) {
      const stale = localPending.filter((p) => !replacedIds.has(p.id) && (p.externalId === null || !byId.has(p.externalId))).map((p) => p.id);
      if (stale.length > 0) {
        noteReleased(await releaseTransferPartners(tx, stale, options.rules));
        await tx.delete(transaction).where(inArray(transaction.id, stale));
        stats.removedPending = stale.length;
      }
    }
  });

  return stats;
}
