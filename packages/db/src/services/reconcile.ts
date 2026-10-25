import { and, asc, desc, eq, inArray, lte, ne } from "drizzle-orm";
import {
  ReconcileRowView,
  fixed8ToCents,
  formatFixed8,
  isCashKey,
  mulToCents,
  normalizeTicker,
  RECONCILE_TOLERANCE_CENTS,
  valueAccountOn,
  type AccountValuation,
  type CashInference,
  type Fixed8,
  type HoldingPriceSource,
  type IsoDate,
  type LineValuation,
  type ReconcileRowStatus,
  type ValuationBasis,
  type ValueSource,
} from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { accountReconciliation, balanceSnapshot, holdingSnapshot, security } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { loadInvestmentAccount, positionsAuditJson, rebuildImpliedPrices, replaceHoldingSnapshot, requestValuation, type SnapshotPosition } from "./holdings.js";
import { requestPriceRefresh } from "./prices.js";
import { cashSecurity, listHeldSecurityIds, requireSecurity, resolveSecurity } from "./securities.js";
import { loadValuationInput } from "./valuation.js";

/**
 * Reconciliation to a brokerage statement (plan decision 14; prices design §3.10; seams C15,
 * C27): the preview compares the statement's rows with the valuation chain on the statement
 * date and writes nothing; the commit always records the attempt in `account_reconciliation`
 * and, when accepted, writes the statement as a `manual` holding snapshot and balance row,
 * rebuilds implied prices, queues the valuation job and audits one batch. `matchesToDollar`
 * (|difference| < 100 cents) is the gate's rule; a difference of 0 is "exact".
 */

// ---- Inputs and records ----

export interface ReconcileRowInput {
  securityId?: string | null;
  ticker?: string | null;
  isCash?: boolean;
  /** Dollars for the cash row. */
  quantity: Fixed8;
  price?: Fixed8 | null;
  valueCents?: bigint | null;
}

export interface ReconcilePreviewInput {
  accountId: string;
  date: IsoDate;
  /** Default: Σ rows. */
  statementTotalCents?: bigint | null;
  rows: readonly ReconcileRowInput[];
  /** Default `RECONCILE_TOLERANCE_CENTS`. */
  toleranceCents?: bigint | null;
}

export interface ReconcileAppSide {
  quantity: Fixed8 | null;
  price: Fixed8 | null;
  priceDate: IsoDate | null;
  priceSource: HoldingPriceSource | null;
  valueCents: bigint | null;
  valueSource: ValueSource;
}

export interface ReconcileStatementSide {
  quantity: Fixed8;
  price: Fixed8 | null;
  valueCents: bigint;
}

/** Bigint twin of `ReconcileRowView`. */
export interface ReconcileRowRecord {
  securityId: string | null;
  ticker: string | null;
  name: string | null;
  isCash: boolean;
  app: ReconcileAppSide | null;
  statement: ReconcileStatementSide | null;
  quantityDiff: Fixed8 | null;
  priceDiff: Fixed8 | null;
  valueDiffCents: bigint | null;
  status: ReconcileRowStatus;
}

export interface ReconcileBalanceRecord {
  balanceCents: bigint | null;
  balanceDate: IsoDate | null;
  /** balance − statement total. */
  differenceCents: bigint | null;
}

export interface CashInferenceHintRecord {
  flowsSinceSnapshotCents: bigint;
  plugCents: bigint;
  wouldReconcile: boolean;
}

/** Bigint twin of `ReconcilePreviewResponse` (plus the resolved rows the commit writes). */
export interface ReconcilePreviewRecord {
  accountId: string;
  date: IsoDate;
  app: AccountValuation;
  statementTotalCents: bigint;
  differenceCents: bigint | null;
  unexplainedCents: bigint | null;
  toleranceCents: bigint;
  matchesToDollar: boolean;
  rows: ReconcileRowRecord[];
  balance: ReconcileBalanceRecord;
  cashInferenceHint: CashInferenceHintRecord | null;
  alreadyReconciled: boolean;
  /** The account setting in force at preview time. */
  cashInference: CashInference;
  /** The statement rows resolved to securities (cash rows carry `isCash`), for the commit. */
  statementRows: ResolvedStatementRow[];
}

export interface ResolvedStatementRow {
  /** Null for an unknown ticker, or for cash when no cash security exists yet. */
  securityId: string | null;
  isCash: boolean;
  ticker: string | null;
  name: string | null;
  quantity: Fixed8;
  price: Fixed8 | null;
  valueCents: bigint;
  unknown: boolean;
}

// ---- Helpers ----

function toView(r: ReconcileRowRecord): ReconcileRowView {
  const f = (v: Fixed8 | null) => (v === null ? null : formatFixed8(v));
  const c = (v: bigint | null) => (v === null ? null : v.toString());
  return {
    securityId: r.securityId,
    ticker: r.ticker,
    name: r.name,
    isCash: r.isCash,
    app: r.app
      ? { quantity: f(r.app.quantity), price: f(r.app.price), priceDate: r.app.priceDate, priceSource: r.app.priceSource, valueCents: c(r.app.valueCents), valueSource: r.app.valueSource }
      : null,
    statement: r.statement ? { quantity: formatFixed8(r.statement.quantity), price: f(r.statement.price), valueCents: r.statement.valueCents.toString() } : null,
    quantityDiff: f(r.quantityDiff),
    priceDiff: f(r.priceDiff),
    valueDiffCents: c(r.valueDiffCents),
    status: r.status,
  };
}

/** The stored jsonb rows as records again (the list view). */
export function rowsFromJson(rows: readonly Record<string, unknown>[]): ReconcileRowView[] {
  return rows.map((r) => ReconcileRowView.parse(r));
}

const CASH_KINDS = new Set(["cash", "cash_plug", "carried_flows"]);

function isCashLine(line: LineValuation): boolean {
  return CASH_KINDS.has(line.kind);
}

async function existingCashSecurity(db: DbOrTx): Promise<{ id: string; name: string } | undefined> {
  const [row] = await db
    .select({ id: security.id, name: security.name })
    .from(security)
    .where(and(eq(security.type, "cash"), eq(security.currency, "USD")))
    .limit(1);
  return row;
}

async function resolveRows(db: DbOrTx, rows: readonly ReconcileRowInput[]): Promise<ResolvedStatementRow[]> {
  const out: ResolvedStatementRow[] = [];
  const seen = new Set<string>();
  const cash = await existingCashSecurity(db);
  for (const r of rows) {
    let securityId: string | null = null;
    let isCash = r.isCash === true;
    let ticker: string | null = r.ticker ? (normalizeTicker(r.ticker) ?? r.ticker.trim().toUpperCase()) : null;
    let name: string | null = null;
    let unknown = false;
    if (r.securityId) {
      const row = await requireSecurity(db, r.securityId);
      securityId = row.id;
      ticker = row.ticker;
      name = row.name;
      isCash = row.type === "cash";
    } else if (isCash || (r.ticker && isCashKey({ ticker: r.ticker }))) {
      isCash = true;
      securityId = cash?.id ?? null;
      name = cash?.name ?? "Cash";
      ticker = null;
    } else if (r.ticker) {
      const resolved = await resolveSecurity(db, { ticker: r.ticker }, { createIfMissing: false });
      if (resolved.id !== null) {
        const row = await requireSecurity(db, resolved.id);
        securityId = row.id;
        ticker = row.ticker ?? ticker;
        name = row.name;
        isCash = row.type === "cash";
      } else unknown = true;
    } else throw new PlanError(400, "validation", "A statement row needs securityId, ticker or isCash");
    const key = isCash ? "cash" : (securityId ?? `ticker:${ticker ?? ""}`);
    if (seen.has(key)) throw new PlanError(400, "duplicate_security", `${isCash ? "Cash" : (ticker ?? name ?? securityId)} is listed twice`);
    seen.add(key);
    const price = r.price ?? null;
    let valueCents: bigint;
    if (r.valueCents !== undefined && r.valueCents !== null) valueCents = r.valueCents;
    else if (price !== null) valueCents = mulToCents(r.quantity, price);
    else if (isCash) valueCents = fixed8ToCents(r.quantity);
    else throw new PlanError(400, "validation", `Row ${ticker ?? name ?? "?"}: give a value or a price`);
    out.push({ securityId, isCash, ticker, name, quantity: r.quantity, price, valueCents, unknown });
  }
  return out;
}

function compareRowsForDisplay(a: ReconcileRowRecord, b: ReconcileRowRecord): number {
  if (a.isCash !== b.isCash) return a.isCash ? 1 : -1;
  const ka = (a.ticker ?? a.name ?? "").toUpperCase();
  const kb = (b.ticker ?? b.name ?? "").toUpperCase();
  if (ka !== kb) return ka < kb ? -1 : 1;
  return (a.securityId ?? "") < (b.securityId ?? "") ? -1 : 1;
}

function appSideOf(line: LineValuation): ReconcileAppSide {
  return { quantity: line.quantity, price: line.price, priceDate: line.priceDate, priceSource: line.priceSource, valueCents: line.valueCents, valueSource: line.valueSource };
}

function statusOf(app: ReconcileAppSide | null, statement: ReconcileStatementSide | null, unknown: boolean, isCash: boolean): ReconcileRowStatus {
  if (unknown) return "unknown_ticker";
  if (app && !statement) return "missing_in_statement";
  if (!app && statement) return "missing_in_app";
  if (!app || !statement) return "match";
  const valuesEqual = app.valueCents !== null && app.valueCents === statement.valueCents;
  if (isCash) return valuesEqual ? "match" : "cash";
  const quantitiesComparable = app.quantity !== null;
  if (quantitiesComparable && app.quantity !== statement.quantity) return "quantity";
  if (valuesEqual) return "match";
  if (statement.price !== null && app.price !== null && statement.price !== app.price) return "price";
  return "value";
}

function buildRow(meta: { securityId: string | null; ticker: string | null; name: string | null; isCash: boolean }, app: ReconcileAppSide | null, statement: ReconcileStatementSide | null, unknown: boolean): ReconcileRowRecord {
  const quantityDiff = app && statement && app.quantity !== null ? app.quantity - statement.quantity : null;
  const priceDiff = app && statement && app.price !== null && statement.price !== null ? app.price - statement.price : null;
  const valueDiffCents = app && statement && app.valueCents !== null ? app.valueCents - statement.valueCents : null;
  return { ...meta, app, statement, quantityDiff, priceDiff, valueDiffCents, status: statusOf(app, statement, unknown, meta.isCash) };
}

/** The app's cash-kind lines summed into one row (reported cash, the plug and carried transfers). */
function appCashSide(lines: readonly LineValuation[]): ReconcileAppSide | null {
  const cashLines = lines.filter(isCashLine);
  if (cashLines.length === 0) return null;
  let quantity: Fixed8 | null = null;
  let valueCents: bigint | null = 0n;
  let priceDate: IsoDate | null = null;
  let synthetic = false;
  for (const l of cashLines) {
    if (l.kind === "cash" && l.securityId !== null && l.quantity !== null) quantity = (quantity ?? 0n) + l.quantity;
    if (l.securityId === null) synthetic = true;
    if (l.valueCents === null) valueCents = null;
    else if (valueCents !== null) valueCents += l.valueCents;
    if (l.priceDate !== null && (priceDate === null || l.priceDate > priceDate)) priceDate = l.priceDate;
  }
  return { quantity, price: quantity === null ? null : 100_000_000n, priceDate, priceSource: "cash", valueCents, valueSource: synthetic ? "carried" : (cashLines[0]!.valueSource ?? "statement") };
}

async function latestReportedBalance(db: DbOrTx, accountId: string, date: IsoDate): Promise<{ balanceCents: bigint; date: IsoDate } | undefined> {
  const [row] = await db
    .select({ balanceCents: balanceSnapshot.balanceCents, date: balanceSnapshot.date })
    .from(balanceSnapshot)
    .where(and(eq(balanceSnapshot.accountId, accountId), ne(balanceSnapshot.source, "computed"), lte(balanceSnapshot.date, date)))
    .orderBy(desc(balanceSnapshot.date))
    .limit(1);
  return row;
}

async function acceptedRowExists(db: DbOrTx, accountId: string, date: IsoDate): Promise<boolean> {
  const [row] = await db
    .select({ id: accountReconciliation.id })
    .from(accountReconciliation)
    .where(and(eq(accountReconciliation.accountId, accountId), eq(accountReconciliation.statementDate, date), eq(accountReconciliation.accepted, true)))
    .limit(1);
  return row !== undefined;
}

// ---- Preview ----

/**
 * The app against the statement on `date` (§3.10 steps 1–6), writing nothing: an open
 * investment account (400 `validation` / `not_investment_account`), `date ≤ today` (400
 * `future_date`), each row resolved to a security (unknown tickers are a row status, the same
 * security twice is 400 `duplicate_security`, a row without a value or price is 400
 * `validation`), the chain's valuation (and what `auto` cash inference would have done for an
 * account that has it off), per-row statuses, the totals and the balance block.
 */
export async function previewReconciliation(db: DbOrTx, input: ReconcilePreviewInput, opts: { today: IsoDate; now: Date }): Promise<ReconcilePreviewRecord> {
  const acct = await loadInvestmentAccount(db, input.accountId);
  if (acct.closed) throw new PlanError(400, "validation", `${acct.name} is closed`);
  if (input.date > opts.today) throw new PlanError(400, "future_date", `${input.date} is after today`);
  const toleranceCents = input.toleranceCents ?? RECONCILE_TOLERANCE_CENTS;
  if (toleranceCents < 0n) throw new PlanError(400, "validation", "toleranceCents must not be negative");
  const statementRows = await resolveRows(db, input.rows);
  const statementTotalCents = input.statementTotalCents ?? statementRows.reduce((acc, r) => acc + r.valueCents, 0n);

  const valuationInput = await loadValuationInput(db, { accountIds: [input.accountId], from: input.date, to: input.date, now: opts.now });
  const app = valueAccountOn(valuationInput, input.accountId, input.date);
  let cashInferenceHint: CashInferenceHintRecord | null = null;
  if (app.cashInference === "off") {
    const autoInput = { ...valuationInput, accounts: valuationInput.accounts.map((a) => (a.id === input.accountId ? { ...a, cashInference: "auto" as const } : a)) };
    const auto = valueAccountOn(autoInput, input.accountId, input.date);
    if (auto.valueCents !== app.valueCents) {
      const sum = (kind: string) => auto.lines.filter((l) => l.kind === kind).reduce((acc, l) => acc + (l.valueCents ?? 0n), 0n);
      cashInferenceHint = {
        flowsSinceSnapshotCents: sum("carried_flows"),
        plugCents: sum("cash_plug"),
        wouldReconcile: auto.valueCents !== null && absBig(auto.valueCents - statementTotalCents) < toleranceCents,
      };
    }
  }

  // Rows: the union of app lines and statement rows by security; cash as one row each side.
  const rows: ReconcileRowRecord[] = [];
  const totalOnly = input.rows.length === 0;
  if (totalOnly) {
    const differenceCents = app.valueCents === null ? null : app.valueCents - statementTotalCents;
    rows.push({
      securityId: null,
      ticker: null,
      name: "Statement total",
      isCash: false,
      app: { quantity: null, price: null, priceDate: app.asOf, priceSource: null, valueCents: app.valueCents, valueSource: app.valueCents === null ? "unpriced" : "priced" },
      statement: { quantity: 0n, price: null, valueCents: statementTotalCents },
      quantityDiff: null,
      priceDiff: null,
      valueDiffCents: differenceCents,
      status: differenceCents !== null && absBig(differenceCents) < toleranceCents ? "match" : "value",
    });
  } else {
    const positionLines = app.lines.filter((l) => l.kind === "position" && l.securityId !== null);
    const statementBySecurity = new Map<string, ResolvedStatementRow>();
    let statementCash: ResolvedStatementRow | undefined;
    const unknownRows: ResolvedStatementRow[] = [];
    for (const r of statementRows) {
      if (r.isCash) statementCash = r;
      else if (r.securityId !== null) statementBySecurity.set(r.securityId, r);
      else unknownRows.push(r);
    }
    const seen = new Set<string>();
    for (const line of positionLines) {
      const id = line.securityId!;
      seen.add(id);
      const stmt = statementBySecurity.get(id);
      rows.push(
        buildRow(
          { securityId: id, ticker: line.ticker, name: line.name, isCash: false },
          appSideOf(line),
          stmt ? { quantity: stmt.quantity, price: stmt.price, valueCents: stmt.valueCents } : null,
          false,
        ),
      );
    }
    for (const [id, stmt] of statementBySecurity) {
      if (seen.has(id)) continue;
      rows.push(buildRow({ securityId: id, ticker: stmt.ticker, name: stmt.name, isCash: false }, null, { quantity: stmt.quantity, price: stmt.price, valueCents: stmt.valueCents }, false));
    }
    for (const stmt of unknownRows) {
      rows.push(buildRow({ securityId: null, ticker: stmt.ticker, name: stmt.name, isCash: false }, null, { quantity: stmt.quantity, price: stmt.price, valueCents: stmt.valueCents }, true));
    }
    const appCash = appCashSide(app.lines);
    const cashMeta = { securityId: statementCash?.securityId ?? app.lines.find((l) => l.kind === "cash" && l.securityId !== null)?.securityId ?? null, ticker: null, name: "Cash", isCash: true };
    if (appCash && (appCash.valueCents !== 0n || statementCash)) {
      rows.push(buildRow(cashMeta, appCash, statementCash ? { quantity: statementCash.quantity, price: statementCash.price, valueCents: statementCash.valueCents } : null, false));
    } else if (statementCash) {
      rows.push(buildRow(cashMeta, null, { quantity: statementCash.quantity, price: statementCash.price, valueCents: statementCash.valueCents }, false));
    }
    rows.sort(compareRowsForDisplay);
  }

  const differenceCents = app.valueCents === null ? null : app.valueCents - statementTotalCents;
  const rowDiffs = rows.reduce((acc, r) => acc + (r.valueDiffCents ?? 0n), 0n);
  const balance = await latestReportedBalance(db, input.accountId, input.date);
  return {
    accountId: input.accountId,
    date: input.date,
    app,
    statementTotalCents,
    differenceCents,
    unexplainedCents: differenceCents === null ? null : differenceCents - rowDiffs,
    toleranceCents,
    matchesToDollar: differenceCents !== null && absBig(differenceCents) < toleranceCents,
    rows,
    balance: {
      balanceCents: balance?.balanceCents ?? null,
      balanceDate: balance?.date ?? null,
      differenceCents: balance ? balance.balanceCents - statementTotalCents : null,
    },
    cashInferenceHint,
    alreadyReconciled: await acceptedRowExists(db, input.accountId, input.date),
    cashInference: app.cashInference,
    statementRows,
  };
}

function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

// ---- Commit ----

export interface ReconcileCommitInput extends ReconcilePreviewInput {
  /** Default true. */
  accept?: boolean;
  note?: string | null;
}

export interface ReconcileCommitOptions {
  today: IsoDate;
  now: Date;
  /** `PRICE_PROVIDER !== 'none'`: queue a fetch for newly referenced provider securities. */
  queuePriceRefresh?: boolean;
}

/** Bigint twin of `ReconcileCommitResponse`. */
export interface ReconcileCommitRecord {
  reconciliationId: string;
  batchId: string;
  accepted: boolean;
  preCommitDifferenceCents: bigint | null;
  matchesToDollar: boolean;
  /** The post-commit valuation on the date (equal to the statement when accepted). */
  app: AccountValuation;
  rowsWritten: number;
  impliedPricesWritten: number;
  preview: ReconcilePreviewRecord;
}

/**
 * Record the attempt and, with `accept`, make the statement the app's truth for the date
 * (§3.10 commit): a `manual` holding snapshot and balance row through `replaceHoldingSnapshot`
 * (cash rows on the cash security, quantity = dollars), implied prices rebuilt, the valuation
 * job queued, a price refresh for newly referenced provider securities, one audit batch.
 */
export async function commitReconciliation(db: Db, input: ReconcileCommitInput, ctx: AuditContext & ReconcileCommitOptions): Promise<ReconcileCommitRecord> {
  const accept = input.accept ?? true;
  return db.transaction(async (tx) => {
    const preview = await previewReconciliation(tx, input, { today: ctx.today, now: ctx.now });
    if (accept) {
      const unknown = preview.statementRows.filter((r) => r.unknown);
      if (unknown.length > 0) throw new PlanError(400, "unknown_ticker", `Unknown securities: ${unknown.map((r) => r.ticker ?? r.name ?? "?").join(", ")}. Create them first.`);
    }
    const acceptedBefore = preview.alreadyReconciled;
    const [reconciliation] = await tx
      .insert(accountReconciliation)
      .values({
        accountId: input.accountId,
        statementDate: input.date,
        statementTotalCents: preview.statementTotalCents,
        appValueCents: preview.app.valueCents,
        appBasis: preview.app.basis,
        appAsOf: preview.app.asOf,
        cashInference: preview.cashInference,
        diffCents: preview.differenceCents,
        balanceCents: preview.balance.balanceCents,
        balanceDiffCents: preview.balance.differenceCents,
        toleranceCents: preview.toleranceCents,
        reconciled: preview.matchesToDollar,
        rows: preview.rows.map(toView) as unknown as Record<string, unknown>[],
        accepted: accept,
        holdingSnapshotDate: accept ? input.date : null,
        note: input.note ?? null,
        userId: ctx.userId,
      })
      .returning({ id: accountReconciliation.id });

    let rowsWritten = 0;
    let impliedPricesWritten = 0;
    let app = preview.app;
    if (accept) {
      const before = await tx
        .select()
        .from(holdingSnapshot)
        .where(and(eq(holdingSnapshot.accountId, input.accountId), eq(holdingSnapshot.date, input.date)));
      const heldBefore = await listHeldSecurityIds(tx);
      const positions: SnapshotPosition[] = [];
      for (const r of preview.statementRows) {
        let securityId = r.securityId;
        if (r.isCash && securityId === null) securityId = (await cashSecurity(tx, "USD")).row.id;
        if (securityId === null) continue;
        positions.push({ securityId, quantity: r.quantity, price: r.isCash ? 100_000_000n : r.price, valueCents: r.valueCents, reportedCostBasisCents: null });
      }
      const written = await replaceHoldingSnapshot(tx, {
        accountId: input.accountId,
        date: input.date,
        source: "manual",
        positions,
        setBalance: true,
        statementTotalCents: preview.statementTotalCents,
        today: ctx.today,
      });
      rowsWritten = written.inserted + written.updated;
      impliedPricesWritten = (await rebuildImpliedPrices(tx, { securityIds: written.securityIds, dates: [input.date] })).written;
      const after = await tx
        .select()
        .from(holdingSnapshot)
        .where(and(eq(holdingSnapshot.accountId, input.accountId), eq(holdingSnapshot.date, input.date)));
      await writeAudit(tx, {
        ...ctx,
        entity: "account_reconciliation",
        entityId: `${input.accountId}:${input.date}`,
        action: acceptedBefore ? "update" : "create",
        before: before.length === 0 ? null : positionsAuditJson(before),
        after: { rows: positionsAuditJson(after), statementTotalCents: preview.statementTotalCents, differenceCents: preview.differenceCents, accepted: true },
      });
      await requestValuation(tx, { reason: "reconcile", accountId: input.accountId });
      if (ctx.queuePriceRefresh) {
        const ids = positions.map((p) => p.securityId).filter((id) => !heldBefore.has(id));
        if (ids.length > 0) {
          const provider = await tx
            .select({ id: security.id })
            .from(security)
            .where(and(inArray(security.id, ids), eq(security.priceMode, "provider"), eq(security.archived, false)));
          if (provider.length > 0) await requestPriceRefresh(tx, { reason: "reconcile", securityIds: provider.map((p) => p.id), now: ctx.now });
        }
      }
      const post = await loadValuationInput(tx, { accountIds: [input.accountId], from: input.date, to: input.date, now: ctx.now });
      app = valueAccountOn(post, input.accountId, input.date);
    } else {
      await writeAudit(tx, {
        ...ctx,
        entity: "account_reconciliation",
        entityId: `${input.accountId}:${input.date}`,
        action: "create",
        before: null,
        after: { reconciliationId: reconciliation!.id, statementTotalCents: preview.statementTotalCents, differenceCents: preview.differenceCents, accepted: false },
      });
    }
    return {
      reconciliationId: reconciliation!.id,
      batchId: ctx.batchId,
      accepted: accept,
      preCommitDifferenceCents: preview.differenceCents,
      matchesToDollar: preview.matchesToDollar,
      app,
      rowsWritten,
      impliedPricesWritten,
      preview,
    };
  });
}

// ---- History ----

/** Bigint twin of `ReconciliationView`. */
export interface ReconciliationRecord {
  id: string;
  accountId: string;
  date: IsoDate;
  statementTotalCents: bigint;
  differenceCents: bigint | null;
  /** difference − Σ stored row diffs. */
  unexplainedCents: bigint | null;
  toleranceCents: bigint;
  matchesToDollar: boolean;
  balance: ReconcileBalanceRecord;
  appValueCents: bigint | null;
  appBasis: ValuationBasis;
  appAsOf: IsoDate | null;
  cashInference: CashInference;
  reconciled: boolean;
  accepted: boolean;
  holdingSnapshotDate: IsoDate | null;
  note: string | null;
  rows: ReconcileRowView[];
  createdAt: Date;
}

function toRecord(r: typeof accountReconciliation.$inferSelect): ReconciliationRecord {
  const rows = rowsFromJson(r.rows);
  const rowDiffs = rows.reduce((acc, row) => acc + (row.valueDiffCents === null ? 0n : BigInt(row.valueDiffCents)), 0n);
  return {
    id: r.id,
    accountId: r.accountId,
    date: r.statementDate,
    statementTotalCents: r.statementTotalCents,
    differenceCents: r.diffCents,
    unexplainedCents: r.diffCents === null ? null : r.diffCents - rowDiffs,
    toleranceCents: r.toleranceCents,
    matchesToDollar: r.reconciled,
    balance: { balanceCents: r.balanceCents, balanceDate: null, differenceCents: r.balanceDiffCents },
    appValueCents: r.appValueCents,
    appBasis: r.appBasis,
    appAsOf: r.appAsOf,
    cashInference: r.cashInference,
    reconciled: r.reconciled,
    accepted: r.accepted,
    holdingSnapshotDate: r.holdingSnapshotDate,
    note: r.note,
    rows,
    createdAt: r.createdAt,
  };
}

/** `GET /api/reconcile/history?accountId=`: newest first. */
export async function listReconciliations(db: DbOrTx, q: { accountId: string; limit?: number }): Promise<ReconciliationRecord[]> {
  const limit = Math.max(1, Math.min(q.limit ?? 50, 200));
  const rows = await db
    .select()
    .from(accountReconciliation)
    .where(eq(accountReconciliation.accountId, q.accountId))
    .orderBy(desc(accountReconciliation.createdAt), desc(accountReconciliation.statementDate), desc(accountReconciliation.id))
    .limit(limit);
  return rows.map(toRecord);
}

export async function getReconciliation(db: DbOrTx, id: string): Promise<ReconciliationRecord | undefined> {
  const [row] = await db.select().from(accountReconciliation).where(eq(accountReconciliation.id, id));
  return row ? toRecord(row) : undefined;
}

/** `DELETE /api/reconcile/:id`: removes the record only (the snapshot it wrote stays); audited. */
export async function deleteReconciliation(db: Db, id: string, ctx: AuditContext): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(accountReconciliation).where(eq(accountReconciliation.id, id));
    if (!row) throw new PlanError(404, "not_found", "Reconciliation not found");
    await tx.delete(accountReconciliation).where(eq(accountReconciliation.id, id));
    await writeAudit(tx, {
      ...ctx,
      entity: "account_reconciliation",
      entityId: `${row.accountId}:${row.statementDate}`,
      action: "delete",
      before: { reconciliationId: row.id, statementTotalCents: row.statementTotalCents, differenceCents: row.diffCents, accepted: row.accepted },
      after: null,
    });
  });
}

/** Accounts (positions or full history) whose latest statement date has no reconciliation on or after it (views design §4, `awaitingReconcile`). */
export async function accountsAwaitingReconcile(db: DbOrTx, candidates: readonly { accountId: string; latestStatementDate: IsoDate | null }[]): Promise<string[]> {
  const ids = candidates.filter((c) => c.latestStatementDate !== null).map((c) => c.accountId);
  if (ids.length === 0) return [];
  const rows = await db
    .select({ accountId: accountReconciliation.accountId, statementDate: accountReconciliation.statementDate })
    .from(accountReconciliation)
    .where(inArray(accountReconciliation.accountId, ids))
    .orderBy(asc(accountReconciliation.accountId));
  const latestRecord = new Map<string, IsoDate>();
  for (const r of rows) {
    const prev = latestRecord.get(r.accountId);
    if (prev === undefined || r.statementDate > prev) latestRecord.set(r.accountId, r.statementDate);
  }
  return candidates
    .filter((c) => c.latestStatementDate !== null)
    .filter((c) => {
      const rec = latestRecord.get(c.accountId);
      return rec === undefined || rec < c.latestStatementDate!;
    })
    .map((c) => c.accountId);
}
