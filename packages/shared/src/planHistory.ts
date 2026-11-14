import type { AuditEntity } from "./enums.js";

/**
 * Undo for the plan's edit history (spec, Security: "edits to plans … keep history, so changes can
 * be reviewed and reverted"; Phase 2 plan decision 11 and audit decision A30; grid-and-api design
 * §Audit: "Revert is client-side: it re-sends `before` through the entity's normal edit endpoint …
 * Undo this fill-right = GET /audit?batchId= then one PUT with every cell's before"). Pure: the web
 * app's History panel builds its requests here, and the API tests feed them back through the routes.
 */

/** The entities the Plan page's history lists: plan cells, categories, groups, goals, recurring items, settings. */
export const PLAN_HISTORY_ENTITIES = ["month_plan", "category", "category_group", "savings_goal", "recurring", "household_setting"] as const satisfies readonly AuditEntity[];
export type PlanHistoryEntity = (typeof PLAN_HISTORY_ENTITIES)[number];

/** The fields of an audit entry an undo reads (`AuditEntryView` satisfies it). */
export interface UndoableEntry {
  id: string;
  at: string;
  batchId: string;
  entity: AuditEntity;
  entityId: string;
  action: "create" | "update" | "delete";
  before?: unknown;
  after?: unknown;
}

/** One `PUT /api/plan/cells` edit (the `PlanCellEdit` request shape). */
export interface PlanCellUndoEdit {
  month: string;
  categoryId: string;
  plannedCents: string | null;
  source: "manual" | "average";
  rolloverMode: "none" | "surplus_only" | "surplus_and_overspend" | null;
  carriedInOverrideCents: string | null;
  note: string | null;
}

/** A PATCH that puts an entity's changed fields back. */
export interface EntityRevertRequest {
  method: "PATCH";
  url: string;
  body: Record<string, unknown>;
}

export type EntityRevert = { ok: true; request: EntityRevertRequest } | { ok: false; reason: string };

/** `2026-11:<uuid>` → its month and category; null for anything else. */
export function parseCellEntityId(entityId: string): { month: string; categoryId: string } | null {
  const m = /^(\d{4}-(?:0[1-9]|1[0-2])):([0-9a-f-]{36})$/i.exec(entityId);
  return m ? { month: m[1]!, categoryId: m[2]! } : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Oldest first: by time, then the reverse of the API's newest-first order for entries of the same instant. */
function oldestFirst<T extends UndoableEntry>(entries: readonly T[]): T[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.at < b.e.at ? -1 : a.e.at > b.e.at ? 1 : b.i - a.i))
    .map(({ e }) => e);
}

const ROLLOVER = new Set(["none", "surplus_only", "surplus_and_overspend"]);

/**
 * The edits that put every plan cell of the entries back as it was before the earliest of them: a
 * cell the batch created is cleared (every column null, so the row goes and the automatic value
 * shows through again); a cell it changed or deleted gets its `before` columns back. A typed or
 * averaged value keeps its source; a value frozen from a recurring item or a goal (a completed
 * month's R or G) comes back with its amount as a typed value, the only source the route takes.
 */
export function planCellUndoEdits(entries: readonly UndoableEntry[]): PlanCellUndoEdit[] {
  const seen = new Set<string>();
  const out: PlanCellUndoEdit[] = [];
  for (const e of oldestFirst(entries)) {
    if (e.entity !== "month_plan" || seen.has(e.entityId)) continue;
    const cell = parseCellEntityId(e.entityId);
    if (!cell) continue;
    seen.add(e.entityId);
    const b = isRecord(e.before) ? e.before : null;
    const rollover = b ? str(b["rolloverMode"]) : null;
    out.push({
      ...cell,
      plannedCents: b ? str(b["plannedCents"]) : null,
      source: b && b["source"] === "average" ? "average" : "manual",
      rolloverMode: rollover !== null && ROLLOVER.has(rollover) ? (rollover as PlanCellUndoEdit["rolloverMode"]) : null,
      carriedInOverrideCents: b ? str(b["carriedInOverrideCents"]) : null,
      note: b ? str(b["note"]) : null,
    });
  }
  return out;
}

interface RevertSpec {
  url: (entityId: string) => string;
  /** Audit fields the entity's PATCH takes under the same name. */
  fields: readonly string[];
  /** Why a change of any other field cannot be put back here. */
  other: string;
}

const REVERTS: Partial<Record<AuditEntity, RevertSpec>> = {
  savings_goal: {
    url: (id) => `/goals/${id}`,
    fields: ["name", "categoryId", "targetCents", "targetDate", "linkedAccountId", "monthlyContributionCents", "startMonth", "startingCents", "status"],
    other: "",
  },
  household_setting: {
    url: () => "/settings",
    fields: ["planStartMonth", "zeroBased", "lowBalanceThresholdCents", "primaryAccountId", "projectionDefaultDays", "timezone", "benchmarkSecurityId", "investmentIncomeCategoryId", "rebalanceBandBp", "rebalanceMinTradeCents"],
    other: "",
  },
  category: {
    url: (id) => `/categories/${id}`,
    fields: ["name", "bucket", "hidden", "groupId", "rolloverMode", "rolloverFromMonth"],
    other: "a change of order is put back by dragging the category in Manage categories",
  },
  category_group: {
    url: (id) => `/category-groups/${id}`,
    fields: ["name", "hidden"],
    other: "a group's bucket and order are changed in Manage categories",
  },
  recurring: {
    url: (id) => `/recurring/${id}`,
    fields: ["name", "categoryId", "accountId", "transferAccountId", "cadence", "anchorDay", "anchorDay2", "anchorMonth", "anchorDate", "expectedCents", "toleranceCents", "amountMode", "notes", "status"],
    other: "the detector's own fields (the locks, the source, the reason for a status) follow the item's charges",
  },
};

/** The fields whose value differs between `before` and `after`, in `after`'s key order. */
export function changedFields(before: unknown, after: unknown): string[] {
  if (!isRecord(before) || !isRecord(after)) return [];
  const keys = [...new Set([...Object.keys(after), ...Object.keys(before)])];
  return keys.filter((k) => k !== "id" && JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
}

const RECURRING_PATCH_STATUSES = new Set(["active", "paused", "cancelled", "dismissed"]);

/**
 * The PATCH that puts an updated entity's changed fields back, or why it cannot be done from the
 * history (a create or a delete is not a field edit; some fields have their own controls).
 */
export function entityRevert(entry: UndoableEntry): EntityRevert {
  const spec = REVERTS[entry.entity];
  if (!spec) return { ok: false, reason: "not part of the plan's history" };
  if (entry.action !== "update") {
    return { ok: false, reason: entry.action === "create" ? "a new item is removed on its own page" : "a deleted item is created again on its own page" };
  }
  const before = isRecord(entry.before) ? entry.before : {};
  const changed = changedFields(entry.before, entry.after);
  if (changed.length === 0) return { ok: false, reason: "nothing changed" };
  const blocked = changed.filter((k) => !spec.fields.includes(k));
  if (blocked.length > 0) return { ok: false, reason: spec.other || `${blocked.join(", ")} cannot be put back here` };
  if (entry.entity === "recurring" && changed.includes("status") && !RECURRING_PATCH_STATUSES.has(String(before["status"]))) {
    return { ok: false, reason: "a suggestion that was confirmed or dismissed is not a suggestion again; change the item on the Recurring page" };
  }
  const body: Record<string, unknown> = {};
  for (const k of changed) body[k] = before[k] ?? null;
  return { ok: true, request: { method: "PATCH", url: spec.url(entry.entityId), body } };
}

export interface BatchUndo {
  /**
   * The entity PATCHes, newest change first (an undo stack: an entity changed twice in the batch
   * ends at its first `before`); sent before the cell edits, because a rollover change pins months.
   */
  requests: EntityRevertRequest[];
  /** One `PUT /plan/cells` with every cell's `before`; empty when the batch touched no cell. */
  cellEdits: PlanCellUndoEdit[];
  /** Why the batch cannot be undone from the history (empty when it can). */
  blocked: string[];
}

/**
 * How to undo one audit batch: every cell back to its `before` in one request, and every updated
 * entity back to its `before` through its PATCH route. A batch with an entry that cannot be put
 * back (a create or delete of a category, group, goal or recurring item; an order change) is
 * blocked as a whole, so an undo never leaves half a change behind.
 */
export function batchUndo(entries: readonly UndoableEntry[]): BatchUndo {
  const requests: EntityRevertRequest[] = [];
  const blocked: string[] = [];
  for (const e of oldestFirst(entries).reverse()) {
    if (e.entity === "month_plan") continue;
    const r = entityRevert(e);
    if (r.ok) requests.push(r.request);
    else blocked.push(r.reason);
  }
  return { requests, cellEdits: planCellUndoEdits(entries), blocked: [...new Set(blocked)] };
}
