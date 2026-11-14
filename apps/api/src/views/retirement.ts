import { TaxDataError, TaxInputError } from "@meridian/retirement";
import { PlanError } from "@meridian/db";
import {
  DEFAULT_PATHS,
  defaultRunSettings,
  MAX_PATHS,
  MEDICARE_AGE,
  MIN_PATHS,
  PLANNER_DISCLAIMER,
  STORED_PERCENTILES,
  type RetirementMeta,
  type RunRequestResponse,
  type ScenarioListResponse,
  type ScenarioSummary,
} from "@meridian/shared";
import type { Planner } from "../planner.js";

/**
 * View mappers of the planner's routes (docs/design/phase-4/inputs-and-data.md §4.7 and §4.8,
 * tax-rmd-ss §4.4). The planner services already return the wire shapes of shared
 * `retirement/api.ts` (their stored documents hold cents as strings; docs/phase-4-plan.md, step 26),
 * so what is left here is the meta, the list envelope, the run request's status and the mapping of
 * the engine's refusals of a preview request.
 */

/** Route 1 (`GET /meta`): the engine's facts and the planner's fixed figures (seams C47: the browser imports none of the engine). */
export function toRetirementMeta(planner: Planner): RetirementMeta {
  return {
    engineVersion: planner.env.engineVersion,
    dataVersion: planner.env.dataVersion,
    minStartYear: planner.env.minStartYear,
    ruleSets: planner.ruleSets.map((r) => ({ id: r.id, label: r.label })),
    limits: { minPaths: MIN_PATHS, maxPaths: MAX_PATHS, defaultPaths: DEFAULT_PATHS },
    defaultSettings: defaultRunSettings(),
    returnModels: planner.returnModels,
    storedPercentiles: [...STORED_PERCENTILES],
    medicareAge: MEDICARE_AGE,
    fullRetirementAge: planner.fullRetirementAge.map((r) => ({ fromBirthYear: r.fromBirthYear, toBirthYear: r.toBirthYear, years: r.years, months: r.months })),
    disclaimer: PLANNER_DISCLAIMER,
  };
}

/** Route 7's envelope. */
export function toScenarioListResponse(items: ScenarioSummary[]): ScenarioListResponse {
  return { items };
}

/** Route 14: 202 when a run was queued, 200 when an existing run (active or finished, same input) is returned. */
export function runRequestStatus(r: RunRequestResponse): 200 | 202 {
  return r.created ? 202 : 200;
}

/**
 * Routes 23 and 24: the engine refuses a request it cannot compute with a typed error, which is the
 * caller's 400 with the engine's code (tax-rmd-ss §4.4): `TaxDataError("unknown_rule_set")`, and
 * `TaxInputError` (`qualified_exceeds_ordinary`, `tax_input_invalid`). A `TaxDataError` of another
 * code is the bundled data's fault and stays a 500. Anything else passes through.
 */
export function toPreviewError(error: unknown): unknown {
  if (error instanceof TaxDataError && error.code === "unknown_rule_set") return new PlanError(400, error.code, error.message);
  if (error instanceof TaxInputError) return new PlanError(400, error.code, error.message);
  return error;
}

/** Runs a preview, mapping the engine's refusals (`toPreviewError`). */
export function preview<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw toPreviewError(error);
  }
}
