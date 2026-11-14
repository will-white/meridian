import { z } from "zod";
import { OkResponse, QueryBoolean, TodayQuery, UuidParams } from "../api.js";
import { AllocationSource, BasisCoverage, OwnerId, PlanBucket, SimRunStatus } from "../enums.js";
import { CentsString, IsoDateInput, IsoDateString } from "../wire.js";
import { RetirementBaseline } from "./baseline.js";
import { SimInput } from "./input.js";
import { ClassWeights, PlanIssue } from "./primitives.js";
import { RetirementProfileDoc } from "./profile.js";
import { FanSeries, SimSummary, YearTable } from "./results.js";
import { ParametricParams } from "./returnModel.js";
import { RunSettings } from "./settings.js";
import {
  FederalTaxPreviewRequest,
  FederalTaxPreviewResponse,
  RetirementRulesView,
  SocialSecurityPreviewRequest,
  SocialSecurityPreviewResponse,
} from "./tax.js";

/**
 * The planner's routes (`apps/api/src/routes/retirement.ts`, prefix `/api/retirement`): routes 1
 * to 21 of inputs-and-data §4.7 and §4.8 and routes 22 to 24 of tax-rmd-ss §4.4 (seams C42).
 * Request contracts use the bounded wire shapes only (the API refuses to register a route that
 * does not); responses carry database values and use the loose shapes. Every read is a GET or a
 * read-only POST; every other mutation is owner-only. Errors are `{ error, code }` through
 * `PlanError` (400, 404 or 409; 403 `viewer` from the auth plugin).
 *
 * This file may import ../api.ts; ../api.ts imports only ./card.ts from this directory.
 */

export const RETIREMENT_API_PREFIX = "/api/retirement";

const Uuid = z.string().uuid();
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "64 lower-case hex digits");
const Revision = z.number().int().min(1);
const ScenarioName = z.string().trim().min(1).max(80);
const Notes = z.string().max(2000);

// ---- Request contracts ----

/** Route 3: `expectedRevision: 0` creates the profile, the stored baseline and the default scenario "Base plan". */
export const PutProfileBody = z.object({ doc: RetirementProfileDoc, expectedRevision: z.number().int().min(0), today: IsoDateInput.optional() }).strict();
export type PutProfileBody = z.infer<typeof PutProfileBody>;

/** Route 4: re-applies an audit row's `before`. */
export const RevertProfileBody = z.object({ auditId: Uuid, expectedRevision: Revision, today: IsoDateInput.optional() }).strict();
export type RevertProfileBody = z.infer<typeof RevertProfileBody>;

/** Route 6: `409 baseline_changed` when the fresh baseline's hash differs from `expectedHash`. */
export const RefreshBaselineBody = z.object({ today: IsoDateInput.optional(), expectedHash: Sha256Hex.optional() }).strict();
export type RefreshBaselineBody = z.infer<typeof RefreshBaselineBody>;

/** Route 7. */
export const ScenarioListQuery = z.object({ includeArchived: QueryBoolean.optional() });
export type ScenarioListQuery = z.infer<typeof ScenarioListQuery>;

const docNeedsProfileRevision = {
  check: (b: { doc?: unknown; profileRevision?: number | undefined }) => b.doc === undefined || b.profileRevision !== undefined,
  issue: { message: "profileRevision is required with doc", path: ["profileRevision"] },
};

/**
 * Route 8. `doc` is the full effective document as edited (the server stores the minimal patch
 * over the profile); `profileRevision` is the profile revision the editor loaded.
 */
export const CreateScenarioBody = z
  .object({
    name: ScenarioName,
    notes: Notes.optional(),
    copyFromId: Uuid.optional(),
    doc: RetirementProfileDoc.optional(),
    profileRevision: Revision.optional(),
    settings: RunSettings.optional(),
  })
  .strict()
  .refine(docNeedsProfileRevision.check, docNeedsProfileRevision.issue);
export type CreateScenarioBody = z.infer<typeof CreateScenarioBody>;

/** Route 10. */
export const UpdateScenarioBody = z
  .object({
    expectedRevision: Revision,
    name: ScenarioName.optional(),
    notes: Notes.nullable().optional(),
    doc: RetirementProfileDoc.optional(),
    profileRevision: Revision.optional(),
    settings: RunSettings.optional(),
    isDefault: z.boolean().optional(),
    archived: z.boolean().optional(),
    position: z.number().int().min(0).max(10000).optional(),
  })
  .strict()
  .refine(docNeedsProfileRevision.check, docNeedsProfileRevision.issue);
export type UpdateScenarioBody = z.infer<typeof UpdateScenarioBody>;

/** Route 12. */
export const RevertScenarioBody = z.object({ auditId: Uuid, expectedRevision: Revision }).strict();
export type RevertScenarioBody = z.infer<typeof RevertScenarioBody>;

/** Route 14: `refresh` recomputes the baseline first (inputs decision 4); `force` starts a run even when an identical one exists. */
export const RunRequestBody = z.object({ today: IsoDateInput.optional(), refresh: z.boolean().default(true), force: z.boolean().default(false) }).strict();
export type RunRequestBody = z.infer<typeof RunRequestBody>;

/** Route 15: newest first. */
export const RunListQuery = z.object({
  scenarioId: Uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Opaque cursor from the previous page. */
  cursor: z.string().max(200).optional(),
});
export type RunListQuery = z.infer<typeof RunListQuery>;

/** Route 18: any integer percentile 1 to 99 (stored ones are served, others re-simulated). */
export const RunPathParams = z.object({ id: Uuid, percentile: z.coerce.number().int().min(1).max(99) });
export type RunPathParams = z.infer<typeof RunPathParams>;

/** Route 20. */
export const UpdateRunBody = z.object({ pinned: z.boolean().optional(), note: z.string().max(500).nullable().optional() }).strict();
export type UpdateRunBody = z.infer<typeof UpdateRunBody>;

// ---- Responses ----

/** One row of the baseline diff (inputs §3.6). */
export const BaselineChange = z.object({
  kind: z.string(),
  path: z.string(),
  label: z.string(),
  accountId: z.string().uuid().optional(),
  beforeCents: CentsString.optional(),
  afterCents: CentsString.optional(),
  deltaCents: CentsString.optional(),
  note: z.string().optional(),
  material: z.boolean(),
});
export type BaselineChange = z.infer<typeof BaselineChange>;

/** The resolver's effective starting values (inputs §4.6 `EffectiveInputs`, cents as strings). */
export const EffectiveInputsView = z.object({
  includedTotalCents: CentsString,
  byBucketCents: z.record(PlanBucket, CentsString),
  baseSpendingCents: CentsString,
  essentialSpendingCents: CentsString,
  /** Employee plus employer. */
  contributionsCents: CentsString,
  employerCents: CentsString,
  planSavingsRateBp: z.number().int().optional(),
  accounts: z.array(
    z.object({
      accountId: z.string(),
      included: z.boolean(),
      bucket: PlanBucket,
      owner: OwnerId.optional(),
      balanceCents: CentsString,
      basisCents: CentsString.optional(),
      basisCoverage: BasisCoverage.optional(),
      allocation: ClassWeights.optional(),
      allocationSource: AllocationSource.optional(),
      /** The fund cost the run would use (seams C25). */
      expenseRatioPpm: z.number().int().optional(),
    }),
  ),
});
export type EffectiveInputsView = z.infer<typeof EffectiveInputsView>;

/**
 * A parametric preset the run-settings form offers (`custom` is the form itself, seams G2):
 * its label and the preset in the custom form's terms, each figure to the nearest basis point
 * (C44, an engine output). `historical` is the lognormal the engine fits to the data's log
 * returns, as arithmetic means and simple-return volatilities; `conservative` is the engine's
 * geometric means with the data's simple-return volatilities. The engine runs the preset itself;
 * these are for display and as a starting point.
 */
export const ReturnModelPresetView = z.object({
  id: z.enum(["historical", "conservative"]),
  label: z.string(),
  params: ParametricParams,
});
export type ReturnModelPresetView = z.infer<typeof ReturnModelPresetView>;

/**
 * The return models' facts the browser cannot compute (C47: it may not import the engine or its
 * data): the parametric presets, where a new custom model starts, and the calendar years of the
 * return series the historical and bootstrap models draw from.
 */
export const RetirementReturnModelsMeta = z.object({
  presets: z.array(ReturnModelPresetView),
  /**
   * Where a new custom model starts (seams G2: "means and volatilities; correlations and
   * persistence from history"): the arithmetic means and sample standard deviations of the data
   * file's simple annual returns, its inflation persistence and innovation correlations, bills not
   * persistent, initial rates absent (the data's last year), each to the nearest basis point.
   */
  historyStartParams: ParametricParams,
  history: z.object({ firstYear: z.number().int(), lastYear: z.number().int() }),
});
export type RetirementReturnModelsMeta = z.infer<typeof RetirementReturnModelsMeta>;

/**
 * Route 1. `minStartYear` is the first year of the tax data, which the browser's `resolvePlan` needs
 * (seams C47); `returnModels` feeds the run-settings form's presets and its custom model.
 */
export const RetirementMeta = z.object({
  engineVersion: z.string(),
  dataVersion: z.string(),
  minStartYear: z.number().int(),
  ruleSets: z.array(z.object({ id: z.string(), label: z.string() })),
  limits: z.object({ minPaths: z.number().int(), maxPaths: z.number().int(), defaultPaths: z.number().int() }),
  defaultSettings: RunSettings,
  returnModels: RetirementReturnModelsMeta,
  storedPercentiles: z.array(z.number().int()),
  medicareAge: z.number().int(),
  fullRetirementAge: z.array(
    z.object({ fromBirthYear: z.number().int(), toBirthYear: z.number().int().nullable(), years: z.number().int(), months: z.number().int() }),
  ),
  disclaimer: z.string(),
});
export type RetirementMeta = z.infer<typeof RetirementMeta>;

/** Routes 2 to 4. `effective` and `issues` are resolved with no overrides and the default scenario's settings. */
export const ProfileResponse = z.object({
  exists: z.boolean(),
  /** 0 when it does not exist. */
  revision: z.number().int(),
  doc: RetirementProfileDoc.nullable(),
  updatedAt: z.string().nullable(),
  /** Stored; a live preview when the profile does not exist. */
  baseline: RetirementBaseline,
  baselineStored: z.boolean(),
  baselineHash: z.string(),
  baselineAgeDays: z.number().int(),
  baselineStale: z.boolean(),
  effective: EffectiveInputsView.nullable(),
  issues: z.array(PlanIssue),
  scenarioIssues: z.array(z.object({ scenarioId: z.string().uuid(), name: z.string(), issues: z.array(PlanIssue) })),
  defaultScenarioId: z.string().uuid().nullable(),
});
export type ProfileResponse = z.infer<typeof ProfileResponse>;

/** Route 5 (computes, writes nothing). */
export const BaselinePreviewResponse = z.object({
  current: RetirementBaseline.nullable(),
  proposed: RetirementBaseline,
  proposedHash: z.string(),
  changes: z.array(BaselineChange),
  effectiveBefore: EffectiveInputsView.nullable(),
  effectiveAfter: EffectiveInputsView.nullable(),
});
export type BaselinePreviewResponse = z.infer<typeof BaselinePreviewResponse>;

/** Route 6. */
export const BaselineRefreshResponse = z.object({ profile: ProfileResponse, changes: z.array(BaselineChange) });
export type BaselineRefreshResponse = z.infer<typeof BaselineRefreshResponse>;

export const SimRunView = z.object({
  id: z.string().uuid(),
  scenarioId: z.string().uuid(),
  scenarioName: z.string(),
  status: SimRunStatus,
  cancelRequested: z.boolean(),
  /** Running and no progress write for 120 s. */
  stalled: z.boolean(),
  paths: z.number().int(),
  pathsDone: z.number().int(),
  /** truncDiv(pathsDone × 10000, paths), at most 10000. */
  progressBp: z.number().int(),
  seed: z.number().int(),
  returnModel: z.string(),
  strategy: z.string(),
  taxRuleSet: z.string(),
  baselineAsOf: IsoDateString,
  dataVersion: z.string(),
  engineVersion: z.string().nullable(),
  threads: z.number().int().nullable(),
  inputHash: z.string(),
  successPaths: z.number().int().nullable(),
  /** truncDiv(successPaths × 10000, paths). */
  successBp: z.number().int().nullable(),
  /** From `summary.endingWealthReal`. */
  medianEndingRealCents: CentsString.nullable(),
  p10EndingRealCents: CentsString.nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  pinned: z.boolean(),
  note: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  /** `input_hash` equals what the scenario would freeze now, under the same engine version. */
  current: z.boolean(),
});
export type SimRunView = z.infer<typeof SimRunView>;

/** Route 16. */
export const SimRunDetail = SimRunView.extend({
  summary: SimSummary.nullable(),
  fan: FanSeries.nullable(),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  storedPercentiles: z.array(z.number().int()),
});
export type SimRunDetail = z.infer<typeof SimRunDetail>;

/** Route 18. `depletionYear` is null for a path that never ran out (seams C46). */
export const RunPathResponse = z.object({
  percentile: z.number().int(),
  pathIndex: z.number().int(),
  rank: z.number().int(),
  source: z.enum(["stored", "resimulated"]),
  endingRealCents: CentsString,
  depletionYear: z.number().int().nullable(),
  table: YearTable,
});
export type RunPathResponse = z.infer<typeof RunPathResponse>;

/** Route 14: 202 with a new run, 200 when an existing run is returned. */
export const RunRequestResponse = z.object({ run: SimRunView, created: z.boolean(), reused: z.boolean(), baselineChanges: z.array(BaselineChange) });
export type RunRequestResponse = z.infer<typeof RunRequestResponse>;

/** Route 15. */
export const RunListResponse = z.object({ items: z.array(SimRunView), nextCursor: z.string().nullable() });
export type RunListResponse = z.infer<typeof RunListResponse>;

export const ScenarioSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  notes: z.string().nullable(),
  isDefault: z.boolean(),
  archived: z.boolean(),
  position: z.number().int(),
  revision: z.number().int(),
  updatedAt: z.string(),
  changeCount: z.number().int(),
  latestRun: SimRunView.nullable(),
  activeRunId: z.string().uuid().nullable(),
});
export type ScenarioSummary = z.infer<typeof ScenarioSummary>;

/** Route 7. */
export const ScenarioListResponse = z.object({ items: z.array(ScenarioSummary) });
export type ScenarioListResponse = z.infer<typeof ScenarioListResponse>;

/** Routes 8 to 10 and 12. `doc` is null when the overrides no longer apply (`override_invalid`). */
export const ScenarioView = ScenarioSummary.extend({
  overrides: z.record(z.unknown()),
  doc: RetirementProfileDoc.nullable(),
  changes: z.array(z.object({ path: z.string(), before: z.unknown().optional(), after: z.unknown().optional() })),
  settings: RunSettings,
  issues: z.array(PlanIssue),
  inputHash: z.string().nullable(),
  profileRevision: z.number().int(),
});
export type ScenarioView = z.infer<typeof ScenarioView>;

/** Route 13: the input the scenario would freeze now. */
export const ScenarioInputResponse = z.object({
  input: SimInput.nullable(),
  inputHash: z.string().nullable(),
  issues: z.array(PlanIssue),
  effective: EffectiveInputsView.nullable(),
  reusableRunId: z.string().uuid().nullable(),
});
export type ScenarioInputResponse = z.infer<typeof ScenarioInputResponse>;

// ---- The route table ----

export type RetirementRouteMethod = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";

/** One route of the planner: its number in the designs, what it takes and what it answers. */
export interface RetirementRoute {
  readonly n: number;
  readonly method: RetirementRouteMethod;
  /** Under `RETIREMENT_API_PREFIX`, in Fastify's `:param` syntax. */
  readonly path: string;
  /** `owner`: mutating, owner-only; `any`: owners and viewers (reads, and the read-only previews 23 and 24). */
  readonly role: "any" | "owner";
  readonly params?: z.ZodTypeAny;
  readonly querystring?: z.ZodTypeAny;
  readonly body?: z.ZodTypeAny;
  readonly response: Readonly<Partial<Record<200 | 201 | 202, z.ZodTypeAny>>>;
}

/** The 24 routes, in the designs' numbering (inputs-and-data §4.7, tax-rmd-ss §4.4). */
export const RETIREMENT_ROUTES: readonly RetirementRoute[] = [
  { n: 1, method: "GET", path: "/meta", role: "any", response: { 200: RetirementMeta } },
  { n: 2, method: "GET", path: "/profile", role: "any", querystring: TodayQuery, response: { 200: ProfileResponse } },
  { n: 3, method: "PUT", path: "/profile", role: "owner", body: PutProfileBody, response: { 200: ProfileResponse } },
  { n: 4, method: "POST", path: "/profile/revert", role: "owner", body: RevertProfileBody, response: { 200: ProfileResponse } },
  { n: 5, method: "GET", path: "/baseline/preview", role: "any", querystring: TodayQuery, response: { 200: BaselinePreviewResponse } },
  { n: 6, method: "POST", path: "/baseline/refresh", role: "owner", body: RefreshBaselineBody, response: { 200: BaselineRefreshResponse } },
  { n: 7, method: "GET", path: "/scenarios", role: "any", querystring: ScenarioListQuery, response: { 200: ScenarioListResponse } },
  { n: 8, method: "POST", path: "/scenarios", role: "owner", body: CreateScenarioBody, response: { 201: ScenarioView } },
  { n: 9, method: "GET", path: "/scenarios/:id", role: "any", params: UuidParams, querystring: TodayQuery, response: { 200: ScenarioView } },
  { n: 10, method: "PATCH", path: "/scenarios/:id", role: "owner", params: UuidParams, body: UpdateScenarioBody, response: { 200: ScenarioView } },
  { n: 11, method: "DELETE", path: "/scenarios/:id", role: "owner", params: UuidParams, response: { 200: OkResponse } },
  { n: 12, method: "POST", path: "/scenarios/:id/revert", role: "owner", params: UuidParams, body: RevertScenarioBody, response: { 200: ScenarioView } },
  { n: 13, method: "GET", path: "/scenarios/:id/input", role: "any", params: UuidParams, querystring: TodayQuery, response: { 200: ScenarioInputResponse } },
  {
    n: 14,
    method: "POST",
    path: "/scenarios/:id/runs",
    role: "owner",
    params: UuidParams,
    body: RunRequestBody,
    response: { 200: RunRequestResponse, 202: RunRequestResponse },
  },
  { n: 15, method: "GET", path: "/runs", role: "any", querystring: RunListQuery, response: { 200: RunListResponse } },
  { n: 16, method: "GET", path: "/runs/:id", role: "any", params: UuidParams, response: { 200: SimRunDetail } },
  { n: 17, method: "GET", path: "/runs/:id/input", role: "any", params: UuidParams, response: { 200: SimInput } },
  { n: 18, method: "GET", path: "/runs/:id/paths/:percentile", role: "any", params: RunPathParams, response: { 200: RunPathResponse } },
  { n: 19, method: "POST", path: "/runs/:id/cancel", role: "owner", params: UuidParams, response: { 200: SimRunView } },
  { n: 20, method: "PATCH", path: "/runs/:id", role: "owner", params: UuidParams, body: UpdateRunBody, response: { 200: SimRunView } },
  { n: 21, method: "DELETE", path: "/runs/:id", role: "owner", params: UuidParams, response: { 200: OkResponse } },
  { n: 22, method: "GET", path: "/rules", role: "any", querystring: TodayQuery, response: { 200: RetirementRulesView } },
  { n: 23, method: "POST", path: "/tax-preview", role: "any", body: FederalTaxPreviewRequest, response: { 200: FederalTaxPreviewResponse } },
  {
    n: 24,
    method: "POST",
    path: "/social-security-preview",
    role: "any",
    body: SocialSecurityPreviewRequest,
    response: { 200: SocialSecurityPreviewResponse },
  },
];
