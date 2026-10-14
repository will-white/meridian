import { describe, expect, it } from "vitest";
import { parseFixed8 } from "./decimal.js";
import { INVESTMENT_ACCOUNT_TYPES, isInvestmentAccountType } from "./enums.js";
import {
  accountFidelity,
  classifyInvestmentInflow,
  deriveFidelity,
  guessSecurityHints,
  isCashKey,
  normalizeCusip,
  normalizeIsin,
  normalizeName,
  normalizeTicker,
  periodStart,
  returnReasonText,
  tradeExternalId,
  tradeSecurityKey,
} from "./investments.js";

const f = parseFixed8;

describe("security identity (imports §3.2, test 19)", () => {
  it("normalizes tickers and refuses names in a symbol column", () => {
    expect(normalizeTicker("spaxx**")).toBe("SPAXX");
    expect(normalizeTicker("$SPAXX")).toBe("SPAXX");
    expect(normalizeTicker(" vti ")).toBe("VTI");
    expect(normalizeTicker("BRK.B")).toBe("BRK.B");
    expect(normalizeTicker("brk-b")).toBe("BRK-B");
    expect(normalizeTicker("VANGUARD TARGET 2045 TRUST")).toBeNull();
    expect(normalizeTicker("")).toBeNull();
    expect(normalizeTicker(null)).toBeNull();
    expect(normalizeTicker("**")).toBeNull();
    expect(normalizeTicker("ABCDEFGHIJKLM")).toBeNull(); // 13 characters
    expect(normalizeTicker("<b>vti</b>")).toBe("VTI");
  });
  it("normalizes names to match the expression index", () => {
    expect(normalizeName("Fidelity 500 Index Pool Class K")).toBe("FIDELITY 500 INDEX POOL CLASS K");
    expect(normalizeName("FIDELITY 500 INDEX POOL - CLASS K")).toBe("FIDELITY 500 INDEX POOL CLASS K");
    expect(normalizeName("  Vanguard Total Stock Market ETF ")).toBe("VANGUARD TOTAL STOCK MARKET ETF");
    expect(normalizeName("S&P 500")).toBe("S P 500");
    expect(normalizeName(null)).toBe("");
  });
  it("normalizes CUSIP and ISIN by shape", () => {
    expect(normalizeCusip("315911750")).toBe("315911750");
    expect(normalizeCusip(" 3159 11750 ")).toBe("315911750");
    expect(normalizeCusip("31591175")).toBeNull();
    expect(normalizeIsin("us9229087690")).toBe("US9229087690");
    expect(normalizeIsin("US92290876")).toBeNull();
  });
  it("recognises the cash position (imports §3.2 step 1; prices §3.10)", () => {
    expect(isCashKey({ ticker: "CASH" })).toBe(true);
    expect(isCashKey({ ticker: "Cash" })).toBe(true);
    expect(isCashKey({ ticker: "USD" })).toBe(true);
    expect(isCashKey({ ticker: "**CASH**" })).toBe(true);
    expect(isCashKey({ ticker: "Cash & Cash Investments" })).toBe(true);
    expect(isCashKey({ ticker: null, name: "Cash" })).toBe(true);
    expect(isCashKey({ name: "CASH BALANCE" })).toBe(true);
    expect(isCashKey({ name: "Core Cash" })).toBe(true);
    expect(isCashKey({ name: "FDIC Insured Deposit Sweep" })).toBe(true);
    expect(isCashKey({ name: "US Dollars" })).toBe(true);
    expect(isCashKey({ name: "US Dollar" })).toBe(true);
    expect(isCashKey({ name: "Cash and Cash Investments" })).toBe(true);
    expect(isCashKey({ ticker: "SPAXX", name: "FIDELITY GOVERNMENT MONEY MARKET" })).toBe(false);
    expect(isCashKey({ ticker: "VTI", name: "Cash" })).toBe(false); // a usable ticker is never cash by name
    expect(isCashKey({ name: "CASHFLOW FUND" })).toBe(false);
    expect(isCashKey({ name: "VANGUARD TARGET 2045 TRUST" })).toBe(false);
    expect(isCashKey({})).toBe(false);
  });
  it("guesses type and asset class from the name, hints and ticker shape", () => {
    expect(guessSecurityHints({ ticker: "spaxx**" })).toEqual({ type: "fund", assetClass: "cash" }); // core position
    expect(guessSecurityHints({ ticker: "SPAXX", name: "FIDELITY GOVERNMENT MONEY MARKET" })).toEqual({ type: "fund", assetClass: "cash" });
    expect(guessSecurityHints({ name: "Fidelity 500 Index Pool Class K" })).toEqual({ type: "fund", assetClass: "us_stock" });
    expect(guessSecurityHints({ ticker: "VTI", name: "Vanguard Total Stock Market ETF" })).toEqual({ type: "etf", assetClass: "us_stock" });
    expect(guessSecurityHints({ ticker: "VXUS", name: "Vanguard Total International Stock ETF" })).toEqual({ type: "etf", assetClass: "intl_stock" });
    expect(guessSecurityHints({ ticker: "BND", name: "Vanguard Total Bond Market ETF" })).toEqual({ type: "etf", assetClass: "bonds" });
    expect(guessSecurityHints({ ticker: "FXAIX" })).toEqual({ type: "fund", assetClass: "other" }); // 5 letters ending in X, no name
    expect(guessSecurityHints({ ticker: "FXAIX", name: "Fidelity 500 Index Fund" })).toEqual({ type: "fund", assetClass: "us_stock" });
    expect(guessSecurityHints({ ticker: "ZZZZ", name: "UNKNOWN CO" })).toEqual({ type: "stock", assetClass: "other" });
    expect(guessSecurityHints({ ticker: "AAPL", name: "Apple Inc" })).toEqual({ type: "stock", assetClass: "other" });
    expect(guessSecurityHints({ name: "VANGUARD TARGET 2045 TRUST" })).toEqual({ type: "fund", assetClass: "other" });
    expect(guessSecurityHints({ name: "US Treasury Note 4.25% 2030" })).toEqual({ type: "bond", assetClass: "bonds" });
    expect(guessSecurityHints({ name: "Marcus 12-month CD" })).toEqual({ type: "cd", assetClass: "other" });
    expect(guessSecurityHints({ name: "Vanguard Real Estate Index Fund Admiral" })).toEqual({ type: "fund", assetClass: "real_estate" });
    expect(guessSecurityHints({ name: "Schwab Government Money Market Fund" })).toEqual({ type: "fund", assetClass: "cash" });
    // rule order is ETF → money market → CD → bond → fund, so "Treasury" wins the type here while the class is cash
    expect(guessSecurityHints({ name: "Schwab Treasury Only Money Fund" })).toEqual({ type: "bond", assetClass: "cash" });
    expect(guessSecurityHints({ name: "Vanguard Emerging Markets Stock Index Admiral" })).toEqual({ type: "fund", assetClass: "intl_stock" });
    // hints are read for the type; the class still comes from the name
    expect(guessSecurityHints({ ticker: "VOO", name: "Vanguard S&P 500", hints: ["ETF"] })).toEqual({ type: "etf", assetClass: "us_stock" });
    expect(guessSecurityHints({ ticker: "ABC", name: "Acme Corp", hints: ["Stock"] })).toEqual({ type: "stock", assetClass: "other" });
  });
});

describe("fidelity (imports §3.12 test 18; views §3.5)", () => {
  it("derives the level from the flags", () => {
    expect(accountFidelity({ hasTrades: false, hasSnapshots: false })).toBe("balance_only");
    expect(accountFidelity({ hasTrades: false, hasSnapshots: true })).toBe("positions");
    expect(accountFidelity({ hasTrades: true, hasSnapshots: false })).toBe("full_history");
    expect(accountFidelity({ hasTrades: true, hasSnapshots: true })).toBe("full_history");
  });
  it("demotes a full history whose lots do not explain the statement", () => {
    expect(deriveFidelity({ hasTrades: true, hasSnapshots: true, mismatches: [] })).toEqual({ fidelity: "full_history", fidelityNote: null });
    expect(deriveFidelity({ hasTrades: true, hasSnapshots: false, mismatches: [] })).toEqual({
      fidelity: "full_history",
      fidelityNote: "no positions statement to check against",
    });
    expect(
      deriveFidelity({ hasTrades: true, hasSnapshots: true, mismatches: [{ ticker: "VTI", lotsQuantity: f("20"), snapshotQuantity: f("40") }] }),
    ).toEqual({ fidelity: "positions", fidelityNote: "trade history incomplete: VTI lots cover 20 of 40 shares" });
    expect(
      deriveFidelity({
        hasTrades: true,
        hasSnapshots: true,
        mismatches: [
          { ticker: "VTI", lotsQuantity: f("20"), snapshotQuantity: f("40") },
          { ticker: "BND", lotsQuantity: f("0"), snapshotQuantity: f("10.5") },
        ],
      }).fidelityNote,
    ).toBe("trade history incomplete: VTI lots cover 20 of 40 shares (+1 more)");
    expect(deriveFidelity({ hasTrades: false, hasSnapshots: true, mismatches: [] })).toEqual({ fidelity: "positions", fidelityNote: null });
    expect(deriveFidelity({ hasTrades: false, hasSnapshots: false, mismatches: [] })).toEqual({ fidelity: "balance_only", fidelityNote: null });
  });
});

describe("classifyInvestmentInflow (imports §3.11, test 17)", () => {
  it("marks contributions into investment accounts and nothing else", () => {
    expect(classifyInvestmentInflow("401k", "EMPLOYEE PRE-TAX CONTRIBUTION", 50_000n)).toBe("contribution");
    expect(classifyInvestmentInflow("401k", "EMPLOYER MATCH", 25_000n)).toBe("contribution");
    expect(classifyInvestmentInflow("brokerage", "ELECTRONIC FUNDS TRANSFER RECEIVED", 100_000n)).toBe("contribution");
    expect(classifyInvestmentInflow("brokerage", "DIVIDEND RECEIVED VTI", 1_234n)).toBeNull();
    expect(classifyInvestmentInflow("brokerage", "REINVESTMENT", 1_234n)).toBeNull();
    expect(classifyInvestmentInflow("brokerage", "YOU SOLD VTI", 99_860n)).toBeNull();
    expect(classifyInvestmentInflow("checking", "DEPOSIT", 100_000n)).toBeNull();
    expect(classifyInvestmentInflow("ira", "DISTRIBUTION", -200_000n)).toBeNull();
    expect(classifyInvestmentInflow("ira", "Rollover from 401k", 1_000_000n)).toBe("contribution");
    expect(classifyInvestmentInflow("hsa", "payroll deduction", 10_000n)).toBe("contribution");
    expect(classifyInvestmentInflow("roth", "ACH Deposit", 60_000n)).toBe("contribution");
    expect(classifyInvestmentInflow("brokerage", "Deposit interest refund", 100n)).toBeNull(); // exclusions win
    expect(classifyInvestmentInflow("brokerage", "", 100n)).toBeNull();
    expect(classifyInvestmentInflow("529", "Transfer from checking", 50_000n)).toBe("contribution");
    expect(classifyInvestmentInflow("brokerage", "YOU BOUGHT VTI", 100n)).toBeNull();
  });
  it("knows the investment account types", () => {
    expect(INVESTMENT_ACCOUNT_TYPES).toEqual(["brokerage", "401k", "ira", "roth", "hsa", "529"]);
    expect(isInvestmentAccountType("brokerage")).toBe(true);
    expect(isInvestmentAccountType("checking")).toBe(false);
    expect(isInvestmentAccountType("asset")).toBe(false);
  });
});

describe("tradeExternalId (imports §3.8, test 11)", () => {
  it("reproduces the design's SHA-256 ids", async () => {
    expect(await tradeExternalId({ date: "2026-10-01", type: "buy", securityKey: "VTI", quantity: f("10"), amountCents: -250_000n })).toBe(
      "inv:bf027e8fe6751b5f9f78153eb9203337d9c774ca457f722f5e6856f301fa1cf0",
    );
    expect(await tradeExternalId({ date: "2026-10-01", type: "buy", securityKey: "VTI", quantity: f("10"), amountCents: -250_000n }, 1)).toBe(
      "inv:bf027e8fe6751b5f9f78153eb9203337d9c774ca457f722f5e6856f301fa1cf0:1",
    );
    expect(await tradeExternalId({ date: "2026-09-15", type: "dividend", securityKey: "VTI", quantity: null, amountCents: 1_234n })).toBe(
      "inv:1b5dee9faca1b69be9c22b24de4d893acb547d73d083f14dfbb4c5728aa1e294",
    );
    expect(await tradeExternalId({ date: "2026-09-15", type: "reinvest", securityKey: "VTI", quantity: f("0.0523"), amountCents: -1_234n })).toBe(
      "inv:5d65e799012bb0146bb1180d2ca7987ddd9e74db98817d57f22961200c581c2c",
    );
    expect(await tradeExternalId({ date: "2026-10-05", type: "sell", securityKey: "VTI", quantity: f("4"), amountCents: 99_860n })).toBe(
      "inv:38638c9dc3e6f19929e61e0fd5a3841ad5aed967fddc90a1a233dbd75687955a",
    );
    expect(await tradeExternalId({ date: "2026-10-02", type: "buy", securityKey: "ABC", quantity: f("5"), amountCents: -24_557n })).toBe(
      "inv:e57ec0a7ccbde687c2bb76b31cf5da260594af4b266bc9d660e17eb6d67bdf65",
    );
  });
  it("canonicalises the quantity so the Postgres form and the file form agree", async () => {
    const a = await tradeExternalId({ date: "2026-10-01", type: "buy", securityKey: "VTI", quantity: f("10.00000000"), amountCents: -250_000n });
    const b = await tradeExternalId({ date: "2026-10-01", type: "buy", securityKey: "VTI", quantity: f("10"), amountCents: -250_000n });
    expect(a).toBe(b);
  });
  it("builds the security key from ticker, else cusip, else name, else cash", () => {
    expect(tradeSecurityKey({ ticker: "vti" })).toBe("VTI");
    expect(tradeSecurityKey({ ticker: "spaxx**", name: "x" })).toBe("SPAXX");
    expect(tradeSecurityKey({ cusip: "315911750", name: "Fidelity 500" })).toBe("cusip:315911750");
    expect(tradeSecurityKey({ name: "Fidelity 500 Index Pool - Class K" })).toBe("name:FIDELITY 500 INDEX POOL CLASS K");
    expect(tradeSecurityKey({ ticker: "VANGUARD TARGET 2045 TRUST" })).toBe("name:VANGUARD TARGET 2045 TRUST");
    expect(tradeSecurityKey({ ticker: "**CASH**" })).toBe("name:CASH");
    expect(tradeSecurityKey({})).toBe("cash");
  });
});

describe("periodStart (seams C31; prices test 16; views test 21)", () => {
  it("defines every preset once", () => {
    expect(periodStart("1w", "2026-10-13")).toBe("2026-10-06");
    expect(periodStart("1m", "2026-10-13")).toBe("2026-09-13");
    expect(periodStart("3m", "2026-10-13")).toBe("2026-07-13");
    expect(periodStart("6m", "2026-10-13")).toBe("2026-04-13");
    expect(periodStart("1y", "2026-10-13")).toBe("2025-10-13");
    expect(periodStart("3y", "2026-10-13")).toBe("2023-10-13");
    expect(periodStart("5y", "2026-10-13")).toBe("2021-10-13");
    expect(periodStart("ytd", "2026-10-13")).toBe("2025-12-31");
    expect(periodStart("1m", "2026-03-31")).toBe("2026-02-28"); // clamped
    expect(periodStart("all", "2026-10-13", { earliest: "2025-10-13" })).toBe("2025-10-13");
    expect(periodStart("all", "2026-10-13", { earliest: null })).toBeNull();
    expect(periodStart("all", "2026-10-13")).toBeNull();
    expect(periodStart("custom", "2026-10-13", { from: "2026-01-01" })).toBe("2026-01-01");
    expect(periodStart("custom", "2026-10-13")).toBeNull();
  });
});

describe("returnReasonText (lots §4.3)", () => {
  it("renders the reason strings", () => {
    expect(returnReasonText("no_valuations", "2026-10-13")).toBe(
      "No value is known for this account on or before 2026-10-13. Sync it or import a statement.",
    );
    expect(returnReasonText("zero_denominator", "2026-04-13")).toBe(
      "Value appeared on 2026-04-13 without a contribution. Add the opening transfer or position.",
    );
    expect(returnReasonText("negative_capital", "2026-05-01")).toBe("The account's value went negative on 2026-05-01.");
    expect(returnReasonText("too_few_flows", null)).toBe("Money only went one way in this period, so a rate of return is undefined.");
    expect(returnReasonText("no_sign_change", null)).toBe("Money only went one way in this period, so a rate of return is undefined.");
    expect(returnReasonText("no_bracket", null)).toBe("The return is outside the solvable range (a total loss or an extreme gain).");
    expect(returnReasonText("no_benchmark_price", "2025-10-13")).toBe("No benchmark price on or before 2025-10-13.");
    expect(returnReasonText("no_valuations", null)).toContain("the period end");
  });
});
