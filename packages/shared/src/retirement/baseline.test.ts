import { describe, expect, it } from "vitest";
import { BaselineAccount, BaselineContribution, BaselineExpenseRatio, RetirementBaseline } from "./baseline.js";
import { fixtureBaseline, forbiddenValuePaths, IDS } from "./testFixtures.js";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => schema.safeParse(value).success;

describe("RetirementBaseline (inputs-and-data §4.3)", () => {
  it("7.0 the fixture baseline parses unchanged and holds no float and no null", () => {
    const baseline = fixtureBaseline();
    expect(RetirementBaseline.parse(baseline)).toEqual(baseline);
    expect(forbiddenValuePaths(baseline)).toEqual([]);
  });

  it("the fixture's totals add up (design figures)", () => {
    const b = fixtureBaseline();
    const sum = (values: string[]) => values.reduce((a, v) => a + BigInt(v), 0n);
    // 15,000,000 + 125,000 + 432,500 + 2,705,200 + 1,820,000 + 500,000 + 2,000,000 = 22,582,700 (test 11).
    expect(sum(b.accounts.filter((a) => a.bucket !== undefined).map((a) => a.valueCents ?? "0"))).toBe(22_582_700n);
    expect(sum(Object.values(b.totals.byBucket))).toBe(BigInt(b.totals.totalCents));
    expect(sum(b.spending.byCategory.map((c) => c.cents))).toBe(BigInt(b.spending.categorizedCents));
  });

  it("strict: an unknown key is refused at every level", () => {
    const b = fixtureBaseline();
    expect(ok(RetirementBaseline, { ...b, extra: 1 })).toBe(false);
    expect(ok(RetirementBaseline, { ...b, window: { ...b.window, days: 365 } })).toBe(false);
    expect(ok(BaselineAccount, { ...b.accounts[0], color: "red" })).toBe(false);
    expect(ok(BaselineContribution, { ...b.contributions[0], note: "x" })).toBe(false);
    expect(ok(RetirementBaseline, { ...b, schemaVersion: 2 })).toBe(false);
  });

  it("C25: an account may carry its measured expense ratio and the share it covers", () => {
    const brokerage = fixtureBaseline().accounts.find((a) => a.accountId === IDS.B);
    expect(brokerage?.expenseRatio).toEqual({ ppm: 270, coveredBp: 10000 });
    expect(ok(BaselineExpenseRatio, { ppm: 1_000_000, coveredBp: 0 })).toBe(true);
    for (const bad of [{ ppm: -1, coveredBp: 0 }, { ppm: 1_000_001, coveredBp: 0 }, { ppm: 3, coveredBp: 10001 }, { ppm: 2.7, coveredBp: 0 }, { ppm: 3 }]) {
      expect(ok(BaselineExpenseRatio, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("enumerated fields refuse unknown members", () => {
    const account = fixtureBaseline().accounts[0];
    expect(ok(BaselineAccount, { ...account, valuationBasis: "guess" })).toBe(false);
    expect(ok(BaselineAccount, { ...account, bucket: "preTax" })).toBe(false);
    expect(ok(BaselineContribution, { ...fixtureBaseline().contributions[0], flags: ["weird"] })).toBe(false);
  });
});
