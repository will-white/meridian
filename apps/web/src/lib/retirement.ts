import {
  DEFAULT_ASSET_CLASS_MAP,
  glideWeightsAt,
  MEDICARE_AGE,
  StrategyConfig,
  truncDiv,
  vpwParams,
  vpwPercentage,
  type AssetClass,
  type ClassWeights,
  type EffectiveInputsView,
  type PersonId,
  type RunSettings,
  type SimInput,
  type StrategyKind,
  type YearTable,
} from "@meridian/shared";
import type { YearMarker } from "../components/charts/retirementOptions.js";
import { money } from "./format.js";
import { monthText, percentText, ratioBp, signedPercentText, wholeDollars } from "./retirementFormat.js";

/**
 * The pure helpers strategies-outputs-web §2 lists for `apps/web/src/lib/retirement.ts`:
 * `successTone`, `changeLabel`, `fanMarkers` and `strategyHints` (with the inputs the hints read).
 * `describeAssumptions` is in retirementAssumptions.ts and `yearTableCsv` in retirementTable.ts.
 * The web imports `@meridian/shared` only (seams C47): VPW is the shared `vpwPercentage`.
 */

export type SuccessTone = "ok" | "warn" | "bad";

/** The success rate's tone (§1 decision 34, UI-1): 90% and above good, 75% to under 90% warning, below 75% bad. */
export function successTone(successBp: number): SuccessTone {
  if (successBp >= 9000) return "ok";
  if (successBp >= 7500) return "warn";
  return "bad";
}

// ---- Change labels (§5.3 ChangeChips) ----

/** Names to put in a label; without them a change of p1 has no prefix and a change of p2 says "Person 2". */
export interface ChangeNames {
  /** The household's people by id; a one-person household needs none. */
  people?: Partial<Record<PersonId, string>>;
  /** An account's name by id. */
  account?: (id: string) => string | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function valueText(v: unknown): string {
  if (v === undefined) return "(none)";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function centsOf(v: unknown): bigint | undefined {
  return typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : undefined;
}

/** "Spending −10%" from two cents strings: the change in basis points of the old amount, truncated (C44). */
function amountChange(label: string, before: unknown, after: unknown): string | undefined {
  const b = centsOf(before);
  const a = centsOf(after);
  if (a !== undefined && b === undefined) return `${label} set to ${money(a.toString())} a year`;
  if (a === undefined || b === undefined) return undefined;
  if (b === 0n) return `${label} ${money(b.toString())} → ${money(a.toString())}`;
  return `${label} ${signedPercentText(Number(truncDiv((a - b) * 10_000n, b)))}`;
}

/** "Sam: retire at 62 …" when the person is named; a second person with no name given is "Person 2". */
function personPrefix(id: string, names: ChangeNames | undefined, capitalized: string): string {
  const name = names?.people?.[id as PersonId] ?? (id === "p2" ? "Person 2" : undefined);
  return name === undefined ? capitalized : `${name}: ${capitalized.charAt(0).toLowerCase()}${capitalized.slice(1)}`;
}

function itemName(v: unknown, fallback: string): string {
  return isRecord(v) && typeof v["name"] === "string" ? v["name"] : fallback;
}

/**
 * One leaf of a scenario's changes in words (§5.3, UI-2): "Retire at 62 instead of 65",
 * "Spending −10%", "Claim Social Security at 70 instead of 67", "Adds income: Pension"; a path it
 * does not know falls back to the path and both values ("a.b: 1 → 2"). `before` is the profile's
 * value, `after` the scenario's (absent: removed). Percent changes of amounts are truncated.
 */
export function changeLabel(path: string, before: unknown, after: unknown, names?: ChangeNames): string {
  const parts = path.split(".");
  const [head, second, third, fourth] = parts;
  const fallback = `${path}: ${valueText(before)} → ${after === undefined ? "(removed)" : valueText(after)}`;

  if (head === "people" && second !== undefined && parts.length === 3) {
    if (third === "retirementAge" && typeof after === "number") {
      const text = typeof before === "number" ? `Retire at ${after} instead of ${before}` : `Retire at ${after}`;
      return personPrefix(second, names, text);
    }
    if (third === "retirementMonth") {
      if (typeof after === "string") return personPrefix(second, names, `Retire in ${monthText(after)}`);
      if (after === undefined) return personPrefix(second, names, "Retire at the retirement age, not a set month");
    }
  }
  if (head === "people" && second !== undefined && third === "longevity" && parts.length === 4 && fourth === "age" && typeof after === "number") {
    return personPrefix(second, names, typeof before === "number" ? `Plan to age ${after} instead of ${before}` : `Plan to age ${after}`);
  }
  if (head === "people" && second !== undefined && third === "longevity" && parts.length === 4 && fourth === "mode") {
    if (after === "mortality") return personPrefix(second, names, "Use the mortality table instead of a fixed age");
    if (after === "fixed") return personPrefix(second, names, "Use a fixed age instead of the mortality table");
  }
  if (head === "spending" && parts.length === 3 && (second === "base" || second === "essential") && third === "annualCents") {
    if (after === undefined) return second === "base" ? "Spending from live data" : "Essential spending from live data";
    const text = amountChange(second === "base" ? "Spending" : "Essential spending", before, after);
    if (text !== undefined) return text;
  }
  if (head === "spending" && parts.length === 3 && (second === "base" || second === "essential") && third === "mode") {
    const what = second === "base" ? "Spending" : "Essential spending";
    if (after === "manual") return `${what} typed instead of from live data`;
    if (after === "live") return `${what} from live data instead of typed`;
  }
  if (head === "spending" && second === "survivorBp" && parts.length === 2 && typeof after === "number") {
    return `Spending after a death: ${percentText(after)}${typeof before === "number" ? ` instead of ${percentText(before)}` : ""}`;
  }
  if (head === "spending" && second === "phases" && parts.length === 2) return "Changes the spending phases";
  if (head === "spending" && second === "goals" && third !== undefined && parts.length === 3) {
    if (after === undefined) return `Removes goal: ${itemName(before, third)}`;
    if (before === undefined) return `Adds goal: ${itemName(after, third)}${isRecord(after) && typeof after["year"] === "number" ? ` (${after["year"]})` : ""}`;
  }
  if (head === "socialSecurity" && second !== undefined && third === "claimAge" && fourth !== undefined && parts.length === 4 && typeof after === "number") {
    const was = typeof before === "number" ? ` instead of ${before}` : "";
    if (fourth === "years") return personPrefix(second, names, `Claim Social Security at ${after}${was}`);
    if (fourth === "months") return personPrefix(second, names, `Claim Social Security ${after} months past the birthday${was}`);
  }
  if (head === "incomes" && second !== undefined && parts.length === 2) {
    if (after === undefined) return `Removes income: ${itemName(before, second)}`;
    if (before === undefined) return `Adds income: ${itemName(after, second)}`;
  }
  if (head === "rothConversions" && second !== undefined && parts.length === 2) {
    if (after === undefined) return "Removes a Roth conversion";
    if (before === undefined && isRecord(after)) {
      const amount = centsOf(after["annualCents"]);
      const years = after["fromYear"] === after["toYear"] ? `in ${String(after["fromYear"])}` : `${String(after["fromYear"])} to ${String(after["toYear"])}`;
      return `Adds a Roth conversion${amount === undefined ? "" : ` of ${money(amount.toString())} a year`} ${years}`;
    }
  }
  if (head === "accounts" && second !== undefined && third === "include" && parts.length === 3) {
    const name = names?.account?.(second) ?? "an account";
    if (after === false) return `Leaves out ${name}`;
    if (after === true) return `Includes ${name}`;
  }
  if (head === "allocation" && second === "glidePath" && parts.length >= 2) return after === undefined ? "Removes the glide path" : "Changes the glide path";
  return fallback;
}

// ---- Fan markers (§5.5 item 3) ----

/**
 * The fan's markers by calendar year (§5.5 item 3): each person's retirement, Social Security
 * claim and Medicare (65, `MEDICARE_AGE`) that fall after the plan start, and, when the selected
 * path's table is given, each person's first year with a required minimum distribution as that
 * path took it (the table's own RMD column, so the web needs no copy of the RMD start ages). A
 * one-person household's labels carry no name.
 */
export function fanMarkers(input: SimInput, table?: YearTable): YearMarker[] {
  const people = input.household.people;
  const named = people.length > 1;
  const label = (name: string, what: string, solo: string) => (named ? `${name}: ${what}` : solo);
  const startMonth = input.plan.startMonth;
  const out: YearMarker[] = [];
  for (const person of people) {
    if (person.retirementMonth > startMonth) out.push({ year: Number(person.retirementMonth.slice(0, 4)), label: named ? `${person.name} retires` : "Retirement" });
    const ss = input.socialSecurity.people.find((s) => s.personId === person.id);
    if (ss?.mode === "estimate" && ss.claimMonth > startMonth) out.push({ year: Number(ss.claimMonth.slice(0, 4)), label: label(person.name, "Social Security", "Social Security") });
    const medicare = `${person.birthYear + MEDICARE_AGE}-${String(person.birthMonth).padStart(2, "0")}`;
    if (medicare > startMonth) out.push({ year: person.birthYear + MEDICARE_AGE, label: label(person.name, "Medicare", "Medicare") });
  }
  if (table !== undefined) {
    people.forEach((person, p) => {
      const owned = table.accounts.map((a, i) => (a.owner === person.id ? i : -1)).filter((i) => i >= 0);
      const row = table.rows.find((r) => owned.some((i) => BigInt(r.withdrawals.rmdByAccount[i] ?? "0") > 0n));
      if (row !== undefined) out.push({ year: row.year, label: label(people[p]!.name, "first RMD", "First RMD") });
    });
  }
  return out.sort((a, b) => a.year - b.year);
}

// ---- Strategy hints (§5.4) ----

/** What the run-settings hints read from `GET /scenarios/:id/input` (§5.4; seams C47). */
export interface HintInputs {
  /** Today's included total. */
  includedTotalCents: string;
  baseSpendingCents: string;
  essentialSpendingCents: string;
  /** The living people's ages attained in the first year the chosen strategy runs. */
  ages: number[];
  /** The stock share of the target mix, weighted by starting balances (basis points). */
  stockShareBp: number;
}

/** A strategy's card hint and note (§5.4); either may be absent. */
export interface StrategyHint {
  hint?: string;
  note?: string;
}

const PERCENTAGE_NOTE = "Other income is spent in addition, so spending steps up when Social Security starts.";
const GUARDRAILS_NOTE =
  "The published rules assume no other income. Here they run on a reference withdrawal and scale what your portfolio pays, so Social Security starting is not mistaken for prosperity. If your plan draws heavily before Social Security starts, expect cuts during those years.";

/** The strategy as configured, or the kind's defaults when the scenario uses another kind. */
function configOf<K extends StrategyKind>(settings: Pick<RunSettings, "strategy"> | undefined, kind: K): Extract<StrategyConfig, { kind: K }> {
  const current = settings?.strategy;
  if (current !== undefined && current.kind === kind) return current as Extract<StrategyConfig, { kind: K }>;
  return StrategyConfig.parse({ kind }) as Extract<StrategyConfig, { kind: K }>;
}

/**
 * Each strategy card's hint (§5.4, UI-3), computed in the browser from the scenario's effective
 * inputs: constant "Your plan spends $96,000 a year, 3.5% of today's portfolio."; fixed percentage
 * "At 4% the first withdrawal would be $54,400."; VPW "At your ages and mix the first percentage is
 * 4.7%." (the shared `vpwPercentage` at the younger living person's age); floor and ceiling
 * "Essentials are 60% of your plan; your discretionary budget is $38,400, 1.4% of the portfolio.";
 * guardrails a note only. Ratios of cents truncate (C44); the VPW rate is a float rate cut to whole
 * basis points; amounts are whole dollars.
 */
export function strategyHints(inputs: HintInputs, settings?: Pick<RunSettings, "strategy">): Record<StrategyKind, StrategyHint> {
  const total = BigInt(inputs.includedTotalCents);
  const base = BigInt(inputs.baseSpendingCents);
  const essential = BigInt(inputs.essentialSpendingCents);
  const ofPortfolio = (cents: bigint) => {
    const bp = ratioBp(cents, total);
    return bp === undefined ? "" : `, ${percentText(bp)} of today's portfolio`;
  };

  const fixed = configOf(settings, "fixed_percentage");
  const vpw = configOf(settings, "vpw");
  const younger = inputs.ages.length === 0 ? undefined : Math.min(...inputs.ages);
  let vpwHint: string | undefined;
  if (younger !== undefined) {
    const rate = vpwPercentage(younger, inputs.stockShareBp / 10_000, vpwParams(vpw));
    vpwHint = `At your ages and mix the first percentage is ${percentText(Math.trunc(rate * 10_000))}.`;
  }
  const essentialsBp = ratioBp(essential, base);
  const discretionary = base - essential;
  const discretionaryBp = ratioBp(discretionary, total);

  return {
    constant_dollar: { hint: `Your plan spends ${wholeDollars(base)} a year${ofPortfolio(base)}.` },
    fixed_percentage: { hint: `At ${percentText(fixed.rateBp)} the first withdrawal would be ${wholeDollars(truncDiv(total * BigInt(fixed.rateBp), 10_000n))}.`, note: PERCENTAGE_NOTE },
    guardrails: { note: GUARDRAILS_NOTE },
    vpw: vpwHint === undefined ? { note: PERCENTAGE_NOTE } : { hint: vpwHint, note: PERCENTAGE_NOTE },
    floor_ceiling:
      essentialsBp === undefined
        ? {}
        : {
            hint: `Essentials are ${percentText(essentialsBp)} of your plan; your discretionary budget is ${wholeDollars(discretionary)}${
              discretionaryBp === undefined ? "" : `, ${percentText(discretionaryBp)} of the portfolio`
            }.`,
          },
  };
}

/** The six classes' share mapped to the simulated stock asset (the asset map's first column), in units of 1/10^8 (bp × bp). */
function stockUnitsOf(weights: ClassWeights, map: Readonly<Record<AssetClass, readonly [number, number, number]>>): bigint {
  let sum = 0n;
  for (const c of Object.keys(map) as AssetClass[]) sum += BigInt(weights[c]) * BigInt(map[c][0]);
  return sum;
}

/**
 * The hints' inputs from the scenario's frozen input and effective values (`GET /scenarios/:id/input`):
 * the ages are those attained in the first year every person is retired (when the chosen strategy
 * starts, §1 decision 5), not before the plan start; the stock share is the target mix of that
 * year (glide paths through the shared `glideWeightsAt`) mapped through the asset map, weighted by
 * starting balances, truncated; a cash account counts as no stock. Null without both.
 */
export function hintInputs(input: SimInput | null | undefined, effective: EffectiveInputsView | null | undefined): HintInputs | null {
  if (!input || !effective) return null;
  const people = input.household.people;
  const year = Math.max(input.plan.startYear, ...people.map((p) => Number(p.retirementMonth.slice(0, 4))));
  const map = input.settings.portfolio.assetClassMap ?? DEFAULT_ASSET_CLASS_MAP;
  let weighted = 0n;
  let balance = 0n;
  for (const a of input.accounts) {
    const cents = BigInt(a.balanceCents);
    const weights = a.glidePath !== undefined && a.glidePath.length > 0 ? glideWeightsAt(a.glidePath, year) : a.allocation;
    weighted += a.bucket === "cash" ? 0n : cents * stockUnitsOf(weights, map);
    balance += cents;
  }
  // One truncation at the end: Σ balance × stock units ÷ (Σ balance × 10000) in basis points.
  return {
    includedTotalCents: effective.includedTotalCents,
    baseSpendingCents: effective.baseSpendingCents,
    essentialSpendingCents: effective.essentialSpendingCents,
    ages: people.filter((p) => p.birthYear + (p.longevity.mode === "fixed" ? p.longevity.age : p.longevity.maxAge) >= year).map((p) => year - p.birthYear),
    stockShareBp: balance === 0n ? 0 : Number(truncDiv(weighted, balance * 10_000n)),
  };
}
