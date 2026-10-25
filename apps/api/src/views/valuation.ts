import type {
  AccountValuationView,
  DayChangeView,
  LastReconciliationView,
  LineValuationView,
  PeriodChangeView,
  PortfolioDayChangeView,
  PriceHistoryResponse,
  PricesStatusResponse,
  PriceView,
  ReconcileCommitResponse,
  ReconcilePreviewResponse,
  ReconciliationView,
  ReconcileRowView,
  SecurityPriceStatusView,
  ValuationSeriesResponse,
  ValuationSummaryResponse,
} from "@meridian/shared";
import { formatFixed8, type AccountDayChange, type AccountValuation, type Fixed8, type LineValuation, type PortfolioDayChange } from "@meridian/shared";
import type {
  LastReconciliationRecord,
  PeriodChangeRecord,
  PriceRecord,
  PricesStatus,
  ReconcileCommitRecord,
  ReconcilePreviewRecord,
  ReconcileRowRecord,
  ReconciliationRecord,
  SecurityPriceStatusRecord,
  ValuationSeriesRecord,
  ValuationSummaryRecord,
} from "@meridian/db";

/**
 * Prices, valuation and reconciliation view mappers (prices design §4, §4.1): the services'
 * bigint records → the wire contracts of packages/shared/src/api.ts. Cents travel as decimal
 * strings, quantities and prices as canonical Fixed8 strings, timestamps as ISO text, dates
 * untouched. Pure; one function per contract.
 */

const cents = (n: bigint): string => n.toString();
const nullableCents = (n: bigint | null): string | null => (n === null ? null : n.toString());
const fx = (v: Fixed8): string => formatFixed8(v);
const nullableFx = (v: Fixed8 | null): string | null => (v === null ? null : formatFixed8(v));
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

// ---- Prices ----

export function toPriceView(r: PriceRecord): PriceView {
  return {
    securityId: r.securityId,
    date: r.date,
    close: fx(r.close),
    adjClose: nullableFx(r.adjClose),
    source: r.source,
    provider: r.provider,
    suspect: r.suspect,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toSecurityPriceStatusView(r: SecurityPriceStatusRecord): SecurityPriceStatusView {
  return {
    securityId: r.securityId,
    ticker: r.ticker,
    name: r.name,
    priceMode: r.priceMode,
    providerSymbol: r.providerSymbol,
    alwaysPrice: r.alwaysPrice,
    held: r.held,
    latestPriceDate: r.latestPriceDate,
    latestClose: nullableFx(r.latestClose),
    latestSource: r.latestSource,
    priceStatus: r.priceStatus,
    tradingDaysBehind: r.tradingDaysBehind,
    fetchStatus: r.fetchStatus,
    fetchMessage: r.fetchMessage,
    fetchedAt: iso(r.fetchedAt),
    failures: r.failures,
    nextAttemptAt: iso(r.nextAttemptAt),
    backfilledFrom: r.backfilledFrom,
  };
}

export function toPricesStatusResponse(s: PricesStatus): PricesStatusResponse {
  return {
    provider: s.provider,
    configured: s.configured,
    fetchHourLocal: s.fetchHourLocal,
    catchupHourLocal: s.catchupHourLocal,
    timezone: s.timezone,
    expectedDate: s.expectedDate,
    lastRun:
      s.lastRun === null
        ? null
        : {
            importLogId: s.lastRun.importLogId,
            startedAt: s.lastRun.startedAt.toISOString(),
            finishedAt: iso(s.lastRun.finishedAt),
            status: s.lastRun.status,
            message: s.lastRun.message,
            stats: s.lastRun.stats,
          },
    activeJob: s.activeJob === null ? null : { id: s.activeJob.id, status: s.activeJob.status, reason: s.activeJob.reason, runAt: s.activeJob.runAt.toISOString() },
    securities: s.securities.map(toSecurityPriceStatusView),
    counts: { ...s.counts },
  };
}

export interface PriceHistoryRecord {
  securityId: string;
  status: { priceMode: PriceRecord["source"]; expectedDate: PriceHistoryResponse["expectedDate"]; latest: PriceRecord | null; priceStatus: PriceHistoryResponse["priceStatus"]; tradingDaysBehind: number };
  /** Descending by date. */
  items: PriceRecord[];
}

export function toPriceHistoryResponse(r: PriceHistoryRecord): PriceHistoryResponse {
  return {
    securityId: r.securityId,
    priceMode: r.status.priceMode,
    expectedDate: r.status.expectedDate,
    latest: r.status.latest === null ? null : toPriceView(r.status.latest),
    priceStatus: r.status.priceStatus,
    tradingDaysBehind: r.status.tradingDaysBehind,
    items: r.items.map(toPriceView),
  };
}

// ---- Valuation ----

export function toLineValuationView(l: LineValuation): LineValuationView {
  return {
    securityId: l.securityId,
    ticker: l.ticker,
    name: l.name,
    kind: l.kind,
    quantity: nullableFx(l.quantity),
    price: nullableFx(l.price),
    priceDate: l.priceDate,
    priceSource: l.priceSource,
    priceStatus: l.priceStatus,
    tradingDaysBehind: l.tradingDaysBehind,
    valueCents: nullableCents(l.valueCents),
    valueSource: l.valueSource,
  };
}

/** The account's day change; an account the engine did not report (none selected) reads as not computed. */
export function toDayChangeView(d: Pick<AccountDayChange, "cents" | "asOf" | "prior" | "reason"> | null): DayChangeView {
  if (d === null) return { cents: null, asOf: null, prior: null, reason: null };
  return { cents: nullableCents(d.cents), asOf: d.asOf, prior: d.prior, reason: d.reason };
}

export function toLastReconciliationView(r: LastReconciliationRecord | null): LastReconciliationView | null {
  if (r === null) return null;
  return { id: r.id, statementDate: r.statementDate, diffCents: nullableCents(r.diffCents), reconciled: r.reconciled, accepted: r.accepted, createdAt: r.createdAt.toISOString() };
}

/** What the summary service attaches to the engine's valuation (the reconcile routes compute the same two). */
export interface AccountValuationExtras {
  dayChange: Pick<AccountDayChange, "cents" | "asOf" | "prior" | "reason"> | null;
  lastReconciliation: LastReconciliationRecord | null;
}

export function toAccountValuationView(v: AccountValuation, extras: AccountValuationExtras): AccountValuationView {
  return {
    accountId: v.accountId,
    name: v.name,
    type: v.type,
    taxTreatment: v.taxTreatment,
    fidelity: v.fidelity,
    cashInference: v.cashInference,
    date: v.date,
    basis: v.basis,
    asOf: v.asOf,
    valueCents: nullableCents(v.valueCents),
    priceStatus: v.priceStatus,
    stalest: v.stalest === null ? null : { securityId: v.stalest.securityId, priceDate: v.stalest.priceDate, tradingDaysBehind: v.stalest.tradingDaysBehind },
    missing: [...v.missing],
    balanceDiffCents: nullableCents(v.balanceDiffCents),
    cashAnchor: v.cashAnchor,
    lines: v.lines.map(toLineValuationView),
    dayChange: toDayChangeView(extras.dayChange),
    lastReconciliation: toLastReconciliationView(extras.lastReconciliation),
    warnings: v.warnings.map((w) => w.message),
  };
}

export function toPortfolioDayChangeView(d: PortfolioDayChange): PortfolioDayChangeView {
  return {
    cents: nullableCents(d.cents),
    asOf: d.asOf,
    prior: d.prior,
    reason: d.reason,
    bp: d.bp,
    partial: d.partial,
    excluded: d.excluded.map((e) => ({ accountId: e.accountId, reason: e.reason })),
  };
}

export function toPeriodChangeView(p: PeriodChangeRecord): PeriodChangeView {
  return {
    period: p.period,
    from: p.from,
    to: p.to,
    startCents: nullableCents(p.startCents),
    endCents: cents(p.endCents),
    changeCents: nullableCents(p.changeCents),
    changeBp: p.changeBp,
    netFlowsCents: cents(p.netFlowsCents),
    growthCents: nullableCents(p.growthCents),
    growthReason: p.growthReason,
    incomeCents: cents(p.incomeCents),
    uncategorizedRows: p.uncategorizedRows,
    partial: p.partial,
    missingAccountIds: [...p.missing],
    newAccounts: p.newAccounts.map((a) => ({ id: a.id, name: a.name, openingCents: cents(a.openingCents) })),
  };
}

export function toValuationSummaryResponse(s: ValuationSummaryRecord): ValuationSummaryResponse {
  return {
    asOf: s.asOf,
    today: s.today,
    expectedDate: s.expectedDate,
    totalCents: nullableCents(s.totalCents),
    partial: s.partial,
    missing: [...s.missing],
    priceStatus: s.priceStatus,
    dayChange: toPortfolioDayChangeView(s.dayChange),
    periodChange: s.periodChange === null ? null : toPeriodChangeView(s.periodChange),
    accounts: s.accounts.map((a) => toAccountValuationView(a, { dayChange: a.dayChange, lastReconciliation: a.lastReconciliation })),
  };
}

export function toValuationSeriesResponse(s: ValuationSeriesRecord): ValuationSeriesResponse {
  return {
    from: s.from,
    to: s.to,
    expectedDate: s.expectedDate,
    dates: [...s.dates],
    accounts: s.accounts.map((a) => ({ accountId: a.accountId, name: a.name, type: a.type, fidelity: a.fidelity, firstDataDate: a.firstDataDate, values: a.values.map(nullableCents) })),
    portfolio: s.portfolio.map((p) => ({ date: p.date, valueCents: nullableCents(p.valueCents), partial: p.partial, missing: [...p.missing], priceStatus: p.priceStatus })),
  };
}

// ---- Reconciliation ----

export function toReconcileRowView(r: ReconcileRowRecord): ReconcileRowView {
  return {
    securityId: r.securityId,
    ticker: r.ticker,
    name: r.name,
    isCash: r.isCash,
    app:
      r.app === null
        ? null
        : {
            quantity: nullableFx(r.app.quantity),
            price: nullableFx(r.app.price),
            priceDate: r.app.priceDate,
            priceSource: r.app.priceSource,
            valueCents: nullableCents(r.app.valueCents),
            valueSource: r.app.valueSource,
          },
    statement: r.statement === null ? null : { quantity: fx(r.statement.quantity), price: nullableFx(r.statement.price), valueCents: cents(r.statement.valueCents) },
    quantityDiff: nullableFx(r.quantityDiff),
    priceDiff: nullableFx(r.priceDiff),
    valueDiffCents: nullableCents(r.valueDiffCents),
    status: r.status,
  };
}

export function toReconcilePreviewResponse(p: ReconcilePreviewRecord, app: AccountValuationView): ReconcilePreviewResponse {
  return {
    accountId: p.accountId,
    date: p.date,
    app,
    statementTotalCents: cents(p.statementTotalCents),
    differenceCents: nullableCents(p.differenceCents),
    unexplainedCents: nullableCents(p.unexplainedCents),
    toleranceCents: cents(p.toleranceCents),
    matchesToDollar: p.matchesToDollar,
    rows: p.rows.map(toReconcileRowView),
    balance: { balanceCents: nullableCents(p.balance.balanceCents), balanceDate: p.balance.balanceDate, differenceCents: nullableCents(p.balance.differenceCents) },
    cashInferenceHint:
      p.cashInferenceHint === null
        ? null
        : { flowsSinceSnapshotCents: cents(p.cashInferenceHint.flowsSinceSnapshotCents), plugCents: cents(p.cashInferenceHint.plugCents), wouldReconcile: p.cashInferenceHint.wouldReconcile },
    alreadyReconciled: p.alreadyReconciled,
  };
}

export function toReconcileCommitResponse(c: ReconcileCommitRecord, app: AccountValuationView): ReconcileCommitResponse {
  return {
    reconciliationId: c.reconciliationId,
    batchId: c.batchId,
    accepted: c.accepted,
    preCommitDifferenceCents: nullableCents(c.preCommitDifferenceCents),
    matchesToDollar: c.matchesToDollar,
    app,
    rowsWritten: c.rowsWritten,
    impliedPricesWritten: c.impliedPricesWritten,
  };
}

export function toReconciliationView(r: ReconciliationRecord): ReconciliationView {
  return {
    id: r.id,
    accountId: r.accountId,
    date: r.date,
    statementTotalCents: cents(r.statementTotalCents),
    differenceCents: nullableCents(r.differenceCents),
    unexplainedCents: nullableCents(r.unexplainedCents),
    toleranceCents: cents(r.toleranceCents),
    matchesToDollar: r.matchesToDollar,
    balance: { balanceCents: nullableCents(r.balance.balanceCents), balanceDate: r.balance.balanceDate, differenceCents: nullableCents(r.balance.differenceCents) },
    appValueCents: nullableCents(r.appValueCents),
    appBasis: r.appBasis,
    appAsOf: r.appAsOf,
    cashInference: r.cashInference,
    reconciled: r.reconciled,
    accepted: r.accepted,
    holdingSnapshotDate: r.holdingSnapshotDate,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  };
}
