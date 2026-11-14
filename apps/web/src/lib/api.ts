export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** `ApiError.status` of a request that got no answer (no network, the server is down, the connection dropped). */
export const NETWORK_ERROR_STATUS = 0;

/**
 * What a person reads when a request never reached Meridian. The browser's own text ("Failed to
 * fetch", Safari's "Load failed", Firefox's "NetworkError when attempting to fetch resource.")
 * says nothing about what happened or what to do (audit b8-web-layout-13).
 */
export const NETWORK_ERROR_MESSAGE = "Can't reach Meridian. Check the connection; the app tries again on its own.";

/** A 502, 503 or 504 without the API's JSON body comes from the proxy: the API is restarting or down. */
const GATEWAY_MESSAGE = "Meridian is not answering right now (it may be restarting). Try again in a moment.";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function api<T>(path: string, options: { method?: Method; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const init: RequestInit = { method: options.method ?? "GET", credentials: "same-origin", signal: options.signal ?? null };
  if (options.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch (error) {
    // A cancelled request stays a cancellation, which TanStack Query tells apart from a failure.
    if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
    throw new ApiError(NETWORK_ERROR_STATUS, NETWORK_ERROR_MESSAGE, "network");
  }
  if (!res.ok) {
    let message = res.status === 502 || res.status === 503 || res.status === 504 ? GATEWAY_MESSAGE : `Request failed (${res.status})`;
    let code: string | undefined;
    try {
      const data = (await res.json()) as { error?: string; code?: string };
      if (data.error) message = data.error;
      code = data.code;
    } catch {
      // keep the default message
    }
    throw new ApiError(res.status, message, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * The retry policy of every query: a request that got no answer, or a 5xx, is tried twice more;
 * an answer that refuses the request (4xx) is final.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (!(error instanceof ApiError)) return true;
  return error.status === NETWORK_ERROR_STATUS || error.status >= 500;
}

export function query(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}
