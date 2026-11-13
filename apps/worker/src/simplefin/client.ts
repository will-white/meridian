import { decodeSetupToken, isoDateToUtcMs, parseAccessUrl, readSimplefinAccountSet, sanitizeText, SimplefinShapeError, type IsoDate, type SimplefinReadResult } from "@meridian/shared";
import { describeFetchFailure } from "../fetchError.js";

/**
 * SimpleFIN protocol v2 client. HTTPS only (enforced when the URLs are parsed),
 * certificate verification left at Node's default (on), only the allowed hosts (the
 * Bridge's by default), bodies read up to a size limit, no retries here: the job queue
 * retries with backoff.
 */

export type SimplefinFailureKind =
  | "claim_forbidden"
  | "forbidden"
  | "payment_required"
  | "http"
  | "network"
  | "invalid_response"
  | "too_large"
  | "host_not_allowed"
  | "access_url_refused";

export class SimplefinError extends Error {
  /** What the server sent when it could not be read (a body that is not JSON), for the import log. */
  public readonly raw?: unknown;
  constructor(
    public readonly kind: SimplefinFailureKind,
    message: string,
    public readonly status?: number,
    raw?: unknown,
  ) {
    super(message);
    this.name = "SimplefinError";
    if (raw !== undefined) this.raw = raw;
  }
  /** Retrying this job cannot help: the same request gets the same answer. */
  get permanent(): boolean {
    return (
      this.kind === "claim_forbidden" ||
      this.kind === "forbidden" ||
      this.kind === "payment_required" ||
      this.kind === "too_large" ||
      this.kind === "host_not_allowed" ||
      this.kind === "access_url_refused"
    );
  }
  /** The Bridge refused the connection itself (403, 402): nothing is scheduled until a sync started by hand succeeds (audit decision 27). */
  get pausesSchedule(): boolean {
    return this.kind === "forbidden" || this.kind === "payment_required";
  }
}

/**
 * The SimpleFIN Bridge's hosts: where a setup token's claim URL and an access URL may point
 * unless `SIMPLEFIN_ALLOWED_HOSTS` says otherwise (spec, Security: outbound calls limited to
 * the SimpleFIN host and the price provider; audit a4-sync-parse-15).
 */
export const DEFAULT_SIMPLEFIN_HOSTS: readonly string[] = ["bridge.simplefin.org", "beta-bridge.simplefin.org"];
/** `SIMPLEFIN_MAX_RESPONSE_MB` default: far above a household's 93 days, far below what ends the worker. */
export const DEFAULT_MAX_RESPONSE_BYTES = 50_000_000;
/** An access URL is a line of text; a claim answer is read up to this much. */
const MAX_CLAIM_RESPONSE_BYTES = 65_536;

export interface ClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
  /** Hosts a claim URL and an access URL may name (lower case). Default `DEFAULT_SIMPLEFIN_HOSTS`. */
  allowedHosts?: readonly string[];
  /** The largest account-set response read, in bytes. Default `DEFAULT_MAX_RESPONSE_BYTES`. */
  maxResponseBytes?: number;
}

const DEFAULT_UA = "Meridian/0.1 (self-hosted personal finance; read-only)";

function makeFetch(options: ClientOptions) {
  const f = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  return async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    } catch (err) {
      // The reason (DNS, refused, certificate, timeout) and never the URL, which carries the credentials or the claim token.
      throw new SimplefinError("network", `Could not reach the SimpleFIN server: ${describeFetchFailure(err, { timeoutMs })}`);
    }
  };
}

/** Refuse a URL whose host the worker is not set up to call, before any request. */
function assertAllowedHost(url: string, options: ClientOptions, what: "setup token" | "access URL"): string {
  const host = new URL(url).hostname.toLowerCase();
  const allowed = (options.allowedHosts ?? DEFAULT_SIMPLEFIN_HOSTS).map((h) => h.toLowerCase());
  if (!allowed.includes(host)) {
    const list = allowed.length > 0 ? allowed.join(", ") : "none";
    throw new SimplefinError(
      "host_not_allowed",
      `The ${what} points at ${sanitizeText(host, 100)}, which is not a SimpleFIN host this server is set up to use (allowed: ${sanitizeText(list, 200)}). If you run your own SimpleFIN server, add its host to SIMPLEFIN_ALLOWED_HOSTS and restart the worker.`,
    );
  }
  return host;
}

/**
 * Read a body as text, at most `maxBytes` of it (audit a4-sync-parse-13). A body that is cut
 * off by the timeout or the connection is a network failure that says why (a4-sync-parse-14).
 */
async function readText(res: Response, maxBytes: number, timeoutMs: number): Promise<string> {
  const tooLarge = () =>
    new SimplefinError(
      "too_large",
      `The SimpleFIN response is larger than ${maxBytes / 1_000_000} MB, so it was not read. If your accounts really need more, raise SIMPLEFIN_MAX_RESPONSE_MB.`,
    );
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof SimplefinError) throw err;
    throw new SimplefinError("network", `Could not reach the SimpleFIN server: ${describeFetchFailure(err, { timeoutMs })}`);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Exchange a setup token for an Access URL. One-time: the Bridge refuses a second claim with 403. */
export async function claimAccessUrl(setupToken: string, options: ClientOptions = {}): Promise<string> {
  const claimUrl = decodeSetupToken(setupToken);
  const claimHost = assertAllowedHost(claimUrl, options, "setup token");
  const res = await makeFetch(options)(claimUrl, {
    method: "POST",
    headers: { "Content-Length": "0", "User-Agent": options.userAgent ?? DEFAULT_UA },
  });
  if (res.status === 403) {
    throw new SimplefinError(
      "claim_forbidden",
      "The SimpleFIN Bridge refused this setup token (403). If you did not already use it, the token may be compromised: revoke it at the Bridge and create a new one.",
      403,
    );
  }
  if (!res.ok) throw new SimplefinError("http", `Claim failed with HTTP ${res.status}`, res.status);
  const accessUrl = (await readText(res, MAX_CLAIM_RESPONSE_BYTES, options.timeoutMs ?? 60_000)).trim();
  let accessHost: string;
  try {
    parseAccessUrl(accessUrl);
    accessHost = new URL(accessUrl).hostname.toLowerCase();
  } catch {
    throw new SimplefinError("invalid_response", "The Bridge returned something that is not an https access URL");
  }
  // Every later sync goes where the access URL points: it must be the server the token named.
  if (accessHost !== claimHost) {
    throw new SimplefinError(
      "access_url_refused",
      `The Bridge answered the claim with an access URL on another host (${sanitizeText(accessHost, 100)}), so it was not stored. Create a new setup token at the Bridge and add the connection again.`,
    );
  }
  return accessUrl;
}

export interface FetchAccountsOptions {
  /** Inclusive start of the window, as a calendar date (UTC midnight). */
  startDate?: IsoDate;
  /** Exclusive end, calendar date. */
  endDate?: IsoDate;
  pending?: boolean;
  balancesOnly?: boolean;
  /** Restrict to these SimpleFIN account ids. */
  accounts?: readonly string[];
}

export interface FetchAccountsResult {
  /** The response exactly as received (parsed JSON), for import_log; read it with `readAccounts` once it is stored. */
  raw: unknown;
  status: number;
}

/**
 * GET /accounts. Returns the parsed JSON without judging its shape, so the caller stores it
 * before reading it (Phase 1 plan, sync step 2; audit a4-sync-parse-02); a body that is not
 * JSON fails with the text attached as `raw` (`{ notJson }`) for the same reason.
 */
export async function fetchAccounts(accessUrl: string, query: FetchAccountsOptions = {}, options: ClientOptions = {}): Promise<FetchAccountsResult> {
  const { baseUrl, username, password } = parseAccessUrl(accessUrl);
  assertAllowedHost(baseUrl, options, "access URL");
  const url = new URL(`${baseUrl}/accounts`);
  url.searchParams.set("version", "2");
  if (query.startDate) url.searchParams.set("start-date", String(Math.floor(isoDateToUtcMs(query.startDate) / 1000)));
  if (query.endDate) url.searchParams.set("end-date", String(Math.floor(isoDateToUtcMs(query.endDate) / 1000)));
  if (query.pending) url.searchParams.set("pending", "1");
  if (query.balancesOnly) url.searchParams.set("balances-only", "1");
  for (const id of query.accounts ?? []) url.searchParams.append("account", id);

  const auth = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  const res = await makeFetch(options)(url.toString(), {
    method: "GET",
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json", "User-Agent": options.userAgent ?? DEFAULT_UA },
  });
  if (res.status === 403) {
    throw new SimplefinError("forbidden", "SimpleFIN access was refused (403). The access URL may have been revoked; reconnect with a new setup token.", 403);
  }
  if (res.status === 402) {
    throw new SimplefinError("payment_required", "The SimpleFIN Bridge reports payment required (402). Check the Bridge subscription.", 402);
  }
  if (!res.ok) throw new SimplefinError("http", `SimpleFIN returned HTTP ${res.status}`, res.status);

  const text = await readText(res, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, options.timeoutMs ?? 60_000);
  try {
    return { raw: JSON.parse(text) as unknown, status: res.status };
  } catch {
    throw new SimplefinError("invalid_response", "SimpleFIN returned a response that is not JSON", res.status, { notJson: text });
  }
}

/**
 * Read a stored response entry by entry (`readSimplefinAccountSet`, audit a4-sync-parse-03):
 * an account or transaction it cannot read is skipped and reported; only a body that is not
 * an account set at all fails, as `invalid_response`.
 */
export function readAccounts(raw: unknown): SimplefinReadResult {
  try {
    return readSimplefinAccountSet(raw);
  } catch (err) {
    if (err instanceof SimplefinShapeError) throw new SimplefinError("invalid_response", `SimpleFIN response did not match protocol v2: ${err.message}`);
    throw err;
  }
}
