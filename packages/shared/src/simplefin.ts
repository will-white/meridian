import { z } from "zod";
import { addDays, unixToIsoDate, type IsoDate } from "./dates.js";
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

/**
 * What a response's `errlist` says about how much of it can be trusted. A connection problem
 * (`con.*`: the bank needs re-authentication) or an account problem (`act.*`: the Bridge
 * could not read the account, or read only part of it) arrives with HTTP 200 and the
 * accounts' last known data, so the lists in such a response are not the whole truth: an
 * empty list is not "nothing happened" and a missing pending item has not vanished. Codes
 * outside those two families are notices and leave the data as it is.
 */
export interface SimplefinFeedHealth {
  /** Some account in the response may be stale or partial. */
  incomplete: boolean;
  /** Whether a reported problem covers this account. */
  affects(account: { id: string; conn_id?: unknown }): boolean;
}

export function simplefinFeedHealth(errlist: readonly SimplefinError[]): SimplefinFeedHealth {
  const problems = errlist.filter((e) => /^(con|act)\./.test(e.code));
  return {
    incomplete: problems.length > 0,
    affects: (account) =>
      problems.some((e) => {
        if (e.code.startsWith("act.") && e.account_id) return e.account_id === account.id;
        // A problem that names a bank connection covers its accounts; when either side does not say, the account may be one of them.
        if (e.conn_id && typeof account.conn_id === "string" && account.conn_id) return e.conn_id === account.conn_id;
        return true;
      }),
  };
}

export interface SyncWindowConfig {
  /** How far back the first sync (and a full resync) asks, and the most any sync asks. */
  initialWindowDays: number;
  /** How far before the high-water mark the next window starts, so late-posting items are seen. */
  overlapDays: number;
}

/**
 * The start of the window a sync requests: `overlapDays` before the high-water mark, or
 * `initialWindowDays` back when there is no mark (the first sync, a full resync). Never
 * further back than the first-sync window: the mark does not move while a bank is
 * unreadable, and without the cap an account that stays broken would make every sync ask
 * for a little more, for ever.
 */
export function syncWindowStart(syncedThrough: IsoDate | null, today: IsoDate, config: SyncWindowConfig): IsoDate {
  const earliest = addDays(today, -config.initialWindowDays);
  if (!syncedThrough) return earliest;
  const start = addDays(syncedThrough, -config.overlapDays);
  return start < earliest ? earliest : start;
}

export interface HighWaterMarkInput {
  /** The mark before this sync (null: never complete). */
  previous: IsoDate | null;
  today: IsoDate;
  /** The start of the window this sync requested. */
  windowStart: IsoDate;
  /** `simplefinFeedHealth(...).incomplete` for the response. */
  incomplete: boolean;
  /** Accounts this sync saw for the first time. */
  accountsCreated: number;
  /** The balance date of every open account in the response (how fresh the Bridge's copy of it is). */
  balanceDates: readonly IsoDate[];
  config: SyncWindowConfig;
}

/**
 * The connection's high-water mark after a full sync that was applied: the day through which
 * every account's transactions are known to be complete. The next window starts `overlapDays`
 * before it, so it may only move when the response really was complete:
 *
 * - it stays put while the Bridge reports a connection or account problem;
 * - it stays put while an account's data is older than the overlap can cover (the Bridge is
 *   serving a stale copy without saying so). An account silent for longer than the first-sync
 *   window is dormant and does not hold the others back;
 * - it is cleared when an account appears that this window did not reach back the first-sync
 *   distance for, so the next sync asks for that account's history;
 * - otherwise it is today.
 */
export function highWaterMarkAfterSync(input: HighWaterMarkInput): IsoDate | null {
  const { today, config } = input;
  const earliest = addDays(today, -config.initialWindowDays);
  if (input.accountsCreated > 0 && input.windowStart > earliest) return null;
  if (input.incomplete) return input.previous;
  const coveredFrom = addDays(today, -config.overlapDays);
  if (input.balanceDates.some((d) => d < coveredFrom && d >= earliest)) return input.previous;
  return today;
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
