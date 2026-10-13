import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { DbOrTx } from "../index.js";
import { tag, transactionTag } from "../schema/index.js";

async function ensureTags(tx: DbOrTx, names: readonly string[]): Promise<Map<string, string>> {
  const clean = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))];
  if (clean.length === 0) return new Map();
  await tx
    .insert(tag)
    .values(clean.map((name) => ({ name })))
    .onConflictDoNothing();
  const rows = await tx.select({ id: tag.id, name: tag.name }).from(tag).where(inArray(tag.name, clean));
  return new Map(rows.map((r) => [r.name, r.id]));
}

/** Add tags to a transaction, keeping the ones it already has. */
export async function addTransactionTags(tx: DbOrTx, transactionId: string, names: readonly string[]): Promise<void> {
  const ids = await ensureTags(tx, names);
  if (ids.size === 0) return;
  await tx
    .insert(transactionTag)
    .values([...ids.values()].map((tagId) => ({ transactionId, tagId })))
    .onConflictDoNothing();
}

/** Replace a transaction's tags with exactly this set. */
export async function setTransactionTags(tx: DbOrTx, transactionId: string, names: readonly string[]): Promise<void> {
  const ids = await ensureTags(tx, names);
  const keep = [...ids.values()];
  if (keep.length === 0) {
    await tx.delete(transactionTag).where(eq(transactionTag.transactionId, transactionId));
    return;
  }
  await tx.delete(transactionTag).where(and(eq(transactionTag.transactionId, transactionId), notInArray(transactionTag.tagId, keep)));
  await tx
    .insert(transactionTag)
    .values(keep.map((tagId) => ({ transactionId, tagId })))
    .onConflictDoNothing();
}

export async function tagsForTransactions(tx: DbOrTx, transactionIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (transactionIds.length === 0) return out;
  const rows = await tx
    .select({ transactionId: transactionTag.transactionId, name: tag.name })
    .from(transactionTag)
    .innerJoin(tag, eq(tag.id, transactionTag.tagId))
    .where(inArray(transactionTag.transactionId, [...transactionIds]));
  for (const r of rows) {
    const list = out.get(r.transactionId) ?? [];
    list.push(r.name);
    out.set(r.transactionId, list);
  }
  for (const list of out.values()) list.sort();
  return out;
}
