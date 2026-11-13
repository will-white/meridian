/**
 * Text that arrives from SimpleFIN (descriptions, payees, org names, error messages)
 * or from CSV files is untrusted. The SimpleFIN protocol requires clients to
 * sanitize server-provided text before display. We strip control characters,
 * invisible formatting, markup and excessive whitespace, and cap the length.
 */

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/**
 * Formatting characters that change how text is shown without being seen: bidirectional
 * embeddings, overrides and isolates (U+202A to U+202E, U+2066 to U+2069; a right-to-left
 * override shows "00.005$" as "$500.00"), the left-to-right, right-to-left and Arabic letter
 * marks, the zero-width space, the word joiner and invisible operators (U+2060 to U+2064) and
 * the byte order mark. The zero-width joiner and non-joiner (U+200C, U+200D) stay: emoji
 * sequences and some scripts need them, and they reorder nothing (audit a4-sync-parse-16).
 */
const INVISIBLE_FORMATTING = /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const TAGS = /<[^>]*>/g;
const WHITESPACE = /\s+/g;

export function sanitizeText(input: unknown, maxLength = 200): string {
  if (input === null || input === undefined) return "";
  const text = typeof input === "string" ? input : String(input);
  const cleaned = text.replace(CONTROL_CHARS, "").replace(INVISIBLE_FORMATTING, "").replace(TAGS, "").replace(WHITESPACE, " ").trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

/**
 * An error's message as it may be stored for display (a connection's `last_error`, an import
 * log's `message`, a job's `last_error`): sanitized and at most `maxLength` characters, since
 * a message can carry text a server sent (a database error quotes the value it refused).
 */
export function errorMessageText(err: unknown, maxLength = 300): string {
  return sanitizeText(err instanceof Error ? err.message : String(err), maxLength);
}
