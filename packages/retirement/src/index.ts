/**
 * @meridian/retirement: the pure retirement engine (L1; engine-and-returns decision 1).
 *
 * No I/O and no clock anywhere under src/ except src/node; no Math.random, Date or
 * implementation-approximated Math function anywhere (engine-and-returns §3.14; the root ESLint
 * block and determinism.test.ts enforce it). Money is float64 dollars inside and integer cents at
 * the boundary, converted only through units.ts.
 */

export { ENGINE_VERSION, DATA_VERSION, DATA_CHECKSUM } from "./version.js";
export { centsToDollars, dollarsToCents, dollarsToCentsBigInt } from "./units.js";
export { detExp, detLog, detPow, powInt } from "./detmath.js";
export { selfTest } from "./selftest.js";
export { EngineInputError, EngineInvariantError, EngineRuntimeError } from "./errors.js";
export type { EngineRuntimeCode } from "./errors.js";
