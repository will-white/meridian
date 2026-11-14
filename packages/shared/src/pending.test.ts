import { describe, expect, it } from "vitest";
import { dayDiff } from "./dates.js";
import { descriptionSimilarity, matchPendingToPosted } from "./pending.js";

describe("descriptionSimilarity", () => {
  it("is 1 for the same merchant with different noise", () => {
    expect(descriptionSimilarity("KING SOOPERS #0123 DENVER CO", "KING SOOPERS 0123")).toBe(1);
  });
  it("is 0 for unrelated merchants", () => {
    expect(descriptionSimilarity("STARBUCKS", "SHELL OIL")).toBe(0);
  });
  it("is partial for overlapping tokens", () => {
    const s = descriptionSimilarity("Blue Bottle Coffee", "Blue Bottle");
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});

describe("matchPendingToPosted", () => {
  it("matches a posted item to the pending row with the same amount, close date and similar description", () => {
    const map = matchPendingToPosted(
      [{ id: "p1", amountCents: -1250n, date: "2026-09-10", description: "PENDING STARBUCKS" }],
      [{ externalId: "TXN-9", amountCents: -1250n, date: "2026-09-12", description: "STARBUCKS #123 DENVER CO" }],
    );
    expect(map.get("TXN-9")).toBe("p1");
  });

  it("does not match a different amount (unless changed amounts are allowed, see below) or a date outside the window", () => {
    expect(
      matchPendingToPosted(
        [{ id: "p1", amountCents: -1250n, date: "2026-09-10", description: "STARBUCKS" }],
        [{ externalId: "x", amountCents: -1251n, date: "2026-09-11", description: "STARBUCKS" }],
        { changedAmounts: false },
      ).size,
    ).toBe(0);
    expect(
      matchPendingToPosted(
        [{ id: "p1", amountCents: -1250n, date: "2026-09-10", description: "STARBUCKS" }],
        [{ externalId: "x", amountCents: -1250n, date: "2026-09-16", description: "STARBUCKS" }],
      ).size,
    ).toBe(0);
  });

  it("picks the most similar description when two pending rows share an amount", () => {
    const map = matchPendingToPosted(
      [
        { id: "shell", amountCents: -4000n, date: "2026-09-10", description: "SHELL OIL 1234" },
        { id: "chevron", amountCents: -4000n, date: "2026-09-10", description: "CHEVRON 5678" },
      ],
      [{ externalId: "posted", amountCents: -4000n, date: "2026-09-11", description: "CHEVRON 5678 DENVER CO" }],
    );
    expect(map.get("posted")).toBe("chevron");
  });

  it("falls back to the closest date when descriptions tie", () => {
    const map = matchPendingToPosted(
      [
        { id: "early", amountCents: -4000n, date: "2026-09-08", description: "COFFEE" },
        { id: "late", amountCents: -4000n, date: "2026-09-11", description: "COFFEE" },
      ],
      [{ externalId: "posted", amountCents: -4000n, date: "2026-09-12", description: "COFFEE" }],
    );
    expect(map.get("posted")).toBe("late");
  });

  it("uses each pending row once", () => {
    const map = matchPendingToPosted(
      [{ id: "p1", amountCents: -4000n, date: "2026-09-10", description: "COFFEE" }],
      [
        { externalId: "a", amountCents: -4000n, date: "2026-09-11", description: "COFFEE" },
        { externalId: "b", amountCents: -4000n, date: "2026-09-12", description: "COFFEE" },
      ],
    );
    expect(map.get("a")).toBe("p1");
    expect(map.has("b")).toBe(false);
  });
});

describe("matchPendingToPosted (audit a5-ingest-transfers)", () => {
  it("a5-ingest-transfers-07: never replaces a pending row whose description shares nothing with the posted item", () => {
    expect(descriptionSimilarity("SHELL OIL 57442", "COSTCO WHSE #1234 AURORA CO")).toBe(0);
    const map = matchPendingToPosted(
      [{ id: "shell", amountCents: -4000n, date: "2026-10-10", description: "SHELL OIL 57442" }],
      [{ externalId: "costco", amountCents: -4000n, date: "2026-10-12", description: "COSTCO WHSE #1234 AURORA CO" }],
    );
    expect(map.size).toBe(0);
  });

  it("a5-ingest-transfers-06: a tip or a settled hold posts with another amount and still replaces its pending row", () => {
    const tip = matchPendingToPosted(
      [{ id: "p", amountCents: -5000n, date: "2026-10-10", description: "TST* TAPHOUSE DENVER" }],
      [{ externalId: "t", amountCents: -6000n, date: "2026-10-11", description: "TAPHOUSE DENVER CO" }],
    );
    expect(tip.get("t")).toBe("p");
    const hotel = matchPendingToPosted(
      [{ id: "p", amountCents: -12000n, date: "2026-10-02", description: "MARRIOTT DENVER TECH" }],
      [{ externalId: "t", amountCents: -13540n, date: "2026-10-05", description: "MARRIOTT DENVER TECH CTR" }],
    );
    expect(hotel.get("t")).toBe("p");
    // A gas hold that settles lower, within half of the hold.
    const gas = matchPendingToPosted(
      [{ id: "p", amountCents: -7500n, date: "2026-10-02", description: "SHELL OIL 57442" }],
      [{ externalId: "t", amountCents: -4310n, date: "2026-10-03", description: "SHELL OIL 57442 DENVER CO" }],
    );
    expect(gas.get("t")).toBe("p");
  });

  it("a5-ingest-transfers-06: a changed amount needs the same merchant, the same direction and at most half again", () => {
    const pending = [{ id: "p", amountCents: -5000n, date: "2026-10-10", description: "TAPHOUSE" }];
    expect(matchPendingToPosted(pending, [{ externalId: "x", amountCents: -7600n, date: "2026-10-10", description: "TAPHOUSE" }]).size).toBe(0);
    expect(matchPendingToPosted(pending, [{ externalId: "x", amountCents: -2400n, date: "2026-10-10", description: "TAPHOUSE" }]).size).toBe(0);
    expect(matchPendingToPosted(pending, [{ externalId: "x", amountCents: 6000n, date: "2026-10-10", description: "TAPHOUSE" }]).size).toBe(0);
    // Weak similarity (one shared token of four) is enough for an equal amount, not for a changed one.
    expect(descriptionSimilarity("BLUE BOTTLE COFFEE", "BLUE MOON BREWING")).toBeLessThan(0.5);
    const blue = [{ id: "p", amountCents: -5000n, date: "2026-10-10", description: "BLUE BOTTLE COFFEE" }];
    expect(matchPendingToPosted(blue, [{ externalId: "x", amountCents: -5500n, date: "2026-10-10", description: "BLUE MOON BREWING" }]).size).toBe(0);
    expect(matchPendingToPosted(blue, [{ externalId: "x", amountCents: -5000n, date: "2026-10-10", description: "BLUE MOON BREWING" }]).get("x")).toBe("p");
  });

  it("a5-ingest-transfers-06: an equal amount is matched before a changed one", () => {
    const map = matchPendingToPosted(
      [
        { id: "fifty", amountCents: -5000n, date: "2026-10-10", description: "TAPHOUSE" },
        { id: "sixty", amountCents: -6000n, date: "2026-10-10", description: "TAPHOUSE" },
      ],
      [
        { externalId: "a", amountCents: -6000n, date: "2026-10-10", description: "TAPHOUSE" },
        { externalId: "b", amountCents: -5900n, date: "2026-10-11", description: "TAPHOUSE" },
      ],
    );
    expect(map.get("a")).toBe("sixty");
    expect(map.get("b")).toBe("fifty");
  });
});

describe("matchPendingToPosted (audit a5-ingest-transfers, second round)", () => {
  it("a5-ingest-transfers-01: the caller's day distance decides the window, so a bank file that dates a hold by its posting day finds it", () => {
    // The feed dates the rental by the day it was made (10-01); it posted on 10-20, the day the bank's file gives it.
    const rows = [{ id: "feed", amountCents: -41200n, date: "2026-10-01", postedDate: "2026-10-20", description: "HERTZ RENT-A-CAR DENVER" }];
    const items = [{ externalId: "csv", amountCents: -41200n, date: "2026-10-20", description: "HERTZ RENT-A-CAR DENVER" }];
    expect(matchPendingToPosted(rows, items, { changedAmounts: false }).size).toBe(0);
    const byPosting = (r: (typeof rows)[number], i: (typeof items)[number]) => Math.min(Math.abs(dayDiff(r.date, i.date)), Math.abs(dayDiff(r.postedDate, i.date)));
    expect(matchPendingToPosted(rows, items, { changedAmounts: false, dayDistance: byPosting }).get("csv")).toBe("feed");
    // The changed-amount pass uses it too: a tip settled 19 days after the day the row is dated (hand-checked: 2 * 6000 within 5000..7500 * 2).
    const tipped = [{ externalId: "csv", amountCents: -6000n, date: "2026-10-20", description: "TAPHOUSE DENVER" }];
    const tipRows = [{ id: "feed", amountCents: -5000n, date: "2026-10-01", postedDate: "2026-10-20", description: "TST* TAPHOUSE DENVER" }];
    expect(matchPendingToPosted(tipRows, tipped).size).toBe(0);
    expect(matchPendingToPosted(tipRows, tipped, { dayDistance: byPosting }).get("csv")).toBe("feed");
    // A distance beyond maxDays still keeps the pair apart.
    expect(matchPendingToPosted(rows, items, { changedAmounts: false, dayDistance: () => 6 }).size).toBe(0);
  });
});
