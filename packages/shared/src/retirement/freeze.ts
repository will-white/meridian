import { sha256Hex } from "../crypto.js";
import type { SimInput } from "./input.js";
import { isPlainObject } from "./mergePatch.js";

/**
 * Canonical JSON and the input hash (inputs-and-data §3.7, decision 7).
 *
 * `canonicalJson` writes a stored document so that equal documents give equal text on every
 * machine: object keys in ascending UTF-16 code-unit order, arrays in their order, strings through
 * `JSON.stringify`, numbers only when they are safe integers, booleans as they are. Anything a
 * stored document may not hold (null, undefined, a non-integer, NaN, a bigint, a class instance,
 * a hole in an array, a cycle) throws `CanonicalJsonError`, so a float can never reach a hash.
 */

export class CanonicalJsonError extends Error {
  constructor(
    /** Where the value sits, as `$.a.b[2]`. */
    readonly path: string,
    reason: string,
  ) {
    super(`canonicalJson: ${reason} at ${path}`);
    this.name = "CanonicalJsonError";
  }
}

function write(value: unknown, path: string, ancestors: Set<object>): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new CanonicalJsonError(path, `${String(value)} is not a safe integer`);
      return String(value);
    case "undefined":
      throw new CanonicalJsonError(path, "undefined is not a JSON value");
    case "object":
      break;
    default:
      throw new CanonicalJsonError(path, `a ${typeof value} is not a JSON value`);
  }
  if (value === null) throw new CanonicalJsonError(path, "null is not allowed in a stored document");
  if (ancestors.has(value)) throw new CanonicalJsonError(path, "the value contains itself");
  if (Array.isArray(value)) {
    ancestors.add(value);
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new CanonicalJsonError(`${path}[${i}]`, "an array may not have holes");
      items.push(write(value[i], `${path}[${i}]`, ancestors));
    }
    ancestors.delete(value);
    return `[${items.join(",")}]`;
  }
  if (!isPlainObject(value)) throw new CanonicalJsonError(path, "only plain objects and arrays are allowed");
  ancestors.add(value);
  const members = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${write(value[key], `${path}.${key}`, ancestors)}`);
  ancestors.delete(value);
  return `{${members.join(",")}}`;
}

/** The canonical text of a stored document (see the file comment). */
export function canonicalJson(value: unknown): string {
  return write(value, "$", new Set());
}

/**
 * What the input hash covers: the frozen input without `meta` and without the display names of
 * people, accounts, income streams and goals (a rename is not a change of inputs).
 */
export function hashableInput(input: SimInput): unknown {
  const { meta: _meta, household, accounts, incomes, spending, ...rest } = input;
  return {
    ...rest,
    household: { ...household, people: household.people.map(({ name: _name, ...person }) => person) },
    accounts: accounts.map(({ name: _name, ...account }) => account),
    incomes: incomes.map(({ name: _name, ...income }) => income),
    spending: { ...spending, goals: spending.goals.map(({ name: _name, ...goal }) => goal) },
  };
}

/** `sim_run.input_hash`: SHA-256 of the canonical JSON of `hashableInput(input)`, lower-case hex. */
export function inputHash(input: SimInput): Promise<string> {
  return sha256Hex(canonicalJson(hashableInput(input)));
}
