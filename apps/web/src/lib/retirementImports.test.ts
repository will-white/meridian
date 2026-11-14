import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Seams C47 (plan decision on the boundary): the web imports `@meridian/shared` only, never the
 * engine package. A scan of every source and test file under apps/web/src.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("the web's imports (seams C47)", () => {
  it("no file under apps/web/src imports @meridian/retirement", () => {
    const offenders = files(SRC).filter((path) => /from\s+["']@meridian\/retirement|import\(\s*["']@meridian\/retirement/.test(readFileSync(path, "utf8")));
    expect(offenders.map((p) => relative(SRC, p))).toEqual([]);
  });

  it("the retirement helpers import only @meridian/shared, the web's own modules and (in tests) vitest and node built-ins", () => {
    const own = files(SRC).filter((p) => /[\\/](lib[\\/]retirement[^\\/]*|components[\\/]charts[\\/]retirementOptions[^\\/]*)\.ts$/.test(p));
    expect(own.length).toBeGreaterThan(10);
    for (const path of own) {
      const specifiers = [...readFileSync(path, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const s of specifiers) {
        const allowed = s.startsWith(".") || s === "@meridian/shared" || s.startsWith("@meridian/shared/src/") || s === "echarts/charts" || (path.endsWith(".test.ts") && (s === "vitest" || s.startsWith("node:")));
        expect(allowed, `${relative(SRC, path)} imports ${s}`).toBe(true);
      }
    }
  });
});
