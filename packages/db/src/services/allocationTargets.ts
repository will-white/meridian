import { asc, sql } from "drizzle-orm";
import type { AssetClass } from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { allocationTarget } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { assetClassRank } from "./securityAllocation.js";

/**
 * Household allocation targets (plan decision 16; imports design §2.8, §3.13): one row per
 * asset class, replaced as a whole set that sums to 10 000 bp or is empty (`400
 * allocation_sum`). Audited as `allocation_target` with entity id `household`; an identical
 * re-send writes nothing.
 */

export interface AllocationTargetRecord {
  assetClass: AssetClass;
  targetBp: number;
}

export interface AllocationTargetsRecord {
  /** Enum order; absent classes are 0. */
  targets: AllocationTargetRecord[];
  updatedAt: Date | null;
}

function sortTargets(targets: readonly AllocationTargetRecord[]): AllocationTargetRecord[] {
  return [...targets].sort((a, b) => assetClassRank(a.assetClass) - assetClassRank(b.assetClass));
}

export async function getAllocationTargets(db: DbOrTx): Promise<AllocationTargetsRecord> {
  const rows = await db.select().from(allocationTarget).orderBy(asc(allocationTarget.assetClass));
  let updatedAt: Date | null = null;
  for (const r of rows) if (updatedAt === null || r.updatedAt > updatedAt) updatedAt = r.updatedAt;
  return { targets: sortTargets(rows.map((r) => ({ assetClass: r.assetClass, targetBp: r.targetBp }))), updatedAt };
}

/** Distinct classes (400 `validation`), 0..10000 each, non-empty sets summing to 10 000 (400 `allocation_sum`). */
export function validateAllocationTargets(targets: readonly AllocationTargetRecord[]): AllocationTargetRecord[] {
  const seen = new Set<AssetClass>();
  let sum = 0;
  for (const t of targets) {
    if (!Number.isInteger(t.targetBp) || t.targetBp < 0 || t.targetBp > 10000) throw new PlanError(400, "validation", "Each target is 0..10000 bp");
    if (seen.has(t.assetClass)) throw new PlanError(400, "validation", `Class ${t.assetClass} is listed twice`);
    seen.add(t.assetClass);
    sum += t.targetBp;
  }
  if (targets.length > 0 && sum !== 10000) throw new PlanError(400, "allocation_sum", `Targets sum to ${sum} bp, not 10000`);
  return sortTargets(targets);
}

/** Replace the table as a whole set in one transaction; `[]` clears it. */
export async function setAllocationTargets(db: Db, targets: readonly AllocationTargetRecord[], ctx: AuditContext): Promise<AllocationTargetsRecord> {
  const next = validateAllocationTargets(targets);
  return db.transaction(async (tx) => {
    const before = await getAllocationTargets(tx);
    if (JSON.stringify(before.targets) === JSON.stringify(next)) return before;
    await tx.delete(allocationTarget);
    if (next.length > 0) {
      await tx.insert(allocationTarget).values(next.map((t) => ({ assetClass: t.assetClass, targetBp: t.targetBp, updatedAt: sql`now()` })));
    }
    await writeAudit(tx, { ...ctx, entity: "allocation_target", entityId: "household", action: "update", before: before.targets, after: next });
    return getAllocationTargets(tx);
  });
}
