// T44's throwing thread (fixtures.ts), started the way thread.boot.mjs starts the real one.
import { register } from "tsx/esm/api";

register();
const { throwingThread } = await import("./fixtures.ts");
throwingThread();
