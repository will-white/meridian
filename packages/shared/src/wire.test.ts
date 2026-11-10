import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as contracts from "./api.js";
import { parseCsvDate, parseLooseMoney } from "./csv.js";
import { parseSplitRatio } from "./investmentsCsv.js";
import { RuleActions, RuleConditions } from "./rules.js";
import {
  CentsInput,
  CentsString,
  IsoDateInput,
  IsoDateString,
  looseWireFields,
  MAX_INPUT_CENTS,
  MAX_LIST_ITEMS,
  MonthInput,
  MonthString,
  NonNegCentsInput,
  NonNegCentsString,
} from "./wire.js";

const ok = (schema: z.ZodTypeAny, value: unknown) => schema.safeParse(value).success;

describe("what a caller may send", () => {
  it("dates: real calendar days from 1900-01-01 to 2199-12-31", () => {
    for (const d of ["1900-01-01", "2024-02-29", "2026-11-10", "2199-12-31"]) expect(ok(IsoDateInput, d), d).toBe(true);
    // 2026-13-45 and 2026-02-31 are not days; 2025 is not a leap year; 2100 is not one either (divisible by 100, not 400).
    for (const d of ["2026-13-45", "2026-02-31", "2025-02-29", "2100-02-29", "2026-00-10", "2026-04-31", "0000-00-00", "0001-01-01", "1899-12-31", "2200-01-01", "9999-12-31", "2026-1-1", "2026-11-10T00:00:00Z", ""]) {
      expect(ok(IsoDateInput, d), d).toBe(false);
    }
    expect(IsoDateInput.safeParse("2026-02-31").error?.issues[0]?.message).toBe("a calendar date between 1900-01-01 and 2199-12-31");
    expect(IsoDateInput.safeParse("Feb 31").error?.issues[0]?.message).toBe("YYYY-MM-DD");
  });

  it("months: 1900-01 to 2199-12", () => {
    for (const m of ["1900-01", "2026-11", "2199-12"]) expect(ok(MonthInput, m), m).toBe(true);
    for (const m of ["1899-12", "2200-01", "9999-12", "0001-01", "2026-13", "2026-00", "2026-1"]) expect(ok(MonthInput, m), m).toBe(false);
  });

  it("cents: at most 15 digits, so thousands of the largest amount still fit a bigint column", () => {
    expect(MAX_INPUT_CENTS).toBe(999_999_999_999_999n);
    // 9,223 × 999,999,999,999,999 = 9,222,999,999,999,990,777 < 2^63 − 1 = 9,223,372,036,854,775,807.
    expect(9223n * MAX_INPUT_CENTS).toBe(9_222_999_999_999_990_777n);
    expect(9223n * MAX_INPUT_CENTS < 2n ** 63n - 1n).toBe(true);
    for (const c of ["0", "-1", "999999999999999", "-999999999999999", "000000000000001"]) expect(ok(CentsInput, c), c).toBe(true);
    for (const c of ["1000000000000000", "-1000000000000000", "9223372036854775808", "9".repeat(40), "1.5", "1e3", "", "-", "+1", " 1"]) expect(ok(CentsInput, c), c).toBe(false);
    for (const c of ["0", "999999999999999"]) expect(ok(NonNegCentsInput, c), c).toBe(true);
    for (const c of ["-1", "1000000000000000", ""]) expect(ok(NonNegCentsInput, c), c).toBe(false);
  });

  it("responses stay loose: whatever the database holds serializes", () => {
    expect(ok(CentsString, "9223372036854775807")).toBe(true);
    expect(ok(CentsString, "123456789012345678901234567890")).toBe(true);
    expect(ok(NonNegCentsString, "18446744073709551615")).toBe(true);
    expect(ok(IsoDateString, "0203-11-05")).toBe(true);
    expect(ok(MonthString, "9999-12")).toBe(true);
  });
});

describe("looseWireFields", () => {
  it("finds loose shapes through objects, arrays, optionals, unions, refinements and pipelines", () => {
    const schema = z.object({
      date: IsoDateString,
      nested: z.object({ month: MonthString.optional(), fine: MonthInput }),
      rows: z.array(z.object({ amountCents: CentsString.nullable() })).max(3),
      either: z.union([z.object({ a: NonNegCentsString }), z.object({ b: z.string() })]),
      tagged: z.discriminatedUnion("kind", [z.object({ kind: z.literal("x"), on: IsoDateString }), z.object({ kind: z.literal("y") })]),
      refined: z.object({ at: IsoDateString }).refine(() => true),
      piped: z.string().transform((s) => s.split(",")).pipe(z.array(IsoDateString)),
      map: z.record(z.string(), CentsString),
      withDefault: IsoDateString.default("2026-01-01"),
    });
    expect(looseWireFields(schema)).toEqual([
      "date (IsoDateString)",
      "nested.month (MonthString)",
      "rows[].amountCents (CentsString)",
      "either.a (NonNegCentsString)",
      "tagged.on (IsoDateString)",
      "refined.at (IsoDateString)",
      "piped[] (IsoDateString)",
      "map{} (CentsString)",
      "withDefault (IsoDateString)",
    ]);
    expect(looseWireFields(z.object({ date: IsoDateInput, cents: CentsInput.optional(), months: z.array(MonthInput) }))).toEqual([]);
    expect(looseWireFields(undefined)).toEqual([]);
    expect(looseWireFields(IsoDateString)).toEqual(["(root) (IsoDateString)"]);
  });

  it("every request contract (…Body, …Query, …Params, …Input) uses the bounded shapes only", () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const [name, value] of Object.entries(contracts)) {
      if (!/(Body|Query|Params|Input)(V2)?$/.test(name) || !(value instanceof z.ZodType)) continue;
      checked++;
      for (const field of looseWireFields(value)) offenders.push(`${name}: ${field}`);
    }
    expect(checked).toBeGreaterThan(80);
    expect(offenders).toEqual([]);
    expect(looseWireFields(RuleConditions)).toEqual([]);
  });
});

describe("list limits in request contracts", () => {
  const uuid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  it("caps reorder lists and import choices at MAX_LIST_ITEMS (5,000)", () => {
    expect(MAX_LIST_ITEMS).toBe(5000);
    const ids = (n: number) => Array.from({ length: n }, () => uuid);
    expect(ok(contracts.ReorderRulesBody, { ids: ids(5000) })).toBe(true);
    expect(ok(contracts.ReorderRulesBody, { ids: ids(5001) })).toBe(false);
    expect(ok(contracts.ReorderCategoriesBody, { groupId: null, ids: ids(5001) })).toBe(false);
    expect(ok(contracts.ReorderCategoryGroupsBody, { bucket: "flexible", ids: ids(5001) })).toBe(false);
    const choices = (n: number) => Array.from({ length: n }, (_, rowIndex) => ({ rowIndex }));
    expect(ok(contracts.TradesPreviewBody, { csvText: "a", accountId: uuid, choices: choices(5000) })).toBe(true);
    expect(ok(contracts.TradesPreviewBody, { csvText: "a", accountId: uuid, choices: choices(5001) })).toBe(false);
    expect(ok(contracts.PositionsPreviewBody, { csvText: "a", accountId: uuid, choices: choices(5001) })).toBe(false);
  });

  it("caps tags at 50, cash-flow accounts at 500, and split ratios at 1,000,000 a side", () => {
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
    expect(ok(contracts.UpdateTransactionBody, { tags: tags(50) })).toBe(true);
    expect(ok(contracts.UpdateTransactionBody, { tags: tags(51) })).toBe(false);
    expect(ok(RuleActions, { addTags: tags(50) })).toBe(true);
    expect(ok(RuleActions, { addTags: tags(51) })).toBe(false);
    expect(ok(contracts.CashFlowProjectionBody, { accountIds: Array.from({ length: 501 }, () => uuid) })).toBe(false);
    expect(ok(contracts.RowChoice, { rowIndex: 0, split: { num: 1_000_000, den: 1 } })).toBe(true);
    expect(ok(contracts.RowChoice, { rowIndex: 0, split: { num: 1_000_001, den: 1 } })).toBe(false);
    expect(ok(contracts.RowChoice, { rowIndex: -1 })).toBe(false);
    expect(ok(contracts.RowChoice, { rowIndex: 10_000_001 })).toBe(false);
    expect(ok(RuleConditions, { amount: { minCents: "-999999999999999" } })).toBe(true);
    expect(ok(RuleConditions, { amount: { minCents: "1000000000000000" } })).toBe(false);
  });
});

describe("the same bounds in imported files", () => {
  it("reads an amount of more than 15 digits of cents as unreadable", () => {
    expect(parseLooseMoney("9999999999999.99")).toBe(999_999_999_999_999n);
    expect(parseLooseMoney("(9,999,999,999,999.99)")).toBe(-999_999_999_999_999n);
    expect(parseLooseMoney("0000000000000012.34")).toBe(1234n);
    expect(parseLooseMoney("10000000000000.00")).toBeUndefined();
    expect(parseLooseMoney("-99999999999999999999.00")).toBeUndefined();
    expect(parseLooseMoney("9".repeat(100_000))).toBeUndefined();
  });

  it("reads a date outside 1900 to 2199 as unreadable", () => {
    expect(parseCsvDate("1900-01-01", "YYYY-MM-DD")).toBe("1900-01-01");
    expect(parseCsvDate("12/31/2199", "MM/DD/YYYY")).toBe("2199-12-31");
    expect(parseCsvDate("0203-11-05", "YYYY-MM-DD")).toBeUndefined();
    expect(parseCsvDate("11/05/0203", "MM/DD/YYYY")).toBeUndefined();
    expect(parseCsvDate("01/01/2200", "MM/DD/YYYY")).toBeUndefined();
    expect(parseCsvDate("02/31/2026", "MM/DD/YYYY")).toBeUndefined();
  });

  it("reads a split ratio with a side over 1,000,000 as no ratio", () => {
    expect(parseSplitRatio("2 FOR 1")).toEqual({ num: 2, den: 1 });
    expect(parseSplitRatio("1000000:1")).toEqual({ num: 1_000_000, den: 1 });
    expect(parseSplitRatio("1000001:1")).toBeUndefined();
    expect(parseSplitRatio(`${"9".repeat(30)} FOR 1`)).toBeUndefined();
  });
});
