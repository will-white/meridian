import { sha256Hex } from "../crypto.js";
import { AssetClass, PlanBucket } from "../enums.js";
import type { BaselineChange } from "./api.js";
import type { BaselineAccount, BaselineContribution, RetirementBaseline } from "./baseline.js";
import { canonicalJson } from "./freeze.js";
import type { ClassWeights } from "./primitives.js";

/**
 * The baseline's hash and the diff between two baselines (inputs-and-data §3.2 B10, §3.6).
 *
 * `baselineHash` is what `plan_profile.baseline_hash`, `meta.baselineHash` and the refresh
 * dialog's `expectedHash` compare: the SHA-256 of the canonical JSON (§3.7) of the baseline
 * without `computedAt` and `today`, so a baseline recomputed later from the same data has the same
 * hash.
 *
 * `diffBaselines(before, after)` lists what a refresh changes, in a fixed order: `as_of`; per
 * account by name `account_added`, `account_removed`, `account_value`, `account_bucket`,
 * `account_basis`, `account_allocation`; `bucket_total` per bucket; `total`; `allocation_targets`;
 * `spending_category` per category by name; `spending_categorized`; `spending_uncategorized`;
 * `income`; `contribution` per account by name; `savings_rate`. Equal baselines give `[]`.
 * `material` (§3.6): value and total rows (with the basis and contribution rows, also amounts the
 * plan uses) when |Δ| is at least 1,000.00 or at least 1% of the before value; spending rows when
 * |Δ| is at least 2% of the before categorized spending; allocation rows when any class moved by
 * 200 bp or more; an added, removed or re-bucketed account always; the as-of date, income and the
 * measured savings rate never (the plan does not read them). Ratios are compared in integers.
 */

/** The baseline without the fields that say when it was computed rather than what it holds. */
export function hashableBaseline(baseline: RetirementBaseline): unknown {
  const { computedAt: _computedAt, today: _today, ...rest } = baseline;
  return rest;
}

/** `plan_profile.baseline_hash`: SHA-256 of the canonical JSON of `hashableBaseline`, lower-case hex. */
export function baselineHash(baseline: RetirementBaseline): Promise<string> {
  return sha256Hex(canonicalJson(hashableBaseline(baseline)));
}

/** A value row is material at a change of at least this many cents (§3.6: 1,000.00). */
export const MATERIAL_VALUE_CENTS = 100_000n;
/** … or at least this share of the before value, in percent. */
export const MATERIAL_VALUE_PERCENT = 1n;
/** A spending row is material at a change of at least this share of the before categorized spending, in percent. */
export const MATERIAL_SPENDING_PERCENT = 2n;
/** An allocation row is material when a class moved by at least this many basis points. */
export const MATERIAL_ALLOCATION_BP = 200;

const BUCKET_LABEL: Record<PlanBucket, string> = { taxable: "Taxable", pre_tax: "Pre-tax", roth: "Roth", hsa: "HSA", cash: "Cash" };
const CLASSES = AssetClass.options;

const abs = (v: bigint) => (v < 0n ? -v : v);
const big = (v: string | undefined) => (v === undefined ? undefined : BigInt(v));

function valueMaterial(before: bigint | undefined, after: bigint | undefined): boolean {
  const b = before ?? 0n;
  const delta = abs((after ?? 0n) - b);
  return delta >= MATERIAL_VALUE_CENTS || delta * 100n >= MATERIAL_VALUE_PERCENT * abs(b);
}

/** A row with before, after and delta cents (each present when its side is). */
function amounts(before: bigint | undefined, after: bigint | undefined): Pick<BaselineChange, "beforeCents" | "afterCents" | "deltaCents"> {
  const out: Pick<BaselineChange, "beforeCents" | "afterCents" | "deltaCents"> = {};
  if (before !== undefined) out.beforeCents = before.toString();
  if (after !== undefined) out.afterCents = after.toString();
  if (before !== undefined && after !== undefined) out.deltaCents = (after - before).toString();
  return out;
}

function byName<T>(items: Iterable<T>, name: (t: T) => string, id: (t: T) => string): T[] {
  return [...items].sort((a, b) => {
    const na = name(a);
    const nb = name(b);
    if (na !== nb) return na < nb ? -1 : 1;
    const ia = id(a);
    const ib = id(b);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

/** The classes that moved, as `us_stock 6839 → 6900`; `[]` when equal; `null` when one side has no weights. */
function weightMoves(before: ClassWeights | undefined, after: ClassWeights | undefined): { note: string; maxMove: number } | null | undefined {
  if (before === undefined && after === undefined) return undefined;
  if (before === undefined || after === undefined) return null;
  const moved = CLASSES.filter((c) => before[c] !== after[c]);
  if (moved.length === 0) return undefined;
  return {
    note: moved.map((c) => `${c} ${before[c]} → ${after[c]}`).join(", "),
    maxMove: Math.max(...moved.map((c) => Math.abs(after[c] - before[c]))),
  };
}

function allocationRow(kind: string, path: string, label: string, before: ClassWeights | undefined, after: ClassWeights | undefined, accountId?: string): BaselineChange | undefined {
  const moves = weightMoves(before, after);
  if (moves === undefined) return undefined;
  const row: BaselineChange =
    moves === null
      ? { kind, path, label, note: before === undefined ? "weights measured" : "weights no longer measured", material: true }
      : { kind, path, label, note: moves.note, material: moves.maxMove >= MATERIAL_ALLOCATION_BP };
  if (accountId !== undefined) row.accountId = accountId;
  return row;
}

/** The yearly contribution the plan would use live (inputs §3.4 R9): the measured net, the recurring plan, or nothing. */
function liveContribution(c: BaselineContribution | undefined): bigint | undefined {
  if (c === undefined) return undefined;
  if (c.source === "measured") return BigInt(c.annualNetCents ?? "0");
  if (c.source === "recurring") return BigInt(c.plannedCents);
  return 0n;
}

function accountRows(id: string, before: BaselineAccount | undefined, after: BaselineAccount | undefined): BaselineChange[] {
  const label = (after ?? before)!.name;
  const at = `accounts.${id}`;
  if (before === undefined) return [{ kind: "account_added", path: at, label, accountId: id, ...amounts(undefined, big(after!.valueCents)), material: true }];
  if (after === undefined) return [{ kind: "account_removed", path: at, label, accountId: id, ...amounts(big(before.valueCents), undefined), material: true }];
  const rows: BaselineChange[] = [];
  const vb = big(before.valueCents);
  const va = big(after.valueCents);
  if (vb !== va) rows.push({ kind: "account_value", path: `${at}.valueCents`, label, accountId: id, ...amounts(vb, va), material: valueMaterial(vb, va) });
  if (before.bucket !== after.bucket) {
    rows.push({ kind: "account_bucket", path: `${at}.bucket`, label, accountId: id, note: `${before.bucket ?? "none"} → ${after.bucket ?? "none"}`, material: true });
  }
  const bb = before.basis;
  const ba = after.basis;
  if (bb !== undefined || ba !== undefined) {
    const kb = big(bb?.knownCents);
    const ka = big(ba?.knownCents);
    const notes: string[] = [];
    if (bb?.coverage !== ba?.coverage) notes.push(`coverage ${bb?.coverage ?? "none"} → ${ba?.coverage ?? "none"}`);
    if (bb?.unknownValueCents !== ba?.unknownValueCents) notes.push(`unknown value ${bb?.unknownValueCents ?? "0"} → ${ba?.unknownValueCents ?? "0"}`);
    if (kb !== ka || notes.length > 0) {
      const row: BaselineChange = { kind: "account_basis", path: `${at}.basis`, label, accountId: id, ...amounts(kb, ka), material: valueMaterial(kb, ka) };
      if (notes.length > 0) row.note = notes.join(", ");
      rows.push(row);
    }
  }
  const allocation = allocationRow("account_allocation", `${at}.weights`, label, before.weights, after.weights, id);
  if (allocation !== undefined) rows.push(allocation);
  return rows;
}

/**
 * What changed between two baselines (see the file comment). `before` is null when there was no
 * stored baseline: every planner account is then added and every amount is new.
 */
export function diffBaselines(before: RetirementBaseline | null, after: RetirementBaseline): BaselineChange[] {
  const rows: BaselineChange[] = [];
  if (before !== null && before.asOf !== after.asOf) {
    rows.push({ kind: "as_of", path: "asOf", label: "Balances as of", note: `${before.asOf} → ${after.asOf}`, material: false });
  }

  // Accounts: those with a planner bucket on either side.
  const accountsBefore = new Map((before?.accounts ?? []).filter((a) => a.bucket !== undefined).map((a) => [a.accountId, a]));
  const accountsAfter = new Map(after.accounts.filter((a) => a.bucket !== undefined).map((a) => [a.accountId, a]));
  const ids = new Set([...accountsBefore.keys(), ...accountsAfter.keys()]);
  const nameOf = (id: string) => (accountsAfter.get(id) ?? accountsBefore.get(id))!.name;
  for (const id of byName(ids, nameOf, (x) => x)) rows.push(...accountRows(id, accountsBefore.get(id), accountsAfter.get(id)));

  for (const bucket of PlanBucket.options) {
    const b = big(before?.totals.byBucket[bucket]);
    const a = big(after.totals.byBucket[bucket]);
    if ((b ?? 0n) !== (a ?? 0n)) {
      rows.push({ kind: "bucket_total", path: `totals.byBucket.${bucket}`, label: BUCKET_LABEL[bucket], ...amounts(b ?? 0n, a ?? 0n), material: valueMaterial(b, a) });
    }
  }
  const totalBefore = big(before?.totals.totalCents);
  const totalAfter = BigInt(after.totals.totalCents);
  if (totalBefore !== totalAfter) {
    rows.push({ kind: "total", path: "totals.totalCents", label: "All plan accounts", ...amounts(totalBefore, totalAfter), material: valueMaterial(totalBefore, totalAfter) });
  }
  const targets = allocationRow("allocation_targets", "allocationTargets", "Household allocation targets", before?.allocationTargets, after.allocationTargets);
  if (targets !== undefined) rows.push(targets);

  // Spending: material against 2% of the before categorized spending.
  const spendingBase = abs(big(before?.spending.categorizedCents) ?? 0n);
  const spendingMaterial = (b: bigint | undefined, a: bigint | undefined) => abs((a ?? 0n) - (b ?? 0n)) * 100n >= MATERIAL_SPENDING_PERCENT * spendingBase;
  const catsBefore = new Map((before?.spending.byCategory ?? []).map((c) => [c.categoryId, c]));
  const catsAfter = new Map(after.spending.byCategory.map((c) => [c.categoryId, c]));
  const catIds = new Set([...catsBefore.keys(), ...catsAfter.keys()]);
  const catName = (id: string) => (catsAfter.get(id) ?? catsBefore.get(id))!.name;
  for (const id of byName(catIds, catName, (x) => x)) {
    const b = big(catsBefore.get(id)?.cents);
    const a = big(catsAfter.get(id)?.cents);
    if (b !== a) rows.push({ kind: "spending_category", path: `spending.byCategory.${id}`, label: catName(id), ...amounts(b, a), material: spendingMaterial(b, a) });
  }
  const catBefore = big(before?.spending.categorizedCents);
  const catAfter = BigInt(after.spending.categorizedCents);
  if (catBefore !== catAfter) {
    rows.push({ kind: "spending_categorized", path: "spending.categorizedCents", label: "Categorized spending", ...amounts(catBefore, catAfter), material: spendingMaterial(catBefore, catAfter) });
  }
  const ub = before?.spending.uncategorized;
  const ua = after.spending.uncategorized;
  if (ub === undefined || ub.count !== ua.count || ub.outflowCents !== ua.outflowCents || ub.inflowCents !== ua.inflowCents) {
    const notes: string[] = [];
    if (ub?.count !== ua.count) notes.push(`count ${ub?.count ?? 0} → ${ua.count}`);
    if (ub?.inflowCents !== ua.inflowCents) notes.push(`inflows ${ub?.inflowCents ?? "0"} → ${ua.inflowCents}`);
    const b = big(ub?.outflowCents);
    const a = BigInt(ua.outflowCents);
    const row: BaselineChange = { kind: "spending_uncategorized", path: "spending.uncategorized", label: "Uncategorized outflows", ...amounts(b, a), material: spendingMaterial(b, a) };
    if (notes.length > 0) row.note = notes.join(", ");
    rows.push(row);
  }

  const ib = before?.income;
  const ia = after.income;
  if (ib === undefined || ib.takeHomeCents !== ia.takeHomeCents || ib.investmentIncomeCents !== ia.investmentIncomeCents) {
    const row: BaselineChange = { kind: "income", path: "income.takeHomeCents", label: "Take-home pay", ...amounts(big(ib?.takeHomeCents), BigInt(ia.takeHomeCents)), material: false };
    if (ib?.investmentIncomeCents !== ia.investmentIncomeCents) row.note = `investment income ${ib?.investmentIncomeCents ?? "0"} → ${ia.investmentIncomeCents}`;
    rows.push(row);
  }

  // Contributions: the yearly amount the plan would use live.
  const contribBefore = new Map((before?.contributions ?? []).map((c) => [c.accountId, c]));
  const contribAfter = new Map(after.contributions.map((c) => [c.accountId, c]));
  const contribIds = new Set([...contribBefore.keys(), ...contribAfter.keys()]);
  const accountName = (id: string) => accountsAfter.get(id)?.name ?? accountsBefore.get(id)?.name ?? after.accounts.find((a) => a.accountId === id)?.name ?? id;
  for (const id of byName(contribIds, accountName, (x) => x)) {
    const cb = contribBefore.get(id);
    const ca = contribAfter.get(id);
    const b = liveContribution(cb);
    const a = liveContribution(ca);
    if (b === a && cb?.source === ca?.source) continue;
    const row: BaselineChange = { kind: "contribution", path: `contributions.${id}`, label: accountName(id), accountId: id, ...amounts(b, a), material: valueMaterial(b, a) };
    if (cb?.source !== ca?.source) row.note = `source ${cb?.source ?? "none"} → ${ca?.source ?? "none"}`;
    rows.push(row);
  }

  const rb = before?.savingsRate.bp;
  const ra = after.savingsRate.bp;
  if (before === null ? ra !== undefined : rb !== ra) {
    rows.push({ kind: "savings_rate", path: "savingsRate.bp", label: "Measured savings rate", note: `${rb ?? "none"} → ${ra ?? "none"} bp`, material: false });
  }
  return rows;
}
