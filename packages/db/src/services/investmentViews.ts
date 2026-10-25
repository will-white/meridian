import { and, count, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import {
  addDays,
  addMonthsClamped,
  dayChange,
  dayDiff,
  MAX_SERIES_DAYS,
  mulToCents,
  periodChange,
  quantityForCents,
  TaxTreatment as TaxTreatmentEnum,
  truncDiv,
  valueAccountOn,
  type AccountType,
  type AccountValuation,
  type AccountWarningKind,
  type AssetClass,
  type ConcentrationLevel,
  type CostCoverage,
  type ExternalFlowInput,
  type Fixed8,
  type HoldingPriceSource,
  type HoldingSource,
  type InvestmentFidelity,
  type InvestmentIncomeFeed,
  type InvestmentPeriod,
  type IsoDate,
  type LineKind,
  type PortfolioDayChange,
  type PriceProviderId,
  type PriceStatus,
  type RebalanceAction,
  type SecurityType,
  type TaxTreatment,
  type ValuationBasis,
  type ValuationSource,
  type ValueSource,
} from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { account, balanceSnapshot, holdingSnapshot, householdSetting, security } from "../schema/index.js";
import { accountFidelities, type AccountFidelityRecord } from "./accountFidelity.js";
import { getAllocationTargets, type AllocationTargetRecord } from "./allocationTargets.js";
import { PlanError } from "./audit.js";
import { HOLDING_SOURCE_RANK } from "./securities.js";
import { defaultAsOf, loadIncomeRows, periodBounds, type IncomeRowRecord, type PeriodBounds } from "./investmentIncome.js";
import { computeHoldings, type HoldingResult } from "./lots.js";
import { loadExternalFlows } from "./performance.js";
import { priceFeedHealth } from "./prices.js";
import { accountsAwaitingReconcile } from "./reconcile.js";
import { ASSET_CLASS_ORDER, assetClassRank, loadSecuritySplits, type SecuritySplitRecord } from "./securityAllocation.js";
import {
  earliestDataDate,
  firstDataDates,
  incomeInWindow,
  listInvestmentAccounts,
  loadValuationInput,
  uncategorizedRowsInWindow,
  valuationSeries,
  type InvestmentAccountRecord,
  type LoadedValuationInput,
} from "./valuation.js";

/**
 * The investment views (plan decisions 8, 12, 16; views design §3; seams C19–C24, C42, C47):
 * one `investmentContext` runs the valuation chain for the selected accounts on `asOf` and
 * every view is a pure function of it. Quantities and values come from the chain's lines (lots
 * or statement per account, decided there); cost basis and lot counts from the lot engine's
 * `computeHoldings`; class splits from `security_allocation`; targets from `allocation_target`.
 * Everything here is read-only; the API mappers stringify the records.
 */

// ---- Pure helpers (views design §3.1) ----

/** Basis points of `part` in `total`, truncated toward zero; null without a positive total. */
export function bp(part: bigint, total: bigint): number | null {
  return total <= 0n ? null : Number(truncDiv(part * 10000n, total));
}

export interface PpmRow {
  valueCents: bigint;
  ppm: number | null;
  type: SecurityType;
}

/** Types whose unknown expense ratio counts as 0 (no ongoing fee); funds with an unknown ratio are excluded. */
const ZERO_RATIO_TYPES: ReadonlySet<SecurityType> = new Set(["stock", "bond", "cash", "cd"]);

/**
 * Value-weighted expense ratio in ppm over the covered rows: a null ratio counts as 0 for
 * `stock | bond | cash | cd` and as unknown (excluded) for `etf | fund | other`.
 */
export function ppmWeighted(rows: readonly PpmRow[]): { ppm: number | null; coveredCents: bigint; totalCents: bigint; annualCostCents: bigint } {
  let num = 0n;
  let covered = 0n;
  let total = 0n;
  for (const r of rows) {
    total += r.valueCents;
    const ppm = r.ppm ?? (ZERO_RATIO_TYPES.has(r.type) ? 0 : null);
    if (ppm === null) continue;
    covered += r.valueCents;
    num += r.valueCents * BigInt(ppm);
  }
  return {
    ppm: covered > 0n ? Number(truncDiv(num, covered)) : null,
    coveredCents: covered,
    totalCents: total,
    annualCostCents: truncDiv(num, 1_000_000n),
  };
}

/** A line's value across its classes: `truncDiv(value × weight, 10000)` per split, the remainder on the primary class. */
export function splitValue(valueCents: bigint, splits: readonly SecuritySplitRecord[], primary: AssetClass): Map<AssetClass, bigint> {
  const out = new Map<AssetClass, bigint>();
  if (splits.length === 0) {
    out.set(primary, valueCents);
    return out;
  }
  let allocated = 0n;
  for (const s of splits) {
    const cents = truncDiv(valueCents * BigInt(s.weightBp), 10000n);
    out.set(s.assetClass, (out.get(s.assetClass) ?? 0n) + cents);
    allocated += cents;
  }
  out.set(primary, (out.get(primary) ?? 0n) + (valueCents - allocated));
  return out;
}

const TAX_TREATMENTS: readonly TaxTreatment[] = TaxTreatmentEnum.options;

const CLASS_LABEL: Record<AssetClass, string> = {
  us_stock: "US stock",
  intl_stock: "international stock",
  bonds: "bond",
  cash: "cash",
  real_estate: "real estate",
  other: "other",
};

/** `MM/DD/YY`. */
export function shortDate(date: IsoDate): string {
  return `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(2, 4)}`;
}

/** `$50,000.00`; negatives as `-$1.00`. */
export function formatDollars(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = (abs / 100n).toLocaleString("en-US");
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${whole}.${frac}`;
}

/** Basis points as a percentage with one decimal ("59.7%"). */
export function formatBp(value: number): string {
  const tenths = Math.round(value / 10);
  const sign = tenths < 0 ? "-" : "";
  const abs = Math.abs(tenths);
  return `${sign}${Math.trunc(abs / 10)}.${abs % 10}%`;
}

const POSITIONS_STALE_DAYS = 35;
const VALUATION_STALE_DAYS = 7;

// ---- Context ----

export interface AccountRefRecord {
  accountId: string;
  accountName: string;
  type: AccountType;
  taxTreatment: TaxTreatment;
  fidelity: InvestmentFidelity;
  fidelityNote: string | null;
}

export interface ValuationRefRecord {
  valuationDate: IsoDate | null;
  valuationSource: ValuationSource | null;
  basis: ValuationBasis;
  valuationStale: boolean;
  positionsDate: IsoDate | null;
  positionsStale: boolean;
}

export interface AccountWarningRecord {
  accountId: string;
  accountName: string;
  kind: AccountWarningKind;
  message: string;
}

/** One valued line of the chain with its account (the unit every view classifies). */
export interface ViewLine {
  accountId: string;
  accountName: string;
  securityId: string | null;
  ticker: string | null;
  name: string;
  kind: LineKind;
  quantity: Fixed8 | null;
  price: Fixed8 | null;
  priceDate: IsoDate | null;
  priceSource: HoldingPriceSource | null;
  priceStatus: PriceStatus;
  valueCents: bigint;
  valueSource: ValueSource;
  /** A position that reports a value but no share count. */
  dollarOnly: boolean;
}

export interface SecurityMeta {
  id: string;
  ticker: string | null;
  name: string;
  type: SecurityType;
  assetClass: AssetClass;
  expenseRatioPpm: number | null;
  needsReview: boolean;
  splits: SecuritySplitRecord[];
}

export interface ContextAccount extends InvestmentAccountRecord {
  fidelityRecord: AccountFidelityRecord | undefined;
  valuation: AccountValuation;
  ref: AccountRefRecord;
  valuationRef: ValuationRefRecord;
  /** The chain valued positions (snapshot, lots or positions basis): classified by the allocation. */
  classified: boolean;
  lines: ViewLine[];
  warnings: AccountWarningRecord[];
  /** The latest snapshot set on or before `asOf`. */
  snapshot: { date: IsoDate; source: HoldingSource } | null;
}

export interface InvestmentContext {
  today: IsoDate;
  now: Date;
  asOf: IsoDate;
  expectedDate: IsoDate;
  accounts: ContextAccount[];
  fidelities: Map<string, AccountFidelityRecord>;
  input: LoadedValuationInput;
  securities: Map<string, SecurityMeta>;
  /** `computeHoldings` rows by `${accountId}|${securityId}` for accounts with trades. */
  engineHoldings: Map<string, HoldingResult>;
  targets: AllocationTargetRecord[];
  setting: { rebalanceBandBp: number; rebalanceMinTradeCents: bigint; benchmarkSecurityId: string | null; investmentIncomeCategoryId: string | null };
  cashSecurityId: string | null;
  /** The latest snapshot set's `reported_cost_basis_cents` by `${accountId}|${securityId}`. */
  reportedBasis: Map<string, bigint>;
}

export interface InvestmentContextQuery {
  today: IsoDate;
  now: Date;
  /** Default: the latest close the feed can have, never after today. */
  asOf?: IsoDate;
  accountIds?: readonly string[];
  includeClosed?: boolean;
  /** Widen the chain's window back to this date (period changes and series read the same input). */
  from?: IsoDate;
}

function key(accountId: string, securityId: string): string {
  return `${accountId}|${securityId}`;
}

function lineKey(line: Pick<ViewLine, "accountId" | "securityId">): string {
  return key(line.accountId, line.securityId ?? "");
}

function accountRef(a: InvestmentAccountRecord, f: AccountFidelityRecord | undefined): AccountRefRecord {
  return { accountId: a.id, accountName: a.name, type: a.type, taxTreatment: a.taxTreatment, fidelity: f?.fidelity ?? "balance_only", fidelityNote: f?.fidelityNote ?? null };
}

/**
 * One round of queries for everything the views share (views design §3.2): the accounts with
 * their derived fidelity, the chain's valuation per account on `asOf`, the securities the lines
 * reference with their splits, the lot engine's holdings for accounts with trades, the latest
 * snapshot set and reported balance per account, the targets and the household settings.
 */
export async function investmentContext(db: DbOrTx, q: InvestmentContextQuery): Promise<InvestmentContext> {
  const asOf = q.asOf ?? defaultAsOf(q.today, q.now);
  if (asOf > q.today) throw new PlanError(400, "validation", `asOf ${asOf} is after today ${q.today}`);
  const accounts = await listInvestmentAccounts(db, { ...(q.accountIds ? { accountIds: q.accountIds } : {}), ...(q.includeClosed ? { includeClosed: true } : {}) });
  const ids = accounts.map((a) => a.id);
  const fidelities = await accountFidelities(db, ids);
  const from = q.from !== undefined && q.from < asOf ? q.from : asOf;
  const input = await loadValuationInput(db, { accountIds: ids, from, to: asOf, now: q.now, fidelities });
  const valuations = new Map(ids.map((id) => [id, valueAccountOn(input, id, asOf)]));

  // The latest snapshot set on or before asOf (its date, highest-ranked source and reported cost basis) per account.
  const snapshots = new Map<string, { date: IsoDate; source: HoldingSource }>();
  const reportedBasis = new Map<string, bigint>();
  if (ids.length > 0) {
    const latest = db
      .select({ accountId: holdingSnapshot.accountId, date: sql<string>`max(${holdingSnapshot.date})`.as("latest_date") })
      .from(holdingSnapshot)
      .where(and(inArray(holdingSnapshot.accountId, ids), lte(holdingSnapshot.date, asOf)))
      .groupBy(holdingSnapshot.accountId)
      .as("latest");
    const rows = await db
      .select({
        accountId: holdingSnapshot.accountId,
        securityId: holdingSnapshot.securityId,
        date: holdingSnapshot.date,
        source: holdingSnapshot.source,
        reportedCostBasisCents: holdingSnapshot.reportedCostBasisCents,
      })
      .from(holdingSnapshot)
      .innerJoin(latest, and(eq(latest.accountId, holdingSnapshot.accountId), eq(latest.date, holdingSnapshot.date)));
    for (const r of rows) {
      const prev = snapshots.get(r.accountId);
      if (!prev || HOLDING_SOURCE_RANK[r.source] > HOLDING_SOURCE_RANK[prev.source]) snapshots.set(r.accountId, { date: r.date, source: r.source });
      if (r.reportedCostBasisCents !== null) reportedBasis.set(key(r.accountId, r.securityId), r.reportedCostBasisCents);
    }
  }
  // The latest reported balance on or before asOf (the balance basis' row).
  const reported = new Map<string, { date: IsoDate; source: ValuationSource }>();
  if (ids.length > 0) {
    const rows = await db
      .selectDistinctOn([balanceSnapshot.accountId], { accountId: balanceSnapshot.accountId, date: balanceSnapshot.date, source: balanceSnapshot.source })
      .from(balanceSnapshot)
      .where(and(inArray(balanceSnapshot.accountId, ids), ne(balanceSnapshot.source, "computed"), lte(balanceSnapshot.date, asOf)))
      .orderBy(balanceSnapshot.accountId, desc(balanceSnapshot.date));
    for (const r of rows) reported.set(r.accountId, { date: r.date, source: r.source });
  }

  // Securities the lines reference, plus the cash security, with their splits.
  const [cash] = await db
    .select({ id: security.id })
    .from(security)
    .where(and(eq(security.type, "cash"), eq(security.currency, "USD")))
    .limit(1);
  const securityIds = new Set<string>();
  for (const v of valuations.values()) for (const l of v.lines) if (l.securityId !== null) securityIds.add(l.securityId);
  if (cash) securityIds.add(cash.id);
  const securities = new Map<string, SecurityMeta>();
  if (securityIds.size > 0) {
    const rows = await db
      .select({
        id: security.id,
        ticker: security.ticker,
        name: security.name,
        type: security.type,
        assetClass: security.assetClass,
        expenseRatioPpm: security.expenseRatioPpm,
        needsReview: security.needsReview,
      })
      .from(security)
      .where(inArray(security.id, [...securityIds]));
    const splits = await loadSecuritySplits(db, [...securityIds]);
    for (const r of rows) securities.set(r.id, { ...r, splits: splits.get(r.id) ?? [] });
  }

  // The lot engine's holdings for accounts with trades (cost basis, lot counts).
  const withTrades = ids.filter((id) => fidelities.get(id)?.lastTradeDate !== null && fidelities.get(id)?.lastTradeDate !== undefined);
  const engineHoldings = new Map<string, HoldingResult>();
  if (withTrades.length > 0) {
    const computed = await computeHoldings(db, { accountIds: withTrades, asOf });
    for (const h of computed.rows) engineHoldings.set(key(h.accountId, h.securityId), h);
  }

  const targets = (await getAllocationTargets(db)).targets;
  const [settingRow] = await db
    .select({
      rebalanceBandBp: householdSetting.rebalanceBandBp,
      rebalanceMinTradeCents: householdSetting.rebalanceMinTradeCents,
      benchmarkSecurityId: householdSetting.benchmarkSecurityId,
      investmentIncomeCategoryId: householdSetting.investmentIncomeCategoryId,
    })
    .from(householdSetting)
    .where(eq(householdSetting.id, 1));
  const setting = settingRow ?? { rebalanceBandBp: 500, rebalanceMinTradeCents: 10000n, benchmarkSecurityId: null, investmentIncomeCategoryId: null };

  const contextAccounts: ContextAccount[] = accounts.map((a) => {
    const f = fidelities.get(a.id);
    const v = valuations.get(a.id)!;
    const snapshot = snapshots.get(a.id) ?? null;
    const classified = v.basis === "snapshot" || v.basis === "lots" || v.basis === "positions";
    const lines: ViewLine[] = v.lines
      .filter((l) => l.valueCents !== null)
      .map((l) => ({
        accountId: a.id,
        accountName: a.name,
        securityId: l.securityId,
        ticker: l.ticker,
        name: l.name,
        kind: l.kind,
        quantity: l.quantity,
        price: l.price,
        priceDate: l.priceDate,
        priceSource: l.priceSource,
        priceStatus: l.priceStatus,
        valueCents: l.valueCents!,
        valueSource: l.valueSource,
        dollarOnly: l.kind === "position" && l.quantity === null,
      }));
    let valuationDate: IsoDate | null = null;
    let valuationSource: ValuationSource | null = null;
    if (classified && v.valueCents !== null) {
      valuationDate = v.date;
      valuationSource = v.basis === "snapshot" ? (snapshot?.source ?? null) : "computed";
    } else if (v.basis === "balance") {
      valuationDate = v.asOf;
      valuationSource = reported.get(a.id)?.source ?? null;
    }
    const valuationStale = valuationDate === null || dayDiff(valuationDate, asOf) > VALUATION_STALE_DAYS;
    const positionsDate = snapshot?.date ?? null;
    const positionsStale = classified && positionsDate !== null && dayDiff(positionsDate, asOf) > POSITIONS_STALE_DAYS;
    const ref = accountRef(a, f);
    const warnings: AccountWarningRecord[] = [];
    const warn = (kind: AccountWarningKind, message: string) => warnings.push({ accountId: a.id, accountName: a.name, kind, message });
    for (const w of v.warnings) if (w.code === "negative_residual") warn("negative_residual", w.message);
    if (v.basis === "none") warn("no_value", `${a.name} has no value: sync it or import a statement`);
    else if (valuationStale && valuationDate !== null) warn("valuation_stale", `${a.name} has no value newer than ${shortDate(valuationDate)}`);
    if (positionsStale && positionsDate !== null) warn("positions_stale", `Positions are ${dayDiff(positionsDate, asOf)} days old; import a statement`);
    if (v.priceStatus === "stale" && v.stalest) warn("price_stale", `Prices are ${v.stalest.tradingDaysBehind} trading days behind (latest ${shortDate(v.stalest.priceDate)})`);
    if (v.missing.length > 0) warn("unpriced", `${v.missing.length} position${v.missing.length === 1 ? "" : "s"} in ${a.name} ${v.missing.length === 1 ? "has" : "have"} no price`);
    if (f?.positionsMatch === false) warn("lots_mismatch", f.fidelityNote ?? "the lots do not explain the latest statement");
    for (const l of lines) if (l.dollarOnly) warn("dollar_only", `${l.ticker ?? l.name}: value only, this position reports no share count`);
    return { ...a, fidelityRecord: f, valuation: v, ref, valuationRef: { valuationDate, valuationSource, basis: v.basis, valuationStale, positionsDate, positionsStale }, classified, lines, warnings, snapshot };
  });

  return {
    today: q.today,
    now: q.now,
    asOf,
    expectedDate: input.expectedThrough,
    accounts: contextAccounts,
    fidelities,
    input,
    securities,
    engineHoldings,
    targets,
    setting: { ...setting, rebalanceMinTradeCents: setting.rebalanceMinTradeCents },
    cashSecurityId: cash?.id ?? null,
    reportedBasis,
  };
}

// ---- Classification (views design §3.6) ----

/** A line with its security's class and splits (synthetic cash lines are class `cash`). */
export interface ClassifiedLine extends ViewLine {
  assetClass: AssetClass;
  splits: SecuritySplitRecord[];
  securityType: SecurityType | null;
  blended: boolean;
  /** The line's value per class (Σ = valueCents). */
  classCents: Map<AssetClass, bigint>;
}

export function classifyLine(line: ViewLine, meta: SecurityMeta | undefined): ClassifiedLine {
  const isCash = line.kind !== "position" || meta === undefined || meta.type === "cash";
  const assetClass: AssetClass = isCash ? "cash" : meta.assetClass;
  const splits = isCash ? [] : (meta?.splits ?? []);
  return { ...line, assetClass, splits, securityType: meta?.type ?? null, blended: splits.length > 0, classCents: splitValue(line.valueCents, splits, assetClass) };
}

export function classifiedLines(ctx: InvestmentContext, accountIds?: ReadonlySet<string>): ClassifiedLine[] {
  const out: ClassifiedLine[] = [];
  for (const a of ctx.accounts) {
    if (!a.classified || (accountIds && !accountIds.has(a.id))) continue;
    for (const l of a.lines) out.push(classifyLine(l, l.securityId ? ctx.securities.get(l.securityId) : undefined));
  }
  return out;
}

function sumMap<K>(entries: Iterable<[K, bigint]>, into = new Map<K, bigint>()): Map<K, bigint> {
  for (const [k, v] of entries) into.set(k, (into.get(k) ?? 0n) + v);
  return into;
}

/** Target cents per class: truncated, the remainder on the largest target (ties: enum order), so Σ = total. */
export function targetCentsOf(total: bigint, targets: readonly AllocationTargetRecord[]): Map<AssetClass, bigint> {
  const out = new Map<AssetClass, bigint>();
  if (targets.length === 0) return out;
  let allocated = 0n;
  let largest: AllocationTargetRecord | undefined;
  for (const c of ASSET_CLASS_ORDER) {
    const t = targets.find((x) => x.assetClass === c);
    const bpValue = t?.targetBp ?? 0;
    const cents = truncDiv(total * BigInt(bpValue), 10000n);
    out.set(c, cents);
    allocated += cents;
    if (t && (!largest || t.targetBp > largest.targetBp)) largest = t;
  }
  if (largest) out.set(largest.assetClass, (out.get(largest.assetClass) ?? 0n) + (total - allocated));
  return out;
}

// ---- Allocation ----

export interface AllocationLineRecord {
  securityId: string | null;
  ticker: string | null;
  name: string;
  accountId: string;
  accountName: string;
  cents: bigint;
  kind: LineKind;
  blended: boolean;
}

export interface AllocationClassRecord {
  assetClass: AssetClass;
  currentCents: bigint;
  currentBp: number | null;
  targetBp: number | null;
  targetCents: bigint | null;
  driftBp: number | null;
  driftCents: bigint | null;
  outOfBand: boolean;
  lines: AllocationLineRecord[];
}

/** Bigint twin of `AllocationView`. */
export interface AllocationRecord {
  today: IsoDate;
  asOf: IsoDate;
  totalCents: bigint;
  classifiedCents: bigint;
  unclassifiedCents: bigint;
  targetsSet: boolean;
  classes: AllocationClassRecord[];
  byTaxTreatment: Array<{ taxTreatment: TaxTreatment; cents: bigint; bp: number | null; classes: Array<{ assetClass: AssetClass; cents: bigint }> }>;
  byAccount: Array<AccountRefRecord & { cents: bigint; bp: number | null; classes: Array<{ assetClass: AssetClass; cents: bigint; bp: number | null }> }>;
  unclassifiedAccounts: Array<AccountRefRecord & { cents: bigint; bpOfTotal: number | null }>;
  rebalance: RebalanceRecord | null;
  warnings: string[];
  accountWarnings: AccountWarningRecord[];
}

export interface AllocationQueryInput {
  today: IsoDate;
  now: Date;
  asOf?: IsoDate;
  includeClosed?: boolean;
}

function nonZeroClasses(m: ReadonlyMap<AssetClass, bigint>): Array<{ assetClass: AssetClass; cents: bigint }> {
  return ASSET_CLASS_ORDER.filter((c) => (m.get(c) ?? 0n) !== 0n).map((c) => ({ assetClass: c, cents: m.get(c)! }));
}

/** `GET /api/investments/allocation` (views design §3.6–§3.7). */
export async function getAllocation(db: DbOrTx, q: AllocationQueryInput): Promise<AllocationRecord> {
  const ctx = await investmentContext(db, { today: q.today, now: q.now, ...(q.asOf ? { asOf: q.asOf } : {}), ...(q.includeClosed ? { includeClosed: true } : {}) });
  return allocationOf(ctx);
}

export function allocationOf(ctx: InvestmentContext): AllocationRecord {
  const lines = classifiedLines(ctx);
  const current = new Map<AssetClass, bigint>();
  for (const l of lines) sumMap(l.classCents, current);
  const classifiedCents = lines.reduce((acc, l) => acc + l.valueCents, 0n);
  const unclassified = ctx.accounts.filter((a) => !a.classified && a.valuation.valueCents !== null);
  const unclassifiedCents = unclassified.reduce((acc, a) => acc + a.valuation.valueCents!, 0n);
  const totalCents = classifiedCents + unclassifiedCents;
  const targetsSet = ctx.targets.length > 0;
  const targetCents = targetCentsOf(classifiedCents, ctx.targets);
  const band = ctx.setting.rebalanceBandBp;

  const classes: AllocationClassRecord[] = ASSET_CLASS_ORDER.map((c) => {
    const currentCents = current.get(c) ?? 0n;
    const currentBp = bp(currentCents, classifiedCents);
    const target = ctx.targets.find((t) => t.assetClass === c);
    const targetBp = targetsSet ? (target?.targetBp ?? 0) : null;
    const tCents = targetsSet ? (targetCents.get(c) ?? 0n) : null;
    const driftBp = targetBp !== null && currentBp !== null ? currentBp - targetBp : null;
    return {
      assetClass: c,
      currentCents,
      currentBp,
      targetBp,
      targetCents: tCents,
      driftBp,
      driftCents: tCents === null ? null : currentCents - tCents,
      outOfBand: driftBp !== null && Math.abs(driftBp) >= band,
      lines: lines
        .filter((l) => (l.classCents.get(c) ?? 0n) !== 0n)
        .map((l) => ({ securityId: l.securityId, ticker: l.ticker, name: l.name, accountId: l.accountId, accountName: l.accountName, cents: l.classCents.get(c)!, kind: l.kind, blended: l.blended }))
        .sort((a, b) => (a.cents !== b.cents ? (a.cents > b.cents ? -1 : 1) : (a.ticker ?? a.name) < (b.ticker ?? b.name) ? -1 : 1)),
    };
  });

  const byTreatment = new Map<TaxTreatment, Map<AssetClass, bigint>>();
  const byAccountMap = new Map<string, Map<AssetClass, bigint>>();
  for (const l of lines) {
    const acct = ctx.accounts.find((a) => a.id === l.accountId)!;
    byTreatment.set(acct.taxTreatment, sumMap(l.classCents, byTreatment.get(acct.taxTreatment) ?? new Map()));
    byAccountMap.set(l.accountId, sumMap(l.classCents, byAccountMap.get(l.accountId) ?? new Map()));
  }
  const total = (m: ReadonlyMap<AssetClass, bigint>) => [...m.values()].reduce((acc, v) => acc + v, 0n);
  const byTaxTreatment = TAX_TREATMENTS.filter((t) => byTreatment.has(t)).map((t) => {
    const m = byTreatment.get(t)!;
    const cents = total(m);
    return { taxTreatment: t, cents, bp: bp(cents, classifiedCents), classes: nonZeroClasses(m) };
  });
  const byAccount = ctx.accounts
    .filter((a) => a.classified)
    .map((a) => {
      const m = byAccountMap.get(a.id) ?? new Map<AssetClass, bigint>();
      const cents = total(m);
      return { ...a.ref, cents, bp: bp(cents, classifiedCents), classes: nonZeroClasses(m).map((c) => ({ ...c, bp: bp(c.cents, cents) })) };
    });
  const unclassifiedAccounts = unclassified.map((a) => ({ ...a.ref, cents: a.valuation.valueCents!, bpOfTotal: bp(a.valuation.valueCents!, totalCents) }));

  const warnings: string[] = [];
  for (const a of unclassified) warnings.push(`${a.name} (${formatDollars(a.valuation.valueCents!)}, ${a.valuation.basis === "balance" ? "balance only" : a.ref.fidelity.replace("_", " ")}) is not in these percentages`);
  for (const a of ctx.accounts) if (a.valuation.basis === "none") warnings.push(`${a.name} has no value and is not shown`);

  const rebalance = targetsSet ? suggestRebalance(rebalanceInputOf(ctx, lines)) : null;
  return {
    today: ctx.today,
    asOf: ctx.asOf,
    totalCents,
    classifiedCents,
    unclassifiedCents,
    targetsSet,
    classes,
    byTaxTreatment,
    byAccount,
    unclassifiedAccounts,
    rebalance,
    warnings,
    accountWarnings: ctx.accounts.flatMap((a) => a.warnings),
  };
}

// ---- Rebalance (views design §3.7) ----

export interface RebalanceLineInput {
  securityId: string | null;
  ticker: string | null;
  name: string;
  type: SecurityType | null;
  assetClass: AssetClass;
  splits: SecuritySplitRecord[];
  valueCents: bigint;
  unrealizedGainCents: bigint | null;
  kind: LineKind;
}

export interface RebalanceAccountInput {
  id: string;
  name: string;
  taxTreatment: TaxTreatment;
  valueCents: bigint;
  lines: RebalanceLineInput[];
}

export interface RebalanceInput {
  accounts: RebalanceAccountInput[];
  /** Null = no targets. */
  targetsBp: readonly AllocationTargetRecord[] | null;
  bandBp: number;
  minTradeCents: bigint;
  /** The close per security for approximate quantities. */
  prices: ReadonlyMap<string, Fixed8>;
  /** The household's largest pure holding per class. */
  householdPure: ReadonlyMap<AssetClass, { securityId: string; ticker: string | null; name: string; accountName: string }>;
}

export interface RebalanceTradeRecord {
  accountId: string;
  accountName: string;
  taxTreatment: TaxTreatment;
  action: RebalanceAction;
  assetClass: AssetClass;
  securityId: string | null;
  ticker: string | null;
  inAccount: boolean;
  amountCents: bigint;
  approxQuantity: Fixed8 | null;
  price: Fixed8 | null;
  estimatedGainCents: bigint | null;
  note: string | null;
}

/** Bigint twin of `RebalanceView`. */
export interface RebalanceRecord {
  triggered: boolean;
  bandBp: number;
  minTradeCents: bigint;
  trades: RebalanceTradeRecord[];
  residual: Array<{ assetClass: AssetClass; amountCents: bigint }>;
  belowMinimumCents: bigint;
  notes: string[];
}

const TAX_RANK: Record<TaxTreatment, number> = { pre_tax: 0, hsa: 0, roth: 0, none: 1, taxable: 2 };

interface TradableLine {
  securityId: string | null;
  ticker: string | null;
  name: string;
  assetClass: AssetClass;
  valueCents: bigint;
  unrealizedGainCents: bigint | null;
  isCash: boolean;
}

function compareLinesDesc(a: { valueCents: bigint; ticker: string | null; name: string; securityId: string | null }, b: typeof a): number {
  if (a.valueCents !== b.valueCents) return a.valueCents > b.valueCents ? -1 : 1;
  const ta = a.ticker ?? a.name;
  const tb = b.ticker ?? b.name;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return (a.securityId ?? "") < (b.securityId ?? "") ? -1 : (a.securityId ?? "") > (b.securityId ?? "") ? 1 : 0;
}

function approx(amount: bigint, close: Fixed8 | undefined): { approxQuantity: Fixed8 | null; price: Fixed8 | null } {
  if (close === undefined || close <= 0n) return { approxQuantity: null, price: close ?? null };
  return { approxQuantity: quantityForCents(amount, close), price: close };
}

/** The deterministic greedy suggestion of §3.7: pure, deep-equal for any input permutation. */
export function suggestRebalance(input: RebalanceInput): RebalanceRecord | null {
  if (input.targetsBp === null || input.targetsBp.length === 0) return null;
  const notes: string[] = [];
  const current = new Map<AssetClass, bigint>();
  const blendedNames = new Set<string>();
  for (const a of input.accounts) {
    for (const l of a.lines) {
      const isCash = l.kind !== "position" || l.type === "cash";
      sumMap(splitValue(l.valueCents, isCash ? [] : l.splits, isCash ? "cash" : l.assetClass), current);
      if (!isCash && l.splits.length > 0) blendedNames.add(l.ticker ?? l.name);
    }
  }
  for (const name of [...blendedNames].sort()) notes.push(`${name} is a blended fund and is held constant`);
  const C = [...current.values()].reduce((acc, v) => acc + v, 0n);
  const targetCents = targetCentsOf(C, input.targetsBp);
  const delta = new Map<AssetClass, bigint>();
  let triggered = false;
  for (const c of ASSET_CLASS_ORDER) {
    const cur = current.get(c) ?? 0n;
    delta.set(c, (targetCents.get(c) ?? 0n) - cur);
    const curBp = bp(cur, C);
    const targetBp = input.targetsBp.find((t) => t.assetClass === c)?.targetBp ?? 0;
    if (curBp !== null && Math.abs(curBp - targetBp) >= input.bandBp) triggered = true;
  }
  const base = { triggered, bandBp: input.bandBp, minTradeCents: input.minTradeCents };
  if (!triggered) return { ...base, trades: [], residual: [], belowMinimumCents: 0n, notes };

  // Tradable lines per account: pure positions and one merged cash line.
  const accounts = [...input.accounts]
    .map((a) => {
      const lines: TradableLine[] = [];
      let cash = 0n;
      let hasCash = false;
      for (const l of a.lines) {
        const isCash = l.kind !== "position" || l.type === "cash";
        if (isCash) {
          cash += l.valueCents;
          hasCash = true;
        } else if (l.splits.length === 0 && l.securityId !== null) {
          lines.push({ securityId: l.securityId, ticker: l.ticker, name: l.name, assetClass: l.assetClass, valueCents: l.valueCents, unrealizedGainCents: l.unrealizedGainCents, isCash: false });
        }
      }
      if (hasCash && cash > 0n) lines.push({ securityId: null, ticker: null, name: "Cash", assetClass: "cash", valueCents: cash, unrealizedGainCents: 0n, isCash: true });
      lines.sort(compareLinesDesc);
      return { ...a, tradable: lines };
    })
    .sort((a, b) => {
      const ra = TAX_RANK[a.taxTreatment];
      const rb = TAX_RANK[b.taxTreatment];
      if (ra !== rb) return ra - rb;
      if (a.valueCents !== b.valueCents) return a.valueCents > b.valueCents ? -1 : 1;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const trades: RebalanceTradeRecord[] = [];
  const overClasses = () =>
    ASSET_CLASS_ORDER.filter((c) => delta.get(c)! < 0n).sort((x, y) => (delta.get(x)! !== delta.get(y)! ? (delta.get(x)! < delta.get(y)! ? -1 : 1) : assetClassRank(x) - assetClassRank(y)));
  const underClasses = () =>
    ASSET_CLASS_ORDER.filter((c) => delta.get(c)! > 0n).sort((x, y) => (delta.get(x)! !== delta.get(y)! ? (delta.get(x)! > delta.get(y)! ? -1 : 1) : assetClassRank(x) - assetClassRank(y)));
  const min = (a: bigint, b: bigint) => (a < b ? a : b);

  for (const a of accounts) {
    const over = overClasses();
    const under = underClasses();
    const cap = new Map<AssetClass, bigint>();
    let sellAvail = 0n;
    for (const c of over) {
      const held = a.tradable.filter((l) => l.assetClass === c).reduce((acc, l) => acc + l.valueCents, 0n);
      const capCents = min(held, -delta.get(c)!);
      cap.set(c, capCents);
      sellAvail += capCents;
    }
    const buyAvail = under.reduce((acc, c) => acc + delta.get(c)!, 0n);
    const amount = min(sellAvail, buyAvail);
    if (amount <= 0n) continue;
    const head = { accountId: a.id, accountName: a.name, taxTreatment: a.taxTreatment };

    let left = amount;
    for (const c of over) {
      if (left <= 0n) break;
      let s = min(cap.get(c)!, left);
      for (const line of a.tradable.filter((l) => l.assetClass === c)) {
        if (s <= 0n) break;
        const take = min(line.valueCents, s);
        if (take <= 0n) continue;
        s -= take;
        left -= take;
        delta.set(c, delta.get(c)! + take);
        if (line.isCash) {
          trades.push({ ...head, action: "use_cash", assetClass: "cash", securityId: null, ticker: null, inAccount: true, amountCents: take, approxQuantity: null, price: null, estimatedGainCents: null, note: null });
          continue;
        }
        let estimatedGainCents: bigint | null = null;
        let note: string | null = null;
        if (a.taxTreatment === "taxable" && line.unrealizedGainCents !== null && line.valueCents > 0n) {
          estimatedGainCents = truncDiv(line.unrealizedGainCents * take, line.valueCents);
          note = `may realize about ${formatDollars(estimatedGainCents)} of gains; the lots view shows which lots`;
        }
        trades.push({ ...head, action: "sell", assetClass: c, securityId: line.securityId, ticker: line.ticker, inAccount: true, amountCents: take, ...approx(take, input.prices.get(line.securityId!)), estimatedGainCents, note });
      }
    }

    left = amount;
    for (const c of under) {
      if (left <= 0n) break;
      const b = min(delta.get(c)!, left);
      if (b <= 0n) continue;
      delta.set(c, delta.get(c)! - b);
      left -= b;
      if (c === "cash") {
        trades.push({ ...head, action: "hold_cash", assetClass: "cash", securityId: null, ticker: null, inAccount: true, amountCents: b, approxQuantity: null, price: null, estimatedGainCents: null, note: null });
        continue;
      }
      const own = a.tradable.find((l) => !l.isCash && l.assetClass === c);
      if (own) {
        trades.push({ ...head, action: "buy", assetClass: c, securityId: own.securityId, ticker: own.ticker, inAccount: true, amountCents: b, ...approx(b, input.prices.get(own.securityId!)), estimatedGainCents: null, note: null });
        continue;
      }
      const pure = input.householdPure.get(c);
      if (pure) {
        trades.push({
          ...head,
          action: "buy",
          assetClass: c,
          securityId: pure.securityId,
          ticker: pure.ticker,
          inAccount: false,
          amountCents: b,
          ...approx(b, input.prices.get(pure.securityId)),
          estimatedGainCents: null,
          note: `${pure.ticker ?? pure.name} or the plan's equivalent ${CLASS_LABEL[c]} fund (held in ${pure.accountName})`,
        });
        continue;
      }
      trades.push({ ...head, action: "buy", assetClass: c, securityId: null, ticker: null, inAccount: false, amountCents: b, approxQuantity: null, price: null, estimatedGainCents: null, note: `a ${CLASS_LABEL[c]} fund (new position)` });
    }
  }

  // Minimum-trade pass (§3.7 step 5).
  let belowMinimumCents = 0n;
  let removed = 0;
  const holdOf = (accountId: string) => trades.find((t) => t.accountId === accountId && t.action === "hold_cash");
  const addHold = (accountId: string, cents: bigint) => {
    const existing = holdOf(accountId);
    if (existing) existing.amountCents += cents;
    else {
      const a = accounts.find((x) => x.id === accountId)!;
      trades.push({ accountId, accountName: a.name, taxTreatment: a.taxTreatment, action: "hold_cash", assetClass: "cash", securityId: null, ticker: null, inAccount: true, amountCents: cents, approxQuantity: null, price: null, estimatedGainCents: null, note: null });
    }
  };
  for (;;) {
    const small = trades.filter((t) => t.action !== "hold_cash" && t.amountCents < input.minTradeCents);
    if (small.length === 0) break;
    small.sort((x, y) => {
      if (x.amountCents !== y.amountCents) return x.amountCents < y.amountCents ? -1 : 1;
      const sx = x.action === "buy" ? 1 : 0;
      const sy = y.action === "buy" ? 1 : 0;
      return sx - sy;
    });
    const t = small[0]!;
    trades.splice(trades.indexOf(t), 1);
    belowMinimumCents += t.amountCents;
    removed++;
    if (t.action === "buy") {
      delta.set(t.assetClass, delta.get(t.assetClass)! + t.amountCents);
      delta.set("cash", delta.get("cash")! - t.amountCents);
      addHold(t.accountId, t.amountCents);
      continue;
    }
    // A removed sell / use_cash: the class stays over target and the account's buys shrink, largest first.
    delta.set(t.assetClass, delta.get(t.assetClass)! - t.amountCents);
    let reduce = t.amountCents;
    const targets = trades.filter((x) => x.accountId === t.accountId && (x.action === "buy" || x.action === "hold_cash")).sort((x, y) => (x.amountCents > y.amountCents ? -1 : x.amountCents < y.amountCents ? 1 : 0));
    for (const x of targets) {
      if (reduce <= 0n) break;
      const cut = min(x.amountCents, reduce);
      x.amountCents -= cut;
      reduce -= cut;
      delta.set(x.assetClass, delta.get(x.assetClass)! + cut);
      if (x.securityId !== null) {
        const a = approx(x.amountCents, input.prices.get(x.securityId));
        x.approxQuantity = a.approxQuantity;
      }
      if (x.amountCents === 0n) trades.splice(trades.indexOf(x), 1);
    }
  }
  // Net use_cash against hold_cash within each account.
  for (const a of accounts) {
    const use = trades.find((t) => t.accountId === a.id && t.action === "use_cash");
    const hold = holdOf(a.id);
    if (!use || !hold) continue;
    const net = min(use.amountCents, hold.amountCents);
    use.amountCents -= net;
    hold.amountCents -= net;
    if (hold.amountCents === 0n) trades.splice(trades.indexOf(hold), 1);
    if (use.amountCents === 0n) trades.splice(trades.indexOf(use), 1);
  }
  if (removed > 0) notes.push(`${removed} trade${removed === 1 ? "" : "s"} under ${formatDollars(input.minTradeCents)} ${removed === 1 ? "was" : "were"} left out`);

  const residual = ASSET_CLASS_ORDER.filter((c) => delta.get(c)! !== 0n).map((c) => ({ assetClass: c, amountCents: delta.get(c)! }));
  if (residual.length > 0) {
    const blendedOnly = residual.filter((r) => r.amountCents < 0n && !accounts.some((a) => a.tradable.some((l) => l.assetClass === r.assetClass)));
    for (const r of blendedOnly) notes.push(`${r.assetClass} is held only through blended funds, which are held constant`);
    if (blendedOnly.length === 0 && removed === 0) notes.push("cannot be fully rebalanced without moving money between accounts");
  }
  return { ...base, trades, residual, belowMinimumCents, notes };
}

/** The pure input of `suggestRebalance` from the context (prices and the household's pure holdings from the lines). */
export function rebalanceInputOf(ctx: InvestmentContext, lines: readonly ClassifiedLine[]): RebalanceInput {
  const prices = new Map<string, Fixed8>();
  const priceMeta = new Map<string, { date: IsoDate; source: HoldingPriceSource }>();
  const pureByClass = new Map<AssetClass, { securityId: string; ticker: string | null; name: string; accountName: string; valueCents: bigint }>();
  const covered = holdingCostBasis(ctx);
  const accounts: RebalanceAccountInput[] = ctx.accounts
    .filter((a) => a.classified)
    .map((a) => ({
      id: a.id,
      name: a.name,
      taxTreatment: a.taxTreatment,
      valueCents: a.lines.reduce((acc, l) => acc + l.valueCents, 0n),
      lines: lines
        .filter((l) => l.accountId === a.id)
        .map((l) => {
          // The close per security: the latest-dated line price, ties by source rank (the holdings rows' rule).
          if (l.securityId !== null && l.price !== null && l.priceDate !== null) {
            const prev = priceMeta.get(l.securityId);
            const source = l.priceSource ?? "cash";
            if (prev === undefined || l.priceDate > prev.date || (l.priceDate === prev.date && SOURCE_RANK[source] > SOURCE_RANK[prev.source])) {
              prices.set(l.securityId, l.price);
              priceMeta.set(l.securityId, { date: l.priceDate, source });
            }
          }
          const basis = covered.get(lineKey(l));
          const pure = l.kind === "position" && !l.blended && l.securityId !== null && l.securityType !== "cash";
          if (pure) {
            const best = pureByClass.get(l.assetClass);
            if (!best || l.valueCents > best.valueCents || (l.valueCents === best.valueCents && (l.ticker ?? l.name) < (best.ticker ?? best.name))) {
              pureByClass.set(l.assetClass, { securityId: l.securityId!, ticker: l.ticker, name: l.name, accountName: l.accountName, valueCents: l.valueCents });
            }
          }
          return {
            securityId: l.securityId,
            ticker: l.ticker,
            name: l.name,
            type: l.securityType,
            assetClass: l.assetClass,
            splits: l.splits,
            valueCents: l.valueCents,
            unrealizedGainCents: basis && basis.costBasisCents !== null ? l.valueCents - basis.costBasisCents : null,
            kind: l.kind,
          };
        }),
    }));
  return {
    accounts,
    targetsBp: ctx.targets.length > 0 ? ctx.targets : null,
    bandBp: ctx.setting.rebalanceBandBp,
    minTradeCents: ctx.setting.rebalanceMinTradeCents,
    prices,
    householdPure: new Map([...pureByClass].map(([c, p]) => [c, { securityId: p.securityId, ticker: p.ticker, name: p.name, accountName: p.accountName }])),
  };
}

// ---- Holdings (views design §3.8) ----

const SOURCE_RANK: Record<HoldingPriceSource, number> = { manual: 5, provider: 4, implied: 3, txn: 2, statement: 1, cash: 0 };

export interface CoveredBasis {
  costBasisCents: bigint | null;
  basisSource: "lots" | "statement" | null;
  gainCents: bigint | null;
  lotCount: number | null;
  unknownBasisQuantity: Fixed8 | null;
}

/**
 * Cost basis per line (`${accountId}|${securityId}`): the lot engine's for accounts with trades
 * (shown even when the lots disagree with the statement, with a `lots_mismatch` warning), else
 * the statement's reported basis; cash and synthetic lines cost what they are worth.
 */
export function holdingCostBasis(ctx: InvestmentContext): Map<string, CoveredBasis> {
  const out = new Map<string, CoveredBasis>();
  const reported = ctx.reportedBasis;
  for (const a of ctx.accounts) {
    if (!a.classified) continue;
    for (const l of a.lines) {
      const k = lineKey(l);
      const meta = l.securityId ? ctx.securities.get(l.securityId) : undefined;
      if (l.kind !== "position" || meta === undefined || meta.type === "cash") {
        out.set(k, { costBasisCents: l.valueCents, basisSource: null, gainCents: 0n, lotCount: null, unknownBasisQuantity: null });
        continue;
      }
      const engine = a.fidelityRecord?.lastTradeDate ? ctx.engineHoldings.get(k) : undefined;
      if (engine) {
        out.set(k, {
          costBasisCents: engine.costBasisCents,
          basisSource: "lots",
          gainCents: engine.costBasisCents === null ? null : l.valueCents - engine.costBasisCents,
          lotCount: engine.lotCount,
          unknownBasisQuantity: engine.unknownBasisQuantity,
        });
        continue;
      }
      const statement = reported.get(k);
      if (statement !== undefined) out.set(k, { costBasisCents: statement, basisSource: "statement", gainCents: l.valueCents - statement, lotCount: null, unknownBasisQuantity: null });
      else out.set(k, { costBasisCents: null, basisSource: null, gainCents: null, lotCount: null, unknownBasisQuantity: null });
    }
  }
  return out;
}

export interface HoldingAccountRecord extends AccountRefRecord {
  kind: LineKind;
  quantity: Fixed8 | null;
  valueCents: bigint;
  costBasisCents: bigint | null;
  basisSource: "lots" | "statement" | null;
  gainCents: bigint | null;
  lotCount: number | null;
  unknownBasisQuantity: Fixed8 | null;
  snapshotDate: IsoDate | null;
  snapshotSource: HoldingSource | null;
  priceSource: HoldingPriceSource;
  dollarOnly: boolean;
}

export interface HoldingRowRecord {
  securityId: string;
  ticker: string | null;
  name: string;
  type: SecurityType;
  assetClass: AssetClass;
  splits: SecuritySplitRecord[];
  needsReview: boolean;
  quantity: Fixed8 | null;
  price: Fixed8 | null;
  priceDate: IsoDate | null;
  priceSource: HoldingPriceSource;
  priceStatus: PriceStatus;
  priceStale: boolean;
  valueCents: bigint;
  weightBp: number | null;
  costBasisCents: bigint | null;
  coverage: CostCoverage;
  gainCents: bigint | null;
  gainBp: number | null;
  expenseRatioPpm: number | null;
  accounts: HoldingAccountRecord[];
}

export interface ConcentrationWarningRecord {
  level: ConcentrationLevel;
  securityId: string;
  ticker: string | null;
  weightBp: number;
  thresholdBp: number;
  message: string;
}

/** Bigint twin of `HoldingsView`. */
export interface HoldingsRecord {
  today: IsoDate;
  asOf: IsoDate;
  /** The classified total the weights are relative to. */
  totalCents: bigint;
  /** Securities and reported cash. */
  holdingsCents: bigint;
  cashCents: bigint;
  /** The plug, carried transfers and lots-basis trade cash. */
  residualCents: bigint;
  rows: HoldingRowRecord[];
  weightedExpenseRatio: { ppm: number | null; coveredBp: number | null; annualCostCents: bigint };
  concentration: ConcentrationWarningRecord[];
  excludedAccounts: Array<AccountRefRecord & { cents: bigint | null }>;
  accountWarnings: AccountWarningRecord[];
  warnings: string[];
}

export interface HoldingsQueryInput {
  today: IsoDate;
  now: Date;
  asOf?: IsoDate;
  accountId?: string;
  includeClosed?: boolean;
}

export const CONCENTRATION_WARN_BP = 1000;
export const CONCENTRATION_BAD_BP = 2500;
export const CONCENTRATION_FUND_BP = 6000;

/** `GET /api/investments/holdings`: `accountId` restricts the rows and the weights' total. */
export async function getHoldings(db: DbOrTx, q: HoldingsQueryInput): Promise<HoldingsRecord> {
  const ctx = await investmentContext(db, { today: q.today, now: q.now, ...(q.asOf ? { asOf: q.asOf } : {}), ...(q.includeClosed ? { includeClosed: true } : {}) });
  if (q.accountId !== undefined && !ctx.accounts.some((a) => a.id === q.accountId)) throw new PlanError(404, "not_found", "Account not found among the investment accounts");
  return holdingsOf(ctx, q.accountId !== undefined ? new Set([q.accountId]) : undefined);
}

export function holdingsOf(ctx: InvestmentContext, accountIds?: ReadonlySet<string>): HoldingsRecord {
  const lines = classifiedLines(ctx, accountIds);
  const basis = holdingCostBasis(ctx);
  const totalCents = lines.reduce((acc, l) => acc + l.valueCents, 0n);
  let holdingsCents = 0n;
  let cashCents = 0n;
  let residualCents = 0n;
  const groups = new Map<string, ClassifiedLine[]>();
  for (const l of lines) {
    if (l.securityId !== null) {
      holdingsCents += l.valueCents;
      if (l.kind === "cash") cashCents += l.valueCents;
    } else residualCents += l.valueCents;
    const rowId = l.securityId ?? ctx.cashSecurityId;
    if (rowId === null) continue;
    groups.set(rowId, [...(groups.get(rowId) ?? []), l]);
  }

  const rows: HoldingRowRecord[] = [];
  for (const [securityId, group] of groups) {
    const meta = ctx.securities.get(securityId);
    if (!meta) continue;
    let quantity: Fixed8 | null = 0n;
    let anyQuantity = false;
    let valueCents = 0n;
    let best: ClassifiedLine | undefined;
    let coveredValue = 0n;
    let coveredCost = 0n;
    let coveredCount = 0;
    const accounts: HoldingAccountRecord[] = [];
    for (const l of group) {
      valueCents += l.valueCents;
      if (l.dollarOnly) quantity = null;
      else if (quantity !== null && l.quantity !== null) {
        quantity += l.quantity;
        anyQuantity = true;
      }
      if (l.securityId !== null && (best === undefined || (l.priceDate ?? "") > (best.priceDate ?? "") || ((l.priceDate ?? "") === (best.priceDate ?? "") && SOURCE_RANK[l.priceSource ?? "cash"] > SOURCE_RANK[best.priceSource ?? "cash"]))) best = l;
      const acct = ctx.accounts.find((a) => a.id === l.accountId)!;
      const b = basis.get(lineKey(l)) ?? { costBasisCents: null, basisSource: null, gainCents: null, lotCount: null, unknownBasisQuantity: null };
      if (b.costBasisCents !== null) {
        coveredValue += l.valueCents;
        coveredCost += b.costBasisCents;
        coveredCount++;
      }
      accounts.push({
        ...acct.ref,
        kind: l.kind,
        quantity: l.quantity,
        valueCents: l.valueCents,
        costBasisCents: b.costBasisCents,
        basisSource: b.basisSource,
        gainCents: b.gainCents,
        lotCount: b.lotCount,
        unknownBasisQuantity: b.unknownBasisQuantity,
        snapshotDate: acct.valuation.basis === "lots" ? null : (acct.snapshot?.date ?? null),
        snapshotSource: acct.valuation.basis === "lots" ? null : (acct.snapshot?.source ?? null),
        priceSource: l.priceSource ?? "cash",
        dollarOnly: l.dollarOnly,
      });
    }
    accounts.sort((a, b) => (a.valueCents !== b.valueCents ? (a.valueCents > b.valueCents ? -1 : 1) : a.accountName < b.accountName ? -1 : 1));
    const coverage: CostCoverage = coveredCount === 0 ? "none" : coveredCount === group.length ? "full" : "partial";
    rows.push({
      securityId,
      ticker: meta.ticker,
      name: meta.name,
      type: meta.type,
      assetClass: meta.assetClass,
      splits: meta.splits,
      needsReview: meta.needsReview,
      quantity: anyQuantity ? quantity : null,
      price: best?.price ?? null,
      priceDate: best?.priceDate ?? null,
      priceSource: best?.priceSource ?? "cash",
      priceStatus: best?.priceStatus ?? "cash",
      priceStale: best?.priceStatus === "stale",
      valueCents,
      weightBp: bp(valueCents, totalCents),
      costBasisCents: coveredCount === 0 ? null : coveredCost,
      coverage,
      gainCents: coveredCount === 0 ? null : coveredValue - coveredCost,
      gainBp: coveredCount === 0 ? null : bp(coveredValue - coveredCost, coveredCost),
      expenseRatioPpm: meta.expenseRatioPpm,
      accounts,
    });
  }
  rows.sort((a, b) => (a.valueCents !== b.valueCents ? (a.valueCents > b.valueCents ? -1 : 1) : (a.ticker ?? a.name) < (b.ticker ?? b.name) ? -1 : 1));

  const weighted = ppmWeighted(rows.map((r) => ({ valueCents: r.valueCents, ppm: r.expenseRatioPpm, type: r.type })));
  const concentration: ConcentrationWarningRecord[] = [];
  for (const r of rows) {
    if (r.weightBp === null) continue;
    if (r.type === "stock" && r.weightBp >= CONCENTRATION_WARN_BP) {
      const bad = r.weightBp >= CONCENTRATION_BAD_BP;
      concentration.push({
        level: bad ? "bad" : "warn",
        securityId: r.securityId,
        ticker: r.ticker,
        weightBp: r.weightBp,
        thresholdBp: bad ? CONCENTRATION_BAD_BP : CONCENTRATION_WARN_BP,
        message: `${r.ticker ?? r.name} is ${formatBp(r.weightBp)} of your portfolio (individual stock; flagged above ${bad ? "25" : "10"}%)`,
      });
    } else if ((r.type === "etf" || r.type === "fund") && r.weightBp >= CONCENTRATION_FUND_BP) {
      concentration.push({ level: "info", securityId: r.securityId, ticker: r.ticker, weightBp: r.weightBp, thresholdBp: CONCENTRATION_FUND_BP, message: `${r.ticker ?? r.name} is ${formatBp(r.weightBp)} of your portfolio: most of the portfolio is one fund; fine for a total-market fund` });
    }
  }
  const selected = ctx.accounts.filter((a) => !accountIds || accountIds.has(a.id));
  const warnings: string[] = [];
  if (residualCents !== 0n && ctx.cashSecurityId === null) warnings.push("Inferred cash has no cash security row yet; it is counted in residualCents only");
  return {
    today: ctx.today,
    asOf: ctx.asOf,
    totalCents,
    holdingsCents,
    cashCents,
    residualCents,
    rows,
    weightedExpenseRatio: { ppm: weighted.ppm, coveredBp: bp(weighted.coveredCents, weighted.totalCents), annualCostCents: weighted.annualCostCents },
    concentration,
    excludedAccounts: selected.filter((a) => !a.classified).map((a) => ({ ...a.ref, cents: a.valuation.valueCents })),
    accountWarnings: selected.flatMap((a) => a.warnings),
    warnings,
  };
}

// ---- Portfolio (views design §3.11 on the chain) ----

export interface ChangeSummaryRecord {
  from: IsoDate;
  to: IsoDate;
  startCents: bigint | null;
  endCents: bigint;
  changeCents: bigint | null;
  changeBp: number | null;
  netFlowsCents: bigint;
  growthCents: bigint | null;
  growthReason: string | null;
  incomeCents: bigint;
  uncategorizedRows: number;
  /** True when `missingAccountIds` is non-empty (the engine's `partial`). */
  partial: boolean;
  /** Accounts valued at `from` but not at `to`, left out of every total (the engine's `missing`). */
  missingAccountIds: string[];
}

export interface PortfolioAccountRecord extends AccountRefRecord, ValuationRefRecord {
  valueCents: bigint | null;
  dayChangeCents: bigint | null;
  dayChangeBp: number | null;
  holdingsCount: number;
  cashCents: bigint | null;
  residualCents: bigint | null;
  closed: boolean;
  investmentIncomeFeed: InvestmentIncomeFeed;
  period: ChangeSummaryRecord | null;
  warnings: AccountWarningRecord[];
}

export interface ValueSeriesRecord {
  dates: IsoDate[];
  step: number;
  total: Array<bigint | null>;
  accounts: Array<{ accountId: string; points: Array<bigint | null> }>;
}

/** Bigint twin of `PortfolioView`. */
export interface PortfolioRecord {
  today: IsoDate;
  asOf: IsoDate;
  period: PeriodBounds | null;
  totalCents: bigint;
  dayChange: PortfolioDayChange;
  periodChange: ChangeSummaryRecord | null;
  accounts: PortfolioAccountRecord[];
  series: ValueSeriesRecord;
  fidelityCounts: Record<InvestmentFidelity, number>;
  warnings: string[];
}

export interface PortfolioQueryInput {
  today: IsoDate;
  now: Date;
  asOf?: IsoDate;
  /** Default `1y`. */
  period?: InvestmentPeriod;
  from?: IsoDate;
  to?: IsoDate;
  accountIds?: readonly string[];
  includeClosed?: boolean;
}

/** `GET /api/investments/portfolio`: the chain's values, day and period change, the value series. */
export async function getPortfolio(db: DbOrTx, q: PortfolioQueryInput): Promise<PortfolioRecord> {
  const period = q.period ?? "1y";
  let asOf = q.asOf ?? defaultAsOf(q.today, q.now);
  if (period === "custom" && q.to) asOf = q.to;
  if (asOf > q.today) throw new PlanError(400, "validation", `asOf ${asOf} is after today ${q.today}`);
  if (period === "custom") {
    if (!q.from) throw new PlanError(400, "validation", "A custom period needs from");
    if (q.from >= asOf) throw new PlanError(400, "validation", `from ${q.from} must be before to ${asOf}`);
  }
  const accounts = await listInvestmentAccounts(db, { ...(q.accountIds ? { accountIds: q.accountIds } : {}), ...(q.includeClosed ? { includeClosed: true } : {}) });
  const ids = accounts.map((a) => a.id);
  const fidelities = await accountFidelities(db, ids);
  const firsts = await firstDataDates(db, ids, fidelities);
  const bounds = periodBounds(period, asOf, earliestDataDate(firsts), { from: q.from ?? null, to: asOf, today: q.today });
  const ctx = await investmentContext(db, {
    today: q.today,
    now: q.now,
    asOf,
    ...(q.accountIds ? { accountIds: q.accountIds } : {}),
    ...(q.includeClosed ? { includeClosed: true } : {}),
    ...(bounds ? { from: bounds.from } : {}),
  });
  const day = dayChange(ctx.input, ids, asOf);
  const change = bounds ? periodChange(ctx.input, ids, { period, end: asOf, from: bounds.from }) : null;

  let periodChangeRecord: ChangeSummaryRecord | null = null;
  const perAccount = new Map<string, ChangeSummaryRecord>();
  if (change) {
    const [incomeCents, uncategorizedRows] = await Promise.all([incomeInWindow(db, ids, change.from, change.to), uncategorizedRowsInWindow(db, ids, change.from, change.to)]);
    periodChangeRecord = {
      from: change.from,
      to: change.to,
      startCents: change.startCents,
      endCents: change.endCents,
      changeCents: change.changeCents,
      changeBp: change.changeBp,
      netFlowsCents: change.netFlowsCents,
      growthCents: change.growthCents,
      growthReason: change.growthReason,
      incomeCents,
      uncategorizedRows,
      partial: change.partial,
      missingAccountIds: [...change.missing],
    };
    for (const a of change.accounts) {
      const [income, uncategorized] = await Promise.all([incomeInWindow(db, [a.accountId], change.from, change.to), uncategorizedRowsInWindow(db, [a.accountId], change.from, change.to)]);
      perAccount.set(a.accountId, {
        from: change.from,
        to: change.to,
        startCents: a.startCents,
        endCents: a.endCents ?? 0n,
        changeCents: a.changeCents,
        changeBp: a.startCents !== null && a.changeCents !== null ? bp(a.changeCents, a.startCents) : null,
        netFlowsCents: a.netFlowsCents,
        growthCents: a.growthCents,
        growthReason: a.growthReason,
        incomeCents: income,
        uncategorizedRows: uncategorized,
        // The account's own row: it is "missing" when it is valued at the start and not at the end.
        partial: change.missing.includes(a.accountId),
        missingAccountIds: change.missing.includes(a.accountId) ? [a.accountId] : [],
      });
    }
  }

  // The value series over the period (daily up to 400 days, weekly beyond; capped at the engine's maximum span).
  const warnings: string[] = [];
  let seriesFrom = bounds ? bounds.from : asOf;
  if (dayDiff(seriesFrom, asOf) > MAX_SERIES_DAYS) {
    seriesFrom = addDays(asOf, -MAX_SERIES_DAYS);
    warnings.push(`The value series starts ${seriesFrom}; at most ${MAX_SERIES_DAYS} days are charted`);
  }
  const weekly = dayDiff(seriesFrom, asOf) > 400;
  const series = await valuationSeries(db, { from: seriesFrom, to: asOf, today: q.today, now: q.now, accountIds: ids, step: weekly ? "week" : "day" });
  const seriesRecord: ValueSeriesRecord = {
    dates: series.dates,
    step: weekly ? 7 : 1,
    total: series.portfolio.map((p) => p.valueCents),
    accounts: series.accounts.map((a) => ({ accountId: a.accountId, points: a.values })),
  };

  const dayByAccount = new Map(day.accounts.map((a) => [a.accountId, a]));
  const fidelityCounts: Record<InvestmentFidelity, number> = { balance_only: 0, positions: 0, full_history: 0 };
  const accountRecords: PortfolioAccountRecord[] = ctx.accounts.map((a) => {
    fidelityCounts[a.ref.fidelity]++;
    const d = dayByAccount.get(a.id);
    let dayChangeBp: number | null = null;
    if (d && d.cents !== null && d.prior !== null) {
      const prior = valueAccountOn(ctx.input, a.id, d.prior).valueCents;
      dayChangeBp = prior === null ? null : bp(d.cents, prior);
    }
    const cash = a.lines.filter((l) => l.kind === "cash" && l.securityId !== null).reduce((acc, l) => acc + l.valueCents, 0n);
    const residual = a.lines.filter((l) => l.securityId === null).reduce((acc, l) => acc + l.valueCents, 0n);
    const period = perAccount.get(a.id) ?? null;
    if (period && period.uncategorizedRows > 0) {
      const n = period.uncategorizedRows;
      warnings.push(`${n} uncategorized row${n === 1 ? "" : "s"} in ${a.name} ${n === 1 ? "is" : "are"} neither a transfer nor income; mark ${n === 1 ? "it" : "them"} if ${n === 1 ? "it is" : "they are"} a contribution or withdrawal`);
    }
    return {
      ...a.ref,
      ...a.valuationRef,
      valueCents: a.valuation.valueCents,
      dayChangeCents: d?.cents ?? null,
      dayChangeBp,
      holdingsCount: a.lines.filter((l) => l.securityId !== null).length,
      cashCents: a.classified ? cash : null,
      residualCents: a.classified ? residual : null,
      closed: a.closed,
      investmentIncomeFeed: a.investmentIncomeFeed,
      period,
      warnings: a.warnings,
    };
  });
  if (bounds?.note) warnings.push(bounds.note);

  return {
    today: q.today,
    asOf,
    period: bounds,
    totalCents: ctx.accounts.reduce((acc, a) => acc + (a.valuation.valueCents ?? 0n), 0n),
    dayChange: day,
    periodChange: periodChangeRecord,
    accounts: accountRecords,
    series: seriesRecord,
    fidelityCounts,
    warnings,
  };
}

// ---- Why did it change (views design §3.9) ----

export interface HoldingChangeRecord {
  securityId: string | null;
  ticker: string | null;
  name: string;
  kind: LineKind;
  quantityFrom: Fixed8 | null;
  quantityTo: Fixed8 | null;
  priceFrom: Fixed8 | null;
  priceTo: Fixed8 | null;
  valueFromCents: bigint;
  valueToCents: bigint;
  deltaCents: bigint;
  priceEffectCents: bigint;
  quantityEffectCents: bigint;
}

export interface ExternalFlowRecord extends ExternalFlowInput {
  counterpartyAccountName: string | null;
  internal: boolean;
  internalReason: null;
}

/** Bigint twin of `AccountChangesView`. */
export interface AccountChangesRecord extends AccountRefRecord {
  from: IsoDate;
  to: IsoDate;
  summary: ChangeSummaryRecord;
  holdings: HoldingChangeRecord[];
  residualEffectCents: bigint;
  flows: ExternalFlowRecord[];
  income: IncomeRowRecord[];
  warnings: string[];
}

export const MAX_CHANGES_MONTHS = 60;

/**
 * Attribute an account's change between two dates: per security `priceEffect =
 * mulToCents(qFrom, pTo) − vFrom` and `quantityEffect` = the rest, the synthetic cash lines'
 * change as the residual effect, the period change's net flows and growth, income and
 * uncategorized rows. `from < to ≤ today`, at most five years (400 `validation`).
 */
export async function getAccountChanges(db: DbOrTx, accountId: string, q: { from: IsoDate; to: IsoDate; today: IsoDate; now: Date }): Promise<AccountChangesRecord> {
  if (q.from >= q.to) throw new PlanError(400, "validation", `from ${q.from} must be before to ${q.to}`);
  if (q.to > q.today) throw new PlanError(400, "validation", `to ${q.to} is after today ${q.today}`);
  if (q.to > addMonthsClamped(q.from, MAX_CHANGES_MONTHS)) throw new PlanError(400, "validation", "A change window spans at most five years");
  const [row] = await db.select({ id: account.id, type: account.type }).from(account).where(eq(account.id, accountId));
  if (!row) throw new PlanError(404, "not_found", "Account not found");
  const accounts = await listInvestmentAccounts(db, { accountIds: [accountId], includeClosed: true });
  const acct = accounts[0]!;
  const fidelities = await accountFidelities(db, [accountId]);
  const input = await loadValuationInput(db, { accountIds: [accountId], from: q.from, to: q.to, now: q.now, fidelities });
  const before = valueAccountOn(input, accountId, q.from);
  const after = valueAccountOn(input, accountId, q.to);
  const change = periodChange(input, [accountId], { period: "custom", end: q.to, from: q.from });
  const mine = change?.accounts.find((a) => a.accountId === accountId);
  const [incomeCents, uncategorizedRows, flows, income] = await Promise.all([
    incomeInWindow(db, [accountId], q.from, q.to),
    uncategorizedRowsInWindow(db, [accountId], q.from, q.to),
    loadExternalFlows(db, [accountId], q.from, q.to, { now: q.now, fidelities }),
    loadIncomeRows(db, [{ id: acct.id, name: acct.name, investmentIncomeFeed: acct.investmentIncomeFeed }], q.from, q.to, (await db.select({ c: householdSetting.investmentIncomeCategoryId }).from(householdSetting).where(eq(householdSetting.id, 1)))[0]?.c ?? null),
  ]);
  const startCents = before.valueCents;
  const endCents = after.valueCents ?? 0n;
  const changeCents = startCents !== null && after.valueCents !== null ? after.valueCents - startCents : null;
  const summary: ChangeSummaryRecord = {
    from: q.from,
    to: q.to,
    startCents,
    endCents,
    changeCents,
    changeBp: startCents !== null && changeCents !== null ? bp(changeCents, startCents) : null,
    netFlowsCents: mine?.netFlowsCents ?? change?.netFlowsCents ?? 0n,
    growthCents: mine?.growthCents ?? null,
    growthReason: mine?.growthReason ?? null,
    incomeCents,
    uncategorizedRows,
    partial: change?.partial ?? false,
    missingAccountIds: [...(change?.missing ?? [])],
  };

  // Holdings: every security (positions and the cash security) present at either date.
  const byKey = new Map<string, { from?: (typeof before.lines)[number]; to?: (typeof after.lines)[number] }>();
  for (const l of before.lines) if (l.securityId !== null) byKey.set(l.securityId, { ...(byKey.get(l.securityId) ?? {}), from: l });
  for (const l of after.lines) if (l.securityId !== null) byKey.set(l.securityId, { ...(byKey.get(l.securityId) ?? {}), to: l });
  const holdings: HoldingChangeRecord[] = [];
  for (const [securityId, pair] of byKey) {
    const f = pair.from;
    const t = pair.to;
    const vFrom = f?.valueCents ?? 0n;
    const vTo = t?.valueCents ?? 0n;
    const qFrom = f?.quantity ?? null;
    const pTo = t?.price ?? null;
    const dollarOnly = (f !== undefined && f.kind === "position" && f.quantity === null) || (t !== undefined && t.kind === "position" && t.quantity === null);
    const priceEffect = !dollarOnly && pTo !== null && qFrom !== null ? mulToCents(qFrom, pTo) - vFrom : 0n;
    holdings.push({
      securityId,
      ticker: t?.ticker ?? f?.ticker ?? null,
      name: t?.name ?? f?.name ?? "",
      kind: t?.kind ?? f?.kind ?? "position",
      quantityFrom: qFrom,
      quantityTo: t?.quantity ?? null,
      priceFrom: f?.price ?? null,
      priceTo: pTo,
      valueFromCents: vFrom,
      valueToCents: vTo,
      deltaCents: vTo - vFrom,
      priceEffectCents: priceEffect,
      quantityEffectCents: vTo - vFrom - priceEffect,
    });
  }
  holdings.sort((a, b) => ((a.ticker ?? a.name) < (b.ticker ?? b.name) ? -1 : (a.ticker ?? a.name) > (b.ticker ?? b.name) ? 1 : 0));
  const synthetic = (v: AccountValuation) => v.lines.filter((l) => l.securityId === null).reduce((acc, l) => acc + (l.valueCents ?? 0n), 0n);
  // A balance-only (or unvalued) side has no lines: everything is residual.
  const holdingsFrom = holdings.reduce((acc, h) => acc + h.valueFromCents, 0n);
  const holdingsTo = holdings.reduce((acc, h) => acc + h.valueToCents, 0n);
  const residualEffectCents = before.lines.length === 0 || after.lines.length === 0 ? (after.valueCents ?? 0n) - (before.valueCents ?? 0n) - (holdingsTo - holdingsFrom) : synthetic(after) - synthetic(before);

  const names = new Map<string, string>();
  const counterparties = [...new Set(flows.map((f) => f.counterpartyAccountId).filter((id): id is string => id !== null))];
  if (counterparties.length > 0) {
    for (const r of await db.select({ id: account.id, name: account.name }).from(account).where(inArray(account.id, counterparties))) names.set(r.id, r.name);
  }
  const warnings: string[] = [];
  if (before.valueCents === null) warnings.push(`${acct.name} has no value on ${q.from}; the change starts from nothing`);
  if (after.valueCents === null) warnings.push(`${acct.name} has no value on ${q.to}`);
  const f = fidelities.get(accountId);
  return {
    ...accountRef(acct, f),
    from: q.from,
    to: q.to,
    summary,
    holdings,
    residualEffectCents,
    flows: flows.map((fl) => ({ ...fl, counterpartyAccountName: fl.counterpartyAccountId ? (names.get(fl.counterpartyAccountId) ?? null) : null, internal: false, internalReason: null })),
    income,
    warnings,
  };
}

// ---- Dashboard (views design §4; seams C47) ----

export interface DashboardInvestmentsBlock {
  asOf: IsoDate;
  totalCents: bigint;
  dayChangeCents: bigint | null;
  dayChangeBp: number | null;
  staleAccounts: Array<{ id: string; name: string; valuationDate: IsoDate | null }>;
  fidelityCounts: Record<InvestmentFidelity, number>;
  awaitingReconcile: number;
  securitiesNeedingReview: number;
  priceFeed: { configured: boolean; expectedDate: IsoDate; stale: number; notFound: number; error: number };
}

/** The dashboard's investments block; null without open investment accounts. */
export async function dashboardInvestments(db: DbOrTx, q: { today: IsoDate; now: Date; priceProvider: PriceProviderId | null }): Promise<DashboardInvestmentsBlock | null> {
  const ctx = await investmentContext(db, { today: q.today, now: q.now });
  if (ctx.accounts.length === 0) return null;
  const day = dayChange(ctx.input, ctx.accounts.map((a) => a.id), ctx.asOf);
  const fidelityCounts: Record<InvestmentFidelity, number> = { balance_only: 0, positions: 0, full_history: 0 };
  for (const a of ctx.accounts) fidelityCounts[a.ref.fidelity]++;

  // Accounts at positions or full history whose latest statement date has no reconciliation on or after it.
  const candidates = ctx.accounts
    .filter((a) => a.ref.fidelity !== "balance_only")
    .map((a) => {
      const f = a.fidelityRecord;
      const reported = ctx.input.balances.filter((b) => b.accountId === a.id).reduce<IsoDate | null>((acc, b) => (acc === null || b.date > acc ? b.date : acc), null);
      const snapshot = f?.lastSnapshotDate ?? null;
      const latest = [reported, snapshot].filter((d): d is IsoDate => d !== null).sort().pop() ?? null;
      return { accountId: a.id, latestStatementDate: latest };
    });
  const awaiting = await accountsAwaitingReconcile(db, candidates);
  const [review] = await db.select({ n: count() }).from(security).where(and(eq(security.needsReview, true), eq(security.archived, false)));
  const feed = await priceFeedHealth(db, { now: q.now, provider: q.priceProvider });
  return {
    asOf: ctx.asOf,
    totalCents: ctx.accounts.reduce((acc, a) => acc + (a.valuation.valueCents ?? 0n), 0n),
    dayChangeCents: day.cents,
    dayChangeBp: day.bp,
    staleAccounts: ctx.accounts.filter((a) => a.valuationRef.valuationStale).map((a) => ({ id: a.id, name: a.name, valuationDate: a.valuationRef.valuationDate })),
    fidelityCounts,
    awaitingReconcile: awaiting.length,
    securitiesNeedingReview: Number(review?.n ?? 0),
    priceFeed: { configured: feed.configured, expectedDate: feed.expectedDate, stale: feed.stale, notFound: feed.notFound, error: feed.error },
  };
}
