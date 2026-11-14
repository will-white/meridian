import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { alwaysRuleVerdict, evaluateRules, RuleActions, RuleConditions, type AlwaysRuleCheck, type IsoDate, type RuleLike } from "@meridian/shared";
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
}

export interface ApplyRulesOptions {
  /** Override a category the user locked by hand. Default false. */
  force?: boolean;
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
 */
export async function applyRulesToRow(tx: DbOrTx, rules: readonly RuleLike[], row: RuleTargetRow, options: ApplyRulesOptions = {}): Promise<boolean> {
  const outcome = evaluateRules(rules, {
    payee: row.payeeName,
    payeeAliases: row.payeeAliases ?? [],
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
  if (outcome.transfer !== undefined) {
    if (outcome.transfer !== row.isTransfer) patch.isTransfer = outcome.transfer;
    const ruledOut = outcome.transfer === false;
    if (row.notTransfer !== ruledOut) patch.notTransfer = ruledOut;
  }
  if (outcome.transfer === false) {
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

/**
 * Audit a8-ledger-ui-09, second round: what "always do this" would do for a transaction moved to
 * `categoryId` (`alwaysRuleVerdict`), with the rules as the sync and a rule run load them and the
 * transaction as a rule run reads it: its payee's name and other names, description, amount,
 * account and date. Null when there is no such transaction.
 */
export async function alwaysRuleCheck(db: DbOrTx, transactionId: string, categoryId: string): Promise<AlwaysRuleCheck | null> {
  const [row] = await db
    .select({
      accountId: transaction.accountId,
      date: transaction.date,
      amountCents: transaction.amountCents,
      rawDescription: transaction.rawDescription,
      payeeName: sql<string>`coalesce(${payee.name}, '')`,
      payeeAliases: sql<string[]>`coalesce(${payee.aliases}, '[]'::jsonb)`,
    })
    .from(transaction)
    .leftJoin(payee, eq(payee.id, transaction.payeeId))
    .where(eq(transaction.id, transactionId));
  if (!row) return null;
  const rules = await loadRules(db);
  const verdict = alwaysRuleVerdict(rules, { payee: row.payeeName, payeeAliases: row.payeeAliases, description: row.rawDescription, amountCents: row.amountCents, accountId: row.accountId, date: row.date }, categoryId);
  if (verdict.verdict === "offer") return { verdict: "offer", rule: null, reason: null };
  const named = rules.find((r) => r.id === verdict.ruleId)!;
  return { verdict: verdict.verdict, rule: { id: named.id, position: named.position, name: named.name }, reason: verdict.verdict === "blocked" ? verdict.reason : null };
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
        if (await applyRulesToRow(tx, rules, row, { payees, released })) changed++;
      }
    });
    lastId = rows[rows.length - 1]!.id;
    if (rows.length < batchSize) break;
  }
  if (released.length > 0) {
    const dates = released.map((r) => r.date).sort();
    await db.transaction((tx) => pairTransfersInDb(tx, { since: dates[0]!, until: dates[dates.length - 1]! }));
  }
  return { examined, changed };
}
