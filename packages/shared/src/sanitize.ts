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
/**
 * A complete tag, comment or declaration: "<" then a letter, "!", "/" or "?" (what an HTML parser
 * reads as the start of markup), up to the next ">". `[^<>]` (not `[^>]`) keeps the scan linear:
 * on a run of "<" every start fails at the next character instead of scanning to the end (audit
 * a6-text-rules-accounts-11). "a < b > c" is not a tag and stays.
 */
const TAGS = /<[\p{L}!/?][^<>]*>/gu;
/**
 * Whatever is left that could still open markup: a run of "<" before a letter, "!", "/" or "?"
 * (an unclosed "<meta …" must not reach a page that sets HTML; audit a6-text-rules-accounts-01).
 * The run goes whole, so no "<" before it is left touching the letter, and the lookbehind starts a
 * match only at the run's first "<", which keeps a long run linear. A "<" or ">" that cannot start
 * markup ("price < 50", "-> SAVINGS", "ER <0.1%") is text, and stays as typed (audit
 * a6-text-rules-accounts, second round).
 */
const OPENS_MARKUP = /(?<!<)<+(?=[\p{L}!/?])/gu;
const WHITESPACE = /\s+/g;

/** The first `n` UTF-16 units of `s`, one fewer when the cut would split a surrogate pair. */
function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  const code = s.charCodeAt(n - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

/**
 * Untrusted text as it may be stored and shown: Unicode NFC (so "é" typed two ways is one
 * spelling), no control characters, invisible formatting, tags or "<" that could open one,
 * whitespace collapsed, at most `maxLength` characters. The input is cut to a small multiple of
 * `maxLength` before any pattern runs, so one enormous field costs no more than a long one.
 */
export function sanitizeText(input: unknown, maxLength = 200): string {
  if (input === null || input === undefined) return "";
  const text = cut(typeof input === "string" ? input : String(input), maxLength * 4 + 256);
  const cleaned = text
    .normalize("NFC")
    .replace(CONTROL_CHARS, "")
    .replace(INVISIBLE_FORMATTING, "")
    .replace(TAGS, "")
    .replace(OPENS_MARKUP, "")
    .replace(WHITESPACE, " ")
    .trim();
  return cut(cleaned, maxLength).trimEnd();
}

/**
 * An error's message as it may be stored for display (a connection's `last_error`, an import
 * log's `message`, a job's `last_error`): sanitized and at most `maxLength` characters, since
 * a message can carry text a server sent (a database error quotes the value it refused).
 */
export function errorMessageText(err: unknown, maxLength = 300): string {
  return sanitizeText(err instanceof Error ? err.message : String(err), maxLength);
}

/** Combining marks on a Latin letter (é = e + U+0301, İ = I + U+0307); other scripts keep theirs, where they are letters. */
const LATIN_MARKS = /(?<=\p{Script=Latin})\p{Mn}+/gu;

/**
 * Text without the accents of Latin letters, in NFC: "Café" → "Cafe", "İSTANBUL" →
 * "ISTANBUL", "ÉCOLE" → "ECOLE". Payee normalization and rule matching use it so that one
 * merchant has one name however a bank spells it (audit a6-text-rules-accounts-17).
 */
export function foldLatinAccents(text: string): string {
  return text.normalize("NFD").replace(LATIN_MARKS, "").normalize("NFC");
}
