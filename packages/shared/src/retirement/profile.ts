import { z } from "zod";
import { DollarBasis, OwnerId, PersonId } from "../enums.js";
import type { RetirementBaseline } from "./baseline.js";
import { bp, ClassWeights, ExpenseRatioPpm, PlanCents, PlanItemId, PlanMonth, PlanYear, schemaVersionOf, UnsupportedSchemaVersionError } from "./primitives.js";

/**
 * The household profile document (`plan_profile.doc`, inputs-and-data §4.2), one versioned
 * document per household. It is a request body (PUT /profile and the scenario editor send it
 * whole), so money and months use the bounded shapes. Amounts are today's dollars at the plan
 * start unless `dollars` is `nominal`; `…Cents` is integer cents, `monthly…` per month,
 * `annual…` per year; `…Bp` is basis points; ages are whole years.
 *
 * Saving is lenient and running is strict (inputs decision 32): the schema checks shape and
 * ranges only; ordering rules (glide points, phases), ownership and windows are issues of the
 * resolver.
 */

export const Longevity = z.discriminatedUnion("mode", [
  /** Alive through the calendar year in which this age is attained. */
  z.object({ mode: z.literal("fixed"), age: z.number().int().min(50).max(119) }).strict(),
  z
    .object({
      mode: z.literal("mortality"),
      sex: z.enum(["female", "male"]),
      /** Shifts the table: +2 = two years healthier (the table is read at age − adjustYears). */
      adjustYears: z.number().int().min(-10).max(10).default(0),
      /** Death is certain in the year this age is attained; the plan's horizon ends there. */
      maxAge: z.number().int().min(90).max(119).default(110),
    })
    .strict(),
]);
export type Longevity = z.infer<typeof Longevity>;

export const Person = z
  .object({
    name: z.string().trim().min(1).max(40),
    birthYear: PlanYear,
    birthMonth: z.number().int().min(1).max(12),
    retirementAge: z.number().int().min(18).max(90),
    /** An exact month; wins over the age. */
    retirementMonth: PlanMonth.optional(),
    longevity: Longevity,
  })
  .strict();
export type Person = z.infer<typeof Person>;

/** A household glide path: six-class weights by the reference person's age, interpolated by `glideWeightsAt`. */
export const GlidePath = z
  .object({
    reference: PersonId,
    points: z.array(z.object({ age: z.number().int().min(18).max(119), weights: ClassWeights }).strict()).min(1).max(12),
  })
  .strict();
export type GlidePath = z.infer<typeof GlidePath>;

/** When a stream starts or ends; resolved to a month in the frozen input. */
export const When = z.discriminatedUnion("at", [
  z.object({ at: z.literal("start") }).strict(),
  z.object({ at: z.literal("year"), year: PlanYear }).strict(),
  z.object({ at: z.literal("age"), personId: PersonId, age: z.number().int().min(18).max(110) }).strict(),
  z.object({ at: z.literal("retirement"), personId: PersonId }).strict(),
]);
export type When = z.infer<typeof When>;

/** A pension's or annuity's cost-of-living clause; `fixed` is nominal basis points a year. */
export const Cola = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("cpi") }).strict(),
  z.object({ mode: z.literal("fixed"), bp: bp(0, 1000) }).strict(),
]);
export type Cola = z.infer<typeof Cola>;

const name60 = z.string().trim().min(1).max(60);

export const IncomeStream = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("salary"), personId: PersonId, annualGrossCents: PlanCents, realRaiseBp: bp(-500, 1000).default(0) }).strict(),
  z
    .object({ kind: z.literal("part_time"), personId: PersonId, annualCents: PlanCents, start: When, end: When, realGrowthBp: bp(-500, 500).default(0) })
    .strict(),
  z
    .object({
      kind: z.literal("pension"),
      personId: PersonId,
      name: name60,
      monthlyCents: PlanCents,
      dollars: DollarBasis.default("nominal"),
      start: When,
      cola: Cola,
      survivorBp: bp().default(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal("annuity"),
      personId: PersonId,
      name: name60,
      monthlyCents: PlanCents,
      dollars: DollarBasis.default("nominal"),
      start: When,
      end: When.optional(),
      cola: Cola,
      survivorBp: bp().default(0),
      taxableBp: bp().default(10000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rental"),
      name: name60,
      annualNetCents: PlanCents,
      start: When,
      end: When.optional(),
      realGrowthBp: bp(-500, 500).default(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal("other"),
      name: name60,
      personId: PersonId.optional(),
      annualCents: PlanCents,
      dollars: DollarBasis.default("today"),
      start: When,
      end: When.optional(),
      realGrowthBp: bp(-500, 500).default(0),
      taxableBp: bp().default(10000),
    })
    .strict(),
]);
export type IncomeStream = z.infer<typeof IncomeStream>;

export const ClaimAge = z
  .object({ years: z.number().int().min(62).max(70), months: z.number().int().min(0).max(11) })
  .strict()
  .refine((c) => c.years < 70 || c.months === 0, "claim by 70");
export type ClaimAge = z.infer<typeof ClaimAge>;

export const SocialSecurityInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("estimate"), monthlyAtFraCents: PlanCents, asOfYear: PlanYear, claimAge: ClaimAge }).strict(),
  z
    .object({
      mode: z.literal("receiving"),
      monthlyCents: PlanCents,
      asOfYear: PlanYear,
      startedMonth: PlanMonth,
      /** The full-retirement-age amount, when known. */
      monthlyAtFraCents: PlanCents.optional(),
    })
    .strict(),
]);
export type SocialSecurityInput = z.infer<typeof SocialSecurityInput>;

/**
 * The planner's setting for one account (keyed by account id). An empty object marks the account
 * reviewed with every default. `expenseRatioPpm` overrides the measured fund cost (seams C25).
 */
export const AccountSetting = z
  .object({
    include: z.boolean().optional(),
    owner: OwnerId.optional(),
    allocation: ClassWeights.optional(),
    glidePath: GlidePath.optional(),
    basisCents: PlanCents.optional(),
    rothContributionBasisCents: PlanCents.optional(),
    expenseRatioPpm: ExpenseRatioPpm.optional(),
  })
  .strict();
export type AccountSetting = z.infer<typeof AccountSetting>;

export const EmployeeContribution = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("live") }).strict(),
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("annual"), annualCents: PlanCents }).strict(),
  z.object({ mode: z.literal("pct_salary"), bp: bp() }).strict(),
]);
export const EmployerContribution = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("live") }).strict(),
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("annual"), annualCents: PlanCents }).strict(),
  /** matchBp of deferrals up to capBpOfSalary of pay. */
  z.object({ mode: z.literal("formula"), matchBp: bp(0, 20000), capBpOfSalary: bp() }).strict(),
]);
export const ContributionSetting = z.object({ employee: EmployeeContribution, employer: EmployerContribution }).strict();
export type ContributionSetting = z.infer<typeof ContributionSetting>;

export const LiveOrManual = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("live") }).strict(),
  z.object({ mode: z.literal("manual"), annualCents: PlanCents }).strict(),
]);
export type LiveOrManual = z.infer<typeof LiveOrManual>;

export const SpendingPhase = z
  .object({ label: z.string().trim().max(40), fromAge: z.number().int().min(40).max(110), multiplierBp: bp(0, 20000) })
  .strict();
export type SpendingPhase = z.infer<typeof SpendingPhase>;

export const SpendingGoal = z
  .object({
    name: name60,
    year: PlanYear,
    amountCents: PlanCents,
    dollars: DollarBasis.default("today"),
    repeat: z.object({ everyYears: z.number().int().min(1).max(50), times: z.number().int().min(1).max(20) }).strict().optional(),
  })
  .strict();
export type SpendingGoal = z.infer<typeof SpendingGoal>;

export const Spending = z
  .object({
    base: LiveOrManual,
    /** The floor for the floor-and-ceiling strategy. */
    essential: LiveOrManual,
    /** A set, as a map, so a scenario can add or drop one id. */
    excludedCategoryIds: z.record(z.string().uuid(), z.literal(true)).default({}),
    includeUncategorized: z.boolean().default(true),
    /** Base spending after the first death, as a share of the couple's. */
    survivorBp: bp().default(10000),
    phaseAnchor: PersonId.default("p1"),
    phases: z.array(SpendingPhase).max(4).default([]),
    goals: z.record(PlanItemId, SpendingGoal).default({}),
    /** Per person a year. The amounts are kept when included in base: they cap the HSA's qualified withdrawals (seams C35). */
    healthcare: z
      .object({
        includedInBase: z.boolean().default(false),
        preMedicareAnnualCents: PlanCents.default("0"),
        medicareAnnualCents: PlanCents.default("0"),
        realGrowthBp: bp(0, 1000).default(0),
      })
      .strict(),
    /** A reserve per named person, spent evenly over the last `lastYears` years of that person's life. */
    longTermCare: z
      .object({
        reserveCents: PlanCents.default("0"),
        lastYears: z.number().int().min(1).max(10).default(2),
        people: z.enum(["each", "p1", "p2"]).default("each"),
      })
      .strict(),
  })
  .strict();
export type Spending = z.infer<typeof Spending>;

export const RothConversion = z
  .object({ personId: PersonId, fromYear: PlanYear, toYear: PlanYear, annualCents: PlanCents, dollars: DollarBasis.default("today") })
  .strict()
  .refine((c) => c.toYear >= c.fromYear, "toYear before fromYear");
export type RothConversion = z.infer<typeof RothConversion>;

export const RetirementProfileDoc = z
  .object({
    schemaVersion: z.literal(1),
    people: z.object({ p1: Person, p2: Person.optional() }).strict(),
    /** Stored, not taxed in v1; decides the joint-account basis share at a death (seams C19). */
    state: z.string().regex(/^[A-Z]{2}$/, "a two-letter state code"),
    accounts: z.record(z.string().uuid(), AccountSetting).default({}),
    allocation: z.object({ unclassified: ClassWeights.optional(), glidePath: GlidePath.optional() }).strict(),
    incomes: z.record(PlanItemId, IncomeStream).default({}),
    socialSecurity: z
      .object({
        p1: SocialSecurityInput,
        p2: SocialSecurityInput.optional(),
        spousal: z.boolean().default(true),
        survivor: z.boolean().default(true),
        /** Benefits × factorBp ÷ 10000 from that year on. */
        adjustment: z.object({ fromYear: PlanYear, factorBp: bp() }).strict().optional(),
      })
      .strict(),
    spending: Spending,
    contributions: z.record(z.string().uuid(), ContributionSetting).default({}),
    rothConversions: z.record(PlanItemId, RothConversion).default({}),
  })
  .strict();
export type RetirementProfileDoc = z.infer<typeof RetirementProfileDoc>;
export type RetirementProfileDocInput = z.input<typeof RetirementProfileDoc>;

/** Reads a stored profile document of any known version as the current one. Version 1 is the identity. */
export function upgradeProfileDoc(raw: unknown): RetirementProfileDoc {
  const version = schemaVersionOf(raw);
  switch (version) {
    case 1:
      return RetirementProfileDoc.parse(raw);
    default:
      throw new UnsupportedSchemaVersionError("RetirementProfileDoc", version);
  }
}

/** The labels and anchor ages of the three default spending phases (inputs §4.2). */
export const DEFAULT_SPENDING_PHASES = [
  { label: "Early active years", fromAge: "retirement" },
  { label: "Slower years", fromAge: 75 },
  { label: "Late life", fromAge: 85 },
] as const;

const MIN_PHASE_AGE = 40;

/**
 * The profile a new household starts from (inputs §4.2): state CO; an empty setting for every
 * bucketed baseline account (which marks it reviewed); no allocation overrides, incomes,
 * contributions or conversions; Social Security `none` for each person with spousal and survivor
 * benefits on; spending live with the three default phases at 10000 bp anchored on p1 (a phase
 * whose age is not above the previous one is left out; a retirement age below 40, the phases'
 * lowest age, starts the first phase at 40); healthcare zeros; no long-term care reserve. No
 * reduction is assumed that the owner did not type.
 */
export function defaultProfileDoc(people: { p1: Person; p2?: Person | undefined }, baseline: Pick<RetirementBaseline, "accounts">): RetirementProfileDoc {
  const phases: Array<{ label: string; fromAge: number; multiplierBp: number }> = [];
  for (const phase of DEFAULT_SPENDING_PHASES) {
    const age = phase.fromAge === "retirement" ? Math.max(MIN_PHASE_AGE, people.p1.retirementAge) : phase.fromAge;
    const previous = phases[phases.length - 1];
    if (previous !== undefined && age <= previous.fromAge) continue;
    phases.push({ label: phase.label, fromAge: age, multiplierBp: 10000 });
  }
  const accounts: Record<string, AccountSetting> = {};
  for (const account of baseline.accounts) if (account.bucket !== undefined) accounts[account.accountId] = {};
  return RetirementProfileDoc.parse({
    schemaVersion: 1,
    people: people.p2 === undefined ? { p1: people.p1 } : { p1: people.p1, p2: people.p2 },
    state: "CO",
    accounts,
    allocation: {},
    incomes: {},
    socialSecurity: people.p2 === undefined ? { p1: { mode: "none" } } : { p1: { mode: "none" }, p2: { mode: "none" } },
    spending: {
      base: { mode: "live" },
      essential: { mode: "live" },
      phases,
      healthcare: {},
      longTermCare: {},
    },
    contributions: {},
    rothConversions: {},
  } satisfies RetirementProfileDocInput);
}
