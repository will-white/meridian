import { describe, expect, it } from "vitest";
import { EngineInputError } from "./errors.js";
import { PURPOSE, counterWord, invNorm, seedKey, threefry2x32, uniformAt, uniformFromWords } from "./rng.js";
import { float64Bits } from "./selftest.js";

// Build step 12 (engine-and-returns §3.3, §7 T1 to T4; seams C5). Every expected value is the
// design's. They were also reproduced by an independent Python implementation written from the
// Random123 header and AS241 (scratchpad p4-rng/ref.py, run with python3 -I): T1's words, all of
// T3's words and uniforms, and T4's quantiles agree to the last digit.

const hex = (w: number) => (w >>> 0).toString(16).padStart(8, "0");
const KEY = seedKey("20261110");

function words(k0: number, k1: number, c0: number, c1: number): string {
  const out = new Uint32Array(2);
  threefry2x32(k0, k1, c0, c1, out);
  return `${hex(out[0]!)} ${hex(out[1]!)}`;
}

describe("T1 Threefry2x32-20 known answers (Random123 kat_vectors)", () => {
  it("T1 ctr (0, 0), key (0, 0) → 6b200159 99ba4efe", () => {
    expect(words(0, 0, 0, 0)).toBe("6b200159 99ba4efe");
  });
  it("T1 ctr (ffffffff, ffffffff), key (ffffffff, ffffffff) → 1cb996fc bb002be7", () => {
    expect(words(0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff)).toBe("1cb996fc bb002be7");
  });
  it("T1 ctr (243f6a88, 85a308d3), key (13198a2e, 03707344) → c4923a9c 483df7a0", () => {
    expect(words(0x13198a2e, 0x03707344, 0x243f6a88, 0x85a308d3)).toBe("c4923a9c 483df7a0");
  });
  it("writes unsigned words into the caller's array and allocates nothing else", () => {
    const out = new Uint32Array([7, 7]);
    threefry2x32(0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, out);
    expect(out[0]).toBe(0x1cb996fc);
    expect(out[1]).toBe(0xbb002be7);
  });
});

describe("T2 seed split and counter packing", () => {
  it("T2 '20261110' → k0 = 20261110 = 0x013528f6, k1 = 0", () => {
    expect(seedKey("20261110")).toEqual([20261110, 0]);
    expect(20261110).toBe(0x013528f6);
  });
  it("T2 '1311768467294899695' (0x1234567890abcdef) → k0 = 0x90abcdef, k1 = 0x12345678", () => {
    expect(seedKey("1311768467294899695")).toEqual([2427178479, 305419896]);
    expect([0x90abcdef, 0x12345678]).toEqual([2427178479, 305419896]);
  });
  it("T2 '18446744073709551615' → (4294967295, 4294967295); '18446744073709551616' → seed_invalid", () => {
    expect(seedKey("18446744073709551615")).toEqual([4294967295, 4294967295]);
    expect(() => seedKey("18446744073709551616")).toThrow(EngineInputError);
    try {
      seedKey("18446744073709551616");
    } catch (e) {
      expect((e as EngineInputError).code).toBe("seed_invalid");
    }
  });
  it("C5: the run seed is an integer 0 … 4294967295 and its key is (seed, 0)", () => {
    expect(seedKey(1)).toEqual([1, 0]);
    expect(seedKey(0)).toEqual([0, 0]);
    expect(seedKey(4294967295)).toEqual([4294967295, 0]);
    expect(seedKey(20261110)).toEqual(seedKey("20261110"));
    expect(seedKey(2n ** 32n + 5n)).toEqual([5, 1]);
  });
  it("seed_invalid for a negative, fractional or non-decimal seed", () => {
    for (const bad of [-1, 1.5, Number.NaN, 2 ** 53, "-1", "1e3", "0x10", "", " 1", "123456789012345678901", -1n]) {
      expect(() => seedKey(bad)).toThrow(EngineInputError);
    }
  });
  it("T2 purpose 3, step 258, slot 5 → c1 = 0x03010205; purpose 0, step 59, slot 3 → 0x00003b03", () => {
    expect(counterWord(3, 258, 5)).toBe(0x03010205);
    expect(counterWord(0, 59, 3)).toBe(0x00003b03);
    // A purpose with the top bit set stays an unsigned word.
    expect(counterWord(255, 65535, 255)).toBe(0xffffffff);
  });
  it("the purposes of §3.3: MARKET 0, BOOT 2, MORTALITY 3", () => {
    expect(PURPOSE).toEqual({ MARKET: 0, BOOT: 2, MORTALITY: 3 });
  });
});

describe("T3 stream outputs and the uniform (seed 20261110)", () => {
  const rows: Array<[number, number, number, number, string, number]> = [
    [0, PURPOSE.MARKET, 0, 0, "691cfdbf 6b6ad584", 0.4105986121237116],
    [0, PURPOSE.MARKET, 0, 1, "604c3d1f a52691e0", 0.3761633134651151],
    [0, PURPOSE.MARKET, 0, 2, "34c86542 793c9e14", 0.20618279983969334],
    [0, PURPOSE.MARKET, 0, 3, "a6550a56 0187d3c3", 0.6497351081070127],
    [1, PURPOSE.MARKET, 0, 0, "208659bb 02d6d548", 0.1270500125153452],
    [0, PURPOSE.MARKET, 1, 0, "3feaecd3 8549679f", 0.2496784257985848],
    [9999, PURPOSE.MARKET, 59, 3, "e9e4ab17 2d6f8a4e", 0.9136454489452127],
    [0, PURPOSE.BOOT, 0, 0, "b790d2ed cd15d199", 0.7170535892414179],
    [0, PURPOSE.BOOT, 0, 1, "cf9cc367 eeef446a", 0.8109857728084687],
    [0, PURPOSE.MORTALITY, 0, 0, "f76c6ff5 23f7e8d1", 0.9664983621314399],
    [0, PURPOSE.MORTALITY, 0, 1, "a5c4e7ba 3b781db8", 0.6475357745930787],
  ];
  for (const [path, purpose, step, slot, w, u] of rows) {
    it(`T3 path ${path}, purpose ${purpose}, step ${step}, slot ${slot} → ${w}, u = ${u}`, () => {
      expect(words(KEY[0], KEY[1], path, counterWord(purpose, step, slot))).toBe(w);
      expect(uniformAt(KEY, path, purpose, step, slot)).toBe(u);
    });
  }

  it("T3 first row by hand: n = 27554806 × 2^26 + 28158806 = 1849171756559190", () => {
    expect(0x691cfdbf >>> 6).toBe(27554806);
    expect(0x6b6ad584 >>> 6).toBe(28158806);
    expect(27554806 * 67108864 + 28158806).toBe(1849171756559190);
    expect((1849171756559190 + 0.5) / 2 ** 52).toBe(0.4105986121237116);
    expect(uniformFromWords(0x691cfdbf, 0x6b6ad584)).toBe(0.4105986121237116);
  });

  it("T3 edges: (0, 0) → 2^−53 = 1.1102230246251565e-16; (ffffffff, ffffffff) → 0.9999999999999999; (80000000, 0) → 0.5000000000000001", () => {
    expect(uniformFromWords(0, 0)).toBe(1.1102230246251565e-16);
    expect(uniformFromWords(0, 0)).toBe(2 ** -53);
    expect(uniformFromWords(0xffffffff, 0xffffffff)).toBe(0.9999999999999999);
    expect(uniformFromWords(0xffffffff, 0xffffffff)).toBe(1 - 2 ** -53);
    expect(uniformFromWords(0x80000000, 0)).toBe(0.5000000000000001);
  });

  it("uniforms lie strictly inside (0, 1) and are symmetric: u(words) + u(~words) = 1 exactly", () => {
    for (let k = 0; k < 2000; k++) {
      const out = new Uint32Array(2);
      threefry2x32(KEY[0], KEY[1], k, counterWord(PURPOSE.MARKET, k % 61, k % 4), out);
      const u = uniformFromWords(out[0]!, out[1]!);
      expect(u > 0 && u < 1).toBe(true);
      expect(u + uniformFromWords(~out[0]! >>> 0, ~out[1]! >>> 0)).toBe(1);
    }
  });

  it("a draw depends only on its address (no hidden state between calls)", () => {
    const a = uniformAt(KEY, 123, PURPOSE.MARKET, 7, 2);
    uniformAt(KEY, 5, PURPOSE.BOOT, 1, 0);
    expect(uniformAt(KEY, 123, PURPOSE.MARKET, 7, 2)).toBe(a);
  });
});

describe("T4 inverse normal (AS241 PPND16)", () => {
  it("T4 stated quantiles", () => {
    expect(invNorm(0.975)).toBe(1.9599639845400536);
    expect(invNorm(0.025)).toBe(-1.9599639845400538);
    expect(invNorm(0.5)).toBe(0);
    expect(invNorm(0.9)).toBe(1.2815515655446008);
    expect(invNorm(0.3)).toBe(-0.5244005127080407);
    expect(invNorm(0.001)).toBe(-3.090232306167813);
    expect(invNorm(1e-10)).toBe(-6.361340902404056);
    expect(invNorm(0.01)).toBe(-2.3263478740408408);
    expect(float64Bits(invNorm(0.01))).toBe("c0029c5c4630ff0e");
    expect(invNorm(2 ** -53)).toBe(-8.209536151601386);
  });

  it("T4 branch boundary: 0.075 − 0.5 is exactly −0.425 (central branch); 0.07 is the first tail value", () => {
    expect(0.075 - 0.5).toBe(-0.425);
    expect(invNorm(0.075)).toBe(-1.4395314709384557);
    expect(invNorm(0.07)).toBe(-1.4757910281791702);
  });

  it("T4 the four MARKET normals of path 0, year 0, and the tail value of T3's mortality uniform", () => {
    const z = [0, 1, 2, 3].map((slot) => invNorm(uniformAt(KEY, 0, PURPOSE.MARKET, 0, slot)));
    expect(z).toEqual([-0.22600539504450393, -0.31557300938964367, -0.8197377940839978, 0.3846054120421159]);
    expect(float64Bits(z[2]!)).toBe("bfea3b4ac11c59ba");
    expect(invNorm(0.9664983621314399)).toBe(1.8316520570794343);
  });

  it("T4 property: invNorm(u) = −invNorm(1 − u) exactly for the uniforms of paths 0..999 at (MARKET, 0, 0)", () => {
    for (let path = 0; path < 1000; path++) {
      const u = uniformAt(KEY, path, PURPOSE.MARKET, 0, 0);
      expect(invNorm(u)).toBe(-invNorm(1 - u));
    }
  });

  it("monotone in u across both branch boundaries and the far tail", () => {
    const us = [2 ** -53, 1e-15, 1e-12, 1e-6, 0.01, 0.0749999999, 0.075, 0.0750000001, 0.3, 0.5, 0.7, 0.925, 0.9250000001, 0.99, 1 - 2 ** -53];
    for (let i = 1; i < us.length; i++) expect(invNorm(us[i]!)).toBeGreaterThan(invNorm(us[i - 1]!));
    // The far tail (r > 5) is reached below about 1.4e-11; CPython's NormalDist().inv_cdf (the same
    // routine with the platform log) gives -7.034483825301132 at 1e-12.
    expect(invNorm(1e-12)).toBeCloseTo(-7.034483825301132, 12);
  });
});
