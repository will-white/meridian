import type {
  ExternalFlowKind,
  ExternalFlowSource,
  ExternalFlowView,
  FlowsSource,
  IncomeKind,
  IncomeMonthView,
  IndexPointView,
  InvestmentIncomeFeed,
  LinkStatus,
  PerformanceRequestBody,
  PeriodView,
  ReturnFigureView,
  ReturnMethod,
  SubPeriodView,
  XirrFigureView,
} from "@meridian/shared";
import { money, shortDate } from "./format.js";
import { formatBp, formatRate, type BadgeTone } from "./investments.js";

/**
 * Pure helpers for the Performance and Income pages: the return figures'
 * presentation (method, TWR, MWR, benchmark, flows provenance), the
 * growth-of-$10,000 chart's merged step series, the request body of the
 * "how this was computed" expander (POST /api/investments/performance with
 * `detail: full`), and the income page's monthly bars, link statuses and feed
 * labels. No React, no DOM; cents stay strings, the only floats are the
 * engine's rates, which are display-only.
 */

// ---- Returns ----

const METHOD_LABELS: Record<ReturnMethod, string> = { true_twr: "True TWR", modified_dietz: "Modified Dietz (approximate)" };

export function methodLabel(method: ReturnMethod | null): string {
  return method === null ? "—" : METHOD_LABELS[method];
}

export function methodTone(method: ReturnMethod | null): BadgeTone {
  return method === "true_twr" ? "ok" : method === "modified_dietz" ? "info" : "neutral";
}

export interface RateCell {
  /** "+8.62%", or "—" when the figure failed. */
  text: string;
  /** The second line: "+9.10% annualized", "not annualized (period under a year)", or null. */
  caption: string | null;
  /** The engine's reason, when the figure is null. */
  failed: boolean;
}

/** The time-weighted return: the period rate, with the annualized rate when the engine returned one (ranges ≥ 365 days). */
export function twrCell(figure: ReturnFigureView): RateCell {
  if (figure.rate === null) return { text: "—", caption: null, failed: true };
  return {
    text: formatRate(figure.rate, true),
    caption: figure.annualized === null ? "not annualized (period under a year)" : `${formatRate(figure.annualized, true)} annualized`,
    failed: false,
  };
}

/**
 * The money-weighted return: `period` for ranges under a year (XIRR is
 * annualized by definition and exaggerates short periods), `annualized`
 * otherwise.
 */
export function mwrCell(xirr: XirrFigureView, days: number): RateCell {
  if (xirr.annualized === null && xirr.period === null) return { text: "—", caption: null, failed: true };
  if (days < 365) {
    return { text: formatRate(xirr.period, true), caption: `over ${xirr.investedDays} days, not annualized (XIRR ${formatRate(xirr.annualized, true)} would exaggerate a short period)`, failed: false };
  }
  return { text: formatRate(xirr.annualized, true), caption: "annualized (XIRR)", failed: false };
}

/** "+1.20%" for the excess over the benchmark; "—" without both figures. */
export function excessText(excess: number | null): string {
  return formatRate(excess, true);
}

const FLOWS_SOURCE_LABELS: Record<FlowsSource, string> = {
  ledger: "flows from ledger",
  investment: "flows from trade history",
  mixed: "flows from ledger and trade history",
  none: "no flows seen",
};

export function flowsSourceLabel(source: FlowsSource): string {
  return FLOWS_SOURCE_LABELS[source];
}

const FLOW_KIND_LABELS: Record<ExternalFlowKind, string> = { cash: "cash", securities: "securities", opening_value: "opening value" };

export function flowKindLabel(kind: ExternalFlowKind): string {
  return FLOW_KIND_LABELS[kind];
}

const FLOW_SOURCE_LABELS: Record<ExternalFlowSource, string> = { ledger: "ledger", investment_txn: "trade history", engine: "engine" };

export function flowSourceLabel(source: ExternalFlowSource): string {
  return FLOW_SOURCE_LABELS[source];
}

export function internalReasonText(reason: ExternalFlowView["internalReason"]): string | null {
  switch (reason) {
    case "counterparty_in_total":
      return "both sides are in this total";
    case "before_first_valuation":
      return "before the first valuation";
    case null:
      return null;
  }
}

/** Where a flow can be inspected: the account's register on its date (ledger rows) or the account's investment activity (trade rows); nothing for the engine's opening values. */
export function flowLink(flow: Pick<ExternalFlowView, "source" | "accountId" | "date">): string | null {
  switch (flow.source) {
    case "ledger":
      return `/transactions?accountId=${flow.accountId}&from=${flow.date}&to=${flow.date}&transfers=only`;
    case "investment_txn":
      return `/investments/accounts/${flow.accountId}`;
    case "engine":
      return null;
  }
}

/** "entered at $1,000.00 on 01/31/26" when the account joined the selection after the period start. */
export function openingValueText(opening: { date: string; cents: string } | null): string | null {
  return opening === null ? null : `entered at ${money(opening.cents)} on ${shortDate(opening.date)}`;
}

/** The caption under a price-only benchmark (plan decision 10). */
export function benchmarkNote(adjusted: boolean): string | null {
  return adjusted ? null : "price return only; a dividend-paying benchmark is understated by its yield";
}

/** "carried from 10/09/26" markers for a sub-period whose boundary was not a valuation date. */
export function subPeriodFlags(sp: Pick<SubPeriodView, "skipped" | "beginCarried" | "endCarried" | "from" | "to">): string[] {
  const flags: string[] = [];
  if (sp.skipped) flags.push("skipped (no capital)");
  if (sp.beginCarried) flags.push(`begin carried to ${shortDate(sp.from)}`);
  if (sp.endCarried) flags.push(`end carried to ${shortDate(sp.to)}`);
  return flags;
}

/** The day count of a period view (0 without one). */
export function periodDays(period: PeriodView | null): number {
  return period?.days ?? 0;
}

// ---- Benchmark URL state ----

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `?benchmark=`: a security id overrides the household's benchmark, `none`
 * turns it off, absent (undefined) keeps the household default.
 */
export function benchmarkFromParams(params: URLSearchParams): string | null | undefined {
  const raw = params.get("benchmark");
  if (raw === null || raw === "") return undefined;
  if (raw === "none") return null;
  return UUID_RE.test(raw) ? raw : undefined;
}

// ---- The engine's detail request ----

/**
 * The body of the "how this was computed" call: the same window as the view
 * (`from` omitted for `all`, which is the engine's since-inception rule),
 * valued as of the period end, one account or the whole selection, with the
 * page's benchmark choice passed through (undefined = household default,
 * null = none) and full detail.
 */
export function detailRequestBody(input: {
  period: PeriodView | null;
  asOf: string;
  today: string;
  accountIds?: readonly string[];
  benchmarkSecurityId: string | null | undefined;
}): PerformanceRequestBody {
  const to = input.period?.to ?? input.asOf;
  const body: PerformanceRequestBody = { today: input.today, to, asOf: to, detail: "full" };
  if (input.period !== null && input.period.kind !== "all") body.from = input.period.from;
  if (input.accountIds !== undefined && input.accountIds.length > 0) body.accountIds = [...input.accountIds];
  if (input.benchmarkSecurityId !== undefined) body.benchmarkSecurityId = input.benchmarkSecurityId;
  return body;
}

// ---- Growth of $10,000 ----

export interface IndexLine {
  key: string;
  name: string;
  points: readonly IndexPointView[];
}

export interface MergedIndexSeries {
  dates: string[];
  /** One entry per line; `values[i]` is the dollars $10,000 had grown to by `dates[i]` (10 000 bp = $10,000), null before the line's first point. */
  lines: Array<{ key: string; name: string; values: Array<number | null> }>;
}

/**
 * Merge index series with different boundary dates onto one axis: the sorted
 * union of dates, each line carried forward as a step from its latest point
 * on or before the date (an index only changes at the engine's sub-period
 * boundaries) and null before its first point.
 */
export function mergeIndexSeries(lines: readonly IndexLine[]): MergedIndexSeries {
  const dateSet = new Set<string>();
  for (const l of lines) for (const p of l.points) dateSet.add(p.date);
  const dates = [...dateSet].sort();
  return {
    dates,
    lines: lines.map((l) => {
      const sorted = [...l.points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      let i = 0;
      let current: number | null = null;
      const values = dates.map((d) => {
        while (i < sorted.length && sorted[i]!.date <= d) {
          current = sorted[i]!.indexBp;
          i++;
        }
        return current;
      });
      return { key: l.key, name: l.name, values };
    }),
  };
}

/** "$10,000 → $10,862" from the last point of an index series; null without points. */
export function growthEndText(points: readonly IndexPointView[]): string | null {
  const last = points[points.length - 1];
  if (!last) return null;
  return `$10,000 → ${money(String(last.indexBp * 100))}`;
}

// ---- Income ----

const INCOME_KIND_LABELS: Record<IncomeKind, string> = { dividend: "Dividend", interest: "Interest" };

export function incomeKindLabel(kind: IncomeKind): string {
  return INCOME_KIND_LABELS[kind];
}

const LINK_STATUS_LABELS: Record<LinkStatus, string> = {
  linked: "linked",
  created: "created",
  awaiting: "awaiting bank row",
  not_fed: "not fed",
  ledger_only: "ledger only",
};

export function linkStatusLabel(status: LinkStatus): string {
  return LINK_STATUS_LABELS[status];
}

export function linkStatusTone(status: LinkStatus): BadgeTone {
  switch (status) {
    case "linked":
    case "created":
      return "ok";
    case "awaiting":
      return "warn";
    case "ledger_only":
      return "info";
    case "not_fed":
      return "neutral";
  }
}

const FEED_MODE_LABELS: Record<InvestmentIncomeFeed, string> = { off: "Off", link: "Link bank rows", create: "Create rows" };

export function feedModeLabel(mode: InvestmentIncomeFeed): string {
  return FEED_MODE_LABELS[mode];
}

const FEED_MODE_HELP: Record<InvestmentIncomeFeed, string> = {
  off: "dividends stay out of the spending plan",
  link: "the bank's own dividend rows are categorized as income",
  create: "Meridian adds an income row when the bank sends none",
};

export function feedModeHelp(mode: InvestmentIncomeFeed): string {
  return FEED_MODE_HELP[mode];
}

export const FEED_EXPLANATION =
  "Linked rows are the bank's own dividend transactions categorized as income; created rows are added by Meridian when the bank sends none. " +
  "Either way each dividend is counted once, the cash stays in the account (it is not a contribution), and reinvested dividends are never fed.";

/** "0.71% of current value"; null without a value to divide by. */
export function yieldText(yieldBp: number | null): string | null {
  return yieldBp === null ? null : `${formatBp(yieldBp, { places: 2 })} of current value`;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct" for a chart axis, "Jan 27" when the year changes from the previous month (or there is none). */
export function monthAxisLabel(month: string, previous: string | null): string {
  const name = MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month.slice(5, 7);
  const year = month.slice(2, 4);
  return previous === null || previous.slice(0, 4) !== month.slice(0, 4) ? `${name} ${year}` : name;
}

export interface IncomeBar {
  month: string;
  /** Dividends paid out in cash (dividends − reinvested). */
  cashDividendsCents: string;
  reinvestedCents: string;
  interestCents: string;
  totalCents: string;
  /** Heights in percent of the tallest month (truncated to two decimals); zero when the month is empty. */
  pct: { cashDividends: number; reinvested: number; interest: number };
}

function pctOf(part: bigint, max: bigint): number {
  if (max <= 0n || part <= 0n) return 0;
  return Number((part * 10000n) / max) / 100;
}

/**
 * The stacked monthly bars: cash dividends, reinvested dividends and interest
 * per month, scaled to the tallest month's total. A negative part (a
 * correction) draws as zero height but keeps its figure.
 */
export function incomeBars(months: ReadonlyArray<Pick<IncomeMonthView, "month" | "dividendsCents" | "interestCents" | "reinvestedCents" | "totalCents">>): { maxCents: string; bars: IncomeBar[] } {
  let max = 0n;
  const parts = months.map((m) => {
    const dividends = BigInt(m.dividendsCents);
    const reinvested = BigInt(m.reinvestedCents);
    const interest = BigInt(m.interestCents);
    const cash = dividends - reinvested;
    const total = BigInt(m.totalCents);
    if (total > max) max = total;
    return { m, cash, reinvested, interest, total };
  });
  return {
    maxCents: max.toString(),
    bars: parts.map(({ m, cash, reinvested, interest, total }) => ({
      month: m.month,
      cashDividendsCents: cash.toString(),
      reinvestedCents: reinvested.toString(),
      interestCents: interest.toString(),
      totalCents: total.toString(),
      pct: { cashDividends: pctOf(cash, max), reinvested: pctOf(reinvested, max), interest: pctOf(interest, max) },
    })),
  };
}

/** The empty state's sentence, naming the feed category when one is set. */
export function incomeEmptyText(categoryName: string | null): string {
  const tail = categoryName ? `bank rows categorized as ${categoryName}` : "bank rows categorized as the investment income category (set one in Settings)";
  return `No dividends or interest recorded. Dividends come from trade-history imports, manual trades, or ${tail}.`;
}
