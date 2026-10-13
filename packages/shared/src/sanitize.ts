/**
 * Text that arrives from SimpleFIN (descriptions, payees, org names, error messages)
 * or from CSV files is untrusted. The SimpleFIN protocol requires clients to
 * sanitize server-provided text before display. We strip control characters,
 * markup and excessive whitespace, and cap the length.
 */

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const TAGS = /<[^>]*>/g;
const WHITESPACE = /\s+/g;

export function sanitizeText(input: unknown, maxLength = 200): string {
  if (input === null || input === undefined) return "";
  const text = typeof input === "string" ? input : String(input);
  const cleaned = text.replace(CONTROL_CHARS, "").replace(TAGS, "").replace(WHITESPACE, " ").trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}
