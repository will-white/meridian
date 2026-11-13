/**
 * What inputs-and-data and the API read from the tax area's data (tax-rmd-ss §4.1 rulesView.ts).
 * Step 4 builds the parts that are plain reads of the data files; `buildRulesView`,
 * `contributionLimit` and the previews are step 11 and compose these.
 */

import { DATA_MANIFEST } from "../version.js";
import { loadTaxData, type TaxData } from "./taxData.js";

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
