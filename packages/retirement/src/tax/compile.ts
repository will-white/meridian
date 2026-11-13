/**
 * Compile the tax law of a run and fill the per-path tables (tax-rmd-ss §3.2, §2.8; seams C12, C22).
 *
 * `compileTaxLaw` runs once per run inside `prepare` (C12): it resolves the rule set, applies its
 * law changes to every plan year's record, re-checks the invariants and flattens each year into
 * `base`, `step` and `mode` arrays in the slot layouts of layout.ts. `fillPathTables` runs once per
 * path: it advances the index factors with the path's own inflation and writes the indexed amounts
 * with the statute's rounding steps (tax-rmd-ss decisions 6 and 7), the tax at every bracket bound,
 * the Social Security COLA (§3.9.6) and the factors themselves. It allocates nothing.
 *
 * Indexing (C22): `F_Y = 1` and `W_Y = 1` for every published year `Y ≤ L`; for `Y > L`
 * `F_Y = F_{Y−1} × (1 + π(Y − 1)) × (1 − chainedCpiWedge)` (or `F_{Y−1}` in a year a
 * `freezeIndexing` law change covers) and `W_Y = W_{Y−1} × (1 + π(Y − 1) + realWageGrowth)`, where
 * `π(y)` is the path's full-year inflation of calendar year `y` (`indexInflation[y − startYear]`)
 * for `y ≥ startYear` and the data's `staleInflation` before the plan starts. An indexed amount is
 * always computed from its value in the last published year:
 *
 * - `floor_increase`: `value_L + floor(value_L × (F − 1) / step + 1e−9) × step`
 * - `nearest`:        `floor(value_L × factor / step + 0.5) × step` (factor `F` or `W` by the rule's index)
 *
 * The `1e−9` guard matters: `20,000 × (1.15 − 1) / 50` is 59.999999999999964 in float64 and must
 * floor to 60 (test J8).
 */

import { FederalYearRecord } from "@meridian/shared";
import { N_BRACKETS, PR, PROG_REC, TAX_REC, TR, progOffset, taxOffset } from "./layout.js";
import { roundCola } from "./socialSecurity.js";
import { TaxDataError, yearValueAt, type IndexingRule, type LawChangeOp, type TaxData } from "./taxData.js";

export { progOffset, taxOffset } from "./layout.js";

// ---------------------------------------------------------------------------------------------
// Slot modes

/** The slot is copied as compiled (a published year, a nominal law-change value, an unindexed amount). */
export const MODE_FIXED = 0;
/** `value_L + floor(value_L × (factor − 1) / step + 1e−9) × step`. */
export const MODE_FLOOR_INCREASE = 1;
/** `floor(value_L × factor / step + 0.5) × step`. */
export const MODE_NEAREST = 2;
/** Flag: the factor is the wage index `W` instead of the price index `F`. */
export const MODE_WAGE = 4;

/** An amount indexed with the statute's floor rounding (decision 7; test J8). */
export function indexFloorIncrease(base: number, factor: number, step: number): number {
  return base + Math.floor((base * (factor - 1)) / step + 1e-9) * step;
}

/** An amount indexed to the nearest step (the HSA limits, the wage base, the earnings-test amounts). */
export function indexNearest(base: number, factor: number, step: number): number {
  return Math.floor((base * factor) / step + 0.5) * step;
}

function indexedValue(base: number, mode: number, step: number, F: number, W: number): number {
  if (mode === MODE_FIXED) return base;
  const factor = (mode & MODE_WAGE) !== 0 ? W : F;
  return (mode & 3) === MODE_FLOOR_INCREASE ? indexFloorIncrease(base, factor, step) : indexNearest(base, factor, step);
}

// ---------------------------------------------------------------------------------------------
// Where each slot is read from in a year record

type Status = "single" | "mfj";

interface SlotSource {
  readonly slot: number;
  /** Dotted path in the year record. */
  readonly path: string;
  /** `record`: per status, the record's own status; `single` / `mfj`: per status, that one; null: one value. */
  readonly status: "record" | Status | null;
  /** Element of an array value. */
  readonly index?: number;
}

const TAX_SOURCES: readonly SlotSource[] = [
  { slot: TR.STD, path: "standardDeduction", status: "record" },
  { slot: TR.AGED, path: "additionalAged", status: "record" },
  { slot: TR.SENIOR_AMT, path: "seniorDeduction.amountPerPerson", status: null },
  { slot: TR.SENIOR_START, path: "seniorDeduction.phaseoutStart", status: "record" },
  { slot: TR.SENIOR_RATE, path: "seniorDeduction.phaseoutRate", status: null },
  { slot: TR.LTCG0, path: "capitalGains.zeroRateMax", status: "record" },
  { slot: TR.LTCG15, path: "capitalGains.fifteenRateMax", status: "record" },
  { slot: TR.LTCG_RATE1, path: "capitalGains.rates", status: null, index: 1 },
  { slot: TR.LTCG_RATE2, path: "capitalGains.rates", status: null, index: 2 },
  { slot: TR.NIIT_THRESHOLD, path: "niit.threshold", status: "record" },
  { slot: TR.NIIT_RATE, path: "niit.rate", status: null },
  { slot: TR.SS_BASE1, path: "socialSecurityTaxation.base1", status: "record" },
  { slot: TR.SS_BASE2, path: "socialSecurityTaxation.base2", status: "record" },
  { slot: TR.SS_RATE1, path: "socialSecurityTaxation.rate1", status: null },
  { slot: TR.SS_RATE2, path: "socialSecurityTaxation.rate2", status: null },
  { slot: TR.SS_MAX_SHARE, path: "socialSecurityTaxation.maxShare", status: null },
  { slot: TR.LOSS_LIMIT, path: "capitalGains.netLossLimit", status: null },
  { slot: TR.PEN_EARLY_RATE, path: "additionalTaxes.earlyDistributionRate", status: null },
  { slot: TR.PEN_HSA_RATE, path: "additionalTaxes.hsaNonQualifiedRate", status: null },
  ...Array.from({ length: N_BRACKETS }, (_, k): SlotSource => ({ slot: TR.THR0 + k, path: "ordinary.thresholds", status: "record", index: k })),
  ...Array.from({ length: N_BRACKETS }, (_, k): SlotSource => ({ slot: TR.RATE0 + k, path: "ordinary.rates", status: null, index: k })),
];

const PROG_SOURCES: readonly SlotSource[] = [
  { slot: PR.ET_UNDER, path: "socialSecurity.earningsTestUnderFra", status: null },
  { slot: PR.ET_FRA, path: "socialSecurity.earningsTestFraYear", status: null },
  { slot: PR.WAGE_BASE, path: "payroll.oasdiWageBase", status: null },
  { slot: PR.DEFERRAL, path: "contributionLimits.employeeDeferral", status: null },
  { slot: PR.CATCHUP50, path: "contributionLimits.catchUp50", status: null },
  { slot: PR.CATCHUP6063, path: "contributionLimits.catchUp60to63", status: null },
  { slot: PR.ANNUAL_ADD, path: "contributionLimits.annualAdditions", status: null },
  { slot: PR.IRA, path: "contributionLimits.ira", status: null },
  { slot: PR.IRA_CATCHUP, path: "contributionLimits.iraCatchUp50", status: null },
  { slot: PR.HSA_SELF, path: "contributionLimits.hsaSelf", status: null },
  { slot: PR.HSA_FAMILY, path: "contributionLimits.hsaFamily", status: null },
  { slot: PR.HSA_CATCHUP, path: "contributionLimits.hsaCatchUp55", status: null },
  { slot: PR.OASDI_RATE, path: "payroll.oasdiRate", status: null },
  { slot: PR.MEDICARE_RATE, path: "payroll.medicareRate", status: null },
  { slot: PR.ADDL_MEDICARE_RATE, path: "payroll.additionalMedicareRate", status: null },
  { slot: PR.ADDL_MEDICARE_THR_SINGLE, path: "payroll.additionalMedicareThreshold", status: "single" },
  { slot: PR.ADDL_MEDICARE_THR_MFJ, path: "payroll.additionalMedicareThreshold", status: "mfj" },
];

/** The COLA has its own rule (§3.9.6) and is never indexed by a rule of `tax/rules.json`. */
const COLA_PATH = "socialSecurity.cola";

function readSource(rec: FederalYearRecord, src: SlotSource, status: Status): number {
  let v = yearValueAt(rec, src.path);
  if (src.status !== null && typeof v === "object" && v !== null) v = (v as Record<Status, unknown>)[src.status === "record" ? status : src.status];
  if (src.index !== undefined && Array.isArray(v)) v = v[src.index];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new TaxDataError("tax_data_invalid", `tax/federal-${rec.taxYear}.json: ${src.path} is not a finite amount`);
  }
  return v;
}

function stepOf(rule: IndexingRule, src: SlotSource, status: Status): number {
  if (typeof rule.step === "number") return rule.step;
  if (src.status === null) throw new TaxDataError("tax_data_invalid", `tax/rules.json: ${rule.path} is one amount but its step is given per filing status`);
  return rule.step[src.status === "record" ? status : src.status];
}

function modeOf(rule: IndexingRule): number {
  return (rule.round === "floor_increase" ? MODE_FLOOR_INCREASE : MODE_NEAREST) | (rule.index === "wage" ? MODE_WAGE : 0);
}

/** The indexing rules by path; every rule must name an amount some slot reads (and not the COLA). */
function indexingRules(data: TaxData): ReadonlyMap<string, IndexingRule> {
  const read = new Set([...TAX_SOURCES, ...PROG_SOURCES].map((s) => s.path));
  const out = new Map<string, IndexingRule>();
  for (const rule of data.rules.indexing) {
    if (rule.path === COLA_PATH || !read.has(rule.path)) {
      throw new TaxDataError("tax_data_invalid", `tax/rules.json: the indexed path ${rule.path} is read by no slot of the tax or program record`);
    }
    out.set(rule.path, rule);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Law changes applied to one year

interface LawOp {
  readonly id: string;
  readonly op: LawChangeOp;
}

function covers(op: LawChangeOp, year: number): boolean {
  if (year < op.fromYear) return false;
  return op.op === "freezeIndexing" ? year <= op.toYear : op.toYear === undefined || year <= op.toYear;
}

function lawInvalid(ruleSetId: string, year: number, why: string): never {
  throw new TaxDataError("law_change_invalid", `rule set ${ruleSetId}, tax year ${year}: ${why}`);
}

function isPerStatus(v: unknown): v is Record<Status, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 2 && keys.includes("single") && keys.includes("mfj");
}

/** Same kind of value: a number, an array of numbers of the same length, or a per-status pair of either. */
function sameShape(current: unknown, next: unknown): boolean {
  if (typeof current === "number") return typeof next === "number";
  if (Array.isArray(current)) return Array.isArray(next) && next.length === current.length && next.every((n) => typeof n === "number");
  if (isPerStatus(current)) return isPerStatus(next) && sameShape(current.single, next.single) && sameShape(current.mfj, next.mfj);
  return false;
}

function setAt(rec: FederalYearRecord, path: string, value: unknown): void {
  const keys = path.split(".");
  let node = rec as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[keys[keys.length - 1] as string] = value;
}

function nonDecreasing(v: readonly number[]): boolean {
  return v.every((x, i) => i === 0 || x >= (v[i - 1] as number));
}

/**
 * The invariants of §2.2 that must survive a law change (the three structural identities are not
 * re-checked: a law change may break them). The 0% capital-gains band must stay at 0%: the layout
 * has no slot for its rate.
 */
function checkLawYear(rec: FederalYearRecord, ruleSetId: string, year: number): void {
  const parsed = FederalYearRecord.safeParse(rec);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    lawInvalid(ruleSetId, year, `${first?.path.join(".") || "(root)"}: ${first?.message ?? "invalid"}`);
  }
  for (const s of ["single", "mfj"] as const) {
    const t = rec.ordinary.thresholds[s];
    if (t[0] !== 0 || !t.every((x, i) => Number.isFinite(x) && (i === 0 || x > (t[i - 1] as number)))) {
      lawInvalid(ruleSetId, year, `ordinary.thresholds.${s} must start at 0 and strictly ascend`);
    }
    if (!(rec.capitalGains.zeroRateMax[s] < rec.capitalGains.fifteenRateMax[s])) lawInvalid(ruleSetId, year, `capitalGains.zeroRateMax.${s} must be below fifteenRateMax.${s}`);
    if (!(rec.socialSecurityTaxation.base1[s] < rec.socialSecurityTaxation.base2[s])) lawInvalid(ruleSetId, year, `socialSecurityTaxation.base1.${s} must be below base2.${s}`);
  }
  if (!nonDecreasing(rec.ordinary.rates)) lawInvalid(ruleSetId, year, "ordinary.rates must ascend");
  if (rec.capitalGains.rates[0] !== 0 || !nonDecreasing(rec.capitalGains.rates)) lawInvalid(ruleSetId, year, "capitalGains.rates must start at 0 and ascend");
}

interface YearLaw {
  readonly rec: FederalYearRecord;
  /** Paths a `setValue` with `dollars: "nominal"` wrote: used as written, never indexed. */
  readonly nominal: ReadonlySet<string>;
  readonly ssScale: number;
  readonly frozen: boolean;
}

function yearLaw(data: TaxData, year: number, ops: readonly LawOp[], ruleSetId: string): YearLaw {
  const source = data.years.get(Math.min(year, data.lastPublishedYear));
  if (!source) throw new RangeError(`no tax year file for ${year}`);
  const active = ops.filter((o) => covers(o.op, year));
  if (active.length === 0) return { rec: source, nominal: new Set(), ssScale: 1, frozen: false };
  const rec = structuredClone(source) as FederalYearRecord;
  const nominal = new Set<string>();
  let ssScale = 1;
  let frozen = false;
  for (const { id, op } of active) {
    switch (op.op) {
      case "setValue":
        if (!sameShape(yearValueAt(rec, op.path), op.value)) lawInvalid(ruleSetId, year, `${id}: the value set at ${op.path} does not have the shape of the year file's value`);
        setAt(rec, op.path, structuredClone(op.value));
        if (op.dollars === "nominal") nominal.add(op.path);
        else nominal.delete(op.path);
        break;
      case "replaceSchedule":
        for (const key of ["ordinary", "standardDeduction", "additionalAged", "capitalGains"] as const) {
          const table = op.table[key];
          if (table === undefined) continue;
          (rec as Record<typeof key, unknown>)[key] = structuredClone(table);
          for (const p of [...nominal]) if (p === key || p.startsWith(`${key}.`)) nominal.delete(p);
        }
        break;
      case "shiftOrdinaryRates":
        rec.ordinary.rates = rec.ordinary.rates.map((r) => r + op.delta);
        break;
      case "freezeIndexing":
        frozen = true;
        break;
      case "scaleSocialSecurity":
        ssScale *= op.factor;
        break;
    }
  }
  checkLawYear(rec, ruleSetId, year);
  return { rec, nominal, ssScale, frozen };
}

// ---------------------------------------------------------------------------------------------
// compileTaxLaw

export interface CompileTaxLawOptions {
  /** Calendar year of plan year 0 (at least the first tax year of the data). */
  startYear: number;
  /** Plan years, at least 1. */
  years: number;
  /** A rule set id of `tax/rules.json` (`RunSettings.taxRuleSet`). */
  ruleSetId: string;
  /** The frozen input's `socialSecurity.adjustment`: every benefit × `factor` from `fromYear` on. */
  ssAdjustment?: { fromYear: number; factor: number } | undefined;
}

export interface CompileWarning {
  readonly code: "tax_data_stale" | "limits_pending" | "rmd_joint_table_unavailable";
  readonly message: string;
}

/** A run's tax law, flattened per plan year (tax-rmd-ss §4.1). Treat every array as read-only. */
export interface CompiledTaxLaw {
  readonly startYear: number;
  readonly years: number;
  readonly lastPublishedYear: number;
  readonly dataVersion: string;
  readonly ruleSetId: string;
  /** years × 2 × TAX_REC, at `taxOffset(i, status)`. */
  readonly taxBase: Float64Array;
  readonly taxStep: Float64Array;
  readonly taxMode: Uint8Array;
  /** years × PROG_REC, at `progOffset(i)`. */
  readonly progBase: Float64Array;
  readonly progStep: Float64Array;
  readonly progMode: Uint8Array;
  /** Per plan year: 1 when a `freezeIndexing` law change covers the year. */
  readonly frozen: Uint8Array;
  /**
   * The same flag for the calendar years after the last published year and before the plan starts
   * (`lastPublishedYear + 1 + j`), whose factors grow with `staleInflation`.
   */
  readonly preStartFrozen: Uint8Array;
  readonly staleInflation: number;
  /** `ss/rules.json`'s `colaStep` (0.001): a COLA is rounded to a multiple of it (`roundCola`). */
  readonly colaStep: number;
  readonly warnings: readonly CompileWarning[];
}

const MAX_YEARS = 200;

function compileWarnings(data: TaxData, startYear: number, years: number): CompileWarning[] {
  const L = data.lastPublishedYear;
  const lastYear = startYear + years - 1;
  const out: CompileWarning[] = [];
  if (startYear > L) {
    const pct = `${(data.rules.staleInflation * 100).toFixed(1)}%`;
    out.push({
      code: "tax_data_stale",
      message: `The plan starts in ${startYear}, after ${L}, the last year with published tax tables; the years in between are indexed with an assumed inflation of ${pct} a year.`,
    });
  }
  for (const y of [...data.years.values()].sort((a, b) => a.taxYear - b.taxYear)) {
    const fields = y.contributionLimits.pending;
    if (fields.length === 0) continue;
    const read = (startYear <= y.taxYear && y.taxYear <= lastYear) || (y.taxYear === L && lastYear > L);
    if (!read) continue;
    out.push({
      code: "limits_pending",
      message: `The ${y.taxYear} contribution limits ${fields.join(", ")} are not yet published; the plan uses the previous year's amounts${y.taxYear === L ? " and indexes later years from them" : ""}.`,
    });
  }
  if (data.joint.rows.length === 0) {
    out.push({
      code: "rmd_joint_table_unavailable",
      message: "The Joint and Last Survivor table is not installed; required minimum distributions use the Uniform Lifetime table for every owner.",
    });
  }
  return out;
}

/**
 * The run's law: the rule set resolved (`TaxDataError("unknown_rule_set")`), its operations applied
 * to every plan year in the order of the rule set (`TaxDataError("law_change_invalid")` when a year
 * then breaks an invariant), and each year flattened into the slot layouts. Called once per
 * `prepare` (seams C12); a malformed option is a caller fault and throws `RangeError`.
 */
export function compileTaxLaw(data: TaxData, o: CompileTaxLawOptions): CompiledTaxLaw {
  const { startYear, years, ruleSetId } = o;
  if (!Number.isInteger(startYear) || startYear < data.firstTaxYear) throw new RangeError(`startYear must be an integer year from ${data.firstTaxYear}, got ${startYear}`);
  if (!Number.isInteger(years) || years < 1 || years > MAX_YEARS) throw new RangeError(`years must be an integer from 1 to ${MAX_YEARS}, got ${years}`);
  const adj = o.ssAdjustment;
  if (adj !== undefined && (!Number.isInteger(adj.fromYear) || !(Number.isFinite(adj.factor) && adj.factor >= 0))) {
    throw new RangeError("ssAdjustment needs an integer fromYear and a finite factor of at least 0");
  }
  const set = data.rules.ruleSets.find((r) => r.id === ruleSetId);
  if (!set) throw new TaxDataError("unknown_rule_set", `unknown tax rule set ${JSON.stringify(ruleSetId)}`);
  const ops: LawOp[] = set.lawChanges.flatMap((id) => {
    const change = data.rules.lawChanges[id];
    if (!change) throw new TaxDataError("tax_data_invalid", `tax/rules.json: rule set ${set.id} names an unknown law change ${id}`);
    return change.ops.map((op) => ({ id, op }));
  });
  const rules = indexingRules(data);
  const L = data.lastPublishedYear;

  const taxBase = new Float64Array(years * 2 * TAX_REC);
  const taxStep = new Float64Array(years * 2 * TAX_REC);
  const taxMode = new Uint8Array(years * 2 * TAX_REC);
  const progBase = new Float64Array(years * PROG_REC);
  const progStep = new Float64Array(years * PROG_REC);
  const progMode = new Uint8Array(years * PROG_REC);
  const frozen = new Uint8Array(years);
  const preStartFrozen = new Uint8Array(Math.max(0, startYear - L - 1));
  for (let j = 0; j < preStartFrozen.length; j++) {
    const y = L + 1 + j;
    preStartFrozen[j] = ops.some((x) => x.op.op === "freezeIndexing" && covers(x.op, y)) ? 1 : 0;
  }

  const flatten = (law: YearLaw, published: boolean, sources: readonly SlotSource[], off: number, status: Status, base: Float64Array, step: Float64Array, mode: Uint8Array) => {
    for (const src of sources) {
      base[off + src.slot] = readSource(law.rec, src, status);
      const rule = published || law.nominal.has(src.path) ? undefined : rules.get(src.path);
      if (rule) {
        mode[off + src.slot] = modeOf(rule);
        step[off + src.slot] = stepOf(rule, src, status);
      }
    }
  };

  for (let i = 0; i < years; i++) {
    const year = startYear + i;
    const published = year <= L;
    const law = yearLaw(data, year, ops, set.id);
    frozen[i] = law.frozen ? 1 : 0;
    for (const status of [0, 1] as const) {
      const off = taxOffset(i, status);
      flatten(law, published, TAX_SOURCES, off, status === 0 ? "single" : "mfj", taxBase, taxStep, taxMode);
      taxBase[off + TR.N_BRACKETS] = N_BRACKETS;
      taxBase[off + TR.THR0 + N_BRACKETS] = Infinity;
    }
    const po = progOffset(i);
    flatten(law, published, PROG_SOURCES, po, "single", progBase, progStep, progMode);
    progBase[po + PR.COLA] = published ? law.rec.socialSecurity.cola : 0;
    progBase[po + PR.SS_SCALE] = law.ssScale * (adj !== undefined && year >= adj.fromYear ? adj.factor : 1);
  }

  return Object.freeze({
    startYear,
    years,
    lastPublishedYear: L,
    dataVersion: data.dataVersion,
    ruleSetId: set.id,
    taxBase,
    taxStep,
    taxMode,
    progBase,
    progStep,
    progMode,
    frozen,
    preStartFrozen,
    staleInflation: data.rules.staleInflation,
    colaStep: data.ss.colaStep,
    warnings: Object.freeze(compileWarnings(data, startYear, years)),
  });
}

// ---------------------------------------------------------------------------------------------
// fillPathTables

export interface FillOptions {
  /** A fraction a year taken off the price index (tax decision 6; `TaxSettings.chainedCpiWedgeBp / 10000`). */
  chainedCpiWedge: number;
  /** A fraction a year by which wages outgrow prices (`TaxSettings.realWageGrowthBp / 10000`). */
  realWageGrowth: number;
}

/**
 * Writes one plan year's records at index factors `F` and `W` and COLA `cola` (used only after the
 * last published year). `fillPathTables` calls it for every plan year; the previews call it with a
 * factor the owner typed. Allocates nothing.
 */
export function fillYearAtFactors(law: CompiledTaxLaw, i: number, F: number, W: number, cola: number, outTax: Float64Array, outProg: Float64Array): void {
  const { taxBase, taxStep, taxMode, progBase, progStep, progMode } = law;
  for (let s = 0; s < 2; s++) {
    const off = (i * 2 + s) * TAX_REC;
    for (let k = 0; k < TAX_REC; k++) outTax[off + k] = indexedValue(taxBase[off + k]!, taxMode[off + k]!, taxStep[off + k]!, F, W);
    // Tax at each lower bound: BASE_0 = 0, BASE_b = BASE_{b−1} + (THR_b − THR_{b−1}) × RATE_{b−1}.
    let base = 0;
    outTax[off + TR.BASE0] = 0;
    for (let b = 1; b < N_BRACKETS; b++) {
      base = base + (outTax[off + TR.THR0 + b]! - outTax[off + TR.THR0 + b - 1]!) * outTax[off + TR.RATE0 + b - 1]!;
      outTax[off + TR.BASE0 + b] = base;
    }
  }
  const po = i * PROG_REC;
  for (let k = 0; k < PROG_REC; k++) outProg[po + k] = indexedValue(progBase[po + k]!, progMode[po + k]!, progStep[po + k]!, F, W);
  if (law.startYear + i > law.lastPublishedYear) outProg[po + PR.COLA] = cola;
  outProg[po + PR.CPI_FACTOR] = F;
  outProg[po + PR.WAGE_FACTOR] = W;
}

/**
 * Fills one path's tax table (`years × 2 × TAX_REC`) and program table (`years × PROG_REC`).
 * `indexInflation[i]` is the path's inflation rate for the whole calendar year `startYear + i`
 * (for year 0 the full-year rate, never the part-year factor; seams C22). Every slot is written, so
 * buffers can be reused across paths. Allocates nothing.
 *
 * The COLA of a year `Y` after the last published year `L` (§3.9.6): with `P_L = 1`, `H = 1` and
 * `P_Y = P_{Y−1} × (1 + π(Y − 1))`, `cola_Y = roundCola(P_Y / H − 1, colaStep)` (to the nearest
 * 0.1%, a half step up, never negative; socialSecurity.ts), and `H = P_Y` when `cola_Y > 0`, so a
 * year after a deflation is measured from the last level that produced an adjustment.
 */
export function fillPathTables(law: CompiledTaxLaw, indexInflation: Float64Array, o: FillOptions, outTax: Float64Array, outProg: Float64Array): void {
  const S = law.startYear;
  const L = law.lastPublishedYear;
  const years = law.years;
  if (indexInflation.length < years || outTax.length < years * 2 * TAX_REC || outProg.length < years * PROG_REC) {
    throw new RangeError("fillPathTables: an inflation rate per plan year and tables of years × 2 × TAX_REC and years × PROG_REC are needed");
  }
  const wedge = 1 - o.chainedCpiWedge;
  const growth = o.realWageGrowth;
  const stale = law.staleInflation;
  const colaStep = law.colaStep;
  let F = 1;
  let W = 1;
  let P = 1;
  let H = 1;
  let cola = 0;
  // Calendar years after the data and before the plan: π is the stale-data inflation.
  for (let y = L + 1; y < S; y++) {
    if (law.preStartFrozen[y - L - 1] === 0) F = F * (1 + stale) * wedge;
    W = W * (1 + stale + growth);
    P = P * (1 + stale);
    cola = roundCola(P / H - 1, colaStep);
    if (cola > 0) H = P;
  }
  for (let i = 0; i < years; i++) {
    const y = S + i;
    if (y > L) {
      const pi = y - 1 >= S ? indexInflation[y - 1 - S]! : stale;
      if (law.frozen[i] === 0) F = F * (1 + pi) * wedge;
      W = W * (1 + pi + growth);
      P = P * (1 + pi);
      cola = roundCola(P / H - 1, colaStep);
      if (cola > 0) H = P;
    }
    fillYearAtFactors(law, i, F, W, cola, outTax, outProg);
  }
}
