// T44's exiting thread (fixtures.ts), started the way thread.boot.mjs starts the real one.
import { register } from "tsx/esm/api";

register();
const { exitingThread } = await import("./fixtures.ts");
exitingThread();
