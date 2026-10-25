import { and, asc, desc, eq, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import {
  centsToFixed8,
  FIXED8_SCALE,
  fixed8ToCents,
  formatFixed8,
  impliedPrice,
  isCashKey,
  isInvestmentAccountType,
  isIsoDate,
  matchesToDollar,
  mulToCents,
  type Fixed8,
  type HoldingSource,
  type IsoDate,
  type SecurityChoice,
  type SecurityType,
} from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { account, balanceSnapshot, connection, holdingSnapshot, price, security } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { qtyFromDb, qtyToDb } from "./decimalDb.js";
import { enqueueJob } from "./jobs.js";
import { upsertPrices } from "./prices.js";
import { cashSecurity, createSecurity, HOLDING_SOURCE_RANK, requireSecurity, resolveSecurity } from "./securities.js";

/**
 * Holding snapshots (imports design §3.4, §3.5, §3.10 under plan decisions 9, 10 and 14;
 * seams C34, C40, C41). `replaceHoldingSnapshot` is the only writer of `holding_snapshot`
 * rows: one (account, date) set at a time, under the precedence manual > csv > simplefin,
 * writing the balance row (`statementTotalCents ?? Σ positions`) for accounts without a
 * SimpleFIN feed and on request for fed ones. `rebuildImpliedPrices` is the only writer of
 * implied price rows: one per (security, date) from the snapshot rows, the largest value
 * winning a same-date tie, then the lowest account id. The positions editor and the
 * snapshot delete are the owner's audited paths; importers record themselves in `import_log`.
 */

export type HoldingSnapshotRow = typeof holdingSnapshot.$inferSelect;

export interface SnapshotPosition {
  securityId: string;
  /** Null = dollar-only (value known, units not reported). */
  quantity: Fixed8 | null;
  /** As reported; derived as `impliedPrice(value, quantity)` when absent and the quantity is non-zero. */
  price: Fixed8 | null;
  valueCents: bigint;
  reportedCostBasisCents: bigint | null;
}

export interface ReplaceHoldingSnapshotInput {
  accountId: string;
  /** The statement's or feed's as-of date, never "today". */
  date: IsoDate;
  source: HoldingSource;
  importLogId?: string | null;
  positions: readonly SnapshotPosition[];
  /** Default: the account has no SimpleFIN connection. */
  setBalance?: boolean;
  /** The statement's own total; the balance row is `statementTotalCents ?? Σ positions` (seams C40). */
  statementTotalCents?: bigint | null;
  today: IsoDate;
}

export interface ReplaceHoldingSnapshotResult {
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
  totalValueCents: bigint;
  /** SimpleFIN-fed accounts: the latest Bridge balance on or before the date; else null. */
  knownBalanceCents: bigint | null;
  differenceCents: bigint | null;
  matchesToDollar: boolean | null;
  balanceWritten: boolean;
  /** The balance row's value when written. */
  balanceCents: bigint | null;
  /** Securities in the set before or after (for the implied-price rebuild). */
  securityIds: string[];
  simplefinFed: boolean;
}

// ---- Account helpers ----

export interface InvestmentAccountRow {
  id: string;
  name: string;
  type: (typeof account.$inferSelect)["type"];
  closed: boolean;
  balanceCents: bigint | null;
  balanceDate: IsoDate | null;
  /** `connection_id` set and the connection's type is `simplefin`. */
  simplefinFed: boolean;
}

/** The account, which must be an investment type (400 `not_investment_account`). */
export async function loadInvestmentAccount(tx: DbOrTx, accountId: string): Promise<InvestmentAccountRow> {
  const [row] = await tx
    .select({
      id: account.id,
      name: account.name,
      type: account.type,
      closed: account.closed,
      balanceCents: account.balanceCents,
      balanceDate: account.balanceDate,
      connectionType: connection.type,
    })
    .from(account)
    .leftJoin(connection, eq(connection.id, account.connectionId))
    .where(eq(account.id, accountId));
  if (!row) throw new PlanError(404, "not_found", "Account not found");
  if (!isInvestmentAccountType(row.type)) throw new PlanError(400, "not_investment_account", `${row.name} is a ${row.type} account`);
  const { connectionType, ...rest } = row;
  return { ...rest, simplefinFed: connectionType === "simplefin" };
}

/** The latest SimpleFIN balance on or before `date`, the number an import is compared to. */
async function knownSimplefinBalance(tx: DbOrTx, accountId: string, date: IsoDate): Promise<bigint | null> {
  const [row] = await tx
    .select({ balanceCents: balanceSnapshot.balanceCents })
    .from(balanceSnapshot)
    .where(and(eq(balanceSnapshot.accountId, accountId), eq(balanceSnapshot.source, "simplefin"), lte(balanceSnapshot.date, date)))
    .orderBy(desc(balanceSnapshot.date))
    .limit(1);
  return row?.balanceCents ?? null;
}

/**
 * Upsert a reported balance row under the snapshot precedence (manual > csv > simplefin,
 * `computed` always replaced). Returns false when a higher-ranked row kept the date.
 */
export async function writeReportedBalance(tx: DbOrTx, accountId: string, date: IsoDate, balanceCents: bigint, source: HoldingSource): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into balance_snapshot (account_id, date, balance_cents, source)
    values (${accountId}::uuid, ${date}::date, ${balanceCents.toString()}::bigint, ${source})
    on conflict (account_id, date) do update set balance_cents = excluded.balance_cents, source = excluded.source
    where (case excluded.source when 'manual' then 3 when 'csv' then 2 when 'simplefin' then 1 else 0 end)
       >= (case balance_snapshot.source when 'manual' then 3 when 'csv' then 2 when 'simplefin' then 1 else 0 end)
    returning id
  `);
  return rows.length > 0;
}

// ---- The one snapshot writer ----

function normalizePositions(positions: readonly SnapshotPosition[]): SnapshotPosition[] {
  const seen = new Set<string>();
  const out: SnapshotPosition[] = [];
  for (const p of positions) {
    if (seen.has(p.securityId)) throw new PlanError(400, "validation", "A snapshot lists each security once; aggregate first");
    seen.add(p.securityId);
    const zeroQuantity = p.quantity === null || p.quantity === 0n;
    if (zeroQuantity && p.valueCents === 0n) continue;
    const priceValue = zeroQuantity ? null : (p.price ?? impliedPrice(p.valueCents, p.quantity!));
    if (priceValue !== null && priceValue < 0n) throw new PlanError(400, "validation", "price must not be negative");
    out.push({ securityId: p.securityId, quantity: p.quantity, price: priceValue, valueCents: p.valueCents, reportedCostBasisCents: p.reportedCostBasisCents });
  }
  return out;
}

/**
 * Replace the (account, date) snapshot set (§3.4): `date ≤ today` (400 `future_date`); an
 * existing set from a higher-ranked source refuses the write (409 `snapshot_precedence`);
 * rows are inserted, updated only when a column differs, or deleted when absent from the
 * set, so the same set written twice changes nothing. The balance row is written for
 * accounts without a SimpleFIN feed (and on request for fed ones) and `account.balance_*`
 * follows when the date is the newest. The caller writes stats or the audit entry.
 */
export async function replaceHoldingSnapshot(tx: DbOrTx, input: ReplaceHoldingSnapshotInput): Promise<ReplaceHoldingSnapshotResult> {
  if (!isIsoDate(input.date)) throw new PlanError(400, "validation", "date must be YYYY-MM-DD");
  if (input.date > input.today) throw new PlanError(400, "future_date", `${input.date} is after today`);
  const acct = await loadInvestmentAccount(tx, input.accountId);
  const positions = normalizePositions(input.positions);
  const ids = positions.map((p) => p.securityId);
  if (ids.length > 0) {
    const found = await tx.select({ id: security.id }).from(security).where(inArray(security.id, ids));
    if (found.length !== ids.length) throw new PlanError(404, "not_found", "Security not found");
  }

  const existing = await tx
    .select()
    .from(holdingSnapshot)
    .where(and(eq(holdingSnapshot.accountId, input.accountId), eq(holdingSnapshot.date, input.date)));
  const rank = HOLDING_SOURCE_RANK[input.source];
  const outranking = existing.find((r) => HOLDING_SOURCE_RANK[r.source] > rank);
  if (outranking) throw new PlanError(409, "snapshot_precedence", `A ${outranking.source} snapshot already exists for ${input.date}`);

  const byId = new Map(existing.map((r) => [r.securityId, r]));
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const p of positions) {
    const row = byId.get(p.securityId);
    if (!row) {
      await tx.insert(holdingSnapshot).values({
        accountId: input.accountId,
        securityId: p.securityId,
        date: input.date,
        quantity: qtyToDb(p.quantity),
        price: qtyToDb(p.price),
        valueCents: p.valueCents,
        reportedCostBasisCents: p.reportedCostBasisCents,
        source: input.source,
        importLogId: input.importLogId ?? null,
      });
      inserted++;
      continue;
    }
    const same =
      qtyFromDb(row.quantity) === p.quantity &&
      qtyFromDb(row.price) === p.price &&
      row.valueCents === p.valueCents &&
      row.reportedCostBasisCents === p.reportedCostBasisCents &&
      row.source === input.source;
    if (same) {
      unchanged++;
      continue;
    }
    await tx
      .update(holdingSnapshot)
      .set({
        quantity: qtyToDb(p.quantity),
        price: qtyToDb(p.price),
        valueCents: p.valueCents,
        reportedCostBasisCents: p.reportedCostBasisCents,
        source: input.source,
        importLogId: input.importLogId ?? row.importLogId,
        updatedAt: new Date(),
      })
      .where(eq(holdingSnapshot.id, row.id));
    updated++;
  }
  const keep = new Set(ids);
  const stale = existing.filter((r) => !keep.has(r.securityId));
  if (stale.length > 0) {
    await tx.delete(holdingSnapshot).where(
      inArray(
        holdingSnapshot.id,
        stale.map((r) => r.id),
      ),
    );
  }

  const totalValueCents = positions.reduce((acc, p) => acc + p.valueCents, 0n);
  const knownBalanceCents = acct.simplefinFed ? await knownSimplefinBalance(tx, input.accountId, input.date) : null;
  const differenceCents = knownBalanceCents === null ? null : totalValueCents - knownBalanceCents;
  const setBalance = input.setBalance ?? !acct.simplefinFed;
  let balanceWritten = false;
  let balanceCents: bigint | null = null;
  if (setBalance) {
    balanceCents = input.statementTotalCents ?? totalValueCents;
    balanceWritten = await writeReportedBalance(tx, input.accountId, input.date, balanceCents, input.source);
    if (balanceWritten && (acct.balanceDate === null || input.date >= acct.balanceDate)) {
      await tx.update(account).set({ balanceCents, balanceDate: input.date, updatedAt: new Date() }).where(eq(account.id, input.accountId));
    }
  }
  return {
    inserted,
    updated,
    unchanged,
    deleted: stale.length,
    totalValueCents,
    knownBalanceCents,
    differenceCents,
    matchesToDollar: differenceCents === null ? null : matchesToDollar(differenceCents),
    balanceWritten,
    balanceCents,
    securityIds: [...new Set([...existing.map((r) => r.securityId), ...ids])].sort(),
    simplefinFed: acct.simplefinFed,
  };
}

// ---- Implied prices ----

export interface RebuildImpliedPricesScope {
  securityIds?: readonly string[];
  dates?: readonly IsoDate[];
}

export interface RebuildImpliedPricesResult {
  /** Implied rows inserted or changed. */
  written: number;
  /** Implied rows in scope no snapshot row derives any more. */
  removed: number;
}

/**
 * The one implied-price writer (§3.5; seams C34): for every (security, date) with a
 * snapshot row carrying a non-zero quantity and a price, on a non-cash security, upsert an
 * `implied` close under the precedence rule. Several accounts on one date: the row with the
 * largest `value_cents` wins, ties by `account_id` ascending, so the result never depends on
 * import order. Implied rows in the scope that no snapshot row derives any more are removed
 * (a deleted or replaced snapshot takes its prices with it); provider and manual rows are
 * never touched. Idempotent: a second run writes nothing.
 */
export async function rebuildImpliedPrices(tx: DbOrTx, scope: RebuildImpliedPricesScope = {}): Promise<RebuildImpliedPricesResult> {
  const ids = scope.securityIds ? [...new Set(scope.securityIds)] : null;
  const dates = scope.dates ? [...new Set(scope.dates)] : null;
  if ((ids && ids.length === 0) || (dates && dates.length === 0)) return { written: 0, removed: 0 };
  const rows = await tx
    .select({ securityId: holdingSnapshot.securityId, date: holdingSnapshot.date, price: holdingSnapshot.price })
    .from(holdingSnapshot)
    .innerJoin(security, eq(security.id, holdingSnapshot.securityId))
    .where(
      and(
        ne(security.type, "cash"),
        isNotNull(holdingSnapshot.quantity),
        sql`${holdingSnapshot.quantity} <> 0`,
        isNotNull(holdingSnapshot.price),
        ids ? inArray(holdingSnapshot.securityId, ids) : undefined,
        dates ? inArray(holdingSnapshot.date, dates) : undefined,
      ),
    )
    .orderBy(asc(holdingSnapshot.securityId), asc(holdingSnapshot.date), desc(holdingSnapshot.valueCents), asc(holdingSnapshot.accountId));
  const winners = new Map<string, { securityId: string; date: IsoDate; close: Fixed8 }>();
  for (const r of rows) {
    const key = `${r.securityId}|${r.date}`;
    if (!winners.has(key)) winners.set(key, { securityId: r.securityId, date: r.date, close: qtyFromDb(r.price)! });
  }
  const result = await upsertPrices(
    tx,
    [...winners.values()].map((w) => ({ securityId: w.securityId, date: w.date, close: w.close, source: "implied" as const })),
  );
  const implied = await tx
    .select({ id: price.id, securityId: price.securityId, date: price.date })
    .from(price)
    .where(and(eq(price.source, "implied"), ids ? inArray(price.securityId, ids) : undefined, dates ? inArray(price.date, dates) : undefined));
  const orphans = implied.filter((p) => !winners.has(`${p.securityId}|${p.date}`)).map((p) => p.id);
  if (orphans.length > 0) await tx.delete(price).where(inArray(price.id, orphans));
  return { written: result.inserted + result.updated, removed: orphans.length };
}

// ---- Valuation job ----

/** Queue the `investments.valuation` job (plan decision 9), deduped per account (or household-wide without one). */
export async function requestValuation(tx: DbOrTx, req: { reason: string; accountId?: string }): Promise<{ jobId: string; created: boolean }> {
  const dedupeKey = req.accountId ? `investments.valuation:${req.accountId}` : "investments.valuation";
  const payload: Record<string, unknown> = { reason: req.reason, dedupeKey };
  if (req.accountId) payload["accountId"] = req.accountId;
  const row = await enqueueJob(tx, "investments.valuation", payload, { dedupe: true });
  return { jobId: row.id, created: row.created };
}

// ---- Reads ----

export interface HoldingSnapshotRowRecord {
  securityId: string;
  ticker: string | null;
  name: string;
  type: SecurityType;
  quantity: Fixed8 | null;
  price: Fixed8 | null;
  valueCents: bigint;
  reportedCostBasisCents: bigint | null;
}

/** Bigint twin of `HoldingSnapshotView`. */
export interface HoldingSnapshotRecord {
  accountId: string;
  date: IsoDate;
  source: HoldingSource;
  importLogId: string | null;
  rows: HoldingSnapshotRowRecord[];
  totalValueCents: bigint;
  knownBalanceCents: bigint | null;
  differenceCents: bigint | null;
  matchesToDollar: boolean | null;
  updatedAt: Date;
}

export interface SnapshotSummary {
  date: IsoDate;
  source: HoldingSource;
  positions: number;
  totalValueCents: bigint;
}

/** One (account, date) set with its securities; the Bridge comparison for SimpleFIN-fed accounts. */
export async function getSnapshot(db: DbOrTx, accountId: string, date: IsoDate): Promise<HoldingSnapshotRecord | undefined> {
  const rows = await db
    .select({ row: holdingSnapshot, ticker: security.ticker, name: security.name, type: security.type })
    .from(holdingSnapshot)
    .innerJoin(security, eq(security.id, holdingSnapshot.securityId))
    .where(and(eq(holdingSnapshot.accountId, accountId), eq(holdingSnapshot.date, date)))
    .orderBy(asc(holdingSnapshot.securityId));
  if (rows.length === 0) return undefined;
  const [acct] = await db
    .select({ connectionType: connection.type })
    .from(account)
    .leftJoin(connection, eq(connection.id, account.connectionId))
    .where(eq(account.id, accountId));
  const simplefinFed = acct?.connectionType === "simplefin";
  let source: HoldingSource = rows[0]!.row.source;
  let importLogId: string | null = null;
  let updatedAt = rows[0]!.row.updatedAt;
  let totalValueCents = 0n;
  for (const r of rows) {
    if (HOLDING_SOURCE_RANK[r.row.source] > HOLDING_SOURCE_RANK[source]) source = r.row.source;
    if (r.row.importLogId) importLogId = r.row.importLogId;
    if (r.row.updatedAt > updatedAt) updatedAt = r.row.updatedAt;
    totalValueCents += r.row.valueCents;
  }
  const knownBalanceCents = simplefinFed ? await knownSimplefinBalance(db, accountId, date) : null;
  const differenceCents = knownBalanceCents === null ? null : totalValueCents - knownBalanceCents;
  return {
    accountId,
    date,
    source,
    importLogId,
    rows: rows.map((r) => ({
      securityId: r.row.securityId,
      ticker: r.ticker,
      name: r.name,
      type: r.type,
      quantity: qtyFromDb(r.row.quantity),
      price: qtyFromDb(r.row.price),
      valueCents: r.row.valueCents,
      reportedCostBasisCents: r.row.reportedCostBasisCents,
    })),
    totalValueCents,
    knownBalanceCents,
    differenceCents,
    matchesToDollar: differenceCents === null ? null : matchesToDollar(differenceCents),
    updatedAt,
  };
}

/** Every snapshot date of an account, newest first (the date picker). */
export async function listSnapshots(db: DbOrTx, accountId: string): Promise<SnapshotSummary[]> {
  const rows = await db
    .select({
      date: holdingSnapshot.date,
      positions: sql<number>`count(*)::int`,
      totalValueCents: sql<string>`sum(${holdingSnapshot.valueCents})::text`,
      topRank: sql<number>`max(case ${holdingSnapshot.source} when 'manual' then 3 when 'csv' then 2 else 1 end)::int`,
    })
    .from(holdingSnapshot)
    .where(eq(holdingSnapshot.accountId, accountId))
    .groupBy(holdingSnapshot.date)
    .orderBy(desc(holdingSnapshot.date));
  return rows.map((r) => ({
    date: r.date,
    source: r.topRank === 3 ? "manual" : r.topRank === 2 ? "csv" : "simplefin",
    positions: r.positions,
    totalValueCents: BigInt(r.totalValueCents),
  }));
}

/** The latest snapshot set on or before `asOf` (every set when `asOf` is omitted). */
export async function latestSnapshot(db: DbOrTx, accountId: string, asOf?: IsoDate): Promise<HoldingSnapshotRecord | undefined> {
  const [row] = await db
    .select({ date: sql<string | null>`max(${holdingSnapshot.date})::text` })
    .from(holdingSnapshot)
    .where(and(eq(holdingSnapshot.accountId, accountId), asOf ? lte(holdingSnapshot.date, asOf) : undefined));
  if (!row?.date) return undefined;
  return getSnapshot(db, accountId, row.date);
}

/** `GET /api/investments/accounts/:id/positions`: the positions as of a date are the latest snapshot set on or before it. */
export async function listPositions(db: DbOrTx, accountId: string, asOf: IsoDate): Promise<HoldingSnapshotRecord | undefined> {
  return latestSnapshot(db, accountId, asOf);
}

// ---- The owner's paths ----

/** The audit shape of a set: the position list, sorted by security, so an unchanged re-save writes nothing. */
export function positionsAuditJson(rows: readonly Pick<HoldingSnapshotRow, "securityId" | "quantity" | "price" | "valueCents" | "reportedCostBasisCents">[]) {
  return [...rows]
    .sort((a, b) => (a.securityId < b.securityId ? -1 : a.securityId > b.securityId ? 1 : 0))
    .map((r) => ({
      securityId: r.securityId,
      quantity: r.quantity === null ? null : formatFixed8(qtyFromDb(r.quantity)!),
      price: r.price === null ? null : formatFixed8(qtyFromDb(r.price)!),
      valueCents: r.valueCents.toString(),
      reportedCostBasisCents: r.reportedCostBasisCents === null ? null : r.reportedCostBasisCents.toString(),
    }));
}

export interface ManualPositionInputRecord {
  security: SecurityChoice;
  quantity?: Fixed8 | null;
  price?: Fixed8;
  valueCents?: bigint;
  costBasisCents?: bigint | null;
}

export interface SetManualPositionsInput {
  accountId: string;
  asOfDate: IsoDate;
  positions: readonly ManualPositionInputRecord[];
  setBalance?: boolean;
  statementTotalCents?: bigint | null;
}

export interface SetManualPositionsResult extends ReplaceHoldingSnapshotResult {
  snapshot: HoldingSnapshotRecord;
  impliedPrices: number;
  securitiesCreated: number;
}

async function chooseSecurity(tx: DbOrTx, choice: SecurityChoice, ctx: AuditContext): Promise<{ id: string; type: SecurityType; created: boolean }> {
  if (choice.kind === "existing") {
    const row = await requireSecurity(tx, choice.securityId);
    return { id: row.id, type: row.type, created: false };
  }
  const s = choice.security;
  if (isCashKey({ ticker: s.ticker, name: s.name })) {
    const { row, created } = await cashSecurity(tx);
    return { id: row.id, type: row.type, created };
  }
  const resolved = await resolveSecurity(tx, { ticker: s.ticker, cusip: s.cusip, isin: s.isin, name: s.name }, { createIfMissing: false });
  if (resolved.id !== null) {
    const row = await requireSecurity(tx, resolved.id);
    return { id: row.id, type: row.type, created: false };
  }
  const created = await createSecurity(tx, { ticker: s.ticker, name: s.name, type: s.type, assetClass: s.assetClass, cusip: s.cusip, isin: s.isin }, ctx, { needsReview: false });
  return { id: created.id, type: created.type, created: true };
}

/**
 * The positions editor (`PUT /api/investments/accounts/:id/positions`, §3.10): each row names
 * a security (existing, or a suggestion that resolves or is created without review), gives a
 * quantity (optional: dollar-only allowed) and a price or a value (the other derived), is
 * aggregated per security and written as a `manual` snapshot (the top rank, always allowed),
 * then the implied prices are rebuilt and the valuation job queued. Audited as
 * `holding_snapshot` with entity id `<accountId>:<date>` and the position lists before/after.
 */
export async function setManualPositions(db: Db, input: SetManualPositionsInput, ctx: AuditContext & { today: IsoDate }): Promise<SetManualPositionsResult> {
  if (!isIsoDate(input.asOfDate)) throw new PlanError(400, "validation", "asOfDate must be YYYY-MM-DD");
  if (input.asOfDate > ctx.today) throw new PlanError(400, "future_date", `${input.asOfDate} is after today`);
  if (input.positions.length === 0) throw new PlanError(400, "validation", "At least one position is required");
  const result = await db.transaction(async (tx) => {
    await loadInvestmentAccount(tx, input.accountId);
    interface Agg {
      quantities: Array<Fixed8 | null>;
      prices: Array<Fixed8 | null>;
      valueCents: bigint;
      costs: Array<bigint | null>;
    }
    const aggregated = new Map<string, Agg>();
    let securitiesCreated = 0;
    for (const p of input.positions) {
      const chosen = await chooseSecurity(tx, p.security, ctx);
      if (chosen.created) securitiesCreated++;
      let quantity = p.quantity ?? null;
      let priceValue: Fixed8 | null = null;
      let valueCents: bigint;
      if (chosen.type === "cash") {
        if (p.valueCents === undefined && quantity === null) throw new PlanError(400, "validation", "A cash position needs a value");
        valueCents = p.valueCents ?? fixed8ToCents(quantity!);
        quantity = quantity ?? centsToFixed8(valueCents);
        priceValue = FIXED8_SCALE;
      } else if (p.price !== undefined) {
        if (quantity === null) throw new PlanError(400, "validation", "A price needs a quantity");
        if (p.price < 0n) throw new PlanError(400, "validation", "price must not be negative");
        priceValue = p.price;
        valueCents = p.valueCents ?? mulToCents(quantity, p.price);
      } else {
        if (p.valueCents === undefined) throw new PlanError(400, "validation", "A position needs a price or a value");
        valueCents = p.valueCents;
        priceValue = quantity !== null && quantity !== 0n ? impliedPrice(valueCents, quantity) : null;
      }
      const agg = aggregated.get(chosen.id) ?? { quantities: [], prices: [], valueCents: 0n, costs: [] };
      agg.quantities.push(quantity);
      agg.prices.push(priceValue);
      agg.valueCents += valueCents;
      agg.costs.push(p.costBasisCents ?? null);
      aggregated.set(chosen.id, agg);
    }
    const positions: SnapshotPosition[] = [...aggregated.entries()].map(([securityId, agg]) => ({
      securityId,
      quantity: agg.quantities.every((q) => q !== null) ? agg.quantities.reduce((acc, q) => acc + q!, 0n) : null,
      price: agg.prices.length === 1 ? agg.prices[0]! : null,
      valueCents: agg.valueCents,
      reportedCostBasisCents: agg.costs.every((c) => c !== null) ? agg.costs.reduce((acc, c) => acc + c!, 0n) : null,
    }));

    const before = await tx
      .select()
      .from(holdingSnapshot)
      .where(and(eq(holdingSnapshot.accountId, input.accountId), eq(holdingSnapshot.date, input.asOfDate)));
    const replaced = await replaceHoldingSnapshot(tx, {
      accountId: input.accountId,
      date: input.asOfDate,
      source: "manual",
      importLogId: null,
      positions,
      ...(input.setBalance !== undefined ? { setBalance: input.setBalance } : {}),
      statementTotalCents: input.statementTotalCents ?? null,
      today: ctx.today,
    });
    const implied = await rebuildImpliedPrices(tx, { securityIds: replaced.securityIds, dates: [input.asOfDate] });
    const after = await tx
      .select()
      .from(holdingSnapshot)
      .where(and(eq(holdingSnapshot.accountId, input.accountId), eq(holdingSnapshot.date, input.asOfDate)));
    await writeAudit(tx, {
      ...ctx,
      entity: "holding_snapshot",
      entityId: `${input.accountId}:${input.asOfDate}`,
      action: before.length === 0 ? "create" : "update",
      before: before.length === 0 ? null : positionsAuditJson(before),
      after: positionsAuditJson(after),
    });
    if (replaced.inserted + replaced.updated + replaced.deleted > 0 || replaced.balanceWritten) {
      await requestValuation(tx, { reason: "snapshot", accountId: input.accountId });
    }
    return { ...replaced, impliedPrices: implied.written, securitiesCreated };
  });
  const snapshot = await getSnapshot(db, input.accountId, input.asOfDate);
  if (!snapshot) throw new PlanError(400, "validation", "Every position was empty");
  return { ...result, snapshot };
}

export interface DeleteSnapshotResult {
  deleted: number;
  /** The balance row of the same date and source went with it. */
  balanceRemoved: boolean;
  impliedPricesRemoved: number;
}

/**
 * Remove a csv or manual snapshot set (a SimpleFIN set is regenerated by the next sync:
 * 409 `snapshot_source`). The balance row the set wrote goes with it, `account.balance_*`
 * falls back to the latest remaining reported balance when it came from this set, the
 * implied prices the set derived are rebuilt (removed when nothing else derives them), and
 * the valuation job is queued. Audited as a `holding_snapshot` delete.
 */
export async function deleteSnapshot(db: Db, accountId: string, date: IsoDate, ctx: AuditContext): Promise<DeleteSnapshotResult> {
  return db.transaction(async (tx) => {
    const acct = await loadInvestmentAccount(tx, accountId);
    const rows = await tx
      .select()
      .from(holdingSnapshot)
      .where(and(eq(holdingSnapshot.accountId, accountId), eq(holdingSnapshot.date, date)));
    if (rows.length === 0) throw new PlanError(404, "not_found", `No snapshot for ${date}`);
    let source: HoldingSource = rows[0]!.source;
    for (const r of rows) if (HOLDING_SOURCE_RANK[r.source] > HOLDING_SOURCE_RANK[source]) source = r.source;
    if (source === "simplefin") throw new PlanError(409, "snapshot_source", "SimpleFIN snapshots are written by the sync; disconnect the account to stop them");
    await tx.delete(holdingSnapshot).where(
      inArray(
        holdingSnapshot.id,
        rows.map((r) => r.id),
      ),
    );
    const removedBalance = await tx
      .delete(balanceSnapshot)
      .where(and(eq(balanceSnapshot.accountId, accountId), eq(balanceSnapshot.date, date), eq(balanceSnapshot.source, source)))
      .returning({ id: balanceSnapshot.id });
    if (removedBalance.length > 0 && acct.balanceDate === date) {
      const [latest] = await tx
        .select({ date: balanceSnapshot.date, balanceCents: balanceSnapshot.balanceCents })
        .from(balanceSnapshot)
        .where(and(eq(balanceSnapshot.accountId, accountId), ne(balanceSnapshot.source, "computed")))
        .orderBy(desc(balanceSnapshot.date))
        .limit(1);
      await tx
        .update(account)
        .set({ balanceCents: latest?.balanceCents ?? null, balanceDate: latest?.date ?? null, updatedAt: new Date() })
        .where(eq(account.id, accountId));
    }
    const implied = await rebuildImpliedPrices(tx, { securityIds: rows.map((r) => r.securityId), dates: [date] });
    await writeAudit(tx, { ...ctx, entity: "holding_snapshot", entityId: `${accountId}:${date}`, action: "delete", before: positionsAuditJson(rows), after: null });
    await requestValuation(tx, { reason: "snapshot_deleted", accountId });
    return { deleted: rows.length, balanceRemoved: removedBalance.length > 0, impliedPricesRemoved: implied.removed };
  });
}
