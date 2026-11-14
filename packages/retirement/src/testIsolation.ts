/**
 * Test support (not exported from the package): whether the test running now belongs to the file
 * that calls this, or to a file that imported that file's suite (the gate, `src/gate.test.ts`).
 *
 * The heap checks of the zero-allocation rule (engine-and-returns §4.3) measure what V8 compiles,
 * and that depends on everything the process ran before: in the gate, one module graph runs every
 * area's suites, whose test views and records of other shapes make the hot call sites polymorphic,
 * and V8 may then box doubles it never boxes in a run of the loop alone (measured: 16 and 32 bytes a
 * call in ST-17 and the withdrawal planner's check, none in their own files). Those checks run in
 * their own files only, where the measurement means what it says; the gate keeps their values.
 */

/**
 * True when the current test was collected from the file whose `import.meta.url` is `moduleUrl`.
 * The caller passes Vitest's `expect.getState().testPath`: the engine's sources import no test
 * framework (seams §2.1; the root ESLint block and determinism.test.ts check it).
 */
export function runsInOwnFile(moduleUrl: string, testPath: string | undefined): boolean {
  return testPath !== undefined && testPath === decodeURIComponent(new URL(moduleUrl).pathname);
}
