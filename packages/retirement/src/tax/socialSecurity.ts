/**
 * Social Security (tax-rmd-ss §3.9). Step 4 builds only the full-retirement-age lookups, which the
 * data tests (A5) and the rules view need; the benefit functions are step 10.
 */

import { loadTaxData, type TaxData } from "./taxData.js";

/** Months of age at a birth-year table row: the first row whose year is at or after `birthYear`. */
function birthYearRow(rows: ReadonlyArray<readonly [number, number]>, birthYear: number): number {
  for (const [year, months] of rows) if (birthYear <= year) return months;
  return (rows[rows.length - 1] as readonly [number, number])[1];
}

/** Full retirement age in months for a retirement or spousal benefit (780 = 65, 792 = 66, 804 = 67). */
export function fraMonths(birthYear: number, data: TaxData = loadTaxData()): number {
  return birthYearRow(data.ss.retirementFraMonths, birthYear);
}

/** Full retirement age in months for a widow(er)'s benefit: the retirement table read two birth years earlier. */
export function survivorFraMonths(birthYear: number, data: TaxData = loadTaxData()): number {
  return birthYearRow(data.ss.retirementFraMonths, birthYear - data.ss.survivorFraBirthYearShift);
}
