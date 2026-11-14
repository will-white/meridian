// T44's violating thread (fixtures.ts), started the way thread.boot.mjs starts the real one.
import { register } from "tsx/esm/api";

register();
const { violatingThread } = await import("./fixtures.ts");
violatingThread();
