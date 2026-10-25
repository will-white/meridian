import { parseCsv } from "./csv.js";
import { dayDiff, isIsoDate, type IsoDate } from "./dates.js";
import { FIXED8_SCALE, roundDivHalfAway, type Fixed8 } from "./decimal.js";
import { PriceProviderId } from "./enums.js";
import { lastTradingDayOnOrBefore, previousTradingDay } from "./marketCalendar.js";
import { localClockInTimeZone } from "./months.js";

/**
 * Pure parts of the price feed (prices design §3.3, §3.6, §3.12): the expected price date,
 * the provider interface and its CSV parser, symbol mapping and the suspect-close rule.
 * The Tiingo HTTP adapter and the fetch job live in the worker. No clock, no DB.
 */

export const MARKET_TIME_ZONE = "America/New_York";

/** End-of-day closes and fund NAVs are assumed posted from this wall-clock time in New York. */
export const EOD_AVAILABLE_AFTER = { hour: 18, minute: 30 } as const;

/**
 * The newest close a feed can honestly have at `now`: the last trading day on or before the
 * New York date when the ET clock is at or past 18:30, else the previous trading day.
 */
export function expectedPriceDate(now: Date): IsoDate {
  const et = localClockInTimeZone(now, MARKET_TIME_ZONE);
  const d = lastTradingDayOnOrBefore(et.date);
  if (d !== et.date) return d; // weekend or holiday: the last session's close is available
  const afterClose =
    et.hour > EOD_AVAILABLE_AFTER.hour || (et.hour === EOD_AVAILABLE_AFTER.hour && et.minute >= EOD_AVAILABLE_AFTER.minute);
  return afterClose ? d : previousTradingDay(d);
}

/** The close a provider-mode position on date `d` should carry, capped at what the feed can have. */
export function expectedCloseFor(d: IsoDate, expectedThrough: IsoDate): IsoDate {
  return d > expectedThrough ? expectedThrough : lastTradingDayOnOrBefore(d);
}

// ---- PRICE_PROVIDER ----

/**
 * `PRICE_PROVIDER` as the API and the worker both read it (plan decision 10; one parser so a
 * shared .env value boots both): trimmed and lower-cased; unset, empty or `none` means no
 * provider (null); any other value but a known provider id is an error naming the value.
 */
export function parsePriceProviderId(raw: string | undefined | null): PriceProviderId | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "none") return null;
  const parsed = PriceProviderId.safeParse(value);
  if (parsed.success) return parsed.data;
  const known = PriceProviderId.options.map((id) => `"${id}"`).join(", ");
  throw new Error(`PRICE_PROVIDER must be ${known} or "none", not "${(raw ?? "").trim()}"`);
}

// ---- Provider interface ----

export type ProviderFailureKind = "not_found" | "rate_limited" | "auth" | "http" | "network" | "invalid_response";

export interface ProviderBar {
  date: IsoDate;
  close: Fixed8;
  adjClose: Fixed8 | null;
  splitFactor: Fixed8 | null;
}

export type ProviderResult =
  | { ok: true; bars: ProviderBar[] }
  | {
      ok: false;
      kind: ProviderFailureKind;
      message: string;
      status?: number;
      retryAfterMs?: number;
      /** ≤ 64 KB of the response, kept in `import_log.raw_payload` for `invalid_response`. */
      body?: string;
    };

export interface PriceProvider {
  readonly id: PriceProviderId;
  mapSymbol(security: { ticker: string; providerSymbol: string | null }): string;
  fetchDaily(symbol: string, range: { from: IsoDate; to: IsoDate }): Promise<ProviderResult>;
}

/** `providerSymbol` wins as typed; otherwise the ticker upper-cased with `.` → `-` (`BRK.B` → `BRK-B`). */
export function mapSymbol(security: { ticker: string; providerSymbol: string | null }): string {
  const override = security.providerSymbol?.trim();
  if (override) return override;
  return security.ticker.trim().toUpperCase().replace(/\./g, "-");
}

// ---- Tiingo CSV ----

export const PROVIDER_BODY_LIMIT = 65_536;

const DECIMAL_CELL = /^(\d{1,12})(?:\.(\d+))?$/;

/** A non-negative decimal cell → Fixed8, rounding half away from zero past the 8th place. */
function parseProviderDecimal(cell: string): Fixed8 | undefined {
  const m = DECIMAL_CELL.exec(cell.trim());
  if (!m) return undefined;
  const [, whole, frac = ""] = m;
  if (frac.length <= 8) return BigInt(whole!) * FIXED8_SCALE + BigInt(frac.padEnd(8, "0"));
  const scaled = BigInt(whole! + frac);
  return roundDivHalfAway(scaled, 10n ** BigInt(frac.length - 8));
}

function invalid(message: string, text: string): ProviderResult {
  return { ok: false, kind: "invalid_response", message, body: text.slice(0, PROVIDER_BODY_LIMIT) };
}

/**
 * Parse Tiingo's daily CSV. The header must contain `date` and `close` (any case, any order);
 * `adjClose` and `splitFactor` are optional. An empty close skips the row; a bad date or a
 * non-decimal cell fails the whole symbol so nothing partial is written. Bars come back
 * sorted ascending and de-duplicated by date (last wins). An empty body is zero bars.
 */
export function parseTiingoCsv(text: string): ProviderResult {
  const rows = parseCsv(text);
  if (rows.length === 0) return { ok: true, bars: [] };
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const dateCol = header.indexOf("date");
  const closeCol = header.indexOf("close");
  if (dateCol < 0 || closeCol < 0) return invalid("response is not a daily price CSV (no date/close header)", text);
  const adjCol = header.indexOf("adjclose");
  const splitCol = header.indexOf("splitfactor");

  const byDate = new Map<IsoDate, ProviderBar>();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.every((c) => c.trim() === "")) continue;
    const date = (row[dateCol] ?? "").trim().slice(0, 10);
    if (!isIsoDate(date)) return invalid(`row ${i}: unreadable date "${(row[dateCol] ?? "").trim().slice(0, 40)}"`, text);
    const closeCell = (row[closeCol] ?? "").trim();
    if (closeCell === "") continue;
    const close = parseProviderDecimal(closeCell);
    if (close === undefined) return invalid(`row ${i}: unreadable close "${closeCell.slice(0, 40)}"`, text);
    let adjClose: Fixed8 | null = null;
    if (adjCol >= 0) {
      const cell = (row[adjCol] ?? "").trim();
      if (cell !== "") {
        const v = parseProviderDecimal(cell);
        if (v === undefined) return invalid(`row ${i}: unreadable adjClose "${cell.slice(0, 40)}"`, text);
        adjClose = v;
      }
    }
    let splitFactor: Fixed8 | null = null;
    if (splitCol >= 0) {
      const cell = (row[splitCol] ?? "").trim();
      if (cell !== "") {
        const v = parseProviderDecimal(cell);
        if (v === undefined) return invalid(`row ${i}: unreadable splitFactor "${cell.slice(0, 40)}"`, text);
        splitFactor = v;
      }
    }
    byDate.set(date, { date, close, adjClose, splitFactor });
  }
  const bars = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { ok: true, bars };
}

// ---- Suspect closes ----

/**
 * A provider close is suspect when it moves more than 50 % against the previous close within
 * 7 calendar days and no split explains it (`splitFactor` null or exactly 1). Suspect rows are
 * stored and marked, never dropped.
 */
export function isSuspectClose(prev: { date: IsoDate; close: Fixed8 } | null, bar: { date: IsoDate; close: Fixed8; splitFactor: Fixed8 | null }): boolean {
  if (!prev) return false;
  if (dayDiff(prev.date, bar.date) > 7) return false;
  if (bar.splitFactor !== null && bar.splitFactor !== FIXED8_SCALE) return false;
  const move = bar.close > prev.close ? bar.close - prev.close : prev.close - bar.close;
  return move * 2n > prev.close;
}

/**
 * Suspect flags for a batch of ascending bars. `prev` for the first bar is the latest stored
 * close before it (or null); for every later bar it is the bar immediately before.
 */
export function flagSuspectBars(bars: readonly ProviderBar[], latestStored: { date: IsoDate; close: Fixed8 } | null): boolean[] {
  const out: boolean[] = [];
  let prev = latestStored;
  for (const bar of bars) {
    out.push(isSuspectClose(prev, bar));
    prev = { date: bar.date, close: bar.close };
  }
  return out;
}
