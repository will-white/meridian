/**
 * What inputs-and-data and the API read from the tax area (tax-rmd-ss §4.1 rulesView.ts, §4.4,
 * §6; seams §2.4, C42): the data's first year and rule sets for `PlannerEnv`, the full-retirement-age
 * table for `GET /meta`, `contributionLimit` for the resolver's warning, and the three read-only
 * routes: 22 `GET /rules` (`buildRulesView`), 23 `POST /tax-preview` (`federalTaxPreview`) and
 * 24 `POST /social-security-preview` (`socialSecurityPreviewView`, built with the Social Security
 * functions in socialSecurity.ts and re-exported here).
 *
 * Everything here allocates and is called per request or per resolve, never in the loop. Errors:
 * `TaxDataError` (`unknown_rule_set`) and `TaxInputError` (`tax_input_invalid`,
 * `qualified_exceeds_ordinary`), which the route handlers map to `PlanError(400, code)`; a malformed
 * `today` is a `RangeError` (the routes pass a date already checked by `resolveToday`).
 */

import { PLANNER_DISCLAIMER, type FederalTaxPreviewRequest, type FederalTaxPreviewResponse, type RetirementRulesView } from "@meridian/shared";
import { DATA_MANIFEST } from "../version.js";
import { computeFederalTax, type FederalTaxInput } from "./federalTax.js";
import { NOT_MODELLED } from "./notModelled.js";
import { ssRuleVerification } from "./socialSecurity.js";
import { TAX_DRAG_CLASSES } from "./taxDrag.js";
import { loadTaxData, type TaxData } from "./taxData.js";

export { contributionLimit } from "./contributionLimits.js";
export type { ContributionLimitKind } from "./contributionLimits.js";
export { socialSecurityPreviewView, SS_RULES, ssRuleVerification } from "./socialSecurity.js";
export { NOT_MODELLED } from "./notModelled.js";

/** The first tax year with a published year file; a plan may not start earlier. */
export const TAX_DATA_FIRST_YEAR: number = DATA_MANIFEST.firstTaxYear;

/** The rule sets of `tax/rules.json`, `current_law` first. */
export function listTaxRuleSets(data: TaxData = loadTaxData()): Array<{ id: string; label: string }> {
  const sets = data.rules.ruleSets.map((r) => ({ id: r.id, label: r.label }));
  return [...sets.filter((r) => r.id === "current_law"), ...sets.filter((r) => r.id !== "current_law")];
}

/** The full-retirement-age table by birth year, from 1900 (the lowest year the profile accepts). */
export function fullRetirementAgeTable(
  data: TaxData = loadTaxData(),
): Array<{ fromBirthYear: number; toBirthYear: number | null; years: number; months: number }> {
  const rows = data.ss.retirementFraMonths;
  return rows.map(([year, months], i) => ({
    fromBirthYear: i === 0 ? 1900 : (rows[i - 1] as readonly [number, number])[0] + 1,
    toBirthYear: i === rows.length - 1 ? null : year,
    years: Math.floor(months / 12),
    months: months % 12,
  }));
}

/** True when the calendar year of `today` (YYYY-MM-DD) is after the last published tax year. */
export function taxDataStale(today: string, data: TaxData = loadTaxData()): boolean {
  const m = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(today);
  if (!m) throw new RangeError(`today must be a date YYYY-MM-DD, got ${today}`);
  return Number(m[1]) > data.lastPublishedYear;
}

/** The published years whose plan limits are not yet published, with the fields carried forward. */
export function pendingLimits(data: TaxData = loadTaxData()): Array<{ year: number; fields: string[] }> {
  return [...data.years.values()]
    .filter((y) => y.contributionLimits.pending.length > 0)
    .sort((a, b) => a.taxYear - b.taxYear)
    .map((y) => ({ year: y.taxYear, fields: [...y.contributionLimits.pending] }));
}

/** A data fraction as basis points, rounded half away from zero (an engine-side ratio, seams C44). */
function fractionBp(x: number): number {
  return Math.sign(x) * Math.floor(Math.abs(x) * 10000 + 0.5);
}

/**
 * Route 22 (`GET /rules`): the data version, staleness on `today`, the pending limits, every
 * published year file, the rule sets with their law changes, the indexing rules, the yield
 * assumptions in basis points, what is not modelled, the Social Security rules with their
 * verification status (plan decision 11), every source and the planner's disclaimer.
 */
export function buildRulesView(today: string, data: TaxData = loadTaxData()): RetirementRulesView {
  const lawChange = (id: string) => {
    const c = data.rules.lawChanges[id];
    if (!c) throw new RangeError(`tax/rules.json names an unknown law change ${id}`);
    return { id, label: c.label, description: c.description, illustrative: c.illustrative };
  };
  const ruleSets = listTaxRuleSets(data).map(({ id, label }) => {
    const set = data.rules.ruleSets.find((r) => r.id === id)!;
    const lawChanges = set.lawChanges.map(lawChange);
    return { id, label, illustrative: lawChanges.some((c) => c.illustrative), lawChanges };
  });
  const taxDrag = Object.fromEntries(
    TAX_DRAG_CLASSES.map((c) => {
      const d = data.drag.classes[c];
      return [
        c,
        {
          dividendYieldBp: fractionBp(d.dividendYield),
          qualifiedShareBp: fractionBp(d.qualifiedShare),
          interestSpreadBp: d.interest === "none" ? null : fractionBp(d.interestSpread),
          taxExemptShareBp: fractionBp(d.taxExemptShare),
          gainDistributionRateBp: fractionBp(d.gainDistributionRate),
        },
      ];
    }),
  ) as RetirementRulesView["taxDrag"];
  return {
    dataVersion: data.dataVersion,
    firstTaxYear: data.firstTaxYear,
    lastPublishedYear: data.lastPublishedYear,
    stale: taxDataStale(today, data),
    pendingLimits: pendingLimits(data),
    years: [...data.years.values()].sort((a, b) => a.taxYear - b.taxYear).map((y) => structuredClone(y)),
    ruleSets,
    indexing: data.rules.indexing.map((r) => ({ path: r.path, index: r.index, round: r.round })),
    taxDrag,
    notModelled: NOT_MODELLED.map((e) => ({ id: e.id, label: e.label, effect: e.effect })),
    socialSecurityRules: ssRuleVerification(data).map((r) => ({ id: r.id, label: r.label, status: r.status })),
    sources: data.sources.map((s) => ({ file: s.file, title: s.title, url: s.url, retrieved: s.retrieved, sha256: s.sha256 })),
    disclaimer: PLANNER_DISCLAIMER,
  };
}

/** The cents fields of the preview request; each is a decimal string on the wire and a bigint in `FederalTaxInput`. */
const PREVIEW_CENTS = [
  "wagesCents",
  "pensionCents",
  "taxableInterestCents",
  "taxExemptInterestCents",
  "ordinaryDividendsCents",
  "qualifiedDividendsCents",
  "shortTermGainCents",
  "longTermGainCents",
  "lossCarryInCents",
  "traditionalDistributionsCents",
  "rothConversionsCents",
  "rothTaxableEarningsCents",
  "hsaTaxableCents",
  "socialSecurityCents",
  "rentalNetCents",
  "otherOrdinaryCents",
  "adjustmentsCents",
  "penalty10BaseCents",
  "penalty20BaseCents",
] as const satisfies ReadonlyArray<keyof FederalTaxPreviewRequest & keyof FederalTaxInput>;

/**
 * Route 23 (`POST /tax-preview`): one household-year through `federalTaxInto` (via
 * `computeFederalTax`), the request already parsed by `FederalTaxPreviewRequest`. After the last
 * published year every indexed amount is at `indexFactorBp / 10000`. Throws `TaxDataError` for an
 * unknown rule set and `TaxInputError("qualified_exceeds_ordinary")` when qualified dividends exceed
 * ordinary dividends.
 */
export function federalTaxPreview(req: FederalTaxPreviewRequest, data: TaxData = loadTaxData()): FederalTaxPreviewResponse {
  const input: FederalTaxInput = { year: req.year, filingStatus: req.filingStatus, ages: req.ages, indexFactor: req.indexFactorBp / 10000, ruleSetId: req.ruleSetId };
  for (const k of PREVIEW_CENTS) input[k] = BigInt(req[k]);
  const r = computeFederalTax(input, data);
  const detail = Object.fromEntries(Object.entries(r.detail).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])) as FederalTaxPreviewResponse["detail"];
  return {
    dataVersion: r.dataVersion,
    dataStatus: r.dataStatus,
    detail,
    provisionalIncomeCents: r.provisionalIncomeCents.toString(),
    unusedDeductionCents: r.unusedDeductionCents.toString(),
    roomInBracketCents: r.roomInBracketCents === null ? null : r.roomInBracketCents.toString(),
    roomAtZeroGainsCents: r.roomAtZeroGainsCents.toString(),
    lossUsedCents: r.lossUsedCents.toString(),
    marginalOrdinaryRate: r.marginalOrdinaryRate,
    marginalGainRate: r.marginalGainRate,
    lines: r.lines.map((l) => ({ form: l.form, line: l.line, label: l.label, cents: l.cents.toString() })),
  };
}
