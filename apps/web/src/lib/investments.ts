import { AssetClass, dayDiff, formatFixed8, isIsoDate, parseDecimalToCents, parseFixed8, roundDivHalfAway } from "@meridian/shared";
import type {
  AccountChangesView,
  AllocationTargetView,
  BasisSource,
  ChangeSummaryView,
  ConcentrationLevel,
  CostCoverage,
  HoldingPriceSource,
  InvestmentFidelity,
  InvestmentPeriod,
  LineKind,
  PortfolioAccountView,
  PortfolioView,
  PriceStatus,
  RebalanceTradeView,
  SecuritySplitView,
  SetSecurityAllocationBody,
  TaxTreatment,
  ValuationBasis,
  ValuationSource,
} from "@meridian/shared";
import { money, shortDate } from "./format.js";

/**
 * Pure helpers for the Investments pages (Portfolio, Allocation, Holdings):
 * formatting of basis points, ppm, quantities and change sentences; URL
 * period and as-of parameters; the targets and split editors' parsing; drift
 * and price-status tones. No React, no DOM; cents and quantities stay
 * strings or bigints, the only floats are display conversions.
 */

// ---- Asset classes and labels ----

/** The six classes in enum order; every chart and table keeps this order. */
export const ASSET_CLASSES: readonly AssetClass[] = AssetClass.options;

const CLASS_LABELS: Record<AssetClass, string> = {
  us_stock: "US stock",
  intl_stock: "International stock",
  bonds: "Bonds",
  cash: "Cash",
  real_estate: "Real estate",
  other: "Other",
};

export function assetClassLabel(c: AssetClass): string {
  return CLASS_LABELS[c];
}

const TAX_LABELS: Record<TaxTreatment, string> = { taxable: "Taxable", pre_tax: "Pre-tax", roth: "Roth", hsa: "HSA", none: "None" };

export function taxTreatmentLabel(t: TaxTreatment): string {
  return TAX_LABELS[t];
}

// ---- Numbers ----

const POW10 = [1, 10, 100];

/**
 * Basis points as a percentage: `formatBp(5970)` → "59.7%", `formatBp(80, { places: 2, sign: true })` → "+0.80%".
 * Integer math, rounding half away from zero at the shown precision; null → "—".
 */
export function formatBp(bp: number | null | undefined, opts: { places?: 0 | 1 | 2; sign?: boolean; suffix?: string } = {}): string {
  if (bp === null || bp === undefined) return "—";
  const places = opts.places ?? 1;
  const suffix = opts.suffix ?? "%";
  const divisor = POW10[2 - places]!;
  const units = Math.sign(bp) * Math.round(Math.abs(bp) / divisor);
  const abs = Math.abs(units);
  const scale = POW10[places]!;
  const whole = Math.trunc(abs / scale);
  const frac = places === 0 ? "" : `.${String(abs % scale).padStart(places, "0")}`;
  const sign = units < 0 ? "-" : opts.sign && units > 0 ? "+" : "";
  return `${sign}${whole}${frac}${suffix}`;
}

/** Drift in percentage points with its sign: "+9.7 pp", "-5.9 pp", "0.0 pp". */
export function formatPp(bp: number | null | undefined): string {
  return formatBp(bp, { places: 1, sign: true, suffix: " pp" });
}

/** Parts per million as a percentage with two places: 326 ppm → "0.03%". */
export function formatPpm(ppm: number | null | undefined): string {
  if (ppm === null || ppm === undefined) return "—";
  const hundredths = Math.sign(ppm) * Math.round(Math.abs(ppm) / 100);
  const abs = Math.abs(hundredths);
  return `${hundredths < 0 ? "-" : ""}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}%`;
}

/** An engine rate (a fraction) as a percentage with two places: 0.0862 → "8.62%". Display only. */
export function formatRate(rate: number | null | undefined, sign = false): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "—";
  const pct = rate * 100;
  const text = `${Math.abs(pct).toFixed(2)}%`;
  if (pct < 0 && text !== "0.00%") return `-${text}`;
  return sign && pct > 0 && text !== "0.00%" ? `+${text}` : text;
}

/**
 * A share quantity trimmed to at most `maxPlaces` decimals (rounded half away
 * from zero), trailing zeros dropped, thousands grouped: "1,250.5", "14.05".
 */
export function formatQuantity(quantity: string | null | undefined, maxPlaces = 8): string {
  if (quantity === null || quantity === undefined) return "—";
  let v = parseFixed8(quantity);
  const places = Math.max(0, Math.min(8, maxPlaces));
  if (places < 8) {
    const unit = 10n ** BigInt(8 - places);
    v = roundDivHalfAway(v, unit) * unit;
  }
  const text = formatFixed8(v);
  const negative = text.startsWith("-");
  const [whole, frac] = (negative ? text.slice(1) : text).split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

/** Cents with an explicit sign: "+$360.00", "-$12.00", "$0.00"; null → "—". */
export function signedMoney(cents: string | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const text = money(cents);
  return BigInt(cents) > 0n ? `+${text}` : text;
}

/** Tone for a signed amount or basis-point figure. */
export function changeTone(value: string | number | null | undefined): "pos" | "neg" | "" {
  if (value === null || value === undefined) return "";
  const n = typeof value === "number" ? value : Number(BigInt(value) > 0n) - Number(BigInt(value) < 0n);
  return n > 0 ? "pos" : n < 0 ? "neg" : "";
}

/** "54/36/10" for a blended fund's splits (whole percents, in the given order); null without splits. */
export function splitLabel(splits: readonly SecuritySplitView[]): string | null {
  if (splits.length === 0) return null;
  return splits.map((s) => String(Math.round(s.weightBp / 100))).join("/");
}

// ---- Fidelity, price status, tones ----

export type BadgeTone = "neutral" | "ok" | "warn" | "bad" | "info";

export function fidelityLabel(fidelity: InvestmentFidelity | null, positionsDate: string | null = null): string {
  switch (fidelity) {
    case "balance_only":
      return "Balance only";
    case "positions":
      return positionsDate ? `Positions as of ${shortDate(positionsDate)}` : "Positions";
    case "full_history":
      return "Full history";
    case null:
      return "Not an investment account";
  }
}

export function fidelityTone(fidelity: InvestmentFidelity | null): BadgeTone {
  switch (fidelity) {
    case "balance_only":
      return "neutral";
    case "positions":
      return "info";
    case "full_history":
      return "ok";
    case null:
      return "neutral";
  }
}

const PRICE_SOURCE_LABELS: Record<HoldingPriceSource, string> = { provider: "feed", implied: "implied", manual: "manual", statement: "statement", txn: "trade", cash: "cash" };

export function priceSourceLabel(source: HoldingPriceSource | null | undefined): string {
  return source ? PRICE_SOURCE_LABELS[source] : "unknown";
}

export interface PriceStatusInput {
  priceStatus: PriceStatus;
  priceDate: string | null;
  /** Null when the view does not carry the count (the Holdings rows). */
  tradingDaysBehind: number | null;
  priceSource?: HoldingPriceSource | null;
}

/** The chip's text: "as of 10/13/26 · feed", "stale 3 trading days (10/08/26)", "implied as of 09/30/26", "carried from statement". */
export function priceStatusText(p: PriceStatusInput): string {
  const date = p.priceDate ? shortDate(p.priceDate) : null;
  switch (p.priceStatus) {
    case "statement":
      return date ? `statement · ${date}` : "statement";
    case "current":
      return `as of ${date ?? "today"} · ${priceSourceLabel(p.priceSource ?? "provider")}`;
    case "stale": {
      const n = p.tradingDaysBehind;
      if (n === null || n <= 0) return `stale${date ? ` (${date})` : ""}`;
      return `stale ${n} trading day${n === 1 ? "" : "s"}${date ? ` (${date})` : ""}`;
    }
    case "implied":
      return date ? `implied as of ${date}` : "implied";
    case "manual":
      return date ? `manual · ${date}` : "manual";
    case "cash":
      return "cash";
    case "carried":
      return date ? `carried from ${date}` : "carried from statement";
    case "missing":
      return "no price";
  }
}

export function priceStatusTone(status: PriceStatus): BadgeTone {
  switch (status) {
    case "current":
      return "ok";
    case "statement":
    case "cash":
      return "neutral";
    case "implied":
    case "manual":
      return "info";
    case "stale":
    case "carried":
      return "warn";
    case "missing":
      return "bad";
  }
}

export function driftTone(cls: { driftBp: number | null; outOfBand: boolean }): BadgeTone {
  if (cls.driftBp === null) return "neutral";
  return cls.outOfBand ? "warn" : "ok";
}

export function concentrationTone(level: ConcentrationLevel): BadgeTone {
  return level;
}

/** The marker beside a cost basis: "partial", "from statement", both, or nothing. */
export function coverageLabel(coverage: CostCoverage, basisSource: BasisSource | null): string | null {
  const parts: string[] = [];
  if (coverage === "partial") parts.push("partial");
  if (basisSource === "statement") parts.push("from statement");
  return parts.length > 0 ? parts.join(" · ") : null;
}

const LINE_KIND_LABELS: Record<LineKind, string> = { position: "position", cash: "cash (reported)", cash_plug: "Cash (from balance)", carried_flows: "carried transfers" };

export function lineKindLabel(kind: LineKind): string {
  return LINE_KIND_LABELS[kind];
}

// ---- Sentences ----

const DAY_CHANGE_REASONS: Record<string, string> = {
  no_prices: "no prices for the held securities",
  balance_only: "balance only: no holdings to price",
  no_value: "no value on this date",
  missing_price: "a held security has no price for the day",
  missing_prior_price: "a held security has no price for the prior day",
};

export function dayChangeReasonText(reason: string | null): string {
  if (reason === null) return "";
  return DAY_CHANGE_REASONS[reason] ?? reason.replace(/_/g, " ");
}

const GROWTH_REASONS: Record<string, string> = {
  flows_not_in_value: "transfers since the last statement are not in the value (cash inference is off, or shares arrived in kind)",
};

export function growthReasonText(reason: string | null): string {
  if (reason === null) return "";
  return GROWTH_REASONS[reason] ?? reason.replace(/_/g, " ");
}

/** "+$360.00 (+0.80%) since 10/12/26"; with a reason when there is no figure. */
export function dayChangeSentence(d: { cents: string | null; bp?: number | null; prior: string | null; reason: string | null }): string {
  if (d.cents === null) return d.reason ? `— (${dayChangeReasonText(d.reason)})` : "—";
  const pct = d.bp === null || d.bp === undefined ? "" : ` (${formatBp(d.bp, { places: 2, sign: true })})`;
  const since = d.prior ? ` since ${shortDate(d.prior)}` : "";
  return `${signedMoney(d.cents)}${pct}${since}`;
}

/** "+$10,252.00: $5,000.00 added, $5,252.00 growth (incl. $324.35 income)". */
export function changeSentence(p: Pick<ChangeSummaryView, "from" | "changeCents" | "netFlowsCents" | "growthCents" | "growthReason" | "incomeCents">): string {
  if (p.changeCents === null) return `no value at ${shortDate(p.from)}`;
  const parts: string[] = [];
  const net = BigInt(p.netFlowsCents);
  if (net !== 0n) parts.push(`${money((net < 0n ? -net : net).toString())} ${net > 0n ? "added" : "withdrawn"}`);
  if (p.growthCents !== null) parts.push(`${money(p.growthCents)} growth`);
  else parts.push(`growth unknown${p.growthReason ? ` (${growthReasonText(p.growthReason)})` : ""}`);
  const income = BigInt(p.incomeCents) !== 0n ? ` (incl. ${money(p.incomeCents)} income)` : "";
  return `${signedMoney(p.changeCents)}: ${parts.join(", ")}${income}`;
}

/**
 * The period-change card's caption when the change left accounts out: "partial: Fidelity Roth
 * IRA had a value at the start but none at the end and was left out". Null when complete.
 */
export function periodChangePartialText(p: Pick<ChangeSummaryView, "partial" | "missingAccountIds">, nameOf: (accountId: string) => string | undefined): string | null {
  if (!p.partial || p.missingAccountIds.length === 0) return null;
  const names = p.missingAccountIds.map((id) => nameOf(id) ?? "an account");
  const n = names.length;
  return `partial: ${n === 1 ? names[0] : `${n} accounts (${names.join(", ")})`} had a value at the start but none at the end and ${n === 1 ? "was" : "were"} left out`;
}

/**
 * The expanded row of an account the chain cannot value yet (the Portfolio's "No values yet"
 * state, where the valuation summary is not even requested): why, in one line; the page adds
 * the links to import positions or add prices.
 */
export function noValueYetText(a: Pick<PortfolioAccountView, "accountName" | "positionsDate">): string {
  return a.positionsDate
    ? `${a.accountName} has positions as of ${shortDate(a.positionsDate)} but no price to value them with yet.`
    : `${a.accountName} has no positions, statement balance or prices on file yet.`;
}

/**
 * "sell $4,392.00 of VTI (~14.05 sh)", "buy $2,681.00 of VXUS or the plan's
 * equivalent international stock fund (~37.65 sh)", "keep $560.60 in cash",
 * "use $270.00 of cash". The server's `note` is shown separately.
 */
export function tradeSentence(t: Pick<RebalanceTradeView, "action" | "assetClass" | "ticker" | "inAccount" | "amountCents" | "approxQuantity">): string {
  const amount = money(t.amountCents);
  const qty = t.approxQuantity ? ` (~${formatQuantity(t.approxQuantity, 2)} sh)` : "";
  const classFund = `${assetClassLabel(t.assetClass).toLowerCase()} fund`;
  switch (t.action) {
    case "use_cash":
      return `use ${amount} of cash`;
    case "hold_cash":
      return `keep ${amount} in cash`;
    case "sell":
      return `sell ${amount} of ${t.ticker ?? `the ${classFund}`}${qty}`;
    case "buy": {
      if (t.ticker === null) return `buy ${amount} of a ${classFund} (new position)`;
      const which = t.inAccount ? t.ticker : `${t.ticker} or the plan's equivalent ${classFund}`;
      return `buy ${amount} of ${which}${qty}`;
    }
  }
}

export interface TradeGroup<T extends Pick<RebalanceTradeView, "accountId" | "accountName" | "taxTreatment">> {
  accountId: string;
  accountName: string;
  taxTreatment: TaxTreatment;
  trades: T[];
}

/** Trades grouped by account in the order the server generated them (account rank, sells then buys). */
export function groupTrades<T extends Pick<RebalanceTradeView, "accountId" | "accountName" | "taxTreatment">>(trades: readonly T[]): Array<TradeGroup<T>> {
  const groups: Array<TradeGroup<T>> = [];
  for (const t of trades) {
    const last = groups[groups.length - 1];
    if (last && last.accountId === t.accountId) last.trades.push(t);
    else groups.push({ accountId: t.accountId, accountName: t.accountName, taxTreatment: t.taxTreatment, trades: [t] });
  }
  return groups;
}

const VALUATION_SOURCE_LABELS: Record<ValuationSource, string> = { simplefin: "SimpleFIN", csv: "a CSV import", manual: "a statement", computed: "prices" };

/** How an account's value was obtained: "from SimpleFIN", "computed from prices (positions as of 10/09/26)". */
export function valuationDescription(a: { basis: ValuationBasis; valuationSource: ValuationSource | null; positionsDate: string | null }): string {
  const source = a.valuationSource ? VALUATION_SOURCE_LABELS[a.valuationSource] : "an unknown source";
  switch (a.basis) {
    case "snapshot":
      return `from ${source}`;
    case "lots":
      return "from trade history";
    case "positions":
      return `computed from prices${a.positionsDate ? ` (positions as of ${shortDate(a.positionsDate)})` : ""}`;
    case "balance":
      return `balance from ${source}`;
    case "none":
      return "no value yet";
  }
}

/** The line under a total: "Vanguard Brokerage from SimpleFIN, Fidelity Roth IRA computed from prices (positions as of 10/09/26)". */
export function asOfLine(accounts: readonly Pick<PortfolioAccountView, "accountName" | "basis" | "valuationSource" | "positionsDate">[]): string {
  return accounts.map((a) => `${a.accountName} ${valuationDescription(a)}`).join(", ");
}

// ---- URL parameters ----

export const PERIOD_CHOICES: ReadonlyArray<readonly [InvestmentPeriod, string]> = [
  ["1m", "1m"],
  ["3m", "3m"],
  ["6m", "6m"],
  ["ytd", "YTD"],
  ["1y", "1y"],
  ["3y", "3y"],
  ["5y", "5y"],
  ["all", "All"],
];

export function isInvestmentPeriod(s: string | null): s is InvestmentPeriod {
  return s !== null && (["1w", "1m", "3m", "6m", "ytd", "1y", "3y", "5y", "all", "custom"] as const).some((p) => p === s);
}

export interface PeriodParams {
  period: InvestmentPeriod;
  from?: string;
  to?: string;
}

/**
 * `?period=` with `?from=&to=` for `custom`; a custom period needs both dates
 * with `from < to ≤ today`, otherwise the default period applies.
 */
export function periodFromParams(params: URLSearchParams, today: string, fallback: InvestmentPeriod = "1y"): PeriodParams {
  const period = params.get("period");
  if (period === "custom") {
    const from = params.get("from");
    const to = params.get("to");
    if (from !== null && to !== null && isIsoDate(from) && isIsoDate(to) && from < to && to <= today) return { period: "custom", from, to };
    return { period: fallback };
  }
  return { period: isInvestmentPeriod(period) ? period : fallback };
}

/** `?asOf=`: a date on or before today, else null (the server picks the latest). */
export function asOfFromParams(params: URLSearchParams, today: string): string | null {
  const asOf = params.get("asOf");
  return asOf !== null && isIsoDate(asOf) && asOf <= today ? asOf : null;
}

/** The query-string fields for a period: `period`, plus `from`/`to` for custom. */
export function periodQuery(p: PeriodParams): { period: InvestmentPeriod; from?: string; to?: string } {
  return p.period === "custom" && p.from && p.to ? { period: "custom", from: p.from, to: p.to } : { period: p.period };
}

// ---- Value series ----

export type SeriesStep = "day" | "week" | "month";

/** Daily points up to 400 days, weekly to about four years, monthly beyond. */
export function autoSeriesStep(from: string, to: string): SeriesStep {
  const days = dayDiff(from, to);
  if (days <= 400) return "day";
  if (days <= 1500) return "week";
  return "month";
}

/** The chart range: the period's start (or 30 days back without one) through the as-of date. */
export function chartRange(asOf: string, period: { from: string } | null): { from: string; to: string } {
  const from = period?.from ?? shiftDays(asOf, -30);
  return { from: from < asOf ? from : shiftDays(asOf, -1), to: asOf };
}

function shiftDays(date: string, days: number): string {
  const ms = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

// ---- Allocation targets editor ----

export type TargetsForm = Record<AssetClass, string>;

/** A percent input ("50", "33.33", "0.5") to basis points; null when it is not a percent with at most two places in 0..100. */
export function percentToBp(raw: string): number | null {
  const s = raw.replace(/[%\s,]/g, "");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const bp = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return bp > 10000 ? null : bp;
}

/** Basis points as a percent input value with trailing zeros trimmed: 5000 → "50", 3333 → "33.33", 50 → "0.5". */
export function bpToPercentInput(bp: number | null): string {
  if (bp === null) return "";
  const whole = Math.trunc(bp / 100);
  const frac = String(bp % 100).padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/** The editor's starting values: the saved targets, or (without any) the current percentages as a starting point. */
export function targetsForm(classes: ReadonlyArray<{ assetClass: AssetClass; targetBp: number | null; currentBp: number | null }>, targetsSet: boolean): TargetsForm {
  const form = Object.fromEntries(ASSET_CLASSES.map((c) => [c, ""])) as TargetsForm;
  for (const cls of classes) {
    const bp = targetsSet ? cls.targetBp : cls.currentBp;
    form[cls.assetClass] = bp === null || bp === 0 ? "" : bpToPercentInput(bp);
  }
  return form;
}

/** Σ of the typed percentages in bp; null when any filled input is not a percent. */
export function targetsSumBp(form: TargetsForm): number | null {
  let sum = 0;
  for (const c of ASSET_CLASSES) {
    const raw = form[c].trim();
    if (raw === "") continue;
    const bp = percentToBp(raw);
    if (bp === null) return null;
    sum += bp;
  }
  return sum;
}

export type TargetsParse = { ok: true; targets: AllocationTargetView[] } | { ok: false; error: string };

/** Blank everywhere clears the targets; otherwise the filled classes must sum to exactly 100.00%. */
export function parseTargetsForm(form: TargetsForm): TargetsParse {
  const targets: AllocationTargetView[] = [];
  for (const c of ASSET_CLASSES) {
    const raw = form[c].trim();
    if (raw === "") continue;
    const bp = percentToBp(raw);
    if (bp === null) return { ok: false, error: `${assetClassLabel(c)}: enter a percentage from 0 to 100 with at most two decimals` };
    if (bp > 0) targets.push({ assetClass: c, targetBp: bp });
  }
  if (targets.length === 0) return { ok: true, targets: [] };
  const sum = targets.reduce((acc, t) => acc + t.targetBp, 0);
  if (sum !== 10000) return { ok: false, error: `Targets must add up to 100.00% (now ${formatBp(sum, { places: 2 })})` };
  return { ok: true, targets };
}

/** Basis points as percentage points with one decimal for the band input: 500 → "5.0". */
export function bpToPpInput(bp: number): string {
  const tenths = Math.round(bp / 10);
  return `${Math.trunc(tenths / 10)}.${tenths % 10}`;
}

/** A band input in percentage points ("5", "2.5") to basis points; null outside 0..50 or with more than one decimal. */
export function ppToBp(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d{1,2}(\.\d)?$/.test(s)) return null;
  const [whole, frac = "0"] = s.split(".");
  const bp = Number(whole) * 100 + Number(frac) * 10;
  return bp > 5000 ? null : bp;
}

/** A dollar input to a non-negative cents string; null when it is not an amount. */
export function dollarsToCents(raw: string): string | null {
  const s = raw.replace(/[$,\s]/g, "");
  if (s === "") return null;
  try {
    const cents = parseDecimalToCents(s);
    return cents < 0n ? null : cents.toString();
  } catch {
    return null;
  }
}

// ---- Security split editor ----

export interface SplitRowForm {
  assetClass: AssetClass;
  percent: string;
}

export type SplitsParse = { ok: true; body: SetSecurityAllocationBody } | { ok: false; error: string };

/** Split rows to the PUT body: blank rows are dropped; the rest must be distinct, sum to 100.00% and include the primary class. */
export function parseSplitsForm(primary: AssetClass, rows: readonly SplitRowForm[]): SplitsParse {
  const splits: Array<{ assetClass: AssetClass; weightBp: number }> = [];
  for (const row of rows) {
    const raw = row.percent.trim();
    if (raw === "") continue;
    const bp = percentToBp(raw);
    if (bp === null) return { ok: false, error: `${assetClassLabel(row.assetClass)}: enter a percentage from 0 to 100 with at most two decimals` };
    if (bp === 0) continue;
    if (splits.some((s) => s.assetClass === row.assetClass)) return { ok: false, error: `${assetClassLabel(row.assetClass)} appears twice` };
    splits.push({ assetClass: row.assetClass, weightBp: bp });
  }
  if (splits.length === 0) return { ok: true, body: { assetClass: primary, splits: null } };
  const sum = splits.reduce((acc, s) => acc + s.weightBp, 0);
  if (sum !== 10000) return { ok: false, error: `Splits must add up to 100.00% (now ${formatBp(sum, { places: 2 })})` };
  if (!splits.some((s) => s.assetClass === primary)) return { ok: false, error: `The primary class (${assetClassLabel(primary)}) must be one of the split classes` };
  return { ok: true, body: { assetClass: primary, splits } };
}

/** The editor's rows from a security's saved splits (one blank row when there are none). */
export function splitRows(splits: readonly SecuritySplitView[]): SplitRowForm[] {
  if (splits.length === 0) return [];
  return splits.map((s) => ({ assetClass: s.assetClass, percent: bpToPercentInput(s.weightBp) }));
}

// ---- Allocation bars ----

/** The scale of the paired bars: the widest current or target share, so the longest bar fills its track. */
export function barScaleBp(classes: ReadonlyArray<{ currentBp: number | null; targetBp: number | null }>): number {
  let max = 0;
  for (const c of classes) max = Math.max(max, c.currentBp ?? 0, c.targetBp ?? 0);
  return max > 0 ? max : 10000;
}

/** A bar's width in percent of its track. */
export function barWidth(bp: number | null, scaleBp: number): number {
  if (bp === null || bp <= 0) return 0;
  return Math.min(100, (bp / scaleBp) * 100);
}

// ---- Why did it change (views design §3.9) ----

export interface ChangeWindow {
  from: string;
  to: string;
}

/**
 * The windows a Portfolio row's "why?" can explain through
 * `GET /investments/accounts/:id/changes`: the day (the prior close the day
 * change was measured from, to the as-of date) and the row's period. Null
 * when a window is unknown or empty (`from < to` is the route's rule).
 */
export function changeWindows(portfolio: Pick<PortfolioView, "asOf" | "dayChange">, account: Pick<PortfolioAccountView, "period">): { day: ChangeWindow | null; period: ChangeWindow | null } {
  const prior = portfolio.dayChange.prior;
  const asOf = portfolio.asOf;
  const day = prior !== null && asOf !== null && prior < asOf ? { from: prior, to: asOf } : null;
  const period = account.period !== null && account.period.from < account.period.to ? { from: account.period.from, to: account.period.to } : null;
  return { day, period };
}

export interface AttributionTotals {
  priceEffectCents: bigint;
  quantityEffectCents: bigint;
  residualEffectCents: bigint;
  totalCents: bigint;
  /** Σ holdings' effects + the residual equals the summary's change exactly (false flags a server bug). */
  balanced: boolean;
}

/** The attribution's footer: Σ price effects, Σ quantity effects, the "cash & other" residual and their total against the change. */
export function attributionTotals(v: Pick<AccountChangesView, "holdings" | "residualEffectCents" | "summary">): AttributionTotals {
  let price = 0n;
  let quantity = 0n;
  for (const h of v.holdings) {
    price += BigInt(h.priceEffectCents);
    quantity += BigInt(h.quantityEffectCents);
  }
  const residual = BigInt(v.residualEffectCents);
  const total = price + quantity + residual;
  const change = v.summary.changeCents === null ? null : BigInt(v.summary.changeCents);
  return { priceEffectCents: price, quantityEffectCents: quantity, residualEffectCents: residual, totalCents: total, balanced: change === null || change === total };
}

/** A balance-only account has no holdings to attribute: "market or unknown: +$310.00" (growth = change − flows), or "—" without a start value. */
export function marketOrUnknownText(summary: Pick<ChangeSummaryView, "growthCents">): string {
  return `market or unknown: ${summary.growthCents === null ? "—" : signedMoney(summary.growthCents)}`;
}

/** "100 → 120", one value when unchanged, "—" for an absent side. */
export function fromToText(from: string | null, to: string | null, format: (v: string) => string): string {
  if (from === to) return from === null ? "—" : format(from);
  return `${from === null ? "—" : format(from)} → ${to === null ? "—" : format(to)}`;
}
