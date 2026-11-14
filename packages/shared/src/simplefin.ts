import { z } from "zod";
import { addDays, unixToIsoDate, type IsoDate } from "./dates.js";
import { sanitizeText } from "./sanitize.js";

/**
 * SimpleFIN protocol v2 shapes. Schemas are lenient (`passthrough`, optional text may be
 * null, amounts may come as numbers, `holdings` and `extra` take any shape) so an extra or
 * odd field from the Bridge never breaks a sync, and `readSimplefinAccountSet` reads the
 * accounts and transactions one at a time, so one it cannot read is skipped and reported
 * without failing the rest. The raw payload is kept in `import_log` for re-processing.
 */

/**
 * Optional text the Bridge may send as `null` (or as anything else by mistake): a string is
 * kept, everything else reads as absent. The raw payload in `import_log` keeps what was sent.
 */
const OptionalText = z.unknown().transform((v): string | undefined => (typeof v === "string" ? v : undefined));
/** Text with a default: a string is kept, anything else reads as the default. */
const TextOr = (fallback: string) => z.unknown().transform((v): string => (typeof v === "string" ? v : fallback));
/**
 * A protocol numeric string ("-33293.43"). A Bridge that sends a JSON number is read through
 * the number's shortest round-trip form; whether it is a readable amount is decided where it
 * is turned into cents (`parseSimplefinAmount`), so one odd value never rejects its account.
 */
const NumericString = z.union([z.string(), z.number().finite()]).transform((v) => (typeof v === "number" ? String(v) : v));
/** Unix seconds from 1970 up to the end of 2199: what a date column and `unixToIsoDate` can hold. */
const MAX_UNIX_SECONDS = 7_258_118_399;
const UnixSeconds = z.number().finite().min(0).max(MAX_UNIX_SECONDS);
/** An optional timestamp: one out of range or of the wrong type reads as absent. */
const OptionalUnixSeconds = z.unknown().transform((v): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_UNIX_SECONDS ? v : undefined));
/** `extra` is free-form: a plain object is kept, anything else reads as absent. */
const ExtraObject = z
  .unknown()
  .transform((v): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined));

export const SimplefinOrganization = z
  .object({
    domain: OptionalText,
    "sfin-url": OptionalText,
    name: OptionalText,
    url: OptionalText,
    id: OptionalText,
  })
  .passthrough();

export const SimplefinTransaction = z
  .object({
    id: z.string().min(1),
    /** Unix seconds when it posted; 0 while pending. */
    posted: UnixSeconds,
    /** Numeric string, e.g. "-33293.43". */
    amount: NumericString,
    description: TextOr(""),
    payee: OptionalText,
    memo: OptionalText,
    /** Unix seconds when the transaction happened (protocol v2, optional). */
    transacted_at: OptionalUnixSeconds,
    pending: z.unknown().transform((v): boolean | undefined => (typeof v === "boolean" ? v : undefined)),
    extra: ExtraObject,
  })
  .passthrough();
export type SimplefinTransaction = z.infer<typeof SimplefinTransaction>;

/** An account without its transactions, which are read one at a time (`readSimplefinAccountSet`). */
const SimplefinAccountFields = z
  .object({
    org: z.unknown().transform((v): z.infer<typeof SimplefinOrganization> => {
      const parsed = SimplefinOrganization.safeParse(v ?? {});
      return parsed.success ? parsed.data : {};
    }),
    id: z.string().min(1),
    name: TextOr(""),
    currency: TextOr("USD"),
    balance: NumericString,
    "available-balance": z.unknown().transform((v): string | undefined => {
      const parsed = NumericString.safeParse(v);
      return parsed.success ? parsed.data : undefined;
    }),
    "balance-date": UnixSeconds,
    /** Any shape: the holdings parser decides what it can read (imports design §3.3 step 1). */
    holdings: z.unknown().optional(),
    extra: ExtraObject,
  })
  .passthrough();

export const SimplefinAccount = SimplefinAccountFields.extend({
  transactions: z
    .array(SimplefinTransaction)
    .nullish()
    .transform((v) => v ?? []),
});
export type SimplefinAccount = z.infer<typeof SimplefinAccount>;

/** Structured error entry. Known codes: con.auth, act.failed, act.missingdata. */
export const SimplefinError = z
  .object({
    code: z.unknown().transform((v): string => (typeof v === "string" && v.trim() ? v : "unknown")),
    msg: OptionalText,
    conn_id: OptionalText,
    account_id: OptionalText,
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

/** What `readSimplefinAccountSet` left out, as an entry for the connection (the shape of `ConnectionError`). */
export interface SimplefinReadProblem {
  code: "account.unreadable" | "transaction.unreadable";
  message: string;
  accountId?: string;
}

export interface SimplefinReadResult {
  /** The accounts and transactions that could be read; the errlist entries coerced (an entry without a code is `unknown`). */
  set: SimplefinAccountSet;
  /** One entry per account that was skipped, and one per account some of whose transactions were. */
  problems: SimplefinReadProblem[];
}

/** The body is not an account set at all (not an object, or `accounts` is not a list). */
export class SimplefinShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimplefinShapeError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** "balance-date: Required" for the first issue of a failed parse (our schema's words, never the value). */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "unknown";
  const path = issue.path.filter((p) => typeof p === "string").join(".");
  return sanitizeText(path ? `${path}: ${issue.message}` : issue.message, 80);
}

/**
 * Read a SimpleFIN response one entry at a time (protocol v2; Phase 1 plan: "a field mismatch
 * is recoverable"). An account that cannot be read is skipped and reported for itself, a
 * transaction that cannot be read is skipped and counted for its account, and every other
 * account is applied as usual; an `errlist` entry is never dropped (one without a code reads
 * as `unknown`). Only a body that is not an account set at all throws (`SimplefinShapeError`).
 * The input should already have gone through `jsonbSafe`, so that the ids read here are the
 * ones stored in the raw payload.
 */
export function readSimplefinAccountSet(raw: unknown): SimplefinReadResult {
  if (!isPlainObject(raw)) throw new SimplefinShapeError("the response is not an account set");
  const listOf = (key: "errors" | "errlist" | "accounts"): unknown[] => {
    const value = raw[key];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new SimplefinShapeError(`${key}: expected a list`);
    return value;
  };
  const errors = listOf("errors").flatMap((e) => (typeof e === "string" ? [e] : typeof e === "number" ? [String(e)] : []));
  const errlist = listOf("errlist").map((e): SimplefinError => {
    if (!isPlainObject(e)) return typeof e === "string" && e ? { code: "unknown", msg: e } : { code: "unknown" };
    const parsed = SimplefinError.parse(e);
    const out: SimplefinError = { ...parsed, code: parsed.code };
    for (const key of ["msg", "conn_id", "account_id"] as const) if (out[key] === undefined) delete out[key];
    return out;
  });
  const problems: SimplefinReadProblem[] = [];
  const accounts: SimplefinAccount[] = [];
  for (const entry of listOf("accounts")) {
    const id = isPlainObject(entry) && typeof entry["id"] === "string" && entry["id"] ? entry["id"] : undefined;
    const label = sanitizeText(isPlainObject(entry) && typeof entry["name"] === "string" ? entry["name"] : "", 100) || "Account";
    const fields = SimplefinAccountFields.safeParse(entry);
    if (!fields.success) {
      const problem: SimplefinReadProblem = { code: "account.unreadable", message: sanitizeText(`${label}: the account could not be read and was skipped (${firstIssue(fields.error)})`, 300) };
      if (id) problem.accountId = sanitizeText(id, 100);
      problems.push(problem);
      continue;
    }
    const list = (entry as Record<string, unknown>)["transactions"];
    const transactions: SimplefinTransaction[] = [];
    const reasons: string[] = [];
    let skipped = 0;
    const items = Array.isArray(list) ? list : list === undefined || list === null ? [] : [list];
    if (!Array.isArray(list) && items.length > 0) {
      skipped++;
      reasons.push("transactions: expected a list");
    } else {
      for (const item of items) {
        const parsed = SimplefinTransaction.safeParse(item);
        if (parsed.success) {
          transactions.push(parsed.data);
        } else {
          skipped++;
          const reason = firstIssue(parsed.error);
          if (!reasons.includes(reason) && reasons.length < 3) reasons.push(reason);
        }
      }
    }
    const name = sanitizeText(fields.data.name, 100) || "Account";
    if (skipped > 0) {
      problems.push({
        code: "transaction.unreadable",
        message: sanitizeText(`${name}: ${skipped} transaction${skipped === 1 ? "" : "s"} could not be read and ${skipped === 1 ? "was" : "were"} skipped (${reasons.join("; ")})`, 300),
        accountId: sanitizeText(fields.data.id, 100),
      });
    }
    accounts.push({ ...fields.data, transactions });
  }
  return { set: { ...raw, errors, errlist, accounts }, problems };
}

const NOT_JSONB_SAFE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * A copy of a parsed JSON value that Postgres `jsonb` accepts: every NUL character and every
 * unpaired surrogate in a string or a key becomes U+FFFD (jsonb refuses `\u0000` and lone
 * surrogate escapes, so one such character in a bank's text failed the whole sync). Iterative,
 * so a deeply nested body cannot exhaust the stack.
 */
export function jsonbSafe(value: unknown): unknown {
  const clean = (s: string): string => s.replace(NOT_JSONB_SAFE, "\uFFFD");
  const stack: Array<{ from: unknown; into: unknown[] | Record<string, unknown> }> = [];
  const shell = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const into: unknown[] = new Array<unknown>(v.length);
      stack.push({ from: v, into });
      return into;
    }
    if (typeof v === "object" && v !== null) {
      const into: Record<string, unknown> = {};
      stack.push({ from: v, into });
      return into;
    }
    return typeof v === "string" ? clean(v) : v;
  };
  const result = shell(value);
  while (stack.length > 0) {
    const { from, into } = stack.pop()!;
    if (Array.isArray(into)) {
      const list = from as unknown[];
      for (let i = 0; i < list.length; i++) into[i] = shell(list[i]);
    } else {
      for (const [key, v] of Object.entries(from as Record<string, unknown>)) into[clean(key)] = shell(v);
    }
  }
  return result;
}

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

export interface SimplefinFeedHealthOptions {
  /**
   * The Bridge ids of the accounts the household closed. An account problem naming one of
   * them does not make the response incomplete: a closed account holds no window for the
   * open ones (as for the stale-copy check, audit decision 24).
   */
  closedAccountIds?: readonly string[];
}

export function simplefinFeedHealth(errlist: readonly SimplefinError[], options: SimplefinFeedHealthOptions = {}): SimplefinFeedHealth {
  const problems = errlist.filter((e) => /^(con|act)\./.test(e.code));
  const closed = new Set(options.closedAccountIds ?? []);
  return {
    incomplete: problems.some((e) => !(e.code.startsWith("act.") && e.account_id !== undefined && closed.has(e.account_id))),
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

export interface BalancesMarkInput {
  /** The mark before the refresh. */
  previous: IsoDate | null;
  today: IsoDate;
  /** Accounts the refresh saw for the first time, or attached to this connection again. */
  accountsCreated: number;
  config: SyncWindowConfig;
}

/**
 * The high-water mark after a Balances only refresh (audit a3-sync-core, second round). The
 * refresh asks for no transactions, so it never moves the mark. But an account it is the first
 * to see (new at the Bridge, or attached again after its connection was removed) is on the
 * connection from now on without any of its history, and the next full sync would not count it
 * as new: the mark is cleared, as after a full sync whose window was short, so that sync asks
 * for the first-sync window. When the next sync asks for that window anyway (the mark is older
 * than the window can reach), the mark stays, so the days it leaves out are still reported.
 */
export function highWaterMarkAfterBalances(input: BalancesMarkInput): IsoDate | null {
  if (input.accountsCreated === 0 || input.previous === null) return input.previous;
  const earliest = addDays(input.today, -input.config.initialWindowDays);
  return syncWindowStart(input.previous, input.today, input.config) > earliest ? null : input.previous;
}

/**
 * The days a sync's window left out (audit decision 25, a3-sync-core second round): from the
 * start of the window an ordinary sync would have asked for, `overlapDays` before the mark (the
 * mark day was only seen up to the hour of that sync, items post late, and the stale-copy rule
 * lets an account be up to `overlapDays` behind it), to the day before the window this sync
 * asked for. Null when the window reaches that far (always, unless the first-sync cap cut it)
 * or there is no mark.
 */
export function syncGapRange(previous: IsoDate | null, windowStart: IsoDate, config: SyncWindowConfig): { from: IsoDate; to: IsoDate } | null {
  if (previous === null) return null;
  const from = addDays(previous, -config.overlapDays);
  const to = addDays(windowStart, -1);
  return from > to ? null : { from, to };
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

/**
 * Calendar date for a transaction: when it happened (`transacted_at`), else when it posted,
 * else `fallback`, the household's day (Phase 2 plan decision 16), for a pending item that
 * carries neither. Timestamps are read as UTC dates, as the Bridge dates them.
 */
export function simplefinTransactionDate(t: Pick<SimplefinTransaction, "posted" | "transacted_at">, fallback: IsoDate): IsoDate {
  if (t.transacted_at && t.transacted_at > 0) return unixToIsoDate(t.transacted_at);
  if (t.posted && t.posted > 0) return unixToIsoDate(t.posted);
  return fallback;
}

/** An amount read from the feed: integer cents, and whether non-zero digits below a cent were dropped. */
export interface SimplefinAmount {
  cents: bigint;
  rounded: boolean;
}

/** The most digits of cents a feed amount may have: about ten trillion dollars, as for amounts sent to the API (audit decision 9). */
export const SIMPLEFIN_MAX_CENTS_DIGITS = 15;
const NUMERIC_STRING = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * Read a protocol numeric string as cents: an optional sign, digits with a fraction of any
 * length, an optional exponent ("+5.00", "12.345", "1E+2", "-0.5e1"). Rounded half away from
 * zero to the cent, with `rounded` set when non-zero digits were dropped. Undefined for what
 * is not a number or has more than 15 digits of cents; never throws, never builds a huge number.
 */
export function parseSimplefinAmount(input: string): SimplefinAmount | undefined {
  const s = input.trim();
  if (s.length === 0 || s.length > 64) return undefined;
  const m = NUMERIC_STRING.exec(s);
  if (!m) return undefined;
  const [, sign, whole = "", frac = "", expText] = m;
  if (whole === "" && frac === "") return undefined;
  const digits = (whole + frac).replace(/^0+/, "");
  if (digits === "") return { cents: 0n, rounded: false };
  // value = digits × 10^(exponent − fraction length); in cents, two more.
  const scale = Number(expText ?? "0") - frac.length + 2;
  let cents: bigint;
  let rounded = false;
  if (scale >= 0) {
    if (digits.length + scale > SIMPLEFIN_MAX_CENTS_DIGITS) return undefined;
    cents = BigInt(digits) * 10n ** BigInt(scale);
  } else {
    const k = -scale;
    // Below a tenth of a cent: rounds to zero.
    if (k > digits.length) return { cents: 0n, rounded: true };
    const divisor = 10n ** BigInt(k);
    const n = BigInt(digits);
    const remainder = n % divisor;
    cents = n / divisor + (remainder * 2n >= divisor ? 1n : 0n);
    rounded = remainder !== 0n;
    if (cents.toString().length > SIMPLEFIN_MAX_CENTS_DIGITS) return undefined;
  }
  if (cents === 0n) return { cents: 0n, rounded };
  return { cents: sign === "-" ? -cents : cents, rounded };
}
