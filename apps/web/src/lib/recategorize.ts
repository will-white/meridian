import { matchString, type RuleView, type TransactionView } from "@meridian/shared";

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
  payeeName: string;
  categoryId: string;
}

/** The rule prompt to offer after `t` was moved to `categoryId`; null without a payee to match on. */
export function recategorizePrompt(t: Pick<TransactionView, "payeeName">, categoryId: string | null): RulePromptTarget | null {
  if (!categoryId || !t.payeeName) return null;
  return { payeeName: t.payeeName, categoryId };
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

/**
 * An enabled rule that already does what "always do this" would write (audit a8-ledger-ui-09):
 * its only condition is the payee, equal to this name as the rules engine compares it
 * (`matchString`: NFKC, Latin accents folded, case ignored unless the rule says otherwise), and
 * it sets this category without marking the row a transfer. The prompt names that rule instead
 * of writing the same rule again.
 */
export function existingAlwaysRule<R extends Pick<RuleView, "enabled" | "conditions" | "actions" | "position" | "name">>(rules: readonly R[] | undefined, target: RulePromptTarget): R | undefined {
  return (rules ?? []).find((r) => {
    if (!r.enabled || r.actions.setCategoryId !== target.categoryId || r.actions.markTransfer === true) return false;
    const c = r.conditions;
    if (!c.payee || c.payee.op !== "equals" || c.description || c.amount || c.accountId || c.dayOfMonth) return false;
    return matchString(c.payee, target.payeeName);
  });
}
