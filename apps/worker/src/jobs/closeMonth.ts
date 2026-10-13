import type { JobRow } from "@meridian/db";
import type { JobContext } from "./context.js";

/** Phase 2: freeze auto-planned values for completed months. Owned by its implementer; see docs/design/phase-2/plan-math.md. */
export async function runCloseMonthJob(ctx: JobContext, job: JobRow): Promise<unknown> {
  void ctx;
  void job;
  throw new Error("plan.close_month is not implemented yet");
}
