import {
  DEFAULT_ASSET_CLASS_MAP,
  type AssetClass,
  type PlanBucket,
  type SimInput,
  type SimRunView,
  type SimSummary,
  type StrategyConfig,
} from "@meridian/shared";
import { money, shortDate } from "./format.js";
import { assetClassLabel, formatPpm } from "./investments.js";
import { BUCKETS, bucketLabel, countText, durationText, monthText, percentInputValue, percentText, ratioBp, strategyLabel } from "./retirementFormat.js";
import { modelText } from "./retirementSummary.js";

/**
 * The assumptions list (strategies-outputs-web §3.13, §5.5 item 8): `describeAssumptions(input,
 * run)` turns a run's frozen input (`GET /runs/:id/input`) and its view into `{ group, label, value }`
 * rows in the groups Run, Markets, Household, Starting balances, Spending, Strategy, Withdrawals,
 * Taxes, Simplifications and Warnings. Pure; every amount is the input's own cents, formatted.
 */

export type AssumptionGroup = "Run" | "Markets" | "Household" | "Starting balances" | "Spending" | "Strategy" | "Withdrawals" | "Taxes" | "Simplifications" | "Warnings";

export interface Assumption {
  group: AssumptionGroup;
  label: string;
  value: string;
}

/** What else the page knows: the run's detail (summary and warnings), and `GET /meta` and `GET /rules`. */
export interface AssumptionContext {
  summary?: SimSummary | null;
  warnings?: ReadonlyArray<{ code: string; message: string }>;
  ruleSets?: ReadonlyArray<{ id: string; label: string }>;
  lastPublishedYear?: number;
  notModelled?: ReadonlyArray<{ label: string }>;
}

const pct = (bp: number) => `${percentInputValue(bp)}%`;

/** Every parameter of a strategy in words (§3.13 "Strategy (kind and every parameter in words)"). */
export function strategyParameters(strategy: StrategyConfig): string {
  switch (strategy.kind) {
    case "constant_dollar":
      return "Spend the plan every year, raised with inflation";
    case "fixed_percentage":
      return `${pct(strategy.rateBp)} of the spendable portfolio each year`;
    case "guardrails":
      return [
        `cut ${pct(strategy.cutBp)} when the withdrawal rate is more than ${pct(strategy.upperBandBp)} above the initial rate`,
        `raise ${pct(strategy.raiseBp)} when it is more than ${pct(strategy.lowerBandBp)} below`,
        strategy.skipInflationAfterLoss ? "the inflation raise is skipped after a losing year" : "the inflation raise is never skipped",
        `no cuts in the last ${strategy.preservationCutoffYears} years`,
        `planning age ${strategy.planningAge}`,
      ].join("; ");
    case "vpw":
      return `real growth ${pct(strategy.stockRealBp)} for stocks and ${pct(strategy.bondRealBp)} for bonds; the last withdrawal at ${strategy.lastWithdrawalAge}; at most ${pct(strategy.maxRateBp)} a year`;
    case "floor_ceiling":
      return `${strategy.rateBp === undefined ? "the plan's own percentage" : pct(strategy.rateBp)} of the portfolio for discretionary spending, kept between ${pct(strategy.floorBp)} below and ${pct(strategy.ceilingBp)} above the plan`;
  }
}

function returnModel(input: SimInput, summary: SimSummary | null | undefined): string {
  const m = input.settings.returnModel;
  if (summary !== undefined && summary !== null && m.kind !== "parametric") return modelText(summary.model);
  switch (m.kind) {
    case "historical":
      return `Historical sequences (${m.cohorts === "auto" ? "complete stretches of history when enough exist, else wrap-around" : m.cohorts === "complete" ? "complete stretches of history only" : "every start year, wrapping around"})`;
    case "bootstrap":
      return `Block bootstrap of the historical record, mean block ${m.meanBlockYears} years`;
    case "parametric": {
      if (m.preset !== "custom" || m.params === undefined) return m.preset === "conservative" ? "Parametric, conservative future" : "Parametric, long-run history";
      const p = m.params;
      const part = (name: string, v: { meanBp: number; volBp: number }) => `${name} ${pct(v.meanBp)} ± ${pct(v.volBp)}`;
      return `Parametric, your own figures (${p.meanKind} means ± volatility): ${[part("stocks", p.stocks), part("bonds", p.bonds), part("bills", p.bills), part("inflation", p.inflation)].join(", ")}`;
    }
    case "fixed":
      return `Fixed returns (a test model), ${m.series.length} ${m.series.length === 1 ? "year" : "years"}`;
  }
}

function assetMap(input: SimInput): string {
  const map = input.settings.portfolio.assetClassMap;
  if (map === undefined) return "International stock, real estate and other are modelled as stocks; bonds as bonds; cash as bills";
  const classes = Object.keys(DEFAULT_ASSET_CLASS_MAP) as AssetClass[];
  return classes.map((c) => `${assetClassLabel(c)}: stocks ${pct(map[c][0])}, bonds ${pct(map[c][1])}, bills ${pct(map[c][2])}`).join("; ");
}

function personLine(input: SimInput, i: number): string {
  const p = input.household.people[i]!;
  const born = monthText(`${p.birthYear}-${String(p.birthMonth).padStart(2, "0")}`);
  const retire = p.retirementMonth <= input.plan.startMonth ? "retired" : `retires ${monthText(p.retirementMonth)} (age ${Number(p.retirementMonth.slice(0, 4)) - p.birthYear})`;
  const life =
    p.longevity.mode === "fixed"
      ? `lives through age ${p.longevity.age}`
      : `life from a mortality table${p.longevity.adjustYears === 0 ? "" : `, ${p.longevity.adjustYears > 0 ? "+" : ""}${p.longevity.adjustYears} years`}, at most ${p.longevity.maxAge}`;
  return `born ${born}, ${retire}, ${life}`;
}

/**
 * The assumptions of a run, in the groups of §3.13. `run` is the run's view (`SimRunView` or
 * `SimRunDetail`); `context` adds what the page loaded besides (the run's summary and warnings, the
 * rule sets of `GET /meta`, the last published year and what is not modelled from `GET /rules`).
 */
export function describeAssumptions(input: SimInput, run: Pick<SimRunView, "paths" | "seed" | "threads" | "engineVersion" | "dataVersion" | "durationMs">, context: AssumptionContext = {}): Assumption[] {
  const out: Assumption[] = [];
  const add = (group: AssumptionGroup, label: string, value: string) => out.push({ group, label, value });
  const s = input.settings;
  const people = input.household.people;

  // Run
  add("Run", "Scenario", input.meta.scenarioName);
  add("Run", "Balances as of", shortDate(input.meta.asOf));
  const startMonth = monthText(input.plan.startMonth);
  add("Run", "First year", input.plan.firstYearMonths === 12 ? `all of ${input.plan.startYear}` : `${input.plan.firstYearMonths} of 12 months (from ${startMonth}); yearly amounts are prorated by months`);
  add("Run", "Plan years", `${input.plan.startYear} to ${input.plan.endYear}`);
  add("Run", "Paths", run.paths === s.paths ? countText(run.paths) : `${countText(run.paths)} (${countText(s.paths)} requested)`);
  add("Run", "Seed", String(s.seed));
  add("Run", "Threads", `${run.threads === null ? "—" : String(run.threads)} (results do not depend on the thread count)`);
  add("Run", "Versions", `engine ${run.engineVersion ?? "—"}, data ${run.dataVersion}`);
  add("Run", "Duration", durationText(run.durationMs));

  // Markets
  add("Markets", "Return model", returnModel(input, context.summary));
  add("Markets", "Inflation", "Simulated with the returns on every path; every figure is also shown in today's dollars");
  add(
    "Markets",
    "Rebalancing",
    s.portfolio.taxableRebalance === "full"
      ? "Every account back to its target mix each year; in taxable accounts this realizes gains in the year of the trade"
      : "Retirement accounts back to their targets each year; taxable accounts are traded only for the year's flows",
  );
  add("Markets", "Asset classes", assetMap(input));
  const overrides = Object.entries(s.tax.taxDrag);
  add(
    "Markets",
    "Taxable-account yields",
    overrides.length === 0
      ? "The data file's dividend yields, qualified shares and interest spreads"
      : `The data file's, with changes: ${overrides
          .map(([c, o]) => {
            const parts: string[] = [];
            if (o.dividendYieldBp !== undefined) parts.push(`dividends ${pct(o.dividendYieldBp)}`);
            if (o.qualifiedShareBp !== undefined) parts.push(`qualified ${pct(o.qualifiedShareBp)}`);
            if (o.interestSpreadBp !== undefined) parts.push(`interest spread ${pct(o.interestSpreadBp)}`);
            if (o.taxExemptShareBp !== undefined) parts.push(`tax-exempt ${pct(o.taxExemptShareBp)}`);
            if (o.gainDistributionRateBp !== undefined) parts.push(`gain distributions ${pct(o.gainDistributionRateBp)}`);
            return `${assetClassLabel(c as AssetClass)} ${parts.join(", ")}`;
          })
          .join("; ")}`,
  );
  const costs = input.accounts.filter((a) => a.expenseRatioPpm > 0);
  add("Markets", "Fund costs", costs.length === 0 ? "None measured (0)" : `${costs.map((a) => `${a.name} ${formatPpm(a.expenseRatioPpm)}`).join(", ")} a year; other accounts 0`);

  // Household
  people.forEach((_, i) => add("Household", people[i]!.name, personLine(input, i)));
  add(
    "Household",
    "Filing status",
    people.length === 2 ? "Married filing jointly; after a first death the survivor files single from the following year" : "Single",
  );
  add("Household", "State", `${input.household.state} (decides the basis step-up of joint accounts at a death; no state tax is modelled)`);

  // Starting balances
  const byBucket = new Map<PlanBucket, bigint>();
  for (const a of input.accounts) byBucket.set(a.bucket, (byBucket.get(a.bucket) ?? 0n) + BigInt(a.balanceCents));
  for (const b of BUCKETS) {
    const cents = byBucket.get(b);
    if (cents !== undefined) add("Starting balances", bucketLabel(b), money(cents.toString()));
  }
  add("Starting balances", "Total", money([...byBucket.values()].reduce((x, y) => x + y, 0n).toString()));
  const assumed = input.accounts.filter((a) => a.allocationSource === "household_target" || a.allocationSource === "household_actual" || a.allocationSource === "assumed");
  if (assumed.length > 0) add("Starting balances", "Allocation assumed", assumed.map((a) => a.name).join(", "));
  const basis = input.accounts.filter((a) => a.bucket === "taxable" && (a.basisCoverage === "partial" || a.basisCoverage === "none"));
  if (basis.length > 0) add("Starting balances", "Cost basis partly unknown", basis.map((a) => a.name).join(", "));
  for (const a of input.accounts.filter((x) => x.synthetic)) {
    add("Starting balances", a.name, a.bucket === "cash" ? "Added to hold surplus cash; starts empty" : "Added to receive Roth conversions; starts empty");
  }

  // Spending
  const sp = input.spending;
  add("Spending", "Base spending", `${money(sp.baseAnnualCents)} a year in today's dollars, from ${monthText(sp.startMonth)}`);
  const essentialBp = ratioBp(sp.essentialAnnualCents, sp.baseAnnualCents);
  add("Spending", "Essential spending", `${money(sp.essentialAnnualCents)} a year${essentialBp === undefined ? "" : ` (${percentText(essentialBp)} of base)`}`);
  if (sp.phases.length > 0) add("Spending", "Phases", sp.phases.map((p) => `from ${p.fromYear}: ${percentText(p.multiplierBp)}`).join("; "));
  for (const h of sp.healthcare) {
    const name = people.find((p) => p.id === h.personId)?.name ?? h.personId;
    const amounts = `${money(h.preMedicareAnnualCents)} a year before Medicare, ${money(h.medicareAnnualCents)} from ${monthText(h.medicareFrom)}`;
    add("Spending", `Healthcare (${name})`, h.inBase ? `Included in base spending; ${amounts} caps the HSA's tax-free withdrawals` : amounts);
  }
  for (const g of sp.goals) add("Spending", `Goal: ${g.name}`, `${money(g.amountCents)} in ${g.year} (${g.dollars === "today" ? "today's dollars" : "nominal"})`);
  if (people.length === 2) add("Spending", "After a first death", `${percentText(sp.survivorBp)} of the couple's base spending`);
  for (const c of sp.longTermCare) {
    const name = people.find((p) => p.id === c.personId)?.name ?? c.personId;
    add("Spending", `Long-term care (${name})`, `${money(c.reserveCents)} set aside, spent over the last ${c.lastYears} ${c.lastYears === 1 ? "year" : "years"} of life`);
  }

  // Strategy
  add("Strategy", strategyLabel(s.strategy.kind), strategyParameters(s.strategy));

  // Withdrawals
  add(
    "Withdrawals",
    "Order",
    "Cash above the reserve, the HSA for healthcare, taxable accounts, pre-tax accounts of owners past 59½, Roth money that leaves without tax, the cash reserve; then the penalized sources (pre-tax before 59½, the rest of the Roth, the HSA beyond healthcare)",
  );
  add("Withdrawals", "Cash kept on hand", `${money(s.withdrawalOrder.cashReserveCents)} in today's dollars`);
  add(
    "Withdrawals",
    "Roth conversions",
    input.rothConversions.length === 0
      ? "None"
      : input.rothConversions
          .map((c) => `${c.year}: ${people.find((p) => p.id === c.personId)?.name ?? c.personId} ${money(c.amountCents)}${c.dollars === "today" ? " (today's dollars)" : ""}`)
          .join("; "),
  );

  // Taxes
  add("Taxes", "Rule set", context.ruleSets?.find((r) => r.id === s.taxRuleSet)?.label ?? s.taxRuleSet);
  add(
    "Taxes",
    "Indexing",
    `${context.lastPublishedYear === undefined ? "Published tables" : `Tables published through ${context.lastPublishedYear}`}; later years indexed by each path's inflation with the statutory rounding${
      s.tax.chainedCpiWedgeBp > 0 ? `, less ${pct(s.tax.chainedCpiWedgeBp)} a year (chained CPI)` : ""
    }`,
  );
  add("Taxes", "Payroll tax", s.tax.includePayrollTax ? "Employee Social Security and Medicare tax on wages, shown as its own line" : "Not subtracted");
  if (s.tax.realWageGrowthBp > 0) add("Taxes", "Wage growth", `The wage base and earnings-test amounts grow ${pct(s.tax.realWageGrowthBp)} a year faster than prices`);
  if (BigInt(s.tax.capLossCarryInCents) > 0n) add("Taxes", "Capital loss carried in", money(s.tax.capLossCarryInCents));
  add("Taxes", "Not modelled", context.notModelled !== undefined && context.notModelled.length > 0 ? context.notModelled.map((n) => n.label).join("; ") : "State tax, IRMAA and ACA subsidies");

  // Simplifications (strategies §8 and the plan's deviations that change results)
  add("Simplifications", "Before retirement", "Spending and take-home pay are not modelled before the first retirement, so a shortfall before retirement cannot show");
  add("Simplifications", "Timing", "Annual steps: each year's flows happen at its start and returns after them");
  add("Simplifications", "Taxable accounts", "Stocks, bonds and bills with an average cost basis per asset, not tax lots");
  add("Simplifications", "Ending wealth", "Not reduced for the tax owed on pre-tax balances");
  add("Simplifications", "Year table", "One simulated path ranked by ending wealth, not the same percentile of every column");
  if (s.strategy.kind === "fixed_percentage" || s.strategy.kind === "vpw") {
    add("Simplifications", "Percentage strategies", "Tax comes out of the rule's withdrawal, so spending is lower than the percentage by the tax on it");
  }
  if (people.some((p) => p.longevity.mode === "mortality")) {
    add("Simplifications", "Mortality table", "Unisex (IRS 2010CM) until a sex-specific table is installed, so sex has no effect");
  }
  if (people.length === 2) add("Simplifications", "Filing", "Two people in one household are treated as married filing jointly");

  // Warnings: the engine's (C41) and the resolver's (input.meta.warnings)
  for (const w of context.warnings ?? []) add("Warnings", w.code, w.message);
  for (const w of input.meta.warnings) add("Warnings", w.code, w.message);
  return out;
}
