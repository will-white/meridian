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

/**
 * A price level (today = 1) as the nine-decimal fixed-point string the stored year rows carry
 * (seams C43, shared `PriceLevel`): 1.025 → "1.025000000", 1.0768906249999999 → "1.076890625".
 * Rounded half away from zero at the ninth decimal; a level must be finite and above 0.
 */
export function priceLevelString(level: number): string {
  if (!(level > 0) || !Number.isFinite(level)) {
    throw new EngineInvariantError("price_level_invalid", `a price level must be finite and above 0, got ${level}`);
  }
  const scaled = scaledHalfAway(level, PRICE_LEVEL_SCALE, "a price level");
  if (!Number.isSafeInteger(scaled) || scaled < 1) {
    throw new EngineInvariantError("price_level_invalid", `the price level ${level} does not fit nine decimals`);
  }
  const whole = Math.floor(scaled / PRICE_LEVEL_SCALE);
  const fraction = String(scaled - whole * PRICE_LEVEL_SCALE).padStart(9, "0");
  return `${whole}.${fraction}`;
}
