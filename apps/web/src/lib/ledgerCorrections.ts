import type { AccountView, CsvImportHistoryItem, LinkFeedAccountResult, TransactionView, TransferCandidateView, UndoImportResult } from "@meridian/shared";
import { money, shortDate } from "./format.js";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Investment rows are removed with their investment transaction, never from the register (audit a5-ingest-transfers-09). */
export function canDelete(t: Pick<TransactionView, "source">): boolean {
  return t.source !== "investment";
}

/** What deleting a row means, said before the household confirms it (audit a5-ingest-transfers-09). */
export function deleteWarning(t: Pick<TransactionView, "source" | "isTransfer" | "amountCents" | "date">): string {
  const parts = [`Delete this ${money(t.amountCents)} transaction of ${shortDate(t.date)}?`];
  if (t.source === "simplefin") parts.push("It came from the bank feed; the next sync will not bring it back.");
  if (t.source === "csv") parts.push("It came from a CSV file; importing that file again will not bring it back.");
  if (t.isTransfer) parts.push("Its other leg stays, as an unpaired row.");
  return parts.join(" ");
}

/** One line per candidate in "Pair with…" (audit a5-ingest-transfers-12). */
export function candidateLabel(c: TransferCandidateView): string {
  return `${shortDate(c.date)} · ${c.accountName} · ${c.rawDescription} · ${money(c.amountCents)}`;
}

/** The register's line after an import is undone. */
export function undoResultText(r: UndoImportResult): string {
  return `Import undone: ${plural(r.removed, "row", "rows")} removed${r.forgotten > 0 ? `, ${plural(r.forgotten, "duplicate", "duplicates")} forgotten` : ""}. The file can be imported again.`;
}

/**
 * The feed accounts an account could take over (audit a5-ingest-transfers-02): for an account
 * without a connection, any open feed account but itself. Second round: an account the Bridge no
 * longer lists (`inFeed` false: a re-link on the same connection gave it a new id, and the sync
 * created a second account) may take over an open account of its own connection that the Bridge
 * does list (or of which that is not known). An account the Bridge still sends is offered none.
 */
export function linkableFeedAccounts(target: Pick<AccountView, "id" | "connectionId" | "inFeed">, all: readonly AccountView[]): AccountView[] {
  const feeds = all.filter((a) => a.id !== target.id && a.connectionId !== null && a.externalId !== null && !a.closed);
  if (target.connectionId === null) return feeds;
  if (target.inFeed !== false) return [];
  return feeds.filter((a) => a.connectionId === target.connectionId && a.inFeed !== false);
}

/** What linking a feed account into an account does, asked before it is done (audit a5-ingest-transfers-02). */
export function linkConfirmText(target: Pick<AccountView, "name" | "connectionId">, feed: Pick<AccountView, "name" | "connectionName">): string {
  const source = feed.connectionName ? ` (${feed.connectionName})` : "";
  if (target.connectionId === null) return `Make ${target.name} the account the feed fills, and fold "${feed.name}"${source} into it? Transactions both have are kept once.`;
  // Second round: the Bridge re-issued the account on the same connection, often under the same name.
  return `The bank no longer sends ${target.name}. Make it the account the feed fills under the new account's id, and fold the new "${feed.name}"${source} into it? Transactions both have are kept once.`;
}

export function linkResultText(r: LinkFeedAccountResult): string {
  const parts = [`${plural(r.merged, "transaction was", "transactions were")} already here`, `${plural(r.moved, "was", "were")} moved in`];
  if (r.dropped > 0) parts.push(`${r.dropped} had the same id`);
  return `Linked: ${parts.join(", ")}.`;
}

/**
 * One past bank import on the Import page (audit a5-ingest-transfers, second round): when, into
 * which account, what it did, the saved mapping it used, and whether it failed or was undone.
 */
export function importHistoryLine(h: CsvImportHistoryItem): string {
  const at = new Date(h.startedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  // The time tells two imports of one day apart.
  const when = Number.isNaN(at.getTime()) ? shortDate(h.startedAt) : `${shortDate(h.startedAt)} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const parts = [when, h.accountName ?? "an account no longer here", `${plural(h.rowsRead, "row", "rows")}: ${h.created} added, ${h.duplicates} already there`];
  if (h.profileName) parts.push(`mapping ${h.profileName}`);
  if (h.status === "error") parts.push("failed");
  if (h.undoneAt) parts.push(`undone ${shortDate(h.undoneAt)}`);
  return parts.join(" · ");
}
