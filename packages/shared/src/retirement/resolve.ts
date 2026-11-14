import { dayDiff, type IsoDate } from "../dates.js";
import { allocateLargestRemainder } from "../decimal.js";
import { AssetClass, PlanBucket, type OwnerId, type PersonId } from "../enums.js";
import { maxMonth, truncDiv, type MonthKey } from "../months.js";
import type { EffectiveInputsView } from "./api.js";
import type { BaselineAccount, BaselineContribution, RetirementBaseline } from "./baseline.js";
import { ageMonth, planStart } from "./clock.js";
import { inputHash } from "./freeze.js";
import {
  SIM_INPUT_SCHEMA,
  SimInput,
  SYNTHETIC_CASH_ACCOUNT_ID,
  syntheticRothAccountId,
  type PlanProvenance,
  type SimInputAccount,
  type SimInputContribution,
  type SimInputConversion,
  type SimInputGoal,
  type SimInputHealthcare,
  type SimInputIncome,
  type SimInputPerson,
  type SimInputSocialSecurityPerson,
} from "./input.js";
import { effectiveProfileDoc, isPlainObject } from "./mergePatch.js";
import { BASELINE_MAX_DAYS, BASELINE_STALE_DAYS, MAX_EXPENSE_RATIO_PPM, PLAN_LIMITS, type ClassWeights, type PlanIssue } from "./primitives.js";
import type { AccountSetting, ContributionSetting, GlidePath, IncomeStream, Person, RetirementProfileDoc, When } from "./profile.js";
import type { RunSettings } from "./settings.js";
import { classWeights } from "./weights.js";

/**
 * The resolver (inputs-and-data §3.4, §3.5, §4.6, decision 6, with seams §2.1, C13, C24, C25, C35):
 * profile document + scenario overrides + stored baseline + run settings → the frozen run input
 * (`SimInput`, §4.5) and the plan's issues. One pure, synchronous function: the API's preview, the
 * run freezer, the web form's inline validation and the tests all call it. It reads no clock and
 * no database; the engine's facts (data version, rule sets, the first tax year, the contribution
 * limits and the engine's own `validateInput`) come in through `ctx`, so shared never imports the
 * engine (§6.1, C47).
 *
 * Rounding: sums of cents are exact; annualizing and percent-of-salary amounts truncate toward
 * zero (`truncDiv`); class weights use largest remainder (`allocateLargestRemainder`).
 *
 * The steps, in the order issues are reported:
 *
 * - R1 the effective document (`override_invalid`, nothing else is resolved);
 * - R2 the plan start (`planStart`), the baseline's age and the first tax year;
 * - R3 the people, retirement months, the horizon (`plan.endYear` is the last year any person can
 *   be alive, which is the engine's mortality horizon, C28);
 * - R4 the accounts: inclusion, balance, owner, allocation, glide path, basis, Roth basis, the fund
 *   cost (C25: typed, else measured, else 0 with `expense_ratio_unknown`), the baseline's flags;
 * - R10 the Roth conversions (resolved here because R5 depends on them);
 * - R5 the synthetic accounts: a Roth account for a person who converts and has none, and
 *   `synthetic:cash` when no taxable or cash account is included (C24);
 * - R6 the income streams, R7 Social Security, R8 spending (with C35's healthcare `inBase` and
 *   `hsa_no_medical`), R9 contributions, R11 the settings;
 * - the engine's limits (C13): accounts with the synthetic ones, income streams, conversions, the
 *   horizon and, for the models whose path count is the request, the path-years;
 * - R12 assembly: arrays sorted, `SimInput.parse`, then `ctx.validateInput` (the engine's, when
 *   given), each of whose issues becomes an error issue (C13). `input` is absent when any issue is
 *   an error.
 */

// ---- The planner environment (§6.1) and the resolver's context (§4.6) ----

export type ContributionLimitKind = "employer_plan" | "ira" | "hsa_family";
/** The full-year limit in cents of a published tax year, or null when the year is not published (tax-rmd-ss §4.1 `contributionLimit`). */
export type ContributionLimitFn = (year: number, age: number, kind: ContributionLimitKind) => bigint | null;
/** One issue of the engine's `validateInput` (seams §2.4). */
export interface EngineIssue {
  readonly code: string;
  readonly message: string;
}
/** The engine's size limits (`PLAN_LIMITS`). */
export interface PlanLimits {
  readonly maxAccounts: number;
  readonly maxIncomes: number;
  readonly maxConversions: number;
  readonly maxYears: number;
  readonly maxPathYears: number;
}

/**
 * The engine's facts, built once by the API and the worker from `@meridian/retirement` and passed
 * into `packages/db`'s services, which never import the engine (inputs decision 8, §6.1, seams
 * C13). The browser builds the same shape from `GET /meta` without the two functions (C47): its
 * `contribution_over_limit` warning and the engine's issues come from the server's issue list.
 */
export interface PlannerEnv {
  engineVersion: string;
  dataVersion: string;
  ruleSets: readonly string[];
  /** The first year of the tax data (`TAX_DATA_FIRST_YEAR`). */
  minStartYear: number;
  /** Default `PLAN_LIMITS`. */
  limits?: PlanLimits;
  contributionLimit?: ContributionLimitFn;
  /** The engine's `validateInput`: `prepare` without throwing. */
  validateInput?: (input: SimInput) => readonly EngineIssue[];
}

/** What the frozen input's `meta` records besides the dates (§4.5). */
export interface ResolveMeta {
  createdAt: string;
  profileRevision: number;
  baselineHash: string;
  scenarioId: string;
  scenarioRevision: number;
  scenarioName: string;
}

export interface ResolveContext extends Omit<PlannerEnv, "engineVersion"> {
  /** The client's date (`resolveToday`): the baseline's age is counted to it. */
  today: IsoDate;
  meta: ResolveMeta;
}

export interface ResolveArgs {
  /** The profile document (`plan_profile.doc`). */
  doc: RetirementProfileDoc;
  baseline: RetirementBaseline;
  /** The scenario's merge patch over `doc`; `{}` for the profile itself. */
  overrides: Readonly<Record<string, unknown>>;
  settings: RunSettings;
}

/** One account as the form shows it (§4.6 `EffectiveInputs`). */
export interface EffectiveAccount {
  accountId: string;
  included: boolean;
  bucket: (typeof PlanBucket.options)[number];
  owner?: OwnerId;
  balanceCents: bigint;
  basisCents?: bigint;
  basisCoverage?: SimInputAccount["basisCoverage"];
  allocation?: ClassWeights;
  allocationSource?: SimInputAccount["allocationSource"];
  expenseRatioPpm?: number;
}

/** The effective starting values of a plan (bigint here; `effectiveInputsView` gives the wire shape). */
export interface EffectiveInputs {
  includedTotalCents: bigint;
  byBucketCents: Record<(typeof PlanBucket.options)[number], bigint>;
  baseSpendingCents: bigint;
  essentialSpendingCents: bigint;
  /** Employee plus employer, year 0. */
  contributionsCents: bigint;
  employerCents: bigint;
  /** `truncDiv(contributions × 10000, the household's gross salary)`; absent without a salary. */
  planSavingsRateBp?: number;
  accounts: EffectiveAccount[];
}

export interface ResolveResult {
  /** Absent when any issue is an error. */
  input?: SimInput;
  issues: PlanIssue[];
  /** Absent only when the overrides no longer apply. */
  effective?: EffectiveInputs;
  /** The effective document; absent when the overrides no longer apply. */
  doc?: RetirementProfileDoc;
}

/** The resolver's error codes (§3.5, with seams C13's limits and `input_invalid`); the engine's codes are added as they come. */
export const PLAN_ERROR_CODES = [
  "override_invalid",
  "owner_required",
  "no_accounts",
  "unknown_person",
  "planning_age_low",
  "claim_in_past",
  "spending_missing",
  "stream_window",
  "salary_duplicate",
  "phase_order",
  "glide_order",
  "goal_in_past",
  "conversion_no_pretax",
  "conversion_in_past",
  "conversion_overlap",
  "unknown_rule_set",
  "baseline_too_old",
  "start_year_unsupported",
  "too_many_accounts",
  "too_many_incomes",
  "too_many_conversions",
  "horizon_too_long",
  "path_years_too_many",
  "input_invalid",
] as const;

/** The resolver's warning codes (§3.5, with seams C25's `expense_ratio_unknown` and C35's `hsa_no_medical`). */
export const PLAN_WARNING_CODES = [
  "baseline_stale",
  "valuation_stale",
  "account_no_value",
  "account_unreviewed",
  "dangling_account_setting",
  "tax_treatment_defaulted",
  "cash_account_treatment",
  "negative_balance",
  "basis_unknown",
  "basis_above_value",
  "allocation_assumed",
  "expense_ratio_unknown",
  "uncategorized_in_spending",
  "spending_short_history",
  "contribution_partial_window",
  "irregular_contributions",
  "contribution_unmeasured",
  "contribution_from_recurring",
  "match_unknown",
  "salary_missing",
  "already_retired",
  "contribution_over_limit",
  "ss_missing",
  "healthcare_zero",
  "hsa_no_medical",
  "goal_before_retirement",
] as const;

/** The allocation of an account nothing else describes (R4): 60% US stock, 40% bonds. */
export const ASSUMED_ALLOCATION: ClassWeights = { us_stock: 6000, intl_stock: 0, bonds: 4000, cash: 0, real_estate: 0, other: 0 };
const CASH_ALLOCATION: ClassWeights = { us_stock: 0, intl_stock: 0, bonds: 0, cash: 10000, real_estate: 0, other: 0 };
export const SYNTHETIC_ROTH_NAME = "Roth (for conversions)";
export const SYNTHETIC_CASH_NAME = "Cash (surplus)";
/** Live spending needs this many full months of ledger (R8). */
const MIN_SPENDING_MONTHS = 3;
const YEAR_MONTHS = 12n;
const BP = 10000n;
const CLASSES = AssetClass.options;
const LIVE = { mode: "live" } as const;

/** Cents as dollars with thousands separators, locale-free: 120000n → "1,200.00". */
export function formatPlanDollars(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${whole}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/** True when the merge patch sets, replaces or deletes the value at `path` (a prefix replaced by a scalar or deleted counts). */
function touches(patch: unknown, path: readonly string[]): boolean {
  let node = patch;
  for (const key of path) {
    if (!isPlainObject(node)) return node !== undefined;
    if (!Object.hasOwn(node, key) || node[key] === undefined) return false;
    node = node[key];
  }
  return true;
}

const big = (v: string | undefined): bigint => (v === undefined ? 0n : BigInt(v));
const max0 = (v: bigint): bigint => (v > 0n ? v : 0n);
const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sortedKeys = (o: Readonly<Record<string, unknown>>) => Object.keys(o).sort();

interface ResolvedPerson {
  id: PersonId;
  person: Person;
  retirementMonth: MonthKey;
  retired: boolean;
}

interface AccountDraft {
  baseline: BaselineAccount;
  setting: AccountSetting;
  bucket: (typeof PlanBucket.options)[number];
  included: boolean;
  balance: bigint;
  owner?: OwnerId;
}

/**
 * Resolves a plan (see the file comment). Never throws on what an owner can type: everything that
 * blocks a run is an error issue. `ctx.validateInput` is called only on an input the resolver
 * itself accepts; an exception it throws (an engine fault, not an input error) propagates.
 */
export function resolvePlan(args: ResolveArgs, ctx: ResolveContext): ResolveResult {
  const issues: PlanIssue[] = [];
  const add = (severity: PlanIssue["severity"], code: string, path: string, message: string, accountId?: string) => {
    const issue: PlanIssue = { code, severity, path, message };
    if (accountId !== undefined) issue.accountId = accountId;
    issues.push(issue);
  };
  const error = (code: string, path: string, message: string, accountId?: string) => add("error", code, path, message, accountId);
  const warn = (code: string, path: string, message: string, accountId?: string) => add("warning", code, path, message, accountId);
  const limits = ctx.limits ?? PLAN_LIMITS;
  const { baseline, settings, overrides } = args;
  const provenance: Record<string, PlanProvenance> = {};
  const typed = (path: readonly string[]): PlanProvenance => (touches(overrides, path) ? "scenario" : "profile");

  // R1. The effective document.
  const effectiveDoc = effectiveProfileDoc(args.doc, overrides);
  if (!effectiveDoc.ok) {
    error("override_invalid", effectiveDoc.path, `The scenario's changes no longer apply to the profile: ${effectiveDoc.message}`);
    return { issues };
  }
  const doc = effectiveDoc.doc;

  // R2. Plan start and the baseline's age.
  const start = planStart(baseline.asOf);
  const { startYear, startMonth, firstYearMonths } = start;
  const ageDays = dayDiff(baseline.asOf, ctx.today);
  if (ageDays > BASELINE_MAX_DAYS) {
    error("baseline_too_old", "baseline", `The balances are from ${baseline.asOf}, ${ageDays} days ago; refresh them from live data (at most ${BASELINE_MAX_DAYS} days).`);
  } else if (ageDays > BASELINE_STALE_DAYS) {
    warn("baseline_stale", "baseline", `The balances are from ${baseline.asOf}, ${ageDays} days ago.`);
  }
  if (startYear < ctx.minStartYear) {
    error("start_year_unsupported", "baseline", `The plan would start in ${startYear}; the tax data starts in ${ctx.minStartYear}.`);
  }

  // R3. People.
  const people: ResolvedPerson[] = [];
  const addPerson = (id: PersonId, person: Person | undefined) => {
    if (person === undefined) return;
    const retirementMonth = person.retirementMonth ?? ageMonth(person.birthYear, person.birthMonth, person.retirementAge);
    people.push({ id, person, retirementMonth, retired: retirementMonth <= startMonth });
  };
  addPerson("p1", doc.people.p1);
  addPerson("p2", doc.people.p2);
  const personOf = (id: PersonId) => people.find((p) => p.id === id);
  const reported = new Set<string>();
  /** The person, or undefined with `unknown_person` once per path when the household does not have them. */
  const known = (id: PersonId, path: string): ResolvedPerson | undefined => {
    const p = personOf(id);
    if (p === undefined && !reported.has(path)) {
      reported.add(path);
      error("unknown_person", path, `${id} is not in this household.`);
    }
    return p;
  };
  const filingStatus = people.length === 2 ? "married_joint" : "single";
  let endYear = startYear;
  for (const p of people) {
    const lastAge = p.person.longevity.mode === "fixed" ? p.person.longevity.age : p.person.longevity.maxAge;
    const lastYear = p.person.birthYear + lastAge;
    if (lastYear <= startYear) {
      error("planning_age_low", `people.${p.id}.longevity`, `${p.person.name} reaches ${lastAge} in ${lastYear}, before the plan starts in ${startYear}.`);
    }
    if (lastYear > endYear) endYear = lastYear;
  }
  const years = endYear - startYear + 1;
  const latestRetirement = people.reduce((m, p) => maxMonth(m, p.retirementMonth), people[0]!.retirementMonth);

  // R4. Accounts.
  const drafts: AccountDraft[] = [];
  const baselineIds = new Set(baseline.accounts.map((a) => a.accountId));
  for (const id of sortedKeys(doc.accounts)) {
    if (!baselineIds.has(id)) warn("dangling_account_setting", `accounts.${id}`, "This account setting names an account that is no longer in the live data; it is ignored.", id);
  }
  for (const id of sortedKeys(doc.contributions)) {
    if (!baselineIds.has(id)) warn("dangling_account_setting", `contributions.${id}`, "This contribution setting names an account that is no longer in the live data; it is ignored.", id);
  }
  for (const account of [...baseline.accounts].sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0))) {
    if (account.bucket === undefined) continue;
    const id = account.accountId;
    const setting = doc.accounts[id] ?? {};
    if (doc.accounts[id] === undefined) warn("account_unreviewed", `accounts.${id}`, `${account.name} is new since the profile was saved; it is included with the defaults.`, id);
    let included = setting.include !== false;
    if (included && account.valueCents === undefined) {
      included = false;
      warn("account_no_value", `accounts.${id}`, `${account.name} has no value in the live data and is left out of the plan.`, id);
    }
    drafts.push({ baseline: account, setting, bucket: account.bucket, included, balance: max0(big(account.valueCents)) });
  }

  // Owners (§3.1): the only person of a one-person household; joint for taxable and cash accounts
  // of a couple; required for a couple's pre-tax, Roth and HSA accounts, which cannot be joint.
  for (const d of drafts) {
    if (!d.included) continue;
    const id = d.baseline.accountId;
    const path = `accounts.${id}.owner`;
    const personal = d.bucket === "pre_tax" || d.bucket === "roth" || d.bucket === "hsa";
    const owner = d.setting.owner;
    if (owner === undefined) {
      if (people.length === 1) d.owner = "p1";
      else if (personal) error("owner_required", path, `Choose whose account ${d.baseline.name} is.`, id);
      else d.owner = "joint";
      if (d.owner !== undefined) provenance[`accounts.${id}.owner`] = "default";
      continue;
    }
    if (people.length === 1 && owner !== "p1") {
      if (!reported.has(path)) {
        reported.add(path);
        error("unknown_person", path, owner === "joint" ? "A one-person household has no joint accounts." : `${owner} is not in this household.`, id);
      }
      continue;
    }
    if (owner === "joint" && personal) {
      error("owner_required", path, `${d.baseline.name} is a ${d.bucket === "pre_tax" ? "pre-tax" : d.bucket === "roth" ? "Roth" : "HSA"} account and needs one owner.`, id);
      continue;
    }
    d.owner = owner;
    provenance[`accounts.${id}.owner`] = typed(["accounts", id, "owner"]);
  }

  const included = drafts.filter((d) => d.included);
  if (included.length === 0) error("no_accounts", "accounts", "No account is included in the plan.");

  // The household's actual mix over the included classified accounts (R4's fifth fallback).
  const summed: Partial<Record<(typeof CLASSES)[number], bigint>> = {};
  for (const d of included) {
    const cc = d.baseline.classCents;
    if (cc === undefined) continue;
    for (const c of CLASSES) summed[c] = (summed[c] ?? 0n) + big(cc[c]);
  }
  const householdActual = classWeights(summed);

  // Glide paths: the household's once, an account's own per account.
  const glideCache = new Map<GlidePath, SimInputAccount["glidePath"] | null>();
  const resolveGlide = (gp: GlidePath, path: string): SimInputAccount["glidePath"] | null => {
    const cached = glideCache.get(gp);
    if (cached !== undefined) return cached;
    let out: SimInputAccount["glidePath"] | null = null;
    const ref = known(gp.reference, `${path}.reference`);
    const ascending = gp.points.every((pt, k) => k === 0 || pt.age > gp.points[k - 1]!.age);
    if (!ascending) error("glide_order", `${path}.points`, "The glide path's ages must be in strictly ascending order.");
    if (ref !== undefined && ascending) out = gp.points.map((pt) => ({ year: ref.person.birthYear + pt.age, weights: { ...pt.weights } }));
    glideCache.set(gp, out);
    return out;
  };

  const accounts: SimInputAccount[] = [];
  const effectiveAccounts: EffectiveAccount[] = [];
  for (const d of drafts) {
    const a = d.baseline;
    const id = a.accountId;
    const at = `accounts.${id}`;
    const eff: EffectiveAccount = { accountId: id, included: d.included, bucket: d.bucket, balanceCents: d.balance };
    effectiveAccounts.push(eff);
    if (!d.included) continue;
    provenance[`${at}.balance`] = "live";

    // Allocation, first match.
    let allocation: ClassWeights;
    let source: SimInputAccount["allocationSource"];
    if (d.setting.allocation !== undefined) {
      allocation = d.setting.allocation;
      source = "override";
      provenance[`${at}.allocation`] = typed(["accounts", id, "allocation"]);
    } else if (a.weights !== undefined) {
      allocation = a.weights;
      source = "holdings";
      provenance[`${at}.allocation`] = "live";
    } else if (d.bucket === "cash") {
      allocation = CASH_ALLOCATION;
      source = "cash";
      provenance[`${at}.allocation`] = "live";
    } else if (doc.allocation.unclassified !== undefined) {
      allocation = doc.allocation.unclassified;
      source = "profile_default";
      provenance[`${at}.allocation`] = typed(["allocation", "unclassified"]);
    } else {
      if (baseline.allocationTargets !== undefined) {
        allocation = baseline.allocationTargets;
        source = "household_target";
      } else if (householdActual !== undefined) {
        allocation = householdActual;
        source = "household_actual";
      } else {
        allocation = ASSUMED_ALLOCATION;
        source = "assumed";
      }
      provenance[`${at}.allocation`] = "default";
      const what = source === "household_target" ? "the household's allocation targets" : source === "household_actual" ? "the household's actual mix" : "60% US stock and 40% bonds";
      warn("allocation_assumed", `${at}.allocation`, `What ${a.name} (${formatPlanDollars(d.balance)}) is invested in is unknown; the plan uses ${what}.`, id);
    }

    const account: SimInputAccount = {
      id,
      name: a.name,
      type: a.type,
      bucket: d.bucket,
      owner: d.owner ?? "joint",
      balanceCents: d.balance.toString(),
      allocation: { ...allocation },
      allocationSource: source,
      expenseRatioPpm: 0,
      synthetic: false,
    };

    // Glide path (never for cash).
    if (d.bucket !== "cash") {
      const own = d.setting.glidePath;
      const gp = own ?? doc.allocation.glidePath;
      if (gp !== undefined) {
        const resolved = resolveGlide(gp, own !== undefined ? `${at}.glidePath` : "allocation.glidePath");
        if (resolved) account.glidePath = resolved;
      }
    }

    // Basis (taxable only).
    if (d.bucket === "taxable") {
      if (d.setting.basisCents !== undefined) {
        const basis = BigInt(d.setting.basisCents);
        account.basisCents = basis.toString();
        account.basisCoverage = "manual";
        provenance[`${at}.basis`] = typed(["accounts", id, "basisCents"]);
        if (basis > d.balance) {
          warn("basis_above_value", `${at}.basisCents`, `The cost basis entered for ${a.name} (${formatPlanDollars(basis)}) is above its value (${formatPlanDollars(d.balance)}): an unrealized loss.`, id);
        }
      } else {
        const known = a.basis === undefined ? 0n : max0(BigInt(a.basis.knownCents));
        const unknown = a.basis === undefined ? d.balance : max0(BigInt(a.basis.unknownValueCents));
        account.basisCents = known.toString();
        account.basisCoverage = a.basis?.coverage ?? "none";
        provenance[`${at}.basis`] = a.basis === undefined ? "default" : "live";
        if (unknown > 0n) {
          warn("basis_unknown", `${at}.basisCents`, `The cost basis of ${formatPlanDollars(unknown)} in ${a.name} is unknown and counts as 0; enter it to avoid overstating tax.`, id);
        }
      }
    }
    if (d.bucket === "roth" && d.setting.rothContributionBasisCents !== undefined) account.rothContributionBasisCents = d.setting.rothContributionBasisCents;

    // Fund cost (C25): typed, else measured, else 0 with a warning (bank accounts hold no fund).
    if (d.setting.expenseRatioPpm !== undefined) {
      account.expenseRatioPpm = d.setting.expenseRatioPpm;
      provenance[`${at}.expenseRatio`] = typed(["accounts", id, "expenseRatioPpm"]);
    } else if (a.expenseRatio !== undefined) {
      account.expenseRatioPpm = Math.min(a.expenseRatio.ppm, MAX_EXPENSE_RATIO_PPM);
      provenance[`${at}.expenseRatio`] = "live";
    } else if (d.bucket !== "cash") {
      provenance[`${at}.expenseRatio`] = "default";
      warn("expense_ratio_unknown", `${at}.expenseRatioPpm`, `The fund costs of ${a.name} are unknown; the plan deducts none. Enter its expense ratio if you know it.`, id);
    }

    // The baseline's flags.
    if (a.treatmentDefaulted) warn("tax_treatment_defaulted", at, `${a.name} has no tax treatment; the plan treats it as ${d.bucket === "pre_tax" ? "pre-tax" : d.bucket}. Set it on the Accounts page.`, id);
    if (d.bucket === "cash" && a.taxTreatment !== "none") {
      warn("cash_account_treatment", at, `${a.name} is a bank account, so the plan treats it as cash; change its type on the Accounts page if it is an HSA or IRA.`, id);
    }
    if (big(a.valueCents) < 0n) warn("negative_balance", at, `${a.name} has a negative balance (${formatPlanDollars(big(a.valueCents))}); the plan counts 0.`, id);
    if (a.stale) warn("valuation_stale", at, `The value of ${a.name} is out of date${a.valuationDate === undefined ? "" : ` (${a.valuationDate})`}.`, id);

    accounts.push(account);
    if (d.owner !== undefined) eff.owner = d.owner;
    if (account.basisCents !== undefined) eff.basisCents = BigInt(account.basisCents);
    if (account.basisCoverage !== undefined) eff.basisCoverage = account.basisCoverage;
    eff.allocation = account.allocation;
    eff.allocationSource = account.allocationSource;
    eff.expenseRatioPpm = account.expenseRatioPpm;
  }

  const ownerIs = (acct: SimInputAccount, pid: PersonId) => acct.owner === pid;
  const hasOwnedAccount = (pid: PersonId, bucket: string) => included.some((d) => d.bucket === bucket && d.owner === pid);

  // R10. Roth conversions (one entry a year).
  const conversions: SimInputConversion[] = [];
  const convertsFor = new Set<PersonId>();
  const conversionYears = new Set<string>();
  for (const id of sortedKeys(doc.rothConversions)) {
    const c = doc.rothConversions[id]!;
    const at = `rothConversions.${id}`;
    if (known(c.personId, `${at}.personId`) === undefined) continue;
    if (c.fromYear < startYear) {
      error("conversion_in_past", `${at}.fromYear`, `A conversion from ${c.fromYear} is before the plan starts in ${startYear}.`);
      continue;
    }
    if (!hasOwnedAccount(c.personId, "pre_tax")) {
      error("conversion_no_pretax", `${at}.personId`, `${personOf(c.personId)!.person.name} has no pre-tax account in the plan to convert from.`);
      continue;
    }
    // Years after the plan's horizon are left out (as goals are): nobody is alive to convert.
    let overlap = false;
    for (let year = c.fromYear; year <= c.toYear && year <= endYear; year++) {
      const key = `${c.personId}:${year}`;
      if (conversionYears.has(key)) overlap = true;
      conversionYears.add(key);
      conversions.push({ year, personId: c.personId, amountCents: c.annualCents, dollars: c.dollars });
      convertsFor.add(c.personId);
    }
    if (overlap) error("conversion_overlap", at, `Two conversions for ${personOf(c.personId)!.person.name} fall in the same year.`);
  }
  conversions.sort((a, b) => a.year - b.year || (a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0));

  // R5. Synthetic accounts.
  for (const p of people) {
    if (!convertsFor.has(p.id) || hasOwnedAccount(p.id, "roth")) continue;
    const pretax = accounts.filter((acct) => acct.bucket === "pre_tax" && ownerIs(acct, p.id));
    const weighted = pretax.some((acct) => BigInt(acct.balanceCents) > 0n);
    const sums = CLASSES.map((c) => pretax.reduce((s, acct) => s + BigInt(acct.allocation[c]) * (weighted ? BigInt(acct.balanceCents) : 1n), 0n));
    const parts = allocateLargestRemainder(10_000n, sums);
    const allocation = Object.fromEntries(CLASSES.map((c, i) => [c, Number(parts[i]!)])) as ClassWeights;
    const id = syntheticRothAccountId(p.id);
    accounts.push({ id, name: SYNTHETIC_ROTH_NAME, bucket: "roth", owner: p.id, balanceCents: "0", allocation, allocationSource: "pretax_mix", expenseRatioPpm: 0, synthetic: true });
    provenance[`accounts.${id}.allocation`] = "default";
    provenance[`accounts.${id}.owner`] = "default";
  }
  if (included.length > 0 && !accounts.some((acct) => acct.bucket === "taxable" || acct.bucket === "cash")) {
    const owner: OwnerId = people.length === 1 ? "p1" : "joint";
    accounts.push({
      id: SYNTHETIC_CASH_ACCOUNT_ID,
      name: SYNTHETIC_CASH_NAME,
      bucket: "cash",
      owner,
      balanceCents: "0",
      allocation: { ...CASH_ALLOCATION },
      allocationSource: "cash",
      expenseRatioPpm: 0,
      synthetic: true,
    });
  }
  for (const acct of accounts) {
    if (!acct.synthetic) continue;
    effectiveAccounts.push({
      accountId: acct.id,
      included: true,
      bucket: acct.bucket,
      owner: acct.owner,
      balanceCents: 0n,
      allocation: acct.allocation,
      allocationSource: acct.allocationSource,
      expenseRatioPpm: 0,
    });
  }
  accounts.sort(byId);

  // R6. Income streams.
  const monthOf = (w: When, path: string): MonthKey | undefined => {
    switch (w.at) {
      case "start":
        return startMonth;
      case "year":
        return `${String(w.year).padStart(4, "0")}-01`;
      case "age": {
        const p = known(w.personId, `${path}.personId`);
        return p === undefined ? undefined : ageMonth(p.person.birthYear, p.person.birthMonth, w.age);
      }
      case "retirement":
        return known(w.personId, `${path}.personId`)?.retirementMonth;
    }
  };
  const incomes: SimInputIncome[] = [];
  const salaryOf = new Map<PersonId, bigint>();
  const droppedFor = new Set<PersonId>();
  const salaryIds = new Map<PersonId, string>();
  for (const id of sortedKeys(doc.incomes)) {
    const s: IncomeStream = doc.incomes[id]!;
    const at = `incomes.${id}`;
    const base = { id, dollars: "today", cola: { mode: "cpi" }, realGrowthBp: 0, survivorBp: 0, taxableBp: 10000, earned: false } as const;
    if (s.kind === "salary") {
      const p = known(s.personId, `${at}.personId`);
      if (p === undefined) continue;
      if (salaryIds.has(p.id)) {
        error("salary_duplicate", at, `${p.person.name} already has a salary (${salaryIds.get(p.id)}); a person has one salary stream.`);
        continue;
      }
      salaryIds.set(p.id, id);
      if (p.retired) {
        droppedFor.add(p.id);
        continue;
      }
      salaryOf.set(p.id, BigInt(s.annualGrossCents));
      incomes.push({
        ...base,
        kind: "salary",
        personId: p.id,
        name: "Salary",
        annualCents: s.annualGrossCents,
        startMonth,
        endMonth: p.retirementMonth,
        realGrowthBp: s.realRaiseBp,
        earned: true,
      });
      continue;
    }
    if ((s.kind === "part_time" || s.kind === "pension" || s.kind === "annuity" || (s.kind === "other" && s.personId !== undefined)) && known(s.personId!, `${at}.personId`) === undefined) continue;
    const endWhen = s.kind === "pension" ? undefined : s.end;
    const from = monthOf(s.start, `${at}.start`);
    const end = endWhen === undefined ? undefined : monthOf(endWhen, `${at}.end`);
    if (from === undefined || (endWhen !== undefined && end === undefined)) continue;
    const startAt = maxMonth(from, startMonth);
    if (end !== undefined && end <= startAt) {
      error("stream_window", `${at}.end`, `This income ends (${end}) before it starts (${startAt}).`);
      continue;
    }
    const window = end === undefined ? { startMonth: startAt } : { startMonth: startAt, endMonth: end };
    switch (s.kind) {
      case "part_time":
        incomes.push({ ...base, ...window, kind: "part_time", personId: s.personId, name: "Part-time work", annualCents: s.annualCents, realGrowthBp: s.realGrowthBp, earned: true });
        break;
      case "pension":
        incomes.push({ ...base, ...window, kind: "pension", personId: s.personId, name: s.name, annualCents: (BigInt(s.monthlyCents) * YEAR_MONTHS).toString(), dollars: s.dollars, cola: s.cola, survivorBp: s.survivorBp });
        break;
      case "annuity":
        incomes.push({
          ...base,
          ...window,
          kind: "annuity",
          personId: s.personId,
          name: s.name,
          annualCents: (BigInt(s.monthlyCents) * YEAR_MONTHS).toString(),
          dollars: s.dollars,
          cola: s.cola,
          survivorBp: s.survivorBp,
          taxableBp: s.taxableBp,
        });
        break;
      case "rental":
        incomes.push({ ...base, ...window, kind: "rental", name: s.name, annualCents: s.annualNetCents, realGrowthBp: s.realGrowthBp });
        break;
      case "other": {
        const stream: SimInputIncome = { ...base, ...window, kind: "other", name: s.name, annualCents: s.annualCents, dollars: s.dollars, realGrowthBp: s.realGrowthBp, taxableBp: s.taxableBp };
        if (s.personId !== undefined) stream.personId = s.personId;
        incomes.push(stream);
        break;
      }
    }
  }
  incomes.sort(byId);

  // R7. Social Security.
  const ssPeople: SimInputSocialSecurityPerson[] = [];
  if (doc.socialSecurity.p2 !== undefined) known("p2", "socialSecurity.p2");
  for (const p of people) {
    const entry = p.id === "p1" ? doc.socialSecurity.p1 : (doc.socialSecurity.p2 ?? { mode: "none" as const });
    const at = `socialSecurity.${p.id}`;
    if (entry.mode === "none") {
      ssPeople.push({ personId: p.id, mode: "none" });
      if (ageMonth(p.person.birthYear, p.person.birthMonth, 70) >= startMonth) {
        warn("ss_missing", at, `No Social Security benefit is entered for ${p.person.name}; enter the figure from the SSA statement.`);
      }
    } else if (entry.mode === "estimate") {
      const claimMonth = ageMonth(p.person.birthYear, p.person.birthMonth, entry.claimAge.years, entry.claimAge.months);
      if (claimMonth < startMonth) {
        error("claim_in_past", `${at}.claimAge`, `${p.person.name} would claim in ${claimMonth}, before the plan starts; enter the benefit as already receiving.`);
      }
      ssPeople.push({
        personId: p.id,
        mode: "estimate",
        monthlyAtFraCents: entry.monthlyAtFraCents,
        asOfYear: entry.asOfYear,
        claimMonth,
        claimAgeMonths: 12 * entry.claimAge.years + entry.claimAge.months,
      });
    } else {
      const r: SimInputSocialSecurityPerson = { personId: p.id, mode: "receiving", monthlyCents: entry.monthlyCents, asOfYear: entry.asOfYear, startedMonth: entry.startedMonth };
      if (entry.monthlyAtFraCents !== undefined) r.monthlyAtFraCents = entry.monthlyAtFraCents;
      ssPeople.push(r);
    }
  }

  // R8. Spending.
  const sp = doc.spending;
  const k = baseline.window.monthsWithData;
  const annualize = (x: bigint) => (BigInt(k) >= YEAR_MONTHS ? x : truncDiv(x * YEAR_MONTHS, BigInt(k)));
  const live = baseline.spending;
  const excluded = (categoryId: string) => sp.excludedCategoryIds[categoryId] === true;
  let annualized = false;
  let baseSpending: bigint;
  if (sp.base.mode === "manual") {
    baseSpending = BigInt(sp.base.annualCents);
    provenance["spending.base"] = typed(["spending", "base"]);
  } else {
    provenance["spending.base"] = "live";
    if (k < MIN_SPENDING_MONTHS) {
      error("spending_missing", "spending.base", `The ledger covers ${k} full month${k === 1 ? "" : "s"}; enter your yearly spending (live spending needs ${MIN_SPENDING_MONTHS}).`);
      baseSpending = 0n;
    } else {
      annualized = BigInt(k) < YEAR_MONTHS;
      baseSpending = annualize(live.byCategory.filter((c) => !excluded(c.categoryId)).reduce((s, c) => s + BigInt(c.cents), 0n));
      if (sp.includeUncategorized) {
        const outflow = annualize(BigInt(live.uncategorized.outflowCents));
        if (outflow > 0n) {
          warn(
            "uncategorized_in_spending",
            "spending.includeUncategorized",
            `Base spending includes ${formatPlanDollars(outflow)} a year of uncategorized outflows (${live.uncategorized.count} transaction${live.uncategorized.count === 1 ? "" : "s"}).`,
          );
        }
        baseSpending += outflow;
      }
      baseSpending = max0(baseSpending);
    }
  }
  let essentialSpending: bigint;
  if (sp.essential.mode === "manual") {
    essentialSpending = BigInt(sp.essential.annualCents);
    provenance["spending.essential"] = typed(["spending", "essential"]);
  } else if (k >= MIN_SPENDING_MONTHS) {
    if (BigInt(k) < YEAR_MONTHS) annualized = true;
    essentialSpending = max0(annualize(live.byCategory.filter((c) => c.bucket === "bills" && !excluded(c.categoryId)).reduce((s, c) => s + BigInt(c.cents), 0n)));
    provenance["spending.essential"] = "live";
  } else {
    essentialSpending = baseSpending;
    provenance["spending.essential"] = "default";
  }
  if (essentialSpending > baseSpending) essentialSpending = baseSpending;
  if (annualized) warn("spending_short_history", "spending.base", `Live spending is annualized from ${k} full months of the ledger.`);

  const earliestRetirement = people.reduce((m, p) => (p.retirementMonth < m ? p.retirementMonth : m), people[0]!.retirementMonth);
  const spendingStart = maxMonth(earliestRetirement, startMonth);
  const spendingStartYear = Number(spendingStart.slice(0, 4));

  const phases: Array<{ fromYear: number; multiplierBp: number }> = [];
  const anchor = known(sp.phaseAnchor, "spending.phaseAnchor");
  const phasesAscending = sp.phases.every((ph, i) => i === 0 || ph.fromAge > sp.phases[i - 1]!.fromAge);
  if (!phasesAscending) error("phase_order", "spending.phases", "The spending phases' ages must be in strictly ascending order.");
  if (anchor !== undefined && phasesAscending) {
    for (const ph of sp.phases) {
      const fromYear = anchor.person.birthYear + ph.fromAge;
      if (fromYear <= endYear) phases.push({ fromYear, multiplierBp: ph.multiplierBp });
    }
  }

  const goals: SimInputGoal[] = [];
  for (const id of sortedKeys(sp.goals)) {
    const g = sp.goals[id]!;
    const at = `spending.goals.${id}.year`;
    const count = g.repeat?.times ?? 1;
    const every = g.repeat?.everyYears ?? 0;
    const occurrences = Array.from({ length: count }, (_, i) => g.year + i * every);
    if (occurrences.every((y) => y < startYear)) {
      error("goal_in_past", at, `${g.name} is in ${g.year}, before the plan starts in ${startYear}.`);
      continue;
    }
    let beforeRetirement: number | undefined;
    occurrences.forEach((year, i) => {
      if (year < startYear || year > endYear) return;
      if (year < spendingStartYear && beforeRetirement === undefined) beforeRetirement = year;
      goals.push({ id: g.repeat === undefined ? id : `${id}:${i + 1}`, name: g.name, year, amountCents: g.amountCents, dollars: g.dollars });
    });
    if (beforeRetirement !== undefined) {
      warn("goal_before_retirement", at, `${g.name} in ${beforeRetirement} falls before retirement; it is paid from savings while still working.`);
    }
  }
  goals.sort((a, b) => a.year - b.year || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const hc = sp.healthcare;
  const healthcare: SimInputHealthcare[] = people.map((p) => ({
    personId: p.id,
    preMedicareAnnualCents: hc.preMedicareAnnualCents,
    preMedicareFrom: maxMonth(p.retirementMonth, startMonth),
    medicareFrom: maxMonth(ageMonth(p.person.birthYear, p.person.birthMonth, 65), startMonth),
    medicareAnnualCents: hc.medicareAnnualCents,
    realGrowthBp: hc.realGrowthBp,
    inBase: hc.includedInBase,
  }));
  const noHealthcareAmounts = BigInt(hc.preMedicareAnnualCents) === 0n && BigInt(hc.medicareAnnualCents) === 0n;
  if (noHealthcareAmounts && !hc.includedInBase) warn("healthcare_zero", "spending.healthcare", "No healthcare costs are entered and they are not part of base spending.");
  if (noHealthcareAmounts) {
    for (const acct of accounts) {
      if (acct.bucket !== "hsa") continue;
      warn(
        "hsa_no_medical",
        "spending.healthcare",
        `No healthcare amounts are entered, so ${acct.name} has no qualified medical spending to pay for and is drawn as taxable income (plus 20% before 65). Enter yearly healthcare costs even when they are part of base spending.`,
        acct.id,
      );
    }
  }

  const longTermCare: Array<{ personId: PersonId; reserveCents: string; lastYears: number }> = [];
  if (BigInt(sp.longTermCare.reserveCents) > 0n) {
    const named = sp.longTermCare.people === "each" ? people : [known(sp.longTermCare.people, "spending.longTermCare.people")].filter((p) => p !== undefined);
    for (const p of named) longTermCare.push({ personId: p.id, reserveCents: sp.longTermCare.reserveCents, lastYears: sp.longTermCare.lastYears });
  }

  // R9. Contributions.
  const contributions: SimInputContribution[] = [];
  const byMeasured = new Map<string, BaselineContribution>(baseline.contributions.map((c) => [c.accountId, c]));
  const householdSalary = [...salaryOf.values()].reduce((s, v) => s + v, 0n);
  let contributionsCents = 0n;
  let employerCents = 0n;
  const employeeByLimit = new Map<string, { person: ResolvedPerson; kind: ContributionLimitKind; cents: bigint; accountId: string }>();
  for (const d of included) {
    const id = d.baseline.accountId;
    const at = `contributions.${id}`;
    const configured = doc.contributions[id];
    if (configured === undefined && d.bucket === "cash") continue; // bank accounts only when set by hand
    if (d.owner === undefined) continue;
    const setting: ContributionSetting = configured ?? { employee: LIVE, employer: LIVE };
    const m = byMeasured.get(id);
    const scalePeople = d.owner === "joint" ? people : people.filter((p) => p.id === d.owner);
    const working = scalePeople.filter((p) => !p.retired);
    const scaleWith: SimInputContribution["scaleWith"] = d.owner === "joint" ? "household" : d.owner;
    const salary = d.owner === "joint" ? (householdSalary > 0n ? householdSalary : undefined) : salaryOf.get(d.owner);
    const pending: Array<[string, string, string]> = [];
    const prov: { employee: PlanProvenance; employer: PlanProvenance } = { employee: "default", employer: "default" };
    const usesLive = setting.employee.mode === "live" || setting.employer.mode === "live";

    let employee = 0n;
    switch (setting.employee.mode) {
      case "live":
        if (m?.source === "measured") employee = big(m.annualEmployeeCents);
        else if (m?.source === "recurring") {
          employee = BigInt(m.plannedCents);
          pending.push(["contribution_from_recurring", `${at}.employee`, `The contribution to ${d.baseline.name} (${formatPlanDollars(employee)} a year) comes from a planned recurring transfer, not measured deposits.`]);
        }
        prov.employee = m !== undefined && m.source !== "none" ? "live" : "default";
        break;
      case "annual":
        employee = BigInt(setting.employee.annualCents);
        prov.employee = typed(["contributions", id, "employee"]);
        break;
      case "pct_salary":
        employee = truncDiv((salary ?? 0n) * BigInt(setting.employee.bp), BP);
        prov.employee = typed(["contributions", id, "employee"]);
        break;
      case "none":
        prov.employee = typed(["contributions", id, "employee"]);
        break;
    }
    let employer = 0n;
    switch (setting.employer.mode) {
      case "live":
        if (m?.employerDetected === true) {
          employer = big(m.annualEmployerCents);
          prov.employer = "live";
        } else if (setting.employee.mode !== "live" && m !== undefined) {
          employer = max0(big(m.annualNetCents) - employee);
          prov.employer = "live";
        } else {
          prov.employer = "default";
          if (d.baseline.type === "401k" && m?.source === "measured") {
            pending.push(["match_unknown", `${at}.employer`, `The employer's part of the deposits into ${d.baseline.name} is not labelled; all of it is treated as your own deferral. Enter the match if there is one.`]);
          }
        }
        break;
      case "annual":
        employer = BigInt(setting.employer.annualCents);
        prov.employer = typed(["contributions", id, "employer"]);
        break;
      case "formula": {
        const cap = truncDiv((salary ?? 0n) * BigInt(setting.employer.capBpOfSalary), BP);
        employer = truncDiv((employee < cap ? employee : cap) * BigInt(setting.employer.matchBp), BP);
        prov.employer = typed(["contributions", id, "employer"]);
        break;
      }
      case "none":
        prov.employer = typed(["contributions", id, "employer"]);
        break;
    }

    if (m?.source === "measured" && usesLive) {
      if (m.flags.includes("partial_window")) {
        pending.push(["contribution_partial_window", `${at}.employee`, `The contributions to ${d.baseline.name} are annualized from ${m.monthsWithData} months of deposits.`]);
      }
      if (m.flags.includes("irregular")) {
        pending.push(["irregular_contributions", `${at}.employee`, `One deposit into ${d.baseline.name} is most of the year's contributions; check that it repeats.`]);
      }
    }
    if (m !== undefined && usesLive && BigInt(m.grossInCents) > 0n && m.flags.includes("insufficient_history")) {
      pending.push(["contribution_unmeasured", `${at}.employee`, `Deposits into ${d.baseline.name} were found, but too few months to measure a yearly amount; enter it if it continues.`]);
    }

    if (working.length === 0) {
      if (employee + employer > 0n) for (const p of scalePeople) droppedFor.add(p.id);
      continue;
    }
    const salaryBased = setting.employee.mode === "pct_salary" || setting.employer.mode === "formula";
    if (employee + employer === 0n) {
      if (salaryBased && salary === undefined) warn("salary_missing", at, `${d.baseline.name}'s contribution is a share of a salary the plan does not have.`, id);
      continue;
    }
    for (const [code, path, message] of pending) warn(code, path, message, id);
    const endMonth = d.owner === "joint" ? latestRetirement : personOf(d.owner)!.retirementMonth;
    const entry: SimInputContribution = { accountId: id, employeeAnnualCents: employee.toString(), employerAnnualCents: employer.toString(), scaleWith, endMonth };
    if (salary === undefined) {
      entry.scaleWith = "inflation";
      warn("salary_missing", at, `No salary is entered for ${d.owner === "joint" ? "the household" : personOf(d.owner)!.person.name}; the contribution to ${d.baseline.name} grows with inflation until retirement.`, id);
    } else {
      entry.salaryBasisCents = salary.toString();
    }
    contributions.push(entry);
    provenance[`${at}.employee`] = prov.employee;
    provenance[`${at}.employer`] = prov.employer;
    contributionsCents += employee + employer;
    employerCents += employer;

    const kind: ContributionLimitKind | undefined =
      d.bucket === "hsa" ? "hsa_family" : d.bucket !== "pre_tax" && d.bucket !== "roth" ? undefined : d.baseline.type === "401k" ? "employer_plan" : d.baseline.type === "ira" || d.baseline.type === "roth" ? "ira" : undefined;
    if (kind !== undefined && d.owner !== "joint") {
      const key = `${d.owner}:${kind}`;
      const group = employeeByLimit.get(key);
      if (group === undefined) employeeByLimit.set(key, { person: personOf(d.owner)!, kind, cents: employee, accountId: id });
      else group.cents += employee;
    }
  }
  contributions.sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  if (ctx.contributionLimit !== undefined) {
    for (const group of employeeByLimit.values()) {
      const limit = ctx.contributionLimit(startYear, startYear - group.person.person.birthYear, group.kind);
      if (limit !== null && group.cents > limit) {
        const what = group.kind === "employer_plan" ? "employer plan" : group.kind === "ira" ? "IRA" : "HSA";
        warn(
          "contribution_over_limit",
          `contributions.${group.accountId}.employee`,
          `${group.person.person.name}'s ${what} contributions (${formatPlanDollars(group.cents)}) are above the ${startYear} limit of ${formatPlanDollars(limit)}; the plan caps them and saves the rest after tax.`,
          group.accountId,
        );
      }
    }
  }
  for (const p of people) {
    if (p.retired && droppedFor.has(p.id)) {
      warn("already_retired", `people.${p.id}.retirementAge`, `${p.person.name} retires in ${p.retirementMonth}, before the plan starts; their salary and contributions are left out.`);
    }
  }

  // R11. Settings.
  if (!ctx.ruleSets.includes(settings.taxRuleSet)) error("unknown_rule_set", "settings.taxRuleSet", `The tax rule set "${settings.taxRuleSet}" is not available.`);

  // The engine's limits (C13).
  if (accounts.length > limits.maxAccounts) {
    error("too_many_accounts", "accounts", `A plan can have at most ${limits.maxAccounts} accounts, synthetic ones included; this one has ${accounts.length}.`);
  }
  if (incomes.length > limits.maxIncomes) error("too_many_incomes", "incomes", `A plan can have at most ${limits.maxIncomes} income streams; this one has ${incomes.length}.`);
  if (conversions.length > limits.maxConversions) {
    error("too_many_conversions", "rothConversions", `A plan can have at most ${limits.maxConversions} yearly Roth conversions; this one has ${conversions.length}.`);
  }
  if (years > limits.maxYears) error("horizon_too_long", "people", `A plan cannot run for more than ${limits.maxYears} years; this one runs ${years} (${startYear} to ${endYear}).`);
  const model = settings.returnModel;
  const allFixed = people.every((p) => p.person.longevity.mode === "fixed");
  // The historical model's count is the cohorts' (the engine checks it); the fixed model runs one path when every life is fixed.
  const paths = model.kind === "historical" ? undefined : model.kind === "fixed" && allFixed ? 1 : settings.paths;
  if (paths !== undefined && years <= limits.maxYears && paths * years > limits.maxPathYears) {
    error("path_years_too_many", "settings.paths", `${paths} paths of ${years} years exceed the engine's ${limits.maxPathYears} path-years; lower the path count.`);
  }

  // Effective inputs (also when the plan has errors).
  const byBucketCents = Object.fromEntries(PlanBucket.options.map((b) => [b, 0n])) as EffectiveInputs["byBucketCents"];
  let includedTotalCents = 0n;
  for (const e of effectiveAccounts) {
    if (!e.included) continue;
    byBucketCents[e.bucket] += e.balanceCents;
    includedTotalCents += e.balanceCents;
  }
  const effective: EffectiveInputs = {
    includedTotalCents,
    byBucketCents,
    baseSpendingCents: baseSpending,
    essentialSpendingCents: essentialSpending,
    contributionsCents,
    employerCents,
    accounts: effectiveAccounts.sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0)),
  };
  if (householdSalary > 0n) effective.planSavingsRateBp = Number(truncDiv(contributionsCents * BP, householdSalary));

  if (issues.some((i) => i.severity === "error")) return { issues, effective, doc };

  // R12. Assembly.
  const simPeople: SimInputPerson[] = people.map((p) => ({
    id: p.id,
    name: p.person.name,
    birthYear: p.person.birthYear,
    birthMonth: p.person.birthMonth,
    retirementMonth: p.retirementMonth,
    longevity: p.person.longevity,
  }));
  const socialSecurity: SimInput["socialSecurity"] = { people: ssPeople, spousal: doc.socialSecurity.spousal, survivor: doc.socialSecurity.survivor };
  if (doc.socialSecurity.adjustment !== undefined) socialSecurity.adjustment = { ...doc.socialSecurity.adjustment };
  const draft = {
    schema: SIM_INPUT_SCHEMA,
    schemaVersion: 1,
    meta: {
      createdAt: ctx.meta.createdAt,
      today: ctx.today,
      asOf: baseline.asOf,
      profileRevision: ctx.meta.profileRevision,
      baselineHash: ctx.meta.baselineHash,
      scenarioId: ctx.meta.scenarioId,
      scenarioRevision: ctx.meta.scenarioRevision,
      scenarioName: ctx.meta.scenarioName,
      provenance: Object.fromEntries(Object.keys(provenance).sort().map((key) => [key, provenance[key]!])),
      warnings: issues.filter((i) => i.severity === "warning"),
    },
    data: { version: ctx.dataVersion },
    plan: { startYear, startMonth, firstYearMonths, endYear, stepsPerYear: 1, currency: "USD" },
    household: { filingStatus, state: doc.state, people: simPeople },
    accounts,
    incomes,
    socialSecurity,
    spending: {
      baseAnnualCents: baseSpending.toString(),
      essentialAnnualCents: essentialSpending.toString(),
      startMonth: spendingStart,
      survivorBp: sp.survivorBp,
      phases,
      goals,
      healthcare,
      longTermCare,
    },
    contributions,
    rothConversions: conversions,
    settings,
  } satisfies SimInput;
  const parsed = SimInput.safeParse(draft);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    error("input_invalid", first === undefined ? "" : first.path.join("."), `The plan cannot be frozen: ${first?.message ?? "invalid input"}.`);
    return { issues, effective, doc };
  }
  const input = parsed.data;

  // The engine's own checks (C13): each issue blocks the run.
  if (ctx.validateInput !== undefined) {
    const engineIssues = ctx.validateInput(input);
    for (const e of engineIssues) error(e.code, ENGINE_ISSUE_PATH[e.code] ?? "", e.message);
    if (engineIssues.length > 0) return { issues, effective, doc };
  }
  return { input, issues, effective, doc };
}

/** Where on the form the engine's issues belong (a dot path into the profile document, or the run settings). */
const ENGINE_ISSUE_PATH: Readonly<Record<string, string>> = {
  too_many_accounts: "accounts",
  too_many_incomes: "incomes",
  too_many_conversions: "rothConversions",
  horizon_too_long: "people",
  plan_invalid: "people",
  path_years_too_many: "settings.paths",
  custom_params_required: "settings.returnModel",
  glide_order: "allocation.glidePath",
  spending_invalid: "spending",
  income_invalid: "incomes",
  social_security_invalid: "socialSecurity",
  contribution_invalid: "contributions",
  conversion_invalid: "rothConversions",
  conversion_no_roth: "rothConversions",
  start_year_unsupported: "baseline",
};

/** The wire shape of `EffectiveInputs` (cents as strings). */
export function effectiveInputsView(e: EffectiveInputs): EffectiveInputsView {
  const view: EffectiveInputsView = {
    includedTotalCents: e.includedTotalCents.toString(),
    byBucketCents: Object.fromEntries(PlanBucket.options.map((b) => [b, e.byBucketCents[b].toString()])),
    baseSpendingCents: e.baseSpendingCents.toString(),
    essentialSpendingCents: e.essentialSpendingCents.toString(),
    contributionsCents: e.contributionsCents.toString(),
    employerCents: e.employerCents.toString(),
    accounts: e.accounts.map((a) => {
      const row: EffectiveInputsView["accounts"][number] = { accountId: a.accountId, included: a.included, bucket: a.bucket, balanceCents: a.balanceCents.toString() };
      if (a.owner !== undefined) row.owner = a.owner;
      if (a.basisCents !== undefined) row.basisCents = a.basisCents.toString();
      if (a.basisCoverage !== undefined) row.basisCoverage = a.basisCoverage;
      if (a.allocation !== undefined) row.allocation = { ...a.allocation };
      if (a.allocationSource !== undefined) row.allocationSource = a.allocationSource;
      if (a.expenseRatioPpm !== undefined) row.expenseRatioPpm = a.expenseRatioPpm;
      return row;
    }),
  };
  if (e.planSavingsRateBp !== undefined) view.planSavingsRateBp = e.planSavingsRateBp;
  return view;
}

/** A resolved plan with its input hash (§3.7): what `requestRun` and `GET /scenarios/:id/input` freeze. */
export interface FrozenInput extends ResolveResult {
  /** `sim_run.input_hash`; present with `input`. */
  inputHash?: string;
}

/**
 * `resolvePlan`, then the input hash of `freeze.ts` (`inputHash`, SHA-256 of the canonical JSON
 * without `meta` and display names). Pass the full `PlannerEnv` (with `validateInput`) so the
 * engine's issues block the run before anything is queued (C13).
 */
export async function freezeInput(args: ResolveArgs, ctx: ResolveContext): Promise<FrozenInput> {
  const resolved = resolvePlan(args, ctx);
  if (resolved.input === undefined) return resolved;
  return { ...resolved, inputHash: await inputHash(resolved.input) };
}
