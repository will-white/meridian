/**
 * The double form of a record's money fields (the zero-allocation rule of engine-and-returns §3.15
 * and §4.3).
 *
 * V8 keeps a number field of an object in the form of what has been stored in it: a field that has
 * only held small integers (a fresh record's `0`) is a small-integer field. The first fraction
 * written to it gives the object a new map with a double field, and every optimized function
 * compiled against the old map is thrown away; until those functions are optimized again they run
 * in the interpreter, which boxes every double it touches. A field that first gets a fraction late
 * in a run (a shortfall on the first failing path, a capped contribution) therefore costs a burst of
 * allocation in the middle of the simulate phase. Writing a fraction once when the record is made
 * gives the field its double form from the start; the value is put back, so the record is
 * unchanged.
 *
 * The record vpw.ts passes to `vpwRawPercentageInto` gets the same form from its literal
 * (`{ raw: 0.5 }`).
 */

/** The keys of `T` whose values are numbers. */
export type NumberKey<T> = { [K in keyof T]-?: T[K] extends number ? K : never }[keyof T] & string;

/** Gives the named number fields of `record` their double form; returns `record` with every value unchanged. */
export function doubleFields<T extends object>(record: T, keys: readonly NumberKey<T>[]): T {
  const r = record as unknown as Record<string, number>;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const v = r[k]!;
    r[k] = 0.5;
    r[k] = v;
  }
  return record;
}
