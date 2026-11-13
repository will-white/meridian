import { describe, expect, it } from "vitest";
import { decodeI16le, decodeI64le, encodeI16le, encodeI64le, rankIndex, rankPaths, selectPercentilePath } from "./percentile.js";
import { STORED_PERCENTILES } from "./primitives.js";
import { NEVER_DEPLETED } from "./results.js";

// The worked example of inputs-and-data §3.8, N = 10 (index: ending cents, depletion year).
const endings = () => BigInt64Array.from([0n, 500n, 0n, 300n, 1200n, 150n, 700n, 400n, 900n, 200n]);
const depletions = () => Int16Array.from([2051, -1, 2047, -1, -1, -1, -1, -1, -1, -1]);

describe("16. percentile paths and codecs (inputs-and-data §3.8, decision 22)", () => {
  it("16 the order is 2, 0, 5, 9, 3, 7, 1, 6, 8, 4", () => {
    expect([...rankPaths(endings(), depletions())]).toEqual([2, 0, 5, 9, 3, 7, 1, 6, 8, 4]);
  });

  it("16 percentiles 5, 10, 25, 50, 75, 90, 95 → ranks 0, 0, 2, 4, 7, 8, 9 → paths 2, 2, 5, 3, 6, 8, 4", () => {
    expect(STORED_PERCENTILES.map((p) => rankIndex(p, 10))).toEqual([0, 0, 2, 4, 7, 8, 9]);
    expect(STORED_PERCENTILES.map((p) => selectPercentilePath(endings(), depletions(), p))).toEqual([2, 2, 5, 3, 6, 8, 4]);
  });

  it("16 percentile 60 → rank ceilDiv(600, 100) − 1 = 5 → path 7; 1 → 2; 99 → 4", () => {
    expect(rankIndex(60, 10)).toBe(5);
    expect(selectPercentilePath(endings(), depletions(), 60)).toBe(7);
    expect(selectPercentilePath(endings(), depletions(), 1)).toBe(2);
    expect(selectPercentilePath(endings(), depletions(), 99)).toBe(4);
  });

  it("16 the listed rankIndex values", () => {
    expect(rankIndex(10, 10000)).toBe(999);
    expect(rankIndex(50, 10000)).toBe(4999);
    expect(rankIndex(90, 10000)).toBe(8999);
    expect(rankIndex(1, 100)).toBe(0);
    expect(rankIndex(99, 100)).toBe(98);
    expect(rankIndex(33, 250)).toBe(82);
    expect(rankIndex(10, 200)).toBe(19);
  });

  it("16 eight of ten paths never deplete", () => {
    expect([...depletions()].filter((y) => y === NEVER_DEPLETED)).toHaveLength(8);
  });

  it("16 encodeI64le of the ten endings is 80 bytes and round-trips", () => {
    const bytes = encodeI64le(endings());
    expect(bytes.byteLength).toBe(80);
    // Little-endian: path 1's 500 = 0x01F4 is bytes 8 and 9 as F4 01.
    expect([...bytes.subarray(8, 16)]).toEqual([0xf4, 0x01, 0, 0, 0, 0, 0, 0]);
    expect(decodeI64le(bytes)).toEqual(endings());
  });

  it("16 encodeI16le of the depletion years (−1 for the eight that never deplete) is 20 bytes and round-trips", () => {
    const bytes = encodeI16le(depletions());
    expect(bytes.byteLength).toBe(20);
    // 2051 = 0x0803 → 03 08; −1 → FF FF.
    expect([...bytes.subarray(0, 4)]).toEqual([0x03, 0x08, 0xff, 0xff]);
    expect(decodeI16le(bytes)).toEqual(depletions());
  });

  it("codecs: negative and extreme values, an offset view (a pooled Buffer), and bad lengths", () => {
    const extreme = BigInt64Array.from([-(2n ** 63n), 2n ** 63n - 1n, -1n, 0n]);
    expect(decodeI64le(encodeI64le(extreme))).toEqual(extreme);
    expect(decodeI64le(encodeI64le([5n, -7n]))).toEqual(BigInt64Array.from([5n, -7n]));
    const padded = new Uint8Array(3 + 16);
    padded.set(encodeI64le([42n, -42n]), 3);
    expect(decodeI64le(padded.subarray(3))).toEqual(BigInt64Array.from([42n, -42n]));
    const years = Int16Array.from([-32768, 32767, -1, 2026]);
    expect(decodeI16le(encodeI16le(years))).toEqual(years);
    expect(decodeI16le(Buffer.from(encodeI16le([2047, -1])))).toEqual(Int16Array.from([2047, -1]));
    expect(() => decodeI64le(new Uint8Array(7))).toThrow(RangeError);
    expect(() => decodeI16le(new Uint8Array(3))).toThrow(RangeError);
    expect(() => encodeI64le([2n ** 63n])).toThrow(RangeError);
    expect(() => encodeI16le([40000])).toThrow(RangeError);
    expect(() => encodeI16le([1.5])).toThrow(RangeError);
    expect(encodeI64le(new BigInt64Array(0)).byteLength).toBe(0);
  });

  it("rankIndex covers 0 and 100 (the engine's [0] and [100]) and refuses anything else", () => {
    expect(rankIndex(0, 10)).toBe(0);
    expect(rankIndex(100, 10)).toBe(9);
    expect(rankIndex(50, 1)).toBe(0);
    expect(() => rankIndex(101, 10)).toThrow(RangeError);
    expect(() => rankIndex(-1, 10)).toThrow(RangeError);
    expect(() => rankIndex(50.5, 10)).toThrow(RangeError);
    expect(() => rankIndex(50, 0)).toThrow(RangeError);
  });

  it("rankPaths refuses mismatched lengths and depletion years below −1", () => {
    expect(() => rankPaths(BigInt64Array.from([1n]), Int16Array.from([]))).toThrow(RangeError);
    expect(() => rankPaths(BigInt64Array.from([1n]), Int16Array.from([-2]))).toThrow(RangeError);
    expect([...rankPaths(new BigInt64Array(0), new Int16Array(0))]).toEqual([]);
  });
});

describe("OUT-1 rank rule (strategies-outputs-web §7.3, decision 25)", () => {
  // Plan start 2026: "failed in year 12" is depletion year 2038, "year 20" is 2046, "year 10" is 2036.
  it("OUT-1 failed in year 12 (ends 0), failed in year 20 (ends 0), then funded 100,000, 500,000, 900,000", () => {
    // Shuffled so the order is not the input order: indices 0..4 = 500,000; failed y20; 900,000; failed y12; 100,000.
    const ending = BigInt64Array.from([50_000_000n, 0n, 90_000_000n, 0n, 10_000_000n]);
    const depletion = Int16Array.from([-1, 2046, -1, 2038, -1]);
    expect([...rankPaths(ending, depletion)]).toEqual([3, 1, 4, 0, 2]);
    // N = 5: p10 → ceil(50/100) − 1 = 0; p50 → ceil(250/100) − 1 = 2; p90 → ceil(450/100) − 1 = 4.
    expect(selectPercentilePath(ending, depletion, 10)).toBe(3);
    expect(selectPercentilePath(ending, depletion, 50)).toBe(4);
    expect(selectPercentilePath(ending, depletion, 90)).toBe(2);
  });

  it("OUT-1 a path that failed in year 10 but ends with 50,000 ranks after both paths that end with 0", () => {
    const ending = BigInt64Array.from([50_000_000n, 0n, 90_000_000n, 0n, 10_000_000n, 5_000_000n]);
    const depletion = Int16Array.from([-1, 2046, -1, 2038, -1, 2036]);
    expect([...rankPaths(ending, depletion)]).toEqual([3, 1, 5, 4, 0, 2]);
  });

  it("ties on ending wealth and depletion year keep index order, and never-depleted sorts last among equal endings", () => {
    const ending = BigInt64Array.from([0n, 0n, 0n, 7n, 7n]);
    const depletion = Int16Array.from([-1, 2040, 2040, -1, -1]);
    expect([...rankPaths(ending, depletion)]).toEqual([1, 2, 0, 3, 4]);
  });
});
