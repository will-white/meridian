import { z } from "zod";
import { dayOfMonth, type IsoDate } from "./dates.js";

/**
 * Ordered rules. Each rule is `conditions -> actions`. Rules run in `position`
 * order; every rule whose conditions all hold applies its actions. A later rule
 * overrides an earlier one for the same field, tags accumulate, and `stop` ends
 * evaluation after that rule. Conditions evaluate against the running context,
 * so a rule that renames a payee feeds the rules after it.
 */

export const StringMatch = z.object({
  op: z.enum(["equals", "contains", "startsWith", "regex"]),
  value: z.string().min(1).max(500),
  caseSensitive: z.boolean().optional(),
});
export type StringMatch = z.infer<typeof StringMatch>;

/** Cents travel as decimal strings inside JSON so bigint survives. */
const CentsString = z.string().regex(/^-?\d+$/);

export const RuleConditions = z
  .object({
    payee: StringMatch.optional(),
    description: StringMatch.optional(),
    amount: z
      .object({ minCents: CentsString.optional(), maxCents: CentsString.optional() })
      .optional(),
    accountId: z.string().uuid().optional(),
    dayOfMonth: z.object({ min: z.number().int().min(1).max(31), max: z.number().int().min(1).max(31) }).optional(),
  })
  .refine((c) => Object.values(c).some((v) => v !== undefined), { message: "A rule needs at least one condition" });
export type RuleConditions = z.infer<typeof RuleConditions>;

export const RuleActions = z
  .object({
    setPayee: z.string().min(1).max(200).optional(),
    setCategoryId: z.string().uuid().nullable().optional(),
    addTags: z.array(z.string().min(1).max(50)).optional(),
    markTransfer: z.boolean().optional(),
    stop: z.boolean().optional(),
  })
  .refine((a) => a.setPayee !== undefined || a.setCategoryId !== undefined || (a.addTags?.length ?? 0) > 0 || a.markTransfer !== undefined, {
    message: "A rule needs at least one action",
  });
export type RuleActions = z.infer<typeof RuleActions>;

export interface RuleLike {
  id: string;
  position: number;
  enabled: boolean;
  conditions: RuleConditions;
  actions: RuleActions;
}

export interface RuleContext {
  payee: string;
  description: string;
  amountCents: bigint;
  accountId: string;
  date: IsoDate;
}

export interface RuleOutcome {
  payee?: string;
  categoryId?: string | null;
  tags: string[];
  transfer?: boolean;
  matchedRuleIds: string[];
}

export function matchString(cond: StringMatch, value: string): boolean {
  const cs = cond.caseSensitive === true;
  const a = cs ? value : value.toLowerCase();
  const b = cs ? cond.value : cond.value.toLowerCase();
  switch (cond.op) {
    case "equals":
      return a === b;
    case "contains":
      return a.includes(b);
    case "startsWith":
      return a.startsWith(b);
    case "regex": {
      try {
        return new RegExp(cond.value, cs ? "" : "i").test(value);
      } catch {
        return false;
      }
    }
  }
}

export function ruleMatches(conditions: RuleConditions, ctx: RuleContext): boolean {
  if (conditions.payee && !matchString(conditions.payee, ctx.payee)) return false;
  if (conditions.description && !matchString(conditions.description, ctx.description)) return false;
  if (conditions.amount) {
    if (conditions.amount.minCents !== undefined && ctx.amountCents < BigInt(conditions.amount.minCents)) return false;
    if (conditions.amount.maxCents !== undefined && ctx.amountCents > BigInt(conditions.amount.maxCents)) return false;
  }
  if (conditions.accountId !== undefined && conditions.accountId !== ctx.accountId) return false;
  if (conditions.dayOfMonth) {
    const d = dayOfMonth(ctx.date);
    if (d < conditions.dayOfMonth.min || d > conditions.dayOfMonth.max) return false;
  }
  return true;
}

export function evaluateRules(rules: readonly RuleLike[], input: RuleContext): RuleOutcome {
  const ordered = [...rules].filter((r) => r.enabled).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const ctx: RuleContext = { ...input };
  const outcome: RuleOutcome = { tags: [], matchedRuleIds: [] };
  const tagSet = new Set<string>();

  for (const rule of ordered) {
    if (!ruleMatches(rule.conditions, ctx)) continue;
    outcome.matchedRuleIds.push(rule.id);
    const a = rule.actions;
    if (a.setPayee !== undefined) {
      outcome.payee = a.setPayee;
      ctx.payee = a.setPayee;
    }
    if (a.setCategoryId !== undefined) outcome.categoryId = a.setCategoryId;
    for (const t of a.addTags ?? []) tagSet.add(t);
    if (a.markTransfer !== undefined) outcome.transfer = a.markTransfer;
    if (a.stop) break;
  }

  outcome.tags = [...tagSet];
  return outcome;
}
