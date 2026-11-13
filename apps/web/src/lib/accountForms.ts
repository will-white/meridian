import { formatCents, parseDecimalToCents, type AccountType } from "@meridian/shared";

/** Accounts whose balance is what the household owes: entered as the amount owed, stored negative. */
export function isDebtType(type: AccountType): boolean {
  return type === "credit" || type === "loan";
}

/** The balance field's label: what is owed for a card or a loan (audit a6-text-rules-accounts-05). */
export function balanceFieldLabel(type: AccountType): string {
  return isDebtType(type) ? "Amount owed" : "Balance";
}

export type ParsedBalance = { ok: true; cents: bigint | null } | { ok: false; error: string };

/**
 * A manual balance as typed: "1,234.56", "$500", "12 500", "-20.5"; empty is no balance.
 * Read to the cent with string math (audit a6-text-rules-accounts-09: no floats, and a value
 * that cannot be read is said, not dropped). For a card or a loan the field is the amount
 * owed, stored negated; a loan owes a positive amount, a card may be in credit.
 */
export function parseManualBalance(raw: string, type: AccountType): ParsedBalance {
  let s = raw.replace(/[$,\s]/g, "");
  if (s === "") return { ok: true, cents: null };
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith(".")) s = `0${s}`;
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (/^\d+\.\d{3,}$/.test(s)) return { ok: false, error: "Use at most two decimals" };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, error: "Not an amount" };
  const magnitude = parseDecimalToCents(s);
  const typed = negative ? -magnitude : magnitude;
  if (!isDebtType(type)) return { ok: true, cents: typed };
  if (type === "loan" && typed < 0n) return { ok: false, error: "Enter what is owed as a positive amount" };
  return { ok: true, cents: -typed };
}

/** A stored balance as the field shows it: the amount owed for a card or a loan, the balance otherwise. */
export function owedText(balanceCents: string | null, type: AccountType): string {
  if (balanceCents === null) return "";
  const cents = BigInt(balanceCents);
  return formatCents(isDebtType(type) ? -cents : cents);
}
