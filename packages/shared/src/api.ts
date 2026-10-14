import { z } from "zod";
import { ColumnRef, CsvDateFormat, CsvMapping } from "./csv.js";
import {
  AccountType,
  Bucket,
  CashInference,
  ConnectionStatus,
  ConnectionType,
  CsvKind,
  HoldingSource,
  InvestmentFidelity,
  InvestmentIncomeFeed,
  JobStatus,
  JobType,
  LotMethod,
  TaxTreatment,
  TransactionSource,
} from "./enums.js";
import { RuleActions, RuleConditions } from "./rules.js";

/** Request and response contracts shared by the API and the web app. Cents are decimal strings. */

export const CentsString = z.string().regex(/^-?\d+$/, "cents as an integer string");
export const IsoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
export const UuidParams = z.object({ id: z.string().uuid() });
export const OkResponse = z.object({ ok: z.literal(true) });
export const ErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
/** Query-string booleans: "true"/"1" and "false"/"0" only. (z.coerce.boolean would read "false" as true.) */
export const QueryBoolean = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

// ---- Phase 3 fragments referenced by the Phase 1/2 contracts (the Phase 3 section is at the end of the file) ----
export const UserRole = z.enum(["owner", "viewer"]);
export type UserRole = z.infer<typeof UserRole>;

/** Positions CSV column mapping (imports design §3.6); saved on a csv connection with `csv_kind = positions`. */
export const PositionsCsvMapping = z
  .object({
    hasHeader: z.boolean().default(true),
    skipRows: z.number().int().min(0).default(0),
    /** The snapshot date: a column, or the request's `asOfDate` (a snapshot is never dated by the clock). */
    asOf: z.discriminatedUnion("mode", [z.object({ mode: z.literal("column"), column: ColumnRef, format: CsvDateFormat }), z.object({ mode: z.literal("request") })]),
    symbol: z.object({ column: ColumnRef }).optional(),
    name: z.object({ column: ColumnRef }).optional(),
    cusip: z.object({ column: ColumnRef }).optional(),
    quantity: z.object({ column: ColumnRef }).optional(),
    price: z.object({ column: ColumnRef }).optional(),
    value: z.object({ column: ColumnRef }).optional(),
    costBasis: z.object({ column: ColumnRef }).optional(),
    accountFilter: z.object({ column: ColumnRef }).optional(),
  })
  .refine((m) => m.symbol !== undefined || m.name !== undefined, "symbol or name column required")
  .refine((m) => m.value !== undefined || (m.quantity !== undefined && m.price !== undefined), "value, or quantity and price, required");
export type PositionsCsvMapping = z.infer<typeof PositionsCsvMapping>;
export type PositionsCsvMappingInput = z.input<typeof PositionsCsvMapping>;

/** How a trade-file row is read after classification (imports design §3.8). */
export const TradeKind = z.enum(["buy", "sell", "dividend", "interest", "reinvest", "reinvest_combined", "fee", "split", "transfer_in", "transfer_out", "cash_in", "cash_out", "skip"]);
export type TradeKind = z.infer<typeof TradeKind>;

/** Trade-history CSV column mapping (imports design §3.8); saved on a csv connection with `csv_kind = trades`. */
export const TradesCsvMapping = z
  .object({
    hasHeader: z.boolean().default(true),
    skipRows: z.number().int().min(0).default(0),
    date: z.object({ column: ColumnRef, format: CsvDateFormat }),
    action: z.object({ column: ColumnRef }),
    symbol: z.object({ column: ColumnRef }).optional(),
    name: z.object({ column: ColumnRef }).optional(),
    cusip: z.object({ column: ColumnRef }).optional(),
    quantity: z.object({ column: ColumnRef }).optional(),
    price: z.object({ column: ColumnRef }).optional(),
    amount: z.object({ column: ColumnRef, invert: z.boolean().default(false) }).optional(),
    /** Commission and fee columns are summed (Fidelity has both). */
    fee: z.object({ columns: z.array(ColumnRef).min(1) }).optional(),
    /** False when the amount column is the principal (price × quantity) and fees are separate. */
    amountIncludesFees: z.boolean().default(true),
    /** How a reinvest-looking row with a quantity is read (plan decision 6): a purchase row only, or a dividend plus a purchase. */
    reinvestRows: z.enum(["separate", "combined"]).default("separate"),
    rowOrder: z.enum(["oldest_first", "newest_first", "auto"]).default("auto"),
    /** actionKey(text) → kind; consulted before the regex classifier (exact key, then longest prefix). */
    actionMap: z.record(z.string(), TradeKind).default({}),
    externalId: z.object({ column: ColumnRef }).optional(),
    description: z.object({ column: ColumnRef }).optional(),
    accountFilter: z.object({ column: ColumnRef }).optional(),
  })
  .refine((m) => m.symbol !== undefined || m.name !== undefined, "symbol or name column required");
export type TradesCsvMapping = z.infer<typeof TradesCsvMapping>;
export type TradesCsvMappingInput = z.input<typeof TradesCsvMapping>;

/** The latest statement check recorded for an account (`account_reconciliation`, plan decision 14). */
export const LastReconciliationView = z.object({
  id: z.string().uuid(),
  statementDate: IsoDateString,
  /** app − statement before the commit; null when the app had no value that day. */
  diffCents: CentsString.nullable(),
  /** |diffCents| < RECONCILE_TOLERANCE_CENTS (`matchesToDollar`). */
  reconciled: z.boolean(),
  accepted: z.boolean(),
  createdAt: z.string(),
});
export type LastReconciliationView = z.infer<typeof LastReconciliationView>;

/** `AccountView.investment` (plan decision 7): derived, never stored; null for non-investment account types. */
export const AccountInvestmentView = z.object({
  fidelity: InvestmentFidelity,
  fidelityNote: z.string().nullable(),
  /** The lots agree with the latest holding snapshot (0.001-share tolerance); null without trades or a snapshot to check. */
  positionsMatch: z.boolean().nullable(),
  lastSnapshotDate: IsoDateString.nullable(),
  lastSnapshotSource: HoldingSource.nullable(),
  lastTradeDate: IsoDateString.nullable(),
  securityCount: z.number().int(),
  needsReviewCount: z.number().int(),
  lastReconciliation: LastReconciliationView.nullable(),
});
export type AccountInvestmentView = z.infer<typeof AccountInvestmentView>;

// ---- Auth ----
export const AuthStatus = z.object({
  setupRequired: z.boolean(),
  authenticated: z.boolean(),
  /** True when the session is password-verified but still needs a TOTP code. */
  totpRequired: z.boolean(),
  totpEnrolled: z.boolean(),
  username: z.string().optional(),
  /** Phase 3: absent when anonymous; the web hides editors for a viewer. */
  role: UserRole.optional(),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

export const Password = z.string().min(12, "Use at least 12 characters").max(256);
export const SetupBody = z.object({ username: z.string().min(1).max(64), password: Password });
export const LoginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) });
export const TotpCodeBody = z.object({ code: z.string().regex(/^\d{6}$/, "6 digits") });
export const TotpSetupResponse = z.object({ otpauthUrl: z.string(), qrDataUrl: z.string(), secret: z.string() });
export type TotpSetupResponse = z.infer<typeof TotpSetupResponse>;

// ---- Connections ----
export const ConnectionErrorView = z.object({ code: z.string(), message: z.string(), accountId: z.string().optional() });
export const ConnectionView = z.object({
  id: z.string().uuid(),
  type: ConnectionType,
  name: z.string(),
  status: ConnectionStatus,
  lastSyncAt: z.string().nullable(),
  syncedThrough: IsoDateString.nullable(),
  lastError: z.string().nullable(),
  lastErrors: z.array(ConnectionErrorView),
  /** The bank mapping; null for other kinds. */
  csvMapping: CsvMapping.nullable(),
  /** Phase 3: which mapper a csv profile belongs to. */
  csvKind: CsvKind,
  positionsMapping: PositionsCsvMapping.nullable(),
  tradesMapping: TradesCsvMapping.nullable(),
  accountCount: z.number().int(),
  activeJob: z.object({ id: z.string().uuid(), type: JobType, status: JobStatus }).nullable(),
  createdAt: z.string(),
});
export type ConnectionView = z.infer<typeof ConnectionView>;
export const CreateSimplefinConnectionBody = z.object({ name: z.string().min(1).max(100), token: z.string().min(16).max(4096) });
export const UpdateConnectionBody = z.object({ name: z.string().min(1).max(100).optional(), status: z.enum(["ok", "disabled"]).optional() });
export const ImportLogView = z.object({
  id: z.string().uuid(),
  connectionId: z.string().uuid(),
  kind: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.string(),
  stats: z.record(z.number()).nullable(),
  errors: z.array(ConnectionErrorView),
  message: z.string().nullable(),
});
export type ImportLogView = z.infer<typeof ImportLogView>;

// ---- Accounts ----
export const AccountView = z.object({
  id: z.string().uuid(),
  connectionId: z.string().uuid().nullable(),
  connectionName: z.string().nullable(),
  externalId: z.string().nullable(),
  name: z.string(),
  institution: z.string().nullable(),
  type: AccountType,
  taxTreatment: TaxTreatment,
  currency: z.string(),
  onBudget: z.boolean(),
  closed: z.boolean(),
  balanceCents: CentsString.nullable(),
  availableCents: CentsString.nullable(),
  balanceDate: IsoDateString.nullable(),
  transactionCount: z.number().int(),
  lowBalanceThresholdCents: CentsString.nullable(),
  paymentDay: z.number().int().min(1).max(31).nullable(),
  paymentFromAccountId: z.string().uuid().nullable(),
  statementDay: z.number().int().min(1).max(31).nullable(),
  /** Phase 3 (investment types; the defaults for every other type). */
  lotMethod: LotMethod,
  cashInference: CashInference,
  investmentIncomeFeed: InvestmentIncomeFeed,
  /** Phase 3: null for non-investment account types. */
  investment: AccountInvestmentView.nullable(),
});
export type AccountView = z.infer<typeof AccountView>;
export const UpdateAccountBody = z.object({
  name: z.string().min(1).max(100).optional(),
  type: AccountType.optional(),
  taxTreatment: TaxTreatment.optional(),
  onBudget: z.boolean().optional(),
  closed: z.boolean().optional(),
  lowBalanceThresholdCents: CentsString.nullable().optional(),
  paymentDay: z.number().int().min(1).max(31).nullable().optional(),
  paymentFromAccountId: z.string().uuid().nullable().optional(),
  statementDay: z.number().int().min(1).max(31).nullable().optional(),
  /** Phase 3: investment types only (400 `not_investment_account` otherwise); enabling a feed needs the household feed category. */
  lotMethod: LotMethod.optional(),
  cashInference: CashInference.optional(),
  investmentIncomeFeed: InvestmentIncomeFeed.optional(),
});
export const CreateManualAccountBody = z.object({
  name: z.string().min(1).max(100),
  type: AccountType,
  taxTreatment: TaxTreatment.optional(),
  balanceCents: CentsString.optional(),
});

// ---- Categories, payees, tags ----
export const CategoryView = z.object({ id: z.string().uuid(), name: z.string(), bucket: Bucket, hidden: z.boolean() });
export type CategoryView = z.infer<typeof CategoryView>;
export const CreateCategoryBody = z.object({ name: z.string().min(1).max(100), bucket: Bucket });
export const UpdateCategoryBody = z.object({ name: z.string().min(1).max(100).optional(), bucket: Bucket.optional(), hidden: z.boolean().optional() });
export const PayeeView = z.object({
  id: z.string().uuid(),
  name: z.string(),
  aliases: z.array(z.string()),
  defaultCategoryId: z.string().uuid().nullable(),
  transactionCount: z.number().int(),
});
export type PayeeView = z.infer<typeof PayeeView>;
export const UpdatePayeeBody = z.object({
  name: z.string().min(1).max(200).optional(),
  defaultCategoryId: z.string().uuid().nullable().optional(),
  /** Merge another payee into this one: its transactions move here and its name becomes an alias. */
  mergeFromId: z.string().uuid().optional(),
});

// ---- Transactions ----
export const TransactionView = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  accountName: z.string(),
  date: IsoDateString,
  amountCents: CentsString,
  payeeId: z.string().uuid().nullable(),
  payeeName: z.string().nullable(),
  rawDescription: z.string(),
  memo: z.string().nullable(),
  categoryId: z.string().uuid().nullable(),
  categoryName: z.string().nullable(),
  categoryLocked: z.boolean(),
  pending: z.boolean(),
  isTransfer: z.boolean(),
  transferPairId: z.string().uuid().nullable(),
  notes: z.string().nullable(),
  tags: z.array(z.string()),
  source: TransactionSource,
  recurringId: z.string().uuid().nullable(),
});
export type TransactionView = z.infer<typeof TransactionView>;
export const TransactionQuery = z.object({
  q: z.string().max(200).optional(),
  accountId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  uncategorized: QueryBoolean.optional(),
  transfers: z.enum(["include", "exclude", "only"]).default("include"),
  from: IsoDateString.optional(),
  to: IsoDateString.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** Opaque cursor from the previous page. */
  cursor: z.string().optional(),
  /** Phase 2: a goal's rows (its category, plus transfer legs in its linked account). */
  goalId: z.string().uuid().optional(),
  /** Phase 2: charges linked to one recurring item. */
  recurringId: z.string().uuid().optional(),
});
export type TransactionQuery = z.infer<typeof TransactionQuery>;
export const TransactionList = z.object({ items: z.array(TransactionView), nextCursor: z.string().nullable() });
export type TransactionList = z.infer<typeof TransactionList>;
export const UpdateTransactionBody = z.object({
  categoryId: z.string().uuid().nullable().optional(),
  payeeName: z.string().min(1).max(200).optional(),
  notes: z.string().max(2000).nullable().optional(),
  isTransfer: z.boolean().optional(),
  tags: z.array(z.string().min(1).max(50)).optional(),
});
export const CreateManualTransactionBody = z.object({
  accountId: z.string().uuid(),
  date: IsoDateString,
  amountCents: CentsString,
  payeeName: z.string().min(1).max(200),
  categoryId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).optional(),
});

// ---- Rules ----
export const RuleView = z.object({
  id: z.string().uuid(),
  name: z.string(),
  position: z.number().int(),
  enabled: z.boolean(),
  conditions: RuleConditions,
  actions: RuleActions,
  createdAt: z.string(),
});
export type RuleView = z.infer<typeof RuleView>;
export const ApplyScope = z.enum(["none", "uncategorized", "all"]);
export const CreateRuleBody = z.object({
  name: z.string().max(100).optional(),
  conditions: RuleConditions,
  actions: RuleActions,
  /** Run the new rule over existing transactions right away. */
  applyTo: ApplyScope.default("uncategorized"),
});
export const UpdateRuleBody = z.object({
  name: z.string().max(100).optional(),
  enabled: z.boolean().optional(),
  conditions: RuleConditions.optional(),
  actions: RuleActions.optional(),
});
export const ReorderRulesBody = z.object({ ids: z.array(z.string().uuid()).min(1) });
export const RunRulesBody = z.object({ scope: z.enum(["uncategorized", "all"]) });
export const RunRulesResponse = z.object({ examined: z.number().int(), changed: z.number().int() });
export type RunRulesResponse = z.infer<typeof RunRulesResponse>;

// ---- CSV import ----
export const CsvPreviewBody = z.object({
  csvText: z.string().min(1).max(10_000_000),
  mapping: CsvMapping.optional(),
  profileId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
});
export const MappedRowView = z.object({
  rowIndex: z.number().int(),
  date: IsoDateString,
  amountCents: CentsString,
  description: z.string(),
  memo: z.string().optional(),
  externalId: z.string(),
  duplicate: z.boolean(),
});
export const CsvPreviewResponse = z.object({
  headers: z.array(z.string()),
  sampleRows: z.array(z.array(z.string())),
  mapping: CsvMapping.nullable(),
  rows: z.array(MappedRowView),
  totalRows: z.number().int(),
  duplicateCount: z.number().int(),
  errors: z.array(z.object({ rowIndex: z.number().int(), message: z.string() })),
});
export type CsvPreviewResponse = z.infer<typeof CsvPreviewResponse>;
export const CsvCommitBody = z.object({
  accountId: z.string().uuid(),
  csvText: z.string().min(1).max(10_000_000),
  mapping: CsvMapping,
  /** Save (or update) the mapping as a profile named after the institution. */
  saveProfile: z.object({ id: z.string().uuid().optional(), name: z.string().min(1).max(100) }).optional(),
});
export const ImportResult = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  replacedPending: z.number().int(),
  removedPending: z.number().int(),
  skipped: z.number().int(),
  transfersPaired: z.number().int(),
  errors: z.array(z.object({ rowIndex: z.number().int().optional(), message: z.string() })),
});
export type ImportResult = z.infer<typeof ImportResult>;

// ---- Jobs ----
export const JobView = z.object({
  id: z.string().uuid(),
  type: JobType,
  status: JobStatus,
  payload: z.record(z.unknown()),
  runAt: z.string(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type JobView = z.infer<typeof JobView>;

// =====================================================================
// Phase 2: spending plan, goals, recurring, alerts, cash flow, dashboard
// =====================================================================
import { AlertKind, AmountMode, AuditAction, AuditEntity, Cadence, GoalStatus, PlannedSource, RecurringSource, RecurringStatus, RolloverMode } from "./enums.js";

export const MonthString = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM");
export const NonNegCentsString = z.string().regex(/^\d+$/, "cents as a non-negative integer string");
export const TodayQuery = z.object({ today: IsoDateString.optional() });

// ---- Settings ----
export const HouseholdSettingView = z.object({
  planStartMonth: MonthString,
  zeroBased: z.boolean(),
  lowBalanceThresholdCents: CentsString,
  primaryAccountId: z.string().uuid().nullable(),
  projectionDefaultDays: z.number().int(),
  timezone: z.string(),
  /** Phase 3: the performance benchmark (a non-cash security); null = none. */
  benchmarkSecurityId: z.string().uuid().nullable(),
  /** Phase 3: income-bucket category that dividend/interest feed rows land in; null = feeds cannot be enabled. */
  investmentIncomeCategoryId: z.string().uuid().nullable(),
  /** Phase 3: drift band in basis points before a class is flagged (0..5000). */
  rebalanceBandBp: z.number().int(),
  /** Phase 3: the smallest trade the rebalance suggestion proposes. */
  rebalanceMinTradeCents: NonNegCentsString,
  updatedAt: z.string(),
});
export type HouseholdSettingView = z.infer<typeof HouseholdSettingView>;
export const UpdateHouseholdSettingBody = z.object({
  planStartMonth: MonthString.optional(),
  zeroBased: z.boolean().optional(),
  lowBalanceThresholdCents: CentsString.optional(),
  primaryAccountId: z.string().uuid().nullable().optional(),
  projectionDefaultDays: z.number().int().min(1).max(366).optional(),
  timezone: z.string().min(1).max(64).optional(),
  /** Phase 3 (400 `validation` for a cash or unknown security; 400 `not_income_category` for a category outside the income bucket). */
  benchmarkSecurityId: z.string().uuid().nullable().optional(),
  investmentIncomeCategoryId: z.string().uuid().nullable().optional(),
  rebalanceBandBp: z.number().int().min(0).max(5000).optional(),
  rebalanceMinTradeCents: NonNegCentsString.optional(),
});

// ---- Categories and groups (Phase 2 extensions) ----
export const CategoryGroupView = z.object({
  id: z.string().uuid(),
  name: z.string(),
  bucket: Bucket,
  position: z.number().int(),
  hidden: z.boolean(),
  categoryCount: z.number().int(),
});
export type CategoryGroupView = z.infer<typeof CategoryGroupView>;
export const CreateCategoryGroupBody = z.object({ name: z.string().min(1).max(100), bucket: Bucket });
export const UpdateCategoryGroupBody = z.object({ name: z.string().min(1).max(100).optional(), hidden: z.boolean().optional() });
export const ReorderCategoryGroupsBody = z.object({ bucket: Bucket, ids: z.array(z.string().uuid()).min(1) });

/** Extended Phase 2 category view (replaces the Phase 1 shape; superset). */
export const CategoryDetailView = CategoryView.extend({
  groupId: z.string().uuid().nullable(),
  position: z.number().int(),
  rolloverMode: RolloverMode,
  rolloverFromMonth: MonthString.nullable(),
  goalId: z.string().uuid().nullable(),
});
export type CategoryDetailView = z.infer<typeof CategoryDetailView>;
export const CreateCategoryBodyV2 = z.object({ name: z.string().min(1).max(100), bucket: Bucket, groupId: z.string().uuid().optional() });
export const UpdateCategoryBodyV2 = z.object({
  name: z.string().min(1).max(100).optional(),
  bucket: Bucket.optional(),
  hidden: z.boolean().optional(),
  groupId: z.string().uuid().nullable().optional(),
  rolloverMode: RolloverMode.optional(),
  rolloverFromMonth: MonthString.nullable().optional(),
});
export const ReorderCategoriesBody = z.object({ groupId: z.string().uuid().nullable(), ids: z.array(z.string().uuid()).min(1) });

// ---- Plan grid ----
export const PlanQuery = z.object({ from: MonthString.optional(), to: MonthString.optional(), today: IsoDateString.optional() });
export type PlanQuery = z.infer<typeof PlanQuery>;
export const PlanCellView = z.object({
  plannedCents: NonNegCentsString,
  source: PlannedSource,
  /** True when a month_plan row holds planned_cents (manual, average, or frozen recurring/goal). */
  hasExplicitPlan: z.boolean(),
  carriedInCents: CentsString,
  carriedInSource: z.enum(["start", "chain", "override", "none"]),
  availableCents: CentsString,
  actualCents: CentsString,
  pendingCents: CentsString,
  remainingCents: CentsString,
  overspendCents: NonNegCentsString,
  committedCents: CentsString,
  rolloverMode: RolloverMode,
  txnCount: z.number().int(),
  overspent: z.boolean(),
  note: z.string().nullable(),
});
export type PlanCellView = z.infer<typeof PlanCellView>;
export const GoalProgressView = z.object({
  savedCents: CentsString,
  remainingToTargetCents: NonNegCentsString,
  progressBp: z.number().int(),
  monthsLeft: z.number().int().nullable(),
  neededPerMonthCents: NonNegCentsString.nullable(),
  projectedCompletionMonth: MonthString.nullable(),
  onTrack: z.boolean().nullable(),
});
export const GoalSummaryView = z.object({
  id: z.string().uuid(),
  name: z.string(),
  targetCents: NonNegCentsString,
  targetDate: IsoDateString.nullable(),
  linkedAccountId: z.string().uuid().nullable(),
  linkedAccountName: z.string().nullable(),
  monthlyContributionCents: NonNegCentsString,
  startMonth: MonthString,
  startingCents: CentsString,
  status: GoalStatus,
  progress: GoalProgressView,
});
export type GoalSummaryView = z.infer<typeof GoalSummaryView>;
export const PlanBucketRow = z.object({ kind: z.literal("bucket"), bucket: Bucket, cells: z.array(PlanCellView) });
export const PlanGroupRow = z.object({
  kind: z.literal("group"),
  bucket: Bucket,
  groupId: z.string().uuid(),
  name: z.string(),
  position: z.number().int(),
  hidden: z.boolean(),
  cells: z.array(PlanCellView),
});
export const PlanCategoryRow = z.object({
  kind: z.literal("category"),
  bucket: Bucket,
  groupId: z.string().uuid().nullable(),
  categoryId: z.string().uuid(),
  name: z.string(),
  position: z.number().int(),
  hidden: z.boolean(),
  rolloverMode: RolloverMode,
  rolloverFromMonth: MonthString.nullable(),
  goal: GoalSummaryView.nullable(),
  cells: z.array(PlanCellView),
});
export const PlanRow = z.discriminatedUnion("kind", [PlanBucketRow, PlanGroupRow, PlanCategoryRow]);
export type PlanRow = z.infer<typeof PlanRow>;
export const BucketTotalsView = z.object({ income: CentsString, bills: CentsString, savings: CentsString, spending: CentsString });
export const PaceView = z.object({ daysLeft: z.number().int(), perDayCents: NonNegCentsString, overCents: NonNegCentsString });
export const MonthSummaryView = z.object({
  month: MonthString,
  state: z.enum(["past", "current", "future"]),
  planned: BucketTotalsView,
  actual: BucketTotalsView,
  committed: BucketTotalsView,
  /** The spec's literal formula: planned income − planned bills − planned savings − planned spending. */
  plannedLeftToSpendCents: CentsString,
  /** Actual-aware: committed income − committed outflows. Shown on the strip; drives pace. */
  leftToSpendCents: CentsString,
  /** Zero-based presentation: committed income − planned outflows. */
  toAssignCents: CentsString,
  warning: z.boolean(),
  pace: PaceView.nullable(),
  uncategorized: z.object({ count: z.number().int(), cents: CentsString }),
});
export type MonthSummaryView = z.infer<typeof MonthSummaryView>;
export const PlanResponse = z.object({
  today: IsoDateString,
  currentMonth: MonthString,
  from: MonthString,
  to: MonthString,
  months: z.array(MonthString),
  zeroBased: z.boolean(),
  rows: z.array(PlanRow),
  summary: z.array(MonthSummaryView),
});
export type PlanResponse = z.infer<typeof PlanResponse>;

export const PlanCellEdit = z
  .object({
    month: MonthString,
    categoryId: z.string().uuid(),
    /** Explicit planned value; null clears it (the auto value shows through). */
    plannedCents: NonNegCentsString.nullable().optional(),
    source: z.enum(["manual", "average"]).default("manual"),
    rolloverMode: RolloverMode.nullable().optional(),
    carriedInOverrideCents: CentsString.nullable().optional(),
    note: z.string().max(500).nullable().optional(),
  })
  .refine((e) => e.plannedCents !== undefined || e.rolloverMode !== undefined || e.carriedInOverrideCents !== undefined || e.note !== undefined, {
    message: "An edit needs at least one field",
  });
export type PlanCellEdit = z.infer<typeof PlanCellEdit>;
export const SetPlanCellsBody = z.object({
  edits: z.array(PlanCellEdit).min(1).max(600),
  /** When given, the response carries the fresh plan for this range. */
  range: z.object({ from: MonthString, to: MonthString }).optional(),
  today: IsoDateString.optional(),
});
export const SetPlanCellsResponse = z.object({ changed: z.number().int(), batchId: z.string().uuid(), plan: PlanResponse.nullable() });
export const PlanAveragesQuery = z.object({
  months: z.coerce.number().pipe(z.union([z.literal(3), z.literal(6), z.literal(12)])),
  asOf: MonthString.optional(),
  today: IsoDateString.optional(),
});
export const PlanAveragesResponse = z.object({
  window: z.object({ from: MonthString, to: MonthString, monthsWithData: z.number().int() }),
  averages: z.array(z.object({ categoryId: z.string().uuid(), averageCents: NonNegCentsString })),
});
export type PlanAveragesResponse = z.infer<typeof PlanAveragesResponse>;
export const CloseMonthBody = z.object({ through: MonthString.optional() });
export const CloseMonthResponse = z.object({ inserted: z.number().int(), through: MonthString });

// ---- Goals ----
export const GoalView = GoalSummaryView.extend({
  categoryId: z.string().uuid(),
  categoryName: z.string(),
  history: z.array(z.object({ month: MonthString, actualCents: CentsString, plannedCents: NonNegCentsString })),
  createdAt: z.string(),
});
export type GoalView = z.infer<typeof GoalView>;
export const CreateGoalBody = z.object({
  name: z.string().min(1).max(100),
  /** Existing savings-bucket category without a goal, or create one by name. */
  categoryId: z.string().uuid().optional(),
  newCategory: z.object({ name: z.string().min(1).max(100), groupId: z.string().uuid().optional() }).optional(),
  targetCents: NonNegCentsString,
  targetDate: IsoDateString.nullable().optional(),
  linkedAccountId: z.string().uuid().nullable().optional(),
  monthlyContributionCents: NonNegCentsString.optional(),
  startMonth: MonthString.optional(),
  startingCents: CentsString.optional(),
});
export const UpdateGoalBody = z.object({
  name: z.string().min(1).max(100).optional(),
  categoryId: z.string().uuid().optional(),
  targetCents: NonNegCentsString.optional(),
  targetDate: IsoDateString.nullable().optional(),
  linkedAccountId: z.string().uuid().nullable().optional(),
  monthlyContributionCents: NonNegCentsString.optional(),
  startMonth: MonthString.optional(),
  startingCents: CentsString.optional(),
  status: GoalStatus.optional(),
});

// ---- Audit ----
export const AuditQuery = z.object({
  entity: AuditEntity.optional(),
  entityId: z.string().max(200).optional(),
  batchId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export const AuditEntryView = z.object({
  id: z.string().uuid(),
  at: z.string(),
  userId: z.string().uuid().nullable(),
  username: z.string().nullable(),
  batchId: z.string().uuid(),
  entity: AuditEntity,
  entityId: z.string(),
  action: AuditAction,
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
});
export const AuditList = z.object({ items: z.array(AuditEntryView), nextCursor: z.string().nullable() });

// ---- Recurring, subscriptions, alerts ----
export const ScheduleView = z.object({
  cadence: Cadence,
  anchorDay: z.number().int().min(1).max(31).nullable(),
  anchorDay2: z.number().int().min(1).max(31).nullable(),
  anchorMonth: z.number().int().min(1).max(12).nullable(),
  anchorDate: IsoDateString.nullable(),
});
export const RecurringView = ScheduleView.extend({
  id: z.string().uuid(),
  payeeId: z.string().uuid(),
  payeeName: z.string(),
  name: z.string(),
  categoryId: z.string().uuid().nullable(),
  categoryName: z.string().nullable(),
  accountId: z.string().uuid().nullable(),
  accountName: z.string().nullable(),
  transferAccountId: z.string().uuid().nullable(),
  transferAccountName: z.string().nullable(),
  expectedCents: CentsString,
  toleranceCents: NonNegCentsString,
  amountMode: AmountMode,
  amountLocked: z.boolean(),
  scheduleLocked: z.boolean(),
  nextDueDate: IsoDateString.nullable(),
  firstChargeDate: IsoDateString.nullable(),
  lastChargeDate: IsoDateString.nullable(),
  lastChargeCents: CentsString.nullable(),
  chargeCount: z.number().int(),
  consecutiveMissed: z.number().int(),
  overdue: z.boolean(),
  confidence: z.number().int().nullable(),
  source: RecurringSource,
  status: RecurringStatus,
  statusReason: z.string().nullable(),
  statusChangedAt: z.string(),
  monthlyEquivalentCents: CentsString,
  yearlyCents: CentsString,
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RecurringView = z.infer<typeof RecurringView>;
export const RecurringQuery = z.object({
  status: z.union([RecurringStatus, z.literal("all")]).optional(),
  direction: z.enum(["inflow", "outflow"]).optional(),
  sort: z.enum(["cost", "due", "name", "confidence"]).default("due"),
});
export const RecurringList = z.object({ items: z.array(RecurringView), totals: z.object({ yearlyCents: CentsString, monthlyEquivalentCents: CentsString }) });
export type RecurringList = z.infer<typeof RecurringList>;
const ScheduleInput = {
  cadence: Cadence,
  anchorDay: z.number().int().min(1).max(31).nullable().optional(),
  anchorDay2: z.number().int().min(1).max(31).nullable().optional(),
  anchorMonth: z.number().int().min(1).max(12).nullable().optional(),
  anchorDate: IsoDateString.nullable().optional(),
};
export const CreateRecurringBody = z.object({
  name: z.string().min(1).max(200),
  payeeId: z.string().uuid().optional(),
  payeeName: z.string().min(1).max(200).optional(),
  categoryId: z.string().uuid(),
  accountId: z.string().uuid(),
  transferAccountId: z.string().uuid().nullable().optional(),
  ...ScheduleInput,
  expectedCents: CentsString,
  toleranceCents: NonNegCentsString.optional(),
  amountMode: AmountMode.optional(),
  notes: z.string().max(2000).optional(),
});
export const UpdateRecurringBody = z.object({
  name: z.string().min(1).max(200).optional(),
  categoryId: z.string().uuid().nullable().optional(),
  accountId: z.string().uuid().nullable().optional(),
  transferAccountId: z.string().uuid().nullable().optional(),
  cadence: Cadence.optional(),
  anchorDay: z.number().int().min(1).max(31).nullable().optional(),
  anchorDay2: z.number().int().min(1).max(31).nullable().optional(),
  anchorMonth: z.number().int().min(1).max(12).nullable().optional(),
  anchorDate: IsoDateString.nullable().optional(),
  expectedCents: CentsString.optional(),
  toleranceCents: NonNegCentsString.optional(),
  amountMode: AmountMode.optional(),
  notes: z.string().max(2000).nullable().optional(),
  status: z.enum(["active", "paused", "cancelled", "dismissed"]).optional(),
});
export const LinkTransactionBody = z.object({ transactionId: z.string().uuid() });
export const SubscriptionRow = z.object({
  id: z.string().uuid(),
  name: z.string(),
  payeeName: z.string(),
  categoryName: z.string().nullable(),
  cadence: Cadence,
  expectedCents: CentsString,
  monthlyEquivalentCents: CentsString,
  yearlyCents: CentsString,
  nextDueDate: IsoDateString.nullable(),
  lastChargeDate: IsoDateString.nullable(),
  lastChargeCents: CentsString.nullable(),
  amountMode: AmountMode,
  consecutiveMissed: z.number().int(),
  status: RecurringStatus,
});
export const SubscriptionsResponse = z.object({
  items: z.array(SubscriptionRow),
  pausedItems: z.array(SubscriptionRow),
  totalMonthlyCents: CentsString,
  totalYearlyCents: CentsString,
});
export type SubscriptionsResponse = z.infer<typeof SubscriptionsResponse>;
export const DetectResponse = z.object({ jobId: z.string().uuid(), created: z.boolean() });
export const AlertView = z.object({
  id: z.string().uuid(),
  kind: AlertKind,
  recurringId: z.string().uuid().nullable(),
  recurringName: z.string().nullable(),
  payeeId: z.string().uuid(),
  payeeName: z.string(),
  transactionId: z.string().uuid().nullable(),
  dueDate: IsoDateString.nullable(),
  oldCents: CentsString.nullable(),
  newCents: CentsString.nullable(),
  createdAt: z.string(),
  dismissedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
});
export type AlertView = z.infer<typeof AlertView>;
export const AlertQuery = z.object({
  includeDismissed: QueryBoolean.default("false"),
  includeResolved: QueryBoolean.default("false"),
  kind: AlertKind.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export const AlertList = z.object({ items: z.array(AlertView) });
export const DismissAllAlertsBody = z.object({ kind: AlertKind.optional() });

// ---- Cash flow ----
export const CashFlowWhatIfBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("skipOccurrence"), recurringId: z.string().uuid(), occurrenceDate: IsoDateString }),
  z.object({
    kind: z.literal("moveOccurrence"),
    recurringId: z.string().uuid(),
    shiftDays: z.number().int().min(-366).max(366).refine((n) => n !== 0, "shiftDays must not be 0"),
    occurrenceDate: IsoDateString.optional(),
  }),
  z.object({ kind: z.literal("oneTime"), date: IsoDateString, amountCents: CentsString, accountId: z.string().uuid(), label: z.string().max(100).optional() }),
]);
export type CashFlowWhatIfBody = z.infer<typeof CashFlowWhatIfBody>;
export const CashFlowProjectionBody = z.object({
  today: IsoDateString.optional(),
  horizonDays: z.number().int().min(1).max(366).optional(),
  thresholdCents: CentsString.optional(),
  accountIds: z.array(z.string().uuid()).optional(),
  whatIfs: z.array(CashFlowWhatIfBody).max(50).default([]),
});
export const CashFlowEventView = z.object({
  date: IsoDateString,
  originalDate: IsoDateString.nullable(),
  accountId: z.string().uuid(),
  accountName: z.string(),
  amountCents: CentsString,
  kind: z.enum(["income", "bill", "transfer_out", "transfer_in", "card_payment_out", "card_payment_in", "one_time"]),
  recurringId: z.string().uuid().nullable(),
  label: z.string(),
  applied: z.boolean(),
  overdue: z.boolean(),
  moved: z.boolean(),
});
export const CashFlowSeriesView = z.object({
  openingCents: CentsString,
  thresholdCents: CentsString.nullable(),
  points: z.array(CentsString),
  minCents: CentsString,
  minDate: IsoDateString,
  firstBelowThresholdDate: IsoDateString.nullable(),
  alreadyBelow: z.boolean(),
});
export const CashFlowAccountSeriesView = CashFlowSeriesView.extend({
  accountId: z.string().uuid(),
  name: z.string(),
  type: AccountType,
  balanceDate: IsoDateString.nullable(),
});
export const CashFlowSpreadView = z.object({
  month: MonthString,
  accountId: z.string().uuid(),
  totalCents: NonNegCentsString,
  windowStart: IsoDateString,
  days: z.number().int(),
  baseCents: NonNegCentsString,
  extraCentDays: z.number().int(),
});
export const CashFlowProjectionResponse = z.object({
  today: IsoDateString,
  endDate: IsoDateString,
  dates: z.array(IsoDateString),
  accounts: z.array(CashFlowAccountSeriesView),
  combined: CashFlowSeriesView,
  events: z.array(CashFlowEventView),
  spreads: z.array(CashFlowSpreadView),
  whatIfs: z.array(z.object({ index: z.number().int(), applied: z.boolean(), reason: z.string().optional() })),
  warnings: z.array(z.string()),
});
export type CashFlowProjectionResponse = z.infer<typeof CashFlowProjectionResponse>;

// ---- Dashboard ----
export const DashboardView = z.object({
  today: IsoDateString,
  plan: z.object({
    month: MonthString,
    leftToSpendCents: CentsString,
    toAssignCents: CentsString,
    zeroBased: z.boolean(),
    warning: z.boolean(),
    pace: PaceView,
    planned: BucketTotalsView,
    actual: BucketTotalsView,
    committed: BucketTotalsView,
    uncategorized: z.object({ count: z.number().int(), cents: CentsString }),
  }),
  cashFlow: z.object({
    asOf: IsoDateString,
    horizonDays: z.number().int(),
    thresholdCents: CentsString,
    points: z.array(z.object({ date: IsoDateString, cents: CentsString })),
    lowPoint: z.object({ date: IsoDateString, cents: CentsString }),
    firstBelow: IsoDateString.nullable(),
    warnings: z.array(z.string()),
  }),
  billsDue: z.array(
    z.object({
      recurringId: z.string().uuid(),
      name: z.string(),
      categoryName: z.string().nullable(),
      accountName: z.string().nullable(),
      dueDate: IsoDateString,
      amountCents: CentsString,
      overdue: z.boolean(),
    }),
  ),
  netWorth: z.object({
    asOf: IsoDateString,
    todayCents: CentsString,
    yearAgoDate: IsoDateString,
    yearAgoCents: CentsString.nullable(),
    changeCents: CentsString.nullable(),
    newAccounts: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
    /** Phase 3: today's net worth by account kind; null until the investments services compute it. */
    breakdown: z
      .object({
        investmentsCents: CentsString,
        investmentsAsOf: IsoDateString.nullable(),
        cashCents: CentsString,
        debtCents: CentsString,
        otherCents: CentsString,
      })
      .nullable(),
  }),
  review: z.object({ uncategorized: z.number().int(), suggestedRecurring: z.number().int(), alerts: z.number().int() }),
  sync: z.object({
    lastSyncAt: z.string().nullable(),
    attention: z.array(z.object({ connectionId: z.string().uuid(), name: z.string(), status: ConnectionStatus })),
  }),
  retirement: z.null(),
  /** Phase 3 (views design §4, seams C47): null without open investment accounts. */
  investments: z
    .object({
      asOf: IsoDateString,
      totalCents: CentsString,
      dayChangeCents: CentsString.nullable(),
      dayChangeBp: z.number().int().nullable(),
      staleAccounts: z.array(z.object({ id: z.string().uuid(), name: z.string(), valuationDate: IsoDateString.nullable() })),
      fidelityCounts: z.object({ balance_only: z.number().int(), positions: z.number().int(), full_history: z.number().int() }),
      /** Positions or full-history accounts whose latest statement date has no reconciliation on or after it. */
      awaitingReconcile: z.number().int(),
      securitiesNeedingReview: z.number().int(),
      /** From `priceFeedHealth`: counts of provider-mode securities by fetch state. */
      priceFeed: z.object({ configured: z.boolean(), expectedDate: IsoDateString, stale: z.number().int(), notFound: z.number().int(), error: z.number().int() }),
    })
    .nullable(),
});
export type DashboardView = z.infer<typeof DashboardView>;

export type AlertList = z.infer<typeof AlertList>;
export type DetectResponse = z.infer<typeof DetectResponse>;
export type CreateRecurringBody = z.infer<typeof CreateRecurringBody>;
export type UpdateRecurringBody = z.infer<typeof UpdateRecurringBody>;
export type RecurringQuery = z.infer<typeof RecurringQuery>;
export type SubscriptionRow = z.infer<typeof SubscriptionRow>;
export type SetPlanCellsBody = z.infer<typeof SetPlanCellsBody>;
export type SetPlanCellsResponse = z.infer<typeof SetPlanCellsResponse>;
export type AuditList = z.infer<typeof AuditList>;
export type AuditEntryView = z.infer<typeof AuditEntryView>;
export type CashFlowProjectionBody = z.infer<typeof CashFlowProjectionBody>;
export type UpdateHouseholdSettingBody = z.infer<typeof UpdateHouseholdSettingBody>;
export type CreateGoalBody = z.infer<typeof CreateGoalBody>;
export type UpdateGoalBody = z.infer<typeof UpdateGoalBody>;

// =====================================================================
// Phase 3: investments
// =====================================================================
// Every request and response contract of the four Phase 3 area designs
// (docs/design/phase-3/*.md) under the reconciled names of docs/phase-3-plan.md
// and seams.md: cents as CentsString, quantities and prices as Fixed8String /
// NonNegFixed8String (decimal.ts), rates as JSON numbers, dates as IsoDateString,
// months as MonthString; `asOf` is the date parameter and `accountIds` a
// comma-separated list (QueryUuidList) on every GET; the engine's
// POST /api/investments/performance keeps its body array (readOnly). The fragments
// the Phase 1/2 contracts reference (AccountInvestmentView, the CSV mappings,
// UserRole) sit near the top of the file.
import { Fixed8String, NonNegFixed8String, PriceString, QuantityString } from "./decimal.js";
import {
  AssetClass,
  DisposalKind,
  EngineWarningCode,
  ExternalFlowKind,
  ExternalFlowSource,
  GainTerm,
  HoldingPriceSource,
  InvestmentPeriod,
  InvestmentTxnSource,
  InvestmentTxnType,
  LineKind,
  LotOpenedBy,
  PriceFetchStatus,
  PriceProviderId,
  PriceSource,
  PriceStatus,
  ReconcileRowStatus,
  ReturnFailureReason,
  ReturnMethod,
  SecurityType,
  TransferDirection,
  ValuationBasis,
  ValueSource,
} from "./enums.js";

// ---- Primitives ----
/** Engine rates (returns, ratios): computed floats, never stored, never fed back into cents. */
export const RateNumber = z.number().finite();
/** Basis points, truncated toward zero unless stated. */
export const BpInt = z.number().int();
/** Expense-ratio entry, e.g. "0.03" → 300 ppm. */
export const PercentString = z.string().regex(/^\d{1,2}(\.\d{1,4})?$/, "percent with up to 4 places");
/** A share quantity that must be greater than zero (trade quantities, lot picks). */
export const PositiveFixed8String = NonNegFixed8String.refine((s) => /[1-9]/.test(s), "must be greater than zero");
/** `?accountIds=a,b` on a GET: a comma-separated list of uuids, transformed to string[] (1..50). */
export const QueryUuidList = z
  .string()
  .transform((s) => s.split(",").map((v) => v.trim()).filter((v) => v.length > 0))
  .pipe(z.array(z.string().uuid()).min(1).max(50));
/** `asOf ≤ today` else 400 `validation`. */
export const AsOfQuery = TodayQuery.extend({ asOf: IsoDateString.optional(), includeClosed: QueryBoolean.optional() });
/** `from`/`to` apply to `custom` only; `from < to ≤ today`. */
export const InvestmentPeriodQuery = AsOfQuery.extend({ period: InvestmentPeriod.default("1y"), from: IsoDateString.optional(), to: IsoDateString.optional() });
export const PeriodView = z.object({ kind: InvestmentPeriod, from: IsoDateString, to: IsoDateString, days: z.number().int(), partial: z.boolean(), note: z.string().nullable() });
/** The aggregate price freshness of an account or the portfolio. */
export const AggregatePriceStatus = z.enum(["current", "stale", "implied", "n/a"]);
export const DetailLevel = z.enum(["summary", "full"]);
const RowError = z.object({ rowIndex: z.number().int(), message: z.string() });
const RowIssue = z.object({ rowIndex: z.number().int().optional(), message: z.string() });
const SaveProfile = z.object({ id: z.string().uuid().optional(), name: z.string().min(1).max(100) });

// ---- View-level enums (views design §2.6; presentation only, no columns) ----
export const IncomeKind = z.enum(["dividend", "interest"]);
export const RebalanceAction = z.enum(["sell", "buy", "use_cash", "hold_cash"]);
export const ConcentrationLevel = z.enum(["info", "warn", "bad"]);
/** `balance_snapshot.source` of the row that valued an account. */
export const ValuationSource = z.enum(["simplefin", "csv", "manual", "computed"]);
export const CostCoverage = z.enum(["full", "partial", "none"]);
export const LinkStatus = z.enum(["linked", "created", "awaiting", "not_fed", "ledger_only"]);
export const FlowsSource = z.enum(["ledger", "investment", "mixed", "none"]);
export const AccountWarningKind = z.enum(["negative_residual", "positions_stale", "valuation_stale", "price_stale", "lots_mismatch", "dollar_only", "unpriced", "no_value"]);
export const BasisSource = z.enum(["lots", "statement"]);
export const SecurityIdentityKind = z.enum(["ticker", "cusip", "isin", "name"]);
export const SecurityMatchedBy = z.enum(["alias", "ticker", "cusip", "isin", "name", "cash"]);
export const PreviewMatchedBy = z.enum(["alias", "ticker", "cusip", "isin", "name", "cash", "choice", "new"]);

// ---- Securities (imports design §4; routes/securities.ts) ----
export const SecuritySuggestion = z.object({
  ticker: z.string().nullable(),
  cusip: z.string().nullable(),
  isin: z.string().nullable(),
  name: z.string(),
  type: SecurityType,
  assetClass: AssetClass,
});
export const SecurityAliasView = z.object({ kind: SecurityIdentityKind, value: z.string() });
export const SecuritySplitView = z.object({ assetClass: AssetClass, weightBp: BpInt });
export const LatestPriceView = z.object({ date: IsoDateString, close: PriceString, source: PriceSource });
export const SecurityView = z.object({
  id: z.string().uuid(),
  ticker: z.string().nullable(),
  name: z.string(),
  type: SecurityType,
  assetClass: AssetClass,
  expenseRatioPpm: z.number().int().nullable(),
  cusip: z.string().nullable(),
  isin: z.string().nullable(),
  currency: z.string(),
  priceMode: PriceSource,
  providerSymbol: z.string().nullable(),
  /** Fetched although not held (e.g. a benchmark). */
  alwaysPrice: z.boolean(),
  needsReview: z.boolean(),
  archived: z.boolean(),
  notes: z.string().nullable(),
  aliases: z.array(SecurityAliasView),
  held: z.boolean(),
  heldInAccounts: z.number().int(),
  latestPrice: LatestPriceView.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const SecurityQuery = z.object({
  q: z.string().max(100).optional(),
  needsReview: QueryBoolean.optional(),
  held: QueryBoolean.optional(),
  type: SecurityType.optional(),
  includeArchived: QueryBoolean.optional(),
});
export const CreateSecurityBody = z.object({
  ticker: z.string().max(20).nullable().optional(),
  name: z.string().min(1).max(200),
  type: SecurityType,
  assetClass: AssetClass,
  expenseRatioPercent: PercentString.nullable().optional(),
  cusip: z.string().length(9).nullable().optional(),
  isin: z.string().length(12).nullable().optional(),
  currency: z.string().length(3).optional(),
  priceMode: PriceSource.optional(),
  providerSymbol: z.string().max(32).nullable().optional(),
  alwaysPrice: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
/** `PATCH /api/investments/securities/:id`; the pricing fields go through `updateSecurityPricing`. */
export const UpdateSecurityBody = CreateSecurityBody.partial().extend({ needsReview: z.boolean().optional(), archived: z.boolean().optional() });
/** The pricing subset of `UpdateSecurityBody` (`priceMode = provider` needs a ticker: 400 `ticker_required`). */
export const UpdateSecurityPricingBody = UpdateSecurityBody.pick({ priceMode: true, providerSymbol: true, alwaysPrice: true });
export const MergeSecurityBody = z.object({ fromId: z.string().uuid() });
export const AddSecurityAliasBody = z.object({ kind: SecurityIdentityKind, value: z.string().min(1).max(200) });
export const ResolveSecurityQuery = z.object({
  ticker: z.string().max(20).optional(),
  cusip: z.string().length(9).optional(),
  isin: z.string().length(12).optional(),
  name: z.string().max(200).optional(),
});
export const ResolveSecurityResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("resolved"), security: SecurityView, matchedBy: SecurityMatchedBy }),
  z.object({ status: z.literal("unresolved"), suggestion: SecuritySuggestion }),
]);
/** How a preview row names its security on commit. */
export const SecurityChoice = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), securityId: z.string().uuid() }),
  z.object({ kind: z.literal("create"), security: SecuritySuggestion }),
]);
export const RowChoice = z.object({
  rowIndex: z.number().int(),
  security: SecurityChoice.optional(),
  /** A split ratio the file did not state (new:old). */
  split: z.object({ num: z.number().int().min(1), den: z.number().int().min(1) }).optional(),
});
export const PreviewSecurityRef = z.object({
  id: z.string().uuid().nullable(),
  ticker: z.string().nullable(),
  name: z.string(),
  matchedBy: PreviewMatchedBy,
  isNew: z.boolean(),
  needsReview: z.boolean(),
  isCash: z.boolean(),
  suggestion: SecuritySuggestion.nullable(),
});

// ---- Positions CSV import (imports design §3.6–3.7; routes/import.ts) ----
export const PositionsPreviewBody = z.object({
  csvText: z.string().min(1).max(10_000_000),
  accountId: z.string().uuid(),
  mapping: PositionsCsvMapping.optional(),
  profileId: z.string().uuid().optional(),
  asOfDate: IsoDateString.optional(),
  accountFilterValue: z.string().max(100).optional(),
  choices: z.array(RowChoice).default([]),
});
export const MappedPositionView = z.object({
  rowIndex: z.number().int(),
  security: PreviewSecurityRef,
  quantity: QuantityString.nullable(),
  price: PriceString.nullable(),
  valueCents: CentsString,
  costBasisCents: CentsString.nullable(),
  warnings: z.array(z.string()),
  /** The current snapshot row for that security and date, if any. */
  existing: z.object({ quantity: QuantityString.nullable(), valueCents: CentsString }).nullable(),
});
export const PositionsPreviewResponse = z.object({
  headers: z.array(z.string()),
  sampleRows: z.array(z.array(z.string())),
  mapping: PositionsCsvMapping.nullable(),
  asOf: IsoDateString.nullable(),
  positions: z.array(MappedPositionView),
  totalValueCents: CentsString,
  knownBalanceCents: CentsString.nullable(),
  differenceCents: CentsString.nullable(),
  /** |difference| < RECONCILE_TOLERANCE_CENTS; null without a known balance. */
  matchesToDollar: z.boolean().nullable(),
  setBalanceDefault: z.boolean(),
  filterValues: z.array(z.string()),
  pendingActivityCents: CentsString,
  snapshotExists: z.boolean(),
  existingSource: HoldingSource.nullable(),
  willReplace: z.boolean(),
  rowsRead: z.number().int(),
  errors: z.array(RowError),
  skipped: z.array(z.object({ rowIndex: z.number().int(), reason: z.string() })),
});
export const PositionsCommitBody = PositionsPreviewBody.extend({
  mapping: PositionsCsvMapping,
  setBalance: z.boolean().optional(),
  /** The statement's total; the balance row = statementTotalCents ?? Σ positions (seams C40). */
  statementTotalCents: CentsString.optional(),
  saveProfile: SaveProfile.optional(),
  today: IsoDateString.optional(),
});
export const PositionsImportResult = z.object({
  importLogId: z.string().uuid(),
  asOf: IsoDateString,
  positions: z.number().int(),
  inserted: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  deleted: z.number().int(),
  securitiesCreated: z.number().int(),
  impliedPrices: z.number().int(),
  totalValueCents: CentsString,
  knownBalanceCents: CentsString.nullable(),
  differenceCents: CentsString.nullable(),
  matchesToDollar: z.boolean().nullable(),
  balanceWritten: z.boolean(),
  errors: z.array(RowIssue),
});

// ---- Trade-history CSV import (imports design §3.8–3.9; routes/import.ts) ----
export const TradesPreviewBody = z.object({
  csvText: z.string().min(1).max(10_000_000),
  accountId: z.string().uuid(),
  mapping: TradesCsvMapping.optional(),
  profileId: z.string().uuid().optional(),
  accountFilterValue: z.string().max(100).optional(),
  choices: z.array(RowChoice).default([]),
});
export const LedgerMatchView = z.object({ ledgerTransactionId: z.string().uuid(), date: IsoDateString });
export const MappedTradeView = z.object({
  rowIndex: z.number().int(),
  sequence: z.number().int(),
  date: IsoDateString,
  type: InvestmentTxnType,
  kind: TradeKind,
  security: PreviewSecurityRef.nullable(),
  quantity: QuantityString.nullable(),
  price: PriceString.nullable(),
  /** Signed cash effect, forced by type. */
  amountCents: CentsString,
  feeCents: NonNegCentsString,
  splitNum: z.number().int().nullable(),
  splitDen: z.number().int().nullable(),
  transferDirection: TransferDirection.nullable(),
  externalId: z.string(),
  rawDescription: z.string(),
  derived: z.array(z.enum(["amount", "price"])),
  warnings: z.array(z.string()),
  duplicate: z.boolean(),
  changed: z.boolean(),
  userEdited: z.boolean(),
  ledgerMatch: LedgerMatchView.nullable(),
});
export const ActionFoundView = z.object({
  key: z.string(),
  sample: z.string(),
  count: z.number().int(),
  kind: TradeKind.nullable(),
  fromProfile: z.boolean(),
  sampleRowIndex: z.number().int(),
});
export const TradesPreviewResponse = z.object({
  headers: z.array(z.string()),
  sampleRows: z.array(z.array(z.string())),
  mapping: TradesCsvMapping.nullable(),
  rowOrder: z.enum(["oldest_first", "newest_first"]).nullable(),
  trades: z.array(MappedTradeView),
  totalRows: z.number().int(),
  duplicateCount: z.number().int(),
  changedCount: z.number().int(),
  userEditedCount: z.number().int(),
  actionsFound: z.array(ActionFoundView),
  unknownActions: z.number().int(),
  filterValues: z.array(z.string()),
  errors: z.array(RowError),
  skipped: z.array(z.object({ rowIndex: z.number().int(), reason: z.string(), text: z.string() })),
});
export const TradesCommitBody = TradesPreviewBody.extend({ mapping: TradesCsvMapping, saveProfile: SaveProfile.optional(), today: IsoDateString.optional() });
export const TradesImportResult = z.object({
  importLogId: z.string().uuid(),
  created: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  skippedEdited: z.number().int(),
  linked: z.number().int(),
  ledgerCreated: z.number().int(),
  ledgerSkipped: z.number().int(),
  transfersPaired: z.number().int(),
  securitiesCreated: z.number().int(),
  lotsRebuilt: z.number().int(),
  warnings: z.array(RowIssue),
  errors: z.array(RowIssue),
});

// ---- Holding snapshots and manual positions (imports design §3.4, §3.10) ----
export const HoldingSnapshotRowView = z.object({
  securityId: z.string().uuid(),
  ticker: z.string().nullable(),
  name: z.string(),
  /** Null for a dollar-only position. */
  quantity: QuantityString.nullable(),
  price: PriceString.nullable(),
  valueCents: CentsString,
  reportedCostBasisCents: CentsString.nullable(),
});
export const HoldingSnapshotView = z.object({
  accountId: z.string().uuid(),
  date: IsoDateString,
  source: HoldingSource,
  importLogId: z.string().uuid().nullable(),
  rows: z.array(HoldingSnapshotRowView),
  totalValueCents: CentsString,
  knownBalanceCents: CentsString.nullable(),
  differenceCents: CentsString.nullable(),
  matchesToDollar: z.boolean().nullable(),
  updatedAt: z.string(),
});
export const SnapshotSummaryView = z.object({ date: IsoDateString, source: HoldingSource, positions: z.number().int(), totalValueCents: CentsString });
export const SnapshotDateParams = z.object({ id: z.string().uuid(), date: IsoDateString });
/** `GET /api/investments/accounts/:id/positions`: the latest snapshot on or before `asOf` (default today). */
export const PositionsQuery = TodayQuery.extend({ asOf: IsoDateString.optional() });
export const ManualPositionInput = z
  .object({
    security: SecurityChoice,
    quantity: QuantityString.nullable().optional(),
    price: PriceString.optional(),
    valueCents: CentsString.optional(),
    costBasisCents: CentsString.nullable().optional(),
  })
  .refine((p) => p.price !== undefined || p.valueCents !== undefined, "price or valueCents required")
  .refine((p) => p.price === undefined || (p.quantity !== undefined && p.quantity !== null), "price needs a quantity");
export const ManualPositionsBody = z.object({
  asOfDate: IsoDateString,
  setBalance: z.boolean().optional(),
  statementTotalCents: CentsString.optional(),
  positions: z.array(ManualPositionInput).min(1).max(500),
  today: IsoDateString.optional(),
});

// ---- Investment transactions (imports design §4; routes/investmentTxns.ts) ----
export const LotPickInput = z.object({ lotId: z.string().uuid(), quantity: PositiveFixed8String });
/** Specific identification for a sale or transfer out: Σ ≤ the row's quantity, FIFO for the remainder. */
export const LotPicks = z.array(LotPickInput).min(1).max(200);
export const LotPickView = z.object({ id: z.string().uuid(), sellTxnId: z.string().uuid(), lotId: z.string().uuid(), quantity: Fixed8String, position: z.number().int() });
export const InvestmentTxnView = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  accountName: z.string(),
  securityId: z.string().uuid().nullable(),
  ticker: z.string().nullable(),
  securityName: z.string().nullable(),
  date: IsoDateString,
  sequence: z.number().int(),
  type: InvestmentTxnType,
  /** Unsigned; `transferDirection` carries the sign of a transfer. */
  quantity: QuantityString.nullable(),
  price: PriceString.nullable(),
  /** Signed cash effect (a reinvest row is ≤ 0). */
  amountCents: CentsString,
  feeCents: NonNegCentsString,
  splitNum: z.number().int().nullable(),
  splitDen: z.number().int().nullable(),
  transferDirection: TransferDirection.nullable(),
  counterpartyAccountId: z.string().uuid().nullable(),
  transferGroupId: z.string().uuid().nullable(),
  /** Carried basis on a transfer in; null = unknown. */
  costBasisCents: CentsString.nullable(),
  acquiredDate: IsoDateString.nullable(),
  lotPicks: z.array(LotPickView),
  ledgerTransactionId: z.string().uuid().nullable(),
  externalId: z.string().nullable(),
  source: InvestmentTxnSource,
  importLogId: z.string().uuid().nullable(),
  rawDescription: z.string().nullable(),
  memo: z.string().nullable(),
  userEdited: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const InvestmentTxnQuery = z.object({
  accountId: z.string().uuid().optional(),
  securityId: z.string().uuid().optional(),
  type: InvestmentTxnType.optional(),
  from: IsoDateString.optional(),
  to: IsoDateString.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** Keyset cursor on (date, sequence, id) descending. */
  cursor: z.string().optional(),
});
export const InvestmentTxnList = z.object({ items: z.array(InvestmentTxnView), nextCursor: z.string().nullable() });
const TradeBase = { accountId: z.string().uuid(), date: IsoDateString, memo: z.string().max(2000).optional(), today: IsoDateString.optional() };
export const CreateInvestmentTxnBody = z.discriminatedUnion("type", [
  z.object({
    ...TradeBase,
    type: z.enum(["buy", "reinvest"]),
    securityId: z.string().uuid(),
    quantity: PositiveFixed8String,
    price: PriceString,
    amountCents: CentsString.optional(),
    feeCents: NonNegCentsString.optional(),
  }),
  z.object({
    ...TradeBase,
    type: z.literal("sell"),
    securityId: z.string().uuid(),
    quantity: PositiveFixed8String,
    price: PriceString,
    amountCents: CentsString.optional(),
    feeCents: NonNegCentsString.optional(),
    lotPicks: LotPicks.optional(),
  }),
  z.object({ ...TradeBase, type: z.enum(["dividend", "interest"]), securityId: z.string().uuid().nullable().optional(), amountCents: CentsString }),
  z.object({ ...TradeBase, type: z.literal("fee"), securityId: z.string().uuid().nullable().optional(), amountCents: CentsString }),
  z.object({
    ...TradeBase,
    type: z.literal("split"),
    securityId: z.string().uuid(),
    splitNum: z.number().int().min(1),
    splitDen: z.number().int().min(1),
    quantity: PriceString.optional(),
  }),
  z.object({
    ...TradeBase,
    type: z.literal("transfer"),
    direction: TransferDirection,
    /** Null for a cash transfer. */
    securityId: z.string().uuid().nullable().optional(),
    quantity: PositiveFixed8String.optional(),
    amountCents: CentsString.optional(),
    /** Another investment account: the mirror leg is inserted with the same transfer group. */
    counterpartyAccountId: z.string().uuid().optional(),
    costBasisCents: NonNegCentsString.nullable().optional(),
    acquiredDate: IsoDateString.nullable().optional(),
    lotPicks: LotPicks.optional(),
  }),
]);
export const UpdateInvestmentTxnBody = z.object({
  type: InvestmentTxnType.optional(),
  transferDirection: TransferDirection.nullable().optional(),
  date: IsoDateString.optional(),
  securityId: z.string().uuid().nullable().optional(),
  quantity: PriceString.nullable().optional(),
  price: PriceString.nullable().optional(),
  amountCents: CentsString.optional(),
  feeCents: NonNegCentsString.optional(),
  splitNum: z.number().int().min(1).nullable().optional(),
  splitDen: z.number().int().min(1).nullable().optional(),
  costBasisCents: NonNegCentsString.nullable().optional(),
  acquiredDate: IsoDateString.nullable().optional(),
  ledgerTransactionId: z.string().uuid().nullable().optional(),
  /** `null` unpairs both transfer legs. Lot picks are edited at `PUT /api/investments/txns/:id/lot-picks`. */
  transferGroupId: z.null().optional(),
  memo: z.string().max(2000).nullable().optional(),
  today: IsoDateString.optional(),
});
export const DeleteInvestmentTxnQuery = z.object({ deleteGroup: QueryBoolean.optional() });
export const CreateInvestmentTxnResponse = z.object({ items: z.array(InvestmentTxnView), batchId: z.string().uuid() });

// ---- Allocation targets (imports design §3.13) ----
export const AllocationTargetView = z.object({ assetClass: AssetClass, targetBp: z.number().int().min(0).max(10000) });
export const AllocationTargetsView = z.object({ targets: z.array(AllocationTargetView), updatedAt: z.string().nullable() });
/** Replaces the whole set; a non-empty set must sum to 10 000 bp (400 `allocation_sum`, checked by the service). */
export const SetAllocationTargetsBody = z
  .object({ targets: z.array(AllocationTargetView).max(6) })
  .refine((b) => new Set(b.targets.map((t) => t.assetClass)).size === b.targets.length, "duplicate asset class");

// ---- Lots and performance (lots design §4.2; routes/performance.ts) ----
export const PerformanceRequestBody = z.object({
  today: IsoDateString.optional(),
  /** Default: since inception (the day before the earliest txn, flow or valuation of the selected accounts). */
  from: IsoDateString.optional(),
  /** Default: today; `from < to ≤ today`. */
  to: IsoDateString.optional(),
  /** Holdings valuation date; default: `to`. */
  asOf: IsoDateString.optional(),
  /** Default: every open investment-type account. */
  accountIds: z.array(z.string().uuid()).max(50).optional(),
  /** Absent → household_setting.benchmark_security_id; null → no benchmark. */
  benchmarkSecurityId: z.string().uuid().nullable().optional(),
  /** `full` adds subPeriods, flows, lots, disposals, investorFlows and benchmark legs; `summary` returns them empty. */
  detail: DetailLevel.default("summary"),
});
export const ReturnFigureView = z.object({
  rate: RateNumber.nullable(),
  annualized: RateNumber.nullable(),
  reason: ReturnFailureReason.nullable(),
  reasonDate: IsoDateString.nullable(),
});
export const InvestorFlowView = z.object({ date: IsoDateString, amountCents: CentsString });
export const XirrFigureView = z.object({
  annualized: RateNumber.nullable(),
  period: RateNumber.nullable(),
  investedDays: z.number().int(),
  reason: ReturnFailureReason.nullable(),
  warnings: z.array(z.string()),
  investorFlows: z.array(InvestorFlowView),
});
export const SubPeriodView = z.object({
  from: IsoDateString,
  to: IsoDateString,
  beginValueCents: CentsString,
  flowCents: CentsString,
  weightedFlowDollars: z.number().nullable(),
  endValueCents: CentsString,
  rate: RateNumber.nullable(),
  skipped: z.boolean(),
  beginCarried: z.boolean(),
  endCarried: z.boolean(),
});
/** One external flow (plan decision 11): ledger transfers, investment cash transfers, securities at market, opening values. */
export const ExternalFlowView = z.object({
  date: IsoDateString,
  amountCents: CentsString,
  kind: ExternalFlowKind,
  source: ExternalFlowSource,
  accountId: z.string().uuid(),
  counterpartyAccountId: z.string().uuid().nullable(),
  counterpartyAccountName: z.string().nullable(),
  internal: z.boolean(),
  internalReason: z.enum(["counterparty_in_total", "before_first_valuation"]).nullable(),
  sourceId: z.string().nullable(),
});
export const EngineWarningView = z.object({
  code: EngineWarningCode,
  accountId: z.string().uuid().optional(),
  securityId: z.string().uuid().optional(),
  ticker: z.string().nullable().optional(),
  txnId: z.string().uuid().optional(),
  date: IsoDateString.optional(),
  priceDate: IsoDateString.optional(),
  quantity: Fixed8String.optional(),
  lotsQuantity: Fixed8String.optional(),
  snapshotQuantity: Fixed8String.optional(),
  diffCents: CentsString.optional(),
  detail: z.string().optional(),
});
/** A lot (plan decision 5): a derived row with a stable id by (openedByTxnId, ordinal); basis null when unknown. */
export const LotView = z.object({
  id: z.string().uuid(),
  openedByTxnId: z.string().uuid(),
  ordinal: z.number().int(),
  originLotId: z.string().uuid().nullable(),
  accountId: z.string().uuid(),
  accountName: z.string(),
  securityId: z.string().uuid(),
  ticker: z.string().nullable(),
  securityName: z.string(),
  openedBy: LotOpenedBy,
  acquiredDate: IsoDateString,
  originalQuantity: Fixed8String,
  quantity: Fixed8String,
  originalCostBasisCents: CentsString.nullable(),
  costBasisCents: CentsString.nullable(),
  basisPerShare: Fixed8String.nullable(),
  basisKnown: z.boolean(),
  closedDate: IsoDateString.nullable(),
  priceDate: IsoDateString.nullable(),
  valueCents: CentsString.nullable(),
  unrealizedCents: CentsString.nullable(),
  term: GainTerm,
});
export const LotDisposalView = z.object({
  accountId: z.string().uuid(),
  accountName: z.string(),
  securityId: z.string().uuid(),
  ticker: z.string().nullable(),
  closeTxnId: z.string().uuid(),
  /** Null for an `unmatched_sell`. */
  lotId: z.string().uuid().nullable(),
  kind: DisposalKind,
  date: IsoDateString,
  acquiredDate: IsoDateString.nullable(),
  quantity: Fixed8String,
  proceedsCents: CentsString,
  /** Null when `basisKnown` is false. */
  basisCents: CentsString.nullable(),
  gainCents: CentsString.nullable(),
  term: GainTerm,
  basisKnown: z.boolean(),
});
/** The engine's holding of a full-history account as of `asOf`. */
export const HoldingView = z.object({
  accountId: z.string().uuid(),
  securityId: z.string().uuid().nullable(),
  ticker: z.string().nullable(),
  securityName: z.string(),
  assetClass: AssetClass,
  quantity: Fixed8String,
  priceDate: IsoDateString.nullable(),
  price: Fixed8String.nullable(),
  priceSource: HoldingPriceSource.nullable(),
  stale: z.boolean(),
  valueCents: CentsString.nullable(),
  costBasisCents: CentsString.nullable(),
  unrealizedCents: CentsString.nullable(),
  unrealizedShortCents: CentsString,
  unrealizedLongCents: CentsString,
  unknownBasisQuantity: Fixed8String,
  lotCount: z.number().int(),
});
export const GainTotalsView = z.object({ proceedsCents: CentsString, basisCents: CentsString, gainCents: CentsString, count: z.number().int() });
export const RealizedSummaryView = z.object({
  shortTerm: GainTotalsView,
  longTerm: GainTotalsView,
  unknownBasis: z.object({ proceedsCents: CentsString, quantity: Fixed8String, count: z.number().int() }),
  transfersOut: z.object({ quantity: Fixed8String, basisCents: CentsString }),
  washSalesApplied: z.literal(false),
});
export const GainSummaryView = z.object({
  realizedShortCents: CentsString,
  realizedLongCents: CentsString,
  realizedCents: CentsString,
  unknownBasisProceedsCents: CentsString,
  unrealizedCents: CentsString,
  totalGainCents: CentsString,
  proceedsCents: CentsString,
  basisConsumedCents: CentsString,
  transferredOutBasisCents: CentsString,
  openValueCents: CentsString,
  openBasisCents: CentsString,
  originalBasisCents: CentsString,
  unpricedSecurityIds: z.array(z.string().uuid()),
});
/** The engine's per-(month, security) income row (`incomeByMonth`); `securityId` null = account-level interest or fees. */
export const EngineIncomeMonthView = z.object({
  month: MonthString,
  securityId: z.string().uuid().nullable(),
  ticker: z.string().nullable(),
  dividendCents: CentsString,
  interestCents: CentsString,
  feeCents: CentsString,
  reinvestedCents: CentsString,
});
export const StatementCheckView = z.object({
  date: IsoDateString,
  statementCents: CentsString,
  securitiesCents: CentsString,
  impliedCashCents: CentsString,
  trackedCashCents: CentsString,
  trackedFrom: z.union([IsoDateString, z.literal("inception")]),
  differenceCents: CentsString,
});
export const BenchmarkLegView = z.object({ date: IsoDateString, cents: CentsString, price: Fixed8String, priceDate: IsoDateString, units: Fixed8String });
export const BenchmarkPerformanceView = z.object({
  securityId: z.string().uuid(),
  ticker: z.string().nullable(),
  name: z.string(),
  /** True when adjusted closes were used (plan decision 10); the UI says "price only" otherwise. */
  adjusted: z.boolean(),
  twr: ReturnFigureView,
  xirr: XirrFigureView,
  shadowValueCents: CentsString,
  startPrice: Fixed8String,
  endPrice: Fixed8String,
  legs: z.array(BenchmarkLegView),
});
const PerformanceBlock = {
  method: ReturnMethod.nullable(),
  startValueCents: CentsString,
  endValueCents: CentsString,
  openingValue: z.object({ date: IsoDateString, cents: CentsString }).nullable(),
  contributionsCents: CentsString,
  withdrawalsCents: CentsString,
  netFlowsCents: CentsString,
  /** end − start − netFlows − openingValue */
  growthCents: CentsString,
  twr: ReturnFigureView,
  xirr: XirrFigureView,
  benchmark: BenchmarkPerformanceView.nullable(),
  subPeriods: z.array(SubPeriodView),
  flows: z.array(ExternalFlowView),
  realized: RealizedSummaryView.nullable(),
  gains: GainSummaryView.nullable(),
  income: z.array(EngineIncomeMonthView),
  warnings: z.array(EngineWarningView),
};
export const AccountPerformanceView = z.object({
  accountId: z.string().uuid(),
  name: z.string(),
  type: AccountType,
  taxTreatment: TaxTreatment,
  fidelity: InvestmentFidelity,
  ...PerformanceBlock,
  holdings: z.array(HoldingView),
  lots: z.array(LotView),
  disposals: z.array(LotDisposalView),
  statementCheck: StatementCheckView.nullable(),
});
export const PerformanceResponse = z.object({
  from: IsoDateString,
  to: IsoDateString,
  asOf: IsoDateString,
  today: IsoDateString,
  days: z.number().int(),
  detail: DetailLevel,
  accounts: z.array(AccountPerformanceView),
  total: z.object({ ...PerformanceBlock, accountIds: z.array(z.string().uuid()), partialGains: z.boolean(), excludedInternalFlows: z.number().int() }),
  benchmark: BenchmarkPerformanceView.nullable(),
  warnings: z.array(EngineWarningView),
});
export const LotsQuery = z.object({
  accountId: z.string().uuid().optional(),
  securityId: z.string().uuid().optional(),
  asOf: IsoDateString.optional(),
  today: IsoDateString.optional(),
  includeClosed: QueryBoolean.default("false"),
});
export const LotsAccountView = z.object({
  accountId: z.string().uuid(),
  fidelity: InvestmentFidelity,
  lotMethod: LotMethod,
  positionCheckDate: IsoDateString.nullable(),
  warnings: z.array(EngineWarningView),
});
export const LotsResponse = z.object({ asOf: IsoDateString, lots: z.array(LotView), accounts: z.array(LotsAccountView) });
export const RealizedGainsQuery = z.object({
  from: IsoDateString,
  to: IsoDateString,
  accountId: z.string().uuid().optional(),
  securityId: z.string().uuid().optional(),
  today: IsoDateString.optional(),
});
export const RealizedGainsResponse = z.object({
  from: IsoDateString,
  to: IsoDateString,
  summary: RealizedSummaryView,
  byAccount: z.array(z.object({ accountId: z.string().uuid(), name: z.string(), summary: RealizedSummaryView })),
  disposals: z.array(LotDisposalView),
});
/** `PUT /api/investments/txns/:id/lot-picks`: replaces the sale's picks; `[]` clears them. */
export const SetLotPicksBody = z.object({ picks: z.array(LotPickInput).max(200), today: IsoDateString.optional() });
export const SetLotPicksResponse = z.object({ picks: z.array(LotPickView), warnings: z.array(EngineWarningView), batchId: z.string().uuid() });
export const RebuildLotsBody = z.object({ accountId: z.string().uuid().optional() });
export const RebuildLotsResponse = z.object({ accounts: z.number().int(), lots: z.number().int(), disposals: z.number().int(), warnings: z.array(EngineWarningView) });

// ---- Prices (prices design §4; routes/prices.ts) ----
export const PriceView = z.object({
  securityId: z.string().uuid(),
  date: IsoDateString,
  close: NonNegFixed8String,
  adjClose: NonNegFixed8String.nullable(),
  source: PriceSource,
  provider: PriceProviderId.nullable(),
  suspect: z.boolean(),
  updatedAt: z.string(),
});
export const PriceHistoryQuery = z.object({
  from: IsoDateString.optional(),
  to: IsoDateString.optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(400),
  today: IsoDateString.optional(),
});
export const PriceHistoryResponse = z.object({
  securityId: z.string().uuid(),
  priceMode: PriceSource,
  expectedDate: IsoDateString,
  latest: PriceView.nullable(),
  priceStatus: PriceStatus,
  tradingDaysBehind: z.number().int(),
  /** Descending by date. */
  items: z.array(PriceView),
});
export const SecurityIdParams = z.object({ securityId: z.string().uuid() });
export const PriceParams = z.object({ securityId: z.string().uuid(), date: IsoDateString });
/** `PUT /api/prices/:securityId/:date`: a manual close (`date ≤ today`, never for the cash security). */
export const SetPriceBody = z.object({ close: NonNegFixed8String, today: IsoDateString.optional() });
export const RefreshPricesBody = z.object({ securityIds: z.array(z.string().uuid()).max(500).optional(), from: IsoDateString.optional() });
export const RefreshPricesResponse = z.object({ jobId: z.string().uuid(), created: z.boolean(), movedUp: z.boolean() });
export const RebuildImpliedPricesResponse = z.object({ written: z.number().int() });
export const SecurityPriceStatusView = z.object({
  securityId: z.string().uuid(),
  ticker: z.string().nullable(),
  name: z.string(),
  priceMode: PriceSource,
  providerSymbol: z.string().nullable(),
  alwaysPrice: z.boolean(),
  held: z.boolean(),
  latestPriceDate: IsoDateString.nullable(),
  latestClose: NonNegFixed8String.nullable(),
  latestSource: PriceSource.nullable(),
  priceStatus: PriceStatus,
  /** Trading days between the latest close and the expected close (provider mode only). */
  tradingDaysBehind: z.number().int(),
  fetchStatus: PriceFetchStatus.nullable(),
  fetchMessage: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  failures: z.number().int(),
  nextAttemptAt: z.string().nullable(),
  backfilledFrom: IsoDateString.nullable(),
});
export const PriceRunView = z.object({
  importLogId: z.string().uuid(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.enum(["running", "ok", "error"]),
  message: z.string().nullable(),
  stats: z.record(z.number()).nullable(),
});
export const PricesStatusResponse = z.object({
  provider: PriceProviderId.nullable(),
  configured: z.boolean(),
  fetchHourLocal: z.number().int(),
  catchupHourLocal: z.number().int().nullable(),
  timezone: z.string(),
  expectedDate: IsoDateString,
  lastRun: PriceRunView.nullable(),
  activeJob: z.object({ id: z.string().uuid(), status: JobStatus, reason: z.string(), runAt: z.string() }).nullable(),
  securities: z.array(SecurityPriceStatusView),
  counts: z.object({
    current: z.number().int(),
    stale: z.number().int(),
    notFound: z.number().int(),
    error: z.number().int(),
    implied: z.number().int(),
    manual: z.number().int(),
  }),
});

// ---- Valuation (prices design §3.7–3.9, §4; routes/valuation.ts) ----
/** One line of the valuation chain: a position, reported cash, the "Cash (from balance)" plug or carried transfer legs. */
export const LineValuationView = z.object({
  securityId: z.string().uuid().nullable(),
  ticker: z.string().nullable(),
  name: z.string(),
  kind: LineKind,
  quantity: Fixed8String.nullable(),
  price: NonNegFixed8String.nullable(),
  priceDate: IsoDateString.nullable(),
  priceSource: HoldingPriceSource.nullable(),
  priceStatus: PriceStatus,
  tradingDaysBehind: z.number().int(),
  valueCents: CentsString.nullable(),
  valueSource: ValueSource,
});
/** Price movement on the quantities held (plan decision 12); null with a reason for balance-only accounts. */
export const DayChangeView = z.object({
  cents: CentsString.nullable(),
  asOf: IsoDateString.nullable(),
  prior: IsoDateString.nullable(),
  reason: z.string().nullable(),
});
export const PortfolioDayChangeView = DayChangeView.extend({
  bp: BpInt.nullable(),
  /** True when any selected account was excluded. */
  partial: z.boolean(),
  excluded: z.array(z.object({ accountId: z.string().uuid(), reason: z.string() })),
});
export const StalestPriceView = z.object({ securityId: z.string().uuid(), priceDate: IsoDateString, tradingDaysBehind: z.number().int() });
/** An investment account valued on a date by the one chain (`valueAccountOn`, plan decision 8). */
export const AccountValuationView = z.object({
  accountId: z.string().uuid(),
  name: z.string(),
  type: AccountType,
  taxTreatment: TaxTreatment,
  fidelity: InvestmentFidelity,
  cashInference: CashInference,
  date: IsoDateString,
  basis: ValuationBasis,
  /** The date of the data the value rests on (a statement, the lots' checkpoint or the balance). */
  asOf: IsoDateString.nullable(),
  valueCents: CentsString.nullable(),
  priceStatus: AggregatePriceStatus,
  stalest: StalestPriceView.nullable(),
  /** Securities without any usable price. */
  missing: z.array(z.string().uuid()),
  /** value − the latest reported balance on or before the date. */
  balanceDiffCents: CentsString.nullable(),
  cashAnchor: IsoDateString.nullable(),
  lines: z.array(LineValuationView),
  dayChange: DayChangeView,
  lastReconciliation: LastReconciliationView.nullable(),
  warnings: z.array(z.string()),
});
export const ValuationSummaryQuery = TodayQuery.extend({
  asOf: IsoDateString.optional(),
  accountIds: QueryUuidList.optional(),
  period: InvestmentPeriod.default("1m"),
  /** The start of a `custom` period. */
  from: IsoDateString.optional(),
});
/** Period change, one computation (plan decision 12): change = growth + net flows; growth null with a reason. */
export const ChangeSummaryView = z.object({
  from: IsoDateString,
  to: IsoDateString,
  startCents: CentsString.nullable(),
  endCents: CentsString,
  changeCents: CentsString.nullable(),
  changeBp: BpInt.nullable(),
  /** External flows in (from, to] plus the opening values of accounts entering after `from`. */
  netFlowsCents: CentsString,
  growthCents: CentsString.nullable(),
  /** e.g. `flows_not_in_value` for a positions-basis account with cash inference off. */
  growthReason: z.string().nullable(),
  incomeCents: CentsString,
  uncategorizedRows: z.number().int(),
});
export const NewAccountView = z.object({ id: z.string().uuid(), name: z.string(), openingCents: CentsString });
export const PeriodChangeView = ChangeSummaryView.extend({ period: InvestmentPeriod, newAccounts: z.array(NewAccountView) });
export const ValuationSummaryResponse = z.object({
  asOf: IsoDateString,
  today: IsoDateString,
  expectedDate: IsoDateString,
  totalCents: CentsString.nullable(),
  partial: z.boolean(),
  missing: z.array(z.string().uuid()),
  priceStatus: AggregatePriceStatus,
  dayChange: PortfolioDayChangeView,
  periodChange: PeriodChangeView.nullable(),
  accounts: z.array(AccountValuationView),
});
export const ValuationSeriesQuery = TodayQuery.extend({
  from: IsoDateString,
  to: IsoDateString,
  accountIds: QueryUuidList.optional(),
  step: z.enum(["day", "week", "month"]).default("day"),
});
export const SeriesPointView = z.object({
  date: IsoDateString,
  valueCents: CentsString.nullable(),
  partial: z.boolean(),
  missing: z.array(z.string().uuid()),
  priceStatus: AggregatePriceStatus,
});
export const ValuationSeriesAccountView = z.object({
  accountId: z.string().uuid(),
  name: z.string(),
  type: AccountType,
  fidelity: InvestmentFidelity,
  firstDataDate: IsoDateString.nullable(),
  values: z.array(CentsString.nullable()),
});
export const ValuationSeriesResponse = z.object({
  from: IsoDateString,
  to: IsoDateString,
  expectedDate: IsoDateString,
  dates: z.array(IsoDateString),
  accounts: z.array(ValuationSeriesAccountView),
  portfolio: z.array(SeriesPointView),
});

// ---- Reconciliation (prices design §3.10, §4; routes/reconcile.ts; the gate) ----
export const ReconcileRowBody = z
  .object({
    securityId: z.string().uuid().optional(),
    ticker: z.string().max(32).optional(),
    isCash: z.boolean().default(false),
    /** Dollars for the cash row. */
    quantity: Fixed8String,
    price: NonNegFixed8String.optional(),
    valueCents: CentsString.optional(),
  })
  .refine((r) => r.securityId !== undefined || r.ticker !== undefined || r.isCash, { message: "securityId, ticker or isCash" });
export const ReconcilePreviewBody = z.object({
  accountId: z.string().uuid(),
  date: IsoDateString,
  /** Default: Σ rows. */
  statementTotalCents: CentsString.optional(),
  rows: z.array(ReconcileRowBody).max(500),
  /** Default RECONCILE_TOLERANCE_CENTS (100). */
  toleranceCents: NonNegCentsString.optional(),
  today: IsoDateString.optional(),
});
export const ReconcileRowView = z.object({
  securityId: z.string().uuid().nullable(),
  ticker: z.string().nullable(),
  name: z.string().nullable(),
  isCash: z.boolean(),
  app: z
    .object({
      quantity: Fixed8String.nullable(),
      price: NonNegFixed8String.nullable(),
      priceDate: IsoDateString.nullable(),
      priceSource: HoldingPriceSource.nullable(),
      valueCents: CentsString.nullable(),
      valueSource: ValueSource,
    })
    .nullable(),
  statement: z.object({ quantity: Fixed8String, price: NonNegFixed8String.nullable(), valueCents: CentsString }).nullable(),
  /** app − statement. */
  quantityDiff: Fixed8String.nullable(),
  priceDiff: Fixed8String.nullable(),
  valueDiffCents: CentsString.nullable(),
  status: ReconcileRowStatus,
});
export const ReconcileBalanceView = z.object({ balanceCents: CentsString.nullable(), balanceDate: IsoDateString.nullable(), differenceCents: CentsString.nullable() });
/** What `cash_inference = auto` would have done for an account that has it off. */
export const CashInferenceHintView = z.object({ flowsSinceSnapshotCents: CentsString, plugCents: CentsString, wouldReconcile: z.boolean() });
export const ReconcilePreviewResponse = z.object({
  accountId: z.string().uuid(),
  date: IsoDateString,
  app: AccountValuationView,
  statementTotalCents: CentsString,
  /** app − statement; null when the app has no value. */
  differenceCents: CentsString.nullable(),
  /** difference − Σ row diffs. */
  unexplainedCents: CentsString.nullable(),
  toleranceCents: NonNegCentsString,
  /** |difference| < tolerance; a difference of 0 is shown as "exact". */
  matchesToDollar: z.boolean(),
  rows: z.array(ReconcileRowView),
  balance: ReconcileBalanceView,
  cashInferenceHint: CashInferenceHintView.nullable(),
  alreadyReconciled: z.boolean(),
});
/** `accept = true` writes the statement as a manual holding snapshot and balance row; the attempt is recorded either way. */
export const ReconcileCommitBody = ReconcilePreviewBody.extend({ accept: z.boolean().default(true), note: z.string().max(500).optional() });
export const ReconcileCommitResponse = z.object({
  reconciliationId: z.string().uuid(),
  batchId: z.string().uuid(),
  accepted: z.boolean(),
  preCommitDifferenceCents: CentsString.nullable(),
  matchesToDollar: z.boolean(),
  /** The post-commit valuation on the date (equal to the statement when accepted). */
  app: AccountValuationView,
  rowsWritten: z.number().int(),
  impliedPricesWritten: z.number().int(),
});
export const ReconciliationListQuery = z.object({ accountId: z.string().uuid(), limit: z.coerce.number().int().min(1).max(200).default(50) });
export const ReconciliationView = ReconcilePreviewResponse.omit({ app: true, rows: true, cashInferenceHint: true, alreadyReconciled: true }).extend({
  id: z.string().uuid(),
  appValueCents: CentsString.nullable(),
  appBasis: ValuationBasis,
  appAsOf: IsoDateString.nullable(),
  /** The account setting in force at preview time. */
  cashInference: CashInference,
  reconciled: z.boolean(),
  accepted: z.boolean(),
  holdingSnapshotDate: IsoDateString.nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});
export const ReconciliationListResponse = z.object({ items: z.array(ReconciliationView) });

// ---- Investment views (views design §4; routes/investmentViews.ts) ----
export const AccountRef = z.object({
  accountId: z.string().uuid(),
  accountName: z.string(),
  type: AccountType,
  taxTreatment: TaxTreatment,
  fidelity: InvestmentFidelity,
  fidelityNote: z.string().nullable(),
});
export const SecurityRef = z.object({
  securityId: z.string().uuid(),
  ticker: z.string().nullable(),
  name: z.string(),
  type: SecurityType,
  assetClass: AssetClass,
  /** `security_allocation` splits (Σ 10 000 bp); empty = the primary class only. */
  splits: z.array(SecuritySplitView),
  needsReview: z.boolean(),
});
export const ValuationRef = z.object({
  valuationDate: IsoDateString.nullable(),
  valuationSource: ValuationSource.nullable(),
  /** Which step of the valuation chain produced the value. */
  basis: ValuationBasis,
  valuationStale: z.boolean(),
  positionsDate: IsoDateString.nullable(),
  positionsStale: z.boolean(),
});
export const AccountWarningView = z.object({ accountId: z.string().uuid(), accountName: z.string(), kind: AccountWarningKind, message: z.string() });
export const IncomeRowView = z.object({
  id: z.string(),
  date: IsoDateString,
  month: MonthString,
  accountId: z.string().uuid(),
  accountName: z.string(),
  securityId: z.string().uuid().nullable(),
  ticker: z.string().nullable(),
  kind: IncomeKind,
  cents: CentsString,
  reinvested: z.boolean(),
  source: z.enum(["investment_txn", "ledger"]),
  ledgerTransactionId: z.string().uuid().nullable(),
  linkStatus: LinkStatus,
  /** The linked ledger row carries the feed category. */
  fed: z.boolean(),
});
export const FidelityCountsView = z.object({ balance_only: z.number().int(), positions: z.number().int(), full_history: z.number().int() });

// Portfolio
export const PortfolioQuery = InvestmentPeriodQuery;
export const PortfolioAccountView = AccountRef.merge(ValuationRef).extend({
  valueCents: CentsString.nullable(),
  dayChangeCents: CentsString.nullable(),
  dayChangeBp: BpInt.nullable(),
  holdingsCount: z.number().int(),
  /** Reported cash lines. */
  cashCents: CentsString.nullable(),
  /** The `cash_plug` and `carried_flows` lines ("Cash (from balance)"). */
  residualCents: CentsString.nullable(),
  closed: z.boolean(),
  investmentIncomeFeed: InvestmentIncomeFeed,
  period: ChangeSummaryView.nullable(),
  warnings: z.array(AccountWarningView),
});
export const ValueSeriesView = z.object({
  dates: z.array(IsoDateString),
  /** Days between points (1, or 7 for long ranges). */
  step: z.number().int(),
  total: z.array(CentsString.nullable()),
  accounts: z.array(z.object({ accountId: z.string().uuid(), points: z.array(CentsString.nullable()) })),
});
export const PortfolioView = z.object({
  today: IsoDateString,
  asOf: IsoDateString.nullable(),
  period: PeriodView.nullable(),
  totalCents: CentsString,
  dayChange: PortfolioDayChangeView,
  periodChange: ChangeSummaryView.nullable(),
  accounts: z.array(PortfolioAccountView),
  series: ValueSeriesView,
  fidelityCounts: FidelityCountsView,
  warnings: z.array(z.string()),
});

// Allocation
export const AllocationQuery = AsOfQuery;
export const AllocationLineView = z.object({
  /** Null for a `cash_plug` or `carried_flows` line. */
  securityId: z.string().uuid().nullable(),
  ticker: z.string().nullable(),
  name: z.string(),
  accountId: z.string().uuid(),
  accountName: z.string(),
  cents: CentsString,
  kind: LineKind,
  /** Split across classes by `security_allocation`. */
  blended: z.boolean(),
});
export const AllocationClassView = z.object({
  assetClass: AssetClass,
  currentCents: CentsString,
  currentBp: BpInt.nullable(),
  targetBp: BpInt.nullable(),
  targetCents: CentsString.nullable(),
  driftBp: BpInt.nullable(),
  driftCents: CentsString.nullable(),
  outOfBand: z.boolean(),
  lines: z.array(AllocationLineView),
});
export const RebalanceTradeView = z.object({
  accountId: z.string().uuid(),
  accountName: z.string(),
  taxTreatment: TaxTreatment,
  action: RebalanceAction,
  assetClass: AssetClass,
  securityId: z.string().uuid().nullable(),
  ticker: z.string().nullable(),
  /** The class is already held in this account (buy more of it) rather than new to it. */
  inAccount: z.boolean(),
  amountCents: NonNegCentsString,
  approxQuantity: Fixed8String.nullable(),
  price: Fixed8String.nullable(),
  /** Pro-rata gain estimate on a taxable sell. */
  estimatedGainCents: CentsString.nullable(),
  note: z.string().nullable(),
});
export const RebalanceView = z.object({
  triggered: z.boolean(),
  bandBp: BpInt,
  minTradeCents: NonNegCentsString,
  trades: z.array(RebalanceTradeView),
  residual: z.array(z.object({ assetClass: AssetClass, amountCents: CentsString })),
  belowMinimumCents: NonNegCentsString,
  notes: z.array(z.string()),
});
export const AllocationView = z.object({
  today: IsoDateString,
  asOf: IsoDateString.nullable(),
  totalCents: CentsString,
  classifiedCents: CentsString,
  unclassifiedCents: CentsString,
  targetsSet: z.boolean(),
  /** Always six, in enum order. */
  classes: z.array(AllocationClassView),
  byTaxTreatment: z.array(
    z.object({ taxTreatment: TaxTreatment, cents: CentsString, bp: BpInt.nullable(), classes: z.array(z.object({ assetClass: AssetClass, cents: CentsString })) }),
  ),
  byAccount: z.array(
    AccountRef.extend({ cents: CentsString, bp: BpInt.nullable(), classes: z.array(z.object({ assetClass: AssetClass, cents: CentsString, bp: BpInt.nullable() })) }),
  ),
  /** Balance-only accounts: valued but not classified. */
  unclassifiedAccounts: z.array(AccountRef.extend({ cents: CentsString, bpOfTotal: BpInt.nullable() })),
  rebalance: RebalanceView.nullable(),
  warnings: z.array(z.string()),
  accountWarnings: z.array(AccountWarningView),
});

// Holdings
export const HoldingsQuery = AsOfQuery.extend({ accountId: z.string().uuid().optional() });
export const HoldingAccountView = AccountRef.extend({
  kind: LineKind,
  quantity: Fixed8String.nullable(),
  valueCents: CentsString,
  costBasisCents: CentsString.nullable(),
  basisSource: BasisSource.nullable(),
  gainCents: CentsString.nullable(),
  lotCount: z.number().int().nullable(),
  unknownBasisQuantity: Fixed8String.nullable(),
  snapshotDate: IsoDateString.nullable(),
  snapshotSource: HoldingSource.nullable(),
  priceSource: HoldingPriceSource,
  dollarOnly: z.boolean(),
});
/** One security across accounts (plan decision 16). */
export const HoldingRowView = SecurityRef.extend({
  quantity: Fixed8String.nullable(),
  price: Fixed8String.nullable(),
  priceDate: IsoDateString.nullable(),
  priceSource: HoldingPriceSource,
  priceStatus: PriceStatus,
  /** = priceStatus === "stale" (seams C26). */
  priceStale: z.boolean(),
  valueCents: CentsString,
  weightBp: BpInt.nullable(),
  costBasisCents: CentsString.nullable(),
  coverage: CostCoverage,
  gainCents: CentsString.nullable(),
  gainBp: BpInt.nullable(),
  expenseRatioPpm: z.number().int().nullable(),
  accounts: z.array(HoldingAccountView),
});
export const ConcentrationWarningView = z.object({
  level: ConcentrationLevel,
  securityId: z.string().uuid(),
  ticker: z.string().nullable(),
  weightBp: BpInt,
  thresholdBp: BpInt,
  message: z.string(),
});
export const WeightedExpenseRatioView = z.object({ ppm: z.number().int().nullable(), coveredBp: BpInt.nullable(), annualCostCents: CentsString });
export const HoldingsView = z.object({
  today: IsoDateString,
  asOf: IsoDateString.nullable(),
  totalCents: CentsString,
  holdingsCents: CentsString,
  cashCents: CentsString,
  /** The `cash_plug` and `carried_flows` lines ("Cash (from balance)"). */
  residualCents: CentsString,
  rows: z.array(HoldingRowView),
  weightedExpenseRatio: WeightedExpenseRatioView,
  concentration: z.array(ConcentrationWarningView),
  excludedAccounts: z.array(AccountRef.extend({ cents: CentsString.nullable() })),
  accountWarnings: z.array(AccountWarningView),
  warnings: z.array(z.string()),
});
/** `PUT /api/investments/securities/:id/allocation` → `SecurityRef`. `splits` null or [] = the primary class only; else distinct classes summing to 10 000 (400 `split_sum`) that include `assetClass` (400 `split_primary`). */
export const SetSecurityAllocationBody = z.object({
  assetClass: AssetClass,
  splits: z.array(z.object({ assetClass: AssetClass, weightBp: z.number().int().min(1).max(10000) })).max(6).nullable(),
});

// Performance (presentation of the engine route; a test asserts GET equals POST)
export const PerformanceQuery = InvestmentPeriodQuery.extend({ accountIds: QueryUuidList.optional(), benchmarkSecurityId: z.string().uuid().optional() });
export const BenchmarkBlockView = z.object({
  twr: RateNumber.nullable(),
  twrAnnualized: RateNumber.nullable(),
  xirrAnnualized: RateNumber.nullable(),
  shadowValueCents: CentsString.nullable(),
  /** twr.rate − benchmark twr; null when either is null. */
  excessTwr: RateNumber.nullable(),
  startPrice: Fixed8String.nullable(),
  endPrice: Fixed8String.nullable(),
  reason: z.string().nullable(),
});
export const IndexPointView = z.object({ date: IsoDateString, indexBp: BpInt });
/** 10 000 at `from`; points at the engine's sub-period boundaries. */
export const IndexSeriesView = z.array(IndexPointView);
export const ReturnBlockView = z.object({
  method: ReturnMethod.nullable(),
  startValueCents: CentsString,
  endValueCents: CentsString,
  openingValue: z.object({ date: IsoDateString, cents: CentsString }).nullable(),
  contributionsCents: CentsString,
  withdrawalsCents: CentsString,
  netFlowsCents: CentsString,
  growthCents: CentsString,
  twr: ReturnFigureView,
  xirr: XirrFigureView,
  benchmark: BenchmarkBlockView.nullable(),
  flows: z.array(ExternalFlowView),
  flowsSource: FlowsSource,
  uncategorizedRows: z.number().int(),
  warnings: z.array(EngineWarningView),
  /** `returnReasonText` of the reasons and warnings. */
  readable: z.array(z.string()),
  series: IndexSeriesView,
});
export const PerformanceBenchmarkView = z.object({
  securityId: z.string().uuid(),
  ticker: z.string().nullable(),
  name: z.string(),
  /** Adjusted closes were used; the UI says "price only" otherwise. */
  adjusted: z.boolean(),
  series: IndexSeriesView,
});
export const PerformanceView = z.object({
  today: IsoDateString,
  asOf: IsoDateString.nullable(),
  period: PeriodView.nullable(),
  benchmark: PerformanceBenchmarkView.nullable(),
  total: ReturnBlockView.nullable(),
  accounts: z.array(AccountRef.extend({ block: ReturnBlockView })),
  warnings: z.array(z.string()),
});

// Income (plan decision 13)
export const IncomeQuery = AsOfQuery.extend({
  period: InvestmentPeriod.default("ytd"),
  from: IsoDateString.optional(),
  to: IsoDateString.optional(),
  accountId: z.string().uuid().optional(),
});
export const IncomeMonthView = z.object({
  month: MonthString,
  dividendsCents: CentsString,
  interestCents: CentsString,
  feesCents: CentsString,
  /** Reinvested dividends (a subset of dividends), never fed to the plan. */
  reinvestedCents: CentsString,
  /** dividends + interest. */
  totalCents: CentsString,
  bySecurity: z.array(z.object({ securityId: z.string().uuid().nullable(), ticker: z.string().nullable(), cents: CentsString })),
  byAccount: z.array(z.object({ accountId: z.string().uuid(), cents: CentsString })),
});
export const IncomeTotalsView = z.object({ dividendsCents: CentsString, interestCents: CentsString, feesCents: CentsString, reinvestedCents: CentsString, totalCents: CentsString });
export const IncomeFeedAccountView = AccountRef.extend({
  mode: InvestmentIncomeFeed,
  linked: z.number().int(),
  created: z.number().int(),
  awaiting: z.number().int(),
  fed: z.number().int(),
  hasLedger: z.boolean(),
  suggestedMode: InvestmentIncomeFeed,
});
export const IncomeView = z.object({
  today: IsoDateString,
  asOf: IsoDateString.nullable(),
  period: PeriodView.nullable(),
  months: z.array(IncomeMonthView),
  totals: IncomeTotalsView,
  trailing12mCents: CentsString,
  yieldBp: BpInt.nullable(),
  rows: z.array(IncomeRowView),
  /** Rows are capped at 2 000. */
  rowsTruncated: z.boolean(),
  feed: z.object({ categoryId: z.string().uuid().nullable(), categoryName: z.string().nullable(), accounts: z.array(IncomeFeedAccountView) }),
  warnings: z.array(z.string()),
});
export const RunIncomeFeedBody = z.object({ accountId: z.string().uuid().optional() });
export const RunIncomeFeedResponse = z.object({
  categorized: z.number().int(),
  created: z.number().int(),
  upgraded: z.number().int(),
  awaiting: z.number().int(),
  unchanged: z.number().int(),
  deleted: z.number().int(),
});

// Why did it change (views design §3.9; `from < to ≤ today`, at most 5 years)
export const AccountChangesQuery = TodayQuery.extend({ from: IsoDateString, to: IsoDateString });
export const HoldingChangeView = z.object({
  securityId: z.string().uuid().nullable(),
  ticker: z.string().nullable(),
  name: z.string(),
  kind: LineKind,
  quantityFrom: Fixed8String.nullable(),
  quantityTo: Fixed8String.nullable(),
  priceFrom: Fixed8String.nullable(),
  priceTo: Fixed8String.nullable(),
  valueFromCents: CentsString,
  valueToCents: CentsString,
  deltaCents: CentsString,
  /** mulToCents(quantityFrom, priceTo) − valueFrom; the rest of the delta is the quantity effect. */
  priceEffectCents: CentsString,
  quantityEffectCents: CentsString,
});
export const AccountChangesView = AccountRef.extend({
  from: IsoDateString,
  to: IsoDateString,
  summary: ChangeSummaryView,
  holdings: z.array(HoldingChangeView),
  /** The change of the cash, plug and carried-flow lines; Σ holdings + this = the change exactly. */
  residualEffectCents: CentsString,
  flows: z.array(ExternalFlowView),
  income: z.array(IncomeRowView),
  warnings: z.array(z.string()),
});

// ---- Inferred types ----
export type QueryUuidList = z.infer<typeof QueryUuidList>;
export type AsOfQuery = z.infer<typeof AsOfQuery>;
export type InvestmentPeriodQuery = z.infer<typeof InvestmentPeriodQuery>;
export type PeriodView = z.infer<typeof PeriodView>;
export type AggregatePriceStatus = z.infer<typeof AggregatePriceStatus>;
export type DetailLevel = z.infer<typeof DetailLevel>;
export type IncomeKind = z.infer<typeof IncomeKind>;
export type RebalanceAction = z.infer<typeof RebalanceAction>;
export type ConcentrationLevel = z.infer<typeof ConcentrationLevel>;
export type ValuationSource = z.infer<typeof ValuationSource>;
export type CostCoverage = z.infer<typeof CostCoverage>;
export type LinkStatus = z.infer<typeof LinkStatus>;
export type FlowsSource = z.infer<typeof FlowsSource>;
export type AccountWarningKind = z.infer<typeof AccountWarningKind>;
export type BasisSource = z.infer<typeof BasisSource>;
export type SecurityIdentityKind = z.infer<typeof SecurityIdentityKind>;
export type SecurityMatchedBy = z.infer<typeof SecurityMatchedBy>;
export type PreviewMatchedBy = z.infer<typeof PreviewMatchedBy>;
export type SecuritySuggestion = z.infer<typeof SecuritySuggestion>;
export type SecurityAliasView = z.infer<typeof SecurityAliasView>;
export type SecuritySplitView = z.infer<typeof SecuritySplitView>;
export type LatestPriceView = z.infer<typeof LatestPriceView>;
export type SecurityView = z.infer<typeof SecurityView>;
export type SecurityQuery = z.infer<typeof SecurityQuery>;
export type CreateSecurityBody = z.infer<typeof CreateSecurityBody>;
export type UpdateSecurityBody = z.infer<typeof UpdateSecurityBody>;
export type UpdateSecurityPricingBody = z.infer<typeof UpdateSecurityPricingBody>;
export type MergeSecurityBody = z.infer<typeof MergeSecurityBody>;
export type AddSecurityAliasBody = z.infer<typeof AddSecurityAliasBody>;
export type ResolveSecurityQuery = z.infer<typeof ResolveSecurityQuery>;
export type ResolveSecurityResponse = z.infer<typeof ResolveSecurityResponse>;
export type SecurityChoice = z.infer<typeof SecurityChoice>;
export type RowChoice = z.infer<typeof RowChoice>;
export type PreviewSecurityRef = z.infer<typeof PreviewSecurityRef>;
export type PositionsPreviewBody = z.infer<typeof PositionsPreviewBody>;
export type MappedPositionView = z.infer<typeof MappedPositionView>;
export type PositionsPreviewResponse = z.infer<typeof PositionsPreviewResponse>;
export type PositionsCommitBody = z.infer<typeof PositionsCommitBody>;
export type PositionsImportResult = z.infer<typeof PositionsImportResult>;
export type TradesPreviewBody = z.infer<typeof TradesPreviewBody>;
export type LedgerMatchView = z.infer<typeof LedgerMatchView>;
export type MappedTradeView = z.infer<typeof MappedTradeView>;
export type ActionFoundView = z.infer<typeof ActionFoundView>;
export type TradesPreviewResponse = z.infer<typeof TradesPreviewResponse>;
export type TradesCommitBody = z.infer<typeof TradesCommitBody>;
export type TradesImportResult = z.infer<typeof TradesImportResult>;
export type HoldingSnapshotRowView = z.infer<typeof HoldingSnapshotRowView>;
export type HoldingSnapshotView = z.infer<typeof HoldingSnapshotView>;
export type SnapshotSummaryView = z.infer<typeof SnapshotSummaryView>;
export type SnapshotDateParams = z.infer<typeof SnapshotDateParams>;
export type PositionsQuery = z.infer<typeof PositionsQuery>;
export type ManualPositionInput = z.infer<typeof ManualPositionInput>;
export type ManualPositionsBody = z.infer<typeof ManualPositionsBody>;
export type LotPickInput = z.infer<typeof LotPickInput>;
export type LotPicks = z.infer<typeof LotPicks>;
export type LotPickView = z.infer<typeof LotPickView>;
export type InvestmentTxnView = z.infer<typeof InvestmentTxnView>;
export type InvestmentTxnQuery = z.infer<typeof InvestmentTxnQuery>;
export type InvestmentTxnList = z.infer<typeof InvestmentTxnList>;
export type CreateInvestmentTxnBody = z.infer<typeof CreateInvestmentTxnBody>;
export type UpdateInvestmentTxnBody = z.infer<typeof UpdateInvestmentTxnBody>;
export type DeleteInvestmentTxnQuery = z.infer<typeof DeleteInvestmentTxnQuery>;
export type CreateInvestmentTxnResponse = z.infer<typeof CreateInvestmentTxnResponse>;
export type AllocationTargetView = z.infer<typeof AllocationTargetView>;
export type AllocationTargetsView = z.infer<typeof AllocationTargetsView>;
export type SetAllocationTargetsBody = z.infer<typeof SetAllocationTargetsBody>;
export type PerformanceRequestBody = z.infer<typeof PerformanceRequestBody>;
export type ReturnFigureView = z.infer<typeof ReturnFigureView>;
export type InvestorFlowView = z.infer<typeof InvestorFlowView>;
export type XirrFigureView = z.infer<typeof XirrFigureView>;
export type SubPeriodView = z.infer<typeof SubPeriodView>;
export type ExternalFlowView = z.infer<typeof ExternalFlowView>;
export type EngineWarningView = z.infer<typeof EngineWarningView>;
export type LotView = z.infer<typeof LotView>;
export type LotDisposalView = z.infer<typeof LotDisposalView>;
export type HoldingView = z.infer<typeof HoldingView>;
export type GainTotalsView = z.infer<typeof GainTotalsView>;
export type RealizedSummaryView = z.infer<typeof RealizedSummaryView>;
export type GainSummaryView = z.infer<typeof GainSummaryView>;
export type EngineIncomeMonthView = z.infer<typeof EngineIncomeMonthView>;
export type StatementCheckView = z.infer<typeof StatementCheckView>;
export type BenchmarkLegView = z.infer<typeof BenchmarkLegView>;
export type BenchmarkPerformanceView = z.infer<typeof BenchmarkPerformanceView>;
export type AccountPerformanceView = z.infer<typeof AccountPerformanceView>;
export type PerformanceResponse = z.infer<typeof PerformanceResponse>;
export type LotsQuery = z.infer<typeof LotsQuery>;
export type LotsAccountView = z.infer<typeof LotsAccountView>;
export type LotsResponse = z.infer<typeof LotsResponse>;
export type RealizedGainsQuery = z.infer<typeof RealizedGainsQuery>;
export type RealizedGainsResponse = z.infer<typeof RealizedGainsResponse>;
export type SetLotPicksBody = z.infer<typeof SetLotPicksBody>;
export type SetLotPicksResponse = z.infer<typeof SetLotPicksResponse>;
export type RebuildLotsBody = z.infer<typeof RebuildLotsBody>;
export type RebuildLotsResponse = z.infer<typeof RebuildLotsResponse>;
export type PriceView = z.infer<typeof PriceView>;
export type PriceHistoryQuery = z.infer<typeof PriceHistoryQuery>;
export type PriceHistoryResponse = z.infer<typeof PriceHistoryResponse>;
export type SecurityIdParams = z.infer<typeof SecurityIdParams>;
export type PriceParams = z.infer<typeof PriceParams>;
export type SetPriceBody = z.infer<typeof SetPriceBody>;
export type RefreshPricesBody = z.infer<typeof RefreshPricesBody>;
export type RefreshPricesResponse = z.infer<typeof RefreshPricesResponse>;
export type RebuildImpliedPricesResponse = z.infer<typeof RebuildImpliedPricesResponse>;
export type SecurityPriceStatusView = z.infer<typeof SecurityPriceStatusView>;
export type PriceRunView = z.infer<typeof PriceRunView>;
export type PricesStatusResponse = z.infer<typeof PricesStatusResponse>;
export type LineValuationView = z.infer<typeof LineValuationView>;
export type DayChangeView = z.infer<typeof DayChangeView>;
export type PortfolioDayChangeView = z.infer<typeof PortfolioDayChangeView>;
export type StalestPriceView = z.infer<typeof StalestPriceView>;
export type AccountValuationView = z.infer<typeof AccountValuationView>;
export type ValuationSummaryQuery = z.infer<typeof ValuationSummaryQuery>;
export type ChangeSummaryView = z.infer<typeof ChangeSummaryView>;
export type NewAccountView = z.infer<typeof NewAccountView>;
export type PeriodChangeView = z.infer<typeof PeriodChangeView>;
export type ValuationSummaryResponse = z.infer<typeof ValuationSummaryResponse>;
export type ValuationSeriesQuery = z.infer<typeof ValuationSeriesQuery>;
export type SeriesPointView = z.infer<typeof SeriesPointView>;
export type ValuationSeriesAccountView = z.infer<typeof ValuationSeriesAccountView>;
export type ValuationSeriesResponse = z.infer<typeof ValuationSeriesResponse>;
export type ReconcileRowBody = z.infer<typeof ReconcileRowBody>;
export type ReconcilePreviewBody = z.infer<typeof ReconcilePreviewBody>;
export type ReconcileRowView = z.infer<typeof ReconcileRowView>;
export type ReconcileBalanceView = z.infer<typeof ReconcileBalanceView>;
export type CashInferenceHintView = z.infer<typeof CashInferenceHintView>;
export type ReconcilePreviewResponse = z.infer<typeof ReconcilePreviewResponse>;
export type ReconcileCommitBody = z.infer<typeof ReconcileCommitBody>;
export type ReconcileCommitResponse = z.infer<typeof ReconcileCommitResponse>;
export type ReconciliationListQuery = z.infer<typeof ReconciliationListQuery>;
export type ReconciliationView = z.infer<typeof ReconciliationView>;
export type ReconciliationListResponse = z.infer<typeof ReconciliationListResponse>;
export type AccountRef = z.infer<typeof AccountRef>;
export type SecurityRef = z.infer<typeof SecurityRef>;
export type ValuationRef = z.infer<typeof ValuationRef>;
export type AccountWarningView = z.infer<typeof AccountWarningView>;
export type IncomeRowView = z.infer<typeof IncomeRowView>;
export type FidelityCountsView = z.infer<typeof FidelityCountsView>;
export type PortfolioQuery = z.infer<typeof PortfolioQuery>;
export type PortfolioAccountView = z.infer<typeof PortfolioAccountView>;
export type ValueSeriesView = z.infer<typeof ValueSeriesView>;
export type PortfolioView = z.infer<typeof PortfolioView>;
export type AllocationQuery = z.infer<typeof AllocationQuery>;
export type AllocationLineView = z.infer<typeof AllocationLineView>;
export type AllocationClassView = z.infer<typeof AllocationClassView>;
export type RebalanceTradeView = z.infer<typeof RebalanceTradeView>;
export type RebalanceView = z.infer<typeof RebalanceView>;
export type AllocationView = z.infer<typeof AllocationView>;
export type HoldingsQuery = z.infer<typeof HoldingsQuery>;
export type HoldingAccountView = z.infer<typeof HoldingAccountView>;
export type HoldingRowView = z.infer<typeof HoldingRowView>;
export type ConcentrationWarningView = z.infer<typeof ConcentrationWarningView>;
export type WeightedExpenseRatioView = z.infer<typeof WeightedExpenseRatioView>;
export type HoldingsView = z.infer<typeof HoldingsView>;
export type SetSecurityAllocationBody = z.infer<typeof SetSecurityAllocationBody>;
export type PerformanceQuery = z.infer<typeof PerformanceQuery>;
export type BenchmarkBlockView = z.infer<typeof BenchmarkBlockView>;
export type IndexPointView = z.infer<typeof IndexPointView>;
export type IndexSeriesView = z.infer<typeof IndexSeriesView>;
export type ReturnBlockView = z.infer<typeof ReturnBlockView>;
export type PerformanceBenchmarkView = z.infer<typeof PerformanceBenchmarkView>;
export type PerformanceView = z.infer<typeof PerformanceView>;
export type IncomeQuery = z.infer<typeof IncomeQuery>;
export type IncomeMonthView = z.infer<typeof IncomeMonthView>;
export type IncomeTotalsView = z.infer<typeof IncomeTotalsView>;
export type IncomeFeedAccountView = z.infer<typeof IncomeFeedAccountView>;
export type IncomeView = z.infer<typeof IncomeView>;
export type RunIncomeFeedBody = z.infer<typeof RunIncomeFeedBody>;
export type RunIncomeFeedResponse = z.infer<typeof RunIncomeFeedResponse>;
export type AccountChangesQuery = z.infer<typeof AccountChangesQuery>;
export type HoldingChangeView = z.infer<typeof HoldingChangeView>;
export type AccountChangesView = z.infer<typeof AccountChangesView>;
