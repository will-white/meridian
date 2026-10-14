import { describe, expect, it } from "vitest";
import { parseFixed8 } from "./decimal.js";
import {
  EOD_AVAILABLE_AFTER,
  MARKET_TIME_ZONE,
  expectedCloseFor,
  expectedPriceDate,
  flagSuspectBars,
  isSuspectClose,
  mapSymbol,
  parseTiingoCsv,
  type ProviderBar,
} from "./prices.js";

const f = parseFixed8;

/** Prices design §3.3, §3.6, §3.12 and tests 5 and 23. */
describe("expectedPriceDate", () => {
  it("is the last session's close once the New York clock passes 18:30 (prices test 5)", () => {
    expect(MARKET_TIME_ZONE).toBe("America/New_York");
    expect(EOD_AVAILABLE_AFTER).toEqual({ hour: 18, minute: 30 });
    expect(expectedPriceDate(new Date("2026-10-14T21:00:00Z"))).toBe("2026-10-13"); // 17:00 EDT
    expect(expectedPriceDate(new Date("2026-10-14T22:29:00Z"))).toBe("2026-10-13"); // 18:29 EDT
    expect(expectedPriceDate(new Date("2026-10-14T22:30:00Z"))).toBe("2026-10-14"); // 18:30 EDT
    expect(expectedPriceDate(new Date("2026-10-14T23:00:00Z"))).toBe("2026-10-14");
    expect(expectedPriceDate(new Date("2026-10-17T15:00:00Z"))).toBe("2026-10-16"); // Saturday
    expect(expectedPriceDate(new Date("2026-10-19T14:00:00Z"))).toBe("2026-10-16"); // Monday 10:00 ET
    expect(expectedPriceDate(new Date("2026-04-05T20:00:00Z"))).toBe("2026-04-02"); // Easter Sunday; Good Friday closed
    expect(expectedPriceDate(new Date("2027-01-01T23:00:00Z"))).toBe("2026-12-31"); // holiday
    // §3.3 examples on the Mountain clock: Wed 10-14 15:00 MDT → 10-13; 17:00 MDT → 10-14
    expect(expectedPriceDate(new Date("2026-10-14T21:00:00Z"))).toBe("2026-10-13");
    expect(expectedPriceDate(new Date("2026-10-14T23:00:00Z"))).toBe("2026-10-14");
    // standard time: 18:30 EST is 23:30Z
    expect(expectedPriceDate(new Date("2026-11-10T23:29:00Z"))).toBe("2026-11-09");
    expect(expectedPriceDate(new Date("2026-11-10T23:30:00Z"))).toBe("2026-11-10");
  });
  it("caps the expected close for a date at what the feed can have", () => {
    expect(expectedCloseFor("2026-10-16", "2026-10-13")).toBe("2026-10-13");
    expect(expectedCloseFor("2026-10-11", "2026-10-20")).toBe("2026-10-09");
    expect(expectedCloseFor("2026-10-12", "2026-10-20")).toBe("2026-10-12");
    expect(expectedCloseFor("2026-10-13", "2026-10-13")).toBe("2026-10-13");
  });
});

describe("mapSymbol", () => {
  it("upper-cases and swaps dots for dashes unless an override is set (prices test 23)", () => {
    expect(mapSymbol({ ticker: "brk.b", providerSymbol: null })).toBe("BRK-B");
    expect(mapSymbol({ ticker: "brk.b", providerSymbol: "BRKB" })).toBe("BRKB");
    expect(mapSymbol({ ticker: "VTI", providerSymbol: "  " })).toBe("VTI");
    expect(mapSymbol({ ticker: " vti ", providerSymbol: null })).toBe("VTI");
  });
});

const HEADER = "date,close,high,low,open,volume,adjClose,adjHigh,adjLow,adjOpen,adjVolume,divCash,splitFactor";

describe("parseTiingoCsv", () => {
  it("parses, sorts ascending and keeps adjusted closes and split factors (prices test 23)", () => {
    const text = `${HEADER}\n2026-10-13,305.25,306,304,304.5,1000,305.25,306,304,304.5,1000,0.0,1.0\n2026-10-12T00:00:00.000Z,303,304,302,302.5,900,303,304,302,302.5,900,0.0,1.0\n`;
    const r = parseTiingoCsv(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bars).toEqual<ProviderBar[]>([
      { date: "2026-10-12", close: 30_300_000_000n, adjClose: 30_300_000_000n, splitFactor: 100_000_000n },
      { date: "2026-10-13", close: 30_525_000_000n, adjClose: 30_525_000_000n, splitFactor: 100_000_000n },
    ]);
  });
  it("skips an empty close, rounds past 8 decimals, and treats missing optional columns as null", () => {
    const r = parseTiingoCsv(`close,date\n,2026-10-12\n310.123456789,2026-10-13\n`);
    expect(r).toEqual({ ok: true, bars: [{ date: "2026-10-13", close: 31_012_345_679n, adjClose: null, splitFactor: null }] });
    const r2 = parseTiingoCsv(`${HEADER}\n2026-10-13,305.25,,,,,,,,,,,\n`);
    expect(r2).toEqual({ ok: true, bars: [{ date: "2026-10-13", close: 30_525_000_000n, adjClose: null, splitFactor: null }] });
    // half away from zero at the 9th digit
    expect(parseTiingoCsv(`date,close\n2026-10-13,1.000000005\n`)).toEqual({
      ok: true,
      bars: [{ date: "2026-10-13", close: 100_000_001n, adjClose: null, splitFactor: null }],
    });
  });
  it("de-duplicates by date with the last row winning and tolerates a BOM and CRLF", () => {
    const r = parseTiingoCsv(`﻿date,close\r\n2026-10-13,300\r\n2026-10-13,301\r\n`);
    expect(r).toEqual({ ok: true, bars: [{ date: "2026-10-13", close: 30_100_000_000n, adjClose: null, splitFactor: null }] });
  });
  it("fails the whole symbol on a bad cell or a bad date, nothing partial", () => {
    const exp = parseTiingoCsv(`date,close\n2026-10-12,303\n2026-10-13,3.0525e2\n`);
    expect(exp.ok).toBe(false);
    if (!exp.ok) expect(exp.kind).toBe("invalid_response");
    const bad = parseTiingoCsv(`date,close\n2026-13-01,303\n`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.kind).toBe("invalid_response");
    const neg = parseTiingoCsv(`date,close\n2026-10-13,-1\n`);
    expect(neg.ok).toBe(false);
    const text = parseTiingoCsv(`date,close,adjClose\n2026-10-13,300,abc\n`);
    expect(text.ok).toBe(false);
  });
  it("rejects an HTML body (keeping it) and reads an empty body as zero bars", () => {
    const html = "<html><body>Please sign in</body></html>";
    const r = parseTiingoCsv(html);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("invalid_response");
      expect(r.body).toBe(html);
    }
    expect(parseTiingoCsv("")).toEqual({ ok: true, bars: [] });
    expect(parseTiingoCsv(`${HEADER}\n`)).toEqual({ ok: true, bars: [] });
  });
});

describe("suspect closes", () => {
  const prev = { date: "2026-10-12", close: f("100") };
  it("flags a > 50 % move within 7 days with no split (prices §3.6, test 23)", () => {
    expect(isSuspectClose(prev, { date: "2026-10-13", close: f("40"), splitFactor: f("1") })).toBe(true);
    expect(isSuspectClose(prev, { date: "2026-10-13", close: f("40"), splitFactor: null })).toBe(true);
    expect(isSuspectClose(prev, { date: "2026-10-13", close: f("40"), splitFactor: f("0.4") })).toBe(false);
    expect(isSuspectClose(prev, { date: "2026-10-13", close: f("60"), splitFactor: f("1") })).toBe(false); // exactly 40 %
    expect(isSuspectClose(prev, { date: "2026-10-13", close: f("50"), splitFactor: f("1") })).toBe(false); // exactly 50 % is not > 50 %
    expect(isSuspectClose(prev, { date: "2026-10-13", close: f("151"), splitFactor: f("1") })).toBe(true);
    expect(isSuspectClose(prev, { date: "2026-10-13", close: f("150"), splitFactor: f("1") })).toBe(false);
    expect(isSuspectClose({ date: "2026-10-03", close: f("100") }, { date: "2026-10-13", close: f("40"), splitFactor: f("1") })).toBe(false); // 10 days
    expect(isSuspectClose({ date: "2026-10-06", close: f("100") }, { date: "2026-10-13", close: f("40"), splitFactor: f("1") })).toBe(true); // 7 days
    expect(isSuspectClose(null, { date: "2026-10-13", close: f("40"), splitFactor: f("1") })).toBe(false);
  });
  it("flags a batch against the latest stored close, then each bar's predecessor", () => {
    const bars: ProviderBar[] = [
      { date: "2026-10-13", close: f("40"), adjClose: null, splitFactor: f("1") },
      { date: "2026-10-14", close: f("41"), adjClose: null, splitFactor: f("1") },
      { date: "2026-10-15", close: f("100"), adjClose: null, splitFactor: f("1") },
    ];
    expect(flagSuspectBars(bars, prev)).toEqual([true, false, true]);
    expect(flagSuspectBars(bars, null)).toEqual([false, false, true]);
    expect(flagSuspectBars([], prev)).toEqual([]);
  });
});
