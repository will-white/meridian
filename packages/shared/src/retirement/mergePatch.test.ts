import { describe, expect, it } from "vitest";
import { diffPatch, effectiveProfileDoc, isPlainObject, jsonEqual, mergePatch, overrideChanges } from "./mergePatch.js";
import { RetirementProfileDoc } from "./profile.js";
import { fixtureProfileDoc } from "./testFixtures.js";

// The worked example of inputs-and-data §3.3 (the base is abbreviated there and here).
const base = () => ({
  people: { p1: { retirementAge: 60 } },
  spending: { base: { mode: "manual", annualCents: "4000000" } },
  incomes: { salary_p1: { annualGrossCents: "12000000" }, pen1: { monthlyCents: "100000" } },
});
const target = () => ({
  people: { p1: { retirementAge: 58 } },
  spending: { base: { mode: "live" } },
  incomes: { salary_p1: { annualGrossCents: "11000000" } },
});
const patch = () => ({
  people: { p1: { retirementAge: 58 } },
  spending: { base: { mode: "live", annualCents: null } },
  incomes: { salary_p1: { annualGrossCents: "11000000" }, pen1: null },
});

describe("5. merge patch and minimal patch (inputs-and-data §3.3)", () => {
  it("5 diffPatch gives exactly the §3.3 patch, and mergePatch(base, patch) deep-equals the target", () => {
    expect(diffPatch(base(), target())).toEqual(patch());
    expect(mergePatch(base(), patch())).toEqual(target());
    expect(mergePatch(base(), diffPatch(base(), target()))).toEqual(target());
  });

  it("5 diffPatch(x, x) is {}", () => {
    expect(diffPatch(base(), base())).toEqual({});
    const doc = RetirementProfileDoc.parse(fixtureProfileDoc());
    expect(diffPatch(doc, structuredClone(doc))).toEqual({});
  });

  it("5 overrideChanges lists the five leaves", () => {
    expect(overrideChanges(base(), patch())).toEqual([
      { path: "incomes.pen1", before: { monthlyCents: "100000" } },
      { path: "incomes.salary_p1.annualGrossCents", before: "12000000", after: "11000000" },
      { path: "people.p1.retirementAge", before: 60, after: 58 },
      { path: "spending.base.annualCents", before: "4000000" },
      { path: "spending.base.mode", before: "manual", after: "live" },
    ]);
  });

  it("5 an array value replaces whole, in both directions", () => {
    expect(mergePatch({ a: [1, 2, 3], b: 1 }, { a: [4] })).toEqual({ a: [4], b: 1 });
    expect(diffPatch({ a: [1, 2], b: 1 }, { a: [1, 2, 3], b: 1 })).toEqual({ a: [1, 2, 3] });
    expect(diffPatch({ a: [{ x: 1 }] }, { a: [{ x: 1 }] })).toEqual({});
    // An array is never merged into: a patch array of objects replaces the base array.
    expect(mergePatch({ a: [{ x: 1, y: 2 }] }, { a: [{ x: 3 }] })).toEqual({ a: [{ x: 3 }] });
  });

  it("5 a patch that would set (or delete) schemaVersion is rejected", () => {
    const doc = RetirementProfileDoc.parse(fixtureProfileDoc());
    expect(effectiveProfileDoc(doc, { schemaVersion: 2 })).toEqual({
      ok: false,
      path: "schemaVersion",
      message: "a scenario cannot change the document's schemaVersion",
    });
    expect(effectiveProfileDoc(doc, { schemaVersion: null })).toMatchObject({ ok: false, path: "schemaVersion" });
    expect(effectiveProfileDoc(doc, { schemaVersion: 1 })).toMatchObject({ ok: false, path: "schemaVersion" });
  });

  it("5 the effective document: an override applies, and one that no longer fits is override_invalid with its path", () => {
    const doc = RetirementProfileDoc.parse(fixtureProfileDoc());
    const applied = effectiveProfileDoc(doc, { people: { p1: { retirementAge: 58 } } });
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.doc.people.p1.retirementAge).toBe(58);
      expect(applied.doc.people.p2).toEqual(doc.people.p2);
    }
    expect(effectiveProfileDoc(doc, {})).toEqual({ ok: true, doc });
    // inputs test 13's last case: the profile deleted pen1, the scenario still edits its amount.
    const { pen1: _pen1, ...incomes } = doc.incomes;
    const withoutPen1 = RetirementProfileDoc.parse({ ...doc, incomes });
    const stale = effectiveProfileDoc(withoutPen1, { incomes: { pen1: { monthlyCents: "120000" } } });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.path.startsWith("incomes.pen1")).toBe(true);
  });

  it("RFC 7396 rules: null deletes, objects merge into objects or replace non-objects, scalars replace", () => {
    expect(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: null, e: 4 } })).toEqual({ a: 1, b: { d: 3, e: 4 } });
    expect(mergePatch({ a: "x" }, { a: { b: 1, c: null } })).toEqual({ a: { b: 1 } });
    expect(mergePatch("not an object", { a: 1 })).toEqual({ a: 1 });
    expect(mergePatch({ a: 1 }, "replaced")).toBe("replaced");
    expect(mergePatch({ a: 1 }, { a: null, b: null })).toEqual({});
  });

  it("no argument is mutated, and the result does not alias the patch", () => {
    const b = base();
    const p = patch();
    const before = structuredClone({ b, p });
    const merged = mergePatch(b, p) as { incomes: { salary_p1: { annualGrossCents: string } } };
    diffPatch(b, target());
    overrideChanges(b, p);
    expect({ b, p }).toEqual(before);
    merged.incomes.salary_p1.annualGrossCents = "1";
    expect(p.incomes.salary_p1.annualGrossCents).toBe("11000000");
  });

  it("a __proto__ key stays an own key and never sets a prototype", () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    const merged = mergePatch({}, hostile) as Record<string, unknown>;
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.hasOwn(merged, "__proto__")).toBe(true);
    expect((merged as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("diffPatch refuses non-objects and a target holding a null (it cannot be said in a merge patch)", () => {
    expect(() => diffPatch([], {})).toThrow(TypeError);
    expect(() => diffPatch({}, "x")).toThrow(TypeError);
    expect(() => diffPatch({}, { a: { b: null } })).toThrow(/null at a\.b/);
  });

  it("the invariant on the fixture document: an edited copy round-trips through its minimal patch", () => {
    const doc = RetirementProfileDoc.parse(fixtureProfileDoc());
    const edited = structuredClone(doc);
    edited.people.p1.retirementAge = 58;
    delete (edited.incomes as Record<string, unknown>)["pen1"];
    edited.spending.goals = {};
    const minimal = diffPatch(doc, edited);
    expect(minimal).toEqual({ incomes: { pen1: null }, people: { p1: { retirementAge: 58 } }, spending: { goals: { roof: null } } });
    expect(mergePatch(doc, minimal)).toEqual(edited);
    expect(effectiveProfileDoc(doc, minimal)).toEqual({ ok: true, doc: edited });
    expect(overrideChanges(doc, minimal).map((c) => c.path)).toEqual(["incomes.pen1", "people.p1.retirementAge", "spending.goals.roof"]);
  });

  it("overrideChanges: a new item is one change with its whole value; leaves that change nothing are left out", () => {
    expect(overrideChanges({ incomes: {} }, { incomes: { pen2: { kind: "pension", monthlyCents: "50000", note: null } } })).toEqual([
      { path: "incomes.pen2", after: { kind: "pension", monthlyCents: "50000" } },
    ]);
    expect(overrideChanges({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] }, d: null })).toEqual([]);
  });

  it("jsonEqual and isPlainObject", () => {
    expect(jsonEqual({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual({}, [])).toBe(false);
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(new Date(0))).toBe(false);
  });
});
