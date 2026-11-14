/**
 * The package's own thread entry for development and its harness tests (engine-and-returns §3.13
 * item 4, seams C10): `thread.boot.mjs` registers tsx and imports this file. Production threads
 * start from the worker app's bundled `simThread.js`, which makes the same call.
 */

import { runThreadMain } from "./thread.js";

runThreadMain();
