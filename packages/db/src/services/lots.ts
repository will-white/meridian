import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, lte, ne, notInArray, sql } from "drizzle-orm";
import {
  buildLots,
  checkPositions,
  compareInvestmentTxns,
  deriveFidelity,
  FIXED8_SCALE,
  holdingsAsOf,
  isInvestmentAccountType,
  summarizeRealized,
  valueLots,
  type AssetClass,
  type DisposalResult,
  type EngineLotPick,
  type EngineWarning,
  type Fixed8,
  type GainTerm,
  type HoldingPriceSource,
  type HoldingSource,
  type InvestmentFidelity,
  type InvestmentTxnInput,
  type IsoDate,
  type LotBuildResult,
  type LotMethod,
  type LotOpenedBy,
  type PositionMismatch,
  type PriceLookup,
  type RealizedSummary,
  type TransferredLot,
} from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { account, holdingSnapshot, investmentTxn, lot, lotDisposal, lotPick, security } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { fixed8FromDb, fixed8ToDb, qtyFromDb } from "./decimalDb.js";
import { latestPrices } from "./prices.js";
import { HOLDING_SOURCE_RANK } from "./securities.js";

/**
 * The lots service (lots design §6.1 under plan decisions 5 and 7; seams C7, C8, C32, C33).
 * `lot` and `lot_disposal` are a derived cache of the pure engine (`buildLots`) rebuilt per
 * account inside the writing transaction; lot ids are stable by `(opened_by_txn_id, ordinal)`
 * (the resolver hands the engine the existing uuid). A transfer group's out-leg account is
 * rebuilt before its in-leg account, which reads the counterparty's `transfer_out` disposals
 * as its lots' sources. Nothing here is audited except `lot_pick` writes (`setLotPicks`).
 */

// ---- Loading ----

export interface LoadInvestmentTxnsOptions {
  /** Drop cash transfers (`type = transfer`, no security): the lot engine's input. */
  securitiesOnly?: boolean;
  /** Only rows dated on or before this date. */
  through?: IsoDate;
}

type TxnRow = typeof investmentTxn.$inferSelect;

/** The engine's signed convention: `sell` and `transfer out` carry a negative quantity. */
export function toEngineTxn(row: TxnRow): InvestmentTxnInput {
  const quantity = qtyFromDb(row.quantity);
  const negative = row.type === "sell" || (row.type === "transfer" && row.transferDirection === "out");
  return {
    id: row.id,
    accountId: row.accountId,
    securityId: row.securityId,
    date: row.date,
    sequence: row.sequence,
    type: row.type,
    quantity: quantity === null ? null : negative ? -quantity : quantity,
    price: qtyFromDb(row.price),
    amountCents: row.amountCents,
    feeCents: row.feeCents,
    splitNum: row.splitNum,
    splitDen: row.splitDen,
    costBasisCents: row.costBasisCents,
    acquiredDate: row.acquiredDate,
    transferGroupId: row.transferGroupId,
    counterpartyAccountId: row.counterpartyAccountId,
  };
}

/** One account's rows as the engine reads them (plan decision 5's sign rule applied), in stream order. */
export async function loadInvestmentTxns(tx: DbOrTx, accountId: string, opts: LoadInvestmentTxnsOptions = {}): Promise<InvestmentTxnInput[]> {
  const rows = await tx
    .select()
    .from(investmentTxn)
    .where(
      and(
        eq(investmentTxn.accountId, accountId),
        opts.through ? lte(investmentTxn.date, opts.through) : undefined,
        opts.securitiesOnly ? sql`not (${investmentTxn.type} = 'transfer' and ${investmentTxn.securityId} is null)` : undefined,
      ),
    );
  return rows.map(toEngineTxn).sort(compareInvestmentTxns);
}

/** The account's `lot_pick` rows (its sells' and transfers-out's picks). */
export async function loadLotPicks(tx: DbOrTx, accountId: string): Promise<EngineLotPick[]> {
  const rows = await tx
    .select({ sellTxnId: lotPick.sellTxnId, lotId: lotPick.lotId, quantity: lotPick.quantity, position: lotPick.position })
    .from(lotPick)
    .innerJoin(investmentTxn, eq(investmentTxn.id, lotPick.sellTxnId))
    .where(eq(investmentTxn.accountId, accountId))
    .orderBy(asc(lotPick.sellTxnId), asc(lotPick.position), asc(lotPick.lotId));
  return rows.map((r) => ({ sellTxnId: r.sellTxnId, lotId: r.lotId, quantity: fixed8FromDb(r.quantity), position: r.position }));
}

/**
 * In-leg transfer txn id → the counterparty's `transfer_out` disposal pieces of the same group
 * (seams C8), read from the table in a deterministic order (acquisition date, then lot id) so
 * the ordinals of the receiving lots never move between rebuilds.
 */
async function loadTransferSources(tx: DbOrTx, accountId: string, txns: readonly InvestmentTxnInput[]): Promise<Map<string, TransferredLot[]>> {
  const out = new Map<string, TransferredLot[]>();
  const inLegs = txns.filter((t) => t.type === "transfer" && t.securityId !== null && t.quantity !== null && t.quantity > 0n && t.transferGroupId !== null);
  if (inLegs.length === 0) return out;
  const groups = [...new Set(inLegs.map((t) => t.transferGroupId!))];
  const outLegs = await tx
    .select({ id: investmentTxn.id, transferGroupId: investmentTxn.transferGroupId })
    .from(investmentTxn)
    .where(and(inArray(investmentTxn.transferGroupId, groups), ne(investmentTxn.accountId, accountId), eq(investmentTxn.type, "transfer"), eq(investmentTxn.transferDirection, "out")));
  const outByGroup = new Map<string, string>();
  for (const o of outLegs) if (o.transferGroupId) outByGroup.set(o.transferGroupId, o.id);
  const outIds = [...outByGroup.values()];
  if (outIds.length === 0) return out;
  const pieces = await tx
    .select({
      closeTxnId: lotDisposal.closeTxnId,
      lotId: lotDisposal.lotId,
      securityId: lotDisposal.securityId,
      acquiredDate: lotDisposal.acquiredDate,
      quantity: lotDisposal.quantity,
      basisCents: lotDisposal.basisCents,
      basisKnown: lotDisposal.basisKnown,
    })
    .from(lotDisposal)
    .where(and(inArray(lotDisposal.closeTxnId, outIds), eq(lotDisposal.kind, "transfer_out"), isNotNull(lotDisposal.lotId)))
    .orderBy(asc(lotDisposal.closeTxnId), asc(lotDisposal.acquiredDate), asc(lotDisposal.lotId));
  const byOut = new Map<string, TransferredLot[]>();
  for (const p of pieces) {
    if (p.lotId === null || p.acquiredDate === null) continue;
    const list = byOut.get(p.closeTxnId) ?? [];
    list.push({ txnId: p.closeTxnId, lotId: p.lotId, securityId: p.securityId, acquiredDate: p.acquiredDate, quantity: fixed8FromDb(p.quantity), basisCents: p.basisCents, basisKnown: p.basisKnown });
    byOut.set(p.closeTxnId, list);
  }
  for (const leg of inLegs) {
    const outId = outByGroup.get(leg.transferGroupId!);
    const list = outId ? byOut.get(outId) : undefined;
    if (list && list.length > 0) out.set(leg.id, list);
  }
  return out;
}

/** The stored lot ids of an account keyed `<openedByTxnId>:<ordinal>`, and a resolver that keeps them. */
async function lotIdResolver(tx: DbOrTx, accountId: string): Promise<(openedByTxnId: string, ordinal: number) => string> {
  const rows = await tx.select({ id: lot.id, openedByTxnId: lot.openedByTxnId, ordinal: lot.ordinal }).from(lot).where(eq(lot.accountId, accountId));
  const assigned = new Map(rows.map((r) => [`${r.openedByTxnId}:${r.ordinal}`, r.id]));
  return (openedByTxnId, ordinal) => {
    const key = `${openedByTxnId}:${ordinal}`;
    let id = assigned.get(key);
    if (!id) {
      id = randomUUID();
      assigned.set(key, id);
    }
    return id;
  };
}

async function loadLotMethod(tx: DbOrTx, accountId: string): Promise<LotMethod> {
  const [row] = await tx.select({ lotMethod: account.lotMethod }).from(account).where(eq(account.id, accountId));
  if (!row) throw new PlanError(404, "not_found", "Account not found");
  return row.lotMethod;
}

export interface BuildAccountLotsOptions {
  /** Only rows dated on or before this date (holdings as of a date). */
  through?: IsoDate;
  /** Only rows strictly before this one in stream order (a dry run "as of the sale"). */
  before?: InvestmentTxnInput;
  /** Leave out the picks of this sale (the dry run validating new picks). */
  excludePicksOf?: string;
}

export interface AccountLotBuild {
  accountId: string;
  lotMethod: LotMethod;
  /** The securities rows fed to the engine, in stream order. */
  txns: InvestmentTxnInput[];
  picks: EngineLotPick[];
  result: LotBuildResult;
}

/** Run the engine over one account's stored rows with its stored lot ids (never writes). */
export async function buildAccountLots(tx: DbOrTx, accountId: string, opts: BuildAccountLotsOptions = {}): Promise<AccountLotBuild> {
  const lotMethod = await loadLotMethod(tx, accountId);
  let txns = await loadInvestmentTxns(tx, accountId, { securitiesOnly: true, ...(opts.through ? { through: opts.through } : {}) });
  if (opts.before) {
    const before = opts.before;
    txns = txns.filter((t) => compareInvestmentTxns(t, before) < 0);
  }
  let picks = await loadLotPicks(tx, accountId);
  if (opts.excludePicksOf) picks = picks.filter((p) => p.sellTxnId !== opts.excludePicksOf);
  const transferSources = await loadTransferSources(tx, accountId, txns);
  const lotId = await lotIdResolver(tx, accountId);
  const result = buildLots({ accountId, lotMethod, txns, lotPicks: picks, transferSources, lotId });
  return { accountId, lotMethod, txns, picks, result };
}

// ---- The rebuild ----

export interface RebuildLotsResult {
  lots: number;
  disposals: number;
  /** The engine's warnings, each carrying the account id. */
  warnings: EngineWarning[];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** One `lot_disposal` row per (close txn, lot): a pick plus the FIFO remainder of the same lot are one row. */
function mergeDisposals(disposals: readonly DisposalResult[]): DisposalResult[] {
  const out: DisposalResult[] = [];
  const index = new Map<string, DisposalResult>();
  for (const d of disposals) {
    const key = `${d.closeTxnId}:${d.lotId ?? ""}`;
    const existing = index.get(key);
    if (!existing) {
      const copy = { ...d };
      index.set(key, copy);
      out.push(copy);
      continue;
    }
    existing.quantity += d.quantity;
    existing.proceedsCents += d.proceedsCents;
    existing.basisCents += d.basisCents;
    existing.gainCents += d.gainCents;
  }
  return out;
}

/**
 * Rebuild one account's lots and disposals from its rows inside the caller's transaction
 * (plan decision 5). Lots are upserted on `(opened_by_txn_id, ordinal)` so their ids (and
 * every `lot_pick` and `origin_lot_id` pointing at them) survive; lots the engine no longer
 * produces are deleted; disposals are rewritten. Idempotent: twice gives identical rows
 * (`rebuilt_at` aside). The caller orders a transfer group's out-leg account first
 * (`rebuildLotsForAccounts` does).
 */
export async function rebuildLots(tx: DbOrTx, accountId: string): Promise<RebuildLotsResult> {
  const build = await buildAccountLots(tx, accountId);
  const { result } = build;
  const now = new Date();

  await tx.delete(lotDisposal).where(eq(lotDisposal.accountId, accountId));

  const lotRows = result.lots.map((l) => ({
    id: l.id,
    accountId,
    securityId: l.securityId,
    openedByTxnId: l.openedByTxnId,
    ordinal: l.ordinal,
    originLotId: l.originLotId,
    openedBy: l.openedBy,
    acquiredDate: l.acquiredDate,
    originalQuantity: fixed8ToDb(l.originalQuantity),
    quantity: fixed8ToDb(l.quantity),
    originalCostBasisCents: l.originalCostBasisCents,
    costBasisCents: l.costBasisCents,
    basisKnown: l.basisKnown,
    closedDate: l.closedDate,
    rebuiltAt: now,
  }));
  for (const batch of chunk(lotRows, 500)) {
    await tx
      .insert(lot)
      .values(batch)
      .onConflictDoUpdate({
        target: [lot.openedByTxnId, lot.ordinal],
        set: {
          securityId: sql`excluded.security_id`,
          originLotId: sql`excluded.origin_lot_id`,
          openedBy: sql`excluded.opened_by`,
          acquiredDate: sql`excluded.acquired_date`,
          originalQuantity: sql`excluded.original_quantity`,
          quantity: sql`excluded.quantity`,
          originalCostBasisCents: sql`excluded.original_cost_basis_cents`,
          costBasisCents: sql`excluded.cost_basis_cents`,
          basisKnown: sql`excluded.basis_known`,
          closedDate: sql`excluded.closed_date`,
          rebuiltAt: sql`excluded.rebuilt_at`,
        },
      });
  }
  const keep = lotRows.map((r) => r.id);
  await tx.delete(lot).where(and(eq(lot.accountId, accountId), keep.length > 0 ? notInArray(lot.id, keep) : undefined));

  const disposals = mergeDisposals(result.disposals);
  for (const batch of chunk(disposals, 500)) {
    await tx.insert(lotDisposal).values(
      batch.map((d) => ({
        accountId,
        securityId: d.securityId,
        closeTxnId: d.closeTxnId,
        lotId: d.lotId,
        kind: d.kind,
        date: d.date,
        acquiredDate: d.acquiredDate,
        quantity: fixed8ToDb(d.quantity),
        proceedsCents: d.proceedsCents,
        basisCents: d.basisCents,
        gainCents: d.gainCents,
        term: d.term,
        basisKnown: d.basisKnown,
        rebuiltAt: now,
      })),
    );
  }

  return { lots: lotRows.length, disposals: disposals.length, warnings: result.warnings.map((w) => ({ ...w, accountId })) };
}

/** Accounts that receive in-kind transfers from any of `accountIds` (their lots depend on these). */
async function inLegAccountsOf(tx: DbOrTx, accountIds: readonly string[]): Promise<Array<{ from: string; to: string }>> {
  if (accountIds.length === 0) return [];
  const outLeg = tx
    .select({ groupId: investmentTxn.transferGroupId, accountId: investmentTxn.accountId })
    .from(investmentTxn)
    .where(and(inArray(investmentTxn.accountId, [...accountIds]), eq(investmentTxn.type, "transfer"), eq(investmentTxn.transferDirection, "out"), isNotNull(investmentTxn.securityId), isNotNull(investmentTxn.transferGroupId)))
    .as("out_leg");
  const rows = await tx
    .select({ from: outLeg.accountId, to: investmentTxn.accountId })
    .from(investmentTxn)
    .innerJoin(outLeg, eq(outLeg.groupId, investmentTxn.transferGroupId))
    .where(and(eq(investmentTxn.type, "transfer"), eq(investmentTxn.transferDirection, "in"), isNotNull(investmentTxn.securityId), ne(investmentTxn.accountId, outLeg.accountId)));
  const seen = new Set<string>();
  const out: Array<{ from: string; to: string }> = [];
  for (const r of rows) {
    const key = `${r.from}>${r.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: r.from, to: r.to });
  }
  return out;
}

export interface RebuildAccountsResult {
  /** In rebuild order. */
  accountIds: string[];
  lots: number;
  disposals: number;
  warnings: EngineWarning[];
}

/**
 * Rebuild a set of accounts and every account whose lots depend on them (the in-legs of their
 * transfers out), out-leg accounts first (seams C8). A cycle between two accounts (transfers
 * both ways) is rebuilt twice so each in-leg reads a fresh out-leg.
 */
export async function rebuildLotsForAccounts(tx: DbOrTx, accountIds: readonly string[]): Promise<RebuildAccountsResult> {
  const set = new Set(accountIds);
  const edges: Array<{ from: string; to: string }> = [];
  let frontier = [...set];
  for (let round = 0; round < 50 && frontier.length > 0; round++) {
    const found = await inLegAccountsOf(tx, frontier);
    frontier = [];
    for (const e of found) {
      if (!edges.some((x) => x.from === e.from && x.to === e.to)) edges.push(e);
      if (!set.has(e.to)) {
        set.add(e.to);
        frontier.push(e.to);
      }
    }
  }
  // Kahn's algorithm with ties by id; whatever is left is cyclic and gets a second pass.
  const ids = [...set].sort();
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const e of edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  const order: string[] = [];
  const ready = ids.filter((id) => indegree.get(id) === 0);
  const done = new Set<string>();
  while (ready.length > 0) {
    ready.sort();
    const id = ready.shift()!;
    order.push(id);
    done.add(id);
    for (const e of edges) {
      if (e.from !== id) continue;
      const left = (indegree.get(e.to) ?? 0) - 1;
      indegree.set(e.to, left);
      if (left === 0 && !done.has(e.to)) ready.push(e.to);
    }
  }
  const cyclic = ids.filter((id) => !done.has(id));
  const passes = [...order, ...cyclic, ...cyclic];

  const out: RebuildAccountsResult = { accountIds: [...order, ...cyclic], lots: 0, disposals: 0, warnings: [] };
  const counted = new Set<string>();
  for (const id of passes) {
    const r = await rebuildLots(tx, id);
    if (counted.has(id)) {
      out.warnings = out.warnings.filter((w) => w.accountId !== id);
    } else {
      counted.add(id);
      out.lots += r.lots;
      out.disposals += r.disposals;
    }
    out.warnings.push(...r.warnings);
  }
  return out;
}

/** Every account with investment rows, in one transaction (`POST /api/investments/lots/rebuild`). */
export async function rebuildAllLots(db: Db, accountId?: string): Promise<RebuildAccountsResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .selectDistinct({ accountId: investmentTxn.accountId })
      .from(investmentTxn)
      .where(accountId ? eq(investmentTxn.accountId, accountId) : undefined);
    const ids = rows.map((r) => r.accountId);
    if (accountId && !ids.includes(accountId)) ids.push(accountId);
    return rebuildLotsForAccounts(tx, ids);
  });
}

// ---- Lot picks (specific identification) ----

export interface LotPickRecord {
  id: string;
  sellTxnId: string;
  lotId: string;
  quantity: Fixed8;
  position: number;
}

export interface LotPickInputRecord {
  lotId: string;
  quantity: Fixed8;
}

/** The picks of several sales, keyed by sale id, in position order. */
export async function listLotPicks(tx: DbOrTx, sellTxnIds: readonly string[]): Promise<Map<string, LotPickRecord[]>> {
  const out = new Map<string, LotPickRecord[]>();
  if (sellTxnIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(lotPick)
    .where(inArray(lotPick.sellTxnId, [...new Set(sellTxnIds)]))
    .orderBy(asc(lotPick.sellTxnId), asc(lotPick.position), asc(lotPick.lotId));
  for (const r of rows) {
    const list = out.get(r.sellTxnId) ?? [];
    list.push({ id: r.id, sellTxnId: r.sellTxnId, lotId: r.lotId, quantity: fixed8FromDb(r.quantity), position: r.position });
    out.set(r.sellTxnId, list);
  }
  return out;
}

/** The sale a pick list belongs to, as the validator needs it (the row may not be stored yet). */
export interface PickSale {
  id: string;
  accountId: string;
  securityId: string | null;
  type: InvestmentTxnInput["type"];
  transferDirection: "in" | "out" | null;
  date: IsoDate;
  sequence: number;
  /** Unsigned. */
  quantity: Fixed8 | null;
}

/**
 * The lots design's validation (seams C7): the row is a sell or a transfer out (400
 * `not_a_sale`); every lot exists (400 `lot_not_found`) and belongs to the same account and
 * security (400 `pick_security_mismatch`); Σ picks ≤ the sale (400 `picks_exceed_sale`); each
 * pick ≤ the lot's quantity open as of the sale, from a dry build without this sale's picks
 * (400 `pick_exceeds_lot`). Returns the picks with positions in input order.
 */
export async function validateLotPicks(tx: DbOrTx, sale: PickSale, picks: readonly LotPickInputRecord[]): Promise<Array<LotPickInputRecord & { position: number }>> {
  const isSale = sale.type === "sell" || (sale.type === "transfer" && sale.transferDirection === "out" && sale.securityId !== null);
  if (!isSale || sale.securityId === null) throw new PlanError(400, "not_a_sale", "Lot picks apply to a sell or a transfer out");
  if (picks.length === 0) return [];
  const seen = new Set<string>();
  for (const p of picks) {
    if (seen.has(p.lotId)) throw new PlanError(400, "validation", `Lot ${p.lotId} is picked twice`);
    seen.add(p.lotId);
    if (p.quantity <= 0n) throw new PlanError(400, "validation", "A pick's quantity must be positive");
  }
  const rows = await tx
    .select({ id: lot.id, accountId: lot.accountId, securityId: lot.securityId })
    .from(lot)
    .where(inArray(lot.id, [...seen]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const p of picks) {
    const row = byId.get(p.lotId);
    if (!row) throw new PlanError(400, "lot_not_found", `Lot ${p.lotId} not found`);
    if (row.accountId !== sale.accountId || row.securityId !== sale.securityId) {
      throw new PlanError(400, "pick_security_mismatch", `Lot ${p.lotId} belongs to another account or security`);
    }
  }
  const total = picks.reduce((acc, p) => acc + p.quantity, 0n);
  const saleQuantity = sale.quantity ?? 0n;
  if (total > saleQuantity) throw new PlanError(400, "picks_exceed_sale", `Picks total ${fixed8ToDb(total)} shares for a sale of ${fixed8ToDb(saleQuantity)}`);
  const saleInput: InvestmentTxnInput = {
    id: sale.id,
    accountId: sale.accountId,
    securityId: sale.securityId,
    date: sale.date,
    sequence: sale.sequence,
    type: sale.type,
    quantity: -saleQuantity,
    price: null,
    amountCents: 0n,
    feeCents: null,
    splitNum: null,
    splitDen: null,
    costBasisCents: null,
    acquiredDate: null,
    transferGroupId: null,
    counterpartyAccountId: null,
  };
  const dry = await buildAccountLots(tx, sale.accountId, { before: saleInput, excludePicksOf: sale.id });
  const open = new Map(dry.result.lots.map((l) => [l.id, l.quantity]));
  for (const p of picks) {
    const available = open.get(p.lotId) ?? 0n;
    if (p.quantity > available) {
      throw new PlanError(400, "pick_exceeds_lot", `Lot ${p.lotId} has ${fixed8ToDb(available)} shares open on ${sale.date}, not ${fixed8ToDb(p.quantity)}`);
    }
  }
  return picks.map((p, position) => ({ lotId: p.lotId, quantity: p.quantity, position }));
}

/** Replace a sale's picks inside the caller's transaction (no audit, no rebuild): the create path and `setLotPicks` share it. */
export async function writeLotPicks(tx: DbOrTx, sellTxnId: string, picks: ReadonlyArray<LotPickInputRecord & { position: number }>): Promise<LotPickRecord[]> {
  await tx.delete(lotPick).where(eq(lotPick.sellTxnId, sellTxnId));
  if (picks.length === 0) return [];
  const rows = await tx
    .insert(lotPick)
    .values(picks.map((p) => ({ sellTxnId, lotId: p.lotId, quantity: fixed8ToDb(p.quantity), position: p.position })))
    .returning();
  return rows.map((r) => ({ id: r.id, sellTxnId: r.sellTxnId, lotId: r.lotId, quantity: fixed8FromDb(r.quantity), position: r.position })).sort((a, b) => a.position - b.position);
}

export function lotPicksAuditJson(picks: readonly LotPickRecord[]) {
  return [...picks].sort((a, b) => a.position - b.position).map((p) => ({ lotId: p.lotId, quantity: fixed8ToDb(p.quantity), position: p.position }));
}

export interface SetLotPicksResult {
  picks: LotPickRecord[];
  /** The sale's warnings after the rebuild. */
  warnings: EngineWarning[];
}

/**
 * `PUT /api/investments/txns/:id/lot-picks`: validates, replaces the picks (`[]` clears),
 * audits `lot_pick` (entity id = the sale) with the pick lists before and after, rebuilds the
 * account and returns the sale's warnings.
 */
export async function setLotPicks(db: Db, sellTxnId: string, picks: readonly LotPickInputRecord[], ctx: AuditContext): Promise<SetLotPicksResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(investmentTxn).where(eq(investmentTxn.id, sellTxnId));
    if (!row) throw new PlanError(404, "not_found", "Investment transaction not found");
    const sale: PickSale = {
      id: row.id,
      accountId: row.accountId,
      securityId: row.securityId,
      type: row.type,
      transferDirection: row.transferDirection,
      date: row.date,
      sequence: row.sequence,
      quantity: qtyFromDb(row.quantity),
    };
    const validated = await validateLotPicks(tx, sale, picks);
    const before = (await listLotPicks(tx, [sellTxnId])).get(sellTxnId) ?? [];
    const after = await writeLotPicks(tx, sellTxnId, validated);
    await writeAudit(tx, {
      ...ctx,
      entity: "lot_pick",
      entityId: sellTxnId,
      action: before.length === 0 ? "create" : after.length === 0 ? "delete" : "update",
      before: before.length === 0 ? null : lotPicksAuditJson(before),
      after: after.length === 0 ? null : lotPicksAuditJson(after),
    });
    const rebuilt = await rebuildLotsForAccounts(tx, [row.accountId]);
    return { picks: after, warnings: rebuilt.warnings.filter((w) => w.txnId === sellTxnId) };
  });
}

// ---- Prices for valuation ----

function toHoldingPriceSource(source: "provider" | "implied" | "manual"): HoldingPriceSource {
  return source;
}

/** The latest close on or before `asOf` per security; the cash security is always 1. */
async function priceLookupAsOf(tx: DbOrTx, securityIds: readonly string[], asOf: IsoDate): Promise<PriceLookup> {
  const ids = [...new Set(securityIds)];
  if (ids.length === 0) return () => null;
  const types = await tx.select({ id: security.id, type: security.type }).from(security).where(inArray(security.id, ids));
  const cash = new Set(types.filter((t) => t.type === "cash").map((t) => t.id));
  const latest = await latestPrices(tx, ids.filter((id) => !cash.has(id)), asOf);
  return (securityId) => {
    if (cash.has(securityId)) return { close: FIXED8_SCALE, date: asOf, source: "cash" };
    const p = latest.get(securityId);
    return p ? { close: p.close, date: p.date, source: toHoldingPriceSource(p.source) } : null;
  };
}

interface SecurityMeta {
  ticker: string | null;
  name: string;
  assetClass: AssetClass;
  type: (typeof security.$inferSelect)["type"];
}

async function securityMeta(tx: DbOrTx, ids: readonly string[]): Promise<Map<string, SecurityMeta>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await tx.select({ id: security.id, ticker: security.ticker, name: security.name, assetClass: security.assetClass, type: security.type }).from(security).where(inArray(security.id, unique));
  return new Map(rows.map((r) => [r.id, { ticker: r.ticker, name: r.name, assetClass: r.assetClass, type: r.type }]));
}

// ---- Holdings (§3.14) ----

export interface HoldingResult {
  accountId: string;
  securityId: string;
  ticker: string | null;
  securityName: string;
  assetClass: AssetClass;
  quantity: Fixed8;
  valueCents: bigint | null;
  /** Σ basis of the known-basis lots; null when none is known. */
  costBasisCents: bigint | null;
  unrealizedCents: bigint | null;
  unrealizedShortCents: bigint;
  unrealizedLongCents: bigint;
  unknownBasisQuantity: Fixed8;
  lotCount: number;
  price: Fixed8 | null;
  priceDate: IsoDate | null;
  priceSource: HoldingPriceSource | null;
  stale: boolean;
  /** Always `lots` here; the Holdings view reports `statement` for positions-basis accounts. */
  basisSource: "lots";
}

export interface ComputeHoldingsResult {
  rows: HoldingResult[];
  warnings: EngineWarning[];
}

/**
 * The engine's holdings of full-history accounts as of a date: lots from the rows dated on
 * or before `asOf`, priced with the latest close on or before it (cash at 1). The cash line
 * (`securityId` null) belongs to the valuation chain, which anchors cash on the reported
 * balance; it is not produced here.
 */
export async function computeHoldings(db: DbOrTx, q: { accountIds: readonly string[]; asOf: IsoDate }): Promise<ComputeHoldingsResult> {
  const rows: HoldingResult[] = [];
  const warnings: EngineWarning[] = [];
  for (const accountId of [...new Set(q.accountIds)].sort()) {
    const build = await buildAccountLots(db, accountId, { through: q.asOf });
    const securityIds = [...new Set(build.result.lots.map((l) => l.securityId))];
    const priceAt = await priceLookupAsOf(db, securityIds, q.asOf);
    const meta = await securityMeta(db, securityIds);
    for (const h of holdingsAsOf(build.result.lots, q.asOf, priceAt)) {
      const m = meta.get(h.securityId);
      rows.push({
        accountId,
        securityId: h.securityId,
        ticker: m?.ticker ?? null,
        securityName: m?.name ?? "",
        assetClass: m?.assetClass ?? "other",
        quantity: h.quantity,
        valueCents: h.valueCents,
        costBasisCents: h.costBasisCents,
        unrealizedCents: h.unrealizedCents,
        unrealizedShortCents: h.unrealizedShortCents,
        unrealizedLongCents: h.unrealizedLongCents,
        unknownBasisQuantity: h.unknownBasisQuantity,
        lotCount: h.lotCount,
        price: h.price,
        priceDate: h.priceDate,
        priceSource: h.priceSource,
        stale: h.stale,
        basisSource: "lots",
      });
    }
    warnings.push(...build.result.warnings.map((w) => ({ ...w, accountId })));
  }
  return { rows, warnings };
}

// ---- Position check and fidelity inputs (§3.16, plan decision 7) ----

export interface AccountPositionCheck {
  accountId: string;
  hasTrades: boolean;
  hasSnapshots: boolean;
  lastSnapshotDate: IsoDate | null;
  lastSnapshotSource: HoldingSource | null;
  lastTradeDate: IsoDate | null;
  /** `position_mismatch` warnings against the latest snapshot; empty without trades or a snapshot. */
  warnings: EngineWarning[];
  mismatches: PositionMismatch[];
  fidelity: InvestmentFidelity;
  fidelityNote: string | null;
  /** null without both trades and a snapshot to compare. */
  positionsMatch: boolean | null;
}

function isTradeRow(t: InvestmentTxnInput): boolean {
  return t.type === "buy" || t.type === "sell" || t.type === "reinvest" || t.type === "split" || (t.type === "transfer" && t.securityId !== null);
}

/**
 * `hasTrades` / `hasSnapshots` plus the engine's `checkPositions` against the latest
 * `holding_snapshot` (0.001-share tolerance; the cash security, `asset_class = 'cash'` funds
 * and dollar-only rows are skipped), folded through `deriveFidelity`: lots that do not explain
 * the latest statement demote a full history to `positions` with a note.
 */
export async function accountPositionCheck(tx: DbOrTx, accountId: string): Promise<AccountPositionCheck> {
  const txns = await loadInvestmentTxns(tx, accountId, { securitiesOnly: true });
  const trades = txns.filter(isTradeRow);
  const hasTrades = trades.length > 0;
  const lastTradeDate = trades.reduce<IsoDate | null>((acc, t) => (acc === null || t.date > acc ? t.date : acc), null);

  const [latest] = await tx
    .select({ date: holdingSnapshot.date })
    .from(holdingSnapshot)
    .where(eq(holdingSnapshot.accountId, accountId))
    .orderBy(desc(holdingSnapshot.date))
    .limit(1);
  const hasSnapshots = latest !== undefined;
  let lastSnapshotSource: HoldingSource | null = null;
  const quantities = new Map<string, Fixed8 | null>();
  const skip = new Set<string>();
  if (latest) {
    const rows = await tx
      .select({ securityId: holdingSnapshot.securityId, quantity: holdingSnapshot.quantity, source: holdingSnapshot.source, type: security.type, assetClass: security.assetClass })
      .from(holdingSnapshot)
      .innerJoin(security, eq(security.id, holdingSnapshot.securityId))
      .where(and(eq(holdingSnapshot.accountId, accountId), eq(holdingSnapshot.date, latest.date)));
    for (const r of rows) {
      quantities.set(r.securityId, qtyFromDb(r.quantity));
      if (r.type === "cash" || r.assetClass === "cash") skip.add(r.securityId);
      if (lastSnapshotSource === null || HOLDING_SOURCE_RANK[r.source] > HOLDING_SOURCE_RANK[lastSnapshotSource]) lastSnapshotSource = r.source;
    }
  }

  let warnings: EngineWarning[] = [];
  const mismatches: PositionMismatch[] = [];
  if (hasTrades && latest) {
    const build = await buildAccountLots(tx, accountId);
    const checked = [...new Set(build.result.lots.map((l) => l.securityId))];
    if (checked.length > 0) {
      const meta = await tx.select({ id: security.id, type: security.type, assetClass: security.assetClass }).from(security).where(inArray(security.id, checked));
      for (const m of meta) if (m.type === "cash" || m.assetClass === "cash") skip.add(m.id);
    }
    warnings = checkPositions(build.result.positions, { date: latest.date, quantities, skipSecurityIds: skip }).map((w) => ({ ...w, accountId }));
    const names = await securityMeta(tx, warnings.map((w) => w.securityId!).filter(Boolean));
    for (const w of warnings) {
      const m = w.securityId ? names.get(w.securityId) : undefined;
      mismatches.push({ ticker: m?.ticker ?? m?.name ?? w.securityId ?? "?", lotsQuantity: w.lotsQuantity ?? 0n, snapshotQuantity: w.snapshotQuantity ?? 0n });
    }
  }
  const derived = deriveFidelity({ hasTrades, hasSnapshots, mismatches });
  return {
    accountId,
    hasTrades,
    hasSnapshots,
    lastSnapshotDate: latest?.date ?? null,
    lastSnapshotSource,
    lastTradeDate,
    warnings,
    mismatches,
    fidelity: derived.fidelity,
    fidelityNote: derived.fidelityNote,
    positionsMatch: hasTrades && hasSnapshots ? warnings.length === 0 : null,
  };
}

// ---- Reads ----

export interface LotRecord {
  id: string;
  openedByTxnId: string;
  ordinal: number;
  originLotId: string | null;
  accountId: string;
  accountName: string;
  securityId: string;
  ticker: string | null;
  securityName: string;
  openedBy: LotOpenedBy;
  acquiredDate: IsoDate;
  originalQuantity: Fixed8;
  quantity: Fixed8;
  /** Null when the basis is unknown (plan decision 5). */
  originalCostBasisCents: bigint | null;
  costBasisCents: bigint | null;
  basisPerShare: Fixed8 | null;
  basisKnown: boolean;
  closedDate: IsoDate | null;
  priceDate: IsoDate | null;
  valueCents: bigint | null;
  unrealizedCents: bigint | null;
  term: GainTerm;
}

export interface LotsAccountRecord {
  accountId: string;
  fidelity: InvestmentFidelity;
  lotMethod: LotMethod;
  positionCheckDate: IsoDate | null;
  warnings: EngineWarning[];
}

export interface ListLotsQuery {
  accountId?: string;
  securityId?: string;
  asOf: IsoDate;
  includeClosed?: boolean;
}

export interface ListLotsResult {
  asOf: IsoDate;
  lots: LotRecord[];
  accounts: LotsAccountRecord[];
}

/**
 * `GET /api/investments/lots`: the stored lots joined with their account and security, valued
 * as of `asOf` (latest close on or before it; term as if sold that day), plus each account's
 * fidelity and position check against its latest snapshot.
 */
export async function listLots(db: DbOrTx, q: ListLotsQuery): Promise<ListLotsResult> {
  const rows = await db
    .select({
      lot,
      accountName: account.name,
      accountType: account.type,
      lotMethod: account.lotMethod,
      ticker: security.ticker,
      securityName: security.name,
    })
    .from(lot)
    .innerJoin(account, eq(account.id, lot.accountId))
    .innerJoin(security, eq(security.id, lot.securityId))
    .where(
      and(
        q.accountId ? eq(lot.accountId, q.accountId) : undefined,
        q.securityId ? eq(lot.securityId, q.securityId) : undefined,
        q.includeClosed ? undefined : gt(lot.quantity, "0"),
      ),
    )
    .orderBy(asc(account.name), asc(security.ticker), asc(lot.acquiredDate), asc(lot.openedByTxnId), asc(lot.ordinal));

  const engineLots = rows.map((r) => ({
    id: r.lot.id,
    openedByTxnId: r.lot.openedByTxnId,
    ordinal: r.lot.ordinal,
    originLotId: r.lot.originLotId,
    accountId: r.lot.accountId,
    securityId: r.lot.securityId,
    openedBy: r.lot.openedBy,
    acquiredDate: r.lot.acquiredDate,
    originalQuantity: fixed8FromDb(r.lot.originalQuantity),
    quantity: fixed8FromDb(r.lot.quantity),
    originalCostBasisCents: r.lot.originalCostBasisCents,
    costBasisCents: r.lot.costBasisCents,
    basisKnown: r.lot.basisKnown,
    closedDate: r.lot.closedDate,
  }));
  const priceAt = await priceLookupAsOf(db, engineLots.map((l) => l.securityId), q.asOf);
  const valuations = valueLots(engineLots, q.asOf, priceAt);
  const lots: LotRecord[] = engineLots.map((l, i) => {
    const r = rows[i]!;
    const v = valuations[i]!;
    return {
      ...l,
      accountName: r.accountName,
      ticker: r.ticker,
      securityName: r.securityName,
      originalCostBasisCents: l.basisKnown ? l.originalCostBasisCents : null,
      costBasisCents: l.basisKnown ? l.costBasisCents : null,
      basisPerShare: v.basisPerShare,
      priceDate: v.priceDate,
      valueCents: v.valueCents,
      unrealizedCents: v.unrealizedCents,
      term: v.term,
    };
  });

  let accountIds: string[];
  if (q.accountId) accountIds = [q.accountId];
  else {
    const withLots = await db.selectDistinct({ accountId: lot.accountId }).from(lot);
    accountIds = withLots.map((r) => r.accountId).sort();
  }
  const accounts: LotsAccountRecord[] = [];
  for (const accountId of accountIds) {
    const [acct] = await db.select({ type: account.type, lotMethod: account.lotMethod }).from(account).where(eq(account.id, accountId));
    if (!acct) throw new PlanError(404, "not_found", "Account not found");
    if (!isInvestmentAccountType(acct.type)) throw new PlanError(400, "not_investment_account", "Not an investment account");
    const check = await accountPositionCheck(db, accountId);
    accounts.push({
      accountId,
      fidelity: check.fidelity,
      lotMethod: acct.lotMethod,
      positionCheckDate: check.hasTrades && check.hasSnapshots ? check.lastSnapshotDate : null,
      warnings: check.warnings,
    });
  }
  return { asOf: q.asOf, lots, accounts };
}

export interface DisposalRecord extends DisposalResult {
  accountName: string;
  ticker: string | null;
}

export interface ListRealizedQuery {
  from: IsoDate;
  to: IsoDate;
  accountId?: string;
  securityId?: string;
}

export interface ListRealizedResult {
  from: IsoDate;
  to: IsoDate;
  summary: RealizedSummary;
  byAccount: Array<{ accountId: string; name: string; summary: RealizedSummary }>;
  /** Disposals in `(from, to]`, by date then account then security. */
  disposals: DisposalRecord[];
}

/** `GET /api/investments/realized`: from `lot_disposal` (rebuilt on every write, so it equals the engine's output). */
export async function listRealized(db: DbOrTx, q: ListRealizedQuery): Promise<ListRealizedResult> {
  if (q.from >= q.to) throw new PlanError(400, "validation", "from must be before to");
  const rows = await db
    .select({ d: lotDisposal, accountName: account.name, ticker: security.ticker })
    .from(lotDisposal)
    .innerJoin(account, eq(account.id, lotDisposal.accountId))
    .innerJoin(security, eq(security.id, lotDisposal.securityId))
    .where(
      and(
        gt(lotDisposal.date, q.from),
        lte(lotDisposal.date, q.to),
        q.accountId ? eq(lotDisposal.accountId, q.accountId) : undefined,
        q.securityId ? eq(lotDisposal.securityId, q.securityId) : undefined,
      ),
    )
    .orderBy(asc(lotDisposal.date), asc(account.name), asc(security.ticker), asc(lotDisposal.acquiredDate), asc(lotDisposal.closeTxnId), asc(lotDisposal.lotId));
  const disposals: DisposalRecord[] = rows.map((r) => ({
    closeTxnId: r.d.closeTxnId,
    lotId: r.d.lotId,
    accountId: r.d.accountId,
    securityId: r.d.securityId,
    kind: r.d.kind,
    date: r.d.date,
    acquiredDate: r.d.acquiredDate,
    quantity: fixed8FromDb(r.d.quantity),
    proceedsCents: r.d.proceedsCents,
    basisCents: r.d.basisCents,
    gainCents: r.d.gainCents,
    term: r.d.term,
    basisKnown: r.d.basisKnown,
    accountName: r.accountName,
    ticker: r.ticker,
  }));
  const range = { from: q.from, to: q.to };
  const accountIds = [...new Set(disposals.map((d) => d.accountId))];
  const byAccount = accountIds
    .map((accountId) => {
      const own = disposals.filter((d) => d.accountId === accountId);
      return { accountId, name: own[0]!.accountName, summary: summarizeRealized(own, range) };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.accountId < b.accountId ? -1 : 1));
  return { from: q.from, to: q.to, summary: summarizeRealized(disposals, range), byAccount, disposals };
}
