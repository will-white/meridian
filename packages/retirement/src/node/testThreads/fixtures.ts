/**
 * Thread bodies for the harness tests (T44, engine-and-returns §7): each serves the pool like
 * `runThreadMain()` but on a path state that misbehaves in one stated way. Each `*.boot.mjs` beside
 * this file registers tsx and starts one of them, the way `thread.boot.mjs` starts the real one.
 * Nothing outside `pool.test.ts` uses them.
 */

import { decideSpending } from "../../strategies/index.js";
import { createPathState } from "../../state.js";
import { runThreadMain } from "../thread.js";

/** A withdrawal hook that takes more than is available in the first drawdown year: `EngineInvariantError("withdrawal_out_of_range")`. */
export function violatingThread(): void {
  runThreadMain({
    createState: (run) =>
      createPathState(run, {
        decideSpending,
        planWithdrawals: (view, _decision, _assess, w) => {
          w[0] = view.available[0]! + 1;
        },
      }),
  });
}

/** A thread that exits (code 3) when it is asked to prepare a run. */
export function exitingThread(): void {
  runThreadMain({
    createState: () => process.exit(3),
  });
}

/** A thread whose run fails with an error that is not one of the engine's (a `TypeError`). */
export function throwingThread(): void {
  runThreadMain({
    createState: () => {
      throw new TypeError("a fault that is not an engine error");
    },
  });
}
