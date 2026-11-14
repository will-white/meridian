import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  defaultTaxTreatment,
  isInvestmentAccountType,
  matchPendingToPosted,
  parseSimplefinAmount,
  sanitizeText,
  unixToIsoDate,
  type AccountType,
  type IsoDate,
  type SimplefinAccount,
} from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import {
  account,
  accountReconciliation,
  balanceSnapshot,
  holdingSnapshot,
  householdSetting,
  importLog,
  investmentTxn,
  lot,
  recurring,
  savingsGoal,
  transaction,
  transactionAlias,
} from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { DUPLICATE_MAX_DAYS } from "./ingest.js";
import { lockLedger } from "./ledgerLock.js";
import { loadRules } from "./rules.js";
import { pairTransfersInDb, releaseTransferPartners } from "./transfers.js";

/**
 * Phase 3 (plan decision 15): investment-type accounts start off budget, so a brokerage's
 * buys never show as uncategorized spending. Audit a6-text-rules-accounts-08: assets (a house,
 * a vehicle) and loans start off budget too, so a property value or a mortgage is not cash in
 * the cash-flow projection; checking, savings and cards start on budget. Applied by both
 * creation paths (the SimpleFIN upsert here and `POST /api/accounts`), never by DDL.
 */
export function defaultOnBudget(type: AccountType): boolean {
  return !isInvestmentAccountType(type) && type !== "asset" && type !== "loan";
}

/**
 * SimpleFIN has no account type; guess from the name and let the user correct it. The account
 * noun decides first (audit a6-text-rules-accounts-06): "Joint Checking", "Kasasa Rewards
 * Checking" and "Student Checking" are checking accounts and "Auto Savings" a savings account,
 * whatever their qualifiers; the retirement and investment words come before that, and the
 * card and loan words only when no bank noun is present.
 */
export function guessAccountType(name: string): AccountType {
  const n = name.toLowerCase();
  if (/\b(roth)\b/.test(n)) return "roth";
  if (/\b(401\s?\(?k\)?|403\s?\(?b\)?|457|tsp)\b/.test(n)) return "401k";
  if (/\b(hsa|health savings)\b/.test(n)) return "hsa";
  if (/\b529\b/.test(n)) return "529";
  if (/\b(ira|sep|simple ira)\b/.test(n)) return "ira";
  if (/\b(brokerage|invest(ment|ing)?s?|trading|securities)\b/.test(n)) return "brokerage";
  if (/\b(mortgage|loan|heloc|line of credit)\b/.test(n)) return "loan";
  if (/\b(checking|chequing|share draft)\b/.test(n)) return "checking";
  if (/\b(savings|save|money market|mma|cd|certificate)\b/.test(n)) return "savings";
  if (/\b(credit|card|visa|mastercard|amex|discover|platinum|sapphire|freedom|rewards|cash back|double cash)\b/.test(n)) return "credit";
  // "Individual" and "Joint" with no bank noun name a brokerage registration ("Individual - TOD").
  if (/\b(individual|joint)\b/.test(n)) return "brokerage";
  if (/\b(auto|student)\b/.test(n)) return "loan";
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
    if (reattached) {
      patch.connectionId = connectionId;
      // Audit a10-conformance-ledger-04: the responses stored for the account before its connection was removed come with it, so
      // Re-read transactions and reopening a closed account replay them for the new connection too.
      await tx
        .update(importLog)
        .set({ connectionId })
        .where(and(isNull(importLog.connectionId), sql`${importLog.kind} like 'simplefin.%'`, sql`${importLog.rawPayload} -> 'accounts' @> ${JSON.stringify([{ id: sf.id }])}::jsonb`));
    }
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

/**
 * Why a manual balance cannot be stored for an account of `type`, or null: a loan's balance is
 * what is owed, so it is never positive (audit a6-text-rules-accounts-05). A card can be in
 * credit, so only loans are checked.
 */
export function manualBalanceProblem(type: AccountType, balanceCents: bigint): string | null {
  if (type === "loan" && balanceCents > 0n) return "A loan's balance is what is owed, as a negative amount (enter 15000.00 owed as -15000.00)";
  return null;
}

export interface RecordManualBalanceInput {
  accountId: string;
  date: IsoDate;
  balanceCents: bigint;
  /** The household's day: a balance may not be dated after it. */
  today: IsoDate;
}

/**
 * Audit a6-text-rules-accounts-03: record what an account without a bank connection is worth
 * or owes on a day (a house revalued, a loan paid down). The day's `balance_snapshot` becomes a
 * manual row (it outranks every other source, Phase 3 decision 14), and the account's
 * `balance_cents` and `balance_date` follow when no later balance exists, so net worth and its
 * history read it. Refused for a feed account (409 `feed_account`: its balance is the bank's), a
 * date after today (400 `future_date`) and a positive loan balance (400 `debt_balance_positive`).
 * Audited as `account` (the day's balance before and after).
 */
export async function recordManualBalance(db: Db, input: RecordManualBalanceInput, audit?: AuditContext): Promise<void> {
  if (input.date > input.today) throw new PlanError(400, "future_date", `A balance cannot be dated after today (${input.today})`);
  await db.transaction(async (tx) => {
    const [acct] = await tx.select().from(account).where(eq(account.id, input.accountId)).for("update");
    if (!acct) throw new PlanError(404, "not_found", "Account not found");
    if (acct.connectionId !== null) throw new PlanError(409, "feed_account", "This account's balance comes from its bank connection; only an account without one takes a balance by hand");
    const problem = manualBalanceProblem(acct.type, input.balanceCents);
    if (problem) throw new PlanError(400, "debt_balance_positive", problem);
    const [previous] = await tx
      .select({ balanceCents: balanceSnapshot.balanceCents, source: balanceSnapshot.source })
      .from(balanceSnapshot)
      .where(and(eq(balanceSnapshot.accountId, acct.id), eq(balanceSnapshot.date, input.date)));
    await tx
      .insert(balanceSnapshot)
      .values({ accountId: acct.id, date: input.date, balanceCents: input.balanceCents, source: "manual" })
      .onConflictDoUpdate({ target: [balanceSnapshot.accountId, balanceSnapshot.date], set: { balanceCents: input.balanceCents, availableCents: null, source: "manual" } });
    const [latest] = await tx
      .select({ date: balanceSnapshot.date, balanceCents: balanceSnapshot.balanceCents })
      .from(balanceSnapshot)
      .where(eq(balanceSnapshot.accountId, acct.id))
      .orderBy(desc(balanceSnapshot.date))
      .limit(1);
    if (latest && latest.date === input.date) {
      await tx.update(account).set({ balanceCents: input.balanceCents, balanceDate: input.date, updatedAt: new Date() }).where(eq(account.id, acct.id));
    }
    if (audit) {
      await writeAudit(tx, {
        ...audit,
        entity: "account",
        entityId: acct.id,
        action: "update",
        before: { balanceDate: input.date, balanceCents: previous ? previous.balanceCents.toString() : null },
        after: { balanceDate: input.date, balanceCents: input.balanceCents.toString() },
      });
    }
  });
}

/**
 * Audit a5-ingest-transfers-02, second round: the Bridge's account ids in each connection's
 * latest stored response that worked (a full sync or a balances refresh), the accounts an
 * `errlist` entry names included (the Bridge knows them though it may not have sent them). A
 * connection with no stored response is left out: nothing says what it lists.
 */
export async function feedListedAccountIds(tx: DbOrTx, connectionIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (connectionIds.length === 0) return out;
  // One stored response per connection, read from the newest back by the (connection, started_at) index: only that one is read whole.
  const rows = await tx.execute<{ connection_id: string; ids: unknown; named: unknown }>(sql`
    select c.id as connection_id,
      jsonb_path_query_array(l.raw_payload, '$.accounts[*].id') as ids,
      jsonb_path_query_array(l.raw_payload, '$.errlist[*].account_id') as named
    from unnest(array[${sql.join(
      connectionIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]) as c(id)
    cross join lateral (
      select raw_payload from ${importLog}
      where connection_id = c.id and kind in ('simplefin.sync', 'simplefin.balances') and status = 'ok' and raw_payload is not null
      order by started_at desc, id desc
      limit 1
    ) l`);
  for (const r of rows) {
    const ids = [...(Array.isArray(r.ids) ? r.ids : []), ...(Array.isArray(r.named) ? r.named : [])].filter((v): v is string => typeof v === "string");
    out.set(r.connection_id, new Set(ids));
  }
  return out;
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
 *
 * Second round of the audit: a Bridge that re-links a bank on the same connection issues the
 * account a new id, and the sync creates a second account beside the one the household has. An
 * account of the feed account's own connection may take it over too, once the Bridge no longer
 * lists the account's id (`feedListedAccountIds`; 409 `account_still_listed` while it does, as
 * the next sync would create it again). An account of another connection is still refused (409
 * `account_connected`).
 */
export async function linkFeedAccount(db: Db, input: { accountId: string; feedAccountId: string }, audit?: AuditContext): Promise<LinkFeedAccountResult> {
  if (input.accountId === input.feedAccountId) throw new PlanError(400, "same_account", "Choose the feed account to link to this one");
  return db.transaction(async (tx) => {
    // Folding rows in decides what is the same purchase, as an ingest does (a10-conformance-ledger-01).
    await lockLedger(tx);
    const [target] = await tx.select().from(account).where(eq(account.id, input.accountId));
    const [feedAccount] = await tx.select().from(account).where(eq(account.id, input.feedAccountId));
    if (!target || !feedAccount) throw new PlanError(404, "not_found", "Account not found");
    if (target.connectionId !== null && target.connectionId !== feedAccount.connectionId) {
      throw new PlanError(409, "account_connected", "This account is fed by another connection; only an account without one, or one of the feed account's own connection, can take over a feed account");
    }
    if (feedAccount.connectionId === null || feedAccount.externalId === null) throw new PlanError(400, "not_feed_account", "The other account does not come from a bank connection");
    if (target.connectionId !== null && target.externalId !== null && (await feedListedAccountIds(tx, [target.connectionId])).get(target.connectionId)?.has(target.externalId)) {
      throw new PlanError(409, "account_still_listed", "The bank connection still sends this account; it can take over another feed account once the Bridge no longer lists it");
    }
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
