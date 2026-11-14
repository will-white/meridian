import { SimInput, StrategyConfig } from "@meridian/shared";
import { exampleSimSummary, fixtureSimInput } from "@meridian/shared/src/retirement/testFixtures.js";
import { describe, expect, it } from "vitest";
import { describeAssumptions, strategyParameters, type Assumption } from "./retirementAssumptions.js";

const RUN = { paths: 10000, seed: 1, threads: 3, engineVersion: "1.0.1", dataVersion: "2026.11.1", durationMs: 1900 };

function valueOf(rows: readonly Assumption[], group: Assumption["group"], label: string): string | undefined {
  return rows.find((r) => r.group === group && r.label === label)?.value;
}

describe("describeAssumptions (strategies-outputs-web §3.13)", () => {
  const rows = describeAssumptions(fixtureSimInput(), RUN, {
    ruleSets: [{ id: "current_law", label: "Current law" }],
    lastPublishedYear: 2027,
    warnings: [{ code: "first_year_lump", message: "The first year is three months long." }],
  });

  it("the groups in order, each present", () => {
    const groups = [...new Set(rows.map((r) => r.group))];
    expect(groups).toEqual(["Run", "Markets", "Household", "Starting balances", "Spending", "Strategy", "Withdrawals", "Taxes", "Simplifications", "Warnings"]);
  });

  it("Run: scenario, as-of date, first-year share, paths, seed, threads with the note, versions, duration", () => {
    expect(rows.filter((r) => r.group === "Run").map((r) => [r.label, r.value])).toEqual([
      ["Scenario", "Base plan"],
      ["Balances as of", "10/13/26"],
      ["First year", "3 of 12 months (from October 2026); yearly amounts are prorated by months"],
      ["Plan years", "2026 to 2072"],
      ["Paths", "10,000"],
      ["Seed", "1"],
      ["Threads", "3 (results do not depend on the thread count)"],
      ["Versions", "engine 1.0.1, data 2026.11.1"],
      ["Duration", "1.9 s"],
    ]);
    // The historical model reports its own count (inputs decision 25).
    expect(valueOf(describeAssumptions(fixtureSimInput(), { ...RUN, paths: 10094 }), "Run", "Paths")).toBe("10,094 (10,000 requested)");
    expect(valueOf(describeAssumptions(fixtureSimInput(), { ...RUN, threads: 0 }), "Run", "Threads")).toBe("none (run inline) (results do not depend on the thread count)");
  });

  it("Markets: the default bootstrap, full rebalancing (plan decision 8), the default asset map, yields and the measured fund cost", () => {
    expect(valueOf(rows, "Markets", "Return model")).toBe("Block bootstrap of the historical record, mean block 10 years");
    expect(valueOf(rows, "Markets", "Rebalancing")).toBe("Every account back to its target mix each year; in taxable accounts this realizes gains in the year of the trade");
    expect(valueOf(rows, "Markets", "Asset classes")).toBe("International stock, real estate and other are modelled as stocks; bonds as bonds; cash as bills");
    expect(valueOf(rows, "Markets", "Taxable-account yields")).toBe("The data file's dividend yields, qualified shares and interest spreads");
    // The fixture's brokerage account B: 270 ppm measured (inputs open question 12) → 0.03%.
    expect(valueOf(rows, "Markets", "Fund costs")).toBe("Brokerage 0.03% a year; other accounts 0");
  });

  it("Household: each person, the filing rule and the state", () => {
    expect(valueOf(rows, "Household", "Alex")).toBe("born June 1975, retires June 2035 (age 60), lives through age 95");
    expect(valueOf(rows, "Household", "Sam")).toBe("born September 1977, retires September 2039 (age 62), lives through age 95");
    expect(valueOf(rows, "Household", "Filing status")).toBe("Married filing jointly; after a first death the survivor files single from the following year");
    expect(valueOf(rows, "Household", "State")).toBe("CO (decides the basis step-up of joint accounts at a death; no state tax is modelled)");
  });

  it("Starting balances by bucket (inputs §7.0: 22,582,700 in all), with the assumed allocations, the unknown basis and the synthetic Roth", () => {
    expect(rows.filter((r) => r.group === "Starting balances").map((r) => [r.label, r.value])).toEqual([
      ["Taxable", "$31,377.00"],
      ["Pre-tax", "$150,000.00"],
      ["Roth", "$18,200.00"],
      ["HSA", "$1,250.00"],
      ["Cash", "$25,000.00"],
      ["Total", "$225,827.00"],
      ["Allocation assumed", "Acme 401(k), HealthEquity HSA"],
      ["Cost basis partly unknown", "Old Brokerage"],
      ["Roth (for conversions)", "Added to receive Roth conversions; starts empty"],
    ]);
  });

  it("Spending: base, essentials (60%), phases, healthcare kept for the HSA (C35), the goal, the survivor share", () => {
    expect(valueOf(rows, "Spending", "Base spending")).toBe("$40,000.00 a year in today's dollars, from June 2035");
    expect(valueOf(rows, "Spending", "Essential spending")).toBe("$24,000.00 a year (60% of base)");
    expect(valueOf(rows, "Spending", "Phases")).toBe("from 2035: 100%; from 2050: 100%; from 2060: 100%");
    expect(valueOf(rows, "Spending", "Healthcare (Alex)")).toBe("Included in base spending; $0.00 a year before Medicare, $0.00 from June 2040 caps the HSA's tax-free withdrawals");
    expect(valueOf(rows, "Spending", "Goal: Roof")).toBe("$18,000.00 in 2031 (today's dollars)");
    expect(valueOf(rows, "Spending", "After a first death")).toBe("100% of the couple's base spending");
  });

  it("Strategy, Withdrawals and Taxes", () => {
    expect(valueOf(rows, "Strategy", "Constant inflation-adjusted")).toBe("Spend the plan every year, raised with inflation");
    expect(valueOf(rows, "Withdrawals", "Cash kept on hand")).toBe("$0.00 in today's dollars");
    expect(valueOf(rows, "Withdrawals", "Roth conversions")).toBe("2036: Alex $30,000.00 (today's dollars)");
    expect(valueOf(rows, "Withdrawals", "Order")).toMatch(/^Cash above the reserve, the HSA for healthcare, taxable accounts/);
    expect(valueOf(rows, "Taxes", "Rule set")).toBe("Current law");
    expect(valueOf(rows, "Taxes", "Indexing")).toBe("Tables published through 2027; later years indexed by each path's inflation with the statutory rounding");
    expect(valueOf(rows, "Taxes", "Payroll tax")).toBe("Employee Social Security and Medicare tax on wages, shown as its own line");
    expect(valueOf(rows, "Taxes", "Not modelled")).toBe("State tax, IRMAA and ACA subsidies");
  });

  it("Simplifications and Warnings: the engine's warnings, then the resolver's", () => {
    expect(valueOf(rows, "Simplifications", "Before retirement")).toBe("Spending and take-home pay are not modelled before the first retirement, so a shortfall before retirement cannot show");
    expect(valueOf(rows, "Simplifications", "Filing")).toBe("Two people in one household are treated as married filing jointly");
    expect(valueOf(rows, "Simplifications", "Mortality table")).toBeUndefined();
    expect(rows.filter((r) => r.group === "Warnings").map((r) => r.label)).toEqual(["first_year_lump", "basis_unknown", "allocation_assumed"]);
  });

  it("other settings: a historical run states its mode from the summary; custom parameters, flows-only, a mortality table, a percentage strategy", () => {
    const base = fixtureSimInput();
    const custom = SimInput.parse({
      ...base,
      household: { ...base.household, people: [{ ...base.household.people[0]!, longevity: { mode: "mortality", sex: "female", adjustYears: 2, maxAge: 110 } }, base.household.people[1]!] },
      settings: {
        ...base.settings,
        portfolio: { taxableRebalance: "flows_only" },
        strategy: { kind: "vpw", stockRealBp: 500, bondRealBp: 190, lastWithdrawalAge: 99, maxRateBp: 1000 },
        returnModel: {
          kind: "parametric",
          preset: "custom",
          params: {
            meanKind: "arithmetic",
            stocks: { meanBp: 600, volBp: 1200 },
            bonds: { meanBp: 400, volBp: 700 },
            bills: { meanBp: 300, volBp: 200, persistenceBp: 0 },
            inflation: { meanBp: 250, volBp: 100, persistenceBp: 0 },
            correlationBp: [
              [10000, 0, 0, 0],
              [0, 10000, 0, 0],
              [0, 0, 10000, 0],
              [0, 0, 0, 10000],
            ],
          },
        },
      },
    });
    const r = describeAssumptions(custom, RUN);
    expect(valueOf(r, "Markets", "Return model")).toBe("Parametric, your own figures (arithmetic means ± volatility): stocks 6% ± 12%, bonds 4% ± 7%, bills 3% ± 2%, inflation 2.5% ± 1%");
    expect(valueOf(r, "Markets", "Rebalancing")).toBe("Retirement accounts back to their targets each year; taxable accounts are traded only for the year's flows");
    expect(valueOf(r, "Household", "Alex")).toBe("born June 1975, retires June 2035 (age 60), life from a mortality table, +2 years, at most 110");
    expect(valueOf(r, "Simplifications", "Mortality table")).toBe("Unisex (IRS 2010CM) until a sex-specific table is installed, so sex has no effect");
    expect(valueOf(r, "Simplifications", "Percentage strategies")).toBe("Tax comes out of the rule's withdrawal, so spending is lower than the percentage by the tax on it");
    const historical = SimInput.parse({ ...base, settings: { ...base.settings, returnModel: { kind: "historical", cohorts: "auto" } } });
    const summary = { ...exampleSimSummary(), model: { kind: "historical" as const, requestedPaths: 10000, cohortMode: "complete" as const, cohortCount: 52, firstStartYear: 1928, lastStartYear: 1979 } };
    expect(valueOf(describeAssumptions(historical, RUN, { summary }), "Markets", "Return model")).toBe("Historical sequences, start years 1928 to 1979, each a complete stretch of history");
    // Without a summary, auto is described as the engine decides it (planCohorts; plan decision 7).
    expect(valueOf(describeAssumptions(historical, RUN), "Markets", "Return model")).toBe(
      "Historical sequences (complete stretches of history when every life is a fixed age and at least 30 stretches exist, else wrap-around)",
    );
  });
});

describe("strategyParameters: every parameter in words", () => {
  it("the defaults of each kind", () => {
    expect(strategyParameters(StrategyConfig.parse({ kind: "fixed_percentage" }))).toBe("4% of the spendable portfolio each year");
    expect(strategyParameters(StrategyConfig.parse({ kind: "guardrails" }))).toBe(
      "cut 10% when the withdrawal rate is more than 20% above the initial rate; raise 10% when it is more than 20% below; the inflation raise is skipped after a losing year; no cuts in the last 15 years; planning age 95",
    );
    expect(strategyParameters(StrategyConfig.parse({ kind: "vpw" }))).toBe("real growth 5% for stocks and 1.9% for bonds; the last withdrawal at 99; at most 10% a year");
    expect(strategyParameters(StrategyConfig.parse({ kind: "floor_ceiling" }))).toBe(
      "the plan's own percentage of the portfolio for discretionary spending, kept between 15% below and 20% above the plan",
    );
    expect(strategyParameters(StrategyConfig.parse({ kind: "floor_ceiling", rateBp: 425 }))).toMatch(/^4\.25% of the portfolio/);
  });
});
