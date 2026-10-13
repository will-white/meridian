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

First run creates the owner (`POST /api/auth/setup`). Passwords hash with Argon2id (19 MiB, 2 iterations, parallelism 1). TOTP enrollment is required before the app opens; the secret is stored encrypted with `SECRETS_KEY`. Sessions are random ids in the `session` table behind a signed, HttpOnly, SameSite=Lax cookie that is `Secure` in production. Login routes are rate-limited.

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
