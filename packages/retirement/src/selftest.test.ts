import { describe, expect, it } from "vitest";
import { detExp, detLog } from "./detmath.js";
import { EngineRuntimeError } from "./errors.js";
import { invNorm, threefry2x32 } from "./rng.js";
import { float64Bits, selfTest } from "./selftest.js";

describe("T46 self-test", () => {
  it("T46 selfTest() passes on this machine", () => {
    expect(() => selfTest()).not.toThrow();
  });

  it("T46 with detExp replaced by Math.exp it throws self_test_failed (the two differ at detExp(1))", () => {
    expect(detExp(1)).not.toBe(Math.exp(1));
    let caught: unknown;
    try {
      selfTest({ detExp: Math.exp, detLog, sqrt: Math.sqrt });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EngineRuntimeError);
    const err = caught as EngineRuntimeError;
    expect(err.code).toBe("self_test_failed");
    expect(err.permanent).toBe(true);
    expect(err.name).toBe("EngineRuntimeError");
    expect(err.message).toContain("detExp(1)");
  });

  it("a square root one unit off is caught too", () => {
    const off = (x: number) => (x === 2 ? 1.4142135623730954 : Math.sqrt(x));
    expect(() => selfTest({ detExp, detLog, sqrt: off })).toThrow(/Math\.sqrt\(2\)/);
  });

  it("T46 step 12: a Threefry that skips the last key injection, or an inverse normal one unit off, is caught", () => {
    const broken = (k0: number, k1: number, c0: number, c1: number, out: Uint32Array) => {
      threefry2x32(k0, k1, c0, c1, out);
      out[0] = (out[0]! ^ 1) >>> 0;
    };
    expect(() => selfTest({ detExp, detLog, sqrt: Math.sqrt, threefry2x32: broken })).toThrow(/threefry2x32 of counter 00000000 00000000/);
    const offByOne = (u: number) => (u === 0.975 ? 1.9599639845400538 : invNorm(u));
    expect(() => selfTest({ detExp, detLog, sqrt: Math.sqrt, invNorm: offByOne })).toThrow(/invNorm\(0\.975\)/);
    expect(() => selfTest({ detExp, detLog, sqrt: Math.sqrt, invNorm, threefry2x32 })).not.toThrow();
  });

  it("float64Bits reads the IEEE 754 pattern big-endian", () => {
    expect(float64Bits(1)).toBe("3ff0000000000000");
    expect(float64Bits(-2)).toBe("c000000000000000");
    expect(float64Bits(0)).toBe("0000000000000000");
    expect(float64Bits(-0)).toBe("8000000000000000");
    expect(float64Bits(Math.sqrt(2))).toBe("3ff6a09e667f3bcd");
    // T4's pinned pattern for invNorm(0.01) = −2.3263478740408408, used again by step 12.
    expect(float64Bits(-2.3263478740408408)).toBe("c0029c5c4630ff0e");
  });
});
