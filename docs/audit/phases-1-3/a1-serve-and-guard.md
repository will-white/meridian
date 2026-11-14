# Audit record: Serving the web app and guarding the API (a1-serve-and-guard)

Scope: how the API serves the built web app (the static files and the SPA fallback), the guard in front of `/api` (session and role, body and list limits, same-origin and JSON for changes, bounded request shapes), proxy trust and where the API listens, for Phases 1 to 3.

## First round (commit aea5d84)

The first round's findings text is not kept; this section is taken from the commit message of aea5d84 ("Audit fixes: serving the web app and guarding the API"). Its decisions are `docs/phase-1-plan.md`, "Decisions made during the audit", 1 to 12, and `docs/phase-2-plan.md`, "Decisions made during the audit", 1.

- **live-01, sec-01, web-01: the built UI's files are served without a session.** The static plugin is registered in its own scope whose routes are marked auth `static` (no session lookup, no database query); everything else keeps the default guard. Tested with a build fixture in every auth state and with the database down (`apps/api/src/serve.test.ts`).
- **sec-02, p1-23: the session and role are checked in `onRequest`, before a body is read, parsed or validated.** Body limit 1 MiB by default, 12 MiB only on the six CSV import routes, 8 KiB on the sign-in routes. A list or map of more than 5,000 items is refused (413 `too_many_items`) before its contract validates the items; reorder ids, import choices, tags, cash-flow account ids and fee columns got limits.
- **live-13, sec-13: `trustProxy` is no longer `true`.** `TRUST_PROXY` lists the proxy addresses whose `X-Forwarded-*` headers are believed (default none; `true` and hop counts refused); compose sets `uniquelocal` for the web container. `API_HOST` defaults to `127.0.0.1` (`0.0.0.0` in the image and compose). Sign-in is also limited per account: 20 passwords a minute per username, 5 authenticator codes per 15 minutes per user.
- **sec-14: every change must be same-origin** (`Sec-Fetch-Site`, else `Origin` against the request host; 403 `cross_site_request`) and may only carry `application/json` (415), sign-in and sign-out included.
- **sec-18: requests use bounded wire shapes** (`CentsInput` 15 digits, `IsoDateInput` and `MonthInput` real dates 1900 to 2199) while responses stay loose; the API refuses to register a route whose request contract uses a loose shape. Forged page cursors answer 400 `invalid_cursor`; NUL characters, split ratios over 1,000,000 and out-of-range CSV rows are refused; Postgres data exceptions answer 400 `invalid_value`; a goal no contribution reaches before 2200 has no projected month instead of a 500.
- **sec-15: payee search escapes `%`, `_` and `\`** through the shared `containsPattern` helper.

## Second round

An independent reviewer found no first-round item undone and raised two new issues. Both were reproduced and are real; both are fixed. Decisions: `docs/phase-1-plan.md`, "Decisions made during the audit", 113 and 114 (decisions 1 and 6 now point to them). The README (home-server quick start) and `.env.example` were edited to match.

Each new test was run against the code before its fix and failed. The outputs are in the lane's scratch directory (`laneA/`): `a1r2-red-serve.txt` (4 of 8 failing on the old `app.ts`), `a1r2-red-web-shellRoutes.txt` (3 of 4 failing with the old denylist), `a1r2-red-deploy.txt` (3 of 25 failing on the old compose file and README). The behaviour was also checked on the real build: the built API (`apps/api/dist/server.js`, production mode) served `apps/web/dist` on 127.0.0.1:3481 and was probed with curl and with headless Chromium, the service worker in control. The runs before the fix are in `a1r2-red-probe.txt` and `a1r2-red-browser.txt`, and the runs after it in `a1r2-green-probe.txt` and `a1r2-green-browser.txt`.

### Second round, new issue 1 (low): README points to the wrong file for TRUST_PROXY

Status: fixed.

What was wrong: the README said "`TRUST_PROXY` in `deploy/docker-compose.yml` must name its address". Since a7-backup-deploy-secrets (decision 75), `deploy/docker-compose.yml` only includes `deploy/services.yml`, and the value was hard-coded there (`- TRUST_PROXY=uniquelocal`, web service). A household following the README edited a file that has no such key, and setting `TRUST_PROXY` in `.env` changed nothing: rendered with `TRUST_PROXY=192.168.1.10,10.0.0.0/8` in `.env`, the web container still got `uniquelocal`.

What changed: the web entry is `- TRUST_PROXY=${TRUST_PROXY:-uniquelocal}`, so `.env` sets it, and when it is unset or empty it stays `uniquelocal` (Caddy on the compose network). Empty falls back rather than meaning "trust nobody": an uncommented `TRUST_PROXY=` copied from `.env.example` would otherwise make every client one address to the sign-in limits. The README now says to set `TRUST_PROXY` in `.env`, names the default and where it comes from, and says to recreate the container (`up -d`). `.env.example` says the same, and so does the comment in `services.yml`. A local edit to `services.yml` was the other choice, but a change to a tracked file gets in the way of every update (decision 114).

Tests: api `deployStack.test.ts` "a1-serve-and-guard (second round): TRUST_PROXY in .env names the proxy the web container trusts; unset or empty it is uniquelocal" (as `docker compose config` renders it, with the line commented, empty and set; the value parses, and no other container gets it); `deployConfig.test.ts` "a1-serve-and-guard (second round): the README and .env.example send a household to the file that sets TRUST_PROXY" (every file the README names for `TRUST_PROXY` must set it) and the updated "the web container listens on every interface, trusts only private-network peers, and publishes no port".

### Second round, new issue 2 (low): the SPA fallback serves the HTML shell for missing build files and for /api, and answers HEAD of an app route with 404

Status: fixed.

What was wrong: the fallback sent `index.html` for every GET whose URL did not start with `/api/`. On the HEAD build, `GET /assets/index-OLDHASH.js`, `/registerSW.js` and `/favicon.ico` got 200 `text/html`. So did `GET /api` and `/api?x=1`. `HEAD /plan` and `HEAD /` got a JSON 404 while GET got 200. In Chromium, `import()` of a stale chunk failed with "Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of text/html" instead of a 404. The service worker's navigation fallback denied only `/^\/api\//`, so a navigation to `/api`, `/api?x=1` or a missing `/assets/` file was answered from the cached shell (`fromServiceWorker` true), whatever the server would say. The test fixture also listed a `registerSW.js` that the build no longer writes (decision 87), so the suite served a file production does not have.

What changed: `servesShell` (`apps/api/src/app.ts`) gives the shell only to a GET or HEAD of a client-side route. That is a path, decoded as the router reads it and without the query, that is outside `/api` and `/assets` and has no dot in its last segment. Everything else gets the JSON 404 `not_found`. HEAD of an app route is now 200 with the shell's headers, and no body goes on the wire (checked over a socket). The service worker's `navigateFallbackDenylist` is the same rule (`apps/web/src/lib/shellRoutes.ts`, imported by `vite.config.ts`). In the built `sw.js` it reads `/^\/api(?:[/?]|$)/`, `/^\/assets(?:[/?]|$)/` and `/^[^?]*\/[^/?]*\.[^/?]*(?:\?|$)/`. In Chromium a navigation to `/api` or to a missing asset now reaches the server and gets its 404, a stale chunk fetch is a 404, and `/plan` still comes from the worker. `registerSW.js` is gone from the fixture. The client-side routes (App.tsx) have no dot in their last segment; a route that needs one would have to be added to both rules (decision 113).

Tests: api `serve.test.ts`:
- "answers a build file that does not exist with a JSON 404, never the shell (a stale chunk, a file this build has not got)" (GET and HEAD of `/assets/index-OLDHASH.js`, its `.css`, `/assets/chunk`, `/assets/`, `/registerSW.js`, `/workbox-00000000.js`, `/favicon.ico`, `/manifest.json`, `/plan/report.pdf`);
- "treats /api itself, with or without a query, as an API path, and gives the shell to no method but GET and HEAD" (`/api`, `/api?x=1`, `/api/`, `/api/?x=1`, `/api/nope?x=1`, `/%61pi/nope`; POST, PUT, PATCH, DELETE and OPTIONS on `/plan`);
- "answers HEAD of an app route as it answers GET: 200 with the shell's headers and no body" (`/`, `/plan`, a query with a dot, `/investments/accounts/12`);
- the database-down case now also covers HEAD `/plan`, `/api` and a missing asset.

Web `src/lib/shellRoutes.test.ts`, "a1-serve-and-guard (second round): which navigations the service worker answers with the shell": the API's paths, build files and client-side routes (`/apiary`, `/assetsx`, a dot in the query), plus the check that `vite.config.ts` passes this list.

Checks: `pnpm typecheck` and `pnpm lint` pass. The suites of the two packages touched pass (TEST_DATABASE_PREFIX `meridian_fix_a_`): api 42 files and 341 tests, web 45 files and 535 tests. `pnpm build` passes.
