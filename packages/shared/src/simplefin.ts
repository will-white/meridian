import { z } from "zod";
import { unixToIsoDate, type IsoDate } from "./dates.js";
import { parseDecimalToCents } from "./money.js";
import { sanitizeText } from "./sanitize.js";

/**
 * SimpleFIN protocol v2 shapes. Schemas are lenient (`passthrough`) so an extra
 * field from the Bridge never breaks a sync; the raw payload is kept in
 * `import_log` for re-processing anyway.
 */

export const SimplefinOrganization = z
  .object({
    domain: z.string().optional(),
    "sfin-url": z.string().optional(),
    name: z.string().optional(),
    url: z.string().optional(),
    id: z.string().optional(),
  })
  .passthrough();

export const SimplefinTransaction = z
  .object({
    id: z.string().min(1),
    /** Unix seconds. 0 for pending items at some banks. */
    posted: z.number(),
    /** Decimal string, e.g. "-33293.43". */
    amount: z.string(),
    description: z.string().default(""),
    payee: z.string().optional(),
    memo: z.string().optional(),
    transaction_date: z.number().optional(),
    pending: z.boolean().optional(),
    extra: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type SimplefinTransaction = z.infer<typeof SimplefinTransaction>;

export const SimplefinAccount = z
  .object({
    org: SimplefinOrganization,
    id: z.string().min(1),
    name: z.string().default(""),
    currency: z.string().default("USD"),
    balance: z.string(),
    "available-balance": z.string().optional(),
    "balance-date": z.number(),
    transactions: z.array(SimplefinTransaction).default([]),
    holdings: z.array(z.record(z.unknown())).optional(),
    extra: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type SimplefinAccount = z.infer<typeof SimplefinAccount>;

/** Structured error entry. Known codes: con.auth, act.failed, act.missingdata. */
export const SimplefinError = z
  .object({
    code: z.string(),
    msg: z.string().optional(),
    conn_id: z.string().optional(),
    account_id: z.string().optional(),
  })
  .passthrough();
export type SimplefinError = z.infer<typeof SimplefinError>;

export const SimplefinAccountSet = z
  .object({
    errors: z.array(z.string()).default([]),
    errlist: z.array(SimplefinError).default([]),
    accounts: z.array(SimplefinAccount).default([]),
  })
  .passthrough();
export type SimplefinAccountSet = z.infer<typeof SimplefinAccountSet>;

export const SIMPLEFIN_ERROR_CODES = {
  "con.auth": "The bank connection needs to be re-authenticated at the SimpleFIN Bridge.",
  "act.failed": "The Bridge could not read this account. It will retry on the next sync.",
  "act.missingdata": "The Bridge returned incomplete data for this account. It will retry on the next sync.",
} as const;

export function describeSimplefinError(err: SimplefinError): string {
  const known = (SIMPLEFIN_ERROR_CODES as Record<string, string>)[err.code];
  const msg = sanitizeText(err.msg, 300);
  if (known) return msg ? `${known} (${msg})` : known;
  return msg ? `${sanitizeText(err.code, 50)}: ${msg}` : sanitizeText(err.code, 50);
}

/** The setup token is the Base64 of the claim URL. It must be HTTPS. */
export function decodeSetupToken(token: string): string {
  const trimmed = token.trim();
  let url: string;
  try {
    url = atob(trimmed).trim();
  } catch {
    throw new Error("The setup token is not valid Base64");
  }
  if (!/^https:\/\//i.test(url)) throw new Error("The claim URL must use https");
  try {
    new URL(url);
  } catch {
    throw new Error("The setup token does not decode to a URL");
  }
  return url;
}

export interface AccessUrlParts {
  /** e.g. https://bridge.simplefin.org/simplefin */
  baseUrl: string;
  username: string;
  password: string;
}

/** Access URLs carry basic-auth credentials: https://user:pass@host/simplefin */
export function parseAccessUrl(accessUrl: string): AccessUrlParts {
  const u = new URL(accessUrl.trim());
  if (u.protocol !== "https:") throw new Error("The access URL must use https");
  const username = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  u.username = "";
  u.password = "";
  const baseUrl = u.toString().replace(/\/$/, "");
  return { baseUrl, username, password };
}

/** Calendar date for a transaction: transaction_date when present, else posted, else today. */
export function simplefinTransactionDate(t: Pick<SimplefinTransaction, "posted" | "transaction_date">, now = new Date()): IsoDate {
  if (t.transaction_date && t.transaction_date > 0) return unixToIsoDate(t.transaction_date);
  if (t.posted && t.posted > 0) return unixToIsoDate(t.posted);
  return now.toISOString().slice(0, 10);
}

export function simplefinAmountCents(amount: string): bigint {
  return parseDecimalToCents(amount);
}
