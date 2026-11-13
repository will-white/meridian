import { RetirementProfileDoc } from "./profile.js";

/**
 * Scenarios as merge patches (inputs-and-data §3.3, decision 3).
 *
 * A scenario stores a minimal RFC 7396 merge patch over the profile document: the editor sends the
 * whole edited document and the server keeps `diffPatch(profile.doc, edited)`, so a value edited
 * back to the base leaves the patch. Stored documents hold no nulls (inputs decision 2), which is
 * what makes the patch exact: `null` means "delete" and arrays are replaced whole.
 *
 * None of these functions mutates its arguments. A result may share unchanged subtrees with the
 * target; values taken from a patch are copied.
 */

/** A JSON object: not null, not an array, and made by `{}`, `JSON.parse` or `Object.create(null)`. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The keys of an object whose values are present (an `undefined` value counts as absent). */
function presentKeys(o: Record<string, unknown>): string[] {
  return Object.keys(o).filter((k) => o[k] !== undefined);
}

function ownValue(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

/** Defines an own data property, so a key such as "__proto__" stays a key and never sets a prototype. */
function setOwn(o: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
}

/** A deep copy of a JSON value (plain objects, arrays and primitives). */
function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of presentKeys(value)) setOwn(out, key, cloneJson(value[key]));
    return out;
  }
  return value;
}

/** Deep equality of JSON values: plain objects by their present keys, arrays in order, primitives by `===`. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const ka = presentKeys(a);
    if (ka.length !== presentKeys(b).length) return false;
    return ka.every((k) => ownValue(b, k) !== undefined && jsonEqual(a[k], ownValue(b, k)));
  }
  return false;
}

/**
 * RFC 7396: when `patch` is not a plain object the result is `patch`; otherwise the target (or `{}`
 * when the target is not an object) with each key of the patch applied: `null` deletes the key, an
 * object merges recursively, anything else (a scalar or an array) replaces.
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return cloneJson(patch);
  const result: Record<string, unknown> = {};
  if (isPlainObject(target)) for (const key of presentKeys(target)) setOwn(result, key, target[key]);
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete result[key];
    else setOwn(result, key, mergePatch(ownValue(result, key), value));
  }
  return result;
}

function nullPath(value: unknown, at: string): string | undefined {
  if (value === null) return at;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = nullPath(value[i], `${at}[${i}]`);
      if (found !== undefined) return found;
    }
  } else if (isPlainObject(value)) {
    for (const key of presentKeys(value)) {
      const found = nullPath(value[key], at ? `${at}.${key}` : key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function diff(base: Record<string, unknown>, target: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const keys = [...new Set([...presentKeys(base), ...presentKeys(target)])].sort();
  for (const key of keys) {
    const b = ownValue(base, key);
    const t = ownValue(target, key);
    if (t === undefined) {
      setOwn(patch, key, null);
    } else if (isPlainObject(b) && isPlainObject(t)) {
      const sub = diff(b, t);
      if (Object.keys(sub).length > 0) setOwn(patch, key, sub);
    } else if (b === undefined || !jsonEqual(b, t)) {
      setOwn(patch, key, cloneJson(t));
    }
  }
  return patch;
}

/**
 * The minimal merge patch that turns `base` into `target`: for each key of either, absent in the
 * target → `null`; both plain objects → recurse, kept when non-empty; not deep-equal → the target
 * value (arrays compare by deep equality and are replaced whole); equal → omitted. Keys are visited
 * in sorted order. `mergePatch(base, diffPatch(base, target))` deep-equals `target`.
 *
 * Both arguments must be plain objects, and the target must hold no null: a null cannot be said in
 * a merge patch (it would mean "delete"), and stored documents never hold one.
 */
export function diffPatch(base: unknown, target: unknown): Record<string, unknown> {
  if (!isPlainObject(base) || !isPlainObject(target)) throw new TypeError("diffPatch: base and target must be plain objects");
  const at = nullPath(target, "");
  if (at !== undefined) throw new TypeError(`diffPatch: the target holds a null at ${at || "the top"}`);
  return diff(base, target);
}

/** One leaf of a scenario's overrides as the owner reads it; a removal has no `after`, an addition no `before`. */
export interface OverrideChange {
  /** A dot path into the profile document. */
  path: string;
  before?: unknown;
  after?: unknown;
}

function walk(base: unknown, patch: Record<string, unknown>, prefix: string, out: OverrideChange[]): void {
  for (const key of Object.keys(patch).sort()) {
    const value = patch[key];
    if (value === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const before = isPlainObject(base) ? ownValue(base, key) : undefined;
    if (isPlainObject(value) && isPlainObject(before)) {
      walk(before, value, path, out);
      continue;
    }
    if (value === null) {
      if (before !== undefined) out.push({ path, before });
      continue;
    }
    const after = mergePatch(undefined, value);
    if (before !== undefined && jsonEqual(before, after)) continue;
    out.push(before === undefined ? { path, after } : { path, before, after });
  }
}

/**
 * The leaves of a scenario's patch against the document it applies to, in sorted path order: a
 * patch object is followed into an object of the document, and anything else is one change (a new
 * income stream is one change with its whole value). Leaves that change nothing (a removal of an
 * absent key, a value equal to the document's) are left out.
 */
export function overrideChanges(doc: Readonly<Record<string, unknown>>, overrides: Readonly<Record<string, unknown>>): OverrideChange[] {
  const out: OverrideChange[] = [];
  walk(doc, overrides, "", out);
  return out;
}

/** The effective document of a scenario, or why its overrides no longer apply (the resolver's `override_invalid`). */
export type EffectiveProfileDoc = { ok: true; doc: RetirementProfileDoc } | { ok: false; path: string; message: string };

/**
 * `RetirementProfileDoc.parse(mergePatch(doc, overrides))` without throwing (inputs §3.3, §3.4 R1).
 * Overrides never touch `schemaVersion`: a patch that sets or deletes it is refused.
 */
export function effectiveProfileDoc(doc: RetirementProfileDoc, overrides: Readonly<Record<string, unknown>>): EffectiveProfileDoc {
  if (!isPlainObject(overrides)) return { ok: false, path: "", message: "overrides must be an object" };
  if (Object.hasOwn(overrides, "schemaVersion")) {
    return { ok: false, path: "schemaVersion", message: "a scenario cannot change the document's schemaVersion" };
  }
  const parsed = RetirementProfileDoc.safeParse(mergePatch(doc, overrides));
  if (parsed.success) return { ok: true, doc: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, path: issue ? issue.path.join(".") : "", message: issue ? issue.message : "invalid document" };
}
