import { asc, eq, inArray } from "drizzle-orm";
import { AssetClass as AssetClassEnum, type AssetClass, type SecurityType } from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { security, securityAllocation } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";

/**
 * Blended-fund class splits (plan decision 16; views design §2.1, §3.6): `security.asset_class`
 * is the primary class and `security_allocation` rows (Σ 10 000 bp) refine it. Per security the
 * rows sum to exactly 10 000 or there are none (`400 split_sum`); when rows exist the primary
 * class is one of them (`400 split_primary`, it receives the truncation remainder); the cash
 * security is never split (`400 cash_security_reserved`). Audited as entity `security` with
 * before/after `{ assetClass, splits }`; nothing is written when they are equal.
 */

export const ASSET_CLASS_ORDER: readonly AssetClass[] = AssetClassEnum.options;

export function assetClassRank(c: AssetClass): number {
  return ASSET_CLASS_ORDER.indexOf(c);
}

export interface SecuritySplitRecord {
  assetClass: AssetClass;
  weightBp: number;
}

/** The `SecurityRef` fragment of the views contracts (no bigints). */
export interface SecurityRefRecord {
  securityId: string;
  ticker: string | null;
  name: string;
  type: SecurityType;
  assetClass: AssetClass;
  /** Enum order; empty = the primary class only. */
  splits: SecuritySplitRecord[];
  needsReview: boolean;
}

function sortSplits(splits: readonly SecuritySplitRecord[]): SecuritySplitRecord[] {
  return [...splits].sort((a, b) => assetClassRank(a.assetClass) - assetClassRank(b.assetClass));
}

/** Splits per security among `securityIds`, in enum order; securities without rows are absent. */
export async function loadSecuritySplits(db: DbOrTx, securityIds: readonly string[]): Promise<Map<string, SecuritySplitRecord[]>> {
  const out = new Map<string, SecuritySplitRecord[]>();
  const ids = [...new Set(securityIds)];
  if (ids.length === 0) return out;
  const rows = await db
    .select({ securityId: securityAllocation.securityId, assetClass: securityAllocation.assetClass, weightBp: securityAllocation.weightBp })
    .from(securityAllocation)
    .where(inArray(securityAllocation.securityId, ids))
    .orderBy(asc(securityAllocation.securityId));
  for (const r of rows) {
    const list = out.get(r.securityId) ?? [];
    list.push({ assetClass: r.assetClass, weightBp: r.weightBp });
    out.set(r.securityId, list);
  }
  for (const [id, list] of out) out.set(id, sortSplits(list));
  return out;
}

/**
 * The invariants of §2.1: distinct classes (400 `validation`), weights 1..10000 summing to
 * exactly 10 000 (400 `split_sum`), the primary class among them (400 `split_primary`).
 * `null` or `[]` means the primary class only. Returns the splits in enum order.
 */
export function validateSplits(assetClass: AssetClass, splits: readonly SecuritySplitRecord[] | null | undefined): SecuritySplitRecord[] {
  if (!splits || splits.length === 0) return [];
  const seen = new Set<AssetClass>();
  let sum = 0;
  for (const s of splits) {
    if (!Number.isInteger(s.weightBp) || s.weightBp < 1 || s.weightBp > 10000) throw new PlanError(400, "validation", "Each split weight is 1..10000 bp");
    if (seen.has(s.assetClass)) throw new PlanError(400, "validation", `Class ${s.assetClass} is listed twice`);
    seen.add(s.assetClass);
    sum += s.weightBp;
  }
  if (sum !== 10000) throw new PlanError(400, "split_sum", `Splits sum to ${sum} bp, not 10000`);
  if (!seen.has(assetClass)) throw new PlanError(400, "split_primary", `The primary class ${assetClass} must be one of the split classes`);
  return sortSplits(splits);
}

/** The `SecurityRef` of one security, with its splits. */
export async function securityRef(db: DbOrTx, securityId: string): Promise<SecurityRefRecord | undefined> {
  const [row] = await db
    .select({ id: security.id, ticker: security.ticker, name: security.name, type: security.type, assetClass: security.assetClass, needsReview: security.needsReview })
    .from(security)
    .where(eq(security.id, securityId));
  if (!row) return undefined;
  const splits = (await loadSecuritySplits(db, [securityId])).get(securityId) ?? [];
  return { securityId: row.id, ticker: row.ticker, name: row.name, type: row.type, assetClass: row.assetClass, splits, needsReview: row.needsReview };
}

export interface SetSecurityAllocationInput {
  assetClass: AssetClass;
  /** null or [] = the primary class only. */
  splits: readonly SecuritySplitRecord[] | null;
}

/**
 * `PUT /api/investments/securities/:id/allocation`: set the primary class and replace the
 * split rows in one transaction. 404 `not_found`; 400 `cash_security_reserved` for the cash
 * security; the §2.1 invariants. Audited as `security` (before/after `{ assetClass, splits }`),
 * skipped when nothing changed.
 */
export async function setSecurityAllocation(db: Db, securityId: string, input: SetSecurityAllocationInput, ctx: AuditContext): Promise<SecurityRefRecord> {
  const splits = validateSplits(input.assetClass, input.splits);
  return db.transaction(async (tx) => {
    const before = await securityRef(tx, securityId);
    if (!before) throw new PlanError(404, "not_found", "Security not found");
    if (before.type === "cash") throw new PlanError(400, "cash_security_reserved", "The cash security is always class cash and never split");
    const changed = before.assetClass !== input.assetClass || JSON.stringify(before.splits) !== JSON.stringify(splits);
    if (!changed) return before;
    if (before.assetClass !== input.assetClass) {
      await tx.update(security).set({ assetClass: input.assetClass, updatedAt: new Date() }).where(eq(security.id, securityId));
    }
    await tx.delete(securityAllocation).where(eq(securityAllocation.securityId, securityId));
    if (splits.length > 0) {
      await tx.insert(securityAllocation).values(splits.map((s) => ({ securityId, assetClass: s.assetClass, weightBp: s.weightBp })));
    }
    const after: SecurityRefRecord = { ...before, assetClass: input.assetClass, splits };
    await writeAudit(tx, {
      ...ctx,
      entity: "security",
      entityId: securityId,
      action: "update",
      before: { assetClass: before.assetClass, splits: before.splits },
      after: { assetClass: after.assetClass, splits: after.splits },
    });
    return after;
  });
}
