import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { evaluateRules, RuleActions, RuleConditions, type IsoDate, type RuleLike } from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { payee, rule, transaction } from "../schema/index.js";
import { PayeeCache } from "./payees.js";
import { addTransactionTags } from "./tags.js";

export interface LoadedRule extends RuleLike {
  name: string;
}

/** Load enabled and disabled rules in order; rows whose JSON no longer validates are skipped. */
export async function loadRules(tx: DbOrTx): Promise<LoadedRule[]> {
  const rows = await tx.select().from(rule).orderBy(asc(rule.position), asc(rule.id));
  const out: LoadedRule[] = [];
  for (const r of rows) {
    const conditions = RuleConditions.safeParse(r.conditions);
    const actions = RuleActions.safeParse(r.actions);
    if (!conditions.success || !actions.success) continue;
    out.push({ id: r.id, name: r.name, position: r.position, enabled: r.enabled, conditions: conditions.data, actions: actions.data });
  }
  return out;
}

export interface RuleTargetRow {
  id: string;
  accountId: string;
  date: IsoDate;
  amountCents: bigint;
  rawDescription: string;
  payeeName: string;
  payeeId: string | null;
  payeeDefaultCategoryId: string | null;
  categoryId: string | null;
  categoryLocked: boolean;
  payeeLocked: boolean;
  isTransfer: boolean;
}

export interface ApplyRulesOptions {
  /** Override a category the user locked by hand. Default false. */
  force?: boolean;
  payees?: PayeeCache;
}

/**
 * Run the rules over one existing row and persist the outcome. Returns true when
 * something changed. Locked fields are respected unless `force` is set.
 */
export async function applyRulesToRow(tx: DbOrTx, rules: readonly RuleLike[], row: RuleTargetRow, options: ApplyRulesOptions = {}): Promise<boolean> {
  const outcome = evaluateRules(rules, {
    payee: row.payeeName,
    description: row.rawDescription,
    amountCents: row.amountCents,
    accountId: row.accountId,
    date: row.date,
  });
  const payees = options.payees ?? new PayeeCache(tx);
  const patch: Partial<typeof transaction.$inferInsert> = {};
  let defaultCategoryId = row.payeeDefaultCategoryId;

  if (outcome.payee !== undefined && !row.payeeLocked) {
    const p = await payees.resolve(outcome.payee);
    if (p.id !== row.payeeId) patch.payeeId = p.id;
    defaultCategoryId = p.defaultCategoryId;
  }
  const canSetCategory = options.force === true || !row.categoryLocked;
  if (canSetCategory) {
    const next = outcome.categoryId !== undefined ? outcome.categoryId : row.categoryId ?? defaultCategoryId ?? null;
    if (next !== row.categoryId) patch.categoryId = next;
  }
  if (outcome.transfer !== undefined && outcome.transfer !== row.isTransfer) patch.isTransfer = outcome.transfer;

  if (outcome.tags.length > 0) await addTransactionTags(tx, row.id, outcome.tags);
  if (Object.keys(patch).length === 0) return outcome.tags.length > 0;
  patch.updatedAt = new Date();
  await tx.update(transaction).set(patch).where(eq(transaction.id, row.id));
  return true;
}

export interface RunRulesOptions {
  scope: "uncategorized" | "all";
  /** Restrict to these rules (for example a freshly created one). Default: all enabled rules. */
  rules?: readonly RuleLike[];
  batchSize?: number;
}

/** Re-run rules on demand over existing transactions. */
export async function runRules(db: Db, options: RunRulesOptions): Promise<{ examined: number; changed: number }> {
  const rules = options.rules ?? (await loadRules(db));
  const batchSize = options.batchSize ?? 500;
  let examined = 0;
  let changed = 0;
  let lastId: string | undefined;

  for (;;) {
    const where = and(
      options.scope === "uncategorized" ? and(isNull(transaction.categoryId), eq(transaction.categoryLocked, false)) : undefined,
      options.scope === "all" ? or(eq(transaction.categoryLocked, false), eq(transaction.payeeLocked, false)) : undefined,
      lastId ? gt(transaction.id, lastId) : undefined,
    );
    const rows = await db
      .select({
        id: transaction.id,
        accountId: transaction.accountId,
        date: transaction.date,
        amountCents: transaction.amountCents,
        rawDescription: transaction.rawDescription,
        payeeName: sql<string>`coalesce(${payee.name}, '')`,
        payeeId: transaction.payeeId,
        payeeDefaultCategoryId: payee.defaultCategoryId,
        categoryId: transaction.categoryId,
        categoryLocked: transaction.categoryLocked,
        payeeLocked: transaction.payeeLocked,
        isTransfer: transaction.isTransfer,
      })
      .from(transaction)
      .leftJoin(payee, eq(payee.id, transaction.payeeId))
      .where(where)
      .orderBy(asc(transaction.id))
      .limit(batchSize);
    if (rows.length === 0) break;
    await db.transaction(async (tx) => {
      const payees = new PayeeCache(tx);
      for (const row of rows) {
        examined++;
        if (await applyRulesToRow(tx, rules, row, { payees })) changed++;
      }
    });
    lastId = rows[rows.length - 1]!.id;
    if (rows.length < batchSize) break;
  }
  return { examined, changed };
}
