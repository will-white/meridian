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

export const JobType = z.enum(["simplefin.claim", "simplefin.sync", "simplefin.balances", "rules.run"]);
export type JobType = z.infer<typeof JobType>;

export const JobStatus = z.enum(["queued", "running", "done", "failed"]);
export type JobStatus = z.infer<typeof JobStatus>;
