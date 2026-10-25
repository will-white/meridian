import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  addDays,
  csvExternalId,
  dayDiff,
  formatFixed8,
  isCashKey,
  mulToCents,
  sanitizeText,
  type EngineWarning,
  type Fixed8,
  type InvestmentTxnSource,
  type InvestmentTxnType,
  type IsoDate,
  type MappedTrade,
  type RowChoice,
  type SecurityChoice,
  type TransferDirection,
} from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { account, investmentTxn, security, transaction } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { qtyFromDb, qtyToDb } from "./decimalDb.js";
import { loadInvestmentAccount, type InvestmentAccountRow } from "./holdings.js";
import { ingestTransactions, type IncomingTransaction } from "./ingest.js";
import { enqueueJob } from "./jobs.js";
import { listLotPicks, rebuildLotsForAccounts, validateLotPicks, writeLotPicks, type LotPickInputRecord, type LotPickRecord } from "./lots.js";
import { resolvePayee } from "./payees.js";
import { requestPriceRefresh } from "./prices.js";
import { loadRules } from "./rules.js";
import { cashSecurity, createSecurity, learnAliases, requireSecurity, resolveSecurity } from "./securities.js";
import { pairTransfersInDb, unpairTransfer } from "./transfers.js";

/**
 * Investment transactions (imports design §3.9–§3.10 under plan decisions 5, 6 and 15; seams
 * C7, C32, C52). Imported rows are keyed by `(account, external_id)` and re-imports write only
 * the diff of the source-owned columns, never a row the owner edited (`user_edited`); manual
 * rows are audited per row. Cash transfers reach the ledger: in SimpleFIN-fed accounts by
 * linking the Bridge's row (`linkToLedger`), elsewhere by a derived ledger row (`is_transfer`,
 * linked by `ledger_transaction_id`) so hand-entered 401(k) deferrals reach savings goals.
 * Only ledger rows this side wrote (a derived transfer row, or the income feed's synthetic
 * row) follow an investment row's edits and deletion; a bank row the linker merely matched is
 * the owner's and is never changed (`ownedLedgerTwin`). Every writer rebuilds the lots of the
 * accounts it touched inside its transaction.
 */

type TxnRow = typeof investmentTxn.$inferSelect;
type TxnInsert = typeof investmentTxn.$inferInsert;

// ---- Records ----

export interface InvestmentTxnRecord {
  id: string;
  accountId: string;
  accountName: string;
  securityId: string | null;
  ticker: string | null;
  securityName: string | null;
  date: IsoDate;
  sequence: number;
  type: InvestmentTxnType;
  /** Unsigned; `transferDirection` carries the sign of a transfer. */
  quantity: Fixed8 | null;
  price: Fixed8 | null;
  amountCents: bigint;
  feeCents: bigint;
  splitNum: number | null;
  splitDen: number | null;
  transferDirection: TransferDirection | null;
  counterpartyAccountId: string | null;
  transferGroupId: string | null;
  costBasisCents: bigint | null;
  acquiredDate: IsoDate | null;
  lotPicks: LotPickRecord[];
  ledgerTransactionId: string | null;
  externalId: string | null;
  source: InvestmentTxnSource;
  importLogId: string | null;
  rawDescription: string | null;
  memo: string | null;
  userEdited: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** The audit shape (the API view without names and timestamps); quantities as decimal strings. */
export function investmentTxnAuditJson(row: TxnRow, picks: readonly LotPickRecord[] = []) {
  return {
    accountId: row.accountId,
    securityId: row.securityId,
    date: row.date,
    sequence: row.sequence,
    type: row.type,
    quantity: row.quantity === null ? null : formatFixed8(qtyFromDb(row.quantity)!),
    price: row.price === null ? null : formatFixed8(qtyFromDb(row.price)!),
    amountCents: row.amountCents,
    feeCents: row.feeCents,
    splitNum: row.splitNum,
    splitDen: row.splitDen,
    transferDirection: row.transferDirection,
    counterpartyAccountId: row.counterpartyAccountId,
    transferGroupId: row.transferGroupId,
    costBasisCents: row.costBasisCents,
    acquiredDate: row.acquiredDate,
    lotPicks: [...picks].sort((a, b) => a.position - b.position).map((p) => ({ lotId: p.lotId, quantity: formatFixed8(p.quantity), position: p.position })),
    ledgerTransactionId: row.ledgerTransactionId,
    externalId: row.externalId,
    source: row.source,
    importLogId: row.importLogId,
    rawDescription: row.rawDescription,
    memo: row.memo,
    userEdited: row.userEdited,
  };
}

// ---- Shape validation (the schema's named CHECKs, raised first as 400 txn_invalid) ----

export interface TxnShape {
  type: InvestmentTxnType;
  securityId: string | null;
  quantity: Fixed8 | null;
  price: Fixed8 | null;
  amountCents: bigint;
  feeCents: bigint;
  splitNum: number | null;
  splitDen: number | null;
  transferDirection: TransferDirection | null;
  costBasisCents: bigint | null;
  acquiredDate: IsoDate | null;
}

function invalid(rule: string, message: string): never {
  throw new PlanError(400, "txn_invalid", `${rule}: ${message}`);
}

/** Mirrors `investment_txn`'s CHECK constraints so a bad row fails with the rule's name before the database sees it. */
export function assertTxnShape(r: TxnShape): void {
  if (r.quantity !== null && r.quantity < 0n) invalid("itx_quantity_nonneg", "quantity must not be negative");
  if (r.price !== null && r.price < 0n) invalid("itx_price_nonneg", "price must not be negative");
  if (r.feeCents < 0n) invalid("itx_fee_nonneg", "fee must not be negative");
  const hasQty = r.quantity !== null && r.quantity > 0n;
  switch (r.type) {
    case "buy":
      if (r.securityId === null || !hasQty || r.amountCents > 0n) invalid("itx_buy", "a buy needs a security, a positive quantity and a non-positive amount");
      break;
    case "sell":
      if (r.securityId === null || !hasQty || r.amountCents < 0n) invalid("itx_sell", "a sell needs a security, a positive quantity and a non-negative amount");
      break;
    case "reinvest":
      if (r.securityId === null || !hasQty || r.amountCents > 0n) invalid("itx_reinvest", "a reinvest needs a security, a positive quantity and a non-positive amount");
      break;
    case "fee":
      if (r.amountCents > 0n) invalid("itx_fee", "a fee's amount must not be positive");
      break;
    default:
      break;
  }
  const isSplit = r.type === "split";
  if (isSplit !== (r.splitNum !== null) || isSplit !== (r.splitDen !== null)) invalid("itx_split", "split_num and split_den belong to a split only");
  if (isSplit && (r.securityId === null || r.splitNum! <= 0 || r.splitDen! <= 0 || r.amountCents !== 0n)) {
    invalid("itx_split", "a split needs a security, a positive ratio and a zero amount");
  }
  const isTransfer = r.type === "transfer";
  if (isTransfer !== (r.transferDirection !== null)) invalid("itx_transfer", "transfer_direction belongs to a transfer only");
  if (isTransfer) {
    const shares = r.securityId !== null && r.amountCents === 0n && hasQty;
    const cash = r.securityId === null && r.amountCents !== 0n && (r.transferDirection === "in") === r.amountCents > 0n;
    if (!shares && !cash) invalid("itx_transfer", "a transfer moves shares (quantity, amount 0) or cash (signed amount matching its direction)");
  }
  const basisGiven = r.costBasisCents !== null || r.acquiredDate !== null;
  if (basisGiven && !(isTransfer && r.transferDirection === "in" && r.securityId !== null)) {
    invalid("itx_basis_only_in", "cost basis and acquisition date belong to a transfer in of shares");
  }
}

// ---- Reads ----

function decodeCursor(cursor: string): { date: string; sequence: number; id: string } | undefined {
  try {
    const [date, sequence, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!date || sequence === undefined || !id) return undefined;
    const n = Number(sequence);
    if (!Number.isInteger(n)) return undefined;
    return { date, sequence: n, id };
  } catch {
    return undefined;
  }
}

function encodeCursor(date: string, sequence: number, id: string): string {
  return Buffer.from(`${date}|${sequence}|${id}`, "utf8").toString("base64url");
}

export interface ListInvestmentTxnsQuery {
  accountId?: string;
  securityId?: string;
  type?: InvestmentTxnType;
  from?: IsoDate;
  to?: IsoDate;
  limit: number;
  cursor?: string;
}

async function selectRecords(db: DbOrTx, where: ReturnType<typeof and>, limit: number): Promise<InvestmentTxnRecord[]> {
  const rows = await db
    .select({ row: investmentTxn, accountName: account.name, ticker: security.ticker, securityName: security.name })
    .from(investmentTxn)
    .innerJoin(account, eq(account.id, investmentTxn.accountId))
    .leftJoin(security, eq(security.id, investmentTxn.securityId))
    .where(where)
    .orderBy(desc(investmentTxn.date), desc(investmentTxn.sequence), desc(investmentTxn.id))
    .limit(limit);
  const picks = await listLotPicks(db, rows.map((r) => r.row.id));
  return rows.map((r) => ({
    id: r.row.id,
    accountId: r.row.accountId,
    accountName: r.accountName,
    securityId: r.row.securityId,
    ticker: r.ticker ?? null,
    securityName: r.securityName ?? null,
    date: r.row.date,
    sequence: r.row.sequence,
    type: r.row.type,
    quantity: qtyFromDb(r.row.quantity),
    price: qtyFromDb(r.row.price),
    amountCents: r.row.amountCents,
    feeCents: r.row.feeCents,
    splitNum: r.row.splitNum,
    splitDen: r.row.splitDen,
    transferDirection: r.row.transferDirection,
    counterpartyAccountId: r.row.counterpartyAccountId,
    transferGroupId: r.row.transferGroupId,
    costBasisCents: r.row.costBasisCents,
    acquiredDate: r.row.acquiredDate,
    lotPicks: picks.get(r.row.id) ?? [],
    ledgerTransactionId: r.row.ledgerTransactionId,
    externalId: r.row.externalId,
    source: r.row.source,
    importLogId: r.row.importLogId,
    rawDescription: r.row.rawDescription,
    memo: r.row.memo,
    userEdited: r.row.userEdited,
    createdAt: r.row.createdAt,
    updatedAt: r.row.updatedAt,
  }));
}

/** Newest first, keyset-paginated on (date, sequence, id). */
export async function listInvestmentTxns(db: DbOrTx, q: ListInvestmentTxnsQuery): Promise<{ items: InvestmentTxnRecord[]; nextCursor: string | null }> {
  const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
  const limit = Math.max(1, Math.min(q.limit, 500));
  const items = await selectRecords(
    db,
    and(
      q.accountId ? eq(investmentTxn.accountId, q.accountId) : undefined,
      q.securityId ? eq(investmentTxn.securityId, q.securityId) : undefined,
      q.type ? eq(investmentTxn.type, q.type) : undefined,
      q.from ? gte(investmentTxn.date, q.from) : undefined,
      q.to ? lte(investmentTxn.date, q.to) : undefined,
      cursor
        ? or(
            sql`${investmentTxn.date} < ${cursor.date}`,
            and(eq(investmentTxn.date, cursor.date), sql`${investmentTxn.sequence} < ${cursor.sequence}`),
            and(eq(investmentTxn.date, cursor.date), eq(investmentTxn.sequence, cursor.sequence), sql`${investmentTxn.id} < ${cursor.id}::uuid`),
          )
        : undefined,
    ),
    limit + 1,
  );
  const page = items.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page, nextCursor: items.length > limit && last ? encodeCursor(last.date, last.sequence, last.id) : null };
}

export async function getInvestmentTxn(db: DbOrTx, id: string): Promise<InvestmentTxnRecord | undefined> {
  const [row] = await selectRecords(db, and(eq(investmentTxn.id, id)), 1);
  return row;
}

async function requireTxn(tx: DbOrTx, id: string): Promise<TxnRow> {
  const [row] = await tx.select().from(investmentTxn).where(eq(investmentTxn.id, id));
  if (!row) throw new PlanError(404, "not_found", "Investment transaction not found");
  return row;
}

async function nextSequence(tx: DbOrTx, accountId: string, date: IsoDate): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${investmentTxn.sequence})` })
    .from(investmentTxn)
    .where(and(eq(investmentTxn.accountId, accountId), eq(investmentTxn.date, date)));
  return row?.max === null || row?.max === undefined ? 0 : Number(row.max) + 1;
}

function isCashTransfer(r: Pick<TxnShape, "type" | "securityId">): boolean {
  return r.type === "transfer" && r.securityId === null;
}

function isLinkable(r: Pick<TxnShape, "type" | "securityId">): boolean {
  return r.type === "dividend" || r.type === "interest" || r.type === "fee" || isCashTransfer(r);
}

// ---- Ledger linking (§3.9 step 5) ----

export interface LinkCandidate {
  id: string;
  accountId: string;
  date: IsoDate;
  amountCents: bigint;
}

export const LEDGER_LINK_DAYS = 3;

/**
 * Link investment rows to the ledger row they describe: the unlinked, posted ledger row of
 * the same account with the same amount within 3 days (never a synthetic feed row), nearest
 * date first, then the earliest id; each ledger row is used once. Sets
 * `ledger_transaction_id` and returns how many rows were linked.
 */
export async function linkToLedger(tx: DbOrTx, rows: readonly LinkCandidate[]): Promise<number> {
  let linked = 0;
  const byAccount = new Map<string, LinkCandidate[]>();
  for (const r of rows) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r]);
  for (const [accountId, list] of byAccount) {
    const dates = list.map((r) => r.date).sort();
    const lo = addDays(dates[0]!, -LEDGER_LINK_DAYS);
    const hi = addDays(dates[dates.length - 1]!, LEDGER_LINK_DAYS);
    const amounts = [...new Set(list.map((r) => r.amountCents))];
    const taken = tx.select({ id: investmentTxn.ledgerTransactionId }).from(investmentTxn).where(sql`${investmentTxn.ledgerTransactionId} is not null`);
    const candidates = await tx
      .select({ id: transaction.id, date: transaction.date, amountCents: transaction.amountCents })
      .from(transaction)
      .where(
        and(
          eq(transaction.accountId, accountId),
          inArray(transaction.amountCents, amounts),
          gte(transaction.date, lo),
          lte(transaction.date, hi),
          eq(transaction.pending, false),
          ne(transaction.source, "investment"),
          sql`${transaction.id} not in ${taken}`,
        ),
      );
    const used = new Set<string>();
    const ordered = [...list].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const row of ordered) {
      let best: { id: string; date: IsoDate; distance: number } | undefined;
      for (const c of candidates) {
        if (used.has(c.id) || c.amountCents !== row.amountCents) continue;
        const distance = Math.abs(dayDiff(c.date, row.date));
        if (distance > LEDGER_LINK_DAYS) continue;
        if (!best || distance < best.distance || (distance === best.distance && (c.date < best.date || (c.date === best.date && c.id < best.id)))) {
          best = { id: c.id, date: c.date, distance };
        }
      }
      if (!best) continue;
      used.add(best.id);
      await tx.update(investmentTxn).set({ ledgerTransactionId: best.id, updatedAt: new Date() }).where(eq(investmentTxn.id, row.id));
      linked++;
    }
  }
  return linked;
}

/** Link every unlinked dividend, interest, fee and cash-transfer row (after a sync delivers the bank side). */
export async function linkUnlinkedInvestmentTxns(tx: DbOrTx, opts: { accountIds?: readonly string[] } = {}): Promise<number> {
  const rows = await tx
    .select({ id: investmentTxn.id, accountId: investmentTxn.accountId, date: investmentTxn.date, amountCents: investmentTxn.amountCents })
    .from(investmentTxn)
    .where(
      and(
        isNull(investmentTxn.ledgerTransactionId),
        or(inArray(investmentTxn.type, ["dividend", "interest", "fee"]), and(eq(investmentTxn.type, "transfer"), isNull(investmentTxn.securityId))),
        opts.accountIds && opts.accountIds.length > 0 ? inArray(investmentTxn.accountId, [...opts.accountIds]) : undefined,
      ),
    );
  return rows.length === 0 ? 0 : linkToLedger(tx, rows);
}

// ---- Share-transfer pairing (§3.9) ----

export const TRANSFER_PAIR_DAYS = 3;

export interface PairInvestmentTransfersOptions {
  since?: IsoDate;
  until?: IsoDate;
}

export interface PairInvestmentTransfersResult {
  paired: number;
  /** Every account whose rows were paired (the caller rebuilds them). */
  touchedAccounts: string[];
}

/**
 * Pair unpaired share transfers across accounts: for each `out` leg in (date, id) order, the
 * `in` leg of another account with the same security and quantity within 3 days (closest,
 * then earliest date, then id). Both legs get one `transfer_group_id` and each other's
 * `counterparty_account_id`; the engine then carries the source lots across.
 */
export async function pairInvestmentTransfers(tx: DbOrTx, opts: PairInvestmentTransfersOptions = {}): Promise<PairInvestmentTransfersResult> {
  const rows = await tx
    .select({
      id: investmentTxn.id,
      accountId: investmentTxn.accountId,
      securityId: investmentTxn.securityId,
      date: investmentTxn.date,
      quantity: investmentTxn.quantity,
      direction: investmentTxn.transferDirection,
    })
    .from(investmentTxn)
    .where(
      and(
        eq(investmentTxn.type, "transfer"),
        sql`${investmentTxn.securityId} is not null`,
        isNull(investmentTxn.transferGroupId),
        opts.since ? gte(investmentTxn.date, addDays(opts.since, -TRANSFER_PAIR_DAYS)) : undefined,
        opts.until ? lte(investmentTxn.date, addDays(opts.until, TRANSFER_PAIR_DAYS)) : undefined,
      ),
    );
  const byIdOrder = (a: { date: string; id: string }, b: { date: string; id: string }) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const outs = rows.filter((r) => r.direction === "out").sort(byIdOrder);
  const ins = rows.filter((r) => r.direction === "in").sort(byIdOrder);
  const used = new Set<string>();
  const touched = new Set<string>();
  let paired = 0;
  for (const o of outs) {
    let best: (typeof ins)[number] | undefined;
    let bestDistance = Infinity;
    for (const i of ins) {
      if (used.has(i.id) || i.accountId === o.accountId || i.securityId !== o.securityId || i.quantity !== o.quantity) continue;
      const distance = Math.abs(dayDiff(o.date, i.date));
      if (distance > TRANSFER_PAIR_DAYS) continue;
      if (!best || distance < bestDistance || (distance === bestDistance && byIdOrder(i, best) < 0)) {
        best = i;
        bestDistance = distance;
      }
    }
    if (!best) continue;
    used.add(best.id);
    const groupId = randomUUID();
    const now = new Date();
    await tx.update(investmentTxn).set({ transferGroupId: groupId, counterpartyAccountId: best.accountId, updatedAt: now }).where(eq(investmentTxn.id, o.id));
    await tx.update(investmentTxn).set({ transferGroupId: groupId, counterpartyAccountId: o.accountId, updatedAt: now }).where(eq(investmentTxn.id, best.id));
    touched.add(o.accountId);
    touched.add(best.accountId);
    paired++;
  }
  return { paired, touchedAccounts: [...touched].sort() };
}

// ---- Derived ledger rows (plan decision 15, G1) ----

/** The external id of a ledger row written for an investment row; the income feed keys its synthetic rows the same way. */
export function derivedLedgerExternalId(txnId: string): string {
  return `inv:${txnId}`;
}

/** A cash transfer's ledger twin in an account without a bank feed: created here, kept in step with the row, deleted with it. */
async function createDerivedLedgerRow(tx: DbOrTx, input: { txnId: string; accountId: string; date: IsoDate; amountCents: bigint; description: string; memo: string | null }): Promise<string> {
  const payee = await resolvePayee(tx, "Transfer");
  const [row] = await tx
    .insert(transaction)
    .values({
      accountId: input.accountId,
      externalId: derivedLedgerExternalId(input.txnId),
      source: "manual",
      date: input.date,
      amountCents: input.amountCents,
      payeeId: payee.id,
      rawDescription: input.description,
      memo: input.memo,
      categoryId: null,
      pending: false,
      isTransfer: true,
    })
    .returning({ id: transaction.id });
  return row!.id;
}

async function deleteOwnedLedgerRow(tx: DbOrTx, ledgerTransactionId: string): Promise<void> {
  await unpairTransfer(tx, ledgerTransactionId);
  await tx.delete(transaction).where(eq(transaction.id, ledgerTransactionId));
}

/** A ledger row this side wrote for an investment row: a cash transfer's derived row, or the income feed's synthetic row (`create` mode). */
export type OwnedLedgerTwinKind = "derived_transfer" | "synthetic_income";

type OwnedTwinSource = Pick<TxnRow, "id" | "type" | "securityId" | "ledgerTransactionId" | "importLogId">;

/**
 * The linked ledger row when this side created it, else null: the feed's synthetic income row
 * (`source = 'investment'`), or a cash transfer's derived row (external id `inv:<row id>` from
 * manual entry, or a row of the same `import_log` as the trade import that wrote both). A bank
 * row the linker matched (SimpleFIN, a bank CSV, a hand-entered row) is never owned.
 */
export async function ownedLedgerTwin(tx: DbOrTx, row: OwnedTwinSource): Promise<{ id: string; kind: OwnedLedgerTwinKind } | null> {
  if (!row.ledgerTransactionId) return null;
  const [ledger] = await tx
    .select({ id: transaction.id, source: transaction.source, externalId: transaction.externalId, importLogId: transaction.importLogId })
    .from(transaction)
    .where(eq(transaction.id, row.ledgerTransactionId));
  if (!ledger) return null;
  if (ledger.source === "investment") return { id: ledger.id, kind: "synthetic_income" };
  const derived = ledger.externalId === derivedLedgerExternalId(row.id) || (row.importLogId !== null && ledger.importLogId === row.importLogId);
  return derived && isCashTransfer(row) ? { id: ledger.id, kind: "derived_transfer" } : null;
}

/** Whether a row of the merged shape still earns its owned twin: a derived row needs a cash transfer, a synthetic row a dividend or interest. */
function ownedTwinStillApplies(kind: OwnedLedgerTwinKind, shape: Pick<TxnShape, "type" | "securityId">): boolean {
  return kind === "derived_transfer" ? isCashTransfer(shape) : shape.type === "dividend" || shape.type === "interest";
}

/**
 * Keep an owned twin in step with its row's new shape: deleted when the row is no longer of
 * the twin's kind, else given the row's date and amount when they changed. Returns true when
 * the twin was deleted (the caller clears the link).
 */
async function followOwnedTwin(tx: DbOrTx, twin: { id: string; kind: OwnedLedgerTwinKind }, next: { type: InvestmentTxnType; securityId: string | null; date: IsoDate; amountCents: bigint }, prev: { date: IsoDate; amountCents: bigint }): Promise<boolean> {
  if (!ownedTwinStillApplies(twin.kind, next)) {
    await deleteOwnedLedgerRow(tx, twin.id);
    return true;
  }
  if (next.date !== prev.date || next.amountCents !== prev.amountCents) {
    await tx.update(transaction).set({ date: next.date, amountCents: next.amountCents, updatedAt: new Date() }).where(eq(transaction.id, twin.id));
  }
  return false;
}

// ---- Manual entry (§3.10) ----

export interface CreateInvestmentTxnInput {
  accountId: string;
  date: IsoDate;
  type: InvestmentTxnType;
  securityId?: string | null;
  /** Unsigned. */
  quantity?: Fixed8 | null;
  price?: Fixed8 | null;
  /** Signed; defaulted for buy/sell/reinvest from quantity × price ± fee, required for dividend/interest/fee and cash transfers. */
  amountCents?: bigint | null;
  feeCents?: bigint | null;
  splitNum?: number | null;
  splitDen?: number | null;
  /** Transfers only. */
  direction?: TransferDirection;
  /** Another investment account: the mirror leg is inserted with the same transfer group. */
  counterpartyAccountId?: string | null;
  costBasisCents?: bigint | null;
  acquiredDate?: IsoDate | null;
  /** Sells and transfers out: specific identification, written as `lot_pick` rows. */
  lotPicks?: readonly LotPickInputRecord[];
  memo?: string | null;
}

export interface CreateInvestmentTxnResult {
  /** The entered row first, then the mirror leg when a counterparty was given. */
  items: InvestmentTxnRecord[];
  /** `prices.fetch` / `investments.income_feed` ids queued after the write. */
  jobs: { incomeFeed: string | null };
  rebuildWarnings: EngineWarning[];
}

/** Defaults and per-type requirements of a manual row, then the CHECK mirror. */
function normalizeManual(input: CreateInvestmentTxnInput): TxnShape {
  const quantity = input.quantity ?? null;
  const price = input.price ?? null;
  const fee = input.feeCents ?? 0n;
  const securityId = input.securityId ?? null;
  const validation = (message: string): never => {
    throw new PlanError(400, "validation", message);
  };
  let amountCents: bigint;
  let direction: TransferDirection | null = null;
  switch (input.type) {
    case "buy":
    case "sell":
    case "reinvest": {
      if (securityId === null) validation("A trade needs a security");
      if (quantity === null || quantity <= 0n) validation("quantity must be positive");
      if (price === null) validation("price is required");
      if (input.amountCents !== undefined && input.amountCents !== null) amountCents = input.amountCents;
      else {
        const gross = mulToCents(quantity!, price!);
        amountCents = input.type === "sell" ? gross - fee : -(gross + fee);
      }
      break;
    }
    case "dividend":
    case "interest":
    case "fee":
      if (input.amountCents === undefined || input.amountCents === null) throw new PlanError(400, "amount_required", `A ${input.type} needs an amount`);
      amountCents = input.amountCents;
      break;
    case "split":
      if (securityId === null) validation("A split needs a security");
      if (input.splitNum === undefined || input.splitNum === null || input.splitDen === undefined || input.splitDen === null) validation("A split needs its ratio");
      if (!Number.isInteger(input.splitNum) || !Number.isInteger(input.splitDen) || input.splitNum! < 1 || input.splitDen! < 1) validation("A split ratio is two positive integers");
      amountCents = 0n;
      break;
    case "transfer":
      if (!input.direction) validation("A transfer needs a direction");
      direction = input.direction!;
      if (securityId === null) {
        if (input.amountCents === undefined || input.amountCents === null) throw new PlanError(400, "amount_required", "A cash transfer needs an amount");
        amountCents = input.amountCents;
        if (quantity !== null) validation("A cash transfer has no quantity");
      } else {
        if (quantity === null || quantity <= 0n) validation("A share transfer needs a positive quantity");
        amountCents = 0n;
      }
      break;
  }
  const shape: TxnShape = {
    type: input.type,
    securityId,
    quantity: input.type === "dividend" || input.type === "interest" || input.type === "fee" ? null : quantity,
    price: input.type === "buy" || input.type === "sell" || input.type === "reinvest" ? price : null,
    amountCents,
    feeCents: fee,
    splitNum: input.type === "split" ? input.splitNum! : null,
    splitDen: input.type === "split" ? input.splitDen! : null,
    transferDirection: direction,
    costBasisCents: input.costBasisCents ?? null,
    acquiredDate: input.acquiredDate ?? null,
  };
  assertTxnShape(shape);
  return shape;
}

async function incomeFeedOf(tx: DbOrTx, accountId: string): Promise<"off" | "link" | "create"> {
  const [row] = await tx.select({ feed: account.investmentIncomeFeed }).from(account).where(eq(account.id, accountId));
  return row?.feed ?? "off";
}

/**
 * A row's ledger side after it was written: link the bank twin (SimpleFIN-fed accounts, or
 * any account that already holds a matching row), else — for cash transfers in accounts
 * without a feed — create the derived ledger row and let it pair with the other side.
 */
async function settleLedgerSide(tx: DbOrTx, row: TxnRow, acct: InvestmentAccountRow, memo: string | null): Promise<{ linked: number; ledgerCreated: number; transfersPaired: number }> {
  if (!isLinkable(row)) return { linked: 0, ledgerCreated: 0, transfersPaired: 0 };
  const linked = await linkToLedger(tx, [{ id: row.id, accountId: row.accountId, date: row.date, amountCents: row.amountCents }]);
  if (linked > 0 || acct.simplefinFed || !isCashTransfer(row)) return { linked, ledgerCreated: 0, transfersPaired: 0 };
  const description = sanitizeText(row.rawDescription, 500) || (row.transferDirection === "in" ? "Transfer in" : "Transfer out");
  const ledgerId = await createDerivedLedgerRow(tx, { txnId: row.id, accountId: row.accountId, date: row.date, amountCents: row.amountCents, description, memo });
  await tx.update(investmentTxn).set({ ledgerTransactionId: ledgerId, updatedAt: new Date() }).where(eq(investmentTxn.id, row.id));
  const transfersPaired = await pairTransfersInDb(tx, { since: row.date, until: row.date });
  return { linked: 0, ledgerCreated: 1, transfersPaired };
}

/**
 * `POST /api/investments/transactions`: validates per type (400 `txn_invalid` naming the
 * rule, 400 `validation`, 400 `amount_required`, 400 `future_date`, 400
 * `not_investment_account`), defaults the amount, numbers the row after its day's rows,
 * inserts the mirror leg of an own-account transfer (400 `transfer_same_account`), writes
 * lot picks, settles the ledger side, rebuilds lots and audits every row in one batch.
 */
export async function createInvestmentTxn(db: Db, input: CreateInvestmentTxnInput, ctx: AuditContext & { today: IsoDate }): Promise<CreateInvestmentTxnResult> {
  if (input.date > ctx.today) throw new PlanError(400, "future_date", `${input.date} is after today`);
  const shape = normalizeManual(input);
  const memo = input.memo === undefined || input.memo === null ? null : sanitizeText(input.memo, 2000) || null;
  return db.transaction(async (tx) => {
    const acct = await loadInvestmentAccount(tx, input.accountId);
    if (shape.securityId !== null) await requireSecurity(tx, shape.securityId);
    let counterparty: InvestmentAccountRow | null = null;
    if (shape.type === "transfer" && input.counterpartyAccountId) {
      if (input.counterpartyAccountId === input.accountId) throw new PlanError(400, "transfer_same_account", "A transfer needs two different accounts");
      counterparty = await loadInvestmentAccount(tx, input.counterpartyAccountId);
    }
    const groupId = counterparty ? randomUUID() : null;
    const id = randomUUID();
    const picks = input.lotPicks && input.lotPicks.length > 0 ? input.lotPicks : [];
    const sequence = await nextSequence(tx, input.accountId, input.date);
    const validatedPicks = await validateLotPicks(
      tx,
      { id, accountId: input.accountId, securityId: shape.securityId, type: shape.type, transferDirection: shape.transferDirection, date: input.date, sequence, quantity: shape.quantity },
      picks,
    ).catch((err: unknown) => {
      if (err instanceof PlanError && err.code === "not_a_sale" && picks.length === 0) return [];
      throw err;
    });

    const base: TxnInsert = {
      id,
      accountId: input.accountId,
      securityId: shape.securityId,
      date: input.date,
      sequence,
      type: shape.type,
      quantity: qtyToDb(shape.quantity),
      price: qtyToDb(shape.price),
      amountCents: shape.amountCents,
      feeCents: shape.feeCents,
      splitNum: shape.splitNum,
      splitDen: shape.splitDen,
      transferDirection: shape.transferDirection,
      counterpartyAccountId: counterparty?.id ?? null,
      transferGroupId: groupId,
      costBasisCents: shape.costBasisCents,
      acquiredDate: shape.acquiredDate,
      source: "manual",
      externalId: null,
      rawDescription: null,
      memo,
      userEdited: false,
    };
    const inserted: TxnRow[] = await tx.insert(investmentTxn).values(base).returning();
    const first = inserted[0]!;
    const written: Array<{ row: TxnRow; acct: InvestmentAccountRow }> = [{ row: first, acct }];
    if (counterparty && groupId) {
      const mirrorDirection: TransferDirection = shape.transferDirection === "in" ? "out" : "in";
      const mirror: TxnInsert = {
        ...base,
        id: randomUUID(),
        accountId: counterparty.id,
        sequence: await nextSequence(tx, counterparty.id, input.date),
        amountCents: shape.securityId === null ? -shape.amountCents : 0n,
        transferDirection: mirrorDirection,
        counterpartyAccountId: input.accountId,
        costBasisCents: null,
        acquiredDate: null,
      };
      const [mirrorRow] = await tx.insert(investmentTxn).values(mirror).returning();
      written.push({ row: mirrorRow!, acct: counterparty });
    }
    const pickRows = validatedPicks.length > 0 ? await writeLotPicks(tx, id, validatedPicks) : [];
    for (const w of written) await settleLedgerSide(tx, w.row, w.acct, memo);
    const rebuilt = await rebuildLotsForAccounts(tx, written.map((w) => w.row.accountId));
    for (const w of written) {
      const fresh = await requireTxn(tx, w.row.id);
      await writeAudit(tx, { ...ctx, entity: "investment_txn", entityId: fresh.id, action: "create", before: null, after: investmentTxnAuditJson(fresh, fresh.id === id ? pickRows : []) });
    }
    let incomeFeed: string | null = null;
    if ((shape.type === "dividend" || shape.type === "interest") && (await incomeFeedOf(tx, input.accountId)) !== "off") {
      incomeFeed = (await enqueueJob(tx, "investments.income_feed", { reason: "manual", dedupeKey: "investments.income_feed" }, { dedupe: true })).id;
    }
    const items: InvestmentTxnRecord[] = [];
    for (const w of written) items.push((await getInvestmentTxn(tx, w.row.id))!);
    return { items, jobs: { incomeFeed }, rebuildWarnings: rebuilt.warnings };
  });
}

export interface UpdateInvestmentTxnInput {
  type?: InvestmentTxnType;
  transferDirection?: TransferDirection | null;
  date?: IsoDate;
  securityId?: string | null;
  quantity?: Fixed8 | null;
  price?: Fixed8 | null;
  amountCents?: bigint;
  feeCents?: bigint;
  splitNum?: number | null;
  splitDen?: number | null;
  costBasisCents?: bigint | null;
  acquiredDate?: IsoDate | null;
  ledgerTransactionId?: string | null;
  /** `null` unpairs both legs of an own-account transfer. */
  transferGroupId?: null;
  memo?: string | null;
}

const SOURCE_OWNED = ["type", "transferDirection", "date", "securityId", "quantity", "price", "amountCents", "feeCents", "splitNum", "splitDen"] as const;

/**
 * `PATCH /api/investments/transactions/:id`: any column may change; the merged row is
 * re-validated as a whole; a paired transfer leg refuses a change of type, security, quantity
 * or direction (409 `transfer_leg_linked`) unless the request also clears the group, and a
 * paired cash transfer's amount or date change mirrors onto the other leg (negated amount,
 * same date) and the derived ledger row this side wrote for it, so the group stays equal and
 * opposite (the other leg is audited in the same batch); a
 * source-owned change on an imported row sets `user_edited`; picks that no longer apply are
 * dropped; a ledger row this side wrote (a derived transfer row or the feed's synthetic
 * income row) follows the date and amount, or goes when the row leaves its kind or the link
 * moves elsewhere, while a merely linked bank row is left alone; lots are rebuilt; audited.
 */
export async function updateInvestmentTxn(db: Db, id: string, patch: UpdateInvestmentTxnInput, ctx: AuditContext & { today: IsoDate }): Promise<{ item: InvestmentTxnRecord; rebuildWarnings: EngineWarning[] }> {
  return db.transaction(async (tx) => {
    const row = await requireTxn(tx, id);
    await loadInvestmentAccount(tx, row.accountId);
    const picksBefore = (await listLotPicks(tx, [id])).get(id) ?? [];
    const before = investmentTxnAuditJson(row, picksBefore);
    const accounts = new Set<string>([row.accountId]);

    let groupId = row.transferGroupId;
    let counterpartyId = row.counterpartyAccountId;
    // Unpairing clears both legs; the other leg is an affected row and gets its own audit entry in this batch.
    const otherLegs: Array<{ row: TxnRow; picks: LotPickRecord[] }> = [];
    if (patch.transferGroupId === null && row.transferGroupId) {
      const legs = await tx.select().from(investmentTxn).where(and(eq(investmentTxn.transferGroupId, row.transferGroupId), ne(investmentTxn.id, id)));
      for (const leg of legs) {
        otherLegs.push({ row: leg, picks: (await listLotPicks(tx, [leg.id])).get(leg.id) ?? [] });
        accounts.add(leg.accountId);
      }
      await tx.update(investmentTxn).set({ transferGroupId: null, counterpartyAccountId: null, updatedAt: new Date() }).where(eq(investmentTxn.transferGroupId, row.transferGroupId));
      groupId = null;
      counterpartyId = null;
    }

    const current: TxnShape = {
      type: row.type,
      securityId: row.securityId,
      quantity: qtyFromDb(row.quantity),
      price: qtyFromDb(row.price),
      amountCents: row.amountCents,
      feeCents: row.feeCents,
      splitNum: row.splitNum,
      splitDen: row.splitDen,
      transferDirection: row.transferDirection,
      costBasisCents: row.costBasisCents,
      acquiredDate: row.acquiredDate,
    };
    const merged: TxnShape = {
      type: patch.type ?? current.type,
      securityId: patch.securityId !== undefined ? patch.securityId : current.securityId,
      quantity: patch.quantity !== undefined ? patch.quantity : current.quantity,
      price: patch.price !== undefined ? patch.price : current.price,
      amountCents: patch.amountCents !== undefined ? patch.amountCents : current.amountCents,
      feeCents: patch.feeCents !== undefined ? patch.feeCents : current.feeCents,
      splitNum: patch.splitNum !== undefined ? patch.splitNum : current.splitNum,
      splitDen: patch.splitDen !== undefined ? patch.splitDen : current.splitDen,
      transferDirection: patch.transferDirection !== undefined ? patch.transferDirection : current.transferDirection,
      costBasisCents: patch.costBasisCents !== undefined ? patch.costBasisCents : current.costBasisCents,
      acquiredDate: patch.acquiredDate !== undefined ? patch.acquiredDate : current.acquiredDate,
    };
    const date = patch.date ?? row.date;
    if (date > ctx.today) throw new PlanError(400, "future_date", `${date} is after today`);
    if (groupId !== null) {
      const legChanged =
        merged.type !== current.type || merged.securityId !== current.securityId || merged.quantity !== current.quantity || merged.transferDirection !== current.transferDirection;
      if (legChanged) throw new PlanError(409, "transfer_leg_linked", "This leg is paired with another account's leg; unpair it first (transferGroupId: null)");
    }
    if (merged.type === "transfer" && merged.transferDirection === null) throw new PlanError(400, "validation", "A transfer needs a direction");
    if ((merged.type === "buy" || merged.type === "sell" || merged.type === "reinvest") && (merged.quantity === null || merged.quantity <= 0n)) {
      throw new PlanError(400, "validation", "quantity must be positive");
    }
    if (merged.type === "split" && (merged.splitNum === null || merged.splitDen === null || merged.splitNum < 1 || merged.splitDen < 1)) {
      throw new PlanError(400, "validation", "A split ratio is two positive integers");
    }
    if (merged.type === "dividend" || merged.type === "interest" || merged.type === "fee") {
      merged.quantity = null;
      merged.price = null;
    }
    if (merged.type !== "split") {
      merged.splitNum = null;
      merged.splitDen = null;
    }
    if (merged.type !== "transfer") merged.transferDirection = null;
    assertTxnShape(merged);
    if (merged.securityId !== null && merged.securityId !== current.securityId) await requireSecurity(tx, merged.securityId);

    let ledgerTransactionId = row.ledgerTransactionId;
    if (patch.ledgerTransactionId !== undefined && patch.ledgerTransactionId !== row.ledgerTransactionId) {
      if (patch.ledgerTransactionId !== null) {
        const [ledger] = await tx.select({ accountId: transaction.accountId }).from(transaction).where(eq(transaction.id, patch.ledgerTransactionId));
        if (!ledger) throw new PlanError(404, "not_found", "Ledger transaction not found");
        if (ledger.accountId !== row.accountId) throw new PlanError(400, "validation", "The ledger row belongs to another account");
        const [other] = await tx.select({ id: investmentTxn.id }).from(investmentTxn).where(and(eq(investmentTxn.ledgerTransactionId, patch.ledgerTransactionId), ne(investmentTxn.id, id)));
        if (other) throw new PlanError(409, "ledger_linked", "That ledger row is already linked to another investment transaction");
      }
      ledgerTransactionId = patch.ledgerTransactionId;
    }

    const sourceChanged = SOURCE_OWNED.some((k) => (k === "date" ? date !== row.date : merged[k] !== current[k]));
    const stillSale = merged.type === "sell" || (merged.type === "transfer" && merged.transferDirection === "out" && merged.securityId !== null);
    const picksCleared = picksBefore.length > 0 && (!stillSale || merged.securityId !== current.securityId);
    if (picksCleared) await writeLotPicks(tx, id, []);

    // Only a ledger row this side wrote follows the row (plan decisions 13 and 15); a bank row the linker matched is the owner's.
    const twin = await ownedLedgerTwin(tx, row);
    if (twin) {
      if (ledgerTransactionId !== row.ledgerTransactionId) {
        // The link moved elsewhere (or was cleared): the twin would only duplicate the new row.
        await deleteOwnedLedgerRow(tx, twin.id);
      } else if (await followOwnedTwin(tx, twin, { type: merged.type, securityId: merged.securityId, date, amountCents: merged.amountCents }, { date: row.date, amountCents: row.amountCents })) {
        ledgerTransactionId = null;
      }
    }

    // A paired cash transfer stays equal and opposite: an amount or date change mirrors onto the
    // other leg (negated amount, same date) and onto its owned ledger twin; a merely linked bank
    // row on that side is the owner's and stays. The other leg is audited below with `otherLegs`.
    if (groupId !== null && isCashTransfer(merged) && (merged.amountCents !== current.amountCents || date !== row.date)) {
      const legs = await tx.select().from(investmentTxn).where(and(eq(investmentTxn.transferGroupId, groupId), ne(investmentTxn.id, id)));
      for (const leg of legs) {
        otherLegs.push({ row: leg, picks: (await listLotPicks(tx, [leg.id])).get(leg.id) ?? [] });
        accounts.add(leg.accountId);
        const legAmountCents = -merged.amountCents;
        const legTwin = await ownedLedgerTwin(tx, leg);
        if (legTwin) await followOwnedTwin(tx, legTwin, { type: leg.type, securityId: leg.securityId, date, amountCents: legAmountCents }, { date: leg.date, amountCents: leg.amountCents });
        await tx
          .update(investmentTxn)
          .set({ date, amountCents: legAmountCents, userEdited: leg.userEdited || leg.source !== "manual", updatedAt: new Date() })
          .where(eq(investmentTxn.id, leg.id));
      }
    }

    const memo = patch.memo === undefined ? row.memo : patch.memo === null ? null : sanitizeText(patch.memo, 2000) || null;
    await tx
      .update(investmentTxn)
      .set({
        type: merged.type,
        securityId: merged.securityId,
        date,
        quantity: qtyToDb(merged.quantity),
        price: qtyToDb(merged.price),
        amountCents: merged.amountCents,
        feeCents: merged.feeCents,
        splitNum: merged.splitNum,
        splitDen: merged.splitDen,
        transferDirection: merged.transferDirection,
        counterpartyAccountId: counterpartyId,
        transferGroupId: groupId,
        costBasisCents: merged.costBasisCents,
        acquiredDate: merged.acquiredDate,
        ledgerTransactionId,
        memo,
        userEdited: row.userEdited || (row.source !== "manual" && sourceChanged),
        updatedAt: new Date(),
      })
      .where(eq(investmentTxn.id, id));
    if (row.counterpartyAccountId) accounts.add(row.counterpartyAccountId);
    const rebuilt = await rebuildLotsForAccounts(tx, [...accounts]);
    const after = await requireTxn(tx, id);
    const picksAfter = (await listLotPicks(tx, [id])).get(id) ?? [];
    await writeAudit(tx, { ...ctx, entity: "investment_txn", entityId: id, action: "update", before, after: investmentTxnAuditJson(after, picksAfter) });
    for (const leg of otherLegs) {
      const fresh = await requireTxn(tx, leg.row.id);
      await writeAudit(tx, { ...ctx, entity: "investment_txn", entityId: fresh.id, action: "update", before: investmentTxnAuditJson(leg.row, leg.picks), after: investmentTxnAuditJson(fresh, leg.picks) });
    }
    return { item: (await getInvestmentTxn(tx, id))!, rebuildWarnings: rebuilt.warnings };
  });
}

/**
 * `DELETE /api/investments/transactions/:id`: manual and imported rows delete alike; a paired
 * transfer leg needs `deleteGroup` (409 `transfer_leg_linked`), which removes both legs; a
 * ledger row this side wrote (a derived transfer row, the feed's synthetic income row) goes
 * with its row, a merely linked bank row stays (the link clears); lots are rebuilt; audited
 * per row.
 */
export async function deleteInvestmentTxn(db: Db, id: string, opts: { deleteGroup?: boolean }, ctx: AuditContext): Promise<{ deleted: number; rebuildWarnings: EngineWarning[] }> {
  return db.transaction(async (tx) => {
    const row = await requireTxn(tx, id);
    let rows: TxnRow[] = [row];
    if (row.transferGroupId) {
      if (!opts.deleteGroup) throw new PlanError(409, "transfer_leg_linked", "This leg is paired with another account's leg; delete the group (deleteGroup=true)");
      rows = await tx.select().from(investmentTxn).where(eq(investmentTxn.transferGroupId, row.transferGroupId));
    }
    const accounts = new Set<string>();
    for (const r of rows) {
      accounts.add(r.accountId);
      if (r.counterpartyAccountId) accounts.add(r.counterpartyAccountId);
      const picks = (await listLotPicks(tx, [r.id])).get(r.id) ?? [];
      const twin = await ownedLedgerTwin(tx, r);
      if (twin) await deleteOwnedLedgerRow(tx, twin.id);
      await writeAudit(tx, { ...ctx, entity: "investment_txn", entityId: r.id, action: "delete", before: investmentTxnAuditJson(r, picks), after: null });
      await tx.delete(investmentTxn).where(eq(investmentTxn.id, r.id));
    }
    const rebuilt = await rebuildLotsForAccounts(tx, [...accounts]);
    return { deleted: rows.length, rebuildWarnings: rebuilt.warnings };
  });
}

// ---- Trade import (§3.9) ----

export interface ImportWarning {
  rowIndex: number;
  code: string;
  message: string;
}

export interface UpsertInvestmentTxnsInput {
  accountId: string;
  trades: readonly MappedTrade[];
  source?: "csv";
  importLogId?: string | null;
  /** Per-row security choices from the preview (`existing` or `create`). */
  choices?: readonly RowChoice[];
  /** Needed for a `create` choice (an audited security create). */
  ctx?: AuditContext;
}

export interface CashRowRef {
  txnId: string;
  rowIndex: number;
  date: IsoDate;
  amountCents: bigint;
  description: string;
  ledgerTransactionId: string | null;
}

export interface UpsertInvestmentTxnsResult {
  created: number;
  updated: number;
  unchanged: number;
  skippedEdited: number;
  securitiesCreated: number;
  linked: number;
  transfersPaired: number;
  lotsRebuilt: number;
  /** Accounts whose lots were rebuilt. */
  touchedAccounts: string[];
  /** The new cash transfer rows, with the ledger row they were linked to (if any). */
  cashRows: CashRowRef[];
  createdIds: string[];
  warnings: ImportWarning[];
  rebuildWarnings: EngineWarning[];
}

async function chooseTradeSecurity(tx: DbOrTx, choice: SecurityChoice, ctx: AuditContext | undefined, learnFrom: { ticker: string | null; cusip: string | null; name: string | null }): Promise<{ id: string; created: boolean }> {
  if (choice.kind === "existing") {
    const row = await requireSecurity(tx, choice.securityId);
    try {
      await learnAliases(tx, row.id, learnFrom);
    } catch (err) {
      if (!(err instanceof PlanError && err.code === "alias_taken")) throw err;
    }
    return { id: row.id, created: false };
  }
  const s = choice.security;
  if (isCashKey({ ticker: s.ticker, name: s.name })) {
    const { row, created } = await cashSecurity(tx);
    return { id: row.id, created };
  }
  const resolved = await resolveSecurity(tx, { ticker: s.ticker, cusip: s.cusip, isin: s.isin, name: s.name }, { createIfMissing: false, source: "csv" });
  if (resolved.id !== null) return { id: resolved.id, created: false };
  if (!ctx) throw new PlanError(400, "validation", "Creating a security from a choice needs an audit context");
  const created = await createSecurity(tx, { ticker: s.ticker, name: s.name, type: s.type, assetClass: s.assetClass, cusip: s.cusip, isin: s.isin }, ctx, { needsReview: false });
  return { id: created.id, created: true };
}

interface DesiredRow {
  trade: MappedTrade;
  values: TxnInsert;
}

function sameNullable<T>(a: T | null, b: T | null): boolean {
  return a === b;
}

/**
 * Write a trade file's rows into one account (§3.9 steps 1–7) inside the caller's
 * transaction: securities resolved (choices first, then created with review), existing rows
 * matched on `external_id`, source-owned columns diffed, owner-edited rows left alone, new rows
 * inserted, income and cash rows linked to the ledger, share transfers paired across accounts,
 * lots rebuilt for every touched account. User-owned columns (memo, links, basis, picks) are
 * never touched; a type change that makes a row's picks or carried basis invalid drops them
 * with a warning. A ledger row this side wrote for the row (a derived transfer row, the
 * feed's synthetic income row) takes the new date and amount, or goes (with a warning) when
 * the row is no longer a cash transfer or income.
 */
export async function upsertInvestmentTxns(tx: DbOrTx, input: UpsertInvestmentTxnsInput): Promise<UpsertInvestmentTxnsResult> {
  const result: UpsertInvestmentTxnsResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skippedEdited: 0,
    securitiesCreated: 0,
    linked: 0,
    transfersPaired: 0,
    lotsRebuilt: 0,
    touchedAccounts: [],
    cashRows: [],
    createdIds: [],
    warnings: [],
    rebuildWarnings: [],
  };
  if (input.trades.length === 0) return result;
  const source = input.source ?? "csv";
  const choices = new Map<number, SecurityChoice>();
  for (const c of input.choices ?? []) if (c.security) choices.set(c.rowIndex, c.security);

  // 1. Securities.
  const resolvedByKey = new Map<string, string>();
  const desired: DesiredRow[] = [];
  for (const t of input.trades) {
    let securityId: string | null = null;
    const hasIdentity = t.ticker !== null || t.name !== null || t.cusip !== null;
    if (hasIdentity && !(t.type === "transfer" && t.kind !== "transfer_in" && t.kind !== "transfer_out")) {
      const choice = choices.get(t.rowIndex);
      const key = choice ? `row:${t.rowIndex}` : `${t.ticker ?? ""}|${t.cusip ?? ""}|${t.name ?? ""}`;
      let id = resolvedByKey.get(key);
      if (!id) {
        if (choice) {
          const chosen = await chooseTradeSecurity(tx, choice, input.ctx, { ticker: t.ticker, cusip: t.cusip, name: t.name });
          if (chosen.created) result.securitiesCreated++;
          id = chosen.id;
        } else {
          const r = await resolveSecurity(tx, { ticker: t.ticker, cusip: t.cusip, name: t.name }, { createIfMissing: true, source: "csv" });
          if (r.id === null) throw new PlanError(400, "validation", `Row ${t.rowIndex}: security could not be resolved`);
          if (r.created) result.securitiesCreated++;
          id = r.id;
        }
        resolvedByKey.set(key, id);
      }
      securityId = id;
    }
    const shape: TxnShape = {
      type: t.type,
      securityId,
      quantity: t.quantity,
      price: t.price,
      amountCents: t.amountCents,
      feeCents: t.feeCents,
      splitNum: t.splitNum,
      splitDen: t.splitDen,
      transferDirection: t.transferDirection,
      costBasisCents: null,
      acquiredDate: null,
    };
    try {
      assertTxnShape(shape);
    } catch (err) {
      if (err instanceof PlanError) throw new PlanError(err.status, err.code, `Row ${t.rowIndex}: ${err.message}`);
      throw err;
    }
    desired.push({
      trade: t,
      values: {
        accountId: input.accountId,
        securityId,
        date: t.date,
        sequence: t.sequence,
        type: t.type,
        quantity: qtyToDb(t.quantity),
        price: qtyToDb(t.price),
        amountCents: t.amountCents,
        feeCents: t.feeCents,
        splitNum: t.splitNum,
        splitDen: t.splitDen,
        transferDirection: t.transferDirection,
        source,
        externalId: t.externalId,
        importLogId: input.importLogId ?? null,
        rawDescription: sanitizeText(t.rawDescription, 500) || null,
      },
    });
  }

  // 2. Existing rows by external id.
  const existing = new Map<string, TxnRow>();
  const ids = desired.map((d) => d.values.externalId!);
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await tx
      .select()
      .from(investmentTxn)
      .where(and(eq(investmentTxn.accountId, input.accountId), inArray(investmentTxn.externalId, ids.slice(i, i + 500))));
    for (const r of rows) existing.set(r.externalId!, r);
  }

  // 3. Diff or insert.
  const fresh: DesiredRow[] = [];
  const unpairedGroups = new Set<string>();
  let picksCleared = 0;
  for (const d of desired) {
    const row = existing.get(d.values.externalId!);
    if (!row) {
      fresh.push(d);
      continue;
    }
    if (row.userEdited) {
      result.skippedEdited++;
      continue;
    }
    const v = d.values;
    const patch: Partial<TxnInsert> = {};
    if (row.date !== v.date) patch.date = v.date;
    if (row.sequence !== v.sequence) patch.sequence = v.sequence;
    if (row.type !== v.type) patch.type = v.type;
    if (!sameNullable(row.securityId, v.securityId ?? null)) patch.securityId = v.securityId ?? null;
    if (!sameNullable(qtyFromDb(row.quantity), d.trade.quantity)) patch.quantity = v.quantity ?? null;
    if (!sameNullable(qtyFromDb(row.price), d.trade.price)) patch.price = v.price ?? null;
    if (row.amountCents !== v.amountCents) patch.amountCents = v.amountCents;
    if (row.feeCents !== (v.feeCents ?? 0n)) patch.feeCents = v.feeCents ?? 0n;
    if (!sameNullable(row.splitNum, v.splitNum ?? null)) patch.splitNum = v.splitNum ?? null;
    if (!sameNullable(row.splitDen, v.splitDen ?? null)) patch.splitDen = v.splitDen ?? null;
    if (!sameNullable(row.transferDirection, v.transferDirection ?? null)) patch.transferDirection = v.transferDirection ?? null;
    if (!sameNullable(row.rawDescription, v.rawDescription ?? null)) patch.rawDescription = v.rawDescription ?? null;
    if (Object.keys(patch).length === 0) {
      result.unchanged++;
      continue;
    }
    const newType = patch.type ?? row.type;
    const newDirection = patch.transferDirection !== undefined ? patch.transferDirection : row.transferDirection;
    const newSecurity = patch.securityId !== undefined ? patch.securityId : row.securityId;
    const identityChanged = patch.type !== undefined || patch.securityId !== undefined || patch.quantity !== undefined || patch.transferDirection !== undefined;
    if (row.transferGroupId && identityChanged) {
      unpairedGroups.add(row.transferGroupId);
      patch.transferGroupId = null;
      patch.counterpartyAccountId = null;
      result.warnings.push({ rowIndex: d.trade.rowIndex, code: "transfer_unpaired", message: "The row changed; its transfer pairing was cleared" });
    }
    const stillSale = newType === "sell" || (newType === "transfer" && newDirection === "out" && newSecurity !== null);
    if (!stillSale || newSecurity !== row.securityId) {
      const picks = (await listLotPicks(tx, [row.id])).get(row.id) ?? [];
      if (picks.length > 0) {
        await writeLotPicks(tx, row.id, []);
        picksCleared++;
        result.warnings.push({ rowIndex: d.trade.rowIndex, code: "lot_picks_cleared", message: "The row is no longer a sale; its lot picks were cleared" });
      }
    }
    const stillTransferIn = newType === "transfer" && newDirection === "in" && newSecurity !== null;
    if ((row.costBasisCents !== null || row.acquiredDate !== null) && !stillTransferIn) {
      patch.costBasisCents = null;
      patch.acquiredDate = null;
      result.warnings.push({ rowIndex: d.trade.rowIndex, code: "basis_cleared", message: "The row is no longer a transfer in; its carried basis was cleared" });
    }
    if (row.ledgerTransactionId && (patch.type !== undefined || patch.securityId !== undefined || patch.date !== undefined || patch.amountCents !== undefined)) {
      const twin = await ownedLedgerTwin(tx, row);
      if (twin && (await followOwnedTwin(tx, twin, { type: newType, securityId: newSecurity, date: patch.date ?? row.date, amountCents: patch.amountCents ?? row.amountCents }, { date: row.date, amountCents: row.amountCents }))) {
        patch.ledgerTransactionId = null;
        result.warnings.push({ rowIndex: d.trade.rowIndex, code: "ledger_row_removed", message: "The row is no longer a cash transfer or income; the ledger row written for it was removed" });
      }
    }
    patch.updatedAt = new Date();
    await tx.update(investmentTxn).set(patch).where(eq(investmentTxn.id, row.id));
    result.updated++;
  }
  for (const groupId of unpairedGroups) {
    await tx.update(investmentTxn).set({ transferGroupId: null, counterpartyAccountId: null, updatedAt: new Date() }).where(eq(investmentTxn.transferGroupId, groupId));
  }

  // 4. New rows (ON CONFLICT DO NOTHING guards a concurrent import).
  const insertedByExternalId = new Map<string, string>();
  for (let i = 0; i < fresh.length; i += 500) {
    const batch = fresh.slice(i, i + 500);
    const rows = await tx
      .insert(investmentTxn)
      .values(batch.map((d) => d.values))
      .onConflictDoNothing()
      .returning({ id: investmentTxn.id, externalId: investmentTxn.externalId });
    for (const r of rows) insertedByExternalId.set(r.externalId!, r.id);
  }
  result.created = insertedByExternalId.size;
  result.unchanged += fresh.length - insertedByExternalId.size;
  result.createdIds = [...insertedByExternalId.values()];

  // 5. Ledger links for the new income and cash rows.
  const linkable: LinkCandidate[] = [];
  for (const d of fresh) {
    const id = insertedByExternalId.get(d.values.externalId!);
    if (!id) continue;
    if (isLinkable({ type: d.trade.type, securityId: d.values.securityId ?? null })) {
      linkable.push({ id, accountId: input.accountId, date: d.trade.date, amountCents: d.trade.amountCents });
    }
  }
  if (linkable.length > 0) result.linked = await linkToLedger(tx, linkable);
  for (const d of fresh) {
    const id = insertedByExternalId.get(d.values.externalId!);
    if (!id || !isCashTransfer({ type: d.trade.type, securityId: d.values.securityId ?? null })) continue;
    const [r] = await tx.select({ ledgerTransactionId: investmentTxn.ledgerTransactionId }).from(investmentTxn).where(eq(investmentTxn.id, id));
    result.cashRows.push({
      txnId: id,
      rowIndex: d.trade.rowIndex,
      date: d.trade.date,
      amountCents: d.trade.amountCents,
      description: d.values.rawDescription ?? "",
      ledgerTransactionId: r?.ledgerTransactionId ?? null,
    });
  }

  // 6. Share-transfer pairing over the import's date range.
  const dates = desired.map((d) => d.trade.date).sort();
  const shareTransfers = desired.some((d) => d.trade.type === "transfer" && d.values.securityId);
  let touched = new Set<string>();
  if (shareTransfers || unpairedGroups.size > 0) {
    const paired = await pairInvestmentTransfers(tx, { since: dates[0]!, until: dates[dates.length - 1]! });
    result.transfersPaired = paired.paired;
    touched = new Set(paired.touchedAccounts);
  }

  // 7. Lots.
  if (result.created + result.updated + picksCleared + result.transfersPaired + unpairedGroups.size > 0) {
    touched.add(input.accountId);
    const rebuilt = await rebuildLotsForAccounts(tx, [...touched]);
    result.lotsRebuilt = rebuilt.accountIds.length;
    result.touchedAccounts = rebuilt.accountIds;
    result.rebuildWarnings = rebuilt.warnings;
  }
  return result;
}

export interface ImportTradesInput {
  accountId: string;
  trades: readonly MappedTrade[];
  /** Action keys with unclassified rows (`actionsFound` entries with `kind` null); non-empty refuses the commit. */
  unknownActionKeys?: readonly string[];
  choices?: readonly RowChoice[];
  importLogId?: string | null;
  today: IsoDate;
  ctx: AuditContext;
  /** True when a price provider is configured: a created security queues the holdings price refresh. */
  queuePriceRefresh?: boolean;
  now?: Date;
}

export interface ImportTradesResult {
  created: number;
  updated: number;
  unchanged: number;
  skippedEdited: number;
  linked: number;
  ledgerCreated: number;
  ledgerSkipped: number;
  transfersPaired: number;
  securitiesCreated: number;
  lotsRebuilt: number;
  warnings: ImportWarning[];
  rebuildWarnings: EngineWarning[];
  jobs: { recurringDetect: string | null; priceRefresh: string | null; incomeFeed: string | null };
}

/**
 * The trades commit (§3.9 `importTrades`): an investment account (400
 * `not_investment_account`), every row dated on or before today (400 `future_date` naming
 * the first offending row), no unclassified action (400 `unknown_action` listing the keys);
 * then, in one transaction, `upsertInvestmentTxns` and — for accounts without a SimpleFIN
 * feed — a ledger row (`is_transfer`, Phase 1 content-hash id) for every new cash transfer
 * that found no bank twin, linked by `ledger_transaction_id` and paired across accounts.
 * After the commit: `recurring.detect` when ledger rows were created, the holdings price
 * refresh when a security was created (and a provider is configured), and the income feed
 * when any row was written. The route writes the `import_log` row around this call.
 */
export async function importTrades(db: Db, input: ImportTradesInput): Promise<ImportTradesResult> {
  const acct = await loadInvestmentAccount(db, input.accountId);
  const future = input.trades.find((t) => t.date > input.today);
  if (future) throw new PlanError(400, "future_date", `Row ${future.rowIndex} is dated ${future.date}, after today`);
  const unknown = [...new Set(input.unknownActionKeys ?? [])];
  if (unknown.length > 0) throw new PlanError(400, "unknown_action", `Map these actions before committing: ${unknown.join(", ")}`);

  const inner = await db.transaction(async (tx) => {
    const upserted = await upsertInvestmentTxns(tx, {
      accountId: input.accountId,
      trades: input.trades,
      source: "csv",
      importLogId: input.importLogId ?? null,
      choices: input.choices ?? [],
      ctx: input.ctx,
    });
    let ledgerCreated = 0;
    let transfersPaired = upserted.transfersPaired;
    const cashInFile = input.trades.filter((t) => t.type === "transfer" && t.transferDirection !== null && t.ticker === null && t.name === null && t.cusip === null).length;
    const linkedNow = upserted.cashRows.filter((c) => c.ledgerTransactionId !== null).length;
    const toCreate = acct.simplefinFed ? [] : upserted.cashRows.filter((c) => c.ledgerTransactionId === null);
    if (toCreate.length > 0) {
      const ordinals = new Map<string, number>();
      const items: Array<IncomingTransaction & { txnId: string }> = [];
      for (const c of toCreate) {
        const key = `${c.date}|${c.amountCents}|${c.description}`;
        const ordinal = ordinals.get(key) ?? 0;
        ordinals.set(key, ordinal + 1);
        items.push({ txnId: c.txnId, externalId: await csvExternalId(c.date, c.amountCents, c.description, ordinal), date: c.date, amountCents: c.amountCents, description: c.description, pending: false });
      }
      const rules = await loadRules(tx);
      const ingestOptions: Parameters<typeof ingestTransactions>[2] = { accountId: input.accountId, source: "csv", rules, accountType: acct.type };
      if (input.importLogId) ingestOptions.importLogId = input.importLogId;
      const stats = await ingestTransactions(
        tx,
        items.map(({ txnId: _txnId, ...item }) => item),
        ingestOptions,
      );
      ledgerCreated = stats.created;
      if (stats.insertedIds.length > 0) {
        await tx.update(transaction).set({ isTransfer: true, categoryId: null, updatedAt: new Date() }).where(inArray(transaction.id, stats.insertedIds));
      }
      const ledgerRows = await tx
        .select({ id: transaction.id, externalId: transaction.externalId })
        .from(transaction)
        .where(and(eq(transaction.accountId, input.accountId), inArray(transaction.externalId, items.map((i) => i.externalId))));
      const alreadyLinked = new Set(
        (await tx.select({ id: investmentTxn.ledgerTransactionId }).from(investmentTxn).where(inArray(investmentTxn.ledgerTransactionId, ledgerRows.map((r) => r.id)))).map((r) => r.id),
      );
      const byExternalId = new Map(ledgerRows.map((r) => [r.externalId!, r.id]));
      for (const item of items) {
        const ledgerId = byExternalId.get(item.externalId);
        if (!ledgerId || alreadyLinked.has(ledgerId)) continue;
        alreadyLinked.add(ledgerId);
        await tx.update(investmentTxn).set({ ledgerTransactionId: ledgerId, updatedAt: new Date() }).where(eq(investmentTxn.id, item.txnId));
      }
      const dates = toCreate.map((c) => c.date).sort();
      transfersPaired += await pairTransfersInDb(tx, { since: dates[0]!, until: dates[dates.length - 1]! });
    }
    // Cash rows of the file that got no ledger row this time: already present from an earlier commit, or linked to a bank twin.
    const ledgerSkipped = Math.max(0, cashInFile - ledgerCreated - linkedNow);
    return { upserted, ledgerCreated, ledgerSkipped, transfersPaired };
  });

  const jobs: ImportTradesResult["jobs"] = { recurringDetect: null, priceRefresh: null, incomeFeed: null };
  if (inner.ledgerCreated > 0) jobs.recurringDetect = (await enqueueJob(db, "recurring.detect", { reason: "ledger" }, { dedupe: true })).id;
  if (inner.upserted.securitiesCreated > 0 && input.queuePriceRefresh) {
    jobs.priceRefresh = (await requestPriceRefresh(db, { reason: "holdings", ...(input.now ? { now: input.now } : {}) })).jobId;
  }
  if (inner.upserted.created + inner.upserted.updated > 0) {
    jobs.incomeFeed = (await enqueueJob(db, "investments.income_feed", { reason: "trades", dedupeKey: "investments.income_feed" }, { dedupe: true })).id;
  }
  const u = inner.upserted;
  return {
    created: u.created,
    updated: u.updated,
    unchanged: u.unchanged,
    skippedEdited: u.skippedEdited,
    linked: u.linked,
    ledgerCreated: inner.ledgerCreated,
    ledgerSkipped: inner.ledgerSkipped,
    transfersPaired: inner.transfersPaired,
    securitiesCreated: u.securitiesCreated,
    lotsRebuilt: u.lotsRebuilt,
    warnings: u.warnings,
    rebuildWarnings: u.rebuildWarnings,
    jobs,
  };
}
