# Meridian: project guide

Meridian is a self-hosted personal finance app for one household. Full design spec:
https://claude.ai/code/artifact/8c7807a5-4f62-4ab5-bd55-854537222288
That spec is the source of truth. If this file and the spec disagree, follow the spec and flag the conflict.

## What this is
Meridian combines a Simplifi-style spending plan and cash-flow projection, an Actual Budget-style multi-month grid, investment tracking at the holding and lot level, and a retirement planner with Monte Carlo simulation and a tax engine. It runs in Docker on a home server. Bank data comes from SimpleFIN.

## Repo layout
```
apps/web        React + Vite UI (PWA)
apps/api        Fastify API
apps/worker     Sync scheduler, price fetch, recurring detection, simulations
packages/db     Drizzle schema + migrations
packages/shared Zod schemas and types shared by web, api and worker
deploy/         docker-compose.yml, Caddyfile, backup script
```

## Fixed decisions (don't change these without asking)
- **Language:** TypeScript everywhere (UI, API, worker, retirement engine).
- **Frontend:** React + Vite, TanStack Query, a virtualized grid for the multi-month view; installable as a PWA.
- **API:** Node + Fastify, with Zod-validated routes shared with the frontend.
- **DB:** PostgreSQL 16 with Drizzle ORM and migrations.
- **Worker:** same codebase in a separate container. Jobs are queued in Postgres.
- **Retirement engine:** a pure TypeScript package that runs in worker threads, deterministic with a seed.
- **Deploy:** Docker Compose with `web`, `worker`, `db`, and `proxy` (Caddy). LAN only; remote access via Tailscale. No port forwarding.
- **Money:** integer cents (`bigint`); share quantities and prices `numeric(20,8)`. No floats for money outside the simulation engine.
- **Accounts carry a tax treatment** (taxable, pre-tax, Roth, HSA) from day one.
- **App is read-only toward institutions.** It never moves money.

## SimpleFIN rules (from the protocol spec, v2)
- Token = Base64 claim URL. POST it to get the Access URL. A 403 on claim means the token may be compromised; tell the user.
- Store the Access URL encrypted (AES-256-GCM, key from a Docker secret or env, never in the DB or backups).
- `GET /accounts?version=2` with `start-date` overlap; use `balances-only=1` for quick refreshes.
- Handle `errlist` codes (`con.auth`, `act.failed`, `act.missingdata`) and 402/403 responses. Sanitize all server-provided text before display.
- HTTPS only, with certificate verification on.
- There is no standard holdings object. Investment positions may appear in `extra`; CSV import covers the rest.

## Working rules
- Build in the spec's phase order. Don't start a phase until the previous gate passes.
- Write tests alongside code (Vitest). Money math, rules, transfer matching, recurring detection, and the tax and RMD logic need hand-calculated test cases.
- Keep secrets out of git. Commit `.env.example` only.
- Raw SimpleFIN responses go to `import_log` for re-processing.
- Commands: `pnpm install`, `pnpm dev`, `pnpm test`, `pnpm typecheck`, `pnpm db:generate`, `pnpm db:migrate`.
