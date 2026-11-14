import { AuditEntity, JobType, ReturnModelKind, SeriesEncoding, SimRunSeriesKind, SimRunStatus, StrategyKind } from "@meridian/shared";
import { describe, expect, it } from "vitest";
import { AUDIT_ENTITIES } from "./plan.js";
import { RETURN_MODEL_KINDS, SERIES_ENCODINGS, SIM_RUN_SERIES_KINDS, SIM_RUN_STATUSES, STRATEGY_KINDS } from "./retirement.js";
import { JOB_TYPES } from "./sources.js";

/**
 * The text columns' value lists mirror the shared enums (Phase 3 decision 3: `enums.ts` is the
 * single source), including the Phase 4 additions of inputs-and-data §2.5 that Stage A deferred to
 * land with their database mirrors: `retirement.simulate` and the planner's four audit entities.
 */
describe("database mirrors of the shared enums", () => {
  it("JOB_TYPES equals JobType and holds retirement.simulate", () => {
    expect([...JOB_TYPES]).toEqual(JobType.options);
    expect(JOB_TYPES).toContain("retirement.simulate");
  });

  it("AUDIT_ENTITIES equals AuditEntity and holds the planner's entities", () => {
    expect([...AUDIT_ENTITIES]).toEqual(AuditEntity.options);
    expect(AUDIT_ENTITIES).toEqual(expect.arrayContaining(["plan_profile", "plan_baseline", "scenario", "sim_run"]));
  });

  it("the planner's own text columns mirror their shared enums", () => {
    expect([...SIM_RUN_STATUSES]).toEqual(SimRunStatus.options);
    expect([...SIM_RUN_SERIES_KINDS]).toEqual(SimRunSeriesKind.options);
    expect([...SERIES_ENCODINGS]).toEqual(SeriesEncoding.options);
    expect([...RETURN_MODEL_KINDS]).toEqual(ReturnModelKind.options);
    expect([...STRATEGY_KINDS]).toEqual(StrategyKind.options);
  });
});
