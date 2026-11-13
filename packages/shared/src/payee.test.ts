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

  // Audit a6-text-rules-accounts-12: one merchant, one payee, across cities and days.
  const cityCases: Array<[string, string]> = [
    ["STARBUCKS STORE 12345 SAN FRANCISCO CA", "Starbucks Store"],
    ["STARBUCKS STORE 12345 DENVER CO", "Starbucks Store"],
    ["STARBUCKS STORE 12345 NEW YORK NY", "Starbucks Store"],
    ["STARBUCKS STORE NEW YORK NY", "Starbucks Store"],
    ["SMITHS FOOD #4123 SALT LAKE CITY UT", "Smiths Food"],
    ["SMITHS FOOD SALT LAKE CITY UT", "Smiths Food"],
    ["KING SOOPERS #0123 FORT COLLINS CO", "King Soopers"],
    ["KING SOOPERS FORT COLLINS CO", "King Soopers"],
    ["PANERA BREAD #601234 LAS VEGAS NV", "Panera Bread"],
    ["KING SOOPERS #0123 COLORADO SPRINGS CO", "King Soopers"],
    ["TACO BELL 1234 CO", "Taco Bell"],
    ["TACO BELL #1234", "Taco Bell"],
    ["ST LOUIS BREAD CO #1234 KIRKWOOD MO", "St Louis Bread Co"],
    ["SAFEWAY #1234 ST PAUL MN", "Safeway"],
    ["SAFEWAY ST PAUL MN", "Safeway"],
    ["LYFT *RIDE TUE 5PM", "Lyft"],
    ["LYFT *RIDE SUN 11AM", "Lyft"],
    ["LYFT *RIDE THU 10:15PM", "Lyft"],
    ["SUN COUNTRY AIRLINES", "Sun Country Airlines"],
  ];
  for (const [raw, expected] of cityCases) {
    it(`a6-text-rules-accounts-12: "${raw}" -> "${expected}"`, () => {
      expect(normalizePayee(raw)).toBe(expected);
    });
  }

  // Audit a6-text-rules-accounts-17: accented letters are letters; one spelling per merchant.
  const unicodeCases: Array<[string, string]> = [
    ["Caf\u00E9 Rio", "Cafe Rio"],
    ["CAFE RIO #23 DENVER CO", "Cafe Rio"],
    ["Cafe\u0301 Rio", "Cafe Rio"],
    ["\u00C9COLE DU VIN", "Ecole Du Vin"],
    ["R\u00E9sum\u00E9 Caf\u00E9", "Resume Cafe"],
    ["\u0130STANBUL KEBAP DENVER CO", "Istanbul Kebap"],
    ["\u00DCBER EATS", "Uber Eats"],
    ["\u5BFF\u53F8 SUSHI", "\u5BFF\u53F8 Sushi"],
  ];
  for (const [raw, expected] of unicodeCases) {
    it(`a6-text-rules-accounts-17: "${raw}" -> "${expected}"`, () => {
      expect(normalizePayee(raw)).toBe(expected);
    });
  }

  it("a6: stays idempotent on the new cases", () => {
    for (const [raw] of [...cityCases, ...unicodeCases]) {
      const once = normalizePayee(raw);
      expect(normalizePayee(once), raw).toBe(once);
    }
  });
});

