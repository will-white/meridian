/**
 * Slot layouts of the tax area's typed-array records (tax-rmd-ss §2.8; seams C30, §2.6).
 *
 * Every record is a `Float64Array` of dollars, fractions or counts. The constants are plain `const`
 * objects, not `const enum`, so isolated-module builds (esbuild, Vite) accept them. The hot-path
 * functions read and write these slots and allocate nothing (tax-rmd-ss decision 14).
 *
 * Not built here, by the seams' rulings: the taxable-income record `YI` and the six-slot taxable
 * holding (C17: the taxable-account mechanics are the engine's; the yields on its three simulated
 * assets are `AD` and `TY` below), and the warning slot `CASH_SERIES_MISSING` (C17.6: every return
 * model has a bill series).
 */

// ---------------------------------------------------------------------------------------------
// The per-path tax table: `Float64Array(years × 2 × TAX_REC)`, one record per plan year and filing
// status, filled once per path by `fillPathTables` (compile.ts).

/** Slots of one tax record (one plan year, one filing status). */
export const TR = {
  /** Standard deduction. */
  STD: 0,
  /** Additional standard deduction per filer aged 65 or over at year end. */
  AGED: 1,
  /** Senior deduction per eligible person (Schedule 1-A Part V). */
  SENIOR_AMT: 2,
  /** The senior deduction's phase-out start (modified AGI). */
  SENIOR_START: 3,
  /** The senior deduction's phase-out rate. */
  SENIOR_RATE: 4,
  /** Maximum zero-rate amount of taxable income (capital gains). */
  LTCG0: 5,
  /** Maximum 15%-rate amount of taxable income. */
  LTCG15: 6,
  /** 0.15 */
  LTCG_RATE1: 7,
  /** 0.20 */
  LTCG_RATE2: 8,
  NIIT_THRESHOLD: 9,
  NIIT_RATE: 10,
  /** Publication 915 base amounts and rates. */
  SS_BASE1: 11,
  SS_BASE2: 12,
  SS_RATE1: 13,
  SS_RATE2: 14,
  SS_MAX_SHARE: 15,
  /** Net capital loss deductible against ordinary income. */
  LOSS_LIMIT: 16,
  /** 10% additional tax on early distributions (Form 5329). */
  PEN_EARLY_RATE: 17,
  /** 20% additional tax on non-qualified HSA distributions (Form 8889). */
  PEN_HSA_RATE: 18,
  /** 7 */
  N_BRACKETS: 19,
  /** Bracket lower bounds `THR0 + i`, i = 0 … 6; slot `THR0 + 7` is the `+Infinity` sentinel. */
  THR0: 20,
  /** Bracket rates `RATE0 + i`, i = 0 … 6 (slot `RATE0 + 7` is unused and 0). */
  RATE0: 28,
  /** Tax at each lower bound `BASE0 + i`, i = 0 … 6 (slot `BASE0 + 7` is unused and 0). */
  BASE0: 36,
  /** 44 to 47 are reserved for v2 (IRMAA, ACA). */
  RESERVED0: 44,
} as const;

/** Slots per tax record. */
export const TAX_REC = 48;
/** Ordinary brackets per schedule (the schema fixes seven rates). */
export const N_BRACKETS = 7;

/** Index of a filing status in the tables: 0 single, 1 married filing jointly (tax-rmd-ss decision 3). */
export type FilingStatusIndex = 0 | 1;
export const STATUS_SINGLE: FilingStatusIndex = 0;
export const STATUS_MFJ: FilingStatusIndex = 1;

/** Offset of the record of plan year `yearIndex` and filing status `status` in a per-path tax table. */
export function taxOffset(yearIndex: number, status: FilingStatusIndex): number {
  return (yearIndex * 2 + status) * TAX_REC;
}

// ---------------------------------------------------------------------------------------------
// The per-path program table: `Float64Array(years × PROG_REC)`, one record per plan year.

/** Slots of one program record (Social Security program amounts, limits, payroll, the index factors). */
export const PR = {
  /** The cost-of-living adjustment first paid in January of the year (tax-rmd-ss §3.9.6). */
  COLA: 0,
  /** Multiplier on every Social Security benefit paid in the year (law changes, the plan's adjustment). */
  SS_SCALE: 1,
  /** Earnings-test exempt amount for a year before the one of full retirement age. */
  ET_UNDER: 2,
  /** Earnings-test exempt amount in the year full retirement age is reached. */
  ET_FRA: 3,
  /** OASDI contribution and benefit base. */
  WAGE_BASE: 4,
  DEFERRAL: 5,
  CATCHUP50: 6,
  CATCHUP6063: 7,
  ANNUAL_ADD: 8,
  IRA: 9,
  IRA_CATCHUP: 10,
  HSA_SELF: 11,
  HSA_FAMILY: 12,
  HSA_CATCHUP: 13,
  OASDI_RATE: 14,
  MEDICARE_RATE: 15,
  ADDL_MEDICARE_RATE: 16,
  ADDL_MEDICARE_THR_SINGLE: 17,
  ADDL_MEDICARE_THR_MFJ: 18,
  /** `F_Y`: the price index factor since the last published year (1 for a published year). */
  CPI_FACTOR: 19,
  /** `W_Y`: the wage index factor since the last published year. */
  WAGE_FACTOR: 20,
  /** 21 to 23 reserved. */
  RESERVED0: 21,
} as const;

/** Slots per program record. */
export const PROG_REC = 24;

/** Offset of the program record of plan year `yearIndex`. */
export function progOffset(yearIndex: number): number {
  return yearIndex * PROG_REC;
}

// ---------------------------------------------------------------------------------------------
// Tax inputs `Float64Array(TAX_IN)`: dollars for the plan year's period (the partial first year's
// own amounts in year 0; seams §2.6: nothing is divided by f before the call).

/** Slots of the tax input record, with the Form 1040 (2025) line each stands for. */
export const TI = {
  /** 1z, after pre-tax and HSA payroll deferrals. */
  WAGES: 0,
  /** 5b, taxable pensions and annuities. */
  PENSION: 1,
  /** 2b, taxable interest. */
  INTEREST: 2,
  /** 2a, counts toward provisional income and MAGI only. */
  TAX_EXEMPT_INTEREST: 3,
  /** 3b, ordinary dividends including the qualified part. */
  ORD_DIV: 4,
  /** 3a, at most `ORD_DIV`. */
  QUAL_DIV: 5,
  /** Schedule D line 7, net short-term gain or loss, signed. */
  ST_GAIN: 6,
  /** Schedule D line 15, net long-term gain or loss before the carryover, signed. */
  LT_GAIN: 7,
  /** Schedule D line 14, at least 0: last year's `LOSS_CARRY_OUT`. */
  LOSS_CARRY_IN: 8,
  /** 4b, taxable pre-tax distributions including RMDs. */
  TRAD_DIST: 9,
  /** 4b, Roth conversions. */
  ROTH_CONV: 10,
  /** 4b, non-qualified Roth earnings distributed. */
  ROTH_TAXABLE: 11,
  /** Schedule 1 line 8f, non-qualified HSA distributions. */
  HSA_TAXABLE: 12,
  /** 6a, household benefits (SSA-1099 box 5). */
  SS_GROSS: 13,
  /** Schedule 1 line 5, net rental income, at least 0 (also investment income). */
  RENTAL: 14,
  /** Schedule 1, any other ordinary income. */
  OTHER_ORD: 15,
  /** Form 8960, investment income already inside another line; 0 in v1. */
  NII_OTHER: 16,
  /** 10, above-the-line deductions; 0 in the v1 loop (deferrals reduce `WAGES`). */
  ADJUSTMENTS: 17,
  /** Form 5329 line 3, the amount subject to the 10% additional tax. */
  PEN10_BASE: 18,
  /** Form 8889 line 16, the amount subject to the 20% additional tax. */
  PEN20_BASE: 19,
  /** Filers aged 65 or over at year end (0, 1 or 2). */
  N_AGED: 20,
  /** f = firstYearMonths / 12 in plan year 0 (seams C14, C23); 0 or 1 means a full year. */
  YEAR_FRACTION: 21,
  /** 22, 23 reserved. */
  RESERVED0: 22,
} as const;

export const TAX_IN = 24;

/** The input slots that hold dollars (every slot below `N_AGED`). */
export const TAX_IN_DOLLAR_SLOTS = 20;

// ---------------------------------------------------------------------------------------------
// Tax outputs `Float64Array(TAX_OUT)`: dollars for the period, rates as fractions.

export const TO = {
  TOTAL: 0,
  /** Form 1040 line 16. */
  INCOME_TAX: 1,
  /** Qualified Dividends and Capital Gain Tax Worksheet line 22. */
  ORD_TAX: 2,
  /** `INCOME_TAX − ORD_TAX`. */
  CG_TAX: 3,
  NIIT: 4,
  PEN10: 5,
  PEN20: 6,
  AGI: 7,
  TAXABLE_INCOME: 8,
  ORD_TAXABLE: 9,
  TAXABLE_SS: 10,
  /** Publication 915 Worksheet 1 line 8. */
  PROVISIONAL: 11,
  /** Standard deduction including the additional amounts for age. */
  STD_DEDUCTION: 12,
  SENIOR_DEDUCTION: 13,
  PREF_AT_0: 14,
  PREF_AT_15: 15,
  PREF_AT_20: 16,
  NII: 17,
  LOSS_CARRY_OUT: 18,
  LOSS_USED: 19,
  /** The statutory rate on the next dollar of ordinary income; 0 while deductions are unused. */
  BRACKET_RATE: 20,
  BRACKET_INDEX: 21,
  /** Ordinary taxable income to the next bracket bound; `+Infinity` in the top bracket. */
  ROOM_IN_BRACKET: 22,
  ROOM_IN_LTCG0: 23,
  MAGI_IRMAA: 24,
  MAGI_ACA: 25,
  /** Worksheet line 10. */
  PREF_INCOME: 26,
  LTCG_NEXT_RATE: 27,
  UNUSED_DEDUCTION: 28,
  /** 29 to 31 reserved. */
  RESERVED0: 29,
} as const;

export const TAX_OUT = 32;

// ---------------------------------------------------------------------------------------------
// The other records of this area (built by later steps; the layouts are fixed here).

/** Roth basis per person, `Float64Array(RB_REC)` from an offset (tax-rmd-ss §3.7.2; seams C32). */
export const RB = {
  /** Regular contributions plus conversions older than five tax years. */
  BASIS_FREE: 0,
  /** Conversions of the last five tax years: `CONV0` four tax years ago … `CONV4` this year. */
  CONV0: 1,
  CONV4: 5,
  /** The first tax year any Roth of the person was funded; 0 = none yet. */
  FIRST_YEAR: 6,
  /** 7 reserved. */
  RESERVED0: 7,
} as const;
export const RB_REC = 8;

/** Output of `rothWithdraw` (rothBasis.ts), `Float64Array(RW_REC)` (tax-rmd-ss §3.7.3, §4.1). */
export const RW = {
  /** Non-qualified earnings distributed: to `TI.ROTH_TAXABLE`. */
  TAXABLE: 0,
  /** The part subject to the 10% additional tax: added to `TI.PEN10_BASE`. */
  PENALTY_BASE: 1,
  FROM_BASIS: 2,
  FROM_CONVERSIONS: 3,
  FROM_EARNINGS: 4,
} as const;
export const RW_REC = 5;

/** Output of `hsaWithdraw` (penalties.ts), `Float64Array(HW_REC)` (tax-rmd-ss §3.7.4). */
export const HW = {
  /** The part above the year's qualified medical spending: to `TI.HSA_TAXABLE`. */
  TAXABLE: 0,
  /** The part subject to the 20% additional tax: to `TI.PEN20_BASE`. */
  PENALTY_BASE: 1,
} as const;
export const HW_REC = 2;

/** Social Security state per path, `Float64Array(SS_REC)`: slot + person (0 or 1). */
export const SS = {
  /** Dollars a month, this year's. */
  PIA: 0,
  /** Months withheld by the earnings test, credited back at full retirement age. */
  ARF_MONTHS: 2,
  /** Fixed when the spousal excess starts; −1 until then. */
  SPOUSAL_FACTOR: 4,
  /** Fixed when the widow(er)'s benefit starts; −1 until then. */
  SURVIVOR_FACTOR: 6,
  /** The person's own factor, fixed at their death; −1 while alive. */
  DECEASED_FACTOR: 8,
  /** 10 to 15 reserved. */
  RESERVED0: 10,
} as const;
export const SS_REC = 16;

/** Social Security output, `Float64Array(SO_REC)`: slot + person (0 or 1); seams C37. */
export const SO = {
  /** The year's benefit, net of withholding and scaled. */
  BENEFIT: 0,
  SPOUSAL: 2,
  /** What the widow(er)'s benefit adds over own plus spousal. */
  SURVIVOR: 4,
  /** Withheld by the earnings test. */
  WITHHELD: 6,
  MONTHS_PAID: 8,
} as const;
export const SO_REC = 10;

// ---------------------------------------------------------------------------------------------
// Taxable-account yield assumptions (taxDrag.ts; tax-rmd-ss §2.6 with seams C17 and C18)

/** One asset class's compiled assumptions, `TD_REC` slots per class in `AssetClass` order (`compileTaxDrag`). */
export const TD = {
  /** Dividends a year as a fraction of the value. */
  DIVIDEND_YIELD: 0,
  /** The qualified fraction of those dividends. */
  QUALIFIED_SHARE: 1,
  /** `INTEREST_NONE`, `INTEREST_PRIOR_BILL_PLUS_SPREAD` or `INTEREST_BILL_RETURN` (data, for the rules view). */
  INTEREST_MODE: 2,
  /** Added to the previous plan year's bill return to give the interest rate (seams C18). */
  INTEREST_SPREAD: 3,
  /** The tax-exempt fraction of the interest. */
  TAX_EXEMPT_SHARE: 4,
  /** Long-term gain distributed a year as a fraction of the unrealized gain. */
  GAIN_DISTRIBUTION: 5,
} as const;
export const TD_REC = 6;
export const INTEREST_NONE = 0;
export const INTEREST_PRIOR_BILL_PLUS_SPREAD = 1;
export const INTEREST_BILL_RETURN = 2;

/**
 * The assumptions of one account in one plan year, blended from the six classes into the simulated
 * stock and bond assets (seams C17 item 2), `AD_REC` slots at `accountDragOffset(t, a, accounts)`.
 * The bill asset has none: it earns the whole bill return, taxed the next year (C17 item 5).
 */
export const AD = {
  STOCK_DIVIDEND_YIELD: 0,
  /** Dividend-weighted. */
  STOCK_QUALIFIED_SHARE: 1,
  STOCK_GAIN_DISTRIBUTION: 2,
  BOND_INTEREST_SPREAD: 3,
  BOND_TAX_EXEMPT_SHARE: 4,
  BOND_GAIN_DISTRIBUTION: 5,
  /** 6, 7 reserved. */
  RESERVED0: 6,
} as const;
export const AD_REC = 8;

/** Offset of account `a`'s record for plan year `t` in a table of `accounts` accounts. */
export function accountDragOffset(t: number, a: number, accounts: number): number {
  return (t * accounts + a) * AD_REC;
}

/** Output of `taxableYieldsInto`: one taxable account's income for the period, dollars. */
export const TY = {
  /** Ordinary dividends including the qualified part: to `TI.ORD_DIV`. */
  DIVIDENDS: 0,
  /** To `TI.QUAL_DIV`. */
  QUALIFIED_DIVIDENDS: 1,
  /** Taxable bond interest: to `TI.INTEREST`. */
  INTEREST: 2,
  /** To `TI.TAX_EXEMPT_INTEREST`. */
  TAX_EXEMPT_INTEREST: 3,
  /** Long-term gain distributions: to `TI.LT_GAIN`. */
  GAIN_DISTRIBUTIONS: 4,
  /** The income reinvested in the stock asset (dividends and its distributions): added to its basis. */
  STOCK_BASIS_ADD: 5,
  /** The income reinvested in the bond asset (all its interest and its distributions): added to its basis. */
  BOND_BASIS_ADD: 6,
  /** 7 reserved. */
  RESERVED0: 7,
} as const;
export const TY_REC = 8;

/** Warning amounts per path, `Float64Array(WN_REC)` (tax-rmd-ss §3.11; seams C41). */
export const WN = {
  /** The largest amount withheld by the earnings test in one year. */
  SS_EARNINGS_TEST: 0,
  /** The largest `PEN10 + PEN20` of one year. */
  EARLY_PENALTY: 1,
  /** The largest non-qualified Roth withdrawal of a person whose Roth basis was not entered. */
  ROTH_BASIS_UNKNOWN: 2,
  /** The largest amount cut by a contribution limit in one year. */
  CONTRIBUTION_CAPPED: 3,
  /** 4 to 7 reserved (4 was CASH_SERIES_MISSING, dropped by seams C17.6). */
  RESERVED0: 4,
} as const;
export const WN_REC = 8;
