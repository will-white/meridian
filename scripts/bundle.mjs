#!/usr/bin/env node
/**
 * Bundle a Node app entry point into one ESM file. Workspace packages
 * (@meridian/*) are compiled from their TypeScript source into the bundle;
 * everything else stays external and is loaded from node_modules at runtime.
 *
 *   node scripts/bundle.mjs <entry.ts> <outfile.js>
 */
import { build } from "esbuild";

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error("usage: bundle.mjs <entry> <outfile>");
  process.exit(2);
}

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // The images run the bundles with --enable-source-maps (NODE_OPTIONS), so a logged stack names
  // the source file and line. The map only needs the positions for that: the sources themselves
  // are not embedded, which keeps the four maps (the API's server and admin, the worker's main and
  // simThread) at about 2.3 MB instead of 10 MB.
  sourcemap: true,
  sourcesContent: false,
  logLevel: "info",
  banner: {
    // Give bundled CommonJS-style helpers a `require` and keep import.meta.url sane.
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  plugins: [
    {
      name: "externalize-node-modules",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith("@meridian/")) return null; // bundle workspace packages from source
          if (args.path.startsWith("node:")) return { path: args.path, external: true };
          return { path: args.path, external: true };
        });
      },
    },
  ],
});
