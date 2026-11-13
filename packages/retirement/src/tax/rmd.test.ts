import { describe, expect, it } from "vitest";
import { compileRmdTables, defaultRmdTables, firstRmdYear, requiredMinimumDistribution, rmdDivisor, rmdStartAge } from "./rmd.js";
import { rawTaxData, validateTaxData } from "./taxData.js";

// tax-rmd-ss §3.8 and tests G1 to G6 and G8 (§7); HC-R1 to HC-R3 of strategies-outputs-web §7.5;
// seams C36 (the Joint and Last Survivor table, × f in year 0 on the opening balance, capped at the
// balance). The divisors are Publication 590-B (2025) Appendix B, Tables II and III, as installed in
// data/rmd/. Dollar values with cents are asserted within 0.005 (tax-rmd-ss decision 50).

const near = (actual: number, expected: number, label = "") =>
  expect(Math.abs(actual - expected), `${label} ${actual} vs ${expected}`).toBeLessThanOrEqual(0.005);

const NO_SPOUSE = -1;

/** The RMD of an owner born in `birthYear` in calendar `year`, with no living spouse. */
const rmdIn = (balance: number, birthYear: number, year: number) =>
  requiredMinimumDistribution(balance, year - birthYear, rmdStartAge(birthYear), NO_SPOUSE);

describe("G1 the IRS's examples (Publication 590-B)", () => {
  it("G1 38,400 at 73 is 38,400 ÷ 26.5 = 1,449.06 (printed $1,450); 34,800 at 73 is 1,313.21 (printed $1,313)", () => {
    expect(rmdDivisor(73, NO_SPOUSE)).toBe(26.5);
    near(requiredMinimumDistribution(38400, 73, 73, NO_SPOUSE), 1449.06);
    near(requiredMinimumDistribution(34800, 73, 73, NO_SPOUSE), 1313.21);
  });

  it("G1 100,000 at 75 is 4,065.04; with a spouse aged 64, 100,000 ÷ 25.3 = 3,952.57", () => {
    near(requiredMinimumDistribution(100000, 75, 73, NO_SPOUSE), 4065.04);
    // 75 − 64 = 11 > 10: Table II at (75, 64), the publication's own example.
    expect(rmdDivisor(75, 64)).toBe(25.3);
    near(requiredMinimumDistribution(100000, 75, 73, 64), 3952.57);
  });
});

describe("G2 known balances", () => {
  it("G2 500,000 at 75 is 20,325.20; 100,000 at 73 is 3,773.58; 800,000 at 72 (born 1950) is 29,197.08; 250,000 at 80 is 12,376.24", () => {
    near(requiredMinimumDistribution(500000, 75, 73, NO_SPOUSE), 20325.2);
    near(requiredMinimumDistribution(100000, 73, 73, NO_SPOUSE), 3773.58);
    expect(rmdStartAge(1950)).toBe(72);
    near(rmdIn(800000, 1950, 2022), 29197.08);
    near(requiredMinimumDistribution(250000, 80, 73, NO_SPOUSE), 12376.24);
  });

  it("G2 age 125 uses the last row, 2.0", () => {
    expect(rmdDivisor(125, NO_SPOUSE)).toBe(2.0);
    expect(rmdDivisor(120, NO_SPOUSE)).toBe(2.0);
    near(requiredMinimumDistribution(100000, 125, 73, NO_SPOUSE), 50000);
  });
});

describe("G3 start ages", () => {
  it("G3 1950 gives 72; 1951 and 1959 give 73; 1960 gives 75", () => {
    expect(rmdStartAge(1950)).toBe(72);
    expect(rmdStartAge(1930)).toBe(72);
    expect(rmdStartAge(1951)).toBe(73);
    expect(rmdStartAge(1959)).toBe(73);
    expect(rmdStartAge(1960)).toBe(75);
    expect(rmdStartAge(1990)).toBe(75);
  });

  it("G3 born 1953: 0 in 2025 (72), due in 2026 (73)", () => {
    expect(rmdIn(500000, 1953, 2025)).toBe(0);
    near(rmdIn(500000, 1953, 2026), 500000 / 26.5);
  });

  it("G3 born 1960: 0 in 2034 (74), balance ÷ 24.6 in 2035", () => {
    expect(rmdIn(500000, 1960, 2034)).toBe(0);
    near(rmdIn(500000, 1960, 2035), 20325.2);
  });
});

describe("G4 the Joint and Last Survivor table (C36)", () => {
  it("G4 owner 75 with a spouse of 65 (10 years younger, not more) uses the Uniform divisor: 4,065.04", () => {
    expect(rmdDivisor(75, 65)).toBe(24.6);
    near(requiredMinimumDistribution(100000, 75, 73, 65), 4065.04);
  });

  it("G4 owner 73, spouse 60: 100,000 ÷ 28.6 = 3,496.50; no living spouse: Uniform", () => {
    expect(rmdDivisor(73, 60)).toBe(28.6);
    near(requiredMinimumDistribution(100000, 73, 73, 60), 3496.5);
    near(requiredMinimumDistribution(100000, 73, 73, NO_SPOUSE), 3773.58);
  });

  it("G4 the table's other spot values, and a spouse under 20 read at 20", () => {
    // tax-rmd-ss §2.5's checks, read through rmdDivisor (each pair is more than 10 years apart).
    expect(rmdDivisor(73, 62)).toBe(27.2);
    expect(rmdDivisor(73, 50)).toBe(36.8);
    expect(rmdDivisor(80, 65)).toBe(23.8);
    expect(rmdDivisor(85, 70)).toBe(19.5);
    expect(rmdDivisor(90, 75)).toBe(15.4);
    expect(rmdDivisor(100, 85)).toBe(8.5);
    expect(rmdDivisor(73, 15)).toBe(rmdDivisor(73, 20));
    expect(rmdDivisor(125, 100)).toBe(rmdDivisor(120, 100));
  });

  it("G4 without Table II (the fallback of §2.5) every owner uses the Uniform divisor", () => {
    const raw = structuredClone(rawTaxData());
    (raw.joint as { rows: unknown[] }).rows = [];
    const fallback = compileRmdTables(validateTaxData(raw));
    expect(fallback.joint).toBeNull();
    expect(rmdDivisor(73, 60, fallback)).toBe(26.5);
    near(requiredMinimumDistribution(100000, 73, 73, 60, 1, fallback), 3773.58);
    expect(defaultRmdTables().joint).not.toBeNull();
  });
});

describe("G5 plan year 0", () => {
  it("G5 500,000 at 75 with f = 2/12 is 3,387.53; with f = 3/12 is 5,081.30", () => {
    // 500,000 ÷ 24.6 = 20,325.2033 a year, times the fraction of the year in the plan.
    near(requiredMinimumDistribution(500000, 75, 73, NO_SPOUSE, 2 / 12), 3387.53);
    near(requiredMinimumDistribution(500000, 75, 73, NO_SPOUSE, 3 / 12), 5081.3);
    // A full year, whichever way YEAR_FRACTION spells it.
    near(requiredMinimumDistribution(500000, 75, 73, NO_SPOUSE, 1), 20325.2);
    near(requiredMinimumDistribution(500000, 75, 73, NO_SPOUSE, 0), 20325.2);
  });
});

describe("G6 the survivor owns the balance (decision 24)", () => {
  it("G6 A (born 1950) dies at the end of 2030; B (born 1958) owns 900,000 on 1 January 2031, is 73: 33,962.26", () => {
    // From 2031 B is the owner, with no spouse for Table II.
    near(rmdIn(900000, 1958, 2031), 33962.26);
  });

  it("G6 had B been born in 1960 (71 in 2031) the RMD is 0 until 2035", () => {
    for (const y of [2031, 2032, 2033, 2034]) expect(rmdIn(900000, 1960, y)).toBe(0);
    near(rmdIn(900000, 1960, 2035), 900000 / 24.6);
  });
});

describe("G8 two accounts of one owner", () => {
  it("G8 300,000 and 700,000 at 80: 49,504.95 in all, 14,851.49 and 34,653.47", () => {
    // One divisor per owner (20.2 at 80), so the per-account amounts are the total taken pro rata.
    const a = requiredMinimumDistribution(300000, 80, 73, NO_SPOUSE);
    const b = requiredMinimumDistribution(700000, 80, 73, NO_SPOUSE);
    const total = requiredMinimumDistribution(1000000, 80, 73, NO_SPOUSE);
    near(a, 14851.49);
    near(b, 34653.47);
    near(total, 49504.95);
    expect(Math.abs(a + b - total)).toBeLessThan(1e-9);
    expect(Math.abs(a - total * 0.3)).toBeLessThan(1e-9);
  });
});

describe("HC-R the hand-calculated RMD cases (strategies-outputs-web §7.5)", () => {
  it("HC-R1 the Pub. 590-B example: 100,000 at 75 is 100,000 ÷ 24.6 = 4,065.04", () => {
    // An owner born in 1951 (start age 73) at 75 in 2026.
    near(rmdIn(100000, 1951, 2026), 4065.04);
  });

  it("HC-R2 500,000 at 73; 250,000 at 80; 100,000 at 100; 50,000 at 121: 18,867.92; 12,376.24; 15,625.00; 25,000.00", () => {
    // Divisors 26.5, 20.2, 6.4 and 2.0 (121 reads the "120 and over" row).
    near(requiredMinimumDistribution(500000, 73, 73, NO_SPOUSE), 18867.92);
    near(requiredMinimumDistribution(250000, 80, 73, NO_SPOUSE), 12376.24);
    near(requiredMinimumDistribution(100000, 100, 73, NO_SPOUSE), 15625.0);
    near(requiredMinimumDistribution(50000, 121, 73, NO_SPOUSE), 25000.0);
  });

  it("HC-R3 first RMD year: born 1951 → 2024; 1958 → 2031; 1959 → 2032; 1960 → 2035; 1961 → 2036", () => {
    expect([1951, 1958, 1959, 1960, 1961].map((b) => firstRmdYear(b))).toEqual([2024, 2031, 2032, 2035, 2036]);
    // The year before the first RMD year owes nothing; the first year owes balance ÷ divisor.
    for (const b of [1951, 1958, 1959, 1960, 1961]) {
      expect(rmdIn(100000, b, firstRmdYear(b) - 1)).toBe(0);
      expect(rmdIn(100000, b, firstRmdYear(b))).toBeGreaterThan(0);
    }
  });
});

describe("guards", () => {
  it("nothing before the start age or on a non-positive balance; never more than the balance", () => {
    expect(requiredMinimumDistribution(100000, 72, 73, NO_SPOUSE)).toBe(0);
    expect(requiredMinimumDistribution(0, 80, 73, NO_SPOUSE)).toBe(0);
    expect(requiredMinimumDistribution(-5, 80, 73, NO_SPOUSE)).toBe(0);
    // Every installed divisor is at least 1 (Table II reaches 1.0 at (120, 120)), so with f ≤ 1 the
    // amount never exceeds the balance; the cap is checked on a table with a divisor below 1.
    const tables = defaultRmdTables();
    for (const d of tables.uniform) expect(d).toBeGreaterThanOrEqual(2);
    for (const d of tables.joint!) expect(d).toBeGreaterThanOrEqual(1);
    for (let age = 73; age <= 125; age++) {
      for (const spouse of [NO_SPOUSE, 20, 40, 60, age - 11, age - 10, age]) {
        const r = requiredMinimumDistribution(1000, age, 73, spouse);
        expect(r).toBeGreaterThan(0);
        expect(r).toBeLessThanOrEqual(1000);
      }
    }
    const below1 = { ...tables, uniform: new Float64Array(tables.uniform.length).fill(0.5) };
    expect(rmdDivisor(80, NO_SPOUSE, below1)).toBe(0.5);
    expect(requiredMinimumDistribution(1000, 80, 73, NO_SPOUSE, 1, below1)).toBe(1000);
    expect(requiredMinimumDistribution(1000, 80, 73, NO_SPOUSE, 0.25, below1)).toBe(500);
  });

  it("the divisor falls with age and with an older spouse", () => {
    for (let age = 73; age < 120; age++) expect(rmdDivisor(age + 1, NO_SPOUSE)).toBeLessThan(rmdDivisor(age, NO_SPOUSE));
    for (let s = 20; s < 62; s++) expect(rmdDivisor(73, s + 1)).toBeLessThanOrEqual(rmdDivisor(73, s));
  });
});
