import { addDays, engineWarningSentence, formatFixed8, isIsoDate, parseFixed8, type EngineWarning } from "@meridian/shared";
import type { EngineWarningView, GainTerm, LotDisposalView, LotView } from "@meridian/shared";

/**
 * Pure helpers for the two views of the lot engine's results that the spec's "lots and cost
 * basis … unrealized and realized gains" asks for (audit finding b9-conformance-plan-investments-01;
 * Phase 3 plan audit decision A21): the Holdings page's lots drawer (GET /investments/lots) and the
 * Realized gains page (GET /investments/realized). No React, no DOM; cents stay strings.
 */

// ---- Lots drawer ----

export interface DrawerLots {
  /** The lots open at the end of `asOf`, oldest first. */
  open: LotView[];
  /** The lots closed on or before `asOf`, newest close first. */
  closed: LotView[];
  /** Σ over the open lots (quantity as Fixed8 text, cents as strings; basis and gain over known-basis lots only). */
  totals: { quantity: string; basisCents: string; valueCents: string | null; gainCents: string | null; unknownBasisLots: number };
}

const byAcquired = (a: LotView, b: LotView): number => (a.acquiredDate < b.acquiredDate ? -1 : a.acquiredDate > b.acquiredDate ? 1 : a.ordinal - b.ordinal);

/** One security's lots in one account, split into open and closed, with the open lots' totals. */
export function drawerLots(lots: readonly LotView[], accountId: string, securityId: string): DrawerLots {
  const own = lots.filter((l) => l.accountId === accountId && l.securityId === securityId);
  const open = own.filter((l) => l.closedDate === null && parseFixed8(l.quantity) > 0n).sort(byAcquired);
  const closed = own.filter((l) => !open.includes(l)).sort((a, b) => ((a.closedDate ?? "") > (b.closedDate ?? "") ? -1 : (a.closedDate ?? "") < (b.closedDate ?? "") ? 1 : byAcquired(a, b)));
  let quantity = 0n;
  let basis = 0n;
  let value: bigint | null = 0n;
  let gain: bigint | null = 0n;
  let unknown = 0;
  for (const l of open) {
    quantity += parseFixed8(l.quantity);
    if (value !== null) value = l.valueCents === null ? null : value + BigInt(l.valueCents);
    if (!l.basisKnown || l.costBasisCents === null) {
      unknown++;
      continue;
    }
    basis += BigInt(l.costBasisCents);
    if (gain !== null) gain = l.unrealizedCents === null ? null : gain + BigInt(l.unrealizedCents);
  }
  return {
    open,
    closed,
    totals: { quantity: formatFixed8(quantity), basisCents: basis.toString(), valueCents: value === null ? null : value.toString(), gainCents: open.length === 0 ? "0" : gain === null ? null : gain.toString(), unknownBasisLots: unknown },
  };
}

const TERM_LABELS: Record<GainTerm, string> = { short: "Short", long: "Long", unknown: "Unknown", none: "—" };

/** "Short", "Long", "Unknown" (no acquisition date), "—" (no gain to classify). */
export function termLabel(term: GainTerm): string {
  return TERM_LABELS[term];
}

/** How a lot was opened, for the drawer's first column. */
export function openedByLabel(l: Pick<LotView, "openedBy">): string {
  return l.openedBy === "buy" ? "buy" : l.openedBy === "reinvest" ? "reinvested dividend" : "transfer in";
}

/** The engine's warnings about one security in one account, as sentences (audit decision A15's wording). */
export function securityWarnings(warnings: readonly EngineWarningView[], securityId: string, securityName: string): string[] {
  return warnings.filter((w) => w.securityId === securityId).map((w) => engineWarningSentence(engineWarning(w), () => securityName));
}

function engineWarning(w: EngineWarningView): EngineWarning {
  const out: EngineWarning = { code: w.code };
  if (w.accountId !== undefined) out.accountId = w.accountId;
  if (w.securityId !== undefined) out.securityId = w.securityId;
  if (w.txnId !== undefined) out.txnId = w.txnId;
  if (w.date !== undefined) out.date = w.date;
  if (w.priceDate !== undefined) out.priceDate = w.priceDate;
  if (w.quantity !== undefined) out.quantity = parseFixed8(w.quantity);
  if (w.lotsQuantity !== undefined) out.lotsQuantity = parseFixed8(w.lotsQuantity);
  if (w.snapshotQuantity !== undefined) out.snapshotQuantity = parseFixed8(w.snapshotQuantity);
  if (w.diffCents !== undefined) out.diffCents = BigInt(w.diffCents);
  if (w.detail !== undefined) out.detail = w.detail;
  return out;
}

// ---- Realized gains ----

export interface RealizedRange {
  /** "2026", or "custom". */
  choice: string;
  /** The route's window is `(from, to]`: `from` is the day before the first day shown. */
  from: string;
  to: string;
  /** The first day shown (from + 1). */
  first: string;
  label: string;
}

/** The calendar years offered: this year and the `count − 1` before it. */
export function realizedYears(today: string, count = 8): string[] {
  const year = Number(today.slice(0, 4));
  return Array.from({ length: count }, (_, i) => String(year - i));
}

/**
 * The period from the URL: `?year=YYYY` (default this year: Jan 1 through Dec 31, the tax year), or
 * `?from=&to=` (first and last day shown, `from ≤ to ≤ today`). A bad custom range falls back to this year.
 */
export function realizedRange(params: URLSearchParams, today: string): RealizedRange {
  const from = params.get("from");
  const to = params.get("to");
  if (from !== null && to !== null && isIsoDate(from) && isIsoDate(to) && from <= to && to <= today && from >= "1900-01-02") {
    return { choice: "custom", from: addDays(from, -1), to, first: from, label: `${from} to ${to}` };
  }
  const yearParam = params.get("year");
  const year = yearParam !== null && /^\d{4}$/.test(yearParam) && yearParam >= "1900" && yearParam <= today.slice(0, 4) ? yearParam : today.slice(0, 4);
  return { choice: year, from: `${Number(year) - 1}-12-31`, to: `${year}-12-31`, first: `${year}-01-01`, label: year === today.slice(0, 4) ? `${year} so far` : year };
}

/** A disposal's flag beside its gain: unmatched sales, unknown basis and transfers out are not ordinary realized gains. */
export function disposalNote(d: Pick<LotDisposalView, "kind" | "basisKnown">): string | null {
  if (d.kind === "unmatched_sell") return "no matching purchase";
  if (d.kind === "transfer_out") return "transferred out, not a sale";
  if (!d.basisKnown) return "basis unknown";
  return null;
}

/** The disposals that are sales (the table's main rows); transfers out are listed apart. */
export function splitDisposals(disposals: readonly LotDisposalView[]): { sales: LotDisposalView[]; transfers: LotDisposalView[] } {
  return { sales: disposals.filter((d) => d.kind !== "transfer_out"), transfers: disposals.filter((d) => d.kind === "transfer_out") };
}
