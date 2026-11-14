/**
 * The body of a simulation thread (engine-and-returns §3.13; seams §2.4, C10).
 *
 * The worker app's `simThread.ts` (a bundled entry) and this package's dev entry
 * (`thread.boot.mjs` → `threadEntry.ts`) only call `runThreadMain()`. The thread answers the pool's
 * messages (`protocol.ts`) on its parent port: `init` runs the self-test (once per thread),
 * `prepare(input)` and allocates one path state; `chunk` runs `simulateChunk` on that state and
 * moves the summary's buffers back. An error is reported with its class name and code and the
 * thread keeps serving; the pool decides what happens next.
 */

import { parentPort } from "node:worker_threads";
import { ensureSelfTest } from "../facade.js";
import { type PreparedRun, prepare } from "../prepare.js";
import { createProductionState, simulateChunk } from "../simulate.js";
import type { PathState } from "../state.js";
import { DATA_VERSION, ENGINE_VERSION } from "../version.js";
import { type ChunkDoneMessage, type MainMessage, type ReadyMessage, VERSION_MISMATCH, chunkTransferList, errorMessage } from "./protocol.js";

export interface ThreadMainOptions {
  /**
   * The path state a run is simulated on. Default: the production hooks and tax functions
   * (`createProductionState`). A test entry passes stub hooks here (T44); nothing else should.
   */
  readonly createState?: (run: PreparedRun) => PathState;
}

/** Serves the pool on this worker thread's parent port. Throws on the main thread. */
export function runThreadMain(options: ThreadMainOptions = {}): void {
  const port = parentPort;
  if (port === null) throw new Error("runThreadMain() runs inside a simulation worker thread, not on the main thread");
  const createState = options.createState ?? createProductionState;
  let runId = -1;
  let run: PreparedRun | null = null;
  let ps: PathState | null = null;

  port.on("message", (m: MainMessage) => {
    try {
      if (m.type === "init") {
        runId = m.runId;
        run = null;
        ps = null;
        if (m.engineVersion !== ENGINE_VERSION || m.dataVersion !== DATA_VERSION) {
          const e = new Error(
            `this simulation thread carries engine ${ENGINE_VERSION} and data ${DATA_VERSION}; the pool runs engine ${m.engineVersion} and data ${m.dataVersion}`,
          );
          e.name = VERSION_MISMATCH;
          throw e;
        }
        ensureSelfTest();
        run = prepare(m.input);
        ps = createState(run);
        const ready: ReadyMessage = { type: "ready", runId };
        port.postMessage(ready);
      } else if (m.type === "chunk") {
        if (m.runId !== runId || run === null || ps === null) throw new Error(`chunk ${m.chunkId} of run ${m.runId} before that run was prepared`);
        const summary = simulateChunk(run, m.pathStart, m.pathCount, ps);
        const done: ChunkDoneMessage = { type: "chunkDone", runId, chunkId: m.chunkId, summary };
        port.postMessage(done, chunkTransferList(summary));
      }
    } catch (e) {
      port.postMessage(errorMessage(runId, e));
    }
  });
}
