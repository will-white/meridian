import { and, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { z } from "zod";
import {
  account,
  balanceSnapshot,
  cashSecurity,
  connection,
  createSecurity,
  enqueueJob,
  getSnapshot,
  HOLDING_SOURCE_RANK,
  importCsvRows,
  importLog,
  importTrades,
  investmentTxn,
  learnAliases,
  loadInvestmentAccount,
  PlanError,
  qtyFromDb,
  rebuildImpliedPrices,
  replaceHoldingSnapshot,
  requestPriceRefresh,
  requestValuation,
  resolveSecurity,
  security,
  transaction,
  type AuditContext,
  type DbOrTx,
  type SnapshotPosition,
} from "@meridian/db";
import {
  addDays,
  CsvCommitBody,
  CsvImportError,
  CsvMapping,
  CsvPreviewBody,
  CsvPreviewResponse,
  dayDiff,
  formatCents,
  guessCsvMapping,
  guessPositionsMapping,
  guessTradesMapping,
  ImportResult,
  isCashKey,
  mapCsvRows,
  mapPositionsCsvRows,
  mapTradesCsvRows,
  matchesToDollar,
  parseCsv,
  PositionsCommitBody,
  PositionsCsvMapping,
  PositionsImportResult,
  PositionsPreviewBody,
  PositionsPreviewResponse,
  sanitizeText,
  TradesCommitBody,
  TradesCsvMapping,
  TradesImportResult,
  TradesPreviewBody,
  TradesPreviewResponse,
  type CsvMappingInput,
  type Fixed8,
  type IsoDate,
  type LedgerMatchView,
  type MappedPosition,
  type MappedPositions,
  type MappedTrade,
  type MappedTrades,
  type PositionsCsvMappingInput,
  type PreviewSecurityRef,
  type RowChoice,
  type SecurityChoice,
  type SecurityKey,
  type TradesCsvMappingInput,
} from "@meridian/shared";
import { badRequest, notFound } from "../lib/errors.js";
import { toActionFoundView, toMappedPositionView, toMappedTradeView, toPositionsImportResult, toRowErrors, toTradesImportResult } from "../views/investments.js";
import { auditContext, resolveToday, usePlanErrors } from "./plan.js";
import { priceProviderConfigured, resolveWithoutCreating } from "./securities.js";

/**
 * Phase 3 additions (imports design §3.7, §3.9; plan decision 17): the positions and trades
 * CSV previews and commits under /api/import/positions and /api/import/trades. A preview
 * resolves securities without creating any; a commit writes the `import_log` row first,
 * runs everything else in one transaction (securities, snapshot or trades, ledger rows,
 * implied prices, balance, lots) and marks the log row `error` with the message on failure,
 * as the Phase 1 bank-CSV commit does. Mapping profiles are `csv` connections typed by
 * `csv_kind`.
 */

type Choice = SecurityChoice | undefined;
type TradeRow = typeof investmentTxn.$inferSelect;
type MappingKind = "positions" | "trades";

function choiceMap(choices: readonly RowChoice[]): Map<number, RowChoice> {
  return new Map(choices.map((c) => [c.rowIndex, c]));
}

/** The file's rows, or none when nothing but whitespace was uploaded (400 `empty_csv`). */
function parseRows(csvText: string): string[][] {
  const rows = parseCsv(csvText);
  return rows.some((row) => row.some((cell) => cell.trim() !== "")) ? rows : [];
}

function dataRowCount(rows: readonly string[][], mapping: { hasHeader: boolean; skipRows: number }): number {
  return Math.max(rows.length - mapping.skipRows - (mapping.hasHeader ? 1 : 0), 0);
}

function headerNames(headers: readonly string[], hasHeader: boolean): string[] {
  return hasHeader ? [...headers] : headers.map((_, i) => `Column ${i + 1}`);
}

const positionKey = (p: MappedPosition): SecurityKey => ({ ticker: p.ticker, cusip: p.cusip, name: p.name });
const tradeKey = (t: MappedTrade): SecurityKey => ({ ticker: t.ticker, cusip: t.cusip, name: t.name });
/** A cash transfer row names no security. */
const isCashTrade = (t: MappedTrade): boolean => t.type === "transfer" && t.ticker === null && t.name === null && t.cusip === null;
/** Rows the commit links to a ledger row (`linkToLedger`): income, fees and cash transfers. */
const linkable = (t: MappedTrade): boolean => t.type === "dividend" || t.type === "interest" || t.type === "fee" || isCashTrade(t);

async function securityRow(db: DbOrTx, id: string) {
  const [row] = await db
    .select({ id: security.id, ticker: security.ticker, name: security.name, type: security.type, needsReview: security.needsReview })
    .from(security)
    .where(eq(security.id, id));
  return row;
}

/** The preview's security reference for a row: the owner's choice first, else a read-only resolution cached per key. Nothing is created. */
async function previewRef(db: DbOrTx, key: SecurityKey, choice: Choice, cache: Map<string, PreviewSecurityRef>): Promise<PreviewSecurityRef> {
  if (choice?.kind === "existing") {
    const row = await securityRow(db, choice.securityId);
    if (!row) throw notFound("Chosen security not found");
    return { id: row.id, ticker: row.ticker, name: row.name, matchedBy: "choice", isNew: false, needsReview: row.needsReview, isCash: row.type === "cash", suggestion: null };
  }
  if (choice?.kind === "create") {
    const s = choice.security;
    return { id: null, ticker: s.ticker, name: s.name, matchedBy: "choice", isNew: true, needsReview: false, isCash: s.type === "cash" || isCashKey({ ticker: s.ticker, name: s.name }), suggestion: s };
  }
  const cacheKey = `${key.ticker ?? ""}|${key.cusip ?? ""}|${key.name ?? ""}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const resolved = await resolveWithoutCreating(db, key);
  let ref: PreviewSecurityRef;
  if (resolved.id === null) {
    const s = resolved.suggestion;
    ref = { id: null, ticker: s.ticker, name: s.name, matchedBy: resolved.cash ? "cash" : "new", isNew: true, needsReview: !resolved.cash, isCash: resolved.cash, suggestion: s };
  } else {
    const row = await securityRow(db, resolved.id);
    if (!row) throw notFound("Security not found");
    ref = { id: row.id, ticker: row.ticker, name: row.name, matchedBy: resolved.matchedBy, isNew: false, needsReview: row.needsReview, isCash: row.type === "cash", suggestion: null };
  }
  cache.set(cacheKey, ref);
  return ref;
}

/**
 * The commit's security for a positions row (§3.7 step 4): an `existing` choice learns the
 * row's identifiers as aliases; a `create` choice creates the edited suggestion without review
 * (audited); a row without a choice resolves or is created with `needs_review` (source csv).
 */
async function commitSecurity(tx: DbOrTx, p: MappedPosition, choice: Choice, ctx: AuditContext): Promise<{ id: string; created: boolean }> {
  if (choice?.kind === "existing") {
    const row = await securityRow(tx, choice.securityId);
    if (!row) throw notFound("Chosen security not found");
    try {
      await learnAliases(tx, row.id, positionKey(p));
    } catch (err) {
      if (!(err instanceof PlanError && err.code === "alias_taken")) throw err;
    }
    return { id: row.id, created: false };
  }
  if (choice?.kind === "create") {
    const s = choice.security;
    if (s.type === "cash" || isCashKey({ ticker: s.ticker, name: s.name })) {
      const { row, created } = await cashSecurity(tx);
      return { id: row.id, created };
    }
    const found = await resolveWithoutCreating(tx, { ticker: s.ticker, cusip: s.cusip, isin: s.isin, name: s.name });
    if (found.id !== null) return { id: found.id, created: false };
    const created = await createSecurity(tx, { ticker: s.ticker, name: s.name, type: s.type, assetClass: s.assetClass, cusip: s.cusip, isin: s.isin }, ctx, { needsReview: false });
    return { id: created.id, created: true };
  }
  if (p.isCash) {
    const { row, created } = await cashSecurity(tx);
    return { id: row.id, created };
  }
  const resolved = await resolveSecurity(tx, positionKey(p), { createIfMissing: true, source: "csv" });
  if (resolved.id === null) throw new PlanError(409, "conflict", "Security could not be created");
  return { id: resolved.id, created: resolved.created };
}

/** Sub-lot rows of one security add up; a dollar-only row makes the set dollar-only; an unknown cost makes the cost unknown. */
interface PositionAggregate {
  securityId: string;
  quantity: Fixed8 | null;
  dollarOnly: boolean;
  price: Fixed8 | null;
  valueCents: bigint;
  costBasisCents: bigint | null;
  costUnknown: boolean;
}

function aggregatePosition(map: Map<string, PositionAggregate>, securityId: string, p: MappedPosition): void {
  const a = map.get(securityId);
  if (!a) {
    map.set(securityId, { securityId, quantity: p.quantity, dollarOnly: p.quantity === null, price: p.price, valueCents: p.valueCents, costBasisCents: p.costBasisCents, costUnknown: p.costBasisCents === null });
    return;
  }
  a.dollarOnly ||= p.quantity === null;
  a.quantity = a.dollarOnly || a.quantity === null || p.quantity === null ? null : a.quantity + p.quantity;
  // The reported price is kept only when every sub-lot shares it; otherwise the service derives impliedPrice(value, quantity).
  a.price = a.price !== null && p.price !== null && a.price === p.price ? a.price : null;
  a.valueCents += p.valueCents;
  a.costUnknown ||= p.costBasisCents === null;
  a.costBasisCents = a.costUnknown || a.costBasisCents === null || p.costBasisCents === null ? null : a.costBasisCents + p.costBasisCents;
}

function toSnapshotPosition(a: PositionAggregate): SnapshotPosition {
  return {
    securityId: a.securityId,
    quantity: a.dollarOnly ? null : a.quantity,
    price: a.dollarOnly ? null : a.price,
    valueCents: a.valueCents,
    reportedCostBasisCents: a.costUnknown ? null : a.costBasisCents,
  };
}

/** `mapPositionsCsvRows` with the file-level refusals mapped: `CsvImportError` keeps its code (`as_of_required`), anything else is `bad_mapping`. */
function mapPositions(rows: readonly string[][], mapping: PositionsCsvMappingInput, opts: { asOfDate?: IsoDate | undefined; accountFilterValue?: string | undefined }): MappedPositions {
  try {
    return mapPositionsCsvRows(rows, mapping, {
      ...(opts.asOfDate !== undefined ? { asOfDate: opts.asOfDate } : {}),
      ...(opts.accountFilterValue !== undefined ? { accountFilterValue: opts.accountFilterValue } : {}),
    });
  } catch (err) {
    if (err instanceof CsvImportError) throw badRequest(err.message, err.code);
    throw badRequest((err as Error).message, "bad_mapping");
  }
}

async function mapTrades(rows: readonly string[][], mapping: TradesCsvMappingInput, opts: { accountFilterValue?: string | undefined; choices: readonly RowChoice[] }): Promise<MappedTrades> {
  try {
    return await mapTradesCsvRows(rows, mapping, { choices: opts.choices, ...(opts.accountFilterValue !== undefined ? { accountFilterValue: opts.accountFilterValue } : {}) });
  } catch (err) {
    if (err instanceof CsvImportError) throw badRequest(err.message, err.code);
    throw badRequest((err as Error).message, "bad_mapping");
  }
}

/** The latest Bridge balance on or before the date (the preview's reconciliation line for SimpleFIN-fed accounts). */
async function knownSimplefinBalance(db: DbOrTx, accountId: string, date: IsoDate): Promise<bigint | null> {
  const [row] = await db
    .select({ balanceCents: balanceSnapshot.balanceCents })
    .from(balanceSnapshot)
    .where(and(eq(balanceSnapshot.accountId, accountId), eq(balanceSnapshot.source, "simplefin"), lte(balanceSnapshot.date, date)))
    .orderBy(desc(balanceSnapshot.date))
    .limit(1);
  return row?.balanceCents ?? null;
}

async function existingTradeRows(db: DbOrTx, accountId: string, externalIds: readonly string[]): Promise<Map<string, TradeRow>> {
  const out = new Map<string, TradeRow>();
  for (let i = 0; i < externalIds.length; i += 500) {
    const rows = await db
      .select()
      .from(investmentTxn)
      .where(and(eq(investmentTxn.accountId, accountId), inArray(investmentTxn.externalId, externalIds.slice(i, i + 500))));
    for (const row of rows) if (row.externalId) out.set(row.externalId, row);
  }
  return out;
}

/** The source-owned columns the commit diffs (`upsertInvestmentTxns`): the preview's `changed` flag mirrors that comparison. */
function tradeChanged(t: MappedTrade, row: TradeRow, securityId: string | null): boolean {
  if (row.date !== t.date || row.sequence !== t.sequence || row.type !== t.type) return true;
  if (securityId !== null && row.securityId !== securityId) return true;
  if (isCashTrade(t) && row.securityId !== null) return true;
  if (qtyFromDb(row.quantity) !== t.quantity || qtyFromDb(row.price) !== t.price) return true;
  if (row.amountCents !== t.amountCents || row.feeCents !== t.feeCents) return true;
  if (row.splitNum !== t.splitNum || row.splitDen !== t.splitDen || row.transferDirection !== t.transferDirection) return true;
  return row.rawDescription !== (sanitizeText(t.rawDescription, 500) || null);
}

async function ledgerDates(db: DbOrTx, ids: readonly string[]): Promise<Map<string, IsoDate>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: transaction.id, date: transaction.date }).from(transaction).where(inArray(transaction.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.date]));
}

interface LinkItem {
  index: number;
  date: IsoDate;
  amountCents: bigint;
}

/**
 * The ledger row each new row would link to on commit, read-only (the rule of
 * `linkToLedger`: same account, equal amount, within 3 days, posted, not a feed row, not
 * already linked; nearest date then earliest id; each ledger row used once).
 */
async function previewLedgerMatches(db: DbOrTx, accountId: string, items: readonly LinkItem[]): Promise<Map<number, LedgerMatchView>> {
  const out = new Map<number, LedgerMatchView>();
  if (items.length === 0) return out;
  const dates = items.map((i) => i.date).sort();
  const lo = addDays(dates[0]!, -3);
  const hi = addDays(dates[dates.length - 1]!, 3);
  const amounts = [...new Set(items.map((i) => i.amountCents))];
  const taken = db.select({ id: investmentTxn.ledgerTransactionId }).from(investmentTxn).where(sql`${investmentTxn.ledgerTransactionId} is not null`);
  const candidates = await db
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
  const ordered = [...items].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.index - b.index));
  for (const item of ordered) {
    let best: { id: string; date: IsoDate; distance: number } | undefined;
    for (const c of candidates) {
      if (used.has(c.id) || c.amountCents !== item.amountCents) continue;
      const distance = Math.abs(dayDiff(c.date, item.date));
      if (distance > 3) continue;
      if (!best || distance < best.distance || (distance === best.distance && (c.date < best.date || (c.date === best.date && c.id < best.id)))) {
        best = { id: c.id, date: c.date, distance };
      }
    }
    if (!best) continue;
    used.add(best.id);
    out.set(item.index, { ledgerTransactionId: best.id, date: best.date });
  }
  return out;
}

export async function importRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  usePlanErrors(app);

  async function existingIds(accountId: string, ids: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await app.db
        .select({ externalId: transaction.externalId })
        .from(transaction)
        .where(and(eq(transaction.accountId, accountId), inArray(transaction.externalId, ids.slice(i, i + 500))));
      for (const row of rows) if (row.externalId) out.add(row.externalId);
    }
    return out;
  }

  r.post("/import/csv/preview", { schema: { body: CsvPreviewBody, response: { 200: CsvPreviewResponse } } }, async (request) => {
    const rows = parseCsv(request.body.csvText);
    if (rows.length === 0) throw badRequest("The file is empty", "empty_csv");
    let mapping: CsvMappingInput | undefined = request.body.mapping;
    if (!mapping && request.body.profileId) {
      const [profile] = await app.db.select().from(connection).where(eq(connection.id, request.body.profileId));
      if (!profile?.csvMapping) throw notFound("Mapping profile not found");
      const parsed = CsvMapping.safeParse(profile.csvMapping);
      if (!parsed.success) throw badRequest("The saved mapping is no longer valid; rebuild it", "bad_profile");
      mapping = parsed.data;
    }
    const headers = rows[0]!;
    if (!mapping) mapping = guessCsvMapping(headers, rows.slice(1, 6));

    const sampleRows = rows.slice(0, 6);
    if (!mapping) return { headers, sampleRows, mapping: null, rows: [], totalRows: Math.max(rows.length - 1, 0), duplicateCount: 0, errors: [] };

    let mapped: Awaited<ReturnType<typeof mapCsvRows>>;
    try {
      mapped = await mapCsvRows(rows, mapping);
    } catch (err) {
      throw badRequest((err as Error).message, "bad_mapping");
    }
    const dupes = request.body.accountId ? await existingIds(request.body.accountId, mapped.rows.map((m) => m.externalId)) : new Set<string>();
    return {
      headers: mapping.hasHeader === false ? headers.map((_, i) => `Column ${i + 1}`) : headers,
      sampleRows,
      mapping: CsvMapping.parse(mapping),
      rows: mapped.rows.slice(0, 200).map((m) => ({
        rowIndex: m.rowIndex,
        date: m.date,
        amountCents: m.amountCents.toString(),
        description: m.description,
        ...(m.memo ? { memo: m.memo } : {}),
        externalId: m.externalId,
        duplicate: dupes.has(m.externalId),
      })),
      totalRows: mapped.rows.length,
      duplicateCount: dupes.size,
      errors: mapped.errors.slice(0, 50),
    };
  });

  r.post("/import/csv/commit", { schema: { body: CsvCommitBody, response: { 200: ImportResult } } }, async (request) => {
    const [acct] = await app.db.select({ id: account.id }).from(account).where(eq(account.id, request.body.accountId));
    if (!acct) throw notFound("Account not found");
    const rows = parseCsv(request.body.csvText);
    let mapped: Awaited<ReturnType<typeof mapCsvRows>>;
    try {
      mapped = await mapCsvRows(rows, request.body.mapping);
    } catch (err) {
      throw badRequest((err as Error).message, "bad_mapping");
    }
    if (mapped.rows.length === 0) throw badRequest("No rows could be read with this mapping", "no_rows");

    let profileId: string | null = null;
    if (request.body.saveProfile) {
      const name = request.body.saveProfile.name.trim();
      if (request.body.saveProfile.id) {
        const [updated] = await app.db
          .update(connection)
          .set({ name, csvMapping: request.body.mapping, updatedAt: new Date() })
          .where(and(eq(connection.id, request.body.saveProfile.id), eq(connection.type, "csv")))
          .returning({ id: connection.id });
        profileId = updated?.id ?? null;
      }
      if (!profileId) {
        const [created] = await app.db.insert(connection).values({ type: "csv", name, csvMapping: request.body.mapping }).returning({ id: connection.id });
        profileId = created!.id;
      }
    }

    const [log] = await app.db
      .insert(importLog)
      .values({ connectionId: profileId, kind: "csv", rawPayload: { csvText: request.body.csvText, mapping: request.body.mapping } })
      .returning({ id: importLog.id });
    let result: Awaited<ReturnType<typeof importCsvRows>>;
    try {
      result = await importCsvRows(app.db, { accountId: acct.id, rows: mapped.rows, importLogId: log!.id });
      await app.db
        .update(importLog)
        .set({ status: "ok", finishedAt: new Date(), stats: { ...result, rowsRead: mapped.rows.length, rowsRejected: mapped.errors.length } })
        .where(eq(importLog.id, log!.id));
      if (profileId) await app.db.update(connection).set({ lastSyncAt: new Date(), status: "ok" }).where(eq(connection.id, profileId));
    } catch (err) {
      await app.db.update(importLog).set({ status: "error", finishedAt: new Date(), message: (err as Error).message }).where(eq(importLog.id, log!.id));
      throw err;
    }
    // The "match recurring" pipeline step runs for every ingest path (design C5); one queued job covers any number of commits.
    await enqueueJob(app.db, "recurring.detect", { reason: "ledger" }, { dedupe: true });
    return { ...result, errors: mapped.errors };
  });

  // ---- Phase 3: positions and trade-history CSV ----

  /** A saved `csv` connection of the asked kind, parsed with the kind's schema (400 `bad_profile` when it no longer validates). */
  async function loadMappingProfile<S extends z.ZodTypeAny>(profileId: string, kind: MappingKind, schema: S): Promise<z.infer<S>> {
    const [profile] = await app.db.select().from(connection).where(eq(connection.id, profileId));
    if (!profile?.csvMapping) throw notFound("Mapping profile not found");
    if (profile.csvKind !== kind) throw badRequest(`The saved profile holds a ${profile.csvKind} mapping, not a ${kind} one`, "bad_profile");
    const parsed = schema.safeParse(profile.csvMapping);
    if (!parsed.success) throw badRequest("The saved mapping is no longer valid; rebuild it", "bad_profile");
    return parsed.data as z.infer<S>;
  }

  /** Create or update a `csv` connection carrying the mapping, typed by `csv_kind`; returns its id. */
  async function saveMappingProfile(save: { id?: string | undefined; name: string }, kind: MappingKind, mapping: Record<string, unknown>): Promise<string> {
    const name = save.name.trim();
    if (save.id) {
      const [updated] = await app.db
        .update(connection)
        .set({ name, csvMapping: mapping, csvKind: kind, updatedAt: new Date() })
        .where(and(eq(connection.id, save.id), eq(connection.type, "csv")))
        .returning({ id: connection.id });
      if (updated) return updated.id;
    }
    const [created] = await app.db.insert(connection).values({ type: "csv", name, csvMapping: mapping, csvKind: kind }).returning({ id: connection.id });
    return created!.id;
  }

  async function finishLog(logId: string, stats: Record<string, number>, message: string): Promise<void> {
    await app.db.update(importLog).set({ status: "ok", finishedAt: new Date(), stats, message }).where(eq(importLog.id, logId));
  }

  async function failLog(logId: string, err: unknown): Promise<void> {
    await app.db.update(importLog).set({ status: "error", finishedAt: new Date(), message: (err as Error).message }).where(eq(importLog.id, logId));
  }

  r.post("/import/positions/preview", { schema: { body: PositionsPreviewBody, response: { 200: PositionsPreviewResponse } } }, async (request) => {
    const b = request.body;
    const rows = parseRows(b.csvText);
    if (rows.length === 0) throw badRequest("The file is empty", "empty_csv");
    const acct = await loadInvestmentAccount(app.db, b.accountId);
    let mapping: PositionsCsvMappingInput | undefined = b.mapping;
    if (!mapping && b.profileId) mapping = await loadMappingProfile(b.profileId, "positions", PositionsCsvMapping);
    const headers = rows[0]!;
    if (!mapping) mapping = guessPositionsMapping(headers, rows.slice(1, 6));
    const sampleRows = rows.slice(0, 6);
    if (!mapping) {
      return {
        headers,
        sampleRows,
        mapping: null,
        asOf: null,
        positions: [],
        totalValueCents: "0",
        knownBalanceCents: null,
        differenceCents: null,
        matchesToDollar: null,
        setBalanceDefault: !acct.simplefinFed,
        filterValues: [],
        pendingActivityCents: "0",
        snapshotExists: false,
        existingSource: null,
        willReplace: false,
        rowsRead: Math.max(rows.length - 1, 0),
        errors: [],
        skipped: [],
      };
    }
    const parsedMapping = PositionsCsvMapping.parse(mapping);
    const mapped = mapPositions(rows, parsedMapping, b);
    const choices = choiceMap(b.choices);
    const snapshot = await getSnapshot(app.db, acct.id, mapped.asOf);
    const existingRows = new Map(snapshot?.rows.map((row) => [row.securityId, row]) ?? []);
    const cache = new Map<string, PreviewSecurityRef>();
    const positions = [];
    let totalValueCents = 0n;
    for (const p of mapped.positions) {
      const ref = await previewRef(app.db, positionKey(p), choices.get(p.rowIndex)?.security, cache);
      const existing = ref.id === null ? undefined : existingRows.get(ref.id);
      positions.push(toMappedPositionView(p, { security: ref, existing: existing ? { quantity: existing.quantity, valueCents: existing.valueCents } : null }));
      totalValueCents += p.valueCents;
    }
    const knownBalanceCents = acct.simplefinFed ? await knownSimplefinBalance(app.db, acct.id, mapped.asOf) : null;
    const differenceCents = knownBalanceCents === null ? null : totalValueCents - knownBalanceCents;
    return {
      headers: headerNames(headers, parsedMapping.hasHeader),
      sampleRows,
      mapping: parsedMapping,
      asOf: mapped.asOf,
      positions,
      totalValueCents: totalValueCents.toString(),
      knownBalanceCents: knownBalanceCents === null ? null : knownBalanceCents.toString(),
      differenceCents: differenceCents === null ? null : differenceCents.toString(),
      matchesToDollar: differenceCents === null ? null : matchesToDollar(differenceCents),
      setBalanceDefault: !acct.simplefinFed,
      filterValues: mapped.filterValues,
      pendingActivityCents: mapped.pendingActivityCents.toString(),
      snapshotExists: snapshot !== undefined,
      existingSource: snapshot?.source ?? null,
      willReplace: snapshot === undefined || HOLDING_SOURCE_RANK.csv >= HOLDING_SOURCE_RANK[snapshot.source],
      rowsRead: dataRowCount(rows, parsedMapping),
      errors: toRowErrors(mapped.errors).slice(0, 50),
      skipped: mapped.skipped.map((s) => ({ rowIndex: s.rowIndex, reason: s.reason })),
    };
  });

  /**
   * §3.7 commit: the `import_log` row (kind `csv.positions`) first, then one transaction that
   * resolves or creates the securities, aggregates sub-lots per security, replaces the snapshot
   * set (source `csv`; a `manual` set on that date → 409 `snapshot_precedence`), rebuilds the
   * implied prices of that date and queues the valuation; afterwards the holdings price refresh
   * when a provider is configured.
   */
  r.post("/import/positions/commit", { schema: { body: PositionsCommitBody, response: { 200: PositionsImportResult } } }, async (request) => {
    const b = request.body;
    const today = await resolveToday(app, b.today);
    const acct = await loadInvestmentAccount(app.db, b.accountId);
    const rows = parseRows(b.csvText);
    if (rows.length === 0) throw badRequest("The file is empty", "empty_csv");
    const mapped = mapPositions(rows, b.mapping, b);
    if (mapped.positions.length === 0) throw badRequest("No positions could be read with this mapping", "no_rows");
    const profileId = b.saveProfile ? await saveMappingProfile(b.saveProfile, "positions", b.mapping) : null;
    const [log] = await app.db
      .insert(importLog)
      .values({
        connectionId: profileId,
        kind: "csv.positions",
        rawPayload: { csvText: b.csvText, mapping: b.mapping, asOfDate: b.asOfDate ?? null, accountFilterValue: b.accountFilterValue ?? null, choices: b.choices },
      })
      .returning({ id: importLog.id });
    const logId = log!.id;
    const ctx = auditContext(request);
    const choices = choiceMap(b.choices);
    try {
      const outcome = await app.db.transaction(async (tx) => {
        const created = new Set<string>();
        const aggregates = new Map<string, PositionAggregate>();
        for (const p of mapped.positions) {
          const resolved = await commitSecurity(tx, p, choices.get(p.rowIndex)?.security, ctx);
          if (resolved.created) created.add(resolved.id);
          aggregatePosition(aggregates, resolved.id, p);
        }
        const result = await replaceHoldingSnapshot(tx, {
          accountId: acct.id,
          date: mapped.asOf,
          source: "csv",
          importLogId: logId,
          positions: [...aggregates.values()].map(toSnapshotPosition),
          ...(b.setBalance !== undefined ? { setBalance: b.setBalance } : {}),
          ...(b.statementTotalCents !== undefined ? { statementTotalCents: BigInt(b.statementTotalCents) } : {}),
          today,
        });
        const implied = await rebuildImpliedPrices(tx, { securityIds: result.securityIds, dates: [mapped.asOf] });
        await requestValuation(tx, { reason: "positions", accountId: acct.id });
        return { result, securitiesCreated: created.size, impliedPrices: implied.written, positions: aggregates.size };
      });
      const { result } = outcome;
      const bridge = result.knownBalanceCents === null || result.differenceCents === null ? "" : ` (Bridge balance $${formatCents(result.knownBalanceCents)}, difference $${formatCents(result.differenceCents)})`;
      await finishLog(
        logId,
        {
          rowsRead: dataRowCount(rows, PositionsCsvMapping.parse(b.mapping)),
          rowsRejected: mapped.errors.length,
          rowsSkipped: mapped.skipped.length,
          positions: outcome.positions,
          inserted: result.inserted,
          updated: result.updated,
          unchanged: result.unchanged,
          deleted: result.deleted,
          securitiesCreated: outcome.securitiesCreated,
          impliedPrices: outcome.impliedPrices,
          balanceWritten: result.balanceWritten ? 1 : 0,
        },
        `Snapshot ${mapped.asOf}: ${outcome.positions} positions, $${formatCents(result.totalValueCents)}${bridge}`,
      );
      if (profileId) await app.db.update(connection).set({ lastSyncAt: new Date(), status: "ok" }).where(eq(connection.id, profileId));
      // Every positions commit asks for the held securities' prices (§3.7 step 5); nothing is queued without a provider.
      if (priceProviderConfigured(app)) await requestPriceRefresh(app.db, { reason: "holdings", now: app.now() });
      return toPositionsImportResult({ importLogId: logId, asOf: mapped.asOf, positions: outcome.positions, result, securitiesCreated: outcome.securitiesCreated, impliedPrices: outcome.impliedPrices, errors: mapped.errors });
    } catch (err) {
      await failLog(logId, err);
      throw err;
    }
  });

  r.post("/import/trades/preview", { schema: { body: TradesPreviewBody, response: { 200: TradesPreviewResponse } } }, async (request) => {
    const b = request.body;
    const rows = parseRows(b.csvText);
    if (rows.length === 0) throw badRequest("The file is empty", "empty_csv");
    const acct = await loadInvestmentAccount(app.db, b.accountId);
    let mapping: TradesCsvMappingInput | undefined = b.mapping;
    if (!mapping && b.profileId) mapping = await loadMappingProfile(b.profileId, "trades", TradesCsvMapping);
    const headers = rows[0]!;
    if (!mapping) mapping = guessTradesMapping(headers, rows.slice(1, 6));
    const sampleRows = rows.slice(0, 6);
    if (!mapping) {
      return { headers, sampleRows, mapping: null, rowOrder: null, trades: [], totalRows: Math.max(rows.length - 1, 0), duplicateCount: 0, changedCount: 0, userEditedCount: 0, actionsFound: [], unknownActions: 0, filterValues: [], errors: [], skipped: [] };
    }
    const parsedMapping = TradesCsvMapping.parse(mapping);
    const mapped = await mapTrades(rows, parsedMapping, b);
    const existing = await existingTradeRows(app.db, acct.id, mapped.trades.map((t) => t.externalId));
    const linkedDates = await ledgerDates(app.db, [...existing.values()].map((row) => row.ledgerTransactionId).filter((id): id is string => id !== null));
    const choices = choiceMap(b.choices);
    const cache = new Map<string, PreviewSecurityRef>();
    // Indexed by position in `mapped.trades`: a combined reinvest row yields two trades with one rowIndex.
    const contexts: Array<{ security: PreviewSecurityRef | null; stored: TradeRow | undefined; changed: boolean; userEdited: boolean }> = [];
    const candidates: LinkItem[] = [];
    for (const [index, t] of mapped.trades.entries()) {
      const sec = isCashTrade(t) ? null : await previewRef(app.db, tradeKey(t), choices.get(t.rowIndex)?.security, cache);
      const stored = existing.get(t.externalId);
      const userEdited = stored?.userEdited ?? false;
      const changed = stored !== undefined && !userEdited && tradeChanged(t, stored, sec?.id ?? null);
      if (stored === undefined && linkable(t)) candidates.push({ index, date: t.date, amountCents: t.amountCents });
      contexts.push({ security: sec, stored, changed, userEdited });
    }
    const matches = await previewLedgerMatches(app.db, acct.id, candidates);
    const trades = mapped.trades.map((t, index) => {
      const c = contexts[index]!;
      const storedLink = c.stored?.ledgerTransactionId ?? null;
      const storedDate = storedLink === null ? undefined : linkedDates.get(storedLink);
      const ledgerMatch = c.stored ? (storedLink !== null && storedDate !== undefined ? { ledgerTransactionId: storedLink, date: storedDate } : null) : (matches.get(index) ?? null);
      return toMappedTradeView(t, { security: c.security, duplicate: c.stored !== undefined, changed: c.changed, userEdited: c.userEdited, ledgerMatch });
    });
    return {
      headers: headerNames(headers, parsedMapping.hasHeader),
      sampleRows,
      mapping: parsedMapping,
      rowOrder: mapped.rowOrder,
      trades: trades.slice(0, 500),
      totalRows: mapped.trades.length,
      duplicateCount: contexts.filter((c) => c.stored !== undefined).length,
      changedCount: contexts.filter((c) => c.changed).length,
      userEditedCount: contexts.filter((c) => c.stored !== undefined && c.userEdited).length,
      actionsFound: mapped.actionsFound.map(toActionFoundView),
      unknownActions: mapped.unknownActions,
      filterValues: mapped.filterValues,
      errors: toRowErrors(mapped.errors).slice(0, 50),
      skipped: mapped.skipped.map((s) => ({ rowIndex: s.rowIndex, reason: s.reason, text: s.text })),
    };
  });

  /**
   * §3.9 commit: the `import_log` row (kind `csv.trades`) first, then `importTrades` (one
   * transaction: upsert by external id, ledger links, derived ledger rows for CSV-only accounts,
   * transfer pairing, lot rebuilds; 400 `unknown_action` / `future_date` /
   * `not_investment_account` mark the log row `error`). A split row without a ratio and a file
   * without readable rows are refused before anything is written.
   */
  r.post("/import/trades/commit", { schema: { body: TradesCommitBody, response: { 200: TradesImportResult } } }, async (request) => {
    const b = request.body;
    const today = await resolveToday(app, b.today);
    const acct = await loadInvestmentAccount(app.db, b.accountId);
    const rows = parseRows(b.csvText);
    if (rows.length === 0) throw badRequest("The file is empty", "empty_csv");
    const mapped = await mapTrades(rows, b.mapping, b);
    const splitMissing = mapped.errors.find((e) => e.code === "split_ratio_required");
    if (splitMissing) throw badRequest(`Row ${splitMissing.rowIndex}: ${splitMissing.message}`, "split_ratio_required");
    if (mapped.trades.length === 0 && mapped.unknownActions === 0) throw badRequest("No trades could be read with this mapping", "no_rows");
    const profileId = b.saveProfile ? await saveMappingProfile(b.saveProfile, "trades", b.mapping) : null;
    const [log] = await app.db
      .insert(importLog)
      .values({ connectionId: profileId, kind: "csv.trades", rawPayload: { csvText: b.csvText, mapping: b.mapping, accountFilterValue: b.accountFilterValue ?? null, choices: b.choices } })
      .returning({ id: importLog.id });
    const logId = log!.id;
    try {
      const result = await importTrades(app.db, {
        accountId: acct.id,
        trades: mapped.trades,
        unknownActionKeys: mapped.actionsFound.filter((a) => a.kind === null).map((a) => a.key),
        choices: b.choices,
        importLogId: logId,
        today,
        ctx: auditContext(request),
        queuePriceRefresh: priceProviderConfigured(app),
        now: app.now(),
      });
      await finishLog(
        logId,
        {
          rowsRead: dataRowCount(rows, TradesCsvMapping.parse(b.mapping)),
          rowsRejected: mapped.errors.length,
          rowsSkipped: mapped.skipped.length,
          created: result.created,
          updated: result.updated,
          unchanged: result.unchanged,
          skippedEdited: result.skippedEdited,
          linked: result.linked,
          ledgerCreated: result.ledgerCreated,
          ledgerSkipped: result.ledgerSkipped,
          transfersPaired: result.transfersPaired,
          securitiesCreated: result.securitiesCreated,
          lotsRebuilt: result.lotsRebuilt,
        },
        `Trades: ${result.created} new, ${result.updated} updated, ${result.unchanged} unchanged, ${result.skippedEdited} edited by hand`,
      );
      if (profileId) await app.db.update(connection).set({ lastSyncAt: new Date(), status: "ok" }).where(eq(connection.id, profileId));
      return toTradesImportResult(logId, result, mapped.errors);
    } catch (err) {
      await failLog(logId, err);
      throw err;
    }
  });
}
