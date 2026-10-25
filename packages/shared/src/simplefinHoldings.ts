import { isIsoDate, unixToIsoDate, type IsoDate } from "./dates.js";
import {
  centsToFixed8,
  fixed8FromJsonNumber,
  fixed8ToCents,
  FIXED8_PER_CENT,
  FIXED8_SCALE,
  impliedPrice,
  mulToCents,
  parseLooseDecimal,
  type Fixed8,
} from "./decimal.js";
import { isCashKey, normalizeCusip, normalizeIsin, normalizeTicker } from "./investments.js";
import { sanitizeText } from "./sanitize.js";

/**
 * SimpleFIN holdings parser (imports design §3.3; plan decision 18; seams C3/C53).
 *
 * The protocol has no standard holdings object. This parser reads the Bridge's own
 * `account.holdings` array plus five `extra` container shapes through a fixed synonym
 * table, accepts dollar-only positions (value known, units not reported), rejects
 * anything else per element naming the keys it saw (values are never echoed), never
 * invents a cash position and never dates a snapshot by the clock. Pure: no DB, no clock.
 */

export type ParsedPositionWarning = "value_mismatch" | "value_rounded" | "asof_mixed" | "dollar_only";

export interface ParsedPosition {
  /** Element index within the container. */
  index: number;
  ticker: string | null;
  name: string | null;
  cusip: string | null;
  isin: string | null;
  /** Null for a dollar-only position. */
  quantity: Fixed8 | null;
  price: Fixed8 | null;
  valueCents: bigint;
  costBasisCents: bigint | null;
  currency: string | null;
  /** The element's own as-of date when it carried one. */
  asOf: IsoDate | null;
  /** Free-text type hints for `guessSecurityHints`. */
  hints: string[];
  isCash: boolean;
  warnings: ParsedPositionWarning[];
}

export type RejectedReason = "missing_identity" | "missing_value" | `unparseable:${string}`;

export interface RejectedPosition {
  index: number;
  reason: RejectedReason;
  keys: string[];
}

export interface SkippedPosition {
  index: number;
  reason: "pending_activity" | "zero_position";
}

export interface HoldingsParseResult {
  /** `none`: no container; `unrecognized`: a container but nothing readable; `partial`: some rows rejected. */
  status: "none" | "parsed" | "partial" | "unrecognized";
  /** `holdings` for the Bridge's own array, else `extra.<key>`. */
  container: string | null;
  /** The snapshot date: the elements' common as-of date, else the account's balance-date. Never the clock. */
  asOf: IsoDate | null;
  positions: ParsedPosition[];
  rejected: RejectedPosition[];
  skipped: SkippedPosition[];
  /** Union of the elements' original keys (≤ 30, sanitized) for the error message. */
  keysSeen: string[];
}

/** The parts of a SimpleFIN account the parser reads (a `SimplefinAccount` satisfies it). */
export interface HoldingsSource {
  holdings?: unknown;
  extra?: Record<string, unknown> | undefined;
  "balance-date"?: number | undefined;
}

// ---- Synonyms (keys are normalized: lower-case, `_`, `-` and spaces dropped) ----

type Field = "symbol" | "name" | "cusip" | "isin" | "quantity" | "price" | "value" | "cost" | "currency" | "asof" | "hint";

const SYNONYMS: ReadonlyArray<[Field, readonly string[]]> = [
  ["symbol", ["symbol", "ticker", "securitysymbol", "tickersymbol", "fundsymbol"]],
  ["name", ["name", "description", "securityname", "security", "fundname", "investmentname", "holdingname"]],
  ["cusip", ["cusip"]],
  ["isin", ["isin"]],
  ["quantity", ["quantity", "shares", "units", "qty", "sharesowned", "sharecount", "unitsheld", "numberofshares"]],
  ["price", ["price", "unitprice", "marketprice", "lastprice", "close", "closeprice", "currentprice", "shareprice", "nav"]],
  ["value", ["value", "marketvalue", "currentvalue", "totalvalue", "balance", "positionvalue"]],
  ["cost", ["costbasis", "cost", "basis", "totalcost", "costbasistotal"]],
  ["currency", ["currency"]],
  ["asof", ["date", "asof", "asofdate", "balancedate", "pricedate"]],
  ["hint", ["type", "securitytype", "assettype", "assetclass"]],
];
// `amount`, `purchaseprice` and `created` are deliberately not synonyms (ambiguous).

const IDENTITY_FIELDS: readonly Field[] = ["symbol", "cusip", "isin", "name"];
const NAMED_CONTAINERS = ["holdings", "positions", "investments", "securities"] as const;
const MAX_KEYS_SEEN = 30;
const PENDING_RE = /^PENDING ACTIVITY/;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, "");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Null and blank strings count as absent. */
function isAbsent(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/** The element's values by field: the first synonym present (in table order) wins. */
function fieldsOf(element: Record<string, unknown>): Map<Field, unknown> {
  const byKey = new Map<string, unknown>();
  for (const [key, value] of Object.entries(element)) {
    const norm = normalizeKey(key);
    if (!byKey.has(norm)) byKey.set(norm, value);
  }
  const out = new Map<Field, unknown>();
  for (const [field, names] of SYNONYMS) {
    for (const name of names) {
      const value = byKey.get(name);
      if (!isAbsent(value)) {
        out.set(field, value);
        break;
      }
    }
  }
  return out;
}

/** Every type hint the element carries (`type`, `securitytype`, `assettype`, `assetclass`), as text for the guesser. */
function hintsOf(element: Record<string, unknown>): string[] {
  const hintKeys = SYNONYMS.find(([field]) => field === "hint")![1];
  const out: string[] = [];
  for (const [key, value] of Object.entries(element)) {
    if (!hintKeys.includes(normalizeKey(key))) continue;
    const t = text(value, 100);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function hasIdentityKey(element: Record<string, unknown>): boolean {
  const fields = fieldsOf(element);
  return IDENTITY_FIELDS.some((f) => fields.has(f));
}

function hasQuantityOrValueKey(element: Record<string, unknown>): boolean {
  const fields = fieldsOf(element);
  return fields.has("quantity") || fields.has("value");
}

/** The elements of a container: an array as-is; an object keyed by symbol becomes its entries. */
function elementsOf(container: unknown): unknown[] | null {
  if (Array.isArray(container)) return container.length > 0 ? container : null;
  if (isPlainObject(container)) {
    const entries = Object.entries(container);
    if (entries.length === 0 || !entries.some(([, v]) => isPlainObject(v))) return null;
    return entries.map(([key, value]) => {
      if (!isPlainObject(value)) return value;
      return hasIdentityKey(value) ? value : { symbol: key, ...value };
    });
  }
  return null;
}

/** For an unnamed `extra.<key>`: at least one element has both an identity key and a quantity-or-value key. */
function looksLikeHoldings(elements: unknown[]): boolean {
  return elements.some((e) => isPlainObject(e) && hasIdentityKey(e) && hasQuantityOrValueKey(e));
}

function findContainer(account: HoldingsSource): { name: string; elements: unknown[] } | null {
  const own = elementsOf(account.holdings);
  if (own) return { name: "holdings", elements: own };
  const extra = isPlainObject(account.extra) ? account.extra : null;
  if (!extra) return null;
  for (const key of NAMED_CONTAINERS) {
    const elements = elementsOf(extra[key]);
    if (elements) return { name: `extra.${key}`, elements };
  }
  for (const [key, value] of Object.entries(extra)) {
    if ((NAMED_CONTAINERS as readonly string[]).includes(key)) continue;
    const elements = elementsOf(value);
    if (elements && looksLikeHoldings(elements)) return { name: `extra.${key}`, elements };
  }
  return null;
}

// ---- Values ----

class Unparseable extends Error {
  constructor(readonly field: string) {
    super(`unparseable:${field}`);
  }
}

function text(v: unknown, max: number): string {
  if (typeof v === "string" || typeof v === "number") return sanitizeText(v, max);
  return "";
}

/** A number (JSON double) or a loose decimal string → Fixed8; undefined when absent. Throws `Unparseable`. */
function decimal(fields: Map<Field, unknown>, field: Field): Fixed8 | undefined {
  const raw = fields.get(field);
  if (isAbsent(raw)) return undefined;
  let parsed: Fixed8 | undefined;
  if (typeof raw === "number") parsed = fixed8FromJsonNumber(raw);
  else if (typeof raw === "string") parsed = parseLooseDecimal(raw);
  if (parsed === undefined) throw new Unparseable(field);
  return parsed;
}

/** A dollar amount → cents (half away from zero); `rounded` when non-zero digits were dropped. */
function money(fields: Map<Field, unknown>, field: Field): { cents: bigint; rounded: boolean } | undefined {
  const v = decimal(fields, field);
  if (v === undefined) return undefined;
  return { cents: fixed8ToCents(v), rounded: v % FIXED8_PER_CENT !== 0n };
}

/** Unix seconds or `YYYY-MM-DD` (a longer ISO timestamp is read by its date part). */
function asOfOf(fields: Map<Field, unknown>): IsoDate | undefined {
  const raw = fields.get("asof");
  if (isAbsent(raw)) return undefined;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) throw new Unparseable("asof");
    return unixToIsoDate(raw);
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    const iso = s.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}/.test(s) && isIsoDate(iso)) return iso;
    if (/^\d{9,12}$/.test(s)) return unixToIsoDate(Number(s));
  }
  throw new Unparseable("asof");
}

function keysOf(element: Record<string, unknown>): string[] {
  return Object.keys(element)
    .map((k) => sanitizeText(k, 50))
    .filter((k) => k.length > 0);
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

type ElementOutcome = { kind: "position"; position: ParsedPosition } | { kind: "rejected"; rejected: RejectedPosition } | { kind: "skipped"; skipped: SkippedPosition };

function parseElement(index: number, raw: unknown): ElementOutcome {
  if (!isPlainObject(raw)) return { kind: "rejected", rejected: { index, reason: "unparseable:element", keys: [] } };
  const keys = keysOf(raw);
  const fields = fieldsOf(raw);

  const symbolRaw = text(fields.get("symbol"), 100);
  const nameRaw = text(fields.get("name"), 200);
  const cusip = normalizeCusip(text(fields.get("cusip"), 50));
  const isin = normalizeIsin(text(fields.get("isin"), 50));
  if (!symbolRaw && !nameRaw && !cusip && !isin) return { kind: "rejected", rejected: { index, reason: "missing_identity", keys } };
  if (PENDING_RE.test(nameRaw.toUpperCase()) || PENDING_RE.test(symbolRaw.toUpperCase())) {
    return { kind: "skipped", skipped: { index, reason: "pending_activity" } };
  }

  try {
    let quantity = decimal(fields, "quantity") ?? null;
    let price = decimal(fields, "price") ?? null;
    const value = money(fields, "value");
    const cost = money(fields, "cost");
    const asOf = asOfOf(fields) ?? null;
    const warnings: ParsedPositionWarning[] = [];
    if (value?.rounded || cost?.rounded) warnings.push("value_rounded");

    const isCash = isCashKey({ ticker: symbolRaw, name: nameRaw });
    let valueCents: bigint;
    if (isCash) {
      // The cash position: a dollar is a share at 1.
      if (price === null) price = FIXED8_SCALE;
      if (value !== undefined) {
        valueCents = value.cents;
        if (quantity === null) quantity = centsToFixed8(valueCents);
      } else if (quantity !== null) {
        valueCents = mulToCents(quantity, price);
      } else {
        return { kind: "rejected", rejected: { index, reason: "missing_value", keys } };
      }
    } else if (value !== undefined && quantity === null) {
      // Dollar-only: the value is known, the units are not reported.
      valueCents = value.cents;
      price = null;
      warnings.push("dollar_only");
    } else if (value === undefined && quantity !== null) {
      if (price === null) return { kind: "rejected", rejected: { index, reason: "missing_value", keys } };
      valueCents = mulToCents(quantity, price);
    } else if (value !== undefined && quantity !== null) {
      valueCents = value.cents;
      if (price === null) {
        price = quantity !== 0n ? impliedPrice(valueCents, quantity) : null;
      } else {
        // The broker's number is what the statement shows; a disagreement beyond 0.5 % (or 1 cent) is flagged.
        const tolerance = abs(valueCents) / 200n;
        if (abs(valueCents - mulToCents(quantity, price)) > (tolerance > 1n ? tolerance : 1n)) warnings.push("value_mismatch");
      }
    } else {
      return { kind: "rejected", rejected: { index, reason: "missing_value", keys } };
    }

    if (valueCents === 0n && (quantity === null || quantity === 0n)) return { kind: "skipped", skipped: { index, reason: "zero_position" } };

    const ticker = normalizeTicker(symbolRaw);
    const name = nameRaw || (ticker === null && symbolRaw ? symbolRaw : "");
    const hints = hintsOf(raw);
    const currency = text(fields.get("currency"), 10).toUpperCase() || null;
    return {
      kind: "position",
      position: {
        index,
        ticker,
        name: name || null,
        cusip,
        isin,
        quantity,
        price,
        valueCents,
        costBasisCents: cost?.cents ?? null,
        currency,
        asOf,
        hints,
        isCash,
        warnings,
      },
    };
  } catch (err) {
    if (err instanceof Unparseable) return { kind: "rejected", rejected: { index, reason: `unparseable:${err.field}`, keys } };
    throw err;
  }
}

/**
 * Parse an account's holdings. `status: 'none'` when no container is present (a counter in stats
 * only); otherwise every element is a position, a rejection naming its keys, or a skip.
 */
export function parseSimplefinHoldings(account: HoldingsSource): HoldingsParseResult {
  const container = findContainer(account);
  if (!container) return { status: "none", container: null, asOf: null, positions: [], rejected: [], skipped: [], keysSeen: [] };

  const positions: ParsedPosition[] = [];
  const rejected: RejectedPosition[] = [];
  const skipped: SkippedPosition[] = [];
  const keysSeen: string[] = [];
  for (const [index, element] of container.elements.entries()) {
    if (isPlainObject(element)) {
      for (const key of keysOf(element)) {
        if (keysSeen.length >= MAX_KEYS_SEEN) break;
        if (!keysSeen.includes(key)) keysSeen.push(key);
      }
    }
    const outcome = parseElement(index, element);
    if (outcome.kind === "position") positions.push(outcome.position);
    else if (outcome.kind === "rejected") rejected.push(outcome.rejected);
    else skipped.push(outcome.skipped);
  }

  // The snapshot date: the elements' common as-of date, else the balance-date. Never the clock.
  const balanceDate = account["balance-date"];
  const fallback = typeof balanceDate === "number" && balanceDate > 0 ? unixToIsoDate(balanceDate) : null;
  const dates = new Set(positions.map((p) => p.asOf).filter((d): d is IsoDate => d !== null));
  let asOf: IsoDate | null;
  if (dates.size === 1 && positions.every((p) => p.asOf !== null)) {
    asOf = positions[0]!.asOf;
  } else {
    asOf = fallback;
    if (dates.size > 0) for (const p of positions) p.warnings.push("asof_mixed");
  }

  const understood = positions.length + skipped.length;
  const status = understood === 0 ? "unrecognized" : rejected.length > 0 ? "partial" : "parsed";
  return { status, container: container.name, asOf, positions, rejected, skipped, keysSeen };
}
