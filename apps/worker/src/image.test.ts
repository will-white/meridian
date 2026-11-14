import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The worker image carries what its two bundles need (inputs-and-data §6.3, seams C10; the
 * Dockerfile's layout is audit a7's and a9's). scripts/bundle.mjs compiles the workspace packages
 * into dist/main.js and dist/simThread.js from source and leaves every npm package external, so
 * at run time those resolve from apps/worker/node_modules alone, which the image's deps stage
 * fills with `pnpm install --prod --filter @meridian/worker`: the worker's own dependencies.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

interface Manifest {
  name: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
}
const manifest = (dir: string) => JSON.parse(read(path.join(dir, "package.json"))) as Manifest;

/** Every workspace package's directory by name. */
const workspace = new Map<string, string>(
  ["apps", "packages"].flatMap((group) =>
    readdirSync(path.join(root, group), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => [manifest(`${group}/${d.name}`).name, `${group}/${d.name}`] as const),
  ),
);

/** The workspace packages the worker's bundles compile in: its @meridian/* dependencies and theirs. */
function bundledWorkspacePackages(): string[] {
  const seen = new Set<string>();
  const queue = Object.keys(manifest("apps/worker").dependencies ?? {}).filter((d) => workspace.has(d));
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...Object.keys(manifest(workspace.get(name)!).dependencies ?? {}).filter((d) => workspace.has(d)));
  }
  return [...seen].sort();
}

/** A Dockerfile's stages, from each FROM to the next: named by their `AS`, the last one "final". */
function stages(file: string): Map<string, string> {
  const chunks = read(file)
    .split(/^(?=FROM )/m)
    .filter((chunk) => chunk.startsWith("FROM "));
  return new Map(chunks.map((chunk, i) => [i === chunks.length - 1 ? "final" : (/^FROM \S+ AS (\S+)/i.exec(chunk)?.[1] ?? `stage${i}`), chunk]));
}

describe("the worker image and its two bundles", () => {
  it("bundles the retirement engine: @meridian/retirement is a workspace dependency, compiled in with db and shared", () => {
    expect(manifest("apps/worker").dependencies?.["@meridian/retirement"]).toBe("workspace:*");
    expect(bundledWorkspacePackages()).toEqual(["@meridian/db", "@meridian/retirement", "@meridian/shared"]);
  });

  it("every npm package a compiled-in workspace package depends on is the worker's own dependency, so the production install has it", () => {
    const own = manifest("apps/worker").dependencies ?? {};
    for (const name of bundledWorkspacePackages()) {
      for (const [dep, range] of Object.entries(manifest(workspace.get(name)!).dependencies ?? {})) {
        if (workspace.has(dep)) continue;
        expect(own[dep], `${name} imports ${dep}; apps/worker must depend on it`).toBeDefined();
        // One version for both, so the lockfile resolves the import to what the package was tested with.
        expect(own[dep], `${dep}: apps/worker and ${name} ask for the same range`).toBe(range);
      }
    }
  });

  it("the build makes dist/main.js and then the thread entry dist/simThread.js, both with scripts/bundle.mjs", () => {
    expect(manifest("apps/worker").scripts?.["build"]).toBe("node ../../scripts/bundle.mjs src/main.ts dist/main.js && node ../../scripts/bundle.mjs src/simThread.ts dist/simThread.js");
    // The thread entry only serves the engine's pool, and the job looks for it beside main.js.
    expect(read("apps/worker/src/simThread.ts")).toMatch(/^import \{ runThreadMain \} from "@meridian\/retirement\/node";\n\nrunThreadMain\(\);\n$/m);
    expect(read("apps/worker/src/env.ts")).toContain('export const SIM_THREAD_ENTRY = new URL("./simThread.js", import.meta.url);');
  });

  it("the Dockerfile builds both bundles, ships the dist folder with their maps, and copies the manifest of every workspace package the worker links", () => {
    const s = stages("apps/worker/Dockerfile");
    expect(s.get("build")).toMatch(/^RUN pnpm --filter @meridian\/worker build$/m);
    const final = s.get("final")!;
    // dist holds main.js, simThread.js and their two source maps.
    expect(final).toMatch(/^COPY --from=build \/app\/apps\/worker\/dist \.\/apps\/worker\/dist$/m);
    for (const name of bundledWorkspacePackages()) {
      const dir = workspace.get(name)!;
      expect(s.get("deps"), `deps stage: ${dir}`).toContain(`COPY ${dir}/package.json ./${dir}/package.json\n`);
      expect(final, `final stage: ${dir}`).toContain(`COPY --from=build /app/${dir}/package.json ./${dir}/package.json\n`);
    }
  });
});
