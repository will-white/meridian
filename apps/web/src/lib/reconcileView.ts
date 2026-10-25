import { addMonths, formatCents, formatFixed8, isCashKey, monthEnd, monthKey, mulToCents, parseCsv, parseFixed8, parseLooseDecimal } from "@meridian/shared";
import type {
  CashInference,
  CashInferenceHintView,
  LineValuationView,
  PriceFetchStatus,
  PriceRunView,
  PriceSource,
  PriceStatus,
  PriceView,
  ReconcileCommitResponse,
  ReconcilePreviewResponse,
  ReconcileRowBody,
  ReconcileRowStatus,
  ReconciliationView,
  SecurityPriceStatusView,
} from "@meridian/shared";
import { money, shortDate } from "./format.js";
import type { BadgeTone } from "./investments.js";

/**
 * Pure helpers for the prices area's two pages. Reconcile: the statement
 * rows form (prefill from the app's lines, paste from CSV, validation to the
 * POST /api/reconcile/preview body), the per-row statuses, the headline and
 * both cash-inference readings. Prices: row severity for the status table,
 * the run and schedule sentences, refresh results and manual price parsing.
 * No React, no DOM; cents and quantities stay strings or bigints.
 */

// ---- Reconcile: the rows form ----

export interface ReconcileRowForm {
  key: string;
  /** Known security (prefilled from the app); a typed ticker otherwise. */
  securityId: string | null;
  ticker: string;
  isCash: boolean;
  /** Shares, or dollars for the cash row. */
  quantity: string;
  price: string;
  /** Dollars. */
  value: string;
}

let rowSeq = 0;

export function newRowKey(): string {
  rowSeq += 1;
  return `r${rowSeq}`;
}

export function emptyRow(): ReconcileRowForm {
  return { key: newRowKey(), securityId: null, ticker: "", isCash: false, quantity: "", price: "", value: "" };
}

function isBlank(row: ReconcileRowForm): boolean {
  return row.ticker.trim() === "" && row.quantity.trim() === "" && row.price.trim() === "" && row.value.trim() === "" && !row.isCash;
}

/**
 * "Prefill from app": the app's positions on the date as statement rows, the
 * cash-kind lines (reported cash, the balance plug, carried transfers) summed
 * into one cash row; dollar-only positions carry a zero quantity and their
 * value. Unpriced lines keep their quantity with an empty value.
 */
export function rowsFromLines(lines: readonly LineValuationView[]): ReconcileRowForm[] {
  const rows: ReconcileRowForm[] = [];
  let cash = 0n;
  let anyCash = false;
  for (const l of lines) {
    if (l.kind !== "position") {
      anyCash = true;
      cash += l.valueCents === null ? 0n : BigInt(l.valueCents);
      continue;
    }
    rows.push({
      key: newRowKey(),
      securityId: l.securityId,
      ticker: l.ticker ?? l.name,
      isCash: false,
      quantity: l.quantity ?? "0",
      price: l.price ?? "",
      value: l.valueCents === null ? "" : formatCents(BigInt(l.valueCents)),
    });
  }
  if (anyCash) rows.push({ key: newRowKey(), securityId: null, ticker: "Cash", isCash: true, quantity: formatCents(cash), price: "", value: "" });
  return rows;
}

const NUMERIC_CELL = /^[\s($€£-]*[\d,]*\.?\d+[\s)%-]*$/;

/**
 * Pasted statement rows as cells: a spreadsheet paste is tab-separated (its
 * numbers may carry thousands separators, which `parseLooseDecimal` strips
 * later), so any tab means lines split on newlines and cells on tabs; a
 * comma file goes through the CSV parser (quoted cells).
 */
function pastedRecords(text: string): string[][] {
  if (!text.includes("\t")) return parseCsv(text);
  return text.split(/\r\n|\r|\n/).map((line) => line.split("\t"));
}

/**
 * "Paste from CSV": symbol, quantity, price, value in that order (three
 * columns: symbol, quantity, price; two: symbol, quantity). A first row
 * whose second cell is not a number is a header and is skipped; a symbol
 * that is a cash key (Cash, USD) becomes the cash row with the last numeric
 * cell as its dollars.
 */
export function parsePastedRows(text: string): ReconcileRowForm[] {
  const out: ReconcileRowForm[] = [];
  const records = pastedRecords(text);
  records.forEach((cells, i) => {
    const c = cells.map((v) => v.trim());
    if (c.every((v) => v === "")) return;
    const symbol = c[0] ?? "";
    if (symbol === "") return;
    if (i === 0 && c.length > 1 && !NUMERIC_CELL.test(c[1] ?? "")) return;
    if (isCashKey({ ticker: symbol, name: symbol })) {
      const dollars = [...c.slice(1)].reverse().find((v) => NUMERIC_CELL.test(v)) ?? "";
      out.push({ key: newRowKey(), securityId: null, ticker: "Cash", isCash: true, quantity: dollars, price: "", value: "" });
      return;
    }
    out.push({
      key: newRowKey(),
      securityId: null,
      ticker: symbol,
      isCash: false,
      quantity: c[1] ?? "",
      price: c.length >= 3 ? (c[2] ?? "") : "",
      value: c.length >= 4 ? (c[3] ?? "") : "",
    });
  });
  return out;
}

/** A dollars input ("1,234.56", "$12") to cents; null when it is not an amount with at most two places. */
export function dollarsInputToCents(raw: string): bigint | null {
  const v = parseLooseDecimal(raw);
  if (v === undefined) return null;
  if (v % 1_000_000n !== 0n) return null;
  return v / 1_000_000n;
}

/** A quantity or price input to a canonical Fixed8 string; null when unreadable. */
export function fixed8Input(raw: string): string | null {
  const v = parseLooseDecimal(raw);
  return v === undefined ? null : formatFixed8(v);
}

export type RowsParse =
  | { ok: true; rows: ReconcileRowBody[]; sumCents: bigint; count: number }
  | { ok: false; errors: Record<string, string> };

/**
 * The form to the preview body: blank rows are dropped; a security row needs
 * a ticker (or a known id), a quantity, and a value or a price ("give a value
 * or a price"); the cash row needs its dollars, which become both its
 * quantity (dollars) and its value. `sumCents` is Σ values (price × quantity
 * when no value was typed), the default statement total.
 */
export function parseReconcileRows(rows: readonly ReconcileRowForm[]): RowsParse {
  const errors: Record<string, string> = {};
  const out: ReconcileRowBody[] = [];
  let sum = 0n;
  for (const row of rows) {
    if (isBlank(row)) continue;
    if (row.isCash) {
      const cents = dollarsInputToCents(row.quantity);
      if (cents === null) {
        errors[row.key] = "enter the cash balance in dollars";
        continue;
      }
      out.push({ isCash: true, quantity: formatCents(cents), valueCents: cents.toString() });
      sum += cents;
      continue;
    }
    if (row.securityId === null && row.ticker.trim() === "") {
      errors[row.key] = "enter a ticker";
      continue;
    }
    const quantity = fixed8Input(row.quantity);
    if (quantity === null) {
      errors[row.key] = "enter the share quantity";
      continue;
    }
    const price = row.price.trim() === "" ? null : fixed8Input(row.price);
    if (row.price.trim() !== "" && price === null) {
      errors[row.key] = "the price is not a number";
      continue;
    }
    const value = row.value.trim() === "" ? null : dollarsInputToCents(row.value);
    if (row.value.trim() !== "" && value === null) {
      errors[row.key] = "the value is not a dollar amount";
      continue;
    }
    if (price === null && value === null) {
      errors[row.key] = "give a value or a price";
      continue;
    }
    const body: ReconcileRowBody = { isCash: false, quantity };
    if (row.securityId !== null) body.securityId = row.securityId;
    else body.ticker = row.ticker.trim();
    if (price !== null) body.price = price;
    if (value !== null) body.valueCents = value.toString();
    out.push(body);
    sum += value ?? mulToCents(parseFixed8(quantity), parseFixed8(price!));
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, rows: out, sumCents: sum, count: out.length };
}

/**
 * Why Accept and Record only must wait: a row that does not parse, a typed
 * total that is not a dollar amount, or nothing entered at all. With no rows
 * and no total the server's statement total is Σ[] = $0.00, and accepting
 * would write an empty manual snapshot and a $0 balance for the date,
 * outranking SimpleFIN and CSV. Null when the commit may run.
 */
export function commitBlockText(parsed: RowsParse, statementTotal: string): string | null {
  if (!parsed.ok) return "Fix the rows above before accepting or recording.";
  const typed = statementTotal.trim() !== "";
  if (typed && dollarsInputToCents(statementTotal) === null) return "The statement total is not a dollar amount.";
  if (parsed.count === 0 && !typed) return "Enter the statement's rows or its total before accepting or recording.";
  return null;
}

/** The last day of the previous month: the default statement date. */
export function defaultStatementDate(today: string): string {
  return monthEnd(addMonths(monthKey(today), -1));
}

// ---- Reconcile: the preview ----

const ROW_STATUS_LABELS: Record<ReconcileRowStatus, string> = {
  match: "Match",
  quantity: "Quantity",
  price: "Price",
  value: "Value",
  cash: "Cash",
  missing_in_app: "Missing in app",
  missing_in_statement: "Missing in statement",
  unknown_ticker: "Unknown ticker",
};

export function rowStatusLabel(status: ReconcileRowStatus): string {
  return ROW_STATUS_LABELS[status];
}

export function rowStatusTone(status: ReconcileRowStatus): BadgeTone {
  switch (status) {
    case "match":
      return "ok";
    case "quantity":
    case "price":
    case "value":
    case "cash":
      return "warn";
    case "missing_in_app":
    case "missing_in_statement":
    case "unknown_ticker":
      return "bad";
  }
}

export interface Headline {
  text: string;
  tone: BadgeTone;
}

/**
 * The large line over the preview: a difference of 0 is "exact"; within the
 * tolerance "to the dollar" (plan decision 14); otherwise "Off by $X" with the
 * sign spelled out (app above or below the statement).
 */
export function differenceHeadline(differenceCents: string | null, matchesToDollar: boolean): Headline {
  if (differenceCents === null) return { text: "No app value on this date", tone: "neutral" };
  const diff = BigInt(differenceCents);
  if (diff === 0n) return { text: "Matches the statement exactly", tone: "ok" };
  const abs = (diff < 0n ? -diff : diff).toString();
  const side = diff > 0n ? "app above the statement" : "app below the statement";
  if (matchesToDollar) return { text: `Matches to the dollar (${money(abs)} ${side})`, tone: "ok" };
  return { text: `Off by ${money(abs)} (${side})`, tone: "warn" };
}

export interface CashInferenceReading {
  setting: CashInference;
  valueCents: string | null;
  differenceCents: string | null;
  reconciles: boolean;
  note: string;
}

export interface CashInferenceReadings {
  current: CashInferenceReading;
  /** What the other setting would show; null when it would not change the value. */
  alternative: CashInferenceReading | null;
}

function cashKindSum(lines: readonly LineValuationView[], kind: LineValuationView["kind"]): bigint {
  return lines.filter((l) => l.kind === kind).reduce((acc, l) => acc + (l.valueCents === null ? 0n : BigInt(l.valueCents)), 0n);
}

/**
 * Both readings of the account's value (plan decision 8): the setting in
 * force, and what the other setting would give. For an `off` account the
 * server's hint carries the plug and the carried transfers `auto` would add;
 * for an `auto` account the `cash_plug` and `carried_flows` lines are what
 * `off` would drop.
 */
export function cashInferenceReadings(preview: Pick<ReconcilePreviewResponse, "app" | "statementTotalCents" | "differenceCents" | "matchesToDollar" | "toleranceCents" | "cashInferenceHint">): CashInferenceReadings {
  const total = BigInt(preview.statementTotalCents);
  const tolerance = BigInt(preview.toleranceCents);
  const current: CashInferenceReading = {
    setting: preview.app.cashInference,
    valueCents: preview.app.valueCents,
    differenceCents: preview.differenceCents,
    reconciles: preview.matchesToDollar,
    note: preview.app.cashInference === "auto" ? "cash inferred from the balance (current setting)" : "no inferred cash (current setting)",
  };
  if (preview.app.cashInference === "off") {
    const hint = preview.cashInferenceHint;
    if (hint === null) return { current, alternative: null };
    const plug = BigInt(hint.plugCents);
    const flows = BigInt(hint.flowsSinceSnapshotCents);
    const value = preview.app.valueCents === null ? null : BigInt(preview.app.valueCents) + plug + flows;
    return {
      current,
      alternative: {
        setting: "auto",
        valueCents: value === null ? null : value.toString(),
        differenceCents: value === null ? null : (value - total).toString(),
        reconciles: hint.wouldReconcile,
        note: `would add ${money(flows.toString())} of transfers since the last statement and a ${money(plug.toString())} balance plug`,
      },
    };
  }
  const plug = cashKindSum(preview.app.lines, "cash_plug");
  const carried = cashKindSum(preview.app.lines, "carried_flows");
  if (plug === 0n && carried === 0n) return { current, alternative: null };
  const value = preview.app.valueCents === null ? null : BigInt(preview.app.valueCents) - plug - carried;
  const diff = value === null ? null : value - total;
  return {
    current,
    alternative: {
      setting: "off",
      valueCents: value === null ? null : value.toString(),
      differenceCents: diff === null ? null : diff.toString(),
      reconciles: diff !== null && (diff < 0n ? -diff : diff) < tolerance,
      note: `would drop the ${money(plug.toString())} balance plug and ${money(carried.toString())} of carried transfers`,
    },
  };
}

/** The callout for an `off` account: "Transfers into this account since the 09/30/26 statement total $1,000.00; turning on Infer cash from balance would reconcile". */
export function cashInferenceHintText(hint: CashInferenceHintView, snapshotDate: string | null): string {
  const since = snapshotDate ? `since the ${shortDate(snapshotDate)} statement` : "since the last statement";
  const flows = BigInt(hint.flowsSinceSnapshotCents);
  const plug = BigInt(hint.plugCents);
  const parts: string[] = [];
  if (flows !== 0n) parts.push(`Transfers into this account ${since} total ${money(flows.toString())}`);
  if (plug !== 0n) parts.push(`${parts.length === 0 ? "The" : "the"} balance implies ${money(plug.toString())} of cash the positions list omits`);
  const lead = parts.length > 0 ? parts.join("; ") : `Inferring cash from the balance would change the value`;
  return `${lead}; turning on Infer cash from balance would ${hint.wouldReconcile ? "reconcile" : "not reconcile"}.`;
}

/** "Reconciled 10/13/26: app value now $58,076.69; pre-commit difference $0.00" (or "Recorded …" when not accepted). */
export function commitResultText(result: Pick<ReconcileCommitResponse, "accepted" | "preCommitDifferenceCents" | "matchesToDollar" | "app">, date: string): string {
  const lead = result.accepted ? `Reconciled ${shortDate(date)}` : `Recorded ${shortDate(date)} without accepting the statement`;
  const diff = result.preCommitDifferenceCents === null ? "no app value before the commit" : `pre-commit difference ${money(result.preCommitDifferenceCents)}${result.matchesToDollar ? "" : " (not to the dollar)"}`;
  return `${lead}: app value now ${money(result.app.valueCents)}; ${diff}.`;
}

/** "exact" / "to the dollar" / "off by $1.00" / "no app value" for a stored record. */
export function recordOutcome(r: Pick<ReconciliationView, "differenceCents" | "reconciled">): { text: string; tone: BadgeTone } {
  if (r.differenceCents === null) return { text: "no app value", tone: "neutral" };
  const diff = BigInt(r.differenceCents);
  if (diff === 0n) return { text: "exact", tone: "ok" };
  if (r.reconciled) return { text: "to the dollar", tone: "ok" };
  return { text: `off by ${money((diff < 0n ? -diff : diff).toString())}`, tone: "warn" };
}

/** Σ row diffs leaves `unexplainedCents`; a non-zero remainder is worth a sentence. */
export function unexplainedText(unexplainedCents: string | null): string | null {
  if (unexplainedCents === null || BigInt(unexplainedCents) === 0n) return null;
  return `${money(unexplainedCents)} of the difference is not explained by any row (cash the statement lists elsewhere, or rounding).`;
}

// ---- Prices: the status table ----

const STATUS_RANK: Record<PriceStatus, number> = { missing: 1, stale: 2, carried: 3, implied: 4, manual: 5, statement: 6, current: 7, cash: 8 };

/** Lower sorts first: fetch failures, then missing, stale, carried, implied, manual, statement, current, cash. */
export function priceRowSeverity(row: Pick<SecurityPriceStatusView, "priceStatus" | "fetchStatus" | "priceMode">): number {
  if (row.priceMode === "provider" && (row.fetchStatus === "error" || row.fetchStatus === "not_found" || row.fetchStatus === "rate_limited")) return 0;
  return STATUS_RANK[row.priceStatus];
}

export function sortPriceRows<T extends Pick<SecurityPriceStatusView, "priceStatus" | "fetchStatus" | "priceMode" | "ticker" | "name">>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const d = priceRowSeverity(a) - priceRowSeverity(b);
    if (d !== 0) return d;
    const ka = (a.ticker ?? a.name).toUpperCase();
    const kb = (b.ticker ?? b.name).toUpperCase();
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

const FETCH_STATUS_LABELS: Record<PriceFetchStatus, string> = { ok: "ok", not_found: "not found", error: "error", rate_limited: "rate limited" };

export function fetchStatusLabel(status: PriceFetchStatus | null): string {
  return status === null ? "never fetched" : FETCH_STATUS_LABELS[status];
}

export function fetchStatusTone(status: PriceFetchStatus | null): BadgeTone {
  switch (status) {
    case "ok":
      return "ok";
    case "not_found":
    case "error":
      return "bad";
    case "rate_limited":
      return "warn";
    case null:
      return "neutral";
  }
}

const PRICE_MODE_LABELS: Record<PriceSource, string> = { provider: "Provider", implied: "Implied", manual: "Manual" };

export function priceModeLabel(mode: PriceSource): string {
  return PRICE_MODE_LABELS[mode];
}

/** "6 pm", "6 am", "12 pm", "12 am". */
export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${h < 12 ? "am" : "pm"}`;
}

/** "nightly at 6 pm household time (America/New_York), catch-up at 6 am". */
export function scheduleText(fetchHour: number, catchupHour: number | null, timezone: string): string {
  const catchup = catchupHour === null ? "" : `, catch-up at ${hourLabel(catchupHour)}`;
  return `nightly at ${hourLabel(fetchHour)} household time (${timezone})${catchup}`;
}

/** A clock time in the household's timezone: "6:03 pm". Falls back to the ISO time when the zone is unknown. */
export function clockIn(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone }).format(new Date(iso)).toLowerCase();
  } catch {
    return iso.slice(11, 16);
  }
}

const STAT_LABELS: ReadonlyArray<readonly [string, (n: number) => string]> = [
  ["requests", (n) => `${n} request${n === 1 ? "" : "s"}`],
  ["securities", (n) => `${n} securit${n === 1 ? "y" : "ies"}`],
  ["rowsInserted", (n) => `${n} new row${n === 1 ? "" : "s"}`],
  ["rowsUpdated", (n) => `${n} updated`],
  ["notFound", (n) => `${n} not found`],
  ["errors", (n) => `${n} error${n === 1 ? "" : "s"}`],
  ["rateLimited", (n) => `${n} rate limited`],
  ["suspect", (n) => `${n} suspect`],
  ["deferred", (n) => `${n} deferred`],
];

/**
 * "6:03 pm · 31 requests, 4 securities, 62 new rows, 1 not found" from the
 * last run's stats (zero counts omitted; the message when there are none);
 * "running since 6:03 pm" while it runs; null without a run.
 */
export function lastRunText(run: PriceRunView | null, timezone: string): string | null {
  if (run === null) return null;
  const when = clockIn(run.startedAt, timezone);
  if (run.status === "running") return `running since ${when}`;
  const stats = run.stats ?? {};
  const parts = STAT_LABELS.flatMap(([key, label]) => {
    const n = stats[key];
    return n !== undefined && n !== 0 ? [label(n)] : [];
  });
  const body = parts.length > 0 ? parts.join(", ") : (run.message ?? "no stats recorded");
  return `${when} · ${body}${run.status === "error" ? ` · failed${run.message && parts.length > 0 ? `: ${run.message}` : ""}` : ""}`;
}

/** The refresh button's result: "queued", "moved up" (a queued manual job pulled forward) or "already running". */
export function refreshResultText(r: { created: boolean; movedUp: boolean }): string {
  if (r.created) return "queued";
  if (r.movedUp) return "moved up";
  return "already running";
}

/** A manual close ("312.5", "$1,234.56") to a canonical non-negative Fixed8 string; null when not a price. */
export function parsePriceInput(raw: string): string | null {
  const v = parseLooseDecimal(raw);
  if (v === undefined || v < 0n) return null;
  return formatFixed8(v);
}

/** "12 current · 1 stale · 1 not found · 2 implied · 1 manual" (zero counts omitted). */
export function countsLine(counts: { current: number; stale: number; notFound: number; error: number; implied: number; manual: number }): string {
  const parts: string[] = [];
  if (counts.current > 0) parts.push(`${counts.current} current`);
  if (counts.stale > 0) parts.push(`${counts.stale} stale`);
  if (counts.notFound > 0) parts.push(`${counts.notFound} not found`);
  if (counts.error > 0) parts.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`);
  if (counts.implied > 0) parts.push(`${counts.implied} implied`);
  if (counts.manual > 0) parts.push(`${counts.manual} manual`);
  return parts.length > 0 ? parts.join(" · ") : "no priced securities";
}

export const NOT_CONFIGURED_TEXT =
  "Price feed not configured: set PRICE_PROVIDER=tiingo and TIINGO_API_KEY in .env (free account, see .env.example) and restart; until then values use statement, positions-implied and manual prices.";

export interface PriceHistoryPoints {
  dates: string[];
  /** Closes as plot numbers (display only). */
  closes: number[];
  suspect: boolean[];
  manual: boolean[];
}

/** The history list (descending from the API) as ascending plot arrays. */
export function priceHistoryPoints(items: readonly PriceView[]): PriceHistoryPoints {
  const asc = [...items].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    dates: asc.map((p) => p.date),
    closes: asc.map((p) => Number(p.close)),
    suspect: asc.map((p) => p.suspect),
    manual: asc.map((p) => p.source === "manual"),
  };
}
