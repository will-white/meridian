import { describe, expect, it } from "vitest";
import { decodeSetupToken, describeSimplefinError, highWaterMarkAfterSync, parseAccessUrl, SimplefinAccountSet, simplefinFeedHealth, simplefinTransactionDate, syncWindowStart } from "./simplefin.js";

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
