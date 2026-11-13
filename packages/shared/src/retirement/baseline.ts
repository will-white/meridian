import { z } from "zod";
import { AccountType, AssetClass, InvestmentFidelity, PlanBucket, TaxTreatment } from "../enums.js";
import { CentsString, IsoDateString, MonthString } from "../wire.js";
import { bp, ClassWeights } from "./primitives.js";

/**
 * The baseline (`plan_profile.baseline`, inputs-and-data §4.3): what live data says about the
 * household on its as-of date. A response and a stored document, never a request, so it uses the
 * loose wire shapes; it holds no floats and no nulls.
 */

/**
 * The value-weighted expense ratio of an account's positions that have one (seams C25), and the
 * share of the account's value those positions cover. The ppm range is the security table's
 * (0 to 100%); the resolver caps what it freezes at `MAX_EXPENSE_RATIO_PPM`.
 */
export const BaselineExpenseRatio = z.object({ ppm: z.number().int().min(0).max(1_000_000), coveredBp: bp() }).strict();
export type BaselineExpenseRatio = z.infer<typeof BaselineExpenseRatio>;

export const BaselineAccount = z
  .object({
    accountId: z.string().uuid(),
    name: z.string(),
    type: AccountType,
    taxTreatment: TaxTreatment,
    bucket: PlanBucket.optional(),
    ineligible: z.enum(["education"]).optional(),
    treatmentDefaulted: z.boolean(),
    valueCents: CentsString.optional(),
    valuationDate: IsoDateString.optional(),
    valuationBasis: z.enum(["snapshot", "lots", "positions", "balance", "none", "bank_balance"]),
    stale: z.boolean(),
    fidelity: InvestmentFidelity.optional(),
    /** Bucket taxable only. */
    basis: z
      .object({
        knownCents: CentsString,
        unknownValueCents: CentsString,
        coverage: z.enum(["full", "partial", "none"]),
        source: z.enum(["lots", "statement", "mixed"]).optional(),
      })
      .strict()
      .optional(),
    /** Classified accounts with a positive value. */
    classCents: z.record(AssetClass, CentsString).optional(),
    weights: ClassWeights.optional(),
    /** Absent when no position has an expense ratio. */
    expenseRatio: BaselineExpenseRatio.optional(),
  })
  .strict();
export type BaselineAccount = z.infer<typeof BaselineAccount>;

export const BaselineContribution = z
  .object({
    accountId: z.string().uuid(),
    monthsWithData: z.number().int().min(0).max(12),
    grossInCents: CentsString,
    outCents: CentsString,
    netCents: CentsString,
    unpairedCents: CentsString,
    employerCents: CentsString,
    employeeCents: CentsString,
    employerDetected: z.boolean(),
    annualNetCents: CentsString.optional(),
    annualEmployeeCents: CentsString.optional(),
    annualEmployerCents: CentsString.optional(),
    annualUnpairedCents: CentsString.optional(),
    plannedCents: CentsString,
    source: z.enum(["measured", "recurring", "none"]),
    flags: z.array(z.enum(["partial_window", "insufficient_history", "irregular", "has_withdrawals"])),
  })
  .strict();
export type BaselineContribution = z.infer<typeof BaselineContribution>;

export const BaselineSpendingCategory = z
  .object({ categoryId: z.string().uuid(), name: z.string(), bucket: z.enum(["bills", "spending"]), cents: CentsString, activeMonths: z.number().int() })
  .strict();
export type BaselineSpendingCategory = z.infer<typeof BaselineSpendingCategory>;

export const RetirementBaseline = z
  .object({
    schemaVersion: z.literal(1),
    asOf: IsoDateString,
    today: IsoDateString,
    computedAt: z.string(),
    window: z.object({ from: MonthString, to: MonthString, monthsWithData: z.number().int().min(0).max(12) }).strict(),
    accounts: z.array(BaselineAccount),
    totals: z.object({ byBucket: z.record(PlanBucket, CentsString), totalCents: CentsString }).strict(),
    allocationTargets: ClassWeights.optional(),
    spending: z
      .object({
        byCategory: z.array(BaselineSpendingCategory),
        categorizedCents: CentsString,
        billsCents: CentsString,
        uncategorized: z.object({ count: z.number().int(), outflowCents: CentsString, inflowCents: CentsString }).strict(),
      })
      .strict(),
    income: z.object({ takeHomeCents: CentsString, investmentIncomeCents: CentsString }).strict(),
    contributions: z.array(BaselineContribution),
    savingsRate: z
      .object({ bp: z.number().int().optional(), contributionsCents: CentsString, payrollCents: CentsString, baseCents: CentsString })
      .strict(),
  })
  .strict();
export type RetirementBaseline = z.infer<typeof RetirementBaseline>;
