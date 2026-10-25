import { runInvestmentIncomeFeed, type JobRow, type RunIncomeFeedResult } from "@meridian/db";
import type { JobContext } from "./context.js";

export interface InvestmentIncomeFeedOutcome extends Omit<RunIncomeFeedResult, "skipped"> {
  reason: string;
  /** Accounts with a feed but no household income category. */
  skipped: number;
}

/**
 * `investments.income_feed` (plan decision 13): one pass of the feed over every account whose
 * `investment_income_feed` is on (the payload's `accountId` is informational: a queued run is
 * shared by every enqueuer under the key `investments.income_feed`). Idempotent: a second run
 * right after the first reports everything `unchanged`.
 */
export async function runInvestmentIncomeFeedJob(ctx: JobContext, job: JobRow): Promise<InvestmentIncomeFeedOutcome> {
  const reason = typeof job.payload["reason"] === "string" ? job.payload["reason"] : "manual";
  const result = await runInvestmentIncomeFeed(ctx.db, { now: ctx.now() });
  for (const s of result.skipped) ctx.log.warn(`[investments.income_feed] ${s.name} has a feed but the household has no investment income category`);
  const { skipped, ...counts } = result;
  return { reason, ...counts, skipped: skipped.length };
}
