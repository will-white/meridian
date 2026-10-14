import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { account, CASH_INFERENCES } from "./accounts.js";
import { user } from "./auth.js";
import { transaction } from "./ledger.js";
import { importLog } from "./sources.js";

/**
 * Phase 3: investments. Money columns are bigint cents; share quantities and prices are
 * numeric(20,8) (Fixed8 in TypeScript, decimal strings on the wire). Text columns mirror
 * the enums of `packages/shared/src/enums.ts` (plan decision 3); the named CHECKs below are
 * mirrored by service validations that fail first with the same name as the error code.
 */

export const SECURITY_TYPES = ["stock", "etf", "fund", "bond", "cash", "cd", "other"] as const;
export const ASSET_CLASSES = ["us_stock", "intl_stock", "bonds", "cash", "real_estate", "other"] as const;
/** Also `security.price_mode`. */
export const PRICE_SOURCES = ["provider", "implied", "manual"] as const;
export const PRICE_PROVIDER_IDS = ["tiingo"] as const;
export const PRICE_FETCH_STATUSES = ["ok", "not_found", "error", "rate_limited"] as const;
export const SECURITY_ALIAS_KINDS = ["ticker", "cusip", "isin", "name"] as const;
export const HOLDING_SOURCES = ["simplefin", "csv", "manual"] as const;
export const INVESTMENT_TXN_TYPES = ["buy", "sell", "dividend", "interest", "reinvest", "fee", "split", "transfer"] as const;
/** Only `csv` and `manual` are written in Phase 3; `simplefin` and `ofx` are reserved. */
export const INVESTMENT_TXN_SOURCES = ["csv", "manual", "simplefin", "ofx"] as const;
export const TRANSFER_DIRECTIONS = ["in", "out"] as const;
export const LOT_OPENED_BY = ["buy", "reinvest", "transfer_in"] as const;
export const GAIN_TERMS = ["short", "long", "unknown", "none"] as const;
export const DISPOSAL_KINDS = ["sell", "transfer_out", "unmatched_sell"] as const;
export const VALUATION_BASES = ["snapshot", "lots", "positions", "balance", "none"] as const;

const fixed8 = (name: string) => numeric(name, { precision: 20, scale: 8 });

/** Security master: one row per instrument; the cash security per currency is created lazily. */
export const security = pgTable(
  "security",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Normalized (trim, upper, strip leading `$` and trailing `*`); null for ticker-less funds and cash. */
    ticker: text("ticker"),
    /** Sanitized, <= 200 chars. */
    name: text("name").notNull(),
    type: text("type", { enum: SECURITY_TYPES }).notNull(),
    /** Primary asset class; `security_allocation` rows refine blended funds. */
    assetClass: text("asset_class", { enum: ASSET_CLASSES }).notNull().default("other"),
    /** Parts per million (0.035% = 350); null = unknown. */
    expenseRatioPpm: integer("expense_ratio_ppm"),
    /** 9 chars, upper. */
    cusip: text("cusip"),
    /** 12 chars, upper. */
    isin: text("isin"),
    currency: text("currency").notNull().default("USD"),
    /** Set by the service on create: `provider` with a ticker, else `implied`; cash is `manual` and valued at 1. */
    priceMode: text("price_mode", { enum: PRICE_SOURCES }).notNull(),
    /** Symbol at the price provider when it differs from `ticker` (the fetch uses `provider_symbol ?? ticker`). */
    providerSymbol: text("provider_symbol"),
    /** Cleared when the owner saves the row. */
    needsReview: boolean("needs_review").notNull().default(true),
    /** Hidden from pickers, kept for history. */
    archived: boolean("archived").notNull().default(false),
    notes: text("notes"),
    /** Fetched even when not held (benchmarks). */
    alwaysPrice: boolean("always_price").notNull().default(false),
    /** Last attempt that reached the provider. */
    priceFetchedAt: timestamp("price_fetched_at", { withTimezone: true }),
    priceFetchStatus: text("price_fetch_status", { enum: PRICE_FETCH_STATUSES }),
    /** Sanitized provider text, <= 300 chars. */
    priceFetchMessage: text("price_fetch_message"),
    /** Consecutive network/HTTP failures (drives the per-security backoff). */
    priceFetchFailures: integer("price_fetch_failures").notNull().default(0),
    /** Backoff; null = eligible now. */
    priceNextAttemptAt: timestamp("price_next_attempt_at", { withTimezone: true }),
    /** Earliest date a completed provider request covered. */
    priceBackfilledFrom: date("price_backfilled_from"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("security_ticker_idx").on(t.ticker).where(sql`"ticker" IS NOT NULL`),
    uniqueIndex("security_cusip_idx").on(t.cusip).where(sql`"cusip" IS NOT NULL`),
    uniqueIndex("security_isin_idx").on(t.isin).where(sql`"isin" IS NOT NULL`),
    /** One cash security per currency. */
    uniqueIndex("security_cash_currency_idx").on(t.currency).where(sql`"type" = 'cash'`),
    /** Name resolution: the same normalization as `normalizeName` in packages/shared. */
    index("security_name_norm_idx").on(sql`upper(regexp_replace("name", '[^A-Za-z0-9]+', ' ', 'g'))`),
    index("security_needs_review_idx").on(t.needsReview),
    check("security_ticker_shape", sql`"ticker" IS NULL OR "ticker" ~ '^[A-Z0-9][A-Z0-9./-]{0,11}$'`),
    check("security_expense_ratio_range", sql`"expense_ratio_ppm" IS NULL OR ("expense_ratio_ppm" >= 0 AND "expense_ratio_ppm" <= 1000000)`),
    check("security_cash_shape", sql`"type" <> 'cash' OR ("ticker" IS NULL AND "asset_class" = 'cash')`),
    check("security_price_fetch_status_check", sql`"price_fetch_status" IS NULL OR "price_fetch_status" IN ('ok', 'not_found', 'error', 'rate_limited')`),
  ],
);

/** Learned identifiers (merges, "link to existing", owner-added, e.g. FB -> META). Unique per (kind, value) across securities. */
export const securityAlias = pgTable(
  "security_alias",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    securityId: uuid("security_id")
      .notNull()
      .references(() => security.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: SECURITY_ALIAS_KINDS }).notNull(),
    /** Normalized as the resolver normalizes that kind. */
    value: text("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("security_alias_kind_value_idx").on(t.kind, t.value), index("security_alias_security_idx").on(t.securityId)],
);

/** Class splits for blended funds: per security the weights sum to 10 000 bp or there are none. */
export const securityAllocation = pgTable(
  "security_allocation",
  {
    securityId: uuid("security_id")
      .notNull()
      .references(() => security.id, { onDelete: "cascade" }),
    assetClass: text("asset_class", { enum: ASSET_CLASSES }).notNull(),
    weightBp: integer("weight_bp").notNull(),
  },
  (t) => [
    primaryKey({ name: "security_allocation_pk", columns: [t.securityId, t.assetClass] }),
    check("security_allocation_class_check", sql`"asset_class" IN ('us_stock', 'intl_stock', 'bonds', 'cash', 'real_estate', 'other')`),
    check("security_allocation_weight_check", sql`"weight_bp" BETWEEN 1 AND 10000`),
  ],
);

/** Daily closes. Precedence on write: manual > provider > implied (`upsertPrices` is the only writer). */
export const price = pgTable(
  "price",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    securityId: uuid("security_id")
      .notNull()
      .references(() => security.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    /** Unadjusted close; 0 for a worthless security. */
    close: fixed8("close").notNull(),
    source: text("source", { enum: PRICE_SOURCES }).notNull(),
    /** Provider rows: dividend/split-adjusted close (the benchmark uses it when present). */
    adjClose: fixed8("adj_close"),
    /** 'tiingo' on provider rows, null otherwise. */
    provider: text("provider", { enum: PRICE_PROVIDER_IDS }),
    /** Flagged by the suspect rule on fetch; valuation still uses the row. */
    suspect: boolean("suspect").notNull().default(false),
    /** Provider rows: when fetched. */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("price_security_date_idx").on(t.securityId, t.date),
    index("price_date_idx").on(t.date),
    check("price_close_nonneg", sql`"close" >= 0`),
    check("price_adj_close_nonneg", sql`"adj_close" IS NULL OR "adj_close" >= 0`),
    check("price_source_check", sql`"source" IN ('provider', 'implied', 'manual')`),
    check("price_provider_shape", sql`("source" = 'provider') = ("provider" IS NOT NULL)`),
  ],
);

/**
 * Positions as a source reported them on a date (statement or feed, never "today").
 * A snapshot set is every row with one (account_id, date); `replaceHoldingSnapshot` is the only writer.
 */
export const holdingSnapshot = pgTable(
  "holding_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id, { onDelete: "cascade" }),
    /** Merges repoint; a referenced security cannot be deleted. */
    securityId: uuid("security_id")
      .notNull()
      .references(() => security.id, { onDelete: "restrict" }),
    date: date("date").notNull(),
    /** Null = dollar-only position (value known, units not reported); may be negative (margin cash, shorts). */
    quantity: fixed8("quantity"),
    /** As reported, or implied `impliedPrice(value, qty)`; null when quantity is null or 0. */
    price: fixed8("price"),
    /** Market value as the source reported it (or `mulToCents(qty, price)` when the source gave only a price). */
    valueCents: bigint("value_cents", { mode: "bigint" }).notNull(),
    /** The source's cost basis, when present; displayed, never used for gains. */
    reportedCostBasisCents: bigint("reported_cost_basis_cents", { mode: "bigint" }),
    source: text("source", { enum: HOLDING_SOURCES }).notNull(),
    importLogId: uuid("import_log_id").references(() => importLog.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("holding_snapshot_account_security_date_idx").on(t.accountId, t.securityId, t.date),
    index("holding_snapshot_account_date_idx").on(t.accountId, t.date),
    index("holding_snapshot_security_date_idx").on(t.securityId, t.date),
    index("holding_snapshot_date_idx").on(t.date),
    check("hs_price_needs_quantity", sql`"price" IS NULL OR "quantity" IS NOT NULL`),
  ],
);

/**
 * Investment activity (trades, income, fees, splits, transfers). `quantity` is unsigned; direction
 * comes from `type` / `transfer_direction`. `amount_cents` is the signed cash effect (buy and
 * reinvest <= 0, sell >= 0, fee <= 0, split 0). A reinvested dividend is two rows: `dividend` (+)
 * and `reinvest` (<= 0). Same-day order is (date, type rank, sequence, id).
 */
export const investmentTxn = pgTable(
  "investment_txn",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id, { onDelete: "cascade" }),
    /** Null only for cash transfers, account-level fees and interest on cash. */
    securityId: uuid("security_id").references(() => security.id, { onDelete: "restrict" }),
    /** Trade date. */
    date: date("date").notNull(),
    /** Same-day order within a type rank: the row's ordinal in its import file; manual rows get max + 1. */
    sequence: integer("sequence").notNull().default(0),
    type: text("type", { enum: INVESTMENT_TXN_TYPES }).notNull(),
    /** Always >= 0; split: shares added as reported (informational), may be null. */
    quantity: fixed8("quantity"),
    /** Per share. */
    price: fixed8("price"),
    /** Signed cash effect. */
    amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
    /** Commission, >= 0; included in a buy's basis, deducted from a sell's proceeds. */
    feeCents: bigint("fee_cents", { mode: "bigint" }).notNull().default(sql`0`),
    /** Split ratio new:old (2:1 -> 2,1; reverse 1:10 -> 1,10). */
    splitNum: integer("split_num"),
    splitDen: integer("split_den"),
    /** Required for `transfer`. */
    transferDirection: text("transfer_direction", { enum: TRANSFER_DIRECTIONS }),
    /** The other own account of a transfer. */
    counterpartyAccountId: uuid("counterparty_account_id").references(() => account.id, { onDelete: "set null" }),
    /** Shared by the two legs of an own-account transfer. */
    transferGroupId: uuid("transfer_group_id"),
    /** Basis carried in on a transfer in from outside. */
    costBasisCents: bigint("cost_basis_cents", { mode: "bigint" }),
    /** Original acquisition date for that lot (transfer in). */
    acquiredDate: date("acquired_date"),
    /** The ledger cash row this activity is linked to, so cash is never counted twice. */
    ledgerTransactionId: uuid("ledger_transaction_id").references(() => transaction.id, { onDelete: "set null" }),
    /** `csvid:...` / `inv:...`; null for manual rows. */
    externalId: text("external_id"),
    source: text("source", { enum: INVESTMENT_TXN_SOURCES }).notNull(),
    importLogId: uuid("import_log_id").references(() => importLog.id, { onDelete: "set null" }),
    /** The file's action + description, sanitized <= 500. */
    rawDescription: text("raw_description"),
    /** User-owned. */
    memo: text("memo"),
    /** Set by any edit of a source-owned column on an imported row. */
    userEdited: boolean("user_edited").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** Nulls are distinct, so manual rows never collide. */
    uniqueIndex("investment_txn_account_external_idx").on(t.accountId, t.externalId),
    index("investment_txn_account_security_date_idx").on(t.accountId, t.securityId, t.date, t.sequence),
    index("investment_txn_security_date_idx").on(t.securityId, t.date),
    index("investment_txn_transfer_group_idx").on(t.transferGroupId),
    /** One ledger row per investment row. */
    uniqueIndex("investment_txn_ledger_idx").on(t.ledgerTransactionId).where(sql`"ledger_transaction_id" IS NOT NULL`),
    index("investment_txn_date_idx").on(t.date),
    index("investment_txn_account_type_date_idx").on(t.accountId, t.type, t.date),
    check("itx_quantity_nonneg", sql`"quantity" IS NULL OR "quantity" >= 0`),
    check("itx_price_nonneg", sql`"price" IS NULL OR "price" >= 0`),
    check("itx_fee_nonneg", sql`"fee_cents" >= 0`),
    check("itx_buy", sql`"type" <> 'buy' OR ("security_id" IS NOT NULL AND "quantity" > 0 AND "amount_cents" <= 0)`),
    check("itx_sell", sql`"type" <> 'sell' OR ("security_id" IS NOT NULL AND "quantity" > 0 AND "amount_cents" >= 0)`),
    check("itx_reinvest", sql`"type" <> 'reinvest' OR ("security_id" IS NOT NULL AND "quantity" > 0 AND "amount_cents" <= 0)`),
    check("itx_fee", sql`"type" <> 'fee' OR "amount_cents" <= 0`),
    check(
      "itx_split",
      sql`(("type" = 'split') = ("split_num" IS NOT NULL)) AND (("type" = 'split') = ("split_den" IS NOT NULL)) AND ("type" <> 'split' OR ("security_id" IS NOT NULL AND "split_num" > 0 AND "split_den" > 0 AND "amount_cents" = 0))`,
    ),
    check(
      "itx_transfer",
      sql`(("type" = 'transfer') = ("transfer_direction" IS NOT NULL)) AND ("type" <> 'transfer' OR (("security_id" IS NOT NULL AND "amount_cents" = 0 AND "quantity" > 0) OR ("security_id" IS NULL AND "amount_cents" <> 0 AND (("transfer_direction" = 'in') = ("amount_cents" > 0)))))`,
    ),
    check(
      "itx_basis_only_in",
      sql`("cost_basis_cents" IS NULL AND "acquired_date" IS NULL) OR ("type" = 'transfer' AND "transfer_direction" = 'in' AND "security_id" IS NOT NULL)`,
    ),
  ],
);

/**
 * Derived cache, rebuilt per account inside the writing transaction (`rebuildLots`). The uuid
 * is kept stable by upsert on (opened_by_txn_id, ordinal); a transfer-in leg gets one lot per
 * source lot (ordinals 0..n-1, `origin_lot_id`). Unknown basis is `basis_known = false` with 0.
 */
export const lot = pgTable(
  "lot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id, { onDelete: "cascade" }),
    securityId: uuid("security_id")
      .notNull()
      .references(() => security.id, { onDelete: "cascade" }),
    /** The buy / reinvest / transfer-in row. */
    openedByTxnId: uuid("opened_by_txn_id")
      .notNull()
      .references(() => investmentTxn.id, { onDelete: "cascade" }),
    ordinal: smallint("ordinal").notNull().default(0),
    /** Lineage across an own-account in-kind transfer. */
    originLotId: uuid("origin_lot_id").references((): AnyPgColumn => lot.id, { onDelete: "set null" }),
    openedBy: text("opened_by", { enum: LOT_OPENED_BY }).notNull(),
    /** Carried acquisition date for transfers in, else the opening date. */
    acquiredDate: date("acquired_date").notNull(),
    /** As opened (pre-split). */
    originalQuantity: fixed8("original_quantity").notNull(),
    /** Remaining, split-adjusted; 0 when closed. */
    quantity: fixed8("quantity").notNull(),
    originalCostBasisCents: bigint("original_cost_basis_cents", { mode: "bigint" }).notNull(),
    /** Remaining (conserved). */
    costBasisCents: bigint("cost_basis_cents", { mode: "bigint" }).notNull(),
    basisKnown: boolean("basis_known").notNull().default(true),
    closedDate: date("closed_date"),
    rebuiltAt: timestamp("rebuilt_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lot_opened_by_ordinal_idx").on(t.openedByTxnId, t.ordinal),
    index("lot_account_security_idx").on(t.accountId, t.securityId, t.closedDate),
    index("lot_account_open_idx").on(t.accountId).where(sql`"quantity" > 0`),
    check("lot_original_quantity_pos", sql`"original_quantity" > 0`),
    check("lot_quantity_nonneg", sql`"quantity" >= 0`),
    check("lot_original_basis_nonneg", sql`"original_cost_basis_cents" >= 0`),
    check("lot_basis_nonneg", sql`"cost_basis_cents" >= 0`),
  ],
);

/** Specific identification: the lots a sell (or transfer out) consumes. Sum of picks <= the sale; FIFO covers the remainder. */
export const lotPick = pgTable(
  "lot_pick",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** A sell or a transfer-out. */
    sellTxnId: uuid("sell_txn_id")
      .notNull()
      .references(() => investmentTxn.id, { onDelete: "cascade" }),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => lot.id, { onDelete: "cascade" }),
    quantity: fixed8("quantity").notNull(),
    /** Consumption order. */
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lot_pick_sell_lot_idx").on(t.sellTxnId, t.lotId),
    index("lot_pick_lot_idx").on(t.lotId),
    check("lot_pick_quantity_pos", sql`"quantity" > 0`),
  ],
);

/** Derived with the lots: one row per (closing transaction, lot); `unmatched_sell` rows have no lot. Realized gains read from here. */
export const lotDisposal = pgTable(
  "lot_disposal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id, { onDelete: "cascade" }),
    securityId: uuid("security_id")
      .notNull()
      .references(() => security.id, { onDelete: "cascade" }),
    /** The sell / transfer-out. */
    closeTxnId: uuid("close_txn_id")
      .notNull()
      .references(() => investmentTxn.id, { onDelete: "cascade" }),
    /** Null for `unmatched_sell`. */
    lotId: uuid("lot_id").references(() => lot.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: DISPOSAL_KINDS }).notNull(),
    date: date("date").notNull(),
    /** Null when unmatched. */
    acquiredDate: date("acquired_date"),
    quantity: fixed8("quantity").notNull(),
    /** This lot's share of the net proceeds (largest remainder); 0 for `transfer_out`. */
    proceedsCents: bigint("proceeds_cents", { mode: "bigint" }).notNull(),
    basisCents: bigint("basis_cents", { mode: "bigint" }).notNull(),
    /** proceeds - basis; 0 for `transfer_out`. */
    gainCents: bigint("gain_cents", { mode: "bigint" }).notNull(),
    term: text("term", { enum: GAIN_TERMS }).notNull(),
    basisKnown: boolean("basis_known").notNull(),
    rebuiltAt: timestamp("rebuilt_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lot_disposal_close_lot_idx").on(t.closeTxnId, sql`COALESCE("lot_id", '00000000-0000-0000-0000-000000000000'::uuid)`),
    index("lot_disposal_account_date_idx").on(t.accountId, t.date),
    index("lot_disposal_lot_idx").on(t.lotId),
    check("lot_disposal_quantity_pos", sql`"quantity" > 0`),
  ],
);

/** Household allocation targets, replaced as a whole set (non-empty sets sum to 10 000 bp). Empty = no targets. */
export const allocationTarget = pgTable(
  "allocation_target",
  {
    assetClass: text("asset_class", { enum: ASSET_CLASSES }).primaryKey(),
    targetBp: integer("target_bp").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check("allocation_target_bp_range", sql`"target_bp" >= 0 AND "target_bp" <= 10000`)],
);

/** The gate's evidence: every reconcile attempt (failed and accepted) against a statement. Several rows per (account, date). */
export const accountReconciliation = pgTable(
  "account_reconciliation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id, { onDelete: "cascade" }),
    statementDate: date("statement_date").notNull(),
    statementTotalCents: bigint("statement_total_cents", { mode: "bigint" }).notNull(),
    /** Null = the app could not value the account that day. */
    appValueCents: bigint("app_value_cents", { mode: "bigint" }),
    appBasis: text("app_basis", { enum: VALUATION_BASES }).notNull(),
    appAsOf: date("app_as_of"),
    /** The account setting in force at preview time. */
    cashInference: text("cash_inference", { enum: CASH_INFERENCES }).notNull(),
    /** app - statement, pre-commit. */
    diffCents: bigint("diff_cents", { mode: "bigint" }),
    /** Latest balance_snapshot on/before the date, pre-commit. */
    balanceCents: bigint("balance_cents", { mode: "bigint" }),
    /** balance - statement. */
    balanceDiffCents: bigint("balance_diff_cents", { mode: "bigint" }),
    toleranceCents: bigint("tolerance_cents", { mode: "bigint" }).notNull().default(sql`100`),
    /** |diff| < tolerance. */
    reconciled: boolean("reconciled").notNull(),
    /** ReconcileRowView[] (cents and quantities as strings). */
    rows: jsonb("rows").$type<Record<string, unknown>[]>().notNull().default([]),
    accepted: boolean("accepted").notNull(),
    /** Set when accepted: the statement was written as a manual holding snapshot on this date. */
    holdingSnapshotDate: date("holding_snapshot_date"),
    note: text("note"),
    userId: uuid("user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("account_reconciliation_account_idx").on(t.accountId, t.statementDate, t.createdAt),
    check("account_reconciliation_app_basis_check", sql`"app_basis" IN ('snapshot', 'lots', 'positions', 'balance', 'none')`),
  ],
);
