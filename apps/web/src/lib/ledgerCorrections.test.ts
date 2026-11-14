import { describe, expect, it } from "vitest";
import type { AccountView, CsvImportHistoryItem } from "@meridian/shared";
import { shortDate } from "./format.js";
import { canDelete, candidateLabel, deleteWarning, importHistoryLine, linkableFeedAccounts, linkConfirmText, linkResultText, undoResultText } from "./ledgerCorrections.js";

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

  it("a5-ingest-transfers-02 (second round): an account the Bridge no longer lists can take over a feed account of its own connection", () => {
    const base = { connectionName: "Bank", institution: null, currency: "USD", onBudget: true, closed: false, balanceCents: null, availableCents: null, balanceDate: null } as unknown as AccountView;
    const gone = { ...base, id: "old", connectionId: "c", externalId: "ACT-CHK", name: "Everyday Checking", inFeed: false } as AccountView;
    const reissued = { ...base, id: "new", connectionId: "c", externalId: "ACT-CHK-NEW", name: "Everyday Checking", inFeed: true } as AccountView;
    const card = { ...base, id: "card", connectionId: "c", externalId: "CARD", name: "Visa", inFeed: true } as AccountView;
    const elsewhere = { ...base, id: "other", connectionId: "d", externalId: "SAV", name: "Savings", inFeed: true } as AccountView;
    const unknown = { ...reissued, id: "u", inFeed: null } as AccountView;
    const all = [gone, reissued, card, elsewhere, unknown];
    expect(linkableFeedAccounts(gone, all).map((a) => a.id)).toEqual(["new", "card", "u"]);
    // Listed (or not known to be gone): it is still fed; nothing to offer.
    expect(linkableFeedAccounts(reissued, all)).toEqual([]);
    expect(linkableFeedAccounts(unknown, all)).toEqual([]);
    // Another account the Bridge no longer lists is not offered either.
    expect(linkableFeedAccounts(gone, [...all, { ...gone, id: "gone2" } as AccountView]).map((a) => a.id)).toEqual(["new", "card", "u"]);
    // Both are called "Everyday Checking": the question says which is which.
    expect(linkConfirmText(gone, reissued)).toBe(
      'The bank no longer sends Everyday Checking. Make it the account the feed fills under the new account\'s id, and fold the new "Everyday Checking" (Bank) into it? Transactions both have are kept once.',
    );
    expect(linkConfirmText({ name: "Credit Union", connectionId: null }, { name: "Credit Union Savings", connectionName: "Bank" })).toBe(
      'Make Credit Union the account the feed fills, and fold "Credit Union Savings" (Bank) into it? Transactions both have are kept once.',
    );
  });

  it("a5-ingest-transfers (second round): a past bank import says when, where, what it did and whether it was undone", () => {
    const item: CsvImportHistoryItem = {
      id: "i",
      startedAt: "2026-11-02T15:04:00.000Z",
      status: "ok",
      accountId: "a",
      accountName: "Everyday Checking",
      profileName: "Chase export",
      rowsRead: 12,
      created: 9,
      duplicates: 3,
      rowsHeld: 9,
      undoneAt: null,
      canUndo: true,
    };
    const at = new Date(item.startedAt);
    const when = `${shortDate(item.startedAt)} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    expect(importHistoryLine(item)).toBe(`${when} · Everyday Checking · 12 rows: 9 added, 3 already there · mapping Chase export`);
    expect(importHistoryLine({ ...item, created: 1, duplicates: 0, rowsRead: 1, profileName: null, undoneAt: "2026-11-03T09:00:00.000Z", rowsHeld: 0, canUndo: false })).toBe(
      `${when} · Everyday Checking · 1 row: 1 added, 0 already there · undone ${shortDate("2026-11-03T09:00:00.000Z")}`,
    );
    expect(importHistoryLine({ ...item, accountName: null, status: "error" })).toMatch(/· an account no longer here · .* · failed/);
  });
});
