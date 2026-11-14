import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest 4 (2c937a1, from 2.1.9) fails a synchronous test that runs past its timeout, which
    // Vitest 2 let finish. The seeded property sweeps (T45, H16, WD-19, the fill sweep) run 3 to 9 s
    // on the shared 4-vCPU machine, beyond the default 5 s; the API and db packages use 30 s.
    testTimeout: 60_000,
  },
});
