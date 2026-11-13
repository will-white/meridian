/**
 * The retirement planner's wire and document schemas, for all four Phase 4 areas
 * (docs/phase-4-plan.md, docs/design/phase-4/seams.md §2). `@meridian/retirement` imports these;
 * `apps/web` imports only `@meridian/shared` (seams C47).
 *
 * Import rule: files here import ../enums.ts, ../wire.ts and each other; only ./api.ts imports
 * ../api.ts, and ../api.ts may import only ./card.ts (the dashboard card), so no import cycle
 * forms.
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
export * from "./card.js";
export * from "./api.js";
