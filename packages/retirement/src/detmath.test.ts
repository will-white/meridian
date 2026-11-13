import { describe, expect, it } from "vitest";
import { detExp, detLog, detPow, powInt } from "./detmath.js";
import { float64Bits } from "./selftest.js";

// T5 (engine-and-returns §7): deterministic exp and log. Values and bit patterns are the design's;
// equality is exact (toBe compares with Object.is, so it is a bit-for-bit check for these values).

/** Distance in units in the last place between two finite doubles of the same sign. */
function ulpDistance(a: number, b: number): number {
  const view = new DataView(new ArrayBuffer(16));
  view.setFloat64(0, a, true);
  view.setFloat64(8, b, true);
  const ia = view.getBigInt64(0, true);
  const ib = view.getBigInt64(8, true);
  const d = ia > ib ? ia - ib : ib - ia;
  return Number(d);
}

/** A small seeded generator for test arguments (xorshift32; the engine's own generator is rng.ts). */
function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

describe("T5 deterministic exp and log", () => {
  it("T5 identities and stated values", () => {
    expect(detExp(0)).toBe(1);
    expect(detLog(1)).toBe(0);
    expect(detLog(2)).toBe(0.6931471805599453);
    expect(detExp(1)).toBe(2.7182818284590455);
    expect(detExp(-0.5)).toBe(0.6065306597126334);
    expect(detLog(1.07)).toBe(0.06765864847381485);
    expect(detExp(detLog(1.07))).toBe(1.07);
  });

  it("T5 bit patterns of detLog(2) and detExp(1); detExp(1) is one unit above Math.E", () => {
    expect(float64Bits(detLog(2))).toBe("3fe62e42fefa39ef");
    expect(float64Bits(detExp(1))).toBe("4005bf0a8b14576a");
    expect(float64Bits(Math.E)).toBe("4005bf0a8b145769");
  });

  it("T5 golden bit patterns", () => {
    expect(float64Bits(detExp(0.5))).toBe("3ffa61298e1e069c");
    expect(float64Bits(detExp(-1.25))).toBe("3fd25618372a584f");
    expect(float64Bits(detLog(1.07))).toBe("3fb15213c27c917f");
    expect(float64Bits(detLog(0.561625))).toBe("bfe27622d7f54a80");
  });

  it("T5 detPow at the part-year exponent 52/365", () => {
    // A check of detPow itself; the 52/365 day fraction is no longer a year-0 rule (seams C14),
    // but these are still the function's pinned values.
    expect(detPow(1.1, 52 / 365)).toBe(1.0136710422166744);
    expect(detPow(1.03, 52 / 365)).toBe(1.0042199962444256);
  });

  it("T5 edge cases of detLog", () => {
    expect(detLog(Infinity)).toBe(Infinity);
    expect(detLog(0)).toBe(-Infinity);
    expect(detLog(-0)).toBe(-Infinity);
    expect(detLog(-1)).toBeNaN();
    expect(detLog(NaN)).toBeNaN();
  });

  it("T5 edge cases of detExp: NaN, overflow, underflow, the two-factor scaling", () => {
    expect(detExp(NaN)).toBeNaN();
    expect(detExp(709.79)).toBe(Infinity);
    expect(detExp(Infinity)).toBe(Infinity);
    expect(detExp(-745.3)).toBe(0);
    expect(detExp(-Infinity)).toBe(0);
    // k = round(709.7 / ln 2) = 1024 > 1023: e^709.7 is finite and must come out finite.
    expect(Number.isFinite(detExp(709.7))).toBe(true);
    expect(ulpDistance(detExp(709.7), Math.exp(709.7))).toBeLessThanOrEqual(4);
    // k < −1022: a subnormal result, scaled in two factors.
    expect(detExp(-740)).toBeGreaterThan(0);
    expect(detExp(-740)).toBeLessThan(2.2250738585072014e-308);
  });

  it("T5 property: within 4 ulp of Math.exp on 100,000 seeded arguments", () => {
    const next = seeded(20261110);
    let worst = 0;
    for (let i = 0; i < 100_000; i++) {
      // Half the arguments in the range the engine uses (log returns), half across the normal range.
      const x = i % 2 === 0 ? (next() - 0.5) * 4 : -700 + next() * 1409;
      worst = Math.max(worst, ulpDistance(detExp(x), Math.exp(x)));
    }
    expect(worst).toBeLessThanOrEqual(4);
  });

  it("T5 property: within 4 ulp of Math.log on 100,000 seeded arguments", () => {
    const next = seeded(1311768467);
    let worst = 0;
    for (let i = 0; i < 100_000; i++) {
      // Half near 1 (growth factors), half across the whole normal range m × 2^e.
      const x = i % 2 === 0 ? 0.25 + next() * 3.75 : (1 + next()) * Math.pow(2, Math.floor(next() * 2045) - 1022);
      const a = detLog(x);
      const b = Math.log(x);
      if (a === 0 || b === 0) expect(a).toBe(b);
      else worst = Math.max(worst, ulpDistance(a, b));
    }
    expect(worst).toBeLessThanOrEqual(4);
  });

  it("powInt multiplies in order and returns 1 for n = 0", () => {
    expect(powInt(1.07, 0)).toBe(1);
    expect(powInt(1.07, 1)).toBe(1.07);
    expect(powInt(1.07, 3)).toBe(1.07 * 1.07 * 1.07);
    expect(powInt(2, 10)).toBe(1024);
    expect(powInt(-0.5, 3)).toBe(-0.125);
  });
});
