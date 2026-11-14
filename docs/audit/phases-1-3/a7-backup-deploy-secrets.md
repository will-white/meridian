# Audit record: Backups, deployment and secrets (a7-backup-deploy-secrets)

Scope: the nightly backup and its off-site copy, restore and the restore check, the compose stack and the images (which settings reach which container, ports, networks, users, healthchecks, image pins), and `SECRETS_KEY` (its checks, rotation and loss) for Phases 1 to 3.

Every finding was judged against the spec ("Security and backups", the phase list), the Phase 1 plan and the code, and reproduced before it was fixed. All 18 are real; 18 are fixed (for -08 the monthly schedule is Phase 6 work, as the spec lists restore-test automation there; for -13 the pins are a setting the household fills, decision 80). Decisions are recorded in `docs/phase-1-plan.md`, "Decisions made during the audit", 69 to 82. The README (home-server quick start, "Locked out", new "The encryption key", "Backups", new "Updating"), `.env.example`, `docs/design/phase-3/seams.md` P9 and `docs/design/phase-3/prices-and-valuation.md` §6.4 were edited to match. No dependency was added; `package.json`'s `packageManager` gained pnpm's sha512.

No Docker daemon runs here and no image can be pulled, so no container was started. Compose effects are checked with `docker compose config` (no daemon needed) on scratch copies of `deploy/` with a scratch `.env`; the scripts run under the local `/bin/sh` (dash; the container's is busybox ash, and the scripts use only POSIX features both have) against the local Postgres 16. What only a running container shows (the `apk add` in `deploy/backup.Dockerfile`, `su-exec`, Caddy's admin endpoint, the `internal` network's lack of a route) is covered by the closest checks below and stated as such.

Test files: `apps/api/src/deployScripts.test.ts` (the three scripts against Postgres), `apps/api/src/deployStack.test.ts` (compose as rendered, Dockerfiles, ignore rules), `apps/api/src/deployConfig.test.ts` (updated to the new layout), `apps/api/src/config.test.ts`, `apps/api/src/secretsKey.test.ts`, `packages/db/src/services/secretsKey.test.ts`, `packages/shared/src/crypto.test.ts`, `apps/worker/src/env.test.ts`, `apps/worker/src/runner.test.ts`. Each new test was run against the code before its fix and failed; the outputs are in the lane's scratch directory: `a7-red-deploy-scripts.txt` (12 of 12 failing on the old scripts), `a7-red-deploy-stack.txt` (12 of 12 on the old compose files and Dockerfiles), `a7-red-api-config.txt`, `a7-red-worker-env.txt`, `a7-red-db-secretsKey.txt`, `a7-red-api-secretsKey.txt`, `a7-red-worker-runner.txt`.

## a7-backup-deploy-secrets-01 (high): nightly backups in Docker write nothing and the log says they succeeded

Status: fixed.

What was wrong: the backup service ran the stock `postgres:16-alpine`, which has no `openssl`; `run_backup` was called on the left of `||`, which turns `set -e` off inside it, so every later step ran, "wrote" and "promoted to monthly" were printed and the function returned the prune loop's 0. No file was written and nothing showed it.

What changed: the service is built from `deploy/backup.Dockerfile` (the Postgres image plus `openssl`, `rclone`, `openssh-client`, `su-exec`, with a build-time check that every tool is there). `backup.sh` checks its tools and settings at start (the nightly loop refuses to start, so the container restarts and shows it), checks every step explicitly instead of relying on `set -e`, and runs each night's backup as its own process (decision 69).

Tests: api `deployScripts.test.ts` "a7-backup-deploy-secrets-01: without openssl a backup fails loudly and writes nothing, once or nightly" and "… in nightly mode a failed backup is reported as FAILED and the loop goes on" (the real loop with a fake `sleep` that stops it on its third call); `deployStack.test.ts` "a7-backup-deploy-secrets-01: the backup service is built with the tools its scripts need".

## a7-backup-deploy-secrets-02 (high): a failed pg_dump is reported as a successful backup, deletes a good copy and becomes the month's only monthly copy

Status: fixed.

What was wrong: no `pipefail`, so a failing `pg_dump` (wrong password, no such database, server down) produced a 48-byte file that decrypts to nothing, "wrote", promotion and pruning, exit 0.

What changed: each stage of the pipeline records its exit status in a file (portable to dash and busybox); the new file is then decrypted and gunzipped and must end with pg_dump's closing line before it is moved into place. Only after that is it promoted and are old copies pruned; on any failure the `.part` is deleted, the failure recorded in `status/last-failure`, and the script exits 1. A backup started in the same second as the previous one waits for the next second instead of overwriting it.

Tests: `deployScripts.test.ts` "a7-backup-deploy-secrets-02: a failing pg_dump writes nothing, keeps every good copy and promotes nothing" (30 seeded good copies; wrong password, missing database, server down) and "… a good backup is verified, promoted once a month and pruned beyond 30".

## a7-backup-deploy-secrets-03 (high): restore.sh drops the live database before it checks the backup

Status: fixed.

What was wrong: `DROP DATABASE … WITH (FORCE)` came first; a wrong passphrase, a cut-short file or an empty dump left an empty or partial database and "Restore complete.", exit 0.

What changed: `restore.sh` reads the whole backup first (decrypt, gunzip, closing line) and changes nothing if that fails; it then restores into a new database with `ON_ERROR_STOP=1 --single-transaction`, checks the app's migrations are there, and only then renames the current database to `<db>_before_<time>` and the restored one into its place. Replacing asks for the database name or `--yes`; every failure exits 1 and says "nothing was changed" (decision 70).

Tests: `deployScripts.test.ts` "a7-backup-deploy-secrets-03: a wrong passphrase, a cut-short file or an empty dump leaves the database as it was" and "… a restore replaces the database only after it completed, and keeps the one it replaced" (no terminal and no `--yes`: refused).

## a7-backup-deploy-secrets-04 (medium): restore.sh reads .env relative to the current directory and lets it override variables already set

Status: fixed.

What was wrong: `. ../.env` from the current directory (the documented command, run from the repository root, found no file), executed the file (an uncommented `BACKUP_COPY_CMD` line stopped the script), and overrode an already-set `POSTGRES_DB`, so a restore aimed at a scratch database replaced the live one.

What changed: the file is found from the script's location (or `MERIDIAN_ENV_FILE`), read as `KEY=VALUE` text for the four settings the script uses, and only for those not already set; `--target-db` restores beside the live database. The README's restore runs it in the backup container, which has `psql`, `openssl`, `gzip` and the database's network, and says to stop web and worker first.

Tests: `deployScripts.test.ts` "a7-backup-deploy-secrets-04: restore reads the repository's .env from any directory, never runs it, and an already-set value wins" (a checkout copy run from another directory; the `.env` has the rclone line and a `$(touch …)` that must not run; an already-set `POSTGRES_DB` is the one restored).

## a7-backup-deploy-secrets-05 (medium): the off-site copy cannot work in the shipped backup container, and its failure only reaches stderr

Status: fixed.

What was wrong: the image had no transport, a failed copy printed one line and the run still exited 0, nothing retried the missed file, and monthly promotions were never copied.

What changed: rclone and openssh-client are in the image, their configuration goes in `deploy/backup-config/` (mounted, `RCLONE_CONFIG` set). `BACKUP_COPY_CMD` runs for every daily and monthly file not yet copied (`$1` the file, `$2` its folder), so a failed file is retried after the next backup; a failure exits 3, is written to `status/offsite` and fails the healthcheck (decision 71).

Tests: `deployScripts.test.ts` "a7-backup-deploy-secrets-05: a failed off-site copy fails the run and the healthcheck, and is retried with the monthly copy" (then nothing is copied twice); `deployStack.test.ts` "a7-backup-deploy-secrets-11: …" also checks `BACKUP_COPY_CMD` reaches the container with its `$1` and `$2` intact. Not run here: `apk add rclone openssh-client` (no image build without a daemon).

## a7-backup-deploy-secrets-06 (medium): SECRETS_KEY is not checked at start-up

Status: fixed.

What was wrong: any non-empty string booted; a hex key (48 bytes) failed first-run TOTP setup with a 500, and a different key after a restore failed every sign-in and sync with opaque errors.

What changed: both config loaders require 32 bytes of standard base64 and say what the value is instead (`secretsKeyProblem` in `packages/shared/src/crypto.ts`). After migrations, the API (`apps/api/src/boot.ts`) and the worker try the key on every stored secret and refuse to start when it opens none of them, with "SECRETS_KEY is not the key these secrets were encrypted with" and what to do; when only some fail they start and log which. A decryption failure now says "could not be decrypted with SECRETS_KEY" (decision 73).

Tests: api `config.test.ts` "loadConfig: the encryption key and placeholder secrets … > refuses a SECRETS_KEY that is not 32 bytes of base64, naming the problem, and accepts one that is"; worker `env.test.ts` "the encryption key and the database password … > refuses a SECRETS_KEY that is not 32 bytes of base64, from the variable or the secret file"; db `secretsKey.test.ts` "a new install accepts any key; stored secrets must open with it, or start-up stops with the reason"; api `secretsKey.test.ts` "a7-backup-deploy-secrets-06: the API does not start with a key that opens none of the stored secrets"; shared `crypto.test.ts` "SECRETS_KEY checks … > secretsKeyProblem accepts 32 bytes of base64 …" and "… a wrong key's decryption error says what it means".

## a7-backup-deploy-secrets-07 (medium): every container gets every secret through env_file ../.env, and compose has no Docker-secret option for SECRETS_KEY

Status: fixed.

What was wrong: one `env_file` gave Caddy, the database, the backup, web and worker every secret; the `.env.example` advice to set `SECRETS_KEY_FILE` had no secret behind it.

What changed: `deploy/docker-compose.yml` includes `deploy/services.yml` with `env_file: ../.env`, so `.env` feeds compose interpolation from any directory, and each service lists the settings it reads. `deploy/docker-compose.secrets.yml` mounts `SECRETS_KEY` (web, worker) and the Tiingo key (worker) as Docker secret files. `.env` stays the default home of the key, as the spec allows (decision 75).

Tests: `deployStack.test.ts` "a7-backup-deploy-secrets-07: each container gets only the secrets it reads" (marker values: `SECRETS_KEY` in web and worker only, `SESSION_SECRET` web, Tiingo worker, passphrase backup, Caddy only `SITE_ADDRESS`), "… the Docker secrets file mounts SECRETS_KEY in web and worker only, and the Tiingo key in the worker", "… every setting the API and the worker read is passed to their container" (scans the sources, so a setting added later, Phase 4's included, fails it until compose passes it).

## a7-backup-deploy-secrets-08 (low): no restore test exists, and no test covers backup.sh or restore.sh

Status: fixed (the monthly schedule is deferred to Phase 6, spec: "Polish … restore-test automation").

What was wrong: nothing verified a backup, and the scripts' failure paths had no tests.

What changed: `deploy/restore-check.sh` (in the backup container: `docker compose exec backup /restore-check.sh`) restores the newest or a named backup into a throwaway database through `restore.sh --check`, counts migrations, tables, members, accounts and transactions, drops it and records `status/restore-check`; `deployScripts.test.ts` covers both scripts' failure paths (decision 72).

Tests: `deployScripts.test.ts` "a7-backup-deploy-secrets-08: the restore check restores the newest backup into a throwaway database and records the result" (and a damaged newest file fails it), plus the -01 to -05 tests above.

## a7-backup-deploy-secrets-09 (low): no way to rotate SECRETS_KEY, and no documented recovery when it is lost

Status: fixed.

What was wrong: one key, no re-encryption command, nothing documented.

What changed: `admin.js rotate-secrets-key` re-encrypts every stored secret from `SECRETS_KEY_OLD` to `SECRETS_KEY` in one transaction; `admin.js reset-secrets-key` lists what a new key cannot open and, with `--confirm`, clears it (authenticators as `reset-totp` does, connections paused with "add it again with a new setup token"). README "The encryption key" gives both procedures, with `docker compose run --rm` for a web container that refuses to start (decision 74).

Tests: db `secretsKey.test.ts` "ENCRYPTED_COLUMNS names every *_enc column of the schema, so a rotation misses none", "rotate-secrets-key re-encrypts every secret under the new key in one transaction, and can run twice", "reset-secrets-key clears what the new key cannot open …"; api `secretsKey.test.ts` "a7-backup-deploy-secrets-09: rotate-secrets-key moves every secret to the new key; the old one no longer starts the API" and "… reset-secrets-key shows what a lost key locked, and clears it only with --confirm".

## a7-backup-deploy-secrets-10 (low): the production compose file publishes the database port

Status: fixed.

What was wrong: `db` published `127.0.0.1:5432` in the home-server stack, and the test named "only Caddy publishes ports" never looked at `db`.

What changed: the port is in `deploy/docker-compose.dev.yml`, which the development quick start adds (decision 76).

Tests: `deployStack.test.ts` "a7-backup-deploy-secrets-10: only Caddy publishes ports; the development file adds the database on loopback"; `deployConfig.test.ts` "only Caddy publishes ports, and the worker has no network settings of the API" now checks every service.

## a7-backup-deploy-secrets-11 (low): BACKUP_HOUR set in .env is ignored

Status: fixed.

What was wrong: `BACKUP_HOUR: ${BACKUP_HOUR:-2}` was interpolated from `deploy/.env` or the shell, never `../.env`, and overrode the env file.

What changed: the backup service passes `BACKUP_HOUR` from `.env` by name (decision 75); `backup.sh` refuses an hour outside 0 to 23.

Tests: `deployStack.test.ts` "a7-backup-deploy-secrets-11: BACKUP_HOUR in .env reaches the backup container".

## a7-backup-deploy-secrets-12 (low): the API, worker and backup containers run as root

Status: fixed.

What changed: both runtime stages end with `USER node` (no `RUN` after it, `/app` root-owned); the backup container starts as root only to `chown` `/backups` to `BACKUP_RUN_AS` (postgres, uid 70) and `exec su-exec` to it (decision 79).

Tests: `deployStack.test.ts` "a7-backup-deploy-secrets-12: the API and worker images run as the node user"; `deployScripts.test.ts` "a7-backup-deploy-secrets-12: started as root, the backup hands its directory to BACKUP_RUN_AS and drops to it" (a recording `su-exec` stands in for the real one).

## a7-backup-deploy-secrets-13 (low): images are referenced by floating tags, with no version or digest pin

Status: fixed, as decision 80 states it.

What was wrong: every image was a moving tag and pnpm had no hash.

What changed: every `FROM` and `image:` goes through `NODE_IMAGE`, `POSTGRES_IMAGE` or `CADDY_IMAGE`, so a digest set in `.env` reaches the db, backup, web, worker and proxy alike; README "Updating" says how to pin, update and keep Postgres on 16. pnpm is pinned by its sha512 (from the npm registry's integrity for 10.28.0). The repository ships no digests: it cannot resolve them here (no registry access), and a pin nobody moves would freeze security fixes.

Tests: `deployStack.test.ts` "a7-backup-deploy-secrets-13: the base images come from the *_IMAGE settings, so a digest pinned in .env reaches every build" and "… every FROM names its image through an ARG, and pnpm is pinned by hash".

## a7-backup-deploy-secrets-14 (low): backups are world-readable

Status: fixed.

What changed: `umask 077` in all three scripts and `chmod 700` on the backup folders; files are 0600.

Tests: `deployScripts.test.ts` "a7-backup-deploy-secrets-14: backup files and directories are readable by their owner only".

## a7-backup-deploy-secrets-15 (low): deploy/secrets/ is not git-ignored

Status: fixed.

What changed: `.gitignore` adds `deploy/secrets/` and `deploy/backup-config/` (decision 82).

Tests: `deployStack.test.ts` "a7-backup-deploy-secrets-15: Docker secret files and the off-site copy's keys are git-ignored" (`git check-ignore`, and `.env.example` still tracked).

## a7-backup-deploy-secrets-16 (low): egress is not limited at the network level

Status: fixed.

What changed: `internal` (`internal: true`) holds db and web; the worker and backup are also on `egress`, Caddy on `edge` for its published ports; the README and the compose header say the host allowlist itself is enforced by the worker (decision 77).

Tests: `deployStack.test.ts` "a7-backup-deploy-secrets-16: db and web have no route out; only the worker, backup and the proxy's published network do". That an internal network has no route is Docker's behaviour and was not observed here (no daemon).

## a7-backup-deploy-secrets-17 (low): production starts with the .env.example placeholder secrets

Status: fixed.

What changed: with `NODE_ENV=production` the API refuses the placeholder `SESSION_SECRET` and the API and the worker refuse the database password `change-me` (from `POSTGRES_PASSWORD` or `DATABASE_URL`); `.env.example` leaves `SESSION_SECRET` empty and explains how to change the database password after the first start (decision 81).

Tests: api `config.test.ts` "… in production refuses the .env.example placeholders for SESSION_SECRET and the database password" and "… .env.example leaves SESSION_SECRET empty, so the API does not start until it is set"; worker `env.test.ts` "… in production refuses the .env.example database password"; shared `crypto.test.ts` "placeholderSecretProblem names the .env.example placeholders".

## a7-backup-deploy-secrets-18 (low): worker, proxy and backup have no healthcheck

Status: fixed (showing the backup state in Settings is left for Phase 6, decision 78).

What changed: backup `backup.sh --health` (last backup failed, nothing verified for 26 hours, or the off-site copy failing; a container that just started is healthy until its first night has passed); worker: the runner writes `WORKER_HEARTBEAT_FILE` after every pass over the queue and every job, and the healthcheck fails after 35 minutes without one; Caddy: its admin endpoint; the proxy now waits for a healthy web.

Tests: `deployScripts.test.ts` "a7-backup-deploy-secrets-18: the healthcheck fails 26 hours after the last verified backup"; worker `runner.test.ts` "worker heartbeat … > WORKER_HEARTBEAT_FILE names the file; without it there is none" and "… writes the heartbeat after each pass over the queue, and not while the database cannot be reached"; `deployStack.test.ts` "a7-backup-deploy-secrets-18: every service has a healthcheck, and the proxy waits for a healthy web". Caddy's admin endpoint answering inside the container was not observed here.

## Second round

An independent reviewer found two first-round items not done (-10 a regression, -13 incomplete) and raised three new issues. Each was checked against the spec, the plan and the code, and reproduced. -10, -13 and new issues 1 and 3 are real and fixed. New issue 2 is real for `docs/design/phase-3/prices-and-valuation.md` and fixed there; its README part had already been fixed by the a1-serve-and-guard second round (commit 4722f45), so nothing was left to do there. For -13 the fix covers Postgres and Node; Caddy stays on its major tag, for the reason below. Decisions: `docs/phase-1-plan.md`, "Decisions made during the audit", 124 to 127 (decisions 76, 77 and 80 now point to them). The README (Backups, Restore, Updating), `.env.example`, the comments in `deploy/services.yml`, `deploy/docker-compose.dev.yml`, `deploy/backup.sh` and `deploy/restore.sh`, and `docs/design/phase-3/prices-and-valuation.md` were edited to match.

Each new test was run against the code before its fix and failed: `a7r2-red-deploy.txt` in the lane's scratch directory (`laneA/`), 6 of 43 failing in `deployStack.test.ts`, `deployScripts.test.ts` and `deployConfig.test.ts`. The restore case shows the old printed command failing as the reviewer described: "Password for user root: … fe_sendauth: no password supplied". No Docker daemon runs here, so as in the first round the stack is checked as `docker compose config` renders it, and the scripts run under the local `/bin/sh` against Postgres 16.

### Second round, a7-backup-deploy-secrets-10 (regression): the development database's port could not work

Status: fixed.

What was wrong: `deploy/docker-compose.dev.yml` added `127.0.0.1:5432:5432` to db, but db's only network was `internal` (`internal: true`, from -16). Docker sets up a published port only through a network that is not internal, because an internal network gives the container no gateway. Decision 77 says the same, which is why Caddy is also on `edge`. So the development quick start (`… -f deploy/docker-compose.dev.yml up -d db`, then `pnpm db:migrate`) and the README's host-side restore would have found nothing on 127.0.0.1:5432. Rendered with the development file, db had the port and `networks: {internal}`. The -10 test checked only the port entry.

What changed: the development file also puts db on `dev`, a network of its own that no other service joins. Web and worker still reach db on `internal`. The home-server stack is unchanged: db is on `internal` only and publishes nothing (decision 125). Docker's behaviour on a running daemon was not observed here.

Tests: api `deployStack.test.ts` "a7-backup-deploy-secrets-10 (second round): the development file puts the database on a network its published port can use". Rendered with the development file, db is on `internal` and on at least one network that is not internal, and no other service is on that network. Rendered without it, db is on `internal` alone, has no port, and the stack has no such network.

### Second round, a7-backup-deploy-secrets-13 (incomplete): the defaults were still floating tags

Status: fixed for Postgres and Node. Caddy stays on its major tag (decision 124).

What was wrong: the first round routed every image through `POSTGRES_IMAGE`, `NODE_IMAGE` and `CADDY_IMAGE`, but kept `postgres:16-alpine`, `node:22-alpine` and `caddy:2-alpine` as the defaults (decision 80). The default deploy was therefore no more reproducible than before, and the item was reported as fixed anyway. The reviewer is right that an exact version tag needs no digest lookup.

What changed: the defaults are `postgres:16.15-alpine` and `node:22.23.4-alpine`, the releases the test suites run on here (`psql --version` 16.15, `node --version` v22.23.4). They are set in `deploy/services.yml` (db and backup, web and worker), in the `ARG` lines of `deploy/backup.Dockerfile`, `apps/api/Dockerfile` and `apps/worker/Dockerfile`, in `.env.example` and in the README. An update of the repository moves them, and `.env` still overrides them, with a digest for a byte-for-byte rebuild. Postgres minor releases share the storage format, so an install that ran a later 16.x reads its volume with the pin.

Caddy stays `caddy:2-alpine`. Nothing in the repository's checks runs a Caddy, and nothing here names a current Caddy release. A tag guessed from memory, if the registry lacks it, would stop every install at `up`, and none can be looked up from here (no requests outside the package registry). The major tag keeps the one service the LAN talks to on Caddy's fixes until a release is checked; `CADDY_IMAGE` pins it. No digest is shipped, for decision 80's reason.

Tests: api `deployStack.test.ts`:
- "a7-backup-deploy-secrets-13 (second round): without a setting in .env, Postgres and Node are exact releases, the same in every service" (rendered; Caddy asserted to be its major tag, so pinning it later changes the test on purpose);
- "… the default base images are exact releases, and every file names the same ones" (as text: one default per image in `services.yml`, equal to each Dockerfile's `ARG` default, and named in the README and `.env.example`).

### Second round, new issue 1 (low): the backup healthcheck stayed failed for good once BACKUP_COPY_CMD was removed

Status: fixed.

What was wrong: with `BACKUP_COPY_CMD` empty, `offsite_copy` returned before writing anything. A `status/offsite` left by an earlier failed copy therefore stayed, and `--health` kept failing with "they are tried again after the next backup", although nothing would retry them. Reproduced: one backup with a failing command exited 3, the next one without it exited 0, and `--health` still exited 1.

What changed: the healthcheck runs with the container's settings, so with `BACKUP_COPY_CMD` unset it ignores `status/offsite` and adds "no off-site copy is made (BACKUP_COPY_CMD is not set)" to its ok line. That holds from the moment the container is recreated. A backup run without the command records the state as `off`. Only a state of `failed` fails the healthcheck, so a command set again is healthy until a copy has been tried. The list of files already copied is kept, so setting the command again copies only the rest. The README's "Off the server" says how to stop copying (decision 126). The first-round -05 test now gives its health calls the same `BACKUP_COPY_CMD` as the backup, as the container does.

Tests: api `deployScripts.test.ts` "a7-backup-deploy-secrets (second round): once BACKUP_COPY_CMD is removed, a copy that failed before no longer fails the healthcheck". The sequence: a failed copy, then the healthcheck without the command (0, says no copy is made), a backup without it (`off` recorded, healthy), the command set again (healthy), and a failing copy (exit 3, all four uncopied files tried, unhealthy again).

### Second round, new issue 2 (low): documents still described the compose layout the first round replaced

Status: fixed. The README part was already fixed.

What was wrong: `docs/design/phase-3/prices-and-valuation.md` line 14 said the shared `x-app-env` (`env_file: ../.env`) delivers `.env` to web and worker, and line 565 said the shared `env_file` carries `PRICE_*` and `TIINGO_API_KEY*` to both containers. Since -07 neither is true: `deploy/services.yml` passes each setting by name. The README line the reviewer quoted ("`TRUST_PROXY` in `deploy/docker-compose.yml` must name its address") was no longer there. The a1-serve-and-guard second round (commit 4722f45, decision 114) had replaced it with "set `TRUST_PROXY` in `.env`" and a pointer to `deploy/services.yml`, and its test checks that every file the README names for `TRUST_PROXY` sets it.

What changed: both lines of `prices-and-valuation.md` keep what the design said and add, as line 596 and `seams.md` P9 already did, what `services.yml` passes since -07. Line 565 also says which container gets which price setting and that the Docker-secret file mounts the key into the worker only.

Tests: api `deployConfig.test.ts` "a7-backup-deploy-secrets (second round): no document describes the shared env_file the compose layout no longer has". `services.yml` has no `x-app-env` or `env_file`. Every line of the README, the Phase 1 to 3 plans and the Phase 2 and 3 designs that mentions `x-app-env` or a shared `env_file` also names `services.yml`. Phase 4's documents and the audit records are left out.

### Second round, new issue 3 (low): the command restore.sh printed to drop the kept database failed where the README runs it

Status: fixed.

What was wrong: after a swap, `restore.sh` printed `psql -d postgres -c 'DROP DATABASE "<db>_before_<stamp>"'`. In the backup container `PGHOST=db` is set but `PGUSER` and `PGPASSWORD` are not, so psql connects as the operating-system user and fails. The README gave no drop command either, and the kept copy takes as much disk space as the data until it is dropped.

What changed: `restore.sh --drop-kept <db>_before_<14 digits>` drops such a copy with the script's own connection settings. It needs only `POSTGRES_*` and psql, and it refuses any other name: the live database, a `_restore_` copy, `postgres` or a wrong stamp. After a swap the restore prints the command as it would run again where the restore ran. When the script is the image's `/restore.sh`, that is `docker compose -f deploy/docker-compose.yml exec backup /restore.sh --drop-kept …`; otherwise it is the script's own path. The README's Restore section shows the command and says the copy takes disk space until it is dropped. Setting `PGUSER` and `PGPASSWORD` on the backup service was the other choice. It would put the password in the container's environment a second time and still leave a hand-typed `DROP DATABASE` that a typo can aim at the live database (decision 127).

Tests: api `deployScripts.test.ts` "a7-backup-deploy-secrets (second round): the command a restore prints to drop the database it replaced works where the restore ran":
- the environment is the backup container's (PGHOST, PGPORT and `POSTGRES_*`, no PGUSER or PGPASSWORD);
- run from its path, the printed command is run as printed and drops the kept copy, and the live database keeps its data;
- run as `/restore.sh` (through `sh -c '. file'`, so `$0` is the image's path without writing to `/`), the printed line is the README's `docker compose … exec backup /restore.sh --drop-kept <name>`, which the README contains, and that command drops the copy;
- every other name is refused, and a name of the right form that does not exist is refused too.

Checks:
- `pnpm typecheck` and `pnpm lint` pass.
- Suites of the packages touched, with TEST_DATABASE_PREFIX `meridian_fix_a_`: api 46 files, 373 tests; worker (its Dockerfile changed) 15 files, 129 tests.
- `pnpm build` passes. No web code changed, so no browser check was needed.
- Green outputs: `a7r2-green-api.txt` and `a7r2-green-worker.txt` in `laneA/`.
