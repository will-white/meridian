import { z } from "zod";
import { bp, PlanCents } from "./primitives.js";

/**
 * Withdrawal strategy and order settings (strategies-outputs-web §4.1), embedded in
 * `RunSettings.strategy` and `RunSettings.withdrawalOrder`: no float, no null, strict objects.
 * `prepareStrategies` (engine) divides basis points by 10,000 and cents by 100.
 */

export const StrategyKind = z.enum(["constant_dollar", "fixed_percentage", "guardrails", "vpw", "floor_ceiling"]);
export type StrategyKind = z.infer<typeof StrategyKind>;

export const StrategyConfig = z.discriminatedUnion("kind", [
  /** Spend the plan every year, raised only for inflation (Bengen 1994). */
  z.object({ kind: z.literal("constant_dollar") }).strict(),
  z
    .object({
      kind: z.literal("fixed_percentage"),
      /** Of the spendable portfolio, a year. */
      rateBp: bp(50, 2000).default(400),
    })
    .strict(),
  z
    .object({
      kind: z.literal("guardrails"),
      /** Of the initial rate. */
      upperBandBp: bp(100, 10000).default(2000),
      lowerBandBp: bp(100, 9000).default(2000),
      /** Of the portfolio-funded part of the plan. */
      cutBp: bp(0, 5000).default(1000),
      raiseBp: bp(0, 5000).default(1000),
      skipInflationAfterLoss: z.boolean().default(true),
      /** Years before the end in which no cut is made. */
      preservationCutoffYears: z.number().int().min(0).max(60).default(15),
      /** The horizon age under table mortality. */
      planningAge: z.number().int().min(80).max(119).default(95),
    })
    .strict(),
  z
    .object({
      kind: z.literal("vpw"),
      /** Real growth a year. */
      stockRealBp: bp(0, 1500).default(500),
      bondRealBp: bp(0, 1000).default(190),
      lastWithdrawalAge: z.number().int().min(85).max(119).default(99),
      maxRateBp: bp(100, 10000).default(1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("floor_ceiling"),
      /** Absent = the plan's own percentage. */
      rateBp: bp(50, 2000).optional(),
      /** Below and above planned discretionary spending. */
      floorBp: bp(0, 9000).default(1500),
      ceilingBp: bp(0, 20000).default(2000),
    })
    .strict(),
]);
export type StrategyConfig = z.infer<typeof StrategyConfig>;
export type StrategyConfigInput = z.input<typeof StrategyConfig>;

/** v1 has one order (cash, taxable, pre-tax, Roth; penalties last) and a cash reserve in today's dollars. */
export const WithdrawalOrderConfig = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default"), cashReserveCents: PlanCents.default("0") }).strict(),
]);
export type WithdrawalOrderConfig = z.infer<typeof WithdrawalOrderConfig>;

export const DEFAULT_STRATEGY = { kind: "constant_dollar" } as const satisfies StrategyConfig;
export const DEFAULT_WITHDRAWAL_ORDER = { kind: "default", cashReserveCents: "0" } as const satisfies WithdrawalOrderConfig;

/** The strategy cards of the run-settings page (strategies-outputs-web §5.4). */
export const STRATEGY_INFO: Record<StrategyKind, { label: string; summary: string; source: string }> = {
  constant_dollar: {
    label: "Constant inflation-adjusted",
    summary:
      "Spend your plan every year, raised only for inflation, whatever markets do. This is the rule behind William Bengen's 4% (1994). Spending is steady; the risk is running out after a bad early stretch.",
    source: "Bengen (1994)",
  },
  fixed_percentage: {
    label: "Fixed percentage",
    summary:
      "Take the same percentage of whatever the portfolio is worth each year. The rule cannot empty the portfolio, but your income rises and falls with the market. Essentials are topped up if the percentage falls short.",
    source: "Percentage-of-portfolio rule",
  },
  guardrails: {
    label: "Guardrails",
    summary:
      "Follow your plan, but skip the inflation raise after a losing year, cut the portfolio-funded part 10% when the withdrawal rate climbs more than 20% above where it started (not in the last 15 years), and raise it 10% when it falls more than 20% below (Guyton and Klinger, 2006).",
    source: "Guyton and Klinger (2006)",
  },
  vpw: {
    label: "Variable percentage",
    summary:
      "Each year withdraw a percentage of the portfolio that rises with age, sized so the money would last to age 100 at long-run growth rates for your stock and bond mix (the Bogleheads VPW method). Income varies with the market.",
    source: "Bogleheads variable percentage withdrawal",
  },
  floor_ceiling: {
    label: "Floor and ceiling",
    summary:
      "Essential spending is paid every year, by Social Security, pensions and annuities first. Discretionary spending is a percentage of the portfolio, kept between 15% below and 20% above your plan (after Bengen, 2001).",
    source: "Bengen (2001)",
  },
};
