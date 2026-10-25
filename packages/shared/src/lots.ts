import { dayDiff, type IsoDate } from "./dates.js";
import { allocateLargestRemainder, amountMismatch, formatFixed8, impliedPrice, mulToCents, roundDivHalfAway, scaleQty, type Fixed8 } from "./decimal.js";
import type { DisposalKind, EngineWarningCode, GainTerm, HoldingPriceSource, InvestmentTxnType, LotMethod, LotOpenedBy } from "./enums.js";
import { addMonthsClamped, monthKey, type MonthKey } from "./months.js";

/**
 * The lot engine (lots design §3.2–§3.5, §3.14–§3.17 under the Phase 3 plan's settlements).
 * Pure and deterministic: no clock, no DB, no randomness. One call builds every lot, disposal,
 * position checkpoint, cash effect and income row of ONE account from its investment
 * transactions; the DB service (`rebuildLots`) stores the result as a derived cache.
 *
 * Conventions fixed here (plan decisions 5 and 6; seams C3–C10, C48):
 *
 * - Quantities in the engine input are SIGNED: + shares into the account (buy, reinvest,
 *   transfer in), − shares out (sell, transfer out). The DB column is unsigned with a
 *   `transfer_direction`; the loader applies the sign.
 * - Same-day order is `(date, type rank, sequence, id)` with rank
 *   split 0 < transfer in 1 < buy 2 < reinvest 3 < dividend/interest 4 < fee 5 < sell 6 <
 *   transfer out 7; a cash transfer ranks 1. Any permutation of the input gives a deep-equal
 *   result.
 * - The amount is the truth, quantity × price ± fee is the check (`amountMismatch`, 5 cents).
 *   A buy or reinvest opens a lot with basis `−amount` (the commission is inside the amount);
 *   a sell's proceeds are its amount (net of the commission). With the DB column NOT NULL the
 *   loader never passes a null amount; the engine still resolves one from quantity × price
 *   ± fee so it is total over hand-built inputs (`amount_missing` when it cannot).
 * - A reinvested dividend is TWO rows: a `dividend` (income, cash +) and a `reinvest`
 *   (a purchase, `amount ≤ 0`, cash −). The engine never counts a reinvest as income;
 *   `reinvestedCents` per month is Σ `−amount` of the reinvest rows.
 * - Sales consume lots FIFO by `(acquiredDate, opening order)`, or the sale's `lot_pick` rows
 *   first (Σ picks ≤ sale, FIFO for the remainder; `needs_lot_pick` when the account's method
 *   is `specific` and a sell has none). Consuming `take` of a lot holding `Q` shares with
 *   basis `B` removes `roundDivHalfAway(B × take, Q)`, or exactly `B` when `take = Q`, so
 *   Σ open basis + Σ consumed basis = Σ original basis in integers. Proceeds are split across
 *   the pieces by largest remainder (R4). Quantity beyond every open lot is an
 *   `unmatched_sell` piece (basis 0, term `unknown`) with an `oversell` warning; the position
 *   floors at 0.
 * - A split scales every open lot with `scaleQty` (R5) and no residual fix; the 0.001-share
 *   position tolerance absorbs the 10⁻⁸ drift. Basis, acquisition date and original quantity
 *   are unchanged.
 * - A transfer out disposes lots (picks, then FIFO) at basis with no gain (`term = none`) and
 *   reports the pieces in `transferredOut`. A transfer in opens one lot per source lot when the
 *   caller supplies the counterparty's pieces (`transferSources`, ordinals 0..n−1 with
 *   `originLotId`), else one lot carrying the row's own basis and acquisition date, or an
 *   unknown-basis lot (`basisKnown = false`, basis 0, `basis_unknown` warning).
 * - Lot ids are stable by `(openedByTxnId, ordinal)`: `lotKey` by default, or whatever the
 *   caller's `lotId` resolver returns (the DB service hands back the existing uuid).
 * - Holding period (IRS Pub 550): long iff `sold > addMonthsClamped(acquired, 12)`.
 */

// ---- Input ----

/** One account's transaction as the engine reads it (the loader applies the quantity sign). */
export interface InvestmentTxnInput {
  id: string;
  accountId: string;
  /** Null only for cash transfers, account-level fees and interest on cash. */
  securityId: string | null;
  date: IsoDate;
  /** Same-day order within a type rank. */
  sequence: number;
  type: InvestmentTxnType;
  /** Signed: + into the account, − out of it; null for cash-only rows and splits. */
  quantity: Fixed8 | null;
  /** Per share, when the source gave one. */
  price: Fixed8 | null;
  /** Signed cash effect; null only on hand-built inputs (the DB column is NOT NULL). */
  amountCents: bigint | null;
  /** Commission ≥ 0; null counts as 0. */
  feeCents: bigint | null;
  /** Split ratio new:old. */
  splitNum: number | null;
  splitDen: number | null;
  /** Carried basis on a transfer in from outside; null = unknown. */
  costBasisCents: bigint | null;
  /** Original acquisition date on a transfer in; null = the transfer date. */
  acquiredDate: IsoDate | null;
  transferGroupId: string | null;
  counterpartyAccountId: string | null;
}

/** A `lot_pick` row: the lot a sell (or transfer out) consumes first, keyed by the lot's id. */
export interface EngineLotPick {
  sellTxnId: string;
  lotId: string;
  quantity: Fixed8;
  position: number;
}

/** A piece a transfer out disposed of, as the in-leg of the same group receives it. */
export interface TransferredLot {
  /** The transfer-out row. */
  txnId: string;
  /** The source lot's id in the out-leg account. */
  lotId: string;
  securityId: string;
  acquiredDate: IsoDate;
  quantity: Fixed8;
  basisCents: bigint;
  basisKnown: boolean;
}

export interface LotBuildInput {
  accountId: string;
  lotMethod: LotMethod;
  txns: readonly InvestmentTxnInput[];
  lotPicks: readonly EngineLotPick[];
  /**
   * In-leg transfer txn id → the counterparty's `transferredOut` pieces for the same group
   * (the out-leg account is rebuilt first). Absent or empty: the row's own basis applies.
   */
  transferSources?: ReadonlyMap<string, readonly TransferredLot[]>;
  /** Lot id for `(openedByTxnId, ordinal)`; defaults to `lotKey`. */
  lotId?: (openedByTxnId: string, ordinal: number) => string;
}

// ---- Output ----

export interface LotResult {
  id: string;
  openedByTxnId: string;
  ordinal: number;
  /** The source lot across an own-account in-kind transfer. */
  originLotId: string | null;
  accountId: string;
  securityId: string;
  openedBy: LotOpenedBy;
  /** Carried for transfers in, else the opening date. */
  acquiredDate: IsoDate;
  /** As opened (pre-split). */
  originalQuantity: Fixed8;
  /** Remaining, split-adjusted; 0 when closed. */
  quantity: Fixed8;
  originalCostBasisCents: bigint;
  /** Remaining (conserved). 0 when `basisKnown` is false. */
  costBasisCents: bigint;
  basisKnown: boolean;
  closedDate: IsoDate | null;
}

export interface DisposalResult {
  closeTxnId: string;
  /** Null for an `unmatched_sell` (and for the unmatched part of a transfer out). */
  lotId: string | null;
  accountId: string;
  securityId: string;
  kind: DisposalKind;
  date: IsoDate;
  acquiredDate: IsoDate | null;
  quantity: Fixed8;
  /** This piece's share of the net proceeds (largest remainder); 0 for a transfer out. */
  proceedsCents: bigint;
  basisCents: bigint;
  /** proceeds − basis; 0 for a transfer out. */
  gainCents: bigint;
  term: GainTerm;
  basisKnown: boolean;
}

/** The account's position in every security after one transaction of the stream. */
export interface PositionCheckpoint {
  date: IsoDate;
  rank: number;
  sequence: number;
  id: string;
  quantityBySecurity: ReadonlyMap<string, Fixed8>;
}

export interface CashEffect {
  txnId: string;
  date: IsoDate;
  cents: bigint;
}

/** The engine's per-(month, security) income row; `securityId` null = account-level interest or fees. */
export interface EngineIncomeMonth {
  month: MonthKey;
  securityId: string | null;
  dividendCents: bigint;
  interestCents: bigint;
  /** Reported positive. */
  feeCents: bigint;
  /** Σ −amount of the month's reinvest rows (purchases, never income). */
  reinvestedCents: bigint;
}

export interface EngineWarning {
  code: EngineWarningCode;
  accountId?: string;
  securityId?: string;
  txnId?: string;
  date?: IsoDate;
  priceDate?: IsoDate;
  quantity?: Fixed8;
  lotsQuantity?: Fixed8;
  snapshotQuantity?: Fixed8;
  diffCents?: bigint;
  detail?: string;
}

export interface LotBuildResult {
  accountId: string;
  /** In opening order. */
  lots: LotResult[];
  /** In stream order. */
  disposals: DisposalResult[];
  /** One per transaction of the stream, including ignored rows. */
  positions: PositionCheckpoint[];
  cashEffects: CashEffect[];
  income: EngineIncomeMonth[];
  /** Transfer-out pieces with a lot, for the in-leg of the same group. */
  transferredOut: TransferredLot[];
  /** In discovery order. */
  warnings: EngineWarning[];
}

// ---- Ordering (§3.2) ----

/** Same-day type rank: a split is applied pre-market, so it precedes every same-day trade. */
export function txnRank(txn: Pick<InvestmentTxnInput, "type" | "quantity">): number {
  switch (txn.type) {
    case "split":
      return 0;
    case "transfer":
      return txn.quantity !== null && txn.quantity < 0n ? 7 : 1;
    case "buy":
      return 2;
    case "reinvest":
      return 3;
    case "dividend":
    case "interest":
      return 4;
    case "fee":
      return 5;
    case "sell":
      return 6;
  }
}

export function compareInvestmentTxns(a: InvestmentTxnInput, b: InvestmentTxnInput): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const ra = txnRank(a);
  const rb = txnRank(b);
  if (ra !== rb) return ra - rb;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The stream: `(date, type rank, sequence, id)` ascending. Never mutates the input. */
export function sortInvestmentTxns(txns: readonly InvestmentTxnInput[]): InvestmentTxnInput[] {
  return [...txns].sort(compareInvestmentTxns);
}

// ---- Identity ----

/** The default lot id: the opening row's id for ordinal 0, `<id>:<ordinal>` for the rest. */
export function lotKey(openedByTxnId: string, ordinal: number): string {
  return ordinal === 0 ? openedByTxnId : `${openedByTxnId}:${ordinal}`;
}

// ---- Holding period (§3.4) ----

/** IRS Pub 550: long-term iff the sale is after the first anniversary (Rev. Rul. 66-7 month-end clamp). */
export function isLongTerm(acquired: IsoDate, sold: IsoDate): boolean {
  return sold > addMonthsClamped(acquired, 12);
}

// ---- Amount resolution (§3.3 step 2) ----

function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/** Signed cash effect a trade row implies from quantity × price ± fee; null without a price. */
function impliedAmount(txn: InvestmentTxnInput): bigint | null {
  if (txn.price === null || txn.quantity === null) return null;
  const gross = mulToCents(absBig(txn.quantity), txn.price);
  const fee = txn.feeCents ?? 0n;
  return txn.type === "sell" ? gross - fee : -(gross + fee);
}

/** The amount the engine uses for a buy, reinvest or sell row, with the 5-cent check. */
function resolveAmount(txn: InvestmentTxnInput, warnings: EngineWarning[]): bigint {
  if (txn.amountCents === null) {
    const implied = impliedAmount(txn);
    if (implied === null) {
      warnings.push({ code: "amount_missing", txnId: txn.id, ...(txn.securityId !== null ? { securityId: txn.securityId } : {}) });
      return 0n;
    }
    return implied;
  }
  // A purchase recorded as a cash inflow is reported by `buy_amount_sign`; the check would only repeat it.
  const signOk = txn.type === "sell" ? true : txn.amountCents <= 0n;
  if (txn.price !== null && txn.quantity !== null && signOk) {
    const check = amountMismatch(absBig(txn.quantity), txn.price, txn.feeCents, txn.amountCents);
    if (check.mismatch) {
      warnings.push({
        code: "amount_mismatch",
        txnId: txn.id,
        ...(txn.securityId !== null ? { securityId: txn.securityId } : {}),
        diffCents: check.diffCents,
      });
    }
  }
  return txn.amountCents;
}

// ---- The engine (§3.3) ----

interface InternalLot extends LotResult {
  openSeq: number;
}

interface Piece {
  lot: InternalLot | null;
  quantity: Fixed8;
  basisCents: bigint;
  basisKnown: boolean;
  acquiredDate: IsoDate | null;
}

export function buildLots(input: LotBuildInput): LotBuildResult {
  const { accountId } = input;
  const lotIdOf = input.lotId ?? lotKey;
  const stream = sortInvestmentTxns(input.txns);
  const warnings: EngineWarning[] = [];
  const lots: InternalLot[] = [];
  const lotById = new Map<string, InternalLot>();
  const lotsBySecurity = new Map<string, InternalLot[]>();
  const disposals: DisposalResult[] = [];
  const positions: PositionCheckpoint[] = [];
  const cashEffects: CashEffect[] = [];
  const transferredOut: TransferredLot[] = [];
  const position = new Map<string, Fixed8>();
  let openSeq = 0;

  const picksBySell = new Map<string, EngineLotPick[]>();
  for (const pick of input.lotPicks) {
    const list = picksBySell.get(pick.sellTxnId);
    if (list) list.push(pick);
    else picksBySell.set(pick.sellTxnId, [pick]);
  }
  for (const list of picksBySell.values()) {
    list.sort((a, b) => (a.position !== b.position ? a.position - b.position : a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0));
  }

  const addPosition = (securityId: string, delta: Fixed8) => {
    position.set(securityId, (position.get(securityId) ?? 0n) + delta);
  };

  const openLot = (o: {
    openedByTxnId: string;
    ordinal: number;
    originLotId: string | null;
    securityId: string;
    openedBy: LotOpenedBy;
    acquiredDate: IsoDate;
    quantity: Fixed8;
    basisCents: bigint;
    basisKnown: boolean;
  }): InternalLot => {
    const lot: InternalLot = {
      id: lotIdOf(o.openedByTxnId, o.ordinal),
      openedByTxnId: o.openedByTxnId,
      ordinal: o.ordinal,
      originLotId: o.originLotId,
      accountId,
      securityId: o.securityId,
      openedBy: o.openedBy,
      acquiredDate: o.acquiredDate,
      originalQuantity: o.quantity,
      quantity: o.quantity,
      originalCostBasisCents: o.basisCents,
      costBasisCents: o.basisCents,
      basisKnown: o.basisKnown,
      closedDate: null,
      openSeq: openSeq++,
    };
    lots.push(lot);
    lotById.set(lot.id, lot);
    const list = lotsBySecurity.get(o.securityId);
    if (list) list.push(lot);
    else lotsBySecurity.set(o.securityId, [lot]);
    addPosition(o.securityId, o.quantity);
    return lot;
  };

  /** Open lots of a security in FIFO order: acquisition date, then opening order. */
  const openLots = (securityId: string): InternalLot[] =>
    (lotsBySecurity.get(securityId) ?? [])
      .filter((l) => l.quantity > 0n)
      .sort((a, b) => (a.acquiredDate !== b.acquiredDate ? (a.acquiredDate < b.acquiredDate ? -1 : 1) : a.openSeq - b.openSeq));

  /** D5: the last piece of a lot takes the exact remainder; the lot's basis never drifts. */
  const consume = (lot: InternalLot, take: Fixed8, date: IsoDate): Piece => {
    const basis = take === lot.quantity ? lot.costBasisCents : roundDivHalfAway(lot.costBasisCents * take, lot.quantity);
    lot.quantity -= take;
    lot.costBasisCents -= basis;
    if (lot.quantity === 0n) lot.closedDate = date;
    addPosition(lot.securityId, -take);
    return { lot, quantity: take, basisCents: basis, basisKnown: lot.basisKnown, acquiredDate: lot.acquiredDate };
  };

  const dispose = (txn: InvestmentTxnInput, securityId: string, q: Fixed8, kind: "sell" | "transfer_out", proceeds: bigint) => {
    const pieces: Piece[] = [];
    let remaining = q;
    const picks = picksBySell.get(txn.id) ?? [];
    if (kind === "sell" && input.lotMethod === "specific" && picks.length === 0) {
      warnings.push({ code: "needs_lot_pick", txnId: txn.id, securityId });
    }
    for (const pick of picks) {
      const lot = lotById.get(pick.lotId);
      if (!lot || lot.securityId !== securityId || lot.quantity <= 0n) {
        warnings.push({ code: "pick_unavailable", txnId: txn.id, securityId, quantity: pick.quantity, detail: pick.lotId });
        continue;
      }
      let take = pick.quantity;
      if (take > lot.quantity) {
        warnings.push({ code: "pick_exceeds_lot", txnId: txn.id, securityId, quantity: pick.quantity, detail: lot.id });
        take = lot.quantity;
      }
      if (take > remaining) {
        warnings.push({ code: "pick_exceeds_sale", txnId: txn.id, securityId, quantity: pick.quantity, detail: lot.id });
        take = remaining;
      }
      if (take <= 0n) continue;
      pieces.push(consume(lot, take, txn.date));
      remaining -= take;
    }
    if (remaining > 0n) {
      for (const lot of openLots(securityId)) {
        if (remaining <= 0n) break;
        const take = lot.quantity < remaining ? lot.quantity : remaining;
        pieces.push(consume(lot, take, txn.date));
        remaining -= take;
      }
    }
    if (remaining > 0n) {
      pieces.push({ lot: null, quantity: remaining, basisCents: 0n, basisKnown: false, acquiredDate: null });
      warnings.push({ code: "oversell", txnId: txn.id, securityId, quantity: remaining, date: txn.date });
    }
    const proceedsParts = kind === "sell" ? allocateLargestRemainder(proceeds, pieces.map((p) => p.quantity)) : pieces.map(() => 0n);
    pieces.forEach((piece, i) => {
      const pieceProceeds = proceedsParts[i]!;
      const term: GainTerm =
        kind === "transfer_out"
          ? "none"
          : !piece.basisKnown || piece.acquiredDate === null
            ? "unknown"
            : isLongTerm(piece.acquiredDate, txn.date)
              ? "long"
              : "short";
      disposals.push({
        closeTxnId: txn.id,
        lotId: piece.lot?.id ?? null,
        accountId,
        securityId,
        kind: piece.lot === null && kind === "sell" ? "unmatched_sell" : kind,
        date: txn.date,
        acquiredDate: piece.acquiredDate,
        quantity: piece.quantity,
        proceedsCents: pieceProceeds,
        basisCents: piece.basisCents,
        gainCents: kind === "transfer_out" ? 0n : pieceProceeds - piece.basisCents,
        term,
        basisKnown: piece.basisKnown,
      });
      if (kind === "transfer_out" && piece.lot !== null && piece.acquiredDate !== null) {
        transferredOut.push({
          txnId: txn.id,
          lotId: piece.lot.id,
          securityId,
          acquiredDate: piece.acquiredDate,
          quantity: piece.quantity,
          basisCents: piece.basisCents,
          basisKnown: piece.basisKnown,
        });
      }
    });
  };

  const badQuantity = (txn: InvestmentTxnInput, detail?: string) => {
    warnings.push({
      code: "bad_quantity",
      txnId: txn.id,
      ...(txn.securityId !== null ? { securityId: txn.securityId } : {}),
      ...(txn.quantity !== null ? { quantity: txn.quantity } : {}),
      ...(detail !== undefined ? { detail } : {}),
    });
  };

  const transferIn = (txn: InvestmentTxnInput, securityId: string, q: Fixed8) => {
    const sources = input.transferSources?.get(txn.id) ?? [];
    const carried = sources.reduce((acc, s) => acc + s.quantity, 0n);
    if (sources.length > 0 && carried <= q) {
      let unknown = 0n;
      sources.forEach((s, ordinal) => {
        openLot({
          openedByTxnId: txn.id,
          ordinal,
          originLotId: s.lotId,
          securityId,
          openedBy: "transfer_in",
          acquiredDate: s.acquiredDate,
          quantity: s.quantity,
          basisCents: s.basisKnown ? s.basisCents : 0n,
          basisKnown: s.basisKnown,
        });
        if (!s.basisKnown) unknown += s.quantity;
      });
      if (carried < q) {
        openLot({
          openedByTxnId: txn.id,
          ordinal: sources.length,
          originLotId: null,
          securityId,
          openedBy: "transfer_in",
          acquiredDate: txn.date,
          quantity: q - carried,
          basisCents: 0n,
          basisKnown: false,
        });
        unknown += q - carried;
      }
      if (unknown > 0n) warnings.push({ code: "basis_unknown", txnId: txn.id, securityId, quantity: unknown });
      return;
    }
    if (sources.length > 0) {
      badQuantity(txn, `transfer sources carry ${formatFixed8(carried)} shares for a row of ${formatFixed8(q)}`);
    }
    const known = txn.costBasisCents !== null && txn.costBasisCents >= 0n;
    openLot({
      openedByTxnId: txn.id,
      ordinal: 0,
      originLotId: null,
      securityId,
      openedBy: "transfer_in",
      acquiredDate: txn.acquiredDate ?? txn.date,
      quantity: q,
      basisCents: known ? txn.costBasisCents! : 0n,
      basisKnown: known,
    });
    if (!known) warnings.push({ code: "basis_unknown", txnId: txn.id, securityId, quantity: q });
  };

  for (const txn of stream) {
    switch (txn.type) {
      case "buy":
      case "reinvest": {
        if (txn.securityId === null || txn.quantity === null || txn.quantity <= 0n) {
          badQuantity(txn);
          break;
        }
        const amount = resolveAmount(txn, warnings);
        let basis = -amount;
        if (amount > 0n) {
          warnings.push({ code: "buy_amount_sign", txnId: txn.id, securityId: txn.securityId, diffCents: amount });
          basis = amount;
        }
        openLot({
          openedByTxnId: txn.id,
          ordinal: 0,
          originLotId: null,
          securityId: txn.securityId,
          openedBy: txn.type,
          acquiredDate: txn.date,
          quantity: txn.quantity,
          basisCents: basis,
          basisKnown: true,
        });
        cashEffects.push({ txnId: txn.id, date: txn.date, cents: amount });
        break;
      }
      case "sell": {
        if (txn.securityId === null || txn.quantity === null || txn.quantity >= 0n) {
          badQuantity(txn);
          break;
        }
        const amount = resolveAmount(txn, warnings);
        dispose(txn, txn.securityId, -txn.quantity, "sell", amount);
        cashEffects.push({ txnId: txn.id, date: txn.date, cents: amount });
        break;
      }
      case "transfer": {
        if (txn.securityId === null) {
          warnings.push({ code: "cash_transfer_in_txns", txnId: txn.id, date: txn.date });
          break;
        }
        if (txn.quantity === null || txn.quantity === 0n) {
          badQuantity(txn);
          break;
        }
        if (txn.quantity > 0n) transferIn(txn, txn.securityId, txn.quantity);
        else dispose(txn, txn.securityId, -txn.quantity, "transfer_out", 0n);
        break;
      }
      case "split": {
        const { splitNum: num, splitDen: den } = txn;
        if (txn.securityId === null || num === null || den === null || !Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) {
          badQuantity(txn, "split ratio");
          break;
        }
        let total = 0n;
        for (const lot of lotsBySecurity.get(txn.securityId) ?? []) {
          if (lot.quantity <= 0n) continue;
          lot.quantity = scaleQty(lot.quantity, num, den);
          if (lot.quantity === 0n) lot.closedDate = txn.date;
          total += lot.quantity;
        }
        position.set(txn.securityId, total);
        break;
      }
      case "dividend":
      case "interest":
      case "fee": {
        cashEffects.push({ txnId: txn.id, date: txn.date, cents: txn.amountCents ?? 0n });
        break;
      }
    }
    positions.push({ date: txn.date, rank: txnRank(txn), sequence: txn.sequence, id: txn.id, quantityBySecurity: new Map(position) });
  }

  return {
    accountId,
    lots: lots.map(({ openSeq: _openSeq, ...lot }) => lot),
    disposals,
    positions,
    cashEffects,
    income: incomeByMonth(stream),
    transferredOut,
    warnings,
  };
}

// ---- Positions ----

/** The position map after the last checkpoint dated on or before `date`; empty before the first. */
export function quantityAt(positions: readonly PositionCheckpoint[], date: IsoDate): ReadonlyMap<string, Fixed8> {
  let lo = 0;
  let hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (positions[mid]!.date <= date) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? new Map() : positions[lo - 1]!.quantityBySecurity;
}

/** 0.001 shares: the position check's tolerance (absorbs R5 drift and statement rounding). */
export const POSITION_TOLERANCE: Fixed8 = 100_000n;

export interface PositionSnapshot {
  date: IsoDate;
  /** Statement quantities per security; null = a dollar-only row (value known, units not reported). */
  quantities: ReadonlyMap<string, Fixed8 | null>;
  /** Securities the check never compares: the cash security and `asset_class = 'cash'` funds. */
  skipSecurityIds?: ReadonlySet<string>;
}

/**
 * §3.16 under plan decision 7: per security in the union of the lots' position on the statement
 * date and the statement's rows, `|lots − statement| > 0.001` shares → `position_mismatch`.
 * A security open in lots but absent from the statement, and one on the statement but absent
 * from lots, both mismatch. Cash-like securities and dollar-only rows are skipped.
 */
export function checkPositions(positions: readonly PositionCheckpoint[], snapshot: PositionSnapshot): EngineWarning[] {
  const lotsQty = quantityAt(positions, snapshot.date);
  const ids = [...new Set([...lotsQty.keys(), ...snapshot.quantities.keys()])].sort();
  const warnings: EngineWarning[] = [];
  for (const securityId of ids) {
    if (snapshot.skipSecurityIds?.has(securityId)) continue;
    const reported = snapshot.quantities.get(securityId);
    if (reported === null) continue;
    const lotsQuantity = lotsQty.get(securityId) ?? 0n;
    const snapshotQuantity = reported ?? 0n;
    if (absBig(lotsQuantity - snapshotQuantity) > POSITION_TOLERANCE) {
      warnings.push({ code: "position_mismatch", securityId, lotsQuantity, snapshotQuantity, date: snapshot.date });
    }
  }
  return warnings;
}

// ---- Income (§3.5 under plan decision 6) ----

function compareIncomeRows(a: EngineIncomeMonth, b: EngineIncomeMonth): number {
  if (a.month !== b.month) return a.month < b.month ? -1 : 1;
  if (a.securityId === b.securityId) return 0;
  if (a.securityId === null) return -1;
  if (b.securityId === null) return 1;
  return a.securityId < b.securityId ? -1 : 1;
}

/**
 * Rows per (month, security): dividends and interest as received, fees reported positive,
 * `reinvestedCents` = Σ −amount of the reinvest rows (a purchase, never income). Account-level
 * rows (`securityId` null) sort first within a month. Rows that would be all zeros are omitted.
 */
export function incomeByMonth(txns: readonly InvestmentTxnInput[]): EngineIncomeMonth[] {
  const rows = new Map<string, EngineIncomeMonth>();
  for (const txn of txns) {
    if (txn.type !== "dividend" && txn.type !== "interest" && txn.type !== "fee" && txn.type !== "reinvest") continue;
    const month = monthKey(txn.date);
    const key = `${month}|${txn.securityId ?? ""}`;
    let row = rows.get(key);
    if (!row) {
      row = { month, securityId: txn.securityId, dividendCents: 0n, interestCents: 0n, feeCents: 0n, reinvestedCents: 0n };
      rows.set(key, row);
    }
    const amount = txn.amountCents ?? (txn.type === "reinvest" ? (impliedAmount(txn) ?? 0n) : 0n);
    switch (txn.type) {
      case "dividend":
        row.dividendCents += amount;
        break;
      case "interest":
        row.interestCents += amount;
        break;
      case "fee":
        row.feeCents += -amount;
        break;
      case "reinvest":
        row.reinvestedCents += -amount;
        break;
    }
  }
  return [...rows.values()]
    .filter((r) => r.dividendCents !== 0n || r.interestCents !== 0n || r.feeCents !== 0n || r.reinvestedCents !== 0n)
    .sort(compareIncomeRows);
}

// ---- Valuation of lots and holdings (§3.14) ----

/** The engine's staleness rule: a close more than 7 days before the valuation date. */
export const STALE_PRICE_DAYS = 7;

export function isStalePrice(priceDate: IsoDate, asOf: IsoDate): boolean {
  return dayDiff(priceDate, asOf) > STALE_PRICE_DAYS;
}

export interface PriceQuote {
  close: Fixed8;
  date: IsoDate;
  source: HoldingPriceSource;
}

/** The latest price on or before the valuation date, or null when the security has none. */
export type PriceLookup = (securityId: string) => PriceQuote | null;

export interface LotValuation {
  lotId: string;
  valueCents: bigint | null;
  /** value − basis; null when the basis is unknown or the lot is unpriced or closed. */
  unrealizedCents: bigint | null;
  /** The term the lot would realize if sold on `asOf`; `unknown` without basis, `none` when closed. */
  term: GainTerm;
  /** R3 on the remaining basis; null when unknown or closed. */
  basisPerShare: Fixed8 | null;
  priceDate: IsoDate | null;
  stale: boolean;
}

/** Per-lot value, unrealized gain, term and basis per share as of a date (closed lots carry nulls). */
export function valueLots(lots: readonly LotResult[], asOf: IsoDate, priceAt: PriceLookup): LotValuation[] {
  const quotes = new Map<string, PriceQuote | null>();
  const quoteFor = (securityId: string) => {
    if (!quotes.has(securityId)) quotes.set(securityId, priceAt(securityId));
    return quotes.get(securityId) ?? null;
  };
  return lots.map((lot) => {
    if (lot.quantity <= 0n) return { lotId: lot.id, valueCents: null, unrealizedCents: null, term: "none", basisPerShare: null, priceDate: null, stale: false };
    const quote = quoteFor(lot.securityId);
    const valueCents = quote ? mulToCents(lot.quantity, quote.close) : null;
    return {
      lotId: lot.id,
      valueCents,
      unrealizedCents: lot.basisKnown && valueCents !== null ? valueCents - lot.costBasisCents : null,
      term: lot.basisKnown ? (isLongTerm(lot.acquiredDate, asOf) ? "long" : "short") : "unknown",
      basisPerShare: lot.basisKnown ? impliedPrice(lot.costBasisCents, lot.quantity) : null,
      priceDate: quote?.date ?? null,
      stale: quote ? isStalePrice(quote.date, asOf) : false,
    };
  });
}

/** One security's open lots of one account, as of a date. */
export interface HoldingRow {
  securityId: string;
  quantity: Fixed8;
  valueCents: bigint | null;
  /** Σ basis of the known-basis lots; null when none is known. */
  costBasisCents: bigint | null;
  /** Σ over known-basis, priced lots; null when there is none. */
  unrealizedCents: bigint | null;
  unrealizedShortCents: bigint;
  unrealizedLongCents: bigint;
  unknownBasisQuantity: Fixed8;
  lotCount: number;
  price: Fixed8 | null;
  priceDate: IsoDate | null;
  priceSource: HoldingPriceSource | null;
  stale: boolean;
}

/** Per-security rows over the open lots, sorted by security id. */
export function holdingsAsOf(lots: readonly LotResult[], asOf: IsoDate, priceAt: PriceLookup): HoldingRow[] {
  const valuations = valueLots(lots, asOf, priceAt);
  const rows = new Map<string, HoldingRow>();
  lots.forEach((lot, i) => {
    if (lot.quantity <= 0n) return;
    const v = valuations[i]!;
    let row = rows.get(lot.securityId);
    if (!row) {
      const quote = priceAt(lot.securityId);
      row = {
        securityId: lot.securityId,
        quantity: 0n,
        valueCents: quote ? 0n : null,
        costBasisCents: null,
        unrealizedCents: null,
        unrealizedShortCents: 0n,
        unrealizedLongCents: 0n,
        unknownBasisQuantity: 0n,
        lotCount: 0,
        price: quote?.close ?? null,
        priceDate: quote?.date ?? null,
        priceSource: quote?.source ?? null,
        stale: quote ? isStalePrice(quote.date, asOf) : false,
      };
      rows.set(lot.securityId, row);
    }
    row.quantity += lot.quantity;
    row.lotCount += 1;
    if (row.valueCents !== null && v.valueCents !== null) row.valueCents += v.valueCents;
    if (lot.basisKnown) row.costBasisCents = (row.costBasisCents ?? 0n) + lot.costBasisCents;
    else row.unknownBasisQuantity += lot.quantity;
    if (v.unrealizedCents !== null) {
      row.unrealizedCents = (row.unrealizedCents ?? 0n) + v.unrealizedCents;
      if (v.term === "long") row.unrealizedLongCents += v.unrealizedCents;
      else row.unrealizedShortCents += v.unrealizedCents;
    }
  });
  return [...rows.values()].sort((a, b) => (a.securityId < b.securityId ? -1 : a.securityId > b.securityId ? 1 : 0));
}

// ---- Gain summaries (§3.15) ----

export interface GainTotals {
  proceedsCents: bigint;
  basisCents: bigint;
  gainCents: bigint;
  count: number;
}

/** Realized gains over `(from, to]`: sales by term, unknown-basis sales apart, transfers out apart. */
export interface RealizedSummary {
  shortTerm: GainTotals;
  longTerm: GainTotals;
  unknownBasis: { proceedsCents: bigint; quantity: Fixed8; count: number };
  transfersOut: { quantity: Fixed8; basisCents: bigint };
  /** IRC §1091 is never applied; the brokerage's 1099-B carries the adjustments. */
  washSalesApplied: false;
}

function emptyTotals(): GainTotals {
  return { proceedsCents: 0n, basisCents: 0n, gainCents: 0n, count: 0 };
}

export function summarizeRealized(disposals: readonly DisposalResult[], range: { from: IsoDate; to: IsoDate }): RealizedSummary {
  const summary: RealizedSummary = {
    shortTerm: emptyTotals(),
    longTerm: emptyTotals(),
    unknownBasis: { proceedsCents: 0n, quantity: 0n, count: 0 },
    transfersOut: { quantity: 0n, basisCents: 0n },
    washSalesApplied: false,
  };
  for (const d of disposals) {
    if (!(d.date > range.from && d.date <= range.to)) continue;
    if (d.kind === "transfer_out") {
      summary.transfersOut.quantity += d.quantity;
      summary.transfersOut.basisCents += d.basisCents;
      continue;
    }
    if (!d.basisKnown) {
      summary.unknownBasis.proceedsCents += d.proceedsCents;
      summary.unknownBasis.quantity += d.quantity;
      summary.unknownBasis.count += 1;
      continue;
    }
    const bucket = d.term === "long" ? summary.longTerm : summary.shortTerm;
    bucket.proceedsCents += d.proceedsCents;
    bucket.basisCents += d.basisCents;
    bucket.gainCents += d.gainCents;
    bucket.count += 1;
  }
  return summary;
}

/** The all-history gain summary of one full-history account as of a date. */
export interface GainSummary {
  realizedShortCents: bigint;
  realizedLongCents: bigint;
  /** short + long. */
  realizedCents: bigint;
  /** Proceeds of sales without a known basis: a separate line, never a gain. */
  unknownBasisProceedsCents: bigint;
  /** Σ value − basis over the open, known-basis, priced lots. */
  unrealizedCents: bigint;
  /** realized + unrealized. */
  totalGainCents: bigint;
  /** Sales only (matched and unmatched). */
  proceedsCents: bigint;
  /** Sales only. */
  basisConsumedCents: bigint;
  transferredOutBasisCents: bigint;
  /** Σ value of the open, priced lots (known basis or not). */
  openValueCents: bigint;
  /** Σ basis of the open, priced, known-basis lots. */
  openBasisCents: bigint;
  /** Σ original basis of every lot opened in the account. */
  originalBasisCents: bigint;
  /** Securities with open lots and no price, sorted. */
  unpricedSecurityIds: string[];
}

/**
 * Invariant (exact in integers, for histories whose lots all have a known basis and a price):
 * `realized + unrealized = openValue + proceeds + transferredOutBasis − originalBasis`;
 * with unknown-basis sales, `+ unknownBasisProceeds` on the left.
 */
export function summarizeGains(lots: readonly LotResult[], disposals: readonly DisposalResult[], priceAt: (securityId: string) => Fixed8 | null): GainSummary {
  const s: GainSummary = {
    realizedShortCents: 0n,
    realizedLongCents: 0n,
    realizedCents: 0n,
    unknownBasisProceedsCents: 0n,
    unrealizedCents: 0n,
    totalGainCents: 0n,
    proceedsCents: 0n,
    basisConsumedCents: 0n,
    transferredOutBasisCents: 0n,
    openValueCents: 0n,
    openBasisCents: 0n,
    originalBasisCents: 0n,
    unpricedSecurityIds: [],
  };
  for (const d of disposals) {
    if (d.kind === "transfer_out") {
      s.transferredOutBasisCents += d.basisCents;
      continue;
    }
    s.proceedsCents += d.proceedsCents;
    s.basisConsumedCents += d.basisCents;
    if (!d.basisKnown) s.unknownBasisProceedsCents += d.proceedsCents;
    else if (d.term === "long") s.realizedLongCents += d.gainCents;
    else s.realizedShortCents += d.gainCents;
  }
  const prices = new Map<string, Fixed8 | null>();
  const unpriced = new Set<string>();
  for (const lot of lots) {
    s.originalBasisCents += lot.originalCostBasisCents;
    if (lot.quantity <= 0n) continue;
    if (!prices.has(lot.securityId)) prices.set(lot.securityId, priceAt(lot.securityId));
    const price = prices.get(lot.securityId) ?? null;
    if (price === null) {
      unpriced.add(lot.securityId);
      continue;
    }
    const value = mulToCents(lot.quantity, price);
    s.openValueCents += value;
    if (lot.basisKnown) {
      s.openBasisCents += lot.costBasisCents;
      s.unrealizedCents += value - lot.costBasisCents;
    }
  }
  s.realizedCents = s.realizedShortCents + s.realizedLongCents;
  s.totalGainCents = s.realizedCents + s.unrealizedCents;
  s.unpricedSecurityIds = [...unpriced].sort();
  return s;
}
