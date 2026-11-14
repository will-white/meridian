import { formatCents, isDebtAccountType, parseDecimalToCents, type AccountType, type AccountView } from "@meridian/shared";
import { fitsWire, TOO_LARGE, TOO_LARGE_IN_SENTENCE } from "./amounts.js";
import { accountTypeLabel, money } from "./format.js";

/** Accounts whose balance is what the household owes: entered as the amount owed, stored negative. */
export function isDebtType(type: AccountType): boolean {
  return isDebtAccountType(type);
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
  if (!fitsWire(magnitude)) return { ok: false, error: TOO_LARGE };
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

/**
 * A low-balance threshold as typed ("1,000", "$500"); blank is none. Read with string math and
 * bounded like every amount (audit a8-ledger-ui-14: "Too large" in dollars, not the wire's text).
 */
export function parseThreshold(raw: string): ParsedBalance {
  let s = raw.replace(/[$,\s]/g, "");
  if (s === "") return { ok: true, cents: null };
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith(".")) s = `0${s}`;
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (/^\d+\.\d{3,}$/.test(s)) return { ok: false, error: "The threshold has more than two decimals" };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, error: "The threshold is not an amount" };
  const magnitude = parseDecimalToCents(s);
  if (!fitsWire(magnitude)) return { ok: false, error: `The threshold is ${TOO_LARGE_IN_SENTENCE}` };
  return { ok: true, cents: negative ? -magnitude : magnitude };
}

/** An account the household entered by hand: no connection and never fed, so its balance is what was typed. */
export function isHandEntered(a: Pick<AccountView, "connectionId" | "externalId">): boolean {
  return a.connectionId === null && a.externalId === null;
}

/**
 * What a type change does to a hand-entered balance, asked before it is sent (audit
 * a8-ledger-ui-01). The amount typed stays what it was: a type change between a debt (card,
 * loan) and anything else changes the stored balance's sign, so "Car loan" added as Checking
 * with 15,000 owes 15,000 as a loan. Null when nothing needs saying: the same side, a feed
 * account (the bank's balance keeps its sign), no balance, or a change the API refuses
 * (`typeChangeRefusal` says that one instead: second round).
 */
export function typeChangeQuestion(a: Pick<AccountView, "name" | "type" | "connectionId" | "externalId" | "balanceCents">, next: AccountType): string | null {
  if (next === a.type || a.balanceCents === null || !isHandEntered(a) || isDebtType(a.type) === isDebtType(next)) return null;
  if (typeChangeRefusal(a, next) !== null) return null;
  const typed = isDebtType(a.type) ? -BigInt(a.balanceCents) : BigInt(a.balanceCents);
  const stored = isDebtType(next) ? -typed : typed;
  const change = `Change ${a.name} to ${accountTypeLabel(next)}?`;
  const becomes = `its balance becomes ${money(stored.toString())}, and its earlier balances change the same way.`;
  // An amount owed or a worth is never said as a negative amount (second round): a balance typed
  // below zero becomes a card in credit, or an account below zero.
  if (typed < 0n) return isDebtType(next) ? `${change} It will be ${money((-typed).toString())} in credit: ${becomes}` : `${change} I${becomes.slice(1)}`;
  const what = isDebtType(next) ? `will owe ${money(typed.toString())}` : `will be worth ${money(typed.toString())}`;
  return `${change} It ${what}: ${becomes}`;
}

/**
 * Why `PATCH /accounts/:id {type}` would be refused, said on the page before anything is asked
 * or sent (audit a8-ledger-ui-01, second round), or null when the API takes the change. The
 * API's rule (400 `debt_balance_positive`): for an account without a connection, the balance
 * after the change (negated for a hand-entered account that crosses the line between a debt
 * and anything else, decision 90) may not leave a loan above zero. A card may be in credit, so
 * only a change to Loan is refused.
 */
export function typeChangeRefusal(a: Pick<AccountView, "name" | "type" | "connectionId" | "externalId" | "balanceCents">, next: AccountType): string | null {
  if (next !== "loan" || next === a.type || a.connectionId !== null || a.balanceCents === null) return null;
  const balance = BigInt(a.balanceCents);
  const flips = isHandEntered(a) && !isDebtType(a.type);
  const after = flips ? -balance : balance;
  if (after <= 0n) return null;
  const head = `${a.name} can't be changed to ${accountTypeLabel(next)}`;
  const rule = "a loan's balance is what it owes, never above zero";
  if (flips) {
    return `${head} while its balance is ${money(a.balanceCents)}: a type change keeps the amount typed, so as a loan its balance would be ${money(after.toString())}, and ${rule}. Record a balance of zero or more first, or keep its type.`;
  }
  if (isDebtType(a.type)) return `${head} while it is ${money(a.balanceCents)} in credit: ${rule}. Record what it owes first, or keep its type.`;
  return `${head} while its balance is ${money(a.balanceCents)}: it keeps the bank's balance, and ${rule}. Record a balance of zero or less first, or keep its type.`;
}

/**
 * Closing an account, said before it is done (audit a8-ledger-ui-02). A feed account gets no
 * transactions while it is closed (phase 1 decision 34); reopening it reads the ones it missed
 * from the stored sync responses.
 */
export function closeQuestion(a: Pick<AccountView, "name" | "connectionId">): string {
  if (a.connectionId !== null) {
    return `Close ${a.name}? While it is closed the bank connection updates its balance but brings in none of its transactions, and it leaves net worth and the plan. Reopening it reads the transactions it missed from the stored sync responses.`;
  }
  return `Close ${a.name}? It leaves net worth, the plan and the lists of open accounts; "show closed" lists it, and it can be reopened.`;
}

/** The line after a reopen: a feed account's missed transactions are being read again (audit a8-ledger-ui-02). */
export function reopenNotice(a: Pick<AccountView, "name" | "connectionId">): string | null {
  if (a.connectionId === null) return null;
  return `${a.name} is open again. The transactions it missed while it was closed are being read from the stored sync responses; they appear in the register in a minute.`;
}

/** Net worth today: open accounts only (Phase 2 plan A16), whatever the page lists (audit a8-ledger-ui-17). */
export function netWorthCents(accounts: ReadonlyArray<Pick<AccountView, "closed" | "balanceCents">>): string {
  return accounts.reduce((acc, a) => acc + (!a.closed && a.balanceCents ? BigInt(a.balanceCents) : 0n), 0n).toString();
}
