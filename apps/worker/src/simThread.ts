/**
 * The simulation thread entry (docs/design/phase-4/inputs-and-data.md §6.3; seams C10).
 *
 * The worker's second bundle, `dist/simThread.js` beside `dist/main.js`: the `retirement.simulate`
 * job starts its threads on this file (`SIM_THREAD_ENTRY` in env.ts) when it exists. All it does is
 * serve the engine's thread pool. Run from source (`tsx watch`, Vitest) the file is not built and
 * the simulations run inline on the job's thread instead.
 */

import { runThreadMain } from "@meridian/retirement/node";

runThreadMain();
