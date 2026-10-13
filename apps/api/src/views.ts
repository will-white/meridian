import type { AccountView, CategoryView, ConnectionView, ImportLogView, JobView, RuleView, TransactionView } from "@meridian/shared";
import { CsvMapping } from "@meridian/shared";
import type { account, category, connection, importLog, job, rule } from "@meridian/db";
import type { LoadedRule, TransactionListRow } from "@meridian/db";

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
  };
}

export function toAccountView(
  r: typeof account.$inferSelect & { connectionName: string | null; transactionCount: number },
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
  };
}

export function toConnectionView(
  r: typeof connection.$inferSelect & { accountCount: number; activeJob: typeof job.$inferSelect | undefined },
): ConnectionView {
  const mapping = r.csvMapping ? CsvMapping.safeParse(r.csvMapping) : undefined;
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    status: r.status,
    lastSyncAt: iso(r.lastSyncAt),
    syncedThrough: r.syncedThrough,
    lastError: r.lastError,
    lastErrors: r.lastErrors.map((e) => (e.accountId ? { code: e.code, message: e.message, accountId: e.accountId } : { code: e.code, message: e.message })),
    csvMapping: mapping?.success ? mapping.data : null,
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
