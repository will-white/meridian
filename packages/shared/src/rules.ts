import { RE2JS } from "re2js";
import { z } from "zod";
import { dayOfMonth, type IsoDate } from "./dates.js";
import { foldLatinAccents } from "./sanitize.js";
import { CentsInput } from "./wire.js";

/**
 * Ordered rules. Each rule is `conditions -> actions`. Rules run in `position`
 * order; every rule whose conditions all hold applies its actions. A later rule
 * overrides an earlier one for the same field, tags accumulate, and `stop` ends
 * evaluation after that rule. Conditions evaluate against the running context,
 * so a rule that renames a payee feeds the rules after it.
 *
 * The contracts below are the stored shape (what `GET /rules` returns and `loadRules`
 * reads, so a rule saved before a check existed still lists); `ruleInputProblem` holds what
 * a create or an edit must also satisfy (audit a6-text-rules-accounts-04 and -16).
 */

export const StringMatch = z.object({
  op: z.enum(["equals", "contains", "startsWith", "regex"]),
  value: z.string().min(1).max(500),
  caseSensitive: z.boolean().optional(),
});
export type StringMatch = z.infer<typeof StringMatch>;

export const RuleConditions = z
  .object({
    payee: StringMatch.optional(),
    description: StringMatch.optional(),
    amount: z
      // Cents travel as decimal strings inside JSON so bigint survives; bounded like every amount a caller sends.
      .object({ minCents: CentsInput.optional(), maxCents: CentsInput.optional() })
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
    addTags: z.array(z.string().min(1).max(50)).max(50).optional(),
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
  /**
   * The names merged into the payee (its aliases). A payee condition holds when it holds for
   * the payee's name or for one of these, so a rule written on a name keeps working after that
   * name is merged into another payee or renamed (audit a6-text-rules-accounts-10). A rule that
   * sets the payee clears them for the rules after it.
   */
  payeeAliases?: readonly string[];
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

/** The longest regular expression a rule may be saved with. */
export const RULE_REGEX_MAX_LENGTH = 200;

/** Compiled patterns by flags and source: a batch compiles each rule's pattern once. */
const compiledPatterns = new Map<string, RE2JS | null>();

/**
 * A rule's pattern compiled for RE2, whose matching time is linear in the text whatever the
 * pattern (no backtracking: `^(\w+\s?)+$` cannot hang an import, audit a6-text-rules-accounts-04).
 * RE2 has no look-around or back-references; a pattern it refuses is null and never matches.
 */
function compilePattern(pattern: string, caseSensitive: boolean): RE2JS | null {
  const key = `${caseSensitive ? "s" : "i"}:${pattern}`;
  const hit = compiledPatterns.get(key);
  if (hit !== undefined) return hit;
  let re: RE2JS | null;
  try {
    re = RE2JS.compile(pattern, caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE);
  } catch {
    re = null;
  }
  if (compiledPatterns.size >= 1000) compiledPatterns.clear();
  compiledPatterns.set(key, re);
  return re;
}

/** Why RE2 refuses a pattern, in its own words without the prefix, or null when it compiles. */
function re2Refusal(pattern: string): string | null {
  try {
    RE2JS.compile(pattern);
    return null;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // "error parsing regexp: invalid or unsupported Perl syntax: `(?=`" → the part after the prefix.
    return raw.replace(/^error parsing regexp:\s*/i, "").slice(0, 120);
  }
}

/** Why a pattern cannot be saved, or null. */
export function regexProblem(pattern: string): string | null {
  if (pattern.length > RULE_REGEX_MAX_LENGTH) return `A pattern may be at most ${RULE_REGEX_MAX_LENGTH} characters`;
  const refusal = re2Refusal(pattern);
  return refusal === null ? null : `Not a pattern this app can run (${refusal}). Look-ahead, look-behind and back-references are not supported`;
}

export interface RuleInputProblem {
  code: "invalid_regex" | "invalid_amount_range";
  message: string;
}

/**
 * What a rule must satisfy beyond its stored shape before it is created or edited (audit
 * a6-text-rules-accounts-16): a pattern compiles for RE2 and is at most 200 characters; an
 * amount range has a bound, and its minimum is not above its maximum. A day range may wrap
 * past the month end (28 to 3), and a day past the end of a month means its last day.
 */
export function ruleInputProblem(conditions: RuleConditions, _actions?: RuleActions): RuleInputProblem | null {
  for (const [field, m] of [
    ["payee", conditions.payee],
    ["description", conditions.description],
  ] as const) {
    if (m?.op !== "regex") continue;
    const problem = regexProblem(m.value);
    if (problem) return { code: "invalid_regex", message: `The ${field} pattern: ${problem}` };
  }
  const amount = conditions.amount;
  if (amount) {
    if (amount.minCents === undefined && amount.maxCents === undefined) return { code: "invalid_amount_range", message: "An amount condition needs a minimum, a maximum or both" };
    if (amount.minCents !== undefined && amount.maxCents !== undefined && BigInt(amount.minCents) > BigInt(amount.maxCents)) {
      return { code: "invalid_amount_range", message: "The amount range's minimum is above its maximum (amounts are signed: spending is negative)" };
    }
  }
  return null;
}

/**
 * Why a stored rule does not run as written, for the Rules page (audit a6-text-rules-accounts,
 * second round): a pattern RE2 refuses (one saved before patterns ran on RE2, with look-around
 * or a back-reference), which never matches, and an amount range saved before the checks of
 * `ruleInputProblem` that cannot match or limits nothing. Empty for a rule that runs as written;
 * a pattern longer than the cap still runs, so it is not listed (an edit must shorten it).
 */
export function storedRuleProblems(conditions: RuleConditions): string[] {
  const out: string[] = [];
  for (const [field, m] of [
    ["payee", conditions.payee],
    ["description", conditions.description],
  ] as const) {
    if (m?.op !== "regex") continue;
    const refusal = re2Refusal(m.value);
    if (refusal !== null) out.push(`The ${field} pattern cannot run here (${refusal}), so this rule never matches. Edit it: look-ahead, look-behind and back-references are not supported.`);
  }
  const amount = conditions.amount;
  if (amount) {
    if (amount.minCents === undefined && amount.maxCents === undefined) out.push("The amount condition has no minimum or maximum, so it limits nothing. Edit it.");
    else if (amount.minCents !== undefined && amount.maxCents !== undefined && BigInt(amount.minCents) > BigInt(amount.maxCents)) {
      out.push("The amount range's minimum is above its maximum, so this rule never matches. Edit it (amounts are signed: spending is negative).");
    }
  }
  return out;
}

/** Case-insensitive comparison form: NFKC, Latin accents folded, lower case. */
function foldForMatch(text: string): string {
  return foldLatinAccents(text.normalize("NFKC")).toLowerCase();
}

type Fold = (text: string) => string;

/** A fold that remembers its answers for one evaluation (each row's payee and description are folded once, not once per rule). */
function memoFold(): Fold {
  const seen = new Map<string, string>();
  return (text) => {
    let out = seen.get(text);
    if (out === undefined) {
      out = foldForMatch(text);
      seen.set(text, out);
    }
    return out;
  };
}

/**
 * Whether `value` satisfies `cond`. Case-insensitive by default, where both sides are compared
 * in NFKC with Latin accents folded ("Café" equals "cafe", "İSTANBUL" contains "istanbul");
 * case-sensitive comparisons still use one Unicode spelling (NFC) of each side. Patterns run on
 * RE2 (linear time) over the NFC text.
 */
export function matchString(cond: StringMatch, value: string, fold: Fold = foldForMatch): boolean {
  const cs = cond.caseSensitive === true;
  if (cond.op === "regex") {
    const re = compilePattern(cond.value, cs);
    return re !== null && re.test(value.normalize("NFC"));
  }
  const a = cs ? value.normalize("NFC") : fold(value);
  const b = cs ? cond.value.normalize("NFC") : fold(cond.value);
  switch (cond.op) {
    case "equals":
      return a === b;
    case "contains":
      return a.includes(b);
    case "startsWith":
      return a.startsWith(b);
  }
}

function daysInMonthOf(date: IsoDate): number {
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();
}

/** Day-of-month range: a day past the month's end is its last day; min above max wraps past the end (28 to 3). */
function dayInRange(range: { min: number; max: number }, date: IsoDate): boolean {
  const last = daysInMonthOf(date);
  const min = Math.min(range.min, last);
  const max = Math.min(range.max, last);
  const d = dayOfMonth(date);
  return min <= max ? d >= min && d <= max : d >= min || d <= max;
}

export function ruleMatches(conditions: RuleConditions, ctx: RuleContext, fold: Fold = foldForMatch): boolean {
  if (conditions.payee) {
    const cond = conditions.payee;
    if (!matchString(cond, ctx.payee, fold) && !(ctx.payeeAliases ?? []).some((alias) => matchString(cond, alias, fold))) return false;
  }
  if (conditions.description && !matchString(conditions.description, ctx.description, fold)) return false;
  if (conditions.amount) {
    if (conditions.amount.minCents !== undefined && ctx.amountCents < BigInt(conditions.amount.minCents)) return false;
    if (conditions.amount.maxCents !== undefined && ctx.amountCents > BigInt(conditions.amount.maxCents)) return false;
  }
  if (conditions.accountId !== undefined && conditions.accountId !== ctx.accountId) return false;
  if (conditions.dayOfMonth && !dayInRange(conditions.dayOfMonth, ctx.date)) return false;
  return true;
}

export function evaluateRules(rules: readonly RuleLike[], input: RuleContext): RuleOutcome {
  const ordered = [...rules].filter((r) => r.enabled).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const ctx: RuleContext = { ...input };
  const outcome: RuleOutcome = { tags: [], matchedRuleIds: [] };
  const tagSet = new Set<string>();
  const fold = memoFold();

  for (const rule of ordered) {
    if (!ruleMatches(rule.conditions, ctx, fold)) continue;
    outcome.matchedRuleIds.push(rule.id);
    const a = rule.actions;
    if (a.setPayee !== undefined) {
      outcome.payee = a.setPayee;
      ctx.payee = a.setPayee;
      ctx.payeeAliases = [];
    }
    if (a.setCategoryId !== undefined) outcome.categoryId = a.setCategoryId;
    for (const t of a.addTags ?? []) tagSet.add(t);
    if (a.markTransfer !== undefined) outcome.transfer = a.markTransfer;
    if (a.stop) break;
  }

  outcome.tags = [...tagSet];
  return outcome;
}
