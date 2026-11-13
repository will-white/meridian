import { ceilDiv } from "../months.js";
import { NEVER_DEPLETED } from "./results.js";

/**
 * Percentile paths and the per-path series codecs (inputs-and-data §3.8, decision 22, seams C9).
 *
 * A percentile path is a real path: paths are ranked by ending wealth in today's cents ascending,
 * then by depletion year ascending with "never" (−1) last, then by path index, and percentile p is
 * the path at the nearest rank. This is the only rank rule: the engine's `percentilePathIndex`, the
 * job's stored tables and the API's re-simulation all come from it, so a percentile table always
 * belongs to the stored series. Failed paths (ending wealth 0) are ordered by how early they ran out.
 */

/** Nearest rank: `max(0, ceil(p × N / 100) − 1)`. `p` is a whole percentile 0..100 (the routes allow 1..99). */
export function rankIndex(percentile: number, paths: number): number {
  if (!Number.isInteger(percentile) || percentile < 0 || percentile > 100) throw new RangeError(`rankIndex: not a percentile: ${percentile}`);
  if (!Number.isSafeInteger(paths) || paths < 1) throw new RangeError(`rankIndex: not a path count: ${paths}`);
  return Math.max(0, Number(ceilDiv(BigInt(percentile) * BigInt(paths), 100n)) - 1);
}

/** The path indices from worst to best (see the file comment). A depletion year is −1 (never) or a calendar year. */
export function rankPaths(endingRealCents: BigInt64Array, depletionYear: Int16Array): Uint32Array {
  const n = endingRealCents.length;
  if (depletionYear.length !== n) throw new RangeError(`rankPaths: ${n} ending values but ${depletionYear.length} depletion years`);
  for (let i = 0; i < n; i++) {
    const y = depletionYear[i]!;
    if (y < 0 && y !== NEVER_DEPLETED) throw new RangeError(`rankPaths: path ${i} has depletion year ${y}`);
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => {
    const ea = endingRealCents[a]!;
    const eb = endingRealCents[b]!;
    if (ea !== eb) return ea < eb ? -1 : 1;
    const da = depletionYear[a]!;
    const db = depletionYear[b]!;
    if (da !== db) {
      if (da === NEVER_DEPLETED) return 1;
      if (db === NEVER_DEPLETED) return -1;
      return da - db;
    }
    return a - b;
  });
  return order;
}

/** The index of the path at percentile p. To pick several percentiles, rank once and index with `rankIndex`. */
export function selectPercentilePath(endingRealCents: BigInt64Array, depletionYear: Int16Array, percentile: number): number {
  const order = rankPaths(endingRealCents, depletionYear);
  return order[rankIndex(percentile, order.length)]!;
}

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/** `sim_run_series` bytes: signed 64-bit little-endian, 8 bytes per path. */
export function encodeI64le(values: ArrayLike<bigint>): Uint8Array {
  const out = new Uint8Array(values.length * 8);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v < I64_MIN || v > I64_MAX) throw new RangeError(`encodeI64le: value ${v} at ${i} does not fit in 64 bits`);
    view.setBigInt64(i * 8, v, true);
  }
  return out;
}

export function decodeI64le(bytes: Uint8Array): BigInt64Array {
  if (bytes.byteLength % 8 !== 0) throw new RangeError(`decodeI64le: ${bytes.byteLength} bytes is not a whole number of 8-byte values`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new BigInt64Array(bytes.byteLength / 8);
  for (let i = 0; i < out.length; i++) out[i] = view.getBigInt64(i * 8, true);
  return out;
}

/** `sim_run_series` bytes: signed 16-bit little-endian, 2 bytes per path (the depletion year, −1 = never). */
export function encodeI16le(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isInteger(v) || v < -32768 || v > 32767) throw new RangeError(`encodeI16le: value ${v} at ${i} does not fit in 16 bits`);
    view.setInt16(i * 2, v, true);
  }
  return out;
}

export function decodeI16le(bytes: Uint8Array): Int16Array {
  if (bytes.byteLength % 2 !== 0) throw new RangeError(`decodeI16le: ${bytes.byteLength} bytes is not a whole number of 2-byte values`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(bytes.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}
