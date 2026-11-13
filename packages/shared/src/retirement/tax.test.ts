import { describe, expect, it } from "vitest";
import {
  DEFAULT_TAX_SETTINGS,
  defaultTaxSettings,
  FederalTaxPreviewRequest,
  FederalTaxPreviewResponse,
  FederalYearRecord,
  RetirementRulesView,
  RuleSetId,
  SocialSecurityPreviewRequest,
  SocialSecurityPreviewResponse,
  TaxDragOverride,
  TaxSettings,
  TaxYearDetail,
} from "./tax.js";
import { forbiddenValuePaths, zeroTaxDetail } from "./testFixtures.js";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => schema.safeParse(value).success;

/**
 * A year file with synthetic figures (round numbers, not law): it exercises the shape only. The
 * real files are packages/retirement/data/tax/federal-YYYY.json with their sources (step 4).
 */
function syntheticYearRecord() {
  const both = (single: number) => ({ single, mfj: single * 2 });
  return {
    schemaVersion: 1,
    taxYear: 2026,
    ordinary: {
      rates: [0.1, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37],
      thresholds: { single: [0, 10_000, 40_000, 90_000, 180_000, 230_000, 600_000], mfj: [0, 20_000, 80_000, 180_000, 360_000, 460_000, 700_000] },
    },
    standardDeduction: both(15_000),
    additionalAged: { single: 2_000, mfj: 1_600 },
    seniorDeduction: { amountPerPerson: 5_000, minAge: 65, phaseoutRate: 0.05, phaseoutStart: both(70_000) },
    capitalGains: { rates: [0, 0.15, 0.2], zeroRateMax: both(45_000), fifteenRateMax: both(500_000), netLossLimit: 3_000 },
    niit: { rate: 0.038, threshold: { single: 200_000, mfj: 250_000 } },
    socialSecurityTaxation: { base1: { single: 25_000, mfj: 32_000 }, base2: { single: 34_000, mfj: 44_000 }, rate1: 0.5, rate2: 0.85, maxShare: 0.85 },
    additionalTaxes: { earlyDistributionRate: 0.1, hsaNonQualifiedRate: 0.2 },
    contributionLimits: {
      employeeDeferral: 20_000,
      catchUp50: 7_000,
      catchUp60to63: 10_000,
      annualAdditions: 60_000,
      ira: 7_000,
      iraCatchUp50: 1_000,
      hsaSelf: 4_000,
      hsaFamily: 8_000,
      hsaCatchUp55: 1_000,
      pending: ["employeeDeferral", "ira"],
    },
    payroll: { oasdiRate: 0.062, oasdiWageBase: 150_000, medicareRate: 0.0145, additionalMedicareRate: 0.009, additionalMedicareThreshold: { single: 200_000, mfj: 250_000 } },
    socialSecurity: { cola: 0.02, earningsTestUnderFra: 20_000, earningsTestFraYear: 50_000 },
    sources: [{ title: "Synthetic test record", url: "https://example.invalid/record.pdf", retrieved: "2026-11-13", sha256: null }],
  };
}

describe("TaxSettings (tax-rmd-ss §4.3)", () => {
  it("the defaults: no wedge, no real wage growth, payroll tax on (C27), no loss carried in, no yield overrides", () => {
    const expected = { chainedCpiWedgeBp: 0, realWageGrowthBp: 0, includePayrollTax: true, capLossCarryInCents: "0", taxDrag: {} };
    expect(TaxSettings.parse({})).toEqual(expected);
    expect(DEFAULT_TAX_SETTINGS).toEqual(expected);
    expect(defaultTaxSettings()).toEqual(expected);
    expect(defaultTaxSettings()).not.toBe(defaultTaxSettings());
    expect(forbiddenValuePaths(DEFAULT_TAX_SETTINGS)).toEqual([]);
  });

  it("ranges, integers, bounded cents and asset-class keys", () => {
    expect(ok(TaxSettings, { taxDrag: { intl_stock: { dividendYieldBp: 280, qualifiedShareBp: 7500 } } })).toBe(true);
    expect(ok(TaxSettings, { taxDrag: { gold: { dividendYieldBp: 0 } } })).toBe(false);
    expect(ok(TaxSettings, { chainedCpiWedgeBp: 101 })).toBe(false);
    expect(ok(TaxSettings, { chainedCpiWedgeBp: 25.5 })).toBe(false);
    expect(ok(TaxSettings, { realWageGrowthBp: 301 })).toBe(false);
    expect(ok(TaxSettings, { capLossCarryInCents: "-100" })).toBe(false);
    expect(ok(TaxSettings, { capLossCarryInCents: "1000000000000000" })).toBe(false);
    expect(ok(TaxDragOverride, { dividendYieldBp: 1501 })).toBe(false);
    expect(ok(TaxDragOverride, { interestSpreadBp: 1001 })).toBe(false);
    expect(ok(TaxDragOverride, { gainDistributionRateBp: 2001 })).toBe(false);
    expect(ok(TaxDragOverride, { qualifiedShareBp: 0.95 })).toBe(false);
  });

  it("strict", () => {
    expect(ok(TaxSettings, { stateTax: true })).toBe(false);
    expect(ok(TaxDragOverride, { yieldBp: 1 })).toBe(false);
  });

  it("rule set ids", () => {
    for (const id of ["current_law", "tcja_sunset", "a"]) expect(ok(RuleSetId, id), id).toBe(true);
    for (const id of ["Current", "1law", "", "a".repeat(41), "law-change"]) expect(ok(RuleSetId, id), id).toBe(false);
  });
});

describe("TaxYearDetail (stored in a year row, seams C37)", () => {
  it("parses a year's detail; strict; integers and cents strings only", () => {
    const detail = { ...zeroTaxDetail("married_joint"), totalFederalCents: "469600", incomeTaxCents: "469600", ordinaryTaxCents: "469600", agiCents: "9200000", bracketRateBp: 1200 };
    expect(TaxYearDetail.parse(detail)).toEqual(detail);
    expect(forbiddenValuePaths(detail)).toEqual([]);
    expect(ok(TaxYearDetail, { ...detail, agiCents: "-500" })).toBe(true);
    expect(ok(TaxYearDetail, { ...detail, niitCents: "-1" })).toBe(false);
    expect(ok(TaxYearDetail, { ...detail, bracketRateBp: 0.12 })).toBe(false);
    expect(ok(TaxYearDetail, { ...detail, stateTaxCents: "0" })).toBe(false);
    expect(ok(TaxYearDetail, { ...detail, filingStatus: "married_separate" })).toBe(false);
  });
});

describe("FederalYearRecord (data, tax-rmd-ss §2.2)", () => {
  it("a year file parses; its rates are fractions and its amounts dollars", () => {
    const record = syntheticYearRecord();
    expect(FederalYearRecord.parse(record)).toEqual(record);
  });

  it("seven brackets, three gain rates, known pending fields, a source with a hash or null", () => {
    const record = syntheticYearRecord();
    expect(ok(FederalYearRecord, { ...record, ordinary: { ...record.ordinary, rates: record.ordinary.rates.slice(0, 6) } })).toBe(false);
    expect(ok(FederalYearRecord, { ...record, capitalGains: { ...record.capitalGains, rates: [0, 0.15] } })).toBe(false);
    expect(ok(FederalYearRecord, { ...record, contributionLimits: { ...record.contributionLimits, pending: ["hsaCatchUp55"] } })).toBe(false);
    expect(ok(FederalYearRecord, { ...record, sources: [] })).toBe(false);
    expect(ok(FederalYearRecord, { ...record, sources: [{ ...record.sources[0], sha256: "ABC" }] })).toBe(false);
    expect(ok(FederalYearRecord, { ...record, taxYear: 2025 })).toBe(false);
    expect(ok(FederalYearRecord, { ...record, extra: 1 })).toBe(false);
  });
});

describe("previews (routes 23 and 24)", () => {
  it("B1 and B2 as requests; everything not sent is 0", () => {
    const b1 = FederalTaxPreviewRequest.parse({ year: 2026, filingStatus: "single", ages: [40], wagesCents: "10000000" });
    expect(b1).toMatchObject({ year: 2026, filingStatus: "single", ages: [40], indexFactorBp: 10000, ruleSetId: "current_law", wagesCents: "10000000", pensionCents: "0", longTermGainCents: "0" });
    const b2 = FederalTaxPreviewRequest.parse({ year: 2026, filingStatus: "married_joint", ages: [45, 45], wagesCents: "18000000" });
    expect(b2.ages).toEqual([45, 45]);
  });

  it("one age per filer; gains may be negative, other amounts may not", () => {
    expect(FederalTaxPreviewRequest.safeParse({ year: 2026, filingStatus: "single", ages: [40, 41] }).error?.issues[0]).toMatchObject({ message: "one age per filer", path: ["ages"] });
    expect(ok(FederalTaxPreviewRequest, { year: 2026, filingStatus: "married_joint", ages: [40] })).toBe(false);
    expect(ok(FederalTaxPreviewRequest, { year: 2026, filingStatus: "single", ages: [40], longTermGainCents: "-300000" })).toBe(true);
    expect(ok(FederalTaxPreviewRequest, { year: 2026, filingStatus: "single", ages: [40], wagesCents: "-1" })).toBe(false);
    expect(ok(FederalTaxPreviewRequest, { year: 2025, filingStatus: "single", ages: [40] })).toBe(false);
    expect(ok(FederalTaxPreviewRequest, { year: 2026, filingStatus: "single", ages: [40], stateCents: "0" })).toBe(false);
  });

  it("the Social Security preview takes one or two people with claim ages 62 to 70", () => {
    const person = { birthYear: 1975, birthMonth: 6, monthlyAtFraCents: "280000", asOfYear: 2026, claimAgeMonths: 804 };
    expect(ok(SocialSecurityPreviewRequest, { people: [person], startYear: 2026 })).toBe(true);
    expect(ok(SocialSecurityPreviewRequest, { people: [person, person], startYear: 2026 })).toBe(true);
    expect(ok(SocialSecurityPreviewRequest, { people: [], startYear: 2026 })).toBe(false);
    expect(ok(SocialSecurityPreviewRequest, { people: [person, person, person], startYear: 2026 })).toBe(false);
    expect(ok(SocialSecurityPreviewRequest, { people: [{ ...person, claimAgeMonths: 743 }], startYear: 2026 })).toBe(false);
    expect(ok(SocialSecurityPreviewRequest, { people: [{ ...person, claimAgeMonths: 841 }], startYear: 2026 })).toBe(false);
    expect(ok(SocialSecurityPreviewRequest, { people: [{ ...person, sex: "male" }], startYear: 2026 })).toBe(false);
  });

  it("responses parse", () => {
    expect(
      ok(FederalTaxPreviewResponse, {
        dataVersion: "2026.11.0",
        dataStatus: "published",
        detail: zeroTaxDetail("single"),
        provisionalIncomeCents: "0",
        unusedDeductionCents: "0",
        roomInBracketCents: null,
        roomAtZeroGainsCents: "0",
        lossUsedCents: "0",
        marginalOrdinaryRate: 0.22,
        marginalGainRate: 0.15,
        lines: [{ form: "1040", line: "15", label: "Taxable income", cents: "0" }],
      }),
    ).toBe(true);
    expect(
      ok(SocialSecurityPreviewResponse, {
        people: [{ fraMonths: 804, survivorFraMonths: 804, piaAtStartCents: "280000", byClaimAge: [{ claimAgeMonths: 744, factorBp: 7000, monthlyCents: "196000", spousalMonthlyCents: "0" }], survivorMonthlyAtFraCents: "0" }],
      }),
    ).toBe(true);
    expect(
      ok(RetirementRulesView, {
        dataVersion: "2026.11.0",
        firstTaxYear: 2026,
        lastPublishedYear: 2027,
        stale: false,
        pendingLimits: [{ year: 2027, fields: ["employeeDeferral"] }],
        years: [syntheticYearRecord()],
        ruleSets: [{ id: "current_law", label: "Current law", illustrative: false, lawChanges: [] }],
        indexing: [{ path: "standardDeduction", index: "cpi", round: "floor_increase" }],
        taxDrag: { us_stock: { dividendYieldBp: 130, qualifiedShareBp: 9500, interestSpreadBp: null, taxExemptShareBp: 0, gainDistributionRateBp: 0 } },
        notModelled: [{ id: "state_tax", label: "State income tax", effect: "Colorado tax is not included" }],
        socialSecurityRules: [{ id: "cola", label: "COLA", status: "secondary" }],
        sources: [{ file: "tax/federal-2026.json", title: "Synthetic", url: "https://example.invalid/", retrieved: "2026-11-13", sha256: null }],
        disclaimer: "x",
      }),
    ).toBe(true);
  });
});
