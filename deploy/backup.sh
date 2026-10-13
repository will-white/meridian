#!/bin/sh
# Encrypted pg_dump backups for Meridian.
#
#   backup.sh            run one backup now
#   backup.sh --nightly  loop forever: back up once a day at BACKUP_HOUR (UTC, default 02:00)
#
# Retention: 30 daily copies in /backups/daily and 12 monthly copies in /backups/monthly
# (the first backup of each month is promoted). Files are gzip + AES-256-CBC (PBKDF2)
# encrypted with BACKUP_PASSPHRASE. The encryption key for SimpleFIN secrets (SECRETS_KEY)
# is never part of a backup: keep it with the passphrase, off this server.
#
# Off-site copy: set BACKUP_COPY_CMD to a command that receives the file path as $1,
# for example `rclone copy "$1" remote:meridian-backups`. It runs after each backup.
#
# Restore: see restore.sh.
set -eu
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE must be set}"
: "${POSTGRES_USER:?}" "${POSTGRES_PASSWORD:?}" "${POSTGRES_DB:?}"
PGHOST="${PGHOST:-db}"
ROOT="${BACKUP_ROOT:-/backups}"
DAILY_KEEP="${BACKUP_DAILY_KEEP:-30}"
MONTHLY_KEEP="${BACKUP_MONTHLY_KEEP:-12}"

run_backup() {
  mkdir -p "$ROOT/daily" "$ROOT/monthly"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  month=$(date -u +%Y%m)
  out="$ROOT/daily/meridian-${stamp}.sql.gz.enc"
  tmp="${out}.part"
  PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h "$PGHOST" -U "$POSTGRES_USER" "$POSTGRES_DB" --no-owner --no-privileges \
    | gzip -9 \
    | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$tmp"
  mv "$tmp" "$out"
  echo "[backup] wrote $out ($(du -h "$out" | cut -f1))"

  # Promote the first backup of the month.
  if [ -z "$(find "$ROOT/monthly" -name "meridian-${month}*.enc" 2>/dev/null | head -n1)" ]; then
    cp "$out" "$ROOT/monthly/"
    echo "[backup] promoted to monthly"
  fi

  # Prune by count, oldest first.
  prune "$ROOT/daily" "$DAILY_KEEP"
  prune "$ROOT/monthly" "$MONTHLY_KEEP"

  if [ -n "${BACKUP_COPY_CMD:-}" ]; then
    sh -c "$BACKUP_COPY_CMD" copy "$out" && echo "[backup] off-site copy done" || echo "[backup] off-site copy FAILED" >&2
  fi
}

prune() {
  dir="$1"; keep="$2"
  ls -1 "$dir"/meridian-*.enc 2>/dev/null | sort | head -n -"$keep" | while read -r f; do
    rm -f "$f" && echo "[backup] pruned $f"
  done
}

if [ "${1:-}" = "--nightly" ]; then
  hour="${BACKUP_HOUR:-2}"
  echo "[backup] nightly mode: daily at ${hour}:00 UTC, keeping ${DAILY_KEEP} daily and ${MONTHLY_KEEP} monthly"
  while true; do
    now=$(date -u +%s)
    target=$(date -u -d "$(date -u +%Y-%m-%d) ${hour}:00:00" +%s 2>/dev/null || date -u -j -f "%Y-%m-%d %H:%M:%S" "$(date -u +%Y-%m-%d) ${hour}:00:00" +%s)
    [ "$target" -le "$now" ] && target=$((target + 86400))
    sleep $((target - now))
    run_backup || echo "[backup] FAILED" >&2
  done
else
  run_backup
fi
