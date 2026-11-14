import { NEVER_DEPLETED, YearTable } from "@meridian/shared";
import { describe, expect, it } from "vitest";
import * as core from "./index.js";
import { DATA_CHECKSUM, DATA_VERSION, ENGINE_VERSION, EngineInputError, simulatePath, validateInput } from "./index.js";
import { W, ZERO_YIELDS } from "./loopTestKit.js";
import { runSimulation } from "./node/index.js";
import { account, buildSimInput, incomeStream } from "./testing/index.js";
import { dollarsToCentsBigInt } from "./units.js";

// Build step 21: the facade of seams §2.4 (C7). `simulatePath(input, k)` re-simulates one path
// with the production hooks and tax functions and must reproduce path k of `runSimulation` bit
// for bit (inputs-and-data, "Assumed behaviour"): the job's reproducibility check (C8) and the
// API's re-simulated percentiles (G11) rest on it.

/** T20's household (engine-and-returns §7) on the bootstrap model with seed 20261110: some paths fail. */
const t20 = (paths: number) =>
  buildSimInput({
    people: [{ birthYear: 1962, longevity: { mode: "fixed", age: 94 } }],
    accounts: [account("roth", "roth", "100000000", { allocation: W(6000, 0, 4000, 0) })],
    spending: { baseAnnualCents: "4000000" },
    returnModel: { kind: "bootstrap", meanBlockYears: 10 },
    paths,
    seed: 20261110,
    tax: ZERO_YIELDS,
  });

describe("the facade's versions and exports (seams §2.4)", () => {
  it("ENGINE_VERSION, DATA_VERSION and DATA_CHECKSUM are exported from the package", () => {
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(DATA_VERSION).toBe("2026.11.0");
    expect(DATA_CHECKSUM).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the core exports the facade and the tax area's previews named by §2.4; the loop's per-state step is simulatePathInto", () => {
    for (const name of [
      "simulatePath",
      "validateInput",
      "EngineInputError",
      "EngineInvariantError",
      "EngineRuntimeError",
      "listTaxRuleSets",
      "TAX_DATA_FIRST_YEAR",
      "contributionLimit",
      "fullRetirementAgeTable",
      "buildRulesView",
      "federalTaxPreview",
      "socialSecurityPreviewView",
      "simulatePathInto",
    ]) {
      expect(core, name).toHaveProperty(name);
    }
    // The core has no harness: the pool and runSimulation are in "@meridian/retirement/node".
    expect(core).not.toHaveProperty("runSimulation");
    expect(core).not.toHaveProperty("createSimPool");
  });
});

describe("validateInput (C13)", () => {
  it("a plan that can run has no issue", () => {
    expect(validateInput(t20(100))).toEqual([]);
  });

  it("an input frozen for another data version is refused with data_version_mismatch", () => {
    const input = { ...t20(100), data: { version: "2025.1.0" } };
    expect(validateInput(input)).toEqual([{ code: "data_version_mismatch", message: expect.stringContaining("2025.1.0") }]);
  });

  it("the resolver's limits are reported together: 33 accounts and 41 income streams", () => {
    const base = t20(100);
    const accounts = Array.from({ length: 33 }, (_, i) => account(`a${i}`, "roth", "100"));
    const incomes = Array.from({ length: 41 }, (_, i) => incomeStream(`i${i}`, "other", "100", "2027-01"));
    const issues = validateInput({ ...base, accounts, incomes });
    expect(issues.map((i) => i.code)).toEqual(["too_many_accounts", "too_many_incomes"]);
  });
});

describe("simulatePath(input, k) reproduces path k of runSimulation", () => {
  const input = t20(300);

  it("ending wealth, depletion year and the table's last row equal the run's series for every 7th path and every failed path", async () => {
    const out = await runSimulation(input, { threads: 0 });
    const failed: number[] = [];
    for (let k = 0; k < out.paths; k++) if (out.depletionYear[k]! !== NEVER_DEPLETED) failed.push(k);
    // Bootstrap with seed 20261110 has failing paths among the first 300 (T41's first row fails 152 of 2,000).
    expect(failed.length).toBeGreaterThan(5);
    const ks = new Set<number>(failed);
    for (let k = 0; k < out.paths; k += 7) ks.add(k);
    for (const k of ks) {
      const r = simulatePath(input, k);
      expect(r.pathIndex).toBe(k);
      expect(r.endingRealCents, `path ${k}`).toBe(out.endingRealCents[k]);
      expect(r.depletionYear, `path ${k}`).toBe(out.depletionYear[k]);
      expect(r.table.rows.at(-1)!.ending.totalReal).toBe(r.endingRealCents.toString());
      // The depletion year is the first row that failed (C46).
      const first = r.table.rows.find((row) => row.failed);
      expect(first?.year ?? NEVER_DEPLETED).toBe(r.depletionYear);
    }
  }, 60_000);

  it("the table is a valid stored YearTable whose rows run to the path's last year", () => {
    const r = simulatePath(input, 0);
    expect(YearTable.parse(r.table)).toEqual(r.table);
    expect(r.table.rows[0]!.year).toBe(2027);
    expect(r.table.rows.at(-1)!.year).toBe(2056); // fixed age 94, born 1962
    expect(r.endingRealCents).toBe(dollarsToCentsBigInt(1599167.000970203)); // T41's path 0 (seed 20261110, 2,000 paths: the same path)
  });

  it("an input that cannot run throws EngineInputError; a path index outside the run throws RangeError", () => {
    const bad = { ...input, data: { version: "2025.1.0" } };
    expect(() => simulatePath(bad, 0)).toThrow(EngineInputError);
    expect(() => simulatePath(input, 300)).toThrow(RangeError);
    expect(() => simulatePath(input, -1)).toThrow(RangeError);
  });
});
