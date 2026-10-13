import { decodeSetupToken, isoDateToUtcMs, parseAccessUrl, SimplefinAccountSet, type IsoDate } from "@meridian/shared";

/**
 * SimpleFIN protocol v2 client. HTTPS only (enforced when the URLs are parsed),
 * certificate verification left at Node's default (on), no retries here: the job
 * queue retries with backoff.
 */

export type SimplefinFailureKind = "claim_forbidden" | "forbidden" | "payment_required" | "http" | "network" | "invalid_response";

export class SimplefinError extends Error {
  constructor(
    public readonly kind: SimplefinFailureKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SimplefinError";
  }
  /** Retrying later cannot help for these. */
  get permanent(): boolean {
    return this.kind === "claim_forbidden" || this.kind === "forbidden" || this.kind === "payment_required";
  }
}

export interface ClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

const DEFAULT_UA = "Meridian/0.1 (self-hosted personal finance; read-only)";

function makeFetch(options: ClientOptions) {
  const f = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  return async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    } catch (err) {
      throw new SimplefinError("network", `Could not reach the SimpleFIN server: ${(err as Error).message}`);
    }
  };
}

/** Exchange a setup token for an Access URL. One-time: the Bridge refuses a second claim with 403. */
export async function claimAccessUrl(setupToken: string, options: ClientOptions = {}): Promise<string> {
  const claimUrl = decodeSetupToken(setupToken);
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
  const accessUrl = (await res.text()).trim();
  try {
    parseAccessUrl(accessUrl);
  } catch {
    throw new SimplefinError("invalid_response", "The Bridge returned something that is not an https access URL");
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
  /** The response exactly as received, for import_log. */
  raw: unknown;
  set: SimplefinAccountSet;
  status: number;
}

export async function fetchAccounts(accessUrl: string, query: FetchAccountsOptions = {}, options: ClientOptions = {}): Promise<FetchAccountsResult> {
  const { baseUrl, username, password } = parseAccessUrl(accessUrl);
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

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new SimplefinError("invalid_response", "SimpleFIN returned a response that is not JSON");
  }
  const parsed = SimplefinAccountSet.safeParse(raw);
  if (!parsed.success) throw new SimplefinError("invalid_response", `SimpleFIN response did not match protocol v2: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  return { raw, set: parsed.data, status: res.status };
}
