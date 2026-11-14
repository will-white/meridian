#!/bin/sh
# Restore an encrypted Meridian backup (made by backup.sh).
#
#   restore.sh [--yes] <backup.sql.gz.enc>                  replace the app's database (POSTGRES_DB)
#   restore.sh --target-db <name> <backup.sql.gz.enc>       restore into a new database <name>; nothing else is touched
#   restore.sh --check <backup.sql.gz.enc>                  restore into a throwaway database, report what it holds, drop it
#   restore.sh --drop-kept <db>_before_<time>               drop the database a restore replaced and kept
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
# one is kept, taking its disk space, until you drop it with --drop-kept (the restore prints the
# command), which drops nothing but such a copy. Replacing asks you to type the database name,
# unless --yes.
#
# Settings: BACKUP_PASSPHRASE, POSTGRES_USER, POSTGRES_PASSWORD and POSTGRES_DB come from the
# environment; any of them that is not set is read from the .env file at the repository root
# (found from this script's location, or MERIDIAN_ENV_FILE). The file is read, never executed.
# PGHOST (default 127.0.0.1, `db` in the container) and PGPORT (5432) say where Postgres is.
set -u
umask 077

say() { echo "[restore] $*"; }
die() { echo "[restore] FAILED: $*" >&2; exit 1; }

# The comment block above: all of it for --help, the usage lines when no backup file is given.
header() { awk 'NR > 1 && /^#/ { print; next } NR > 1 { exit }' "$0"; }
usage() { header | awk '/restore\.sh / { seen = 1; print; next } seen { exit } { print }' >&2; }

target_db=""
assume_yes=0
check=0
drop_kept=""
file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target-db) [ $# -ge 2 ] || die "--target-db needs a database name"; target_db="$2"; shift 2 ;;
    --target-db=*) target_db="${1#--target-db=}"; shift ;;
    --yes | -y) assume_yes=1; shift ;;
    --check) check=1; shift ;;
    --drop-kept) [ $# -ge 2 ] || die "--drop-kept needs the name of the database a restore kept"; drop_kept="$2"; shift 2 ;;
    --drop-kept=*) drop_kept="${1#--drop-kept=}"; shift ;;
    -h | --help) header; exit 0 ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) [ -z "$file" ] || die "one backup file at a time"; file="$1"; shift ;;
  esac
done
if [ -n "$drop_kept" ]; then
  [ -z "$file" ] && [ -z "$target_db" ] && [ "$check" = 0 ] || die "--drop-kept takes the name of a database and nothing else"
  needed="POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB"
  tools="psql"
else
  [ -n "$file" ] || { usage; exit 2; }
  [ -f "$file" ] && [ -r "$file" ] || die "cannot read $file"
  needed="BACKUP_PASSPHRASE POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB"
  tools="psql openssl gzip"
fi

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
for key in $needed; do
  eval "value=\${$key:-}"
  [ -n "$value" ] || die "$key is not set (in the environment or $env_file)"
done
export BACKUP_PASSPHRASE
export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="$POSTGRES_USER"
export PGPASSWORD="$POSTGRES_PASSWORD"

for tool in $tools; do
  command -v "$tool" > /dev/null 2>&1 || die "$tool is not installed here (run this in the backup container: see the top of this script)"
done

valid_name() {
  case "$1" in '' | [!A-Za-z_]* | *[!A-Za-z0-9_]*) return 1 ;; esac
  [ "${#1}" -le 63 ]
}
psql_admin() { psql -X -q -v ON_ERROR_STOP=1 -d postgres "$@"; }
db_exists() { [ "$(psql_admin -Atc "select 1 from pg_database where datname = '$1'")" = "1" ]; }

# This script, as it would be run again where it runs now. The backup image has it at
# /restore.sh, and the README runs it there through compose from the repository's root.
this_script() {
  if [ "$0" = /restore.sh ]; then echo "docker compose -f deploy/docker-compose.yml exec backup /restore.sh"; else echo "$0"; fi
}

# Drop a database an earlier restore kept (<db>_before_<14 digits>), and nothing else.
if [ -n "$drop_kept" ]; then
  case "$drop_kept" in
    "${POSTGRES_DB}_before_"[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) die "--drop-kept drops only a database a restore kept (\"${POSTGRES_DB}_before_<time>\"), not \"$drop_kept\"" ;;
  esac
  valid_name "$drop_kept" || die "\"$drop_kept\" is not a database name a restore makes"
  psql_admin -Atc "select 1" > /dev/null || die "cannot reach Postgres at $PGHOST:$PGPORT as $POSTGRES_USER - nothing was dropped"
  db_exists "$drop_kept" || die "there is no database \"$drop_kept\" on $PGHOST (already dropped?)"
  psql_admin -c "DROP DATABASE \"$drop_kept\"" > /dev/null || die "cannot drop \"$drop_kept\" (is something connected to it?)"
  say "dropped \"$drop_kept\", the copy a restore kept; \"$POSTGRES_DB\" is untouched."
  exit 0
fi

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
  say "The database it replaced is kept as \"$previous\" and takes disk space until it is dropped. When the app works, drop it:"
  say "  $(this_script) --drop-kept $previous"
fi
