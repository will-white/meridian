import type { IsoDate, PriceProvider, ProviderResult } from "@meridian/shared";
import { priceConfigOf, type WorkerConfig } from "../env.js";
import { TiingoProvider } from "./tiingo.js";

/**
 * The price feed's worker-side seam (prices design §3.12; plan decision 10): one adapter per
 * `PRICE_PROVIDER`, the error the runner never retries, and the per-symbol retry loop the
 * fetch job runs. The adapter takes an injected `fetch` so the suites never touch the network.
 */

export type PriceFeedErrorKind = "not_configured" | "auth" | "network";

/** A whole-run failure. `permanent` stops the runner's retries (`not_configured`, `auth`); `network` is retried with the queue's backoff. */
export class PriceFeedError extends Error {
  constructor(
    public readonly kind: PriceFeedErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "PriceFeedError";
  }
  get permanent(): boolean {
    return this.kind === "not_configured" || this.kind === "auth";
  }
}

/** The configured adapter, or null when `PRICE_PROVIDER=none`. A tiingo provider without a key is refused at boot by `loadConfig`. */
export function createPriceProvider(config: Pick<WorkerConfig, "prices">, fetchImpl?: typeof fetch): PriceProvider | null {
  const prices = priceConfigOf(config);
  if (prices.provider === null) return null;
  if (!prices.tiingoApiKey) throw new PriceFeedError("not_configured", "PRICE_PROVIDER=tiingo needs TIINGO_API_KEY (or TIINGO_API_KEY_FILE)");
  return new TiingoProvider({ apiKey: prices.tiingoApiKey, timeoutMs: prices.timeoutMs, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

export const MAX_ATTEMPTS_PER_SYMBOL = 3;
export const RETRY_AFTER_CAP_MS = 120_000;
export const RETRY_AFTER_DEFAULT_MS = 5_000;
/** After an `http` or `network` failure: 5 s after the first attempt, 15 s after the second. */
export const RETRY_BACKOFF_MS: readonly number[] = [5_000, 15_000];

export interface FetchWithRetriesResult {
  result: ProviderResult;
  /** Every attempt counts as a request in the run's stats. */
  attempts: number;
  /** The pauses taken between attempts, in ms (for the suites). */
  sleeps: number[];
}

export type Sleep = (ms: number) => Promise<void>;

/**
 * Up to three attempts per symbol: after `rate_limited` sleep `min(Retry-After ?? 5 s, 120 s)`;
 * after `http` or `network` sleep 5 s then 15 s; `not_found`, `auth` and `invalid_response`
 * come back at once. The last failure is returned when every attempt failed.
 */
export async function fetchWithRetries(
  provider: PriceProvider,
  symbol: string,
  range: { from: IsoDate; to: IsoDate },
  opts: { sleep: Sleep; maxAttempts?: number },
): Promise<FetchWithRetriesResult> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS_PER_SYMBOL;
  const sleeps: number[] = [];
  let attempts = 0;
  let last: ProviderResult = { ok: false, kind: "network", message: "no attempt made" };
  while (attempts < maxAttempts) {
    attempts++;
    last = await provider.fetchDaily(symbol, range);
    if (last.ok || last.kind === "not_found" || last.kind === "auth" || last.kind === "invalid_response") break;
    if (attempts >= maxAttempts) break;
    const pause = last.kind === "rate_limited" ? Math.min(last.retryAfterMs ?? RETRY_AFTER_DEFAULT_MS, RETRY_AFTER_CAP_MS) : RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)]!;
    sleeps.push(pause);
    await opts.sleep(pause);
  }
  return { result: last, attempts, sleeps };
}

/** Provider text for `security.price_fetch_message`: one line, no control characters, at most 300 characters. */
export function sanitizeProviderMessage(text: string, max = 300): string {
  const oneLine = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
