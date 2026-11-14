/**
 * The deterministic reference scenarios R1 and R2 as frozen inputs (seams C1, C50; D14), written
 * from `reference/sheets/r1.md` §1 and `reference/sheets/r2.md` §1 with the builder of this module's
 * neighbour. The engine's own suites run them (build step 19: WD-5, WD-15, WD-16 and WD-21); build
 * step 22b can write `reference/fixtures/r1.input.json` and `r2.input.json` from them.
 *
 * Money in the sheets is dollars; here it is integer cents in decimal strings, rates in basis
 * points and the fixed series in parts per million, as `SimInput` requires.
 */

import type { SimInput, SimInputAccount, TaxSettingsInput } from "@meridian/shared";
import { account, buildSimInput, cashAccount, incomeStream } from "./simInput.js";

const W = (us: number, bonds: number, cash = 0) => ({ us_stock: us, intl_stock: 0, bonds, cash, real_estate: 0, other: 0 });

/** R1 (r1.md §1): a couple born January 1962, retired at the plan start, both alive through 2047. */
export function referenceR1Input(): SimInput {
  const accounts: SimInputAccount[] = [
    { ...cashAccount("cash", "4000000"), type: "checking" },
    account("taxable", "taxable", "40000000", { type: "brokerage", basisCents: "25000000", allocation: W(10000, 0) }),
    account("pre_tax_a", "pre_tax", "90000000", { type: "ira", owner: "p1", allocation: W(10000, 0) }),
    account("pre_tax_b", "pre_tax", "30000000", { type: "ira", owner: "p2", allocation: W(10000, 0) }),
    account("roth_a", "roth", "15000000", { type: "roth", owner: "p1", rothContributionBasisCents: "0", allocation: W(10000, 0) }),
  ];
  const tax: TaxSettingsInput = { includePayrollTax: true, taxDrag: { us_stock: { dividendYieldBp: 0 } } };
  return buildSimInput({
    startYear: 2027,
    people: [
      { birthYear: 1962, retirementMonth: "2027-01", longevity: { mode: "fixed", age: 85 } },
      { birthYear: 1962, retirementMonth: "2027-01", longevity: { mode: "fixed", age: 85 } },
    ],
    endYear: 2047,
    accounts,
    incomes: [incomeStream("pension_b", "pension", "1200000", "2027-01", { personId: "p2", dollars: "nominal", cola: { mode: "none" } })],
    socialSecurity: {
      people: [
        { personId: "p1", mode: "estimate", monthlyAtFraCents: "300000", asOfYear: 2027, claimMonth: "2029-01", claimAgeMonths: 804 },
        { personId: "p2", mode: "estimate", monthlyAtFraCents: "180000", asOfYear: 2027, claimMonth: "2029-01", claimAgeMonths: 804 },
      ],
      spousal: true,
      survivor: true,
    },
    spending: {
      baseAnnualCents: "13000000",
      essentialAnnualCents: "13000000",
      startMonth: "2027-01",
      survivorBp: 10000,
      phases: [
        { fromYear: 2037, multiplierBp: 9000 },
        { fromYear: 2042, multiplierBp: 7000 },
      ],
      goals: [{ id: "goal_2030", name: "goal", year: 2030, amountCents: "4000000", dollars: "today" }],
      healthcare: [],
      longTermCare: [],
    },
    rothConversions: [
      { year: 2027, personId: "p1", amountCents: "8000000", dollars: "nominal" },
      { year: 2028, personId: "p1", amountCents: "11000000", dollars: "nominal" },
    ],
    returnModel: { kind: "fixed", series: [{ stocksPpm: 50000, bondsPpm: 50000, billsPpm: 50000, inflationPpm: 25000 }] },
    portfolio: { taxableRebalance: "full" },
    strategy: { kind: "constant_dollar" },
    cashReserveCents: "0",
    taxRuleSet: "current_law",
    tax,
    seed: 1,
    state: "CO",
  });
}

/**
 * R2 (r2.md §1): person 1 born January 1958 (dies at the end of 2034), person 2 born January 1961
 * (alive through 2056); yields, the HSA, a cash reserve of 20,000 today's dollars, long-term care.
 */
export function referenceR2Input(): SimInput {
  const accounts: SimInputAccount[] = [
    { ...cashAccount("cash", "4000000"), type: "checking" },
    account("taxable", "taxable", "50000000", { type: "brokerage", basisCents: "34000000", allocation: W(6000, 4000) }),
    account("pre_tax_1", "pre_tax", "40000000", { type: "ira", owner: "p1", allocation: W(6000, 4000) }),
    account("pre_tax_2", "pre_tax", "15000000", { type: "ira", owner: "p2", allocation: W(6000, 4000) }),
    account("roth_1", "roth", "6000000", { type: "roth", owner: "p1", rothContributionBasisCents: "0", allocation: W(10000, 0) }),
    account("roth_2", "roth", "4000000", { type: "roth", owner: "p2", rothContributionBasisCents: "0", allocation: W(10000, 0) }),
    account("hsa_2", "hsa", "2000000", { type: "hsa", owner: "p2", allocation: W(6000, 4000) }),
  ];
  const health = (personId: "p1" | "p2") => ({
    personId,
    preMedicareAnnualCents: "600000",
    preMedicareFrom: "2027-01",
    medicareFrom: "2027-01",
    medicareAnnualCents: "600000",
    realGrowthBp: 0,
    inBase: false,
  });
  const tax: TaxSettingsInput = { includePayrollTax: true, taxDrag: { us_stock: { dividendYieldBp: 150, qualifiedShareBp: 10000 } } };
  return buildSimInput({
    startYear: 2027,
    people: [
      { birthYear: 1958, retirementMonth: "2027-01", longevity: { mode: "fixed", age: 76 } },
      { birthYear: 1961, retirementMonth: "2027-01", longevity: { mode: "fixed", age: 95 } },
    ],
    endYear: 2056,
    accounts,
    socialSecurity: {
      people: [
        { personId: "p1", mode: "receiving", monthlyCents: "250000", asOfYear: 2027, startedMonth: "2024-09", monthlyAtFraCents: "250000" },
        { personId: "p2", mode: "estimate", monthlyAtFraCents: "150000", asOfYear: 2027, claimMonth: "2028-01", claimAgeMonths: 804 },
      ],
      spousal: true,
      survivor: true,
    },
    spending: {
      baseAnnualCents: "9960000",
      essentialAnnualCents: "9960000",
      startMonth: "2027-01",
      survivorBp: 7000,
      phases: [],
      goals: [{ id: "goal_2030", name: "goal", year: 2030, amountCents: "3000000", dollars: "today" }],
      healthcare: [health("p1"), health("p2")],
      longTermCare: [{ personId: "p2", reserveCents: "6000000", lastYears: 2 }],
    },
    rothConversions: [
      { year: 2028, personId: "p1", amountCents: "2000000", dollars: "today" },
      { year: 2029, personId: "p1", amountCents: "2000000", dollars: "today" },
    ],
    returnModel: { kind: "fixed", series: [{ stocksPpm: 60000, bondsPpm: 40000, billsPpm: 20000, inflationPpm: 25000 }] },
    portfolio: { taxableRebalance: "full" },
    strategy: { kind: "constant_dollar" },
    cashReserveCents: "2000000",
    taxRuleSet: "current_law",
    tax,
    seed: 1,
    state: "CO",
  });
}
