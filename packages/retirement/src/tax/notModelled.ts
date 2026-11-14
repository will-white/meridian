/**
 * What the tax, RMD and Social Security area does not model, as data (tax-rmd-ss §8.2, decision
 * 47). The rules view serves it (`GET /rules`), the rules page lists it, and test K8 pins each entry
 * with one assertion named after its id (notModelled.test.ts).
 *
 * Changed from the area design by the seams: `loss_step_down` is gone (C19: basis moves toward
 * value at the first death in both directions), `rebalance_lag` is gone (C17: rebalancing gains
 * are taxed in the year of the trade), and `short_term_sales` and `wash_sales_lots` describe the
 * engine's model (three simulated assets per account, average cost, every gain long-term), whose
 * pins replace the area design's taxable-account cases F2. Added after the Stage A review:
 * `roth_catch_up` (SECURE 2.0's Roth catch-up rule, absent from §8.2).
 */

export interface NotModelledEntry {
  readonly id: string;
  /** What is not modelled. */
  readonly label: string;
  /** Its effect on the results. */
  readonly effect: string;
}

export const NOT_MODELLED = Object.freeze(
  [
    { id: "tax_table_rounding", label: "Whole-dollar rounding and the Tax Table's $50 bands", effect: "Within a few dollars of a filed return." },
    {
      id: "itemized_deductions",
      label: "Itemized deductions and the non-itemizer charitable deduction",
      effect: "Tax is overstated for a household that itemizes.",
    },
    { id: "amt", label: "The alternative minimum tax", effect: "None for standard-deduction households without incentive stock options." },
    { id: "credits", label: "Every tax credit (child, saver's, foreign tax, elderly)", effect: "Tax is slightly overstated." },
    {
      id: "other_deductions",
      label: "The blindness and dependent deductions and the deductions for tips, overtime, car-loan interest, qualified business income and student-loan interest",
      effect: "Tax is overstated where they apply.",
    },
    {
      id: "special_gain_rates",
      label: "The 25% and 28% capital gain rates (real-estate depreciation recapture, collectibles)",
      effect: "Tax is understated on such a sale.",
    },
    {
      id: "loss_character",
      label: "The short- or long-term character of a capital loss carryover, and the carryover worksheet's rule when taxable income is negative",
      effect: "Timing differences of a few hundred dollars.",
    },
    {
      id: "short_term_sales",
      label: "Short-term gains on the simulated sales and rebalancing: every realized gain is long-term",
      effect: "Tax is understated for a household that sells within a year of buying.",
    },
    { id: "pretax_basis", label: "After-tax basis in pre-tax accounts (Form 8606)", effect: "Withdrawals are taxed in full." },
    {
      id: "roth_catch_up",
      label:
        "The Roth catch-up rule (§ 414(v)(7)(A), from 2026): an employee whose prior-year wages exceed the threshold ($150,000 for 2026 catch-ups, $155,000 for 2027) must make 401(k) catch-up contributions as Roth; the planner treats them as pre-tax",
      effect: "For such an employee aged 50 or over, tax is understated by up to the catch-up times the marginal rate each year, and that money is counted as pre-tax, not Roth.",
    },
    {
      id: "ira_deduction_limits",
      label: "The income limits on deductible IRA and on Roth IRA contributions",
      effect: "AGI is slightly understated for a high earner who contributes to an IRA.",
    },
    {
      id: "penalty_exceptions",
      label: "Substantially equal payments, disability, medical, first-home, education, birth and the other exceptions to the 10% additional tax",
      effect: "The additional tax is overstated for an early retiree who would use one.",
    },
    {
      id: "beneficiary_ira",
      label: "Keeping a deceased spouse's account as a beneficiary, which is penalty-free before 59½",
      effect: "The additional tax is overstated for a survivor under 59½ who withdraws.",
    },
    {
      id: "roth_401k_ordering",
      label: "The pro-rata rule for non-qualified Roth 401(k) withdrawals: all Roth money follows the Roth IRA ordering",
      effect: "Small; early withdrawals only.",
    },
    {
      id: "roth_history",
      label: "Conversions made in the five years before the plan starts, and the true first-contribution year of an existing Roth",
      effect: "An early withdrawal treats pre-plan conversions as earnings unless they are entered as basis; an existing account is assumed past its five years.",
    },
    { id: "hsa_shoebox", label: "Reimbursing earlier years' medical costs from the HSA", effect: "The HSA is slightly less useful." },
    { id: "rmd_first_year_deferral", label: "Taking the first RMD by 1 April of the next year", effect: "One year of timing." },
    { id: "rmd_still_working", label: "Delaying 401(k) RMDs while still employed", effect: "Only for work past 73 or 75." },
    { id: "qcd", label: "Qualified charitable distributions", effect: "Tax is overstated for a donor." },
    { id: "inherited_accounts", label: "Accounts inherited from anyone but the spouse, and the ten-year rule", effect: "Out of scope." },
    { id: "ss_family_maximum", label: "The Social Security family maximum", effect: "It cannot bind without child beneficiaries." },
    {
      id: "ss_wage_indexing",
      label: "Growth of the PIA with average wages before 60, and the lower benefit of someone who stops work early",
      effect: "Within a few percent; enter the estimate for the planned stop-work age.",
    },
    {
      id: "ss_month_rules",
      label: "Entitlement only from the first full month at 62, no benefit for the month of death, payment a month in arrears, birthdays on the 1st of a month",
      effect: "At most one month of benefit.",
    },
    {
      id: "ss_earnings_test_detail",
      label: "The monthly earnings test of the first year, the worker's earnings withholding the spouse's part, and the credit-back of spousal and survivor reductions",
      effect: "Small; the adjustment at full retirement age returns most of it.",
    },
    {
      id: "ss_other_benefits",
      label: "Child, divorced-spouse and disability benefits, and a survivor choosing to delay the widow(er)'s benefit",
      effect: "The widow(er)'s benefit starts as soon as it can, with its permanent reduction.",
    },
    {
      id: "ss_receiving_spousal",
      label: "A spousal part already inside the benefit of someone who is receiving",
      effect: "The amount entered is treated as the person's own benefit; enter the full-retirement-age amount to be exact.",
    },
    { id: "nq_annuity_nii", label: "The net investment income tax on the gain part of a non-qualified annuity", effect: "NIIT is understated above the thresholds." },
    { id: "rental_detail", label: "Depreciation and the passive-loss limits on rental income", effect: "Timing only." },
    {
      id: "wash_sales_lots",
      label: "Wash sales and specific-lot selection: basis is the average cost per account and simulated asset (stocks, bonds, bills)",
      effect: "The timing of realized gains differs from lot-level accounting; the lifetime total does not.",
    },
    { id: "payment_timing", label: "Withholding, estimated payments and April settlement", effect: "None on totals." },
    {
      id: "payroll_detail",
      label: "The payroll-tax exemption of HSA payroll contributions, and self-employment tax",
      effect: "Payroll tax is slightly overstated for HSA payroll savers.",
    },
    {
      id: "state_irmaa_aca",
      label: "State income tax, IRMAA and ACA premium credits (Phase 5)",
      effect: "Costs are understated until Phase 5; the MAGI figures they need are computed.",
    },
  ] as const satisfies readonly NotModelledEntry[],
);

export type NotModelledId = (typeof NOT_MODELLED)[number]["id"];
