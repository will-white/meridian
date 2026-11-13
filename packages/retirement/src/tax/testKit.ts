/**
 * Test support for the tax area (not exported from the package): named tax inputs, filled tables
 * and fixture data with extra law changes. Used by the tax tests of steps 6 and 7 and available to
 * the later steps' tests (penalties, RMDs, the loop on the real slot layouts).
 */

import { compileTaxLaw, fillPathTables, type CompiledTaxLaw, type FillOptions } from "./compile.js";
import { federalTaxInto } from "./federalTax.js";
import { PROG_REC, TAX_IN, TAX_OUT, TAX_REC, TI, taxOffset, type FilingStatusIndex } from "./layout.js";
import { rawTaxData, validateTaxData, type TaxData } from "./taxData.js";

export type TaxInputName = Exclude<keyof typeof TI, "RESERVED0">;

/** A tax input record from named slots (every other slot 0). */
export function taxInput(fields: Partial<Record<TaxInputName, number>>): Float64Array {
  const x = new Float64Array(TAX_IN);
  for (const [name, value] of Object.entries(fields)) x[TI[name as TaxInputName]] = value as number;
  return x;
}

export interface PathTables {
  readonly law: CompiledTaxLaw;
  readonly tax: Float64Array;
  readonly prog: Float64Array;
}

export interface TablesOptions {
  startYear: number;
  years: number;
  ruleSetId?: string;
  /** One rate for every plan year, or one per plan year (missing years are 0). */
  inflation?: number | readonly number[];
  fill?: Partial<FillOptions>;
  ssAdjustment?: { fromYear: number; factor: number };
}

/** Compiles a law and fills one path's tables. */
export function pathTables(data: TaxData, o: TablesOptions): PathTables {
  const law = compileTaxLaw(data, { startYear: o.startYear, years: o.years, ruleSetId: o.ruleSetId ?? "current_law", ssAdjustment: o.ssAdjustment });
  const inflation = new Float64Array(o.years);
  for (let i = 0; i < o.years; i++) {
    const v = typeof o.inflation === "number" ? o.inflation : o.inflation?.[i];
    inflation[i] = v ?? 0;
  }
  const tax = new Float64Array(o.years * 2 * TAX_REC);
  const prog = new Float64Array(o.years * PROG_REC);
  fillPathTables(law, inflation, { chainedCpiWedge: o.fill?.chainedCpiWedge ?? 0, realWageGrowth: o.fill?.realWageGrowth ?? 0 }, tax, prog);
  return { law, tax, prog };
}

/** The tax outputs of one household-year on filled tables. */
export function taxOn(t: PathTables, calendarYear: number, status: FilingStatusIndex, x: Float64Array): Float64Array {
  const r = new Float64Array(TAX_OUT);
  federalTaxInto(t.tax, taxOffset(calendarYear - t.law.startYear, status), x, r);
  return r;
}

/** The bundled data with extra law changes and rule sets (validated like the real files). */
export function dataWithLawChanges(
  lawChanges: Record<string, { label: string; illustrative: boolean; description: string; ops: unknown[] }>,
  ruleSets: Array<{ id: string; label: string; lawChanges: string[] }>,
): TaxData {
  const raw = structuredClone(rawTaxData());
  const rules = raw.rules as { lawChanges: Record<string, unknown>; ruleSets: unknown[] };
  Object.assign(rules.lawChanges, lawChanges);
  rules.ruleSets.push(...ruleSets);
  return validateTaxData(raw);
}
