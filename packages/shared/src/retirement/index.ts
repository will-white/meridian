/**
 * The retirement planner's wire and document schemas, for all four Phase 4 areas
 * (docs/phase-4-plan.md, docs/design/phase-4/seams.md §2). `@meridian/retirement` imports these;
 * `apps/web` imports only `@meridian/shared` (seams C47).
 *
 * Import rule: files here import ../enums.ts, ../wire.ts, the pure helpers of the package
 * (../decimal.ts, ../months.ts, ../dates.ts, ../crypto.ts, ../plan.ts's `firstFullLedgerMonth`;
 * the type `ExternalFlowInput` of ../performance.ts) and each other; only ./api.ts imports
 * ../api.ts, and ../api.ts may import only ./card.ts (the dashboard card), so no import cycle
 * forms. The planner's pure helpers (merge patch, canonical JSON and the input hash, the plan
 * clock, buckets, class and glide weights, percentile paths and the series codecs, the result
 * helpers and VPW, the contribution aggregation, the baseline hash and diff, and the resolver)
 * sit beside the schemas they work on.
 */
export * from "./primitives.js";
export * from "./profile.js";
export * from "./baseline.js";
export * from "./returnModel.js";
export * from "./strategy.js";
export * from "./tax.js";
export * from "./settings.js";
export * from "./input.js";
export * from "./results.js";
export * from "./mergePatch.js";
export * from "./freeze.js";
export * from "./contributions.js";
export * from "./baselineDiff.js";
export * from "./resolve.js";
export * from "./bucket.js";
export * from "./clock.js";
export * from "./weights.js";
export * from "./percentile.js";
export * from "./card.js";
export * from "./api.js";
