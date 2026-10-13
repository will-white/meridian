import { eq, sql } from "drizzle-orm";
import { normalizePayee } from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { payee } from "../schema/index.js";

export interface PayeeRow {
  id: string;
  name: string;
  defaultCategoryId: string | null;
}

/** A small per-batch cache so an import does not hit the payee table once per row. */
export class PayeeCache {
  private readonly byName = new Map<string, PayeeRow>();
  constructor(private readonly tx: DbOrTx) {}
  async resolve(name: string): Promise<PayeeRow> {
    const key = name.trim().toLowerCase();
    const hit = this.byName.get(key);
    if (hit) return hit;
    const row = await resolvePayee(this.tx, name);
    this.byName.set(key, row);
    return row;
  }
}

/** Find a payee by name or alias (case-insensitive), creating it when missing. */
export async function resolvePayee(tx: DbOrTx, rawName: string): Promise<PayeeRow> {
  const name = rawName.trim() || "Unknown";
  const existing = await tx
    .select({ id: payee.id, name: payee.name, defaultCategoryId: payee.defaultCategoryId })
    .from(payee)
    .where(
      sql`lower(${payee.name}) = lower(${name}) or exists (select 1 from jsonb_array_elements_text(${payee.aliases}) a where lower(a) = lower(${name}))`,
    )
    .orderBy(sql`case when lower(${payee.name}) = lower(${name}) then 0 else 1 end`)
    .limit(1);
  if (existing[0]) return existing[0];
  const inserted = await tx
    .insert(payee)
    .values({ name })
    .onConflictDoUpdate({ target: payee.name, set: { name } })
    .returning({ id: payee.id, name: payee.name, defaultCategoryId: payee.defaultCategoryId });
  return inserted[0]!;
}

/** Normalize a raw description (or bank payee) and resolve it to a payee row. */
export async function resolvePayeeFromDescription(tx: DbOrTx, description: string, bankPayee?: string): Promise<PayeeRow> {
  const name = normalizePayee(bankPayee?.trim() || description) || "Unknown";
  return resolvePayee(tx, name);
}

export async function addPayeeAlias(tx: DbOrTx, payeeId: string, alias: string): Promise<void> {
  await tx
    .update(payee)
    .set({ aliases: sql`(select jsonb_agg(distinct x) from jsonb_array_elements_text(${payee.aliases} || ${JSON.stringify([alias])}::jsonb) x)` })
    .where(eq(payee.id, payeeId));
}
