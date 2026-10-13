import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Suites share one Postgres; each creates its own schema, but keep files sequential for predictable load.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
