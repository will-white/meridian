import { and, asc, eq, gt, gte, inArray, lte, ne, notExists, sql } from "drizzle-orm";
import {
  addDays,
  addMonthsClamped,
  dayDiff,
  expectedPriceDate,
  incomeByMonth,
  isInvestmentAccountType,
  monthKey,
  periodStart,
  truncDiv,
  type IncomeKind,
  type InvestmentFidelity,
  type InvestmentIncomeFeed,
  type InvestmentPeriod,
  type IsoDate,
  type LinkStatus,
  type MonthKey,
} from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { account, category, householdSetting, investmentTxn, security, transaction } from "../schema/index.js";
import { accountFidelities } from "./accountFidelity.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { enqueueJob } from "./jobs.js";
import { loadInvestmentTxns } from "./lots.js";
import { earliestDataDate, firstDataDates, listInvestmentAccounts, valueAccountsOn, type InvestmentAccountRecord } from "./valuation.js";

/**
 * Investment income (plan decision 13; views design §3.13; seams C25): the income view unions
 * the engine's dividend/interest rows with ledger rows in the household feed category that no
 * investment row is linked to (never double counting), and the per-account feed into the plan
 * (`link` categorizes the bank twin, `create` adds a synthetic `source = 'investment'` row for
 * accounts without a bank feed, an upgrade pass swaps the synthetic row for the bank's own row
 * when it arrives). Reinvested dividends are never fed. Fees and `reinvestedCents` come from
 * the engine's `incomeByMonth`.
 */

// ---- Period bounds and the default as-of date (views design §3.11, D21) ----

export interface PeriodBounds {
  kind: InvestmentPeriod;
  from: IsoDate;
  to: IsoDate;
  days: number;
  /** The period starts before the earliest data date. */
  partial: boolean;
  note: string | null;
}

/** The latest close the feed can have, never after today: the views' default `asOf`. */
export function defaultAsOf(today: IsoDate, now: Date): IsoDate {
  const expected = expectedPriceDate(now);
  return expected < today ? expected : today;
}

/**
 * `from`/`to` of a period preset ending at `asOf` (one `periodStart`); `custom` takes the given
 * `from` (and `to`, default `asOf`) and must satisfy `from < to ≤ today` (400 `validation`).
 * Null when `all` has no data or `custom` has no `from`. `partial` marks a start before the
 * earliest data date.
 */
export function periodBounds(kind: InvestmentPeriod, asOf: IsoDate, earliest: IsoDate | null, custom: { from?: IsoDate | null; to?: IsoDate | null; today?: IsoDate } = {}): PeriodBounds | null {
  let to = asOf;
  if (kind === "custom") {
    if (!custom.from) return null;
    to = custom.to ?? asOf;
    if (custom.today !== undefined && to > custom.today) throw new PlanError(400, "validation", `to ${to} is after today ${custom.today}`);
    if (custom.from >= to) throw new PlanError(400, "validation", `from ${custom.from} must be before to ${to}`);
  }
  const from = periodStart(kind, to, { earliest, from: custom.from ?? null });
  if (from === null) return null;
  const partial = earliest !== null && from < earliest;
  return { kind, from, to, days: dayDiff(from, to), partial, note: partial ? `Values begin ${earliest}; the period is shorter than requested` : null };
}

// ---- Rows ----

export interface IncomeRowRecord {
  id: string;
  date: IsoDate;
  month: MonthKey;
  accountId: string;
  accountName: string;
  securityId: string | null;
  ticker: string | null;
  kind: IncomeKind;
  cents: bigint;
  /** A dividend with a `reinvest` row for the same account, security and date. */
  reinvested: boolean;
  source: "investment_txn" | "ledger";
  ledgerTransactionId: string | null;
  linkStatus: LinkStatus;
  /** The linked ledger row carries the feed category (ledger-only rows are in it by definition). */
  fed: boolean;
}

export interface IncomeAccountInfo {
  id: string;
  name: string;
  investmentIncomeFeed: InvestmentIncomeFeed;
}

const INTEREST_SECURITY_TYPES = new Set(["cash", "cd", "bond"]);

function reinvestKey(accountId: string, securityId: string | null, date: IsoDate): string {
  return `${accountId}|${securityId ?? ""}|${date}`;
}

/** The `(account, security, date)` keys that carry a `reinvest` row (a reinvested dividend). */
async function loadReinvestKeys(db: DbOrTx, accountIds: readonly string[], from: IsoDate | null, to: IsoDate | null): Promise<Set<string>> {
  const rows = await db
    .select({ accountId: investmentTxn.accountId, securityId: investmentTxn.securityId, date: investmentTxn.date })
    .from(investmentTxn)
    .where(
      and(
        inArray(investmentTxn.accountId, [...accountIds]),
        eq(investmentTxn.type, "reinvest"),
        from ? gt(investmentTxn.date, from) : undefined,
        to ? lte(investmentTxn.date, to) : undefined,
      ),
    );
  return new Set(rows.map((r) => reinvestKey(r.accountId, r.securityId, r.date)));
}

function compareRows(a: IncomeRowRecord, b: IncomeRowRecord): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Income rows of `accounts` in `(from, to]` (views design §3.13): (a) `dividend` / `interest`
 * investment rows with their link state; (b) ledger rows in the feed category, posted, not
 * transfers, not synthetic and linked to no investment row. Sorted by (date, account, id).
 */
export async function loadIncomeRows(db: DbOrTx, accounts: readonly IncomeAccountInfo[], from: IsoDate, to: IsoDate, feedCategoryId: string | null): Promise<IncomeRowRecord[]> {
  const ids = accounts.map((a) => a.id);
  if (ids.length === 0 || to <= from) return [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const reinvested = await loadReinvestKeys(db, ids, from, to);

  const txnRows = await db
    .select({
      id: investmentTxn.id,
      accountId: investmentTxn.accountId,
      securityId: investmentTxn.securityId,
      date: investmentTxn.date,
      type: investmentTxn.type,
      amountCents: investmentTxn.amountCents,
      ledgerTransactionId: investmentTxn.ledgerTransactionId,
      ticker: security.ticker,
      securityType: security.type,
      ledgerSource: transaction.source,
      ledgerCategoryId: transaction.categoryId,
    })
    .from(investmentTxn)
    .leftJoin(security, eq(security.id, investmentTxn.securityId))
    .leftJoin(transaction, eq(transaction.id, investmentTxn.ledgerTransactionId))
    .where(and(inArray(investmentTxn.accountId, ids), inArray(investmentTxn.type, ["dividend", "interest"]), gt(investmentTxn.date, from), lte(investmentTxn.date, to)))
    .orderBy(asc(investmentTxn.date), asc(investmentTxn.sequence), asc(investmentTxn.id));

  const rows: IncomeRowRecord[] = txnRows.map((r) => {
    const acct = byId.get(r.accountId)!;
    const kind: IncomeKind = r.type === "interest" || (r.securityType !== null && INTEREST_SECURITY_TYPES.has(r.securityType)) ? "interest" : "dividend";
    let linkStatus: LinkStatus;
    if (r.ledgerTransactionId !== null && r.ledgerSource !== null) linkStatus = r.ledgerSource === "investment" ? "created" : "linked";
    else linkStatus = acct.investmentIncomeFeed === "off" ? "not_fed" : "awaiting";
    return {
      id: r.id,
      date: r.date,
      month: monthKey(r.date),
      accountId: r.accountId,
      accountName: acct.name,
      securityId: r.securityId,
      ticker: r.ticker,
      kind,
      cents: r.amountCents,
      reinvested: r.type === "dividend" && reinvested.has(reinvestKey(r.accountId, r.securityId, r.date)),
      source: "investment_txn",
      ledgerTransactionId: r.ledgerTransactionId,
      linkStatus,
      fed: r.ledgerTransactionId !== null && feedCategoryId !== null && r.ledgerCategoryId === feedCategoryId,
    };
  });

  if (feedCategoryId !== null) {
    const ledgerRows = await db
      .select({ id: transaction.id, accountId: transaction.accountId, date: transaction.date, amountCents: transaction.amountCents, description: transaction.rawDescription })
      .from(transaction)
      .where(
        and(
          inArray(transaction.accountId, ids),
          eq(transaction.categoryId, feedCategoryId),
          eq(transaction.isTransfer, false),
          eq(transaction.pending, false),
          ne(transaction.source, "investment"),
          gt(transaction.date, from),
          lte(transaction.date, to),
          notExists(db.select({ one: sql`1` }).from(investmentTxn).where(eq(investmentTxn.ledgerTransactionId, transaction.id))),
        ),
      );
    for (const r of ledgerRows) {
      rows.push({
        id: r.id,
        date: r.date,
        month: monthKey(r.date),
        accountId: r.accountId,
        accountName: byId.get(r.accountId)!.name,
        securityId: null,
        ticker: null,
        kind: /INTEREST/i.test(r.description) ? "interest" : "dividend",
        cents: r.amountCents,
        reinvested: false,
        source: "ledger",
        ledgerTransactionId: r.id,
        linkStatus: "ledger_only",
        fed: true,
      });
    }
  }
  return rows.sort(compareRows);
}

// ---- The view ----

export interface IncomeMonthRecord {
  month: MonthKey;
  dividendsCents: bigint;
  interestCents: bigint;
  feesCents: bigint;
  reinvestedCents: bigint;
  totalCents: bigint;
  bySecurity: Array<{ securityId: string | null; ticker: string | null; cents: bigint }>;
  byAccount: Array<{ accountId: string; cents: bigint }>;
}

export interface IncomeFeedAccountRecord {
  accountId: string;
  accountName: string;
  type: InvestmentAccountRecord["type"];
  taxTreatment: InvestmentAccountRecord["taxTreatment"];
  fidelity: InvestmentFidelity;
  fidelityNote: string | null;
  mode: InvestmentIncomeFeed;
  linked: number;
  created: number;
  awaiting: number;
  fed: number;
  hasLedger: boolean;
  suggestedMode: InvestmentIncomeFeed;
}

/** Bigint twin of `IncomeView`. */
export interface IncomeRecord {
  today: IsoDate;
  asOf: IsoDate;
  period: PeriodBounds | null;
  months: IncomeMonthRecord[];
  totals: { dividendsCents: bigint; interestCents: bigint; feesCents: bigint; reinvestedCents: bigint; totalCents: bigint };
  trailing12mCents: bigint;
  yieldBp: number | null;
  rows: IncomeRowRecord[];
  rowsTruncated: boolean;
  feed: { categoryId: string | null; categoryName: string | null; accounts: IncomeFeedAccountRecord[] };
  warnings: string[];
}

export interface IncomeQueryInput {
  today: IsoDate;
  now: Date;
  asOf?: IsoDate;
  /** Default `ytd`. */
  period?: InvestmentPeriod;
  from?: IsoDate;
  to?: IsoDate;
  accountId?: string;
  includeClosed?: boolean;
}

export const INCOME_ROW_CAP = 2000;

function bp(part: bigint, total: bigint): number | null {
  return total <= 0n ? null : Number(truncDiv(part * 10000n, total));
}

/** The household feed category (id and name), or nulls. */
export async function feedCategory(db: DbOrTx): Promise<{ id: string | null; name: string | null }> {
  const [row] = await db
    .select({ id: householdSetting.investmentIncomeCategoryId, name: category.name })
    .from(householdSetting)
    .leftJoin(category, eq(category.id, householdSetting.investmentIncomeCategoryId))
    .where(eq(householdSetting.id, 1));
  return { id: row?.id ?? null, name: row?.id ? (row.name ?? null) : null };
}

/** `GET /api/investments/income`: writes nothing. */
export async function getInvestmentIncome(db: DbOrTx, q: IncomeQueryInput): Promise<IncomeRecord> {
  const asOf = q.asOf ?? defaultAsOf(q.today, q.now);
  if (asOf > q.today) throw new PlanError(400, "validation", `asOf ${asOf} is after today ${q.today}`);
  const accounts = await listInvestmentAccounts(db, { ...(q.accountId ? { accountIds: [q.accountId] } : {}), ...(q.includeClosed ? { includeClosed: true } : {}) });
  const ids = accounts.map((a) => a.id);
  const fidelities = await accountFidelities(db, ids);
  const firsts = await firstDataDates(db, ids, fidelities);
  const period = periodBounds(q.period ?? "ytd", asOf, earliestDataDate(firsts), { from: q.from ?? null, to: q.to ?? null, today: q.today });
  const feed = await feedCategory(db);
  const warnings: string[] = [];

  const infos: IncomeAccountInfo[] = accounts.map((a) => ({ id: a.id, name: a.name, investmentIncomeFeed: a.investmentIncomeFeed }));
  const allRows = period ? await loadIncomeRows(db, infos, period.from, period.to, feed.id) : [];

  // Fees and reinvested amounts come from the engine's per-(month, security) rows.
  const months = new Map<MonthKey, IncomeMonthRecord & { securities: Map<string, { ticker: string | null; cents: bigint }>; accounts: Map<string, bigint> }>();
  const monthOf = (m: MonthKey) => {
    let row = months.get(m);
    if (!row) {
      row = { month: m, dividendsCents: 0n, interestCents: 0n, feesCents: 0n, reinvestedCents: 0n, totalCents: 0n, bySecurity: [], byAccount: [], securities: new Map(), accounts: new Map() };
      months.set(m, row);
    }
    return row;
  };
  if (period) {
    for (const a of accounts) {
      const txns = (await loadInvestmentTxns(db, a.id, { through: period.to })).filter((t) => t.date > period.from);
      for (const m of incomeByMonth(txns)) {
        if (m.feeCents === 0n && m.reinvestedCents === 0n) continue;
        const row = monthOf(m.month);
        row.feesCents += m.feeCents;
        row.reinvestedCents += m.reinvestedCents;
      }
    }
  }
  for (const r of allRows) {
    const row = monthOf(r.month);
    if (r.kind === "interest") row.interestCents += r.cents;
    else row.dividendsCents += r.cents;
    const secKey = r.securityId ?? "";
    const sec = row.securities.get(secKey) ?? { ticker: r.ticker, cents: 0n };
    sec.cents += r.cents;
    row.securities.set(secKey, sec);
    row.accounts.set(r.accountId, (row.accounts.get(r.accountId) ?? 0n) + r.cents);
  }
  const monthList: IncomeMonthRecord[] = [...months.values()]
    .sort((a, b) => (a.month < b.month ? -1 : 1))
    .map((m) => ({
      month: m.month,
      dividendsCents: m.dividendsCents,
      interestCents: m.interestCents,
      feesCents: m.feesCents,
      reinvestedCents: m.reinvestedCents,
      totalCents: m.dividendsCents + m.interestCents,
      bySecurity: [...m.securities.entries()]
        .map(([key, v]) => ({ securityId: key === "" ? null : key, ticker: v.ticker, cents: v.cents }))
        .sort((a, b) => (a.cents !== b.cents ? (a.cents > b.cents ? -1 : 1) : (a.securityId ?? "") < (b.securityId ?? "") ? -1 : 1)),
      byAccount: [...m.accounts.entries()].map(([accountId, cents]) => ({ accountId, cents })).sort((a, b) => (a.accountId < b.accountId ? -1 : 1)),
    }));
  const totals = monthList.reduce(
    (acc, m) => ({
      dividendsCents: acc.dividendsCents + m.dividendsCents,
      interestCents: acc.interestCents + m.interestCents,
      feesCents: acc.feesCents + m.feesCents,
      reinvestedCents: acc.reinvestedCents + m.reinvestedCents,
      totalCents: acc.totalCents + m.totalCents,
    }),
    { dividendsCents: 0n, interestCents: 0n, feesCents: 0n, reinvestedCents: 0n, totalCents: 0n },
  );

  // Trailing twelve months and the yield on the classified value as of `asOf`.
  const t12 = await loadIncomeRows(db, infos, addMonthsClamped(asOf, -12), asOf, feed.id);
  const trailing12mCents = t12.reduce((acc, r) => acc + r.cents, 0n);
  const valuations = await valueAccountsOn(db, { accountIds: ids, date: asOf, now: q.now, fidelities });
  let classified = 0n;
  for (const v of valuations) if ((v.basis === "snapshot" || v.basis === "lots" || v.basis === "positions") && v.valueCents !== null) classified += v.valueCents;
  const yieldBp = bp(trailing12mCents, classified);

  // Feed state per account over the period's rows.
  const ledgerAccounts = new Set(
    ids.length === 0 ? [] : (await db.selectDistinct({ accountId: transaction.accountId }).from(transaction).where(inArray(transaction.accountId, ids))).map((r) => r.accountId),
  );
  const feedAccounts: IncomeFeedAccountRecord[] = accounts.map((a) => {
    const f = fidelities.get(a.id);
    const mine = allRows.filter((r) => r.accountId === a.id && r.source === "investment_txn" && !r.reinvested);
    if (a.investmentIncomeFeed !== "off" && feed.id === null) warnings.push(`No investment income category is set; the feed for ${a.name} cannot run`);
    return {
      accountId: a.id,
      accountName: a.name,
      type: a.type,
      taxTreatment: a.taxTreatment,
      fidelity: f?.fidelity ?? "balance_only",
      fidelityNote: f?.fidelityNote ?? null,
      mode: a.investmentIncomeFeed,
      linked: mine.filter((r) => r.linkStatus === "linked").length,
      created: mine.filter((r) => r.linkStatus === "created").length,
      awaiting: mine.filter((r) => r.linkStatus === "awaiting").length,
      fed: mine.filter((r) => r.fed).length,
      hasLedger: ledgerAccounts.has(a.id),
      suggestedMode: ledgerAccounts.has(a.id) ? "link" : "create",
    };
  });

  return {
    today: q.today,
    asOf,
    period,
    months: monthList,
    totals,
    trailing12mCents,
    yieldBp,
    rows: allRows.slice(0, INCOME_ROW_CAP),
    rowsTruncated: allRows.length > INCOME_ROW_CAP,
    feed: { categoryId: feed.id, categoryName: feed.name, accounts: feedAccounts },
    warnings,
  };
}

// ---- The feed run (views design §3.13) ----

export interface IncomeFeedCounts {
  categorized: number;
  created: number;
  upgraded: number;
  awaiting: number;
  unchanged: number;
  deleted: number;
}

export interface RunIncomeFeedResult extends IncomeFeedCounts {
  /** Accounts with a feed that could not run (no household category). */
  skipped: Array<{ accountId: string; name: string; reason: "feed_category_required" }>;
}

function zeroCounts(): IncomeFeedCounts {
  return { categorized: 0, created: 0, upgraded: 0, awaiting: 0, unchanged: 0, deleted: 0 };
}

function addCounts(a: IncomeFeedCounts, b: IncomeFeedCounts): IncomeFeedCounts {
  return {
    categorized: a.categorized + b.categorized,
    created: a.created + b.created,
    upgraded: a.upgraded + b.upgraded,
    awaiting: a.awaiting + b.awaiting,
    unchanged: a.unchanged + b.unchanged,
    deleted: a.deleted + b.deleted,
  };
}

/** The days either side of an income row within which an equal-amount bank row is its twin (the imports linker's rule). */
export const FEED_TWIN_DAYS = 3;

/**
 * The bank row a synthetic row should give way to: same account, equal amount, within 3 days,
 * posted, not a transfer, not synthetic, linked to no investment row; nearest date, then the
 * earliest date, then id.
 */
async function findBankTwin(tx: DbOrTx, accountId: string, date: IsoDate, amountCents: bigint): Promise<{ id: string } | undefined> {
  const candidates = await tx
    .select({ id: transaction.id, date: transaction.date })
    .from(transaction)
    .where(
      and(
        eq(transaction.accountId, accountId),
        eq(transaction.amountCents, amountCents),
        gte(transaction.date, addDays(date, -FEED_TWIN_DAYS)),
        lte(transaction.date, addDays(date, FEED_TWIN_DAYS)),
        eq(transaction.isTransfer, false),
        eq(transaction.pending, false),
        ne(transaction.source, "investment"),
        notExists(tx.select({ one: sql`1` }).from(investmentTxn).where(eq(investmentTxn.ledgerTransactionId, transaction.id))),
      ),
    );
  let best: { id: string; date: IsoDate; distance: number } | undefined;
  for (const c of candidates) {
    const distance = Math.abs(dayDiff(c.date, date));
    if (!best || distance < best.distance || (distance === best.distance && (c.date < best.date || (c.date === best.date && c.id < best.id)))) {
      best = { id: c.id, date: c.date, distance };
    }
  }
  return best ? { id: best.id } : undefined;
}

/** One account's feed pass (the caller owns the transaction). */
export async function feedAccount(tx: DbOrTx, acct: { id: string; investmentIncomeFeed: InvestmentIncomeFeed }, feedCategoryId: string, now: Date = new Date()): Promise<IncomeFeedCounts> {
  const counts = zeroCounts();
  if (acct.investmentIncomeFeed === "off") return counts;
  const reinvested = await loadReinvestKeys(tx, [acct.id], null, null);
  const candidates = await tx
    .select({
      id: investmentTxn.id,
      securityId: investmentTxn.securityId,
      date: investmentTxn.date,
      type: investmentTxn.type,
      amountCents: investmentTxn.amountCents,
      ledgerTransactionId: investmentTxn.ledgerTransactionId,
      ticker: security.ticker,
      securityName: security.name,
      ledgerId: transaction.id,
      ledgerSource: transaction.source,
      ledgerCategoryId: transaction.categoryId,
      ledgerLocked: transaction.categoryLocked,
    })
    .from(investmentTxn)
    .leftJoin(security, eq(security.id, investmentTxn.securityId))
    .leftJoin(transaction, eq(transaction.id, investmentTxn.ledgerTransactionId))
    .where(and(eq(investmentTxn.accountId, acct.id), inArray(investmentTxn.type, ["dividend", "interest"])))
    .orderBy(asc(investmentTxn.date), asc(investmentTxn.sequence), asc(investmentTxn.id));

  for (const c of candidates) {
    if (c.type === "dividend" && reinvested.has(reinvestKey(acct.id, c.securityId, c.date))) continue;
    if (c.ledgerId !== null) {
      if (c.ledgerSource !== "investment") {
        // (a) Linked to a bank row: categorize it unless the owner locked a category.
        if (!c.ledgerLocked && c.ledgerCategoryId !== feedCategoryId) {
          await tx.update(transaction).set({ categoryId: feedCategoryId, updatedAt: now }).where(eq(transaction.id, c.ledgerId));
          counts.categorized++;
        } else counts.unchanged++;
        continue;
      }
      // (b) Linked to a synthetic row: the bank's own row replaces it when one has arrived.
      const twin = await findBankTwin(tx, acct.id, c.date, c.amountCents);
      if (twin) {
        await tx.update(investmentTxn).set({ ledgerTransactionId: twin.id, updatedAt: now }).where(eq(investmentTxn.id, c.id));
        await tx
          .update(transaction)
          .set(c.ledgerLocked ? { categoryId: c.ledgerCategoryId, categoryLocked: true, updatedAt: now } : { categoryId: feedCategoryId, categoryLocked: false, updatedAt: now })
          .where(eq(transaction.id, twin.id));
        await tx.delete(transaction).where(eq(transaction.id, c.ledgerId));
        counts.upgraded++;
      } else if (!c.ledgerLocked && c.ledgerCategoryId !== feedCategoryId) {
        await tx.update(transaction).set({ categoryId: feedCategoryId, updatedAt: now }).where(eq(transaction.id, c.ledgerId));
        counts.categorized++;
      } else counts.unchanged++;
      continue;
    }
    // (c) Unlinked.
    if (acct.investmentIncomeFeed !== "create") {
      counts.awaiting++;
      continue;
    }
    const externalId = `inv:${c.id}`;
    const description = `${c.type.toUpperCase()} ${c.ticker ?? c.securityName ?? ""}`.trim();
    const inserted = await tx
      .insert(transaction)
      .values({
        accountId: acct.id,
        externalId,
        source: "investment",
        date: c.date,
        amountCents: c.amountCents,
        rawDescription: description,
        categoryId: feedCategoryId,
        categoryLocked: false,
        pending: false,
        isTransfer: false,
      })
      .onConflictDoNothing({ target: [transaction.accountId, transaction.externalId] })
      .returning({ id: transaction.id });
    let syntheticId = inserted[0]?.id;
    if (!syntheticId) {
      const [existing] = await tx
        .select({ id: transaction.id })
        .from(transaction)
        .where(and(eq(transaction.accountId, acct.id), eq(transaction.externalId, externalId)));
      syntheticId = existing?.id;
    }
    if (!syntheticId) throw new Error(`feed: synthetic row for ${c.id} could not be written`);
    await tx.update(investmentTxn).set({ ledgerTransactionId: syntheticId, updatedAt: now }).where(eq(investmentTxn.id, c.id));
    counts.created++;
  }
  return counts;
}

/**
 * Run the feed for every account with `investment_income_feed ≠ off` (or the given ones), one
 * transaction per account so one bad account never rolls back the others. Idempotent: a second
 * run reports everything `unchanged`.
 */
export async function runInvestmentIncomeFeed(db: Db, opts: { accountIds?: readonly string[]; now?: Date } = {}): Promise<RunIncomeFeedResult> {
  const rows = await db
    .select({ id: account.id, name: account.name, type: account.type, investmentIncomeFeed: account.investmentIncomeFeed })
    .from(account)
    .where(and(ne(account.investmentIncomeFeed, "off"), opts.accountIds ? inArray(account.id, [...opts.accountIds]) : undefined))
    .orderBy(asc(account.name), asc(account.id));
  const accounts = rows.filter((r) => isInvestmentAccountType(r.type));
  let counts = zeroCounts();
  const skipped: RunIncomeFeedResult["skipped"] = [];
  if (accounts.length === 0) return { ...counts, skipped };
  const feed = await feedCategory(db);
  for (const a of accounts) {
    if (feed.id === null) {
      skipped.push({ accountId: a.id, name: a.name, reason: "feed_category_required" });
      continue;
    }
    const categoryId = feed.id;
    const result = await db.transaction((tx) => feedAccount(tx, a, categoryId, opts.now));
    counts = addCounts(counts, result);
  }
  return { ...counts, skipped };
}

/** Delete the account's unlocked synthetic rows (the links clear by `ON DELETE SET NULL`). */
async function deleteSyntheticRows(tx: DbOrTx, accountId: string): Promise<number> {
  const deleted = await tx
    .delete(transaction)
    .where(and(eq(transaction.accountId, accountId), eq(transaction.source, "investment"), eq(transaction.categoryLocked, false)))
    .returning({ id: transaction.id });
  return deleted.length;
}

export interface SetIncomeFeedResult {
  accountId: string;
  investmentIncomeFeed: InvestmentIncomeFeed;
  /** The inline run (modes `link` and `create`), else null. */
  run: IncomeFeedCounts | null;
  deleted: number;
  jobId: string | null;
}

/**
 * `PATCH /api/accounts/:id { investmentIncomeFeed }`: 400 `not_investment_account` for other
 * types, 400 `feed_category_required` when enabling without a household category; audited as
 * `account`; `off` deletes the account's unlocked synthetic rows; a non-off mode runs the
 * account inline and queues `investments.income_feed` (deduped).
 */
export async function setInvestmentIncomeFeed(db: Db, accountId: string, mode: InvestmentIncomeFeed, ctx: AuditContext & { now?: Date }): Promise<SetIncomeFeedResult> {
  const now = ctx.now ?? new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ id: account.id, name: account.name, type: account.type, investmentIncomeFeed: account.investmentIncomeFeed }).from(account).where(eq(account.id, accountId));
    if (!row) throw new PlanError(404, "not_found", "Account not found");
    if (mode !== "off" && !isInvestmentAccountType(row.type)) throw new PlanError(400, "not_investment_account", `${row.name} is a ${row.type} account`);
    const feed = mode === "off" ? { id: null } : await feedCategory(tx);
    if (mode !== "off" && feed.id === null) throw new PlanError(400, "feed_category_required", "Set the household's investment income category first");
    if (row.investmentIncomeFeed !== mode) {
      await tx.update(account).set({ investmentIncomeFeed: mode, updatedAt: now }).where(eq(account.id, accountId));
      await writeAudit(tx, {
        ...ctx,
        entity: "account",
        entityId: accountId,
        action: "update",
        before: { investmentIncomeFeed: row.investmentIncomeFeed },
        after: { investmentIncomeFeed: mode },
      });
    }
    let deleted = 0;
    let run: IncomeFeedCounts | null = null;
    let jobId: string | null = null;
    if (mode === "off") deleted = await deleteSyntheticRows(tx, accountId);
    else {
      run = await feedAccount(tx, { id: accountId, investmentIncomeFeed: mode }, feed.id!, now);
      jobId = (await enqueueJob(tx, "investments.income_feed", { reason: "setting", accountId, dedupeKey: "investments.income_feed" }, { dedupe: true })).id;
    }
    return { accountId, investmentIncomeFeed: mode, run, deleted, jobId };
  });
}
