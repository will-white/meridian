import { describe, expect, it } from "vitest";
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

  it("does not match a different amount or a date outside the window", () => {
    expect(
      matchPendingToPosted(
        [{ id: "p1", amountCents: -1250n, date: "2026-09-10", description: "STARBUCKS" }],
        [{ externalId: "x", amountCents: -1251n, date: "2026-09-11", description: "STARBUCKS" }],
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
