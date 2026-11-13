import type { AccountView, LinkFeedAccountResult, TransactionView, TransferCandidateView, UndoImportResult } from "@meridian/shared";
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
 * The feed accounts an account could take over (audit a5-ingest-transfers-02): only an account
 * without a connection can, and only a feed account that is open and not itself.
 */
export function linkableFeedAccounts(target: Pick<AccountView, "id" | "connectionId">, all: readonly AccountView[]): AccountView[] {
  if (target.connectionId !== null) return [];
  return all.filter((a) => a.id !== target.id && a.connectionId !== null && a.externalId !== null && !a.closed);
}

export function linkResultText(r: LinkFeedAccountResult): string {
  const parts = [`${plural(r.merged, "transaction was", "transactions were")} already here`, `${plural(r.moved, "was", "were")} moved in`];
  if (r.dropped > 0) parts.push(`${r.dropped} had the same id`);
  return `Linked: ${parts.join(", ")}.`;
}
