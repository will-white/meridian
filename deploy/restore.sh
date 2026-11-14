#!/bin/sh
# Restore an encrypted Meridian backup (made by backup.sh).
#
#   restore.sh [--yes] <backup.sql.gz.enc>                  replace the app's database (POSTGRES_DB)
#   restore.sh --target-db <name> <backup.sql.gz.enc>       restore into a new database <name>; nothing else is touched
#   restore.sh --check <backup.sql.gz.enc>                  restore into a throwaway database, report what it holds, drop it
#
# On the server, run it in the backup container, which has the tools, the settings and the
# database's network (the backups are under /backups there):
#   docker compose -f deploy/docker-compose.yml stop web worker
#   docker compose -f deploy/docker-compose.yml exec backup /restore.sh /backups/daily/meridian-20261013T020000Z.sql.gz.enc
#   docker compose -f deploy/docker-compose.yml start web worker
#
# Nothing is dropped or replaced until the backup has been decrypted and read to its end. The
# backup is then restored into a new database in one transaction that stops at the first error;
# only when that worked (and the restored database has the app's migrations) is the current
# database renamed to <db>_before_<stamp> and the restored one renamed into its place. The old
# one is kept until you drop it. Replacing asks you to type the database name, unless --yes.
#
# Settings: BACKUP_PASSPHRASE, POSTGRES_USER, POSTGRES_PASSWORD and POSTGRES_DB come from the
# environment; any of them that is not set is read from the .env file at the repository root
# (found from this script's location, or MERIDIAN_ENV_FILE). The file is read, never executed.
# PGHOST (default 127.0.0.1, `db` in the container) and PGPORT (5432) say where Postgres is.
set -u
umask 077

say() { echo "[restore] $*"; }
die() { echo "[restore] FAILED: $*" >&2; exit 1; }

target_db=""
assume_yes=0
check=0
file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target-db) [ $# -ge 2 ] || die "--target-db needs a database name"; target_db="$2"; shift 2 ;;
    --target-db=*) target_db="${1#--target-db=}"; shift ;;
    --yes | -y) assume_yes=1; shift ;;
    --check) check=1; shift ;;
    -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) [ -z "$file" ] || die "one backup file at a time"; file="$1"; shift ;;
  esac
done
[ -n "$file" ] || { sed -n '2,6p' "$0" >&2; exit 2; }
[ -f "$file" ] && [ -r "$file" ] || die "cannot read $file"

# KEY=VALUE from the .env file, without running it: quotes are removed, an inline " #" comment
# after an unquoted value is dropped, and the last line for a key wins (as Docker Compose reads it).
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
env_file="${MERIDIAN_ENV_FILE:-$script_dir/../.env}"
env_value() {
  line=$(grep -E "^[[:space:]]*$1[[:space:]]*=" "$env_file" 2>/dev/null | tail -n 1) || return 1
  [ -n "$line" ] || return 1
  value=$(printf '%s' "${line#*=}" | tr -d '\r' | sed -e 's/^[[:space:]]*//')
  case "$value" in
    \"*\"*) value=${value#\"}; value=${value%%\"*} ;;
    \'*\'*) value=${value#\'}; value=${value%%\'*} ;;
    *) value=$(printf '%s' "$value" | sed -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//') ;;
  esac
  printf '%s' "$value"
}
for key in BACKUP_PASSPHRASE POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB; do
  eval "is_set=\${$key+set}"
  if [ -z "$is_set" ] && [ -f "$env_file" ]; then
    if value=$(env_value "$key"); then export "$key=$value"; fi
  fi
done
for key in BACKUP_PASSPHRASE POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB; do
  eval "value=\${$key:-}"
  [ -n "$value" ] || die "$key is not set (in the environment or $env_file)"
done
export BACKUP_PASSPHRASE
export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="$POSTGRES_USER"
export PGPASSWORD="$POSTGRES_PASSWORD"

for tool in psql openssl gzip; do
  command -v "$tool" > /dev/null 2>&1 || die "$tool is not installed here (run this in the backup container: see the top of this script)"
done

valid_name() {
  case "$1" in '' | [!A-Za-z_]* | *[!A-Za-z0-9_]*) return 1 ;; esac
  [ "${#1}" -le 63 ]
}
stamp=$(date -u +%Y%m%d%H%M%S)
[ "$check" = 1 ] && [ -z "$target_db" ] && target_db="${RESTORE_CHECK_PREFIX:-meridian_restorecheck_}${stamp}"
if [ -n "$target_db" ]; then
  valid_name "$target_db" || die "the target database name may use letters, digits and _ only (at most 63)"
  staging="$target_db"
else
  valid_name "$POSTGRES_DB" || die "POSTGRES_DB may use letters, digits and _ only for a restore"
  staging="${POSTGRES_DB}_restore_${stamp}"
  previous="${POSTGRES_DB}_before_${stamp}"
  valid_name "$previous" || die "POSTGRES_DB is too long to keep the current database beside the restored one"
fi

work=$(mktemp -d) || die "cannot create a temporary directory"
trap 'rm -rf "$work"' EXIT
psql_admin() { psql -X -q -v ON_ERROR_STOP=1 -d postgres "$@"; }
db_exists() { [ "$(psql_admin -Atc "select 1 from pg_database where datname = '$1'")" = "1" ]; }

decrypt_stream() {
  { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$file" || echo "decrypt exited $? (wrong BACKUP_PASSPHRASE, or a damaged file)" >> "$work/errors"; } \
    | { gzip -dc || echo "gunzip exited $? (the file is damaged or cut short)" >> "$work/errors"; }
}
problems() { tr '\n' ' ' < "$work/errors"; }

# 1. Read the whole backup before touching anything.
: > "$work/errors"
end=$(decrypt_stream | tail -n 20)
[ -z "$(problems)" ] || die "$file does not read back: $(problems)- nothing was changed"
printf '%s\n' "$end" | grep -qx -- '-- PostgreSQL database dump complete' || die "$file is not a complete dump (no end marker) - nothing was changed"
psql_admin -Atc "select 1" > /dev/null || die "cannot reach Postgres at $PGHOST:$PGPORT as $POSTGRES_USER - nothing was changed"

if [ -z "$target_db" ]; then
  db_exists "$POSTGRES_DB" && replacing=1 || replacing=0
  if [ "$replacing" = 1 ] && [ "$assume_yes" != 1 ]; then
    if [ -t 0 ]; then
      printf 'This replaces the database "%s" on %s with %s.\nThe current one is kept as "%s". Type the database name to go on: ' "$POSTGRES_DB" "$PGHOST" "$file" "$previous"
      read -r answer || answer=""
      [ "$answer" = "$POSTGRES_DB" ] || die "not confirmed - nothing was changed"
    else
      die "replacing \"$POSTGRES_DB\" needs --yes when there is no terminal - nothing was changed"
    fi
  fi
fi
db_exists "$staging" && die "the database \"$staging\" already exists - nothing was changed"

# 2. Restore into a new database, in one transaction that stops at the first error.
say "restoring $file into a new database \"$staging\" on $PGHOST"
psql_admin -c "CREATE DATABASE \"$staging\"" || die "cannot create the database \"$staging\""
: > "$work/errors"
decrypt_stream | psql -X -q -v ON_ERROR_STOP=1 --single-transaction -d "$staging" > "$work/psql.out" 2>&1 || echo "psql exited $?" >> "$work/errors"
if [ -n "$(problems)" ]; then
  tail -n 5 "$work/psql.out" >&2
  psql_admin -c "DROP DATABASE IF EXISTS \"$staging\"" > /dev/null 2>&1
  die "the restore did not complete: $(problems)- the new database was dropped and nothing else was changed"
fi
contents=$(psql -X -Atq -F ' ' -d "$staging" -c "select
  (select count(*) from drizzle.__drizzle_migrations),
  (select count(*) from information_schema.tables where table_schema = 'public'),
  (select count(*) from \"user\"),
  (select count(*) from account),
  (select count(*) from \"transaction\")" 2>/dev/null)
set -- $contents
if [ $# -ne 5 ] || [ "$1" = 0 ]; then
  psql_admin -c "DROP DATABASE IF EXISTS \"$staging\"" > /dev/null 2>&1
  die "the restored database lacks the app's migrations or tables; this is not a Meridian backup - nothing else was changed"
fi
summary="$1 migrations, $2 tables, $3 members, $4 accounts, $5 transactions"

if [ "$check" = 1 ]; then
  psql_admin -c "DROP DATABASE \"$staging\"" > /dev/null || say "could not drop \"$staging\"; drop it by hand"
  say "Restore check passed: $file restored completely ($summary)."
  exit 0
fi
if [ -n "$target_db" ]; then
  say "Restore complete: \"$target_db\" holds $file ($summary)."
  exit 0
fi

# 3. Swap: the current database is kept under another name, the restored one takes its place.
if [ "$replacing" = 1 ]; then
  psql_admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$POSTGRES_DB' AND pid <> pg_backend_pid()" > /dev/null
  psql_admin -c "ALTER DATABASE \"$POSTGRES_DB\" RENAME TO \"$previous\"" \
    || die "cannot rename \"$POSTGRES_DB\" (still in use? stop web and worker first); the restored copy is in \"$staging\""
fi
if ! psql_admin -c "ALTER DATABASE \"$staging\" RENAME TO \"$POSTGRES_DB\""; then
  [ "$replacing" = 1 ] && psql_admin -c "ALTER DATABASE \"$previous\" RENAME TO \"$POSTGRES_DB\""
  die "cannot rename \"$staging\" to \"$POSTGRES_DB\"; the current database is unchanged and the restored copy is in \"$staging\""
fi
say "Restore complete: \"$POSTGRES_DB\" now holds $file ($summary)."
if [ "$replacing" = 1 ]; then
  say "The database it replaced is kept as \"$previous\". When the app works, drop it:"
  say "  psql -d postgres -c 'DROP DATABASE \"$previous\"'"
fi
