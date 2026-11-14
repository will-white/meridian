import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { evaluateRules, RuleActions, RuleConditions, type IsoDate, type RuleLike } from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { category, payee, rule, transaction } from "../schema/index.js";
import { lockLedger } from "./ledgerLock.js";
import { PayeeCache } from "./payees.js";
import { addTransactionTags } from "./tags.js";
import { pairTransfersInDb, releaseTransferPartners } from "./transfers.js";
import { dropTransferSplits } from "./transferSplits.js";

export interface LoadedRule extends RuleLike {
  name: string;
}

export interface LoadRulesOptions {
  /**
   * The rules as stored, for display: a category action that names a category which no longer
   * exists is kept, so the Rules page can say so. By default (for evaluation) such an action
   * is dropped, so a stale rule sets nothing instead of making an import fail on the foreign key
   * (audit a6-text-rules-accounts-02).
   */
  stored?: boolean;
}

/** Load enabled and disabled rules in order; rows whose JSON no longer validates are skipped. */
export async function loadRules(tx: DbOrTx, options: LoadRulesOptions = {}): Promise<LoadedRule[]> {
  const rows = await tx.select().from(rule).orderBy(asc(rule.position), asc(rule.id));
  const named = rows.flatMap((r) => {
    const id = (r.actions as { setCategoryId?: unknown } | null)?.setCategoryId;
    return typeof id === "string" ? [id] : [];
  });
  const known = new Set<string>();
  if (!options.stored && named.length > 0) {
    const found = await tx.select({ id: category.id }).from(category).where(inArray(category.id, [...new Set(named)]));
    for (const c of found) known.add(c.id);
  }
  const out: LoadedRule[] = [];
  for (const r of rows) {
    const conditions = RuleConditions.safeParse(r.conditions);
    const actions = RuleActions.safeParse(r.actions);
    if (!conditions.success || !actions.success) continue;
    let ruleActions: RuleActions = actions.data;
    if (!options.stored && typeof ruleActions.setCategoryId === "string" && !known.has(ruleActions.setCategoryId)) {
      const { setCategoryId: _gone, ...rest } = ruleActions;
      ruleActions = rest;
    }
    out.push({ id: r.id, name: r.name, position: r.position, enabled: r.enabled, conditions: conditions.data, actions: ruleActions });
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
  /** The names merged into the payee: a payee condition holds on any of them (audit a6-text-rules-accounts-10). */
  payeeAliases?: readonly string[];
  payeeId: string | null;
  payeeDefaultCategoryId: string | null;
  categoryId: string | null;
  categoryLocked: boolean;
  payeeLocked: boolean;
  isTransfer: boolean;
  /** What a rule said before about the row being a transfer (`not_transfer`); unknown when left out. */
  notTransfer?: boolean;
  /** The row's transfer pair; looked up when left out and a rule says the row is not a transfer. */
  transferPairId?: string | null;
  /** The household decided by hand whether the row is a transfer (`transfer_locked`); looked up when left out and a rule has a transfer action for it. */
  transferLocked?: boolean;
}

export interface ApplyRulesOptions {
  /** Override a category, or a transfer decision, the user made by hand. Default false. */
  force?: boolean;
  /**
   * The household's whole rule set, when `rules` is it: a row whose `not_transfer` no rule of it
   * sets any more loses the flag (audit a10-conformance-ledger-03, second round). When `rules` is
   * only some of them (a rule just saved), the whole set is loaded for such a row.
   */
  allRules?: readonly RuleLike[];
  payees?: PayeeCache;
  /** Collects the transfer partners released because a rule said their row is not a transfer, with their dates (for a pairing pass). */
  released?: Array<{ id: string; date: IsoDate }>;
}

/**
 * Run the rules over one existing row and persist the outcome. Returns true when
 * something changed. Locked fields are respected unless `force` is set.
 *
 * A rule's transfer action is kept with the row (audit a10-conformance-ledger-03): "not a
 * transfer" sets `not_transfer`, so automatic pairing leaves the row alone, and on a paired row
 * it undoes the pair: the row loses its pair id and its partner is released (pair id and
 * `is_transfer` cleared, the rules run on it again), so no pair id is left on one row and the
 * partner may pair with another leg. "Mark as transfer" clears `not_transfer`.
 *
 * Second round: a row whose transfer state the household decided by hand (`transfer_locked`:
 * marked, marked not, paired or linked by hand) keeps it; the rules' transfer actions pass it by
 * unless `force` is set. And `not_transfer` lasts only as long as a rule sets it: a row it is set
 * on that no rule of the household's whole set rules out any more (the rule was deleted, switched
 * off or changed) loses it, so automatic pairing may take the row again.
 */
export async function applyRulesToRow(tx: DbOrTx, rules: readonly RuleLike[], row: RuleTargetRow, options: ApplyRulesOptions = {}): Promise<boolean> {
  const target = {
    payee: row.payeeName,
    payeeAliases: row.payeeAliases ?? [],
    description: row.rawDescription,
    amountCents: row.amountCents,
    accountId: row.accountId,
    date: row.date,
  };
  const outcome = evaluateRules(rules, target);
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
  const transferLocked =
    outcome.transfer === undefined
      ? false
      : (row.transferLocked ?? (await tx.select({ locked: transaction.transferLocked }).from(transaction).where(eq(transaction.id, row.id)))[0]?.locked ?? false);
  // The household's own transfer decision holds over the rules' (second round).
  const transferAction = transferLocked && options.force !== true ? undefined : outcome.transfer;
  if (transferAction !== undefined) {
    if (transferAction !== row.isTransfer) patch.isTransfer = transferAction;
    const ruledOut = transferAction === false;
    if (row.notTransfer !== ruledOut) patch.notTransfer = ruledOut;
    if (transferLocked) patch.transferLocked = false;
  } else if (outcome.transfer === undefined && row.notTransfer === true) {
    // No rule given here decides the row: when none of the household's rules rules it out any more, the flag goes with the rule.
    const all = options.allRules ?? (await loadRules(tx));
    if (evaluateRules(all, target).transfer !== false) patch.notTransfer = false;
  }
  if (transferAction === false) {
    const pairId =
      row.transferPairId !== undefined ? row.transferPairId : ((await tx.select({ pairId: transaction.transferPairId }).from(transaction).where(eq(transaction.id, row.id)))[0]?.pairId ?? null);
    if (pairId !== null) {
      patch.transferPairId = null;
      const released = await releaseTransferPartners(tx, [row.id], rules);
      options.released?.push(...released);
    }
  }

  if (outcome.tags.length > 0) await addTransactionTags(tx, row.id, outcome.tags);
  if (Object.keys(patch).length === 0) return outcome.tags.length > 0;
  patch.updatedAt = new Date();
  await tx.update(transaction).set(patch).where(eq(transaction.id, row.id));
  // A transfer has no split (audit a8-ledger-ui-10): a rule that marks a split row a transfer removes its lines.
  if (patch.isTransfer === true) await dropTransferSplits(tx, [row.id]);
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
  const allRules = await loadRules(db);
  const rules = options.rules ?? allRules;
  const batchSize = options.batchSize ?? 500;
  let examined = 0;
  let changed = 0;
  let lastId: string | undefined;
  // Partners released because a rule ruled their row out as a transfer may pair with another leg (decision 49).
  const released: Array<{ id: string; date: IsoDate }> = [];

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
        payeeAliases: sql<string[]>`coalesce(${payee.aliases}, '[]'::jsonb)`,
        payeeId: transaction.payeeId,
        payeeDefaultCategoryId: payee.defaultCategoryId,
        categoryId: transaction.categoryId,
        categoryLocked: transaction.categoryLocked,
        payeeLocked: transaction.payeeLocked,
        isTransfer: transaction.isTransfer,
        notTransfer: transaction.notTransfer,
        transferPairId: transaction.transferPairId,
        transferLocked: transaction.transferLocked,
      })
      .from(transaction)
      .leftJoin(payee, eq(payee.id, transaction.payeeId))
      .where(where)
      .orderBy(asc(transaction.id))
      .limit(batchSize);
    if (rows.length === 0) break;
    await db.transaction(async (tx) => {
      // A rule can release a transfer pair (a10-conformance-ledger-03): not while a pairing pass or an ingest decides from the same rows.
      await lockLedger(tx);
      const payees = new PayeeCache(tx);
      for (const row of rows) {
        examined++;
        if (await applyRulesToRow(tx, rules, row, { payees, released, allRules })) changed++;
      }
    });
    lastId = rows[rows.length - 1]!.id;
    if (rows.length < batchSize) break;
  }
  if (released.length > 0) {
    const dates = released.map((r) => r.date).sort();
    await db.transaction((tx) => pairTransfersInDb(tx, { since: dates[0]!, until: dates[dates.length - 1]! }));
  }
  // Rows whose "not a transfer" went with its rule (a10-conformance-ledger-03, second round) may pair now.
  await clearStaleNotTransfer(db, allRules);
  return { examined, changed };
}

/**
 * Audit a10-conformance-ledger-03, second round: `not_transfer` lasts as long as a rule sets
 * it. Every row it is set on is checked against the household's rules as they are now (`rules`,
 * loaded when left out); where none rules the row out any more (the rule was deleted, switched off
 * or changed) the flag goes, and a pairing pass over those rows' days lets them pair. The rules
 * routes run this after a rule is deleted, changed or moved; a rule run ends with it. Nothing else
 * of the row changes: the other rules apply when the household runs them.
 */
export async function clearStaleNotTransfer(db: Db, rules?: readonly RuleLike[]): Promise<{ cleared: number; transfersPaired: number }> {
  return db.transaction(async (tx) => {
    await lockLedger(tx);
    const all = rules ?? (await loadRules(tx));
    const flagged = await tx
      .select({
        id: transaction.id,
        accountId: transaction.accountId,
        date: transaction.date,
        amountCents: transaction.amountCents,
        rawDescription: transaction.rawDescription,
        payeeName: sql<string>`coalesce(${payee.name}, '')`,
        payeeAliases: sql<string[]>`coalesce(${payee.aliases}, '[]'::jsonb)`,
      })
      .from(transaction)
      .leftJoin(payee, eq(payee.id, transaction.payeeId))
      .where(eq(transaction.notTransfer, true));
    const stale = flagged.filter(
      (r) => evaluateRules(all, { payee: r.payeeName, payeeAliases: r.payeeAliases, description: r.rawDescription, amountCents: r.amountCents, accountId: r.accountId, date: r.date }).transfer !== false,
    );
    if (stale.length === 0) return { cleared: 0, transfersPaired: 0 };
    for (let i = 0; i < stale.length; i += 500) {
      await tx
        .update(transaction)
        .set({ notTransfer: false, updatedAt: new Date() })
        .where(inArray(transaction.id, stale.slice(i, i + 500).map((r) => r.id)));
    }
    const dates = stale.map((r) => r.date).sort();
    const transfersPaired = await pairTransfersInDb(tx, { since: dates[0]!, until: dates[dates.length - 1]! });
    return { cleared: stale.length, transfersPaired };
  });
}
