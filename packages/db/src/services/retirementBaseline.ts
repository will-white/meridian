import { and, eq, inArray, isNull, lt, gte, notExists, sql } from "drizzle-orm";
import {
  addDays,
  addMonths,
  aggregateContributions,
  AssetClass,
  averageWindow,
  bucketSign,
  CADENCE_TABLE,
  classWeights,
  dayDiff,
  firstFullLedgerMonth,
  monthKey,
  monthRange,
  monthStart,
  PlanBucket,
  planBucketOf,
  RetirementBaseline,
  truncDiv,
  withRecurringFallback,
  type BaselineAccount,
  type BaselineContribution,
  type BaselineContributionRecord,
  type BaselineSpendingCategory,
  type ClassWeights,
  type IsoDate,
  type MonthKey,
} from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { account, category, investmentTxn, recurring, split, transaction } from "../schema/index.js";
import { latestBalances } from "./dashboard.js";
import { classifiedLines, holdingCostBasis, holdingsOf, investmentContext, type ContextAccount, type CoveredBasis, type InvestmentContext } from "./investmentViews.js";
import { loadFlowRows } from "./performance.js";
import { loadCategoryActuals } from "./plan.js";
import { firstDataDates } from "./valuation.js";

/**
 * The planner's baseline (docs/design/phase-4/inputs-and-data.md §3.2, B1 to B9; seams C25): what
 * live data says about the household on its as-of date, computed from the Phase 1 to 3 services
 * and stored by the profile service as `plan_profile.baseline`. Read-only: nothing here writes.
 *
 * - Investment accounts (B2, B4, B5): the investment views' valuation chain (`investmentContext`
 *   on the views' default as-of date), the class split of the classified lines, the cost basis of
 *   taxable accounts' positions, and the measured fund cost (C25): the value-weighted expense ratio
 *   of the account's positions that have one, with the share of the account's value they cover,
 *   by the Holdings page's own rule (`holdingsOf`'s `weightedExpenseRatio`: an unknown ratio counts
 *   as 0 for a stock, bond, cash or CD position and as unknown for a fund).
 * - Bank accounts (B3): the net worth rule's latest balance on or before today.
 * - Spending and income (B6, B7): the grid's actuals over the 12 complete months before today's
 *   month that the plan's ledger covers in full, plus uncategorized outflows.
 * - Contributions (B8): net external cash flows into each planner investment account over the
 *   same window (`aggregateContributions`), with the recurring-transfer fallback.
 * - The measured savings rate (B9), reported only.
 *
 * Rounding: sums of cents are exact; annualizing and ratios truncate toward zero (C44); class
 * weights split by largest remainder.
 */

export interface ComputeBaselineQuery {
  /** The household's date (the client's, through `resolveToday`). */
  today: IsoDate;
  /** The server clock: decides the as-of date (the latest close the feed can have). */
  now: Date;
}

/** A bank account's balance older than this many days before today is stale (B3). */
export const BANK_BALANCE_STALE_DAYS = 35;
/** The spending and contribution window, in complete months before today's month (B6). */
export const BASELINE_WINDOW_MONTHS = 12;

const CLASSES = AssetClass.options;
const BUCKETS = PlanBucket.options;

function byNameThenId(a: { name: string; accountId: string }, b: { name: string; accountId: string }): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
}

/** B4: the classified lines' value per class, and their weights; nothing for an unclassified account or one without a positive value. */
function allocationOf(ctx: InvestmentContext, a: ContextAccount): Pick<BaselineAccount, "classCents" | "weights"> {
  if (!a.classified || a.valuation.valueCents === null || a.valuation.valueCents <= 0n) return {};
  const sums = new Map<AssetClass, bigint>();
  for (const line of classifiedLines(ctx, new Set([a.id]))) {
    for (const [c, cents] of line.classCents) sums.set(c, (sums.get(c) ?? 0n) + cents);
  }
  const classCents: Partial<Record<AssetClass, string>> = {};
  for (const c of CLASSES) {
    const cents = sums.get(c) ?? 0n;
    if (cents !== 0n) classCents[c] = cents.toString();
  }
  const weights = classWeights(Object.fromEntries(sums));
  return { classCents, ...(weights === undefined ? {} : { weights }) };
}

/**
 * B5 (bucket taxable only): the basis known for the account's positions and the value of what has
 * none. A cash or synthetic line costs what it is worth; a position adds its basis when it has one
 * (the lots', else the statement's), and the value of its unknown-basis shares at the line's own
 * value per share; a position without a basis adds its whole value. A balance-only account has
 * no known basis.
 */
function basisOf(ctx: InvestmentContext, a: ContextAccount, basis: ReadonlyMap<string, CoveredBasis>): NonNullable<BaselineAccount["basis"]> {
  if (!a.classified) {
    const value = a.valuation.valueCents ?? 0n;
    return { knownCents: "0", unknownValueCents: value.toString(), coverage: value === 0n ? "full" : "none" };
  }
  let known = 0n;
  let unknownValue = 0n;
  let withBasis = 0;
  const sources = new Set<"lots" | "statement">();
  for (const line of a.lines) {
    const meta = line.securityId === null ? undefined : ctx.securities.get(line.securityId);
    if (line.kind !== "position" || meta === undefined || meta.type === "cash") {
      known += line.valueCents;
      continue;
    }
    const b = basis.get(`${a.id}|${line.securityId}`);
    if (b === undefined || b.costBasisCents === null) {
      unknownValue += line.valueCents;
      continue;
    }
    known += b.costBasisCents;
    withBasis++;
    if (b.basisSource !== null) sources.add(b.basisSource);
    const unknownQty = b.unknownBasisQuantity ?? 0n;
    if (unknownQty > 0n) {
      const quantity = line.quantity;
      // A line without a share count cannot be split: its whole value is of unknown basis.
      if (quantity === null || quantity <= 0n) unknownValue += line.valueCents;
      else unknownValue += truncDiv(line.valueCents * (unknownQty < quantity ? unknownQty : quantity), quantity);
    }
  }
  const coverage = unknownValue === 0n ? "full" : withBasis === 0 ? "none" : "partial";
  const source = sources.size === 0 ? undefined : sources.size === 2 ? "mixed" : [...sources][0]!;
  return { knownCents: known.toString(), unknownValueCents: unknownValue.toString(), coverage, ...(source === undefined ? {} : { source }) };
}

/** C25: the Holdings page's weighted expense ratio of the account's positions, and the share of its value they cover; absent when none has one. */
function expenseRatioOf(ctx: InvestmentContext, a: ContextAccount): Pick<BaselineAccount, "expenseRatio"> {
  if (!a.classified) return {};
  const { ppm, coveredBp } = holdingsOf(ctx, new Set([a.id])).weightedExpenseRatio;
  if (ppm === null || coveredBp === null) return {};
  return { expenseRatio: { ppm, coveredBp } };
}

function investmentAccount(ctx: InvestmentContext, a: ContextAccount, basis: ReadonlyMap<string, CoveredBasis>): BaselineAccount {
  const bucket = planBucketOf(a.type, a.taxTreatment);
  const value = a.valuation.valueCents;
  const ref = a.valuationRef;
  return {
    accountId: a.id,
    name: a.name,
    type: a.type,
    taxTreatment: a.taxTreatment,
    ...(bucket.bucket === undefined ? {} : { bucket: bucket.bucket }),
    ...(bucket.ineligible === undefined ? {} : { ineligible: bucket.ineligible }),
    treatmentDefaulted: bucket.treatmentDefaulted,
    ...(value === null ? {} : { valueCents: value.toString() }),
    ...(ref.valuationDate === null ? {} : { valuationDate: ref.valuationDate }),
    valuationBasis: ref.basis,
    stale: ref.valuationStale,
    fidelity: a.ref.fidelity,
    ...(bucket.bucket === "taxable" ? { basis: basisOf(ctx, a, basis) } : {}),
    ...allocationOf(ctx, a),
    ...expenseRatioOf(ctx, a),
  };
}

/** B3: open checking and savings accounts at their latest balance on or before today (any source). */
async function bankAccounts(db: DbOrTx, today: IsoDate): Promise<BaselineAccount[]> {
  const rows = await db
    .select({ id: account.id, name: account.name, type: account.type, taxTreatment: account.taxTreatment })
    .from(account)
    .where(and(inArray(account.type, ["checking", "savings"]), eq(account.closed, false)));
  if (rows.length === 0) return [];
  const balances = await latestBalances(db, today, true);
  return rows.map((r) => {
    const b = balances.get(r.id);
    return {
      accountId: r.id,
      name: r.name,
      type: r.type,
      taxTreatment: r.taxTreatment,
      bucket: "cash",
      treatmentDefaulted: false,
      ...(b === undefined ? {} : { valueCents: b.balanceCents.toString(), valuationDate: b.date }),
      valuationBasis: "bank_balance",
      stale: b === undefined || dayDiff(b.date, today) > BANK_BALANCE_STALE_DAYS,
    };
  });
}

/** B6: the window, the first month the plan's ledger covers in full, and the counted months. */
async function ledgerWindow(db: DbOrTx, today: IsoDate): Promise<{ from: MonthKey; to: MonthKey; monthsWithData: number; lo: IsoDate; countedLo: IsoDate; hi: IsoDate }> {
  const { from, to } = averageWindow(monthKey(today), BASELINE_WINDOW_MONTHS);
  const lo = monthStart(from);
  const hi = monthStart(addMonths(to, 1));
  const [earliest] = await db
    .select({ min: sql<string | null>`min(${transaction.date})::text` })
    .from(transaction)
    .innerJoin(account, eq(account.id, transaction.accountId))
    .where(eq(account.onBudget, true));
  const firstFull = firstFullLedgerMonth(earliest?.min ?? null);
  if (firstFull === null) return { from, to, monthsWithData: 0, lo, countedLo: hi, hi };
  const monthsWithData = monthRange(from, to).filter((m) => m >= firstFull).length;
  const firstDay = monthStart(firstFull);
  return { from, to, monthsWithData, lo, countedLo: firstDay > lo ? (firstDay < hi ? firstDay : hi) : lo, hi };
}

/** B7: uncategorized non-transfer rows of on-budget accounts in [lo, hi), split by sign (the plan's `loadUncategorized` predicate). */
async function uncategorized(db: DbOrTx, lo: IsoDate, hi: IsoDate): Promise<RetirementBaseline["spending"]["uncategorized"]> {
  if (lo >= hi) return { count: 0, outflowCents: "0", inflowCents: "0" };
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      outflow: sql<bigint>`coalesce(sum(case when ${transaction.amountCents} < 0 then -${transaction.amountCents} else 0 end), 0)::bigint`,
      inflow: sql<bigint>`coalesce(sum(case when ${transaction.amountCents} > 0 then ${transaction.amountCents} else 0 end), 0)::bigint`,
    })
    .from(transaction)
    .innerJoin(account, eq(account.id, transaction.accountId))
    .where(
      and(
        isNull(transaction.categoryId),
        eq(transaction.isTransfer, false),
        eq(account.onBudget, true),
        gte(transaction.date, lo),
        lt(transaction.date, hi),
        notExists(db.select({ one: sql`1` }).from(split).where(eq(split.transactionId, transaction.id))),
      ),
    );
  return { count: row?.count ?? 0, outflowCents: (row?.outflow ?? 0n).toString(), inflowCents: (row?.inflow ?? 0n).toString() };
}

/** B7: spending by bills and spending category (bucket-natural, a refund reduces it), take-home pay and the investment income shown beside it. */
async function spendingAndIncome(
  db: DbOrTx,
  lo: IsoDate,
  hi: IsoDate,
  investmentIncomeCategoryId: string | null,
): Promise<{ byCategory: BaselineSpendingCategory[]; categorized: bigint; bills: bigint; takeHome: bigint; investmentIncome: bigint }> {
  const out = { byCategory: [] as BaselineSpendingCategory[], categorized: 0n, bills: 0n, takeHome: 0n, investmentIncome: 0n };
  if (lo >= hi) return out;
  const actuals = await loadCategoryActuals(db, lo, hi);
  const categories = new Map((await db.select({ id: category.id, name: category.name, bucket: category.bucket }).from(category)).map((c) => [c.id, c]));
  const spending = new Map<string, { cents: bigint; months: Set<MonthKey> }>();
  for (const a of actuals) {
    const c = categories.get(a.categoryId);
    if (c === undefined) continue;
    if (a.categoryId === investmentIncomeCategoryId) {
      out.investmentIncome += a.signedCents;
    } else if (c.bucket === "income") {
      out.takeHome += a.signedCents;
    } else if (c.bucket === "bills" || c.bucket === "spending") {
      const s = spending.get(a.categoryId) ?? { cents: 0n, months: new Set<MonthKey>() };
      s.cents += bucketSign(c.bucket) * a.signedCents;
      s.months.add(a.month);
      spending.set(a.categoryId, s);
    }
  }
  for (const [categoryId, s] of spending) {
    const c = categories.get(categoryId)!;
    const bucket = c.bucket as "bills" | "spending";
    out.byCategory.push({ categoryId, name: c.name, bucket, cents: s.cents.toString(), activeMonths: s.months.size });
    out.categorized += s.cents;
    if (bucket === "bills") out.bills += s.cents;
  }
  // Largest first, then by name and id: a fixed order, so equal data gives an equal hash.
  out.byCategory.sort((a, b) => {
    const d = BigInt(b.cents) - BigInt(a.cents);
    if (d !== 0n) return d > 0n ? 1 : -1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0;
  });
  return out;
}

/** B8: descriptions of the flows by `sourceId`: the ledger row's raw description, else the investment row's, else its memo. */
async function flowDescriptions(db: DbOrTx, flows: readonly { source: string; sourceId: string | null }[]): Promise<Map<string, string>> {
  const ledgerIds = [...new Set(flows.filter((f) => f.source === "ledger" && f.sourceId !== null).map((f) => f.sourceId!))];
  const invIds = [...new Set(flows.filter((f) => f.source === "investment_txn" && f.sourceId !== null).map((f) => f.sourceId!))];
  const out = new Map<string, string>();
  if (ledgerIds.length > 0) {
    for (const r of await db.select({ id: transaction.id, text: transaction.rawDescription }).from(transaction).where(inArray(transaction.id, ledgerIds))) out.set(r.id, r.text);
  }
  if (invIds.length > 0) {
    for (const r of await db.select({ id: investmentTxn.id, raw: investmentTxn.rawDescription, memo: investmentTxn.memo }).from(investmentTxn).where(inArray(investmentTxn.id, invIds))) {
      const text = r.raw ?? r.memo;
      if (text !== null) out.set(r.id, text);
    }
  }
  return out;
}

/** B8's fallback: the yearly equivalent of the active recurring transfers into each account (Phase 2's occurrences a year). */
async function plannedTransfers(db: DbOrTx, accountIds: readonly string[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (accountIds.length === 0) return out;
  const rows = await db
    .select({ accountId: recurring.transferAccountId, cadence: recurring.cadence, expectedCents: recurring.expectedCents })
    .from(recurring)
    .where(and(eq(recurring.status, "active"), inArray(recurring.transferAccountId, [...accountIds])));
  for (const r of rows) {
    if (r.accountId === null) continue;
    const magnitude = r.expectedCents < 0n ? -r.expectedCents : r.expectedCents;
    out.set(r.accountId, (out.get(r.accountId) ?? 0n) + magnitude * BigInt(CADENCE_TABLE[r.cadence].occurrencesPerYear));
  }
  return out;
}

async function contributionsOf(db: DbOrTx, ctx: InvestmentContext, plannerInvestmentIds: ReadonlySet<string>, window: { from: MonthKey; to: MonthKey; lo: IsoDate; hi: IsoDate }): Promise<BaselineContribution[]> {
  const ids = [...plannerInvestmentIds];
  if (ids.length === 0) return [];
  // loadFlowRows reads (from, to]: every flow dated in [lo, hi).
  const flows = await loadFlowRows(db, ids, addDays(window.lo, -1), addDays(window.hi, -1));
  const descriptions = await flowDescriptions(db, flows);
  const dataDates = await firstDataDates(db, ids, ctx.fidelities);
  const records: BaselineContributionRecord[] = aggregateContributions(flows, descriptions, plannerInvestmentIds, dataDates, { from: window.from, to: window.to });
  const needFallback = records.filter((r) => r.annualNetCents === undefined || BigInt(r.annualNetCents) === 0n).map((r) => r.accountId);
  const planned = await plannedTransfers(db, needFallback);
  return records.map((r) => withRecurringFallback(r, planned.get(r.accountId) ?? 0n));
}

/** B4: the household targets as six weights, when the household has set any. */
function targetsOf(ctx: InvestmentContext): ClassWeights | undefined {
  if (ctx.targets.length === 0) return undefined;
  const w: ClassWeights = { us_stock: 0, intl_stock: 0, bonds: 0, cash: 0, real_estate: 0, other: 0 };
  for (const t of ctx.targets) w[t.assetClass] = t.targetBp;
  return w;
}

/**
 * The baseline on `today` (B1 to B9). Read-only. The result is a parsed `RetirementBaseline`
 * (strict, no floats, no nulls); `computedAt` is `now`. Accounts are in name then id order, the
 * contributions in account id order (`aggregateContributions`), the categories largest first.
 */
export async function computeBaseline(db: DbOrTx, q: ComputeBaselineQuery): Promise<RetirementBaseline> {
  // B1, B2: the investment views' context on their default as-of date (the latest close the feed can have).
  const ctx = await investmentContext(db, { today: q.today, now: q.now });
  const basis = holdingCostBasis(ctx);
  const accounts = [...ctx.accounts.map((a) => investmentAccount(ctx, a, basis)), ...(await bankAccounts(db, q.today))].sort(byNameThenId);

  const byBucket = Object.fromEntries(BUCKETS.map((b) => [b, 0n])) as Record<PlanBucket, bigint>;
  for (const a of accounts) if (a.bucket !== undefined && a.valueCents !== undefined) byBucket[a.bucket] += BigInt(a.valueCents);
  const total = BUCKETS.reduce((sum, b) => sum + byBucket[b], 0n);

  // B6, B7.
  const w = await ledgerWindow(db, q.today);
  const s = await spendingAndIncome(db, w.countedLo, w.hi, ctx.setting.investmentIncomeCategoryId);
  const uncat = await uncategorized(db, w.countedLo, w.hi);

  // B8: the investment accounts with a bucket.
  const plannerInvestmentIds = new Set(ctx.accounts.filter((a) => planBucketOf(a.type, a.taxTreatment).bucket !== undefined).map((a) => a.id));
  const contributions = await contributionsOf(db, ctx, plannerInvestmentIds, w);

  // B9: money that never reached the budget (payroll deferrals, employer money) is added back to income.
  let contributed = 0n;
  let payroll = 0n;
  for (const c of contributions) {
    contributed += BigInt(c.annualNetCents ?? "0");
    payroll += BigInt(c.annualUnpairedCents ?? "0");
  }
  const base = s.takeHome + payroll;

  const targets = targetsOf(ctx);
  return RetirementBaseline.parse({
    schemaVersion: 1,
    asOf: ctx.asOf,
    today: q.today,
    computedAt: q.now.toISOString(),
    window: { from: w.from, to: w.to, monthsWithData: w.monthsWithData },
    accounts,
    totals: { byBucket: Object.fromEntries(BUCKETS.map((b) => [b, byBucket[b].toString()])), totalCents: total.toString() },
    ...(targets === undefined ? {} : { allocationTargets: targets }),
    spending: { byCategory: s.byCategory, categorizedCents: s.categorized.toString(), billsCents: s.bills.toString(), uncategorized: uncat },
    income: { takeHomeCents: s.takeHome.toString(), investmentIncomeCents: s.investmentIncome.toString() },
    contributions,
    savingsRate: {
      ...(base > 0n ? { bp: Number(truncDiv(contributed * 10000n, base)) } : {}),
      contributionsCents: contributed.toString(),
      payrollCents: payroll.toString(),
      baseCents: base.toString(),
    },
  });
}

/**
 * What the `plan_baseline` audit row holds (inputs §6.2): the figures a person compares between two
 * refreshes, with no dates, so a baseline whose only change is its as-of date writes no audit row.
 */
export function baselineAuditJson(b: RetirementBaseline): Record<string, unknown> {
  return {
    byBucket: b.totals.byBucket,
    totalCents: b.totals.totalCents,
    categorizedCents: b.spending.categorizedCents,
    billsCents: b.spending.billsCents,
    uncategorizedOutflowCents: b.spending.uncategorized.outflowCents,
    takeHomeCents: b.income.takeHomeCents,
    contributionsCents: b.savingsRate.contributionsCents,
    ...(b.savingsRate.bp === undefined ? {} : { savingsRateBp: b.savingsRate.bp }),
    accountCount: b.accounts.length,
  };
}
