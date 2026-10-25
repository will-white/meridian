import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { isInvestmentAccountType, type EngineWarning, type HoldingSource, type InvestmentFidelity, type IsoDate } from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { account, accountReconciliation, holdingSnapshot, lot, security } from "../schema/index.js";
import { accountPositionCheck } from "./lots.js";

/**
 * Derived fidelity (plan decision 7; seams C14, C17, C33): never stored. `hasTrades` /
 * `hasSnapshots` plus the engine's position check against the latest holding snapshot
 * (0.001-share tolerance, skipping the cash security, `asset_class = 'cash'` funds and
 * dollar-only rows); a mismatch demotes a full history to `positions` with a note.
 * `AccountView.investment` is this record stringified; non-investment types get null.
 */

export interface LastReconciliationRecord {
  id: string;
  statementDate: IsoDate;
  /** app − statement before the commit; null when the app had no value that day. */
  diffCents: bigint | null;
  reconciled: boolean;
  accepted: boolean;
  createdAt: Date;
}

export interface AccountFidelityRecord {
  accountId: string;
  fidelity: InvestmentFidelity;
  fidelityNote: string | null;
  /** The lots agree with the latest snapshot; null without trades or a snapshot to check. */
  positionsMatch: boolean | null;
  lastSnapshotDate: IsoDate | null;
  lastSnapshotSource: HoldingSource | null;
  lastTradeDate: IsoDate | null;
  /** Distinct securities in the latest snapshot set and in open lots. */
  securityCount: number;
  needsReviewCount: number;
  lastReconciliation: LastReconciliationRecord | null;
  /** The engine's `position_mismatch` warnings (the lots route and the performance warnings reuse them). */
  warnings: EngineWarning[];
  /** The snapshot date the lots were checked against; null when nothing was checked. */
  positionCheckDate: IsoDate | null;
}

/**
 * One record per investment-type account among `accountIds` (other types are left out, so
 * the caller maps a missing entry to null). The position check runs the engine per account
 * that has both trades and a snapshot.
 */
export async function accountFidelities(db: DbOrTx, accountIds: readonly string[]): Promise<Map<string, AccountFidelityRecord>> {
  const out = new Map<string, AccountFidelityRecord>();
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return out;
  const accounts = await db.select({ id: account.id, type: account.type }).from(account).where(inArray(account.id, ids));
  const investment = accounts.filter((a) => isInvestmentAccountType(a.type)).map((a) => a.id);
  if (investment.length === 0) return out;

  // Securities in each account's latest snapshot set.
  const latestDate = db
    .select({ accountId: holdingSnapshot.accountId, date: sql<string>`max(${holdingSnapshot.date})`.as("latest_date") })
    .from(holdingSnapshot)
    .where(inArray(holdingSnapshot.accountId, investment))
    .groupBy(holdingSnapshot.accountId)
    .as("latest");
  const snapshotSecurities = await db
    .select({ accountId: holdingSnapshot.accountId, securityId: holdingSnapshot.securityId, needsReview: security.needsReview })
    .from(holdingSnapshot)
    .innerJoin(latestDate, and(eq(latestDate.accountId, holdingSnapshot.accountId), eq(latestDate.date, holdingSnapshot.date)))
    .innerJoin(security, eq(security.id, holdingSnapshot.securityId));
  const lotSecurities = await db
    .select({ accountId: lot.accountId, securityId: lot.securityId, needsReview: security.needsReview })
    .from(lot)
    .innerJoin(security, eq(security.id, lot.securityId))
    .where(and(inArray(lot.accountId, investment), gt(lot.quantity, "0")));
  const securitiesByAccount = new Map<string, Map<string, boolean>>();
  for (const r of [...snapshotSecurities, ...lotSecurities]) {
    const m = securitiesByAccount.get(r.accountId) ?? new Map<string, boolean>();
    m.set(r.securityId, r.needsReview);
    securitiesByAccount.set(r.accountId, m);
  }

  const reconciliations = await db
    .selectDistinctOn([accountReconciliation.accountId], {
      accountId: accountReconciliation.accountId,
      id: accountReconciliation.id,
      statementDate: accountReconciliation.statementDate,
      diffCents: accountReconciliation.diffCents,
      reconciled: accountReconciliation.reconciled,
      accepted: accountReconciliation.accepted,
      createdAt: accountReconciliation.createdAt,
    })
    .from(accountReconciliation)
    .where(inArray(accountReconciliation.accountId, investment))
    .orderBy(accountReconciliation.accountId, desc(accountReconciliation.createdAt), desc(accountReconciliation.statementDate), desc(accountReconciliation.id));
  const reconciliationByAccount = new Map(reconciliations.map((r) => [r.accountId, r]));

  for (const accountId of investment) {
    const check = await accountPositionCheck(db, accountId);
    const securities = securitiesByAccount.get(accountId) ?? new Map<string, boolean>();
    const rec = reconciliationByAccount.get(accountId);
    out.set(accountId, {
      accountId,
      fidelity: check.fidelity,
      fidelityNote: check.fidelityNote,
      positionsMatch: check.positionsMatch,
      lastSnapshotDate: check.lastSnapshotDate,
      lastSnapshotSource: check.lastSnapshotSource,
      lastTradeDate: check.lastTradeDate,
      securityCount: securities.size,
      needsReviewCount: [...securities.values()].filter(Boolean).length,
      lastReconciliation: rec
        ? {
            id: rec.id,
            statementDate: rec.statementDate,
            diffCents: rec.diffCents,
            reconciled: rec.reconciled,
            accepted: rec.accepted,
            createdAt: rec.createdAt,
          }
        : null,
      warnings: check.warnings,
      positionCheckDate: check.hasTrades && check.hasSnapshots ? check.lastSnapshotDate : null,
    });
  }
  return out;
}
