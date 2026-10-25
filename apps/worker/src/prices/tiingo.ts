import { mapSymbol, parseTiingoCsv, PROVIDER_BODY_LIMIT, type IsoDate, type PriceProvider, type PriceProviderId, type ProviderResult } from "@meridian/shared";

/**
 * Tiingo end-of-day adapter (prices design §3.12). One GET per symbol and date range, CSV
 * requested so a close such as `310.02` stays decimal text and never passes through a JS
 * float; HTTPS only with certificate verification left at Node's default (on); no retries
 * here (`fetchWithRetries` in provider.ts). The API key travels in the `Authorization`
 * header and never in the URL or a log line.
 */

export const TIINGO_BASE_URL = "https://api.tiingo.com/tiingo/daily";
const DEFAULT_UA = "Meridian/0.1 (self-hosted personal finance; read-only)";

export interface TiingoOptions {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
  baseUrl?: string;
}

/** `Retry-After` in ms: delta seconds, or an HTTP date relative to `now`; undefined when absent or unreadable. */
export function parseRetryAfter(header: string | null, now: Date = new Date()): number | undefined {
  if (!header) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now.getTime());
}

/** A JSON error body naming an unknown ticker (`{"detail": "Error: Ticker 'ZZZZ' not found"}`), which Tiingo may send with a 404 or a 200/400. */
export function bodyNamesUnknownTicker(body: string): boolean {
  const text = body.trim();
  if (!text.startsWith("{")) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return false;
    const detail = (parsed as { detail?: unknown }).detail;
    return typeof detail === "string" && /not found|unknown ticker|no ticker|does not exist|invalid ticker/i.test(detail);
  } catch {
    return false;
  }
}

export class TiingoProvider implements PriceProvider {
  readonly id: PriceProviderId = "tiingo";
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: TiingoOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.userAgent = options.userAgent ?? DEFAULT_UA;
    this.baseUrl = (options.baseUrl ?? TIINGO_BASE_URL).replace(/\/$/, "");
  }

  mapSymbol(security: { ticker: string; providerSymbol: string | null }): string {
    return mapSymbol(security);
  }

  /** The request URL for a symbol and range (exported for the suites; the key is never part of it). */
  urlFor(symbol: string, range: { from: IsoDate; to: IsoDate }): string {
    const url = new URL(`${this.baseUrl}/${encodeURIComponent(symbol)}/prices`);
    url.searchParams.set("startDate", range.from);
    url.searchParams.set("endDate", range.to);
    url.searchParams.set("format", "csv");
    url.searchParams.set("resampleFreq", "daily");
    return url.toString();
  }

  async fetchDaily(symbol: string, range: { from: IsoDate; to: IsoDate }): Promise<ProviderResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.urlFor(symbol, range), {
        method: "GET",
        headers: { Authorization: `Token ${this.apiKey}`, Accept: "text/csv", "User-Agent": this.userAgent },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, kind: "network", message: `tiingo: could not reach the price server: ${message}` };
    }

    let body: string;
    try {
      body = await res.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, kind: "network", message: `tiingo: response body could not be read: ${message}` };
    }

    if (res.status === 404 || bodyNamesUnknownTicker(body)) {
      return { ok: false, kind: "not_found", message: `tiingo: symbol ${symbol} not found`, status: res.status };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, kind: "auth", message: `tiingo: API key rejected (${res.status})`, status: res.status };
    }
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      return { ok: false, kind: "rate_limited", message: "tiingo: rate limited (429)", status: 429, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
    if (!res.ok) {
      return { ok: false, kind: "http", message: `tiingo: HTTP ${res.status}`, status: res.status, body: body.slice(0, PROVIDER_BODY_LIMIT) };
    }
    const parsed = parseTiingoCsv(body);
    if (!parsed.ok) return { ...parsed, message: `tiingo: ${parsed.message}`, status: res.status };
    return parsed;
  }
}
