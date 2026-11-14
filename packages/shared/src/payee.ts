import { foldLatinAccents } from "./sanitize.js";

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
  // A bank's own purchase wording in front of the merchant (audit a6-text-rules-accounts-12, second
  // round): "VISA DDA PUR 123456 SAFEWAY", "PURCHASE AUTHORIZED ON 10/02 SAFEWAY", "CARD PURCHASE WITH PIN".
  /^DDA(\s+(PUR|PURCH|PURCHASE|POS|DEBIT|CREDIT|WD|WITHDRAWAL|DEP|DEPOSIT)(\s+AP)?)?\b/i,
  /^AUTHORIZED\s+ON\b/i,
  /^(CARD\s+)?PURCHASE\s+WITH\s+PIN\b/i,
  /^CARD\s+PURCHASE\b/i,
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
  "DDA",
  "PUR",
  "USA",
  "US",
]);

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
]);

const URL_RE = /\b[A-Z0-9.-]+\.(COM|NET|ORG|CO|IO|US)(\/[A-Z0-9/._-]*)?\b/gi;

/**
 * Where a store number, phone number, masked card or processor code stood: the "CITY ST" that
 * follows one is the store's place, the words before it the merchant (audit a6-text-rules-accounts-12).
 */
const MARK = "\u0002";

const WEEKDAY = "(?:MON|TUE|TUES|WED|THU|THUR|THURS|FRI|SAT|SUN)";
const STORE_NUMBER = /#\s*\d+\b/g;
const PROCESSOR_CODE = /\*[A-Z0-9]{4,}\b/gi;
const PHONE = /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g;
const MASKED_CARD = /\b(X{2,}|\*{2,})\d+\b/gi;

const SEGMENTS: RegExp[] = [
  /\bINDN[:#]\s*.*?(?=\s+(?:CO\s+ID|[A-Z]{2,6})[:#]|$)/gi, // "INDN:JOHN DOE" up to the next KEY: segment
  /\b(DIRECT|DIR)\s+DEP(OSIT)?\b/gi, // "DIRECT DEP" anywhere, not only as a prefix
  /\bCO\s+ID[:#]?\s*\S+/gi, // "CO ID:1234567890"
  /\b(DES|ID|INDN|TRACE|REF|CKF|CCD|PPD|WEB|TEL|ARC)[:#]\s*\S+/gi, // "DES:XCELENERGY" "ID:0000123"
  PHONE, // phone numbers
  /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, // dates such as 10/02 or 10/02/24
  new RegExp(`\\b(?:${WEEKDAY}\\s+)?\\d{1,2}:\\d{2}(:\\d{2})?\\s*(AM|PM)?\\b`, "gi"), // times, with the weekday a ride or order carries ("THU 10:15PM")
  new RegExp(`\\b(?:${WEEKDAY}\\s+)?\\d{1,2}\\s?(AM|PM)\\b`, "gi"), // "TUE 5PM", "SUN 11AM"
  MASKED_CARD, // masked card numbers XXXX1234
  STORE_NUMBER, // store numbers #0123
  PROCESSOR_CODE, // processor codes *2K3JH8U21
  URL_RE, // URL-ish tokens (AMZN.COM/BILL), kept only when the name itself is a domain
  /\bWWW\.\S+/gi,
];

/** Segments whose place is kept as a mark, because they separate the merchant from its city. */
const MARKED: ReadonlySet<RegExp> = new Set([PHONE, MASKED_CARD, STORE_NUMBER, PROCESSOR_CODE]);

function stripSegments(text: string): string {
  let out = text;
  for (const re of SEGMENTS) {
    out = out.trim().replace(re, (match: string, ...args: unknown[]) => {
      const offset = args[args.length - 2] as number;
      if (re === URL_RE && offset === 0) return match;
      return MARKED.has(re) ? ` ${MARK} ` : " ";
    });
  }
  return out;
}

/** First words of two- and three-word city names ("SAN FRANCISCO", "FORT COLLINS", "SALT LAKE CITY"). */
const CITY_PREFIXES = new Set(["SAN", "SANTA", "LOS", "LAS", "NEW", "FORT", "FT", "ST", "SAINT", "EL", "PALM", "PORT", "MOUNT", "MT", "NORTH", "SOUTH", "EAST", "WEST", "SALT", "GRAND", "BATON", "OKLAHOMA", "KANSAS", "JERSEY", "CARSON", "SIOUX", "COEUR"]);
/** Last words of two-word city names ("COLORADO SPRINGS", "COMMERCE CITY", "HIGHLANDS RANCH"). */
const CITY_SUFFIXES = new Set(["CITY", "SPRINGS", "BEACH", "VILLAGE", "HEIGHTS", "FALLS", "HILLS", "RANCH", "VALLEY", "JUNCTION", "LAKE", "ROCK", "PARK"]);

/** How many trailing words of `words` (before a state code) read as a city when nothing marks where it starts: 1 to 3. */
function cityWidth(words: readonly string[]): number {
  const n = words.length;
  let width = 1;
  if (n >= 2 && CITY_SUFFIXES.has(words[n - 1]!.toUpperCase())) width = 2;
  if (n > width && CITY_PREFIXES.has(words[n - 1 - width]!.toUpperCase())) width += 1;
  return width;
}

/**
 * Drop a trailing "CITY ST". When a store number or code stands after the merchant, before the
 * city, the city is exactly the words between it and the state (none, one, two or three).
 * Otherwise, and also when the code stands in front of the merchant ("CHECKCARD 1105 SAFEWAY
 * DENVER CO": a card's date, a card number or a transaction id, with no name word before it),
 * the city is the last word, widened by the lists of city prefixes and suffixes (audit
 * a6-text-rules-accounts-12, second round). A merchant word is never dropped when nothing would
 * be left of the name.
 */
function stripCityState(seq: string[]): string[] {
  while (seq.length > 0 && seq[seq.length - 1] === MARK) seq.pop();
  const last = seq[seq.length - 1];
  if (last === undefined || !US_STATES.has(last.toUpperCase()) || last !== last.toUpperCase()) return seq;
  const stateAt = seq.length - 1;
  // Walk back from the state over at most three words, to a mark.
  let i = stateAt - 1;
  let k = 0;
  while (i >= 0 && seq[i] !== MARK && k < 4) {
    i--;
    k++;
  }
  const nameWordBefore = seq.slice(0, Math.max(i, 0)).some((t) => t !== MARK);
  if (i >= 0 && seq[i] === MARK && k <= 3 && nameWordBefore) return seq.slice(0, i + 1);
  const words = seq.slice(0, stateAt).filter((t) => t !== MARK);
  if (words.length < 2) return words;
  const width = Math.min(cityWidth(words), words.length - 1);
  return words.slice(0, words.length - width);
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
    .replace(/(^|[\s-])(\p{Ll})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase())
    .replace(/^Mc([a-z])/, (_, ch: string) => `Mc${ch.toUpperCase()}`);
}

/**
 * Normalize a raw description (or SimpleFIN payee) into a canonical payee name. Latin accents
 * are folded ("Café Rio" and "CAFE RIO" are one payee) and letters of every script are kept
 * (audit a6-text-rules-accounts-17); a rename on the payee restores the spelling the household
 * prefers, and the folded name stays an alias.
 */
export function normalizePayee(raw: string): string {
  const source = foldLatinAccents(raw.normalize("NFKC")).replace(/\s+/g, " ").trim();
  let text = source;
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

  const seq = text
    .split(/\s+/)
    .map((t) => (t === MARK ? t : t.replace(/^[^\p{L}\p{N}$&'’.-]+|[^\p{L}\p{N}$&'’.!-]+$/gu, "")))
    .filter((t) => t.length > 0)
    .filter((t) => !NOISE_TOKENS.has(t.toUpperCase()))
    .map((t) => (t !== MARK && isCodeToken(t) ? MARK : t));

  // Trailing "CITY ST": drop the state code and the city.
  let tokens = stripCityState(seq).filter((t) => t !== MARK);

  // Drop a dangling trailing single letter or punctuation-only token.
  while (tokens.length > 1 && /^[^\p{L}\p{N}]*$/u.test(tokens[tokens.length - 1] ?? "")) tokens.pop();

  if (tokens.length === 0) {
    tokens = source.split(" ").filter((t) => t.length > 0);
  }

  return tokens.map(titleCase).join(" ").trim();
}
