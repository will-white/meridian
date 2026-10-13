import { describe, expect, it } from "vitest";
import { evaluateRules, RuleActions, RuleConditions, ruleMatches, type RuleLike } from "./rules.js";

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
