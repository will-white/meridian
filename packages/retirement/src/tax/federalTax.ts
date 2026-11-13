/**
 * Federal income tax for one household-year (tax-rmd-ss §3.3 to §3.5, §4.1; seams C23, C30).
 *
 * `federalTaxInto(t, o, x, r)` follows Form 1040 in order: Schedule D netting, Publication 915
 * Worksheet 1, AGI, the standard deduction with the age-65 additions, the senior deduction
 * (Schedule 1-A Part V), taxable income, the Qualified Dividends and Capital Gain Tax Worksheet,
 * Form 8960, then the additional taxes of Form 5329 and Form 8889. It reads the per-path table `t`
 * at record offset `o` and the inputs `x`, writes every slot of the outputs `r`, returns nothing
 * (C30: a returned double is boxed) and allocates nothing. `x` is never written.
 *
 * The partial first year is handled here and nowhere else (C23): with `f = x[YEAR_FRACTION]` and
 * `0 < f < 1`, every dollar input is read as `x[k] / f`, the year is computed on the calendar
 * year's thresholds, and every dollar output is multiplied by `f`, so `Tax_f(x) = f × Tax(x / f)`
 * (decision 44). Rates, the bracket index and `+Infinity` are left alone.
 *
 * `computeFederalTax` is the allocating wrapper for tests, the preview route and the tax drawer:
 * cents in, cents out, rounded half away from zero only through units.ts (L1, C38).
 */

import { addUp, type TaxFilingStatus, type TaxYearDetail } from "@meridian/shared";
import { centsToDollars, dollarsToCentsBigInt } from "../units.js";
import { compileTaxLaw, fillYearAtFactors } from "./compile.js";
import { PROG_REC, TAX_IN, TAX_IN_DOLLAR_SLOTS, TAX_OUT, TAX_REC, TI, TO, TR, taxOffset, type FilingStatusIndex } from "./layout.js";
import { loadTaxData, type TaxData } from "./taxData.js";

/** Ordinary tax on taxable income `z` from the bracket table at `o` (0 for `z ≤ 0`). */
function bracketTax(t: Float64Array, o: number, z: number): number {
  if (z <= 0) return 0;
  let i = 6;
  while (i > 0 && !(t[o + TR.THR0 + i]! < z)) i--;
  return t[o + TR.BASE0 + i]! + (z - t[o + TR.THR0 + i]!) * t[o + TR.RATE0 + i]!;
}

/**
 * One household-year through the federal income tax (§3.3). `t` is a per-path tax table filled by
 * `fillPathTables`, `o` the record offset `taxOffset(yearIndex, status)`, `x` the inputs (layout
 * `TI`, the period's dollars), `r` the outputs (layout `TO`). Total over finite inputs; never throws.
 */
export function federalTaxInto(t: Float64Array, o: number, x: Float64Array, r: Float64Array): void {
  const f0 = x[TI.YEAR_FRACTION]!;
  const f = f0 > 0 && f0 < 1 ? f0 : 1;

  const wages = x[TI.WAGES]! / f;
  const pension = x[TI.PENSION]! / f;
  const interest = x[TI.INTEREST]! / f;
  const taxExemptInterest = x[TI.TAX_EXEMPT_INTEREST]! / f;
  const ordDiv = x[TI.ORD_DIV]! / f;
  const qualDiv = x[TI.QUAL_DIV]! / f;
  const stGain = x[TI.ST_GAIN]! / f;
  const ltGain = x[TI.LT_GAIN]! / f;
  const lossCarryIn = x[TI.LOSS_CARRY_IN]! / f;
  const tradDist = x[TI.TRAD_DIST]! / f;
  const rothConv = x[TI.ROTH_CONV]! / f;
  const rothTaxable = x[TI.ROTH_TAXABLE]! / f;
  const hsaTaxable = x[TI.HSA_TAXABLE]! / f;
  const ssGross = x[TI.SS_GROSS]! / f;
  const rental = x[TI.RENTAL]! / f;
  const otherOrd = x[TI.OTHER_ORD]! / f;
  const niiOther = x[TI.NII_OTHER]! / f;
  const adjustments = x[TI.ADJUSTMENTS]! / f;
  const pen10Base = x[TI.PEN10_BASE]! / f;
  const pen20Base = x[TI.PEN20_BASE]! / f;
  const nAged = x[TI.N_AGED]!;

  // Step 1, Schedule D (lines 7, 14 to 16, 21): one long-term carryover, the loss limit against ordinary income.
  const netLT = ltGain - lossCarryIn;
  const net = stGain + netLT;
  let capInAgi: number;
  let prefGain: number;
  let lossUsed: number;
  let lossCarryOut: number;
  if (net >= 0) {
    capInAgi = net;
    prefGain = Math.max(0, Math.min(netLT, net));
    lossUsed = 0;
    lossCarryOut = 0;
  } else {
    lossUsed = Math.min(-net, t[o + TR.LOSS_LIMIT]!);
    capInAgi = -lossUsed;
    prefGain = 0;
    lossCarryOut = -net - lossUsed;
  }

  // Step 2, income other than Social Security (Publication 915 Worksheet 1 line 3).
  const other = wages + pension + interest + ordDiv + tradDist + rothConv + rothTaxable + hsaTaxable + rental + otherOrd + capInAgi;

  // Step 3, taxable Social Security (Worksheet 1 lines 2 to 19).
  const ssRate1 = t[o + TR.SS_RATE1]!;
  const ssBase1 = t[o + TR.SS_BASE1]!;
  const ssBase2 = t[o + TR.SS_BASE2]!;
  const provisional = other + taxExemptInterest + 0.5 * ssGross - adjustments;
  const tier1 = Math.min(ssRate1 * ssGross, ssRate1 * Math.max(0, provisional - ssBase1), ssRate1 * (ssBase2 - ssBase1));
  const taxableSs = Math.min(t[o + TR.SS_MAX_SHARE]! * ssGross, t[o + TR.SS_RATE2]! * Math.max(0, provisional - ssBase2) + tier1);

  // Step 4.
  const agi = other + taxableSs - adjustments;

  // Step 5, deductions (§63(c), §63(f); Schedule 1-A lines 31 to 37, whose MAGI is AGI here).
  const stdDeduction = t[o + TR.STD]! + nAged * t[o + TR.AGED]!;
  const seniorDeduction = nAged * Math.max(0, t[o + TR.SENIOR_AMT]! - t[o + TR.SENIOR_RATE]! * Math.max(0, agi - t[o + TR.SENIOR_START]!));
  const taxableIncome = Math.max(0, agi - stdDeduction - seniorDeduction);
  const unusedDeduction = Math.max(0, stdDeduction + seniorDeduction - agi);

  // Step 6, Qualified Dividends and Capital Gain Tax Worksheet (lines in brackets).
  const ltcg0 = t[o + TR.LTCG0]!;
  const ltcg15 = t[o + TR.LTCG15]!;
  const ltcgRate1 = t[o + TR.LTCG_RATE1]!;
  const ltcgRate2 = t[o + TR.LTCG_RATE2]!;
  const prefIncome = Math.min(qualDiv + prefGain, taxableIncome); // [10]
  const ordTaxable = taxableIncome - prefIncome; // [5]
  const ordTax = bracketTax(t, o, ordTaxable); // [22]
  const prefAt0 = Math.max(0, Math.min(taxableIncome, ltcg0) - ordTaxable); // [9]
  const prefAt15 = Math.min(prefIncome - prefAt0, Math.max(0, Math.min(taxableIncome, ltcg15) - (ordTaxable + prefAt0))); // [17]
  const prefAt20 = prefIncome - prefAt0 - prefAt15; // [20]
  // [25]: the smaller of [23] and [24]. It is never below [22]; the max only absorbs float noise.
  const incomeTax = Math.max(ordTax, Math.min(ordTax + ltcgRate1 * prefAt15 + ltcgRate2 * prefAt20, bracketTax(t, o, taxableIncome)));
  const cgTax = incomeTax - ordTax;

  // Step 7, Form 8960 (wages, pensions, retirement-account distributions, benefits and tax-exempt interest are not investment income).
  const nii = Math.max(0, interest + ordDiv + rental + niiOther + capInAgi);
  const niit = t[o + TR.NIIT_RATE]! * Math.min(nii, Math.max(0, agi - t[o + TR.NIIT_THRESHOLD]!));

  // Step 8, the additional taxes of Form 5329 and Form 8889 (the bases come from the caller).
  const pen10 = t[o + TR.PEN_EARLY_RATE]! * pen10Base;
  const pen20 = t[o + TR.PEN_HSA_RATE]! * pen20Base;

  // Step 9.
  const total = incomeTax + niit + pen10 + pen20;

  // Step 10, marginal and headroom outputs.
  let bracketIndex = 6;
  while (bracketIndex > 0 && t[o + TR.THR0 + bracketIndex]! > ordTaxable) bracketIndex--;
  const bracketRate = unusedDeduction > 0 ? 0 : t[o + TR.RATE0 + bracketIndex]!;
  const roomInBracket = t[o + TR.THR0 + bracketIndex + 1]! - ordTaxable;
  const roomInLtcg0 = Math.max(0, ltcg0 - taxableIncome);
  const ltcgNextRate = taxableIncome < ltcg0 ? 0 : taxableIncome < ltcg15 ? ltcgRate1 : ltcgRate2;
  const magiIrmaa = agi + taxExemptInterest;
  const magiAca = magiIrmaa + (ssGross - taxableSs);

  r[TO.TOTAL] = total * f;
  r[TO.INCOME_TAX] = incomeTax * f;
  r[TO.ORD_TAX] = ordTax * f;
  r[TO.CG_TAX] = cgTax * f;
  r[TO.NIIT] = niit * f;
  r[TO.PEN10] = pen10 * f;
  r[TO.PEN20] = pen20 * f;
  r[TO.AGI] = agi * f;
  r[TO.TAXABLE_INCOME] = taxableIncome * f;
  r[TO.ORD_TAXABLE] = ordTaxable * f;
  r[TO.TAXABLE_SS] = taxableSs * f;
  r[TO.PROVISIONAL] = provisional * f;
  r[TO.STD_DEDUCTION] = stdDeduction * f;
  r[TO.SENIOR_DEDUCTION] = seniorDeduction * f;
  r[TO.PREF_AT_0] = prefAt0 * f;
  r[TO.PREF_AT_15] = prefAt15 * f;
  r[TO.PREF_AT_20] = prefAt20 * f;
  r[TO.NII] = nii * f;
  r[TO.LOSS_CARRY_OUT] = lossCarryOut * f;
  r[TO.LOSS_USED] = lossUsed * f;
  r[TO.BRACKET_RATE] = bracketRate;
  r[TO.BRACKET_INDEX] = bracketIndex;
  r[TO.ROOM_IN_BRACKET] = roomInBracket * f;
  r[TO.ROOM_IN_LTCG0] = roomInLtcg0 * f;
  r[TO.MAGI_IRMAA] = magiIrmaa * f;
  r[TO.MAGI_ACA] = magiAca * f;
  r[TO.PREF_INCOME] = prefIncome * f;
  r[TO.LTCG_NEXT_RATE] = ltcgNextRate;
  r[TO.UNUSED_DEDUCTION] = unusedDeduction * f;
  for (let k = TO.RESERVED0; k < TAX_OUT; k++) r[k] = 0;
}

/**
 * Effective marginal rates by finite difference (§3.4): `out[0]` = Δ`TOTAL` / 100 for $100 more of
 * `TRAD_DIST`, `out[1]` the same for $100 more of `LT_GAIN`. `scratchIn` (`TAX_IN`) and
 * `scratchOut` (`TAX_OUT`) are caller-owned; `x` is not written. Allocates nothing.
 */
export function effectiveMarginalRates(t: Float64Array, o: number, x: Float64Array, scratchIn: Float64Array, scratchOut: Float64Array, out: Float64Array): void {
  federalTaxInto(t, o, x, scratchOut);
  const base = scratchOut[TO.TOTAL]!;
  for (let k = 0; k < TAX_IN; k++) scratchIn[k] = x[k]!;
  scratchIn[TI.TRAD_DIST] = x[TI.TRAD_DIST]! + 100;
  federalTaxInto(t, o, scratchIn, scratchOut);
  out[0] = (scratchOut[TO.TOTAL]! - base) / 100;
  scratchIn[TI.TRAD_DIST] = x[TI.TRAD_DIST]!;
  scratchIn[TI.LT_GAIN] = x[TI.LT_GAIN]! + 100;
  federalTaxInto(t, o, scratchIn, scratchOut);
  out[1] = (scratchOut[TO.TOTAL]! - base) / 100;
}

// ---------------------------------------------------------------------------------------------
// Validation (tests and previews only, never the loop; §3.5)

export type TaxInputErrorCode = "tax_input_invalid" | "qualified_exceeds_ordinary";

/** A tax input the function's contract does not cover; the preview route answers 400 with `code`. */
export class TaxInputError extends Error {
  readonly permanent = true;
  readonly code: TaxInputErrorCode;
  constructor(code: TaxInputErrorCode, message: string) {
    super(message);
    this.name = "TaxInputError";
    this.code = code;
  }
}

const SIGNED_INPUTS: ReadonlySet<number> = new Set([TI.ST_GAIN, TI.LT_GAIN]);
const INPUT_NAMES = Object.fromEntries(Object.entries(TI).map(([name, slot]) => [slot, name])) as Record<number, string>;

/**
 * Throws `TaxInputError` unless `x` is a valid input record: finite slots, every dollar slot except
 * the two gains at least 0, `QUAL_DIV ≤ ORD_DIV` (`qualified_exceeds_ordinary`), `N_AGED` 0, 1 or 2,
 * `YEAR_FRACTION` in [0, 1].
 */
export function assertTaxInput(x: Float64Array): void {
  if (x.length < TAX_IN) throw new TaxInputError("tax_input_invalid", `a tax input record has ${TAX_IN} slots, got ${x.length}`);
  for (let k = 0; k <= TI.YEAR_FRACTION; k++) {
    const v = x[k]!;
    if (!Number.isFinite(v)) throw new TaxInputError("tax_input_invalid", `${INPUT_NAMES[k]} is not a finite number`);
    if (k < TAX_IN_DOLLAR_SLOTS && !SIGNED_INPUTS.has(k) && v < 0) throw new TaxInputError("tax_input_invalid", `${INPUT_NAMES[k]} must not be negative`);
  }
  if (x[TI.QUAL_DIV]! > x[TI.ORD_DIV]!) throw new TaxInputError("qualified_exceeds_ordinary", "qualified dividends must not exceed ordinary dividends");
  const nAged = x[TI.N_AGED]!;
  if (!(nAged === 0 || nAged === 1 || nAged === 2)) throw new TaxInputError("tax_input_invalid", "N_AGED must be 0, 1 or 2");
  const f = x[TI.YEAR_FRACTION]!;
  if (!(f >= 0 && f <= 1)) throw new TaxInputError("tax_input_invalid", "YEAR_FRACTION must lie in [0, 1]");
}

// ---------------------------------------------------------------------------------------------
// The year table's tax block (seams C37)

/** `TaxYearDetail` with bigint cents (the result of `computeFederalTax`). */
export type TaxYearDetailCents = {
  [K in keyof TaxYearDetail]: K extends `${string}Cents` ? bigint : TaxYearDetail[K];
};

/** A rate as basis points, rounded half away from zero (an engine ratio at the boundary, C44). */
function rateBp(rate: number): number {
  return Math.sign(rate) * Math.floor(Math.abs(rate) * 10000 + 0.5);
}

/**
 * The tax block of one year from the outputs `r` (dollars) and the year's employee payroll tax.
 * Each engine total is rounded once (units.ts); the parts shown under it are rounded and then made
 * to add up to it with shared `addUp`, so `incomeTax = ordinary + capital gains`, `total = income tax
 * + NIIT + the two additional taxes` and `taxable income = ordinary taxable + the three gain bands`
 * hold in cents.
 */
export function taxYearDetailCents(r: Float64Array, status: FilingStatusIndex, payrollTax: number): TaxYearDetailCents {
  const c = (slot: number) => dollarsToCentsBigInt(r[slot]!);
  const total = c(TO.TOTAL);
  const [incomeTax, niit, pen10, pen20] = addUp(total, [c(TO.INCOME_TAX), c(TO.NIIT), c(TO.PEN10), c(TO.PEN20)]) as [bigint, bigint, bigint, bigint];
  const [ordTax, cgTax] = addUp(incomeTax, [c(TO.ORD_TAX), c(TO.CG_TAX)]) as [bigint, bigint];
  const taxable = c(TO.TAXABLE_INCOME);
  const [ordTaxable, at0, at15, at20] = addUp(taxable, [c(TO.ORD_TAXABLE), c(TO.PREF_AT_0), c(TO.PREF_AT_15), c(TO.PREF_AT_20)]) as [bigint, bigint, bigint, bigint];
  const filingStatus: TaxFilingStatus = status === 0 ? "single" : "married_joint";
  return {
    filingStatus,
    totalFederalCents: total,
    incomeTaxCents: incomeTax,
    ordinaryTaxCents: ordTax,
    capitalGainsTaxCents: cgTax,
    niitCents: niit,
    earlyPenaltyCents: pen10,
    hsaPenaltyCents: pen20,
    payrollTaxCents: dollarsToCentsBigInt(payrollTax),
    agiCents: c(TO.AGI),
    taxableIncomeCents: taxable,
    ordinaryTaxableCents: ordTaxable,
    taxableSocialSecurityCents: c(TO.TAXABLE_SS),
    standardDeductionCents: c(TO.STD_DEDUCTION),
    seniorDeductionCents: c(TO.SENIOR_DEDUCTION),
    gainsAt0Cents: at0,
    gainsAt15Cents: at15,
    gainsAt20Cents: at20,
    capitalLossCarryoverCents: c(TO.LOSS_CARRY_OUT),
    magiIrmaaCents: c(TO.MAGI_IRMAA),
    magiAcaCents: c(TO.MAGI_ACA),
    bracketRateBp: rateBp(r[TO.BRACKET_RATE]!),
    nextGainRateBp: rateBp(r[TO.LTCG_NEXT_RATE]!),
  };
}

/** `taxYearDetailCents` as the stored wire shape (cents as decimal strings); `x` is kept for the §4.1 signature. */
export function taxYearDetail(_x: Float64Array, r: Float64Array, status: FilingStatusIndex, payrollTax: number): TaxYearDetail {
  const d = taxYearDetailCents(r, status, payrollTax);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) out[k] = typeof v === "bigint" ? v.toString() : v;
  return out as TaxYearDetail;
}

// ---------------------------------------------------------------------------------------------
// computeFederalTax: the allocating wrapper

/** The cents fields of `FederalTaxPreviewRequest`, in the order of the input slots they fill. */
const CENTS_FIELDS = [
  ["wagesCents", TI.WAGES],
  ["pensionCents", TI.PENSION],
  ["taxableInterestCents", TI.INTEREST],
  ["taxExemptInterestCents", TI.TAX_EXEMPT_INTEREST],
  ["ordinaryDividendsCents", TI.ORD_DIV],
  ["qualifiedDividendsCents", TI.QUAL_DIV],
  ["shortTermGainCents", TI.ST_GAIN],
  ["longTermGainCents", TI.LT_GAIN],
  ["lossCarryInCents", TI.LOSS_CARRY_IN],
  ["traditionalDistributionsCents", TI.TRAD_DIST],
  ["rothConversionsCents", TI.ROTH_CONV],
  ["rothTaxableEarningsCents", TI.ROTH_TAXABLE],
  ["hsaTaxableCents", TI.HSA_TAXABLE],
  ["socialSecurityCents", TI.SS_GROSS],
  ["rentalNetCents", TI.RENTAL],
  ["otherOrdinaryCents", TI.OTHER_ORD],
  ["adjustmentsCents", TI.ADJUSTMENTS],
  ["penalty10BaseCents", TI.PEN10_BASE],
  ["penalty20BaseCents", TI.PEN20_BASE],
] as const;

type CentsField = (typeof CENTS_FIELDS)[number][0];

/** The fields of `FederalTaxPreviewRequest` with bigint cents (absent = 0) and a numeric index factor. */
export type FederalTaxInput = {
  year: number;
  filingStatus: TaxFilingStatus;
  /** Ages attained by year end, one per filer. */
  ages: readonly number[];
  /** `F` for a year after the last published year (default 1); ignored for a published year. */
  indexFactor?: number | undefined;
  ruleSetId?: string | undefined;
} & { [K in CentsField]?: bigint | undefined };

export interface FederalTaxLine {
  form: string;
  line: string;
  label: string;
  cents: bigint;
}

/** The fields of `FederalTaxPreviewResponse` with bigint cents. */
export interface FederalTaxResult {
  dataVersion: string;
  dataStatus: "published" | "indexed";
  detail: TaxYearDetailCents;
  provisionalIncomeCents: bigint;
  unusedDeductionCents: bigint;
  /** Null in the top bracket. */
  roomInBracketCents: bigint | null;
  roomAtZeroGainsCents: bigint;
  lossUsedCents: bigint;
  /** Effective, by finite difference (fractions). */
  marginalOrdinaryRate: number;
  marginalGainRate: number;
  lines: FederalTaxLine[];
}

/**
 * One household-year in cents: builds a one-year table from the data (the rule set's law changes
 * applied; after the last published year every indexed amount at `indexFactor`), calls
 * `federalTaxInto` and returns named cents with the worksheet lines. Throws `TaxInputError` for an
 * input outside the contract and `TaxDataError("unknown_rule_set")` for an unknown rule set.
 */
export function computeFederalTax(input: FederalTaxInput, data: TaxData = loadTaxData()): FederalTaxResult {
  const { year, filingStatus, ages } = input;
  if (!Number.isInteger(year) || year < data.firstTaxYear) throw new TaxInputError("tax_input_invalid", `year must be an integer from ${data.firstTaxYear}`);
  const status: FilingStatusIndex = filingStatus === "single" ? 0 : 1;
  if (ages.length !== status + 1 || !ages.every((a) => Number.isInteger(a) && a >= 0)) {
    throw new TaxInputError("tax_input_invalid", "one whole age per filer: one for single, two for married filing jointly");
  }
  const factor = input.indexFactor ?? 1;
  if (!(Number.isFinite(factor) && factor > 0)) throw new TaxInputError("tax_input_invalid", "indexFactor must be a positive number");
  const law = compileTaxLaw(data, { startYear: year, years: 1, ruleSetId: input.ruleSetId ?? "current_law" });
  const indexed = year > data.lastPublishedYear;
  const table = new Float64Array(2 * TAX_REC);
  const prog = new Float64Array(PROG_REC);
  fillYearAtFactors(law, 0, indexed ? factor : 1, indexed ? factor : 1, 0, table, prog);

  // Filers aged 65 or over at year end (§63(f) and the senior deduction use the same age; minAge is not a law path).
  const minAge = data.years.get(Math.min(year, data.lastPublishedYear))!.seniorDeduction.minAge;
  const x = new Float64Array(TAX_IN);
  for (const [field, slot] of CENTS_FIELDS) x[slot] = centsToDollars(input[field] ?? 0n);
  x[TI.N_AGED] = ages.filter((a) => a >= minAge).length;
  x[TI.YEAR_FRACTION] = 1;
  assertTaxInput(x);

  const o = taxOffset(0, status);
  const r = new Float64Array(TAX_OUT);
  federalTaxInto(table, o, x, r);
  const marginal = new Float64Array(2);
  effectiveMarginalRates(table, o, x, new Float64Array(TAX_IN), new Float64Array(TAX_OUT), marginal);

  const detail = taxYearDetailCents(r, status, 0);
  const c = (slot: number) => dollarsToCentsBigInt(r[slot]!);
  const room = r[TO.ROOM_IN_BRACKET]!;
  const netLT = x[TI.LT_GAIN]! - x[TI.LOSS_CARRY_IN]!;
  const line = (form: string, ln: string, label: string, cents: bigint): FederalTaxLine => ({ form, line: ln, label, cents });
  const lines: FederalTaxLine[] = [
    line("Schedule D", "7", "Net short-term capital gain or loss", input.shortTermGainCents ?? 0n),
    line("Schedule D", "14", "Long-term capital loss carryover", -(input.lossCarryInCents ?? 0n)),
    line("Schedule D", "15", "Net long-term capital gain or loss", dollarsToCentsBigInt(netLT)),
    line("Schedule D", "16", "Net capital gain or loss", dollarsToCentsBigInt(x[TI.ST_GAIN]! + netLT)),
    line("Pub. 915 Worksheet 1", "8", "Provisional income", c(TO.PROVISIONAL)),
    line("Pub. 915 Worksheet 1", "19", "Taxable Social Security benefits", detail.taxableSocialSecurityCents),
    line("Form 1040", "AGI", "Adjusted gross income", detail.agiCents),
    line("Form 1040", "Standard deduction", "Standard deduction with the additional amounts for age", detail.standardDeductionCents),
    line("Schedule 1-A", "Part V", "Enhanced deduction for seniors", detail.seniorDeductionCents),
    line("QDCG Tax Worksheet", "1", "Taxable income", detail.taxableIncomeCents),
    line("QDCG Tax Worksheet", "5", "Ordinary taxable income", detail.ordinaryTaxableCents),
    line("QDCG Tax Worksheet", "9", "Qualified dividends and gains taxed at 0%", detail.gainsAt0Cents),
    line("QDCG Tax Worksheet", "10", "Qualified dividends and gains in taxable income", c(TO.PREF_INCOME)),
    line("QDCG Tax Worksheet", "17", "Qualified dividends and gains taxed at 15%", detail.gainsAt15Cents),
    line("QDCG Tax Worksheet", "20", "Qualified dividends and gains taxed at 20%", detail.gainsAt20Cents),
    line("QDCG Tax Worksheet", "22", "Tax on ordinary taxable income", detail.ordinaryTaxCents),
    line("Form 1040", "16", "Income tax", detail.incomeTaxCents),
    line("Form 8960", "NIIT", "Net investment income tax", detail.niitCents),
    line("Form 5329", "3", "Amount subject to the 10% additional tax", input.penalty10BaseCents ?? 0n),
    line("Form 5329", "Additional tax", "10% additional tax on early distributions", detail.earlyPenaltyCents),
    line("Form 8889", "16", "Amount subject to the 20% additional tax", input.penalty20BaseCents ?? 0n),
    line("Form 8889", "Additional tax", "20% additional tax on non-qualified HSA distributions", detail.hsaPenaltyCents),
    line("Total", "Federal", "Total federal tax", detail.totalFederalCents),
  ];
  return {
    dataVersion: law.dataVersion,
    dataStatus: indexed ? "indexed" : "published",
    detail,
    provisionalIncomeCents: c(TO.PROVISIONAL),
    unusedDeductionCents: c(TO.UNUSED_DEDUCTION),
    roomInBracketCents: Number.isFinite(room) ? dollarsToCentsBigInt(room) : null,
    roomAtZeroGainsCents: c(TO.ROOM_IN_LTCG0),
    lossUsedCents: c(TO.LOSS_USED),
    marginalOrdinaryRate: marginal[0]!,
    marginalGainRate: marginal[1]!,
    lines,
  };
}
