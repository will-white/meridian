/**
 * Deterministic exponential and logarithm (engine-and-returns §3.4, §3.14).
 *
 * ECMAScript fixes the result of `+ − × ÷` (IEEE 754 binary64, round to nearest, no fused
 * multiply-add) and of `Math.sqrt` (correctly rounded), but leaves `Math.exp`, `Math.log`,
 * `Math.pow` and `**` implementation-approximated: their last bit may change with the CPU, the Node
 * version or the browser. The engine therefore never calls them (the root ESLint block and
 * `determinism.test.ts` enforce it) and uses these functions instead, written only with the exact
 * operations. Their bit patterns are part of the contract (T5), so the order of every operation
 * below is fixed: do not "simplify" an expression here without re-pinning T5 and bumping
 * ENGINE_VERSION.
 *
 * Constants are decimal literals in shortest round-trip form or quotients of exact integers; none
 * comes from `Math.E`, `Math.LN2` or `Math.pow` (§3.14 item 2).
 *
 * The special results are `Number.NaN` and `Number.POSITIVE_INFINITY`, never the globals `NaN` and
 * `Infinity`: with a global among its results V8 gives an inlined `detExp` or `detLog` a boxed
 * result, one heap number per call (measured: 16 bytes a call through `detExpInPlace`, none with
 * `Number.NaN`). The values are the same.
 */

const LN2_HI = 6.93147180369123816490e-01;
const LN2_LO = 1.90821492927058770002e-10;
const SQRT2 = 1.4142135623730951;
const SQRT1_2 = 0.7071067811865476;
const INV_LN2 = 1.4426950408889634;

/** Offset of 2^0 in `POW2`: `POW2[k + POW2_ZERO] = 2^k` for k = −1074 … 1023. */
const POW2_ZERO = 1074;

/**
 * Every power of two a binary64 can hold, built by repeated doubling and halving from 1. Each step
 * is exact (a power of two times 2 or 0.5 is representable down to the smallest subnormal 2^−1074).
 */
const POW2: Float64Array = (() => {
  const table = new Float64Array(POW2_ZERO + 1024);
  let v = 1;
  table[POW2_ZERO] = v;
  for (let k = 1; k <= 1023; k++) {
    v *= 2;
    table[POW2_ZERO + k] = v;
  }
  v = 1;
  for (let k = -1; k >= -1074; k--) {
    v *= 0.5;
    table[POW2_ZERO + k] = v;
  }
  return table;
})();

/** 2^k for an integer k in −1074 … 1023. */
function pow2(k: number): number {
  return POW2[k + POW2_ZERO]!;
}

/**
 * Natural logarithm. Reduces x to [1/√2, √2) by exact halving or doubling (x = m·2^k), then
 * ln m = 2·atanh(s) with s = (m − 1)/(m + 1), summed to twelve terms.
 */
export function detLog(x: number): number {
  if (!(x > 0)) return x === 0 ? Number.NEGATIVE_INFINITY : Number.NaN;
  if (x === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  let k = 0;
  while (x >= SQRT2) {
    x *= 0.5;
    k++;
  }
  while (x < SQRT1_2) {
    x *= 2;
    k--;
  }
  const s = (x - 1) / (x + 1);
  const z = s * s;
  let p = 1 / 25;
  p = 1 / 23 + z * p;
  p = 1 / 21 + z * p;
  p = 1 / 19 + z * p;
  p = 1 / 17 + z * p;
  p = 1 / 15 + z * p;
  p = 1 / 13 + z * p;
  p = 1 / 11 + z * p;
  p = 1 / 9 + z * p;
  p = 1 / 7 + z * p;
  p = 1 / 5 + z * p;
  p = 1 / 3 + z * p;
  const r = 2 * s + 2 * s * z * p;
  return k * LN2_HI + (r + k * LN2_LO);
}

/**
 * Exponential. Reduces by a two-part ln 2 (x = k·ln 2 + r, |r| ≤ ln 2 / 2), sums the Taylor series
 * of e^r to degree 14 and scales by 2^k from the exact table, in two factors where 2^k alone would
 * overflow or underflow.
 */
export function detExp(x: number): number {
  if (x !== x) return Number.NaN;
  if (x > 709.78) return Number.POSITIVE_INFINITY;
  if (x < -745.2) return 0;
  const k = Math.round(x * INV_LN2);
  const r = (x - k * LN2_HI) - k * LN2_LO;
  let p = 1 / 87178291200;
  p = 1 / 6227020800 + r * p;
  p = 1 / 479001600 + r * p;
  p = 1 / 39916800 + r * p;
  p = 1 / 3628800 + r * p;
  p = 1 / 362880 + r * p;
  p = 1 / 40320 + r * p;
  p = 1 / 5040 + r * p;
  p = 1 / 720 + r * p;
  p = 1 / 120 + r * p;
  p = 1 / 24 + r * p;
  p = 1 / 6 + r * p;
  p = 0.5 + r * p;
  const e = 1 + (r + r * r * p);
  if (k > 1023) return e * pow2(1023) * pow2(k - 1023);
  if (k < -1022) return e * pow2(k + 1022) * pow2(-1022);
  return e * pow2(k);
}

/**
 * `values[i] = detExp(values[i])` for i in [start, start + count): the array form the return models
 * use, because a double passed to or returned from a call V8 does not inline is boxed (a heap
 * number each way); the same operations on the same values, so the same bits.
 */
export function detExpInPlace(values: Float64Array, start: number, count: number): void {
  for (let i = start; i < start + count; i++) values[i] = detExp(values[i]!);
}

/** x^y for x > 0 as `detExp(y × detLog(x))` (no `Math.pow`, no `**`). */
export function detPow(x: number, y: number): number {
  return detExp(y * detLog(x));
}

/** x^n for a whole n ≥ 0 by n multiplications, starting from 1 and in order (n = 0 gives 1). */
export function powInt(x: number, n: number): number {
  let r = 1;
  for (let i = 0; i < n; i++) r *= x;
  return r;
}
