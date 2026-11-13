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
  /**
   * Two legs the household said are not one transfer ("transfer · undo"): they never pair
   * with each other again, though each may still pair with another leg (audit
   * a5-ingest-transfers-04). Called with (outflow id, inflow id).
   */
  isDismissed?: (outflowId: string, inflowId: string) => boolean;
}

function byDateThenId(a: TransferCandidate, b: TransferCandidate): number {
  return compareIsoDate(a.date, b.date) || a.id.localeCompare(b.id);
}

/**
 * Deterministic pairing with as many pairs as the legs allow. Within each amount, outflows are
 * visited in date order and each takes the unpaired inflow of opposite amount in another
 * account with the smallest date distance (earliest date, then id, on ties). When every inflow
 * it can reach is taken, an earlier outflow gives its inflow up if it can take another one
 * within the window (an augmenting path), so a same-day checking -> savings -> brokerage move
 * pairs both hops whatever the row ids are (audit a5-ingest-transfers-10). Each transaction
 * pairs once. Pairs come out in the outflows' date order.
 */
export function pairTransfers(candidates: readonly TransferCandidate[], options: PairTransfersOptions = {}): TransferPair[] {
  const maxDays = options.maxDays ?? 3;
  const isDismissed = options.isDismissed ?? (() => false);
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

  // Each outflow's reachable inflows, best first (closest date, then earliest, then id).
  const options_ = new Map<string, TransferCandidate[]>();
  for (const out of outflows) {
    const matches = inflowsByAmount.get((-out.amountCents).toString()) ?? [];
    const reachable = matches
      .filter((inflow) => inflow.accountId !== out.accountId && Math.abs(dayDiff(out.date, inflow.date)) <= maxDays && !isDismissed(out.id, inflow.id))
      .map((inflow) => ({ inflow, distance: Math.abs(dayDiff(out.date, inflow.date)) }))
      .sort((a, b) => a.distance - b.distance || byDateThenId(a.inflow, b.inflow))
      .map((x) => x.inflow);
    options_.set(out.id, reachable);
  }

  const outflowOf = new Map<string, string>(); // inflow id -> outflow id
  const inflowOf = new Map<string, string>(); // outflow id -> inflow id
  const assign = (outId: string, inId: string) => {
    outflowOf.set(inId, outId);
    inflowOf.set(outId, inId);
  };
  // The closest free inflow first, as a greedy pass takes it; only when none is free, a path
  // that moves an outflow already paired to another inflow it can reach.
  const tryAssign = (outId: string, visited: Set<string>): boolean => {
    const reachable = options_.get(outId) ?? [];
    const free = reachable.find((inflow) => !visited.has(inflow.id) && !outflowOf.has(inflow.id));
    if (free) {
      assign(outId, free.id);
      return true;
    }
    for (const inflow of reachable) {
      if (visited.has(inflow.id)) continue;
      visited.add(inflow.id);
      const holder = outflowOf.get(inflow.id);
      if (holder !== undefined && tryAssign(holder, visited)) {
        assign(outId, inflow.id);
        return true;
      }
    }
    return false;
  };
  for (const out of outflows) tryAssign(out.id, new Set());

  const pairs: TransferPair[] = [];
  for (const out of outflows) {
    const inflowId = inflowOf.get(out.id);
    if (inflowId !== undefined) pairs.push({ outflowId: out.id, inflowId });
  }
  return pairs;
}
