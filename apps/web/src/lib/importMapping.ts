import { matchesToDollar } from "@meridian/shared";
import type {
  ActionFoundView,
  ColumnRef,
  CsvDateFormat,
  CsvKind,
  MappedTradeView,
  PositionsCsvMapping,
  PositionsImportResult,
  PositionsPreviewResponse,
  PreviewSecurityRef,
  TradeKind,
  TradesCsvMapping,
  TradesImportResult,
  TradesPreviewResponse,
} from "@meridian/shared";
import { money, shortDate } from "./format.js";
import type { BadgeTone } from "./investments.js";

/**
 * Pure helpers for the Import page's positions and trades flows (imports
 * design §3.6–§3.9, §5): the hand-built starting mappings, the optional-column
 * edits the mapping editors make, the client-side validation that mirrors the
 * Zod refinements, the action map edits, and the sentences the previews and
 * results show. The server guesses the mapping (`guessPositionsMapping`,
 * `guessTradesMapping` in packages/shared); these helpers only edit and check
 * what it returned. No React, no DOM.
 */

// ---- Kinds ----

export const CSV_KINDS: ReadonlyArray<readonly [CsvKind, string]> = [
  ["bank", "Bank transactions"],
  ["positions", "Brokerage positions"],
  ["trades", "Trade history"],
];

export function csvKindLabel(kind: CsvKind): string {
  return CSV_KINDS.find(([k]) => k === kind)?.[1] ?? kind;
}

/** `?kind=` in the URL; anything else is the bank flow. */
export function csvKindFromParam(raw: string | null): CsvKind {
  return raw === "positions" || raw === "trades" ? raw : "bank";
}

// ---- Columns ----

/** A column reference as a select value (headers by name, header-less files by index). */
export function columnValue(ref: ColumnRef | undefined): string {
  return ref === undefined ? "" : String(ref);
}

/** A select value back to a column reference: a header name, or the index when the file has no header row. */
export function columnRef(value: string, hasHeader: boolean): ColumnRef {
  return hasHeader || !/^\d+$/.test(value) ? value : Number(value);
}

export type PositionsColumnKey = "symbol" | "name" | "cusip" | "quantity" | "price" | "value" | "costBasis" | "accountFilter";
export type TradesColumnKey = "symbol" | "name" | "cusip" | "quantity" | "price" | "externalId" | "description" | "accountFilter";

export const POSITIONS_COLUMNS: ReadonlyArray<readonly [PositionsColumnKey, string, string]> = [
  ["symbol", "Symbol column", "ticker; symbol or name is required"],
  ["name", "Name column", "security description; symbol or name is required"],
  ["cusip", "CUSIP column", "optional"],
  ["quantity", "Quantity column", "shares; with price when there is no value column"],
  ["price", "Price column", "with quantity when there is no value column"],
  ["value", "Value column", "market value; or quantity and price"],
  ["costBasis", "Cost basis column", "optional, shown from the statement"],
  ["accountFilter", "Account column", "optional: a file covering several accounts"],
];

export const TRADES_COLUMNS: ReadonlyArray<readonly [TradesColumnKey, string, string]> = [
  ["symbol", "Symbol column", "ticker; symbol or name is required"],
  ["name", "Name column", "security description; symbol or name is required"],
  ["cusip", "CUSIP column", "optional"],
  ["quantity", "Quantity column", "shares (sells may be negative in the file)"],
  ["price", "Price column", "per share"],
  ["externalId", "Transaction id column", "optional: the broker's id makes re-imports exact"],
  ["description", "Description column", "optional: kept with the row"],
  ["accountFilter", "Account column", "optional: a file covering several accounts"],
];

/** A first mapping when the server could not guess one: symbol in the first column, value in the last, the date from the request. */
export function handBuiltPositionsMapping(headers: readonly string[]): PositionsCsvMapping {
  const first = headers[0] ?? 0;
  const last = headers[headers.length - 1] ?? 1;
  return { hasHeader: true, skipRows: 0, asOf: { mode: "request" }, symbol: { column: first }, value: { column: last } };
}

/** A first trades mapping: date, action and symbol in the first three columns, the amount in the last. */
export function handBuiltTradesMapping(headers: readonly string[]): TradesCsvMapping {
  const col = (i: number): ColumnRef => headers[i] ?? i;
  const last = headers[headers.length - 1] ?? 3;
  return {
    hasHeader: true,
    skipRows: 0,
    date: { column: col(0), format: "MM/DD/YYYY" },
    action: { column: col(1) },
    symbol: { column: col(2) },
    amount: { column: last, invert: false },
    amountIncludesFees: true,
    reinvestRows: "separate",
    rowOrder: "auto",
    actionMap: {},
  };
}

/** Sets or (with "") clears one optional column of a positions mapping. */
export function setPositionsColumn(mapping: PositionsCsvMapping, key: PositionsColumnKey, value: string): PositionsCsvMapping {
  const { [key]: _drop, ...rest } = mapping;
  return value === "" ? rest : { ...rest, [key]: { column: columnRef(value, mapping.hasHeader) } };
}

/** Sets or clears one optional column of a trades mapping. */
export function setTradesColumn(mapping: TradesCsvMapping, key: TradesColumnKey, value: string): TradesCsvMapping {
  const { [key]: _drop, ...rest } = mapping;
  return value === "" ? rest : { ...rest, [key]: { column: columnRef(value, mapping.hasHeader) } };
}

/** The as-of date: a column with a format, or the request's date. */
export function setPositionsAsOf(mapping: PositionsCsvMapping, value: string, format: CsvDateFormat): PositionsCsvMapping {
  if (value === "") return { ...mapping, asOf: { mode: "request" } };
  return { ...mapping, asOf: { mode: "column", column: columnRef(value, mapping.hasHeader), format } };
}

/** The amount column (keeps `invert`); "" removes it so the amount is derived from quantity × price. */
export function setTradesAmount(mapping: TradesCsvMapping, value: string): TradesCsvMapping {
  const { amount, ...rest } = mapping;
  if (value === "") return rest;
  return { ...rest, amount: { column: columnRef(value, mapping.hasHeader), invert: amount?.invert ?? false } };
}

/** Adds or removes a fee column; the `fee` key goes when no column is left. */
export function toggleFeeColumn(mapping: TradesCsvMapping, value: string): TradesCsvMapping {
  const ref = columnRef(value, mapping.hasHeader);
  const current = mapping.fee?.columns ?? [];
  const next = current.some((c) => String(c) === String(ref)) ? current.filter((c) => String(c) !== String(ref)) : [...current, ref];
  const { fee: _drop, ...rest } = mapping;
  return next.length === 0 ? rest : { ...rest, fee: { columns: next } };
}

export function hasFeeColumn(mapping: TradesCsvMapping, value: string): boolean {
  return (mapping.fee?.columns ?? []).some((c) => String(c) === value);
}

/** Maps an action key to a kind (`null` forgets the entry so the regex classifier applies again). */
export function setActionKind(mapping: TradesCsvMapping, key: string, kind: TradeKind | null): TradesCsvMapping {
  const { [key]: _drop, ...rest } = mapping.actionMap;
  return { ...mapping, actionMap: kind === null ? rest : { ...rest, [key]: kind } };
}

// ---- Validation (mirrors the Zod refinements, so the preview never 400s on a shape the editor allowed) ----

/** What stops a positions mapping from previewing; empty when it is complete. */
export function positionsMappingIssues(mapping: PositionsCsvMapping, asOfDate: string): string[] {
  const issues: string[] = [];
  if (!mapping.symbol && !mapping.name) issues.push("Pick a symbol or a name column.");
  if (!mapping.value && !(mapping.quantity && mapping.price)) issues.push("Pick a value column, or both a quantity and a price column.");
  if (mapping.asOf.mode === "request" && asOfDate === "") issues.push("The file has no date column: enter the statement date (a snapshot is never dated by the clock).");
  return issues;
}

/** What stops a trades mapping from previewing. */
export function tradesMappingIssues(mapping: TradesCsvMapping): string[] {
  const issues: string[] = [];
  if (!mapping.symbol && !mapping.name) issues.push("Pick a symbol or a name column.");
  if (String(mapping.date.column) === String(mapping.action.column)) issues.push("The date and action columns must differ.");
  if (!mapping.amount && !(mapping.quantity && mapping.price)) issues.push("Without an amount column, quantity and price are needed to derive it.");
  return issues;
}

// ---- Trade kinds and actions ----

const TRADE_KIND_LABELS: Record<TradeKind, string> = {
  buy: "Buy",
  sell: "Sell",
  dividend: "Dividend",
  interest: "Interest",
  reinvest: "Reinvest (purchase only)",
  reinvest_combined: "Reinvest (dividend + purchase)",
  fee: "Fee",
  split: "Split",
  transfer_in: "Shares transferred in",
  transfer_out: "Shares transferred out",
  cash_in: "Cash in (contribution)",
  cash_out: "Cash out (withdrawal)",
  skip: "Skip",
};

export const TRADE_KINDS: readonly TradeKind[] = Object.keys(TRADE_KIND_LABELS) as TradeKind[];

export function tradeKindLabel(kind: TradeKind): string {
  return TRADE_KIND_LABELS[kind];
}

/** The actions the file uses, unknown ones first, then by count descending. */
export function sortActions(actions: readonly ActionFoundView[]): ActionFoundView[] {
  return [...actions].sort((a, b) => {
    if ((a.kind === null) !== (b.kind === null)) return a.kind === null ? -1 : 1;
    return b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
}

/** "3 rows were not recognised; map them or skip them". */
export function unknownActionsText(unknown: number): string | null {
  if (unknown === 0) return null;
  return `${unknown} row${unknown === 1 ? " was" : "s were"} not recognised; map ${unknown === 1 ? "it" : "them"} or skip ${unknown === 1 ? "it" : "them"}.`;
}

/** "file is newest-first; imported oldest-first". */
export function rowOrderText(order: TradesPreviewResponse["rowOrder"]): string | null {
  if (order === null) return null;
  return order === "newest_first" ? "file is newest-first; imported oldest-first" : "file is oldest-first";
}

// ---- Preview rows ----

/** The badge beside a preview row's security: new (will be created), guessed (type and class to review), or cash. */
export function securityBadge(ref: PreviewSecurityRef): { text: string; tone: BadgeTone } | null {
  if (ref.isCash) return { text: "cash", tone: "neutral" };
  if (ref.isNew) return { text: "new", tone: "info" };
  if (ref.needsReview) return { text: "guessed", tone: "warn" };
  return null;
}

const WARNING_TEXTS: Record<string, string> = {
  amount_mismatch: "the amount differs from quantity × price (± fee) by more than 5 cents",
  value_rounded: "the value was rounded to cents",
  cost_unreadable: "the cost basis could not be read and was dropped",
  reinvest_without_dividend: "a reinvest row without a matching dividend; set reinvest rows to 'dividend + purchase' if this file combines them",
  non_usd: "a non-USD holding; only USD is supported",
  dollar_only: "value only: the row reports no share count",
  price_from_value: "the price was derived from the value",
  quantity_negative: "a negative quantity was read as positive",
  reversal: "a reversal: the sign was kept",
};

export function previewWarningText(code: string): string {
  return WARNING_TEXTS[code] ?? code.replace(/_/g, " ");
}

/** The ledger link of a trade row: "↔ ledger 09/16/26". */
export function ledgerMatchText(t: Pick<MappedTradeView, "ledgerMatch">): string | null {
  return t.ledgerMatch ? `↔ ledger ${shortDate(t.ledgerMatch.date)}` : null;
}

/** The marker on a trade row: duplicate rows are muted, changed rows marked, hand-edited rows kept. */
export function tradeRowMarker(t: Pick<MappedTradeView, "duplicate" | "changed" | "userEdited">): { text: string; tone: BadgeTone } | null {
  if (t.userEdited) return { text: "edited by hand, kept", tone: "neutral" };
  if (t.changed) return { text: "changed", tone: "warn" };
  if (t.duplicate) return { text: "already imported", tone: "neutral" };
  return null;
}

/** Rows grouped by date in the order the server returns them (oldest first after re-ordering). */
export function groupTradesByDate<T extends { date: string }>(rows: readonly T[]): Array<{ date: string; rows: T[] }> {
  const groups: Array<{ date: string; rows: T[] }> = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.date === r.date) last.rows.push(r);
    else groups.push({ date: r.date, rows: [r] });
  }
  return groups;
}

// ---- The reconciliation line and the snapshot bar ----

export interface ReconciliationLine {
  text: string;
  tone: BadgeTone;
}

/**
 * "Positions total $3,337.75 · Bridge balance $3,350.09 · difference $12.34"
 * in `ok` tone with "matches to the dollar" (plan decision 14) when
 * |difference| < $1, `warn` otherwise; null without a known balance.
 */
export function reconciliationLine(p: { totalValueCents: string; knownBalanceCents: string | null; differenceCents: string | null; matchesToDollar?: boolean | null }): ReconciliationLine | null {
  if (p.knownBalanceCents === null || p.differenceCents === null) return null;
  const diff = BigInt(p.differenceCents);
  const matches = p.matchesToDollar ?? matchesToDollar(diff);
  const base = `Positions total ${money(p.totalValueCents)} · Bridge balance ${money(p.knownBalanceCents)} · difference ${money(p.differenceCents)}`;
  if (diff === 0n) return { text: `${base} · exact`, tone: "ok" };
  return matches ? { text: `${base} · matches to the dollar`, tone: "ok" } : { text: base, tone: "warn" };
}

export interface SnapshotBar {
  text: string;
  tone: "warn" | "bad";
  /** True when the commit must be refused (a manual snapshot outranks a csv import). */
  blocks: boolean;
}

/** The yellow or red bar over a positions preview when a snapshot already exists for the date. */
export function snapshotBar(p: Pick<PositionsPreviewResponse, "snapshotExists" | "existingSource" | "willReplace" | "asOf">): SnapshotBar | null {
  if (!p.snapshotExists || p.asOf === null) return null;
  if (!p.willReplace || p.existingSource === "manual") {
    return { text: `A manual snapshot exists for ${p.asOf}; delete it on the account's positions tab first.`, tone: "bad", blocks: true };
  }
  return { text: `A ${p.existingSource ?? "stored"} snapshot for ${p.asOf} exists and will be replaced.`, tone: "warn", blocks: false };
}

// ---- Buttons and results ----

/** "Import 3 positions as of 2026-10-13". */
export function positionsCommitLabel(count: number, asOf: string | null): string {
  return `Import ${count} position${count === 1 ? "" : "s"}${asOf ? ` as of ${asOf}` : ""}`;
}

/** "Import 4 trades (6 already imported)". */
export function tradesCommitLabel(totalRows: number, duplicateCount: number): string {
  const fresh = Math.max(totalRows - duplicateCount, 0);
  const dup = duplicateCount > 0 ? ` (${duplicateCount} already imported)` : "";
  return `Import ${fresh} trade${fresh === 1 ? "" : "s"}${dup}`;
}

/** "Snapshot 2026-10-13: 3 positions (2 new, 1 updated), $3,337.75; 2 securities created; 3 implied prices; balance set." */
export function positionsResultText(r: PositionsImportResult): string {
  const parts = [`Snapshot ${r.asOf}: ${r.positions} position${r.positions === 1 ? "" : "s"} (${r.inserted} new, ${r.updated} updated, ${r.unchanged} unchanged${r.deleted > 0 ? `, ${r.deleted} removed` : ""}), ${money(r.totalValueCents)}`];
  if (r.securitiesCreated > 0) parts.push(`${r.securitiesCreated} securit${r.securitiesCreated === 1 ? "y" : "ies"} created`);
  if (r.impliedPrices > 0) parts.push(`${r.impliedPrices} implied price${r.impliedPrices === 1 ? "" : "s"}`);
  if (r.balanceWritten) parts.push("account balance set");
  const line = reconciliationLine(r);
  if (line) parts.push(line.text.toLowerCase());
  return `${parts.join("; ")}.`;
}

/** "Imported 4 trades, 2 unchanged, 1 kept as edited; 3 linked to ledger rows, 2 ledger rows created; 1 transfer paired; lots rebuilt for 1 account." */
export function tradesResultText(r: TradesImportResult): string {
  const parts = [`Imported ${r.created} trade${r.created === 1 ? "" : "s"}${r.updated > 0 ? `, ${r.updated} updated` : ""}${r.unchanged > 0 ? `, ${r.unchanged} unchanged` : ""}${r.skippedEdited > 0 ? `, ${r.skippedEdited} kept as edited` : ""}`];
  if (r.linked > 0 || r.ledgerCreated > 0) parts.push(`${r.linked} linked to ledger rows, ${r.ledgerCreated} ledger row${r.ledgerCreated === 1 ? "" : "s"} created`);
  if (r.transfersPaired > 0) parts.push(`${r.transfersPaired} transfer${r.transfersPaired === 1 ? "" : "s"} paired`);
  if (r.securitiesCreated > 0) parts.push(`${r.securitiesCreated} securit${r.securitiesCreated === 1 ? "y" : "ies"} created`);
  if (r.lotsRebuilt > 0) parts.push(`lots rebuilt for ${r.lotsRebuilt} account${r.lotsRebuilt === 1 ? "" : "s"}`);
  if (r.warnings.length > 0) parts.push(`${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}`);
  return `${parts.join("; ")}.`;
}
