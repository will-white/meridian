import { describe, expect, it } from "vitest";
import {
  AMOUNT_MISMATCH_TOLERANCE_CENTS,
  Fixed8String,
  NonNegFixed8String,
  PriceString,
  QuantityString,
  RECONCILE_TOLERANCE_CENTS,
  allocateLargestRemainder,
  amountMismatch,
  centsToFixed8,
  fixed8FromJsonNumber,
  fixed8ToCents,
  formatFixed8,
  impliedPrice,
  matchesToDollar,
  mulToCents,
  parseFixed8,
  parseLooseDecimal,
  percentToPpm,
  ppmToPercent,
  quantityForCents,
  roundDivHalfAway,
  scaleQty,
} from "./decimal.js";

const f = parseFixed8;

/**
 * Every case below is one of the four area designs' hand-calculated examples
 * (imports §3.1 / test 1–3, lots §3.1 / TC1 / TC22 / TC28 / TC2, prices §3.1 / tests 1–3,
 * views §3.1 / test 1), re-run under the plan's unified names. Expectations that changed
 * under the unified rules are marked "re-derived".
 */
describe("parseFixed8 / formatFixed8", () => {
  it("parses canonical and Postgres forms (imports test 1, prices test 1)", () => {
    expect(f("12.345")).toBe(1_234_500_000n);
    expect(f("-0.00000001")).toBe(-1n);
    expect(f("1000")).toBe(100_000_000_000n);
    expect(f("12.50000000")).toBe(1_250_000_000n);
    expect(f("117.57714286")).toBe(11_757_714_286n);
    expect(f("10.5")).toBe(1_050_000_000n);
    expect(f("-0.5")).toBe(-50_000_000n);
    expect(f("123.4")).toBe(12_340_000_000n);
    expect(f("0")).toBe(0n);
  });
  it("rejects more than 8 decimals, exponents, blanks, separators and 13 integer digits", () => {
    for (const bad of ["1.123456789", "1e5", "1e3", "", "1,000", "1234567890123", "310.", "abc", "1.2.3"]) {
      expect(() => f(bad), bad).toThrow();
    }
  });
  it("formats canonically with no trailing zeros and no -0", () => {
    expect(formatFixed8(1_234_500_000n)).toBe("12.345");
    expect(formatFixed8(-1n)).toBe("-0.00000001");
    expect(formatFixed8(100_000_000_000n)).toBe("1000");
    expect(formatFixed8(f("12.50000000"))).toBe("12.5");
    expect(formatFixed8(f("10.50000000"))).toBe("10.5");
    expect(formatFixed8(1_050_000_000n)).toBe("10.5");
    expect(formatFixed8(0n)).toBe("0");
    expect(formatFixed8(-0n)).toBe("0");
    // re-derived: the lots design's TC1 expected "123.40000000"; seams C2 settles on no trailing zeros.
    expect(formatFixed8(f("123.4"))).toBe("123.4");
    expect(formatFixed8(f("-1234.5678"))).toBe("-1234.5678");
    expect(formatFixed8(f("0.1"))).toBe("0.1");
  });
  it("round-trips through parse", () => {
    for (const s of ["12.345", "-0.00000001", "1000", "0", "999999999999.99999999", "-999999999999.99999999"]) {
      expect(formatFixed8(f(s))).toBe(s);
    }
  });
  it("Zod strings are the image of numeric(20,8) (prices test 1)", () => {
    for (const ok of ["310.02", "0", "-2.5", "999999999999.99999999", "12.50000000"]) {
      expect(Fixed8String.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ["310.", "1e3", "1234567890123", "1.123456789", "", "abc", "1,000", " 1"]) {
      expect(Fixed8String.safeParse(bad).success, bad).toBe(false);
    }
    expect(NonNegFixed8String.safeParse("-2.5").success).toBe(false);
    expect(NonNegFixed8String.safeParse("2.5").success).toBe(true);
    expect(QuantityString).toBe(Fixed8String);
    expect(PriceString).toBe(NonNegFixed8String);
  });
});

describe("roundDivHalfAway", () => {
  it("rounds half away from zero (imports test 2, lots TC1)", () => {
    const cases: Array<[bigint, bigint, bigint]> = [
      [5n, 2n, 3n],
      [-5n, 2n, -3n],
      [7n, 2n, 4n],
      [-7n, 2n, -4n],
      [4n, 2n, 2n],
      [1n, 3n, 0n],
      [-1n, 3n, 0n],
      [5n, 4n, 1n],
      [6n, 4n, 2n],
      [-5n, 4n, -1n],
      [0n, 7n, 0n],
    ];
    for (const [n, d, expected] of cases) expect(roundDivHalfAway(n, d), `${n}/${d}`).toBe(expected);
  });
  it("asserts a positive divisor", () => {
    expect(() => roundDivHalfAway(1n, 0n)).toThrow();
    expect(() => roundDivHalfAway(1n, -2n)).toThrow();
  });
});

describe("mulToCents (R1)", () => {
  const cases: Array<[string, string, bigint]> = [
    // imports §3.1 / test 2
    ["12.345", "101.23", 124_968n],
    ["0.5", "10.01", 501n],
    ["3", "33.333333", 10_000n],
    ["3", "33.33333333", 10_000n],
    ["-1.5", "2.01", -302n],
    ["0.001", "0.5", 0n],
    ["1", "0.005", 1n],
    ["2.5", "0.002", 1n],
    ["1.5", "0.01", 2n],
    ["-1.5", "0.01", -2n],
    ["100", "0.00000001", 0n],
    ["150.25", "123.4567", 1_854_937n],
    ["12.5", "123.456", 154_320n],
    ["0.333", "10.01", 333n],
    ["41.2", "210.1234", 865_708n],
    ["0.0523", "236.04", 1_234n],
    ["7", "51.37", 35_959n],
    ["5", "48.123", 24_062n],
    // lots §3.1 / TC1
    ["10.5", "123.456789", 129_630n],
    ["0.33333333", "300", 10_000n],
    ["-2.5", "1.01", -253n],
    ["2.5", "1.01", 253n],
    ["1", "0.00499999", 0n],
    ["2.33333333", "6.01", 1_402n],
    ["3.5", "101.33", 35_466n],
    ["0.25", "55", 1_375n],
    // prices §3.1 / test 2
    ["123.4567", "45.67", 563_827n],
    ["10.5", "117.57714286", 123_456n],
    ["0.5", "0.01", 1n],
    ["-0.5", "0.01", -1n],
    ["0.33333333", "3", 100n],
    ["1.00000001", "0.5", 50n],
    ["0.00000001", "0.00000001", 0n],
    ["0.5", "315.25", 15_763n],
    ["50.123", "505.10", 2_531_713n],
    ["50.123", "502.00", 2_516_175n],
    ["50.123", "498.75", 2_499_885n],
    ["100", "305.25", 3_052_500n],
    ["999999.99999999", "999999.99999999", 99_999_999_999_998n],
    // views §3.1 / test 1
    ["40", "312.50", 1_250_000n],
    ["0.00000001", "312.50", 0n],
    ["3", "0.005", 2n],
    ["-3", "0.005", -2n],
    ["100", "42", 420_000n],
  ];
  it.each(cases)("%s × %s → %s cents", (qty, price, expected) => {
    expect(mulToCents(f(qty), f(price))).toBe(expected);
  });
});

describe("quantityForCents (R2)", () => {
  it("divides cents by a price, half away at the 8th place (lots TC1, views test 1)", () => {
    expect(formatFixed8(quantityForCents(100_000n, f("33.333333")))).toBe("30.0000003");
    expect(formatFixed8(quantityForCents(100_000n, f("3")))).toBe("333.33333333");
    expect(formatFixed8(quantityForCents(439_200n, f("312.50")))).toBe("14.0544");
    expect(formatFixed8(quantityForCents(115_040n, f("74.80")))).toBe("15.37967914");
    expect(quantityForCents(0n, f("312.50"))).toBe(0n);
    expect(formatFixed8(quantityForCents(-100_000n, f("3")))).toBe("-333.33333333");
  });
  it("asserts a positive price", () => {
    expect(() => quantityForCents(100n, 0n)).toThrow();
    expect(() => quantityForCents(100n, -1n)).toThrow();
  });
});

describe("impliedPrice (R3)", () => {
  const cases: Array<[bigint, string, string]> = [
    // imports test 3
    [124_968n, "12.345", "101.22964763"],
    [100_000n, "7", "142.85714286"],
    [318_750n, "12.75", "250"],
    [865_708n, "41.2", "210.12330097"],
    [1_234n, "0.0523", "235.94646272"],
    [1_250_000n, "37.123", "336.71847642"],
    [10_000n, "3", "33.33333333"],
    [179_011n, "14.5", "123.45586207"],
    [315_185n, "15", "210.12333333"],
    // lots TC1 (basisPerShare)
    [100_495n, "100", "10.0495"],
    [24_000n, "20", "12"],
    [1_400n, "2.33333333", "6.00000001"],
    // prices test 3
    [123_456n, "10.5", "117.57714286"],
    [1_234_567n, "1234.567", "10"],
    [1_264_800n, "1240", "10.2"],
    [987_654n, "321.123", "30.75625228"],
    [4_567_890n, "1234.5678", "36.99991203"],
    [4_725_000n, "1250", "37.8"],
    [100n, "3", "0.33333333"],
    [1n, "3", "0.00333333"],
    // views test 1
    [420_000n, "100", "42"],
    [1_000_000n, "3", "3333.33333333"],
  ];
  it.each(cases)("%s cents ÷ %s → %s", (cents, qty, expected) => {
    expect(formatFixed8(impliedPrice(cents, f(qty)))).toBe(expected);
  });
  it("uses absolute values and refuses a zero quantity", () => {
    expect(impliedPrice(-124_968n, f("12.345"))).toBe(impliedPrice(124_968n, f("12.345")));
    expect(impliedPrice(124_968n, f("-12.345"))).toBe(impliedPrice(124_968n, f("12.345")));
    expect(() => impliedPrice(100n, 0n)).toThrow();
  });
  it("round-trips to the cent (prices test 3, imports test 3)", () => {
    const roundTrips: Array<[bigint, string]> = [
      [123_456n, "10.5"],
      [987_654n, "321.123"],
      [4_567_890n, "1234.5678"],
      [100n, "3"],
      [10_000n, "3"],
    ];
    for (const [cents, qty] of roundTrips) {
      expect(mulToCents(f(qty), impliedPrice(cents, f(qty))), `${cents} / ${qty}`).toBe(cents);
    }
  });
});

describe("allocateLargestRemainder (R4)", () => {
  it("matches lots TC22", () => {
    expect(allocateLargestRemainder(179_995n, [100n, 20n])).toEqual([149_996n, 29_999n]);
    expect(allocateLargestRemainder(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocateLargestRemainder(10n, [1n, 1n, 1n, 1n])).toEqual([3n, 3n, 2n, 2n]);
    expect(allocateLargestRemainder(0n, [3n, 7n])).toEqual([0n, 0n]);
    expect(allocateLargestRemainder(-179_995n, [100n, 20n])).toEqual([-149_996n, -29_999n]);
    expect(allocateLargestRemainder(174_900n, [20n, 5n])).toEqual([139_920n, 34_980n]);
    expect(() => allocateLargestRemainder(5n, [0n, 0n])).toThrow();
    expect(() => allocateLargestRemainder(5n, [])).toThrow();
  });
  it("gives the extra cent to the largest remainder, ties to the lower index, and always sums to the total", () => {
    expect(allocateLargestRemainder(7n, [1n, 2n])).toEqual([2n, 5n]);
    expect(allocateLargestRemainder(1n, [1n, 1n])).toEqual([1n, 0n]);
    expect(allocateLargestRemainder(5n, [0n, 1n])).toEqual([0n, 5n]);
    const totals = [1n, 2n, 99n, 1_000_001n, -7n, 123_456_789n];
    const weightSets = [[1n, 1n, 1n], [100n, 20n], [3n, 3n, 3n, 1n], [5n, 0n, 7n]];
    for (const t of totals) {
      for (const w of weightSets) {
        const parts = allocateLargestRemainder(t, w);
        expect(parts.length).toBe(w.length);
        expect(parts.reduce((a, b) => a + b, 0n)).toBe(t);
      }
    }
  });
});

describe("scaleQty (R5)", () => {
  it("scales a lot's quantity by the split ratio, half away at the 8th place (lots TC1)", () => {
    expect(formatFixed8(scaleQty(f("15"), 1, 10))).toBe("1.5");
    expect(formatFixed8(scaleQty(f("7"), 1, 3))).toBe("2.33333333");
    expect(formatFixed8(scaleQty(f("10"), 2, 1))).toBe("20");
    expect(formatFixed8(scaleQty(f("0.5"), 3, 2))).toBe("0.75");
    expect(() => scaleQty(f("1"), 0, 1)).toThrow();
    expect(() => scaleQty(f("1"), 1, 0)).toThrow();
    expect(() => scaleQty(f("1"), 1.5, 1)).toThrow();
  });
});

describe("fixed8ToCents / centsToFixed8", () => {
  it("rounds a Fixed8 dollar amount to cents (imports test 2)", () => {
    expect(fixed8ToCents(f("3094.4025"))).toBe(309_440n);
    expect(fixed8ToCents(f("3094.405"))).toBe(309_441n);
    expect(fixed8ToCents(f("-3094.405"))).toBe(-309_441n);
    expect(fixed8ToCents(f("12.34"))).toBe(1_234n);
    expect(fixed8ToCents(f("0.004999"))).toBe(0n);
  });
  it("centsToFixed8 is exact", () => {
    expect(centsToFixed8(15_025n)).toBe(f("150.25"));
    expect(centsToFixed8(-1n)).toBe(f("-0.01"));
    expect(fixed8ToCents(centsToFixed8(223_456n))).toBe(223_456n);
  });
});

describe("parseLooseDecimal", () => {
  it("reads brokerage export forms (imports test 1)", () => {
    expect(parseLooseDecimal("$1,234.50")).toBe(123_450_000_000n);
    expect(parseLooseDecimal("1,234.5")).toBe(123_450_000_000n);
    expect(parseLooseDecimal("(12.5)")).toBe(-1_250_000_000n);
    expect(parseLooseDecimal("12.5-")).toBe(-1_250_000_000n);
    expect(parseLooseDecimal("-12.5")).toBe(-1_250_000_000n);
    expect(parseLooseDecimal("+12.5")).toBe(1_250_000_000n);
    expect(parseLooseDecimal(" 0.0523 ")).toBe(5_230_000n);
    expect(parseLooseDecimal("-4")).toBe(-400_000_000n);
    expect(parseLooseDecimal("12.50000000")).toBe(1_250_000_000n);
    expect(parseLooseDecimal("0.123456789")).toBeUndefined();
    expect(parseLooseDecimal("abc")).toBeUndefined();
    expect(parseLooseDecimal("")).toBeUndefined();
    expect(parseLooseDecimal("1e5")).toBeUndefined();
    expect(parseLooseDecimal("1234567890123")).toBeUndefined();
  });
});

describe("fixed8FromJsonNumber", () => {
  it("accepts shortest round-trip strings with ≤ 8 decimals and never rounds (imports test 1)", () => {
    expect(fixed8FromJsonNumber(41.2)).toBe(4_120_000_000n);
    expect(fixed8FromJsonNumber(210.1234)).toBe(21_012_340_000n);
    expect(fixed8FromJsonNumber(-2)).toBe(-200_000_000n);
    expect(fixed8FromJsonNumber(0)).toBe(0n);
    expect(fixed8FromJsonNumber(1e-9)).toBeUndefined();
    expect(fixed8FromJsonNumber(1e21)).toBeUndefined();
    expect(fixed8FromJsonNumber(0.1 + 0.2)).toBeUndefined();
    expect(fixed8FromJsonNumber(Number.NaN)).toBeUndefined();
    expect(fixed8FromJsonNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("percentToPpm / ppmToPercent", () => {
  it("converts exactly or throws (imports test 1)", () => {
    expect(percentToPpm("0.03")).toBe(300);
    expect(percentToPpm("0.015")).toBe(150);
    expect(percentToPpm("1.25")).toBe(12_500);
    expect(percentToPpm("0")).toBe(0);
    expect(() => percentToPpm("0.00001")).toThrow();
    expect(ppmToPercent(300)).toBe("0.03");
    expect(ppmToPercent(150)).toBe("0.015");
    expect(ppmToPercent(12_500)).toBe("1.25");
    expect(ppmToPercent(0)).toBe("0");
    expect(() => ppmToPercent(1.5)).toThrow();
  });
});

describe("amountMismatch (the 5-cent check)", () => {
  it("matches lots TC28 and TC2's fee-null variant", () => {
    // b2: buy 1 @ 100.00, fee 0, amount −10100 → expected −10000, diff −100, mismatch
    expect(amountMismatch(f("1"), f("100"), 0n, -10_100n)).toEqual({ expectedCents: -10_000n, diffCents: -100n, mismatch: true });
    // s1: sell 1 @ 100.00, fee 0, amount +9997 → expected 10000, diff −3 ≤ 5, no mismatch
    expect(amountMismatch(f("1"), f("100"), 0n, 9_997n)).toEqual({ expectedCents: 10_000n, diffCents: -3n, mismatch: false });
    // TC2 b1 with feeCents null: buy 100 @ 10, amount −100495 → expected −100000, diff −495
    expect(amountMismatch(f("100"), f("10"), null, -100_495n)).toEqual({ expectedCents: -100_000n, diffCents: -495n, mismatch: true });
    // TC2 as stated: fee 495 inside the amount → no mismatch
    expect(amountMismatch(f("100"), f("10"), 495n, -100_495n).mismatch).toBe(false);
    // TC2 s1: sell 120 @ 15, fee 5, amount +179995 → expected 180000 − 5
    expect(amountMismatch(f("120"), f("15"), 5n, 179_995n)).toEqual({ expectedCents: 179_995n, diffCents: 0n, mismatch: false });
  });
  it("matches the imports worked rows", () => {
    // sell 4 × 130, fees 0.02, amount 519.98 (a negative file quantity is taken absolute)
    expect(amountMismatch(f("-4"), f("130"), 2n, 51_998n)).toEqual({ expectedCents: 51_998n, diffCents: 0n, mismatch: false });
    // buy 10 × 123.45, amount −1234.50, fee 0
    expect(amountMismatch(f("10"), f("123.45"), 0n, -123_450n).mismatch).toBe(false);
    // re-derived: the imports mapper's max(100, |A|/100) band becomes 5 cents (seams C3);
    // 12.5 × 123.456 = 1543.20 against $1,600.00 is a mismatch under both rules.
    expect(amountMismatch(f("12.5"), f("123.456"), 0n, -160_000n)).toEqual({ expectedCents: -154_320n, diffCents: -5_680n, mismatch: true });
    // a 6-cent gap is a mismatch; a 5-cent gap is not
    expect(amountMismatch(f("10"), f("123.45"), 0n, -123_456n).mismatch).toBe(true);
    expect(amountMismatch(f("10"), f("123.45"), 0n, -123_455n).mismatch).toBe(false);
    expect(AMOUNT_MISMATCH_TOLERANCE_CENTS).toBe(5n);
  });
});

describe("matchesToDollar", () => {
  it("is |diff| < 100 cents (seams C27)", () => {
    expect(RECONCILE_TOLERANCE_CENTS).toBe(100n);
    expect(matchesToDollar(0n)).toBe(true);
    expect(matchesToDollar(-59n)).toBe(true);
    expect(matchesToDollar(99n)).toBe(true);
    expect(matchesToDollar(-99n)).toBe(true);
    expect(matchesToDollar(100n)).toBe(false);
    expect(matchesToDollar(-100n)).toBe(false);
    expect(matchesToDollar(-1_234n)).toBe(false);
  });
});
