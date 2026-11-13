/**
 * Start-up self-test (engine-and-returns §3.13 "Self-test", §3.14 item 6).
 *
 * Run once per worker thread and once before an inline run: the engine refuses to simulate on a
 * machine whose arithmetic disagrees with the pinned bit patterns, because every result, digest and
 * percentile path depends on them. A mismatch throws `EngineRuntimeError("self_test_failed")`.
 *
 * Checks so far: the deterministic exponential and logarithm (the design's `detExp(1)` and
 * `detLog(2)`, plus T5's four golden bit patterns) and `Math.sqrt(2)`. The three Threefry vectors
 * of T1 and `invNorm(0.975)` join this list with `rng.ts` (build step 12).
 */

import { detExp, detLog } from "./detmath.js";
import { EngineRuntimeError } from "./errors.js";

/** The functions under test; a test double replaces one to prove a disagreement is caught (T46). */
export interface SelfTestFunctions {
  detExp(x: number): number;
  detLog(x: number): number;
  sqrt(x: number): number;
}

const ENGINE_FUNCTIONS: SelfTestFunctions = { detExp, detLog, sqrt: Math.sqrt };

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
];

/** The IEEE 754 bit pattern of a binary64 as 16 hex digits, read big-endian through a DataView. */
export function float64Bits(x: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x, false);
  return view.getUint32(0, false).toString(16).padStart(8, "0") + view.getUint32(4, false).toString(16).padStart(8, "0");
}

/** Throws `EngineRuntimeError("self_test_failed")` naming the first value that differs. */
export function selfTest(fns: SelfTestFunctions = ENGINE_FUNCTIONS): void {
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
