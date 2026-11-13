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
