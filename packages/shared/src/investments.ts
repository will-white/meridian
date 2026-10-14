import { sha256Hex } from "./crypto.js";
import { addDays, type IsoDate } from "./dates.js";
import { formatFixed8, type Fixed8 } from "./decimal.js";
import {
  isInvestmentAccountType,
  type AccountType,
  type AssetClass,
  type InvestmentFidelity,
  type InvestmentPeriod,
  type InvestmentTxnType,
  type ReturnFailureReason,
  type SecurityType,
} from "./enums.js";
import { addMonthsClamped } from "./months.js";
import { sanitizeText } from "./sanitize.js";

/**
 * Pure investment helpers shared by the importers, the services, the API and the web
 * (imports design §3.2, §3.8, §3.11, §3.12; views §3.5, §3.11; lots §4.3). No clock, no DB.
 */

// ---- Security identity ----

const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-/]{0,11}$/;

/**
 * Upper-cased ticker without a leading `$`, trailing `*`s (Fidelity's core-position marker)
 * or stray whitespace; null when empty or when the result is not ticker-shaped (a fund name
 * in a symbol column is not a ticker).
 */
export function normalizeTicker(raw: unknown): string | null {
  let s = sanitizeText(raw, 100).trim().toUpperCase();
  if (s.startsWith("$")) s = s.slice(1);
  s = s.replace(/\*+$/, "").replace(/\s+/g, " ").trim();
  if (!s || !TICKER_RE.test(s)) return null;
  return s;
}

/** Upper-cased name with every run of non-alphanumerics collapsed to one space (matches the expression index). */
export function normalizeName(raw: unknown): string {
  return sanitizeText(raw, 500)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

export function normalizeCusip(raw: unknown): string | null {
  const s = sanitizeText(raw, 50).toUpperCase().replace(/\s+/g, "");
  return /^[A-Z0-9]{9}$/.test(s) ? s : null;
}

export function normalizeIsin(raw: unknown): string | null {
  const s = sanitizeText(raw, 50).toUpperCase().replace(/\s+/g, "");
  return /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(s) ? s : null;
}

const CASH_TICKERS = new Set(["CASH", "USD", "**CASH**", "CASH & CASH INVESTMENTS"]);
const CASH_NAME_RE = /^CASH( |$)|CORE CASH|FDIC INSURED DEPOSIT|CASH AND CASH INVESTMENTS|CASH BALANCE|US DOLLARS?$/;

export interface SecurityKey {
  ticker?: string | null;
  name?: string | null;
  cusip?: string | null;
  isin?: string | null;
  currency?: string | null;
  /** Free-text type hints from the source (`type`, `securitytype`, `assettype`, `assetclass`). */
  hints?: readonly string[];
}

/**
 * True for the cash position itself: a cash ticker (`CASH`, `USD`, `**CASH**`,
 * `CASH & CASH INVESTMENTS`, any case) or, when the key carries no usable ticker, a cash-shaped name.
 */
export function isCashKey(key: Pick<SecurityKey, "ticker" | "name">): boolean {
  const rawTicker = sanitizeText(key.ticker, 100).trim().toUpperCase().replace(/\s+/g, " ");
  if (rawTicker && CASH_TICKERS.has(rawTicker)) return true;
  if (normalizeTicker(key.ticker) !== null) return false;
  const name = normalizeName(key.name);
  return name !== "" && CASH_NAME_RE.test(name);
}

export interface SecurityHints {
  type: SecurityType;
  assetClass: AssetClass;
}

const ETF_RE = /\bETF\b/;
const MONEY_MARKET_RE = /MONEY MARKET|\bMMF\b|CORE POSITION|SWEEP/;
const CD_RE = /\bCD\b|CERTIFICATE OF DEPOSIT/;
const BOND_RE = /BOND|TREASURY|NOTE\b|BILL\b/;
const FUND_RE = /FUND|INDEX|TRUST|POOL|PORTFOLIO|TARGET|CLASS [A-Z]\b|INSTL|ADMIRAL|INVESTOR/;

const CLASS_RULES: ReadonlyArray<[RegExp, AssetClass]> = [
  [/MONEY MARKET|CASH RESERVES|TREASURY ONLY|FDIC/, "cash"],
  [/REIT|REAL ESTATE/, "real_estate"],
  [/BOND|TREASURY|FIXED INCOME|INCOME FUND|AGGREGATE|TIPS|MUNICIPAL/, "bonds"],
  [/INTERNATIONAL|INTL|EMERGING|EX[- ]?US|EAFE|GLOBAL|FOREIGN|DEVELOPED MARKETS|EUROPE|PACIFIC|ASIA/, "intl_stock"],
  [/500|TOTAL STOCK|TOTAL MARKET|S&P|RUSSELL|NASDAQ|GROWTH|VALUE|SMALL CAP|MID CAP|LARGE CAP|EQUITY|STOCK/, "us_stock"],
];

/**
 * Guess a new security's type and asset class from its ticker, name and source hints.
 * Shown as "guessed" (`needs_review`) until the owner saves the row. A ticker carrying
 * Fidelity's `**` core-position marker is a sweep fund (fund, cash).
 */
export function guessSecurityHints(key: Pick<SecurityKey, "ticker" | "name" | "hints">): SecurityHints {
  const rawTicker = sanitizeText(key.ticker, 100).trim();
  const ticker = normalizeTicker(rawTicker);
  const name = sanitizeText(key.name, 500).toUpperCase().replace(/\s+/g, " ").trim();
  const hintText = (key.hints ?? []).map((h) => sanitizeText(h, 100).toUpperCase()).join(" ");
  const corePosition = /\*+$/.test(rawTicker);
  const text = `${hintText} ${name}`.trim();

  let type: SecurityType;
  let assetClass: AssetClass | null = null;
  if (ETF_RE.test(text)) type = "etf";
  else if (MONEY_MARKET_RE.test(text) || corePosition) {
    type = "fund";
    assetClass = "cash";
  } else if (CD_RE.test(text)) type = "cd";
  else if (BOND_RE.test(text)) type = "bond";
  else if (FUND_RE.test(text) || (ticker !== null && /^[A-Z]{5}$/.test(ticker) && ticker.endsWith("X"))) type = "fund";
  else type = "stock";

  if (assetClass === null) {
    assetClass = "other";
    for (const [re, cls] of CLASS_RULES) {
      if (re.test(name)) {
        assetClass = cls;
        break;
      }
    }
  }
  return { type, assetClass };
}

// ---- Fidelity ----

/** The imports design's core: trades → full history; else snapshots → positions; else balance only. */
export function accountFidelity(f: { hasTrades: boolean; hasSnapshots: boolean }): InvestmentFidelity {
  if (f.hasTrades) return "full_history";
  if (f.hasSnapshots) return "positions";
  return "balance_only";
}

export interface PositionMismatch {
  ticker: string;
  lotsQuantity: Fixed8;
  snapshotQuantity: Fixed8;
}

export interface FidelityResult {
  fidelity: InvestmentFidelity;
  fidelityNote: string | null;
}

/**
 * The plan's derived fidelity (views §3.5): `accountFidelity` plus the engine's position check.
 * Lots that do not explain the latest statement demote a full history to `positions` with a note.
 */
export function deriveFidelity(f: { hasTrades: boolean; hasSnapshots: boolean; mismatches: readonly PositionMismatch[] }): FidelityResult {
  const base = accountFidelity(f);
  if (base !== "full_history") return { fidelity: base, fidelityNote: null };
  if (f.mismatches.length === 0) {
    return { fidelity: "full_history", fidelityNote: f.hasSnapshots ? null : "no positions statement to check against" };
  }
  const first = f.mismatches[0]!;
  const more = f.mismatches.length > 1 ? ` (+${f.mismatches.length - 1} more)` : "";
  return {
    fidelity: "positions",
    fidelityNote: `trade history incomplete: ${first.ticker} lots cover ${formatFixed8(first.lotsQuantity)} of ${formatFixed8(first.snapshotQuantity)} shares${more}`,
  };
}

// ---- Contributions ----

const INFLOW_EXCLUDE_RE = /DIVIDEND|INTEREST|CAPITAL GAIN|REINVEST|REFUND|REBATE|\bSOLD\b|\bSELL\b|REDEMPTION/;
const CONTRIBUTION_RE =
  /CONTRIBUTION|EMPLOYER (MATCH|CONTRIB)|EMPLOYEE (PRE-?TAX|ROTH|AFTER-?TAX)|SALARY DEFERRAL|401\(?K\)? (DEFERRAL|CONTRIB)|PAYROLL|ROLLOVER|EFT (IN|RECEIVED)|ELECTRONIC FUNDS TRANSFER RECEIVED|ACH (DEPOSIT|CREDIT|IN)|WIRE IN|FUNDS RECEIVED|TRANSFER (IN|FROM)|\bDEPOSIT\b/;

/**
 * Ingest-time classifier: an inflow into an investment-type account whose text reads like a
 * contribution is an (unpaired) transfer. Outflows and non-investment accounts are never touched.
 */
export function classifyInvestmentInflow(accountType: AccountType, description: string, amountCents: bigint): "contribution" | null {
  if (!isInvestmentAccountType(accountType) || amountCents <= 0n) return null;
  const text = sanitizeText(description, 500).toUpperCase().replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (INFLOW_EXCLUDE_RE.test(text)) return null;
  return CONTRIBUTION_RE.test(text) ? "contribution" : null;
}

// ---- Trade ids ----

/** The security part of a trade id: normalized ticker, else `cusip:`, else `name:`, else `cash`. */
export function tradeSecurityKey(key: Pick<SecurityKey, "ticker" | "cusip" | "name">): string {
  const ticker = normalizeTicker(key.ticker);
  if (ticker) return ticker;
  const cusip = normalizeCusip(key.cusip);
  if (cusip) return `cusip:${cusip}`;
  const name = normalizeName(key.name) || normalizeName(key.ticker); // a fund name in the symbol column resolves by name
  if (name) return `name:${name}`;
  return "cash";
}

export interface TradeIdParts {
  date: IsoDate;
  type: InvestmentTxnType;
  securityKey: string;
  quantity: Fixed8 | null;
  amountCents: bigint;
}

/**
 * Stable id for a trade row without a file-provided id:
 * `inv:<sha256(date|type|securityKey|quantityCanonical|amountCents)>[:n]` (n ≥ 1 for identical
 * keys within one file, in file order). Never depends on `sequence`.
 */
export async function tradeExternalId(parts: TradeIdParts, ordinal = 0): Promise<string> {
  const quantity = parts.quantity === null ? "" : formatFixed8(parts.quantity);
  const key = `${parts.date}|${parts.type}|${parts.securityKey}|${quantity}|${parts.amountCents.toString()}`;
  const hash = await sha256Hex(key);
  return ordinal === 0 ? `inv:${hash}` : `inv:${hash}:${ordinal}`;
}

// ---- Periods ----

export interface PeriodStartOptions {
  /** The first date with data (for `all`); null when there is none. */
  earliest?: IsoDate | null;
  /** The requested start (for `custom`). */
  from?: IsoDate | null;
}

/**
 * The one definition of a period's start (seams C31): `1w` = 7 days back; `1m|3m|6m|1y|3y|5y`
 * = `addMonthsClamped`; `ytd` = Dec 31 of the previous year; `all` = the earliest data date;
 * `custom` = the given start. Null when `all` has no data or `custom` has no start.
 */
export function periodStart(period: InvestmentPeriod, end: IsoDate, opts: PeriodStartOptions = {}): IsoDate | null {
  switch (period) {
    case "1w":
      return addDays(end, -7);
    case "1m":
      return addMonthsClamped(end, -1);
    case "3m":
      return addMonthsClamped(end, -3);
    case "6m":
      return addMonthsClamped(end, -6);
    case "1y":
      return addMonthsClamped(end, -12);
    case "3y":
      return addMonthsClamped(end, -36);
    case "5y":
      return addMonthsClamped(end, -60);
    case "ytd":
      return `${Number(end.slice(0, 4)) - 1}-12-31`;
    case "all":
      return opts.earliest ?? null;
    case "custom":
      return opts.from ?? null;
  }
}

// ---- Readable return-failure reasons ----

/** The lots design's reason strings, rendered for people rather than code names. */
export function returnReasonText(reason: ReturnFailureReason, date: IsoDate | null): string {
  switch (reason) {
    case "no_valuations":
      return `No value is known for this account on or before ${date ?? "the period end"}. Sync it or import a statement.`;
    case "zero_denominator":
      return `Value appeared on ${date ?? "a date in the period"} without a contribution. Add the opening transfer or position.`;
    case "negative_capital":
      return `The account's value went negative on ${date ?? "a date in the period"}.`;
    case "too_few_flows":
    case "no_sign_change":
      return "Money only went one way in this period, so a rate of return is undefined.";
    case "no_bracket":
      return "The return is outside the solvable range (a total loss or an extreme gain).";
    case "no_benchmark_price":
      return `No benchmark price on or before ${date ?? "the period start"}.`;
  }
}
