import { and, eq, sql } from "drizzle-orm";
import {
  defaultTaxTreatment,
  isInvestmentAccountType,
  parseSimplefinAmount,
  sanitizeText,
  unixToIsoDate,
  type AccountType,
  type SimplefinAccount,
} from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { account, balanceSnapshot } from "../schema/index.js";

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

  const [existing] = await tx
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.connectionId, connectionId), eq(account.externalId, sf.id)));

  let id: string;
  let created = false;
  if (existing) {
    id = existing.id;
    const patch: Partial<typeof account.$inferInsert> = { institution, currency, updatedAt: new Date() };
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
  const result: UpsertAccountResult = { id, created, balanceUnreadable: balance === undefined, availableUnreadable: available === undefined, rounded };
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
