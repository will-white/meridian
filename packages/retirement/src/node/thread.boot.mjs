// Dev and test thread entry (engine-and-returns §3.13 item 4, seams C10): a worker started on a
// .ts file with `--import tsx` cannot resolve the sources' relative `.js` specifiers, so this file
// registers tsx's loader inside the thread first and then imports the TypeScript entry.
import { register } from "tsx/esm/api";

register();
await import("./threadEntry.ts");
