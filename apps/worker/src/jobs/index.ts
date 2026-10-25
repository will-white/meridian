import { runRules, type JobRow } from "@meridian/db";
import { runClaimJob } from "./claim.js";
import { runCloseMonthJob } from "./closeMonth.js";
import type { JobContext } from "./context.js";
import { runInvestmentIncomeFeedJob } from "./investmentIncomeFeed.js";
import { runInvestmentsValuationJob } from "./investmentsValuation.js";
import { runPricesFetchJob } from "./pricesFetch.js";
import { runRecurringDetectJob } from "./recurringDetect.js";
import { runReprocessHoldingsJob } from "./reprocessHoldings.js";
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
    case "recurring.detect":
      return runRecurringDetectJob(ctx, job);
    case "plan.close_month":
      return runCloseMonthJob(ctx, job);
    case "simplefin.reprocess_holdings":
      return runReprocessHoldingsJob(ctx, job);
    case "prices.fetch":
      return runPricesFetchJob(ctx, job);
    case "investments.valuation":
      return runInvestmentsValuationJob(ctx, job);
    case "investments.income_feed":
      return runInvestmentIncomeFeedJob(ctx, job);
    default:
      throw new Error(`unknown job type ${String(job.type)}`);
  }
}

export { runClaimJob, runSyncJob, runPricesFetchJob, runInvestmentsValuationJob, runInvestmentIncomeFeedJob, runReprocessHoldingsJob };
