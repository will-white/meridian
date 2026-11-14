# Meridian

Self-hosted personal finance for one household: spending plan, multi-month budget grid, cash-flow projection, investment tracking, and a retirement planner. Bank data via SimpleFIN. Runs in Docker on your own server.

Phase 1 (foundation and ledger) is built: auth, SimpleFIN sync, accounts, a transaction register, payee normalization, rules, transfer pairing, CSV import, and encrypted nightly backups. See `docs/phase-1-plan.md` for what was built and why.

Phase 3 (investments) is built: securities and daily prices behind a provider interface (Tiingo, with implied and manual prices), holdings from SimpleFIN `extra` and positions CSV, trade-history import, lots and cost basis, reconciliation to brokerage statements to the dollar, and the Portfolio, Allocation, Holdings (with each account's lots), Performance, Realized gains and Income views. See `docs/phase-3-plan.md` and `docs/design/phase-3/`.

Phase 2 (spending plan) is built: category groups, a virtualized multi-month plan grid with rollovers and plan-from-average, savings goals, recurring detection with suggestions and alerts, a subscriptions page, a cash-flow projection with what-ifs, and a dashboard. See `docs/phase-2-plan.md` for the binding decisions and `docs/design/phase-2/` for the area designs.

## Quick start (development)

```bash
pnpm install
cp .env.example .env            # fill in SESSION_SECRET (openssl rand -hex 32), SECRETS_KEY (openssl rand -base64 32)
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml up -d db   # db on 127.0.0.1:5432
pnpm db:migrate                 # applies packages/db/drizzle to DATABASE_URL
pnpm dev                        # api on :3000, worker, web on :5173 (proxies /api)
```

Open http://localhost:5173, create the owner account, enroll an authenticator app, then paste a SimpleFIN setup token on the Connections page. Create the owner right after the first start: until then, whoever opens the app first can.

The API listens on loopback (`API_HOST`, default `127.0.0.1`) and believes no `X-Forwarded-*` header unless `TRUST_PROXY` names the proxy that sent it.

## Quick start (home server)

```bash
cp .env.example .env            # set POSTGRES_PASSWORD, SESSION_SECRET, SECRETS_KEY, BACKUP_PASSPHRASE, SITE_ADDRESS
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps      # every service should become "healthy"
```

This needs Docker Compose 2.20 or later. `deploy/docker-compose.yml` includes `deploy/services.yml` and reads the repository's `.env` for it, and each container gets only the settings it reads: the database password reaches db, web, worker and backup; `SECRETS_KEY` web and worker; `SESSION_SECRET` web; the Tiingo key the worker; `BACKUP_PASSPHRASE` the backup container; Caddy only `SITE_ADDRESS`. The API and the worker refuse to start in production with the `.env.example` placeholders (`change-me`) or a `SECRETS_KEY` that is not 32 bytes of base64. To keep `SECRETS_KEY` and the Tiingo key out of every container's environment, use Docker secret files instead (`deploy/docker-compose.secrets.yml` says how).

The database and the web container sit on a network with no route out; only the worker (SimpleFIN and the price provider), the backup container (the off-site copy) and Caddy (for its published ports) can reach other hosts, and which hosts the worker calls is enforced by the worker itself. The web and worker containers run as an unprivileged user; the backup container drops to the `postgres` user once it has handed `deploy/backups` to it.

Caddy serves the app on the LAN at `https://$SITE_ADDRESS` with an internally issued certificate; trust its root CA on your devices. For access from outside, put the server on Tailscale. Do not port-forward.

After an update (`up -d --build` again), an app that is still open, on a phone as on a desktop, shows "A new version of Meridian is ready" when it next comes into view (it also checks hourly); choosing **Reload to use it** switches to the new build. Nothing reloads on its own, so nothing being typed is lost.

The `web` container serves the built UI and the API on port 3000, reachable only from the compose network. The UI's files load without a session; everything under `/api` needs one. Any other path a browser opens loads the app, except a file the build does not have (anything under `/assets/`, or a name with an extension, such as a previous build's script) and `/api` itself, which answer 404. Changes are accepted only from the app's own origin and only as JSON. If you put a different reverse proxy in front, it must pass the `Host` header through (or send `X-Forwarded-Host`), and you set `TRUST_PROXY` in `.env` to its address so the sign-in rate limits count the real client; unset or empty, the web container trusts `uniquelocal`, which is Caddy on the compose network (`deploy/services.yml`). Recreate the container after changing it (`up -d` again).

## Accounts and sign-in

There are two roles. The **owner** (one account, created on first run) changes everything. **Viewers** see everything and change nothing except their own sign-in; the owner adds them under Settings > Household members with a first password, and each viewer sets up their own authenticator app at their first sign-in.

Under Settings > Sign-in and security every member can change their password (the current one is required; other sessions are signed out), move to a new authenticator (the old one keeps working until a code from the new one is accepted), see where they are signed in and sign those sessions out, and review the sign-in activity: completed sign-ins and failed attempts (a wrong current password typed while signed in included), kept for 90 days. The owner sees every member's activity, can set a new password for a viewer who forgot theirs, clear the authenticator (and passkeys) of a viewer who lost their phone, and remove a viewer.

Under the same heading every member can add **passkeys**: after re-entering the password, the browser saves a passkey on the device (or in the platform's password manager), and **Sign in with a passkey** then signs that member in with the device's screen lock (fingerprint, face or PIN) instead of the password and the code. A passkey belongs to the address it was added at (the LAN name and the Tailscale name are two addresses), and it needs that address over https with a certificate the device trusts (trust Caddy's root CA, as above), or localhost. The password and the authenticator keep working; a passkey is never the only way in.

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

If the `web` container is not running (for example it refuses to start on a wrong `SECRETS_KEY`), use `run --rm` instead of `exec`: `docker compose -f deploy/docker-compose.yml run --rm web node apps/api/dist/admin.js users`.

`reset-totp` clears the authenticator and the member's passkeys (a lost phone may hold both): sign in with the password and set up a new authenticator straight away, because until then the password alone reaches that setup screen. `reset-password` prints a temporary password once; sign in with it and change it under Settings. `users` lists the accounts that exist: if the app shows "Sign in" before you ever created an account, someone else on your network got there first; check with `users`, then reset that account or start again with an empty database. In development the same commands run as `pnpm --filter @meridian/api admin <command>`, with `DATABASE_URL` set as for `pnpm dev`.

## Bank sync

The worker syncs each SimpleFIN connection every 6 hours (`SYNC_INTERVAL_HOURS`), asking the Bridge for everything from 7 days before the last complete sync. The Connections page shows that day as "complete through".

- **A bank needs re-authentication, or the Bridge could not read an account.** The Bridge still answers, with what it last knew. Syncs keep running, "complete through" stays where it was, and the first complete sync afterwards fetches everything since, so an outage of weeks loses nothing. Pending rows of the affected accounts are kept in the meantime. A sync never asks for more than 93 days (`SIMPLEFIN_INITIAL_WINDOW_DAYS`); if a bank was unreadable for longer, the connection says which days may be missing (from a week before "complete through", for items that post late). The notice stays through later syncs: import a CSV from the bank for those days, then press **Dismiss** next to it.
- **The Bridge is down or unreachable.** The sync is retried twice within minutes, then once every 6 hours until it works. The error says why (a name that does not resolve, a refused connection, a certificate that was not accepted, a timeout).
- **The Bridge refuses the access URL (403) or asks for payment (402).** Trying again cannot help, so scheduled syncs for that connection stop. Fix it at the Bridge, then press **Sync now**; when that sync works the schedule resumes. A revoked access URL needs a new setup token (add a new connection, remove the old one).
- **Full resync** asks again for the whole first-sync window (93 days). Nothing is added twice. Use it when something looks missing after an outage.
- **A bank linked at the Bridge later** gets the same 93 days of history as the first ones, also when it first shows up in a **Balances only** refresh: the next sync asks for its history.
- **An odd value in a response.** Amounts are read to the cent whatever their form ("+5.00", "12.345", "1E+2"); one that cannot be read skips only that transaction, a balance that cannot be read keeps the last known one, and an account or transaction that cannot be read at all is skipped. A response whose list of problems cannot be read is applied but not counted as complete, and one without a list of accounts is not taken as an answer: the sync fails and "complete through" stays where it was. The connection lists each of these, and every response is kept in the import log as it arrived, except that NUL characters, and anything nested more than 1000 levels deep, which the database cannot store, are replaced.
- **A setup token that could not be claimed** (the Bridge was down for a moment) stays stored: press **Sync now** to try the claim again. A token the Bridge refused (403) is deleted; the connection says it may be compromised.
- **A CSV over days the sync already has.** A bank export almost always overlaps synced days. The Import page marks the rows the ledger already has (from the feed, by hand or from an earlier file) as already imported, and the commit adds only the others; the feed later takes over a CSV row of the same purchase instead of adding it again. The same holds when a commit and a sync run at the same moment (they take turns), when the same file is imported again with or without its id column, and for files imported before an update. **Undo this import** on the result line takes an import back out. An amount written with a decimal comma ("12,50") is not read: export the file with a decimal point.
- **Reconnecting a bank.** Removing a connection keeps its accounts and the bank responses stored for them; when the same accounts come back on a new connection they are attached to it, not created again, and the new connection takes over those responses (for **Re-read transactions**). Deleting a CSV mapping profile keeps the imports made with it, which can still be undone. If the Bridge re-issued an account under a new id (or an account's history came from CSV files before the bank was connected), choose **same as a feed account…** on that account in Accounts: the feed account is folded into it and every transaction is kept once.
- **Re-read transactions** (Connections page) replays every stored response for its transactions, also those older than the Bridge's 93 days, after an update. Rows the ledger has are left as they are and nothing is added twice.
- **Corrections in the register.** **more** on a row edits its payee, notes and tags, pairs it with the other leg of a transfer the automatic pairing missed, marks it as a transfer whose other leg is not in the app (a split row loses its split: a transfer has none), or deletes it (a deleted bank or CSV row does not come back with the next sync or a re-import). A paired leg names the account and date of its other leg. **transfer · undo** lasts: the two rows are not paired again. **Add transaction** enters a cash purchase or an uncleared check (dated today at the latest, an amount other than zero); the bank's row of the same purchase takes it over later. A hold the bank sends without a date keeps the day it first appeared until it posts, so a note or category set on it stays. When the bank changes the amount of a paired transfer leg, the pair is released and paired again only with a matching leg.
- **Closing an account.** A closed feed account still gets its balance, but none of its transactions. Reopening it reads the ones it missed from the stored sync responses, so nothing from the closed days is lost.
- **Account types, manual accounts and payees.** The feed has no account type, so the app guesses one from the account's name ("Joint Checking" is a checking account); correct it on the Accounts page, along with the Budget box. Houses, vehicles and loans you add by hand start off budget, so they stay out of the cash-flow projection; a card or a loan takes the amount owed, and **update balance** records a new value on any date. The cash flow starts a manual account from that balance plus the rows imported after its date, and says how old each starting balance is. Changing a hand-entered account between a card or loan and any other type keeps the amount you typed (a car loan added as Checking with 15,000 owes 15,000 as a Loan). On the Payees page, merge the names one merchant appears under and rename a payee: the old names stay aliases, so the next import and the rules written on them still find it. A rule that marks rows as **not a transfer** keeps them out of the automatic pairing, and running it undoes a pair it rules out. The Rules page edits every condition and action and keeps a history that can be reverted, a deleted rule included; a rule saved before a check existed that cannot run as written (a pattern with look-ahead, which this app's pattern engine does not run) is marked **needs an edit** with the reason; **History** on the Plan page does the same for planned amounts, categories, goals, recurring items and settings (Undo puts a fill-right or an edit back).
- **Which servers.** The worker only calls the SimpleFIN Bridge's hosts (`SIMPLEFIN_ALLOWED_HOSTS`, default `bridge.simplefin.org` and `beta-bridge.simplefin.org`); a setup token for any other host is refused before any request. If you run your own SimpleFIN server, list its host there. Responses larger than `SIMPLEFIN_MAX_RESPONSE_MB` (50) are not read.

## Commands

| Command | What |
| --- | --- |
| `pnpm dev` | run api, worker and web with hot reload |
| `pnpm test` | unit tests; integration suites skip without `TEST_DATABASE_URL` (their throwaway databases are named `TEST_DATABASE_PREFIX`, default `meridian_test_`, plus a random suffix) |
| `pnpm test:db` | all tests against a local Postgres (creates throwaway databases) |
| `pnpm typecheck`, `pnpm lint` | type and lint checks across the workspace |
| `pnpm db:generate` | generate a migration after editing `packages/db/src/schema` |
| `pnpm db:migrate` | apply migrations to `DATABASE_URL` |
| `pnpm build` | production bundles (`apps/*/dist`) and the web build |

## The encryption key

`SECRETS_KEY` encrypts the SimpleFIN access URLs, setup tokens and every member's authenticator secret. It is never in the database or a backup, so keep a copy with the backup passphrase, off the server: a backup restored without it signs no one in and syncs nothing. The API and the worker check it at start-up and refuse to run, saying so in their log, when it opens none of the stored secrets.

**Changing it** (for example after it may have leaked):

```bash
openssl rand -base64 32                                         # the new key
# in .env: rename the SECRETS_KEY line to SECRETS_KEY_OLD, and add SECRETS_KEY=<the new key>
docker compose -f deploy/docker-compose.yml stop web worker
docker compose -f deploy/docker-compose.yml run --rm web node apps/api/dist/admin.js rotate-secrets-key
# remove SECRETS_KEY_OLD from .env
docker compose -f deploy/docker-compose.yml up -d
```

`rotate-secrets-key` re-encrypts every stored secret in one transaction (all or nothing); running it again changes nothing.

**When it is lost:** put a new key in `.env`, then `docker compose -f deploy/docker-compose.yml run --rm web node apps/api/dist/admin.js reset-secrets-key` lists what the new key cannot open, and the same with `--confirm` clears it: every member sets up their authenticator again at the next sign-in (the password alone reaches that screen until then, so do it straight away), and each SimpleFIN connection is removed and added again with a new setup token from the Bridge (its accounts and history are kept). Then start web and worker.

## Backups

The `backup` service (`deploy/backup.Dockerfile`: the Postgres image plus openssl, rclone and ssh) runs `deploy/backup.sh` nightly at `BACKUP_HOUR` UTC: a `pg_dump`, gzipped and encrypted with `BACKUP_PASSPHRASE`, into `deploy/backups/daily` (30 kept) and, for the first backup of each month, `deploy/backups/monthly` (12 kept). A backup counts only when every step worked and the new file decrypts and reads to pg_dump's closing line; a failed one leaves no file, promotes nothing and prunes nothing. The files and folders are readable by their owner only (the container's `postgres` user, uid 70).

`docker compose -f deploy/docker-compose.yml ps` shows the backup container **unhealthy** when the last backup failed, when no verified backup was made for 26 hours, or when the off-site copy is failing; `docker compose -f deploy/docker-compose.yml exec backup /backup.sh --health` says which, and `docker compose -f deploy/docker-compose.yml logs backup` shows each night. `deploy/backups/status/` keeps the last success, the last failure, the off-site state and the last restore check.

**Off the server.** Set `BACKUP_COPY_CMD` in `.env` (examples there): it runs for every backup file not copied yet, daily and monthly, with the file as `$1` and its folder as `$2`; a file whose copy failed is tried again after the next backup. Put the tool's configuration in `deploy/backup-config/` (git-ignored, mounted at `/backup-config`): `rclone.conf` for rclone (`RCLONE_CONFIG` points there; make one with `rclone config` and copy it in), or an ssh key and `known_hosts` for scp. The folder must be readable by uid 70 (`sudo chown -R 70 deploy/backup-config`).

**Prove a backup restores** (once a month; running it on a schedule is Phase 6 work): `docker compose -f deploy/docker-compose.yml exec backup /restore-check.sh` restores the newest backup into a throwaway database, checks it holds the app's tables, drops it and records the result. The live database is not touched.

**Restore.**

```bash
docker compose -f deploy/docker-compose.yml stop web worker
docker compose -f deploy/docker-compose.yml exec backup /restore.sh /backups/daily/meridian-20261013T020000Z.sql.gz.enc
docker compose -f deploy/docker-compose.yml start web worker
```

Nothing is changed until the backup has been decrypted and read to its end. It is then restored into a new database in one transaction that stops at the first error, and only then swapped in; the database it replaced is kept as `<name>_before_<time>` until you drop it. It asks you to type the database name (or pass `--yes`). `--target-db <name>` restores into a new database of that name and leaves everything else alone. On another machine with `psql`, `openssl` and `gzip` installed (and the development file's database port), `deploy/restore.sh` reads the settings it is not given from the repository's `.env`, from any directory. A restored database needs the same `SECRETS_KEY` (see "The encryption key").

## Updating

```bash
git pull
docker compose -f deploy/docker-compose.yml pull --ignore-buildable   # db and Caddy
docker compose -f deploy/docker-compose.yml build --pull              # web, worker and backup on fresh base images
docker compose -f deploy/docker-compose.yml up -d
```

The base images are the floating tags `postgres:16-alpine`, `node:22-alpine` and `caddy:2-alpine`, so a rebuild picks up their security fixes. To make rebuilds reproducible instead, pin each to a digest in `.env` (`POSTGRES_IMAGE`, `NODE_IMAGE`, `CADDY_IMAGE`; `docker buildx imagetools inspect <image>` prints the digest) and move the pins when you choose to update. Keep Postgres on major version 16: a new major version cannot read the existing data volume without a dump and restore. pnpm is pinned by version and hash in `package.json`.

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
