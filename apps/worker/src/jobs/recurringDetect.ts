import type { JobRow } from "@meridian/db";
import type { JobContext } from "./context.js";

/** Phase 2: run recurring detection and alerts. Owned by its implementer; see docs/design/phase-2/recurring.md. */
export async function runRecurringDetectJob(ctx: JobContext, job: JobRow): Promise<unknown> {
  void ctx;
  void job;
  throw new Error("recurring.detect is not implemented yet");
}
