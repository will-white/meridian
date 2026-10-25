import type {
  ActionFoundView,
  AllocationTargetsView,
  HoldingSnapshotView,
  InvestmentTxnView,
  LedgerMatchView,
  LotPickView,
  MappedPositionView,
  MappedTradeView,
  PositionsImportResult,
  PreviewSecurityRef,
  SecurityRef,
  SecurityView,
  SnapshotSummaryView,
  TradesImportResult,
} from "@meridian/shared";
import { formatFixed8, type ActionFound, type EngineWarning, type Fixed8, type ImportRowError, type IsoDate, type MappedPosition, type MappedTrade } from "@meridian/shared";
import type {
  AllocationTargetsRecord,
  HoldingSnapshotRecord,
  ImportTradesResult,
  InvestmentTxnRecord,
  LotPickRecord,
  ReplaceHoldingSnapshotResult,
  SecurityRecord,
  SecurityRefRecord,
  SnapshotSummary,
} from "@meridian/db";

/**
 * Securities, snapshots, investment-transaction and import view mappers: bigint service
 * records → the wire contracts of packages/shared/src/api.ts ("Phase 3: investments").
 * Cents travel as decimal strings, quantities and prices as canonical Fixed8 strings,
 * timestamps as ISO text, dates untouched. Pure; one function per contract.
 */

const cents = (n: bigint): string => n.toString();
const nullableCents = (n: bigint | null): string | null => (n === null ? null : n.toString());
const fx = (v: Fixed8): string => formatFixed8(v);
const nullableFx = (v: Fixed8 | null): string | null => (v === null ? null : formatFixed8(v));

export function toSecurityView(r: SecurityRecord): SecurityView {
  return {
    id: r.id,
    ticker: r.ticker,
    name: r.name,
    type: r.type,
    assetClass: r.assetClass,
    expenseRatioPpm: r.expenseRatioPpm,
    cusip: r.cusip,
    isin: r.isin,
    currency: r.currency,
    priceMode: r.priceMode,
    providerSymbol: r.providerSymbol,
    alwaysPrice: r.alwaysPrice,
    needsReview: r.needsReview,
    archived: r.archived,
    notes: r.notes,
    aliases: r.aliases.map((a) => ({ kind: a.kind, value: a.value })),
    held: r.held,
    heldInAccounts: r.heldInAccounts,
    latestPrice: r.latestPrice === null ? null : { date: r.latestPrice.date, close: fx(r.latestPrice.close), source: r.latestPrice.source },
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toSecurityRefView(r: SecurityRefRecord): SecurityRef {
  return {
    securityId: r.securityId,
    ticker: r.ticker,
    name: r.name,
    type: r.type,
    assetClass: r.assetClass,
    splits: r.splits.map((s) => ({ assetClass: s.assetClass, weightBp: s.weightBp })),
    needsReview: r.needsReview,
  };
}

export function toAllocationTargetsView(r: AllocationTargetsRecord): AllocationTargetsView {
  return {
    targets: r.targets.map((t) => ({ assetClass: t.assetClass, targetBp: t.targetBp })),
    updatedAt: r.updatedAt === null ? null : r.updatedAt.toISOString(),
  };
}

export function toHoldingSnapshotView(r: HoldingSnapshotRecord): HoldingSnapshotView {
  return {
    accountId: r.accountId,
    date: r.date,
    source: r.source,
    importLogId: r.importLogId,
    rows: r.rows.map((row) => ({
      securityId: row.securityId,
      ticker: row.ticker,
      name: row.name,
      quantity: nullableFx(row.quantity),
      price: nullableFx(row.price),
      valueCents: cents(row.valueCents),
      reportedCostBasisCents: nullableCents(row.reportedCostBasisCents),
    })),
    totalValueCents: cents(r.totalValueCents),
    knownBalanceCents: nullableCents(r.knownBalanceCents),
    differenceCents: nullableCents(r.differenceCents),
    matchesToDollar: r.matchesToDollar,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toSnapshotSummaryView(r: SnapshotSummary): SnapshotSummaryView {
  return { date: r.date, source: r.source, positions: r.positions, totalValueCents: cents(r.totalValueCents) };
}

export function toLotPickView(p: LotPickRecord): LotPickView {
  return { id: p.id, sellTxnId: p.sellTxnId, lotId: p.lotId, quantity: fx(p.quantity), position: p.position };
}

export function toInvestmentTxnView(r: InvestmentTxnRecord): InvestmentTxnView {
  return {
    id: r.id,
    accountId: r.accountId,
    accountName: r.accountName,
    securityId: r.securityId,
    ticker: r.ticker,
    securityName: r.securityName,
    date: r.date,
    sequence: r.sequence,
    type: r.type,
    quantity: nullableFx(r.quantity),
    price: nullableFx(r.price),
    amountCents: cents(r.amountCents),
    feeCents: cents(r.feeCents),
    splitNum: r.splitNum,
    splitDen: r.splitDen,
    transferDirection: r.transferDirection,
    counterpartyAccountId: r.counterpartyAccountId,
    transferGroupId: r.transferGroupId,
    costBasisCents: nullableCents(r.costBasisCents),
    acquiredDate: r.acquiredDate,
    lotPicks: r.lotPicks.map(toLotPickView),
    ledgerTransactionId: r.ledgerTransactionId,
    externalId: r.externalId,
    source: r.source,
    importLogId: r.importLogId,
    rawDescription: r.rawDescription,
    memo: r.memo,
    userEdited: r.userEdited,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ---- Import previews and results ----

/** What the preview route resolved for one positions row: its security and the snapshot row it would replace. */
export interface PositionRowContext {
  security: PreviewSecurityRef;
  existing: { quantity: Fixed8 | null; valueCents: bigint } | null;
}

export function toMappedPositionView(p: MappedPosition, ctx: PositionRowContext): MappedPositionView {
  return {
    rowIndex: p.rowIndex,
    security: ctx.security,
    quantity: nullableFx(p.quantity),
    price: nullableFx(p.price),
    valueCents: cents(p.valueCents),
    costBasisCents: nullableCents(p.costBasisCents),
    warnings: [...p.warnings],
    existing: ctx.existing === null ? null : { quantity: nullableFx(ctx.existing.quantity), valueCents: cents(ctx.existing.valueCents) },
  };
}

/** What the preview route resolved for one trade row: its security (null for cash rows) and how it compares with the stored row. */
export interface TradeRowContext {
  security: PreviewSecurityRef | null;
  duplicate: boolean;
  changed: boolean;
  userEdited: boolean;
  ledgerMatch: LedgerMatchView | null;
}

export function toMappedTradeView(t: MappedTrade, ctx: TradeRowContext): MappedTradeView {
  return {
    rowIndex: t.rowIndex,
    sequence: t.sequence,
    date: t.date,
    type: t.type,
    kind: t.kind,
    security: ctx.security,
    quantity: nullableFx(t.quantity),
    price: nullableFx(t.price),
    amountCents: cents(t.amountCents),
    feeCents: cents(t.feeCents),
    splitNum: t.splitNum,
    splitDen: t.splitDen,
    transferDirection: t.transferDirection,
    externalId: t.externalId,
    rawDescription: t.rawDescription,
    derived: [...t.derived],
    warnings: [...t.warnings],
    duplicate: ctx.duplicate,
    changed: ctx.changed,
    userEdited: ctx.userEdited,
    ledgerMatch: ctx.ledgerMatch,
  };
}

export function toActionFoundView(a: ActionFound): ActionFoundView {
  return { key: a.key, sample: a.sample, count: a.count, kind: a.kind, fromProfile: a.fromProfile, sampleRowIndex: a.sampleRowIndex };
}

export function toRowErrors(errors: readonly ImportRowError[]): Array<{ rowIndex: number; message: string }> {
  return errors.map((e) => ({ rowIndex: e.rowIndex, message: e.message }));
}

/** A readable line for an engine warning returned by an import (the preview has no row to attach it to). */
export function engineWarningText(w: EngineWarning): string {
  const parts: string[] = [w.code];
  if (w.detail) parts.push(w.detail);
  else if (w.date) parts.push(w.date);
  return parts.join(": ");
}

export interface PositionsImportOutcome {
  importLogId: string;
  asOf: IsoDate;
  positions: number;
  result: ReplaceHoldingSnapshotResult;
  securitiesCreated: number;
  impliedPrices: number;
  errors: readonly ImportRowError[];
}

export function toPositionsImportResult(o: PositionsImportOutcome): PositionsImportResult {
  return {
    importLogId: o.importLogId,
    asOf: o.asOf,
    positions: o.positions,
    inserted: o.result.inserted,
    updated: o.result.updated,
    unchanged: o.result.unchanged,
    deleted: o.result.deleted,
    securitiesCreated: o.securitiesCreated,
    impliedPrices: o.impliedPrices,
    totalValueCents: cents(o.result.totalValueCents),
    knownBalanceCents: nullableCents(o.result.knownBalanceCents),
    differenceCents: nullableCents(o.result.differenceCents),
    matchesToDollar: o.result.matchesToDollar,
    balanceWritten: o.result.balanceWritten,
    errors: toRowErrors(o.errors),
  };
}

export function toTradesImportResult(importLogId: string, r: ImportTradesResult, errors: readonly ImportRowError[]): TradesImportResult {
  return {
    importLogId,
    created: r.created,
    updated: r.updated,
    unchanged: r.unchanged,
    skippedEdited: r.skippedEdited,
    linked: r.linked,
    ledgerCreated: r.ledgerCreated,
    ledgerSkipped: r.ledgerSkipped,
    transfersPaired: r.transfersPaired,
    securitiesCreated: r.securitiesCreated,
    lotsRebuilt: r.lotsRebuilt,
    warnings: [...r.warnings.map((w) => ({ rowIndex: w.rowIndex, message: w.message })), ...r.rebuildWarnings.map((w) => ({ message: engineWarningText(w) }))],
    errors: toRowErrors(errors),
  };
}
