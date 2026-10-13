#!/bin/sh
# Nightly encrypted pg_dump. Keeps 30 daily + 12 monthly copies.
# Phase 1 TODO: add the monthly roll-up and an automated restore test.
set -eu
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE must be set}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="/backups/meridian-${STAMP}.sql.gz.enc"
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h db -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_PASSPHRASE -out "$OUT"
echo "backup written: $OUT"
# prune daily backups older than 30 days
find /backups -name 'meridian-*.enc' -mtime +30 -delete
