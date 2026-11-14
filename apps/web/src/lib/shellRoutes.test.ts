import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAVIGATE_FALLBACK_DENYLIST } from "./shellRoutes.js";

/**
 * Audit a1-serve-and-guard, second round: the service worker answers a navigation from its
 * cached shell only where the server would send the shell (apps/api/src/app.ts, servesShell).
 * Workbox tests each pattern against the URL's pathname plus search.
 */
const denied = (pathAndSearch: string) => NAVIGATE_FALLBACK_DENYLIST.some((pattern) => pattern.test(pathAndSearch));

describe("a1-serve-and-guard (second round): which navigations the service worker answers with the shell", () => {
  it("never answers the API's paths, /api itself and /api?… included", () => {
    for (const path of ["/api", "/api?x=1", "/api/", "/api/?x=1", "/api/accounts", "/api/export/transactions.csv?from=2026-01-01"]) {
      expect(denied(path), path).toBe(true);
    }
  });

  it("never answers a build file: anything under /assets/, or a last segment with an extension", () => {
    for (const path of ["/assets", "/assets/", "/assets/index-OLDHASH.js", "/assets/chunk", "/registerSW.js", "/favicon.ico", "/plan/report.pdf", "/workbox-00000000.js?v=1"]) {
      expect(denied(path), path).toBe(true);
    }
  });

  it("answers every client-side route, whatever its query says", () => {
    for (const path of ["/", "/plan", "/plan?month=2026.11", "/plan?next=/a.b", "/investments/holdings?account=1", "/investments/accounts/12", "/apiary", "/assetsx", "/dashboard"]) {
      expect(denied(path), path).toBe(false);
    }
  });

  it("is the denylist the build gives the service worker", () => {
    const config = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");
    expect(config).toMatch(/import \{ NAVIGATE_FALLBACK_DENYLIST \} from "\.\/src\/lib\/shellRoutes(\.js|\.ts)?";/);
    expect(config).toMatch(/navigateFallbackDenylist: NAVIGATE_FALLBACK_DENYLIST,/);
  });
});
