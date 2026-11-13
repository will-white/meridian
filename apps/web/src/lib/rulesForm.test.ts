import { describe, expect, it } from "vitest";
import { buildRule, describeRuleEntry, emptyRuleForm, revertPlan, ruleFormFrom } from "./rulesForm.js";

const CAT = "11111111-1111-4111-8111-111111111111";
const ACCT = "33333333-3333-4333-8333-333333333333";

describe("rule editor (a6-text-rules-accounts-13)", () => {
  it("builds every condition and action the engine has", () => {
    const form = {
      ...emptyRuleForm(),
      name: " Utilities ",
      payee: { op: "contains" as const, value: " xcel ", caseSensitive: false },
      description: { op: "regex" as const, value: "^XCEL\\s", caseSensitive: true },
      minAmount: "-$1,500.00",
      maxAmount: "-20",
      accountId: ACCT,
      dayMin: "28",
      dayMax: "3",
      setPayee: "Xcel Energy",
      setCategory: CAT,
      addTags: "house, utilities, house",
      markTransfer: "no" as const,
      stop: true,
    };
    expect(buildRule(form)).toEqual({
      ok: true,
      name: "Utilities",
      conditions: {
        payee: { op: "contains", value: "xcel" },
        description: { op: "regex", value: "^XCEL\\s", caseSensitive: true },
        amount: { minCents: "-150000", maxCents: "-2000" },
        accountId: ACCT,
        dayOfMonth: { min: 28, max: 3 },
      },
      actions: { setPayee: "Xcel Energy", setCategoryId: CAT, addTags: ["house", "utilities"], markTransfer: false, stop: true },
    });
  });

  it("round-trips a stored rule through the form", () => {
    const rule = {
      name: "Card payment",
      conditions: { description: { op: "contains" as const, value: "PAYMENT THANK YOU" }, amount: { minCents: "100" } },
      actions: { markTransfer: true, setCategoryId: null },
    };
    const built = buildRule(ruleFormFrom(rule));
    expect(built).toEqual({ ok: true, ...rule });
  });

  it("says what is missing or wrong", () => {
    expect(buildRule(emptyRuleForm())).toEqual({ ok: false, error: "Give the rule at least one condition" });
    expect(buildRule({ ...emptyRuleForm(), payee: { op: "equals", value: "Netflix", caseSensitive: false } })).toEqual({ ok: false, error: "Give the rule at least one thing to do" });
    expect(buildRule({ ...emptyRuleForm(), minAmount: "abc", setPayee: "x" }).ok).toBe(false);
    expect(buildRule({ ...emptyRuleForm(), minAmount: "-10", maxAmount: "-50", setPayee: "x" }).ok).toBe(false);
    expect(buildRule({ ...emptyRuleForm(), dayMin: "32", setPayee: "x" }).ok).toBe(false);
  });
});

describe("rule history and revert (a6-text-rules-accounts-13)", () => {
  const json = (id: string, position: number, over: Record<string, unknown> = {}) => ({ id, name: `rule ${id}`, position, enabled: true, conditions: { payee: { op: "contains", value: id } }, actions: { addTags: [id] }, ...over });
  const rules = [
    { id: "a", position: 1 },
    { id: "b", position: 2 },
    { id: "c", position: 3 },
  ];

  it("restores a deleted rule at its old position, in its old state, without running it", () => {
    const plan = revertPlan({ action: "delete", entityId: "d", before: json("d", 2, { enabled: false }), after: null }, rules);
    expect(plan).toEqual({
      ok: true,
      steps: [{ kind: "create", body: { name: "rule d", enabled: false, conditions: { payee: { op: "contains", value: "d" } }, actions: { addTags: ["d"] }, position: 2, applyTo: "none" } }],
    });
    expect(revertPlan({ action: "delete", entityId: "a", before: json("a", 1), after: null }, rules)).toEqual({ ok: false, reason: "The rule exists again" });
  });

  it("deletes a created rule, sends an edit back, and moves a rule back to its place", () => {
    expect(revertPlan({ action: "create", entityId: "b", before: null, after: json("b", 2) }, rules)).toEqual({ ok: true, steps: [{ kind: "delete", id: "b" }] });
    const edit = revertPlan({ action: "update", entityId: "b", before: json("b", 2), after: json("b", 2, { enabled: false }) }, rules);
    expect(edit).toEqual({ ok: true, steps: [{ kind: "patch", id: "b", body: { name: "rule b", enabled: true, conditions: { payee: { op: "contains", value: "b" } }, actions: { addTags: ["b"] } } }] });
    const move = revertPlan({ action: "update", entityId: "c", before: json("c", 1), after: json("c", 3) }, rules);
    expect(move).toEqual({ ok: true, steps: [{ kind: "reorder", ids: ["c", "a", "b"] }] });
    expect(revertPlan({ action: "update", entityId: "z", before: json("z", 1), after: json("z", 2) }, rules).ok).toBe(false);
  });

  it("describes each entry", () => {
    expect(describeRuleEntry({ action: "create", before: null, after: json("a", 1) })).toBe('created "rule a" at #1');
    expect(describeRuleEntry({ action: "delete", before: json("a", 4), after: null })).toBe('deleted "rule a" (was #4)');
    expect(describeRuleEntry({ action: "update", before: json("a", 1), after: json("a", 2, { enabled: false }) })).toBe('"rule a": disabled, moved #1 → #2');
  });
});
