import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  FIXTURES_DIR,
  json,
  loadReturns,
  r4SpreadOffset,
  renderCsv,
  runR1,
  runR2,
  runR3,
  runR4SpreadRun,
  R4_LARGE_PATHS,
  R4_SPREAD_PATHS,
  R4_SPREAD_RUNS,
} from "./independent.js";
import { SHEET_COLUMNS, UNTABULATED } from "./independent/columns.js";
import type { RunResult } from "./independent/deterministic.js";
import { DATA_SHA256, parseReturns } from "./independent/historical.js";
import { lawFor } from "./independent/law.js";
import { boxMuller, lognormalParameters, Mulberry32 } from "./independent/lognormal.js";

// Phase 4 step 22a: the independent calculator (reference/independent.ts) and the expected files it
// writes (reference/fixtures/*.expected.*), checked against the reference sheets it was written
// from (reference/sheets/*.md) and against seams.md §8 D15 to D18. The engine's side of the
// three-way agreement is step 22b.

const REFERENCE = fileURLToPath(new URL("./", import.meta.url));
const SRC = resolve(REFERENCE, "../src");
const sheetText = (name: string): string => readFileSync(join(REFERENCE, "sheets", `${name}.md`), "utf8");
const fixture = (name: string): string => readFileSync(join(FIXTURES_DIR, name), "utf8");

// --------------------------------------------------------------------------------------------
// Markdown and CSV helpers

const cells = (line: string): string[] =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

interface Table {
  header: string[];
  rows: string[][];
}

/** The table whose header line is `lines[at]` (separator next, rows until the first non-table line). */
function tableAt(lines: readonly string[], at: number): Table {
  const header = cells(lines[at] ?? "");
  expect(lines[at + 1] ?? "").toMatch(/^\|( *:?-{3,}:? *\|)+$/);
  const rows: string[][] = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(cells(line));
  }
  return { header, rows };
}

/** The machine-read table after `<!-- table: id -->`. */
function markedTable(text: string, id: string): Table {
  const lines = text.split("\n");
  const at = lines.indexOf(`<!-- table: ${id} -->`);
  expect(at, `table ${id}`).toBeGreaterThanOrEqual(0);
  return tableAt(lines, at + 1);
}

/** Every table whose header line starts with `prefix`. */
function tablesStartingWith(text: string, prefix: string): Table[] {
  const lines = text.split("\n");
  return lines.flatMap((line, i) => (line.startsWith(prefix) ? [tableAt(lines, i)] : []));
}

const sheetMoney = (cell: string): number => {
  expect(cell).toMatch(/^-?\d{1,3}(,\d{3})*(\.\d+)?$/);
  return Number(cell.replace(/,/g, ""));
};

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  expect(text.endsWith("\n")).toBe(true);
  const lines = text.slice(0, -1).split("\n");
  const header = (lines[0] ?? "").split(",");
  const rows = lines.slice(1).map((l) => l.split(","));
  for (const r of rows) expect(r.length).toBe(header.length);
  return { header, rows };
}

const MONEY_CELL = /^-?\d+\.\d{2}$/;
const TOLERANCE = 0.01 + 1e-9; // per cell (the task and seams.md §8 D15: within 0.01)

// --------------------------------------------------------------------------------------------
// Source scan

/** Module specifiers of every import, export-from, dynamic import and require in a source text. */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  // A module specifier never contains white space, which keeps prose such as "12% from" out.
  const patterns = [
    /\bfrom\s*["']([^"'\s]+)["']/g,
    /\bimport\s*["']([^"'\s]+)["']/g,
    /\bimport\s*\(\s*["']([^"'\s]+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"'\s]+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) out.push(m[1] as string);
  return out;
}

/** Why a specifier imported by `file` would reach packages/retirement/src, or null. */
function reachesSrc(file: string, spec: string): string | null {
  if (spec === "@meridian/retirement" || spec.startsWith("@meridian/retirement/")) return "the package entry points are src/";
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const target = resolve(dirname(file), spec);
    if (target === SRC || target.startsWith(SRC + sep)) return "a path into src/";
    return null;
  }
  if (spec.startsWith("node:") || spec === "vitest") return null;
  return "a package the calculator does not need";
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].includes(extname(name)) ? [path] : [];
  });
}

describe("step 22a: nothing under reference/ imports from src/", () => {
  it("the scanner finds a path into src/ and the package's own entry points", () => {
    // Escaped (\u0066 is "f", \u0069 is "i") so that this file's own source does not match the scan.
    const planted = 'import { cents } \u0066rom "../src/units.js";\nexport * \u0066rom "@meridian/retirement/testing";\nconst m = await \u0069mport("../src/rng.js");';
    const file = join(REFERENCE, "planted.ts");
    const found = importSpecifiers(planted).map((s) => reachesSrc(file, s));
    expect(found).toEqual(["a path into src/", "the package entry points are src/", "a path into src/"]);
  });

  it("no source file under reference/ reaches src/ or any package but node: and vitest", () => {
    const files = sourceFiles(REFERENCE);
    expect(files.some((f) => f.endsWith(`${sep}independent.ts`))).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(10);
    const offences: string[] = [];
    let imports = 0;
    for (const file of files) {
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        imports++;
        const why = reachesSrc(file, spec);
        if (why !== null) offences.push(`${file}: "${spec}" (${why})`);
      }
    }
    expect(imports).toBeGreaterThan(20);
    expect(offences).toEqual([]);
  });
});

// --------------------------------------------------------------------------------------------
// R1 and R2

const RUNS: ReadonlyArray<readonly ["r1" | "r2", () => RunResult, number, number]> = [
  ["r1", runR1, 2027, 2047],
  ["r2", runR2, 2027, 2056],
];

for (const [id, run, first, last] of RUNS) {
  describe(`step 22a: ${id.toUpperCase()} (reference/sheets/${id}.md)`, () => {
    const result = run();
    const csvText = fixture(`${id}.expected.csv`);
    const csv = parseCsv(csvText);
    const col = (key: string): number => {
      const i = csv.header.indexOf(key);
      expect(i, `CSV column ${key}`).toBeGreaterThanOrEqual(0);
      return i;
    };
    const years = Array.from({ length: last - first + 1 }, (_, k) => String(first + k));

    it(`${id}.expected.csv is what the calculator writes (one row per plan year)`, () => {
      expect(renderCsv(result)).toBe(csvText);
      expect(csv.rows.map((r) => r[0])).toEqual(years);
    });

    it(`${id}.expected.csv equals the four tables of §4 within 0.01 per cell`, () => {
      const text = sheetText(id);
      let compared = 0;
      let largest = 0;
      for (const [tableId, mapping] of Object.entries(SHEET_COLUMNS[id])) {
        const t = markedTable(text, tableId);
        expect(t.rows.map((r) => r[0]), tableId).toEqual(years);
        expect(t.header.filter((h) => mapping[h] === undefined), `${tableId}: unmapped sheet columns`).toEqual([]);
        t.rows.forEach((row, r) => {
          const mine = csv.rows[r] ?? [];
          t.header.forEach((name, c) => {
            const key = mapping[name] as string;
            const theirs = row[c] ?? "";
            const ours = mine[col(key)] ?? "";
            compared++;
            if (MONEY_CELL.test(ours)) {
              const diff = Math.abs(Number(ours) - sheetMoney(theirs));
              largest = Math.max(largest, diff);
              expect(diff, `${tableId} ${row[0]} ${name}: sheet ${theirs}, calculator ${ours}`).toBeLessThanOrEqual(TOLERANCE);
            } else {
              // Year, ages, filing, cpiStart / cpiEnd (shortest round-trip doubles) and basis points: equal.
              expect(ours, `${tableId} ${row[0]} ${name}`).toBe(theirs);
            }
          });
        });
      }
      expect(compared).toBeGreaterThan(1000);
      // When written (step 22a) every money cell agreed to the cent, the largest difference 0.00,
      // the three half-cent cells of R1 2030 included (r1.md §2.12); the requirement is 0.01.
      expect(largest).toBeLessThanOrEqual(TOLERANCE);
    });

    it(`the CSV columns the tables omit hold what ${id}.md §2.11 states`, () => {
      const tabulated = new Set(Object.values(SHEET_COLUMNS[id]).flatMap((m) => Object.values(m)));
      const untabulated = UNTABULATED[id];
      expect(csv.header.filter((k) => !tabulated.has(k) && untabulated[k] === undefined), "unclassified CSV columns").toEqual([]);
      for (const [key, rule] of Object.entries(untabulated)) {
        for (const row of csv.rows) {
          const v = row[col(key)];
          if (rule === "zero") expect(v, `${key} ${row[0]}`).toBe("0.00");
          else if ("equals" in rule) expect(v, `${key} ${row[0]}`).toBe(row[col(rule.equals)]);
          else expect(v, `${key} ${row[0]}`).toBe(rule.text);
        }
      }
    });

    it(`the cash identity and the roll-forward hold on the unrounded rows (${id}.md §2.11)`, () => {
      let previous = result.startTotal;
      for (const r of result.rows) {
        expect(Math.abs(r.incomeTotal + r.withdrawalsTotal - (r.tax.totalFederalTax + r.funded + r.surplus))).toBeLessThan(1e-6);
        expect(Math.abs(previous + r.surplus - r.withdrawalsTotal + r.growth - r.endTotal)).toBeLessThan(1e-6);
        previous = r.endTotal;
      }
    });

    it(`the indexed law of every year equals the law tables of ${id}.md §2.10`, () => {
      const tables = tablesStartingWith(sheetText(id), "| Year | F | 12% from");
      expect(tables.length).toBe(id === "r1" ? 1 : 2);
      const rows = tables.flatMap((t) => t.rows);
      expect(rows.map((r) => r[0])).toEqual(years);
      rows.forEach((row, k) => {
        const law = (result.rows[k] as RunResult["rows"][number]).law;
        const [year, f, ...figures] = row;
        expect(law.year).toBe(Number(year));
        expect(String(law.factor)).toBe(f);
        const mine = [...law.thresholds.slice(1), law.standard, law.aged, law.max0, law.max15, law.seniorEach];
        expect(mine, `${year} (${law.filing})`).toEqual(figures.map(sheetMoney));
      });
    });

    it(`the Social Security chain equals the table of ${id}.md §2.5`, () => {
      const [table] = tablesStartingWith(sheetText(id), "| Year | COLA (from January)");
      expect(table).toBeDefined();
      const rows = (table as Table).rows;
      expect(rows.map((r) => r[0])).toEqual(years);
      rows.forEach((row, k) => {
        const ss = result.ss[k] as RunResult["ss"][number];
        const [year, cola, pia1, pia2, pay1, pay2, year1, year2] = row as [string, string, string, string, string, string, string, string];
        expect(ss.year).toBe(Number(year));
        expect(ss.cola === 0 ? "–" : `${ss.cola * 100}%`).toBe(cola);
        expect([ss.pia.p1, ss.pia.p2]).toEqual([Number(pia1), Number(pia2)]);
        expect([ss.monthly.p1, ss.monthly.p2]).toEqual([Number(pay1), Number(pay2)]);
        expect([ss.annual.p1, ss.annual.p2]).toEqual([sheetMoney(year1), sheetMoney(year2)]);
      });
    });
  });
}

describe("step 22a: summary figures (§5 of r1.md and r2.md)", () => {
  const to2 = (x: number): number => Math.round(x * 100) / 100;

  it("R1 succeeds and ends with 1,872,197.87 nominal, 1,114,680.94 in today's dollars", () => {
    const r = runR1();
    expect(r.success).toBe(true);
    expect(r.depletionYear).toBe(-1);
    expect(to2(r.endNominal)).toBe(1_872_197.87);
    expect(to2(r.endReal)).toBe(1_114_680.94);
    expect(to2(r.lifetimeFundedReal)).toBe(2_471_000.0);
    expect(to2(r.lifetimeTaxReal)).toBe(153_853.22);
    expect(to2(r.lifetimeShortfallReal)).toBe(0);
  });

  it("R2 fails in 2056 with a shortfall of 59,264.03 (28,960.03 in today's dollars) and ends at 0", () => {
    const r = runR2();
    expect(r.success).toBe(false);
    expect(r.depletionYear).toBe(2056);
    const lastRow = r.rows[r.rows.length - 1] as RunResult["rows"][number];
    expect(to2(lastRow.shortfall)).toBe(59_264.03);
    expect(to2(r.lifetimeShortfallReal)).toBe(28_960.03);
    expect(to2(r.endNominal)).toBe(0);
    expect(to2(r.lifetimeFundedReal)).toBe(2_619_679.97);
    expect(to2(r.lifetimeTaxReal)).toBe(105_568.56);
    expect(r.rows.filter((row) => row.shortfall > 0).map((row) => row.year)).toEqual([2056]);
  });
});

describe("step 22a: the re-derived hand cases (reference/sheets/hand-cases.md)", () => {
  const r1 = runR1();
  const row = (year: number) => r1.rows.find((r) => r.year === year) as RunResult["rows"][number];
  const to2 = (x: number): number => Math.round(x * 100) / 100;

  it("HC-T15 2028 joint standard deduction with both age additions is 37,400.00; 12% from 26,200", () => {
    // 33,200 + floor(33,200 × 0.025 / 100) × 100 = 34,000; 1,700 + floor(1,700 × 0.025 / 50) × 50 = 1,700.
    const law = lawFor(2028, "joint", 1.025);
    expect(law.standard + 2 * law.aged).toBe(37_400);
    expect(law.thresholds[1]).toBe(26_200);
  });

  it("HC-S3 (a) R2's widow's benefit in 2035 is 36,540.00; (b) R1's person A in 2029 is 37,812.00", () => {
    // (a) PIA_p1 3,045.6 after eight 2.5% COLAs truncated to the dime, paid 3,045 a month.
    expect(runR2().rows.find((r) => r.year === 2035)?.ss.p2).toBe(36_540);
    // (b) 3,000 → 3,075.0 → 3,151.875 → 3,151.8, paid 3,151 a month; B 22,692.00; together 60,504.00 (seams C50).
    expect(row(2029).ss.p1).toBe(37_812);
    expect(row(2029).ss.p2).toBe(22_692);
  });

  it("WD-5 R1 2028: taxable 133,585.74, gain 54,070.42, ordinary tax 8,563.41, gains tax 3,772.33", () => {
    const y = row(2028);
    // Closed form (hand-cases.md): x × (1 − 0.1824 × 17/42) = 123,723.30, so x = 123,723.30 × 42 / 38.8992.
    expect(Math.abs((y.withdrawals.taxable as number) - (123_723.3 * 42) / 38.8992)).toBeLessThan(1e-6);
    expect(to2(y.withdrawals.taxable as number)).toBe(133_585.74);
    expect(to2(y.realizedGains)).toBe(54_070.42);
    expect(to2(y.tax.ordinaryTax)).toBe(8_563.41);
    expect(to2(y.tax.capitalGainsTax)).toBe(3_772.33);
    expect(to2(y.tax.totalFederalTax)).toBe(12_335.74);
  });

  it("WD-15 R1 2031: taxable 43,442.14, pre-tax 21,170.38 and 8,879.72, tax 5,560.56", () => {
    const y = row(2031);
    // Closed form (hand-cases.md, intermediates to four decimals): 0.778 y = 23,378.9730, y = 30,050.0938.
    const preTax = (y.withdrawals.pre_tax_a as number) + (y.withdrawals.pre_tax_b as number);
    expect(Math.abs(preTax - 30_050.0938)).toBeLessThan(0.001);
    expect(to2(y.withdrawals.taxable as number)).toBe(43_442.14);
    expect(to2(y.withdrawals.pre_tax_a as number)).toBe(21_170.38);
    expect(to2(y.withdrawals.pre_tax_b as number)).toBe(8_879.72);
    expect(to2(y.tax.totalFederalTax)).toBe(5_560.56);
  });
});

// --------------------------------------------------------------------------------------------
// R3

describe("step 22a: R3 (reference/sheets/r3.md)", () => {
  const r3 = runR3();
  const run = (bp: number) => {
    const found = r3.engineConvention.runs.find((r) => r.stockBp === bp);
    expect(found).toBeDefined();
    return found as (typeof r3.engineConvention.runs)[number];
  };

  it("reads the pinned data file and refuses the wrong sheet", () => {
    expect(loadReturns().sha256).toBe(DATA_SHA256);
    const text = readFileSync(join(REFERENCE, "../data/us-annual-returns.csv"), "utf8");
    // "Nominal vs Real Data" has a 1966 inflation of 3.36% (r3.md §1).
    expect(() => parseReturns(text.replace("1966,-0.099710,0.029079,0.048557,0.034591", "1966,-0.099710,0.029079,0.048557,0.033600"))).toThrow(/1966/);
  });

  it("r3.expected.json is what the calculator writes", () => {
    expect(json(r3)).toBe(fixture("r3.expected.json"));
    expect(r3.dataSha256).toBe(DATA_SHA256);
  });

  it("D16: 64 of 69 at 50% stocks failing 1964, 1965, 1966, 1968, 1969; 65 of 69 at 75% failing 1965, 1966, 1968, 1969", () => {
    for (const bp of [5000, 7500]) {
      expect([run(bp).paths, run(bp).firstStartYear, run(bp).lastStartYear]).toEqual([69, 1928, 1996]);
    }
    expect([run(5000).successPaths, run(5000).successBp]).toEqual([64, 9275]);
    expect(run(5000).failures.map((f) => f.startYear)).toEqual([1964, 1965, 1966, 1968, 1969]);
    expect([run(7500).successPaths, run(7500).successBp]).toEqual([65, 9420]);
    expect(run(7500).failures.map((f) => f.startYear)).toEqual([1965, 1966, 1968, 1969]);
  });

  it("equals the expected table of r3.md §4: failing indexes, shortfalls and percentiles within 0.01", () => {
    const t = markedTable(sheetText("r3"), "r3.expected");
    expect(t.rows.length).toBe(2);
    for (const row of t.rows) {
      const [stocks, funded, successBp, failures, percentiles] = row as [string, string, string, string, string];
      const r = run(Number(stocks.replace("%", "")) * 100);
      expect(funded).toBe(`${r.successPaths} of ${r.paths}`);
      expect(Number(successBp)).toBe(r.successBp);
      const sheetFailures = [...failures.matchAll(/(\d{4}) \((\d+); ([\d,]+\.\d{2})\)/g)].map((m) => ({
        startYear: Number(m[1]),
        failIndex: Number(m[2]),
        shortfallReal: sheetMoney(m[3] as string),
      }));
      expect(sheetFailures.length).toBe(r.failures.length);
      sheetFailures.forEach((f, i) => {
        const mine = r.failures[i] as (typeof r.failures)[number];
        expect([mine.startYear, mine.failIndex]).toEqual([f.startYear, f.failIndex]);
        expect(Math.abs(mine.shortfallReal - f.shortfallReal)).toBeLessThanOrEqual(TOLERANCE);
      });
      const p = [...percentiles.matchAll(/([\d,]+\.\d{2}) \((\d{4})\)/g)].map((m) => [sheetMoney(m[1] as string), Number(m[2])]);
      expect(p.length).toBe(3);
      const mine = [
        [r.endingReal.p10, r.endingReal.startYearOfEach.p10],
        [r.endingReal.p50, r.endingReal.startYearOfEach.p50],
        [r.endingReal.p90, r.endingReal.startYearOfEach.p90],
      ];
      p.forEach(([value, year], i) => {
        const [v, y] = mine[i] as [number, number];
        expect(y).toBe(year);
        expect(Math.abs(v - (value as number))).toBeLessThanOrEqual(TOLERANCE);
      });
    }
  });

  it("equals the spot values of r3.md §4", () => {
    // r3.md §4 "Spot values": [stock bp, start year, nominal end, today's dollars].
    const spots: Array<[number, number, number, number]> = [
      [5000, 1928, 1_756_469.89, 1_069_960.25],
      [5000, 1982, 12_134_994.85, 5_054_626.07],
      [7500, 1929, 466_954.35, 276_294.08],
      [7500, 1973, 1_183_999.2, 278_163.95],
      [7500, 1982, 13_690_993.58, 5_702_750.93],
    ];
    for (const [bp, year, nominal, real] of spots) {
      const s = run(bp).samples.find((x) => x.startYear === year);
      expect(s, `${bp} ${year}`).toBeDefined();
      expect(Math.abs((s?.endNominal ?? NaN) - nominal)).toBeLessThanOrEqual(TOLERANCE);
      expect(Math.abs((s?.endReal ?? NaN) - real)).toBeLessThanOrEqual(TOLERANCE);
    }
    expect(run(5000).samples.find((x) => x.startYear === 1928)?.cpiEnd).toBe(1.641622);
  });

  it("HC-E1 the 1966 path at 50% stocks follows r3.md §3 and fails in plan year 24 short by 14,686.68", () => {
    // (1,000,000 − 40,000) × (1 + 0.5 × (−0.099710) + 0.5 × 0.029079) = 960,000 × 0.9646845 = 926,097.12.
    const [table] = tablesStartingWith(sheetText("r3"), "| Year | Start balance |");
    const rows = (table as Table).rows.filter((r) => r[0] !== "…");
    expect(rows.length).toBe(7);
    for (const [year, start, need, ret, end, inflation] of rows as Array<[string, string, string, string, string, string]>) {
      const mine = r3.path1966.find((y) => y.dataYear === Number(year));
      expect(mine, year).toBeDefined();
      const m = mine as (typeof r3.path1966)[number];
      expect(Math.abs(m.startBalance - sheetMoney(start))).toBeLessThanOrEqual(TOLERANCE);
      expect(Math.abs(m.need - sheetMoney(need.split(" ")[0] as string))).toBeLessThanOrEqual(TOLERANCE);
      expect(Math.abs(m.endBalance - sheetMoney(end))).toBeLessThanOrEqual(TOLERANCE);
      // Percentages to four decimals: within half a unit of the last printed digit.
      const percent = (cell: string): number => Number(cell.replace("−", "-").replace("+", "").replace("%", ""));
      expect(Math.abs(m.inflation * 100 - percent(inflation))).toBeLessThanOrEqual(0.00005 + 1e-9);
      if (ret !== "") expect(Math.abs(m.portfolioReturn * 100 - percent(ret))).toBeLessThanOrEqual(0.00005 + 1e-9);
    }
    const fail = r3.path1966.find((y) => y.shortfall > 0);
    expect(fail?.dataYear).toBe(1990);
    expect(fail?.shortfall).toBe(14_686.68);
    expect(run(5000).failures.find((f) => f.startYear === 1966)?.failIndex).toBe(24);
  });

  it("D18: the Trinity convention gives 37 and 38 of 39, within 5 points of the study's 95% and 98%", () => {
    const published = JSON.parse(fixture("published.json")) as Array<{ id: string; value: number; tolerance: number; verified: boolean }>;
    const study = (id: string) => published.find((p) => p.id === id) as (typeof published)[number];
    const trinity = (bp: number) => r3.trinityConvention.runs.find((r) => r.stockBp === bp) as (typeof r3.trinityConvention.runs)[number];
    for (const [bp, id, count] of [
      [5000, "trinity_1998_table3_50_stocks", 37],
      [7500, "trinity_1998_table3_75_stocks", 38],
    ] as const) {
      const t = trinity(bp);
      expect([t.windows, t.startYears[0], t.startYears[1], t.successCount]).toEqual([39, 1928, 1966, count]);
      const p = study(id);
      expect(p.tolerance).toBe(5);
      expect(Math.abs((100 * t.successCount) / t.windows - p.value)).toBeLessThanOrEqual(p.tolerance);
    }
  });

  it("the counts r3.md §4 and §5 give for information: other mixes and all 69 windows", () => {
    // Trinity convention at 100%, 25%, 0% stocks: 37, 28, 4 of 39; engine convention: 64, 51, 27 of 69.
    expect([10000, 2500, 0].map((bp) => r3.trinityConvention.runs.find((r) => r.stockBp === bp)?.successCount)).toEqual([37, 28, 4]);
    expect(r3.engineConvention.otherMixes.map((r) => [r.stockBp, r.successPaths])).toEqual([[10000, 64], [2500, 51], [0, 27]]);
    // The study's convention on the engine's 69 windows: 65 and 68 of 69 (r3.md §5 item 3).
    expect(r3.trinityConvention.onAll69Windows.map((r) => [r.stockBp, r.windows, r.successCount])).toEqual([[5000, 69, 65], [7500, 69, 68]]);
  });
});

// --------------------------------------------------------------------------------------------
// R4

describe("step 22a: R4 (reference/sheets/r4.md)", () => {
  const r4 = JSON.parse(fixture("r4.expected.json")) as {
    paths: number;
    successPaths: number;
    successRate: number;
    toleranceAbs: number;
    medianEndingReal: number;
    medianToleranceRel: number;
    percentilesEndingReal: { p10: number; p25: number; p50: number; p75: number; p90: number };
    parameters: { stocks: { meanBp: number; volBp: number }; inflation: { meanBp: number; volBp: number }; planYears: number };
    spread: {
      runs: number;
      pathsPerRun: number;
      successRate: { min: number; max: number; mean: number; sd: number };
      binomialSd: number;
      medianEndingReal: { min: number; max: number };
      perRun: Array<{ run: number; uniformOffset: number; successPaths: number; successRate: number; medianEndingReal: number }>;
    };
  };

  it("D17: 4,000,000 paths succeed 69.97% ± 1.5 points of the time", () => {
    expect(r4.paths).toBe(R4_LARGE_PATHS);
    expect(r4.successRate).toBe(r4.successPaths / r4.paths);
    expect([r4.toleranceAbs, r4.medianToleranceRel]).toEqual([0.015, 0.08]);
    expect(Math.abs(r4.successRate - 0.6997)).toBeLessThanOrEqual(0.015);
    // Recorded: 0.699367, 0.03 points from the design's 69.97% (the standard error of 4,000,000 paths is 0.023 points).
    expect(Math.abs(r4.successRate - 0.6997)).toBeLessThan(0.001);
  });

  it("D17: the median ending wealth is within 8% of about 337,500; the 10th and 25th percentiles are 0", () => {
    expect(Math.abs(r4.medianEndingReal / 337_500 - 1)).toBeLessThanOrEqual(0.08);
    expect(r4.percentilesEndingReal.p50).toBe(r4.medianEndingReal);
    expect([r4.percentilesEndingReal.p10, r4.percentilesEndingReal.p25]).toEqual([0, 0]);
    // r4.md §3, for information: the 75th percentile is about 1,005,000.
    expect(Math.abs(r4.percentilesEndingReal.p75 / 1_005_000 - 1)).toBeLessThan(0.08);
  });

  it("the parameters are the sheet's (stocks 6% / 12%, inflation 2.5% / 1%, 30 years)", () => {
    expect(r4.parameters.stocks).toEqual({ meanBp: 600, volBp: 1200 });
    expect(r4.parameters.inflation).toEqual({ meanBp: 250, volBp: 100 });
    expect(r4.parameters.planYears).toBe(30);
  });

  it("forty independent 10,000-path runs spread as a binomial would", () => {
    const s = r4.spread;
    expect([s.runs, s.pathsPerRun, s.perRun.length]).toEqual([R4_SPREAD_RUNS, R4_SPREAD_PATHS, R4_SPREAD_RUNS]);
    const rates = s.perRun.map((r) => r.successRate);
    expect([Math.min(...rates), Math.max(...rates)]).toEqual([s.successRate.min, s.successRate.max]);
    s.perRun.forEach((r, j) => {
      expect(r.uniformOffset).toBe(r4SpreadOffset(j));
      expect(r.successRate).toBe(r.successPaths / R4_SPREAD_PATHS);
    });
    // The sample standard deviation of 40 runs is within ±35% of the binomial value about 99% of the time.
    expect(s.successRate.sd / s.binomialSd).toBeGreaterThan(0.65);
    expect(s.successRate.sd / s.binomialSd).toBeLessThan(1.35);
    // Every run lies within the gate's 1.5 points of the large run (about three standard errors).
    for (const r of rates) expect(Math.abs(r - r4.successRate)).toBeLessThanOrEqual(0.015);
  });

  it("spread runs 0 and 39 re-run to the recorded figures", () => {
    for (const j of [0, R4_SPREAD_RUNS - 1]) {
      const again = runR4SpreadRun(j);
      const recorded = r4.spread.perRun[j] as (typeof r4.spread.perRun)[number];
      expect([again.successPaths, again.p50]).toEqual([recorded.successPaths, recorded.medianEndingReal]);
    }
  });

  it("mulberry32: a stream offset equals discarding that many outputs", () => {
    const stepped = new Mulberry32(1);
    for (let k = 0; k < 1000; k++) stepped.nextUint32();
    const jumped = new Mulberry32(1, 1000);
    for (let k = 0; k < 5; k++) expect(jumped.nextUint32()).toBe(stepped.nextUint32());
  });

  it("Box–Muller gives independent standard normals (200,000 pairs)", () => {
    const rng = new Mulberry32(7);
    const n = 200_000;
    let s0 = 0;
    let s1 = 0;
    let q0 = 0;
    let q1 = 0;
    let c = 0;
    for (let k = 0; k < n; k++) {
      const [a, b] = boxMuller(rng);
      s0 += a;
      s1 += b;
      q0 += a * a;
      q1 += b * b;
      c += a * b;
    }
    // Standard errors: mean 1/√n = 0.0022, variance √(2/n) = 0.0032, correlation 0.0022.
    expect(Math.abs(s0 / n)).toBeLessThan(0.01);
    expect(Math.abs(s1 / n)).toBeLessThan(0.01);
    expect(Math.abs(q0 / n - 1)).toBeLessThan(0.015);
    expect(Math.abs(q1 / n - 1)).toBeLessThan(0.015);
    expect(Math.abs(c / n)).toBeLessThan(0.01);
  });

  it("the lognormal parameters give back the arithmetic means and volatilities (r4.md §2)", () => {
    // E[g] = exp(μ + σ²/2) = 1 + A and sd[g] = E[g] × sqrt(exp(σ²) − 1) = S, by construction.
    for (const [meanBp, volBp] of [
      [600, 1200],
      [250, 100],
    ] as const) {
      const { mu, sigma } = lognormalParameters(meanBp, volBp);
      const mean = Math.exp(mu + (sigma * sigma) / 2);
      expect(Math.abs(mean - (1 + meanBp / 10000))).toBeLessThan(1e-12);
      expect(Math.abs(mean * Math.sqrt(Math.exp(sigma * sigma) - 1) - volBp / 10000)).toBeLessThan(1e-12);
    }
  });
});
