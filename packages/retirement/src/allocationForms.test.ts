import { describe, expect, it } from "vitest";
import { detExp, detExpInPlace } from "./detmath.js";
import { doubleFields } from "./doubleFields.js";
import { PURPOSE, invNorm, invNormInPlace, seedKey, uniformAt, uniformsAt } from "./rng.js";
import { float64Bits } from "./selftest.js";

// The allocation-free forms added for the zero-GC budget of engine-and-returns §3.15 (T47's PERF=1
// garbage-collection row): array and out-record forms of functions that return or take doubles,
// because V8 boxes a double that crosses a call it does not inline. Each form must give the same
// bits as the scalar form it stands for, so the T41 digests and R1 to R4 cannot move.

const bits = (xs: ArrayLike<number>) => Array.from(xs, float64Bits);

describe("T3 and T4 the array forms of the generator", () => {
  it("T3 uniformsAt writes uniformAt(key, path, purpose, step, j) for slots 0 … count − 1, bit for bit", () => {
    const key = seedKey("20261110");
    const out = new Float64Array(6);
    for (const [path, step] of [[0, 0], [1, 59], [12345, 7], [4294967295, 65535]] as const) {
      uniformsAt(key, path, PURPOSE.MARKET, step, 4, out);
      const expected = [0, 1, 2, 3].map((j) => uniformAt(key, path, PURPOSE.MARKET, step, j));
      expect(bits(out.subarray(0, 4))).toEqual(bits(expected));
    }
    out.fill(7);
    uniformsAt(key, 3, PURPOSE.BOOT, 2, 2, out);
    expect(Array.from(out.subarray(2))).toEqual([7, 7, 7, 7]);
  });

  it("T4 invNormInPlace replaces values[start … start + count − 1] by invNorm of each, bit for bit (both tails and the centre)", () => {
    const us = [2 ** -53, 1e-10, 0.02425, 0.05, 0.075, 0.3, 0.5, 0.7, 0.925, 0.97575, 1 - 1e-10, 1 - 2 ** -53];
    const values = Float64Array.from([9, ...us, 9]);
    invNormInPlace(values, 1, us.length);
    expect(bits(values.subarray(1, 1 + us.length))).toEqual(bits(us.map(invNorm)));
    expect([values[0], values[us.length + 1]]).toEqual([9, 9]);
  });
});

describe("T5 the array form of detExp", () => {
  it("T5 detExpInPlace replaces each value by detExp of it, bit for bit (NaN, overflow, underflow and the two-factor scaling included)", () => {
    const xs = [Number.NaN, 0, -0, 1, -1, 0.5, 1e-300, 709.7, 709.79, 800, -708.5, -740, -745.1, -745.3, -1000, 0.0779, -0.312];
    const values = Float64Array.from(xs);
    detExpInPlace(values, 0, xs.length);
    expect(bits(values)).toEqual(bits(xs.map(detExp)));
    const part = Float64Array.from([1, 2, 3]);
    detExpInPlace(part, 1, 1);
    expect(bits(part)).toEqual(bits([1, detExp(2), 3]));
  });
});

describe("doubleFields", () => {
  it("leaves every value of the record as it was, -0 and NaN included", () => {
    const r = { a: 0, b: -0, c: 1.5, d: Number.NaN, e: 7, s: "x" };
    expect(doubleFields(r, ["a", "b", "c", "d", "e"])).toBe(r);
    expect(Object.is(r.a, 0)).toBe(true);
    expect(Object.is(r.b, -0)).toBe(true);
    expect(r.c).toBe(1.5);
    expect(Number.isNaN(r.d)).toBe(true);
    expect(r.e).toBe(7);
    expect(r.s).toBe("x");
    expect(Object.keys(r)).toEqual(["a", "b", "c", "d", "e", "s"]);
  });
});
