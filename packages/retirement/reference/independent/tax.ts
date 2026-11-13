// The federal tax of one year in Form 1040 order, as r1.md §2.10 and r2.md §2.10 state it.
// Independent of packages/retirement/src: written from the sheets only.

import { STATUTORY, bracketIndex, RATES, schedule, type YearLaw } from "./law.js";

export interface TaxInput {
  /** Pensions, RMDs, pre-tax withdrawals, conversions, taxable HSA withdrawals. */
  readonly ordinaryNonInvestment: number;
  /** Coupons plus the bill interest carried from the previous year. */
  readonly interest: number;
  readonly qualifiedDividends: number;
  readonly ordinaryDividends: number;
  /** Realized long-term gains of the year (never negative in R1 and R2). */
  readonly gains: number;
  readonly benefits: number;
  /** Filers aged 65 or older at the year end. */
  readonly nAged: number;
  /** The early part of pre-tax and Roth withdrawals (10%). */
  readonly earlyBase: number;
  /** The early part of taxable HSA withdrawals (20%). */
  readonly hsaEarlyBase: number;
}

export interface TaxDetail {
  readonly provisionalIncome: number;
  readonly taxableSs: number;
  readonly agi: number;
  readonly magiIrmaa: number;
  readonly magiAca: number;
  readonly standardDeduction: number;
  readonly seniorDeduction: number;
  readonly taxableIncome: number;
  readonly ordinaryTaxable: number;
  readonly gainsAt0: number;
  readonly gainsAt15: number;
  readonly gainsAt20: number;
  readonly ordinaryTax: number;
  readonly capitalGainsTax: number;
  readonly incomeTax: number;
  readonly niit: number;
  readonly penalty10: number;
  readonly penalty20: number;
  readonly totalFederalTax: number;
  readonly capitalLossCarryover: number;
  readonly bracketRateBp: number;
  readonly nextGainRateBp: number;
}

export function federalTax(law: YearLaw, x: TaxInput): TaxDetail {
  if (x.gains < 0) throw new RangeError("capital losses are not exercised by R1 or R2 and are not implemented");
  const filing = law.filing;
  const [base1, base2] = STATUTORY.ssBase[filing];
  // 1-2. Net gain enters AGI; `other` is every income line but the benefits.
  const gain = x.gains;
  const dividends = x.qualifiedDividends + x.ordinaryDividends;
  const other = x.ordinaryNonInvestment + x.interest + dividends + gain;
  // 3. Publication 915 Worksheet 1.
  const provisionalIncome = other + 0.5 * x.benefits;
  const tier1 = Math.min(0.5 * x.benefits, 0.5 * Math.max(0, provisionalIncome - base1), 0.5 * (base2 - base1));
  const taxableSs = Math.min(0.85 * x.benefits, 0.85 * Math.max(0, provisionalIncome - base2) + tier1);
  // 4. AGI.
  const agi = other + taxableSs;
  // 5. Deductions.
  const standardDeduction = law.standard + x.nAged * law.aged;
  const seniorDeduction =
    x.nAged *
    Math.max(0, law.seniorEach - (law.seniorEach > 0 ? STATUTORY.seniorPhaseOutRate * Math.max(0, agi - STATUTORY.seniorPhaseOutStart[filing]) : 0));
  const taxableIncome = Math.max(0, agi - standardDeduction - seniorDeduction);
  // 6. Qualified Dividends and Capital Gain Tax Worksheet.
  const pref = Math.min(gain + x.qualifiedDividends, taxableIncome);
  const ordinaryTaxable = taxableIncome - pref;
  const ordinaryTax = schedule(law, ordinaryTaxable);
  const gainsAt0 = Math.max(0, Math.min(taxableIncome, law.max0) - ordinaryTaxable);
  const gainsAt15 = Math.min(pref - gainsAt0, Math.max(0, Math.min(taxableIncome, law.max15) - (ordinaryTaxable + gainsAt0)));
  const gainsAt20 = pref - gainsAt0 - gainsAt15;
  const incomeTax = Math.min(ordinaryTax + 0.15 * gainsAt15 + 0.2 * gainsAt20, schedule(law, taxableIncome));
  const capitalGainsTax = incomeTax - ordinaryTax;
  // 7. Net investment income tax.
  const nii = x.interest + dividends + gain;
  const niit = STATUTORY.niitRate * Math.min(nii, Math.max(0, agi - STATUTORY.niitThreshold[filing]));
  // 8. Additional taxes.
  const penalty10 = STATUTORY.earlyPenaltyRate * x.earlyBase;
  const penalty20 = STATUTORY.hsaPenaltyRate * x.hsaEarlyBase;
  // 9. Total.
  const totalFederalTax = incomeTax + niit + penalty10 + penalty20;

  const deductionsUnused = standardDeduction + seniorDeduction > agi;
  const bracketRateBp = deductionsUnused ? 0 : Math.round((RATES[bracketIndex(law, ordinaryTaxable)] as number) * 10000);
  const nextGainRateBp = taxableIncome < law.max0 ? 0 : taxableIncome < law.max15 ? 1500 : 2000;

  return {
    provisionalIncome,
    taxableSs,
    agi,
    magiIrmaa: agi,
    magiAca: agi + x.benefits - taxableSs,
    standardDeduction,
    seniorDeduction,
    taxableIncome,
    ordinaryTaxable,
    gainsAt0,
    gainsAt15,
    gainsAt20,
    ordinaryTax,
    capitalGainsTax,
    incomeTax,
    niit,
    penalty10,
    penalty20,
    totalFederalTax,
    capitalLossCarryover: 0,
    bracketRateBp,
    nextGainRateBp,
  };
}
