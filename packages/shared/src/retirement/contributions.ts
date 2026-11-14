import type { IsoDate } from "../dates.js";
import { addMonths, monthKey, monthRange, monthStart, truncDiv, type MonthKey } from "../months.js";
import type { ExternalFlowInput } from "../performance.js";
import { firstFullLedgerMonth } from "../plan.js";
import type { BaselineContribution } from "./baseline.js";

/**
 * Contributions measured from live data (inputs-and-data §3.2 B8, decision 14): the net external
 * cash flows into each planner investment account over the baseline's 12-month window, with moves
 * between plan accounts removed, annualized over the full months with data (at least 3), and the
 * employer part found by description. Pure: the service loads the flows (`loadFlowRows`), their
 * descriptions and each account's first data date, calls `aggregateContributions`, then adds the
 * recurring-transfer fallback with `withRecurringFallback`.
 *
 * Rounding: sums are exact; annualizing truncates toward zero (`truncDiv`, the Phase 2 rule).
 */

/**
 * A description that marks a positive flow as employer money (B8): "EMPLOYER MATCH", "ER SAFE
 * HARBOR", "PROFIT SHARING", "NON-ELECTIVE"; not "EMPLOYEE PRE-TAX CONTRIBUTION".
 */
export const EMPLOYER_DESCRIPTION = /\b(employer|match|safe harbor|profit.?shar|non.?elective)/i;

/** Fewer full months than this and the annual figures are absent (`insufficient_history`). */
export const MIN_CONTRIBUTION_MONTHS = 3;
const FULL_YEAR_MONTHS = 12;

/** One account's measured contributions, before the service's recurring fallback (`plannedCents`, `source`). */
export type BaselineContributionRecord = Omit<BaselineContribution, "plannedCents" | "source">;

type Flag = BaselineContribution["flags"][number];

/** The window's months as `[from, to]`, inclusive (the baseline's `window`). */
export interface ContributionWindow {
  from: MonthKey;
  to: MonthKey;
}

function cents(v: bigint): string {
  return v.toString();
}

/**
 * Aggregates the flows of the planner investment accounts (B8). For each account of
 * `plannerInvestmentIds`, in id order:
 *
 * - securities flows and flows whose counterparty is another plan investment account (a rollover,
 *   a move between plan accounts) are dropped, and so is any flow outside the window;
 * - the coverage start is the earlier of the account's first data date and its earliest remaining
 *   flow; months count from `firstFullLedgerMonth(coverageStart)` (a partial first month counts in
 *   neither the sum nor the divisor), and flows before that month are dropped;
 * - gross in, out, net `max(0, in − out)`, unpaired (positive flows with no counterparty: payroll
 *   deferrals and employer money never pass through a bank account);
 * - employer money: positive flows whose description (by `sourceId`) matches
 *   `EMPLOYER_DESCRIPTION`, at most the net; the employee part is the rest of the net;
 * - 12 months or more: the annual figures are the sums; 3 to 11: `truncDiv(x × 12, k)` with
 *   `partial_window`; fewer: absent, `insufficient_history`;
 * - `irregular` when one positive flow is more than half the gross; `has_withdrawals` when any
 *   money left the account.
 */
export function aggregateContributions(
  flows: readonly ExternalFlowInput[],
  descriptions: ReadonlyMap<string, string>,
  plannerInvestmentIds: ReadonlySet<string>,
  firstDataDates: ReadonlyMap<string, IsoDate | null>,
  window: ContributionWindow,
): BaselineContributionRecord[] {
  const windowMonths = monthRange(window.from, window.to);
  const lo = monthStart(window.from);
  const hi = monthStart(addMonths(window.to, 1));
  const byAccount = new Map<string, ExternalFlowInput[]>();
  for (const flow of flows) {
    if (!plannerInvestmentIds.has(flow.accountId)) continue;
    if (flow.kind === "securities") continue;
    if (flow.counterpartyAccountId !== null && plannerInvestmentIds.has(flow.counterpartyAccountId)) continue;
    if (flow.date < lo || flow.date >= hi) continue;
    const list = byAccount.get(flow.accountId);
    if (list === undefined) byAccount.set(flow.accountId, [flow]);
    else list.push(flow);
  }

  return [...plannerInvestmentIds].sort().map((accountId): BaselineContributionRecord => {
    const remaining = byAccount.get(accountId) ?? [];
    let coverageStart: IsoDate | null = firstDataDates.get(accountId) ?? null;
    for (const flow of remaining) if (coverageStart === null || flow.date < coverageStart) coverageStart = flow.date;
    const firstFull = firstFullLedgerMonth(coverageStart);
    const counted = firstFull === null ? [] : remaining.filter((f) => monthKey(f.date) >= firstFull);
    const k = firstFull === null ? 0 : windowMonths.filter((m) => m >= firstFull).length;

    let grossIn = 0n;
    let out = 0n;
    let unpaired = 0n;
    let matched = 0n;
    let largestIn = 0n;
    for (const flow of counted) {
      const amount = flow.amountCents;
      if (amount > 0n) {
        grossIn += amount;
        if (flow.counterpartyAccountId === null) unpaired += amount;
        const description = flow.sourceId === null ? undefined : descriptions.get(flow.sourceId);
        if (description !== undefined && EMPLOYER_DESCRIPTION.test(description)) matched += amount;
        if (amount > largestIn) largestIn = amount;
      } else if (amount < 0n) {
        out += -amount;
      }
    }
    const net = grossIn > out ? grossIn - out : 0n;
    const employer = matched < net ? matched : net;
    const employee = net - employer;

    const flags: Flag[] = [];
    const record: BaselineContributionRecord = {
      accountId,
      monthsWithData: k,
      grossInCents: cents(grossIn),
      outCents: cents(out),
      netCents: cents(net),
      unpairedCents: cents(unpaired),
      employerCents: cents(employer),
      employeeCents: cents(employee),
      employerDetected: employer > 0n,
      flags,
    };
    if (k >= MIN_CONTRIBUTION_MONTHS) {
      const annual = (x: bigint) => cents(k >= FULL_YEAR_MONTHS ? x : truncDiv(x * BigInt(FULL_YEAR_MONTHS), BigInt(k)));
      record.annualNetCents = annual(net);
      record.annualEmployeeCents = annual(employee);
      record.annualEmployerCents = annual(employer);
      record.annualUnpairedCents = annual(unpaired);
      if (k < FULL_YEAR_MONTHS) flags.push("partial_window");
    } else {
      flags.push("insufficient_history");
    }
    if (largestIn * 2n > grossIn) flags.push("irregular");
    if (out > 0n) flags.push("has_withdrawals");
    return record;
  });
}

/**
 * The recurring fallback of B8 (in the service): `plannedCents` is the yearly equivalent of the
 * active recurring transfers into the account; `source` is `measured` when the annual net is
 * positive, else `recurring` when a transfer is planned, else `none`.
 */
export function withRecurringFallback(record: BaselineContributionRecord, plannedCents: bigint): BaselineContribution {
  const net = record.annualNetCents === undefined ? 0n : BigInt(record.annualNetCents);
  const planned = plannedCents < 0n ? -plannedCents : plannedCents;
  const source = net > 0n ? "measured" : planned > 0n ? "recurring" : "none";
  return { ...record, plannedCents: cents(planned), source };
}

