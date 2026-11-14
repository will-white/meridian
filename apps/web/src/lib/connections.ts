import type { ConnectionView } from "@meridian/shared";

/**
 * What the Connections page says about a SimpleFIN connection's sync state, kept out of the
 * component so the wording and the rules can be tested.
 */

/** The last sync that ran to its end was not a success: the last try is later than the last success, or there never was one. */
export function lastAttemptFailed(c: Pick<ConnectionView, "lastSyncAt" | "lastAttemptAt">): boolean {
  if (!c.lastAttemptAt) return false;
  return !c.lastSyncAt || new Date(c.lastAttemptAt).getTime() > new Date(c.lastSyncAt).getTime();
}

/** "3 accounts · last sync 2 h ago · complete through 2026-10-13", with the last try added when it failed. */
export function syncSummary(
  c: Pick<ConnectionView, "accountCount" | "lastSyncAt" | "lastAttemptAt" | "syncedThrough">,
  relative: (iso: string | null | undefined) => string,
): string {
  const parts = [`${c.accountCount} account${c.accountCount === 1 ? "" : "s"}`, `last sync ${relative(c.lastSyncAt)}`];
  if (lastAttemptFailed(c)) parts.push(`last tried ${relative(c.lastAttemptAt)}`);
  if (c.syncedThrough) parts.push(`complete through ${c.syncedThrough}`);
  return parts.join(" · ");
}

/**
 * What the app is doing about a connection that is not syncing cleanly and what the household
 * can do, under the error text. Null when there is nothing to add.
 */
export function syncAdvice(c: Pick<ConnectionView, "status" | "syncPaused" | "syncedThrough" | "lastAttemptAt">): string | null {
  if (c.status === "disabled" || c.status === "claiming") return null;
  if (c.syncPaused) {
    return "Scheduled syncs are paused, because asking again cannot fix this. Once it is sorted out at the Bridge, press Sync now: the schedule resumes when that sync works.";
  }
  if (c.status === "auth_required") {
    const since = c.syncedThrough ? `, and the first complete one fetches everything since ${c.syncedThrough}` : "";
    return `Re-authenticate the bank at the SimpleFIN Bridge. Syncs keep running in the meantime${since}.`;
  }
  // An error with no sync ever tried is a setup token that could not be claimed: the error text says what to do, and nothing is scheduled.
  if (c.status === "error" && c.lastAttemptAt) return "The schedule tries again one sync interval after the last try. Sync now tries at once.";
  return null;
}

export interface SyncControls {
  syncNow: boolean;
  balancesOnly: boolean;
  fullResync: boolean;
}

/**
 * Which sync buttons can be pressed. One job per connection at a time; a balances-only
 * refresh only makes sense on a working connection; a full resync needs an access URL, so
 * not while the token is still being claimed.
 */
export function syncControls(c: Pick<ConnectionView, "status" | "activeJob">): SyncControls {
  const idle = c.activeJob === null && c.status !== "disabled";
  return { syncNow: idle, balancesOnly: idle && c.status === "ok", fullResync: idle && c.status !== "claiming" };
}

/**
 * Audit a10-conformance-ledger-04: what removing a SimpleFIN connection keeps and loses, asked
 * before it happens. The stored bank responses stay (they are what Re-read transactions and
 * reopening a closed account replay), and adding the connection again takes them over with the
 * accounts.
 */
export function removeConnectionPrompt(name: string): string {
  return `Remove ${name}? Accounts, transactions and the stored bank responses stay; the access URL is deleted. Adding the connection again attaches the same accounts and their stored responses.`;
}

/** Audit a10-conformance-ledger-04: deleting a CSV mapping profile removes the saved mapping only; the imports made with it stay and can still be undone. */
export function deleteProfilePrompt(name: string): string {
  return `Delete the mapping "${name}"? Only the saved column mapping goes; the imports made with it, and their rows, stay, and each can still be undone from the Import page.`;
}

/**
 * Audit a3-sync-core, second round: a sync.gap notice names days the feed was never asked for
 * again. It stays on the connection through later syncs, so the page offers to put it away;
 * nothing else in the list is dismissed (the next response replaces those). Null for an entry
 * that is not one, or a notice without its days.
 */
export function dismissibleGap(e: ConnectionView["lastErrors"][number]): { from: string; to: string } | null {
  return e.code === "sync.gap" && e.from && e.to ? { from: e.from, to: e.to } : null;
}

/** Asked before a notice is dismissed: after that nothing on the page says those days may be missing. */
export function dismissGapPrompt(gap: { from: string; to: string }): string {
  return `Dismiss the notice about ${gap.from} to ${gap.to}? Do it once a CSV import from the bank covers those days: no sync asks the Bridge for them again.`;
}
