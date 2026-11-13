/**
 * Floor and ceiling (Bengen 2001, with the spec's essentials split; strategies-outputs-web decision
 * 17 and §3.4 (e)).
 *
 * Planned discretionary spending is `disc = corePlanned − essentialCore`. In the start year the
 * percentage is `fc.rate` when given, else `disc ÷ P` (0 when P is 0), kept in the state. Every
 * year `raw = rate × P` is clamped to `[(1 − floor) × disc, (1 + ceiling) × disc]` (flags
 * `BAND_FLOOR`, `BAND_CEILING`) and core spending is `essentialCore + D`. Because `disc` carries
 * inflation, phases and the survivor share, the band follows the plan; with no essentials, phases or
 * survivor change it is Bengen's rule.
 */

import type { PlannedYear } from "./planned.js";
import type { StrategyTables } from "./prepare.js";
import { RULE, SLOT, type SpendDecision } from "./types.js";

/** Writes the year's core spending into `out.spend` (before healthcare and care) and its flags into `out.rule`. */
export function floorCeilingCore(tb: StrategyTables, state: Float64Array, py: PlannedYear, out: SpendDecision): void {
  const fc = tb.fc;
  const P = py.spendable;
  const disc = py.corePlanned - py.essentialCore;
  if (state[SLOT.STARTED] === 0) {
    state[SLOT.STARTED] = 1;
    state[SLOT.FC_RATE] = Number.isNaN(fc.rate) ? (P > 0 ? disc / P : 0) : fc.rate;
  }
  const raw = state[SLOT.FC_RATE]! * P;
  const lo = (1 - fc.floor) * disc;
  const hi = (1 + fc.ceiling) * disc;
  let d = raw;
  if (d < lo) {
    d = lo;
    out.rule |= RULE.BAND_FLOOR;
  } else if (d > hi) {
    d = hi;
    out.rule |= RULE.BAND_CEILING;
  }
  out.spend = py.essentialCore + d;
}
