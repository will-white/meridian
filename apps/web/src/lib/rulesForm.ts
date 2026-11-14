import { formatCents, parseDecimalToCents, type AccountView, type AuditEntryView, type CategoryView, type RuleView } from "@meridian/shared";
import { fitsWire, TOO_LARGE_IN_SENTENCE } from "./amounts.js";

/**
 * The rule editor and the rule history (audit a6-text-rules-accounts-13): every condition and
 * action the rules engine has, a form state that round-trips a stored rule, and the request
 * that reverts one history entry through the normal edit routes.
 */

export type StringOp = "equals" | "contains" | "startsWith" | "regex";
export const STRING_OPS: ReadonlyArray<[StringOp, string]> = [
  ["contains", "contains"],
  ["equals", "is"],
  ["startsWith", "starts with"],
  ["regex", "matches pattern"],
];

export interface StringField {
  op: StringOp;
  value: string;
  caseSensitive: boolean;
}

export interface RuleForm {
  name: string;
  payee: StringField;
  description: StringField;
  /** Signed dollars as typed ("-50.00"); blank is no bound. */
  minAmount: string;
  maxAmount: string;
  accountId: string;
  /** "1".."31"; blank for no day condition. */
  dayMin: string;
  dayMax: string;
  setPayee: string;
  /** "" leave as is, "none" clear the category, or a category id. */
  setCategory: string;
  /** Comma-separated. */
  addTags: string;
  /** "" leave as is, "yes" mark as a transfer, "no" not a transfer. */
  markTransfer: "" | "yes" | "no";
  stop: boolean;
}

const emptyString = (): StringField => ({ op: "contains", value: "", caseSensitive: false });

export function emptyRuleForm(): RuleForm {
  return { name: "", payee: emptyString(), description: emptyString(), minAmount: "", maxAmount: "", accountId: "", dayMin: "", dayMax: "", setPayee: "", setCategory: "", addTags: "", markTransfer: "", stop: false };
}

/** The form for an existing rule. */
export function ruleFormFrom(rule: Pick<RuleView, "name" | "conditions" | "actions">): RuleForm {
  const c = rule.conditions;
  const a = rule.actions;
  const str = (m: RuleView["conditions"]["payee"]): StringField => (m ? { op: m.op, value: m.value, caseSensitive: m.caseSensitive === true } : emptyString());
  return {
    name: rule.name,
    payee: str(c.payee),
    description: str(c.description),
    minAmount: c.amount?.minCents !== undefined ? formatCents(BigInt(c.amount.minCents)) : "",
    maxAmount: c.amount?.maxCents !== undefined ? formatCents(BigInt(c.amount.maxCents)) : "",
    accountId: c.accountId ?? "",
    dayMin: c.dayOfMonth ? String(c.dayOfMonth.min) : "",
    dayMax: c.dayOfMonth ? String(c.dayOfMonth.max) : "",
    setPayee: a.setPayee ?? "",
    setCategory: a.setCategoryId === undefined ? "" : a.setCategoryId === null ? "none" : a.setCategoryId,
    addTags: (a.addTags ?? []).join(", "),
    markTransfer: a.markTransfer === undefined ? "" : a.markTransfer ? "yes" : "no",
    stop: a.stop === true,
  };
}

/** Signed cents of "-1,234.50", "$12", "-.5"; null for blank; undefined when it is not an amount. */
function signedCents(raw: string): bigint | null | undefined {
  let s = raw.replace(/[$,\s]/g, "");
  if (s === "") return null;
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (s.startsWith(".")) s = `0${s}`;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  const cents = parseDecimalToCents(s);
  return negative ? -cents : cents;
}

export type BuiltRule = { ok: true; name: string; conditions: RuleView["conditions"]; actions: RuleView["actions"] } | { ok: false; error: string };

/** The request parts for a form, or what is missing. The server checks the pattern and the category. */
export function buildRule(form: RuleForm): BuiltRule {
  const conditions: RuleView["conditions"] = {};
  for (const key of ["payee", "description"] as const) {
    const f = form[key];
    if (f.value.trim() === "") continue;
    conditions[key] = { op: f.op, value: f.op === "regex" ? f.value : f.value.trim(), ...(f.caseSensitive ? { caseSensitive: true } : {}) };
  }
  const min = signedCents(form.minAmount);
  const max = signedCents(form.maxAmount);
  if (min === undefined || max === undefined) return { ok: false, error: "An amount bound is not an amount (spending is negative, e.g. -50.00)" };
  if ((min !== null && !fitsWire(min)) || (max !== null && !fitsWire(max))) return { ok: false, error: `An amount bound is ${TOO_LARGE_IN_SENTENCE}` };
  if (min !== null && max !== null && min > max) return { ok: false, error: "The smallest amount is above the largest (spending is negative: -100.00 is below -20.00)" };
  if (min !== null || max !== null) conditions.amount = { ...(min !== null ? { minCents: min.toString() } : {}), ...(max !== null ? { maxCents: max.toString() } : {}) };
  if (form.accountId) conditions.accountId = form.accountId;
  if (form.dayMin !== "" || form.dayMax !== "") {
    const dMin = Number(form.dayMin || form.dayMax);
    const dMax = Number(form.dayMax || form.dayMin);
    if (![dMin, dMax].every((d) => Number.isInteger(d) && d >= 1 && d <= 31)) return { ok: false, error: "Days of the month are 1 to 31" };
    conditions.dayOfMonth = { min: dMin, max: dMax };
  }
  if (Object.keys(conditions).length === 0) return { ok: false, error: "Give the rule at least one condition" };

  const actions: RuleView["actions"] = {};
  if (form.setPayee.trim()) actions.setPayee = form.setPayee.trim();
  if (form.setCategory === "none") actions.setCategoryId = null;
  else if (form.setCategory) actions.setCategoryId = form.setCategory;
  const tags = [...new Set(form.addTags.split(",").map((t) => t.trim()).filter((t) => t.length > 0))];
  if (tags.length > 0) actions.addTags = tags;
  if (form.markTransfer) actions.markTransfer = form.markTransfer === "yes";
  if (Object.keys(actions).length === 0) return { ok: false, error: "Give the rule at least one thing to do" };
  if (form.stop) actions.stop = true;
  return { ok: true, name: form.name.trim(), conditions, actions };
}

/** A rule as the audit log keeps it (`ruleAuditJson` in the API). */
export interface RuleAuditJson {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  conditions: RuleView["conditions"];
  actions: RuleView["actions"];
}

function asRuleJson(v: unknown): RuleAuditJson | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Partial<RuleAuditJson>;
  return typeof o.id === "string" && typeof o.position === "number" && typeof o.conditions === "object" && typeof o.actions === "object" ? (o as RuleAuditJson) : null;
}

export type RevertStep =
  | { kind: "patch"; id: string; body: { name: string; enabled: boolean; conditions: RuleView["conditions"]; actions: RuleView["actions"] } }
  | { kind: "reorder"; ids: string[] }
  | { kind: "delete"; id: string }
  | { kind: "create"; body: { name: string; enabled: boolean; conditions: RuleView["conditions"]; actions: RuleView["actions"]; position: number; applyTo: "none" } };

export type RevertPlan = { ok: true; steps: RevertStep[] } | { ok: false; reason: string };

/**
 * How to undo one history entry through the normal routes (Phase 2 design: revert re-sends
 * `before`): a created rule is deleted; a deleted one is created again at its old position and
 * in its old state, without running over existing rows (`applyTo: "none"`); an edit is sent
 * back with PATCH, and a move goes back to its old place with a reorder.
 */
export function revertPlan(entry: Pick<AuditEntryView, "action" | "entityId" | "before" | "after">, rules: ReadonlyArray<Pick<RuleView, "id" | "position">>): RevertPlan {
  const exists = rules.some((r) => r.id === entry.entityId);
  if (entry.action === "create") {
    return exists ? { ok: true, steps: [{ kind: "delete", id: entry.entityId }] } : { ok: false, reason: "The rule was deleted since" };
  }
  const before = asRuleJson(entry.before);
  if (!before) return { ok: false, reason: "The entry has no earlier state" };
  const body = { name: before.name, enabled: before.enabled, conditions: before.conditions, actions: before.actions };
  if (entry.action === "delete") {
    if (exists) return { ok: false, reason: "The rule exists again" };
    return { ok: true, steps: [{ kind: "create", body: { ...body, position: before.position, applyTo: "none" } }] };
  }
  if (!exists) return { ok: false, reason: "The rule was deleted since; restore it from its delete entry" };
  const steps: RevertStep[] = [];
  const after = asRuleJson(entry.after);
  const edited = !after || JSON.stringify(body) !== JSON.stringify({ name: after.name, enabled: after.enabled, conditions: after.conditions, actions: after.actions });
  if (edited) steps.push({ kind: "patch", id: entry.entityId, body });
  const ordered = [...rules].sort((a, b) => a.position - b.position).map((r) => r.id);
  const at = ordered.indexOf(entry.entityId);
  const target = Math.min(Math.max(before.position, 1), ordered.length) - 1;
  if (at !== target) {
    ordered.splice(at, 1);
    ordered.splice(target, 0, entry.entityId);
    steps.push({ kind: "reorder", ids: ordered });
  }
  return steps.length > 0 ? { ok: true, steps } : { ok: false, reason: "Nothing to revert: the rule is as it was" };
}

/** One line for a history entry: what happened to which rule. */
export function describeRuleEntry(entry: Pick<AuditEntryView, "action" | "before" | "after">): string {
  const before = asRuleJson(entry.before);
  const after = asRuleJson(entry.after);
  const name = (r: RuleAuditJson | null) => (r?.name ? `"${r.name}"` : "an unnamed rule");
  if (entry.action === "create") return `created ${name(after)} at #${after?.position ?? "?"}`;
  if (entry.action === "delete") return `deleted ${name(before)} (was #${before?.position ?? "?"})`;
  const changes: string[] = [];
  if (before && after) {
    if (before.name !== after.name) changes.push("renamed");
    if (before.enabled !== after.enabled) changes.push(after.enabled ? "enabled" : "disabled");
    if (JSON.stringify(before.conditions) !== JSON.stringify(after.conditions)) changes.push("conditions changed");
    if (JSON.stringify(before.actions) !== JSON.stringify(after.actions)) changes.push("actions changed");
    if (before.position !== after.position) changes.push(`moved #${before.position} → #${after.position}`);
  }
  return `${name(after ?? before)}: ${changes.join(", ") || "edited"}`;
}

export interface RuleOption {
  value: string;
  label: string;
}

/**
 * The categories the rule editor offers (audit a8-ledger-ui-08): the visible ones, plus the
 * category the rule sets now when it is hidden ("(hidden)") or gone ("(deleted category: sets
 * nothing)"), so the select shows what the rule does and saving it untouched keeps it, as the
 * goal form does for its own category (b7-plan-ui-09).
 */
export function ruleCategoryOptions(categories: ReadonlyArray<Pick<CategoryView, "id" | "name" | "hidden">>, current: string): RuleOption[] {
  const out = categories.filter((c) => !c.hidden || c.id === current).map((c) => ({ value: c.id, label: c.hidden ? `${c.name} (hidden)` : c.name }));
  // An empty list is one that has not loaded yet: nothing is called deleted before it has.
  if (current !== "" && current !== "none" && categories.length > 0 && !categories.some((c) => c.id === current)) out.push({ value: current, label: "(deleted category: sets nothing)" });
  return out;
}

/** The accounts the editor offers: the open ones, plus the rule's own account when it is closed ("(closed)") or removed. */
export function ruleAccountOptions(accounts: ReadonlyArray<Pick<AccountView, "id" | "name" | "closed">>, current: string): RuleOption[] {
  const out = accounts.filter((a) => !a.closed || a.id === current).map((a) => ({ value: a.id, label: a.closed ? `${a.name} (closed)` : a.name }));
  if (current !== "" && accounts.length > 0 && !accounts.some((a) => a.id === current)) out.push({ value: current, label: "(removed account)" });
  return out;
}
