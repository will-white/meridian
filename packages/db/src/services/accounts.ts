import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  defaultTaxTreatment,
  isInvestmentAccountType,
  matchPendingToPosted,
  parseSimplefinAmount,
  sanitizeText,
  unixToIsoDate,
  type AccountType,
  type SimplefinAccount,
} from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import {
  account,
  accountReconciliation,
  balanceSnapshot,
  holdingSnapshot,
  householdSetting,
  investmentTxn,
  lot,
  recurring,
  savingsGoal,
  transaction,
  transactionAlias,
} from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { DUPLICATE_MAX_DAYS } from "./ingest.js";
import { loadRules } from "./rules.js";
import { pairTransfersInDb, releaseTransferPartners } from "./transfers.js";

/**
 * Phase 3 (plan decision 15): investment-type accounts start off budget, so a brokerage's
 * buys never show as uncategorized spending; every other type starts on budget. Applied by
 * both creation paths (the SimpleFIN upsert here and `POST /api/accounts`), never by DDL.
 */
export function defaultOnBudget(type: AccountType): boolean {
  return !isInvestmentAccountType(type);
}

/** SimpleFIN has no account type; guess from the name and let the user correct it. */
export function guessAccountType(name: string): AccountType {
  const n = name.toLowerCase();
  if (/\b(roth)\b/.test(n)) return "roth";
  if (/\b(401\s?\(?k\)?|403\s?\(?b\)?|457|tsp)\b/.test(n)) return "401k";
  if (/\b(hsa|health savings)\b/.test(n)) return "hsa";
  if (/\b529\b/.test(n)) return "529";
  if (/\b(ira|sep|simple ira)\b/.test(n)) return "ira";
  if (/\b(brokerage|invest|trading|individual|joint|securities)\b/.test(n)) return "brokerage";
  if (/\b(credit|card|visa|mastercard|amex|discover|platinum|sapphire|freedom|rewards)\b/.test(n)) return "credit";
  if (/\b(mortgage|loan|auto|student|heloc|line of credit)\b/.test(n)) return "loan";
  if (/\b(savings|save|money market|mma|cd)\b/.test(n)) return "savings";
  return "checking";
}

export interface UpsertAccountResult {
  id: string;
  created: boolean;
  /** The feed's balance could not be read (`parseSimplefinAmount`): the last known balance was kept and no balance row written. */
  balanceUnreadable: boolean;
  /** The available balance could not be read: the stored one was kept (null on a new account). */
  availableUnreadable: boolean;
  /** How many of the two amounts had digits below a cent and were rounded. */
  rounded: number;
  /** An account without a connection that carries the feed's id was attached to this connection (audit a5-ingest-transfers-02). */
  reattached: boolean;
}

/**
 * Create or refresh the account row for a SimpleFIN account and record today's balance. A
 * balance that cannot be read (audit a4-sync-parse-01) leaves the account's last known one
 * in place, and writes no balance row, instead of failing the sync; a new account is created
 * without one.
 */
export async function upsertSimplefinAccount(tx: DbOrTx, connectionId: string, sf: SimplefinAccount): Promise<UpsertAccountResult> {
  const name = sanitizeText(sf.name, 100) || "Account";
  const institution = sanitizeText(sf.org.name ?? sf.org.domain ?? "", 100) || null;
  const balance = parseSimplefinAmount(sf.balance);
  const available = sf["available-balance"] === undefined ? null : parseSimplefinAmount(sf["available-balance"]);
  const rounded = (balance?.rounded ? 1 : 0) + (available?.rounded ? 1 : 0);
  const balanceCents = balance?.cents ?? null;
  const availableCents = available?.cents ?? null;
  const balanceDate = unixToIsoDate(sf["balance-date"]);
  const currency = sanitizeText(sf.currency, 10) || "USD";

  let [existing] = await tx
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.connectionId, connectionId), eq(account.externalId, sf.id)));
  // Audit a5-ingest-transfers-02: removing a connection keeps its accounts without one. The same
  // feed account seen again (the connection removed and added again) is that account, so it is
  // attached to the new connection instead of created a second time with every transaction.
  let reattached = false;
  if (!existing) {
    [existing] = await tx
      .select({ id: account.id })
      .from(account)
      .where(and(isNull(account.connectionId), eq(account.externalId, sf.id)))
      .orderBy(asc(account.createdAt), asc(account.id))
      .limit(1);
    reattached = existing !== undefined;
  }

  let id: string;
  let created = false;
  if (existing) {
    id = existing.id;
    const patch: Partial<typeof account.$inferInsert> = { institution, currency, updatedAt: new Date() };
    if (reattached) patch.connectionId = connectionId;
    if (balance) {
      patch.balanceCents = balance.cents;
      patch.balanceDate = balanceDate;
      if (available !== undefined) patch.availableCents = availableCents;
    }
    await tx.update(account).set(patch).where(eq(account.id, id));
  } else {
    const type = guessAccountType(name);
    const [inserted] = await tx
      .insert(account)
      .values({
        connectionId,
        externalId: sf.id,
        name,
        institution,
        type,
        taxTreatment: defaultTaxTreatment[type],
        currency,
        onBudget: defaultOnBudget(type),
        balanceCents,
        availableCents: balance ? availableCents : null,
        balanceDate: balance ? balanceDate : null,
      })
      .returning({ id: account.id });
    id = inserted!.id;
    created = true;
  }
  const result: UpsertAccountResult = { id, created, balanceUnreadable: balance === undefined, availableUnreadable: available === undefined, rounded, reattached };
  if (!balance) return result;

  // Phase 3 (plan decision 14, seams C41): the balance row follows the snapshot precedence
  // manual > csv > simplefin > computed (the rank `writeReportedBalance` in holdings.ts applies),
  // so a hand-checked statement balance and a positions import's statement total both survive
  // the next sync; a feed row refreshes only a feed or computed row.
  await tx
    .insert(balanceSnapshot)
    .values({ accountId: id, date: balanceDate, balanceCents: balance.cents, availableCents, source: "simplefin" })
    .onConflictDoUpdate({
      target: [balanceSnapshot.accountId, balanceSnapshot.date],
      set: { balanceCents: balance.cents, availableCents, source: "simplefin" },
      setWhere: sql`(case ${balanceSnapshot.source} when 'manual' then 3 when 'csv' then 2 when 'simplefin' then 1 else 0 end) <= 1`,
    });

  return result;
}

export interface LinkFeedAccountResult {
  /** Feed rows that were purchases the account already had: its rows took over their ids, the edits on them stayed. */
  merged: number;
  /** Feed rows the account lacked, moved into it. */
  moved: number;
  /** Feed rows whose id the account already had (or the household had deleted). */
  dropped: number;
  transfersPaired: number;
}

/**
 * Audit a5-ingest-transfers-02: the household says a feed account is an account it already has.
 * The Bridge re-issued the account under a new id after a re-link, or its history came from a
 * CSV (or a removed connection) before the bank was connected. The account takes over the feed
 * account's connection and id, so every later sync lands in it, and the feed account's rows
 * are folded in without doubling: a row whose id the account has is dropped, a row that is the
 * same purchase as one of the account's (equal amount, `DUPLICATE_MAX_DAYS`, a shared
 * description; its CSV and manual rows and its feed rows the new ids replaced) is taken over by
 * that row, and the rest are moved. Balances the account lacks are copied; the feed's holdings
 * snapshots are dropped and the next sync writes them again; recurring items, goals, the
 * cash-flow account and card payment settings that named the feed account follow it. Refused
 * when the account has a connection of its own (409 `account_connected`), when the other
 * account is not from a feed (400 `not_feed_account`), and when the feed account already holds
 * investment history of its own (409 `feed_account_has_history`). Audited as `account`.
 */
export async function linkFeedAccount(db: Db, input: { accountId: string; feedAccountId: string }, audit?: AuditContext): Promise<LinkFeedAccountResult> {
  if (input.accountId === input.feedAccountId) throw new PlanError(400, "same_account", "Choose the feed account to link to this one");
  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(account).where(eq(account.id, input.accountId));
    const [feedAccount] = await tx.select().from(account).where(eq(account.id, input.feedAccountId));
    if (!target || !feedAccount) throw new PlanError(404, "not_found", "Account not found");
    if (target.connectionId !== null) throw new PlanError(409, "account_connected", "This account is fed by a connection already; only an account without one can take over a feed account");
    if (feedAccount.connectionId === null || feedAccount.externalId === null) throw new PlanError(400, "not_feed_account", "The other account does not come from a bank connection");
    const history = await tx.execute<{ n: number }>(sql`
      select (select count(*) from ${investmentTxn} where ${investmentTxn.accountId} = ${feedAccount.id})
           + (select count(*) from ${lot} where ${lot.accountId} = ${feedAccount.id})
           + (select count(*) from ${accountReconciliation} where ${accountReconciliation.accountId} = ${feedAccount.id})
           + (select count(*) from ${holdingSnapshot} where ${holdingSnapshot.accountId} = ${feedAccount.id} and ${holdingSnapshot.source} <> 'simplefin') as n`);
    if (Number(history[0]?.n ?? 0) > 0) {
      throw new PlanError(409, "feed_account_has_history", "The feed account has investment history of its own (trades, lots or a statement); link it before entering any");
    }

    const feedRows = await tx.select().from(transaction).where(eq(transaction.accountId, feedAccount.id));
    const targetRows = await tx.select().from(transaction).where(eq(transaction.accountId, target.id));
    const targetIds = new Set(targetRows.flatMap((r) => (r.externalId ? [r.externalId] : [])));
    const targetAliases = await tx.select({ externalId: transactionAlias.externalId }).from(transactionAlias).where(eq(transactionAlias.accountId, target.id));
    for (const a of targetAliases) targetIds.add(a.externalId);
    const feedIds = new Set(feedRows.flatMap((r) => (r.externalId ? [r.externalId] : [])));

    const dropped = feedRows.filter((r) => r.externalId !== null && targetIds.has(r.externalId));
    const rest = feedRows.filter((r) => !(r.externalId !== null && targetIds.has(r.externalId)));
    // The account's rows another source made, and its feed rows whose ids the feed no longer uses.
    const candidates = targetRows.filter((r) => r.source === "csv" || r.source === "manual" || (r.source === "simplefin" && (r.externalId === null || !feedIds.has(r.externalId))));
    const matches = matchPendingToPosted(
      candidates.map((r) => ({ id: r.id, amountCents: r.amountCents, date: r.date, description: r.rawDescription })),
      rest.filter((r) => r.externalId !== null && r.source !== "investment").map((r) => ({ externalId: r.id, amountCents: r.amountCents, date: r.date, description: r.rawDescription })),
      { changedAmounts: false, maxDays: DUPLICATE_MAX_DAYS },
    );
    const removedFeedRows = dropped.map((r) => r.id);
    let merged = 0;
    for (const f of rest) {
      const targetRowId = matches.get(f.id);
      if (!targetRowId) continue;
      const r = candidates.find((c) => c.id === targetRowId)!;
      removedFeedRows.push(f.id);
      merged++;
      if (f.pending && !r.pending) {
        await tx.insert(transactionAlias).values({ accountId: target.id, externalId: f.externalId!, transactionId: r.id, source: "simplefin" }).onConflictDoNothing();
        continue;
      }
      const patch: Partial<typeof transaction.$inferInsert> = {
        externalId: f.externalId,
        source: "simplefin",
        date: f.date,
        rawDescription: f.rawDescription,
        memo: f.memo ?? r.memo,
        pending: f.pending,
        postedAt: f.postedAt,
        importLogId: f.importLogId,
        updatedAt: new Date(),
      };
      // What the household did on the feed's copy counts where the account's row has nothing.
      if (r.categoryId === null && !r.categoryLocked && f.categoryId !== null) patch.categoryId = f.categoryId;
      if (r.notes === null && f.notes !== null) patch.notes = f.notes;
      await tx.update(transaction).set({ externalId: null }).where(eq(transaction.id, f.id));
      await tx.update(transaction).set(patch).where(eq(transaction.id, r.id));
      if (r.externalId !== null) {
        await tx
          .insert(transactionAlias)
          .values({ accountId: target.id, externalId: r.externalId, transactionId: r.id, source: r.source === "csv" ? "csv" : "simplefin", importLogId: r.source === "csv" ? r.importLogId : null })
          .onConflictDoNothing();
      }
    }
    const rules = await loadRules(tx);
    const released = await releaseTransferPartners(tx, removedFeedRows, rules);
    if (removedFeedRows.length > 0) await tx.delete(transaction).where(inArray(transaction.id, removedFeedRows));
    const removedSet = new Set(removedFeedRows);
    const moved = feedRows.filter((r) => !removedSet.has(r.id));
    if (moved.length > 0) await tx.update(transaction).set({ accountId: target.id, updatedAt: new Date() }).where(eq(transaction.accountId, feedAccount.id));

    // The feed account's own ids (pending copies, deleted rows) follow it, unless the account knows the id already.
    await tx.execute(sql`
      delete from ${transactionAlias} a using ${transactionAlias} b
      where a.account_id = ${feedAccount.id} and b.account_id = ${target.id} and a.external_id = b.external_id`);
    await tx.update(transactionAlias).set({ accountId: target.id }).where(eq(transactionAlias.accountId, feedAccount.id));
    await tx.execute(sql`
      insert into ${balanceSnapshot} (account_id, date, balance_cents, available_cents, source)
      select ${target.id}, date, balance_cents, available_cents, source from ${balanceSnapshot} where account_id = ${feedAccount.id}
      on conflict (account_id, date) do nothing`);
    await tx.update(recurring).set({ accountId: target.id }).where(eq(recurring.accountId, feedAccount.id));
    await tx.update(recurring).set({ transferAccountId: target.id }).where(eq(recurring.transferAccountId, feedAccount.id));
    await tx.update(savingsGoal).set({ linkedAccountId: target.id }).where(eq(savingsGoal.linkedAccountId, feedAccount.id));
    await tx.update(householdSetting).set({ primaryAccountId: target.id }).where(eq(householdSetting.primaryAccountId, feedAccount.id));
    await tx.update(account).set({ paymentFromAccountId: target.id }).where(eq(account.paymentFromAccountId, feedAccount.id));

    await tx.delete(account).where(eq(account.id, feedAccount.id));
    const feedIsNewer = feedAccount.balanceDate !== null && (target.balanceDate === null || feedAccount.balanceDate >= target.balanceDate);
    await tx
      .update(account)
      .set({
        connectionId: feedAccount.connectionId,
        externalId: feedAccount.externalId,
        institution: feedAccount.institution ?? target.institution,
        ...(feedIsNewer ? { balanceCents: feedAccount.balanceCents, availableCents: feedAccount.availableCents, balanceDate: feedAccount.balanceDate } : {}),
        updatedAt: new Date(),
      })
      .where(eq(account.id, target.id));
    if (audit) {
      await writeAudit(tx, {
        ...audit,
        entity: "account",
        entityId: target.id,
        action: "update",
        before: { connectionId: target.connectionId, externalId: target.externalId },
        after: { connectionId: feedAccount.connectionId, externalId: feedAccount.externalId, linkedFrom: feedAccount.id },
      });
      await writeAudit(tx, { ...audit, entity: "account", entityId: feedAccount.id, action: "delete", before: { name: feedAccount.name, externalId: feedAccount.externalId, mergedInto: target.id }, after: null });
    }

    const dates = [...feedRows.map((r) => r.date), ...released.map((r) => r.date)].sort();
    const transfersPaired = dates.length > 0 ? await pairTransfersInDb(tx, { since: dates[0]!, until: dates[dates.length - 1]! }) : 0;
    return { merged, moved: moved.length, dropped: dropped.length, transfersPaired };
  });
}
