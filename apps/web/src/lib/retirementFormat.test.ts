import { describe, expect, it } from "vitest";
import {
  ageLabel,
  agePhrase,
  bpExact,
  chartText,
  compactMoney,
  countText,
  csvMoney,
  dollarsInputValue,
  durationText,
  monthText,
  ordinal,
  parseDollarsInput,
  parseSignedPercent,
  parseWholeNumber,
  percentInputValue,
  percentText,
  priceLevelText,
  ratioBp,
  signedPercentText,
  wholeDollars,
} from "./retirementFormat.js";

describe("retirement formatting (integer cents and basis points)", () => {
  it("whole dollars round half away from zero", () => {
    expect(wholeDollars("9600000")).toBe("$96,000");
    expect(wholeDollars("10971428")).toBe("$109,714");
    expect(wholeDollars("10971450")).toBe("$109,715");
    expect(wholeDollars(-150n)).toBe("-$2");
    expect(wholeDollars("0")).toBe("$0");
  });

  it("compact money: $0, $950, $337.3k, $1.2M, $3.4B; a figure that rounds up takes the next unit", () => {
    expect(compactMoney("0")).toBe("$0");
    expect(compactMoney("95000")).toBe("$950");
    expect(compactMoney("33726943")).toBe("$337.3k");
    expect(compactMoney("120000000")).toBe("$1.2M");
    expect(compactMoney("340000000000")).toBe("$3.4B");
    expect(compactMoney("100000000")).toBe("$1M");
    // $999,950.00 rounds to 1,000.0k: shown as $1M, not "$1,000k".
    expect(compactMoney("99995000")).toBe("$1M");
    expect(compactMoney("99950")).toBe("$1k");
    expect(compactMoney("-120000000")).toBe("-$1.2M");
  });

  it("percentages from basis points truncate; the engine's rates are exact; signed changes use the minus sign", () => {
    expect(percentText(350)).toBe("3.5%");
    expect(percentText(400)).toBe("4%");
    expect(percentText(472)).toBe("4.7%");
    expect(percentText(9420, 0)).toBe("94%");
    expect(percentText(9999, 0)).toBe("99%");
    expect(percentText(-185)).toBe("-1.8%");
    expect(bpExact(685)).toBe("6.85%");
    expect(bpExact(-180)).toBe("-1.80%");
    expect(bpExact(5)).toBe("0.05%");
    expect(signedPercentText(-1000)).toBe("−10%");
    expect(signedPercentText(333)).toBe("+3.3%");
    expect(signedPercentText(5)).toBe("0%");
    expect(ratioBp("9600000", "274285700")).toBe(350);
    expect(ratioBp("-1", "3")).toBe(-3333);
    expect(ratioBp("1", "0")).toBeUndefined();
  });

  it("counts, ordinals, ages, months, durations, price levels and CSV money", () => {
    expect(countText(10000)).toBe("10,000");
    expect(countText(-1234567)).toBe("-1,234,567");
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111, 1000].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th", "1,000th"]);
    expect(ageLabel([67])).toBe("67");
    expect(ageLabel([67, 65])).toBe("67 / 65");
    expect(ageLabel([80, 78], [true, false])).toBe("80 / —");
    expect(agePhrase("67")).toBe("Age 67");
    expect(agePhrase("67 / 65")).toBe("Ages 67 / 65");
    expect(monthText("2035-06")).toBe("June 2035");
    expect(monthText("2025-11", true)).toBe("Nov 2025");
    expect(durationText(850)).toBe("850 ms");
    expect(durationText(1960)).toBe("1.9 s");
    expect(durationText(125_000)).toBe("2 min 5 s");
    expect(durationText(null)).toBe("—");
    expect(priceLevelText("1.218402898")).toBe("1.2184");
    expect(priceLevelText("1.000000000")).toBe("1");
    expect(priceLevelText("1.025000000")).toBe("1.025");
    expect(csvMoney("123456")).toBe("1234.56");
    expect(csvMoney("-5")).toBe("-0.05");
    expect(csvMoney(0n)).toBe("0.00");
  });

  it("form inputs: dollars, signed percents and whole numbers, and the text they start with", () => {
    expect(parseDollarsInput("$25,000")).toBe(2_500_000n);
    expect(parseDollarsInput(" 12.5 ")).toBe(1250n);
    expect(parseDollarsInput(".75")).toBe(75n);
    expect(parseDollarsInput("-5")).toBeNull();
    expect(parseDollarsInput("1.234")).toBeNull();
    expect(parseDollarsInput("")).toBeNull();
    expect(dollarsInputValue("350000")).toBe("3500");
    expect(dollarsInputValue("123456")).toBe("1234.56");
    expect(parseSignedPercent("-12.5", -5000, 10000)).toBe(-1250);
    expect(parseSignedPercent("+3.25%", -5000, 10000)).toBe(325);
    expect(parseSignedPercent("−5", -5000, 10000)).toBe(-500);
    expect(parseSignedPercent("101", -5000, 10000)).toBeNull();
    expect(parseSignedPercent("4.123", 0, 10000)).toBeNull();
    expect(percentInputValue(1185)).toBe("11.85");
    expect(percentInputValue(-250)).toBe("-2.5");
    expect(percentInputValue(400)).toBe("4");
    expect(parseWholeNumber("10,000", 100, 100000)).toBe(10000);
    expect(parseWholeNumber("99", 100, 100000)).toBeNull();
    expect(parseWholeNumber("1.5", 0, 10)).toBeNull();
  });

  it("canvas text loses braces and control characters (ECharts reads {a} and {style|text} in labels)", () => {
    expect(chartText("{a|Alex} retires {b}")).toBe("(a|Alex) retires (b)");
    expect(chartText("Sam\u0000\n: Medicare")).toBe("Sam: Medicare");
  });
});
