import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { csvExternalId, csvIdColumnKey, csvIdScheme, csvIdText, mapCsvRows, parseLooseMoney } from "./csv.js";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const MAPPING = { hasHeader: true, date: { column: "Date", format: "YYYY-MM-DD" as const }, description: { column: "Description" }, amount: { mode: "single" as const, column: "Amount" } };

/** Audit batch a10-conformance-ledger: bank CSV ids and amounts (Phase 1 conformance). */
describe("a10-conformance-ledger-02: a CSV row's content id hashes the description as the file has it", () => {
  it("is csv2: + sha256(date|cents|text in lower case with white space collapsed), with no payee heuristics in it", async () => {
    expect(csvIdText("  TACO BELL   1234 CO ")).toBe("taco bell 1234 co");
    expect(await csvExternalId("2026-10-03", -1240n, "TACO BELL 1234 CO", 0)).toBe(`csv2:${sha("2026-10-03|-1240|taco bell 1234 co")}`);
    expect(await csvExternalId("2026-10-03", -1240n, "TACO BELL 1234 CO", 2)).toBe(`csv2:${sha("2026-10-03|-1240|taco bell 1234 co")}:2`);
    // Two descriptions the payee normalizer reads as one merchant are two contents: the id follows the text, not the heuristic.
    expect(await csvExternalId("2026-10-04", -4107n, "SHELL OIL 57444 FORT COLLINS CO", 0)).not.toBe(await csvExternalId("2026-10-04", -4107n, "SHELL OIL 57444", 0));
  });

  it("maps rows to ids from the raw cell, so the sanitizer's rules do not move them, and numbers equal rows in file order", async () => {
    const { rows } = await mapCsvRows(
      [
        ["Date", "Description", "Amount"],
        ["2026-10-08", "BLUE  BOTTLE COFFEE", "-4.50"],
        ["2026-10-08", "Blue Bottle Coffee", "-4.50"],
        ["2026-10-08", "CAFE <b>RIO</b>", "-9.00"],
      ],
      MAPPING,
    );
    const coffee = `csv2:${sha("2026-10-08|-450|blue bottle coffee")}`;
    expect(rows.map((r) => r.externalId)).toEqual([coffee, `${coffee}:1`, `csv2:${sha("2026-10-08|-900|cafe <b>rio</b>")}`]);
    // The stored description is still the sanitized one.
    expect(rows[2]!.description).toBe("CAFE RIO");
  });

  it("names the id schemes", () => {
    expect(csvIdScheme("csvid:REF-1")).toBe("csvid");
    expect(csvIdScheme("csv2:abc:1")).toBe("csv2");
    expect(csvIdScheme("csv:abc")).toBe("csv");
    expect(csvIdScheme("T-100")).toBeUndefined();
    expect(csvIdScheme(null)).toBeUndefined();
  });
});

describe("a10-conformance-ledger-08: an amount with a decimal comma is refused, never read 100 times too large", () => {
  it("refuses a comma before the cents and comma groups that are not thousands", () => {
    for (const raw of ["12,50", "€12,50", "-12,50", "1 234,56", "1.234,56", "12,5", ",50", "1,23,456.00", "(12,50)", "12,50 DR", "1,2345.00"]) {
      expect(parseLooseMoney(raw), raw).toBeUndefined();
    }
  });

  it("still reads thousands separators, signs and currency signs", () => {
    expect(parseLooseMoney("1,234.56")).toBe(123456n);
    expect(parseLooseMoney("$1,234,567.89")).toBe(123456789n);
    expect(parseLooseMoney("1,234")).toBe(123400n);
    expect(parseLooseMoney("-1,000")).toBe(-100000n);
    expect(parseLooseMoney("1 234.56")).toBe(123456n);
    expect(parseLooseMoney("€12.50")).toBe(1250n);
    expect(parseLooseMoney("(1,234.50)")).toBe(-123450n);
  });

  it("says why such an amount was not read", async () => {
    const { rows, errors } = await mapCsvRows(
      [
        ["Date", "Description", "Amount"],
        ["2026-10-08", "BAKERY", "12,50"],
        ["2026-10-09", "GROCER", "-1.234,56"],
        ["2026-10-10", "FUEL", "-41.07"],
      ],
      MAPPING,
    );
    expect(rows.map((r) => r.amountCents)).toEqual([-4107n]);
    expect(errors).toEqual([
      { rowIndex: 1, message: 'Unreadable amount "12,50": a comma before the cents is not read; export the file with a decimal point' },
      { rowIndex: 2, message: 'Unreadable amount "-1.234,56": a comma before the cents is not read; export the file with a decimal point' },
    ]);
  });
});

describe("a10-conformance-ledger-02, second round: a bank id names its id column", () => {
  const header = ["Date", "Description", "Amount", "Reference", "Transaction ID"];
  const lines = [
    ["2026-10-03", "TACO BELL 1234 CO", "-12.40", "REF-1", "9001"],
    ["2026-10-04", "SHELL OIL 57444 FORT COLLINS CO", "-41.07", "REF-2", "9002"],
  ];

  it("is csvid2:<column as a mapping matches it>:<the file's id>, so two id columns of one file are two schemes", async () => {
    const byReference = await mapCsvRows([header, ...lines], { ...MAPPING, externalId: { column: "Reference" } });
    const byTransactionId = await mapCsvRows([header, ...lines], { ...MAPPING, externalId: { column: "transaction id" } });
    const byPosition = await mapCsvRows([header, ...lines], { ...MAPPING, externalId: { column: 4 } });
    expect(byReference.rows.map((r) => r.externalId)).toEqual(["csvid2:reference:REF-1", "csvid2:reference:REF-2"]);
    expect(byTransactionId.rows.map((r) => r.externalId)).toEqual(["csvid2:transaction id:9001", "csvid2:transaction id:9002"]);
    // The column by its position is the same column by its name.
    expect(byPosition.rows.map((r) => r.externalId)).toEqual(byTransactionId.rows.map((r) => r.externalId));
    expect(csvIdScheme("csvid2:reference:REF-1")).toBe("csvid2:reference");
    expect(csvIdScheme("csvid2:transaction id:9001")).toBe("csvid2:transaction id");
    expect(csvIdScheme("csvid2:reference:A:B")).toBe("csvid2:reference");
  });

  it("names a column without a header by its position, and escapes a colon in a header", async () => {
    const noHeader = await mapCsvRows(lines, { ...MAPPING, hasHeader: false, date: { column: 0, format: "YYYY-MM-DD" }, description: { column: 1 }, amount: { mode: "single", column: 2 }, externalId: { column: 3 } });
    expect(noHeader.rows.map((r) => r.externalId)).toEqual(["csvid2:#3:REF-1", "csvid2:#3:REF-2"]);
    const colon = await mapCsvRows([["Date", "Description", "Amount", "Ref: 100%"], ["2026-10-03", "TACO BELL", "-12.40", "R:1"]], { ...MAPPING, externalId: { column: "Ref: 100%" } });
    expect(colon.rows[0]!.externalId).toBe("csvid2:ref%3A 100%25:R:1");
    expect(csvIdScheme(colon.rows[0]!.externalId)).toBe("csvid2:ref%3A 100%25");
    expect(csvIdColumnKey(undefined, 2)).toBe("#2");
    expect(csvIdColumnKey(["Date", ""], 1)).toBe("#1");
  });
});
