import { z } from "zod";

/**
 * Fixed-point decimals for share quantities and prices.
 *
 * `Fixed8` is a bigint scaled by 10^8 (the exact image of Postgres `numeric(20,8)`);
 * on the wire it is a decimal string with at most 8 fraction digits. Cents stay
 * `bigint`. No JS `number` ever holds a quantity, a price or cents; rates (returns,
 * ratios) are the only floats and they never feed back into cents.
 *
 * Rounding sites (Phase 3 plan, decision 2). Phase 2's rule is that bigint division
 * truncates toward zero. Phase 3 states exactly these exceptions, all of which round
 * half away from zero through `roundDivHalfAway`:
 *
 *   R1  `mulToCents(qty, price)`         quantity × price → cents (statements round each
 *                                        position's market value to the cent)
 *   R2  `quantityForCents(cents, price)` cents ÷ price → quantity
 *   R3  `impliedPrice(cents, qty)`       cents ÷ quantity → price, on absolute values
 *   R5  `scaleQty(qty, num, den)`        split scaling per lot, no residual fix
 *       `fixed8ToCents(v)`               a dollar amount held as Fixed8 → cents
 *       lot engine basis consumption     `roundDivHalfAway(basis × take, quantity)` (lots.ts)
 *
 *   R4  `allocateLargestRemainder`       cents split across pieces (proceeds across lots,
 *                                        class splits of a value): largest remainder, so
 *                                        the pieces always sum to the total
 *
 * Every other integer division in the app (basis points, ppm, target cents, pro-rata
 * gain estimates, averages, monthly equivalents) keeps truncation toward zero
 * (`truncDiv` in months.ts). `percentToPpm` is exact or throws; it never rounds.
 */

export type Fixed8 = bigint;

/** 1.00000000 */
export const FIXED8_SCALE = 100_000_000n;
/** Fixed8 units per cent: 10^8 / 10^2. */
export const FIXED8_PER_CENT = 1_000_000n;
/** (Fixed8 × Fixed8) units per cent: 10^8 · 10^8 / 10^2. */
export const FIXED8_SQ_PER_CENT = 100_000_000_000_000n;

const FIXED8_RE = /^(-?)(\d{1,12})(?:\.(\d{1,8}))?$/;

/** Zod: a decimal string with up to 12 integer and 8 fraction digits (`numeric(20,8)`). */
export const Fixed8String = z.string().regex(/^-?\d{1,12}(\.\d{1,8})?$/, "decimal with up to 8 places");
export const NonNegFixed8String = z.string().regex(/^\d{1,12}(\.\d{1,8})?$/, "non-negative decimal with up to 8 places");
export const QuantityString = Fixed8String;
export const PriceString = NonNegFixed8String;

/**
 * Parse a canonical or Postgres-form decimal string ("12.5", "12.50000000", "-0.00000001").
 * Throws on more than 8 fraction digits, more than 12 integer digits, exponents, blanks and
 * thousands separators.
 */
export function parseFixed8(s: string): Fixed8 {
  const m = FIXED8_RE.exec(s.trim());
  if (!m) throw new Error(`Not a decimal with up to 8 places: "${s}"`);
  const [, sign, whole, frac = ""] = m;
  const value = BigInt(whole!) * FIXED8_SCALE + BigInt(frac.padEnd(8, "0"));
  return sign === "-" ? -value : value;
}

/** Canonical form: no trailing zeros, no trailing point, no "-0". */
export function formatFixed8(v: Fixed8): string {
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = abs / FIXED8_SCALE;
  let frac = (abs % FIXED8_SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  if (frac.length > 0) frac = `.${frac}`;
  if (whole === 0n && frac === "") return "0";
  return `${negative ? "-" : ""}${whole}${frac}`;
}

/** Integer division rounding half away from zero. The divisor must be > 0n. */
export function roundDivHalfAway(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("divisor must be > 0n");
  const q = n / d;
  const r = n % d;
  const twiceAbsR = r < 0n ? -2n * r : 2n * r;
  if (twiceAbsR >= d) return n < 0n ? q - 1n : q + 1n;
  return q;
}

/** R1: quantity × price → cents. */
export function mulToCents(qty: Fixed8, price: Fixed8): bigint {
  return roundDivHalfAway(qty * price, FIXED8_SQ_PER_CENT);
}

/** R2: cents ÷ price → quantity. The price must be > 0n. */
export function quantityForCents(cents: bigint, price: Fixed8): Fixed8 {
  if (price <= 0n) throw new Error("price must be > 0n");
  return roundDivHalfAway(cents * FIXED8_SQ_PER_CENT, price);
}

/** R3: cents ÷ quantity → unit price, on absolute values. The quantity must be ≠ 0n. */
export function impliedPrice(cents: bigint, qty: Fixed8): Fixed8 {
  if (qty === 0n) throw new Error("quantity must be non-zero");
  const absCents = cents < 0n ? -cents : cents;
  const absQty = qty < 0n ? -qty : qty;
  return roundDivHalfAway(absCents * FIXED8_SQ_PER_CENT, absQty);
}

/**
 * R4: split `total` across `weights` by largest remainder; the parts sum to `total` exactly.
 * Works on |total| and negates for a negative total; ties go to the lower index.
 * Throws when the weights sum to 0n or less.
 */
export function allocateLargestRemainder(total: bigint, weights: readonly bigint[]): bigint[] {
  const sum = weights.reduce((acc, w) => acc + w, 0n);
  if (sum <= 0n) throw new Error("weights must sum to > 0n");
  const negative = total < 0n;
  const abs = negative ? -total : total;
  const parts: bigint[] = [];
  const remainders: Array<{ index: number; rem: bigint }> = [];
  let allocated = 0n;
  for (let i = 0; i < weights.length; i++) {
    const scaled = abs * weights[i]!;
    const part = scaled / sum;
    parts.push(part);
    allocated += part;
    remainders.push({ index: i, rem: scaled % sum });
  }
  let left = abs - allocated;
  remainders.sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1));
  for (const { index } of remainders) {
    if (left <= 0n) break;
    parts[index] = parts[index]! + 1n;
    left -= 1n;
  }
  return negative ? parts.map((p) => -p) : parts;
}

/** R5: split scaling (`num` new shares for `den` old), rounded per lot at the 8th place. */
export function scaleQty(qty: Fixed8, num: number, den: number): Fixed8 {
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) {
    throw new Error("split ratio must be two positive integers");
  }
  return roundDivHalfAway(qty * BigInt(num), BigInt(den));
}

/** A dollar amount held as Fixed8 → cents (half away from zero). */
export function fixed8ToCents(v: Fixed8): bigint {
  return roundDivHalfAway(v, FIXED8_PER_CENT);
}

/** Cents → Fixed8 dollars (exact). The cash security's "quantity". */
export function centsToFixed8(cents: bigint): Fixed8 {
  return cents * FIXED8_PER_CENT;
}

/**
 * Forgiving decimal parse for brokerage exports: "1,234.5", "$1,234.50", "(12.5)", "12.5-", "-12.5".
 * Undefined when unreadable, more than 8 fraction digits or more than 12 integer digits.
 */
export function parseLooseDecimal(raw: string): Fixed8 | undefined {
  let s = raw.trim();
  if (!s) return undefined;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (/\bDR\b/i.test(s)) negative = !negative;
  s = s.replace(/\b(CR|DR)\b/gi, "");
  s = s.replace(/[$€£,\s]/g, "");
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  if (s.startsWith("+")) s = s.slice(1);
  const m = /^(\d{0,12})(?:\.(\d{0,8}))?$/.exec(s);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return undefined;
  const value = BigInt(m[1] || "0") * FIXED8_SCALE + BigInt((m[2] ?? "").padEnd(8, "0"));
  return negative ? -value : value;
}

/**
 * A JSON number (a double) → Fixed8 through its shortest round-trip string.
 * Undefined on exponent form, more than 8 fraction digits, non-finite values and
 * integer parts beyond 12 digits; never rounded.
 */
export function fixed8FromJsonNumber(n: number): Fixed8 | undefined {
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  const text = String(n);
  if (!FIXED8_RE.test(text)) return undefined;
  return parseFixed8(text);
}

/** "0.03" (percent) → 300 ppm. The value must be a whole number of ppm, else throws. */
export function percentToPpm(s: string): number {
  const v = parseFixed8(s);
  const unit = 10_000n; // 1 ppm = 0.0001 % = 10 000 Fixed8 units of a percent
  if (v % unit !== 0n) throw new Error(`Not a whole number of ppm: "${s}"`);
  return Number(v / unit);
}

/** 300 ppm → "0.03" (percent). */
export function ppmToPercent(ppm: number): string {
  if (!Number.isInteger(ppm)) throw new Error("ppm must be an integer");
  return formatFixed8(BigInt(ppm) * 10_000n);
}

/** The trade preview and the lot engine agree on this band for "the amount matches quantity × price ± fee". */
export const AMOUNT_MISMATCH_TOLERANCE_CENTS = 5n;

export interface AmountCheck {
  /** The signed cash effect the quantity, price and fee imply. */
  expectedCents: bigint;
  /** Actual − expected. */
  diffCents: bigint;
  /** True when |diff| exceeds the 5-cent tolerance. */
  mismatch: boolean;
}

/**
 * The 5-cent check: does the signed `amountCents` match quantity × price ± fee?
 * A negative (or zero-with-fee) amount is a purchase: expected −(gross + fee); a positive
 * amount is a sale: expected gross − fee. A null fee counts as 0.
 */
export function amountMismatch(qty: Fixed8, price: Fixed8, feeCents: bigint | null, amountCents: bigint): AmountCheck {
  const gross = mulToCents(qty < 0n ? -qty : qty, price);
  const fee = feeCents ?? 0n;
  const expectedCents = amountCents < 0n ? -(gross + fee) : gross - fee;
  const diffCents = amountCents - expectedCents;
  const absDiff = diffCents < 0n ? -diffCents : diffCents;
  return { expectedCents, diffCents, mismatch: absDiff > AMOUNT_MISMATCH_TOLERANCE_CENTS };
}

/** The gate: an account value matches a statement "to the dollar" when |difference| < $1. */
export const RECONCILE_TOLERANCE_CENTS = 100n;

export function matchesToDollar(differenceCents: bigint): boolean {
  const abs = differenceCents < 0n ? -differenceCents : differenceCents;
  return abs < RECONCILE_TOLERANCE_CENTS;
}
