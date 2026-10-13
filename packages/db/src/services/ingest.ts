import { and, eq, gte, inArray, notInArray } from "drizzle-orm";
import { addDays, evaluateRules, matchPendingToPosted, normalizePayee, type IsoDate, type RuleLike } from "@meridian/shared";
import type { Db } from "../index.js";
import { transaction } from "../schema/index.js";
import { PayeeCache } from "./payees.js";
import { addTransactionTags } from "./tags.js";
import { applyRulesToRow } from "./rules.js";

export interface IncomingTransaction {
  externalId: string;
  date: IsoDate;
  amountCents: bigint;
  description: string;
  payee?: string;
  memo?: string;
  pending: boolean;
  postedAt?: Date;
}

export interface IngestOptions {
  accountId: string;
  source: "simplefin" | "csv";
  importLogId?: string;
  /**
   * Start of the fetched window (SimpleFIN). Local pending rows at or after
   * `windowStart - 7 days` that the feed no longer returns and that did not post are deleted.
   * CSV imports leave this unset: a file is never a complete view of pending items.
   */
  windowStart?: IsoDate;
  rules: readonly RuleLike[];
}

export interface IngestStats {
  created: number;
  updated: number;
  replacedPending: number;
  removedPending: number;
  skipped: number;
  insertedIds: string[];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Upsert a batch of bank transactions for one account.
 *
 * - Dedupe key is (account, external id). Known rows get their bank-owned fields refreshed.
 * - A posted item with a new id replaces a matching local pending row in place (same row id,
 *   user edits kept).
 * - New rows get a normalized payee, the rules, and the payee's default category.
 * - Pending rows the feed stopped returning are removed (SimpleFIN only).
 */
export async function ingestTransactions(db: Db, incoming: readonly IncomingTransaction[], options: IngestOptions): Promise<IngestStats> {
  const stats: IngestStats = { created: 0, updated: 0, replacedPending: 0, removedPending: 0, skipped: 0, insertedIds: [] };

  // Last occurrence wins when a feed repeats an id inside one payload.
  const byId = new Map<string, IncomingTransaction>();
  for (const item of incoming) {
    if (byId.has(item.externalId)) stats.skipped++;
    byId.set(item.externalId, item);
  }
  const items = [...byId.values()];
  const incomingIds = items.map((i) => i.externalId);

  await db.transaction(async (tx) => {
    const payees = new PayeeCache(tx);
    const existing = new Map<string, typeof transaction.$inferSelect>();
    for (const ids of chunk(incomingIds, 500)) {
      const rows = await tx
        .select()
        .from(transaction)
        .where(and(eq(transaction.accountId, options.accountId), inArray(transaction.externalId, ids)));
      for (const r of rows) existing.set(r.externalId!, r);
    }

    const fresh: IncomingTransaction[] = [];
    for (const item of items) {
      const row = existing.get(item.externalId);
      if (!row) {
        fresh.push(item);
        continue;
      }
      const patch: Partial<typeof transaction.$inferInsert> = {};
      if (row.date !== item.date) patch.date = item.date;
      if (row.amountCents !== item.amountCents) patch.amountCents = item.amountCents;
      if (row.rawDescription !== item.description) patch.rawDescription = item.description;
      if ((row.memo ?? null) !== (item.memo ?? null)) patch.memo = item.memo ?? null;
      if (row.pending !== item.pending) patch.pending = item.pending;
      const postedAt = item.postedAt ?? null;
      if ((row.postedAt?.getTime() ?? null) !== (postedAt?.getTime() ?? null)) patch.postedAt = postedAt;
      if (Object.keys(patch).length > 0) {
        patch.updatedAt = new Date();
        await tx.update(transaction).set(patch).where(eq(transaction.id, row.id));
        stats.updated++;
      }
    }

    // Local pending rows the feed might have re-issued under a new id.
    const pendingWhere = and(
      eq(transaction.accountId, options.accountId),
      eq(transaction.pending, true),
      incomingIds.length > 0 ? notInArray(transaction.externalId, incomingIds) : undefined,
      options.windowStart ? gte(transaction.date, addDays(options.windowStart, -7)) : undefined,
    );
    const localPending = await tx.select().from(transaction).where(pendingWhere);
    const matches = matchPendingToPosted(
      localPending.map((p) => ({ id: p.id, amountCents: p.amountCents, date: p.date, description: p.rawDescription })),
      fresh.filter((f) => !f.pending).map((f) => ({ externalId: f.externalId, amountCents: f.amountCents, date: f.date, description: f.description })),
    );
    const matchedLocalIds = new Set(matches.values());

    for (const item of fresh) {
      const localId = matches.get(item.externalId);
      if (localId) {
        const local = localPending.find((p) => p.id === localId)!;
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
        let payeeId = local.payeeId;
        let payeeDefaultCategoryId: string | null = null;
        if (!local.payeeLocked) {
          const p = await payees.resolve(normalizePayee(item.payee?.trim() || item.description) || "Unknown");
          patch.payeeId = p.id;
          payeeName = p.name;
          payeeId = p.id;
          payeeDefaultCategoryId = p.defaultCategoryId;
        }
        await tx.update(transaction).set(patch).where(eq(transaction.id, local.id));
        if (!local.categoryLocked) {
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
              payeeId,
              payeeDefaultCategoryId,
              categoryId: local.categoryId,
              categoryLocked: local.categoryLocked,
              payeeLocked: local.payeeLocked,
              isTransfer: local.isTransfer,
            },
            { payees },
          );
        }
        stats.replacedPending++;
        continue;
      }

      const baseName = normalizePayee(item.payee?.trim() || item.description) || "Unknown";
      const outcome = evaluateRules(options.rules, {
        payee: baseName,
        description: item.description,
        amountCents: item.amountCents,
        accountId: options.accountId,
        date: item.date,
      });
      const p = await payees.resolve(outcome.payee ?? baseName);
      const categoryId = outcome.categoryId !== undefined ? outcome.categoryId : p.defaultCategoryId;
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
          isTransfer: outcome.transfer ?? false,
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

    if (options.windowStart) {
      const stale = localPending.filter((p) => !matchedLocalIds.has(p.id)).map((p) => p.id);
      if (stale.length > 0) {
        await tx.delete(transaction).where(inArray(transaction.id, stale));
        stats.removedPending = stale.length;
      }
    }
  });

  return stats;
}
