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

Open http://localhost:5173, create the owner account, enroll an authenticator app, then paste a SimpleFIN setup token on the Connections page. Create the owner right after the first start: until then, whoever opens the app first can.

The API listens on loopback (`API_HOST`, default `127.0.0.1`) and believes no `X-Forwarded-*` header unless `TRUST_PROXY` names the proxy that sent it.

## Quick start (home server)

```bash
cp .env.example .env            # fill in secrets
docker compose -f deploy/docker-compose.yml up -d --build
```

Caddy serves the app on the LAN at `https://$SITE_ADDRESS` with an internally issued certificate; trust its root CA on your devices. For access from outside, put the server on Tailscale. Do not port-forward.

The `web` container serves the built UI and the API on port 3000, reachable only from the compose network. The UI's files load without a session; everything under `/api` needs one. Changes are accepted only from the app's own origin and only as JSON. If you put a different reverse proxy in front, it must pass the `Host` header through (or send `X-Forwarded-Host`), and `TRUST_PROXY` in `deploy/docker-compose.yml` must name its address so the sign-in rate limits count the real client.

## Accounts and sign-in

There are two roles. The **owner** (one account, created on first run) changes everything. **Viewers** see everything and change nothing except their own sign-in; the owner adds them under Settings > Household members with a first password, and each viewer sets up their own authenticator app at their first sign-in.

Under Settings > Sign-in and security every member can change their password (the current one is required; other sessions are signed out), move to a new authenticator (the old one keeps working until a code from the new one is accepted), see where they are signed in and sign those sessions out, and review the sign-in activity: completed sign-ins and failed attempts, kept for 90 days. The owner sees every member's activity, can set a new password for a viewer who forgot theirs, clear the authenticator of a viewer who lost their phone, and remove a viewer.

How sign-in behaves:

- A password alone opens nothing: it starts a ten-minute session that can only take the authenticator code. Five wrong codes end it (enter the password again), and codes are refused for up to 15 minutes after five attempts on one account.
- Each authenticator code works once.
- A signed-in session ends after `SESSION_TTL_DAYS` (30) or after `SESSION_IDLE_DAYS` (14) without use, whichever comes first.
- The database stores a hash of each session id, never the id, so a backup holds nothing that can be used to sign in.

### Locked out

If the owner has lost the authenticator or forgotten the password, recover from the server's console. These commands talk to the database directly, end the member's sessions and are recorded in the audit log:

```bash
docker compose -f deploy/docker-compose.yml exec web node apps/api/dist/admin.js users
docker compose -f deploy/docker-compose.yml exec web node apps/api/dist/admin.js reset-totp <username>
docker compose -f deploy/docker-compose.yml exec web node apps/api/dist/admin.js reset-password <username>
docker compose -f deploy/docker-compose.yml exec web node apps/api/dist/admin.js sign-out <username>
```

`reset-totp` clears the authenticator: sign in with the password and set up a new one straight away, because until then the password alone reaches that setup screen. `reset-password` prints a temporary password once; sign in with it and change it under Settings. `users` lists the accounts that exist: if the app shows "Sign in" before you ever created an account, someone else on your network got there first; check with `users`, then reset that account or start again with an empty database. In development the same commands run as `pnpm --filter @meridian/api admin <command>`, with `DATABASE_URL` set as for `pnpm dev`.

## Bank sync

The worker syncs each SimpleFIN connection every 6 hours (`SYNC_INTERVAL_HOURS`), asking the Bridge for everything from 7 days before the last complete sync. The Connections page shows that day as "complete through".

- **A bank needs re-authentication, or the Bridge could not read an account.** The Bridge still answers, with what it last knew. Syncs keep running, "complete through" stays where it was, and the first complete sync afterwards fetches everything since, so an outage of weeks loses nothing. Pending rows of the affected accounts are kept in the meantime. A sync never asks for more than 93 days (`SIMPLEFIN_INITIAL_WINDOW_DAYS`); if a bank was unreadable for longer, the connection says which days were not requested, and a CSV import covers them.
- **The Bridge is down or unreachable.** The sync is retried twice within minutes, then once every 6 hours until it works. The error says why (a name that does not resolve, a refused connection, a certificate that was not accepted, a timeout).
- **The Bridge refuses the access URL (403) or asks for payment (402).** Trying again cannot help, so scheduled syncs for that connection stop. Fix it at the Bridge, then press **Sync now**; when that sync works the schedule resumes. A revoked access URL needs a new setup token (add a new connection, remove the old one).
- **Full resync** asks again for the whole first-sync window (93 days). Nothing is added twice. Use it when something looks missing after an outage.

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
