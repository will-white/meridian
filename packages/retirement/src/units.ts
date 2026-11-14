/**
 * The cents boundary (L1, seams C38).
 *
 * Inside the engine money is float64 dollars; outside it is integer cents. This file is the only
 * place where one becomes the other: inputs are converted once on the way in (`centsToDollars`),
 * results once on the way out (`dollarsToCents` / `dollarsToCentsBigInt`), rounded half away from
 * zero with a 1e-7 guard so that a value such as 1.005, whose binary64 form lies just below the
 * half cent, still rounds up (1.005 → 101 cents; the unguarded `floor(|x| × 100 + 0.5)` gives 100).
 *
 * The guarded form is the one both designs' cases agree on: the engine's T39 and the tax area's K9.
 */

import { EngineInputError, EngineInvariantError } from "./errors.js";

const CENTS_STRING = /^-?\d+$/;

/** Integer cents (a decimal string as stored in `SimInput`, or a bigint) to float64 dollars: `Number(c) / 100`. */
export function centsToDollars(c: string | bigint): number {
  if (typeof c === "string" && !CENTS_STRING.test(c)) {
    throw new EngineInputError("cents_invalid", `not an integer number of cents: ${JSON.stringify(c)}`);
  }
  return Number(c) / 100;
}

/**
 * Float64 dollars to integer cents, half away from zero: `sign(x) × floor(|x| × 100 + 0.5 + 1e-7)`.
 * Negative zero is 0. A non-finite amount is an engine fault and throws.
 */
export function dollarsToCentsBigInt(x: number): bigint {
  if (!Number.isFinite(x)) {
    throw new EngineInvariantError("non_finite_amount", `cannot convert ${x} dollars to cents`);
  }
  const magnitude = BigInt(Math.floor(Math.abs(x) * 100 + 0.5 + 1e-7));
  return x < 0 ? -magnitude : magnitude;
}

/** The same rounding as `dollarsToCentsBigInt`, as a decimal string ("-0" never occurs). */
export function dollarsToCents(x: number): string {
  return dollarsToCentsBigInt(x).toString();
}

/**
 * `x × scale` rounded half away from zero to an integer, with the same 1e-7 guard as cents: the
 * boundary form of a ratio computed inside the engine from float64 (seams C44, plan decision 15).
 * Negative zero is 0. A non-finite ratio is an engine fault and throws.
 */
function scaledHalfAway(x: number, scale: number, what: string): number {
  if (!Number.isFinite(x)) {
    throw new EngineInvariantError("non_finite_amount", `cannot convert ${x} to ${what}`);
  }
  const magnitude = Math.floor(Math.abs(x) * scale + 0.5 + 1e-7);
  return magnitude === 0 ? 0 : x < 0 ? -magnitude : magnitude;
}

/** A ratio (a fraction) in whole basis points, half away from zero (C44): 0.06854525… → 685. */
export function ratioToBp(x: number): number {
  return scaledHalfAway(x, 10_000, "basis points");
}

/** A fraction in whole parts per million, half away from zero: 3/12 → 250000, 1/12 → 83333. */
export function ratioToPpm(x: number): number {
  return scaledHalfAway(x, 1_000_000, "parts per million");
}

/** Digits after the point of a stored price level (seams C43; shared `PRICE_LEVEL_DECIMALS`). */
const PRICE_LEVEL_SCALE = 1_000_000_000;
const PRICE_LEVEL_DIGITS = 9;
/** Below this scaled level (2^53) `level × 1e9 + 0.5 + 1e-7` is an integer-exact float64. */
const FLOAT_SCALED_LIMIT = 9_007_199_254_740_992;

/**
 * `level × 10^9` rounded half away from zero with the 1e-7 guard, computed exactly on the double's
 * binary value `m × 2^e` (as bigints): `floor(level × 10^9 + 0.5 + 1e-7)`.
 */
function exactScaledLevel(level: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, level);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  const fraction = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  // A normal double is (2^52 + fraction) × 2^(biased − 1075); a subnormal one fraction × 2^−1074.
  const m = biased === 0 ? fraction : fraction | (1n << 52n);
  const e = biased === 0 ? -1074 : biased - 1075;
  const num = m * BigInt(PRICE_LEVEL_SCALE);
  if (e >= 0) return num << BigInt(e);
  // floor(num / 2^k + 5000001 / 10^7) = floor((num × 10^7 + 5000001 × 2^k) / (2^k × 10^7)).
  const den = 1n << BigInt(-e);
  return (num * 10_000_000n + 5_000_001n * den) / (den * 10_000_000n);
}

/**
 * A price level (today = 1) as the nine-decimal fixed-point string the stored year rows carry
 * (seams C43, shared `PriceLevel`): 1.025 → "1.025000000", 1.0768906249999999 → "1.076890625".
 * Rounded half away from zero at the ninth decimal with the 1e-7 guard of the cents rule (C38).
 *
 * Every finite level is written exactly (the shared form holds up to 309 integer digits, the
 * range of a float64): below 9,007,199 by the float form, above it on the double's exact binary
 * value, so a valid input whose inflation runs far (a custom parametric model at 100% a year, the
 * fixed model at +200%) is stored, never refused late (seams C13; the job re-simulates the stored
 * percentiles with simulatePath, C8). A level that rounds to 0 (below 0.5 × 10^−9: deflation of
 * that order only arises from a deflating fixed or custom model over decades) is held at
 * 0.000000001, the smallest positive level the form has; the engine's own real figures are
 * computed in float64 and are unaffected. A level that is not finite or not above 0 is an engine
 * fault.
 */
export function priceLevelString(level: number): string {
  if (!(level > 0) || !Number.isFinite(level)) {
    throw new EngineInvariantError("price_level_invalid", `a price level must be finite and above 0, got ${level}`);
  }
  const product = level * PRICE_LEVEL_SCALE + 0.5 + 1e-7;
  let digits: string;
  if (product < FLOAT_SCALED_LIMIT) {
    const scaled = Math.floor(product);
    digits = String(scaled < 1 ? 1 : scaled);
  } else {
    digits = exactScaledLevel(level).toString();
  }
  digits = digits.padStart(PRICE_LEVEL_DIGITS + 1, "0");
  return `${digits.slice(0, -PRICE_LEVEL_DIGITS)}.${digits.slice(-PRICE_LEVEL_DIGITS)}`;
}
