# Meridian

Self-hosted personal finance for one household: spending plan, multi-month budget grid, cash-flow projection, investment tracking, and a retirement planner. Bank data via SimpleFIN. Runs in Docker on your own server.

## Quick start (development)

```bash
pnpm install
cp .env.example .env          # fill in secrets
docker compose -f deploy/docker-compose.yml up -d db
pnpm db:migrate
pnpm dev
```

## Quick start (home server)

```bash
cp .env.example .env          # fill in secrets
docker compose -f deploy/docker-compose.yml up -d
```

The app is served by Caddy on the LAN only. For access from outside, put the server on Tailscale; do not port-forward.

## Layout

| Path | What |
| --- | --- |
| `apps/web` | React + Vite UI |
| `apps/api` | Fastify API |
| `apps/worker` | Sync, prices, recurring detection, simulations |
| `packages/db` | Drizzle schema and migrations |
| `packages/shared` | Zod schemas and types |
| `deploy/` | Compose, Caddy, backups |

Design spec and build phases: see `CLAUDE.md`.
