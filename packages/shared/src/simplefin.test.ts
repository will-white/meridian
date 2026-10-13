import { describe, expect, it } from "vitest";
import { decodeSetupToken, describeSimplefinError, parseAccessUrl, SimplefinAccountSet, simplefinTransactionDate } from "./simplefin.js";

describe("decodeSetupToken", () => {
  it("decodes a base64 https claim URL", () => {
    expect(decodeSetupToken(btoa("https://bridge.simplefin.org/simplefin/claim/abc"))).toBe("https://bridge.simplefin.org/simplefin/claim/abc");
  });
  it("rejects non-https and garbage", () => {
    expect(() => decodeSetupToken(btoa("http://bridge.simplefin.org/claim/abc"))).toThrow(/https/);
    expect(() => decodeSetupToken("not base64 at all!")).toThrow();
  });
});

describe("parseAccessUrl", () => {
  it("splits credentials from the base URL", () => {
    expect(parseAccessUrl("https://u%40x:p%3Ass@bridge.simplefin.org/simplefin")).toEqual({
      baseUrl: "https://bridge.simplefin.org/simplefin",
      username: "u@x",
      password: "p:ss",
    });
  });
  it("rejects http", () => {
    expect(() => parseAccessUrl("http://u:p@bridge.simplefin.org/simplefin")).toThrow(/https/);
  });
});

describe("SimplefinAccountSet", () => {
  it("parses a v2 response with errlist and keeps unknown fields", () => {
    const parsed = SimplefinAccountSet.parse({
      errors: [],
      errlist: [{ code: "con.auth", msg: "Please re-auth", conn_id: "c1", something: 1 }],
      accounts: [
        {
          org: { domain: "bank.example", name: "Example Bank", "sfin-url": "https://bank.example/sfin" },
          id: "ACT-1",
          name: "Checking",
          currency: "USD",
          balance: "1234.56",
          "available-balance": "1200.00",
          "balance-date": 1760000000,
          transactions: [{ id: "T1", posted: 1759900000, amount: "-10.00", description: "COFFEE", pending: true, posted_extra: 1 }],
          extra: { holdings: [] },
        },
      ],
    });
    expect(parsed.accounts[0]!.transactions[0]!.pending).toBe(true);
    expect(parsed.errlist[0]!.code).toBe("con.auth");
    expect((parsed.errlist[0] as Record<string, unknown>)["something"]).toBe(1);
  });
  it("defaults missing lists", () => {
    const parsed = SimplefinAccountSet.parse({ accounts: [] });
    expect(parsed.errors).toEqual([]);
    expect(parsed.errlist).toEqual([]);
  });
});

describe("describeSimplefinError", () => {
  it("maps known codes to guidance and sanitizes the message", () => {
    expect(describeSimplefinError({ code: "con.auth", msg: "<b>bad</b>\u0000 creds" })).toBe(
      "The bank connection needs to be re-authenticated at the SimpleFIN Bridge. (bad creds)",
    );
    expect(describeSimplefinError({ code: "act.missingdata" })).toMatch(/incomplete data/);
    expect(describeSimplefinError({ code: "weird.code", msg: "x" })).toBe("weird.code: x");
  });
});

describe("simplefinTransactionDate", () => {
  it("prefers transaction_date, then posted, then today", () => {
    expect(simplefinTransactionDate({ posted: 1759900000, transaction_date: 1759800000 })).toBe("2025-10-07");
    expect(simplefinTransactionDate({ posted: 1759900000 })).toBe("2025-10-08");
    expect(simplefinTransactionDate({ posted: 0 }, new Date("2026-10-13T12:00:00Z"))).toBe("2026-10-13");
  });
});
