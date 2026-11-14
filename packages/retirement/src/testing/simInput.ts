/**
 * A `SimInput` builder for the engine's own tests and the reference fixtures (seams C1: loop tests
 * are written as `SimInput`). Every field has a plain default, so a case states only what it is
 * about; the result is parsed with the shared schema, so a builder output is always a valid
 * frozen input.
 *
 * Defaults: a plan from January 2027 (`firstYearMonths` 12) to the last person's fixed life
 * expectancy; one person `p1` born January 1962, retired before the plan starts, fixed age 95; one
 * cash account of 0; no income, Social Security, contributions or conversions; spending 0 from the
 * plan start; the default run settings with the fixed model at 0% everywhere; the engine's data
 * version. Like the resolver (seams C24), the builder adds `synthetic:cash` (balance 0) when the
 * accounts it is given include no taxable or cash account.
 */

import {
  type Longevity,
  type PersonId,
  type PlanBucket,
  type PlanIncomeKind,
  type PortfolioSettings,
  type ReturnModelConfigInput,
  type RunSettingsInput,
  SIM_INPUT_SCHEMA,
  SYNTHETIC_CASH_ACCOUNT_ID,
  SimInput,
  type SimInputAccount,
  type SimInputContribution,
  type SimInputConversion,
  type SimInputIncome,
  type SimInputSpending,
  type StrategyConfigInput,
  type TaxSettingsInput,
  defaultRunSettings,
} from "@meridian/shared";
import { DATA_VERSION } from "../version.js";

export interface PersonOptions {
  birthYear: number;
  birthMonth?: number;
  /** `YYYY-MM`; default: the plan's start month (already retired). */
  retirementMonth?: string;
  /** Default: fixed age 95. */
  longevity?: Longevity;
}

export interface SimInputOptions {
  startYear?: number;
  /** 1 to 12; `firstYearMonths = 13 − startMonth`. */
  startMonth?: number;
  /** Default: the last year of the last person's life expectancy (fixed age, or `maxAge`). */
  endYear?: number;
  people?: readonly PersonOptions[];
  accounts?: readonly SimInputAccount[];
  spending?: Partial<SimInputSpending>;
  strategy?: StrategyConfigInput;
  cashReserveCents?: string;
  returnModel?: ReturnModelConfigInput;
  incomes?: readonly SimInputIncome[];
  contributions?: readonly SimInputContribution[];
  rothConversions?: readonly SimInputConversion[];
  socialSecurity?: SimInput["socialSecurity"];
  /** Default "CO". */
  state?: string;
  portfolio?: PortfolioSettings;
  tax?: TaxSettingsInput;
  /** Default: the run settings' default (10,000). */
  paths?: number;
  seed?: number;
  taxRuleSet?: string;
  /** `meta.scenarioName`; default "test". */
  scenarioName?: string;
}

const PERSON_IDS: readonly PersonId[] = ["p1", "p2"];

function month(year: number, m: number): string {
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

/** A cash account in the shape the resolver writes (bucket `cash`, 100% cash). */
export function cashAccount(id: string, balanceCents: string, owner: SimInputAccount["owner"] = "joint"): SimInputAccount {
  return {
    id,
    name: id,
    bucket: "cash",
    owner,
    balanceCents,
    allocation: { us_stock: 0, intl_stock: 0, bonds: 0, cash: 10000, real_estate: 0, other: 0 },
    allocationSource: "cash",
    expenseRatioPpm: 0,
    synthetic: false,
  };
}

/**
 * An account in the shape the resolver writes. Defaults: owner `joint` for taxable and cash
 * accounts and `p1` otherwise; 100% US stock (100% cash for a cash account); no basis (a taxable
 * account's basis then counts 0); no fund cost; not synthetic. `o` overrides any field.
 */
export function account(id: string, bucket: PlanBucket, balanceCents: string, o: Partial<SimInputAccount> = {}): SimInputAccount {
  const cash = bucket === "cash";
  return {
    id,
    name: id,
    bucket,
    owner: cash || bucket === "taxable" ? "joint" : "p1",
    balanceCents,
    allocation: cash
      ? { us_stock: 0, intl_stock: 0, bonds: 0, cash: 10000, real_estate: 0, other: 0 }
      : { us_stock: 10000, intl_stock: 0, bonds: 0, cash: 0, real_estate: 0, other: 0 },
    allocationSource: cash ? "cash" : "holdings",
    expenseRatioPpm: 0,
    synthetic: false,
    ...o,
  };
}

/**
 * An income stream with the fields the resolver freezes for a kind that does not have them
 * (inputs-and-data §3.4 R6): today's dollars, COLA `cpi`, no real growth, no survivor share, fully
 * taxable; `earned` for salary and part-time income. `o` overrides any field.
 */
export function incomeStream(id: string, kind: PlanIncomeKind, annualCents: string, startMonth: string, o: Partial<SimInputIncome> = {}): SimInputIncome {
  return {
    id,
    kind,
    name: id,
    annualCents,
    dollars: "today",
    startMonth,
    realGrowthBp: 0,
    cola: { mode: "cpi" },
    survivorBp: 0,
    taxableBp: 10000,
    earned: kind === "salary" || kind === "part_time",
    ...o,
  };
}

export function buildSimInput(o: SimInputOptions = {}): SimInput {
  const startYear = o.startYear ?? 2027;
  const startMonthNumber = o.startMonth ?? 1;
  const startMonth = month(startYear, startMonthNumber);
  const people = (o.people ?? [{ birthYear: 1962 }]).map((p, i) => ({
    id: PERSON_IDS[i]!,
    name: PERSON_IDS[i]!,
    birthYear: p.birthYear,
    birthMonth: p.birthMonth ?? 1,
    retirementMonth: p.retirementMonth ?? startMonth,
    longevity: p.longevity ?? ({ mode: "fixed", age: 95 } as const),
  }));
  const lastYear = Math.max(...people.map((p) => p.birthYear + (p.longevity.mode === "fixed" ? p.longevity.age : p.longevity.maxAge)));
  const settings = defaultRunSettings();
  const given = o.accounts ?? [cashAccount("cash", "0")];
  const accounts = given.some((a) => a.bucket === "taxable" || a.bucket === "cash")
    ? given
    : [...given, { ...cashAccount(SYNTHETIC_CASH_ACCOUNT_ID, "0"), name: "Cash (surplus)", allocationSource: "cash" as const, synthetic: true }];
  const raw = {
    schema: SIM_INPUT_SCHEMA,
    schemaVersion: 1,
    meta: {
      createdAt: "2026-11-13T00:00:00.000Z",
      today: "2026-11-13",
      asOf: "2026-11-13",
      profileRevision: 1,
      baselineHash: "0".repeat(64),
      scenarioId: "00000000-0000-4000-8000-000000000001",
      scenarioRevision: 1,
      scenarioName: o.scenarioName ?? "test",
      provenance: {},
      warnings: [],
    },
    data: { version: DATA_VERSION },
    plan: { startYear, startMonth, firstYearMonths: 13 - startMonthNumber, endYear: o.endYear ?? lastYear, stepsPerYear: 1, currency: "USD" },
    household: { filingStatus: people.length === 2 ? "married_joint" : "single", state: o.state ?? "CO", people },
    accounts,
    incomes: o.incomes ?? [],
    socialSecurity: o.socialSecurity ?? { people: people.map((p) => ({ personId: p.id, mode: "none" })), spousal: true, survivor: true },
    spending: {
      baseAnnualCents: "0",
      essentialAnnualCents: "0",
      startMonth,
      survivorBp: 10000,
      phases: [],
      goals: [],
      healthcare: [],
      longTermCare: [],
      ...o.spending,
    },
    contributions: o.contributions ?? [],
    rothConversions: o.rothConversions ?? [],
    settings: {
      ...settings,
      ...(o.paths === undefined ? {} : { paths: o.paths }),
      ...(o.seed === undefined ? {} : { seed: o.seed }),
      ...(o.taxRuleSet === undefined ? {} : { taxRuleSet: o.taxRuleSet }),
      portfolio: o.portfolio ?? settings.portfolio,
      tax: o.tax ?? settings.tax,
      returnModel: o.returnModel ?? { kind: "fixed", series: [{ stocksPpm: 0, bondsPpm: 0, billsPpm: 0, inflationPpm: 0 }] },
      strategy: o.strategy ?? settings.strategy,
      withdrawalOrder: { kind: "default", cashReserveCents: o.cashReserveCents ?? "0" },
    } satisfies RunSettingsInput,
  };
  return SimInput.parse(raw);
}
