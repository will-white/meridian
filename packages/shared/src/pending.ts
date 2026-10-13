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

export interface MatchPendingOptions {
  /** Maximum calendar days between the pending date and the posted date. Default 5. */
  maxDays?: number;
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
 * Returns a map of posted external id -> local pending row id. Greedy: posted
 * items are visited in date order; each takes the best unmatched pending row with
 * the same amount within the window, scoring description similarity first and
 * date distance second. Equal amount is required; similarity may be 0 when the
 * amount and window alone identify the item (one pending charge of that size).
 */
export function matchPendingToPosted(
  pending: readonly PendingRow[],
  posted: readonly PostedIncoming[],
  options: MatchPendingOptions = {},
): Map<string, string> {
  const maxDays = options.maxDays ?? 5;
  const byAmount = new Map<string, PendingRow[]>();
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
    let best: PendingRow | undefined;
    let bestScore = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const row of list) {
      if (used.has(row.id)) continue;
      const distance = Math.abs(dayDiff(row.date, item.date));
      if (distance > maxDays) continue;
      const score = descriptionSimilarity(row.description, item.description);
      if (score > bestScore || (score === bestScore && distance < bestDistance)) {
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
  return result;
}
