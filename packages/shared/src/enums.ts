import { z } from "zod";

/** Account types. Drives default tax treatment and which views an account appears in. */
export const AccountType = z.enum([
  "checking",
  "savings",
  "credit",
  "loan",
  "brokerage",
  "401k",
  "ira",
  "roth",
  "hsa",
  "529",
  "asset",
]);
export type AccountType = z.infer<typeof AccountType>;

/** Tax treatment is set from day one; the retirement planner depends on it. */
export const TaxTreatment = z.enum(["taxable", "pre_tax", "roth", "hsa", "none"]);
export type TaxTreatment = z.infer<typeof TaxTreatment>;

export const defaultTaxTreatment: Record<AccountType, TaxTreatment> = {
  checking: "none",
  savings: "none",
  credit: "none",
  loan: "none",
  brokerage: "taxable",
  "401k": "pre_tax",
  ira: "pre_tax",
  roth: "roth",
  hsa: "hsa",
  "529": "none",
  asset: "none",
};

export const ConnectionType = z.enum(["simplefin", "csv", "manual"]);
export type ConnectionType = z.infer<typeof ConnectionType>;

/** Spending-plan buckets (Simplifi-style). Every category belongs to exactly one. */
export const Bucket = z.enum(["income", "bills", "savings", "spending"]);
export type Bucket = z.infer<typeof Bucket>;

export const ConnectionStatus = z.enum(["ok", "claiming", "auth_required", "error", "disabled"]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

export const TransactionSource = z.enum(["simplefin", "csv", "manual", "investment"]);
export type TransactionSource = z.infer<typeof TransactionSource>;

export const JobType = z.enum([
  "simplefin.claim",
  "simplefin.sync",
  "simplefin.balances",
  "rules.run",
  "recurring.detect",
  "plan.close_month",
  "simplefin.reprocess_holdings",
  "prices.fetch",
  "investments.valuation",
  "investments.income_feed",
]);
export type JobType = z.infer<typeof JobType>;

export const JobStatus = z.enum(["queued", "running", "done", "failed"]);
export type JobStatus = z.infer<typeof JobStatus>;

// ---- Phase 2 ----

export const RolloverMode = z.enum(["none", "surplus", "all"]);
export type RolloverMode = z.infer<typeof RolloverMode>;

export const PlannedSource = z.enum(["manual", "average", "recurring", "goal", "none"]);
export type PlannedSource = z.infer<typeof PlannedSource>;

export const Cadence = z.enum(["weekly", "biweekly", "twice_monthly", "monthly", "bimonthly", "quarterly", "semiannual", "yearly"]);
export type Cadence = z.infer<typeof Cadence>;

export const RecurringStatus = z.enum(["suggested", "active", "paused", "cancelled", "dismissed"]);
export type RecurringStatus = z.infer<typeof RecurringStatus>;

export const RecurringSource = z.enum(["detected", "manual"]);
export type RecurringSource = z.infer<typeof RecurringSource>;

export const AmountMode = z.enum(["fixed", "variable"]);
export type AmountMode = z.infer<typeof AmountMode>;

export const AlertKind = z.enum(["price_increase", "new_recurring", "missed_charge", "trial_converted"]);
export type AlertKind = z.infer<typeof AlertKind>;

export const AuditEntity = z.enum([
  "month_plan",
  "category",
  "category_group",
  "savings_goal",
  "recurring",
  "rule",
  "household_setting",
  "security",
  "investment_txn",
  "holding_snapshot",
  "allocation_target",
  "lot_pick",
  "account_reconciliation",
  "account",
]);
export type AuditEntity = z.infer<typeof AuditEntity>;

export const AuditAction = z.enum(["create", "update", "delete"]);
export type AuditAction = z.infer<typeof AuditAction>;

export const GoalStatus = z.enum(["active", "completed", "archived"]);
export type GoalStatus = z.infer<typeof GoalStatus>;

// ---- Phase 3: investments ----
// This file is the single source for every Phase 3 enum; Drizzle text columns mirror these lists.

/** `import_log.kind`. The Phase 1 kinds plus the Phase 3 import and fetch records. */
export const ImportLogKind = z.enum([
  "simplefin.claim",
  "simplefin.sync",
  "simplefin.balances",
  "csv",
  "csv.positions",
  "csv.trades",
  "simplefin.reprocess",
  "prices.fetch",
]);
export type ImportLogKind = z.infer<typeof ImportLogKind>;

/** Account types that hold securities; the only types with a derived fidelity and an investments block. */
export const INVESTMENT_ACCOUNT_TYPES = ["brokerage", "401k", "ira", "roth", "hsa", "529"] as const satisfies readonly AccountType[];
export type InvestmentAccountType = (typeof INVESTMENT_ACCOUNT_TYPES)[number];
export function isInvestmentAccountType(type: AccountType): type is InvestmentAccountType {
  return (INVESTMENT_ACCOUNT_TYPES as readonly AccountType[]).includes(type);
}

export const SecurityType = z.enum(["stock", "etf", "fund", "bond", "cash", "cd", "other"]);
export type SecurityType = z.infer<typeof SecurityType>;

export const AssetClass = z.enum(["us_stock", "intl_stock", "bonds", "cash", "real_estate", "other"]);
export type AssetClass = z.infer<typeof AssetClass>;

/** `price.source` and `security.price_mode`. Precedence manual > provider > implied. */
export const PriceSource = z.enum(["provider", "implied", "manual"]);
export type PriceSource = z.infer<typeof PriceSource>;

/** `holding_snapshot.source`. Precedence manual > csv > simplefin (balance rows alike). */
export const HoldingSource = z.enum(["simplefin", "csv", "manual"]);
export type HoldingSource = z.infer<typeof HoldingSource>;

export const InvestmentTxnType = z.enum(["buy", "sell", "dividend", "interest", "reinvest", "fee", "split", "transfer"]);
export type InvestmentTxnType = z.infer<typeof InvestmentTxnType>;

/** Only `csv` and `manual` are written in Phase 3; `simplefin` and `ofx` are reserved. */
export const InvestmentTxnSource = z.enum(["csv", "manual", "simplefin", "ofx"]);
export type InvestmentTxnSource = z.infer<typeof InvestmentTxnSource>;

export const TransferDirection = z.enum(["in", "out"]);
export type TransferDirection = z.infer<typeof TransferDirection>;

export const LotMethod = z.enum(["fifo", "specific"]);
export type LotMethod = z.infer<typeof LotMethod>;

export const LotOpenedBy = z.enum(["buy", "reinvest", "transfer_in"]);
export type LotOpenedBy = z.infer<typeof LotOpenedBy>;

export const GainTerm = z.enum(["short", "long", "unknown", "none"]);
export type GainTerm = z.infer<typeof GainTerm>;

export const DisposalKind = z.enum(["sell", "transfer_out", "unmatched_sell"]);
export type DisposalKind = z.infer<typeof DisposalKind>;

/** Derived, never stored. `null` for non-investment account types (there is no `none` member). */
export const InvestmentFidelity = z.enum(["balance_only", "positions", "full_history"]);
export type InvestmentFidelity = z.infer<typeof InvestmentFidelity>;

export const CashInference = z.enum(["auto", "off"]);
export type CashInference = z.infer<typeof CashInference>;

export const InvestmentIncomeFeed = z.enum(["off", "link", "create"]);
export type InvestmentIncomeFeed = z.infer<typeof InvestmentIncomeFeed>;

/** `connection.csv_kind`: which mapper a CSV profile belongs to. */
export const CsvKind = z.enum(["bank", "positions", "trades"]);
export type CsvKind = z.infer<typeof CsvKind>;

/** Which step of the valuation chain produced an account's value on a date. */
export const ValuationBasis = z.enum(["snapshot", "lots", "positions", "balance", "none"]);
export type ValuationBasis = z.infer<typeof ValuationBasis>;

/** Where a holding line's price came from. */
export const HoldingPriceSource = z.enum(["provider", "implied", "manual", "statement", "txn", "cash"]);
export type HoldingPriceSource = z.infer<typeof HoldingPriceSource>;

/** User-facing price freshness (the prices design's `fixed` is spelled `cash`). */
export const PriceStatus = z.enum(["statement", "current", "stale", "implied", "manual", "cash", "carried", "missing"]);
export type PriceStatus = z.infer<typeof PriceStatus>;

/** How a line's value was obtained within the valuation chain. */
export const ValueSource = z.enum(["statement", "priced", "carried", "unpriced"]);
export type ValueSource = z.infer<typeof ValueSource>;

export const LineKind = z.enum(["position", "cash", "cash_plug", "carried_flows"]);
export type LineKind = z.infer<typeof LineKind>;

export const InvestmentPeriod = z.enum(["1w", "1m", "3m", "6m", "ytd", "1y", "3y", "5y", "all", "custom"]);
export type InvestmentPeriod = z.infer<typeof InvestmentPeriod>;

export const ReturnMethod = z.enum(["true_twr", "modified_dietz"]);
export type ReturnMethod = z.infer<typeof ReturnMethod>;

export const ExternalFlowKind = z.enum(["cash", "securities", "opening_value"]);
export type ExternalFlowKind = z.infer<typeof ExternalFlowKind>;

export const ExternalFlowSource = z.enum(["ledger", "investment_txn", "engine"]);
export type ExternalFlowSource = z.infer<typeof ExternalFlowSource>;

export const ReturnFailureReason = z.enum([
  "no_valuations",
  "zero_denominator",
  "negative_capital",
  "too_few_flows",
  "no_sign_change",
  "no_bracket",
  "no_benchmark_price",
]);
export type ReturnFailureReason = z.infer<typeof ReturnFailureReason>;

export const EngineWarningCode = z.enum([
  "bad_quantity",
  "buy_amount_sign",
  "amount_missing",
  "amount_mismatch",
  "basis_unknown",
  "needs_lot_pick",
  "pick_unavailable",
  "pick_exceeds_lot",
  "pick_exceeds_sale",
  "oversell",
  "cash_transfer_in_txns",
  "price_from_txn",
  "stale_price",
  "no_price",
  "securities_flow_unpriced",
  "valuation_carried",
  "flow_before_first_valuation",
  "position_mismatch",
  "zero_denominator",
  "negative_capital",
  "multiple_roots",
  "no_benchmark_price",
  "statement_mismatch",
  "no_valuations",
]);
export type EngineWarningCode = z.infer<typeof EngineWarningCode>;

export const PriceProviderId = z.enum(["tiingo"]);
export type PriceProviderId = z.infer<typeof PriceProviderId>;

/** `security.price_fetch_status`. */
export const PriceFetchStatus = z.enum(["ok", "not_found", "error", "rate_limited"]);
export type PriceFetchStatus = z.infer<typeof PriceFetchStatus>;

export const ReconcileRowStatus = z.enum([
  "match",
  "quantity",
  "price",
  "value",
  "cash",
  "missing_in_app",
  "missing_in_statement",
  "unknown_ticker",
]);
export type ReconcileRowStatus = z.infer<typeof ReconcileRowStatus>;
