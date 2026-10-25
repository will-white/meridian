import { and, eq, gt, gte, inArray, lte, ne, notInArray, sql } from "drizzle-orm";
import {
  accountFidelities,
  balanceSnapshot,
  firstDataDates,
  getHouseholdSetting,
  householdToday,
  listInvestmentAccounts,
  loadValuationInput,
  PlanError,
  type JobRow,
} from "@meridian/db";
import { addDays, expectedPriceDate, MAX_SERIES_DAYS, valueSeries, type IsoDate } from "@meridian/shared";
import type { JobContext } from "./context.js";

/**
 * `investments.valuation` (plan decision 9; seams decision 8): write `balance_snapshot` rows
 * with `source = 'computed'` from the valuation chain for every open investment account (or
 * the payload's one), on the dates after its last reported row through the expected price
 * date. The window also reaches back to the earliest computed row the account already carries:
 * a reconcile commit or a backdated statement makes a later date reported, and the computed
 * rows before it must still follow a corrected close (the overlap re-fetch, a manual price) or
 * a backdated import. `ON CONFLICT … WHERE source = 'computed'` never overwrites a reported
 * row (and reported dates are not written at all), so Phase 2's net worth stays on
 * `balance_snapshot` and agrees with the Portfolio on every date. A date the chain cannot
 * value loses its stale computed row. `account.balance_*` (the latest reported balance) is not
 * touched. Idempotent.
 */

export interface ValuationSkip {
  accountId: string;
  reason: "no_data" | "up_to_date" | "unknown_account";
}

export interface InvestmentsValuationOutcome {
  reason: string;
  today: IsoDate;
  expectedThrough: IsoDate;
  /** The last date valued (the expected price date, never after the household's today). */
  through: IsoDate;
  accounts: number;
  /** Computed rows inserted or changed. */
  written: number;
  /** Computed rows already holding the chain's value. */
  kept: number;
  /** Stale computed rows removed (dates the chain no longer values). */
  removed: number;
  skipped: ValuationSkip[];
}

const WRITE_BATCH = 500;

export async function runInvestmentsValuationJob(ctx: JobContext, job: JobRow): Promise<InvestmentsValuationOutcome> {
  const now = ctx.now();
  const setting = await getHouseholdSetting(ctx.db);
  const today = householdToday(setting, now);
  const expectedThrough = expectedPriceDate(now);
  const through = expectedThrough < today ? expectedThrough : today;
  const reason = typeof job.payload["reason"] === "string" ? job.payload["reason"] : "manual";
  const accountId = typeof job.payload["accountId"] === "string" ? job.payload["accountId"] : undefined;
  const outcome: InvestmentsValuationOutcome = { reason, today, expectedThrough, through, accounts: 0, written: 0, kept: 0, removed: 0, skipped: [] };

  let accounts;
  try {
    accounts = await listInvestmentAccounts(ctx.db, accountId ? { accountIds: [accountId], includeClosed: true } : {});
  } catch (err) {
    // A payload naming a deleted or non-investment account: nothing to value, nothing to retry.
    if (err instanceof PlanError && accountId) {
      ctx.log.warn(`[investments.valuation] ${err.message}`);
      outcome.skipped.push({ accountId, reason: "unknown_account" });
      return outcome;
    }
    throw err;
  }
  const open = accounts.filter((a) => !a.closed);
  if (open.length === 0) return outcome;
  const ids = open.map((a) => a.id);

  // Where each account's computed rows start: the day after its last reported row, else its first data
  // date, and never after the earliest computed row it already carries (those rows are this job's to
  // refresh or remove whatever reported rows arrived after them).
  const bounds = await ctx.db
    .select({
      accountId: balanceSnapshot.accountId,
      lastReported: sql<string | null>`(max(${balanceSnapshot.date}) filter (where ${balanceSnapshot.source} <> 'computed'))::text`,
      firstComputed: sql<string | null>`(min(${balanceSnapshot.date}) filter (where ${balanceSnapshot.source} = 'computed'))::text`,
    })
    .from(balanceSnapshot)
    .where(inArray(balanceSnapshot.accountId, ids))
    .groupBy(balanceSnapshot.accountId);
  const boundsBy = new Map(bounds.map((r) => [r.accountId, r]));
  const fidelities = await accountFidelities(ctx.db, ids);
  const firsts = await firstDataDates(ctx.db, ids, fidelities);

  const windows: Array<{ accountId: string; from: IsoDate }> = [];
  for (const id of ids) {
    const reported = boundsBy.get(id)?.lastReported ?? null;
    const firstComputed = boundsBy.get(id)?.firstComputed ?? null;
    const first = firsts.get(id) ?? null;
    let from = reported ? addDays(reported, 1) : first;
    if (firstComputed !== null && (from === null || firstComputed < from)) from = firstComputed;
    if (from === null) {
      outcome.skipped.push({ accountId: id, reason: "no_data" });
      continue;
    }
    if (from > through) {
      outcome.skipped.push({ accountId: id, reason: "up_to_date" });
      continue;
    }
    const floor = addDays(through, -MAX_SERIES_DAYS);
    if (from < floor) from = floor;
    windows.push({ accountId: id, from });
  }
  if (windows.length === 0) return outcome;
  outcome.accounts = windows.length;

  const earliest = windows.reduce((acc, w) => (w.from < acc ? w.from : acc), windows[0]!.from);
  const windowIds = windows.map((w) => w.accountId);
  const input = await loadValuationInput(ctx.db, { accountIds: windowIds, from: earliest, to: through, now, fidelities });
  // Reported dates inside the windows are never written (the upsert's guard would refuse them anyway).
  const reportedRows = await ctx.db
    .select({ accountId: balanceSnapshot.accountId, date: balanceSnapshot.date })
    .from(balanceSnapshot)
    .where(and(inArray(balanceSnapshot.accountId, windowIds), ne(balanceSnapshot.source, "computed"), gte(balanceSnapshot.date, earliest), lte(balanceSnapshot.date, through)));
  const reportedDates = new Map<string, Set<IsoDate>>();
  for (const r of reportedRows) {
    const set = reportedDates.get(r.accountId) ?? new Set<IsoDate>();
    set.add(r.date);
    reportedDates.set(r.accountId, set);
  }

  for (const w of windows) {
    const series = valueSeries(input, [w.accountId], w.from, through, "day");
    const values = series.accounts[0]!.values;
    const reported = reportedDates.get(w.accountId);
    const rows: Array<{ date: IsoDate; balanceCents: bigint }> = [];
    series.dates.forEach((date, i) => {
      const v = values[i];
      if (v !== null && v !== undefined && !reported?.has(date)) rows.push({ date, balanceCents: v });
    });
    for (let i = 0; i < rows.length; i += WRITE_BATCH) {
      const batch = rows.slice(i, i + WRITE_BATCH);
      const values = batch.map((r) => sql`(${w.accountId}::uuid, ${r.date}::date, ${r.balanceCents.toString()}::bigint, 'computed')`);
      const returned = await ctx.db.execute<{ inserted: boolean }>(sql`
        insert into balance_snapshot (account_id, date, balance_cents, source)
        values ${sql.join(values, sql`, `)}
        on conflict (account_id, date) do update set balance_cents = excluded.balance_cents
        where balance_snapshot.source = 'computed' and balance_snapshot.balance_cents is distinct from excluded.balance_cents
        returning (xmax = 0) as inserted
      `);
      outcome.written += returned.length;
      outcome.kept += batch.length - returned.length;
    }
    // Computed rows in the window the chain no longer values.
    const removed = await ctx.db
      .delete(balanceSnapshot)
      .where(
        and(
          eq(balanceSnapshot.accountId, w.accountId),
          eq(balanceSnapshot.source, "computed"),
          gte(balanceSnapshot.date, w.from),
          lte(balanceSnapshot.date, through),
          rows.length > 0
            ? notInArray(
                balanceSnapshot.date,
                rows.map((r) => r.date),
              )
            : gt(balanceSnapshot.date, "1900-01-01"),
        ),
      )
      .returning({ id: balanceSnapshot.id });
    outcome.removed += removed.length;
  }
  return outcome;
}
