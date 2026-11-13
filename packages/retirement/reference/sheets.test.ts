import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Phase 4 step 5: the reference sheets are present and parse. They are the only documents the
// independent calculator of step 22 is written from, so their tables must be complete and
// internally consistent. This test checks shape and arithmetic identities only; the figures
// themselves are checked by the three-way agreement of step 22 (sheets, calculator, engine).

const SHEETS = fileURLToPath(new URL("./sheets/", import.meta.url));

function sheet(name: string): string {
  const path = `${SHEETS}${name}.md`;
  expect(existsSync(path), `${name}.md is missing`).toBe(true);
  return readFileSync(path, "utf8");
}

interface Table {
  header: string[];
  rows: string[][];
}

/** The markdown table that follows `<!-- table: id -->`. */
function table(text: string, id: string): Table {
  const lines = text.split("\n");
  const at = lines.indexOf(`<!-- table: ${id} -->`);
  expect(at, `table ${id} not found`).toBeGreaterThanOrEqual(0);
  const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const header = cells(lines[at + 1] ?? "");
  expect(lines[at + 2] ?? "", `table ${id}: separator row`).toMatch(/^\|( *:?-{3,}:? *\|)+$/);
  const rows: string[][] = [];
  for (const line of lines.slice(at + 3)) {
    if (!line.startsWith("|")) break;
    const row = cells(line);
    expect(row.length, `table ${id}: ${line.slice(0, 40)}`).toBe(header.length);
    rows.push(row);
  }
  return { header, rows };
}

const MONEY = /^-?\d{1,3}(,\d{3})*\.\d{2}$/;
const DECIMAL = /^\d+(\.\d+)?$/;
const INTEGER = /^-?\d+$/;

function money(cell: string): number {
  expect(cell).toMatch(MONEY);
  return Number(cell.replace(/,/g, ""));
}

/** Column accessor by header name; every column is money unless named otherwise. */
function columns(t: Table) {
  return (row: string[], name: string): number => {
    const i = t.header.indexOf(name);
    expect(i, `column ${name}`).toBeGreaterThanOrEqual(0);
    return money(row[i] ?? "");
  };
}

function checkCells(t: Table): void {
  for (const row of t.rows) {
    t.header.forEach((name, i) => {
      const cell = row[i] ?? "";
      if (name === "Year") expect(cell).toMatch(/^\d{4}$/);
      else if (name === "Ages" || name === "Filing") expect(cell.length).toBeGreaterThan(0);
      else if (name === "cpiStart" || name === "cpiEnd") expect(cell).toMatch(DECIMAL);
      else if (name.endsWith(" bp")) expect(cell).toMatch(INTEGER);
      else expect(cell, `${name} ${row[0] ?? ""}`).toMatch(MONEY);
    });
  }
}

const near = (a: number, b: number, tol = 0.02) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

function years(t: Table): number[] {
  return t.rows.map((r) => Number(r[0]));
}

describe("reference sheets (step 5)", () => {
  it("are all present", () => {
    for (const name of ["r1", "r2", "r3", "r4", "hand-cases"]) expect(sheet(name).length).toBeGreaterThan(1000);
  });

  for (const [id, first, last, accounts] of [
    ["r1", 2027, 2047, ["Cash", "Taxable", "Pre-tax A", "Pre-tax B"]],
    ["r2", 2027, 2056, ["Cash", "HSA", "Taxable", "Pre-tax 1", "Pre-tax 2", "Roth 1", "Roth 2"]],
  ] as const) {
    describe(id, () => {
      const span = Array.from({ length: last - first + 1 }, (_, k) => first + k);
      const load = () => {
        const text = sheet(id);
        return {
          income: table(text, `${id}.income`),
          withdrawals: table(text, `${id}.withdrawals`),
          tax: table(text, `${id}.tax`),
          ending: table(text, `${id}.ending`),
        };
      };

      it("has one row per plan year in every table, and every cell parses", () => {
        const { income, withdrawals, tax, ending } = load();
        for (const t of [income, withdrawals, tax, ending]) {
          expect(years(t)).toEqual(span);
          checkCells(t);
        }
      });

      it("adds up: withdrawals by account, the cash identity and the roll-forward", () => {
        const { income, withdrawals, tax, ending } = load();
        const inc = columns(income);
        const wd = columns(withdrawals);
        const tx = columns(tax);
        const en = columns(ending);
        let previous = id === "r1" ? 1_790_000 : 1_210_000;
        span.forEach((_, k) => {
          const i = income.rows[k] ?? [];
          const w = withdrawals.rows[k] ?? [];
          const t = tax.rows[k] ?? [];
          const e = ending.rows[k] ?? [];
          const total = wd(w, "Withdrawals total");
          near(accounts.reduce((s, a) => s + wd(w, a), 0), total);
          near(wd(w, "RMD total"), id === "r1" ? wd(w, "RMD A") + wd(w, "RMD B") : wd(w, "RMD 1") + wd(w, "RMD 2"));
          const surplus = id === "r1" ? inc(i, "Surplus saved") : 0;
          near(inc(i, "Income total") + total, tx(t, "Total federal tax") + inc(i, "Funded") + surplus);
          near(previous + surplus - total + en(e, "Growth"), en(e, "End total"));
          near(en(e, "End total real") * Number(e[ending.header.indexOf("cpiEnd")]), en(e, "End total"), 0.05);
          previous = en(e, "End total");
        });
      });
    });
  }

  it("r3 and r4 carry their expected-value tables, marked as unconfirmed", () => {
    for (const id of ["r3", "r4"]) {
      const text = sheet(id);
      expect(table(text, `${id}.expected`).rows.length).toBeGreaterThanOrEqual(2);
      expect(text).toContain("to be confirmed by the independent calculator");
    }
  });

  it("hand-cases.md carries the four re-derived cases", () => {
    const text = sheet("hand-cases");
    for (const [id, value] of [
      ["HC-T15", "37,400.00"],
      ["HC-S3", "36,540.00"],
      ["HC-S3", "37,812.00"],
      ["WD-5", "133,585.74"],
      ["WD-15", "5,560.56"],
    ] as const) {
      expect(text).toContain(`## ${id}.`);
      expect(text).toContain(value);
    }
  });
});
