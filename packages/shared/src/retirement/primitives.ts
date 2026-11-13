import { z } from "zod";
import { PlanIssueSeverity } from "../enums.js";
import { MAX_INPUT_YEAR, MIN_INPUT_YEAR, MonthInput, NonNegCentsInput } from "../wire.js";

/**
 * The retirement planner's primitive shapes (docs/design/phase-4/inputs-and-data.md §4.1).
 *
 * Stored documents (the profile, the baseline, the frozen input, the run settings and the
 * results) hold no floats and no nulls: only strings, safe integers, booleans, arrays and
 * objects; an absent value is an absent key (inputs decision 2, plan decision 15). Money is
 * integer cents as a decimal string; a ratio is integer basis points (100 bp = 1%) or parts per
 * million; a month is `YYYY-MM`.
 */

/** Integer cents as a decimal string, 0 .. 999,999,999,999,999 (a request shape: the profile document is a request body). */
export const PlanCents = NonNegCentsInput;
/** `YYYY-MM`, 1900-01 .. 2199-12. */
export const PlanMonth = MonthInput;
/** A calendar year a caller may name. */
export const PlanYear = z.number().int().min(MIN_INPUT_YEAR).max(MAX_INPUT_YEAR);
/** Basis points, an integer in [min, max]; 100 bp = 1%. */
export const bp = (min = 0, max = 10000) => z.number().int().min(min).max(max);
/** A stable id for an item of a map in the profile document (an income stream, a goal, a conversion). */
export const PlanItemId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, "a lower-case id of at most 32 letters, digits and underscores");

/** The six asset classes in basis points; they sum to 10000. */
export const ClassWeights = z
  .object({ us_stock: bp(), intl_stock: bp(), bonds: bp(), cash: bp(), real_estate: bp(), other: bp() })
  .strict()
  .refine((w) => w.us_stock + w.intl_stock + w.bonds + w.cash + w.real_estate + w.other === 10000, "weights must sum to 10000 bp");
export type ClassWeights = z.infer<typeof ClassWeights>;

/** A fund's yearly cost in parts per million (300 ppm = 0.03%); the engine accepts up to 10%. */
export const MAX_EXPENSE_RATIO_PPM = 100_000;
export const ExpenseRatioPpm = z.number().int().min(0).max(MAX_EXPENSE_RATIO_PPM);

export const MEDICARE_AGE = 65;
export const MIN_PATHS = 100;
export const MAX_PATHS = 100_000;
export const DEFAULT_PATHS = 10_000;
/** The percentiles whose year tables every run stores (inputs decision 21). */
export const STORED_PERCENTILES = [5, 10, 25, 50, 75, 90, 95] as const;
/** A baseline older than this many days is flagged; one older than the maximum blocks a run. */
export const BASELINE_STALE_DAYS = 7;
export const BASELINE_MAX_DAYS = 35;
export const PLANNER_DISCLAIMER = "The planner is an estimate, not tax or investment advice.";

/**
 * The engine's size limits, which the resolver also enforces so an unrunnable plan is refused on
 * the form (seams C13; engine design §2.1 `LIMITS`). `maxAccounts` counts synthetic accounts.
 */
export const PLAN_LIMITS = {
  maxAccounts: 32,
  maxIncomes: 40,
  maxConversions: 120,
  maxYears: 120,
  maxPathYears: 6_000_000,
} as const;

/** One issue of a resolved plan; `path` is a dot path into the profile document. */
export const PlanIssue = z
  .object({
    code: z.string(),
    severity: PlanIssueSeverity,
    path: z.string(),
    message: z.string(),
    accountId: z.string().optional(),
  })
  .strict();
export type PlanIssue = z.infer<typeof PlanIssue>;

/** A stored document whose `schemaVersion` this build cannot read (thrown by the `upgrade…` functions). */
export class UnsupportedSchemaVersionError extends Error {
  readonly code = "unsupported_schema_version";
  constructor(
    readonly document: string,
    readonly version: unknown,
  ) {
    super(`${document}: schemaVersion ${JSON.stringify(version) ?? String(version)} is not supported`);
    this.name = "UnsupportedSchemaVersionError";
  }
}

/** The `schemaVersion` of a raw stored document, or undefined when it has none. */
export function schemaVersionOf(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return (raw as { schemaVersion?: unknown }).schemaVersion;
}
