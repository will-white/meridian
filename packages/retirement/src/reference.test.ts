import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SimInput, type YearTable, addUp, deflateYearTable, selectPercentilePath } from "@meridian/shared";
import { describe, expect, it } from "vitest";
import { SHEET_COLUMNS } from "../reference/independent/columns.js";
import { simulatePath, simulatePreparedPath } from "./facade.js";
import { YR, YR_REC } from "./loop.js";
import { customParams } from "./models/parametric.js";
import { runSimulation } from "./node/index.js";
import { prepare } from "./prepare.js";
import { CSV_ASSETS, type EngineCsvRow, engineCsvRows } from "./referenceKit.js";
import { simulatePathDetail } from "./simulate.js";
import { toYearTable } from "./results/yearTable.js";
import {
  R3_STOCK_BP,
  R4_RETURN_MODEL,
  referenceR1Input,
  referenceR2Input,
  referenceR3Input,
  referenceR4Input,
} from "./testing/referenceScenarios.js";
import { dollarsToCentsBigInt } from "./units.js";

// Build step 22b (seams §11 step 22, second half; strategies-outputs-web §7.6 to §7.9; seams §8
// D14 to D18): the engine on the reference fixtures `reference/fixtures/r1.input.json` to
// `r4.input.json`, against the independent calculator's expected files.
//
// The engine runs through its public facade: `runSimulation` (inline, `threads: 0`, and once on two
// threads) for the run and `simulatePath` for a path's year table. R1 and R2 also read the path's
// `PathDetail` (`simulatePathDetail`, the same path: the facade's table is built from it), because
// the expected CSVs carry columns the stored year table does not (provisional income, qualified
// dividends, the carried interest, the basis by asset) and because the sheets round every cell
// once, a total included, while the year table makes parts add up to their total.
//
// The three-way agreement of R1 and R2 (r1.md and r2.md, "Status"): the figures of the sheets
// (the step-5 scratch reference), the independent calculator (reference/reference-sheets.test.ts:
// every table cell within 0.01; measured 0.00) and the engine (here: every cell of the expected
// CSVs within 0.01). Measured: every one of R1's 1,596 money cells and R2's 2,400 agrees to the cent
// (largest difference 0.00), the three half-cent cells of R1 2030 included, and every price level,
// basis-point, age and filing cell is equal. The stored year table differs from the once-rounded
// cells only where strategies-outputs-web §3.11 says it does (addUp, the growth plug); its largest
// difference from the CSVs is 0.02 (R2 2040, pre_tax_1's ending balance, which takes the rounding
// of the seven accounts' cents), inside the design's gate tolerance of 1.00 (§7.7 (3)).
//
// R3 (r3.md §5 item 1): the same 69 start years, funded counts, failing start years and failure
// indexes; every lifetime shortfall and every ending wealth within 1.00. Measured: every ending
// wealth equal to the cent, nominal and real; the shortfalls within 0.01 (the year table's rows are
// deflated cell by cell). R4 (r4.md §4): success 70.40% against 69.94% (0.46 points, tolerance 1.5)
// and a median ending wealth of 337,269.91 against 337,269.43 (0.0001%, tolerance 8%); the near
// equality of the medians is chance (seeds 2 to 8 give medians from 325,198 to 349,411).

const FIXTURES = new URL("../reference/fixtures/", import.meta.url);
const SHEETS = new URL("../reference/sheets/", import.meta.url);
const fixtureText = (name: string) => readFileSync(new URL(name, FIXTURES), "utf8");
const fixtureJson = (name: string): unknown => JSON.parse(fixtureText(name));
const loadInput = (name: string): SimInput => SimInput.parse(fixtureJson(name));

const CENT = 1n;
const absBig = (x: bigint) => (x < 0n ? -x : x);
/** A CSV money cell ("-1234.56") as cents, exactly. */
function csvCents(cell: string): bigint {
  expect(cell, "a CSV money cell").toMatch(/^-?\d+\.\d{2}$/);
  const negative = cell.startsWith("-");
  const [whole, frac] = cell.replace("-", "").split(".") as [string, string];
  const c = BigInt(whole) * 100n + BigInt(frac);
  return negative ? -c : c;
}
/** A sheet money cell ("12,000.00") as cents, exactly. */
const sheetCents = (cell: string) => {
  expect(cell, "a sheet money cell").toMatch(/^-?\d{1,3}(,\d{3})*\.\d{2}$/);
  return csvCents(cell.replace(/,/g, ""));
};
/** Dollars from the JSON fixtures (rounded to the cent there) as cents. */
const jsonCents = (dollars: number) => dollarsToCentsBigInt(dollars);

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.trimEnd().split("\n");
  const head = lines[0]!.split(",");
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    expect(values.length).toBe(head.length);
    return Object.fromEntries(values.map((v, i) => [head[i]!, v]));
  });
}

/** The machine-read table after `<!-- table: id -->` in a sheet. */
function sheetTable(sheet: string, id: string): { header: string[]; rows: string[][] } {
  const lines = readFileSync(new URL(`${sheet}.md`, SHEETS), "utf8").split("\n");
  const at = lines.indexOf(`<!-- table: ${id} -->`);
  expect(at, `table ${id}`).toBeGreaterThanOrEqual(0);
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  const header = cells(lines[at + 1]!);
  const rows: string[][] = [];
  for (const line of lines.slice(at + 3)) {
    if (!line.startsWith("|")) break;
    rows.push(cells(line));
  }
  return { header, rows };
}

// --------------------------------------------------------------------------------------------
// D14: the input fixtures

describe("D14 the input fixtures r1.input.json to r4.input.json", () => {
  const builders: ReadonlyArray<readonly [string, () => SimInput]> = [
    ["r1", referenceR1Input],
    ["r2", referenceR2Input],
    ["r3", () => referenceR3Input(5000)],
    ["r4", referenceR4Input],
  ];

  it.each(builders)("D14 %s.input.json is a complete SimInput (parsing adds nothing) and equals its reference builder", (id, build) => {
    const raw = fixtureJson(`${id}.input.json`);
    expect(SimInput.parse(raw)).toEqual(raw);
    expect(raw).toEqual(build());
    // Written as `${JSON.stringify(build(), null, 2)}\n`; the scenario name says which sheet.
    expect(fixtureText(`${id}.input.json`)).toBe(`${JSON.stringify(build(), null, 2)}\n`);
    expect(SimInput.parse(raw).meta.scenarioName).toBe(id.toUpperCase());
  });

  it("D14 R1 and R2 use the fixed model, R3 the historical model with complete cohorts, R4 the custom parametric parameters", () => {
    const [r1, r2, r3, r4] = ["r1", "r2", "r3", "r4"].map((id) => loadInput(`${id}.input.json`)) as [SimInput, SimInput, SimInput, SimInput];
    expect(r1.settings.returnModel).toEqual({ kind: "fixed", series: [{ stocksPpm: 50000, bondsPpm: 50000, billsPpm: 50000, inflationPpm: 25000 }] });
    expect(r2.settings.returnModel).toEqual({ kind: "fixed", series: [{ stocksPpm: 60000, bondsPpm: 40000, billsPpm: 20000, inflationPpm: 25000 }] });
    expect(r3.settings.returnModel).toEqual({ kind: "historical", cohorts: "complete" });
    expect(r4.settings.returnModel).toEqual(R4_RETURN_MODEL);
    expect([r4.settings.paths, r4.settings.seed]).toEqual([10000, 1]);
  });

  it("D14 the fixtures carry the sheets' §1 inputs (plan, people, accounts, Social Security, spending, conversions)", () => {
    const r1 = loadInput("r1.input.json");
    const r2 = loadInput("r2.input.json");
    const r3 = loadInput("r3.input.json");
    const r4 = loadInput("r4.input.json");
    // Plans: January starts (firstYearMonths 12), 2027 to 2047, 2056, 2056, 2056.
    expect([r1, r2, r3, r4].map((x) => [x.plan.startMonth, x.plan.firstYearMonths, x.plan.endYear])).toEqual([
      ["2027-01", 12, 2047],
      ["2027-01", 12, 2056],
      ["2027-01", 12, 2056],
      ["2027-01", 12, 2056],
    ]);
    const people = (x: SimInput) => x.household.people.map((p) => [p.id, p.birthYear, p.birthMonth, p.retirementMonth, p.longevity]);
    expect(people(r1)).toEqual([
      ["p1", 1962, 1, "2027-01", { mode: "fixed", age: 85 }],
      ["p2", 1962, 1, "2027-01", { mode: "fixed", age: 85 }],
    ]);
    expect(people(r2)).toEqual([
      ["p1", 1958, 1, "2027-01", { mode: "fixed", age: 76 }],
      ["p2", 1961, 1, "2027-01", { mode: "fixed", age: 95 }],
    ]);
    expect(people(r3)).toEqual([["p1", 1962, 1, "2027-01", { mode: "fixed", age: 94 }]]);
    expect(people(r4)).toEqual(people(r3));
    expect([r1, r2, r3, r4].map((x) => [x.household.filingStatus, x.household.state])).toEqual([
      ["married_joint", "CO"],
      ["married_joint", "CO"],
      ["single", "CO"],
      ["single", "CO"],
    ]);
    // Accounts, as the §1 tables of r1.md and r2.md print them (balance and basis in cents; the
    // allocation as us_stock / bonds / cash in bp).
    const accounts = (x: SimInput) =>
      x.accounts.map((a) => [
        a.id,
        a.bucket,
        a.type,
        a.owner,
        a.balanceCents,
        a.basisCents ?? a.rothContributionBasisCents ?? null,
        [a.allocation.us_stock, a.allocation.bonds, a.allocation.cash],
        a.expenseRatioPpm,
        a.synthetic,
      ]);
    expect(accounts(r1)).toEqual([
      ["cash", "cash", "checking", "joint", "4000000", null, [0, 0, 10000], 0, false],
      ["taxable", "taxable", "brokerage", "joint", "40000000", "25000000", [10000, 0, 0], 0, false],
      ["pre_tax_a", "pre_tax", "ira", "p1", "90000000", null, [10000, 0, 0], 0, false],
      ["pre_tax_b", "pre_tax", "ira", "p2", "30000000", null, [10000, 0, 0], 0, false],
      ["roth_a", "roth", "roth", "p1", "15000000", "0", [10000, 0, 0], 0, false],
    ]);
    expect(accounts(r2)).toEqual([
      ["cash", "cash", "checking", "joint", "4000000", null, [0, 0, 10000], 0, false],
      ["taxable", "taxable", "brokerage", "joint", "50000000", "34000000", [6000, 4000, 0], 0, false],
      ["pre_tax_1", "pre_tax", "ira", "p1", "40000000", null, [6000, 4000, 0], 0, false],
      ["pre_tax_2", "pre_tax", "ira", "p2", "15000000", null, [6000, 4000, 0], 0, false],
      ["roth_1", "roth", "roth", "p1", "6000000", "0", [10000, 0, 0], 0, false],
      ["roth_2", "roth", "roth", "p2", "4000000", "0", [10000, 0, 0], 0, false],
      ["hsa_2", "hsa", "hsa", "p2", "2000000", null, [6000, 4000, 0], 0, false],
    ]);
    // R3: one Roth account of 1,000,000 at 50% stocks and 50% bonds (the 75% run changes only the
    // allocation); R4: the same account wholly in stocks. Each gets the resolver's synthetic cash.
    expect(accounts(r3)).toEqual([
      ["roth", "roth", "roth", "p1", "100000000", "0", [5000, 5000, 0], 0, false],
      ["synthetic:cash", "cash", undefined, "joint", "0", null, [0, 0, 10000], 0, true],
    ]);
    expect(accounts(r4)[0]).toEqual(["roth", "roth", "roth", "p1", "100000000", "0", [10000, 0, 0], 0, false]);
    expect(referenceR3Input(7500).accounts[0]!.allocation).toMatchObject({ us_stock: 7500, bonds: 2500 });
    // Income, Social Security, spending, conversions, the order and the tax settings.
    expect(r1.incomes.map((s) => [s.kind, s.personId, s.annualCents, s.dollars, s.startMonth, s.cola, s.taxableBp])).toEqual([
      ["pension", "p2", "1200000", "nominal", "2027-01", { mode: "none" }, 10000],
    ]);
    expect([r2.incomes, r3.incomes, r4.incomes]).toEqual([[], [], []]);
    expect(r1.socialSecurity.people).toEqual([
      { personId: "p1", mode: "estimate", monthlyAtFraCents: "300000", asOfYear: 2027, claimMonth: "2029-01", claimAgeMonths: 804 },
      { personId: "p2", mode: "estimate", monthlyAtFraCents: "180000", asOfYear: 2027, claimMonth: "2029-01", claimAgeMonths: 804 },
    ]);
    expect(r2.socialSecurity.people).toEqual([
      { personId: "p1", mode: "receiving", monthlyCents: "250000", asOfYear: 2027, startedMonth: "2024-09", monthlyAtFraCents: "250000" },
      { personId: "p2", mode: "estimate", monthlyAtFraCents: "150000", asOfYear: 2027, claimMonth: "2028-01", claimAgeMonths: 804 },
    ]);
    expect(r3.socialSecurity.people).toEqual([{ personId: "p1", mode: "none" }]);
    const spending = (x: SimInput) => [x.spending.baseAnnualCents, x.spending.survivorBp, x.spending.phases, x.spending.goals.map((g) => [g.year, g.amountCents, g.dollars])];
    expect(spending(r1)).toEqual([
      "13000000",
      10000,
      [
        { fromYear: 2037, multiplierBp: 9000 },
        { fromYear: 2042, multiplierBp: 7000 },
      ],
      [[2030, "4000000", "today"]],
    ]);
    expect(spending(r2)).toEqual(["9960000", 7000, [], [[2030, "3000000", "today"]]]);
    expect(r2.spending.healthcare.map((h) => [h.personId, h.preMedicareAnnualCents, h.medicareAnnualCents, h.inBase])).toEqual([
      ["p1", "600000", "600000", false],
      ["p2", "600000", "600000", false],
    ]);
    expect(r2.spending.longTermCare).toEqual([{ personId: "p2", reserveCents: "6000000", lastYears: 2 }]);
    expect(spending(r3)).toEqual(["4000000", 10000, [], []]);
    expect(spending(r4)).toEqual(spending(r3));
    expect(r1.rothConversions.map((c) => [c.year, c.personId, c.amountCents, c.dollars])).toEqual([
      [2027, "p1", "8000000", "nominal"],
      [2028, "p1", "11000000", "nominal"],
    ]);
    expect(r2.rothConversions.map((c) => [c.year, c.personId, c.amountCents, c.dollars])).toEqual([
      [2028, "p1", "2000000", "today"],
      [2029, "p1", "2000000", "today"],
    ]);
    expect([r1, r2, r3, r4].map((x) => [x.settings.strategy.kind, x.settings.withdrawalOrder, x.settings.taxRuleSet, x.settings.portfolio])).toEqual([
      ["constant_dollar", { kind: "default", cashReserveCents: "0" }, "current_law", { taxableRebalance: "full" }],
      ["constant_dollar", { kind: "default", cashReserveCents: "2000000" }, "current_law", { taxableRebalance: "full" }],
      ["constant_dollar", { kind: "default", cashReserveCents: "0" }, "current_law", { taxableRebalance: "full" }],
      ["constant_dollar", { kind: "default", cashReserveCents: "0" }, "current_law", { taxableRebalance: "full" }],
    ]);
    expect(r1.settings.tax).toMatchObject({ chainedCpiWedgeBp: 0, realWageGrowthBp: 0, includePayrollTax: true, capLossCarryInCents: "0", taxDrag: { us_stock: { dividendYieldBp: 0 } } });
    expect(r2.settings.tax).toMatchObject({ chainedCpiWedgeBp: 0, includePayrollTax: true, taxDrag: { us_stock: { dividendYieldBp: 150, qualifiedShareBp: 10000 } } });
  });
});

// --------------------------------------------------------------------------------------------
// R1 and R2: every cell of the expected CSVs (D15), the stored year table, the summary

interface Deterministic {
  readonly id: "r1" | "r2";
  readonly input: SimInput;
  readonly table: YearTable;
  readonly rows: EngineCsvRow[];
  readonly assessCalls: number[];
  readonly expected: Array<Record<string, string>>;
}

function deterministic(id: "r1" | "r2"): Deterministic {
  const input = loadInput(`${id}.input.json`);
  const run = prepare(input);
  const detail = simulatePathDetail(run, 0);
  const table = toYearTable(detail, run);
  const assessCalls = Array.from({ length: detail.rows }, (_, t) => detail.year[t * YR_REC + YR.ASSESS_CALLS]!);
  return { id, input, table, rows: engineCsvRows(run, detail, table), assessCalls, expected: parseCsv(fixtureText(`${id}.expected.csv`)) };
}

describe.each(["r1", "r2"] as const)("R1 and R2 (strategies-outputs-web §7.6, §7.7; D15): %s", (id) => {
  const d = deterministic(id);
  const R = id.toUpperCase();

  it(`${R} the facade's path is the detail compared here: simulatePath(input, 0) gives the same year table, and runSimulation runs one path`, async () => {
    const path = simulatePath(d.input, 0);
    expect(path.table).toEqual(d.table);
    const out = await runSimulation(d.input, { threads: 0 });
    expect(out.paths).toBe(1);
    expect(out.endingRealCents[0]).toBe(path.endingRealCents);
    expect(out.depletionYear[0]).toBe(path.depletionYear);
    expect(BigInt(d.table.rows.at(-1)!.ending.totalReal)).toBe(path.endingRealCents);
  });

  it(`${R} every cell of ${id}.expected.csv within 0.01: money as the engine's figure rounded once, the rest equal`, () => {
    expect(d.rows.length).toBe(d.expected.length);
    let moneyCells = 0;
    let largest = 0n;
    d.expected.forEach((e, t) => {
      const row = d.rows[t]!;
      // Every column of the file has an engine value, and the engine has no column the file lacks.
      expect(Object.keys(row).sort()).toEqual(Object.keys(e).sort());
      for (const [key, cell] of Object.entries(row)) {
        const at = `${id} ${e.year} ${key}`;
        const want = e[key]!;
        switch (cell.kind) {
          case "money": {
            const diff = absBig(dollarsToCentsBigInt(cell.dollars) - csvCents(want));
            expect(diff <= CENT, `${at}: ${cell.dollars} against ${want}`).toBe(true);
            if (diff > largest) largest = diff;
            moneyCells++;
            break;
          }
          case "cpi":
            // The same float64 chain `cpi[t+1] = cpi[t] × (1 + inflation)`; the CSV prints the shortest round-trip form.
            expect(cell.value, at).toBe(Number(want));
            break;
          case "bp":
          case "year":
            expect(String(cell.value), at).toBe(want);
            break;
          case "text":
            expect(cell.value, at).toBe(want);
            break;
        }
      }
    });
    // 76 money columns × 21 rows (R1), 80 × 30 (R2).
    expect(moneyCells).toBe(id === "r1" ? 76 * 21 : 80 * 30);
    // Measured: 0 cents (see the file's header); the tolerance is 1 cent.
    expect(largest <= CENT).toBe(true);
  });

  it(`${R} the four tables of ${id}.md §4 against the engine directly: every cell within 0.01 (the sheet's side of the three-way agreement)`, () => {
    let checked = 0;
    for (const [tableId, columns] of Object.entries(SHEET_COLUMNS[id])) {
      const table = sheetTable(id, tableId);
      expect(table.rows.length, tableId).toBe(d.rows.length);
      table.rows.forEach((cells, t) => {
        const row = d.rows[t]!;
        table.header.forEach((column, c) => {
          const key = columns[column];
          expect(key, `${tableId} column ${column}`).toBeDefined();
          const cell = row[key!]!;
          const value = cells[c]!;
          const at = `${tableId} ${cells[0]} ${column}`;
          if (cell.kind === "money") {
            const diff = absBig(dollarsToCentsBigInt(cell.dollars) - sheetCents(value));
            expect(diff <= CENT, `${at}: ${cell.dollars} against ${value}`).toBe(true);
          } else if (cell.kind === "cpi") expect(cell.value, at).toBe(Number(value));
          else expect(String(cell.value), at).toBe(value);
          checked++;
        });
      });
    }
    expect(checked).toBeGreaterThan(id === "r1" ? 1000 : 2000);
  });

  it(`${R} the stored year table: totals and single cells are the rounded figures; parts add up (addUp); growth is the plug; every cell within 1.00 (largest 0.02)`, () => {
    let largest = 0n;
    d.table.rows.forEach((row, t) => {
      const e = d.expected[t]!;
      const cells = d.rows[t]!;
      const once = (key: string) => {
        const cell = cells[key];
        if (cell?.kind !== "money") throw new Error(`${key} is not a money cell`);
        return dollarsToCentsBigInt(cell.dollars);
      };
      for (const [key, cell] of Object.entries(cells)) {
        if (cell.kind !== "money" || cell.table === undefined) continue;
        const diff = absBig(cell.table - csvCents(e[key]!));
        if (diff > largest) largest = diff;
        expect(diff <= 100n, `${id} ${row.year} ${key}: the table's ${cell.table} against ${e[key]}`).toBe(true);
      }
      const at = `${id} ${row.year}`;
      // Cells the table rounds once, as the CSV does: equal to the CSV within 0.01.
      for (const key of [
        "income_total", "employee_contributions", "employer_contributions", "payroll_tax", "planned", "healthcare",
        "long_term_care", "goals", "floor", "funded", "shortfall", "surplus_saved", "rmd_total", "wd_total", "conversions",
        "realized_gains", "dividends", "coupons", "taxable_ss", "agi", "magi_irmaa", "magi_aca", "standard_deduction",
        "senior_deduction", "taxable_income", "total_federal_tax", "capital_loss_carryover", "end_total", "end_total_real",
      ]) {
        const cell = cells[key];
        expect(cell?.kind === "money" && cell.table !== undefined, `${at} ${key} in the table`).toBe(true);
        if (cell?.kind === "money" && cell.table !== undefined) {
          expect(absBig(cell.table - csvCents(e[key]!)) <= CENT, `${at} ${key}`).toBe(true);
        }
      }
      // Parts: addUp of the rounded total over the parts rounded once (strategies-outputs-web §3.11 item 5).
      const ids = d.input.accounts.map((a) => a.id);
      const people = d.input.household.people.map((p) => p.id);
      const big = (xs: readonly string[]) => xs.map((x) => BigInt(x));
      expect(big(row.withdrawals.byAccount), `${at} withdrawals`).toEqual(addUp(once("wd_total"), ids.map((a) => once(`wd_${a}`))));
      expect(big(row.ending.byAccount), `${at} endings`).toEqual(addUp(once("end_total"), ids.map((a) => once(`end_${a}`))));
      expect(BigInt(row.income.total), `${at} income`).toBe(once("income_total"));
      expect(big(row.income.socialSecurity), `${at} benefits`).toEqual(
        addUp(once("income_total"), [once("wages"), ...people.map((p) => once(`ss_${p}`)), once("pension"), once("rental"), once("other_income")]).slice(1, 1 + people.length),
      );
      expect(BigInt(row.tax.taxableIncomeCents), `${at} taxable income`).toBe(once("taxable_income"));
      expect(
        big([row.tax.ordinaryTaxableCents, row.tax.gainsAt0Cents, row.tax.gainsAt15Cents, row.tax.gainsAt20Cents]),
        `${at} taxable income by rate`,
      ).toEqual(addUp(once("taxable_income"), [once("ordinary_taxable"), once("gains_at_0"), once("gains_at_15"), once("gains_at_20")]));
      // Core is what the funded amount leaves after healthcare, long-term care and goals, in cents.
      expect(BigInt(row.spending.core), `${at} core`).toBe(
        BigInt(row.spending.funded) - BigInt(row.spending.healthcare) - BigInt(row.spending.longTermCare) - BigInt(row.spending.goals),
      );
      // Growth is the roll-forward's plug in cents (item 6).
      const previous = t === 0 ? BigInt(d.table.startingTotal) : BigInt(d.table.rows[t - 1]!.ending.total);
      expect(BigInt(row.growth), `${at} growth`).toBe(
        BigInt(row.ending.total) - (previous + BigInt(row.surplusSaved) + BigInt(row.contributions.employee) + BigInt(row.contributions.employer) - BigInt(row.withdrawals.total)),
      );
    });
    // Measured 0.01 (R1) and 0.02 (R2); the design expected the largest under 0.02 (§7.7 (3)).
    expect(largest <= 2n, `${id}: the largest difference is ${largest} cents`).toBe(true);
  });

  it(`${R} the gross-up needs at most ${id === "r1" ? 5 : 6} assess calls in any year (strategies-outputs-web §7.6, §7.7)`, () => {
    expect(Math.max(...d.assessCalls)).toBeLessThanOrEqual(id === "r1" ? 5 : 6);
  });
});

describe("R1 and R2 summary figures through runSimulation (r1.md §5, r2.md §5)", () => {
  it("R1 succeeds; ends with 1,872,197.87 nominal and 1,114,680.94 in today's dollars; lifetime spending 2,471,000.00 and tax 153,853.22 in today's dollars", async () => {
    const out = await runSimulation(loadInput("r1.input.json"), { threads: 0 });
    expect([out.paths, out.successPaths, out.depletionYear[0]]).toEqual([1, 1, -1]);
    expect(out.endingRealCents[0]).toBe(111468094n);
    expect(out.summary.endingWealthNominal.p50).toBe("187219787");
    expect(out.lifetimeSpendingRealCents[0]).toBe(247100000n);
    expect(out.lifetimeTaxRealCents[0]).toBe(15385322n);
    expect(out.summary.shortfallRealP50OfFailures).toBeUndefined();
  });

  it("R2 fails in 2056 with a shortfall of 59,264.03 (28,960.03 in today's dollars) and ends at 0; lifetime spending 2,619,679.97 and tax 105,568.56", async () => {
    const input = loadInput("r2.input.json");
    const out = await runSimulation(input, { threads: 0 });
    expect([out.paths, out.successPaths, out.depletionYear[0]]).toEqual([1, 0, 2056]);
    expect(out.endingRealCents[0]).toBe(0n);
    expect(out.summary.failure).toMatchObject({ paths: 1, firstDepletionYear: 2056, medianDepletionYear: 2056 });
    expect(out.summary.shortfallRealP50OfFailures).toBe("2896003");
    expect(out.lifetimeSpendingRealCents[0]).toBe(261967997n);
    expect(out.lifetimeTaxRealCents[0]).toBe(10556856n);
    const last = simulatePath(input, 0).table.rows.at(-1)!;
    expect([last.year, last.failed, last.spending.shortfall, last.ending.total]).toEqual([2056, true, "5926403", "0"]);
  });

  it("R2 2034, the first death (r2.md §2.12, §3): stocks 70,753.05 at basis 36,776.54 → 53,764.79; bonds 46,278.72 at 32,341.96 → 39,310.34", () => {
    const input = loadInput("r2.input.json");
    const run = prepare(input);
    const detail = simulatePathDetail(run, 0);
    const t = 2034 - 2027;
    const a = input.accounts.findIndex((x) => x.id === "taxable");
    const o = (t * run.accountCount + a) * 3;
    // The detail's basis is after the reset; the year table's basis is the same (the basis carried into 2035).
    expect(CSV_ASSETS.slice(0, 2).map((_, j) => dollarsToCentsBigInt(detail.end[o + j]!))).toEqual([7075305n, 4627872n]);
    expect(CSV_ASSETS.slice(0, 2).map((_, j) => dollarsToCentsBigInt(detail.endBasis[o + j]!))).toEqual([5376479n, 3931034n]);
    expect(detail.endBasis[o + 2]).toBe(0);
    const row = toYearTable(detail, run).rows[t]!;
    // The table rounds the account's basis once: 53,764.79… + 39,310.34… = 93,075.14 (the rounded
    // parts sum to 93,075.13; the unrounded stock basis is just under 53,764.795).
    expect(row.ending.basisByAccount[a]).toBe(dollarsToCentsBigInt(detail.endBasis[o]! + detail.endBasis[o + 1]! + detail.endBasis[o + 2]!).toString());
    expect(row.ending.basisByAccount[a]).toBe("9307514");
    // The sheet's 2034 row is before the reset (r2.md §2.11): 36,776.54 + 32,341.96 = 69,118.50;
    // half-way to the values gives 36,776.54 + 0.5 × (70,753.05 − 36,776.54) = 53,764.795 and
    // 32,341.96 + 0.5 × (46,278.72 − 32,341.96) = 39,310.34 on the printed cents.
    const csv = parseCsv(fixtureText("r2.expected.csv"))[t]!;
    expect([csv.basis_taxable_stocks, csv.basis_taxable_bonds, csv.basis_taxable]).toEqual(["36776.54", "32341.96", "69118.50"]);
  });
});

// --------------------------------------------------------------------------------------------
// R3: the 4% rule on the historical record (r3.md, D16, D18)

interface R3Path {
  readonly startYear: number;
  readonly failIndex: number;
  readonly shortfallReal: number;
  readonly endNominal: number;
  readonly endReal: number;
}
interface R3Run {
  readonly stockBp: number;
  readonly paths: number;
  readonly firstStartYear: number;
  readonly lastStartYear: number;
  readonly successPaths: number;
  readonly successBp: number;
  readonly failures: ReadonlyArray<{ startYear: number; failIndex: number; shortfallReal: number }>;
  readonly endingReal: { p10: number; p50: number; p90: number; startYearOfEach: { p10: number; p50: number; p90: number } };
  readonly pathsDetail: readonly R3Path[];
}
interface R3Expected {
  readonly dataSha256: string;
  readonly engineConvention: { runs: readonly R3Run[]; otherMixes: ReadonlyArray<{ stockBp: number; paths: number; successPaths: number }> };
  readonly path1966: ReadonlyArray<{
    dataYear: number;
    startBalance: number;
    need: number;
    shortfall: number;
    portfolioReturn: number;
    endBalance: number;
    inflation: number;
  }>;
}
interface Published {
  readonly id: string;
  readonly value: number;
  readonly tolerance: number;
  readonly verified: boolean;
}

const r3Expected = fixtureJson("r3.expected.json") as R3Expected;
/** R3's input at a stock share: r3.input.json (50%) with the Roth account's allocation changed, as r3.md §1's second run. */
function r3Input(stockBp: number): SimInput {
  const base = loadInput("r3.input.json");
  if (stockBp === 5000) return base;
  const accounts = base.accounts.map((a) => (a.id === "roth" ? { ...a, allocation: { ...a.allocation, us_stock: stockBp, bonds: 10000 - stockBp } } : a));
  const input = SimInput.parse({ ...base, accounts });
  expect(input).toEqual(referenceR3Input(stockBp));
  return input;
}
/** Σ shortfall ÷ cpiStart over a path's rows, in today's cents (the year table deflated row by row, seams C43). */
function lifetimeShortfallRealCents(table: YearTable): bigint {
  return deflateYearTable(table).rows.reduce((s, row) => s + BigInt(row.spending.shortfall), 0n);
}

describe("R3 the 4% rule on the historical record (strategies-outputs-web §7.8; r3.md; D16)", () => {
  it("R3 the engine reads the data file the calculator read (D2's SHA-256)", () => {
    const csv = readFileSync(new URL("../data/us-annual-returns.csv", import.meta.url));
    expect(createHash("sha256").update(csv).digest("hex")).toBe(r3Expected.dataSha256);
    const manifest = JSON.parse(readFileSync(new URL("../data/manifest.json", import.meta.url), "utf8")) as { files: Array<{ path: string; sha256: string }> };
    expect(manifest.files.find((f) => f.path === "us-annual-returns.csv")?.sha256).toBe(r3Expected.dataSha256);
  });

  it.each(R3_STOCK_BP)(
    "R3 %i bp stocks: the same 69 start years, funded count, failing start years and indexes; every shortfall and ending wealth within 1.00",
    async (stockBp) => {
      const e = r3Expected.engineConvention.runs.find((r) => r.stockBp === stockBp)!;
      const input = r3Input(stockBp);
      const out = await runSimulation(input, { threads: 0 });
      expect(out.paths).toBe(69);
      expect(out.summary.model).toMatchObject({ kind: "historical", cohortMode: "complete", cohortCount: 69, firstStartYear: 1928, lastStartYear: 1996 });
      expect([e.paths, e.firstStartYear, e.lastStartYear]).toEqual([69, 1928, 1996]);
      expect(out.successPaths).toBe(e.successPaths);
      // successBp = floor(funded × 10000 ÷ paths) (r3.md §2): 64 → 9275, 65 → 9420.
      expect(Math.floor((out.successPaths * 10000) / out.paths)).toBe(e.successBp);
      const run = prepare(input);
      const failures: Array<{ startYear: number; failIndex: number; shortfallReal: number }> = [];
      for (let k = 0; k < out.paths; k++) {
        const want = e.pathsDetail[k]!;
        const path = simulatePreparedPath(run, k);
        const at = `${stockBp} bp, start ${want.startYear}`;
        expect(path.table.historicalStartYear, at).toBe(want.startYear);
        expect(path.table.historicalStartYear, at).toBe(1928 + k);
        const failIndex = out.depletionYear[k] === -1 ? -1 : out.depletionYear[k]! - 2027;
        expect(failIndex, at).toBe(want.failIndex);
        expect(path.depletionYear, at).toBe(out.depletionYear[k]);
        expect(path.endingRealCents, at).toBe(out.endingRealCents[k]);
        // Within 1.00 (r3.md §5 item 1); measured: equal to the cent.
        expect(absBig(out.endingRealCents[k]! - jsonCents(want.endReal)) <= 100n, `${at}: ending ${out.endingRealCents[k]} against ${want.endReal}`).toBe(true);
        expect(absBig(BigInt(path.table.rows.at(-1)!.ending.total) - jsonCents(want.endNominal)) <= 100n, `${at}: nominal`).toBe(true);
        const shortfall = lifetimeShortfallRealCents(path.table);
        expect(absBig(shortfall - jsonCents(want.shortfallReal)) <= 100n, `${at}: shortfall ${shortfall} against ${want.shortfallReal}`).toBe(true);
        if (failIndex >= 0) failures.push({ startYear: want.startYear, failIndex, shortfallReal: Number(shortfall) / 100 });
      }
      expect(failures.map((f) => [f.startYear, f.failIndex])).toEqual(e.failures.map((f) => [f.startYear, f.failIndex]));
      failures.forEach((f, i) => expect(Math.abs(f.shortfallReal - e.failures[i]!.shortfallReal)).toBeLessThanOrEqual(1));
      // The 10th, 50th and 90th percentile paths (C9's rank on cents, p → rank max(0, ceil(p N / 100) − 1)).
      for (const p of [10, 50, 90] as const) {
        const k = selectPercentilePath(out.endingRealCents, out.depletionYear, p);
        expect(1928 + k, `p${p}`).toBe(e.endingReal.startYearOfEach[`p${p}`]);
        const summaryCents = BigInt(out.summary.endingWealthReal[`p${p}`]);
        expect(summaryCents).toBe(out.endingRealCents[k]);
        expect(absBig(summaryCents - jsonCents(e.endingReal[`p${p}`])) <= 100n, `p${p}`).toBe(true);
      }
    },
    60_000,
  );

  it("R3 the counts r3.md §4 gives for information: 64, 51 and 27 of 69 at 100%, 25% and 0% stocks", async () => {
    for (const mix of r3Expected.engineConvention.otherMixes) {
      const out = await runSimulation(r3Input(mix.stockBp), { threads: 0 });
      expect([mix.stockBp, out.paths, out.successPaths]).toEqual([mix.stockBp, mix.paths, mix.successPaths]);
    }
    expect(r3Expected.engineConvention.otherMixes.map((m) => [m.stockBp, m.successPaths])).toEqual([
      [10000, 64],
      [2500, 51],
      [0, 27],
    ]);
  });

  it("HC-E1 the 1966 path at 50% stocks (r3.md §3): every row within 0.01; it fails in plan year 24 (1990) short by 14,686.68", () => {
    const input = r3Input(5000);
    const run = prepare(input);
    const k = 1966 - 1928;
    const detail = simulatePathDetail(run, k);
    const table = toYearTable(detail, run);
    expect(table.historicalStartYear).toBe(1966);
    expect(table.rows.length).toBe(r3Expected.path1966.length);
    r3Expected.path1966.forEach((want, t) => {
      const row = table.rows[t]!;
      const at = `${want.dataYear} (plan ${row.year})`;
      expect(detail.sampledYear[t], at).toBe(want.dataYear);
      const start = t === 0 ? BigInt(table.startingTotal) : BigInt(table.rows[t - 1]!.ending.total);
      for (const [name, got, value] of [
        ["start balance", start, want.startBalance],
        ["need", BigInt(row.spending.floor), want.need],
        ["shortfall", BigInt(row.spending.shortfall), want.shortfall],
        ["end balance", BigInt(row.ending.total), want.endBalance],
      ] as const) {
        expect(absBig(got - jsonCents(value)) <= CENT, `${at} ${name}: ${got} against ${value}`).toBe(true);
      }
      // The mix's return and the year's inflation, from the market path (the data row as it happened).
      const g = (j: number) => detail.growth[t * 3 + j]! - 1;
      expect(Math.abs(0.5 * g(0) + 0.5 * g(1) - want.portfolioReturn), `${at} return`).toBeLessThan(1e-12);
      expect(Math.abs(detail.priceFactor[t]! - 1 - want.inflation), `${at} inflation`).toBeLessThan(1e-12);
    });
    const fail = table.rows.findIndex((r) => r.failed);
    expect(fail).toBe(24);
    expect(table.rows[24]!.spending.shortfall).toBe("1468668");
    // 1966 by hand: (1,000,000 − 40,000) × (1 + 0.5 × (−0.099710) + 0.5 × 0.029079) = 960,000 × 0.9646845 = 926,097.12.
    expect(table.rows[0]!.ending.total).toBe("92609712");
  });

  it("R3 the engine against the study (r3.md §5 item 3; D18): 92.8% against 95% and 94.2% against 98%, within 5 points", async () => {
    const published = fixtureJson("published.json") as Published[];
    const study = new Map(published.map((p) => [p.id, p]));
    for (const [stockBp, id] of [
      [5000, "trinity_1998_table3_50_stocks"],
      [7500, "trinity_1998_table3_75_stocks"],
    ] as const) {
      const out = await runSimulation(r3Input(stockBp), { threads: 0 });
      const ref = study.get(id)!;
      expect(ref.verified).toBe(false);
      expect(Math.abs((100 * out.successPaths) / out.paths - ref.value)).toBeLessThanOrEqual(ref.tolerance);
    }
  });
});

// --------------------------------------------------------------------------------------------
// R4: a lognormal sanity check (r4.md, D17)

interface R4Expected {
  readonly successRate: number;
  readonly toleranceAbs: number;
  readonly medianEndingReal: number;
  readonly medianToleranceRel: number;
  readonly percentilesEndingReal: { p10: number; p25: number; p50: number; p75: number; p90: number };
}
const r4Expected = fixtureJson("r4.expected.json") as R4Expected;

describe("R4 a lognormal sanity check (strategies-outputs-web §7.9; r4.md; D17)", () => {
  it("R4 the engine's lognormal parameters are the sheet's: σ² = ln(1 + (S ÷ (1 + A))²), μ = ln(1 + A) − σ² ÷ 2 (r4.md §2)", () => {
    const model = loadInput("r4.input.json").settings.returnModel;
    if (model.kind !== "parametric" || model.params === undefined) throw new Error("R4 runs the custom parametric model");
    const p = customParams(model.params);
    const sheet = (A: number, S: number) => {
      const s2 = Math.log(1 + (S / (1 + A)) ** 2);
      return { mu: Math.log(1 + A) - s2 / 2, sigma: Math.sqrt(s2) };
    };
    for (const [j, A, S] of [
      [0, 0.06, 0.12],
      [3, 0.025, 0.01],
    ] as const) {
      expect(Math.abs(p.mu[j]! - sheet(A, S).mu)).toBeLessThan(1e-15);
      expect(Math.abs(p.sigma[j]! - sheet(A, S).sigma)).toBeLessThan(1e-15);
    }
    expect([p.phiBills, p.phiInflation]).toEqual([0, 0]);
    expect(Array.from(p.correlation)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it(
    "R4 10,000 paths, seed 1: success within 1.5 points of 69.94% and the median ending wealth within 8% of 337,269.43; the 10th and 25th percentiles are 0",
    async () => {
      const input = loadInput("r4.input.json");
      const out = await runSimulation(input, { threads: 0 });
      expect([out.paths, out.summary.model.kind, out.summary.model.preset]).toEqual([10000, "parametric", "custom"]);
      expect([r4Expected.toleranceAbs, r4Expected.medianToleranceRel]).toEqual([0.015, 0.08]);
      const success = out.successPaths / out.paths;
      expect(Math.abs(success - r4Expected.successRate)).toBeLessThanOrEqual(r4Expected.toleranceAbs);
      const median = Number(out.summary.endingWealthReal.p50) / 100;
      expect(Math.abs(median / r4Expected.medianEndingReal - 1)).toBeLessThanOrEqual(r4Expected.medianToleranceRel);
      expect([out.summary.endingWealthReal.p10, out.summary.endingWealthReal.p25]).toEqual(["0", "0"]);
      expect([r4Expected.percentilesEndingReal.p10, r4Expected.percentilesEndingReal.p25]).toEqual([0, 0]);
      // Measured (see the file's header): 7,040 of 10,000 and 337,269.91. Not pinned here: T41's
      // digests pin the engine's numbers; the gate's criteria are the two tolerances above.
      // HC-E3 on the gate's own run: two threads give the same output as inline, timing aside.
      const threaded = await runSimulation(input, { threads: 2 });
      const { timing: _a, ...inline } = out;
      const { timing: _b, ...pooled } = threaded;
      expect(pooled).toEqual(inline);
    },
    120_000,
  );
});
