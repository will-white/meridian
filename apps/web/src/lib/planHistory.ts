import { parseCellEntityId, type AuditEntryView } from "@meridian/shared";
import { money, shortDate } from "./format.js";
import { ROLLOVER_LABELS, monthLabel } from "./plan.js";

/**
 * Pure helpers for the Plan page's history panel (audit finding b9-conformance-plan-investments-03;
 * Phase 2 plan audit decision A30): the audit entries of the plan's entities grouped into the
 * batches they were written in (one batch per request: a fill-right, a plan-from-average, a goal
 * edit), and a sentence per entry. The undo itself is `batchUndo` in @meridian/shared.
 */

export interface HistoryBatch {
  batchId: string;
  /** The newest entry's time. */
  at: string;
  username: string | null;
  /** Newest first, as listed. */
  entries: AuditEntryView[];
}

/** Consecutive entries of one batch form one group (the list is newest first, so a batch's entries are adjacent). */
export function groupBatches(items: readonly AuditEntryView[]): HistoryBatch[] {
  const out: HistoryBatch[] = [];
  for (const e of items) {
    const last = out[out.length - 1];
    if (last && last.batchId === e.batchId) last.entries.push(e);
    else out.push({ batchId: e.batchId, at: e.at, username: e.username, entries: [e] });
  }
  return out;
}

/** "11/13/26 4:05 PM" in the browser's time zone. */
export function historyTime(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  let h = d.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${shortDate(at)} ${h}:${String(d.getMinutes()).padStart(2, "0")} ${ampm}`;
}

export interface HistoryNames {
  category: (id: string) => string | undefined;
  group?: (id: string) => string | undefined;
  account?: (id: string) => string | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A plan cell's state in words: "$250.00", "$118.00 (average)", "automatic". */
function plannedText(state: Record<string, unknown> | null): string {
  if (!state || state["plannedCents"] === null || state["plannedCents"] === undefined) return "automatic";
  const cents = money(String(state["plannedCents"]));
  const source = state["source"];
  return source === "average" ? `${cents} (average)` : source === "recurring" ? `${cents} (frozen from recurring)` : source === "goal" ? `${cents} (frozen from the goal)` : cents;
}

function cellSentence(e: AuditEntryView, names: HistoryNames): string {
  const cell = parseCellEntityId(e.entityId);
  const where = cell ? `${names.category(cell.categoryId) ?? "A category"} · ${monthLabel(cell.month)}` : e.entityId;
  const before = isRecord(e.before) ? e.before : null;
  const after = isRecord(e.after) ? e.after : null;
  const parts: string[] = [];
  if (plannedText(before) !== plannedText(after)) parts.push(`planned ${plannedText(after)} (was ${plannedText(before)})`);
  const pin = (s: Record<string, unknown> | null) => (s && typeof s["rolloverMode"] === "string" ? (ROLLOVER_LABELS[s["rolloverMode"] as keyof typeof ROLLOVER_LABELS] ?? String(s["rolloverMode"])) : null);
  if (pin(before) !== pin(after)) parts.push(pin(after) === null ? "rollover no longer pinned" : `rollover pinned to "${pin(after)}"`);
  const override = (s: Record<string, unknown> | null) => (s && s["carriedInOverrideCents"] != null ? money(String(s["carriedInOverrideCents"])) : null);
  if (override(before) !== override(after)) parts.push(override(after) === null ? "carried-in override removed" : `carried in set to ${override(after)}`);
  const note = (s: Record<string, unknown> | null) => (s && typeof s["note"] === "string" ? s["note"] : null);
  if (note(before) !== note(after)) parts.push(note(after) === null ? "note removed" : `note "${note(after)}"`);
  return `${where}: ${parts.join("; ") || "unchanged"}`;
}

const ENTITY_LABELS: Partial<Record<AuditEntryView["entity"], string>> = {
  category: "Category",
  category_group: "Group",
  savings_goal: "Goal",
  recurring: "Recurring",
  household_setting: "Settings",
};

const FIELD_LABELS: Record<string, string> = {
  planStartMonth: "plan start",
  zeroBased: "zero-based",
  lowBalanceThresholdCents: "low-balance threshold",
  primaryAccountId: "primary account",
  projectionDefaultDays: "projection days",
  benchmarkSecurityId: "benchmark",
  investmentIncomeCategoryId: "investment income category",
  rebalanceBandBp: "rebalance band (bp)",
  rebalanceMinTradeCents: "minimum trade",
  rolloverMode: "rollover",
  rolloverFromMonth: "rollover from",
  groupId: "group",
  categoryId: "category",
  accountId: "account",
  transferAccountId: "transfer account",
  monthlyContributionCents: "monthly contribution",
  targetCents: "target",
  targetDate: "target date",
  startingCents: "starting amount",
  startMonth: "start month",
  linkedAccountId: "linked account",
  expectedCents: "expected amount",
  toleranceCents: "tolerance",
  amountMode: "amount",
};

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/([A-Z])/g, " $1").toLowerCase();
}

function valueText(key: string, value: unknown, names: HistoryNames): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (key.endsWith("Cents")) return money(String(value));
  if (key === "rolloverMode" && typeof value === "string") return ROLLOVER_LABELS[value as keyof typeof ROLLOVER_LABELS] ?? value;
  if ((key.endsWith("Month") || key === "rolloverFromMonth") && typeof value === "string") return monthLabel(value);
  if (key.endsWith("Date") && typeof value === "string") return shortDate(value);
  if (typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)) {
    const name = key === "categoryId" || key.endsWith("CategoryId") ? names.category(value) : key === "groupId" ? names.group?.(value) : key.endsWith("AccountId") || key === "accountId" ? names.account?.(value) : undefined;
    return name ?? "another one";
  }
  return String(value);
}

/** One entry in words: "Dining · Nov 2026: planned $250.00 (was automatic)", "Goal Emergency fund: monthly contribution $500.00 → $400.00". */
export function describeEntry(e: AuditEntryView, names: HistoryNames): string {
  if (e.entity === "month_plan") return cellSentence(e, names);
  const before = isRecord(e.before) ? e.before : {};
  const after = isRecord(e.after) ? e.after : {};
  const label = ENTITY_LABELS[e.entity] ?? e.entity;
  const name = typeof after["name"] === "string" ? after["name"] : typeof before["name"] === "string" ? before["name"] : null;
  const subject = e.entity === "household_setting" ? label : `${label} ${name ?? ""}`.trim();
  if (e.action === "create") return `${subject} created`;
  if (e.action === "delete") return `${subject} deleted`;
  const keys = [...new Set([...Object.keys(after), ...Object.keys(before)])].filter((k) => k !== "id" && JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
  if (keys.length === 0) return `${subject}: unchanged`;
  return `${subject}: ${keys.map((k) => `${fieldLabel(k)} ${valueText(k, before[k], names)} → ${valueText(k, after[k], names)}`).join("; ")}`;
}

/** Whether a later entry (newer than the batch) changed something the batch changed: undoing it then also undoes that. */
export function laterChanges(batch: HistoryBatch, newer: readonly AuditEntryView[]): number {
  const ids = new Set(batch.entries.map((e) => `${e.entity}:${e.entityId}`));
  return newer.filter((e) => e.batchId !== batch.batchId && ids.has(`${e.entity}:${e.entityId}`)).length;
}
