import type {
  AccountChangesView,
  AccountRef,
  AccountWarningView,
  AllocationView,
  BenchmarkBlockView,
  ChangeSummaryView,
  ExternalFlowView,
  FlowsSource,
  HoldingsView,
  IncomeRowView,
  IncomeView,
  IndexSeriesView,
  PerformanceView,
  PeriodView,
  PortfolioView,
  ReturnBlockView,
  RunIncomeFeedResponse,
  SecurityRef,
} from "@meridian/shared";
import {
  formatFixed8,
  ReturnFailureReason,
  returnReasonText,
  type EngineWarning,
  type Fixed8,
  type FlowResult,
  type InvestmentPeriod,
  type IsoDate,
  type PerformanceBlock,
  type SubPeriod,
} from "@meridian/shared";
import type {
  AccountChangesRecord,
  AccountRefRecord,
  AccountWarningRecord,
  AllocationRecord,
  ChangeSummaryRecord,
  ExternalFlowRecord,
  HoldingsRecord,
  IncomeRecord,
  IncomeRowRecord,
  PerformanceRecord,
  PeriodBounds,
  PortfolioRecord,
  RunIncomeFeedResult,
} from "@meridian/db";
import { engineWarningText } from "./investments.js";
import { toEngineWarningView } from "./performance.js";
import { toPortfolioDayChangeView } from "./valuation.js";

/**
 * Investment view mappers (views design §4; `routes/investmentViews.ts`): the view services'
 * bigint records → the wire contracts. Cents as decimal strings, Fixed8 as canonical strings,
 * timestamps as ISO text. The Performance view is the presentation of the engine's own
 * `PerformanceRecord` (plan decision 17: a test asserts the GET equals the POST), with the chart
 * index series and readable reasons added here. Pure.
 */

const cents = (n: bigint): string => n.toString();
const nullableCents = (n: bigint | null): string | null => (n === null ? null : n.toString());
const fx = (v: Fixed8): string => formatFixed8(v);
const nullableFx = (v: Fixed8 | null): string | null => (v === null ? null : formatFixed8(v));

// ---- Shared fragments ----

export function toAccountRefView(r: AccountRefRecord): AccountRef {
  return { accountId: r.accountId, accountName: r.accountName, type: r.type, taxTreatment: r.taxTreatment, fidelity: r.fidelity, fidelityNote: r.fidelityNote };
}

export function toAccountWarningView(w: AccountWarningRecord): AccountWarningView {
  return { accountId: w.accountId, accountName: w.accountName, kind: w.kind, message: w.message };
}

export function toPeriodView(p: PeriodBounds): PeriodView {
  return { kind: p.kind, from: p.from, to: p.to, days: p.days, partial: p.partial, note: p.note };
}

export function toChangeSummaryView(c: ChangeSummaryRecord): ChangeSummaryView {
  return {
    from: c.from,
    to: c.to,
    startCents: nullableCents(c.startCents),
    endCents: cents(c.endCents),
    changeCents: nullableCents(c.changeCents),
    changeBp: c.changeBp,
    netFlowsCents: cents(c.netFlowsCents),
    growthCents: nullableCents(c.growthCents),
    growthReason: c.growthReason,
    incomeCents: cents(c.incomeCents),
    uncategorizedRows: c.uncategorizedRows,
    partial: c.partial,
    missingAccountIds: [...c.missingAccountIds],
  };
}

export function toIncomeRowView(r: IncomeRowRecord): IncomeRowView {
  return {
    id: r.id,
    date: r.date,
    month: r.month,
    accountId: r.accountId,
    accountName: r.accountName,
    securityId: r.securityId,
    ticker: r.ticker,
    kind: r.kind,
    cents: cents(r.cents),
    reinvested: r.reinvested,
    source: r.source,
    ledgerTransactionId: r.ledgerTransactionId,
    linkStatus: r.linkStatus,
    fed: r.fed,
  };
}

function toExternalFlowView(f: ExternalFlowRecord): ExternalFlowView {
  return {
    date: f.date,
    amountCents: cents(f.amountCents),
    kind: f.kind,
    source: f.source,
    accountId: f.accountId,
    counterpartyAccountId: f.counterpartyAccountId,
    counterpartyAccountName: f.counterpartyAccountName,
    internal: f.internal,
    internalReason: f.internalReason,
    sourceId: f.sourceId,
  };
}

// ---- Portfolio ----

export function toPortfolioView(r: PortfolioRecord): PortfolioView {
  return {
    today: r.today,
    asOf: r.asOf,
    period: r.period === null ? null : toPeriodView(r.period),
    totalCents: cents(r.totalCents),
    dayChange: toPortfolioDayChangeView(r.dayChange),
    periodChange: r.periodChange === null ? null : toChangeSummaryView(r.periodChange),
    accounts: r.accounts.map((a) => ({
      ...toAccountRefView(a),
      valuationDate: a.valuationDate,
      valuationSource: a.valuationSource,
      basis: a.basis,
      valuationStale: a.valuationStale,
      positionsDate: a.positionsDate,
      positionsStale: a.positionsStale,
      valueCents: nullableCents(a.valueCents),
      dayChangeCents: nullableCents(a.dayChangeCents),
      dayChangeBp: a.dayChangeBp,
      holdingsCount: a.holdingsCount,
      cashCents: nullableCents(a.cashCents),
      residualCents: nullableCents(a.residualCents),
      closed: a.closed,
      investmentIncomeFeed: a.investmentIncomeFeed,
      period: a.period === null ? null : toChangeSummaryView(a.period),
      warnings: a.warnings.map(toAccountWarningView),
    })),
    series: {
      dates: [...r.series.dates],
      step: r.series.step,
      total: r.series.total.map(nullableCents),
      accounts: r.series.accounts.map((a) => ({ accountId: a.accountId, points: a.points.map(nullableCents) })),
    },
    fidelityCounts: { ...r.fidelityCounts },
    warnings: [...r.warnings],
  };
}

// ---- Allocation ----

export function toAllocationView(r: AllocationRecord): AllocationView {
  return {
    today: r.today,
    asOf: r.asOf,
    totalCents: cents(r.totalCents),
    classifiedCents: cents(r.classifiedCents),
    unclassifiedCents: cents(r.unclassifiedCents),
    targetsSet: r.targetsSet,
    classes: r.classes.map((c) => ({
      assetClass: c.assetClass,
      currentCents: cents(c.currentCents),
      currentBp: c.currentBp,
      targetBp: c.targetBp,
      targetCents: nullableCents(c.targetCents),
      driftBp: c.driftBp,
      driftCents: nullableCents(c.driftCents),
      outOfBand: c.outOfBand,
      lines: c.lines.map((l) => ({
        securityId: l.securityId,
        ticker: l.ticker,
        name: l.name,
        accountId: l.accountId,
        accountName: l.accountName,
        cents: cents(l.cents),
        kind: l.kind,
        blended: l.blended,
      })),
    })),
    byTaxTreatment: r.byTaxTreatment.map((t) => ({ taxTreatment: t.taxTreatment, cents: cents(t.cents), bp: t.bp, classes: t.classes.map((c) => ({ assetClass: c.assetClass, cents: cents(c.cents) })) })),
    byAccount: r.byAccount.map((a) => ({
      ...toAccountRefView(a),
      cents: cents(a.cents),
      bp: a.bp,
      classes: a.classes.map((c) => ({ assetClass: c.assetClass, cents: cents(c.cents), bp: c.bp })),
    })),
    unclassifiedAccounts: r.unclassifiedAccounts.map((a) => ({ ...toAccountRefView(a), cents: cents(a.cents), bpOfTotal: a.bpOfTotal })),
    rebalance:
      r.rebalance === null
        ? null
        : {
            triggered: r.rebalance.triggered,
            bandBp: r.rebalance.bandBp,
            minTradeCents: cents(r.rebalance.minTradeCents),
            trades: r.rebalance.trades.map((t) => ({
              accountId: t.accountId,
              accountName: t.accountName,
              taxTreatment: t.taxTreatment,
              action: t.action,
              assetClass: t.assetClass,
              securityId: t.securityId,
              ticker: t.ticker,
              inAccount: t.inAccount,
              amountCents: cents(t.amountCents),
              approxQuantity: nullableFx(t.approxQuantity),
              price: nullableFx(t.price),
              estimatedGainCents: nullableCents(t.estimatedGainCents),
              note: t.note,
            })),
            residual: r.rebalance.residual.map((x) => ({ assetClass: x.assetClass, amountCents: cents(x.amountCents) })),
            belowMinimumCents: cents(r.rebalance.belowMinimumCents),
            notes: [...r.rebalance.notes],
          },
    warnings: [...r.warnings],
    accountWarnings: r.accountWarnings.map(toAccountWarningView),
  };
}

// ---- Holdings ----

export function toHoldingsView(r: HoldingsRecord): HoldingsView {
  return {
    today: r.today,
    asOf: r.asOf,
    totalCents: cents(r.totalCents),
    holdingsCents: cents(r.holdingsCents),
    cashCents: cents(r.cashCents),
    residualCents: cents(r.residualCents),
    rows: r.rows.map((row) => {
      const ref: SecurityRef = {
        securityId: row.securityId,
        ticker: row.ticker,
        name: row.name,
        type: row.type,
        assetClass: row.assetClass,
        splits: row.splits.map((s) => ({ assetClass: s.assetClass, weightBp: s.weightBp })),
        needsReview: row.needsReview,
      };
      return {
        ...ref,
        quantity: nullableFx(row.quantity),
        price: nullableFx(row.price),
        priceDate: row.priceDate,
        priceSource: row.priceSource,
        priceStatus: row.priceStatus,
        priceStale: row.priceStale,
        valueCents: cents(row.valueCents),
        weightBp: row.weightBp,
        costBasisCents: nullableCents(row.costBasisCents),
        coverage: row.coverage,
        gainCents: nullableCents(row.gainCents),
        gainBp: row.gainBp,
        expenseRatioPpm: row.expenseRatioPpm,
        accounts: row.accounts.map((a) => ({
          ...toAccountRefView(a),
          kind: a.kind,
          quantity: nullableFx(a.quantity),
          valueCents: cents(a.valueCents),
          costBasisCents: nullableCents(a.costBasisCents),
          basisSource: a.basisSource,
          gainCents: nullableCents(a.gainCents),
          lotCount: a.lotCount,
          unknownBasisQuantity: nullableFx(a.unknownBasisQuantity),
          snapshotDate: a.snapshotDate,
          snapshotSource: a.snapshotSource,
          priceSource: a.priceSource,
          dollarOnly: a.dollarOnly,
        })),
      };
    }),
    weightedExpenseRatio: { ppm: r.weightedExpenseRatio.ppm, coveredBp: r.weightedExpenseRatio.coveredBp, annualCostCents: cents(r.weightedExpenseRatio.annualCostCents) },
    concentration: r.concentration.map((c) => ({ level: c.level, securityId: c.securityId, ticker: c.ticker, weightBp: c.weightBp, thresholdBp: c.thresholdBp, message: c.message })),
    excludedAccounts: r.excludedAccounts.map((a) => ({ ...toAccountRefView(a), cents: nullableCents(a.cents) })),
    accountWarnings: r.accountWarnings.map(toAccountWarningView),
    warnings: [...r.warnings],
  };
}

// ---- Income ----

export function toIncomeView(r: IncomeRecord): IncomeView {
  return {
    today: r.today,
    asOf: r.asOf,
    period: r.period === null ? null : toPeriodView(r.period),
    months: r.months.map((m) => ({
      month: m.month,
      dividendsCents: cents(m.dividendsCents),
      interestCents: cents(m.interestCents),
      feesCents: cents(m.feesCents),
      reinvestedCents: cents(m.reinvestedCents),
      totalCents: cents(m.totalCents),
      bySecurity: m.bySecurity.map((s) => ({ securityId: s.securityId, ticker: s.ticker, cents: cents(s.cents) })),
      byAccount: m.byAccount.map((a) => ({ accountId: a.accountId, cents: cents(a.cents) })),
    })),
    totals: {
      dividendsCents: cents(r.totals.dividendsCents),
      interestCents: cents(r.totals.interestCents),
      feesCents: cents(r.totals.feesCents),
      reinvestedCents: cents(r.totals.reinvestedCents),
      totalCents: cents(r.totals.totalCents),
    },
    trailing12mCents: cents(r.trailing12mCents),
    yieldBp: r.yieldBp,
    rows: r.rows.map(toIncomeRowView),
    rowsTruncated: r.rowsTruncated,
    feed: {
      categoryId: r.feed.categoryId,
      categoryName: r.feed.categoryName,
      accounts: r.feed.accounts.map((a) => ({
        accountId: a.accountId,
        accountName: a.accountName,
        type: a.type,
        taxTreatment: a.taxTreatment,
        fidelity: a.fidelity,
        fidelityNote: a.fidelityNote,
        mode: a.mode,
        linked: a.linked,
        created: a.created,
        awaiting: a.awaiting,
        fed: a.fed,
        hasLedger: a.hasLedger,
        suggestedMode: a.suggestedMode,
      })),
    },
    warnings: [...r.warnings],
  };
}

export function toRunIncomeFeedResponse(r: RunIncomeFeedResult): RunIncomeFeedResponse {
  return { categorized: r.categorized, created: r.created, upgraded: r.upgraded, awaiting: r.awaiting, unchanged: r.unchanged, deleted: r.deleted };
}

// ---- Why did it change ----

export function toAccountChangesView(r: AccountChangesRecord): AccountChangesView {
  return {
    ...toAccountRefView(r),
    from: r.from,
    to: r.to,
    summary: toChangeSummaryView(r.summary),
    holdings: r.holdings.map((h) => ({
      securityId: h.securityId,
      ticker: h.ticker,
      name: h.name,
      kind: h.kind,
      quantityFrom: nullableFx(h.quantityFrom),
      quantityTo: nullableFx(h.quantityTo),
      priceFrom: nullableFx(h.priceFrom),
      priceTo: nullableFx(h.priceTo),
      valueFromCents: cents(h.valueFromCents),
      valueToCents: cents(h.valueToCents),
      deltaCents: cents(h.deltaCents),
      priceEffectCents: cents(h.priceEffectCents),
      quantityEffectCents: cents(h.quantityEffectCents),
    })),
    residualEffectCents: cents(r.residualEffectCents),
    flows: r.flows.map(toExternalFlowView),
    income: r.income.map(toIncomeRowView),
    warnings: [...r.warnings],
  };
}

// ---- Performance (the GET presentation of the engine's POST) ----

/** What the route adds to the engine record: the period, the benchmark's identity and closes, fidelity notes and the ledger's uncategorized counts. */
export interface PerformanceViewExtras {
  today: IsoDate;
  periodKind: InvestmentPeriod;
  /** `periodBounds` for a preset or custom period; null for `all` (the engine's since-inception range stands in). */
  period: PeriodBounds | null;
  /** The benchmark in force (query override ?? household setting); null = none requested. */
  benchmark: { securityId: string; ticker: string | null; name: string } | null;
  /** The benchmark's closes: the latest on or before `from` first, then ascending through `to`. */
  benchmarkCloses: ReadonlyArray<{ date: IsoDate; close: Fixed8 }>;
  fidelityNotes: ReadonlyMap<string, string | null>;
  /** Uncategorized ledger rows in (from, to] per account id, and for the whole selection under `total`. */
  uncategorized: ReadonlyMap<string, number>;
}

/** Chart points at the engine's sub-period boundaries: 10 000 at `from`, then round(10000 × Π(1 + rⱼ)) over the non-skipped sub-periods. */
export function indexSeriesOf(from: IsoDate, to: IsoDate, subPeriods: readonly SubPeriod[], fallbackRate: number | null): IndexSeriesView {
  const out: IndexSeriesView = [{ date: from, indexBp: 10000 }];
  if (subPeriods.length === 0) {
    if (fallbackRate !== null && Number.isFinite(fallbackRate)) out.push({ date: to, indexBp: Math.round(10000 * (1 + fallbackRate)) });
    return out;
  }
  let cum = 1;
  for (const s of subPeriods) {
    if (s.skipped || s.rate === null || !Number.isFinite(s.rate)) continue;
    cum *= 1 + s.rate;
    out.push({ date: s.to, indexBp: Math.round(10000 * cum) });
  }
  return out;
}

/** `round(10000 × B(d) / B(from))` at the given dates, `B(d)` the latest close on or before `d`; empty without a close on or before `from`. */
export function benchmarkIndexSeriesOf(from: IsoDate, dates: readonly IsoDate[], closes: ReadonlyArray<{ date: IsoDate; close: Fixed8 }>): IndexSeriesView {
  const closeOn = (d: IsoDate): Fixed8 | null => {
    let found: Fixed8 | null = null;
    for (const c of closes) {
      if (c.date > d) break;
      if (c.close > 0n) found = c.close;
    }
    return found;
  };
  const base = closeOn(from);
  if (base === null) return [];
  const baseN = Number(base);
  const out: IndexSeriesView = [];
  for (const d of [from, ...dates.filter((x) => x > from)]) {
    const c = closeOn(d);
    if (c === null) continue;
    out.push({ date: d, indexBp: Math.round((10000 * Number(c)) / baseN) });
  }
  return out;
}

/** The provenance of a block's external flows (opening values are the engine's, not a feed). */
export function flowsSourceOf(flows: readonly FlowResult[]): FlowsSource {
  let ledger = false;
  let investment = false;
  for (const f of flows) {
    if (f.source === "ledger") ledger = true;
    else if (f.source === "investment_txn") investment = true;
  }
  if (ledger && investment) return "mixed";
  if (ledger) return "ledger";
  if (investment) return "investment";
  return "none";
}

const FAILURE_REASONS = new Set<string>(ReturnFailureReason.options);

/** One readable line per distinct reason (twr, xirr, benchmark) and engine warning. */
function readableOf(block: PerformanceBlock, from: IsoDate, benchmarkMissing: boolean): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  if (block.twr.reason !== null) push(returnReasonText(block.twr.reason, block.twr.reasonDate));
  if (block.xirr.reason !== null) push(returnReasonText(block.xirr.reason, null));
  if (benchmarkMissing) push(returnReasonText("no_benchmark_price", from));
  for (const w of block.warnings) {
    if (FAILURE_REASONS.has(w.code)) push(returnReasonText(w.code as ReturnFailureReason, w.date ?? null));
    else push(engineWarningText(w));
  }
  return out;
}

export function toPerformanceView(r: PerformanceRecord, x: PerformanceViewExtras): PerformanceView {
  const meta = (id: string) => r.securities.get(id);
  const tickerOf = (id: string) => meta(id)?.ticker ?? null;
  const accountName = (id: string) => r.accountNames.get(id) ?? id;
  const benchmarkMissing = x.benchmark !== null && r.benchmark === null;

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

  const benchmarkBlock = (b: PerformanceBlock): BenchmarkBlockView | null => {
    if (x.benchmark === null) return null;
    if (b.benchmark === null) {
      return { twr: null, twrAnnualized: null, xirrAnnualized: null, shadowValueCents: null, excessTwr: null, startPrice: null, endPrice: null, reason: "no_benchmark_price" };
    }
    const bench = b.benchmark;
    return {
      twr: bench.twr.rate,
      twrAnnualized: bench.twr.annualized,
      xirrAnnualized: bench.xirr.annualized,
      shadowValueCents: cents(bench.shadowValueCents),
      excessTwr: b.twr.rate !== null && bench.twr.rate !== null ? b.twr.rate - bench.twr.rate : null,
      startPrice: fx(bench.startPrice),
      endPrice: fx(bench.endPrice),
      reason: bench.twr.reason,
    };
  };

  const block = (b: PerformanceBlock, key: string): ReturnBlockView => ({
    method: b.method,
    startValueCents: cents(b.startValueCents),
    endValueCents: cents(b.endValueCents),
    openingValue: b.openingValue === null ? null : { date: b.openingValue.date, cents: cents(b.openingValue.cents) },
    contributionsCents: cents(b.contributionsCents),
    withdrawalsCents: cents(b.withdrawalsCents),
    netFlowsCents: cents(b.netFlowsCents),
    growthCents: cents(b.growthCents),
    twr: { rate: b.twr.rate, annualized: b.twr.annualized, reason: b.twr.reason, reasonDate: b.twr.reasonDate },
    xirr: {
      annualized: b.xirr.annualized,
      period: b.xirr.period,
      investedDays: b.xirr.investedDays,
      reason: b.xirr.reason,
      warnings: [...b.xirr.warnings],
      investorFlows: b.xirr.investorFlows.map((f) => ({ date: f.date, amountCents: cents(f.amountCents) })),
    },
    benchmark: benchmarkBlock(b),
    flows: b.flows.map(flow),
    flowsSource: flowsSourceOf(b.flows),
    uncategorizedRows: x.uncategorized.get(key) ?? 0,
    warnings: b.warnings.map((w: EngineWarning) => toEngineWarningView(w, tickerOf)),
    readable: readableOf(b, r.from, benchmarkMissing),
    series: indexSeriesOf(r.from, r.to, b.subPeriods, b.twr.rate),
  });

  const period: PeriodView = x.period !== null ? toPeriodView(x.period) : { kind: x.periodKind, from: r.from, to: r.to, days: r.days, partial: false, note: null };
  const totalDates = r.total.subPeriods.filter((s) => !s.skipped).map((s) => s.to);
  const warnings: string[] = [];
  if (period.note !== null) warnings.push(period.note);

  return {
    today: x.today,
    asOf: r.asOf,
    period,
    benchmark:
      x.benchmark === null
        ? null
        : {
            securityId: x.benchmark.securityId,
            ticker: x.benchmark.ticker,
            name: x.benchmark.name,
            adjusted: r.benchmark?.adjusted ?? false,
            series: r.benchmark === null ? [] : benchmarkIndexSeriesOf(r.from, totalDates.length > 0 ? totalDates : [r.to], x.benchmarkCloses),
          },
    total: r.accounts.length === 0 ? null : block(r.total, "total"),
    accounts: r.accounts.map((a) => ({
      accountId: a.accountId,
      accountName: a.name,
      type: a.type,
      taxTreatment: a.taxTreatment,
      fidelity: a.fidelity,
      fidelityNote: x.fidelityNotes.get(a.accountId) ?? null,
      block: block(a, a.accountId),
    })),
    warnings,
  };
}
