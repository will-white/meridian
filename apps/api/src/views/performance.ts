import type {
  AccountPerformanceView,
  BenchmarkPerformanceView,
  EngineIncomeMonthView,
  EngineWarningView,
  ExternalFlowView,
  GainSummaryView,
  GainTotalsView,
  HoldingView,
  LotDisposalView,
  LotView,
  LotsResponse,
  PerformanceResponse,
  RealizedGainsResponse,
  RealizedSummaryView,
  RebuildLotsResponse,
  ReturnFigureView,
  SetLotPicksResponse,
  StatementCheckView,
  SubPeriodView,
  XirrFigureView,
} from "@meridian/shared";
import {
  formatFixed8,
  impliedPrice,
  type AccountPerformance,
  type BenchmarkPerformance,
  type DisposalResult,
  type EngineIncomeMonth,
  type EngineWarning,
  type Fixed8,
  type FlowResult,
  type GainSummary,
  type GainTotals,
  type LotResult,
  type PerformanceBlock,
  type PerformanceHolding,
  type RealizedSummary,
  type ReturnFigure,
  type StatementCheck,
  type SubPeriod,
  type XirrFigure,
} from "@meridian/shared";
import type { DisposalRecord, ListLotsResult, ListRealizedResult, LotRecord, PerformanceRecord, RebuildAccountsResult, SetLotPicksResult } from "@meridian/db";
import { toLotPickView } from "./investments.js";

/**
 * Lots, realized gains and performance view mappers (lots design §4.2): engine and service
 * records → the wire contracts. The performance mapper fills tickers, names and classes from
 * the record's `securities` map and account names from `accountNames`; `applyDetail` has
 * already emptied the summary lists, so nothing is stripped here. Pure.
 */

const cents = (n: bigint): string => n.toString();
const nullableCents = (n: bigint | null): string | null => (n === null ? null : n.toString());
const fx = (v: Fixed8): string => formatFixed8(v);
const nullableFx = (v: Fixed8 | null): string | null => (v === null ? null : formatFixed8(v));

type TickerOf = (securityId: string) => string | null;

/** Optional keys are copied only when present (exactOptionalPropertyTypes). */
export function toEngineWarningView(w: EngineWarning, tickerOf?: TickerOf): EngineWarningView {
  const v: EngineWarningView = { code: w.code };
  if (w.accountId !== undefined) v.accountId = w.accountId;
  if (w.securityId !== undefined) {
    v.securityId = w.securityId;
    if (tickerOf) v.ticker = tickerOf(w.securityId);
  }
  if (w.txnId !== undefined) v.txnId = w.txnId;
  if (w.date !== undefined) v.date = w.date;
  if (w.priceDate !== undefined) v.priceDate = w.priceDate;
  if (w.quantity !== undefined) v.quantity = fx(w.quantity);
  if (w.lotsQuantity !== undefined) v.lotsQuantity = fx(w.lotsQuantity);
  if (w.snapshotQuantity !== undefined) v.snapshotQuantity = fx(w.snapshotQuantity);
  if (w.diffCents !== undefined) v.diffCents = cents(w.diffCents);
  if (w.detail !== undefined) v.detail = w.detail;
  return v;
}

export function toLotView(r: LotRecord): LotView {
  return {
    id: r.id,
    openedByTxnId: r.openedByTxnId,
    ordinal: r.ordinal,
    originLotId: r.originLotId,
    accountId: r.accountId,
    accountName: r.accountName,
    securityId: r.securityId,
    ticker: r.ticker,
    securityName: r.securityName,
    openedBy: r.openedBy,
    acquiredDate: r.acquiredDate,
    originalQuantity: fx(r.originalQuantity),
    quantity: fx(r.quantity),
    originalCostBasisCents: nullableCents(r.originalCostBasisCents),
    costBasisCents: nullableCents(r.costBasisCents),
    basisPerShare: nullableFx(r.basisPerShare),
    basisKnown: r.basisKnown,
    closedDate: r.closedDate,
    priceDate: r.priceDate,
    valueCents: nullableCents(r.valueCents),
    unrealizedCents: nullableCents(r.unrealizedCents),
    term: r.term,
  };
}

export function toLotsResponse(r: ListLotsResult): LotsResponse {
  const tickers = new Map<string, string | null>();
  for (const l of r.lots) tickers.set(l.securityId, l.ticker);
  const tickerOf: TickerOf = (id) => tickers.get(id) ?? null;
  return {
    asOf: r.asOf,
    lots: r.lots.map(toLotView),
    accounts: r.accounts.map((a) => ({
      accountId: a.accountId,
      fidelity: a.fidelity,
      lotMethod: a.lotMethod,
      positionCheckDate: a.positionCheckDate,
      warnings: a.warnings.map((w) => toEngineWarningView(w, tickerOf)),
    })),
  };
}

export function toLotDisposalView(d: DisposalRecord): LotDisposalView {
  return {
    accountId: d.accountId,
    accountName: d.accountName,
    securityId: d.securityId,
    ticker: d.ticker,
    closeTxnId: d.closeTxnId,
    lotId: d.lotId,
    kind: d.kind,
    date: d.date,
    acquiredDate: d.acquiredDate,
    quantity: fx(d.quantity),
    proceedsCents: cents(d.proceedsCents),
    basisCents: d.basisKnown ? cents(d.basisCents) : null,
    gainCents: d.basisKnown ? cents(d.gainCents) : null,
    term: d.term,
    basisKnown: d.basisKnown,
  };
}

function toGainTotalsView(g: GainTotals): GainTotalsView {
  return { proceedsCents: cents(g.proceedsCents), basisCents: cents(g.basisCents), gainCents: cents(g.gainCents), count: g.count };
}

export function toRealizedSummaryView(s: RealizedSummary): RealizedSummaryView {
  return {
    shortTerm: toGainTotalsView(s.shortTerm),
    longTerm: toGainTotalsView(s.longTerm),
    unknownBasis: { proceedsCents: cents(s.unknownBasis.proceedsCents), quantity: fx(s.unknownBasis.quantity), count: s.unknownBasis.count },
    transfersOut: { quantity: fx(s.transfersOut.quantity), basisCents: cents(s.transfersOut.basisCents) },
    washSalesApplied: false,
  };
}

export function toRealizedGainsResponse(r: ListRealizedResult): RealizedGainsResponse {
  return {
    from: r.from,
    to: r.to,
    summary: toRealizedSummaryView(r.summary),
    byAccount: r.byAccount.map((a) => ({ accountId: a.accountId, name: a.name, summary: toRealizedSummaryView(a.summary) })),
    disposals: r.disposals.map(toLotDisposalView),
  };
}

export function toSetLotPicksResponse(r: SetLotPicksResult, batchId: string, tickerOf?: TickerOf): SetLotPicksResponse {
  return { picks: r.picks.map(toLotPickView), warnings: r.warnings.map((w) => toEngineWarningView(w, tickerOf)), batchId };
}

export function toRebuildLotsResponse(r: RebuildAccountsResult): RebuildLotsResponse {
  return { accounts: r.accountIds.length, lots: r.lots, disposals: r.disposals, warnings: r.warnings.map((w) => toEngineWarningView(w)) };
}

// ---- Performance (POST /api/investments/performance) ----

function toReturnFigureView(f: ReturnFigure): ReturnFigureView {
  return { rate: f.rate, annualized: f.annualized, reason: f.reason, reasonDate: f.reasonDate };
}

function toXirrFigureView(x: XirrFigure): XirrFigureView {
  return {
    annualized: x.annualized,
    period: x.period,
    investedDays: x.investedDays,
    reason: x.reason,
    warnings: [...x.warnings],
    investorFlows: x.investorFlows.map((f) => ({ date: f.date, amountCents: cents(f.amountCents) })),
  };
}

function toSubPeriodView(s: SubPeriod): SubPeriodView {
  return {
    from: s.from,
    to: s.to,
    beginValueCents: cents(s.beginValueCents),
    flowCents: cents(s.flowCents),
    weightedFlowDollars: s.weightedFlowDollars,
    endValueCents: cents(s.endValueCents),
    rate: s.rate,
    skipped: s.skipped,
    beginCarried: s.beginCarried,
    endCarried: s.endCarried,
  };
}

function toGainSummaryView(g: GainSummary): GainSummaryView {
  return {
    realizedShortCents: cents(g.realizedShortCents),
    realizedLongCents: cents(g.realizedLongCents),
    realizedCents: cents(g.realizedCents),
    unknownBasisProceedsCents: cents(g.unknownBasisProceedsCents),
    unrealizedCents: cents(g.unrealizedCents),
    totalGainCents: cents(g.totalGainCents),
    proceedsCents: cents(g.proceedsCents),
    basisConsumedCents: cents(g.basisConsumedCents),
    transferredOutBasisCents: cents(g.transferredOutBasisCents),
    openValueCents: cents(g.openValueCents),
    openBasisCents: cents(g.openBasisCents),
    originalBasisCents: cents(g.originalBasisCents),
    unpricedSecurityIds: [...g.unpricedSecurityIds],
  };
}

function toStatementCheckView(s: StatementCheck): StatementCheckView {
  return {
    date: s.date,
    statementCents: cents(s.statementCents),
    securitiesCents: cents(s.securitiesCents),
    impliedCashCents: cents(s.impliedCashCents),
    trackedCashCents: cents(s.trackedCashCents),
    trackedFrom: s.trackedFrom,
    differenceCents: cents(s.differenceCents),
  };
}

/** The lots of a `detail: full` response carry the valued columns of the stored lot with the same id (the ids are stable by (opening txn, ordinal)). */
export type LotDetails = ReadonlyMap<string, LotRecord>;

export function toPerformanceResponse(r: PerformanceRecord, lotDetails: LotDetails = new Map()): PerformanceResponse {
  const meta = (id: string) => r.securities.get(id);
  const tickerOf: TickerOf = (id) => meta(id)?.ticker ?? null;
  const nameOf = (id: string) => meta(id)?.name ?? id;
  const accountName = (id: string) => r.accountNames.get(id) ?? id;
  const warnings = (list: readonly EngineWarning[]) => list.map((w) => toEngineWarningView(w, tickerOf));

  const flow = (f: FlowResult): ExternalFlowView => ({
    date: f.date,
    amountCents: cents(f.amountCents),
    kind: f.kind,
    source: f.source,
    accountId: f.accountId,
    counterpartyAccountId: f.counterpartyAccountId,
    counterpartyAccountName: f.counterpartyAccountId === null ? null : accountName(f.counterpartyAccountId),
    internal: f.internal,
    internalReason: f.internalReason,
    sourceId: f.sourceId,
  });

  const benchmark = (b: BenchmarkPerformance | null): BenchmarkPerformanceView | null =>
    b === null
      ? null
      : {
          securityId: b.securityId,
          ticker: tickerOf(b.securityId),
          name: nameOf(b.securityId),
          adjusted: b.adjusted,
          twr: toReturnFigureView(b.twr),
          xirr: toXirrFigureView(b.xirr),
          shadowValueCents: cents(b.shadowValueCents),
          startPrice: fx(b.startPrice),
          endPrice: fx(b.endPrice),
          legs: b.legs.map((l) => ({ date: l.date, cents: cents(l.cents), price: fx(l.price), priceDate: l.priceDate, units: fx(l.units) })),
        };

  const income = (m: EngineIncomeMonth): EngineIncomeMonthView => ({
    month: m.month,
    securityId: m.securityId,
    ticker: m.securityId === null ? null : tickerOf(m.securityId),
    dividendCents: cents(m.dividendCents),
    interestCents: cents(m.interestCents),
    feeCents: cents(m.feeCents),
    reinvestedCents: cents(m.reinvestedCents),
  });

  const block = (b: PerformanceBlock) => ({
    method: b.method,
    startValueCents: cents(b.startValueCents),
    endValueCents: cents(b.endValueCents),
    openingValue: b.openingValue === null ? null : { date: b.openingValue.date, cents: cents(b.openingValue.cents) },
    contributionsCents: cents(b.contributionsCents),
    withdrawalsCents: cents(b.withdrawalsCents),
    netFlowsCents: cents(b.netFlowsCents),
    growthCents: cents(b.growthCents),
    twr: toReturnFigureView(b.twr),
    xirr: toXirrFigureView(b.xirr),
    benchmark: benchmark(b.benchmark),
    subPeriods: b.subPeriods.map(toSubPeriodView),
    flows: b.flows.map(flow),
    realized: b.realized === null ? null : toRealizedSummaryView(b.realized),
    gains: b.gains === null ? null : toGainSummaryView(b.gains),
    income: b.income.map(income),
    warnings: warnings(b.warnings),
  });

  const holding = (accountId: string, h: PerformanceHolding): HoldingView => ({
    accountId,
    securityId: h.securityId,
    ticker: h.securityId === null ? null : tickerOf(h.securityId),
    securityName: h.securityId === null ? "Cash" : nameOf(h.securityId),
    assetClass: h.securityId === null ? "cash" : (meta(h.securityId)?.assetClass ?? "other"),
    quantity: fx(h.quantity),
    priceDate: h.priceDate,
    price: nullableFx(h.price),
    priceSource: h.priceSource,
    stale: h.stale,
    valueCents: nullableCents(h.valueCents),
    costBasisCents: nullableCents(h.costBasisCents),
    unrealizedCents: nullableCents(h.unrealizedCents),
    unrealizedShortCents: cents(h.unrealizedShortCents),
    unrealizedLongCents: cents(h.unrealizedLongCents),
    unknownBasisQuantity: fx(h.unknownBasisQuantity),
    lotCount: h.lotCount,
  });

  const lot = (l: LotResult): LotView => {
    const detail = lotDetails.get(l.id);
    return {
      id: l.id,
      openedByTxnId: l.openedByTxnId,
      ordinal: l.ordinal,
      originLotId: l.originLotId,
      accountId: l.accountId,
      accountName: accountName(l.accountId),
      securityId: l.securityId,
      ticker: tickerOf(l.securityId),
      securityName: nameOf(l.securityId),
      openedBy: l.openedBy,
      acquiredDate: l.acquiredDate,
      originalQuantity: fx(l.originalQuantity),
      quantity: fx(l.quantity),
      originalCostBasisCents: l.basisKnown ? cents(l.originalCostBasisCents) : null,
      costBasisCents: l.basisKnown ? cents(l.costBasisCents) : null,
      basisPerShare: detail ? nullableFx(detail.basisPerShare) : l.basisKnown && l.quantity > 0n ? fx(impliedPrice(l.costBasisCents, l.quantity)) : null,
      basisKnown: l.basisKnown,
      closedDate: l.closedDate,
      priceDate: detail?.priceDate ?? null,
      valueCents: detail ? nullableCents(detail.valueCents) : null,
      unrealizedCents: detail ? nullableCents(detail.unrealizedCents) : null,
      term: detail?.term ?? "unknown",
    };
  };

  const disposal = (d: DisposalResult): LotDisposalView => ({
    accountId: d.accountId,
    accountName: accountName(d.accountId),
    securityId: d.securityId,
    ticker: tickerOf(d.securityId),
    closeTxnId: d.closeTxnId,
    lotId: d.lotId,
    kind: d.kind,
    date: d.date,
    acquiredDate: d.acquiredDate,
    quantity: fx(d.quantity),
    proceedsCents: cents(d.proceedsCents),
    basisCents: d.basisKnown ? cents(d.basisCents) : null,
    gainCents: d.basisKnown ? cents(d.gainCents) : null,
    term: d.term,
    basisKnown: d.basisKnown,
  });

  const account = (a: AccountPerformance): AccountPerformanceView => ({
    accountId: a.accountId,
    name: a.name,
    type: a.type,
    taxTreatment: a.taxTreatment,
    fidelity: a.fidelity,
    ...block(a),
    holdings: a.holdings.map((h) => holding(a.accountId, h)),
    lots: a.lots.map(lot),
    disposals: a.disposals.map(disposal),
    statementCheck: a.statementCheck === null ? null : toStatementCheckView(a.statementCheck),
  });

  return {
    from: r.from,
    to: r.to,
    asOf: r.asOf,
    today: r.today,
    days: r.days,
    detail: r.detail,
    accounts: r.accounts.map(account),
    total: {
      ...block(r.total),
      accountIds: [...r.total.accountIds],
      partialGains: r.total.partialGains,
      excludedInternalFlows: r.total.excludedInternalFlows,
      excludedAccountIds: [...r.total.excludedAccountIds],
    },
    benchmark: benchmark(r.benchmark),
    warnings: warnings(r.warnings),
  };
}
