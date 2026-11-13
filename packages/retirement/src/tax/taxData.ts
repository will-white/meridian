/**
 * The tax area's data files: Zod schemas, the loader and its invariants (tax-rmd-ss §2, §4.1, §4.2;
 * seams §8 D5 to D11; plan decision 11).
 *
 * The JSON tables are imported statically with import attributes, so bundles carry them and the
 * package reads no file at run time (tax-rmd-ss decision 1). `validateTaxData` checks structure and
 * the invariants that must hold for any future data version; the published figures themselves (the
 * cumulative bracket amounts, table sums, spot values) are pinned by `data.test.ts`.
 */

import { AssetClass, FederalYearRecord, RuleSetId, TaxDataSource } from "@meridian/shared";
import { z } from "zod";
import federal2026Json from "../../data/tax/federal-2026.json" with { type: "json" };
import federal2027Json from "../../data/tax/federal-2027.json" with { type: "json" };
import taxRulesJson from "../../data/tax/rules.json" with { type: "json" };
import ssRulesJson from "../../data/ss/rules.json" with { type: "json" };
import uniformJson from "../../data/rmd/uniform-lifetime.json" with { type: "json" };
import jointJson from "../../data/rmd/joint-life.json" with { type: "json" };
import jointMetaJson from "../../data/rmd/joint-life.meta.json" with { type: "json" };
import taxDragJson from "../../data/taxable/tax-drag.json" with { type: "json" };
import { DATA_MANIFEST, type DataManifest } from "../version.js";

export type TaxDataErrorCode = "tax_data_invalid" | "unknown_rule_set" | "law_change_invalid";

/** Raised only when data is loaded or compiled; the hot-path functions never throw (decision 49). */
export class TaxDataError extends Error {
  readonly permanent = true;
  readonly code: TaxDataErrorCode;
  constructor(code: TaxDataErrorCode, message: string) {
    super(message);
    this.name = "TaxDataError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// tax/rules.json (§2.3)

/** The year-record paths a law change may set (a misspelt path is a load error). */
export const LAW_PATHS = [
  "ordinary.rates",
  "ordinary.thresholds",
  "standardDeduction",
  "additionalAged",
  "seniorDeduction.amountPerPerson",
  "seniorDeduction.phaseoutStart",
  "seniorDeduction.phaseoutRate",
  "capitalGains.rates",
  "capitalGains.zeroRateMax",
  "capitalGains.fifteenRateMax",
  "capitalGains.netLossLimit",
  "niit.rate",
  "niit.threshold",
  "socialSecurityTaxation.base1",
  "socialSecurityTaxation.base2",
  "socialSecurityTaxation.rate1",
  "socialSecurityTaxation.rate2",
  "socialSecurityTaxation.maxShare",
  "additionalTaxes.earlyDistributionRate",
  "additionalTaxes.hsaNonQualifiedRate",
  "payroll.oasdiRate",
  "payroll.medicareRate",
  "payroll.additionalMedicareRate",
  "payroll.additionalMedicareThreshold",
] as const;
export const LawPath = z.enum(LAW_PATHS);
export type LawPath = z.infer<typeof LawPath>;

const Year = z.number().int().min(2000).max(2200);
const PerStatusStep = z.object({ single: z.number().positive(), mfj: z.number().positive() }).strict();
const LawValue = z.union([
  z.number(),
  z.object({ single: z.number(), mfj: z.number() }).strict(),
  z.array(z.number()),
  z.object({ single: z.array(z.number()), mfj: z.array(z.number()) }).strict(),
]);

export const IndexingRule = z
  .object({
    path: z.string().min(1),
    index: z.enum(["cpi", "wage"]),
    round: z.enum(["floor_increase", "nearest"]),
    step: z.union([z.number().positive(), PerStatusStep]),
  })
  .strict();
export type IndexingRule = z.infer<typeof IndexingRule>;

const Window = { fromYear: Year, toYear: Year.optional() };
export const LawChangeOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("setValue"), path: LawPath, value: LawValue, ...Window, dollars: z.enum(["base", "nominal"]).default("base") }).strict(),
  z
    .object({
      op: z.literal("replaceSchedule"),
      ...Window,
      table: z
        .object({
          ordinary: FederalYearRecord.shape.ordinary.optional(),
          standardDeduction: FederalYearRecord.shape.standardDeduction.optional(),
          additionalAged: FederalYearRecord.shape.additionalAged.optional(),
          capitalGains: FederalYearRecord.shape.capitalGains.optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ op: z.literal("shiftOrdinaryRates"), ...Window, delta: z.number().min(-0.1).max(0.2) }).strict(),
  z.object({ op: z.literal("freezeIndexing"), fromYear: Year, toYear: Year }).strict(),
  z.object({ op: z.literal("scaleSocialSecurity"), ...Window, factor: z.number().min(0).max(1.5) }).strict(),
]);
export type LawChangeOp = z.infer<typeof LawChangeOp>;

export const LawChange = z
  .object({ label: z.string().min(1), illustrative: z.boolean(), description: z.string().min(1), ops: z.array(LawChangeOp).min(1) })
  .strict();
export type LawChange = z.infer<typeof LawChange>;

export const TaxRulesFile = z
  .object({
    schemaVersion: z.literal(1),
    staleInflation: z.number().min(0).max(0.2),
    indexing: z.array(IndexingRule).min(1),
    lawChanges: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), LawChange),
    ruleSets: z.array(z.object({ id: RuleSetId, label: z.string().min(1), lawChanges: z.array(z.string()) }).strict()).min(1),
    sources: z.array(TaxDataSource).min(1),
  })
  .strict();
export type TaxRulesFile = z.infer<typeof TaxRulesFile>;

// ---------------------------------------------------------------------------------------------
// ss/rules.json (§2.4, plan decision 11)

/** An exact fraction "n/d" with 0 < n/d <= 1, kept as a string so factors are computed as rationals. */
const Fraction = z.string().regex(/^[1-9]\d*\/[1-9]\d*$/, "a fraction n/d");
const BirthYearRows = z.array(z.tuple([z.number().int().min(1800).max(9999), z.number().int().min(0).max(1500)])).min(1);

export const VerificationStatus = z.enum(["primary", "secondary", "unverified"]);
export type VerificationStatus = z.infer<typeof VerificationStatus>;
export const FigureVerification = z
  .object({ status: VerificationStatus, sources: z.array(z.string().min(1)), note: z.string().optional() })
  .strict();
export type FigureVerification = z.infer<typeof FigureVerification>;

export const SocialSecurityRulesFile = z
  .object({
    schemaVersion: z.literal(1),
    retirementFraMonths: BirthYearRows,
    survivorFraBirthYearShift: z.number().int().min(0).max(5),
    earliestRetirementMonths: z.number().int().min(600).max(900),
    latestCreditMonths: z.number().int().min(600).max(900),
    earlyReduction: z.object({ firstMonths: z.number().int().positive(), first: Fraction, later: Fraction }).strict(),
    spousalReduction: z.object({ firstMonths: z.number().int().positive(), first: Fraction, later: Fraction }).strict(),
    delayedCreditPerMonth: Fraction,
    spousalShare: Fraction,
    survivor: z.object({ earliestMonths: z.number().int().min(600).max(900), maxReduction: Fraction, widowLimitShare: Fraction }).strict(),
    earningsTest: z.object({ withholdUnderFra: Fraction, withholdFraYear: Fraction }).strict(),
    colaStep: z.number().positive().max(0.01),
    colaHistory: z.record(z.string().regex(/^\d{4}$/), z.number().min(0).max(0.2)),
    verification: z.record(z.string().min(1), FigureVerification),
    sources: z.array(TaxDataSource).min(1),
  })
  .strict();
export type SocialSecurityRulesFile = z.infer<typeof SocialSecurityRulesFile>;

// ---------------------------------------------------------------------------------------------
// rmd/*.json (§2.5)

export const UniformLifetimeFile = z
  .object({
    schemaVersion: z.literal(1),
    table: z.string().min(1),
    startAge: BirthYearRows,
    jointTableSpouseGapYears: z.number().int().positive(),
    firstAge: z.number().int().positive(),
    lastAge: z.number().int().positive(),
    divisors: z.array(z.number().positive()),
    sources: z.array(TaxDataSource).min(1),
  })
  .strict();
export type UniformLifetimeFile = z.infer<typeof UniformLifetimeFile>;

/** Exactly 0 rows (the fallback: Uniform table for everyone, `rmd_joint_table_unavailable`) or the full square. */
export const JointLifeFile = z
  .object({
    schemaVersion: z.literal(1),
    table: z.string().min(1),
    firstAge: z.literal(20),
    lastAge: z.literal(120),
    rows: z.array(z.array(z.number().positive()).length(101)).refine((r) => r.length === 0 || r.length === 101, "0 or 101 rows"),
  })
  .strict();
export type JointLifeFile = z.infer<typeof JointLifeFile>;

/** The joint table keeps the byte layout pinned by seams §8 D10, so its sources live beside it. */
export const JointLifeMetaFile = z
  .object({
    schemaVersion: z.literal(1),
    file: z.literal("rmd/joint-life.json"),
    table: z.string().min(1),
    sources: z.array(TaxDataSource).min(1),
    checks: z.record(z.string(), z.unknown()),
  })
  .strict();
export type JointLifeMetaFile = z.infer<typeof JointLifeMetaFile>;

// ---------------------------------------------------------------------------------------------
// taxable/tax-drag.json (§2.6 with seams C17, C18, C19)

const Share = z.number().min(0).max(1);
export const TaxDragClass = z
  .object({
    dividendYield: z.number().min(0).max(0.15),
    qualifiedShare: Share,
    /** none; prior_bill_plus_spread = max(0, previous year's bill return + spread) (C18); bill_return = the bill asset itself (C17.5). */
    interest: z.enum(["none", "prior_bill_plus_spread", "bill_return"]),
    interestSpread: z.number().min(-0.05).max(0.15),
    taxExemptShare: Share,
    gainDistributionRate: z.number().min(0).max(0.2),
  })
  .strict();
export type TaxDragClass = z.infer<typeof TaxDragClass>;

export const TaxDragFile = z
  .object({
    schemaVersion: z.literal(1),
    classes: z.object(Object.fromEntries(AssetClass.options.map((c) => [c, TaxDragClass])) as Record<AssetClass, typeof TaxDragClass>).strict(),
    basisStepUp: z
      .object({
        ownAccount: Share,
        jointAccount: Share,
        jointAccountCommunityProperty: Share,
        communityPropertyStates: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
      })
      .strict(),
    notes: z.array(z.string()),
    sources: z.array(TaxDataSource).min(1),
  })
  .strict();
export type TaxDragFile = z.infer<typeof TaxDragFile>;

// ---------------------------------------------------------------------------------------------
// The bundle

/** The imported modules before validation: year files keyed by their manifest path. */
export interface RawTaxData {
  manifest: DataManifest;
  years: Record<string, unknown>;
  rules: unknown;
  ss: unknown;
  uniform: unknown;
  joint: unknown;
  jointMeta: unknown;
  drag: unknown;
}

export interface TaxDataSourceRef extends TaxDataSource {
  file: string;
}

export interface TaxData {
  readonly dataVersion: string;
  readonly firstTaxYear: number;
  readonly lastPublishedYear: number;
  readonly years: ReadonlyMap<number, FederalYearRecord>;
  readonly rules: TaxRulesFile;
  readonly ss: SocialSecurityRulesFile;
  readonly uniform: UniformLifetimeFile;
  readonly joint: JointLifeFile;
  readonly drag: TaxDragFile;
  /** Every source entry of every file, with the file it belongs to. */
  readonly sources: readonly TaxDataSourceRef[];
}

const YEAR_FILE = /^tax\/federal-(\d{4})\.json$/;

function invalid(file: string, why: string): never {
  throw new TaxDataError("tax_data_invalid", `${file}: ${why}`);
}

function parseFile<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown, file: string): T {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    invalid(file, `${first?.path.join(".") || "(root)"}: ${first?.message ?? "invalid"}`);
  }
  return r.data;
}

function strictlyAscending(v: readonly number[]): boolean {
  return v.every((x, i) => i === 0 || x > (v[i - 1] as number));
}

function checkYear(file: string, y: FederalYearRecord, expectedYear: number): void {
  if (y.taxYear !== expectedYear) invalid(file, `taxYear ${y.taxYear} does not match the file name`);
  for (const s of ["single", "mfj"] as const) {
    const t = y.ordinary.thresholds[s];
    if (t[0] !== 0 || !strictlyAscending(t)) invalid(file, `ordinary.thresholds.${s} must start at 0 and strictly ascend`);
    if (!(y.capitalGains.zeroRateMax[s] < y.capitalGains.fifteenRateMax[s])) invalid(file, `capitalGains: zeroRateMax.${s} must be below fifteenRateMax.${s}`);
    if (!(y.socialSecurityTaxation.base1[s] < y.socialSecurityTaxation.base2[s])) invalid(file, `socialSecurityTaxation: base1.${s} must be below base2.${s}`);
  }
  if (!strictlyAscending(y.ordinary.rates)) invalid(file, "ordinary.rates must ascend");
  if (!strictlyAscending(y.capitalGains.rates)) invalid(file, "capitalGains.rates must ascend");
  // The statute's structural identities (decision 7), which the indexing rounding preserves.
  for (let i = 1; i <= 5; i++) {
    if ((y.ordinary.thresholds.single[i] as number) * 2 !== y.ordinary.thresholds.mfj[i]) invalid(file, `single threshold ${i} must be half the joint one`);
  }
  if (y.standardDeduction.single * 2 !== y.standardDeduction.mfj) invalid(file, "the joint standard deduction must be twice the single one");
  if (y.capitalGains.zeroRateMax.single * 2 !== y.capitalGains.zeroRateMax.mfj) invalid(file, "the joint 0% gains maximum must be twice the single one");
}

/** The value at a dotted path of a year record (`undefined` when the path does not exist). */
export function yearValueAt(y: FederalYearRecord, path: string): unknown {
  let v: unknown = y;
  for (const key of path.split(".")) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

function isIndexable(v: unknown): boolean {
  const num = (x: unknown) => typeof x === "number";
  const nums = (x: unknown) => Array.isArray(x) && x.every(num);
  if (num(v) || nums(v)) return true;
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return Object.keys(o).length === 2 && ((num(o.single) && num(o.mfj)) || (nums(o.single) && nums(o.mfj)));
}

/** Rational value of "n/d". */
export function fractionValue(f: string): number {
  const [n, d] = f.split("/").map(Number);
  return (n as number) / (d as number);
}

/** The figures of ss/rules.json that need a verification mark (plan decision 11). */
export function ssFigureKeys(ss: SocialSecurityRulesFile): string[] {
  return [
    ...ss.retirementFraMonths.map(([year]) => `retirementFraMonths.${year}`),
    "survivorFraBirthYearShift",
    "earliestRetirementMonths",
    "latestCreditMonths",
    "earlyReduction",
    "spousalReduction",
    "delayedCreditPerMonth",
    "spousalShare",
    "survivor.earliestMonths",
    "survivor.maxReduction",
    "survivor.widowLimitShare",
    "earningsTest",
    "colaStep",
    ...Object.keys(ss.colaHistory).map((y) => `colaHistory.${y}`),
  ];
}

function checkRules(rules: TaxRulesFile, years: ReadonlyMap<number, FederalYearRecord>): void {
  const file = "tax/rules.json";
  const ids = rules.ruleSets.map((r) => r.id);
  if (new Set(ids).size !== ids.length) invalid(file, "rule set ids must be unique");
  if (!ids.includes("current_law")) invalid(file, "current_law must be present");
  for (const set of rules.ruleSets) {
    for (const id of set.lawChanges) if (!(id in rules.lawChanges)) invalid(file, `rule set ${set.id}: unknown law change ${id}`);
  }
  const paths = rules.indexing.map((r) => r.path);
  if (new Set(paths).size !== paths.length) invalid(file, "an indexed path is listed twice");
  for (const rule of rules.indexing) {
    for (const [taxYear, y] of years) {
      if (!isIndexable(yearValueAt(y, rule.path))) invalid(file, `indexed path ${rule.path} is not an amount in the ${taxYear} year file`);
    }
  }
  for (const [id, change] of Object.entries(rules.lawChanges)) {
    for (const op of change.ops) {
      if ("toYear" in op && op.toYear !== undefined && op.toYear < op.fromYear) invalid(file, `law change ${id}: toYear before fromYear`);
    }
  }
}

function checkSs(ss: SocialSecurityRulesFile, firstTaxYear: number): void {
  const file = "ss/rules.json";
  const fra = ss.retirementFraMonths;
  if (!strictlyAscending(fra.map((r) => r[0])) || !strictlyAscending(fra.map((r) => r[1]))) invalid(file, "retirementFraMonths must ascend in both columns");
  const fractions = [
    ss.earlyReduction.first, ss.earlyReduction.later, ss.spousalReduction.first, ss.spousalReduction.later, ss.delayedCreditPerMonth,
    ss.spousalShare, ss.survivor.maxReduction, ss.survivor.widowLimitShare, ss.earningsTest.withholdUnderFra, ss.earningsTest.withholdFraYear,
  ];
  for (const f of fractions) {
    const v = fractionValue(f);
    if (!(v > 0 && v <= 1)) invalid(file, `fraction ${f} must lie in (0, 1]`);
  }
  if (!(ss.earliestRetirementMonths < ss.latestCreditMonths)) invalid(file, "earliestRetirementMonths must be below latestCreditMonths");
  const colaYears = Object.keys(ss.colaHistory).map(Number).sort((a, b) => a - b);
  if (colaYears.some((y, i) => i > 0 && y !== (colaYears[i - 1] as number) + 1)) invalid(file, "colaHistory years must be contiguous");
  if (colaYears.length > 0 && colaYears[colaYears.length - 1] !== firstTaxYear - 1) invalid(file, `colaHistory must end at ${firstTaxYear - 1}`);
  // Plan decision 11: every figure carries a verification mark; secondary names two sources.
  const titles = new Set(ss.sources.map((s) => s.title));
  if (titles.size !== ss.sources.length) invalid(file, "source titles must be unique");
  const keys = ssFigureKeys(ss);
  for (const key of keys) {
    const v = ss.verification[key];
    if (!v) invalid(file, `figure ${key} has no verification mark`);
    for (const s of v.sources) if (!titles.has(s)) invalid(file, `verification of ${key} names an unknown source ${s}`);
    if (new Set(v.sources).size !== v.sources.length) invalid(file, `verification of ${key} names a source twice`);
    if (v.status === "secondary" && v.sources.length < 2) invalid(file, `${key} is secondary but names fewer than two sources`);
    if (v.status === "primary" && v.sources.length < 1) invalid(file, `${key} is primary but names no source`);
    if (key.startsWith("colaHistory.") && v.status === "unverified") invalid(file, `${key} is unverified; such COLA years are deleted (plan decision 11)`);
  }
  for (const key of Object.keys(ss.verification)) if (!keys.includes(key)) invalid(file, `verification mark for unknown figure ${key}`);
}

function checkUniform(u: UniformLifetimeFile): void {
  const file = "rmd/uniform-lifetime.json";
  if (u.divisors.length !== u.lastAge - u.firstAge + 1) invalid(file, "one divisor per age from firstAge to lastAge");
  if (!u.divisors.every((d, i) => i === 0 || d < (u.divisors[i - 1] as number))) invalid(file, "divisors must strictly decrease");
  if (!strictlyAscending(u.startAge.map((r) => r[0])) || !strictlyAscending(u.startAge.map((r) => r[1]))) invalid(file, "startAge rows must ascend");
}

function checkJoint(j: JointLifeFile): void {
  const file = "rmd/joint-life.json";
  const n = j.rows.length;
  for (let a = 0; a < n; a++) {
    const row = j.rows[a] as number[];
    for (let b = 0; b < n; b++) {
      if (row[b] !== (j.rows[b] as number[])[a]) invalid(file, `not symmetric at (${a + 20}, ${b + 20})`);
      if (b > 0 && (row[b] as number) > (row[b - 1] as number)) invalid(file, `row ${a + 20} increases at ${b + 20}`);
    }
  }
}

function checkManifest(m: DataManifest, years: ReadonlyMap<number, FederalYearRecord>): void {
  const file = "manifest.json";
  const list = [...years.keys()].sort((a, b) => a - b);
  if (list[0] !== m.firstTaxYear) invalid(file, `the first year file must be firstTaxYear ${m.firstTaxYear}`);
  if (list[list.length - 1] !== m.lastPublishedYear) invalid(file, `the last year file must be lastPublishedYear ${m.lastPublishedYear}`);
  if (list.some((y, i) => i > 0 && y !== (list[i - 1] as number) + 1)) invalid(file, "the year files must be contiguous");
  const listed = new Set(m.files.map((f) => f.path));
  for (const y of list) if (!listed.has(`tax/federal-${y}.json`)) invalid(file, `tax/federal-${y}.json is not listed`);
}

/** Parses and checks the raw modules; throws `TaxDataError("tax_data_invalid")` naming the file. */
export function validateTaxData(raw: RawTaxData): TaxData {
  const years = new Map<number, FederalYearRecord>();
  const sources: TaxDataSourceRef[] = [];
  for (const [path, value] of Object.entries(raw.years)) {
    const m = YEAR_FILE.exec(path);
    if (!m) invalid(path, "a year file must be named tax/federal-YYYY.json");
    const y = parseFile(FederalYearRecord, value, path);
    checkYear(path, y, Number(m[1]));
    years.set(y.taxYear, y);
    for (const s of y.sources) sources.push({ file: path, ...s });
  }
  checkManifest(raw.manifest, years);
  const rules = parseFile(TaxRulesFile, raw.rules, "tax/rules.json");
  checkRules(rules, years);
  const ss = parseFile(SocialSecurityRulesFile, raw.ss, "ss/rules.json");
  checkSs(ss, raw.manifest.firstTaxYear);
  const uniform = parseFile(UniformLifetimeFile, raw.uniform, "rmd/uniform-lifetime.json");
  checkUniform(uniform);
  const joint = parseFile(JointLifeFile, raw.joint, "rmd/joint-life.json");
  checkJoint(joint);
  const jointMeta = parseFile(JointLifeMetaFile, raw.jointMeta, "rmd/joint-life.meta.json");
  const drag = parseFile(TaxDragFile, raw.drag, "taxable/tax-drag.json");
  for (const [file, list] of [
    ["tax/rules.json", rules.sources],
    ["ss/rules.json", ss.sources],
    ["rmd/uniform-lifetime.json", uniform.sources],
    ["rmd/joint-life.json", jointMeta.sources],
    ["taxable/tax-drag.json", drag.sources],
  ] as const) {
    for (const s of list) sources.push({ file, ...s });
  }
  return deepFreeze({
    dataVersion: raw.manifest.dataVersion,
    firstTaxYear: raw.manifest.firstTaxYear,
    lastPublishedYear: raw.manifest.lastPublishedYear,
    years,
    rules,
    ss,
    uniform,
    joint,
    drag,
    sources,
  });
}

function deepFreeze<T>(value: T): T {
  if (value instanceof Map) {
    for (const v of value.values()) deepFreeze(v);
    return value;
  }
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** The bundled modules, unvalidated (for tests that edit a copy and expect a refusal). */
export function rawTaxData(): RawTaxData {
  return {
    manifest: DATA_MANIFEST,
    years: { "tax/federal-2026.json": federal2026Json, "tax/federal-2027.json": federal2027Json },
    rules: taxRulesJson,
    ss: ssRulesJson,
    uniform: uniformJson,
    joint: jointJson,
    jointMeta: jointMetaJson,
    drag: taxDragJson,
  };
}

let cached: TaxData | undefined;

/** The bundled JSON, parsed, validated and frozen (once per process). */
export function loadTaxData(): TaxData {
  cached ??= validateTaxData(rawTaxData());
  return cached;
}
