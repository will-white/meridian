import { z } from "zod";
import { CentsString, IsoDateString } from "../wire.js";

/**
 * The dashboard's retirement card (`DashboardView.retirement`, inputs-and-data §4.9): the newest
 * finished run of the default scenario, filled by packages/db's `retirementCard`. `DashboardView`
 * in ../api.ts takes `RetirementCard.nullable()` (null: no profile yet). This file imports nothing
 * from ../api.ts, so that import makes no cycle.
 *
 * `state`: `running` while the default scenario has an active run; `failed` when its newest run
 * failed and none is done; `ready` with a run; `no_run` otherwise. `stale` is null when it was
 * not evaluated.
 */
export const RetirementCard = z.object({
  state: z.enum(["no_run", "running", "ready", "failed"]),
  scenarioId: z.string().uuid(),
  scenarioName: z.string(),
  active: z.object({ runId: z.string().uuid(), status: z.enum(["queued", "running"]), progressBp: z.number().int() }).nullable(),
  run: z
    .object({
      id: z.string().uuid(),
      finishedAt: z.string(),
      paths: z.number().int(),
      successPaths: z.number().int(),
      successBp: z.number().int(),
      medianEndingRealCents: CentsString,
      p10EndingRealCents: CentsString,
      baselineAsOf: IsoDateString,
      ageDays: z.number().int(),
      stale: z.object({ inputsChanged: z.boolean(), engineChanged: z.boolean() }).nullable(),
    })
    .nullable(),
  /** Error issues on the default scenario. */
  issues: z.number().int(),
});
export type RetirementCard = z.infer<typeof RetirementCard>;
