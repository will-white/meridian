/**
 * The workload of the federal tax function's bench and heap check (tax-rmd-ss §3.5): household-years
 * that reach every part of `federalTaxInto` (ordinary brackets, the 0/15/20% gains bands, the
 * taxation of Social Security, the senior deduction, the net investment income tax, a capital loss
 * and its carry, both additional taxes, the partial first year), on a path's tables for 30 plan
 * years indexed at 3% inflation, single and married filing jointly.
 *
 * The household-years are the inputs of the design's cases B1, D1 and HC-T1 to HC-T10 with a few
 * of their own; they are inputs only, nothing here is an expected value.
 */

import { compileTaxLaw, fillPathTables } from "../src/tax/compile.js";
import { federalTaxInto } from "../src/tax/federalTax.js";
import { PROG_REC, TAX_IN, TAX_OUT, TAX_REC, TI, TO, taxOffset } from "../src/tax/layout.js";
import { loadTaxData } from "../src/tax/taxData.js";

type Slots = Partial<Record<Exclude<keyof typeof TI, "RESERVED0">, number>>;

/** One household-year: its inputs, filing status and plan year (0 … 29). */
const CASES: ReadonlyArray<{ status: 0 | 1; year: number; x: Slots }> = [
  { status: 0, year: 0, x: { WAGES: 100000 } }, // B1
  { status: 0, year: 0, x: { WAGES: 30000, LT_GAIN: 40000 } }, // D1's bands
  { status: 1, year: 0, x: { WAGES: 150000 } }, // HC-T1
  { status: 1, year: 1, x: { WAGES: 80000, LT_GAIN: 60000 } }, // HC-T3
  { status: 1, year: 2, x: { WAGES: 200000, LT_GAIN: 100000 } }, // HC-T4, the NIIT
  { status: 1, year: 3, x: { OTHER_ORD: 30000, SS_GROSS: 40000 } }, // HC-T5
  { status: 0, year: 4, x: { OTHER_ORD: 100000, N_AGED: 1 } }, // HC-T6
  { status: 0, year: 5, x: { PENSION: 40000, SS_GROSS: 24000, ORD_DIV: 5000, QUAL_DIV: 5000, LT_GAIN: 10000, N_AGED: 1 } }, // HC-T9
  { status: 1, year: 6, x: { WAGES: 240000, INTEREST: 10000, ORD_DIV: 20000, QUAL_DIV: 20000, LT_GAIN: 30000 } }, // HC-T10
  { status: 1, year: 9, x: { TRAD_DIST: 20000, SS_GROSS: 40000, ORD_DIV: 6000, QUAL_DIV: 6000, LT_GAIN: 30000, N_AGED: 2 } }, // HC-T12
  { status: 0, year: 12, x: { WAGES: 50000, LT_GAIN: -8000, LOSS_CARRY_IN: 2500 } },
  { status: 0, year: 15, x: { TRAD_DIST: 50000, PEN10_BASE: 50000, HSA_TAXABLE: 4000, PEN20_BASE: 4000 } },
  { status: 1, year: 20, x: { WAGES: 900000, LT_GAIN: 400000, ROTH_CONV: 50000 } },
  { status: 1, year: 29, x: { ROTH_TAXABLE: 12000, TAX_EXEMPT_INTEREST: 3000, RENTAL: 18000, N_AGED: 2 } },
  { status: 0, year: 0, x: { WAGES: 25000, YEAR_FRACTION: 2 / 12 } }, // a partial first year
  { status: 1, year: 0, x: { WAGES: 60000, SS_GROSS: 9000, YEAR_FRACTION: 0.25 } },
];

export interface FederalTaxWorkload {
  readonly table: Float64Array;
  /** Case k's input record and its table offset. */
  readonly inputs: readonly Float64Array[];
  readonly offsets: Int32Array;
  readonly out: Float64Array;
  /** Where each call's `TO.TOTAL` is summed, so that no call can be dropped as dead code. */
  readonly sink: Float64Array;
}

export function federalTaxWorkload(): FederalTaxWorkload {
  const years = 30;
  const law = compileTaxLaw(loadTaxData(), { startYear: 2026, years, ruleSetId: "current_law" });
  const table = new Float64Array(years * 2 * TAX_REC);
  const prog = new Float64Array(years * PROG_REC);
  fillPathTables(law, new Float64Array(years).fill(0.03), { chainedCpiWedge: 0, realWageGrowth: 0 }, table, prog);
  const inputs = CASES.map((c) => {
    const x = new Float64Array(TAX_IN);
    x[TI.YEAR_FRACTION] = 1;
    for (const [name, value] of Object.entries(c.x)) x[TI[name as keyof Slots]] = value as number;
    return x;
  });
  const offsets = Int32Array.from(CASES, (c) => taxOffset(c.year, c.status));
  return { table, inputs, offsets, out: new Float64Array(TAX_OUT), sink: new Float64Array(1) };
}

/** `calls` evaluations of `federalTaxInto`, cycling through the cases. Allocates nothing. */
export function runFederalTax(w: FederalTaxWorkload, calls: number): void {
  const { table, inputs, offsets, out, sink } = w;
  const n = inputs.length;
  let k = 0;
  for (let c = 0; c < calls; c++) {
    federalTaxInto(table, offsets[k]!, inputs[k]!, out);
    sink[0] = sink[0]! + out[TO.TOTAL]!;
    k = k + 1 === n ? 0 : k + 1;
  }
}

/** The heap check's figures (`heapCheck`). */
export interface HeapCheck {
  readonly calls: number;
  readonly warmupCalls: number;
  /** `process.memoryUsage().heapUsed` after a full collection, and after the calls. */
  readonly heapBefore: number;
  readonly heapAfter: number;
  readonly heapDelta: number;
  /** Garbage collections during the calls (a `PerformanceObserver` on `gc` entries). */
  readonly gcCount: number;
  readonly ms: number;
}

/**
 * The heap check of tax-rmd-ss §3.5: `warmupCalls` calls (the optimizing compiler settles; a pause
 * lets concurrent compilations install), two full collections (`gc`, from `--expose-gc`), then
 * `calls` calls measured: the heap is unchanged when none of them allocates. The calls run in
 * batches of 100 through `runFederalTax`, so that the measured code is the optimized function and
 * not the first iterations of a long loop before the optimizing compiler enters it.
 */
export async function heapCheck(w: FederalTaxWorkload, gc: () => void, calls = 100_000, warmupCalls = 300_000): Promise<HeapCheck> {
  const { PerformanceObserver } = await import("node:perf_hooks");
  const batch = 100;
  const batches = (n: number) => {
    const count = Math.ceil(n / batch);
    for (let i = 0; i < count; i++) runFederalTax(w, batch);
  };
  batches(warmupCalls);
  await new Promise((r) => setTimeout(r, 50));
  batches(warmupCalls);
  gc();
  gc();
  const entries: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((list) => entries.push(...list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  const t0 = performance.now();
  const heapBefore = process.memoryUsage().heapUsed;
  batches(calls);
  const heapAfter = process.memoryUsage().heapUsed;
  const ms = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 20));
  entries.push(...observer.takeRecords());
  observer.disconnect();
  return { calls, warmupCalls, heapBefore, heapAfter, heapDelta: heapAfter - heapBefore, gcCount: entries.length, ms };
}
