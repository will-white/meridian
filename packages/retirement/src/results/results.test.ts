import { readFileSync } from "node:fs";
import { FanSeries, PlanBucket, SimSummary, type SimInput, type YearRow, YearTable, deflateYearTable, pathStory } from "@meridian/shared";
import { fixtureSimInput } from "@meridian/shared/src/retirement/testFixtures.js";
import { describe, expect, it } from "vitest";
import { type EngineResult, aggregate } from "../aggregate.js";
import { TAX_FUNCTIONS } from "../hooks.js";
import { W, ZERO_YIELDS } from "../loopTestKit.js";
import { type PreparedRun, prepare } from "../prepare.js";
import { simulatePathDetail, simulateRun } from "../simulate.js";
import { createPathState } from "../state.js";
import { referenceR1Input, referenceR2Input } from "../testing/referenceScenarios.js";
import { type SimInputOptions, account, buildSimInput } from "../testing/simInput.js";
import { fixedSocialSecurity, noTaxInto, stubHooks, stubTaxFunctions } from "../testing/stubs.js";
import { dollarsToCentsBigInt } from "../units.js";
import { createEngineHooks } from "../withdrawals/plan.js";
import { failureSummary, toFanSeries, toSimSummary } from "./summary.js";
import { essentialCoverageBp, toYearTable, withdrawalRateBp } from "./yearTable.js";

// Build step 20: the result mappers (strategies-outputs-web §3.9 to §3.11 and §7.3; seams C9,
// C37, C40, C43 to C46, C52, F9) on the engine's own runs. R1 and R2 are the regenerated sheets
// (reference/sheets/r1.md, r2.md) through the production hooks and tax functions; their cells
// come from reference/fixtures/r1.expected.csv and r2.expected.csv.

const NO_TAX = { federalTaxInto: noTaxInto };

function expectedRows(name: string): Array<Record<string, string>> {
  const lines = readFileSync(new URL(`../../reference/fixtures/${name}`, import.meta.url), "utf8").trim().split("\n");
  const head = lines[0]!.split(",");
  return lines.slice(1).map((line) => Object.fromEntries(line.split(",").map((v, i) => [head[i]!, v])));
}

/** A sheet cell "1,234.56" (printed without separators in the CSV) as cents. */
const cellCents = (v: string) => BigInt(Math.round(Number(v) * 100));

interface Mapped {
  run: PreparedRun;
  result: EngineResult;
  table: YearTable;
}

/** Prepares, runs every path inline, aggregates, and maps path `k` (default: the median path). */
function mapped(input: SimInput, k?: number): Mapped {
  const run = prepare(input);
  const result = aggregate(run, simulateRun(run));
  const path = k ?? result.percentilePathIndex[50]!;
  return { run, result, table: toYearTable(simulatePathDetail(run, path), run) };
}

const sum = (xs: readonly string[]) => xs.reduce((s, x) => s + BigInt(x), 0n);

/** OUT-8's checks of one table: every group adds up to its total in cents, and the roll-forward holds. */
function assertAddsUp(table: YearTable): void {
  let previous = BigInt(table.startingTotal);
  const buckets = table.accounts.map((a) => a.bucket);
  const bucketSum = (parts: readonly string[], b: PlanBucket) => parts.reduce((s, x, a) => (buckets[a] === b ? s + BigInt(x) : s), 0n);
  for (const row of table.rows) {
    const at = `${row.year}`;
    const inc = row.income;
    expect(sum([inc.wages, ...inc.socialSecurity, inc.pensionAnnuity, inc.rental, inc.other]), `${at} income`).toBe(BigInt(inc.total));
    expect(sum(row.withdrawals.byAccount), `${at} withdrawals`).toBe(BigInt(row.withdrawals.total));
    expect(sum(row.withdrawals.rmdByAccount), `${at} RMDs`).toBe(BigInt(row.withdrawals.rmdTotal));
    expect(sum(Object.values(row.withdrawals.byBucket)), `${at} withdrawals by bucket`).toBe(BigInt(row.withdrawals.total));
    const sp = row.spending;
    expect(sum([sp.core, sp.healthcare, sp.longTermCare, sp.goals]), `${at} spending`).toBe(BigInt(sp.funded));
    const tx = row.tax;
    expect(sum([tx.incomeTaxCents, tx.niitCents, tx.earlyPenaltyCents, tx.hsaPenaltyCents]), `${at} taxes`).toBe(BigInt(tx.totalFederalCents));
    expect(sum([tx.ordinaryTaxCents, tx.capitalGainsTaxCents]), `${at} income tax`).toBe(BigInt(tx.incomeTaxCents));
    expect(sum([tx.ordinaryTaxableCents, tx.gainsAt0Cents, tx.gainsAt15Cents, tx.gainsAt20Cents]), `${at} taxable income`).toBe(BigInt(tx.taxableIncomeCents));
    expect(sum(row.ending.byAccount), `${at} ending`).toBe(BigInt(row.ending.total));
    expect(sum(Object.values(row.ending.byBucket)), `${at} ending by bucket`).toBe(BigInt(row.ending.total));
    for (const b of PlanBucket.options) {
      expect(BigInt(row.ending.byBucket[b]), `${at} ending ${b}`).toBe(bucketSum(row.ending.byAccount, b));
      expect(BigInt(row.withdrawals.byBucket[b]), `${at} withdrawals ${b}`).toBe(bucketSum(row.withdrawals.byAccount, b));
    }
    const flows = BigInt(row.contributions.employee) + BigInt(row.contributions.employer) + BigInt(row.surplusSaved) - BigInt(row.withdrawals.total);
    expect(previous + flows + BigInt(row.growth), `${at} roll-forward`).toBe(BigInt(row.ending.total));
    previous = BigInt(row.ending.total);
  }
}

/** Every number in a stored document is an integer and nothing is null (OUT-10, inputs decision 2). */
function assertIntegersOnly(value: unknown, path = "$"): void {
  if (value === null) throw new Error(`${path} is null`);
  if (typeof value === "number") {
    expect(Number.isInteger(value), `${path} = ${value}`).toBe(true);
    return;
  }
  if (Array.isArray(value)) value.forEach((v, i) => assertIntegersOnly(v, `${path}[${i}]`));
  else if (typeof value === "object") for (const [k, v] of Object.entries(value as object)) assertIntegersOnly(v, `${path}.${k}`);
}

function assertBandsOrdered(fan: FanSeries): void {
  for (const bands of [fan.real, fan.nominal, fan.spendingReal]) {
    const order = [bands.p10, bands.p25, bands.p50, bands.p75, bands.p90];
    for (let t = 0; t < bands.p10.length; t++) {
      for (let j = 1; j < order.length; j++) expect(BigInt(order[j]![t]!) >= BigInt(order[j - 1]![t]!), `band ${j} at ${t}`).toBe(true);
    }
  }
}

describe("OUT-4 failure summary (strategies-outputs-web §3.10, C46)", () => {
  it("OUT-4 byYear [0, 0, 1, 0, 2, 1] from 2027 → 4 paths, first 2029, median 2031", () => {
    // Running count 0, 0, 1, 1, 3, 4: it first reaches ceil(4 ÷ 2) = 2 in plan year 4 (2031).
    expect(failureSummary([0, 0, 1, 0, 2, 1], 2027)).toEqual({ paths: 4, byYear: [0, 0, 1, 0, 2, 1], firstDepletionYear: 2029, medianDepletionYear: 2031 });
  });

  it("no failure: the two years are absent (no nulls in a stored document)", () => {
    expect(failureSummary([0, 0, 0], 2027)).toEqual({ paths: 0, byYear: [0, 0, 0] });
    // One failure: first and median are the same year; ceil(1 ÷ 2) = 1.
    expect(failureSummary([0, 1], 2040)).toEqual({ paths: 1, byYear: [0, 1], firstDepletionYear: 2041, medianDepletionYear: 2041 });
  });
});

describe("R1 and R2 through the mappers (OUT-8 to OUT-11)", () => {
  const r1 = mapped(referenceR1Input());
  const r2 = mapped(referenceR2Input());

  it("OUT-8 every row of R1 and R2 adds up, nominal and in today's dollars", () => {
    for (const { table } of [r1, r2]) {
      assertAddsUp(table);
      const real = deflateYearTable(table);
      assertAddsUp({ ...real, startingTotal: table.startingTotal });
      // The today's-dollar ending total is the engine's own figure.
      real.rows.forEach((row, t) => expect(row.ending.total).toBe(table.rows[t]!.ending.totalReal));
    }
  });

  it("OUT-9 R1 2027: withdrawalRateBp 685 (122,696 ÷ 1,790,000); guaranteed income 72,516 against essentials 81,948.75 → 8849", () => {
    expect(r1.table.rows[0]!.strategy.withdrawalRateBp).toBe(685);
    expect(withdrawalRateBp(122696, 0, 1790000)).toBe(685);
    // 72,516 ÷ 81,948.75 = 0.884894… → 8848.95 bp → 8849 (half away from zero, C44).
    expect(essentialCoverageBp(72516, 81948.75)).toBe(8849);
    // R1 2029: benefits 60,504 + pension 12,000 against essentials 130,000 × 1.050625 = 136,581.25:
    // 72,504 ÷ 136,581.25 = 0.530848… → 5308 bp. 2027: 12,000 ÷ 130,000 = 923.08 → 923.
    expect(r1.table.rows[2]!.strategy.essentialCoverageBp).toBe(5308);
    expect(r1.table.rows[0]!.strategy.essentialCoverageBp).toBe(923);
    // The cap at 20000 and the absent denominator.
    expect(essentialCoverageBp(90000, 30000)).toBe(20000);
    expect(essentialCoverageBp(1000, 0)).toBeUndefined();
    expect(withdrawalRateBp(1000, 0, 0)).toBe(0);
  });

  it("OUT-9 every R1 and R2 row: the withdrawal rate and portfolio return of the sheets (§2.11), and the spending, income, investment, tax and ending cells", () => {
    for (const [{ table }, name] of [
      [r1, "r1.expected.csv"],
      [r2, "r2.expected.csv"],
    ] as const) {
      const rows = expectedRows(name);
      expect(table.rows.length).toBe(rows.length);
      table.rows.forEach((row, t) => {
        const e = rows[t]!;
        const at = `${name} ${row.year}`;
        expect(row.year, at).toBe(Number(e.year));
        expect(row.strategy.withdrawalRateBp, `${at} withdrawal rate`).toBe(Number(e.withdrawal_rate_bp));
        expect(row.portfolioReturnBp, `${at} portfolio return`).toBe(Number(e.portfolio_return_bp));
        const cells: Array<[string, string]> = [
          [row.spending.planned, "planned"],
          [row.spending.healthcare, "healthcare"],
          [row.spending.longTermCare, "long_term_care"],
          [row.spending.goals, "goals"],
          [row.spending.floor, "floor"],
          [row.spending.funded, "funded"],
          [row.spending.core, "core"],
          [row.spending.shortfall, "shortfall"],
          [row.surplusSaved, "surplus_saved"],
          [row.income.total, "income_total"],
          [row.investment.realizedGains, "realized_gains"],
          [row.investment.dividends, "dividends"],
          [row.investment.coupons, "coupons"],
          [row.tax.totalFederalCents, "total_federal_tax"],
          [row.withdrawals.total, "wd_total"],
          [row.conversions, "conversions"],
          [row.ending.total, "end_total"],
          [row.ending.totalReal, "end_total_real"],
          // The sheet's growth is the unrounded growth rounded; the table's is the cents plug of
          // the roll-forward, so the two can differ by the rounding of the parts.
          [row.growth, "growth"],
        ];
        for (const [value, column] of cells) {
          const diff = BigInt(value) - cellCents(e[column]!);
          expect(diff >= -2n && diff <= 2n, `${at} ${column}: ${value} against ${e[column]}`).toBe(true);
        }
        expect(row.cpiStart, at).toBe(Number(e.cpi_start).toFixed(9));
      });
    }
  });

  it("OUT-9 R1 and R2 summary figures (r1.md §5, r2.md §5)", () => {
    // R1: funded, 1,114,680.94 in today's dollars, lifetime spending 2,471,000.00, lifetime tax 153,853.22.
    const s1 = toSimSummary(r1.result, r1.run.input);
    expect(s1.successPaths).toBe(1);
    expect(s1.endingWealthReal.p50).toBe("111468094");
    expect(s1.endingWealthNominal.p50).toBe("187219787");
    expect(s1.lifetimeSpendingRealP50).toBe("247100000");
    expect(s1.lifetimeTaxesRealP50).toBe("15385322");
    expect(s1.shortfallRealP50OfFailures).toBeUndefined();
    // R2: fails in 2056 with a shortfall of 28,960.03 in today's dollars; ends with 0; spending 2,619,679.97; tax 105,568.56.
    const s2 = toSimSummary(r2.result, r2.run.input);
    expect(s2.successPaths).toBe(0);
    expect(s2.failure.firstDepletionYear).toBe(2056);
    expect(s2.failure.medianDepletionYear).toBe(2056);
    expect(s2.shortfallRealP50OfFailures).toBe("2896003");
    expect(s2.endingWealthReal.p50).toBe("0");
    expect(s2.lifetimeSpendingRealP50).toBe("261967997");
    expect(s2.lifetimeTaxesRealP50).toBe("10556856");
    expect(r2.result.depletionYear[0]).toBe(2056);
    expect(r2.table.rows.at(-1)!.failed).toBe(true);
    // The fixed model with every life expectancy fixed: one path, no interval.
    expect(s1.successCi95Bp).toBeUndefined();
    expect(s1.model.kind).toBe("fixed");
    expect(s1.firstYearFractionPpm).toBe(1_000_000);
  });

  it("OUT-10 the outputs parse with their schemas; no number in them is a non-integer; bands are non-decreasing", () => {
    for (const { run, result, table } of [r1, r2]) {
      const summary = toSimSummary(result, run.input);
      const fan = toFanSeries(result);
      expect(SimSummary.parse(summary)).toEqual(summary);
      expect(FanSeries.parse(fan)).toEqual(fan);
      expect(YearTable.parse(table)).toEqual(table);
      for (const doc of [summary, fan, table]) assertIntegersOnly(doc);
      assertBandsOrdered(fan);
    }
  });

  it("OUT-11 R1's story: funded; cash ran dry in 2027 and the taxable account in 2031; never below plan", () => {
    const story = pathStory(r1.table);
    expect(story.outcome).toBe("funded");
    expect(story.failureYear).toBeUndefined();
    expect(story.depletion).toEqual([
      { bucket: "cash", year: 2027 },
      { bucket: "taxable", year: 2031 },
    ]);
    expect(story.belowPlanYears).toBe(0);
    expect(story.endingRealCents).toBe("111468094");
    // Every year returns 5% at 2.5% inflation: 1.05 ÷ 1.025 − 1 = 2.439% → 243 bp (truncated).
    expect(story.first10.realReturnBp).toBe(243);
    // R2 fails in its last year: the story says when and at what age (person 2, 95).
    const s2 = pathStory(r2.table);
    expect(s2.outcome).toBe("failed");
    expect(s2.failureYear).toBe(2056);
    expect(s2.failureAges).toEqual([95]);
  });

  it("the year table of R1: accounts from the input, the death years, f, the price levels and phases", () => {
    const t = r1.table;
    expect(t.accounts.map((a) => [a.id, a.bucket, a.owner])).toEqual([
      ["cash", "cash", "joint"],
      ["taxable", "taxable", "joint"],
      ["pre_tax_a", "pre_tax", "p1"],
      ["pre_tax_b", "pre_tax", "p2"],
      ["roth_a", "roth", "p1"],
    ]);
    expect(t.deathYears).toEqual([2047, 2047]);
    expect(t.startingTotal).toBe("179000000");
    expect(t.historicalStartYear).toBeUndefined();
    expect(t.rows.every((r) => r.phase === "retirement" && r.yearFractionPpm === 1_000_000 && r.inflationBp === 250 && r.filingStatus === "married_joint")).toBe(true);
    // 2029: price level 1.025² = 1.050625 at the start and 1.025³ = 1.076890625 at the end.
    expect([t.rows[2]!.cpiStart, t.rows[2]!.cpiEnd]).toEqual(["1.050625000", "1.076890625"]);
    // 2029 benefits (r1.md §3): 3,151 and 1,891 a month, 37,812.00 and 22,692.00 for the year.
    expect(t.rows[2]!.income.socialSecurity).toEqual(["3781200", "2269200"]);
    expect(t.rows[2]!.income.socialSecurityParts).toEqual([
      { spousal: "0", survivor: "0", withheld: "0" },
      { spousal: "0", survivor: "0", withheld: "0" },
    ]);
    // 2027's conversion of 80,000 and 2028's of 110,000 are not withdrawals.
    expect([t.rows[0]!.conversions, t.rows[1]!.conversions]).toEqual(["8000000", "11000000"]);
  });
});

describe("events, gross years and the shortfall allotment (strategies-outputs-web §3.11 items 3 and 4)", () => {
  // The cases of WD-12 and WD-13 (withdrawals.real.test.ts) through the year table.
  const ira = (cents: string, owner: "p1" | "p2" = "p1") => account(`ira_${owner}`, "pre_tax", cents, { type: "ira", owner, allocation: W(5000, 0, 5000, 0) });
  const fixed = (age: number) => ({ mode: "fixed", age }) as const;
  const tableOf = (input: SimInput, ss: number[]) => {
    const run = prepare(input);
    const ps = createPathState(run, createEngineHooks(), { ...TAX_FUNCTIONS, socialSecurityYear: fixedSocialSecurity(ss) });
    return toYearTable(simulatePathDetail(run, 0, ps), run).rows[0]!;
  };

  it("rmd_excess (WD-12): 3% of 1,300,000 = 39,000 is below the RMD of 48,780.49; nothing else withdrawn; 9,780.49 saved", () => {
    const row = tableOf(
      buildSimInput({
        startYear: 2027,
        people: [
          { birthYear: 1952, longevity: fixed(75) },
          { birthYear: 1952, longevity: fixed(75) },
        ],
        accounts: [ira("120000000"), account("brk", "taxable", "10000000", { type: "brokerage", basisCents: "10000000", allocation: W(5000, 0, 5000, 0) })],
        spending: { baseAnnualCents: "10000000", essentialAnnualCents: "0" },
        strategy: { kind: "fixed_percentage", rateBp: 300 },
        tax: ZERO_YIELDS,
      }),
      [25000, 25000],
    );
    expect(row.strategy.events).toEqual(["rmd_excess"]);
    expect(row.spending.ruleGross).toBe("3900000");
    expect(row.withdrawals.total).toBe("4878049");
    expect(row.withdrawals.rmdTotal).toBe("4878049");
    expect(row.surplusSaved).toBe("978049");
    // (48,780.49 − 9,780.49) ÷ 1,300,000 = 3.00% → 300 bp.
    expect(row.strategy.withdrawalRateBp).toBe(300);
    // Funded 85,732.73 (WD-12), all core: no healthcare, care or goals.
    expect(row.spending.funded).toBe("8573273");
    expect(row.spending.core).toBe("8573273");
  });

  it("topped_up (WD-13): a floor of 65,000 takes 45,713.64 where the 4% rule released 40,000; a floor of 50,000 does not", () => {
    for (const [floor, topped, withdrawal] of [
      ["5000000", false, "4000000"],
      ["6500000", true, "4571364"],
    ] as const) {
      const row = tableOf(
        buildSimInput({
          startYear: 2027,
          people: [{ birthYear: 1960, longevity: fixed(67) }],
          accounts: [account("ira_p1", "pre_tax", "100000000", { type: "ira", allocation: W(10000, 0, 0, 0) })],
          spending: { baseAnnualCents: "8000000", essentialAnnualCents: floor },
          strategy: { kind: "fixed_percentage", rateBp: 400 },
          tax: ZERO_YIELDS,
        }),
        [24000],
      );
      expect(row.strategy.events).toEqual(topped ? ["topped_up"] : []);
      expect(row.spending.ruleGross).toBe("4000000");
      const diff = BigInt(row.withdrawals.total) - BigInt(withdrawal);
      expect(diff >= -2n && diff <= 2n, row.withdrawals.total).toBe(true);
      expect(row.spending.floor).toBe(floor);
      expect(row.phase).toBe("retirement");
    }
  });

  it("a shortfall year allots the funded amount to healthcare, long-term care, goals, then core (R2 2056)", () => {
    // r2.md 2056: need = core + healthcare + care; the shortfall leaves core what remains.
    const rows = expectedRows("r2.expected.csv");
    const last = rows.at(-1)!;
    const row = mapped(referenceR2Input()).table.rows.at(-1)!;
    expect(BigInt(row.spending.shortfall) > 0n).toBe(true);
    expect(row.spending.healthcare).toBe(String(cellCents(last.healthcare!)));
    expect(row.spending.longTermCare).toBe(String(cellCents(last.long_term_care!)));
    expect(BigInt(row.spending.core)).toBe(BigInt(row.spending.funded) - BigInt(row.spending.healthcare) - BigInt(row.spending.longTermCare) - BigInt(row.spending.goals));
    expect(row.failed).toBe(true);
  });
});

describe("the inputs fixture: accumulation, transition and retirement rows (C15, C52)", () => {
  // Alex retires June 2035 (drawdown from 2035), Sam September 2039; plan from October 2026 (f = 3/12).
  const input: SimInput = { ...fixtureSimInput(), settings: { ...fixtureSimInput().settings, paths: 200 } };
  const run = prepare(input);
  const table = toYearTable(simulatePathDetail(run, 0), run);
  const row = (year: number) => table.rows.find((r) => r.year === year)!;

  it("phases by year: accumulation to 2034, transition 2035 to 2038, retirement from 2039", () => {
    expect(row(2026).phase).toBe("accumulation");
    expect(row(2034).phase).toBe("accumulation");
    expect(row(2035).phase).toBe("transition");
    expect(row(2038).phase).toBe("transition");
    expect(row(2039).phase).toBe("retirement");
    expect(row(2026).yearFractionPpm).toBe(250_000);
    expect(row(2027).yearFractionPpm).toBe(1_000_000);
  });

  it("an accumulation row: wages and contributions, no planned spending; the 2031 roof is the year's only spending (C52)", () => {
    const r = row(2031);
    expect(BigInt(r.income.wages) > 0n).toBe(true);
    expect(BigInt(r.contributions.employee) > 0n).toBe(true);
    expect(BigInt(r.contributions.employer) > 0n).toBe(true);
    expect(r.spending.planned).toBe("0");
    expect(r.spending.core).toBe("0");
    expect(r.spending.healthcare).toBe("0");
    expect(r.spending.floor).toBe("0");
    expect(BigInt(r.spending.goals) > 0n).toBe(true);
    expect(r.spending.funded).toBe(r.spending.goals);
    expect(r.strategy.essentialCoverageBp).toBeUndefined();
    expect(row(2030).spending.funded).toBe("0");
    expect(BigInt(row(2030).tax.payrollTaxCents) > 0n).toBe(true);
  });

  it("OUT-8 and OUT-10 on the fixture: the rows add up in both units (contributions included) and the documents parse", () => {
    assertAddsUp(table);
    const real = deflateYearTable(table);
    assertAddsUp({ ...real, startingTotal: table.startingTotal });
    expect(YearTable.parse(table)).toEqual(table);
    assertIntegersOnly(table);
    // Sam's pension from September 2039: four months of 1,000.
    expect(row(2039).income.pensionAnnuity).toBe("400000");
    expect(row(2036).conversions).not.toBe("0");
  });
});

describe("OUT-12 and T43: the stored table is the re-simulated path, and the detail is the fast path", () => {
  it("OUT-12 a 200-path run: the 50th-percentile table deep-equals toYearTable(simulatePathDetail(…)) from a fresh state and from a reused one", () => {
    // Table mortality (paths end in different years) on the production hooks and tax functions.
    const input = buildSimInput({
      people: [
        { birthYear: 1960, longevity: { mode: "mortality", sex: "female", adjustYears: 0, maxAge: 105 } },
        { birthYear: 1962, longevity: { mode: "mortality", sex: "male", adjustYears: 0, maxAge: 105 } },
      ],
      accounts: [
        account("brk", "taxable", "60000000", { type: "brokerage", basisCents: "40000000", allocation: W(6000, 0, 4000, 0) }),
        account("ira", "pre_tax", "90000000", { type: "ira", allocation: W(6000, 0, 4000, 0) }),
      ],
      spending: { baseAnnualCents: "6000000" },
      returnModel: { kind: "bootstrap", meanBlockYears: 10 },
      paths: 200,
    });
    const run = prepare(input);
    const summary = simulateRun(run);
    const result = aggregate(run, summary);
    const k = result.percentilePathIndex[50]!;
    const fresh = toYearTable(simulatePathDetail(run, k), run);
    const ps = createPathState(run, createEngineHooks());
    for (const other of [0, 199, 17, k + 1 < 200 ? k + 1 : 0]) simulatePathDetail(run, other, ps);
    const reused = toYearTable(simulatePathDetail(run, k, ps), run);
    expect(reused).toEqual(fresh);
    expect(fresh.pathIndex).toBe(k);
    // It ends at the stored percentile and depletion year (the job's reproducibility check).
    expect(fresh.rows.at(-1)!.ending.totalReal).toBe(result.endingWealthReal.p50.toString());
    const failed = fresh.rows.find((r) => r.failed);
    expect(failed === undefined ? -1 : failed.year).toBe(result.depletionYear[k]);
    expect(fresh.rows.length).toBe(summary.endIdx[k]! + 1);
    // With table mortality the bands stop where fewer than 100 paths are alive, and the run says so.
    const fan = toFanSeries(result);
    expect(FanSeries.parse(fan)).toEqual(fan);
    expect(fan.truncated).toBe(true);
    expect(fan.aliveCount.at(-1)! >= 100).toBe(true);
    expect(result.aliveCount[fan.years.length]! < 100).toBe(true);
    expect(result.warnings.some((w) => w.code === "few_alive_paths")).toBe(true);
    assertBandsOrdered(fan);
    assertIntegersOnly(fan);
  });

  /** The first T41 run: T20's household, bootstrap with mean block 10, 2,000 paths, seed 20261110, no tax. */
  const t41 = (returnModel: SimInputOptions["returnModel"], paths: number, longevity: SimInputOptions["people"] = [{ birthYear: 1962, longevity: { mode: "fixed", age: 94 } }]) => {
    const run = prepare(
      buildSimInput({
        people: longevity,
        accounts: [account("roth", "roth", "100000000", { allocation: W(6000, 0, 4000, 0) })],
        spending: { baseAnnualCents: "4000000" },
        ...(returnModel === undefined ? {} : { returnModel }),
        paths,
        seed: 20261110,
        tax: ZERO_YIELDS,
      }),
    );
    const ps = createPathState(run, stubHooks(), stubTaxFunctions(NO_TAX));
    const summary = simulateRun(run, ps);
    return { run, ps, summary, result: aggregate(run, summary) };
  };

  /** 200 path indices from a fixed linear congruential sequence (test only). */
  const seeded = (n: number, count = 200) => {
    const out: number[] = [];
    let x = 20_261_114;
    for (let i = 0; i < count; i++) {
      x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0;
      out.push(x % n);
    }
    return out;
  };

  it("T43 200 seeded paths of the first T41 run: the detail's last row is dollarsToCents(endReal[k]) and it has endIdx[k] + 1 rows; every percentile path ends at its quantile", () => {
    const { run, ps, summary, result } = t41({ kind: "bootstrap", meanBlockYears: 10 }, 2000);
    // T41's first run (engine-and-returns §7: "Seed 20261110 throughout"; src/node/golden.test.ts).
    expect(run.input.settings.seed).toBe(20261110);
    expect(run.paths).toBe(2000);
    for (const k of seeded(2000)) {
      const table = toYearTable(simulatePathDetail(run, k, ps), run);
      expect(table.rows.at(-1)!.ending.totalReal, `path ${k}`).toBe(dollarsToCentsBigInt(summary.endReal[k]!).toString());
      expect(table.rows.length).toBe(summary.endIdx[k]! + 1);
    }
    for (let p = 0; p <= 100; p++) {
      const table = toYearTable(simulatePathDetail(run, result.percentilePathIndex[p]!, ps), run);
      expect(table.rows.at(-1)!.ending.totalReal, `percentile ${p}`).toBe(result.endingWealthRealQuantiles[p]!.toString());
    }
  });

  it("T43 with the historical model, cohortStartYear = 1928 + (k mod C); with table mortality the row count follows each path's last death", () => {
    // Table mortality makes `auto` wrap: C = 98 cohorts (1928 to 2025), each replicated.
    const { run, ps, summary } = t41({ kind: "historical", cohorts: "auto" }, 300, [{ birthYear: 1962, longevity: { mode: "mortality", sex: "female", adjustYears: 0, maxAge: 100 } }]);
    const C = run.model.cohorts!.cohortCount;
    expect(C).toBe(98);
    const counts = new Set<number>();
    for (const k of seeded(run.paths)) {
      const detail = simulatePathDetail(run, k, ps);
      expect(detail.cohortStartYear).toBe(1928 + (k % C));
      const table = toYearTable(detail, run);
      expect(table.historicalStartYear).toBe(1928 + (k % C));
      expect(table.rows.length).toBe(summary.endIdx[k]! + 1);
      expect(table.rows.at(-1)!.ending.totalReal).toBe(dollarsToCentsBigInt(summary.endReal[k]!).toString());
      counts.add(table.rows.length);
    }
    expect(counts.size).toBeGreaterThan(5);
  });
});

describe("the fixture's run: summary and fan of a bootstrap run with a partial first year", () => {
  const input: SimInput = { ...fixtureSimInput(), settings: { ...fixtureSimInput().settings, paths: 200 } };
  const run = prepare(input);
  const result = aggregate(run, simulateRun(run));

  it("the spending bands start at the first drawdown year (2035, index 9); f = 3/12 is 250000 ppm; Wilson is present", () => {
    const fan = toFanSeries(result);
    expect(FanSeries.parse(fan)).toEqual(fan);
    expect(fan.years[0]).toBe(2026);
    expect(fan.spendingFromIndex).toBe(9);
    expect(fan.spendingReal.p50.length).toBe(fan.years.length - 9);
    expect(fan.truncated).toBe(false);
    expect(fan.ages).toEqual([fan.years.map((y) => y - 1975), fan.years.map((y) => y - 1977)]);
    assertBandsOrdered(fan);
    const summary = toSimSummary(result, input);
    expect(SimSummary.parse(summary)).toEqual(summary);
    expect(summary.firstYearFractionPpm).toBe(250_000);
    expect(summary.model).toEqual({ kind: "bootstrap", requestedPaths: 200, meanBlockYears: 10 });
    expect(summary.strategy).toBe("constant_dollar");
    const [lo, hi] = result.successCi95!;
    expect(summary.successCi95Bp).toEqual([Math.floor(lo * 10000 + 0.5 + 1e-7), Math.floor(hi * 10000 + 0.5 + 1e-7)]);
    assertIntegersOnly(summary);
  });
});

describe("run warnings of the aggregate (C41, C39, engine-and-returns §2.6)", () => {
  it("conversion_after_death counts the conversions skipped and the paths they were on", () => {
    // p1 (born 1960, fixed age 70) dies at the end of 2030; conversions scheduled for him in 2031 and 2032 are skipped.
    const input = buildSimInput({
      people: [
        { birthYear: 1960, longevity: { mode: "fixed", age: 70 } },
        { birthYear: 1962, longevity: { mode: "fixed", age: 75 } },
      ],
      accounts: [account("ira", "pre_tax", "50000000", { type: "ira" }), account("roth", "roth", "1000000", { type: "roth" })],
      rothConversions: [
        { year: 2028, personId: "p1", amountCents: "1000000", dollars: "nominal" },
        { year: 2031, personId: "p1", amountCents: "1000000", dollars: "nominal" },
        { year: 2032, personId: "p1", amountCents: "1000000", dollars: "nominal" },
      ],
      tax: ZERO_YIELDS,
    });
    const { result } = mapped(input);
    const w = result.warnings.find((x) => x.code === "conversion_after_death");
    expect(w?.message).toBe("2 scheduled Roth conversions were skipped on 1 of 1 path because the person had died.");
  });

  it("grossup_not_converged counts the path-years whose hook stopped with a surplus; the engine's warnings come before the tax area's", () => {
    // A withdrawal hook that takes everything available leaves net above the tolerance every drawdown year.
    const input = buildSimInput({
      people: [{ birthYear: 1962, longevity: { mode: "fixed", age: 68 } }],
      accounts: [account("brk", "taxable", "100000000", { type: "brokerage", basisCents: "100000000", allocation: W(0, 0, 0, 10000) })],
      spending: { baseAnnualCents: "4000000" },
      tax: ZERO_YIELDS,
    });
    const run = prepare(input);
    const ps = createPathState(run, {
      decideSpending: createEngineHooks().decideSpending,
      planWithdrawals: (view, _decision, _assess, w) => {
        for (let a = 0; a < view.accountCount; a++) w[a] = view.available[a]!;
      },
    });
    const result = aggregate(run, simulateRun(run, ps));
    const w = result.warnings.find((x) => x.code === "grossup_not_converged");
    // Plan years 2027 to 2030 (fixed age 68): four years, each withdrawing the whole account.
    expect(w?.message).toBe("In 4 simulated years on 1 of 1 path the withdrawal gross-up stopped before it converged; it kept a withdrawal that paid the year's spending and tax, and saved the extra cash.");
    const codes = result.warnings.map((x) => x.code);
    expect(codes.indexOf("grossup_not_converged")).toBeGreaterThan(codes.indexOf("path_count_adjusted"));
    expect(codes.indexOf("grossup_not_converged")).toBeLessThan(codes.indexOf("limits_pending"));
  });
});

describe("guards", () => {
  it("toYearTable refuses a detail of another run", () => {
    const a = prepare(referenceR1Input());
    const b = prepare(referenceR2Input());
    expect(() => toYearTable(simulatePathDetail(a, 0), b)).toThrow(RangeError);
    expect(() => simulatePathDetail(a, 1)).toThrow(RangeError);
  });

  it("a row is the shape YearRow declares for every phase", () => {
    const row: YearRow = mapped(referenceR1Input()).table.rows[0]!;
    expect(Object.keys(row).sort()).toEqual(
      ["year", "yearFractionPpm", "ages", "alive", "phase", "filingStatus", "cpiStart", "cpiEnd", "inflationBp", "portfolioReturnBp", "income", "contributions", "spending", "strategy", "withdrawals", "conversions", "investment", "tax", "surplusSaved", "growth", "ending", "failed"].sort(),
    );
  });
});
