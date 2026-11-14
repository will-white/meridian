import { compareIsoDate, dayDiff, type IsoDate } from "./dates.js";
import { normalizePayee } from "./payee.js";

/**
 * Pending transactions usually post later under a different id, often with a
 * slightly different description and date. When a posted item arrives whose id
 * we have not seen, we look for a local pending row to replace instead of
 * inserting a duplicate.
 */

export interface PendingRow {
  id: string;
  amountCents: bigint;
  date: IsoDate;
  description: string;
}

export interface PostedIncoming {
  externalId: string;
  amountCents: bigint;
  date: IsoDate;
  description: string;
}

export interface MatchPendingOptions<R extends PendingRow = PendingRow, P extends PostedIncoming = PostedIncoming> {
  /** Maximum days between the pending date and the posted date (as `dayDistance` counts them). Default 5. */
  maxDays?: number;
  /**
   * Days between a row and an item, for the window and the closest-date tie-break. Default: the
   * calendar days between their dates. A caller that knows more about the two dates passes its
   * own (audit a5-ingest-transfers-01, second round): a bank's file dates a purchase by the day
   * it posted, the feed by the day it was made, so across sources the posting day counts too; a
   * distance above `maxDays` (`Infinity` included) keeps the two apart.
   */
  dayDistance?: (row: R, item: P) => number;
  /**
   * Also match a posted amount that differs from the pending one (a tip added, a hold that
   * settled for another amount): same direction, at most half again either way, and a strong
   * description match (`STRONG_SIMILARITY`). Default true; duplicate detection across sources
   * turns it off, because two rows of one purchase always carry the same amount.
   */
  changedAmounts?: boolean;
  /** The least description similarity for an equal amount (always above 0). Default: anything above 0. */
  minSimilarity?: number;
}

/** A description match strong enough to accept a changed amount (audit a5-ingest-transfers-06). */
export const STRONG_SIMILARITY = 0.5;

/** Same direction, and the posted amount within half of the pending amount either way (50% to 150%). */
export function isChangedAmountMatch(pendingCents: bigint, postedCents: bigint): boolean {
  if (pendingCents === postedCents || pendingCents === 0n || postedCents === 0n) return false;
  if (pendingCents < 0n !== postedCents < 0n) return false;
  const p = pendingCents < 0n ? -pendingCents : pendingCents;
  const q = postedCents < 0n ? -postedCents : postedCents;
  return 2n * q >= p && 2n * q <= 3n * p;
}

function tokens(text: string): Set<string> {
  return new Set(
    normalizePayee(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1),
  );
}

/** 0..1 similarity: 1 for an identical normalized payee, else token overlap. */
export function descriptionSimilarity(a: string, b: string): number {
  const na = normalizePayee(a).toLowerCase();
  const nb = normalizePayee(b).toLowerCase();
  if (na && na === nb) return 1;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Returns a map of posted external id -> local pending row id. Greedy: posted items are visited
 * in date order; each takes the best unmatched pending row within the window, scoring
 * description similarity first and date distance second. Two passes:
 *
 * 1. Equal amount, and the descriptions share something (similarity above 0): a row whose
 *    description has nothing in common with the posted item is another purchase, whatever its
 *    amount (audit a5-ingest-transfers-07).
 * 2. Unless `changedAmounts` is false, the posted items still unmatched may take a row of the
 *    same merchant (similarity at least `STRONG_SIMILARITY`) whose amount is within half of
 *    theirs in the same direction: a tip, or a hold that settled for another amount (audit
 *    a5-ingest-transfers-06). The closest amount wins, then the date.
 */
export function matchPendingToPosted<R extends PendingRow, P extends PostedIncoming>(
  pending: readonly R[],
  posted: readonly P[],
  options: MatchPendingOptions<R, P> = {},
): Map<string, string> {
  const maxDays = options.maxDays ?? 5;
  const minSimilarity = options.minSimilarity ?? 0;
  const days = options.dayDistance ?? ((row: R, item: P) => Math.abs(dayDiff(row.date, item.date)));
  const byAmount = new Map<string, R[]>();
  for (const p of pending) {
    const list = byAmount.get(p.amountCents.toString()) ?? [];
    list.push(p);
    byAmount.set(p.amountCents.toString(), list);
  }
  const used = new Set<string>();
  const result = new Map<string, string>();
  const ordered = [...posted].sort((a, b) => compareIsoDate(a.date, b.date) || a.externalId.localeCompare(b.externalId));

  for (const item of ordered) {
    const list = byAmount.get(item.amountCents.toString());
    if (!list) continue;
    let best: R | undefined;
    let bestScore = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const row of list) {
      if (used.has(row.id)) continue;
      const distance = days(row, item);
      if (!(distance <= maxDays)) continue;
      const score = descriptionSimilarity(row.description, item.description);
      if (score < minSimilarity) continue;
      if (score > bestScore || (score === bestScore && score > 0 && distance < bestDistance)) {
        best = row;
        bestScore = score;
        bestDistance = distance;
      }
    }
    if (best) {
      used.add(best.id);
      result.set(item.externalId, best.id);
    }
  }
  if (options.changedAmounts === false) return result;

  const abs = (v: bigint) => (v < 0n ? -v : v);
  for (const item of ordered) {
    if (result.has(item.externalId)) continue;
    let best: R | undefined;
    let bestScore = 0;
    let bestGap = 0n;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const row of pending) {
      if (used.has(row.id) || !isChangedAmountMatch(row.amountCents, item.amountCents)) continue;
      const distance = days(row, item);
      if (!(distance <= maxDays)) continue;
      const score = descriptionSimilarity(row.description, item.description);
      if (score < STRONG_SIMILARITY) continue;
      const gap = abs(row.amountCents - item.amountCents);
      const better = !best || score > bestScore || (score === bestScore && (gap < bestGap || (gap === bestGap && distance < bestDistance)));
      if (better) {
        best = row;
        bestScore = score;
        bestGap = gap;
        bestDistance = distance;
      }
    }
    if (best) {
      used.add(best.id);
      result.set(item.externalId, best.id);
    }
  }
  return result;
}
