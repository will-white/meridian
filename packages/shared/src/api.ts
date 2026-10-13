import { z } from "zod";
import { CsvMapping } from "./csv.js";
import { AccountType, Bucket, ConnectionStatus, ConnectionType, JobStatus, JobType, TaxTreatment, TransactionSource } from "./enums.js";
import { RuleActions, RuleConditions } from "./rules.js";

/** Request and response contracts shared by the API and the web app. Cents are decimal strings. */

export const CentsString = z.string().regex(/^-?\d+$/, "cents as an integer string");
export const IsoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
export const UuidParams = z.object({ id: z.string().uuid() });
export const OkResponse = z.object({ ok: z.literal(true) });
export const ErrorResponse = z.object({ error: z.string(), code: z.string().optional() });

// ---- Auth ----
export const AuthStatus = z.object({
  setupRequired: z.boolean(),
  authenticated: z.boolean(),
  /** True when the session is password-verified but still needs a TOTP code. */
  totpRequired: z.boolean(),
  totpEnrolled: z.boolean(),
  username: z.string().optional(),
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
  csvMapping: CsvMapping.nullable(),
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
  uncategorized: z.coerce.boolean().optional(),
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
  includeDismissed: z.coerce.boolean().default(false),
  includeResolved: z.coerce.boolean().default(false),
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
  }),
  review: z.object({ uncategorized: z.number().int(), suggestedRecurring: z.number().int(), alerts: z.number().int() }),
  sync: z.object({
    lastSyncAt: z.string().nullable(),
    attention: z.array(z.object({ connectionId: z.string().uuid(), name: z.string(), status: ConnectionStatus })),
  }),
  retirement: z.null(),
});
export type DashboardView = z.infer<typeof DashboardView>;
