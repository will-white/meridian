import { and, eq } from "drizzle-orm";
import {
  defaultTaxTreatment,
  parseDecimalToCents,
  sanitizeText,
  unixToIsoDate,
  type AccountType,
  type SimplefinAccount,
} from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { account, balanceSnapshot } from "../schema/index.js";

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
}

/** Create or refresh the account row for a SimpleFIN account and record today's balance. */
export async function upsertSimplefinAccount(tx: DbOrTx, connectionId: string, sf: SimplefinAccount): Promise<UpsertAccountResult> {
  const name = sanitizeText(sf.name, 100) || "Account";
  const institution = sanitizeText(sf.org.name ?? sf.org.domain ?? "", 100) || null;
  const balanceCents = parseDecimalToCents(sf.balance);
  const availableCents = sf["available-balance"] ? parseDecimalToCents(sf["available-balance"]) : null;
  const balanceDate = unixToIsoDate(sf["balance-date"]);

  const [existing] = await tx
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.connectionId, connectionId), eq(account.externalId, sf.id)));

  let id: string;
  let created = false;
  if (existing) {
    id = existing.id;
    await tx
      .update(account)
      .set({ institution, currency: sanitizeText(sf.currency, 10) || "USD", balanceCents, availableCents, balanceDate, updatedAt: new Date() })
      .where(eq(account.id, id));
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
        currency: sanitizeText(sf.currency, 10) || "USD",
        balanceCents,
        availableCents,
        balanceDate,
      })
      .returning({ id: account.id });
    id = inserted!.id;
    created = true;
  }

  await tx
    .insert(balanceSnapshot)
    .values({ accountId: id, date: balanceDate, balanceCents, availableCents, source: "simplefin" })
    .onConflictDoUpdate({ target: [balanceSnapshot.accountId, balanceSnapshot.date], set: { balanceCents, availableCents, source: "simplefin" } });

  return { id, created };
}
