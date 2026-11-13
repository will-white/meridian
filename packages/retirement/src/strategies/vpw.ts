/**
 * The two gross-year rules (strategies-outputs-web decisions 3, 14 and 16, §3.4 (b) and (d)): the
 * rule sets the gross portfolio withdrawal, `gross = percentage × P + longTermCare`, and spending
 * is what is left after tax, never less than the floor `essential core + healthcare + long-term
 * care` (the withdrawal order tops up to it).
 *
 * VPW's percentage is the shared `vpwRawPercentageInto` (seams C47: one implementation for the
 * engine and the run-settings hints) at the age attained by the younger living person, with the
 * year's stock share, capped at `maxRate` (flag `CAP` when the cap binds). The query and result are
 * module-level records, so no double crosses a call (engine-and-returns §4.3).
 */

import { type VpwQuery, vpwRawPercentageInto } from "@meridian/shared";
import type { PlannedYear } from "./planned.js";
import type { StrategyTables } from "./prepare.js";
import { RULE, type SpendDecision, type SpendingView } from "./types.js";

/** The age attained this year by the younger living person (the first person's age when nobody is alive). */
export function youngerLivingAge(view: SpendingView, tb: StrategyTables): number {
  let age = Number.POSITIVE_INFINITY;
  for (let i = 0; i < tb.personCount; i++) {
    if (view.alive[i] !== 0 && view.age[i]! < age) age = view.age[i]!;
  }
  return age === Number.POSITIVE_INFINITY ? view.age[0]! : age;
}

/** `fixed_percentage`: `gross = rate × P + L`. */
export function fixedPercentageGross(tb: StrategyTables, py: PlannedYear, out: SpendDecision): void {
  out.gross = tb.fixedRate * py.spendable + py.longTermCare;
}

const QUERY: VpwQuery = { age: 0, stockShare: 0.5 };
const RESULT = { raw: 0.5 };

/** `vpw`: `gross = min(raw, maxRate) × P + L`. */
export function vpwGross(view: SpendingView, tb: StrategyTables, py: PlannedYear, out: SpendDecision): void {
  QUERY.age = youngerLivingAge(view, tb);
  QUERY.stockShare = view.stockShare;
  vpwRawPercentageInto(QUERY, tb.vpw, RESULT);
  const raw = RESULT.raw;
  let pct = raw;
  if (raw > tb.vpw.maxRate) {
    pct = tb.vpw.maxRate;
    out.rule |= RULE.CAP;
  }
  out.gross = pct * py.spendable + py.longTermCare;
}
