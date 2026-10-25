# Meridian

Self-hosted personal finance for one household: spending plan, multi-month budget grid, cash-flow projection, investment tracking, and a retirement planner. Bank data via SimpleFIN. Runs in Docker on your own server.

Phase 1 (foundation and ledger) is built: auth, SimpleFIN sync, accounts, a transaction register, payee normalization, rules, transfer pairing, CSV import, and encrypted nightly backups. See `docs/phase-1-plan.md` for what was built and why.

Phase 3 (investments) is built: securities and daily prices behind a provider interface (Tiingo, with implied and manual prices), holdings from SimpleFIN `extra` and positions CSV, trade-history import, lots and cost basis, reconciliation to brokerage statements to the dollar, and the Portfolio, Allocation, Holdings, Performance and Income views. See `docs/phase-3-plan.md` and `docs/design/phase-3/`.

Phase 2 (spending plan) is built: category groups, a virtualized multi-month plan grid with rollovers and plan-from-average, savings goals, recurring detection with suggestions and alerts, a subscriptions page, a cash-flow projection with what-ifs, and a dashboard. See `docs/phase-2-plan.md` for the binding decisions and `docs/design/phase-2/` for the area designs.

## Quick start (development)

```bash
pnpm install
cp .env.example .env            # fill in SESSION_SECRET, SECRETS_KEY (openssl rand -base64 32), passwords
docker compose -f deploy/docker-compose.yml up -d db
pnpm db:migrate                 # applies packages/db/drizzle to DATABASE_URL
pnpm dev                        # api on :3000, worker, web on :5173 (proxies /api)
```

Open http://localhost:5173, create the owner account, enroll an authenticator app, then paste a SimpleFIN setup token on the Connections page.

## Quick start (home server)

```bash
cp .env.example .env            # fill in secrets
docker compose -f deploy/docker-compose.yml up -d --build
```

Caddy serves the app on the LAN at `https://$SITE_ADDRESS` with an internally issued certificate; trust its root CA on your devices. For access from outside, put the server on Tailscale. Do not port-forward.

## Commands

| Command | What |
| --- | --- |
| `pnpm dev` | run api, worker and web with hot reload |
| `pnpm test` | unit tests; integration suites skip without `TEST_DATABASE_URL` |
| `pnpm test:db` | all tests against a local Postgres (creates throwaway databases) |
| `pnpm typecheck`, `pnpm lint` | type and lint checks across the workspace |
| `pnpm db:generate` | generate a migration after editing `packages/db/src/schema` |
| `pnpm db:migrate` | apply migrations to `DATABASE_URL` |
| `pnpm build` | production bundles (`apps/*/dist`) and the web build |

## Backups

The `backup` service runs `deploy/backup.sh` nightly at `BACKUP_HOUR` UTC: an encrypted `pg_dump` into `deploy/backups/daily` (30 kept) and `deploy/backups/monthly` (12 kept). Set `BACKUP_COPY_CMD` to push each file off the server. Restore with `deploy/restore.sh <file>`. `SECRETS_KEY` is never in a backup: keep it with the passphrase, off the server.

## Layout

| Path | What |
| --- | --- |
| `apps/web` | React + Vite UI (PWA) |
| `apps/api` | Fastify API; serves the built UI in production |
| `apps/worker` | SimpleFIN sync, job runner, scheduler, recurring detection, nightly month close, price fetch and valuation jobs; later simulations |
| `packages/db` | Drizzle schema, migrations, data services |
| `packages/shared` | Zod contracts and the pure engines (payee normalization, rules, transfers, CSV, schedules, plan math, recurring detection, cash flow, lots and cost basis, valuation, performance) |
| `deploy/` | Compose, Caddy, backup and restore scripts |

Design spec and build phases: see `CLAUDE.md`.
