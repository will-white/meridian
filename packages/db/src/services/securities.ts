import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  guessSecurityHints,
  impliedPrice,
  isCashKey,
  isIsoDate,
  normalizeCusip,
  normalizeIsin,
  normalizeName,
  normalizeTicker,
  percentToPpm,
  sanitizeText,
  type AssetClass,
  type Fixed8,
  type HoldingSource,
  type IsoDate,
  type PriceSource,
  type SecurityKey,
  type SecuritySuggestion,
  type SecurityType,
} from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import {
  holdingSnapshot,
  householdSetting,
  investmentTxn,
  lot,
  lotDisposal,
  price,
  SECURITY_ALIAS_KINDS,
  security,
  securityAlias,
  securityAllocation,
} from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { fixed8FromDb, fixed8ToDb } from "./decimalDb.js";
import { getPrice, latestPrices, requestPriceRefresh, upsertPrices, type LatestPriceRecord, type PriceRecord } from "./prices.js";

/**
 * The security master (imports design §3.2 under plan decisions 3, 4, 10 and 17; seams C39,
 * C46): resolution of a source's identity key to one row (alias → ticker → cusip → isin →
 * normalized name), the cash security per currency, learned aliases, the owner's create /
 * update / delete / merge, the pricing fields (`updateSecurityPricing`), the "held" set the
 * price feed and the Securities page read, and the owner's manual price.
 *
 * Precedence constants live here because the master defines them; `holdings.ts` and
 * `prices.ts` apply them to snapshot and price rows.
 */

/** `holding_snapshot.source` and `balance_snapshot.source` precedence (plan decision 14; `computed` never outranks a reported row). */
export const HOLDING_SOURCE_RANK: Record<HoldingSource | "computed", number> = { computed: 0, simplefin: 1, csv: 2, manual: 3 };
/** `price.source` precedence (plan decision 10). */
export const PRICE_SOURCE_RANK: Record<PriceSource, number> = { implied: 1, provider: 2, manual: 3 };

export type SecurityRow = typeof security.$inferSelect;
export type SecurityAliasKind = (typeof SECURITY_ALIAS_KINDS)[number];

export interface SecurityAliasRecord {
  kind: SecurityAliasKind;
  value: string;
}

/** Bigint twin of `SecurityView`. */
export interface SecurityRecord {
  id: string;
  ticker: string | null;
  name: string;
  type: SecurityType;
  assetClass: AssetClass;
  expenseRatioPpm: number | null;
  cusip: string | null;
  isin: string | null;
  currency: string;
  priceMode: PriceSource;
  providerSymbol: string | null;
  alwaysPrice: boolean;
  needsReview: boolean;
  archived: boolean;
  notes: string | null;
  aliases: SecurityAliasRecord[];
  held: boolean;
  heldInAccounts: number;
  latestPrice: LatestPriceRecord | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SecurityMatchedBy = "alias" | "ticker" | "cusip" | "isin" | "name" | "cash";

export type ResolveSecurityResult =
  | { id: string; created: boolean; matchedBy: SecurityMatchedBy | "created" }
  | { id: null; created: false; matchedBy: "unresolved"; suggestion: SecuritySuggestion };

export interface ResolveSecurityOptions {
  createIfMissing: boolean;
  /** Informational: which importer asked (kept for the audit trail of a later step). */
  source?: HoldingSource;
}

// ---- Small helpers ----

export async function requireSecurity(tx: DbOrTx, id: string): Promise<SecurityRow> {
  const [row] = await tx.select().from(security).where(eq(security.id, id));
  if (!row) throw new PlanError(404, "not_found", "Security not found");
  return row;
}

function normalizeCurrency(raw: string | null | undefined): string {
  const s = sanitizeText(raw, 10).toUpperCase();
  if (!s) return "USD";
  if (!/^[A-Z]{3}$/.test(s)) throw new PlanError(400, "validation", `Unknown currency "${s}"`);
  return s;
}

/** The audit shape: the owner-visible columns plus the learned aliases; never the fetch state or timestamps. */
export function securityAuditJson(row: SecurityRow, aliases: readonly SecurityAliasRecord[] = []) {
  return {
    id: row.id,
    ticker: row.ticker,
    name: row.name,
    type: row.type,
    assetClass: row.assetClass,
    expenseRatioPpm: row.expenseRatioPpm,
    cusip: row.cusip,
    isin: row.isin,
    currency: row.currency,
    priceMode: row.priceMode,
    providerSymbol: row.providerSymbol,
    alwaysPrice: row.alwaysPrice,
    needsReview: row.needsReview,
    archived: row.archived,
    notes: row.notes,
    aliases: [...aliases].sort((a, b) => a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value)).map((a) => `${a.kind}:${a.value}`),
  };
}

async function loadAliases(db: DbOrTx, securityIds: readonly string[]): Promise<Map<string, SecurityAliasRecord[]>> {
  const out = new Map<string, SecurityAliasRecord[]>();
  if (securityIds.length === 0) return out;
  const rows = await db
    .select({ securityId: securityAlias.securityId, kind: securityAlias.kind, value: securityAlias.value })
    .from(securityAlias)
    .where(inArray(securityAlias.securityId, [...securityIds]))
    .orderBy(asc(securityAlias.kind), asc(securityAlias.value));
  for (const r of rows) {
    const list = out.get(r.securityId) ?? [];
    list.push({ kind: r.kind, value: r.value });
    out.set(r.securityId, list);
  }
  return out;
}

// ---- Held securities ----

/**
 * Security id → the open accounts holding it: a row with a non-zero quantity (or a non-zero
 * value for a dollar-only row) in the account's latest snapshot set, or an open lot.
 */
export async function loadHeldSecurities(db: DbOrTx): Promise<Map<string, Set<string>>> {
  const rows = await db.execute<{ security_id: string; account_id: string }>(sql`
    with latest as (
      select hs.account_id, max(hs.date) as date from holding_snapshot hs group by hs.account_id
    )
    select hs.security_id, hs.account_id
    from holding_snapshot hs
    join latest l on l.account_id = hs.account_id and l.date = hs.date
    join account a on a.id = hs.account_id and a.closed = false
    where (hs.quantity is not null and hs.quantity <> 0) or (hs.quantity is null and hs.value_cents <> 0)
    union
    select lt.security_id, lt.account_id
    from lot lt
    join account a on a.id = lt.account_id and a.closed = false
    where lt.quantity > 0
  `);
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = out.get(r.security_id) ?? new Set<string>();
    set.add(r.account_id);
    out.set(r.security_id, set);
  }
  return out;
}

/** The prices design's "held securities only": the keys of `loadHeldSecurities`. */
export async function listHeldSecurityIds(db: DbOrTx): Promise<Set<string>> {
  return new Set((await loadHeldSecurities(db)).keys());
}

// ---- Cash security ----

/** Get-or-create the one cash security of a currency (valued at 1, never priced, never reviewed). */
export async function cashSecurity(tx: DbOrTx, currency = "USD"): Promise<{ row: SecurityRow; created: boolean }> {
  const cur = normalizeCurrency(currency);
  const find = async () => {
    const [row] = await tx
      .select()
      .from(security)
      .where(and(eq(security.type, "cash"), eq(security.currency, cur)));
    return row;
  };
  const existing = await find();
  if (existing) return { row: existing, created: false };
  const [inserted] = await tx
    .insert(security)
    .values({ ticker: null, name: `Cash (${cur})`, type: "cash", assetClass: "cash", currency: cur, priceMode: "manual", needsReview: false })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { row: inserted, created: true };
  const row = await find();
  if (!row) throw new PlanError(500, "internal", "cash security could not be created");
  return { row, created: false };
}

// ---- Resolution ----

interface IdentityParts {
  ticker: string | null;
  cusip: string | null;
  isin: string | null;
  /** Normalized name for the alias and name steps; from the symbol column when it is not ticker-shaped. */
  nameNorm: string;
  /** The display name a new row gets. */
  displayName: string;
}

function identifiersOf(key: SecurityKey): IdentityParts {
  const ticker = normalizeTicker(key.ticker);
  const cusip = normalizeCusip(key.cusip);
  const isin = normalizeIsin(key.isin);
  const rawName = sanitizeText(key.name, 200);
  const rawTickerText = sanitizeText(key.ticker, 200);
  const nameNorm = normalizeName(rawName) || (ticker === null ? normalizeName(rawTickerText) : "");
  const displayName = rawName || (ticker === null ? rawTickerText : "") || ticker || cusip || isin || "";
  return { ticker, cusip, isin, nameNorm, displayName };
}

const normalizedNameSql = sql`btrim(upper(regexp_replace(${security.name}, '[^A-Za-z0-9]+', ' ', 'g')))`;

async function lookupSecurity(tx: DbOrTx, ids: IdentityParts): Promise<{ id: string; matchedBy: SecurityMatchedBy } | null> {
  const pairs: Array<[SecurityAliasKind, string]> = [];
  if (ids.ticker) pairs.push(["ticker", ids.ticker]);
  if (ids.cusip) pairs.push(["cusip", ids.cusip]);
  if (ids.isin) pairs.push(["isin", ids.isin]);
  if (ids.nameNorm) pairs.push(["name", ids.nameNorm]);
  if (pairs.length > 0) {
    const aliasRows = await tx
      .select({ kind: securityAlias.kind, securityId: securityAlias.securityId })
      .from(securityAlias)
      .where(or(...pairs.map(([kind, value]) => and(eq(securityAlias.kind, kind), eq(securityAlias.value, value)))));
    for (const [kind] of pairs) {
      const hit = aliasRows.find((r) => r.kind === kind);
      if (hit) return { id: hit.securityId, matchedBy: "alias" };
    }
  }
  if (ids.ticker) {
    const [row] = await tx.select({ id: security.id }).from(security).where(eq(security.ticker, ids.ticker));
    if (row) return { id: row.id, matchedBy: "ticker" };
  }
  if (ids.cusip) {
    const [row] = await tx.select({ id: security.id }).from(security).where(eq(security.cusip, ids.cusip));
    if (row) return { id: row.id, matchedBy: "cusip" };
  }
  if (ids.isin) {
    const [row] = await tx.select({ id: security.id }).from(security).where(eq(security.isin, ids.isin));
    if (row) return { id: row.id, matchedBy: "isin" };
  }
  if (ids.ticker === null && ids.nameNorm) {
    const [row] = await tx
      .select({ id: security.id })
      .from(security)
      .where(sql`${normalizedNameSql} = ${ids.nameNorm}`)
      .orderBy(asc(security.createdAt), asc(security.id))
      .limit(1);
    if (row) return { id: row.id, matchedBy: "name" };
  }
  return null;
}

/** Default `price_mode` on create: a ticker is fetched, except money-market/sweep funds (seams decision 16); no ticker → implied. */
function defaultPriceMode(ticker: string | null, hints: { type: SecurityType; assetClass: AssetClass }): PriceSource {
  if (ticker === null) return "implied";
  if (hints.type === "fund" && hints.assetClass === "cash") return "implied";
  return "provider";
}

/**
 * Resolve a source's identity key to a security (§3.2): the cash key → the cash security;
 * then alias, ticker, cusip, isin, and (only without a ticker) the normalized name. A key
 * with a ticker that matches nothing creates a new security even when a name matches.
 * With `createIfMissing` a new row is inserted with guessed hints and `needs_review`;
 * a unique-index race re-runs the lookup. Without it the preview gets a suggestion.
 */
export async function resolveSecurity(tx: DbOrTx, key: SecurityKey, opts: ResolveSecurityOptions): Promise<ResolveSecurityResult> {
  if (isCashKey(key)) {
    const { row, created } = await cashSecurity(tx, key.currency ?? "USD");
    return { id: row.id, created, matchedBy: "cash" };
  }
  const ids = identifiersOf(key);
  if (!ids.ticker && !ids.cusip && !ids.isin && !ids.nameNorm) throw new PlanError(400, "validation", "A security needs a ticker, CUSIP, ISIN or name");
  const found = await lookupSecurity(tx, ids);
  if (found) return { id: found.id, created: false, matchedBy: found.matchedBy };

  const hints = guessSecurityHints({ ticker: key.ticker ?? null, name: ids.displayName, hints: key.hints ?? [] });
  const suggestion: SecuritySuggestion = { ticker: ids.ticker, cusip: ids.cusip, isin: ids.isin, name: ids.displayName, type: hints.type, assetClass: hints.assetClass };
  if (!opts.createIfMissing) return { id: null, created: false, matchedBy: "unresolved", suggestion };

  const [inserted] = await tx
    .insert(security)
    .values({
      ticker: ids.ticker,
      name: ids.displayName,
      type: hints.type,
      assetClass: hints.assetClass,
      cusip: ids.cusip,
      isin: ids.isin,
      currency: normalizeCurrency(key.currency),
      priceMode: defaultPriceMode(ids.ticker, hints),
      needsReview: true,
    })
    .onConflictDoNothing()
    .returning({ id: security.id });
  if (inserted) return { id: inserted.id, created: true, matchedBy: "created" };
  const again = await lookupSecurity(tx, ids);
  if (again) return { id: again.id, created: false, matchedBy: again.matchedBy };
  throw new PlanError(409, "conflict", "Security could not be created");
}

// ---- Aliases ----

export const MAX_ALIASES_PER_SECURITY = 50;

/** Insert one alias; 409 `alias_taken` when another security owns it (as an alias or as its own identifier). Returns 1 when written. */
async function insertAlias(tx: DbOrTx, row: SecurityRow, kind: SecurityAliasKind, value: string): Promise<number> {
  const [existing] = await tx
    .select({ securityId: securityAlias.securityId })
    .from(securityAlias)
    .where(and(eq(securityAlias.kind, kind), eq(securityAlias.value, value)));
  if (existing) {
    if (existing.securityId === row.id) return 0;
    throw new PlanError(409, "alias_taken", `${kind} "${value}" already belongs to another security; merge them instead`);
  }
  if (kind !== "name") {
    const column = kind === "ticker" ? security.ticker : kind === "cusip" ? security.cusip : security.isin;
    const [owner] = await tx
      .select({ id: security.id })
      .from(security)
      .where(and(eq(column, value), ne(security.id, row.id)));
    if (owner) throw new PlanError(409, "alias_taken", `${kind} "${value}" is another security's identifier; merge them instead`);
  }
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(securityAlias)
    .where(eq(securityAlias.securityId, row.id));
  if ((count?.n ?? 0) >= MAX_ALIASES_PER_SECURITY) return 0;
  const inserted = await tx.insert(securityAlias).values({ securityId: row.id, kind, value }).onConflictDoNothing().returning({ id: securityAlias.id });
  return inserted.length;
}

/**
 * Learn the key's identifiers as aliases of a security (the preview's "link to existing"):
 * each normalized ticker / cusip / isin / name that is not the row's own identifier. Returns
 * how many were written. Not audited: the import that learns them is recorded by `import_log`.
 */
export async function learnAliases(tx: DbOrTx, securityId: string, key: SecurityKey): Promise<number> {
  const row = await requireSecurity(tx, securityId);
  const ids = identifiersOf(key);
  const candidates: Array<[SecurityAliasKind, string]> = [];
  if (ids.ticker && ids.ticker !== row.ticker) candidates.push(["ticker", ids.ticker]);
  if (ids.cusip && ids.cusip !== row.cusip) candidates.push(["cusip", ids.cusip]);
  if (ids.isin && ids.isin !== row.isin) candidates.push(["isin", ids.isin]);
  if (ids.nameNorm && ids.nameNorm !== normalizeName(row.name)) candidates.push(["name", ids.nameNorm]);
  let added = 0;
  for (const [kind, value] of candidates) added += await insertAlias(tx, row, kind, value);
  return added;
}

function normalizeAliasValue(kind: SecurityAliasKind, raw: string): string {
  switch (kind) {
    case "ticker": {
      const v = normalizeTicker(raw);
      if (!v) throw new PlanError(400, "validation", `"${sanitizeText(raw, 50)}" is not a ticker`);
      return v;
    }
    case "cusip": {
      const v = normalizeCusip(raw);
      if (!v) throw new PlanError(400, "validation", "A CUSIP is 9 characters");
      return v;
    }
    case "isin": {
      const v = normalizeIsin(raw);
      if (!v) throw new PlanError(400, "validation", "An ISIN is 12 characters");
      return v;
    }
    case "name": {
      const v = normalizeName(raw);
      if (!v) throw new PlanError(400, "validation", "Name is required");
      return v;
    }
  }
}

/** The owner's alias (e.g. FB → META). Audited as a `security` update. */
export async function addSecurityAlias(db: Db, securityId: string, input: { kind: SecurityAliasKind; value: string }, ctx: AuditContext): Promise<SecurityRecord> {
  await db.transaction(async (tx) => {
    const row = await requireSecurity(tx, securityId);
    const value = normalizeAliasValue(input.kind, input.value);
    const own = input.kind === "ticker" ? row.ticker : input.kind === "cusip" ? row.cusip : input.kind === "isin" ? row.isin : normalizeName(row.name);
    if (own === value) return;
    const before = (await loadAliases(tx, [securityId])).get(securityId) ?? [];
    await insertAlias(tx, row, input.kind, value);
    const after = (await loadAliases(tx, [securityId])).get(securityId) ?? [];
    await writeAudit(tx, { ...ctx, entity: "security", entityId: securityId, action: "update", before: securityAuditJson(row, before), after: securityAuditJson(row, after) });
  });
  return (await getSecurity(db, securityId))!;
}

// ---- Reads ----

export interface SecurityListQuery {
  q?: string;
  needsReview?: boolean;
  held?: boolean;
  type?: SecurityType;
  includeArchived?: boolean;
}

async function buildRecords(db: DbOrTx, rows: readonly SecurityRow[]): Promise<SecurityRecord[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const aliases = await loadAliases(db, ids);
  const held = await loadHeldSecurities(db);
  const latest = await latestPrices(db, ids);
  return rows.map((r) => {
    const accounts = held.get(r.id);
    return {
      id: r.id,
      ticker: r.ticker,
      name: r.name,
      type: r.type,
      assetClass: r.assetClass,
      expenseRatioPpm: r.expenseRatioPpm,
      cusip: r.cusip,
      isin: r.isin,
      currency: r.currency,
      priceMode: r.priceMode,
      providerSymbol: r.providerSymbol,
      alwaysPrice: r.alwaysPrice,
      needsReview: r.needsReview,
      archived: r.archived,
      notes: r.notes,
      aliases: aliases.get(r.id) ?? [],
      held: accounts !== undefined && accounts.size > 0,
      heldInAccounts: accounts?.size ?? 0,
      latestPrice: latest.get(r.id) ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
}

export async function getSecurity(db: DbOrTx, id: string): Promise<SecurityRecord | undefined> {
  const [row] = await db.select().from(security).where(eq(security.id, id));
  if (!row) return undefined;
  return (await buildRecords(db, [row]))[0];
}

/** Securities sorted by ticker (ticker-less rows by name after them); archived hidden unless asked. */
export async function listSecurities(db: DbOrTx, query: SecurityListQuery = {}): Promise<SecurityRecord[]> {
  const q = query.q ? sanitizeText(query.q, 100) : "";
  const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = await db
    .select()
    .from(security)
    .where(
      and(
        query.includeArchived ? undefined : eq(security.archived, false),
        query.needsReview !== undefined ? eq(security.needsReview, query.needsReview) : undefined,
        query.type !== undefined ? eq(security.type, query.type) : undefined,
        q ? or(sql`${security.ticker} ilike ${pattern}`, sql`${security.name} ilike ${pattern}`, sql`${security.cusip} ilike ${pattern}`) : undefined,
      ),
    );
  const records = await buildRecords(db, rows);
  const filtered = query.held === undefined ? records : records.filter((r) => r.held === query.held);
  return filtered.sort((a, b) => {
    if (a.ticker !== null && b.ticker === null) return -1;
    if (a.ticker === null && b.ticker !== null) return 1;
    return (a.ticker ?? "").localeCompare(b.ticker ?? "") || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1);
  });
}

// ---- Create / update ----

export interface CreateSecurityInput {
  ticker?: string | null;
  name: string;
  type: SecurityType;
  assetClass: AssetClass;
  expenseRatioPpm?: number | null;
  /** "0.03" → 300 ppm (the API body's form); must be a whole number of ppm. */
  expenseRatioPercent?: string | null;
  cusip?: string | null;
  isin?: string | null;
  currency?: string;
  priceMode?: PriceSource;
  providerSymbol?: string | null;
  alwaysPrice?: boolean;
  notes?: string | null;
}

export interface UpdateSecurityInput extends Partial<CreateSecurityInput> {
  needsReview?: boolean;
  archived?: boolean;
}

export type SecurityPricingPatch = Pick<UpdateSecurityInput, "priceMode" | "providerSymbol" | "alwaysPrice">;

export interface SecurityMutationOptions {
  /** Queue a `prices.fetch` backfill when the pricing patch calls for one (the caller turns it off when no provider is configured). */
  queueBackfill?: boolean;
  /** Fixes `now` for the queued job (tests). */
  now?: Date;
}

export interface SecurityMutationResult {
  security: SecurityRecord;
  /** The `prices.fetch` job queued for a switch to `provider` or a symbol change, when any. */
  backfillJobId: string | null;
}

function expenseRatioOf(input: Pick<CreateSecurityInput, "expenseRatioPpm" | "expenseRatioPercent">): number | null | undefined {
  if (input.expenseRatioPpm !== undefined) {
    if (input.expenseRatioPpm !== null && (!Number.isInteger(input.expenseRatioPpm) || input.expenseRatioPpm < 0 || input.expenseRatioPpm > 1_000_000)) {
      throw new PlanError(400, "validation", "expenseRatioPpm must be between 0 and 1000000");
    }
    return input.expenseRatioPpm;
  }
  if (input.expenseRatioPercent !== undefined) {
    if (input.expenseRatioPercent === null) return null;
    try {
      const ppm = percentToPpm(input.expenseRatioPercent);
      if (ppm < 0 || ppm > 1_000_000) throw new Error("range");
      return ppm;
    } catch {
      throw new PlanError(400, "validation", `Expense ratio "${sanitizeText(input.expenseRatioPercent, 20)}" is not a whole number of ppm`);
    }
  }
  return undefined;
}

function tickerOf(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const text = sanitizeText(raw, 50);
  if (!text) return null;
  const ticker = normalizeTicker(text);
  if (!ticker) throw new PlanError(400, "validation", `"${text}" is not a ticker (letters, digits, . - / up to 12 characters)`);
  return ticker;
}

function cusipOf(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || !sanitizeText(raw, 50)) return null;
  const v = normalizeCusip(raw);
  if (!v) throw new PlanError(400, "validation", "A CUSIP is 9 characters");
  return v;
}

function isinOf(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || !sanitizeText(raw, 50)) return null;
  const v = normalizeIsin(raw);
  if (!v) throw new PlanError(400, "validation", "An ISIN is 12 characters");
  return v;
}

function providerSymbolOf(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = sanitizeText(raw, 32);
  return s || null;
}

async function assertIdentifiersFree(tx: DbOrTx, ids: { ticker: string | null; cusip: string | null; isin: string | null }, exceptId?: string): Promise<void> {
  const checks: Array<[PgColumn, string | null, string, string]> = [
    [security.ticker, ids.ticker, "duplicate_ticker", "ticker"],
    [security.cusip, ids.cusip, "duplicate_cusip", "CUSIP"],
    [security.isin, ids.isin, "duplicate_isin", "ISIN"],
  ];
  for (const [column, value, code, label] of checks) {
    if (value === null) continue;
    const [taken] = await tx
      .select({ id: security.id })
      .from(security)
      .where(and(eq(column, value), exceptId ? ne(security.id, exceptId) : undefined));
    if (taken) throw new PlanError(409, code, `A security with ${label} ${value} already exists`);
  }
}

/**
 * The owner's create (also the positions editor's "create" choice). Never a cash row
 * (400 `cash_security_reserved`); `provider` mode needs a ticker (400 `ticker_required`);
 * duplicate identifiers → 409 `duplicate_ticker` / `duplicate_cusip` / `duplicate_isin`.
 * Audited as a `security` create. Takes `DbOrTx` so an importer can create inside its transaction.
 */
export async function createSecurity(tx: DbOrTx, input: CreateSecurityInput, ctx: AuditContext, opts: { needsReview?: boolean } = {}): Promise<SecurityRecord> {
  if (input.type === "cash") throw new PlanError(400, "cash_security_reserved", "The cash security is created automatically per currency");
  const name = sanitizeText(input.name, 200);
  if (!name) throw new PlanError(400, "validation", "Name is required");
  const ticker = tickerOf(input.ticker);
  const cusip = cusipOf(input.cusip);
  const isin = isinOf(input.isin);
  const hints = { type: input.type, assetClass: input.assetClass };
  const priceMode = input.priceMode ?? defaultPriceMode(ticker, hints);
  if (priceMode === "provider" && ticker === null) throw new PlanError(400, "ticker_required", "A security priced by the provider needs a ticker");
  const expenseRatioPpm = expenseRatioOf(input) ?? null;
  await assertIdentifiersFree(tx, { ticker, cusip, isin });
  const [row] = await tx
    .insert(security)
    .values({
      ticker,
      name,
      type: input.type,
      assetClass: input.assetClass,
      expenseRatioPpm,
      cusip,
      isin,
      currency: normalizeCurrency(input.currency),
      priceMode,
      providerSymbol: providerSymbolOf(input.providerSymbol),
      alwaysPrice: input.alwaysPrice ?? false,
      needsReview: opts.needsReview ?? false,
      notes: input.notes === undefined ? null : input.notes === null ? null : sanitizeText(input.notes, 2000) || null,
    })
    .returning();
  await writeAudit(tx, { ...ctx, entity: "security", entityId: row!.id, action: "create", before: null, after: securityAuditJson(row!) });
  return (await getSecurity(tx, row!.id))!;
}

interface PricingPatchResult {
  set: Partial<typeof security.$inferInsert>;
  /** The fetch state was reset: a backfill should be queued. */
  backfill: boolean;
}

/**
 * The pricing side of a patch (seams C39): `provider` needs a ticker (400 `ticker_required`);
 * switching to `provider`, or changing the symbol the feed uses, resets the fetch state so
 * the next run backfills from the first needed date.
 */
function applyPricingPatch(existing: SecurityRow, patch: SecurityPricingPatch, nextTicker: string | null): PricingPatchResult {
  const set: Partial<typeof security.$inferInsert> = {};
  const nextMode = patch.priceMode ?? existing.priceMode;
  if (nextMode === "provider" && nextTicker === null) throw new PlanError(400, "ticker_required", "A security priced by the provider needs a ticker");
  if (patch.priceMode !== undefined && patch.priceMode !== existing.priceMode) set.priceMode = patch.priceMode;
  let nextSymbol = existing.providerSymbol;
  if (patch.providerSymbol !== undefined) {
    nextSymbol = providerSymbolOf(patch.providerSymbol);
    if (nextSymbol !== existing.providerSymbol) set.providerSymbol = nextSymbol;
  }
  if (patch.alwaysPrice !== undefined && patch.alwaysPrice !== existing.alwaysPrice) set.alwaysPrice = patch.alwaysPrice;
  const feedSymbolBefore = existing.providerSymbol ?? existing.ticker;
  const feedSymbolAfter = nextSymbol ?? nextTicker;
  const backfill = nextMode === "provider" && (existing.priceMode !== "provider" || feedSymbolBefore !== feedSymbolAfter);
  if (backfill) {
    set.priceFetchStatus = null;
    set.priceFetchMessage = null;
    set.priceFetchFailures = 0;
    set.priceNextAttemptAt = null;
    set.priceBackfilledFrom = null;
  }
  return { set, backfill };
}

async function queueBackfill(tx: DbOrTx, securityId: string, opts: SecurityMutationOptions): Promise<string | null> {
  if (opts.queueBackfill === false) return null;
  const job = await requestPriceRefresh(tx, { reason: "refill", securityIds: [securityId], ...(opts.now ? { now: opts.now } : {}) });
  return job.jobId;
}

/**
 * The owner's PATCH: identity, classification, notes, flags and the pricing fields
 * (through the same rules as `updateSecurityPricing`). Saving clears `needsReview` unless the
 * patch sets it. The cash security accepts only name, notes, review and archive changes
 * (400 `cash_security_reserved`); a class not among the security's splits is refused
 * (400 `split_primary`, seams C46). Audited as a `security` update.
 */
export async function updateSecurity(db: Db, id: string, patch: UpdateSecurityInput, ctx: AuditContext, opts: SecurityMutationOptions = {}): Promise<SecurityMutationResult> {
  let backfillJobId: string | null = null;
  await db.transaction(async (tx) => {
    const existing = await requireSecurity(tx, id);
    const aliases = (await loadAliases(tx, [id])).get(id) ?? [];
    if (patch.type === "cash") throw new PlanError(400, "cash_security_reserved", "A security cannot become the cash security");
    if (existing.type === "cash") {
      const reserved: Array<keyof UpdateSecurityInput> = ["ticker", "type", "assetClass", "cusip", "isin", "priceMode", "providerSymbol", "alwaysPrice", "expenseRatioPpm", "expenseRatioPercent", "currency"];
      if (reserved.some((k) => patch[k] !== undefined)) throw new PlanError(400, "cash_security_reserved", "The cash security's identity and pricing are fixed");
    }
    const set: Partial<typeof security.$inferInsert> = {};
    if (patch.name !== undefined) {
      const name = sanitizeText(patch.name, 200);
      if (!name) throw new PlanError(400, "validation", "Name is required");
      if (name !== existing.name) set.name = name;
    }
    const nextTicker = patch.ticker !== undefined ? tickerOf(patch.ticker) : existing.ticker;
    if (patch.ticker !== undefined && nextTicker !== existing.ticker) set.ticker = nextTicker;
    if (patch.type !== undefined && patch.type !== existing.type) set.type = patch.type;
    if (patch.assetClass !== undefined && patch.assetClass !== existing.assetClass) {
      const splits = await tx.select({ assetClass: securityAllocation.assetClass }).from(securityAllocation).where(eq(securityAllocation.securityId, id));
      if (splits.length > 0 && !splits.some((s) => s.assetClass === patch.assetClass)) {
        throw new PlanError(400, "split_primary", `The primary class must be one of the security's splits (${splits.map((s) => s.assetClass).join(", ")})`);
      }
      set.assetClass = patch.assetClass;
    }
    const expense = expenseRatioOf(patch);
    if (expense !== undefined && expense !== existing.expenseRatioPpm) set.expenseRatioPpm = expense;
    if (patch.cusip !== undefined) {
      const v = cusipOf(patch.cusip);
      if (v !== existing.cusip) set.cusip = v;
    }
    if (patch.isin !== undefined) {
      const v = isinOf(patch.isin);
      if (v !== existing.isin) set.isin = v;
    }
    if (patch.currency !== undefined) {
      const v = normalizeCurrency(patch.currency);
      if (v !== existing.currency) set.currency = v;
    }
    if (patch.notes !== undefined) {
      const v = patch.notes === null ? null : sanitizeText(patch.notes, 2000) || null;
      if (v !== existing.notes) set.notes = v;
    }
    if (patch.archived !== undefined && patch.archived !== existing.archived) set.archived = patch.archived;
    const needsReview = patch.needsReview ?? false;
    if (needsReview !== existing.needsReview) set.needsReview = needsReview;
    const nextMode = patch.priceMode ?? existing.priceMode;
    if (nextMode === "provider" && nextTicker === null && existing.type !== "cash") {
      throw new PlanError(400, "ticker_required", "A security priced by the provider needs a ticker");
    }
    const pricing = existing.type === "cash" ? { set: {}, backfill: false } : applyPricingPatch(existing, patch, nextTicker);
    Object.assign(set, pricing.set);
    if (Object.keys(set).length === 0) return;
    await assertIdentifiersFree(tx, { ticker: set.ticker === undefined ? null : nextTicker, cusip: set.cusip ?? null, isin: set.isin ?? null }, id);
    const [after] = await tx
      .update(security)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(security.id, id))
      .returning();
    await writeAudit(tx, { ...ctx, entity: "security", entityId: id, action: "update", before: securityAuditJson(existing, aliases), after: securityAuditJson(after!, aliases) });
    if (pricing.backfill) backfillJobId = await queueBackfill(tx, id, opts);
  });
  return { security: (await getSecurity(db, id))!, backfillJobId };
}

/** The pricing fields alone (`priceMode`, `providerSymbol`, `alwaysPrice`): the rules of `applyPricingPatch`, audited as a `security` update. */
export async function updateSecurityPricing(db: Db, id: string, patch: SecurityPricingPatch, ctx: AuditContext, opts: SecurityMutationOptions = {}): Promise<SecurityMutationResult> {
  let backfillJobId: string | null = null;
  await db.transaction(async (tx) => {
    const existing = await requireSecurity(tx, id);
    if (existing.type === "cash") throw new PlanError(400, "cash_security_reserved", "The cash security is valued at 1 and never priced");
    const aliases = (await loadAliases(tx, [id])).get(id) ?? [];
    const pricing = applyPricingPatch(existing, patch, existing.ticker);
    if (Object.keys(pricing.set).length === 0) return;
    const [after] = await tx
      .update(security)
      .set({ ...pricing.set, updatedAt: new Date() })
      .where(eq(security.id, id))
      .returning();
    await writeAudit(tx, { ...ctx, entity: "security", entityId: id, action: "update", before: securityAuditJson(existing, aliases), after: securityAuditJson(after!, aliases) });
    if (pricing.backfill) backfillJobId = await queueBackfill(tx, id, opts);
  });
  return { security: (await getSecurity(db, id))!, backfillJobId };
}

// ---- Delete / merge ----

/** Rows that keep a security alive; the owner merges or archives a referenced one. */
export async function securityReferences(db: DbOrTx, id: string): Promise<{ snapshots: number; txns: number; lots: number; prices: number }> {
  const count = async (q: Promise<Array<{ n: number }>>) => (await q)[0]?.n ?? 0;
  const [snapshots, txns, lots, prices] = await Promise.all([
    count(db.select({ n: sql<number>`count(*)::int` }).from(holdingSnapshot).where(eq(holdingSnapshot.securityId, id))),
    count(db.select({ n: sql<number>`count(*)::int` }).from(investmentTxn).where(eq(investmentTxn.securityId, id))),
    count(db.select({ n: sql<number>`count(*)::int` }).from(lot).where(eq(lot.securityId, id))),
    count(db.select({ n: sql<number>`count(*)::int` }).from(price).where(eq(price.securityId, id))),
  ]);
  return { snapshots, txns, lots, prices };
}

/** Delete an unreferenced security (409 `security_in_use` otherwise; the cash security never). Audited. */
export async function deleteSecurity(db: Db, id: string, ctx: AuditContext): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await requireSecurity(tx, id);
    if (existing.type === "cash") throw new PlanError(400, "cash_security_reserved", "The cash security cannot be deleted");
    const refs = await securityReferences(tx, id);
    const used = Object.entries(refs)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`);
    if (used.length > 0) throw new PlanError(409, "security_in_use", `Security is referenced by ${used.join(", ")}; merge or archive it instead`);
    const aliases = (await loadAliases(tx, [id])).get(id) ?? [];
    await tx.delete(security).where(eq(security.id, id));
    await writeAudit(tx, { ...ctx, entity: "security", entityId: id, action: "delete", before: securityAuditJson(existing, aliases), after: null });
  });
}

export interface MergeSecuritiesOptions {
  /** Step 7's `rebuildLots(tx, accountId)`; called for every account whose trades moved (out-leg order is the caller's concern). */
  rebuildLots?: (tx: DbOrTx, accountId: string) => Promise<unknown>;
}

export interface MergeSecuritiesResult {
  security: SecurityRecord;
  snapshotsMerged: number;
  snapshotsRepointed: number;
  pricesRepointed: number;
  pricesDropped: number;
  txnsRepointed: number;
  lotsRepointed: number;
  accountsRebuilt: string[];
}

/**
 * Merge `loserId` into `survivorId` (§3.2): snapshot rows combine per (account, date), prices
 * keep the higher rank per date, trades and lots repoint (then the lots cache is rebuilt per
 * touched account through `opts.rebuildLots`), the loser's identifiers become aliases, the
 * benchmark setting follows, the loser is deleted. One transaction; audited as a `security`
 * update on the survivor and a `security` delete on the loser.
 */
export async function mergeSecurities(db: Db, survivorId: string, loserId: string, ctx: AuditContext, opts: MergeSecuritiesOptions = {}): Promise<MergeSecuritiesResult> {
  if (survivorId === loserId) throw new PlanError(400, "merge_self", "A security cannot be merged into itself");
  const result = await db.transaction(async (tx) => {
    const survivor = await requireSecurity(tx, survivorId);
    const loser = await requireSecurity(tx, loserId);
    if (survivor.type === "cash" || loser.type === "cash") throw new PlanError(400, "cash_security_reserved", "The cash security cannot be merged");
    const survivorAliasesBefore = (await loadAliases(tx, [survivorId])).get(survivorId) ?? [];
    const loserAliases = (await loadAliases(tx, [loserId])).get(loserId) ?? [];

    // 2. holding_snapshot
    let snapshotsMerged = 0;
    let snapshotsRepointed = 0;
    const loserRows = await tx.select().from(holdingSnapshot).where(eq(holdingSnapshot.securityId, loserId));
    for (const lr of loserRows) {
      const [sr] = await tx
        .select()
        .from(holdingSnapshot)
        .where(and(eq(holdingSnapshot.securityId, survivorId), eq(holdingSnapshot.accountId, lr.accountId), eq(holdingSnapshot.date, lr.date)));
      if (sr) {
        const lq = lr.quantity === null ? null : fixed8FromDb(lr.quantity);
        const sq = sr.quantity === null ? null : fixed8FromDb(sr.quantity);
        const quantity = lq !== null && sq !== null ? lq + sq : null;
        const valueCents = sr.valueCents + lr.valueCents;
        const reportedCostBasisCents = sr.reportedCostBasisCents !== null && lr.reportedCostBasisCents !== null ? sr.reportedCostBasisCents + lr.reportedCostBasisCents : null;
        const priceValue = quantity !== null && quantity !== 0n ? impliedPrice(valueCents, quantity) : null;
        const source = HOLDING_SOURCE_RANK[lr.source] > HOLDING_SOURCE_RANK[sr.source] ? lr.source : sr.source;
        await tx
          .update(holdingSnapshot)
          .set({ quantity: quantity === null ? null : fixed8ToDb(quantity), price: priceValue === null ? null : fixed8ToDb(priceValue), valueCents, reportedCostBasisCents, source, updatedAt: new Date() })
          .where(eq(holdingSnapshot.id, sr.id));
        await tx.delete(holdingSnapshot).where(eq(holdingSnapshot.id, lr.id));
        snapshotsMerged++;
      } else {
        await tx.update(holdingSnapshot).set({ securityId: survivorId, updatedAt: new Date() }).where(eq(holdingSnapshot.id, lr.id));
        snapshotsRepointed++;
      }
    }

    // 3. price
    let pricesRepointed = 0;
    let pricesDropped = 0;
    const survivorPrices = new Map((await tx.select({ id: price.id, date: price.date, source: price.source }).from(price).where(eq(price.securityId, survivorId))).map((p) => [p.date, p]));
    const loserPrices = await tx.select({ id: price.id, date: price.date, source: price.source }).from(price).where(eq(price.securityId, loserId));
    for (const lp of loserPrices) {
      const sp = survivorPrices.get(lp.date);
      if (!sp) {
        await tx.update(price).set({ securityId: survivorId }).where(eq(price.id, lp.id));
        pricesRepointed++;
      } else if (PRICE_SOURCE_RANK[lp.source] > PRICE_SOURCE_RANK[sp.source]) {
        await tx.delete(price).where(eq(price.id, sp.id));
        await tx.update(price).set({ securityId: survivorId }).where(eq(price.id, lp.id));
        pricesRepointed++;
        pricesDropped++;
      } else {
        await tx.delete(price).where(eq(price.id, lp.id));
        pricesDropped++;
      }
    }

    // 4. investment_txn, lot, lot_disposal; then the lots cache per touched account
    const movedTxns = await tx.update(investmentTxn).set({ securityId: survivorId, updatedAt: new Date() }).where(eq(investmentTxn.securityId, loserId)).returning({ accountId: investmentTxn.accountId });
    const movedLots = await tx.update(lot).set({ securityId: survivorId }).where(eq(lot.securityId, loserId)).returning({ accountId: lot.accountId });
    await tx.update(lotDisposal).set({ securityId: survivorId }).where(eq(lotDisposal.securityId, loserId));
    const accountsRebuilt = [...new Set([...movedTxns, ...movedLots].map((r) => r.accountId))].sort();
    if (opts.rebuildLots) for (const accountId of accountsRebuilt) await opts.rebuildLots(tx, accountId);

    // 5. aliases: the loser's rows and its own identifiers
    await tx.update(securityAlias).set({ securityId: survivorId }).where(eq(securityAlias.securityId, loserId));
    const learned: Array<[SecurityAliasKind, string | null]> = [
      ["ticker", loser.ticker],
      ["cusip", loser.cusip],
      ["isin", loser.isin],
      ["name", normalizeName(loser.name) || null],
    ];
    for (const [kind, value] of learned) {
      if (value === null) continue;
      const own = kind === "ticker" ? survivor.ticker : kind === "cusip" ? survivor.cusip : kind === "isin" ? survivor.isin : normalizeName(survivor.name);
      if (own === value) continue;
      await tx.insert(securityAlias).values({ securityId: survivorId, kind, value }).onConflictDoNothing();
    }

    // 6. the benchmark setting, then the loser
    await tx.update(householdSetting).set({ benchmarkSecurityId: survivorId }).where(eq(householdSetting.benchmarkSecurityId, loserId));
    await tx.delete(security).where(eq(security.id, loserId));
    await tx.update(security).set({ updatedAt: new Date() }).where(eq(security.id, survivorId));

    const survivorAliasesAfter = (await loadAliases(tx, [survivorId])).get(survivorId) ?? [];
    const [survivorAfter] = await tx.select().from(security).where(eq(security.id, survivorId));
    await writeAudit(tx, { ...ctx, entity: "security", entityId: survivorId, action: "update", before: securityAuditJson(survivor, survivorAliasesBefore), after: securityAuditJson(survivorAfter!, survivorAliasesAfter) });
    await writeAudit(tx, { ...ctx, entity: "security", entityId: loserId, action: "delete", before: securityAuditJson(loser, loserAliases), after: null });
    return { snapshotsMerged, snapshotsRepointed, pricesRepointed, pricesDropped, txnsRepointed: movedTxns.length, lotsRepointed: movedLots.length, accountsRebuilt };
  });
  return { security: (await getSecurity(db, survivorId))!, ...result };
}

// ---- Manual price ----

/**
 * The owner's close for a date (`PUT /api/prices/:securityId/:date`): the top of the price
 * precedence, so neither the feed nor an implied rebuild replaces it. Never for the cash
 * security (400 `cash_security_reserved`); `date ≤ today` when a `today` is given (400
 * `future_date`). Audited as a `security` update carrying `{ price: { date, close, source } }`.
 */
export async function setManualPrice(db: Db, securityId: string, input: { date: IsoDate; close: Fixed8 }, ctx: AuditContext & { today?: IsoDate }): Promise<PriceRecord> {
  if (!isIsoDate(input.date)) throw new PlanError(400, "validation", "date must be YYYY-MM-DD");
  if (ctx.today !== undefined && input.date > ctx.today) throw new PlanError(400, "future_date", `${input.date} is after today`);
  if (input.close < 0n) throw new PlanError(400, "validation", "close must not be negative");
  await db.transaction(async (tx) => {
    const row = await requireSecurity(tx, securityId);
    if (row.type === "cash") throw new PlanError(400, "cash_security_reserved", "The cash security is valued at 1 and never priced");
    const existing = await getPrice(tx, securityId, input.date);
    await upsertPrices(tx, [{ securityId, date: input.date, close: input.close, source: "manual" }]);
    await writeAudit(tx, {
      ...ctx,
      entity: "security",
      entityId: securityId,
      action: "update",
      before: { price: { date: input.date, close: existing ? fixed8ToDb(existing.close) : null, source: existing?.source ?? null } },
      after: { price: { date: input.date, close: fixed8ToDb(input.close), source: "manual" } },
    });
  });
  return (await getPrice(db, securityId, input.date))!;
}

/** Securities a reconcile or a view may show "as of": every non-archived row, cheap enough for a household. */
export async function listSecurityRows(db: DbOrTx, where?: { ids?: readonly string[]; includeArchived?: boolean }): Promise<SecurityRow[]> {
  return db
    .select()
    .from(security)
    .where(and(where?.includeArchived ? undefined : eq(security.archived, false), where?.ids ? inArray(security.id, [...where.ids]) : undefined))
    .orderBy(asc(security.ticker), asc(security.name), asc(security.id));
}
