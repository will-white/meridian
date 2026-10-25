import type { AccountInvestmentView, AccountView, CategoryView, ConnectionView, ImportLogView, JobView, RuleView, TransactionView } from "@meridian/shared";
import { CsvMapping, isInvestmentAccountType, PositionsCsvMapping, TradesCsvMapping } from "@meridian/shared";
import type { account, category, connection, importLog, job, rule } from "@meridian/db";
import type { AccountFidelityRecord, LoadedRule, TransactionListRow } from "@meridian/db";
import { toLastReconciliationView } from "./views/valuation.js";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toTransactionView(r: TransactionListRow): TransactionView {
  return {
    id: r.id,
    accountId: r.accountId,
    accountName: r.accountName,
    date: r.date,
    amountCents: r.amountCents.toString(),
    payeeId: r.payeeId,
    payeeName: r.payeeName,
    rawDescription: r.rawDescription,
    memo: r.memo,
    categoryId: r.categoryId,
    categoryName: r.categoryName,
    categoryLocked: r.categoryLocked,
    pending: r.pending,
    isTransfer: r.isTransfer,
    transferPairId: r.transferPairId,
    notes: r.notes,
    tags: r.tags,
    source: r.source,
    recurringId: r.recurringId,
  };
}

/**
 * `AccountView.investment` (plan decision 7): the derived fidelity record stringified. An
 * investment-type account the fidelity service did not report (it reports every one it is
 * asked about) falls back to balance-only with nothing to check.
 */
function toAccountInvestmentView(f: AccountFidelityRecord | undefined): AccountInvestmentView {
  if (!f) {
    return { fidelity: "balance_only", fidelityNote: null, positionsMatch: null, lastSnapshotDate: null, lastSnapshotSource: null, lastTradeDate: null, securityCount: 0, needsReviewCount: 0, lastReconciliation: null };
  }
  return {
    fidelity: f.fidelity,
    fidelityNote: f.fidelityNote,
    positionsMatch: f.positionsMatch,
    lastSnapshotDate: f.lastSnapshotDate,
    lastSnapshotSource: f.lastSnapshotSource,
    lastTradeDate: f.lastTradeDate,
    securityCount: f.securityCount,
    needsReviewCount: f.needsReviewCount,
    lastReconciliation: toLastReconciliationView(f.lastReconciliation),
  };
}

/** `investment` is the account's `accountFidelities` record (investment types only; every other type reads null). */
export function toAccountView(
  r: typeof account.$inferSelect & { connectionName: string | null; transactionCount: number },
  investment?: AccountFidelityRecord,
): AccountView {
  return {
    id: r.id,
    connectionId: r.connectionId,
    connectionName: r.connectionName,
    externalId: r.externalId,
    name: r.name,
    institution: r.institution,
    type: r.type,
    taxTreatment: r.taxTreatment,
    currency: r.currency,
    onBudget: r.onBudget,
    closed: r.closed,
    balanceCents: r.balanceCents === null ? null : r.balanceCents.toString(),
    availableCents: r.availableCents === null ? null : r.availableCents.toString(),
    balanceDate: r.balanceDate,
    transactionCount: r.transactionCount,
    lowBalanceThresholdCents: r.lowBalanceThresholdCents === null ? null : r.lowBalanceThresholdCents.toString(),
    paymentDay: r.paymentDay,
    paymentFromAccountId: r.paymentFromAccountId,
    statementDay: r.statementDay,
    lotMethod: r.lotMethod,
    cashInference: r.cashInference,
    investmentIncomeFeed: r.investmentIncomeFeed,
    investment: isInvestmentAccountType(r.type) ? toAccountInvestmentView(investment) : null,
  };
}

export function toConnectionView(
  r: typeof connection.$inferSelect & { accountCount: number; activeJob: typeof job.$inferSelect | undefined },
): ConnectionView {
  // The saved mapping is typed by `csv_kind`; the other two mapping fields are null.
  const bank = r.csvKind === "bank" && r.csvMapping ? CsvMapping.safeParse(r.csvMapping) : undefined;
  const positions = r.csvKind === "positions" && r.csvMapping ? PositionsCsvMapping.safeParse(r.csvMapping) : undefined;
  const trades = r.csvKind === "trades" && r.csvMapping ? TradesCsvMapping.safeParse(r.csvMapping) : undefined;
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    status: r.status,
    lastSyncAt: iso(r.lastSyncAt),
    syncedThrough: r.syncedThrough,
    lastError: r.lastError,
    lastErrors: r.lastErrors.map((e) => (e.accountId ? { code: e.code, message: e.message, accountId: e.accountId } : { code: e.code, message: e.message })),
    csvMapping: bank?.success ? bank.data : null,
    csvKind: r.csvKind,
    positionsMapping: positions?.success ? positions.data : null,
    tradesMapping: trades?.success ? trades.data : null,
    accountCount: r.accountCount,
    activeJob: r.activeJob ? { id: r.activeJob.id, type: r.activeJob.type, status: r.activeJob.status } : null,
    createdAt: r.createdAt.toISOString(),
  };
}

export function toImportLogView(r: typeof importLog.$inferSelect): ImportLogView {
  return {
    id: r.id,
    connectionId: r.connectionId ?? "",
    kind: r.kind,
    startedAt: r.startedAt.toISOString(),
    finishedAt: iso(r.finishedAt),
    status: r.status,
    stats: r.stats ?? null,
    errors: r.errors.map((e) => (e.accountId ? { code: e.code, message: e.message, accountId: e.accountId } : { code: e.code, message: e.message })),
    message: r.message,
  };
}

export function toCategoryView(r: typeof category.$inferSelect): CategoryView {
  return { id: r.id, name: r.name, bucket: r.bucket, hidden: r.hidden };
}

export function toRuleView(r: LoadedRule & { createdAt: Date }): RuleView;
export function toRuleView(r: typeof rule.$inferSelect, parsed: LoadedRule): RuleView;
export function toRuleView(r: (LoadedRule & { createdAt: Date }) | typeof rule.$inferSelect, parsed?: LoadedRule): RuleView {
  const p = parsed ?? (r as LoadedRule);
  return {
    id: r.id,
    name: r.name,
    position: r.position,
    enabled: r.enabled,
    conditions: p.conditions,
    actions: p.actions,
    createdAt: (r as { createdAt: Date }).createdAt.toISOString(),
  };
}

export function toJobView(r: typeof job.$inferSelect): JobView {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    payload: r.payload,
    runAt: r.runAt.toISOString(),
    attempts: r.attempts,
    lastError: r.lastError,
    createdAt: r.createdAt.toISOString(),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
  };
}
