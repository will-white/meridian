/**
 * The largest amount a request may carry: the wire's cents are at most 15 digits
 * (9,999,999,999,999.99). Every money field checks it before sending and says "Too large" in
 * dollars, instead of the server's contract text about cents (audit b7-plan-ui-13 for the plan
 * grid and the goal form; a8-ledger-ui-14 for balances, thresholds, rule bounds, split lines and
 * new transactions).
 */
export const MAX_WIRE_CENTS = 999_999_999_999_999n;

export const TOO_LARGE = "Too large (at most 9,999,999,999,999.99)";

/** Whether a signed amount in cents fits the wire. */
export function fitsWire(cents: bigint): boolean {
  return (cents < 0n ? -cents : cents) <= MAX_WIRE_CENTS;
}

/** The longest search the register sends (`TransactionQuery.q`). */
export const SEARCH_MAX_LENGTH = 200;

/** The same, inside a sentence: "Line 2: too large (at most …)". */
export const TOO_LARGE_IN_SENTENCE = "too large (at most 9,999,999,999,999.99)";
