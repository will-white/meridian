import { allocateLargestRemainder } from "../decimal.js";
import { AssetClass } from "../enums.js";
import type { ClassWeights } from "./primitives.js";

/**
 * Six-class weights in basis points (inputs-and-data §3.4 R4, §3.9, seams C29). Weights are split
 * by largest remainder (`allocateLargestRemainder`, ties to the lower index, in the order of
 * `AssetClass`), so they always sum to 10000. The form's preview and the engine both call
 * `glideWeightsAt`, so they show the same mix.
 */

const CLASSES = AssetClass.options;

function toWeights(parts: readonly bigint[]): ClassWeights {
  const at = (i: number) => Number(parts[i]!);
  return { us_stock: at(0), intl_stock: at(1), bonds: at(2), cash: at(3), real_estate: at(4), other: at(5) };
}

/** The weights of a value split by class in cents; undefined when every class is 0 or any is negative. */
export function classWeights(classCents: Readonly<Partial<Record<AssetClass, bigint>>>): ClassWeights | undefined {
  const values = CLASSES.map((c) => classCents[c] ?? 0n);
  if (values.some((v) => v < 0n) || values.every((v) => v === 0n)) return undefined;
  return toWeights(allocateLargestRemainder(10_000n, values));
}

/** One point of a resolved glide path: the six-class target from that calendar year on. */
export interface GlidePoint {
  year: number;
  weights: ClassWeights;
}

/**
 * The target weights in `year`. Before the first point the first point's weights apply, after the
 * last the last's; between points at `y0 < y1` with `d = year − y0` and `span = y1 − y0` the
 * weights are `a × (span − d) + b × d` split into 10000 by largest remainder (linear
 * interpolation, exact in integers). Points must be in strictly ascending years.
 */
export function glideWeightsAt(points: ReadonlyArray<GlidePoint>, year: number): ClassWeights {
  if (points.length === 0) throw new RangeError("glideWeightsAt: a glide path needs at least one point");
  if (!Number.isInteger(year)) throw new RangeError(`glideWeightsAt: not a year: ${year}`);
  for (let i = 1; i < points.length; i++) {
    if (!(points[i]!.year > points[i - 1]!.year)) throw new RangeError("glideWeightsAt: the points' years must be strictly ascending");
  }
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (year <= first.year) return { ...first.weights };
  if (year >= last.year) return { ...last.weights };
  let i = 0;
  while (points[i + 1]!.year <= year) i++;
  const a = points[i]!;
  const b = points[i + 1]!;
  const d = BigInt(year - a.year);
  const span = BigInt(b.year - a.year);
  return toWeights(
    allocateLargestRemainder(
      10_000n,
      CLASSES.map((c) => BigInt(a.weights[c]) * (span - d) + BigInt(b.weights[c]) * d),
    ),
  );
}
