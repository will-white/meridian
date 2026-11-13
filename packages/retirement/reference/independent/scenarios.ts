// The inputs of R1 and R2, transcribed from r1.md §1 and r2.md §1 (dollars; rates as decimals).

import type { Scenario } from "./deterministic.js";

const ALL_STOCK = { stocks: 1, bonds: 0, bills: 0 } as const;
const SIXTY_FORTY = { stocks: 0.6, bonds: 0.4, bills: 0 } as const;
const CASH = { stocks: 0, bonds: 0, bills: 1 } as const;

/** r1.md §1: a deterministic couple, both born January 1962, alive through 2047. */
export const R1: Scenario = {
  id: "r1",
  startYear: 2027,
  endYear: 2047,
  persons: [
    { id: "p1", birthYear: 1962, birthMonth: 1, lastAliveYear: 2047 },
    { id: "p2", birthYear: 1962, birthMonth: 1, lastAliveYear: 2047 },
  ],
  accounts: [
    { id: "cash", bucket: "cash", owner: "joint", balance: 40_000, basis: 0, weights: CASH },
    { id: "taxable", bucket: "taxable", owner: "joint", balance: 400_000, basis: 250_000, weights: ALL_STOCK },
    { id: "pre_tax_a", bucket: "pre_tax", owner: "p1", balance: 900_000, basis: 0, weights: ALL_STOCK },
    { id: "pre_tax_b", bucket: "pre_tax", owner: "p2", balance: 300_000, basis: 0, weights: ALL_STOCK },
    { id: "roth_a", bucket: "roth", owner: "p1", balance: 150_000, basis: 0, weights: ALL_STOCK },
  ],
  // 50000, 50000, 50000 and 25000 ppm.
  returns: { stocks: 50_000 / 1e6, bonds: 50_000 / 1e6, bills: 50_000 / 1e6 },
  inflation: 25_000 / 1e6,
  pensions: [{ personId: "p2", annual: 12_000 }],
  socialSecurity: [
    { id: "p1", birthYear: 1962, birthMonth: 1, pia: 3_000, claimYear: 2029, claimMonth: 1, lastAliveYear: 2047 },
    { id: "p2", birthYear: 1962, birthMonth: 1, pia: 1_800, claimYear: 2029, claimMonth: 1, lastAliveYear: 2047 },
  ],
  spending: {
    base: 130_000,
    phases: [
      { fromYear: 2037, multiplier: 9000 / 10000 },
      { fromYear: 2042, multiplier: 7000 / 10000 },
    ],
    survivorShare: 10000 / 10000,
    goals: [{ year: 2030, amount: 40_000 }],
    healthcarePerPerson: 0,
    longTermCare: [],
  },
  conversions: [
    { personId: "p1", year: 2027, amount: 80_000, dollars: "nominal" },
    { personId: "p1", year: 2028, amount: 110_000, dollars: "nominal" },
  ],
  cashReserve: 0,
  dividendYield: 0, // taxDrag override { us_stock: { dividendYieldBp: 0 } }
  qualifiedShare: 1,
  bondSpread: 100 / 10000, // no bonds held: never used
  jointBasisShare: 0.5,
};

/** r2.md §1: yields, the HSA, a cash reserve and a first death at the end of 2034. */
export const R2: Scenario = {
  id: "r2",
  startYear: 2027,
  endYear: 2056,
  persons: [
    { id: "p1", birthYear: 1958, birthMonth: 1, lastAliveYear: 2034 },
    { id: "p2", birthYear: 1961, birthMonth: 1, lastAliveYear: 2056 },
  ],
  accounts: [
    { id: "cash", bucket: "cash", owner: "joint", balance: 40_000, basis: 0, weights: CASH },
    { id: "taxable", bucket: "taxable", owner: "joint", balance: 500_000, basis: 340_000, weights: SIXTY_FORTY },
    { id: "pre_tax_1", bucket: "pre_tax", owner: "p1", balance: 400_000, basis: 0, weights: SIXTY_FORTY },
    { id: "pre_tax_2", bucket: "pre_tax", owner: "p2", balance: 150_000, basis: 0, weights: SIXTY_FORTY },
    { id: "roth_1", bucket: "roth", owner: "p1", balance: 60_000, basis: 0, weights: ALL_STOCK },
    { id: "roth_2", bucket: "roth", owner: "p2", balance: 40_000, basis: 0, weights: ALL_STOCK },
    { id: "hsa_2", bucket: "hsa", owner: "p2", balance: 20_000, basis: 0, weights: SIXTY_FORTY },
  ],
  // 60000, 40000, 20000 and 25000 ppm.
  returns: { stocks: 60_000 / 1e6, bonds: 40_000 / 1e6, bills: 20_000 / 1e6 },
  inflation: 25_000 / 1e6,
  pensions: [],
  socialSecurity: [
    // receiving since 2024-09 (his full retirement age), 2,500.00 a month
    { id: "p1", birthYear: 1958, birthMonth: 1, pia: 2_500, claimYear: 2024, claimMonth: 9, lastAliveYear: 2034 },
    // estimate, 1,500.00 at full retirement age, claim 2028-01
    { id: "p2", birthYear: 1961, birthMonth: 1, pia: 1_500, claimYear: 2028, claimMonth: 1, lastAliveYear: 2056 },
  ],
  spending: {
    base: 99_600,
    phases: [],
    survivorShare: 7000 / 10000,
    goals: [{ year: 2030, amount: 30_000 }],
    healthcarePerPerson: 6_000,
    longTermCare: [{ personId: "p2", reserve: 60_000, lastYears: 2 }],
  },
  conversions: [
    { personId: "p1", year: 2028, amount: 20_000, dollars: "today" },
    { personId: "p1", year: 2029, amount: 20_000, dollars: "today" },
  ],
  cashReserve: 20_000,
  dividendYield: 150 / 10000, // taxDrag override { us_stock: { dividendYieldBp: 150, qualifiedShareBp: 10000 } }
  qualifiedShare: 10000 / 10000,
  bondSpread: 100 / 10000, // the default interest spread of 1.00%, no tax-exempt share
  jointBasisShare: 0.5, // Colorado is not a community-property state
};
