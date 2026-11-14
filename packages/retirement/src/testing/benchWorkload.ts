/**
 * The reference workload of the performance budget (engine-and-returns §3.15), as a `SimInput`:
 * two people aged 45 and 43 in 2026 (born June 1981 and March 1983), planned to ages 104 and 102
 * (fixed life expectancy; Y = 60, 2026 to 2085), a plan from November 2026 (the design's
 * `asOf = 2026-11-10` under seams C14: `firstYearMonths` 2), seven accounts (taxable, two
 * pre-tax of which one follows a glide path, two Roth, an HSA, cash), two salaries, one pension,
 * five contributions and constant real spending, with the default withdrawal order and the real
 * tax, RMD and Social Security functions.
 *
 * The design names the shape, not the amounts; the amounts here are this file's choice and are not
 * expected values of anything. Beyond the design's list, both people claim Social Security at 67,
 * so the month loop of the tax area (seams F13) is part of what is measured.
 *
 * Used by `bench/run.ts` and by T47's guard (`src/node/perf.test.ts`).
 */

import type { ReturnModelConfigInput, SimInput } from "@meridian/shared";
import { account, buildSimInput, cashAccount, incomeStream } from "./simInput.js";

const mix = (us: number, intl: number, bonds: number, cash: number) => ({ us_stock: us, intl_stock: intl, bonds, cash, real_estate: 0, other: 0 });

/** The parametric (`historical` preset) and bootstrap (mean block 10) models the budget is measured on. */
export const BENCH_MODELS = {
  parametric: { kind: "parametric", preset: "historical" },
  bootstrap: { kind: "bootstrap", meanBlockYears: 10 },
} as const satisfies Record<string, ReturnModelConfigInput>;

export function benchWorkloadInput(returnModel: ReturnModelConfigInput = BENCH_MODELS.bootstrap, paths = 10_000, seed = 1): SimInput {
  return buildSimInput({
    startYear: 2026,
    startMonth: 11,
    people: [
      { birthYear: 1981, birthMonth: 6, retirementMonth: "2046-06", longevity: { mode: "fixed", age: 104 } },
      { birthYear: 1983, birthMonth: 3, retirementMonth: "2048-03", longevity: { mode: "fixed", age: 102 } },
    ],
    accounts: [
      account("taxable", "taxable", "30000000", { type: "brokerage", basisCents: "22000000", basisCoverage: "full", allocation: mix(6000, 2000, 1500, 500), expenseRatioPpm: 400 }),
      account("k1", "pre_tax", "40000000", {
        type: "401k",
        owner: "p1",
        allocation: mix(7000, 2000, 1000, 0),
        glidePath: [
          { year: 2026, weights: mix(7000, 2000, 1000, 0) },
          { year: 2046, weights: mix(4000, 1000, 4500, 500) },
        ],
        expenseRatioPpm: 800,
      }),
      account("k2", "pre_tax", "20000000", { type: "401k", owner: "p2", allocation: mix(6000, 2000, 2000, 0), expenseRatioPpm: 500 }),
      account("r1", "roth", "8000000", { type: "roth", owner: "p1", rothContributionBasisCents: "4000000", allocation: mix(8000, 2000, 0, 0) }),
      account("r2", "roth", "6000000", { type: "roth", owner: "p2", rothContributionBasisCents: "3000000", allocation: mix(8000, 2000, 0, 0) }),
      account("hsa", "hsa", "3000000", { type: "hsa", owner: "p1", allocation: mix(6000, 2000, 2000, 0) }),
      cashAccount("cash", "4000000"),
    ],
    incomes: [
      incomeStream("salary_p1", "salary", "15000000", "2026-11", { personId: "p1", endMonth: "2046-06", realGrowthBp: 100 }),
      incomeStream("salary_p2", "salary", "9000000", "2026-11", { personId: "p2", endMonth: "2048-03", realGrowthBp: 100 }),
      incomeStream("pension_p2", "pension", "2000000", "2048-03", { personId: "p2", dollars: "nominal", cola: { mode: "none" }, survivorBp: 5000 }),
    ],
    contributions: [
      { accountId: "k1", employeeAnnualCents: "2000000", employerAnnualCents: "600000", scaleWith: "p1", salaryBasisCents: "15000000", endMonth: "2046-06" },
      { accountId: "k2", employeeAnnualCents: "1500000", employerAnnualCents: "450000", scaleWith: "p2", salaryBasisCents: "9000000", endMonth: "2048-03" },
      { accountId: "r1", employeeAnnualCents: "700000", employerAnnualCents: "0", scaleWith: "p1", salaryBasisCents: "15000000", endMonth: "2046-06" },
      { accountId: "r2", employeeAnnualCents: "700000", employerAnnualCents: "0", scaleWith: "p2", salaryBasisCents: "9000000", endMonth: "2048-03" },
      { accountId: "hsa", employeeAnnualCents: "400000", employerAnnualCents: "0", scaleWith: "p1", salaryBasisCents: "15000000", endMonth: "2046-06" },
    ],
    socialSecurity: {
      people: [
        { personId: "p1", mode: "estimate", monthlyAtFraCents: "320000", asOfYear: 2026, claimMonth: "2048-06", claimAgeMonths: 804 },
        { personId: "p2", mode: "estimate", monthlyAtFraCents: "210000", asOfYear: 2026, claimMonth: "2050-03", claimAgeMonths: 804 },
      ],
      spousal: true,
      survivor: true,
    },
    spending: { baseAnnualCents: "13000000", essentialAnnualCents: "8000000", startMonth: "2046-06" },
    returnModel,
    paths,
    seed,
  });
}
