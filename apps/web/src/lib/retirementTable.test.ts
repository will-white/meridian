import { deflateYearTable, PLANNER_DISCLAIMER, YearTable, type YearRow } from "@meridian/shared";
import { exampleYearRow, exampleYearTable } from "@meridian/shared/src/retirement/testFixtures.js";
import { describe, expect, it } from "vitest";
import { R1_YEAR_TABLE } from "./retirementFixtures.js";
import { eventLabel, isBelowPlan, socialSecurityPartsText, yearDrawer, yearTableColumns, yearTableCsv, yearTableView } from "./retirementTable.js";

const R1_HEADER = [
  "Year",
  "Ages",
  "Phase",
  "Income",
  "Wages",
  "Social Security (Person 1)",
  "Social Security (Person 2)",
  "Pensions and annuities",
  "Rental",
  "Other income",
  "Spending",
  "Planned",
  "Core",
  "Healthcare",
  "Long-term care",
  "Goals",
  "Shortfall",
  "Withdrawals",
  "Withdrawals: Taxable accounts",
  "Withdrawals: Pre-tax accounts",
  "Withdrawals: Roth accounts",
  "Withdrawals: Cash accounts",
  "Withdrawals: cash",
  "Withdrawals: taxable",
  "Withdrawals: pre_tax_a",
  "Withdrawals: pre_tax_b",
  "Withdrawals: roth_a",
  "of which RMD",
  "Withdrawal rate",
  "Roth conversions",
  "Federal tax",
  "Ordinary tax",
  "Capital gains tax",
  "Net investment income tax",
  "Penalties",
  "Payroll tax",
  "Contributions",
  "Employee",
  "Employer",
  "Ending balance",
  "Ending: Taxable accounts",
  "Ending: Pre-tax accounts",
  "Ending: Roth accounts",
  "Ending: Cash accounts",
  "Ending: cash",
  "Ending: taxable",
  "Ending: pre_tax_a",
  "Ending: pre_tax_b",
  "Ending: roth_a",
  "Inflation index",
  "Return",
  "Events",
].join(",");

describe("yearTableCsv (strategies-outputs-web §5.5 item 6)", () => {
  const csv = yearTableCsv(R1_YEAR_TABLE, { dollars: "today" });
  const lines = csv.split("\r\n");

  it("UI-4 R1's table in today's dollars: 21 data rows, the header of the expanded groups, the disclaimer as the last line", () => {
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(lines.at(-1)).toBe("");
    const body = lines.slice(0, -1);
    expect(body[0]).toBe(R1_HEADER);
    const data = body.slice(1, -2);
    expect(data).toHaveLength(21);
    expect(data.map((l) => l.split(",")[0])).toEqual(Array.from({ length: 21 }, (_, i) => String(2027 + i)));
    for (const line of data) expect(line.split(",")).toHaveLength(R1_HEADER.split(",").length);
    expect(body.at(-2)).toBe("Amounts in today's dollars (the price level at the plan start).");
    // The disclaimer has a comma, so it is one quoted field (RFC 4180).
    expect(body.at(-1)).toBe(`"${PLANNER_DISCLAIMER}"`);
  });

  it("UI-4 the 2027 row (price level 1 at the start, 1.025 at the end) and the 2047 row ending at 1,114,680.94 today's dollars", () => {
    const at = (line: string, column: string) => line.split(",")[R1_HEADER.split(",").indexOf(column)];
    const first = lines[1]!;
    // 2027 flows deflate at 1: Sam's pension 12,000.00; 40,000.00 from cash and 82,696.00 from the
    // taxable account; spending 130,000.00; tax 4,696.00; the 80,000.00 conversion; rate 685 bp (OUT-9).
    expect(at(first, "Ages")).toBe("65 / 65");
    expect(at(first, "Phase")).toBe("Retirement");
    expect(at(first, "Income")).toBe("12000.00");
    expect(at(first, "Pensions and annuities")).toBe("12000.00");
    expect(at(first, "Withdrawals")).toBe("122696.00");
    expect(at(first, "Withdrawals: cash")).toBe("40000.00");
    expect(at(first, "Withdrawals: taxable")).toBe("82696.00");
    expect(at(first, "Spending")).toBe("130000.00");
    expect(at(first, "Federal tax")).toBe("4696.00");
    expect(at(first, "Roth conversions")).toBe("80000.00");
    expect(at(first, "Withdrawal rate")).toBe("6.85%");
    // Ending balances deflate at 1.025: the engine's own total, 1,750,669.20 ÷ 1.025 = 1,707,969.95.
    expect(at(first, "Ending balance")).toBe("1707969.95");
    expect(at(first, "Inflation index")).toBe("1.025000000");
    const last = lines[21]!;
    expect(at(last, "Year")).toBe("2047");
    expect(at(last, "Ages")).toBe("85 / 85");
    expect(at(last, "Ending balance")).toBe("1114680.94");
    // The by-account real balances add up to it (OUT-7's property, absorbed by addUp).
    const accounts = ["Ending: cash", "Ending: taxable", "Ending: pre_tax_a", "Ending: pre_tax_b", "Ending: roth_a"].map((c) => BigInt(at(last, c)!.replace(".", "")));
    expect(accounts.reduce((s, v) => s + v, 0n)).toBe(111468094n);
  });

  it("nominal dollars: the stored cents; the unit line says so", () => {
    const nominal = yearTableCsv(R1_YEAR_TABLE, { dollars: "nominal" }).split("\r\n");
    const endingColumn = R1_HEADER.split(",").indexOf("Ending balance");
    expect(nominal[1]!.split(",")[endingColumn]).toBe("1750669.20");
    expect(nominal[21]!.split(",")[endingColumn]).toBe("1872197.87");
    expect(nominal.at(-3)).toBe("Amounts in nominal dollars.");
  });

  it("names are quoted when needed and never start a spreadsheet formula", () => {
    const table = exampleYearTable();
    const hostile = YearTable.parse({ ...table, accounts: [{ ...table.accounts[0]!, name: '=HYPERLINK("http://x","Roth, IRA")' }] });
    const header = yearTableCsv(hostile, { dollars: "nominal", people: ["-Alex"] }).split("\r\n")[0]!;
    expect(header).toContain('"Withdrawals: =HYPERLINK(""http://x"",""Roth, IRA"")"');
    expect(header).toContain("Social Security (-Alex)");
    const top = yearTableCsv(YearTable.parse({ ...table, rows: [{ ...exampleYearRow(), strategy: { events: ["cut", "freeze"], withdrawalRateBp: 400 } }] }), {
      dollars: "nominal",
      strategy: { kind: "guardrails", upperBandBp: 2000, lowerBandBp: 2000, cutBp: 1000, raiseBp: 1000, skipInflationAfterLoss: true, preservationCutoffYears: 15, planningAge: 95 },
    });
    expect(top.split("\r\n")[1]!.endsWith(",cut 10%; raise skipped")).toBe(true);
  });
});

describe("yearTableView: columns, tones and chips", () => {
  it("collapsed groups show their headline only; expanding a group adds its detail", () => {
    const collapsed = yearTableView(R1_YEAR_TABLE, { dollars: "nominal", expanded: new Set() });
    expect(collapsed.columns.map((c) => c.label)).toEqual(["Year", "Ages", "Phase", "Income", "Spending", "Withdrawals", "Roth conversions", "Federal tax", "Contributions", "Ending balance", "Inflation index", "Return"]);
    const taxes = yearTableView(R1_YEAR_TABLE, { dollars: "nominal", expanded: new Set(["taxes"]) });
    expect(taxes.columns.filter((c) => c.group === "taxes").map((c) => c.label)).toEqual(["Federal tax", "Ordinary tax", "Capital gains tax", "Net investment income tax", "Penalties", "Payroll tax"]);
    expect(collapsed.rows[0]!.cells).toEqual(["2027", "65 / 65", "Retirement", "$12,000.00", "$130,000.00", "$122,696.00", "$80,000.00", "$4,696.00", "$0.00", "$1,750,669.20", "1.025", "5.00%"]);
    // R1's fixed model returns 5% on stocks: growth 83,365.20 ÷ (1,750,669.20 − 83,365.20) = 0.05 → 500 bp.
    // R1 is funded every year with no shortfall, no below-plan year and no event.
    expect(collapsed.rows.every((r) => r.tone === undefined && r.events.length === 0)).toBe(true);
    expect(collapsed.firstShortfallYear).toBeUndefined();
  });

  it("the first shortfall year is 'money ran out' in the bad tone, later ones tinted, below-plan years warned", () => {
    const base = exampleYearRow();
    const row = (year: number, patch: Partial<YearRow>): YearRow => ({ ...base, year, ...patch });
    const short = { ...base.spending, funded: "3000000", core: "3000000", shortfall: "1000000" };
    const table = YearTable.parse({
      ...exampleYearTable(),
      rows: [
        row(2027, {}),
        row(2028, { spending: { ...base.spending, funded: "3900000", core: "3900000" } }),
        row(2029, { spending: short, failed: true }),
        row(2030, { spending: short, failed: true }),
      ],
    });
    const view = yearTableView(table, { dollars: "nominal", expanded: "all" });
    expect(view.rows.map((r) => [r.tone, r.flag])).toEqual([
      [undefined, undefined],
      ["warn", undefined],
      ["bad", "money ran out"],
      ["bad_tint", undefined],
    ]);
    expect(view.firstShortfallYear).toBe(2029);
    // One cent below plan is rounding, not "below plan" (the shared pathStory's tolerance).
    expect(isBelowPlan({ ...base, spending: { ...base.spending, funded: "3999999", core: "3999999" } })).toBe(false);
    expect(isBelowPlan({ ...base, phase: "accumulation", spending: { ...base.spending, funded: "0", core: "0" } })).toBe(false);
  });

  it("event chips in words, with the strategy's own figures", () => {
    expect(eventLabel("freeze")).toBe("raise skipped");
    expect(eventLabel("cut")).toBe("cut");
    expect(eventLabel("raise", { kind: "guardrails", upperBandBp: 2000, lowerBandBp: 2000, cutBp: 1000, raiseBp: 1250, skipInflationAfterLoss: true, preservationCutoffYears: 15, planningAge: 95 })).toBe("raise 12.5%");
    expect(eventLabel("cap", { kind: "vpw", stockRealBp: 500, bondRealBp: 190, lastWithdrawalAge: 99, maxRateBp: 1000 })).toBe("capped at 10%");
    expect(eventLabel("band_floor")).toBe("at the floor");
    expect(eventLabel("band_ceiling")).toBe("at the ceiling");
    expect(eventLabel("essentials")).toBe("held at essentials");
    expect(eventLabel("topped_up")).toBe("topped up to essentials");
    expect(eventLabel("rmd_excess")).toBe("RMD above the rule");
  });

  it("a column per person and per account; a bucket with no account has none", () => {
    const labels = yearTableColumns(R1_YEAR_TABLE, ["Pat", "Lee"]).map((c) => c.label);
    expect(labels).toContain("Social Security (Pat)");
    expect(labels).toContain("Social Security (Lee)");
    expect(labels.some((l) => l.includes("HSA"))).toBe(false);
  });
});

describe("yearDrawer (§5.5 item 7, C37, C52)", () => {
  it("R1 2027 by hand: 12,000 + 40,000 + 82,696 came in; 4,696 tax and 130,000 spending went out; the tax lists", () => {
    const d = yearDrawer(R1_YEAR_TABLE.rows[0]!, R1_YEAR_TABLE.accounts);
    expect(d.cash.sources).toEqual([
      { label: "Pensions and annuities", cents: "1200000" },
      { label: "Withdrawn from cash", cents: "4000000" },
      { label: "Withdrawn from taxable", cents: "8269600" },
    ]);
    expect(d.cash.uses).toEqual([
      { label: "Federal tax", cents: "469600" },
      { label: "Spending", cents: "13000000" },
    ]);
    expect(d.cash.sourcesTotal).toBe("13469600");
    expect(d.cash.usesTotal).toBe("13469600");
    expect(d.cash.balanced).toBe(true);
    expect(d.cash.unexplainedCents).toBeUndefined();
    // Taxed on: the pension, the 80,000 conversion and 31,011 of realized gains; AGI 123,011;
    // deductions 36,600 + 12,000 (senior); taxable income 74,411 = 43,400 ordinary + 31,011 at 0%.
    expect(d.tax.income).toEqual([
      { label: "Pensions and annuities", cents: "1200000" },
      { label: "Roth conversions", cents: "8000000" },
      { label: "Realized gains", cents: "3101100" },
    ]);
    expect(d.tax.computation).toEqual([
      { label: "Adjusted gross income", cents: "12301100" },
      { label: "Standard deduction", cents: "3660000" },
      { label: "Senior deduction", cents: "1200000" },
      { label: "Taxable income", cents: "7441100" },
      { label: "taxed as ordinary income", cents: "4340000", indent: true },
      { label: "gains and qualified dividends at 0%", cents: "3101100", indent: true },
    ]);
    expect(d.tax.taxes.reduce((s, l) => s + BigInt(l.cents), 0n)).toBe(BigInt(d.tax.totalCents));
    expect(d.tax.totalCents).toBe("469600");
    // 469,600 × 10000 ÷ 12,301,100 = 381.75 → 381 bp, truncated.
    expect(d.tax.effectiveRateBp).toBe(381);
    expect(d.tax.bracketRateBp).toBe(1200);
    expect(d.tax.payroll.cents).toBe("0");
    expect(d.tax.footnote).toBe("State tax, IRMAA and ACA subsidies are not modelled in this version.");
  });

  it("R1 2037: the RMDs are marked, and the taxable part of Social Security carries its share", () => {
    const d = yearDrawer(R1_YEAR_TABLE.rows[10]!, R1_YEAR_TABLE.accounts, ["Pat", "Lee"]);
    expect(d.cash.sources.slice(0, 2)).toEqual([
      { label: "Social Security (Pat)", cents: "4606800" },
      { label: "Social Security (Lee)", cents: "2763600" },
    ]);
    expect(d.cash.sources.find((l) => l.label === "Withdrawn from pre_tax_a")).toEqual({ label: "Withdrawn from pre_tax_a", cents: "5344991", detail: "of which RMD $31,756.54" });
    expect(d.tax.income.find((l) => l.label === "Pre-tax withdrawals")).toEqual({ label: "Pre-tax withdrawals", cents: "7586898", detail: "of which RMD $45,076.52" });
    // 6,264,840 ÷ (4,606,800 + 2,763,600) = 0.85 → 8500 bp.
    expect(d.tax.income.at(-1)).toEqual({ label: "of which taxable", cents: "6264840", indent: true, detail: "85% of benefits" });
  });

  it("every R1 row, in both units: the two lists add up to the same total, within a cent of rounding absorbed", () => {
    for (const table of [R1_YEAR_TABLE, deflateYearTable(R1_YEAR_TABLE)]) {
      for (const row of table.rows) {
        const d = yearDrawer(row, table.accounts);
        const sum = (lines: ReadonlyArray<{ cents: string }>) => lines.reduce((s, l) => s + BigInt(l.cents), 0n);
        expect(d.cash.balanced, `${row.year}`).toBe(true);
        expect(d.cash.unexplainedCents, `${row.year}`).toBeUndefined();
        expect(sum(d.cash.sources), `${row.year}`).toBe(BigInt(d.cash.sourcesTotal));
        expect(sum(d.cash.uses), `${row.year}`).toBe(BigInt(d.cash.sourcesTotal));
      }
    }
  });

  it("an accumulation row lists both sides with the note instead of an equality (C52)", () => {
    const row: YearRow = { ...exampleYearRow(), phase: "accumulation", income: { ...exampleYearRow().income, wages: "9000000", total: "9000000" } };
    const d = yearDrawer(row, exampleYearTable().accounts);
    expect(d.cash.balanced).toBe(false);
    expect(d.cash.note).toBe("Spending is not modelled before retirement: income less tax and contributions is not tracked.");
    expect(d.cash.uses.map((l) => l.label)).toEqual(["Goals"]);
  });

  it("a first drawdown year with months before spending started: the pre-start tax and take-home are their own lines", () => {
    const base = exampleYearRow();
    // Wages 72,000: 30,000 in the months before spending started (tax 5,000 on them, take-home
    // 25,000) and a working spouse's 42,000 after. Nothing withdrawn; tax 12,000 in all; spending
    // 40,000. 72,000 = (12,000 − 5,000) + 40,000 + 25,000.
    const row: YearRow = {
      ...base,
      phase: "transition",
      income: { ...base.income, wages: "7200000", total: "7200000" },
      withdrawals: { byAccount: ["0"], byBucket: { taxable: "0", pre_tax: "0", roth: "0", hsa: "0", cash: "0" }, total: "0", rmdByAccount: ["0"], rmdTotal: "0" },
      tax: { ...base.tax, totalFederalCents: "1200000", incomeTaxCents: "1200000", ordinaryTaxCents: "1200000" },
      preStart: { takeHome: "2500000", tax: "500000" },
    };
    const d = yearDrawer(row, exampleYearTable().accounts);
    expect(d.cash.sources).toEqual([{ label: "Wages", cents: "7200000" }]);
    expect(d.cash.uses).toEqual([
      { label: "Federal tax (on the months after spending started)", cents: "700000" },
      { label: "Spending", cents: "4000000" },
      { label: "Take-home pay before spending started", cents: "2500000" },
    ]);
    expect(d.cash.usesTotal).toBe("7200000");
    expect(d.cash.balanced).toBe(true);
    expect(d.cash.unexplainedCents).toBeUndefined();
    // A row that does not add up beyond rounding shows the difference rather than hiding it.
    const off = yearDrawer({ ...row, surplusSaved: "100" }, exampleYearTable().accounts);
    expect(off.cash.unexplainedCents).toBe("-100");
    expect(off.cash.uses.at(-1)).toEqual({ label: "Not accounted for", cents: "-100" });
  });

  it("C37: a benefit's spousal and survivor parts and the earnings test's withholding are named; a benefit withheld whole keeps its line", () => {
    const base = exampleYearRow();
    const row: YearRow = {
      ...base,
      ages: [65, 63],
      alive: [true, true],
      income: {
        ...base.income,
        socialSecurity: ["2400000", "0"],
        socialSecurityParts: [
          { spousal: "540000", survivor: "0", withheld: "0" },
          { spousal: "0", survivor: "0", withheld: "1800000" },
        ],
        total: "2400000",
      },
    };
    const d = yearDrawer(row, exampleYearTable().accounts, ["Alex", "Sam"]);
    expect(d.cash.sources.slice(0, 2)).toEqual([
      { label: "Social Security (Alex)", cents: "2400000", detail: "includes $5,400.00 spousal" },
      { label: "Social Security (Sam)", cents: "0", detail: "$18,000.00 withheld by the earnings test" },
    ]);
    expect(socialSecurityPartsText({ spousal: "100", survivor: "200", withheld: "300" })).toBe("includes $1.00 spousal and $2.00 survivor; $3.00 withheld by the earnings test");
    expect(socialSecurityPartsText({ spousal: "0", survivor: "0", withheld: "0" })).toBeUndefined();
  });
});
