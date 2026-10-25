import { PositionsCsvMapping, TradesCsvMapping, type PositionsCsvMappingInput, type RowChoice, type TradeKind, type TradesCsvMappingInput } from "./api.js";
import { parseCsvDate, parseLooseMoney, type ColumnRef, type CsvDateFormat, type MappingError } from "./csv.js";
import { dayDiff, type IsoDate } from "./dates.js";
import {
  amountMismatch,
  centsToFixed8,
  fixed8ToCents,
  FIXED8_PER_CENT,
  FIXED8_SCALE,
  formatFixed8,
  impliedPrice,
  mulToCents,
  parseLooseDecimal,
  type Fixed8,
} from "./decimal.js";
import type { InvestmentTxnType, TransferDirection } from "./enums.js";
import { isCashKey, normalizeCusip, normalizeTicker, tradeExternalId, tradeSecurityKey } from "./investments.js";
import { sanitizeText } from "./sanitize.js";

/**
 * Positions and trade-history CSV mappers (imports design §3.6 and §3.8; plan decisions 5–7;
 * seams C3, C6, C53), on the Phase 1 bank-mapper pattern: a Zod mapping, column refs by header
 * or index, rows that cannot be mapped are reported rather than thrown, stable ids, a guesser.
 * The mapping contracts (`PositionsCsvMapping`, `TradesCsvMapping`, `TradeKind`) live in api.ts.
 * Pure: no DB, no clock (a snapshot is never dated by the clock: `as_of_required` is thrown).
 */

// ---- Shared ----

/** A row-level problem with a stable code and a readable message (assignable to `MappingError`). */
export interface ImportRowError extends MappingError {
  code: string;
}

/** A file-level refusal (`as_of_required`); column-resolution failures throw a plain `Error` (`bad_mapping`). */
export class CsvImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CsvImportError";
  }
}

const TOTALS_RE = /^(TOTAL|ACCOUNT TOTAL|GRAND TOTAL)\b/;
const PENDING_RE = /^PENDING ACTIVITY/;

function resolveColumn(ref: ColumnRef, headers: readonly string[] | undefined): number {
  if (typeof ref === "number") return ref;
  if (!headers) throw new Error(`Column "${ref}" referenced by name, but the file has no header row`);
  const idx = headers.findIndex((h) => h.trim().toLowerCase() === ref.trim().toLowerCase());
  if (idx < 0) throw new Error(`Column "${ref}" not found in header`);
  return idx;
}

function cell(row: readonly string[], col: number | undefined): string {
  return col === undefined ? "" : (row[col] ?? "").trim();
}

function isBlankRow(row: readonly string[]): boolean {
  return row.every((c) => c.trim() === "");
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function upper(s: string): string {
  return s.toUpperCase().replace(/\s+/g, " ").trim();
}

/** Phase 1's header guess: exact match on every candidate first, then a contains match. */
function findHeader(headers: readonly string[], candidates: readonly string[], containsCandidates: readonly string[] = candidates): string | undefined {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const c of candidates) {
    const idx = lower.indexOf(c);
    if (idx >= 0) return headers[idx];
  }
  for (const c of containsCandidates) {
    const idx = lower.findIndex((h) => h.includes(c));
    if (idx >= 0) return headers[idx];
  }
  return undefined;
}

function guessDateFormat(samples: readonly string[]): CsvDateFormat {
  const s = samples.map((x) => x.trim()).filter((x) => x.length > 0);
  if (s.some((x) => /^\d{4}-\d{2}-\d{2}/.test(x))) return "YYYY-MM-DD";
  if (s.some((x) => /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(x))) return "YYYY/MM/DD";
  if (s.some((x) => /^[A-Za-z]{3}/.test(x))) return "MMM D, YYYY";
  if (s.some((x) => /^\d{1,2}\s+[A-Za-z]{3}/.test(x))) return "D MMM YYYY";
  if (s.some((x) => /^\d{1,2}\/\d{1,2}\/\d{2}$/.test(x))) return "MM/DD/YY";
  if (s.some((x) => /^\d{1,2}-\d{1,2}-\d{4}$/.test(x))) return "MM-DD-YYYY";
  if (s.some((x) => Number(x.split(/[/-]/)[0]) > 12)) return "DD/MM/YYYY";
  return "MM/DD/YYYY";
}

/** Split a file into header and data rows per `hasHeader`/`skipRows`; `offset` is the data rows' index base. */
function splitRows(rows: readonly string[][], mapping: { hasHeader: boolean; skipRows: number }) {
  const body = rows.slice(mapping.skipRows);
  const headers = mapping.hasHeader ? body[0] : undefined;
  const data = mapping.hasHeader ? body.slice(1) : body;
  return { headers, data, offset: mapping.skipRows + (mapping.hasHeader ? 1 : 0) };
}

/** A loosely formatted decimal cell: undefined when blank, `null` when non-blank but unreadable. */
function decimalCell(raw: string): Fixed8 | null | undefined {
  if (raw === "") return undefined;
  return parseLooseDecimal(raw) ?? null;
}

/** A dollar cell → cents (half away from zero) with a `rounded` flag; `null` when unreadable. */
function moneyCell(raw: string): { cents: bigint; rounded: boolean } | null | undefined {
  const v = decimalCell(raw);
  if (v === undefined) return undefined;
  if (v === null) return null;
  return { cents: fixed8ToCents(v), rounded: v % FIXED8_PER_CENT !== 0n };
}

// ---- Positions ----

export interface MappedPosition {
  rowIndex: number;
  ticker: string | null;
  name: string | null;
  cusip: string | null;
  /** Null for a dollar-only row. */
  quantity: Fixed8 | null;
  price: Fixed8 | null;
  valueCents: bigint;
  costBasisCents: bigint | null;
  isCash: boolean;
  warnings: string[];
}

export interface PositionsSkip {
  rowIndex: number;
  reason: "totals_row" | "pending_activity" | "other_account" | "zero_position";
}

export interface MappedPositions {
  positions: MappedPosition[];
  asOf: IsoDate;
  errors: ImportRowError[];
  skipped: PositionsSkip[];
  /** Distinct values of the account-filter column, in file order, for the UI. */
  filterValues: string[];
  pendingActivityCents: bigint;
}

export interface MapPositionsOptions {
  /** The snapshot date when the mapping's `asOf.mode` is `request` (or the column yields none). */
  asOfDate?: IsoDate;
  /** Keep only rows whose `accountFilter` column equals this; without it no row is filtered. */
  accountFilterValue?: string;
}

/** The identity used to merge a security's sub-lot rows: ticker, else cusip, else name; cash rows merge together. */
function positionKey(p: Pick<MappedPosition, "ticker" | "cusip" | "name" | "isCash">): string {
  if (p.isCash) return "cash";
  return tradeSecurityKey({ ticker: p.ticker, cusip: p.cusip, name: p.name });
}

function mergePositions(rows: MappedPosition[]): MappedPosition {
  const first = rows[0]!;
  if (rows.length === 1) return first;
  const quantity = rows.every((r) => r.quantity !== null) ? rows.reduce((acc, r) => acc + r.quantity!, 0n) : null;
  const valueCents = rows.reduce((acc, r) => acc + r.valueCents, 0n);
  const costBasisCents = rows.every((r) => r.costBasisCents !== null) ? rows.reduce((acc, r) => acc + r.costBasisCents!, 0n) : null;
  const reported = first.price;
  const identical = reported !== null && rows.every((r) => r.price === reported);
  let price: Fixed8 | null;
  if (identical) price = reported;
  else if (quantity !== null && quantity !== 0n) price = impliedPrice(valueCents, quantity);
  else price = null;
  const warnings: string[] = [];
  for (const r of rows) for (const w of r.warnings) if (!warnings.includes(w)) warnings.push(w);
  return {
    rowIndex: first.rowIndex,
    ticker: first.ticker,
    name: first.name ?? rows.find((r) => r.name !== null)?.name ?? null,
    cusip: first.cusip ?? rows.find((r) => r.cusip !== null)?.cusip ?? null,
    quantity,
    price,
    valueCents,
    costBasisCents,
    isCash: first.isCash,
    warnings,
  };
}

/**
 * Apply a positions mapping to parsed rows. Rows that cannot be mapped are reported, not thrown;
 * sub-lot rows of one security are aggregated. Throws `CsvImportError('as_of_required')` when no
 * date is available (a snapshot is never dated by the clock).
 */
export function mapPositionsCsvRows(rows: readonly string[][], mappingInput: PositionsCsvMappingInput, opts: MapPositionsOptions = {}): MappedPositions {
  const mapping = PositionsCsvMapping.parse(mappingInput);
  if (mapping.asOf.mode === "request" && opts.asOfDate === undefined) {
    throw new CsvImportError("as_of_required", "The file has no date column: an as-of date is required");
  }
  const { headers, data, offset } = splitRows(rows, mapping);
  const col = (ref: { column: ColumnRef } | undefined) => (ref ? resolveColumn(ref.column, headers) : undefined);
  const symbolCol = col(mapping.symbol);
  const nameCol = col(mapping.name);
  const cusipCol = col(mapping.cusip);
  const quantityCol = col(mapping.quantity);
  const priceCol = col(mapping.price);
  const valueCol = col(mapping.value);
  const costCol = col(mapping.costBasis);
  const filterCol = col(mapping.accountFilter);
  const dateCol = mapping.asOf.mode === "column" ? resolveColumn(mapping.asOf.column, headers) : undefined;
  const dateFormat = mapping.asOf.mode === "column" ? mapping.asOf.format : undefined;

  const mapped: MappedPosition[] = [];
  const errors: ImportRowError[] = [];
  const skipped: PositionsSkip[] = [];
  const filterValues: string[] = [];
  let pendingActivityCents = 0n;
  let columnAsOf: IsoDate | undefined;

  for (let i = 0; i < data.length; i++) {
    const row = data[i]!;
    const rowIndex = i + offset;
    if (isBlankRow(row)) continue;

    if (filterCol !== undefined) {
      const value = sanitizeText(cell(row, filterCol), 100);
      if (value && !filterValues.includes(value)) filterValues.push(value);
      if (opts.accountFilterValue !== undefined && value !== opts.accountFilterValue) {
        skipped.push({ rowIndex, reason: "other_account" });
        continue;
      }
    }

    const symbolRaw = sanitizeText(cell(row, symbolCol), 100);
    const nameRaw = sanitizeText(cell(row, nameCol), 200);
    const cusipRaw = sanitizeText(cell(row, cusipCol), 50);
    const symbolUpper = upper(symbolRaw);
    const nameUpper = upper(nameRaw);
    if (TOTALS_RE.test(symbolUpper) || TOTALS_RE.test(nameUpper)) {
      skipped.push({ rowIndex, reason: "totals_row" });
      continue;
    }
    if (PENDING_RE.test(symbolUpper) || PENDING_RE.test(nameUpper)) {
      const pending = moneyCell(cell(row, valueCol));
      if (pending) pendingActivityCents += pending.cents;
      skipped.push({ rowIndex, reason: "pending_activity" });
      continue;
    }
    const quantityText = cell(row, quantityCol);
    const priceText = cell(row, priceCol);
    const valueText = cell(row, valueCol);
    const costText = cell(row, costCol);
    // No identity, or an identity with no numbers at all (statement footers), is not a position.
    if ((!symbolRaw && !nameRaw && !cusipRaw) || (quantityText === "" && valueText === "")) {
      skipped.push({ rowIndex, reason: "totals_row" });
      continue;
    }

    if (dateCol !== undefined && dateFormat !== undefined) {
      const dateText = cell(row, dateCol);
      const date = parseCsvDate(dateText, dateFormat);
      if (!date) {
        errors.push({ rowIndex, code: "unreadable_date", message: `Unreadable date "${sanitizeText(dateText, 50)}"` });
        continue;
      }
      if (columnAsOf === undefined) columnAsOf = date;
      else if (date !== columnAsOf) {
        errors.push({ rowIndex, code: "asof_mixed", message: `Row is dated ${date}, the file ${columnAsOf}` });
        continue;
      }
    }

    const warnings: string[] = [];
    let quantity = decimalCell(quantityText);
    if (quantity === null) {
      errors.push({ rowIndex, code: "unreadable_quantity", message: `Unreadable quantity "${sanitizeText(quantityText, 50)}"` });
      continue;
    }
    let price = decimalCell(priceText);
    if (price === null) {
      errors.push({ rowIndex, code: "unreadable_price", message: `Unreadable price "${sanitizeText(priceText, 50)}"` });
      continue;
    }
    const value = moneyCell(valueText);
    if (value === null) {
      errors.push({ rowIndex, code: "unreadable_value", message: `Unreadable value "${sanitizeText(valueText, 50)}"` });
      continue;
    }
    if (value?.rounded) warnings.push("value_rounded");
    const cost = moneyCell(costText);
    let costBasisCents: bigint | null = null;
    if (cost === null) warnings.push("cost_unreadable");
    else if (cost) {
      costBasisCents = cost.cents;
      if (cost.rounded) warnings.push("cost_rounded");
    }

    const isCash = isCashKey({ ticker: symbolRaw, name: nameRaw });
    let valueCents: bigint;
    if (isCash) {
      if (price === undefined) price = FIXED8_SCALE;
      if (value !== undefined) {
        valueCents = value.cents;
        if (quantity === undefined) quantity = centsToFixed8(valueCents);
      } else if (quantity !== undefined) {
        valueCents = mulToCents(quantity, price);
      } else {
        errors.push({ rowIndex, code: "missing_value", message: "A value, or a quantity and a price, is required" });
        continue;
      }
    } else if (value !== undefined && quantity === undefined) {
      valueCents = value.cents;
      price = undefined;
      warnings.push("dollar_only");
    } else if (value === undefined && quantity !== undefined) {
      if (price === undefined) {
        errors.push({ rowIndex, code: "missing_value", message: "A value or a price is required with a quantity" });
        continue;
      }
      valueCents = mulToCents(quantity, price);
    } else if (value !== undefined && quantity !== undefined) {
      valueCents = value.cents;
      if (price === undefined) {
        price = quantity !== 0n ? impliedPrice(valueCents, quantity) : undefined;
      } else {
        const tolerance = abs(valueCents) / 200n;
        if (abs(valueCents - mulToCents(quantity, price)) > (tolerance > 1n ? tolerance : 1n)) warnings.push("value_mismatch");
      }
    } else {
      errors.push({ rowIndex, code: "missing_value", message: "A value, or a quantity and a price, is required" });
      continue;
    }
    if (valueCents === 0n && (quantity === undefined || quantity === 0n)) {
      skipped.push({ rowIndex, reason: "zero_position" });
      continue;
    }

    const ticker = normalizeTicker(symbolRaw);
    const name = nameRaw || (ticker === null && symbolRaw ? symbolRaw : "");
    mapped.push({
      rowIndex,
      ticker,
      name: name || null,
      cusip: normalizeCusip(cusipRaw),
      quantity: quantity ?? null,
      price: price ?? null,
      valueCents,
      costBasisCents,
      isCash,
      warnings,
    });
  }

  // Sub-lot rows of one security are one position.
  const groups = new Map<string, MappedPosition[]>();
  for (const p of mapped) {
    const key = positionKey(p);
    const group = groups.get(key);
    if (group) group.push(p);
    else groups.set(key, [p]);
  }
  const positions = [...groups.values()].map(mergePositions);

  const asOf = columnAsOf ?? opts.asOfDate;
  if (asOf === undefined) throw new CsvImportError("as_of_required", "No row carries a readable date: an as-of date is required");
  return { positions, asOf, errors, skipped, filterValues, pendingActivityCents };
}

const POS_DATE_HEADERS = ["as of", "as of date", "date", "price date"];
const POS_SYMBOL_HEADERS = ["symbol", "ticker"];
const POS_NAME_HEADERS = ["description", "investment name", "security name", "security description", "fund name", "name", "security", "investment", "holding"];
const POS_CUSIP_HEADERS = ["cusip"];
const POS_QUANTITY_HEADERS = ["quantity", "shares", "units", "qty", "quantity (shares)"];
const POS_PRICE_HEADERS = ["last price", "price", "unit price", "share price", "market price", "current price", "nav", "last"];
const POS_VALUE_HEADERS = ["current value", "market value", "total value", "value", "position value", "balance"];
const POS_COST_HEADERS = ["cost basis total", "cost basis", "total cost", "basis", "cost"];
const ACCOUNT_HEADERS = ["account number", "account name", "account"];

/** Guess a positions mapping from the header row and a few sample rows; undefined without an identity column or any value column. */
export function guessPositionsMapping(headers: readonly string[], samples: readonly string[][]): PositionsCsvMappingInput | undefined {
  const symbol = findHeader(headers, POS_SYMBOL_HEADERS);
  const name = findHeader(headers, POS_NAME_HEADERS);
  if (!symbol && !name) return undefined;
  const quantity = findHeader(headers, POS_QUANTITY_HEADERS);
  const price = findHeader(headers, POS_PRICE_HEADERS);
  const value = findHeader(headers, POS_VALUE_HEADERS);
  if (!value && !(quantity && price)) return undefined;
  const date = findHeader(headers, POS_DATE_HEADERS);
  const mapping: PositionsCsvMappingInput = { hasHeader: true, asOf: { mode: "request" } };
  if (date) {
    const dateIdx = headers.indexOf(date);
    mapping.asOf = { mode: "column", column: date, format: guessDateFormat(samples.map((r) => r[dateIdx] ?? "")) };
  }
  if (symbol) mapping.symbol = { column: symbol };
  if (name && name !== symbol) mapping.name = { column: name };
  const cusip = findHeader(headers, POS_CUSIP_HEADERS);
  if (cusip) mapping.cusip = { column: cusip };
  if (quantity) mapping.quantity = { column: quantity };
  if (price) mapping.price = { column: price };
  if (value) mapping.value = { column: value };
  const cost = findHeader(headers, POS_COST_HEADERS);
  if (cost) mapping.costBasis = { column: cost };
  const account = findHeader(headers, ACCOUNT_HEADERS);
  if (account) mapping.accountFilter = { column: account };
  return mapping;
}

// ---- Trades ----

/** The lookup key of an action: sanitized, lower-cased, whitespace collapsed. */
export function actionKey(action: string): string {
  return sanitizeText(action, 200).toLowerCase().replace(/\s+/g, " ").trim();
}

export interface ClassifyRow {
  /** The row carries a non-zero quantity. */
  hasQuantity: boolean;
  amountSign: -1 | 0 | 1 | null;
  /** The row's security name and ticker, removed from the text before the regex pass so a fund called
   *  "… DIVIDEND APPRECIATION …" bought through a Fidelity-style action line stays a buy. */
  securityName?: string | null;
  ticker?: string | null;
}

const REINVEST_RE = /REINVEST|DRIP|DIVIDEND REINVESTED/;
const DIVIDEND_RE = /DIVIDEND|\bDIV\b|CAPITAL GAIN|CAP GAIN|QUALIFIED/;
const DISTRIBUTION_RE = /DISTRIBUTION\b/;
const DISTRIBUTION_EXCLUDE_RE = /IRA|TRANSFER/;
const INTEREST_RE = /INTEREST/;
const FEE_RE = /\bFEE\b|COMMISSION|ADR FEE|ADVISORY/;
const SPLIT_RE = /SPLIT/;
const BUY_RE = /\b(BUY|BOUGHT|PURCHASE|YOU BOUGHT|BUY TO COVER)\b/;
const SELL_RE = /\b(SELL|SOLD|YOU SOLD|REDEMPTION|SELL SHORT)\b/;
const SHARE_TRANSFER_RE = /TRANSFER (OF )?(SHARES|SECURITIES)|JOURNAL|ACATS|RECEIVED|DELIVERED|IN KIND|SECURITIES (RECEIVED|DELIVERED)/;
const SHARE_TRANSFER_OUT_RE = /\bOUT\b|DELIVERED|\bTO\b/;
const CASH_IN_RE = /CONTRIBUTION|DEPOSIT|EFT (IN|RECEIVED)|ELECTRONIC FUNDS TRANSFER RECEIVED|\bACH\b|WIRE IN|FUNDS RECEIVED|TRANSFER IN|ROLLOVER|EMPLOYER MATCH/;
const CASH_OUT_RE = /WITHDRAWAL|ACH (WITHDRAWAL|DEBIT)|EFT OUT|TRANSFER OUT|WIRE OUT|DISBURSEMENT|REDEMPTION TO BANK/;
const SWEEP_RE = /SWEEP|CORE FUND|MONEY MARKET (PURCHASE|REDEMPTION)|JOURNALED CASH|ADJUSTMENT/;
const REVERSAL_RE = /REVERSAL|ADJUSTMENT|CORRECTION/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `ACTION + ' ' + DESCRIPTION`, upper-cased and collapsed, with the row's security name and `(TICKER)` removed. */
function classificationText(action: string, description: string, row: ClassifyRow): string {
  let text = upper(`${sanitizeText(action, 200)} ${sanitizeText(description, 500)}`);
  const name = upper(sanitizeText(row.securityName ?? "", 200));
  if (name.length >= 6) text = text.split(name).join(" ");
  const ticker = normalizeTicker(row.ticker ?? "");
  if (ticker) text = text.replace(new RegExp(`\\(${escapeRegExp(ticker)}\\)`, "g"), " ");
  return upper(text);
}

/**
 * The cash direction of a row's text: the one pattern that matches; when both do ("ACH
 * WITHDRAWAL", "ROLLOVER DISBURSEMENT") the amount's sign decides (`bySign`), and without a
 * usable sign the inflow pattern wins, as the imports design's rule order says.
 */
function classifyCash(text: string, amountSign: ClassifyRow["amountSign"]): { kind: "cash_in" | "cash_out"; bySign: boolean } | undefined {
  const inflow = CASH_IN_RE.test(text);
  const outflow = CASH_OUT_RE.test(text);
  if (inflow && outflow) {
    if (amountSign === -1) return { kind: "cash_out", bySign: true };
    if (amountSign === 1) return { kind: "cash_in", bySign: true };
    return { kind: "cash_in", bySign: false };
  }
  if (inflow) return { kind: "cash_in", bySign: false };
  if (outflow) return { kind: "cash_out", bySign: false };
  return undefined;
}

/**
 * Classify a trade-file row (imports design §3.8): the mapping's `actionMap` first (exact key, then
 * the longest key that is a prefix of the action), then the regex rules in order. Undefined means
 * unclassified: the row is listed under `actionsFound` and nothing is imported until it is mapped.
 * Buys and sells need a quantity (a "PURCHASE CREDIT" journal line without shares is not a trade).
 * A cash row whose text names both directions goes the way of the amount's sign.
 */
export function classifyTradeAction(action: string, description: string, row: ClassifyRow, mapping: Pick<TradesCsvMapping, "actionMap" | "reinvestRows">): TradeKind | undefined {
  const fromMap = lookupActionMap(action, mapping.actionMap);
  if (fromMap !== undefined) return fromMap;
  const text = classificationText(action, description, row);
  if (!text) return undefined;
  if (REINVEST_RE.test(text)) {
    if (!row.hasQuantity) return "dividend";
    return mapping.reinvestRows === "combined" ? "reinvest_combined" : "reinvest";
  }
  if (DIVIDEND_RE.test(text) || (DISTRIBUTION_RE.test(text) && !DISTRIBUTION_EXCLUDE_RE.test(text))) return "dividend";
  if (INTEREST_RE.test(text)) return "interest";
  if (FEE_RE.test(text)) return "fee";
  if (SPLIT_RE.test(text)) return "split";
  if (row.hasQuantity && BUY_RE.test(text)) return "buy";
  if (row.hasQuantity && SELL_RE.test(text)) return "sell";
  if (row.hasQuantity && SHARE_TRANSFER_RE.test(text)) return SHARE_TRANSFER_OUT_RE.test(text) ? "transfer_out" : "transfer_in";
  const cash = classifyCash(text, row.amountSign);
  if (cash) return cash.kind;
  if (SWEEP_RE.test(text)) return "skip";
  return undefined;
}

/** Exact key, else the longest map key that is a prefix of the action's key. */
function lookupActionMap(action: string, actionMap: Record<string, TradeKind>): TradeKind | undefined {
  const key = actionKey(action);
  const entries = Object.entries(actionMap).map(([k, kind]) => [actionKey(k), kind] as const);
  const exact = entries.find(([k]) => k === key);
  if (exact) return exact[1];
  let best: (typeof entries)[number] | undefined;
  for (const entry of entries) {
    if (entry[0].length > 0 && key.startsWith(entry[0]) && (best === undefined || entry[0].length > best[0].length)) best = entry;
  }
  return best?.[1];
}

export interface MappedTrade {
  rowIndex: number;
  /** Index within the date group after the row-order sort (plan decision 5). */
  sequence: number;
  date: IsoDate;
  type: InvestmentTxnType;
  kind: TradeKind;
  ticker: string | null;
  name: string | null;
  cusip: string | null;
  quantity: Fixed8 | null;
  price: Fixed8 | null;
  /** Signed cash effect, forced by type. */
  amountCents: bigint;
  feeCents: bigint;
  splitNum: number | null;
  splitDen: number | null;
  transferDirection: TransferDirection | null;
  /** `csvid:<id>` or `inv:<sha256>`; never depends on `sequence`. */
  externalId: string;
  rawDescription: string;
  derived: Array<"amount" | "price">;
  warnings: string[];
}

export interface TradesSkip {
  rowIndex: number;
  reason: "skip" | "other_account" | "footer";
  text: string;
}

export interface ActionFound {
  key: string;
  sample: string;
  count: number;
  /** Null when any row under this key is unclassified. */
  kind: TradeKind | null;
  fromProfile: boolean;
  sampleRowIndex: number;
}

export interface MappedTrades {
  /** Date ascending, `sequence` within a date. */
  trades: MappedTrade[];
  errors: ImportRowError[];
  skipped: TradesSkip[];
  actionsFound: ActionFound[];
  /** Distinct action keys with an unclassified row; commit is refused while > 0. */
  unknownActions: number;
  rowOrder: "oldest_first" | "newest_first";
  filterValues: string[];
}

export interface MapTradesOptions {
  accountFilterValue?: string;
  /** Preview choices; only `split` ratios are consumed here (security choices are the service's). */
  choices?: readonly RowChoice[];
}

/** New:old from "2 FOR 1", "2-for-1", "1:10" or "3/2" (a date such as 10/13/2026 is not a ratio). */
export function parseSplitRatio(text: string): { num: number; den: number } | undefined {
  const t = upper(text);
  const m = /(\d+)\s*-?\s*FOR\s*-?\s*(\d+)/.exec(t) ?? /(\d+)\s*:\s*(\d+)/.exec(t) ?? /(?<![\d/])(\d+)\s*\/\s*(\d+)(?![/\d])/.exec(t);
  if (!m) return undefined;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!Number.isInteger(num) || !Number.isInteger(den) || num < 1 || den < 1) return undefined;
  return { num, den };
}

const KIND_TYPE: Record<Exclude<TradeKind, "skip" | "reinvest_combined">, InvestmentTxnType> = {
  buy: "buy",
  sell: "sell",
  dividend: "dividend",
  interest: "interest",
  reinvest: "reinvest",
  fee: "fee",
  split: "split",
  transfer_in: "transfer",
  transfer_out: "transfer",
  cash_in: "transfer",
  cash_out: "transfer",
};

interface TradeDraft extends Omit<MappedTrade, "sequence" | "externalId"> {
  securityKey: string;
  fileId: string | null;
}

type DraftBase = Pick<TradeDraft, "rowIndex" | "date" | "kind" | "ticker" | "name" | "cusip" | "feeCents" | "splitNum" | "splitDen" | "transferDirection" | "rawDescription" | "securityKey" | "fileId">;

type RowOutcome = { kind: "trades"; trades: TradeDraft[] } | { kind: "error"; error: ImportRowError } | { kind: "skipped"; skip: TradesSkip } | { kind: "unclassified" };

/**
 * Apply a trades mapping to parsed rows: classify, force signs by type, derive the missing one of
 * amount and price, split combined reinvests into two rows, assign stable ids and same-day
 * sequences after the row-order sort. Unmappable rows are reported, never thrown.
 */
export async function mapTradesCsvRows(rows: readonly string[][], mappingInput: TradesCsvMappingInput, opts: MapTradesOptions = {}): Promise<MappedTrades> {
  const mapping = TradesCsvMapping.parse(mappingInput);
  const { headers, data, offset } = splitRows(rows, mapping);
  const col = (ref: { column: ColumnRef } | undefined) => (ref ? resolveColumn(ref.column, headers) : undefined);
  const dateCol = resolveColumn(mapping.date.column, headers);
  const actionCol = resolveColumn(mapping.action.column, headers);
  const symbolCol = col(mapping.symbol);
  const nameCol = col(mapping.name);
  const cusipCol = col(mapping.cusip);
  const quantityCol = col(mapping.quantity);
  const priceCol = col(mapping.price);
  const amountCol = col(mapping.amount);
  const invert = mapping.amount?.invert ?? false;
  const feeCols = mapping.fee ? mapping.fee.columns.map((c) => resolveColumn(c, headers)) : [];
  const idCol = col(mapping.externalId);
  const descCol = col(mapping.description);
  const filterCol = col(mapping.accountFilter);
  const splitChoices = new Map<number, { num: number; den: number }>();
  for (const c of opts.choices ?? []) if (c.split) splitChoices.set(c.rowIndex, c.split);

  const errors: ImportRowError[] = [];
  const skipped: TradesSkip[] = [];
  const filterValues: string[] = [];
  const actions = new Map<string, ActionFound & { unknown: boolean }>();
  const groups: TradeDraft[][] = []; // per file row, in file order
  let firstDate: IsoDate | undefined;
  let lastDate: IsoDate | undefined;

  const noteAction = (action: string, rowIndex: number, kind: TradeKind | undefined, fromProfile: boolean) => {
    const key = actionKey(action);
    const found = actions.get(key);
    if (found) {
      found.count += 1;
      if (kind === undefined) {
        found.unknown = true;
        found.kind = null;
      }
    } else {
      actions.set(key, { key, sample: sanitizeText(action, 200), count: 1, kind: kind ?? null, fromProfile, sampleRowIndex: rowIndex, unknown: kind === undefined });
    }
  };

  for (let i = 0; i < data.length; i++) {
    const row = data[i]!;
    const rowIndex = i + offset;
    if (isBlankRow(row)) continue;

    const dateText = cell(row, dateCol);
    const date = parseCsvDate(dateText, mapping.date.format);
    if (date) {
      if (firstDate === undefined) firstDate = date;
      lastDate = date;
    }
    const action = sanitizeText(cell(row, actionCol), 200);
    const description = sanitizeText(cell(row, descCol), 500);
    // A statement footer has no date and nothing in the other mapped columns.
    if (!date && !action && cell(row, quantityCol) === "" && cell(row, amountCol) === "" && cell(row, symbolCol) === "") {
      skipped.push({ rowIndex, reason: "footer", text: sanitizeText(row.find((c) => c.trim() !== "") ?? "", 200) });
      continue;
    }
    if (filterCol !== undefined) {
      const value = sanitizeText(cell(row, filterCol), 100);
      if (value && !filterValues.includes(value)) filterValues.push(value);
      if (opts.accountFilterValue !== undefined && value !== opts.accountFilterValue) {
        skipped.push({ rowIndex, reason: "other_account", text: action });
        continue;
      }
    }
    if (!date) {
      errors.push({ rowIndex, code: "unreadable_date", message: `Unreadable date "${sanitizeText(dateText, 50)}"` });
      continue;
    }

    const outcome = mapTradeRow({
      rowIndex,
      date,
      action,
      description,
      symbolRaw: sanitizeText(cell(row, symbolCol), 100),
      nameRaw: sanitizeText(cell(row, nameCol), 200),
      cusipRaw: sanitizeText(cell(row, cusipCol), 50),
      quantityText: cell(row, quantityCol),
      priceText: cell(row, priceCol),
      amountText: cell(row, amountCol),
      invert,
      feeTexts: feeCols.map((c) => cell(row, c)),
      fileId: sanitizeText(cell(row, idCol), 200) || null,
      splitChoice: splitChoices.get(rowIndex),
      mapping,
      noteAction,
    });
    if (outcome.kind === "trades") groups.push(outcome.trades);
    else if (outcome.kind === "error") errors.push(outcome.error);
    else if (outcome.kind === "skipped") skipped.push(outcome.skip);
  }

  // Stable ids in file order; identical keys get an ordinal.
  const seen = new Map<string, number>();
  const withIds: Array<MappedTrade & { securityKey: string }>[] = [];
  for (const group of groups) {
    const out: Array<MappedTrade & { securityKey: string }> = [];
    for (const draft of group) {
      const { securityKey, fileId, ...rest } = draft;
      let externalId: string;
      if (fileId) {
        const suffix = draft.kind === "reinvest_combined" ? (draft.type === "dividend" ? ":div" : ":buy") : "";
        externalId = `csvid:${fileId}${suffix}`;
      } else {
        const parts = { date: draft.date, type: draft.type, securityKey, quantity: draft.quantity, amountCents: draft.amountCents };
        const key = `${parts.date}|${parts.type}|${parts.securityKey}|${parts.quantity === null ? "" : formatFixed8(parts.quantity)}|${parts.amountCents}`;
        const ordinal = seen.get(key) ?? 0;
        seen.set(key, ordinal + 1);
        externalId = await tradeExternalId(parts, ordinal);
      }
      out.push({ ...rest, sequence: 0, externalId, securityKey });
    }
    withIds.push(out);
  }

  // Row order (plan decision 5): newest-first files are reversed, then a stable sort by date assigns sequences.
  let rowOrder: "oldest_first" | "newest_first";
  if (mapping.rowOrder === "auto") rowOrder = firstDate !== undefined && lastDate !== undefined && firstDate > lastDate ? "newest_first" : "oldest_first";
  else rowOrder = mapping.rowOrder;
  const ordered = rowOrder === "newest_first" ? [...withIds].reverse() : withIds;
  const flat = ordered.flat();
  const sorted = flat.map((t, i) => ({ t, i })).sort((a, b) => (a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : a.i - b.i));
  let sequence = 0;
  let current: IsoDate | undefined;
  for (const { t } of sorted) {
    if (t.date !== current) {
      current = t.date;
      sequence = 0;
    }
    t.sequence = sequence++;
  }

  // A reinvest without its dividend in the file (same security within 7 days) is income counted nowhere.
  const dividends = sorted.filter(({ t }) => t.type === "dividend").map(({ t }) => t);
  for (const { t } of sorted) {
    if (t.kind !== "reinvest") continue;
    const paired = dividends.some((d) => d.securityKey === t.securityKey && Math.abs(dayDiff(d.date, t.date)) <= 7);
    if (!paired) t.warnings.push("reinvest_without_dividend");
  }

  const trades: MappedTrade[] = sorted.map(({ t }) => {
    const { securityKey: _securityKey, ...trade } = t;
    return trade;
  });
  const actionsFound: ActionFound[] = [...actions.values()].map(({ unknown: _unknown, ...a }) => a);
  const unknownActions = [...actions.values()].filter((a) => a.unknown).length;
  return { trades, errors, skipped, actionsFound, unknownActions, rowOrder, filterValues };
}

interface RowInput {
  rowIndex: number;
  date: IsoDate;
  action: string;
  description: string;
  symbolRaw: string;
  nameRaw: string;
  cusipRaw: string;
  quantityText: string;
  priceText: string;
  amountText: string;
  invert: boolean;
  feeTexts: string[];
  fileId: string | null;
  splitChoice: { num: number; den: number } | undefined;
  mapping: TradesCsvMapping;
  noteAction: (action: string, rowIndex: number, kind: TradeKind | undefined, fromProfile: boolean) => void;
}

function mapTradeRow(r: RowInput): RowOutcome {
  const { rowIndex, date, mapping } = r;
  const rawDescription = sanitizeText(`${r.action} ${r.description}`.trim(), 500);
  const fail = (code: string, message: string): RowOutcome => ({ kind: "error", error: { rowIndex, code, message } });

  const quantityCell = decimalCell(r.quantityText);
  if (quantityCell === null) return fail("unreadable_quantity", `Unreadable quantity "${sanitizeText(r.quantityText, 50)}"`);
  const Q = quantityCell === undefined ? undefined : abs(quantityCell);
  const priceCell = decimalCell(r.priceText);
  if (priceCell === null) return fail("unreadable_price", `Unreadable price "${sanitizeText(r.priceText, 50)}"`);
  const P = priceCell === undefined ? undefined : abs(priceCell);
  let A: bigint | undefined;
  if (r.amountText !== "") {
    A = parseLooseMoney(r.amountText);
    if (A === undefined) return fail("unreadable_amount", `Unreadable amount "${sanitizeText(r.amountText, 50)}"`);
    if (r.invert) A = -A;
  }
  let F = 0n;
  for (const feeText of r.feeTexts) {
    if (feeText === "") continue;
    const fee = parseLooseMoney(feeText);
    if (fee === undefined) return fail("unreadable_fee", `Unreadable fee "${sanitizeText(feeText, 50)}"`);
    F += abs(fee);
  }

  const hasQuantity = Q !== undefined && Q !== 0n;
  const amountSign: -1 | 0 | 1 | null = A === undefined ? null : A < 0n ? -1 : A > 0n ? 1 : 0;
  const ticker = normalizeTicker(r.symbolRaw);
  const name = r.nameRaw || (ticker === null && r.symbolRaw ? r.symbolRaw : "");
  const cusip = normalizeCusip(r.cusipRaw);
  const hasIdentity = r.symbolRaw !== "" || r.nameRaw !== "" || cusip !== null;
  const fromProfile = lookupActionMap(r.action, mapping.actionMap) !== undefined;
  const classifyRow: ClassifyRow = { hasQuantity, amountSign, securityName: r.nameRaw, ticker };
  const kind = classifyTradeAction(r.action, r.description, classifyRow, mapping);
  r.noteAction(r.action, rowIndex, kind, fromProfile);
  if (kind === undefined) return { kind: "unclassified" };
  if (kind === "skip") return { kind: "skipped", skip: { rowIndex, reason: "skip", text: rawDescription } };

  const text = upper(rawDescription);
  const securityKey = tradeSecurityKey({ ticker: r.symbolRaw, cusip: r.cusipRaw, name: r.nameRaw });
  const base: DraftBase = { rowIndex, date, kind, ticker, name: name || null, cusip, feeCents: F, splitNum: null, splitDen: null, transferDirection: null, rawDescription, securityKey, fileId: r.fileId };
  const one = (t: Omit<TradeDraft, keyof DraftBase> & Partial<DraftBase>): RowOutcome => ({ kind: "trades", trades: [{ ...base, ...t }] });

  switch (kind) {
    case "buy":
    case "sell":
    case "reinvest":
    case "reinvest_combined": {
      if (!hasIdentity) return fail("security_required", "A security is required for a trade");
      if (!hasQuantity) return fail("quantity_required", `A ${kind === "sell" ? "sell" : "buy"} needs a quantity greater than zero`);
      const q = Q!;
      const isSell = kind === "sell";
      const derived: Array<"amount" | "price"> = [];
      const warnings: string[] = [];
      let amountCents: bigint;
      let price: Fixed8 | null;
      if (A === undefined && P === undefined) return fail("amount_or_price_required", "An amount or a price is required with a quantity");
      if (A === undefined) {
        const gross = mulToCents(q, P!);
        amountCents = isSell ? gross - F : -(gross + F);
        price = P!;
        derived.push("amount");
      } else {
        const a = abs(A);
        if (mapping.amountIncludesFees) amountCents = isSell ? a : -a;
        else amountCents = isSell ? a - F : -(a + F);
        if (P === undefined) {
          const gross = isSell ? amountCents + F : abs(amountCents) - F;
          price = gross > 0n ? impliedPrice(gross, q) : null;
          derived.push("price");
        } else {
          price = P;
          if (amountMismatch(q, P, F, amountCents).mismatch) warnings.push("amount_mismatch");
        }
      }
      if (kind === "reinvest_combined") {
        const cost = abs(amountCents);
        return {
          kind: "trades",
          trades: [
            { ...base, type: "dividend", quantity: null, price: null, amountCents: cost, feeCents: 0n, derived: derived.includes("amount") ? ["amount"] : [], warnings: [] },
            { ...base, type: "reinvest", quantity: q, price, amountCents: -cost, derived, warnings },
          ],
        };
      }
      return one({ type: KIND_TYPE[kind], quantity: q, price, amountCents, derived, warnings });
    }
    case "dividend":
    case "interest": {
      if (kind === "dividend" && !hasIdentity) return fail("security_required", "A dividend needs a security (map the action to interest if it is cash interest)");
      if (A === undefined) return fail("amount_required", `A ${kind} needs an amount`);
      const warnings: string[] = [];
      let amountCents = abs(A);
      if (A < 0n) {
        if (REVERSAL_RE.test(text)) amountCents = A;
        else warnings.push("sign_forced");
      }
      return one({ type: kind, quantity: null, price: null, amountCents, derived: [], warnings });
    }
    case "fee": {
      let amountCents: bigint;
      const derived: Array<"amount" | "price"> = [];
      if (A !== undefined) amountCents = -abs(A);
      else if (F > 0n) {
        amountCents = -F;
        derived.push("amount");
      } else return fail("amount_required", "A fee needs an amount");
      return one({ type: "fee", quantity: null, price: null, amountCents, derived, warnings: [] });
    }
    case "split": {
      if (!hasIdentity) return fail("security_required", "A split needs a security");
      const ratio = parseSplitRatio(text) ?? r.splitChoice;
      if (!ratio) return fail("split_ratio_required", "The split ratio (new for old) is not in the text; choose it in the preview");
      return one({ type: "split", quantity: hasQuantity ? Q! : null, price: null, amountCents: 0n, feeCents: 0n, splitNum: ratio.num, splitDen: ratio.den, derived: [], warnings: [] });
    }
    case "transfer_in":
    case "transfer_out": {
      if (!hasIdentity) return fail("security_required", "A securities transfer needs a security");
      if (!hasQuantity) return fail("quantity_required", "A securities transfer needs a quantity greater than zero");
      return one({ type: "transfer", quantity: Q!, price: P ?? null, amountCents: 0n, transferDirection: kind === "transfer_in" ? "in" : "out", derived: [], warnings: [] });
    }
    case "cash_in":
    case "cash_out": {
      if (A === undefined) return fail("amount_required", "A cash transfer needs an amount");
      const warnings: string[] = [];
      // The text named both directions and the file's sign chose: the preview says so.
      if (!fromProfile && classifyCash(classificationText(r.action, r.description, classifyRow), amountSign)?.bySign) warnings.push("direction_from_sign");
      return one({
        type: "transfer",
        ticker: null,
        name: null,
        cusip: null,
        securityKey: "cash",
        quantity: null,
        price: null,
        amountCents: kind === "cash_in" ? abs(A) : -abs(A),
        transferDirection: kind === "cash_in" ? "in" : "out",
        derived: [],
        warnings,
      });
    }
  }
}

const TRD_DATE_HEADERS = ["run date", "trade date", "transaction date", "activity date", "date"];
const TRD_ACTION_HEADERS = ["action", "activity", "transaction type", "type"];
const TRD_SYMBOL_HEADERS = ["symbol", "ticker"];
const TRD_NAME_HEADERS = ["description", "investment name", "security description", "security", "name"];
const TRD_QUANTITY_HEADERS = ["quantity", "shares", "units", "qty"];
const TRD_PRICE_HEADERS = ["price ($)", "price", "unit price", "share price"];
const TRD_AMOUNT_HEADERS = ["amount ($)", "net amount", "amount", "total", "net"];
const TRD_PRINCIPAL_HEADERS = ["principal amount", "principal"];
const TRD_FEE_HEADERS = ["commission ($)", "commission", "fees ($)", "fees", "fees & comm"];
const TRD_ID_HEADERS = ["transaction id", "reference", "confirmation", "id"];
const TRD_CUSIP_HEADERS = ["cusip"];

/** Guess a trades mapping from the header row and a few sample rows; undefined without a date, an action and an identity column. */
export function guessTradesMapping(headers: readonly string[], samples: readonly string[][]): TradesCsvMappingInput | undefined {
  const date = findHeader(headers, TRD_DATE_HEADERS);
  const action = findHeader(headers, TRD_ACTION_HEADERS, ["action", "activity", "transaction type"]);
  if (!date || !action) return undefined;
  const symbol = findHeader(headers, TRD_SYMBOL_HEADERS);
  const name = findHeader(headers, TRD_NAME_HEADERS);
  if (!symbol && !name) return undefined;
  const dateIdx = headers.indexOf(date);
  const mapping: TradesCsvMappingInput = {
    hasHeader: true,
    date: { column: date, format: guessDateFormat(samples.map((r) => r[dateIdx] ?? "")) },
    action: { column: action },
  };
  if (symbol) mapping.symbol = { column: symbol };
  if (name && name !== action && name !== symbol) mapping.name = { column: name };
  const cusip = findHeader(headers, TRD_CUSIP_HEADERS);
  if (cusip) mapping.cusip = { column: cusip };
  const quantity = findHeader(headers, TRD_QUANTITY_HEADERS);
  if (quantity) mapping.quantity = { column: quantity };
  const price = findHeader(headers, TRD_PRICE_HEADERS);
  if (price) mapping.price = { column: price };
  // A net amount (fees inside) by exact header first; a principal column means fees are separate; then a looser match.
  const amount = findHeader(headers, TRD_AMOUNT_HEADERS, []);
  const principal = amount ? undefined : findHeader(headers, TRD_PRINCIPAL_HEADERS);
  const loose = amount || principal ? undefined : findHeader(headers, TRD_AMOUNT_HEADERS);
  if (amount || loose) {
    mapping.amount = { column: (amount ?? loose)!, invert: false };
    mapping.amountIncludesFees = true;
  } else if (principal) {
    mapping.amount = { column: principal, invert: false };
    mapping.amountIncludesFees = false;
  }
  const fees = headers.filter((h) => {
    const l = h.trim().toLowerCase();
    return TRD_FEE_HEADERS.includes(l) || l.startsWith("commission") || l.startsWith("fee");
  });
  if (fees.length > 0) mapping.fee = { columns: fees };
  const id = findHeader(headers, TRD_ID_HEADERS, ["transaction id", "reference", "confirmation"]);
  if (id) mapping.externalId = { column: id };
  const account = findHeader(headers, ACCOUNT_HEADERS);
  if (account) mapping.accountFilter = { column: account };
  return mapping;
}
