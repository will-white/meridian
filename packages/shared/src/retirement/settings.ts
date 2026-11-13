import { z } from "zod";
import { DEFAULT_PATHS, MAX_PATHS, MIN_PATHS, schemaVersionOf, UnsupportedSchemaVersionError } from "./primitives.js";
import { DEFAULT_PORTFOLIO_SETTINGS, DEFAULT_RETURN_MODEL, PortfolioSettings, ReturnModelConfig } from "./returnModel.js";
import { DEFAULT_STRATEGY, DEFAULT_WITHDRAWAL_ORDER, StrategyConfig, WithdrawalOrderConfig } from "./strategy.js";
import { DEFAULT_RULE_SET_ID, RuleSetId, TaxSettings } from "./tax.js";

/**
 * A scenario's run settings (`scenario.settings`, frozen into `SimInput.settings`): the envelope
 * of inputs-and-data §4.4 as seams §2.1 reconciles it. The inner shapes belong to the other areas
 * (return model and portfolio: engine; strategy and order: strategies; rule set and tax: tax) and
 * all live in this directory. It is a request body and a stored document: bounded shapes,
 * integers, no nulls.
 */
export const RunSettings = z
  .object({
    schemaVersion: z.literal(1),
    /** A request: the historical model reports its own count (inputs decision 25). */
    paths: z.number().int().min(MIN_PATHS).max(MAX_PATHS).default(DEFAULT_PATHS),
    /** One shared default across scenarios, so two scenarios see the same markets (inputs decision 27). */
    seed: z.number().int().min(0).max(4294967295).default(1),
    /** 12 is reserved (L3). */
    stepsPerYear: z.literal(1),
    returnModel: ReturnModelConfig,
    portfolio: PortfolioSettings,
    strategy: StrategyConfig,
    /** v1: `{ kind: "default" }`. */
    withdrawalOrder: WithdrawalOrderConfig,
    taxRuleSet: RuleSetId.default(DEFAULT_RULE_SET_ID),
    tax: TaxSettings,
  })
  .strict();
export type RunSettings = z.infer<typeof RunSettings>;
export type RunSettingsInput = z.input<typeof RunSettings>;

/**
 * The settings of a new scenario: 10,000 paths, seed 1, the stationary bootstrap with a mean
 * block of 10 years (plan decision 6), taxable accounts fully rebalanced (plan decision 8),
 * constant inflation-adjusted spending, the default order, current law and the default tax
 * assumptions. A fresh object on every call.
 */
export function defaultRunSettings(): RunSettings {
  return RunSettings.parse({
    schemaVersion: 1,
    stepsPerYear: 1,
    returnModel: DEFAULT_RETURN_MODEL,
    portfolio: DEFAULT_PORTFOLIO_SETTINGS,
    strategy: DEFAULT_STRATEGY,
    withdrawalOrder: DEFAULT_WITHDRAWAL_ORDER,
    tax: {},
  } satisfies RunSettingsInput);
}

/**
 * Reads stored run settings of any known version as the current one (seams F10): a dispatch on
 * `schemaVersion`, the identity for version 1. A later version ships with a pure upgrade here;
 * a frozen `sim_run.input` is never rewritten.
 */
export function upgradeRunSettings(raw: unknown): RunSettings {
  const version = schemaVersionOf(raw);
  switch (version) {
    case 1:
      return RunSettings.parse(raw);
    default:
      throw new UnsupportedSchemaVersionError("RunSettings", version);
  }
}
