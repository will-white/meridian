import {
  AssetClass,
  defaultRunSettings,
  diffPatch,
  effectiveInputsView,
  effectiveProfileDoc,
  glideWeightsAt,
  isPlainObject,
  overrideChanges,
  ParametricParams,
  resolvePlan,
  RetirementProfileDoc,
  RunSettings,
  StrategyConfig,
  truncDiv,
  UpdateScenarioBody,
  type ClassWeights,
  type EffectiveInputsView,
  type GlidePath,
  type HistoricalCohorts,
  type MeanKind,
  type OverrideChange,
  type ParametricPreset,
  type PersonId,
  type PlanIssue,
  type PlanProvenance,
  type RetirementBaseline,
  type RetirementMeta,
  type ScenarioView,
  type StrategyKind,
  type TaxableRebalance,
} from "@meridian/shared";
import { money } from "./format.js";
import { bpToPercentInput, percentToBp } from "./investments.js";
import { changeLabel, type ChangeNames } from "./retirement.js";
import { dollarsInputValue, monthText, parseDollarsInput, parseSignedPercent, parseWholeNumber, percentInputValue, percentText, ratioBp } from "./retirementFormat.js";

/**
 * Form models for the profile wizard and the scenario editor (strategies-outputs-web §5.2 to §5.4,
 * inputs-and-data §3.3 and §4.7, seams G2 and G3, plan decisions 6 and 7). Each form holds the
 * text the person typed; parsing turns it into the shared shapes in integers (basis points, cents,
 * whole years) and validates it with the shared Zod schemas, so a form never sends what the API
 * would refuse. Nothing here does arithmetic on money in floats.
 */

// ---- Dot paths into a document ----

/** The value at a dot path ("people.p1.retirementAge", "spending.phases.0.fromAge"); undefined when absent. */
export function valueAt(doc: unknown, path: string): unknown {
  let at: unknown = doc;
  for (const key of path === "" ? [] : path.split(".")) {
    if (Array.isArray(at) && /^\d+$/.test(key)) at = at[Number(key)];
    else if (isPlainObject(at) && Object.hasOwn(at, key)) at = at[key];
    else return undefined;
  }
  return at;
}

function setIn(container: unknown, keys: readonly string[], value: unknown): unknown {
  const [key, ...rest] = keys;
  if (key === undefined) return value;
  if (Array.isArray(container) && /^\d+$/.test(key)) {
    const copy = [...container];
    const i = Number(key);
    if (rest.length === 0 && value === undefined) copy.splice(i, 1);
    else copy[i] = setIn(copy[i], rest, value);
    return copy;
  }
  const copy: Record<string, unknown> = isPlainObject(container) ? { ...container } : {};
  if (rest.length === 0 && value === undefined) {
    delete copy[key];
    return copy;
  }
  Object.defineProperty(copy, key, { value: setIn(Object.hasOwn(copy, key) ? copy[key] : undefined, rest, value), enumerable: true, writable: true, configurable: true });
  return copy;
}

/** A copy of `doc` with the value at `path` replaced (missing parents are created); `undefined` removes the key. Never mutates. */
export function setAt<T>(doc: T, path: string, value: unknown): T {
  return setIn(doc, path === "" ? [] : path.split("."), value) as T;
}

// ---- The scenario editor's merge-patch flow (inputs §3.3, §4.7 routes 8 and 10) ----

/**
 * A scenario being edited. The editor holds the whole effective document; the server stores
 * `diffPatch(profile.doc, doc)` (inputs §4.7), so a field edited back to the profile's value leaves
 * the patch. `profileRevision` is the profile revision the editor loaded: a profile change made
 * meanwhile is refused (`409 revision_conflict`), never frozen into the scenario.
 */
export interface ScenarioDraft {
  profileDoc: RetirementProfileDoc;
  profileRevision: number;
  scenarioRevision: number;
  doc: RetirementProfileDoc;
  /** The scenario's overrides no longer applied to the profile (`override_invalid`), so the editor started from the profile. */
  overridesLost?: { path: string; message: string };
}

/** The editor's starting draft: the scenario's effective document (`ScenarioView.doc`, else the shared `effectiveProfileDoc`). */
export function startScenarioDraft(profile: { doc: RetirementProfileDoc; revision: number }, scenario: Pick<ScenarioView, "overrides" | "doc" | "revision">): ScenarioDraft {
  const base = { profileDoc: profile.doc, profileRevision: profile.revision, scenarioRevision: scenario.revision };
  if (scenario.doc !== null) return { ...base, doc: scenario.doc };
  const effective = effectiveProfileDoc(profile.doc, scenario.overrides);
  if (effective.ok) return { ...base, doc: effective.doc };
  return { ...base, doc: profile.doc, overridesLost: { path: effective.path, message: effective.message } };
}

/** The draft with one field changed. */
export function editDraft(draft: ScenarioDraft, path: string, value: unknown): ScenarioDraft {
  return { ...draft, doc: setAt(draft.doc, path, value) };
}

/** What the server will store: the minimal merge patch over the profile. */
export function draftPatch(draft: ScenarioDraft): Record<string, unknown> {
  return diffPatch(draft.profileDoc, draft.doc);
}

/** The draft's changes against the profile, each with its chip label (`changeLabel`). */
export function draftChanges(draft: ScenarioDraft, names?: ChangeNames): Array<OverrideChange & { label: string }> {
  return overrideChanges(draft.profileDoc, draftPatch(draft)).map((c) => ({ ...c, label: changeLabel(c.path, c.before, c.after, names) }));
}

/** Whether a field differs from the profile: a change at the path, inside it, or of a whole value that contains it. */
export function isChanged(draft: ScenarioDraft, path: string): boolean {
  return overrideChanges(draft.profileDoc, draftPatch(draft)).some((c) => c.path === path || c.path.startsWith(`${path}.`) || path.startsWith(`${c.path}.`));
}

/** The profile's value of a field, shown greyed beside a changed one. */
export function profileValue(draft: ScenarioDraft, path: string): unknown {
  return valueAt(draft.profileDoc, path);
}

/** "Reset to profile": the field takes the profile's value again, or goes away when the profile has none. */
export function resetToProfile(draft: ScenarioDraft, path: string): ScenarioDraft {
  return { ...draft, doc: setAt(draft.doc, path, valueAt(draft.profileDoc, path)) };
}

export type SaveScenario = { ok: true; body: UpdateScenarioBody } | { ok: false; path: string; message: string };

/** The `PATCH /scenarios/:id` body for the draft (route 10): the whole effective document with both revisions, checked against the shared contract. */
export function scenarioSaveBody(draft: ScenarioDraft): SaveScenario {
  const parsed = UpdateScenarioBody.safeParse({ expectedRevision: draft.scenarioRevision, doc: draft.doc, profileRevision: draft.profileRevision });
  if (parsed.success) return { ok: true, body: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, path: issue ? issue.path.filter((p) => p !== "doc").join(".") : "", message: issue ? issue.message : "invalid document" };
}

/** A name for a duplicate: "Base plan (copy)", then "(copy 2)" and so on, unique without regard to case. */
export function duplicateName(name: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  const stem = name.length > 70 ? name.slice(0, 70).trimEnd() : name;
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? `${stem} (copy)` : `${stem} (copy ${i})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

// ---- The household glide-path editor (seams G3, inputs §3.9) ----

export type WeightsForm = Record<AssetClass, string>;
export interface GlidePointForm {
  age: string;
  weights: WeightsForm;
}
export interface GlidePathForm {
  reference: PersonId;
  points: GlidePointForm[];
}

export const MAX_GLIDE_POINTS = 12;

/** Weights as the percent inputs show them; a 0 class is blank. */
export function weightsForm(weights: ClassWeights): WeightsForm {
  return Object.fromEntries(AssetClass.options.map((c) => [c, weights[c] === 0 ? "" : bpToPercentInput(weights[c])])) as WeightsForm;
}

/** The editor's starting state: the saved glide path, or one point at `start.age` with the account's or the household's mix. */
export function glidePathForm(glide: GlidePath | undefined, start: { age: number; weights: ClassWeights; reference?: PersonId }): GlidePathForm {
  if (glide !== undefined) return { reference: glide.reference, points: glide.points.map((p) => ({ age: String(p.age), weights: weightsForm(p.weights) })) };
  return { reference: start.reference ?? "p1", points: [{ age: String(start.age), weights: weightsForm(start.weights) }] };
}

/** A new point after the last: five years later (at most 119), with the last point's mix. Twelve points at most. */
export function addGlidePoint(form: GlidePathForm): GlidePathForm {
  if (form.points.length >= MAX_GLIDE_POINTS) return form;
  const last = form.points[form.points.length - 1];
  const age = last === undefined ? NaN : Number(last.age);
  const next: GlidePointForm = { age: Number.isInteger(age) ? String(Math.min(119, age + 5)) : "", weights: last === undefined ? weightsForm({ us_stock: 6000, intl_stock: 0, bonds: 4000, cash: 0, real_estate: 0, other: 0 }) : { ...last.weights } };
  return { ...form, points: [...form.points, next] };
}

/** The form without point `i`; the last point is never removed (a glide path has at least one). */
export function removeGlidePoint(form: GlidePathForm, i: number): GlidePathForm {
  if (form.points.length <= 1) return form;
  return { ...form, points: form.points.filter((_, k) => k !== i) };
}

export interface FieldError {
  /** The point, for a point's field. */
  point?: number;
  field: string;
  message: string;
}

/** Six percent inputs to basis points; null with the first problem when they are not percentages summing to 100.00%. */
export function parseWeightsForm(form: WeightsForm): { ok: true; weights: ClassWeights } | { ok: false; field: string; message: string } {
  const out = {} as Record<AssetClass, number>;
  let sum = 0;
  for (const c of AssetClass.options) {
    const raw = form[c].trim();
    const bp = raw === "" ? 0 : percentToBp(raw);
    if (bp === null) return { ok: false, field: c, message: "Enter a percentage from 0 to 100 with at most two decimals" };
    out[c] = bp;
    sum += bp;
  }
  if (sum !== 10000) return { ok: false, field: "weights", message: `The mix must add up to 100% (now ${percentInputValue(sum)}%)` };
  return { ok: true, weights: out };
}

/**
 * The form as the profile's `GlidePath` (seams G3): the reference person must exist; each age a
 * whole number 18 to 119, the ages strictly ascending (the resolver's `glide_order`, shown here
 * inline); each mix sums to 100.00%; one to twelve points.
 */
export function parseGlidePathForm(form: GlidePathForm, people: { p2?: unknown }): { ok: true; glidePath: GlidePath } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  if (form.reference === "p2" && people.p2 === undefined) errors.push({ field: "reference", message: "The household has one person" });
  if (form.points.length < 1 || form.points.length > MAX_GLIDE_POINTS) errors.push({ field: "points", message: `A glide path has 1 to ${MAX_GLIDE_POINTS} points` });
  const points: GlidePath["points"] = [];
  form.points.forEach((p, i) => {
    const age = parseWholeNumber(p.age, 18, 119);
    if (age === null) errors.push({ point: i, field: "age", message: "Enter an age from 18 to 119" });
    const prev = points[points.length - 1];
    if (age !== null && prev !== undefined && age <= prev.age) errors.push({ point: i, field: "age", message: "Ages must rise from one point to the next" });
    const weights = parseWeightsForm(p.weights);
    if (!weights.ok) errors.push({ point: i, field: weights.field, message: weights.message });
    if (age !== null && weights.ok) points.push({ age, weights: weights.weights });
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, glidePath: { reference: form.reference, points } };
}

/**
 * The preview under the editor: the target mix in each year from `fromYear` to `toYear` through the
 * shared `glideWeightsAt` on the points resolved to years (`birthYear(reference) + age`, inputs
 * §3.4 R4), the same function the engine calls (C29).
 */
export function glidePreview(glide: GlidePath, referenceBirthYear: number, fromYear: number, toYear: number): Array<{ year: number; age: number; weights: ClassWeights }> {
  const points = glide.points.map((p) => ({ year: referenceBirthYear + p.age, weights: p.weights }));
  const out: Array<{ year: number; age: number; weights: ClassWeights }> = [];
  for (let year = fromYear; year <= toYear; year++) out.push({ year, age: year - referenceBirthYear, weights: glideWeightsAt(points, year) });
  return out;
}

// ---- The custom parametric form (seams G2) ----

export interface MeanVolForm {
  mean: string;
  vol: string;
}
export interface ParametricForm {
  meanKind: MeanKind;
  stocks: MeanVolForm;
  bonds: MeanVolForm;
  bills: MeanVolForm;
  inflation: MeanVolForm;
}

/**
 * What the run-settings form reads of `GET /meta` (`RetirementMeta.returnModels`, seams C47 and G2):
 * the parametric presets and where a new custom model starts, the latter "means and volatilities;
 * correlations and persistence from history" (the data file's arithmetic means and simple-return
 * volatilities, its inflation persistence and innovation correlations, bills not persistent, each to
 * the nearest basis point). The server computes them from the engine's data, so a data update
 * reaches the form with it; the web may not import the engine.
 */
export type ReturnModelsMeta = Pick<RetirementMeta, "returnModels">;

const meanVolForm = (v: { meanBp: number; volBp: number }): MeanVolForm => ({ mean: percentInputValue(v.meanBp), vol: percentInputValue(v.volBp) });

/** The form from saved custom parameters, or from history (`meta.returnModels.historyStartParams`). */
export function parametricForm(meta: ReturnModelsMeta, params?: ParametricParams): ParametricForm {
  const p = params ?? meta.returnModels.historyStartParams;
  return { meanKind: p.meanKind, stocks: meanVolForm(p.stocks), bonds: meanVolForm(p.bonds), bills: meanVolForm(p.bills), inflation: meanVolForm(p.inflation) };
}

type ParametricAsset = "stocks" | "bonds" | "bills" | "inflation";

/**
 * The form as `ParametricParams` in integer basis points (C3): means −50% to 100%, volatilities 0% to
 * 100%, at most two decimals. Persistence, initial rates and correlations are kept from `base` (the
 * saved custom parameters) or taken from history (`meta`); the result is checked with the shared schema.
 */
export function parseParametricForm(
  form: ParametricForm,
  meta: ReturnModelsMeta,
  base?: ParametricParams,
): { ok: true; params: ParametricParams } | { ok: false; errors: FieldError[] } {
  const start = base ?? meta.returnModels.historyStartParams;
  const errors: FieldError[] = [];
  const read = (asset: ParametricAsset) => {
    const mean = parseSignedPercent(form[asset].mean, -5000, 10000);
    const vol = parseSignedPercent(form[asset].vol, 0, 10000);
    if (mean === null) errors.push({ field: `${asset}.mean`, message: "Enter a mean from -50% to 100% with at most two decimals" });
    if (vol === null) errors.push({ field: `${asset}.vol`, message: "Enter a volatility from 0% to 100% with at most two decimals" });
    return { meanBp: mean ?? 0, volBp: vol ?? 0 };
  };
  const stocks = read("stocks");
  const bonds = read("bonds");
  const bills = read("bills");
  const inflation = read("inflation");
  if (errors.length > 0) return { ok: false, errors };
  const candidate = {
    meanKind: form.meanKind,
    stocks,
    bonds,
    bills: { ...start.bills, ...bills },
    inflation: { ...start.inflation, ...inflation },
    correlationBp: start.correlationBp.map((row) => [...row]),
  };
  const parsed = ParametricParams.safeParse(candidate);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) };
  return { ok: true, params: parsed.data };
}

// ---- Run settings (§5.4, plan decisions 6 and 7, seams C51) ----

export type ModelChoice = "historical" | "bootstrap" | "parametric" | "fixed";

export interface StrategyFields {
  fixedRate: string;
  upperBand: string;
  lowerBand: string;
  cut: string;
  raise: string;
  skipInflationAfterLoss: boolean;
  preservationCutoffYears: string;
  planningAge: string;
  stockReal: string;
  bondReal: string;
  lastWithdrawalAge: string;
  maxRate: string;
  /** Blank: the plan's own percentage. */
  floorCeilingRate: string;
  floor: string;
  ceiling: string;
}

export interface RunSettingsForm {
  paths: string;
  seed: string;
  /** `fixed` is a test model: shown read-only, never offered (engine decision 30). */
  model: ModelChoice;
  cohorts: HistoricalCohorts;
  meanBlockYears: string;
  preset: ParametricPreset;
  custom: ParametricForm;
  strategy: StrategyKind;
  strategyFields: StrategyFields;
  /** Dollars, today's. */
  cashReserve: string;
  taxableRebalance: TaxableRebalance;
  taxRuleSet: string;
  includePayrollTax: boolean;
}

/** The return-model cards (§5.4), the historical cohort choice (plan decision 7) and the parametric presets. */
export const RETURN_MODEL_CHOICES: ReadonlyArray<{ value: Exclude<ModelChoice, "fixed">; label: string; summary: string }> = [
  { value: "historical", label: "Historical sequences", summary: "Every rolling start year of the US record since 1928, as it happened." },
  { value: "bootstrap", label: "Block bootstrap", summary: "New sequences stitched from blocks of real years, keeping crashes and recoveries together. The default." },
  { value: "parametric", label: "Parametric", summary: "Correlated lognormal returns from expected returns and volatilities." },
];
export const COHORT_CHOICES: ReadonlyArray<{ value: HistoricalCohorts; label: string }> = [
  { value: "auto", label: "Complete stretches of history when every life is a fixed age and at least 30 stretches exist, else wrap around (default)" },
  { value: "complete", label: "Complete stretches of history only" },
  { value: "wrap", label: "Every start year, wrapping around to the first year of the record" },
];
/** The parametric presets of `GET /meta` with their labels, then the custom model. */
export function presetChoices(meta: ReturnModelsMeta): Array<{ value: ParametricPreset; label: string }> {
  return [...meta.returnModels.presets.map((p) => ({ value: p.id, label: p.label })), { value: "custom", label: "Your own returns and volatilities" }];
}

const defaultsOf = <K extends StrategyKind>(kind: K) => StrategyConfig.parse({ kind }) as Extract<StrategyConfig, { kind: K }>;

function strategyFields(current: StrategyConfig): StrategyFields {
  const fixed = current.kind === "fixed_percentage" ? current : defaultsOf("fixed_percentage");
  const g = current.kind === "guardrails" ? current : defaultsOf("guardrails");
  const v = current.kind === "vpw" ? current : defaultsOf("vpw");
  const fc = current.kind === "floor_ceiling" ? current : defaultsOf("floor_ceiling");
  const p = percentInputValue;
  return {
    fixedRate: p(fixed.rateBp),
    upperBand: p(g.upperBandBp),
    lowerBand: p(g.lowerBandBp),
    cut: p(g.cutBp),
    raise: p(g.raiseBp),
    skipInflationAfterLoss: g.skipInflationAfterLoss,
    preservationCutoffYears: String(g.preservationCutoffYears),
    planningAge: String(g.planningAge),
    stockReal: p(v.stockRealBp),
    bondReal: p(v.bondRealBp),
    lastWithdrawalAge: String(v.lastWithdrawalAge),
    maxRate: p(v.maxRateBp),
    floorCeilingRate: fc.rateBp === undefined ? "" : p(fc.rateBp),
    floor: p(fc.floorBp),
    ceiling: p(fc.ceilingBp),
  };
}

/**
 * The form for a scenario's settings; with none, the settings of a new scenario (`defaultRunSettings`:
 * the bootstrap with a mean block of 10 years, 10,000 paths, seed 1; plan decision 6, C51). Every
 * strategy's fields are filled (the current kind's values, the others' defaults), so switching
 * the card keeps what was typed.
 */
export function runSettingsForm(meta: ReturnModelsMeta, settings: RunSettings = defaultRunSettings()): RunSettingsForm {
  const m = settings.returnModel;
  return {
    paths: String(settings.paths),
    seed: String(settings.seed),
    model: m.kind,
    cohorts: m.kind === "historical" ? m.cohorts : "auto",
    meanBlockYears: String(m.kind === "bootstrap" ? m.meanBlockYears : 10),
    preset: m.kind === "parametric" ? m.preset : "historical",
    custom: parametricForm(meta, m.kind === "parametric" && m.preset === "custom" ? m.params : undefined),
    strategy: settings.strategy.kind,
    strategyFields: strategyFields(settings.strategy),
    cashReserve: dollarsInputValue(settings.withdrawalOrder.cashReserveCents),
    taxableRebalance: settings.portfolio.taxableRebalance,
    taxRuleSet: settings.taxRuleSet,
    includePayrollTax: settings.tax.includePayrollTax,
  };
}

/** The paths field: disabled for the historical model, which runs one path per start year (§5.4). */
export function pathsField(form: Pick<RunSettingsForm, "model">): { disabled: boolean; note?: string } {
  if (form.model === "historical") return { disabled: true, note: "One path per historical start year" };
  if (form.model === "fixed") return { disabled: true, note: "The fixed test model runs one path" };
  return { disabled: false };
}

function parseStrategy(kind: StrategyKind, f: StrategyFields, errors: FieldError[]): unknown {
  const pct = (field: keyof StrategyFields, min: number, max: number) => {
    const bp = parseSignedPercent(String(f[field]), min, max);
    if (bp === null) errors.push({ field: `strategy.${field}`, message: `Enter a percentage from ${percentInputValue(min)}% to ${percentInputValue(max)}% with at most two decimals` });
    return bp ?? min;
  };
  const whole = (field: keyof StrategyFields, min: number, max: number) => {
    const n = parseWholeNumber(String(f[field]), min, max);
    if (n === null) errors.push({ field: `strategy.${field}`, message: `Enter a whole number from ${min} to ${max}` });
    return n ?? min;
  };
  switch (kind) {
    case "constant_dollar":
      return { kind };
    case "fixed_percentage":
      return { kind, rateBp: pct("fixedRate", 50, 2000) };
    case "guardrails":
      return {
        kind,
        upperBandBp: pct("upperBand", 100, 10000),
        lowerBandBp: pct("lowerBand", 100, 9000),
        cutBp: pct("cut", 0, 5000),
        raiseBp: pct("raise", 0, 5000),
        skipInflationAfterLoss: f.skipInflationAfterLoss,
        preservationCutoffYears: whole("preservationCutoffYears", 0, 60),
        planningAge: whole("planningAge", 80, 119),
      };
    case "vpw":
      return { kind, stockRealBp: pct("stockReal", 0, 1500), bondRealBp: pct("bondReal", 0, 1000), lastWithdrawalAge: whole("lastWithdrawalAge", 85, 119), maxRateBp: pct("maxRate", 100, 10000) };
    case "floor_ceiling": {
      const out: Record<string, unknown> = { kind, floorBp: pct("floor", 0, 9000), ceilingBp: pct("ceiling", 0, 20000) };
      if (f.floorCeilingRate.trim() !== "") out["rateBp"] = pct("floorCeilingRate", 50, 2000);
      return out;
    }
  }
}

/**
 * The form as `RunSettings` (§5.4): integers only, checked with the shared schema. What the form
 * does not show is kept from `base` (the asset map, the yield overrides and other tax settings, a
 * fixed test model). The paths of the historical model are kept as they are: it reports its own
 * count.
 */
export function parseRunSettingsForm(
  form: RunSettingsForm,
  base: RunSettings,
  meta: ReturnModelsMeta,
): { ok: true; settings: RunSettings } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const pathsLocked = pathsField(form).disabled;
  const paths = pathsLocked ? base.paths : parseWholeNumber(form.paths, 100, 100_000);
  if (paths === null) errors.push({ field: "paths", message: "Enter a whole number of paths from 100 to 100,000" });
  const seed = parseWholeNumber(form.seed, 0, 4_294_967_295);
  if (seed === null) errors.push({ field: "seed", message: "Enter a whole number from 0 to 4,294,967,295" });

  let returnModel: unknown;
  switch (form.model) {
    case "historical":
      returnModel = { kind: "historical", cohorts: form.cohorts };
      break;
    case "bootstrap": {
      const block = parseWholeNumber(form.meanBlockYears, 1, 30);
      if (block === null) errors.push({ field: "meanBlockYears", message: "Enter a mean block of 1 to 30 years" });
      returnModel = { kind: "bootstrap", meanBlockYears: block ?? 10 };
      break;
    }
    case "parametric": {
      if (form.preset !== "custom") {
        returnModel = { kind: "parametric", preset: form.preset };
        break;
      }
      const saved = base.returnModel.kind === "parametric" && base.returnModel.preset === "custom" ? base.returnModel.params : undefined;
      const custom = parseParametricForm(form.custom, meta, saved);
      if (!custom.ok) errors.push(...custom.errors.map((e) => ({ ...e, field: `custom.${e.field}` })));
      else returnModel = { kind: "parametric", preset: "custom", params: custom.params };
      break;
    }
    case "fixed":
      returnModel = base.returnModel;
      break;
  }
  const strategy = parseStrategy(form.strategy, form.strategyFields, errors);
  const reserve = parseDollarsInput(form.cashReserve === "" ? "0" : form.cashReserve);
  if (reserve === null) errors.push({ field: "cashReserve", message: "Enter an amount in dollars, at most two decimals" });
  if (errors.length > 0) return { ok: false, errors };

  const parsed = RunSettings.safeParse({
    ...base,
    paths,
    seed,
    returnModel,
    portfolio: { ...base.portfolio, taxableRebalance: form.taxableRebalance },
    strategy,
    withdrawalOrder: { kind: "default", cashReserveCents: (reserve ?? 0n).toString() },
    taxRuleSet: form.taxRuleSet,
    tax: { ...base.tax, includePayrollTax: form.includePayrollTax },
  });
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) };
  return { ok: true, settings: parsed.data };
}

// ---- Seed hints (§5.2) ----

const PROVENANCE_LABELS: Record<PlanProvenance, string> = { live: "from live data", profile: "typed", scenario: "this scenario", default: "default" };

/** A seeded field's provenance in words (§5.2): "from live data", "typed", "this scenario", "default". */
export function provenanceLabel(p: PlanProvenance): string {
  return PROVENANCE_LABELS[p];
}

export interface SeedHint {
  label: string;
  /** "Live value $86,050.00" beside a typed value, with "Use live value". */
  liveText?: string;
  useLive: boolean;
  /** The typed and live values differ by more than 2% or $500 a year, whichever is larger. */
  prominent: boolean;
}

/** The hint beside a seeded amount (§5.2): its provenance and, for a typed value, the live one and whether the gap is worth a look. */
export function seedHint(h: { provenance: PlanProvenance; valueCents: string; liveCents?: string | undefined }): SeedHint {
  const typed = h.provenance === "profile" || h.provenance === "scenario";
  if (!typed || h.liveCents === undefined) return { label: provenanceLabel(h.provenance), useLive: false, prominent: false };
  const value = BigInt(h.valueCents);
  const live = BigInt(h.liveCents);
  const gap = value > live ? value - live : live - value;
  const absLive = live < 0n ? -live : live;
  const threshold = truncDiv(absLive * 200n, 10_000n) > 50_000n ? truncDiv(absLive * 200n, 10_000n) : 50_000n;
  return { label: provenanceLabel(h.provenance), liveText: `Live value ${money(h.liveCents)}`, useLive: gap !== 0n, prominent: gap > threshold };
}

/** The spending evidence (§5.2): "last 12 months of the plan, Nov 2025 to Oct 2026". */
export function spendingEvidence(window: { from: string; to: string; monthsWithData: number }): string {
  return `last ${window.monthsWithData} ${window.monthsWithData === 1 ? "month" : "months"} of the plan, ${monthText(window.from, true)} to ${monthText(window.to, true)}`;
}

/** "Essentials are 60% of your spending" (§5.2); null without base spending. */
export function essentialsShareText(essentialCents: string, baseCents: string): string | null {
  const bp = ratioBp(essentialCents, baseCents);
  return bp === undefined ? null : `Essentials are ${percentText(bp)} of your spending`;
}

// ---- Inline issues: the shared resolver in the browser (§5.2, inputs §5, seams C47) ----

/** A scenario id for the browser's own resolution, whose frozen input is never sent anywhere. */
const BROWSER_SCENARIO_ID = "00000000-0000-4000-8000-000000000000";

export interface InlineIssues {
  issues: PlanIssue[];
  /** The issues of each document path, for the field they belong to. */
  byPath: Map<string, PlanIssue[]>;
  effective?: EffectiveInputsView;
}

/**
 * The form's inline issues (§5.2 "with `resolvePlan` run in the browser for inline issues by
 * path"): the shared `resolvePlan` on the document being edited, with the context built from
 * `GET /meta` and without `contributionLimit` and `validateInput` (seams C47), so
 * `contribution_over_limit` and the engine's own issues come from the server's issue list.
 */
export function inlineIssues(
  args: { doc: RetirementProfileDoc; baseline: RetirementBaseline; overrides?: Readonly<Record<string, unknown>>; settings: RunSettings },
  meta: Pick<RetirementMeta, "dataVersion" | "minStartYear" | "ruleSets">,
  today: string,
): InlineIssues {
  const result = resolvePlan(
    { doc: args.doc, baseline: args.baseline, overrides: args.overrides ?? {}, settings: args.settings },
    {
      today,
      dataVersion: meta.dataVersion,
      ruleSets: meta.ruleSets.map((r) => r.id),
      minStartYear: meta.minStartYear,
      meta: { createdAt: `${today}T00:00:00.000Z`, profileRevision: 0, baselineHash: "", scenarioId: BROWSER_SCENARIO_ID, scenarioRevision: 0, scenarioName: "" },
    },
  );
  const byPath = new Map<string, PlanIssue[]>();
  for (const issue of result.issues) byPath.set(issue.path, [...(byPath.get(issue.path) ?? []), issue]);
  const out: InlineIssues = { issues: result.issues, byPath };
  if (result.effective !== undefined) out.effective = effectiveInputsView(result.effective);
  return out;
}
