import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// tax-rmd-ss §3.5: "under --expose-gc, 100,000 calls leave the heap unchanged". The check runs in a
// process of its own (bench/federalTaxHeap.ts on the workload of bench/federalTaxWorkload.ts:
// household-years through every part of federalTaxInto, single and joint, 30 indexed plan years,
// partial first years), because --expose-gc is a process flag and Vitest's own allocations would
// be counted here. After 600,000 warm-up calls and two full collections the heap may move by a few
// kilobytes (the timer, the memory reading); one boxed double a call would be 1.6 MB.

const PACKAGE_DIR = fileURLToPath(new URL("../../", import.meta.url));

interface HeapCheck {
  calls: number;
  heapDelta: number;
  gcCount: number;
}

describe("federalTaxInto allocates nothing (tax-rmd-ss §3.5)", () => {
  it("§3.5 100,000 calls under --expose-gc leave the heap unchanged and run no garbage collection", () => {
    // `node --import tsx` rather than the tsx CLI, which opens an IPC pipe in the temporary directory.
    const out = execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", "bench/federalTaxHeap.ts", "--json"], {
      cwd: PACKAGE_DIR,
      encoding: "utf8",
      timeout: 120_000,
    });
    const r = JSON.parse(out.trim().split("\n").at(-1)!) as HeapCheck;
    expect(r.calls).toBe(100_000);
    expect(r.gcCount).toBe(0);
    expect(r.heapDelta).toBeLessThan(64 * 1024);
  }, 130_000);
});
