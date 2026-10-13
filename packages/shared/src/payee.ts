/**
 * Payee normalization: turn a raw bank description into a stable, human payee name.
 *
 * The goal is a name that groups the same merchant across statements, not a
 * perfect display name. Aliases on the payee table merge whatever this misses.
 */

/** Card-processor and bank prefixes that carry no merchant information. */
const PREFIXES: RegExp[] = [
  /^(POS|PIN|SIG)\s+(PURCHASE|DEBIT|CREDIT|TRANSACTION|REFUND)\b/i,
  /^(DEBIT|CREDIT)\s+CARD\s+(PURCHASE|DEBIT|CREDIT|REFUND)\b/i,
  /^(CHECK\s?CARD|CKCD|VISA|MASTERCARD|DBT|CRD)\b/i,
  /^(ACH|ELECTRONIC|ONLINE|WEB|TEL|RECURRING|PREAUTHORIZED|EFT)\s+(DEBIT|CREDIT|PAYMENT|PMT|WITHDRAWAL|DEPOSIT)\b/i,
  /^ACH\b/i,
  /^DIRECT\s+(DEP(OSIT)?|DEBIT|PAY(MENT)?)\b/i,
  /^(PURCHASE|PAYMENT|WITHDRAWAL|DEPOSIT)\b/i,
  /^(SQ|SQU|TST|PAYPAL|PP|PY|DD|IC|SP|CKE|GOOGLE|APPLE\.COM\/BILL|AMZN\s+MKTP|PYMT)\s*\*\s*/i,
  /^(SQ|TST|PP|PY|DD|IC|SP|CKE)\s*\*/i,
  /^INTL\s*\*/i,
];

/** Tokens that are statement plumbing, never part of a merchant name. */
const NOISE_TOKENS = new Set([
  "WEB",
  "PMT",
  "ONLINE",
  "PURCHASE",
  "DEBIT",
  "CREDIT",
  "ACH",
  "POS",
  "CHECKCARD",
  "CKCD",
  "RECURRING",
  "AUTOPAY",
  "ID",
  "DES",
  "INDN",
  "PPD",
  "CCD",
  "TEL",
  "ARC",
  "EPAY",
  "BILLPAY",
  "WWW",
  "REF",
  "TRACE",
  "AUTH",
  "PENDING",
  "CARD",
  "CRD",
  "USA",
  "US",
]);

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
]);

const URL_RE = /\b[A-Z0-9.-]+\.(COM|NET|ORG|CO|IO|US)(\/[A-Z0-9/._-]*)?\b/gi;

const SEGMENTS: RegExp[] = [
  /\bINDN[:#]\s*.*?(?=\s+(?:CO\s+ID|[A-Z]{2,6})[:#]|$)/gi, // "INDN:JOHN DOE" up to the next KEY: segment
  /\b(DIRECT|DIR)\s+DEP(OSIT)?\b/gi, // "DIRECT DEP" anywhere, not only as a prefix
  /\bCO\s+ID[:#]?\s*\S+/gi, // "CO ID:1234567890"
  /\b(DES|ID|INDN|TRACE|REF|CKF|CCD|PPD|WEB|TEL|ARC)[:#]\s*\S+/gi, // "DES:XCELENERGY" "ID:0000123"
  /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, // phone numbers
  /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, // dates such as 10/02 or 10/02/24
  /\b\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?\b/gi, // times
  /\b(X{2,}|\*{2,})\d+\b/gi, // masked card numbers XXXX1234
  /#\s*\d+\b/g, // store numbers #0123
  /\*[A-Z0-9]{4,}\b/gi, // processor codes *2K3JH8U21
  URL_RE, // URL-ish tokens (AMZN.COM/BILL), kept only when the name itself is a domain
  /\bWWW\.\S+/gi,
];

function stripSegments(text: string): string {
  let out = text;
  for (const re of SEGMENTS) {
    out = out.trim().replace(re, (match: string, ...args: unknown[]) => {
      const offset = args[args.length - 2] as number;
      if (re === URL_RE && offset === 0) return match;
      return " ";
    });
  }
  return out;
}

function isCodeToken(token: string): boolean {
  if (/^\d{3,}$/.test(token)) return true; // 1002, 24692161
  if (/^[A-Z0-9]{5,}$/i.test(token) && /\d/.test(token) && /[A-Z]/i.test(token)) return true; // 2K3JH8U21
  if (/^[A-Z]{1,3}\d{3,}$/i.test(token)) return true; // T1234, REF123456
  return false;
}

function titleCase(token: string): string {
  if (token.length <= 1) return token.toUpperCase();
  // Keep short all-caps tokens that look like initialisms (ATM, IKEA still read fine as Ikea; prefer readability).
  return token
    .toLowerCase()
    .replace(/(^|[\s-])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase())
    .replace(/^Mc([a-z])/, (_, ch: string) => `Mc${ch.toUpperCase()}`);
}

/** Normalize a raw description (or SimpleFIN payee) into a canonical payee name. */
export function normalizePayee(raw: string): string {
  let text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "";

  let changed = true;
  while (changed) {
    changed = false;
    for (const re of PREFIXES) {
      const next = text.replace(re, "").trim();
      if (next !== text) {
        text = next;
        changed = true;
      }
    }
  }

  text = stripSegments(text);

  let tokens = text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\w$&'’.-]+|[^\w$&'’.!-]+$/g, ""))
    .filter((t) => t.length > 0)
    .filter((t) => !NOISE_TOKENS.has(t.toUpperCase()))
    .filter((t) => !isCodeToken(t));

  // Trailing "CITY ST": drop the state code, then the city token when a name remains.
  const last = tokens[tokens.length - 1];
  if (tokens.length >= 2 && last && US_STATES.has(last.toUpperCase()) && last === last.toUpperCase()) {
    tokens = tokens.slice(0, -1);
    if (tokens.length >= 2) tokens = tokens.slice(0, -1);
  }

  // Drop a dangling trailing single letter or punctuation-only token.
  while (tokens.length > 1 && /^[^A-Za-z0-9]*$/.test(tokens[tokens.length - 1] ?? "")) tokens.pop();

  if (tokens.length === 0) {
    tokens = raw
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter((t) => t.length > 0);
  }

  return tokens.map(titleCase).join(" ").trim();
}
