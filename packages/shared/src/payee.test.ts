import { describe, expect, it } from "vitest";
import { normalizePayee } from "./payee.js";

describe("normalizePayee", () => {
  const cases: Array<[string, string]> = [
    ["SQ *BLUE BOTTLE COFFEE", "Blue Bottle Coffee"],
    ["TST* THE LOCAL TAPHOUSE DENVER CO", "The Local Taphouse"],
    ["PAYPAL *SPOTIFY 4029357733", "Spotify"],
    ["KING SOOPERS #0123 DENVER CO", "King Soopers"],
    ["POS PURCHASE 10/02 COSTCO WHSE #1234 AURORA CO", "Costco Whse"],
    ["CHECKCARD 1002 STARBUCKS 800-782-7282 WA 24692161", "Starbucks"],
    ["XCEL ENERGY DES:XCELENERGY ID:0000123456 INDN:JOHN DOE CO ID:1234567890 WEB", "Xcel Energy"],
    ["AMAZON.COM*2K3JH8U21 AMZN.COM/BILL WA", "Amazon.com"],
    ["TRADER JOE'S #210 BOULDER CO", "Trader Joe's"],
    ["Direct Deposit ACME CORP PAYROLL", "Acme Corp Payroll"],
    ["ACME CORP PAYROLL DIRECT DEP", "Acme Corp Payroll"],
    ["7-ELEVEN 12345 DENVER CO", "7-Eleven"],
    ["ACH DEBIT CHASE CREDIT CRD EPAY 1234567890", "Chase"],
    ["   netflix.com   ", "Netflix.com"],
    ["ONLINE TRANSFER TO SAVINGS XXXXXX1234", "Transfer To Savings"],
    ["MCDONALD'S F12345 LAKEWOOD CO", "McDonald's"],
  ];
  for (const [raw, expected] of cases) {
    it(`"${raw}" -> "${expected}"`, () => {
      expect(normalizePayee(raw)).toBe(expected);
    });
  }

  it("returns an empty string for empty input", () => {
    expect(normalizePayee("")).toBe("");
    expect(normalizePayee("   ")).toBe("");
  });

  it("falls back to the raw text when everything looks like noise", () => {
    expect(normalizePayee("12345678")).toBe("12345678");
  });

  it("is idempotent", () => {
    for (const raw of ["SQ *BLUE BOTTLE COFFEE", "KING SOOPERS #0123 DENVER CO", "Trader Joe's"]) {
      const once = normalizePayee(raw);
      expect(normalizePayee(once)).toBe(once);
    }
  });
});
