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

export const TransactionSource = z.enum(["simplefin", "csv", "manual"]);
export type TransactionSource = z.infer<typeof TransactionSource>;

export const JobType = z.enum(["simplefin.claim", "simplefin.sync", "simplefin.balances", "rules.run", "recurring.detect", "plan.close_month"]);
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

export const AuditEntity = z.enum(["month_plan", "category", "category_group", "savings_goal", "recurring", "rule", "household_setting"]);
export type AuditEntity = z.infer<typeof AuditEntity>;

export const AuditAction = z.enum(["create", "update", "delete"]);
export type AuditAction = z.infer<typeof AuditAction>;

export const GoalStatus = z.enum(["active", "completed", "archived"]);
export type GoalStatus = z.infer<typeof GoalStatus>;
