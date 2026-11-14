/**
 * The heap check of tax-rmd-ss §3.5 in a process of its own:
 *
 *   node --expose-gc --import tsx bench/federalTaxHeap.ts [--calls 100000] [--json]
 *
 * After a warm-up, `calls` evaluations of `federalTaxInto` on the workload of
 * `federalTaxWorkload.ts` must leave the heap unchanged and run no garbage collection. Run by
 * `src/tax/federalTax.heap.test.ts`, which asserts both; a check inside Vitest's own process would
 * measure Vitest's allocations too, and `--expose-gc` is a process flag.
 */

import { federalTaxWorkload, heapCheck } from "./federalTaxWorkload.js";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const callsAt = argv.indexOf("--calls");
const calls = callsAt >= 0 ? Number(argv[callsAt + 1]) : 100_000;
const gc = (globalThis as { gc?: () => void }).gc;
if (typeof gc !== "function") {
  console.error("bench/federalTaxHeap.ts needs node --expose-gc");
  process.exit(2);
}
const r = await heapCheck(federalTaxWorkload(), gc, calls);
if (json) console.log(JSON.stringify(r));
else {
  console.log(
    `federalTaxInto: ${r.calls} calls after ${r.warmupCalls * 2} warm-up calls in ${r.ms.toFixed(1)} ms; ` +
      `heap ${r.heapBefore} → ${r.heapAfter} bytes (${r.heapDelta >= 0 ? "+" : ""}${r.heapDelta}); ${r.gcCount} garbage collections`,
  );
}
