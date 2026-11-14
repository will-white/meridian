# Audit record: Dependencies (a9-dependencies)

Scope: the workspace's dependency declarations, the lockfile, the bundling script and what the API and worker images install and ship.

Both findings were judged real and fixed; neither was rejected or deferred. The decisions are recorded in `docs/phase-1-plan.md`, "Decisions made during the audit", 102 and 103, and the plan's test matrix has an "Images (audit a9)" row. No statement in the README or `.env.example` was made wrong by the change. The comment in `packages/db/src/migrate.ts` said that the bundled API and worker both set `MERIDIAN_MIGRATIONS_DIR`, and it now says that only the API does.

Checks: `pnpm typecheck` and `pnpm lint` pass. The suites pass (TEST_DATABASE_PREFIX `meridian_fix_b_`): shared 48 files and 934 tests, db 49 files and 373 tests, worker 13 files and 110 tests, api 40 files and 327 tests, web 33 files and 399 tests. `pnpm build` passes. `pnpm install --frozen-lockfile --offline` accepts the regenerated lockfile.

No Docker daemon runs here, so each image was checked by simulating its Dockerfile stage by stage on the local filesystem. The simulator, `laneB/sim-image.mjs` in the lane's scratch directory, runs COPY, `COPY --from`, RUN, ENV and CMD. It skips `corepack enable`, and it runs `pnpm install` offline from the local store. The record of that check is `laneB/a9-manual-check.txt`. Its logs are `sim-before-*.log`, `sim-after.log` and `layout-sizes.txt`. Its stacks are `before-stack-plain.txt`, `before-stack-maps.txt` and `after-stack.txt`. The simulated API image ran on port 3491 against `meridian_fix_b_a9img`, a database dropped afterwards. It applied the 9 migrations and answered `/api/health` and `/`, and `admin.js users` ran. The simulated worker image started and wrote its heartbeat file. Both were stopped by their recorded PIDs. The new tests were also run against the tree before the fix (`laneB/before-tests.log`), and all four failed there.

## a9-dependencies-01 (low): the API and worker images ship pnpm, its store and cache, packages nothing imports, and (worker) migrations it never runs

Status: fixed.

What was wrong:
- The final stage of both Dockerfiles ran `corepack enable` and `pnpm install --frozen-lockfile --prod --filter @meridian/<app>` itself. So the image kept corepack's download of pnpm, pnpm's store and its metadata cache under `/root`, about 26 MB that nothing needs at run time.
- The lockfile resolved drizzle-orm's optional peers `react` and `@types/react` to the web app's React in every importer (`drizzle-orm@0.38.4(@types/react@19.3.0)(postgres@3.4.9)(react@19.3.0)`). As a result react, @types/react and csstype were installed in both images, 3 of the worker's 7 packages, and no bundle imports them. The cause, reproduced in a two-project workspace: pnpm fills an optional peer that is already in the workspace's graph whenever `auto-install-peers` or `dedupe-peer-dependents` is on, and both are on by default.
- The worker image copied `packages/db/drizzle` (1.1 MB) and set `MERIDIAN_MIGRATIONS_DIR`, and so did its compose entry. Only `apps/api/src/boot.ts` runs migrations, and the worker starts after the API is healthy.

Reproduced on the simulated layout of the commit before the fix: the API's `/app` held 44.8 MB of files and the worker's 18.6 MB. Both had `react@19.3.0`, `@types+react@19.3.0` and `csstype@3.2.3` in `node_modules/.pnpm`.

What changed:
- Both Dockerfiles now have three stages. `build` is unchanged. `deps` copies only the lockfile, `pnpm-workspace.yaml` and the package.json files, then runs `pnpm install --frozen-lockfile --prod --filter @meridian/<app>`. The image stage copies `node_modules` and `apps/<app>/node_modules` from `deps`, and the bundles (plus, for the API, the UI and the migrations) from `build`. It runs nothing: no corepack, no pnpm, no store or cache, and `/app` stays root-owned (decision 79). pnpm's links are relative, so they survive the copy. The package.json files of `packages/db` and `packages/shared` are copied so that the workspace links resolve. On the simulated layout no link is broken.
- The worker image no longer copies `packages/db/drizzle` and no longer sets `MERIDIAN_MIGRATIONS_DIR`, and `deploy/services.yml` no longer passes it to the worker. The bundle reads the variable at load time only to compute a path it never uses.
- `pnpm-workspace.yaml` has the overrides `"drizzle-orm>react": "-"` and `"drizzle-orm>@types/react": "-"`, and the lockfile was regenerated with `pnpm install`. The diff is the overrides block, the two peer ranges in drizzle-orm's package entry (now `*`), the three importers' drizzle-orm version (`0.38.4(postgres@3.4.9)`) and its snapshot. No other package moved.
- After the fix, the simulated API `/app` holds 39.6 MB and the worker's 13.9 MB, and the worker installs drizzle-orm, postgres, re2js and zod only. Part of the API's drop is finding 02's smaller maps.

Tests (`apps/api/src/deployStack.test.ts`, suite "the API and worker images carry only what they run (audit a9-dependencies)"):
- "a9-dependencies-01: the image installs nothing itself: its node_modules come from a stage that ran the production install": the last stage of each Dockerfile has no RUN and no corepack or pnpm, and every COPY in it is `--from`. Its two `node_modules` come from a stage that runs exactly `pnpm install --frozen-lockfile --prod --filter @meridian/<app>`.
- "a9-dependencies-01: only the API image carries the migrations, because only the API runs them": the API boot runs `runMigrations`, and no worker source does. The API image copies the migrations and sets the variable, the worker image has neither, and the same holds for the compose entries.
- "a9-dependencies-01: the production install of the API and the worker holds no React (drizzle-orm's optional peers stay unresolved)": the test walks `pnpm-lock.yaml` from the `apps/api`, `apps/worker` and `packages/db` importers through every snapshot's dependencies and optional dependencies. The packages the bundles import must be there, and react, react-dom, @types/react and csstype must not.
- Manual: the simulated images above (`laneB/a9-manual-check.txt`).

## a9-dependencies-02 (low): bundles are built with source maps that the images ship but Node never reads, so production stack traces point into the bundle

Status: fixed.

What was wrong: `scripts/bundle.mjs` wrote `server.js.map` (2.7 MB), `admin.js.map` (1.5 MB) and `main.js.map` (2.0 MB), and each embedded the full text of every source. The images copied the maps with the bundles, but nothing passed `--enable-source-maps`, so Node never read them. Reproduced on the simulated API image with `SESSION_SECRET` unset: the logged frame was `at loadConfig (…/apps/api/dist/server.js:23614:22)`.

What changed: decision 103 keeps the maps and uses them. A stack in the household's log is what someone fixing a bug has to go on, and it should name the source file and line.
- Both images set `ENV NODE_OPTIONS=--enable-source-maps`. That also covers `admin.js` run with `docker compose exec` or `run`, so the README's commands stay as they are.
- The `start` scripts of `apps/api` and `apps/worker` pass the flag too.
- `scripts/bundle.mjs` sets `sourcesContent: false`. Mapping a stack needs only the positions, and the image has no use for a second copy of every source. The three maps are now 1.4 MB together instead of 6.2 MB.
- On the simulated image the same failure now logs `at loadConfig (…/apps/api/src/config.ts:143:22)` and `at <anonymous> (…/apps/api/src/server.ts:6:16)`.
- Measured cost: formatting 2,000 stacks took 228 ms instead of 195 ms, and start-up is about 0.13 s longer once, while the map is read.

Tests:
- `apps/api/src/deployStack.test.ts`, "a9-dependencies-02: the images run the bundles with their source maps, so a logged stack names the source file and line". Both images copy their whole `dist` and set `NODE_OPTIONS=--enable-source-maps`. The test bundles a two-file fixture with `scripts/bundle.mjs` and runs it with the image's `NODE_OPTIONS`. The stack must name `thrower.ts:2` and not the bundle, and the map must list both sources and carry no `sourcesContent`.
- Manual: the stacks before and after on the simulated image, the `pnpm start` runs and the timing (`laneB/a9-manual-check.txt`).
