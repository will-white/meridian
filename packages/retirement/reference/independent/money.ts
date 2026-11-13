// Rounding of printed figures, transcribed from the reference sheets (r1.md §2.12, r2.md §2.13):
// each cell is the unrounded float64 value rounded half away from zero to the cent,
// `sign(x) × floor(|x| × 100 + 0.5 + 1e−7)`. Written for the independent calculator only; it
// shares no code with packages/retirement/src.

/** Dollars to integer cents, half away from zero with the sheets' 1e−7 guard. */
export function cents(x: number): number {
  if (!Number.isFinite(x)) throw new RangeError(`not a finite amount: ${x}`);
  const magnitude = Math.floor(Math.abs(x) * 100 + 0.5 + 1e-7);
  return x < 0 ? -magnitude : magnitude;
}

/** Dollars printed with two decimals and no thousands separator (the CSV form). */
export function money(x: number): string {
  const c = cents(x);
  if (c === 0) return "0.00";
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100);
  const frac = abs - whole * 100;
  return `${c < 0 ? "-" : ""}${whole}.${String(frac).padStart(2, "0")}`;
}

/** Dollars rounded to the cent, as a JSON number. */
export function dollars2(x: number): number {
  return cents(x) / 100;
}

/** A ratio to whole basis points, half away from zero (r1.md §2.11, r2.md §2.11). */
export function basisPoints(ratio: number): number {
  if (!Number.isFinite(ratio)) throw new RangeError(`not a finite ratio: ${ratio}`);
  const magnitude = Math.floor(Math.abs(ratio) * 10000 + 0.5);
  return ratio < 0 ? -magnitude : magnitude;
}
