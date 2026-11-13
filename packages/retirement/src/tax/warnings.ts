/**
 * Run warnings of the tax area (tax-rmd-ss §3.11, decision 48; seams C41).
 *
 * Compile warnings (`tax_data_stale`, `limits_pending`, `rmd_joint_table_unavailable` from
 * `compileTaxLaw`; `ss_statement_old` from `compileSsPlan`) are the same on every path. Path
 * warnings are amounts: each path owns a `Float64Array(WN_REC)` (layout `WN`) and the loop calls
 * `noteWarning(wn, slot, amount)`, which keeps the largest amount of one year. After a path the
 * harness adds it to its chunk's totals (`addPathWarnings`): per slot the largest amount
 * (`warnMax`) and the number of paths with a positive amount (`warnPaths`). Chunks merge with
 * `mergeWarningTotals` by the same maximum and sum, so the result does not depend on the thread
 * count, the chunking or the order (L5). `warningMessages` turns the compile warnings and the
 * merged totals into the run's `{ code, message }` list; `SimOutput.warnings` is the engine's
 * warnings followed by it. `CASH_SERIES_MISSING` does not exist (C17 item 6).
 */

import { WN, WN_REC } from "./layout.js";

/** The run-warning code of each path-warning slot (slots 4 to 7 are reserved). */
export const PATH_WARNING_CODES = ["ss_earnings_test", "early_withdrawal_penalty", "roth_basis_unknown", "contribution_capped"] as const;
export type PathWarningCode = (typeof PATH_WARNING_CODES)[number];

/** A path's warning amounts back to 0, before the path starts. */
export function resetPathWarnings(wn: Float64Array): void {
  wn.fill(0, 0, WN_REC);
}

/** `wn[slot] = max(wn[slot], amount)`: the largest amount of one year on the path. Allocates nothing. */
export function noteWarning(wn: Float64Array, slot: number, amount: number): void {
  if (amount > wn[slot]!) wn[slot] = amount;
}

/** A chunk's (or the run's) merged path warnings (seams C41's `ChunkSummary.warnMax` and `warnPaths`). */
export interface WarningTotals {
  /** Per slot, the largest amount over the paths. */
  readonly warnMax: Float64Array;
  /** Per slot, the number of paths with a positive amount. */
  readonly warnPaths: Uint32Array;
}

export function createWarningTotals(): WarningTotals {
  return { warnMax: new Float64Array(WN_REC), warnPaths: new Uint32Array(WN_REC) };
}

/** Adds one finished path's amounts to `totals`. Allocates nothing. */
export function addPathWarnings(totals: WarningTotals, wn: Float64Array): void {
  const { warnMax, warnPaths } = totals;
  for (let k = 0; k < WN_REC; k++) {
    const v = wn[k]!;
    if (v > 0) {
      warnPaths[k] = warnPaths[k]! + 1;
      if (v > warnMax[k]!) warnMax[k] = v;
    }
  }
}

/** Merges the totals of another chunk into `into`: the maximum and the sum per slot, independent of order. */
export function mergeWarningTotals(into: WarningTotals, from: WarningTotals): void {
  for (let k = 0; k < WN_REC; k++) {
    if (from.warnMax[k]! > into.warnMax[k]!) into.warnMax[k] = from.warnMax[k]!;
    into.warnPaths[k] = into.warnPaths[k]! + from.warnPaths[k]!;
  }
}

/** A whole number with thousands separators (no locale: the same text on every machine). */
function grouped(n: number): string {
  const digits = String(n);
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

/** Whole dollars, rounded half away from zero (amounts here are positive). */
function dollars(x: number): string {
  return `$${grouped(Math.floor(x + 0.5))}`;
}

function onPaths(n: number, total: number): string {
  return `on ${grouped(n)} of ${grouped(total)} path${total === 1 ? "" : "s"}`;
}

const PATH_MESSAGES: Record<PathWarningCode, (amount: string, paths: string) => string> = {
  ss_earnings_test: (a, p) => `The Social Security earnings test withholds up to ${a} in a year ${p}; the months are credited back at full retirement age.`,
  early_withdrawal_penalty: (a, p) =>
    `Withdrawals before 59½, and HSA withdrawals for other than medical costs before 65, carry additional tax of up to ${a} in a year ${p}.`,
  roth_basis_unknown: (a, p) =>
    `Roth withdrawals of up to ${a} in a year are taxed as earnings ${p} because the Roth contribution basis was not entered; enter it on the account to be exact.`,
  contribution_capped: (a, p) =>
    `Planned contributions exceed the legal limits by up to ${a} in a year ${p}; an employee's excess is saved after tax in the surplus account and an employer's excess is dropped.`,
};

/**
 * The run's warnings of this area: the compile warnings as given, then one entry per path-warning
 * slot with a path count above 0, in slot order (`PATH_WARNING_CODES`). Amounts are the year's
 * nominal dollars, shown whole.
 */
export function warningMessages(
  compile: ReadonlyArray<{ code: string; message: string }>,
  totals: WarningTotals,
  totalPaths: number,
): Array<{ code: string; message: string }> {
  const out = compile.map((w) => ({ code: w.code, message: w.message }));
  PATH_WARNING_CODES.forEach((code, slot) => {
    const n = totals.warnPaths[slot]!;
    if (n > 0) out.push({ code, message: PATH_MESSAGES[code](dollars(totals.warnMax[slot]!), onPaths(n, totalPaths)) });
  });
  return out;
}

/** The slots of `WN` in the order of `PATH_WARNING_CODES` (a compile-time check of the two lists). */
export const PATH_WARNING_SLOTS = [WN.SS_EARNINGS_TEST, WN.EARLY_PENALTY, WN.ROTH_BASIS_UNKNOWN, WN.CONTRIBUTION_CAPPED] as const;
