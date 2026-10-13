import { describe, expect, it } from "vitest";
import { guessCsvMapping, mapCsvRows, parseCsv, parseCsvDate, parseLooseMoney } from "./csv.js";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, CRLF and a BOM", () => {
    const text = '﻿Date,Description,Amount\r\n2026-09-01,"King Soopers, Denver",-45.32\r\n2026-09-02,"He said ""hi""",10\n';
    expect(parseCsv(text)).toEqual([
      ["Date", "Description", "Amount"],
      ["2026-09-01", "King Soopers, Denver", "-45.32"],
      ["2026-09-02", 'He said "hi"', "10"],
    ]);
  });
  it("keeps empty trailing fields and skips blank lines", () => {
    expect(parseCsv("a,b,\n\n1,,\n")).toEqual([
      ["a", "b", ""],
      ["1", "", ""],
    ]);
  });
});

describe("parseCsvDate", () => {
  it("parses each supported format", () => {
    expect(parseCsvDate("2026-09-05", "YYYY-MM-DD")).toBe("2026-09-05");
    expect(parseCsvDate("09/05/2026", "MM/DD/YYYY")).toBe("2026-09-05");
    expect(parseCsvDate("9/5/2026", "MM/DD/YYYY")).toBe("2026-09-05");
    expect(parseCsvDate("05/09/2026", "DD/MM/YYYY")).toBe("2026-09-05");
    expect(parseCsvDate("9/5/26", "MM/DD/YY")).toBe("2026-09-05");
    expect(parseCsvDate("2026/09/05", "YYYY/MM/DD")).toBe("2026-09-05");
    expect(parseCsvDate("05-09-2026", "DD-MM-YYYY")).toBe("2026-09-05");
    expect(parseCsvDate("09-05-2026", "MM-DD-YYYY")).toBe("2026-09-05");
    expect(parseCsvDate("Sep 5, 2026", "MMM D, YYYY")).toBe("2026-09-05");
    expect(parseCsvDate("5 Sep 2026", "D MMM YYYY")).toBe("2026-09-05");
  });
  it("rejects impossible dates", () => {
    expect(parseCsvDate("2026-02-30", "YYYY-MM-DD")).toBeUndefined();
    expect(parseCsvDate("", "YYYY-MM-DD")).toBeUndefined();
    expect(parseCsvDate("13/01/2026", "MM/DD/YYYY")).toBeUndefined();
  });
});

describe("parseLooseMoney", () => {
  it("parses bank export styles", () => {
    expect(parseLooseMoney("-45.32")).toBe(-4532n);
    expect(parseLooseMoney("$1,234.56")).toBe(123456n);
    expect(parseLooseMoney("(12.34)")).toBe(-1234n);
    expect(parseLooseMoney("12.34-")).toBe(-1234n);
    expect(parseLooseMoney("12.5")).toBe(1250n);
    expect(parseLooseMoney("7")).toBe(700n);
    expect(parseLooseMoney(" 3.00 CR ")).toBe(300n);
    expect(parseLooseMoney("3.00 DR")).toBe(-300n);
    expect(parseLooseMoney("")).toBeUndefined();
    expect(parseLooseMoney("abc")).toBeUndefined();
  });
});

describe("mapCsvRows", () => {
  const rows = [
    ["Date", "Description", "Debit", "Credit"],
    ["09/01/2026", "KING SOOPERS #0123", "45.32", ""],
    ["09/01/2026", "KING SOOPERS #0123", "45.32", ""],
    ["09/02/2026", "ACME CORP PAYROLL", "", "2500.00"],
    ["bad", "x", "1", ""],
  ];

  it("maps debit/credit columns to signed cents and reports bad rows", async () => {
    const { rows: mapped, errors } = await mapCsvRows(rows, {
      hasHeader: true,
      date: { column: "Date", format: "MM/DD/YYYY" },
      description: { column: "Description" },
      amount: { mode: "split", debitColumn: "Debit", creditColumn: "Credit" },
    });
    expect(mapped.map((r) => [r.date, r.amountCents, r.description])).toEqual([
      ["2026-09-01", -4532n, "KING SOOPERS #0123"],
      ["2026-09-01", -4532n, "KING SOOPERS #0123"],
      ["2026-09-02", 250000n, "ACME CORP PAYROLL"],
    ]);
    expect(errors).toEqual([{ rowIndex: 4, message: 'Unreadable date "bad"' }]);
  });

  it("gives identical rows in one file distinct, stable ids and the same ids on re-import", async () => {
    const mapping = {
      hasHeader: true,
      date: { column: "Date", format: "MM/DD/YYYY" as const },
      description: { column: "Description" },
      amount: { mode: "split" as const, debitColumn: "Debit", creditColumn: "Credit" },
    };
    const a = await mapCsvRows(rows, mapping);
    const b = await mapCsvRows(rows, mapping);
    expect(a.rows[0]!.externalId).not.toBe(a.rows[1]!.externalId);
    expect(a.rows[0]!.externalId.startsWith("csv:")).toBe(true);
    expect(a.rows[1]!.externalId.endsWith(":1")).toBe(true);
    expect(a.rows.map((r) => r.externalId)).toEqual(b.rows.map((r) => r.externalId));
  });

  it("supports a single signed amount column with inversion and index-based columns", async () => {
    const { rows: mapped } = await mapCsvRows(
      [
        ["2026-09-01", "Coffee", "4.50"],
        ["2026-09-02", "Refund", "-4.50"],
      ],
      {
        hasHeader: false,
        date: { column: 0, format: "YYYY-MM-DD" },
        description: { column: 1 },
        amount: { mode: "single", column: 2, invert: true },
      },
    );
    expect(mapped.map((r) => r.amountCents)).toEqual([-450n, 450n]);
  });

  it("uses a bank-provided id column when present", async () => {
    const { rows: mapped } = await mapCsvRows(
      [
        ["Transaction ID", "Date", "Description", "Amount"],
        ["ABC123", "2026-09-01", "Coffee", "-4.50"],
      ],
      {
        hasHeader: true,
        date: { column: "Date", format: "YYYY-MM-DD" },
        description: { column: "Description" },
        amount: { mode: "single", column: "Amount" },
        externalId: { column: "Transaction ID" },
      },
    );
    expect(mapped[0]!.externalId).toBe("csvid:ABC123");
  });
});

describe("guessCsvMapping", () => {
  it("recognizes common bank headers", () => {
    const guess = guessCsvMapping(["Posted Date", "Payee", "Debit", "Credit"], [["09/15/2026", "x", "1.00", ""]]);
    expect(guess).toEqual({
      hasHeader: true,
      date: { column: "Posted Date", format: "MM/DD/YYYY" },
      description: { column: "Payee" },
      amount: { mode: "split", debitColumn: "Debit", creditColumn: "Credit" },
    });
  });
  it("picks ISO dates and a single amount column", () => {
    const guess = guessCsvMapping(["Date", "Description", "Amount", "Memo"], [["2026-09-15", "x", "-1.00", "m"]]);
    expect(guess?.date).toEqual({ column: "Date", format: "YYYY-MM-DD" });
    expect(guess?.amount).toEqual({ mode: "single", column: "Amount", invert: false });
    expect(guess?.memo).toEqual({ column: "Memo" });
  });
  it("returns undefined without a date column", () => {
    expect(guessCsvMapping(["Foo", "Bar"], [])).toBeUndefined();
  });
});
