import { z } from "zod";
import { AccountType, AllocationSource, BasisCoverage, DollarBasis, OwnerId, PersonId, PlanBucket, PlanIncomeKind } from "../enums.js";
import { IsoDateString, MonthString, NonNegCentsString } from "../wire.js";
import { bp, ClassWeights, ExpenseRatioPpm, PlanIssue, PlanYear } from "./primitives.js";
import { Cola, Longevity } from "./profile.js";
import { RunSettings } from "./settings.js";
import { TaxFilingStatus } from "./tax.js";

/**
 * The frozen run input (`sim_run.input`, inputs-and-data §4.5, with seams §2.1): the only input
 * the engine accepts (seams C1). Self-contained, month-resolved, annual cents unless a name says
 * monthly; no floats and no nulls. `input_hash` covers everything except `meta` and the display
 * names of people, accounts, incomes and goals. Written by `resolvePlan`, never by hand outside
 * tests; never a request body (it uses the loose wire shapes).
 */

export const SIM_INPUT_SCHEMA = "meridian.retirement.input";

/** The cash account the resolver adds when the plan has no taxable or cash account, so surplus cash stays in the plan (seams C24). */
export const SYNTHETIC_CASH_ACCOUNT_ID = "synthetic:cash";
/** The Roth account the resolver adds for a conversion by a person without one (inputs §3.4 R5). */
export function syntheticRothAccountId(personId: PersonId): string {
  return `synthetic:roth:${personId}`;
}

/** Where a seeded value came from (inputs §3.4 R13), keyed by path in `meta.provenance`. */
export const PlanProvenance = z.enum(["live", "profile", "scenario", "default"]);
export type PlanProvenance = z.infer<typeof PlanProvenance>;

/** Not hashed and not read by the engine. */
export const SimInputMeta = z
  .object({
    createdAt: z.string(),
    today: IsoDateString,
    asOf: IsoDateString,
    profileRevision: z.number().int(),
    baselineHash: z.string(),
    scenarioId: z.string().uuid(),
    scenarioRevision: z.number().int(),
    scenarioName: z.string(),
    provenance: z.record(PlanProvenance),
    warnings: z.array(PlanIssue),
  })
  .strict();
export type SimInputMeta = z.infer<typeof SimInputMeta>;

export const SimInputPlan = z
  .object({
    startYear: PlanYear,
    startMonth: MonthString,
    /** Months of year 0, from `startMonth` through December; f = firstYearMonths / 12 (plan decision 2). */
    firstYearMonths: z.number().int().min(1).max(12),
    endYear: PlanYear,
    stepsPerYear: z.literal(1),
    currency: z.literal("USD"),
  })
  .strict();
export type SimInputPlan = z.infer<typeof SimInputPlan>;

export const SimInputPerson = z
  .object({
    id: PersonId,
    name: z.string(),
    birthYear: PlanYear,
    birthMonth: z.number().int().min(1).max(12),
    retirementMonth: MonthString,
    longevity: Longevity,
  })
  .strict();
export type SimInputPerson = z.infer<typeof SimInputPerson>;

export const SimInputAccount = z
  .object({
    /** An account uuid, or `synthetic:cash` / `synthetic:roth:<person>`. */
    id: z.string(),
    name: z.string(),
    type: AccountType.optional(),
    bucket: PlanBucket,
    owner: OwnerId,
    balanceCents: NonNegCentsString,
    /** Bucket taxable only. */
    basisCents: NonNegCentsString.optional(),
    basisCoverage: BasisCoverage.optional(),
    /** Bucket roth; absent = unknown. */
    rothContributionBasisCents: NonNegCentsString.optional(),
    allocation: ClassWeights,
    allocationSource: AllocationSource,
    glidePath: z.array(z.object({ year: PlanYear, weights: ClassWeights }).strict()).optional(),
    /** The yearly fund cost (seams C25, plan decision 3): measured, typed, or 0 when unknown. */
    expenseRatioPpm: ExpenseRatioPpm,
    synthetic: z.boolean(),
  })
  .strict();
export type SimInputAccount = z.infer<typeof SimInputAccount>;

export const SimInputIncome = z
  .object({
    id: z.string(),
    kind: PlanIncomeKind,
    personId: PersonId.optional(),
    name: z.string(),
    annualCents: NonNegCentsString,
    dollars: DollarBasis,
    /** The window is [startMonth, endMonth); no end = for life, or to the end of the plan for a household stream. */
    startMonth: MonthString,
    endMonth: MonthString.optional(),
    realGrowthBp: z.number().int(),
    cola: Cola,
    survivorBp: bp(),
    taxableBp: bp(),
    earned: z.boolean(),
  })
  .strict();
export type SimInputIncome = z.infer<typeof SimInputIncome>;

export const SimInputSocialSecurityPerson = z.discriminatedUnion("mode", [
  z.object({ personId: PersonId, mode: z.literal("none") }).strict(),
  z
    .object({
      personId: PersonId,
      mode: z.literal("estimate"),
      monthlyAtFraCents: NonNegCentsString,
      asOfYear: PlanYear,
      claimMonth: MonthString,
      claimAgeMonths: z.number().int(),
    })
    .strict(),
  z
    .object({
      personId: PersonId,
      mode: z.literal("receiving"),
      monthlyCents: NonNegCentsString,
      asOfYear: PlanYear,
      startedMonth: MonthString,
      monthlyAtFraCents: NonNegCentsString.optional(),
    })
    .strict(),
]);
export type SimInputSocialSecurityPerson = z.infer<typeof SimInputSocialSecurityPerson>;

export const SimInputGoal = z
  .object({ id: z.string(), name: z.string(), year: PlanYear, amountCents: NonNegCentsString, dollars: DollarBasis })
  .strict();
export type SimInputGoal = z.infer<typeof SimInputGoal>;

/**
 * Healthcare per person a year. The entered amounts are kept when they are included in base
 * spending (`inBase`): spending adds them only when `inBase` is false, and the HSA's qualified cap
 * is the entered amount either way (seams C35, plan decision 9).
 */
export const SimInputHealthcare = z
  .object({
    personId: PersonId,
    preMedicareAnnualCents: NonNegCentsString,
    preMedicareFrom: MonthString,
    medicareFrom: MonthString,
    medicareAnnualCents: NonNegCentsString,
    realGrowthBp: z.number().int(),
    inBase: z.boolean(),
  })
  .strict();
export type SimInputHealthcare = z.infer<typeof SimInputHealthcare>;

export const SimInputSpending = z
  .object({
    baseAnnualCents: NonNegCentsString,
    essentialAnnualCents: NonNegCentsString,
    /** The earliest retirement month, not before the plan start. */
    startMonth: MonthString,
    survivorBp: bp(),
    phases: z.array(z.object({ fromYear: PlanYear, multiplierBp: bp(0, 20000) }).strict()),
    goals: z.array(SimInputGoal),
    healthcare: z.array(SimInputHealthcare),
    longTermCare: z.array(z.object({ personId: PersonId, reserveCents: NonNegCentsString, lastYears: z.number().int() }).strict()),
  })
  .strict();
export type SimInputSpending = z.infer<typeof SimInputSpending>;

export const SimInputContribution = z
  .object({
    accountId: z.string(),
    employeeAnnualCents: NonNegCentsString,
    employerAnnualCents: NonNegCentsString,
    /** Year-0 amounts scale with the salary paid to this person or the household, or with the price level. */
    scaleWith: z.enum(["p1", "p2", "household", "inflation"]),
    salaryBasisCents: NonNegCentsString.optional(),
    endMonth: MonthString,
  })
  .strict();
export type SimInputContribution = z.infer<typeof SimInputContribution>;

export const SimInputConversion = z.object({ year: PlanYear, personId: PersonId, amountCents: NonNegCentsString, dollars: DollarBasis }).strict();
export type SimInputConversion = z.infer<typeof SimInputConversion>;

export const SimInput = z
  .object({
    schema: z.literal(SIM_INPUT_SCHEMA),
    schemaVersion: z.literal(1),
    meta: SimInputMeta,
    /** The data manifest version the run must load. */
    data: z.object({ version: z.string() }).strict(),
    plan: SimInputPlan,
    household: z
      .object({
        filingStatus: TaxFilingStatus,
        state: z.string(),
        people: z.array(SimInputPerson).min(1).max(2),
      })
      .strict(),
    accounts: z.array(SimInputAccount).min(1),
    incomes: z.array(SimInputIncome),
    socialSecurity: z
      .object({
        people: z.array(SimInputSocialSecurityPerson),
        spousal: z.boolean(),
        survivor: z.boolean(),
        adjustment: z.object({ fromYear: PlanYear, factorBp: bp() }).strict().optional(),
      })
      .strict(),
    spending: SimInputSpending,
    contributions: z.array(SimInputContribution),
    rothConversions: z.array(SimInputConversion),
    settings: RunSettings,
  })
  .strict();
export type SimInput = z.infer<typeof SimInput>;
