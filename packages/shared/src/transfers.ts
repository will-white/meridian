import { compareIsoDate, dayDiff, type IsoDate } from "./dates.js";

/**
 * Transfer pairing: an outflow and an inflow of equal amount, in two different
 * accounts of the household, within `maxDays` of each other, are one transfer.
 * Credit card payments and moves into savings or brokerage accounts pair this way
 * and leave the budget.
 */

export interface TransferCandidate {
  id: string;
  accountId: string;
  date: IsoDate;
  amountCents: bigint;
}

export interface TransferPair {
  outflowId: string;
  inflowId: string;
}

export interface PairTransfersOptions {
  /** Maximum calendar days between the two legs. Default 3. */
  maxDays?: number;
}

function byDateThenId(a: TransferCandidate, b: TransferCandidate): number {
  return compareIsoDate(a.date, b.date) || a.id.localeCompare(b.id);
}

/**
 * Greedy, deterministic pairing. Outflows are visited in date order; each takes
 * the unpaired inflow of opposite amount in another account with the smallest
 * date distance (earliest date, then id, on ties). Each transaction pairs once.
 */
export function pairTransfers(candidates: readonly TransferCandidate[], options: PairTransfersOptions = {}): TransferPair[] {
  const maxDays = options.maxDays ?? 3;
  const outflows = candidates.filter((c) => c.amountCents < 0n).sort(byDateThenId);
  const inflowsByAmount = new Map<string, TransferCandidate[]>();
  for (const c of candidates) {
    if (c.amountCents <= 0n) continue;
    const key = c.amountCents.toString();
    const list = inflowsByAmount.get(key) ?? [];
    list.push(c);
    inflowsByAmount.set(key, list);
  }
  for (const list of inflowsByAmount.values()) list.sort(byDateThenId);

  const used = new Set<string>();
  const pairs: TransferPair[] = [];

  for (const out of outflows) {
    const matches = inflowsByAmount.get((-out.amountCents).toString());
    if (!matches) continue;
    let best: TransferCandidate | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const inflow of matches) {
      if (used.has(inflow.id) || inflow.accountId === out.accountId) continue;
      const distance = Math.abs(dayDiff(out.date, inflow.date));
      if (distance > maxDays) continue;
      if (distance < bestDistance) {
        best = inflow;
        bestDistance = distance;
      }
    }
    if (best) {
      used.add(best.id);
      used.add(out.id);
      pairs.push({ outflowId: out.id, inflowId: best.id });
    }
  }
  return pairs;
}
