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
});
export type AccountView = z.infer<typeof AccountView>;
export const UpdateAccountBody = z.object({
  name: z.string().min(1).max(100).optional(),
  type: AccountType.optional(),
  taxTreatment: TaxTreatment.optional(),
  onBudget: z.boolean().optional(),
  closed: z.boolean().optional(),
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
