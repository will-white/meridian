import { describe, expect, it } from "vitest";
import { EngineInputError, EngineInvariantError } from "./errors.js";
import { PriceLevel } from "@meridian/shared";
import { centsToDollars, dollarsToCents, dollarsToCentsBigInt, priceLevelString } from "./units.js";

describe("T39 cents boundary (engine-and-returns §7)", () => {
  it("T39 centsToDollars", () => {
    expect(centsToDollars("100000000")).toBe(1000000);
    expect(centsToDollars(100000000n)).toBe(1000000);
    expect(centsToDollars("-12345")).toBe(-123.45);
    expect(centsToDollars("0")).toBe(0);
  });

  it("T39 dollarsToCents rounds half away from zero", () => {
    expect(dollarsToCents(0.125)).toBe("13");
    expect(dollarsToCents(-0.125)).toBe("-13");
    expect(dollarsToCents(891635.328)).toBe("89163533");
    expect(dollarsToCents(585613.59)).toBe("58561359");
  });

  it("T39 a negative amount that rounds to zero is \"0\", never \"-0\"", () => {
    expect(dollarsToCents(-0.004)).toBe("0");
    expect(dollarsToCents(-0)).toBe("0");
    expect(dollarsToCentsBigInt(-0.004)).toBe(0n);
  });

  it("T39 the round trip of a stored cents value is exact", () => {
    // T19's ending wealth in today's dollars: "58561359" cents.
    expect(dollarsToCents(centsToDollars("58561359"))).toBe("58561359");
    for (const c of ["1", "-1", "99", "100000001", "-987654321098", "123456789012345"]) {
      expect(dollarsToCents(centsToDollars(c))).toBe(c);
    }
  });
});

describe("K9 cent cases (tax-rmd-ss §7): the 1e-7 guard", () => {
  it("K9 toCents(20325.2032…) is 2032520n", () => {
    // G2's RMD: 500,000 ÷ 24.6 = 20,325.203252… dollars.
    expect(dollarsToCentsBigInt(500000 / 24.6)).toBe(2032520n);
  });

  it("K9 toCents(1.005) is 101n, where the unguarded rounding gives 100", () => {
    // 1.005 in binary64 is 1.00499999999999989…; × 100 = 100.49999999999999, + 0.5 = 100.99999999999999,
    // which floors to 100 without the guard and to 101 once 1e-7 is added.
    expect(Math.floor(Math.abs(1.005) * 100 + 0.5)).toBe(100);
    expect(dollarsToCentsBigInt(1.005)).toBe(101n);
    expect(dollarsToCents(1.005)).toBe("101");
  });

  it("K9 toCents(−1234.565) is −123457n", () => {
    expect(dollarsToCentsBigInt(-1234.565)).toBe(-123457n);
    expect(dollarsToCents(-1234.565)).toBe("-123457");
  });

  it("the string and bigint forms agree", () => {
    for (const x of [0, 0.004, 0.005, 0.015, 1.005, 2.675, -2.675, 1e9 + 0.505, 891635.328, -1234.565]) {
      expect(dollarsToCents(x)).toBe(dollarsToCentsBigInt(x).toString());
    }
  });
});

describe("guards", () => {
  it("a non-finite amount is an engine fault", () => {
    expect(() => dollarsToCents(NaN)).toThrow(EngineInvariantError);
    expect(() => dollarsToCentsBigInt(Infinity)).toThrow(EngineInvariantError);
    expect(() => dollarsToCentsBigInt(-Infinity)).toThrow(/cannot convert/);
  });

  it("a malformed cents string is an input error", () => {
    for (const bad of ["", "1.5", "1e3", " 12", "--1", "abc"]) {
      expect(() => centsToDollars(bad)).toThrow(EngineInputError);
    }
  });
});

describe("engine-02: priceLevelString writes every finite level exactly, half away from zero at the ninth decimal (seams C43)", () => {
  // Expected strings: the exact binary value of each double, rounded half up at the ninth decimal
  // (Python decimal with 400 digits, scratch). Below 9,007,199 the float form of before is kept.
  it("the documented and the large levels", () => {
    expect(priceLevelString(1)).toBe("1.000000000");
    expect(priceLevelString(1.025)).toBe("1.025000000");
    expect(priceLevelString(1.0768906249999999)).toBe("1.076890625");
    expect(priceLevelString(9051906.318045665)).toBe("9051906.318045665");
    expect(priceLevelString(9007199.254740993)).toBe("9007199.254740993");
    expect(priceLevelString(14348907)).toBe("14348907.000000000");
    expect(priceLevelString(123456789012.5)).toBe("123456789012.500000000");
    expect(priceLevelString(3 ** 60)).toBe("42391158275216203520420085760.000000000");
    const top = priceLevelString(Number.MAX_VALUE);
    expect(top.split(".")[0]!).toHaveLength(309);
    expect(top.startsWith("17976931348623157081452742373170435679807056752584499659891747680315726078")).toBe(true);
    for (const level of [9051906.318045665, 14348907, 3 ** 60, 1e300, Number.MAX_VALUE]) expect(PriceLevel.safeParse(priceLevelString(level)).success, `${level}`).toBe(true);
  });

  it("a level below the nine-decimal floor is held at 0.000000001, the smallest positive level the stored form has", () => {
    expect(priceLevelString(1.5e-9)).toBe("0.000000002");
    // The 1e-7 guard of the cents rule (C38) applies at the ninth decimal too: 1.4999999999 + 0.5
    // + 1e-7 ≥ 2, so it rounds up; 1.4999 does not.
    expect(priceLevelString(1.4999999999e-9)).toBe("0.000000002");
    expect(priceLevelString(1.4999e-9)).toBe("0.000000001");
    expect(priceLevelString(9.313225746154785e-10)).toBe("0.000000001");
    expect(priceLevelString(4.656612873077393e-10)).toBe("0.000000001");
    expect(priceLevelString(Number.MIN_VALUE)).toBe("0.000000001");
  });

  it("a level that is not finite or not above 0 is an engine fault", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => priceLevelString(bad), `${bad}`).toThrow(EngineInvariantError);
  });
});
