import { Worker } from "node:worker_threads";
import type { SimInput } from "@meridian/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createChunkSummary } from "../aggregate.js";
import { W, ZERO_YIELDS } from "../loopTestKit.js";
import { prepare } from "../prepare.js";
import { account, buildSimInput } from "../testing/index.js";
import { DATA_VERSION, ENGINE_VERSION } from "../version.js";
import {
  CHUNK_PATHS,
  DEV_THREAD_ENTRY,
  EngineInputError,
  EngineInvariantError,
  EngineRuntimeError,
  MAX_THREADS,
  type SimPool,
  type SimProgress,
  SimulationCancelledError,
  SimulationWorkerError,
  chunkRanges,
  createSimPool,
  defaultThreads,
  runSimulation,
  runThreadMain,
} from "./index.js";
import { VERSION_MISMATCH, chunkTransferList, errorMessage, rebuildError } from "./protocol.js";

// T44 (engine-and-returns §7): the harness's behaviour. Every threaded case starts its threads
// from the package's dev entry (`thread.boot.mjs`, which registers tsx and imports the .ts
// sources with their .js specifiers) or from one of the misbehaving entries beside
// `testThreads/fixtures.ts`, so these cases also prove that a thread can load the TypeScript
// sources (C10).

const fixture = (name: string) => new URL(`./testThreads/${name}.boot.mjs`, import.meta.url);

/** T20's household (fixed age 94, 40,000 real from 1,000,000 in a Roth at 60/40, no tax) on the bootstrap model. */
const t20 = (paths: number): SimInput =>
  buildSimInput({
    people: [{ birthYear: 1962, longevity: { mode: "fixed", age: 94 } }],
    accounts: [account("roth", "roth", "100000000", { allocation: W(6000, 0, 4000, 0) })],
    spending: { baseAnnualCents: "4000000" },
    returnModel: { kind: "bootstrap", meanBlockYears: 10 },
    paths,
    seed: 20261110,
    tax: ZERO_YIELDS,
  });

const pools: SimPool[] = [];
const pool = (threads: number, threadEntry?: URL): SimPool => {
  const p = createSimPool({ threads, ...(threadEntry === undefined ? {} : { threadEntry }) });
  pools.push(p);
  return p;
};
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the run to reject");
}

describe("T44 progress", () => {
  it("T44 1,000 paths in four chunks on two threads: onProgress reports 250, 500, 750, 1000 of 1000", async () => {
    const reports: SimProgress[] = [];
    const out = await pool(2).run(t20(1000), { onProgress: (p) => reports.push(p) });
    expect(out.paths).toBe(1000);
    expect(out.timing.threads).toBe(2);
    expect(reports.map((r) => r.donePaths)).toEqual([250, 500, 750, 1000]);
    expect(reports.every((r) => r.totalPaths === 1000)).toBe(true);
    for (let i = 1; i < reports.length; i++) expect(reports[i]!.elapsedMs).toBeGreaterThanOrEqual(reports[i - 1]!.elapsedMs);
  }, 60_000);

  it("T44 inline: the same reports, with the event loop running between chunks", async () => {
    const reports: number[] = [];
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    try {
      await runSimulation(t20(1000), { threads: 0, onProgress: (p) => reports.push(p.donePaths) });
    } finally {
      clearInterval(timer);
    }
    expect(reports).toEqual([250, 500, 750, 1000]);
    expect(ticks).toBeGreaterThan(0);
  }, 60_000);
});

describe("T44 cancellation and the time limit", () => {
  it("T44 aborting the signal after the first chunk rejects with SimulationCancelledError('cancelled') and leaves no live thread; the pool then runs again", async () => {
    const p = pool(2);
    const controller = new AbortController();
    const e = await rejection(p.run(t20(1000), { signal: controller.signal, onProgress: () => controller.abort() }));
    expect(e).toBeInstanceOf(SimulationCancelledError);
    expect((e as SimulationCancelledError).code).toBe("cancelled");
    expect((e as SimulationCancelledError).permanent).toBe(true);
    expect(p.liveWorkers).toBe(0);
    const again = await p.run(t20(1000));
    expect(again.paths).toBe(1000);
    expect(again.summary.digest).toBe((await runSimulation(t20(1000), { threads: 0 })).summary.digest);
    expect(p.liveWorkers).toBe(2);
  }, 60_000);

  it("T44 inline: aborting after the first chunk rejects with code cancelled; a signal aborted before the run rejects at once", async () => {
    const controller = new AbortController();
    const reports: number[] = [];
    const e = await rejection(
      runSimulation(t20(1000), {
        threads: 0,
        signal: controller.signal,
        onProgress: (p) => {
          reports.push(p.donePaths);
          controller.abort();
        },
      }),
    );
    expect(e).toBeInstanceOf(SimulationCancelledError);
    expect((e as SimulationCancelledError).code).toBe("cancelled");
    expect(reports).toEqual([250]);
    const before = await rejection(runSimulation(t20(1000), { threads: 2, signal: AbortSignal.abort() }));
    expect((before as SimulationCancelledError).code).toBe("cancelled");
  }, 60_000);

  it("T44 maxRunMs = 1 rejects with code timeout, on two threads and inline, and the pool leaves no live thread", async () => {
    const p = pool(2);
    const e = await rejection(p.run(t20(1000), { maxRunMs: 1 }));
    expect(e).toBeInstanceOf(SimulationCancelledError);
    expect((e as SimulationCancelledError).code).toBe("timeout");
    expect(p.liveWorkers).toBe(0);
    const inline = await rejection(runSimulation(t20(1000), { threads: 0, maxRunMs: 1 }));
    expect((inline as SimulationCancelledError).code).toBe("timeout");
  }, 60_000);

  it("closing the pool during a run rejects it with code cancelled; a closed pool refuses to run", async () => {
    const p = pool(2);
    const running = p.run(t20(1000), { onProgress: () => void p.close() });
    const e = await rejection(running);
    expect((e as SimulationCancelledError).code).toBe("cancelled");
    expect(p.liveWorkers).toBe(0);
    await expect(p.run(t20(1000))).rejects.toThrow("closed");
  }, 60_000);

  it("a pool runs one simulation at a time", async () => {
    const p = pool(1);
    const first = p.run(t20(500));
    await expect(p.run(t20(500))).rejects.toThrow("already running");
    expect((await first).paths).toBe(500);
  }, 60_000);
});

describe("T44 errors keep their class", () => {
  it("T44 a withdrawal hook that breaks its contract in a thread rejects with EngineInvariantError (permanent), not SimulationWorkerError", async () => {
    const p = pool(2, fixture("violating"));
    const e = await rejection(p.run(t20(1000)));
    expect(e).toBeInstanceOf(EngineInvariantError);
    expect(e).not.toBeInstanceOf(SimulationWorkerError);
    expect((e as EngineInvariantError).code).toBe("withdrawal_out_of_range");
    expect((e as EngineInvariantError).permanent).toBe(true);
    // The thread's own stack is kept.
    expect(e.stack).toContain("loop.ts");
    expect(p.liveWorkers).toBe(0);
  }, 60_000);

  it("T44 a thread that exits rejects with SimulationWorkerError (retryable)", async () => {
    const p = pool(2, fixture("exiting"));
    const e = await rejection(p.run(t20(1000)));
    expect(e).toBeInstanceOf(SimulationWorkerError);
    expect((e as SimulationWorkerError).permanent).toBe(false);
    expect(e.message).toContain("exited with code 3");
    expect(p.liveWorkers).toBe(0);
  }, 60_000);

  it("T44 an error in a thread that is not an engine error rejects with SimulationWorkerError and keeps the cause", async () => {
    const e = await rejection(runSimulation(t20(1000), { threads: 2, threadEntry: fixture("throwing") }));
    expect(e).toBeInstanceOf(SimulationWorkerError);
    expect(e.message).toContain("TypeError: a fault that is not an engine error");
    expect((e.cause as Error).name).toBe("TypeError");
  }, 60_000);

  it("T44 an invalid input rejects with EngineInputError before any thread starts", async () => {
    const p = pool(2);
    const bad = { ...t20(1000), data: { version: "2025.1.0" } };
    const e = await rejection(p.run(bad));
    expect(e).toBeInstanceOf(EngineInputError);
    expect((e as EngineInputError).code).toBe("data_version_mismatch");
    expect(p.liveWorkers).toBe(0);
  }, 60_000);

  it("a thread refuses a run from a pool of another engine or data version", async () => {
    const worker = new Worker(DEV_THREAD_ENTRY);
    try {
      const reply = new Promise<unknown>((resolve) => worker.once("message", resolve));
      worker.postMessage({ type: "init", runId: 7, input: t20(100), engineVersion: "0.0.0", dataVersion: DATA_VERSION });
      const m = (await reply) as { type: string; runId: number; name: string; message: string };
      expect(m).toMatchObject({ type: "error", runId: 7, name: VERSION_MISMATCH });
      expect(m.message).toContain(ENGINE_VERSION);
      expect(rebuildError(m as Parameters<typeof rebuildError>[0])).toBeInstanceOf(SimulationWorkerError);
    } finally {
      await worker.terminate();
    }
  }, 60_000);
});

describe("thread counts and chunks", () => {
  it("defaultThreads is max(1, min(8, parallelism − 1)): 1 → 1, 2 → 1, 4 → 3, 8 → 7, 16 → 8", () => {
    expect([1, 2, 4, 8, 16].map((n) => defaultThreads(n))).toEqual([1, 1, 3, 7, 8]);
    expect(defaultThreads()).toBeGreaterThanOrEqual(1);
  });

  it("a pool has 0 to 64 threads; a run never uses more threads than it has chunks", async () => {
    expect(createSimPool({ threads: 100 }).threads).toBe(MAX_THREADS);
    expect(createSimPool({ threads: 0 }).threads).toBe(0);
    expect(() => createSimPool({ threads: -1 })).toThrow(RangeError);
    expect(() => createSimPool({ threads: 1.5 })).toThrow(RangeError);
    expect(() => createSimPool({ threads: 2, threadEntry: new URL("./nowhere.mjs", import.meta.url) })).toThrow("does not exist");
    // Threads 0 needs no entry at all.
    expect(createSimPool({ threads: 0, threadEntry: new URL("./nowhere.mjs", import.meta.url) }).threads).toBe(0);
    const p = pool(3);
    const out = await p.run(t20(300));
    expect(out.timing.threads).toBe(2); // 300 paths are two chunks of 250 and 50
    expect(p.liveWorkers).toBe(2); // threads are started when a run needs them
    expect((await p.run(t20(1000))).timing.threads).toBe(3);
    expect(p.liveWorkers).toBe(3);
  }, 60_000);

  it("chunks of 250 paths: 10,000 paths are 40 chunks; the last chunk takes the rest", () => {
    expect(CHUNK_PATHS).toBe(250);
    expect(chunkRanges(10_000, CHUNK_PATHS)).toHaveLength(40);
    expect(chunkRanges(1001, 250)).toEqual([
      [0, 250],
      [250, 250],
      [500, 250],
      [750, 250],
      [1000, 1],
    ]);
  });

  it("run options are checked", async () => {
    await expect(runSimulation(t20(100), { threads: 0, chunkPaths: 0 })).rejects.toThrow(RangeError);
    await expect(runSimulation(t20(100), { threads: 0, maxRunMs: 0 })).rejects.toThrow(RangeError);
    await expect(runSimulation(t20(100), { threads: 0, maxRunMs: 2 ** 31 })).rejects.toThrow(RangeError);
    await expect(runSimulation(t20(100), { threads: 0, maxRunMs: Number.NaN })).rejects.toThrow(RangeError);
  });
});

describe("the protocol", () => {
  it("a chunk summary moves every typed array's buffer, each once", () => {
    const chunk = createChunkSummary(prepare(t20(100)), 0, 10);
    const arrays = Object.values(chunk).filter((v) => ArrayBuffer.isView(v));
    const buffers = chunkTransferList(chunk);
    expect(buffers).toHaveLength(arrays.length);
    expect(new Set(buffers).size).toBe(buffers.length);
  });

  it("engine errors are rebuilt as their own class with their code; anything else becomes a SimulationWorkerError", () => {
    const cases: Array<[Error, new (...args: never[]) => Error]> = [
      [new EngineInputError("plan_invalid", "bad plan"), EngineInputError],
      [new EngineInvariantError("assess_calls", "too many calls"), EngineInvariantError],
      [new EngineRuntimeError("self_test_failed", "the self-test failed"), EngineRuntimeError],
      [new RangeError("out of range"), SimulationWorkerError],
    ];
    for (const [thrown, expected] of cases) {
      const back = rebuildError(errorMessage(1, thrown));
      expect(back).toBeInstanceOf(expected);
      if (expected !== SimulationWorkerError) {
        expect(back.message).toBe(thrown.message);
        expect((back as EngineInputError).code).toBe((thrown as EngineInputError).code);
        expect((back as EngineInputError).permanent).toBe(true);
      }
    }
    expect(rebuildError(errorMessage(1, "a string"))).toBeInstanceOf(SimulationWorkerError);
  });

  it("runThreadMain refuses to run on the main thread", () => {
    expect(() => runThreadMain()).toThrow("worker thread");
  });
});
