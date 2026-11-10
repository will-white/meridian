# Phase 1 build plan: Foundation and ledger

Source of truth: the design spec (linked from `CLAUDE.md`). This plan says what Phase 1 builds, where it lives, and where it deliberately departs from the letter of the spec or `CLAUDE.md`.

## Deliverables

| # | Deliverable | Where |
| --- | --- | --- |
| 1 | pnpm monorepo: `apps/web`, `apps/api`, `apps/worker`, `packages/db`, `packages/shared` | root, already scaffolded; extended here |
| 2 | Docker Compose with `web`, `worker`, `db`, `proxy` (Caddy, internal TLS), `backup` (nightly encrypted `pg_dump`), `.env.example` | `deploy/` |
| 3 | Auth: one local owner, Argon2id, TOTP, cookie sessions | `apps/api/src/auth` |
| 4 | Phase 1 tables + first migration | `packages/db` |
| 5 | SimpleFIN: claim, encrypted Access URL, 6-hour sync, overlap window, upsert, pending→posted, `errlist` per connection | `apps/worker`, `packages/db/src/services` |
| 6 | Payee normalization, ordered rules, transfer pairing | `packages/shared` (pure) + `packages/db/src/services` (persistence) |
| 7 | Bank CSV import with a column mapper saved per institution | `packages/shared/src/csv.ts`, `apps/api/src/routes/import.ts`, `apps/web` |
| 8 | Minimal UI: connections, accounts, register with search, categorize, "always do this" | `apps/web` |

## Package responsibilities

- `packages/shared` is isomorphic (runs in browser and Node). It holds Zod contracts for every API route, the SimpleFIN v2 response schema, and the pure engines: `normalizePayee`, `evaluateRules`, `pairTransfers`, `matchPendingToPosted`, CSV parse + map, `sanitizeText`, and AES-256-GCM helpers on Web Crypto. Every engine has hand-calculated Vitest cases.
- `packages/db` holds the Drizzle schema, migrations, a programmatic migrate runner, and the data services that apply the engines to rows: `upsertTransactions` (dedupe by account + external id, pending replacement), `applyRules`, `pairTransfersForAccounts`, `importCsv`, `jobs`. Integration tests run against `TEST_DATABASE_URL` and skip when it is unset.
- `apps/worker` is the only process that talks to the outside world (spec: "the worker is the only container that talks to the outside world"). It runs the SimpleFIN client, a Postgres-backed job runner (`FOR UPDATE SKIP LOCKED`), and the 6-hour scheduler.
- `apps/api` validates with Zod, owns sessions, and enqueues jobs for anything that touches SimpleFIN. It serves the built UI in production.
- `apps/web` is React + Vite + TanStack Query + React Router, plain CSS, PWA manifest already configured.

## Data model (Phase 1)

Tables from the spec: `connection`, `import_log`, `account`, `balance_snapshot`, `transaction`, `split`, `payee`, `rule`, `tag`, `transaction_tag`, plus `user` and `session` for auth.

Additions beyond the list, each with a reason:

- `job`: `CLAUDE.md` fixes "jobs are queued in Postgres" and the spec routes all SimpleFIN traffic through the worker, so claim and sync run as jobs.
- `category` (minimal: name, bucket, hidden): the Phase 1 UI must categorize and the rules engine must set a category, so a target table is needed. `category_group` and `month_plan` stay in Phase 2.
- `connection.claim_token_enc` and `connection.last_errors` (jsonb): the pasted token waits encrypted for the worker to claim it; `errlist` entries surface per connection.
- `connection.synced_through`: the high-water mark that the next sync overlaps by 7 days.
- `account.balance_cents`, `available_cents`, `balance_date`: current balance for the accounts list, with history in `balance_snapshot`.
- `transaction.is_transfer`, `source`, `import_log_id`, `posted_at`, `memo`: rule action "mark transfer", provenance, and the SimpleFIN fields.
- `transaction.category_locked`: set when the user categorizes by hand, so re-running rules never overwrites a manual choice.

## Sync pipeline (per connection, in the worker)

1. Window: `start-date` = `synced_through − 7 days`, or `now − 93 days` on first sync. Always `pending=1`. `balances-only=1` is used by the "refresh balances" job.
2. Raw response goes to `import_log` first, before any parsing.
3. Accounts upsert by (connection, external id); balance snapshot written per account per balance date.
4. Transactions: upsert by (account, external id). Bank-owned fields (amount, date, description, pending) update; user fields (category, payee if locked, notes, tags) never do.
5. Pending → posted: a posted item whose id is new is matched to a local pending row in the same account by equal amount, date within 5 days and best description similarity, then that row is updated in place (new external id, `pending=false`), keeping its id and user edits. Pending rows inside the window that are neither returned nor matched are deleted.
6. New rows: normalize payee → run rules → pair transfers across all of the user's accounts within 3 days.
7. `errlist` entries are stored on the connection; `con.auth` sets status `auth_required`; HTTP 403 on sync sets `auth_required`; 402 sets `error` with a "subscription" message; 403 on claim sets `error` with the "token may be compromised" message. All server text is sanitized before it is stored for display.

## Rules engine semantics

Rules run in `position` order. Every rule whose conditions all hold applies its actions; a later rule overrides an earlier one for the same field, tags accumulate, and a rule may set `stop` to end evaluation. Conditions: payee (equals, contains, starts with, regex), description (same operators), signed amount range in cents, account, day of month. Actions: set payee, set category, add tags, mark transfer.

## Transfer pairing

Candidates are unpaired transactions in the user's own accounts. An outflow pairs with the inflow of exactly opposite amount in a different account whose date is within 3 days, choosing the closest date (earliest on a tie). Each transaction pairs at most once. Both legs get the same `transfer_pair_id`, `is_transfer=true`, and their category is cleared so they leave the budget.

## CSV import

Mapping per institution is stored on a `connection` of type `csv` (`csv_mapping`). The mapper supports header or index columns, several date formats, a single signed amount column (with optional inversion) or separate debit and credit columns, and optional memo and id columns. Rows without a bank id get a stable external id: `csv:` + SHA-256 of date, amount and normalized description, with an ordinal for identical rows in the same file. Re-importing the same or an overlapping file creates no duplicates.

## Auth

First run creates the owner (`POST /api/auth/setup`). Passwords hash with Argon2id (19 MiB, 2 iterations, parallelism 1). TOTP enrollment is required before the app opens; the secret is stored encrypted with `SECRETS_KEY`. Sessions are random ids in the `session` table behind a signed, HttpOnly, SameSite=Lax cookie that is `Secure` in production. Login routes are rate-limited, per client address and per account (see the audit decisions at the end of this file).

The guard runs in Fastify's `onRequest` hook, before a body is read: every route is closed unless its `config.auth` opens it (`static` for the files of the web app, `public` for health and the sign-in routes, `session` for the two-factor routes; the default `full` needs a verified session, and a change also needs the owner role). In production the API serves the built web app from `WEB_DIST_DIR`; those files and the SPA fallback are `static`: no session, no database query, so the setup and sign-in screens load in a fresh browser.

## Deviations and open points

- `packages/db/src/services` holds the persistence side of the ledger pipeline rather than a sixth package, to keep the five-workspace layout in `CLAUDE.md`.
- `category` is pulled forward from Phase 2 in minimal form (reason above).
- SimpleFIN hosts were unreachable from the build container, so the client follows protocol v2 as described in `CLAUDE.md` and the public spec from memory. Schemas are lenient (`passthrough`) and raw payloads are logged, so a field mismatch is recoverable without a resync.
- The Phase 1 gate's "3 months of real transactions" is exercised with a deterministic 3-month fixture through two overlapping syncs and a repeat sync. Running it against a real Bridge token is the user's acceptance step.

## Test matrix

| Area | Test | Package |
| --- | --- | --- |
| Money | parse and format round trips | shared |
| Payee normalization | processor prefixes, store numbers, city/state suffixes, card artifacts | shared |
| Rules engine | ordering, override, tags accumulate, stop, every condition operator | shared |
| Transfer pairing | equal and opposite within 3 days, closest date wins, same account never pairs, each leg used once | shared + db |
| Pending → posted | matched by amount, window and description; row id and category preserved; vanished pending removed | shared + db |
| Dedupe | same payload twice, overlapping windows, CSV re-import | db |
| CSV | parsing quoted fields, mapping, date formats, debit/credit columns, stable ids | shared |
| SimpleFIN client | claim 200 and 403, accounts 200/402/403, `errlist` surfaced, HTTPS enforced | worker |
| Auth | setup, login, TOTP, guard | api |
| Serving the web app | every file of the shell loads with no session, in every auth state and with the database down; unknown API paths stay JSON 404 | api |
| Request guards | session before body; body, list and NUL limits; same-origin changes; JSON only; proxy trust; per-address and per-account sign-in limits | api |
| Hostile input | bad cursors, impossible or out-of-range dates and months, amounts over 15 digits, column overflows, CSV out-of-range rows, literal `%`/`_` search: 400, never 500 | shared + db + api |

## Decisions made during the audit

Serving and guarding the API (audit batch "serve and guard"):

1. **The web app's files are public; only `/api` is guarded.** `@fastify/static` is registered in its own scope whose routes are marked `auth: "static"`; the guard's default for every other route stays `full`. Static routes and unknown paths never read the session or the database.
2. **Authentication runs before the body is read.** The guard moved from `preHandler` to `onRequest`: an anonymous caller gets 401 (403 `setup_required` before the owner exists) and a viewer's change gets 403 `viewer` without the body being parsed or validated.
3. **Body limits.** 1 MiB by default (Fastify refuses more with 413 before parsing), 12 MiB only on the six `/api/import/*` routes whose `csvText` may be 10,000,000 characters, 8 KiB on the sign-in routes. The default is 1 MiB rather than the 256 KB the audit suggested because a contract-valid plan edit (600 cells with notes) can exceed 256 KB.
4. **List limit.** No list or map in a request may have more than 5,000 items (`MAX_LIST_ITEMS`, checked on the parsed body before its contract: 413 `too_many_items`). Zod 3 validates every element of an over-long array, and the fix for that upstream advisory exists only in Zod 4; this check bounds the work without a major upgrade. Lists that had no limit got one: reorder ids and import choices 5,000, tags 50, cash-flow account ids 500, fee columns 10.
5. **Changes must be same-origin and JSON.** For every method except GET, HEAD and OPTIONS (sign-in and sign-out included) the API refuses a request whose `Sec-Fetch-Site` is not `same-origin` or `none`, or, when the browser sends no `Sec-Fetch-Site`, whose `Origin` host differs from the request's own host (403 `cross_site_request`); a client that sends neither header is not a browser and passes. A `Content-Type` other than `application/json` on a change is 415, so no HTML form can be a valid request. The cookie stays SameSite=Lax: Strict would add nothing here, because the threat is a same-site sibling host (another machine on the tailnet name), which SameSite does not stop and the origin check does, and no state changes on GET.
6. **Proxy trust is a list of addresses.** `TRUST_PROXY` names the peers whose `X-Forwarded-For` / `X-Forwarded-Host` are believed (IPs, CIDR ranges, or the presets `loopback`, `linklocal`, `uniquelocal`). The default is nobody; `true` and hop counts are refused, because a client that reaches the port directly could then choose its own address. The compose file sets `uniquelocal` for the web container: its port is not published, so its only peers are on the compose network, and Caddy replaces any forwarded header a client sends. A fixed subnet for the compose network would be tighter but can collide with networks the server already has, so it was not chosen.
7. **The API binds loopback by default.** `API_HOST` defaults to `127.0.0.1`; the Docker image and the compose file set `0.0.0.0` inside the container. The Vite dev proxy targets `127.0.0.1:3000`.
8. **Sign-in limits per account as well as per address.** Per address (before the body is read): 5 setups, 10 passwords, 10 codes a minute. Per account, whatever the address: 20 password attempts a minute per username, and 5 authenticator codes per 15 minutes per user (480 guesses a day against a six-digit code with a three-step window). A locked-out owner sees how many seconds to wait; existing sessions are unaffected. The counters live in the API process and reset when it restarts.
9. **What a caller may send is bounded; what the API returns is not.** Requests use `CentsInput` (at most 15 digits of cents, about ten trillion dollars, so thousands of amounts still sum inside a bigint), `IsoDateInput` (a real calendar date, 1900-01-01 to 2199-12-31) and `MonthInput` (1900-01 to 2199-12); responses keep the loose `CentsString`, `IsoDateString` and `MonthString`, so whatever a bank feed or an old import stored still serializes. The API refuses to register a route whose request contract uses a loose shape. CSV imports apply the same bounds per row ("Unreadable date", "Unreadable amount"), and a split ratio side is at most 1,000,000.
10. **A page cursor the server did not issue is 400 `invalid_cursor`** on the transaction, audit and investment-transaction lists (before: a 500 from Postgres, or silently the first page).
11. **Postgres data exceptions are the caller's 400.** A value the database refuses as out of range or malformed (SQLSTATE class 22; for example a quantity times a price that no column can hold) is answered 400 `invalid_value` and logged at warn level, not 500. The contracts stop what they can see; this is the net under them.
12. **Payee search matches `%`, `_` and `\` literally**, through the same `containsPattern` helper as the transaction and security searches.
