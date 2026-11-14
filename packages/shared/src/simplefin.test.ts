import { describe, expect, it } from "vitest";
import {
  decodeSetupToken,
  describeSimplefinError,
  highWaterMarkAfterBalances,
  highWaterMarkAfterSync,
  jsonbSafe,
  parseAccessUrl,
  parseSimplefinAmount,
  readSimplefinAccountSet,
  SimplefinAccountSet,
  simplefinFeedHealth,
  simplefinTransactionDate,
  syncGapRange,
  syncWindowStart,
} from "./simplefin.js";

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
  it("prefers transacted_at, then posted, then the day it is given", () => {
    expect(simplefinTransactionDate({ posted: 1759900000, transacted_at: 1759800000 }, "2026-10-13")).toBe("2025-10-07");
    expect(simplefinTransactionDate({ posted: 1759900000 }, "2026-10-13")).toBe("2025-10-08");
    expect(simplefinTransactionDate({ posted: 0 }, "2026-10-13")).toBe("2026-10-13");
  });
});

describe("simplefinFeedHealth", () => {
  const chk = { id: "CHK", conn_id: "CON-1" };
  const card = { id: "CARD", conn_id: "CON-2" };
  const bare = { id: "OLD" }; // a Bridge that does not say which bank connection an account belongs to

  it("a response with no connection or account problem is complete", () => {
    const health = simplefinFeedHealth([]);
    expect(health.incomplete).toBe(false);
    expect(health.affects(chk)).toBe(false);
    // A code outside con.* and act.* is a notice, not a hole in the data.
    const notice = simplefinFeedHealth([{ code: "gen.notice", msg: "scheduled maintenance tonight" }]);
    expect(notice.incomplete).toBe(false);
    expect(notice.affects(chk)).toBe(false);
  });

  it("an account problem covers the account it names and nothing else", () => {
    for (const code of ["act.failed", "act.missingdata", "act.somethingnew"]) {
      const health = simplefinFeedHealth([{ code, account_id: "CARD" }]);
      expect(health.incomplete).toBe(true);
      expect(health.affects(card)).toBe(true);
      expect(health.affects(chk)).toBe(false);
    }
  });

  it("a connection problem covers the accounts of that bank connection, and every account when it cannot be told apart", () => {
    const named = simplefinFeedHealth([{ code: "con.auth", conn_id: "CON-1" }]);
    expect(named.incomplete).toBe(true);
    expect(named.affects(chk)).toBe(true);
    expect(named.affects(card)).toBe(false);
    // The account does not say which connection it is on: it may be the broken one.
    expect(named.affects(bare)).toBe(true);
    // The entry names no connection: every account may be stale.
    const unnamed = simplefinFeedHealth([{ code: "con.auth", msg: "re-login" }]);
    expect([chk, card, bare].map((a) => unnamed.affects(a))).toEqual([true, true, true]);
    // An account problem that names no account falls back to its connection, then to everything.
    expect(simplefinFeedHealth([{ code: "act.failed", conn_id: "CON-2" }]).affects(chk)).toBe(false);
    expect(simplefinFeedHealth([{ code: "act.failed", conn_id: "CON-2" }]).affects(card)).toBe(true);
    expect(simplefinFeedHealth([{ code: "act.failed" }]).affects(chk)).toBe(true);
  });
});

describe("syncWindowStart", () => {
  const config = { initialWindowDays: 93, overlapDays: 7 };
  it("looks back 93 days on the first sync and overlaps 7 days afterwards", () => {
    expect(syncWindowStart(null, "2026-10-13", config)).toBe("2026-07-12");
    expect(syncWindowStart("2026-10-10", "2026-10-13", config)).toBe("2026-10-03");
  });
  it("never asks for more than the first-sync window, however old the mark is", () => {
    // 2026-07-19 - 7 days = 2026-07-12 is exactly 93 days before 2026-10-13: still inside.
    expect(syncWindowStart("2026-07-19", "2026-10-13", config)).toBe("2026-07-12");
    // One day older and the cap decides.
    expect(syncWindowStart("2026-07-18", "2026-10-13", config)).toBe("2026-07-12");
    expect(syncWindowStart("2025-01-01", "2026-10-13", config)).toBe("2026-07-12");
  });
});

describe("highWaterMarkAfterSync", () => {
  const config = { initialWindowDays: 93, overlapDays: 7 };
  const base = { previous: "2026-10-01" as const, today: "2026-10-13" as const, windowStart: "2026-09-24" as const, incomplete: false, accountsCreated: 0, balanceDates: ["2026-10-13" as const, "2026-10-12" as const], config };

  it("moves to today after a response with no problem in it", () => {
    expect(highWaterMarkAfterSync(base)).toBe("2026-10-13");
    expect(highWaterMarkAfterSync({ ...base, previous: null, windowStart: "2026-07-12" })).toBe("2026-10-13");
  });

  it("stays where it was while the Bridge reports a connection or account problem", () => {
    expect(highWaterMarkAfterSync({ ...base, incomplete: true })).toBe("2026-10-01");
    expect(highWaterMarkAfterSync({ ...base, previous: null, windowStart: "2026-07-12", incomplete: true })).toBeNull();
  });

  it("stays where it was while an account's data is older than the overlap can cover", () => {
    // 2026-10-13 - 7 days = 2026-10-06: data as of that day is still inside the next window.
    expect(highWaterMarkAfterSync({ ...base, balanceDates: ["2026-10-13", "2026-10-06"] })).toBe("2026-10-13");
    // One day older and the next window (from 2026-10-06) would start after it.
    expect(highWaterMarkAfterSync({ ...base, balanceDates: ["2026-10-13", "2026-10-05"] })).toBe("2026-10-01");
    // 2026-10-13 - 93 days = 2026-07-12: an account silent since before then is dormant, not late.
    expect(highWaterMarkAfterSync({ ...base, balanceDates: ["2026-10-13", "2026-07-12"] })).toBe("2026-10-01");
    expect(highWaterMarkAfterSync({ ...base, balanceDates: ["2026-10-13", "2026-07-11"] })).toBe("2026-10-13");
    expect(highWaterMarkAfterSync({ ...base, balanceDates: ["2026-10-13", "1970-01-01"] })).toBe("2026-10-13");
  });

  it("is cleared when an account appears that the window did not reach back the first-sync distance for", () => {
    // The next sync then asks for the whole first-sync window, which gives the new account its history.
    expect(highWaterMarkAfterSync({ ...base, accountsCreated: 1 })).toBeNull();
    expect(highWaterMarkAfterSync({ ...base, accountsCreated: 1, incomplete: true })).toBeNull();
    // The first sync and a full resync already asked for all of it.
    expect(highWaterMarkAfterSync({ ...base, previous: null, windowStart: "2026-07-12", accountsCreated: 3 })).toBe("2026-10-13");
  });
});

describe("a3-sync-core (second round): the mark after a Balances only refresh, and the days a capped window leaves out", () => {
  const config = { initialWindowDays: 93, overlapDays: 7 };

  it("highWaterMarkAfterBalances: a refresh never moves the mark, but one that finds an account clears it so the next full sync asks for its history", () => {
    // 2026-10-11 - 93 days = 2026-07-10.
    expect(highWaterMarkAfterBalances({ previous: "2026-10-10", today: "2026-10-11", accountsCreated: 0, config })).toBe("2026-10-10");
    expect(highWaterMarkAfterBalances({ previous: null, today: "2026-10-11", accountsCreated: 0, config })).toBeNull();
    // A new (or attached again) account: the next window would start 2026-10-03, after 2026-07-10, so the mark goes.
    expect(highWaterMarkAfterBalances({ previous: "2026-10-10", today: "2026-10-11", accountsCreated: 1, config })).toBeNull();
    // 2026-07-18 - 7 = 2026-07-11, one day short of the first-sync window: cleared.
    expect(highWaterMarkAfterBalances({ previous: "2026-07-18", today: "2026-10-11", accountsCreated: 2, config })).toBeNull();
    // 2026-07-17 - 7 = 2026-07-10: the next sync asks for the whole first-sync window anyway, so the mark stays and the days it misses are still reported.
    expect(highWaterMarkAfterBalances({ previous: "2026-07-17", today: "2026-10-11", accountsCreated: 1, config })).toBe("2026-07-17");
    expect(highWaterMarkAfterBalances({ previous: "2026-06-01", today: "2026-10-11", accountsCreated: 1, config })).toBe("2026-06-01");
  });

  it("syncGapRange: from the overlap before the last complete sync to the day before the window, and only when the cap cut the window", () => {
    // Mark 2026-06-01, today 2026-10-20: the window is capped at 2026-07-19 (93 days back). An ordinary sync would have
    // asked from 2026-05-25 (7 days before the mark, for items that post late), so 2026-05-25 to 2026-07-18 were not asked for again.
    expect(syncGapRange("2026-06-01", "2026-07-19", config)).toEqual({ from: "2026-05-25", to: "2026-07-18" });
    // Today 2026-10-13, 93 days back 2026-07-12. Mark 2026-07-19: the overlap reaches 2026-07-12 exactly, nothing is left out.
    expect(syncGapRange("2026-07-19", syncWindowStart("2026-07-19", "2026-10-13", config), config)).toBeNull();
    // Mark 2026-07-18: the overlap would start 2026-07-11, one day before the window.
    expect(syncGapRange("2026-07-18", syncWindowStart("2026-07-18", "2026-10-13", config), config)).toEqual({ from: "2026-07-11", to: "2026-07-11" });
    // No mark (first sync), or a window that reaches the overlap (an ordinary sync, a full resync after a recent one).
    expect(syncGapRange(null, "2026-07-12", config)).toBeNull();
    expect(syncGapRange("2026-10-10", "2026-10-03", config)).toBeNull();
    expect(syncGapRange("2026-10-10", "2026-07-12", config)).toBeNull();
  });
});

// ---- Audit batch a4-sync-parse ----

describe("parseSimplefinAmount (a4-sync-parse-01)", () => {
  // The protocol's numeric strings: an optional sign, digits with any number of decimals, an optional exponent.
  // Hand-calculated: cents = value × 100, rounded half away from zero; `rounded` when non-zero digits below a cent were dropped.
  it("reads a sign, any number of decimals and an exponent", () => {
    expect(parseSimplefinAmount("+5.00")).toEqual({ cents: 500n, rounded: false });
    expect(parseSimplefinAmount("-33293.43")).toEqual({ cents: -3329343n, rounded: false });
    // 12.345 → 1234.5 cents → 1235 (half away from zero)
    expect(parseSimplefinAmount("12.345")).toEqual({ cents: 1235n, rounded: true });
    expect(parseSimplefinAmount("-12.345")).toEqual({ cents: -1235n, rounded: true });
    // 1E+2 = 100 → 10000 cents
    expect(parseSimplefinAmount("1E+2")).toEqual({ cents: 10000n, rounded: false });
    // -0.5e1 = -5 → -500 cents
    expect(parseSimplefinAmount("-0.5e1")).toEqual({ cents: -500n, rounded: false });
    // 1234.567 → 123456.7 cents → 123457
    expect(parseSimplefinAmount("1234.567")).toEqual({ cents: 123457n, rounded: true });
    // 1234.564 → 123456.4 cents → 123456
    expect(parseSimplefinAmount("1234.564")).toEqual({ cents: 123456n, rounded: true });
    expect(parseSimplefinAmount(".50")).toEqual({ cents: 50n, rounded: false });
    expect(parseSimplefinAmount("5.")).toEqual({ cents: 500n, rounded: false });
    // Trailing zeros are not a loss of precision.
    expect(parseSimplefinAmount("100.10000")).toEqual({ cents: 10010n, rounded: false });
    // -0.005 → -0.5 cents → -1; -0.004 → -0.4 cents → 0
    expect(parseSimplefinAmount("-0.005")).toEqual({ cents: -1n, rounded: true });
    expect(parseSimplefinAmount("-0.004")).toEqual({ cents: 0n, rounded: true });
    // 2.5e-3 = 0.0025 → 0.25 cents → 0; 1e-7 → 0
    expect(parseSimplefinAmount("2.5e-3")).toEqual({ cents: 0n, rounded: true });
    expect(parseSimplefinAmount("1e-7")).toEqual({ cents: 0n, rounded: true });
    expect(parseSimplefinAmount(" 0 ")).toEqual({ cents: 0n, rounded: false });
    expect(parseSimplefinAmount("-0.00")).toEqual({ cents: 0n, rounded: false });
  });

  it("refuses what is not a number, and values no account holds (more than 15 digits of cents)", () => {
    for (const bad of ["", " ", ".", "abc", "1,234.00", "$5.00", "1e", "e5", "--5", "+-5", "NaN", "Infinity", "0x10", "5 00", "<b>1</b>"]) {
      expect(parseSimplefinAmount(bad), bad).toBeUndefined();
    }
    // 9 999 999 999 999.99 is 15 digits of cents; one more digit is out of range.
    expect(parseSimplefinAmount("9999999999999.99")).toEqual({ cents: 999999999999999n, rounded: false });
    expect(parseSimplefinAmount("10000000000000.00")).toBeUndefined();
    expect(parseSimplefinAmount("1e13")).toBeUndefined();
    expect(parseSimplefinAmount("1e999999999")).toBeUndefined();
    expect(parseSimplefinAmount("1".repeat(200))).toBeUndefined();
  });
});

describe("readSimplefinAccountSet (a4-sync-parse-03)", () => {
  const good = (id: string, extra: Record<string, unknown> = {}) => ({
    org: { name: "Bank" },
    id,
    name: `Account ${id}`,
    currency: "USD",
    balance: "10.00",
    "balance-date": 1760000000,
    transactions: [{ id: `${id}-T1`, posted: 1759900000, amount: "-1.00", description: "COFFEE" }],
    ...extra,
  });

  it("accepts the shapes the holdings parser and the protocol allow: holdings keyed by symbol, nulls for optional text, amounts as JSON numbers", () => {
    const { set, problems } = readSimplefinAccountSet({
      errors: [],
      errlist: [{ code: "act.failed", msg: null, account_id: "BRK" }],
      accounts: [
        good("BRK", { holdings: { VTI: { shares: "2", market_value: "500.00" } }, extra: null }),
        good("NUL1", { holdings: null }),
        good("NUL2", { holdings: [null] }),
        good("NUM", { balance: 12.5, "available-balance": null, transactions: [{ id: "N1", posted: 1759900000, amount: -3.25, description: null, payee: null, memo: null }] }),
      ],
    });
    expect(problems).toEqual([]);
    expect(set.accounts.map((a) => a.id)).toEqual(["BRK", "NUL1", "NUL2", "NUM"]);
    expect(set.accounts[0]!.holdings).toEqual({ VTI: { shares: "2", market_value: "500.00" } });
    expect(set.accounts[3]!.balance).toBe("12.5");
    expect(set.accounts[3]!["available-balance"]).toBeUndefined();
    expect(set.accounts[3]!.transactions[0]).toMatchObject({ id: "N1", amount: "-3.25", description: "" });
    expect(set.accounts[3]!.transactions[0]!.payee).toBeUndefined();
    expect(set.errlist).toEqual([{ code: "act.failed", account_id: "BRK" }]);
  });

  it("skips and reports one account or one transaction it cannot read, and keeps the rest", () => {
    const { set, problems } = readSimplefinAccountSet({
      errlist: [{ code: null }, "con.auth"],
      accounts: [
        good("CHK", { transactions: [{ id: "OK1", posted: 1759900000, amount: "-1.00", description: "A" }, { id: "BAD1", amount: "-2.00", description: "no posted date" }, { posted: 1759900000, amount: "1" }] }),
        { id: "BROKEN", name: "Broken <b>card</b>", balance: "1.00" },
        { name: "No id at all" },
        good("SAV"),
      ],
    });
    expect(set.accounts.map((a) => a.id)).toEqual(["CHK", "SAV"]);
    expect(set.accounts[0]!.transactions.map((t) => t.id)).toEqual(["OK1"]);
    expect(set.errlist).toEqual([{ code: "unknown" }, { code: "unknown", msg: "con.auth" }]);
    expect(problems).toEqual([
      { code: "transaction.unreadable", message: "Account CHK: 2 transactions could not be read and were skipped (posted: Required; id: Required)", accountId: "CHK" },
      { code: "account.unreadable", message: "Broken card: the account could not be read and was skipped (balance-date: Required)", accountId: "BROKEN" },
      { code: "account.unreadable", message: "No id at all: the account could not be read and was skipped (id: Required)" },
    ]);
  });

  it("refuses a body that is not an account set at all", () => {
    expect(() => readSimplefinAccountSet([1, 2])).toThrow(/not an account set/);
    expect(() => readSimplefinAccountSet({ accounts: "nope" })).toThrow(/accounts/);
    expect(() => readSimplefinAccountSet("text")).toThrow(/not an account set/);
  });
});

describe("transacted_at (a4-sync-parse-04, a4-sync-parse-08)", () => {
  it("dates a transaction by when it happened, then when it posted, then the household's day", () => {
    // posted 2026-10-30T12:00Z, transacted_at 2026-10-27T12:00Z
    expect(simplefinTransactionDate({ posted: 1793361600, transacted_at: 1793102400 }, "2026-10-31")).toBe("2026-10-27");
    expect(simplefinTransactionDate({ posted: 1793361600 }, "2026-10-31")).toBe("2026-10-30");
    // Pending with no transaction time: the day the household is on, not the UTC day.
    expect(simplefinTransactionDate({ posted: 0 }, "2026-10-31")).toBe("2026-10-31");
    expect(simplefinTransactionDate({ posted: 0, transacted_at: 1793188800 }, "2026-10-31")).toBe("2026-10-28");
  });
  it("is the field the schema reads", () => {
    const parsed = SimplefinAccountSet.parse({ accounts: [{ org: {}, id: "A", name: "A", currency: "USD", balance: "1", "balance-date": 1, transactions: [{ id: "T", posted: 0, amount: "1", transacted_at: 1793188800 }] }] });
    expect(parsed.accounts[0]!.transactions[0]!.transacted_at).toBe(1793188800);
  });
});

describe("jsonbSafe (a4-sync-parse-05)", () => {
  it("replaces NUL and unpaired surrogates in every string and key, which Postgres jsonb refuses", () => {
    const raw = JSON.parse('{"errlist":[{"code":"act.failed","msg":"bad\\u0000msg"}],"a\\u0000b":["x\\u0000", {"p":"ACME\\u0000STORE","q":"\\ud800"}, 1, null, true]}');
    expect(jsonbSafe(raw)).toEqual({ errlist: [{ code: "act.failed", msg: "bad\uFFFDmsg" }], "a\uFFFDb": ["x\uFFFD", { p: "ACME\uFFFDSTORE", q: "\uFFFD" }, 1, null, true] });
    expect(JSON.stringify(jsonbSafe(raw))).not.toMatch(/\\u0000|\\ud800/);
  });
  it("copies deeply nested values without recursion", () => {
    let deep: unknown = "x\u0000";
    for (let i = 0; i < 100_000; i++) deep = [deep];
    let out = jsonbSafe(deep);
    for (let i = 0; i < 100_000; i++) out = (out as unknown[])[0];
    expect(out).toBe("x\uFFFD");
  });
});

describe("simplefinFeedHealth with closed accounts (a4-sync-parse-10)", () => {
  it("a problem with an account the household closed does not make the response incomplete", () => {
    expect(simplefinFeedHealth([{ code: "act.failed", account_id: "OLD" }], { closedAccountIds: ["OLD"] }).incomplete).toBe(false);
    expect(simplefinFeedHealth([{ code: "act.failed", account_id: "OLD" }], { closedAccountIds: ["OTHER"] }).incomplete).toBe(true);
    // A connection problem may cover open accounts too.
    expect(simplefinFeedHealth([{ code: "con.auth" }], { closedAccountIds: ["OLD"] }).incomplete).toBe(true);
    expect(simplefinFeedHealth([{ code: "act.failed", account_id: "OLD" }, { code: "act.missingdata", account_id: "CHK" }], { closedAccountIds: ["OLD"] }).incomplete).toBe(true);
  });
});
