import { z } from "zod";
import { AssetClass } from "../enums.js";
import { CentsInput, CentsString, NonNegCentsInput, NonNegCentsString } from "../wire.js";
import { bp, PlanCents, PlanYear } from "./primitives.js";

/**
 * Tax wire shapes (tax-rmd-ss §4.3). Requests use the bounded inputs; responses use
 * `CentsString` (signed) and `NonNegCentsString`. `TaxSettings` is stored inside `RunSettings`
 * and `TaxYearDetail` inside a stored year row, so both are integers and strings only. The
 * year file (`FederalYearRecord`) is data: its rates and dollar amounts are JSON numbers as the
 * revenue procedures print them.
 */

export const TaxFilingStatus = z.enum(["single", "married_joint"]);
export type TaxFilingStatus = z.infer<typeof TaxFilingStatus>;

/** A tax rule set id from `tax/rules.json` (`current_law` is always present). */
export const RuleSetId = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "a rule set id");
export type RuleSetId = z.infer<typeof RuleSetId>;
export const DEFAULT_RULE_SET_ID = "current_law";

/** A dollar amount by filing status, as the year files spell it. */
export const PerStatus = z.object({ single: z.number().nonnegative(), mfj: z.number().nonnegative() }).strict();
export type PerStatus = z.infer<typeof PerStatus>;

/** Where a figure of a data file was read: the document, its URL, the retrieval date and the file's SHA-256. */
export const TaxDataSource = z
  .object({
    title: z.string().min(1),
    url: z.string().url(),
    retrieved: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    section: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();
export type TaxDataSource = z.infer<typeof TaxDataSource>;

export const CONTRIBUTION_LIMIT_FIELDS = ["employeeDeferral", "catchUp50", "catchUp60to63", "annualAdditions", "ira", "iraCatchUp50", "hsaSelf", "hsaFamily"] as const;

/** One published tax year (`tax/federal-YYYY.json`, tax-rmd-ss §2.2); also served by `GET /rules`. */
export const FederalYearRecord = z
  .object({
    schemaVersion: z.literal(1),
    taxYear: z.number().int().min(2026),
    ordinary: z
      .object({
        rates: z.array(z.number().min(0).max(1)).length(7),
        thresholds: z.object({ single: z.array(z.number().nonnegative()).length(7), mfj: z.array(z.number().nonnegative()).length(7) }).strict(),
      })
      .strict(),
    standardDeduction: PerStatus,
    additionalAged: PerStatus,
    seniorDeduction: z
      .object({ amountPerPerson: z.number().nonnegative(), minAge: z.number().int(), phaseoutRate: z.number().min(0).max(1), phaseoutStart: PerStatus })
      .strict(),
    capitalGains: z
      .object({ rates: z.array(z.number().min(0).max(1)).length(3), zeroRateMax: PerStatus, fifteenRateMax: PerStatus, netLossLimit: z.number().nonnegative() })
      .strict(),
    niit: z.object({ rate: z.number().min(0).max(1), threshold: PerStatus }).strict(),
    socialSecurityTaxation: z.object({ base1: PerStatus, base2: PerStatus, rate1: z.number(), rate2: z.number(), maxShare: z.number() }).strict(),
    additionalTaxes: z.object({ earlyDistributionRate: z.number(), hsaNonQualifiedRate: z.number() }).strict(),
    contributionLimits: z
      .object({
        employeeDeferral: z.number(),
        catchUp50: z.number(),
        catchUp60to63: z.number(),
        annualAdditions: z.number(),
        ira: z.number(),
        iraCatchUp50: z.number(),
        hsaSelf: z.number(),
        hsaFamily: z.number(),
        hsaCatchUp55: z.number(),
        /** Fields not yet published for the year, carried at the previous year's amounts. */
        pending: z.array(z.enum(CONTRIBUTION_LIMIT_FIELDS)),
      })
      .strict(),
    payroll: z
      .object({
        oasdiRate: z.number(),
        oasdiWageBase: z.number(),
        medicareRate: z.number(),
        additionalMedicareRate: z.number(),
        additionalMedicareThreshold: PerStatus,
      })
      .strict(),
    socialSecurity: z.object({ cola: z.number().min(0).max(0.2), earningsTestUnderFra: z.number(), earningsTestFraYear: z.number() }).strict(),
    sources: z.array(TaxDataSource).min(1),
  })
  .strict();
export type FederalYearRecord = z.infer<typeof FederalYearRecord>;

/** A scenario's override of one asset class's taxable-account yield assumptions (`taxable/tax-drag.json`). */
export const TaxDragOverride = z
  .object({
    dividendYieldBp: bp(0, 1500).optional(),
    qualifiedShareBp: bp().optional(),
    interestSpreadBp: bp(0, 1000).optional(),
    taxExemptShareBp: bp().optional(),
    gainDistributionRateBp: bp(0, 2000).optional(),
  })
  .strict();
export type TaxDragOverride = z.infer<typeof TaxDragOverride>;

/** Scenario-level tax assumptions (`RunSettings.tax`). */
export const TaxSettings = z
  .object({
    /** Basis points a year taken off the bracket index (tax decision 6). */
    chainedCpiWedgeBp: bp(0, 100).default(0),
    /** The wage base and earnings-test amounts grow this much faster than prices. */
    realWageGrowthBp: bp(0, 300).default(0),
    /** Subtract employee payroll tax from wages (plan decision 5, seams C27). */
    includePayrollTax: z.boolean().default(true),
    /** A capital loss carried into the plan's first year. */
    capLossCarryInCents: PlanCents.default("0"),
    taxDrag: z.record(AssetClass, TaxDragOverride).default({}),
  })
  .strict();
export type TaxSettings = z.infer<typeof TaxSettings>;
export type TaxSettingsInput = z.input<typeof TaxSettings>;

/** `TaxSettings.parse({})`. */
export function defaultTaxSettings(): TaxSettings {
  return TaxSettings.parse({});
}
export const DEFAULT_TAX_SETTINGS: TaxSettings = defaultTaxSettings();

/**
 * One year of one path, for the year-by-year table (stored inside `YearRow.tax`, seams C37).
 * `incomeTaxCents = ordinaryTaxCents + capitalGainsTaxCents`; `totalFederalCents = incomeTaxCents
 * + niitCents + earlyPenaltyCents + hsaPenaltyCents`; payroll tax is separate. Rates are basis points.
 */
export const TaxYearDetail = z
  .object({
    filingStatus: TaxFilingStatus,
    totalFederalCents: NonNegCentsString,
    incomeTaxCents: NonNegCentsString,
    ordinaryTaxCents: NonNegCentsString,
    capitalGainsTaxCents: NonNegCentsString,
    niitCents: NonNegCentsString,
    earlyPenaltyCents: NonNegCentsString,
    hsaPenaltyCents: NonNegCentsString,
    payrollTaxCents: NonNegCentsString,
    agiCents: CentsString,
    taxableIncomeCents: NonNegCentsString,
    ordinaryTaxableCents: NonNegCentsString,
    taxableSocialSecurityCents: NonNegCentsString,
    standardDeductionCents: NonNegCentsString,
    seniorDeductionCents: NonNegCentsString,
    gainsAt0Cents: NonNegCentsString,
    gainsAt15Cents: NonNegCentsString,
    gainsAt20Cents: NonNegCentsString,
    capitalLossCarryoverCents: NonNegCentsString,
    magiIrmaaCents: CentsString,
    magiAcaCents: CentsString,
    bracketRateBp: z.number().int(),
    nextGainRateBp: z.number().int(),
  })
  .strict();
export type TaxYearDetail = z.infer<typeof TaxYearDetail>;

const In = NonNegCentsInput.default("0");

/** Route 23 (`POST /tax-preview`): one household-year through the tax function, the gate's comparison tool. */
export const FederalTaxPreviewRequest = z
  .object({
    year: z.number().int().min(2026).max(2150),
    filingStatus: TaxFilingStatus,
    /** Attained by year end; one per filer. */
    ages: z.array(z.number().int().min(0).max(125)).min(1).max(2),
    /** The index factor × 10000, used only after the last published year. */
    indexFactorBp: z.number().int().min(2000).max(200000).default(10000),
    ruleSetId: RuleSetId.default(DEFAULT_RULE_SET_ID),
    wagesCents: In,
    pensionCents: In,
    taxableInterestCents: In,
    taxExemptInterestCents: In,
    ordinaryDividendsCents: In,
    qualifiedDividendsCents: In,
    shortTermGainCents: CentsInput.default("0"),
    longTermGainCents: CentsInput.default("0"),
    lossCarryInCents: In,
    traditionalDistributionsCents: In,
    rothConversionsCents: In,
    rothTaxableEarningsCents: In,
    hsaTaxableCents: In,
    socialSecurityCents: In,
    rentalNetCents: In,
    otherOrdinaryCents: In,
    adjustmentsCents: In,
    penalty10BaseCents: In,
    penalty20BaseCents: In,
  })
  .strict()
  .refine((r) => r.ages.length === (r.filingStatus === "single" ? 1 : 2), { message: "one age per filer", path: ["ages"] });
export type FederalTaxPreviewRequest = z.infer<typeof FederalTaxPreviewRequest>;
export type FederalTaxPreviewRequestInput = z.input<typeof FederalTaxPreviewRequest>;

export const FederalTaxPreviewResponse = z.object({
  dataVersion: z.string(),
  dataStatus: z.enum(["published", "indexed"]),
  detail: TaxYearDetail,
  provisionalIncomeCents: CentsString,
  unusedDeductionCents: NonNegCentsString,
  /** Null in the top bracket. */
  roomInBracketCents: NonNegCentsString.nullable(),
  roomAtZeroGainsCents: NonNegCentsString,
  lossUsedCents: NonNegCentsString,
  /** Effective, by finite difference (fractions). */
  marginalOrdinaryRate: z.number(),
  marginalGainRate: z.number(),
  lines: z.array(z.object({ form: z.string(), line: z.string(), label: z.string(), cents: CentsString })),
});
export type FederalTaxPreviewResponse = z.infer<typeof FederalTaxPreviewResponse>;

/** Route 24 (`POST /social-security-preview`): benefit by claiming age for the Social Security step of the form. */
export const SocialSecurityPreviewRequest = z
  .object({
    people: z
      .array(
        z
          .object({
            birthYear: PlanYear,
            birthMonth: z.number().int().min(1).max(12),
            monthlyAtFraCents: PlanCents,
            asOfYear: PlanYear,
            /** 62 years (744) to 70 years (840). */
            claimAgeMonths: z.number().int().min(744).max(840),
          })
          .strict(),
      )
      .min(1)
      .max(2),
    startYear: PlanYear,
  })
  .strict();
export type SocialSecurityPreviewRequest = z.infer<typeof SocialSecurityPreviewRequest>;

export const SocialSecurityPreviewResponse = z.object({
  people: z.array(
    z.object({
      fraMonths: z.number().int(),
      survivorFraMonths: z.number().int(),
      piaAtStartCents: NonNegCentsString,
      /** 62 to 70 in whole years. */
      byClaimAge: z.array(
        z.object({ claimAgeMonths: z.number().int(), factorBp: z.number().int(), monthlyCents: NonNegCentsString, spousalMonthlyCents: NonNegCentsString }),
      ),
      survivorMonthlyAtFraCents: NonNegCentsString,
    }),
  ),
});
export type SocialSecurityPreviewResponse = z.infer<typeof SocialSecurityPreviewResponse>;

/** Route 22 (`GET /rules`): the tax tables, rule sets, indexing rule, yield assumptions and what is not modelled, with sources. */
export const RetirementRulesView = z.object({
  dataVersion: z.string(),
  firstTaxYear: z.number().int(),
  lastPublishedYear: z.number().int(),
  /** year(today) > lastPublishedYear. */
  stale: z.boolean(),
  pendingLimits: z.array(z.object({ year: z.number().int(), fields: z.array(z.string()) })),
  years: z.array(FederalYearRecord),
  ruleSets: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      /** True when any of its law changes is. */
      illustrative: z.boolean(),
      lawChanges: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), illustrative: z.boolean() })),
    }),
  ),
  indexing: z.array(z.object({ path: z.string(), index: z.enum(["cpi", "wage"]), round: z.enum(["floor_increase", "nearest"]) })),
  taxDrag: z.record(
    AssetClass,
    z.object({
      dividendYieldBp: z.number().int(),
      qualifiedShareBp: z.number().int(),
      /** Null for a class that pays no interest. */
      interestSpreadBp: z.number().int().nullable(),
      taxExemptShareBp: z.number().int(),
      gainDistributionRateBp: z.number().int(),
    }),
  ),
  notModelled: z.array(z.object({ id: z.string(), label: z.string(), effect: z.string() })),
  sources: z.array(z.object({ file: z.string(), title: z.string(), url: z.string(), retrieved: z.string(), sha256: z.string().nullable() })),
  disclaimer: z.string(),
});
export type RetirementRulesView = z.infer<typeof RetirementRulesView>;
