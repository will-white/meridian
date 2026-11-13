import { describe, expect, it } from "vitest";
import { evaluateRules, RuleActions, RuleConditions, ruleInputProblem, ruleMatches, type RuleLike } from "./rules.js";

const CAT_GROCERIES = "11111111-1111-4111-8111-111111111111";
const CAT_SHOPPING = "22222222-2222-4222-8222-222222222222";
const ACCT_CHECKING = "33333333-3333-4333-8333-333333333333";

function rule(id: string, position: number, conditions: RuleLike["conditions"], actions: RuleLike["actions"], enabled = true): RuleLike {
  return { id, position, enabled, conditions, actions };
}

const ctx = {
  payee: "King Soopers",
  description: "KING SOOPERS #0123 DENVER CO",
  amountCents: -4532n,
  accountId: ACCT_CHECKING,
  date: "2026-09-15",
};

describe("ruleMatches", () => {
  it("matches each string operator case-insensitively by default", () => {
    expect(ruleMatches({ payee: { op: "equals", value: "king soopers" } }, ctx)).toBe(true);
    expect(ruleMatches({ payee: { op: "contains", value: "soop" } }, ctx)).toBe(true);
    expect(ruleMatches({ payee: { op: "startsWith", value: "King" } }, ctx)).toBe(true);
    expect(ruleMatches({ description: { op: "regex", value: "^KING\\s+SOOPERS" } }, ctx)).toBe(true);
    expect(ruleMatches({ payee: { op: "equals", value: "king soopers", caseSensitive: true } }, ctx)).toBe(false);
  });

  it("treats an invalid regex as no match", () => {
    expect(ruleMatches({ payee: { op: "regex", value: "(" } }, ctx)).toBe(false);
  });

  it("checks signed amount ranges in cents", () => {
    expect(ruleMatches({ amount: { minCents: "-5000", maxCents: "-4000" } }, ctx)).toBe(true);
    expect(ruleMatches({ amount: { minCents: "-4000" } }, ctx)).toBe(false);
    expect(ruleMatches({ amount: { maxCents: "-5000" } }, ctx)).toBe(false);
  });

  it("checks account and day of month", () => {
    expect(ruleMatches({ accountId: ACCT_CHECKING }, ctx)).toBe(true);
    expect(ruleMatches({ accountId: CAT_GROCERIES }, ctx)).toBe(false);
    expect(ruleMatches({ dayOfMonth: { min: 10, max: 20 } }, ctx)).toBe(true);
    expect(ruleMatches({ dayOfMonth: { min: 1, max: 5 } }, ctx)).toBe(false);
  });

  it("requires every condition to hold", () => {
    expect(ruleMatches({ payee: { op: "equals", value: "King Soopers" }, amount: { maxCents: "-10000" } }, ctx)).toBe(false);
  });
});

describe("evaluateRules", () => {
  it("applies matching rules in position order and later rules override earlier ones", () => {
    const rules = [
      rule("b", 2, { payee: { op: "equals", value: "King Soopers" } }, { setCategoryId: CAT_SHOPPING }),
      rule("a", 1, { payee: { op: "equals", value: "King Soopers" } }, { setCategoryId: CAT_GROCERIES, addTags: ["food"] }),
    ];
    const out = evaluateRules(rules, ctx);
    expect(out.matchedRuleIds).toEqual(["a", "b"]);
    expect(out.categoryId).toBe(CAT_SHOPPING);
    expect(out.tags).toEqual(["food"]);
  });

  it("accumulates tags without duplicates", () => {
    const rules = [
      rule("a", 1, { payee: { op: "contains", value: "soopers" } }, { addTags: ["food", "weekly"] }),
      rule("b", 2, { accountId: ACCT_CHECKING }, { addTags: ["weekly", "checking"] }),
    ];
    expect(evaluateRules(rules, ctx).tags).toEqual(["food", "weekly", "checking"]);
  });

  it("skips disabled rules", () => {
    const rules = [rule("a", 1, { payee: { op: "equals", value: "King Soopers" } }, { setCategoryId: CAT_GROCERIES }, false)];
    expect(evaluateRules(rules, ctx).categoryId).toBeUndefined();
  });

  it("stops after a rule with stop", () => {
    const rules = [
      rule("a", 1, { payee: { op: "equals", value: "King Soopers" } }, { setCategoryId: CAT_GROCERIES, stop: true }),
      rule("b", 2, { payee: { op: "equals", value: "King Soopers" } }, { setCategoryId: CAT_SHOPPING }),
    ];
    const out = evaluateRules(rules, ctx);
    expect(out.categoryId).toBe(CAT_GROCERIES);
    expect(out.matchedRuleIds).toEqual(["a"]);
  });

  it("feeds a renamed payee to the rules after it", () => {
    const rules = [
      rule("a", 1, { description: { op: "contains", value: "AMZN" } }, { setPayee: "Amazon" }),
      rule("b", 2, { payee: { op: "equals", value: "Amazon" } }, { setCategoryId: CAT_SHOPPING }),
    ];
    const out = evaluateRules(rules, { ...ctx, payee: "Amzn Mktp", description: "AMZN MKTP US*1A2B3C" });
    expect(out.payee).toBe("Amazon");
    expect(out.categoryId).toBe(CAT_SHOPPING);
  });

  it("can mark a transfer and clear a category", () => {
    const rules = [rule("a", 1, { description: { op: "contains", value: "PAYMENT THANK YOU" } }, { markTransfer: true, setCategoryId: null })];
    const out = evaluateRules(rules, { ...ctx, description: "PAYMENT THANK YOU" });
    expect(out.transfer).toBe(true);
    expect(out.categoryId).toBeNull();
  });

  it("returns an empty outcome when nothing matches", () => {
    expect(evaluateRules([], ctx)).toEqual({ tags: [], matchedRuleIds: [] });
  });
});

describe("schemas", () => {
  it("rejects a rule with no conditions or no actions", () => {
    expect(RuleConditions.safeParse({}).success).toBe(false);
    expect(RuleActions.safeParse({}).success).toBe(false);
    expect(RuleActions.safeParse({ addTags: [] }).success).toBe(false);
    expect(RuleActions.safeParse({ setCategoryId: null }).success).toBe(true);
  });
});

describe("regular expressions run in linear time (a6-text-rules-accounts-04)", () => {
  it("answers a pattern with nested quantifiers at once instead of backtracking for minutes", () => {
    const cases: Array<[string, string]> = [
      ["^(\\w+\\s?)+$", "POS PURCHASE STARBUCKS STORE DENVER CO 1234!"],
      ["^(A+)+$", `${"A".repeat(5000)}!`],
      ["(x+x+)+y", "x".repeat(500)],
      ["^(a|aa)+$", `${"a".repeat(500)}b`],
    ];
    for (const [pattern, text] of cases) {
      const t0 = performance.now();
      expect(ruleMatches({ description: { op: "regex", value: pattern } }, { ...ctx, description: text })).toBe(false);
      expect(performance.now() - t0, pattern).toBeLessThan(250);
    }
    // Ordinary patterns keep working, case-insensitively by default.
    expect(ruleMatches({ description: { op: "regex", value: "^king\\s+soopers\\b" } }, ctx)).toBe(true);
    expect(ruleMatches({ description: { op: "regex", value: "^king", caseSensitive: true } }, ctx)).toBe(false);
    expect(ruleMatches({ description: { op: "regex", value: "#\\d{4}" } }, ctx)).toBe(true);
  });

  it("refuses a pattern that does not compile, uses look-around or back-references, or is too long", () => {
    expect(ruleInputProblem({ description: { op: "regex", value: "(" } }, { setCategoryId: CAT_GROCERIES })?.code).toBe("invalid_regex");
    expect(ruleInputProblem({ description: { op: "regex", value: "(?=x)" } }, { setCategoryId: CAT_GROCERIES })?.code).toBe("invalid_regex");
    expect(ruleInputProblem({ description: { op: "regex", value: "(a)\\1" } }, { setCategoryId: CAT_GROCERIES })?.code).toBe("invalid_regex");
    expect(ruleInputProblem({ payee: { op: "regex", value: "a".repeat(201) } }, { setCategoryId: CAT_GROCERIES })?.code).toBe("invalid_regex");
    expect(ruleInputProblem({ payee: { op: "regex", value: "^(\\w+\\s?)+$" } }, { setCategoryId: CAT_GROCERIES })).toBeNull();
    expect(ruleInputProblem({ payee: { op: "contains", value: "(" } }, { setCategoryId: CAT_GROCERIES })).toBeNull();
  });
});

describe("rules saved as written or refused (a6-text-rules-accounts-16)", () => {
  it("refuses an amount range without a bound or with its bounds the wrong way round", () => {
    expect(ruleInputProblem({ amount: {} }, { setCategoryId: CAT_GROCERIES })?.code).toBe("invalid_amount_range");
    expect(ruleInputProblem({ amount: { minCents: "1000", maxCents: "500" } }, { setCategoryId: CAT_GROCERIES })?.code).toBe("invalid_amount_range");
    expect(ruleInputProblem({ amount: { minCents: "-5000", maxCents: "-4000" } }, { setCategoryId: CAT_GROCERIES })).toBeNull();
    expect(ruleInputProblem({ amount: { maxCents: "0" } }, { setCategoryId: CAT_GROCERIES })).toBeNull();
  });

  it("reads a day range that wraps past the month end, and a day past the end as the last day", () => {
    const at = (date: string) => ({ ...ctx, date });
    const monthEnd = { dayOfMonth: { min: 28, max: 3 } };
    expect(ruleMatches(monthEnd, at("2026-09-28"))).toBe(true);
    expect(ruleMatches(monthEnd, at("2026-09-30"))).toBe(true);
    expect(ruleMatches(monthEnd, at("2026-10-02"))).toBe(true);
    expect(ruleMatches(monthEnd, at("2026-10-15"))).toBe(false);
    const last = { dayOfMonth: { min: 31, max: 31 } };
    expect(ruleMatches(last, at("2026-10-31"))).toBe(true);
    expect(ruleMatches(last, at("2026-11-30"))).toBe(true);
    expect(ruleMatches(last, at("2026-02-28"))).toBe(true);
    expect(ruleMatches(last, at("2028-02-28"))).toBe(false);
    expect(ruleMatches(last, at("2028-02-29"))).toBe(true);
    expect(ruleMatches(last, at("2026-11-29"))).toBe(false);
    expect(ruleMatches({ dayOfMonth: { min: 10, max: 20 } }, at("2026-09-15"))).toBe(true);
  });
});

describe("rule matching and Unicode (a6-text-rules-accounts-17)", () => {
  it("compares one spelling of an accented letter, folds Latin accents and the dotted capital I", () => {
    const nfd = "Cafe\u0301";
    expect(ruleMatches({ payee: { op: "equals", value: "Caf\u00E9" } }, { ...ctx, payee: nfd })).toBe(true);
    expect(ruleMatches({ payee: { op: "equals", value: "Caf\u00E9", caseSensitive: true } }, { ...ctx, payee: nfd })).toBe(true);
    expect(ruleMatches({ payee: { op: "equals", value: "cafe" } }, { ...ctx, payee: "Caf\u00E9" })).toBe(true);
    expect(ruleMatches({ description: { op: "contains", value: "istanbul" } }, { ...ctx, description: "\u0130STANBUL KEBAP" })).toBe(true);
    expect(ruleMatches({ payee: { op: "startsWith", value: "\u00C9cole" } }, { ...ctx, payee: "ecole du vin" })).toBe(true);
    // Accents of other scripts are letters, not decoration: they stay.
    expect(ruleMatches({ payee: { op: "equals", value: "\u0915" } }, { ...ctx, payee: "\u0915\u093F" })).toBe(false);
  });
});

describe("payee conditions and merged names (a6-text-rules-accounts-10)", () => {
  it("matches a payee condition on a name merged into the payee, until a rule renames it", () => {
    const merged = { ...ctx, payee: "Starbucks Store", payeeAliases: ["Sbux Mobile Order"] };
    const onVariant = rule("v", 1, { payee: { op: "equals", value: "Sbux Mobile Order" } }, { setCategoryId: CAT_GROCERIES });
    expect(evaluateRules([onVariant], merged).categoryId).toBe(CAT_GROCERIES);
    const rename = rule("r", 0, { payee: { op: "contains", value: "starbucks" } }, { setPayee: "Coffee Shop" });
    const renamed = evaluateRules([rename, onVariant], merged);
    expect(renamed.payee).toBe("Coffee Shop");
    expect(renamed.categoryId).toBeUndefined();
  });
});
