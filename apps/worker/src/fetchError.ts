import { sanitizeText } from "@meridian/shared";

/**
 * Why a `fetch` threw, in words the household can act on. Node reports every transport
 * failure as `TypeError: fetch failed` and keeps the reason (a name that does not resolve, a
 * refused connection, a certificate the system does not trust) in `err.cause`; without it a
 * certificate problem and an outage read the same. Used for the SimpleFIN Bridge and the
 * price provider alike.
 *
 * The text is one bounded line and never repeats a URL's credentials, path or query: an
 * access URL is a password and a claim URL a one-time secret.
 */
export function describeFetchFailure(err: unknown, options: { timeoutMs?: number } = {}): string {
  const root = rootCause(err);
  if (root.name === "TimeoutError" || nameOf(err) === "TimeoutError") {
    return options.timeoutMs ? `timeout (no answer within ${Math.round(options.timeoutMs / 1000)} seconds)` : "timeout (no answer in time)";
  }
  const message = clean(root.message) || clean(messageOf(err)) || "unknown error";
  const withCode = root.code && !message.includes(root.code) ? `${message} (${root.code})` : message;
  return root.code && CERTIFICATE_CODE.test(root.code) ? `its certificate was not accepted: ${withCode}` : withCode;
}

/** Node's and OpenSSL's codes for a certificate that failed verification (untrusted, expired, wrong host). */
const CERTIFICATE_CODE = /CERT|ISSUER|LEAF_SIGNATURE|ALTNAME|CRL/;

interface Cause {
  name: string;
  message: string;
  code: string | null;
}

function nameOf(err: unknown): string {
  return typeof err === "object" && err !== null && typeof (err as { name?: unknown }).name === "string" ? (err as { name: string }).name : "";
}

function messageOf(err: unknown): string {
  if (typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string") return (err as { message: string }).message;
  return typeof err === "string" ? err : "";
}

/** The innermost `cause` (the first of several when a connection was tried on more than one address). */
function rootCause(err: unknown): Cause {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== "object" || current === null) break;
    const errors = (current as { errors?: unknown }).errors;
    const next = Array.isArray(errors) && errors.length > 0 ? errors[0] : (current as { cause?: unknown }).cause;
    if (typeof next !== "object" || next === null) break;
    current = next;
  }
  const code = typeof current === "object" && current !== null ? (current as { code?: unknown }).code : undefined;
  return { name: nameOf(current), message: messageOf(current), code: typeof code === "string" && code ? code : null };
}

/** OpenSSL's error line (`<thread>:error:<number>:<library>:<function>:<reason>:<file>:<line>:`); the reason is the readable part. */
const OPENSSL_ERROR = /:error:[0-9A-Fa-f]+:[^:]*:[^:]*:([^:]+):/;

/** First line only, URLs cut down to scheme and host, markup and control characters removed, at most 200 characters. */
function clean(text: string): string {
  const line = text.split(/\r?\n/)[0] ?? "";
  const firstLine = OPENSSL_ERROR.exec(line)?.[1] ?? line;
  const withoutSecrets = firstLine.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => {
    try {
      const url = new URL(match);
      return `${url.protocol}//${url.host}`;
    } catch {
      return "(url)";
    }
  });
  return sanitizeText(withoutSecrets, 200);
}
