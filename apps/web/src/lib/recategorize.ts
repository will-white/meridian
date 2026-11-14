import type { AlwaysRuleCheck, TransactionView } from "@meridian/shared";

/**
 * Recategorizing a transaction from the register or from the Plan page's drill-down panel
 * (drag onto a category row, or the row's category select): what can be moved, and the
 * Phase 1 "always do this" rule offered afterwards (spec, Transactions: "Recategorizing a
 * transaction offers 'always do this'").
 */

/** dataTransfer type a draggable transaction row carries (the transaction id). */
export const TRANSACTION_DRAG_TYPE = "text/meridian-transaction";

/**
 * A row that can be dropped on a category. A transfer leg has no category (it is undone on the
 * register), and a split row is recategorized line by line in its split editor: dropping it would
 * replace every line with one category.
 */
export function canDragToRecategorize(t: Pick<TransactionView, "isTransfer" | "splits">): boolean {
  return !t.isTransfer && t.splits.length === 0;
}

export interface RulePromptTarget {
  /** The transaction just recategorized: the rules engine is run on it before anything is offered (audit a8-ledger-ui-09, second round). */
  transactionId: string;
  payeeName: string;
  categoryId: string;
}

/** The rule prompt to offer after `t` was moved to `categoryId`; null without a payee to match on. */
export function recategorizePrompt(t: Pick<TransactionView, "id" | "payeeName">, categoryId: string | null): RulePromptTarget | null {
  if (!categoryId || !t.payeeName) return null;
  return { transactionId: t.id, payeeName: t.payeeName, categoryId };
}

/**
 * The query key of `GET /transactions/:id/always-rule` for a prompt: under `["rules"]`, so a rule
 * created, edited, moved or deleted anywhere asks again.
 */
export function alwaysRuleKey(target: RulePromptTarget) {
  return ["rules", "always", target.transactionId, target.categoryId] as const;
}

/** POST /api/rules body of "always do this": this payee always gets this category, applied to the uncategorized rows. */
export function alwaysRuleBody(target: RulePromptTarget, categoryName: string | undefined) {
  return {
    name: `${target.payeeName} → ${categoryName ?? "category"}`,
    conditions: { payee: { op: "equals" as const, value: target.payeeName } },
    actions: { setCategoryId: target.categoryId },
    applyTo: "uncategorized" as const,
  };
}

/** "Rule saved. 3 other transactions categorized." */
export function ruleSavedNotice(changed: number): string {
  return `Rule saved. ${changed} other transaction${changed === 1 ? "" : "s"} categorized.`;
}

/** "Rule #3 "Blue Bottle Coffee → Coffee"": how the prompt names a rule. */
export function ruleLabel(rule: NonNullable<AlwaysRuleCheck["rule"]>): string {
  return `Rule #${rule.position}${rule.name ? ` "${rule.name}"` : ""}`;
}

const BLOCKED: Record<NonNullable<AlwaysRuleCheck["reason"]>, string> = {
  stop: "ends the rules for this transaction before a rule written now would run",
  transfer: "marks this transaction a transfer",
  payee: "renames this transaction's payee before a rule written now would see it",
};

/**
 * Why "always do this" is not offered when a rule decides first (audit a8-ledger-ui-09, second
 * round): the rule that stops the run, marks the transaction a transfer or renames its payee.
 */
export function blockedRuleText(check: AlwaysRuleCheck, target: RulePromptTarget, categoryName: string | undefined): string | null {
  if (check.verdict !== "blocked" || !check.rule || !check.reason) return null;
  return `${ruleLabel(check.rule)} ${BLOCKED[check.reason]}, so "always do this" would not categorize ${target.payeeName} as ${categoryName ?? "that category"}.`;
}
