/**
 * The federal tax function's bench (tax-rmd-ss §3.5; reported, never gating):
 *
 *   pnpm --filter @meridian/retirement exec vitest bench bench/federalTax.bench.ts
 *   NODE_OPTIONS=--expose-gc pnpm --filter @meridian/retirement exec vitest bench bench/federalTax.bench.ts
 *
 * Calls a second on the workload of `federalTaxWorkload.ts` (one call; a million calls, whose
 * target is under 250 ms on one core) and, when the process has `--expose-gc`, the heap after
 * 100,000 calls, printed. The asserted form of the heap check is `src/tax/federalTax.heap.test.ts`
 * (its own process, `bench/federalTaxHeap.ts`). Vitest runs bench files only under `vitest bench`.
 */

import { bench, describe } from "vitest";
import { federalTaxWorkload, heapCheck, runFederalTax } from "./federalTaxWorkload.js";

const w = federalTaxWorkload();
const gc = (globalThis as { gc?: () => void }).gc;

if (typeof gc === "function") {
  const r = await heapCheck(w, gc);
  console.log(`federalTaxInto heap check: ${r.calls} calls, heap ${r.heapDelta >= 0 ? "+" : ""}${r.heapDelta} bytes, ${r.gcCount} garbage collections`);
}

describe("federalTaxInto (tax-rmd-ss §3.5)", () => {
  bench("one household-year", () => {
    runFederalTax(w, 1);
  });
  bench(
    "1,000,000 household-years (target: under 250 ms)",
    () => {
      runFederalTax(w, 1_000_000);
    },
    { iterations: 10, time: 0, warmupIterations: 2 },
  );
});
