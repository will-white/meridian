/**
 * The engine's random numbers (engine-and-returns decision 20 and §3.3; seams C5; L5).
 *
 * A counter-based generator: Threefry2x32 with 20 rounds (Salmon, Moraes, Dror and Shaw, "Parallel
 * random numbers: as easy as 1, 2, 3", SC11; the Random123 reference). Every draw is addressed by
 * (key, path, purpose, step, slot), so path k is the same for any thread count, chunking or order,
 * one path can be re-simulated alone, and a market draw does not depend on the horizon, the
 * strategy or the mortality mode (two scenarios with one seed see identical markets).
 *
 * - Key: `(seed mod 2^32, floor(seed / 2^32))`. The run seed is `RunSettings.seed`, an integer
 *   0 … 4294967295 (seams C5), so the key is `(seed, 0)`; `seedKey` also takes a decimal string of
 *   any unsigned 64-bit value for the known-answer tests.
 * - Counter: `c0 = path index`, `c1 = purpose · 2^24 + step · 2^8 + slot` (step < 65,536, slot < 256).
 * - Uniform: 52 bits of one block, `u = (n + 0.5) / 2^52`, in [2^−53, 1 − 2^−53]: never 0 or 1 and
 *   symmetric about 0.5; the sum and the division are exact.
 * - Normal: Wichura's AS241 (PPND16) inverse normal CDF of one uniform, with `detLog` in the tails;
 *   no rejection, so every normal is addressable and monotone in its uniform.
 *
 * All word arithmetic is exact in JavaScript (32-bit adds, rotates and xors), so the streams are the
 * same on every machine. Nothing here allocates per draw.
 */

import { detLog } from "./detmath.js";
import { EngineInputError } from "./errors.js";

/** What a draw is for: the `purpose` field of the counter (§3.3's table). 1 and 4 … 15 are reserved for the engine; 16 … 255 are free for later hooks. */
export const PURPOSE = {
  /** Step = plan year; slots 0 stocks, 1 bonds, 2 bills, 3 inflation (the parametric model's normals). */
  MARKET: 0,
  /** Step = plan year; slot 0 the new-block decision, 1 the block's start row (the bootstrap). */
  BOOT: 2,
  /** Step 0; slot = person index (one death draw per person per path). */
  MORTALITY: 3,
} as const;
export type Purpose = (typeof PURPOSE)[keyof typeof PURPOSE];

/** The generator key: the seed's low and high 32-bit words. */
export type RngKey = readonly [number, number];

const ROTATIONS = [13, 15, 26, 6, 17, 29, 16, 24] as const;
const SKEIN_PARITY = 0x1bd11bda;
const TWO_POW_26 = 67108864;
/** 2^−52, an exact power of two. */
const TWO_POW_MINUS_52 = 1 / 4503599627370496;
const TWO_POW_32 = 4294967296n;
const MAX_SEED = 18446744073709551615n;

function rotl32(x: number, r: number): number {
  return (x << r) | (x >>> (32 - r));
}

/**
 * Threefry2x32-20 of the counter (c0, c1) under the key (k0, k1); writes the two output words to
 * `out[0]`, `out[1]` as unsigned 32-bit integers. Inputs are taken modulo 2^32.
 */
export function threefry2x32(k0: number, k1: number, c0: number, c1: number, out: Uint32Array): void {
  const ks0 = k0 | 0;
  const ks1 = k1 | 0;
  const ks2 = SKEIN_PARITY ^ ks0 ^ ks1;
  let x0 = (c0 + ks0) | 0;
  let x1 = (c1 + ks1) | 0;
  for (let r = 0; r < 20; r++) {
    x0 = (x0 + x1) | 0;
    x1 = rotl32(x1, ROTATIONS[r & 7]!);
    x1 ^= x0;
    if ((r & 3) === 3) {
      // Key injection s = 1 … 5 after rounds 4, 8, 12, 16 and 20.
      const s = (r + 1) >> 2;
      const m = s % 3;
      x0 = (x0 + (m === 0 ? ks0 : m === 1 ? ks1 : ks2)) | 0;
      x1 = (x1 + (m === 0 ? ks1 : m === 1 ? ks2 : ks0) + s) | 0;
    }
  }
  out[0] = x0 >>> 0;
  out[1] = x1 >>> 0;
}

/**
 * The key of a seed: `[seed mod 2^32, floor(seed / 2^32)]`. Takes a safe integer, a bigint or a
 * decimal string of an unsigned 64-bit value; anything else (negative, fractional, above 2^64 − 1,
 * not decimal) is `EngineInputError("seed_invalid")`.
 */
export function seedKey(seed: number | bigint | string): RngKey {
  let value: bigint;
  if (typeof seed === "number") {
    if (!Number.isSafeInteger(seed) || seed < 0) throw seedInvalid(seed);
    value = BigInt(seed);
  } else if (typeof seed === "bigint") {
    value = seed;
  } else {
    if (!/^\d{1,20}$/.test(seed)) throw seedInvalid(seed);
    value = BigInt(seed);
  }
  if (value < 0n || value > MAX_SEED) throw seedInvalid(seed);
  return [Number(value % TWO_POW_32), Number(value / TWO_POW_32)];
}

function seedInvalid(seed: unknown): EngineInputError {
  return new EngineInputError("seed_invalid", `the seed must be an unsigned 64-bit integer, got ${String(seed)}`);
}

/**
 * The counter's second word, `purpose · 2^24 + step · 2^8 + slot`, for purpose < 256, step < 65,536
 * and slot < 256 (the caller's contract; the fields would overlap otherwise).
 */
export function counterWord(purpose: number, step: number, slot: number): number {
  return ((purpose << 24) | (step << 8) | slot) >>> 0;
}

/** The uniform of one output block: `n = (x0 >>> 6) · 2^26 + (x1 >>> 6)`, `u = (n + 0.5) / 2^52`. */
export function uniformFromWords(x0: number, x1: number): number {
  const n = (x0 >>> 6) * TWO_POW_26 + (x1 >>> 6);
  return (n + 0.5) * TWO_POW_MINUS_52;
}

/** Scratch for `uniformAt`: one module instance per thread, so no draw allocates. */
const WORDS = new Uint32Array(2);

/** The uniform at (path, purpose, step, slot) under `key`, in [2^−53, 1 − 2^−53]. */
export function uniformAt(key: RngKey, path: number, purpose: number, step: number, slot: number): number {
  threefry2x32(key[0], key[1], path, counterWord(purpose, step, slot), WORDS);
  return uniformFromWords(WORDS[0]!, WORDS[1]!);
}

/**
 * `out[j] = uniformAt(key, path, purpose, step, j)` for the slots j = 0 … count − 1: one step's
 * draws written to an array. The return models' form: a double returned from a call V8 does not
 * inline is boxed (a heap number per draw), and this writes its results where the caller reads them.
 */
export function uniformsAt(key: RngKey, path: number, purpose: number, step: number, count: number, out: Float64Array): void {
  for (let j = 0; j < count; j++) {
    threefry2x32(key[0], key[1], path, counterWord(purpose, step, j), WORDS);
    out[j] = uniformFromWords(WORDS[0]!, WORDS[1]!);
  }
}

// AS241 (Wichura, "Algorithm AS 241: The Percentage Points of the Normal Distribution", Applied
// Statistics 37(3), 1988), routine PPND16, as in CPython's statistics.NormalDist.inv_cdf and R's
// qnorm.c. Coefficients from the constant term c[0] up to c[7].
const A = [
  3.3871328727963666080e0, 1.3314166789178437745e+2, 1.9715909503065514427e+3, 1.3731693765509461125e+4,
  4.5921953931549871457e+4, 6.7265770927008700853e+4, 3.3430575583588128105e+4, 2.5090809287301226727e+3,
] as const;
const B = [
  1, 4.2313330701600911252e+1, 6.8718700749205790830e+2, 5.3941960214247511077e+3,
  2.1213794301586595867e+4, 3.9307895800092710610e+4, 2.8729085735721942674e+4, 5.2264952788528545610e+3,
] as const;
const C = [
  1.42343711074968357734e0, 4.63033784615654529590e0, 5.76949722146069140550e0, 3.64784832476320460504e0,
  1.27045825245236838258e0, 2.41780725177450611770e-1, 2.27238449892691845833e-2, 7.74545014278341407640e-4,
] as const;
const D = [
  1, 2.05319162663775882187e0, 1.67638483018380384940e0, 6.89767334985100004550e-1,
  1.48103976427480074590e-1, 1.51986665636164571966e-2, 5.47593808499534494600e-4, 1.05075007164441684324e-9,
] as const;
const E = [
  6.65790464350110377720e0, 5.46378491116411436990e0, 1.78482653991729133580e0, 2.96560571828504891230e-1,
  2.65321895265761230930e-2, 1.24266094738807843860e-3, 2.71155556874348757815e-5, 2.01033439929228813265e-7,
] as const;
const F = [
  1, 5.99832206555887937690e-1, 1.36929880922735805310e-1, 1.48753612908506148525e-2,
  7.86869131145613259100e-4, 1.84631831751005468180e-5, 1.42151175831644588870e-7, 2.04426310338993978564e-15,
] as const;

/** A degree-7 polynomial by Horner from the highest coefficient: v = c[7]; v = v·r + c[i] for i = 6 … 0. */
function poly7(c: readonly number[], r: number): number {
  let v = c[7]!;
  for (let i = 6; i >= 0; i--) v = v * r + c[i]!;
  return v;
}

/**
 * The standard normal quantile of u in (0, 1) (AS241 PPND16). The central branch covers
 * |u − 0.5| ≤ 0.425; the tails use `detLog`. The largest |z| on the generator's grid is
 * 8.209536151601386 (u = 2^−53).
 */
export function invNorm(u: number): number {
  const q = u - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    return (q * poly7(A, r)) / poly7(B, r);
  }
  let r = Math.sqrt(-detLog(q < 0 ? u : 1 - u));
  let z: number;
  if (r <= 5) {
    r -= 1.6;
    z = poly7(C, r) / poly7(D, r);
  } else {
    r -= 5;
    z = poly7(E, r) / poly7(F, r);
  }
  return q < 0 ? -z : z;
}

/** `values[i] = invNorm(values[i])` for i in [start, start + count): the array form of `invNorm` (see `uniformsAt`). */
export function invNormInPlace(values: Float64Array, start: number, count: number): void {
  for (let i = start; i < start + count; i++) values[i] = invNorm(values[i]!);
}
