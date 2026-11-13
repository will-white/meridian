import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { UnsupportedSchemaVersionError } from "./primitives.js";
import { defaultRunSettings, RunSettings, upgradeRunSettings } from "./settings.js";
import { forbiddenValuePaths } from "./testFixtures.js";

const ok = (value: unknown) => RunSettings.safeParse(value).success;

describe("RunSettings (seams §2.1)", () => {
  it("defaultRunSettings: 10,000 paths, seed 1, the bootstrap (plan decision 6), full rebalancing (plan decision 8), current law", () => {
    expect(defaultRunSettings()).toEqual({
      schemaVersion: 1,
      paths: 10_000,
      seed: 1,
      stepsPerYear: 1,
      returnModel: { kind: "bootstrap", meanBlockYears: 10 },
      portfolio: { taxableRebalance: "full" },
      strategy: { kind: "constant_dollar" },
      withdrawalOrder: { kind: "default", cashReserveCents: "0" },
      taxRuleSet: "current_law",
      tax: { chainedCpiWedgeBp: 0, realWageGrowthBp: 0, includePayrollTax: true, capLossCarryInCents: "0", taxDrag: {} },
    });
  });

  it("the defaults parse to themselves, hold no float and no null, and are a fresh object each time", () => {
    const settings = defaultRunSettings();
    expect(RunSettings.parse(settings)).toEqual(settings);
    expect(forbiddenValuePaths(settings)).toEqual([]);
    const other = defaultRunSettings();
    expect(other).not.toBe(settings);
    other.tax.taxDrag["us_stock"] = { dividendYieldBp: 0 };
    expect(defaultRunSettings().tax.taxDrag).toEqual({});
  });

  it("paths, seed and the rule set default when absent", () => {
    const { paths: _paths, seed: _seed, taxRuleSet: _taxRuleSet, ...rest } = defaultRunSettings();
    expect(RunSettings.parse(rest)).toEqual(defaultRunSettings());
  });

  it("every block is required except those three; the version and the step are literals", () => {
    const settings = defaultRunSettings();
    for (const key of ["returnModel", "portfolio", "strategy", "withdrawalOrder", "tax", "stepsPerYear", "schemaVersion"] as const) {
      const { [key]: _dropped, ...rest } = settings;
      expect(ok(rest), key).toBe(false);
    }
    expect(ok({ ...settings, stepsPerYear: 12 })).toBe(false);
    expect(ok({ ...settings, schemaVersion: 2 })).toBe(false);
  });

  it("strict", () => {
    expect(ok({ ...defaultRunSettings(), threads: 4 })).toBe(false);
    expect(ok({ ...defaultRunSettings(), returnShift: { stocks: 0 } })).toBe(false);
  });

  it("paths 100 to 100,000; seed 0 to 4294967295 (C5)", () => {
    const settings = defaultRunSettings();
    for (const [paths, valid] of [[100, true], [100_000, true], [99, false], [100_001, false], [1000.5, false]] as const) expect(ok({ ...settings, paths }), String(paths)).toBe(valid);
    for (const [seed, valid] of [[0, true], [4294967295, true], [-1, false], [4294967296, false], [1.5, false], ["1", false]] as const) expect(ok({ ...settings, seed }), String(seed)).toBe(valid);
    expect(ok({ ...settings, taxRuleSet: "Current Law" })).toBe(false);
  });
});

describe("upgradeRunSettings (seams F10)", () => {
  it("is the identity for version 1", () => {
    const settings = defaultRunSettings();
    expect(upgradeRunSettings(settings)).toEqual(settings);
    expect(upgradeRunSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
    const custom = { ...settings, paths: 2000, seed: 42, returnModel: { kind: "historical", cohorts: "complete" }, portfolio: { taxableRebalance: "flows_only" } };
    expect(upgradeRunSettings(custom)).toEqual(custom);
  });

  it("applies the version's defaults to a stored document that omitted them", () => {
    expect(upgradeRunSettings({ schemaVersion: 1, stepsPerYear: 1, returnModel: { kind: "bootstrap" }, portfolio: {}, strategy: { kind: "constant_dollar" }, withdrawalOrder: { kind: "default" }, tax: {} })).toEqual(
      defaultRunSettings(),
    );
  });

  it("refuses an unknown version, and an invalid version-1 document", () => {
    expect(() => upgradeRunSettings({ ...defaultRunSettings(), schemaVersion: 2 })).toThrow(UnsupportedSchemaVersionError);
    expect(() => upgradeRunSettings({ ...defaultRunSettings(), schemaVersion: 2 })).toThrow("RunSettings: schemaVersion 2 is not supported");
    expect(() => upgradeRunSettings("settings")).toThrow(UnsupportedSchemaVersionError);
    expect(() => upgradeRunSettings({ ...defaultRunSettings(), paths: 0 })).toThrow(ZodError);
  });
});
