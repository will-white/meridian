import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../crypto.js";
import { CanonicalJsonError, canonicalJson, hashableInput, inputHash } from "./freeze.js";
import { SimInput } from "./input.js";
import { fixtureSimInput } from "./testFixtures.js";

/** Rebuilds a JSON value with every object's keys inserted in reverse order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .reverse()
        .map((k) => [k, reverseKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

describe("14. canonical JSON and hash (inputs-and-data §3.7)", () => {
  it("14 the §3.7 example gives exactly that string and digest", async () => {
    const text = canonicalJson({ b: 1, a: { d: "x", c: [2, 1] } });
    expect(text).toBe('{"a":{"c":[2,1],"d":"x"},"b":1}');
    // The design's digest, recomputed here with Node's crypto as well as through sha256Hex.
    expect(createHash("sha256").update(text).digest("hex")).toBe("be443ac6d288a3a8c08f56c7542cc1a267664f64b11042b4b1b1ed8b99be2da0");
    expect(await sha256Hex(text)).toBe("be443ac6d288a3a8c08f56c7542cc1a267664f64b11042b4b1b1ed8b99be2da0");
  });

  it("14 1.5, null, undefined, NaN and 2 ** 53 each throw CanonicalJsonError", () => {
    for (const bad of [1.5, null, undefined, Number.NaN, 2 ** 53]) {
      expect(() => canonicalJson(bad)).toThrow(CanonicalJsonError);
      expect(() => canonicalJson({ a: [bad] })).toThrow(CanonicalJsonError);
    }
    expect(() => canonicalJson({ a: { b: 0.1 } })).toThrow(/at \$\.a\.b/);
  });

  it("14 two inputs that differ only in meta or in an account's name have equal hashes", async () => {
    const input = fixtureSimInput();
    const renamed = fixtureSimInput();
    renamed.meta.createdAt = "2027-01-01T00:00:00.000Z";
    renamed.meta.warnings = [];
    renamed.meta.scenarioName = "Another name";
    renamed.accounts[0]!.name = "Renamed 401(k)";
    renamed.household.people[1]!.name = "Samantha";
    renamed.incomes[0]!.name = "Pension";
    renamed.spending.goals[0]!.name = "New roof";
    expect(await inputHash(renamed)).toBe(await inputHash(input));
    expect(canonicalJson(hashableInput(renamed))).toBe(canonicalJson(hashableInput(input)));
  });

  it("14 an input rebuilt with keys in another order has the same hash", async () => {
    const input = fixtureSimInput();
    const reordered = reverseKeys(input) as SimInput;
    expect(Object.keys(reordered)[0]).toBe("settings");
    expect(await inputHash(reordered)).toBe(await inputHash(input));
  });

  it("14 settings.seed + 1 changes the hash", async () => {
    const input = fixtureSimInput();
    const other = fixtureSimInput();
    other.settings.seed = input.settings.seed + 1;
    expect(await inputHash(other)).not.toBe(await inputHash(input));
  });

  it("the hash is SHA-256 of the canonical text, lower-case hex, and the fixture input is canonical-safe", async () => {
    const input = SimInput.parse(fixtureSimInput());
    const text = canonicalJson(hashableInput(input));
    const hash = await inputHash(input);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash("sha256").update(text).digest("hex"));
    expect(text.includes('"meta"')).toBe(false);
    expect(text.includes("Acme 401(k)")).toBe(false);
  });

  it("hashableInput drops meta and the four kinds of name, and leaves the input untouched", () => {
    const input = fixtureSimInput();
    const before = structuredClone(input);
    type Named = { name?: string; id?: string };
    const h = hashableInput(input) as {
      meta?: unknown;
      household: { people: Named[] };
      accounts: Named[];
      incomes: Named[];
      spending: { goals: Named[] };
    };
    expect(h.meta).toBeUndefined();
    for (const list of [h.household.people, h.accounts, h.incomes, h.spending.goals]) {
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((item) => !("name" in item))).toBe(true);
    }
    expect(h.accounts[0]!.id).toBe(input.accounts[0]!.id);
    expect(input).toEqual(before);
  });

  it("strings, keys and integers are written as JSON writes them; non-plain values and cycles throw", () => {
    expect(canonicalJson({ "é": 1, Z: 2, a: 3, "10": 4, "9": 5 })).toBe('{"10":4,"9":5,"Z":2,"a":3,"é":1}');
    expect(canonicalJson(["a\"b\n", -0, -12, true, false, [], {}])).toBe('["a\\"b\\n",0,-12,true,false,[],{}]');
    expect(canonicalJson(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
    expect(() => canonicalJson(1n)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Date(0))).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Map())).toThrow(CanonicalJsonError);
    expect(() => canonicalJson([1, , 3])).toThrow(/holes/);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/contains itself/);
    // The same object twice (not a cycle) is fine.
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});
