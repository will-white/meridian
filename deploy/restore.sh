#!/bin/sh
# Restore an encrypted backup into the running db container (or any Postgres).
#
#   deploy/restore.sh deploy/backups/daily/meridian-20261013T020000Z.sql.gz.enc
#
# Reads BACKUP_PASSPHRASE, POSTGRES_* from ../.env unless already set. The target
# database is dropped and recreated, so stop web and worker first:
#   docker compose -f deploy/docker-compose.yml stop web worker
set -eu
file="${1:?usage: restore.sh <backup.sql.gz.enc>}"
[ -f ../.env ] && { set -a; . ../.env; set +a; }
: "${BACKUP_PASSPHRASE:?}" "${POSTGRES_USER:?}" "${POSTGRES_PASSWORD:?}" "${POSTGRES_DB:?}"
PGHOST="${PGHOST:-127.0.0.1}"
export PGPASSWORD="$POSTGRES_PASSWORD"
echo "Restoring $file into $POSTGRES_DB on $PGHOST (this drops the current database)."
psql -h "$PGHOST" -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\" WITH (FORCE)"
psql -h "$PGHOST" -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE \"$POSTGRES_DB\""
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$file" | gunzip | psql -h "$PGHOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q
echo "Restore complete."
