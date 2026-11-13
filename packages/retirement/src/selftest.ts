/**
 * Start-up self-test (engine-and-returns §3.13 "Self-test", §3.14 item 6).
 *
 * Run once per worker thread and once before an inline run: the engine refuses to simulate on a
 * machine whose arithmetic disagrees with the pinned bit patterns, because every result, digest and
 * percentile path depends on them. A mismatch throws `EngineRuntimeError("self_test_failed")`.
 *
 * Checks: the deterministic exponential and logarithm (the design's `detExp(1)` and `detLog(2)`,
 * plus T5's four golden bit patterns), `Math.sqrt(2)`, the three Threefry2x32-20 known-answer
 * vectors of T1 (Random123 `kat_vectors`) and `invNorm(0.975)` (T4).
 */

import { detExp, detLog } from "./detmath.js";
import { EngineRuntimeError } from "./errors.js";
import { invNorm, threefry2x32 } from "./rng.js";

/** The functions under test; a test double replaces one to prove a disagreement is caught (T46). */
export interface SelfTestFunctions {
  detExp(x: number): number;
  detLog(x: number): number;
  sqrt(x: number): number;
  /** Absent = the engine's own (`rng.ts`). */
  invNorm?(u: number): number;
  /** Absent = the engine's own (`rng.ts`). */
  threefry2x32?(k0: number, k1: number, c0: number, c1: number, out: Uint32Array): void;
}

const ENGINE_FUNCTIONS: SelfTestFunctions = { detExp, detLog, sqrt: Math.sqrt, invNorm, threefry2x32 };

interface Check {
  label: string;
  run(fns: SelfTestFunctions): number;
  /** The exact binary64 result, as the 16 hex digits of its IEEE 754 bit pattern. */
  bits: string;
}

const CHECKS: readonly Check[] = [
  { label: "detExp(1)", run: (m) => m.detExp(1), bits: "4005bf0a8b14576a" }, // 2.7182818284590455
  { label: "detLog(2)", run: (m) => m.detLog(2), bits: "3fe62e42fefa39ef" }, // 0.6931471805599453
  { label: "detExp(0.5)", run: (m) => m.detExp(0.5), bits: "3ffa61298e1e069c" },
  { label: "detExp(-1.25)", run: (m) => m.detExp(-1.25), bits: "3fd25618372a584f" },
  { label: "detLog(1.07)", run: (m) => m.detLog(1.07), bits: "3fb15213c27c917f" },
  { label: "detLog(0.561625)", run: (m) => m.detLog(0.561625), bits: "bfe27622d7f54a80" },
  { label: "Math.sqrt(2)", run: (m) => m.sqrt(2), bits: "3ff6a09e667f3bcd" }, // 1.4142135623730951
  { label: "invNorm(0.975)", run: (m) => (m.invNorm ?? invNorm)(0.975), bits: "3fff5c0331eeff82" }, // 1.9599639845400536
];

/** T1: Random123 `kat_vectors` for threefry2x32_20, as (counter, key) → output words. */
const THREEFRY_VECTORS: ReadonlyArray<{ ctr: [number, number]; key: [number, number]; out: [number, number] }> = [
  { ctr: [0x00000000, 0x00000000], key: [0x00000000, 0x00000000], out: [0x6b200159, 0x99ba4efe] },
  { ctr: [0xffffffff, 0xffffffff], key: [0xffffffff, 0xffffffff], out: [0x1cb996fc, 0xbb002be7] },
  { ctr: [0x243f6a88, 0x85a308d3], key: [0x13198a2e, 0x03707344], out: [0xc4923a9c, 0x483df7a0] },
];

const hex8 = (w: number): string => (w >>> 0).toString(16).padStart(8, "0");

/** The IEEE 754 bit pattern of a binary64 as 16 hex digits, read big-endian through a DataView. */
export function float64Bits(x: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x, false);
  return view.getUint32(0, false).toString(16).padStart(8, "0") + view.getUint32(4, false).toString(16).padStart(8, "0");
}

/** Throws `EngineRuntimeError("self_test_failed")` naming the first value that differs. */
export function selfTest(fns: SelfTestFunctions = ENGINE_FUNCTIONS): void {
  const threefry = fns.threefry2x32 ?? threefry2x32;
  const words = new Uint32Array(2);
  for (const v of THREEFRY_VECTORS) {
    threefry(v.key[0], v.key[1], v.ctr[0], v.ctr[1], words);
    if (words[0] !== v.out[0] || words[1] !== v.out[1]) {
      throw new EngineRuntimeError(
        "self_test_failed",
        `engine self-test failed: threefry2x32 of counter ${hex8(v.ctr[0])} ${hex8(v.ctr[1])} under key ${hex8(v.key[0])} ${hex8(v.key[1])} ` +
          `is ${hex8(words[0]!)} ${hex8(words[1]!)}, expected ${hex8(v.out[0])} ${hex8(v.out[1])}`,
      );
    }
  }
  for (const check of CHECKS) {
    const value = check.run(fns);
    const bits = float64Bits(value);
    if (bits !== check.bits) {
      throw new EngineRuntimeError(
        "self_test_failed",
        `engine self-test failed: ${check.label} is ${value} (bits ${bits}), expected bits ${check.bits}`,
      );
    }
  }
}
