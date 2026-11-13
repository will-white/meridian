import { describe, expect, it } from "vitest";
import { balanceFieldLabel, owedText, parseManualBalance } from "./accountForms.js";

describe("manual balance input (a6-text-rules-accounts-09)", () => {
  it("reads what people type with grouping and a dollar sign, in integer cents", () => {
    expect(parseManualBalance("1,234.56", "asset")).toEqual({ ok: true, cents: 123456n });
    expect(parseManualBalance("$500", "asset")).toEqual({ ok: true, cents: 50000n });
    expect(parseManualBalance(" 12 500.00 ", "checking")).toEqual({ ok: true, cents: 1250000n });
    expect(parseManualBalance("-20.5", "checking")).toEqual({ ok: true, cents: -2050n });
    expect(parseManualBalance(".5", "asset")).toEqual({ ok: true, cents: 50n });
    expect(parseManualBalance("", "asset")).toEqual({ ok: true, cents: null });
  });
  it("says why instead of dropping a value it cannot read", () => {
    expect(parseManualBalance("1.005", "asset")).toEqual({ ok: false, error: "Use at most two decimals" });
    expect(parseManualBalance("12abc", "asset")).toEqual({ ok: false, error: "Not an amount" });
    expect(parseManualBalance("1.2.3", "asset")).toEqual({ ok: false, error: "Not an amount" });
  });
});

describe("loans and cards take the amount owed (a6-text-rules-accounts-05)", () => {
  it("labels the field and stores what is owed as a negative balance", () => {
    expect(balanceFieldLabel("loan")).toBe("Amount owed");
    expect(balanceFieldLabel("credit")).toBe("Amount owed");
    expect(balanceFieldLabel("asset")).toBe("Balance");
    expect(parseManualBalance("15,000", "loan")).toEqual({ ok: true, cents: -1500000n });
    expect(parseManualBalance("250.00", "credit")).toEqual({ ok: true, cents: -25000n });
    // A card can be in credit; a loan cannot.
    expect(parseManualBalance("-40", "credit")).toEqual({ ok: true, cents: 4000n });
    expect(parseManualBalance("-40", "loan")).toEqual({ ok: false, error: "Enter what is owed as a positive amount" });
  });
  it("shows a debt's balance back as the amount owed", () => {
    expect(owedText("-1500000", "loan")).toBe("15000.00");
    expect(owedText("4000", "credit")).toBe("-40.00");
    expect(owedText("123456", "asset")).toBe("1234.56");
    expect(owedText(null, "asset")).toBe("");
  });
});
