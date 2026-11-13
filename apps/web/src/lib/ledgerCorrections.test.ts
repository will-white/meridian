import { describe, expect, it } from "vitest";
import type { AccountView } from "@meridian/shared";
import { canDelete, candidateLabel, deleteWarning, linkableFeedAccounts, linkResultText, undoResultText } from "./ledgerCorrections.js";

describe("ledger corrections wording (audit a5-ingest-transfers)", () => {
  it("a5-ingest-transfers-09: says where a deleted row came from and that it will not come back", () => {
    expect(deleteWarning({ source: "simplefin", isTransfer: false, amountCents: "-4532", date: "2026-10-05" })).toMatch(/bank feed; the next sync will not bring it back/);
    expect(deleteWarning({ source: "csv", isTransfer: true, amountCents: "-50000", date: "2026-10-05" })).toMatch(/CSV file.*Its other leg stays/);
    expect(deleteWarning({ source: "manual", isTransfer: false, amountCents: "-1250", date: "2026-10-05" })).not.toMatch(/feed|CSV/);
    expect(canDelete({ source: "investment" })).toBe(false);
    expect(canDelete({ source: "manual" })).toBe(true);
    expect(undoResultText({ removed: 1, forgotten: 3 })).toBe("Import undone: 1 row removed, 3 duplicates forgotten. The file can be imported again.");
    expect(undoResultText({ removed: 2, forgotten: 0 })).toBe("Import undone: 2 rows removed. The file can be imported again.");
  });

  it("a5-ingest-transfers-12 and -02: candidates and feed accounts", () => {
    expect(candidateLabel({ id: "x", accountId: "a", accountName: "Sapphire Visa", date: "2026-10-07", amountCents: "50000", rawDescription: "PAYMENT THANK YOU", isTransfer: false })).toContain("Sapphire Visa · PAYMENT THANK YOU");
    const base = { connectionName: null, institution: null, currency: "USD", onBudget: true, closed: false, balanceCents: null, availableCents: null, balanceDate: null } as unknown as AccountView;
    const manual = { ...base, id: "m", connectionId: null, externalId: null, name: "Credit Union" } as AccountView;
    const feed = { ...base, id: "f", connectionId: "c", externalId: "CU", name: "Credit Union Savings" } as AccountView;
    const closedFeed = { ...feed, id: "g", closed: true } as AccountView;
    expect(linkableFeedAccounts(manual, [manual, feed, closedFeed]).map((a) => a.id)).toEqual(["f"]);
    expect(linkableFeedAccounts(feed, [manual, feed])).toEqual([]);
    expect(linkResultText({ merged: 2, moved: 1, dropped: 0, transfersPaired: 0 })).toBe("Linked: 2 transactions were already here, 1 was moved in.");
  });
});
