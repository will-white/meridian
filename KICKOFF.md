Read CLAUDE.md first, then the design spec it links to. The monorepo skeleton, Docker Compose, Caddy config, and shared tooling are already in place; `pnpm install && pnpm typecheck` should pass before you start.

Build **Phase 1: Foundation and ledger** of Meridian:

1. Auth: a single local owner account, Argon2id password hashing, and TOTP. Session cookies, HTTPS only.
2. Phase 1 tables in `packages/db` from the spec's data model: `connection`, `import_log`, `account`, `balance_snapshot`, `transaction`, `split`, `payee`, `rule`, `tag`, `transaction_tag`. Generate and apply the first migration.
3. SimpleFIN: paste-token → claim → store the encrypted Access URL. The worker syncs every 6 hours with an overlapping `start-date` window, upserts by (account, external id), replaces pending transactions when they post, and surfaces `errlist` per connection. Follow every rule in CLAUDE.md.
4. Payee normalization, ordered rules engine, and transfer pairing (equal and opposite amounts across the user's own accounts within 3 days).
5. Bank CSV import with a column mapper saved per institution.
6. Nightly encrypted `pg_dump` backup job (`deploy/backup.sh` is a stub).
7. Minimal UI: connections page, accounts list with balances, transaction register with search, categorize/recategorize, and "always do this" rule creation.

Phase 1 gate: 3 months of real transactions import with no duplicates and correct transfer pairing. Include automated tests for dedupe, pending→posted replacement, transfer pairing, and the rules engine.

Plan first, show me the plan, then build.
