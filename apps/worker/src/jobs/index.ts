import { runRules, type JobRow } from "@meridian/db";
import { runClaimJob } from "./claim.js";
import type { JobContext } from "./context.js";
import { runSyncJob } from "./sync.js";

export async function dispatchJob(ctx: JobContext, job: JobRow): Promise<unknown> {
  switch (job.type) {
    case "simplefin.claim":
      return runClaimJob(ctx, job);
    case "simplefin.sync":
    case "simplefin.balances":
      return runSyncJob(ctx, job);
    case "rules.run":
      return runRules(ctx.db, { scope: job.payload["scope"] === "all" ? "all" : "uncategorized" });
    default:
      throw new Error(`unknown job type ${String(job.type)}`);
  }
}

export { runClaimJob, runSyncJob };
