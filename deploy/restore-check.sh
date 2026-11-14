#!/bin/sh
# Prove that a backup restores: restore.sh --check decrypts it, restores it into a throwaway
# database on the same server, checks that it holds the app's schema and drops it again. The
# live database is not touched.
#
#   restore-check.sh [backup.sql.gz.enc]     default: the newest file in $BACKUP_ROOT/daily
#
# On the server (in the backup container):
#   docker compose -f deploy/docker-compose.yml exec backup /restore-check.sh
#
# The result is written to $BACKUP_ROOT/status/restore-check ("<epoch> ok ..." or
# "<epoch> failed ..."), and the exit status is 0 only when the restore worked. Run it once a
# month; running it on a schedule is Phase 6 work (spec: restore-test automation).
set -u
umask 077

ROOT="${BACKUP_ROOT:-/backups}"
STATUS="$ROOT/status"
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

record() {
  mkdir -p "$STATUS" 2>/dev/null && printf '%s %s\n' "$(date -u +%s)" "$1" > "$STATUS/restore-check.tmp" && mv "$STATUS/restore-check.tmp" "$STATUS/restore-check"
}

file="${1:-}"
if [ -z "$file" ]; then
  newest=$(ls -1 "$ROOT/daily" 2>/dev/null | grep '^meridian-.*\.enc$' | sort | tail -n 1)
  if [ -z "$newest" ]; then
    echo "[restore-check] FAILED: no backup in $ROOT/daily" >&2
    record "failed no backup in $ROOT/daily"
    exit 1
  fi
  file="$ROOT/daily/$newest"
fi

out=$(sh "$here/restore.sh" --check "$file" 2>&1)
code=$?
printf '%s\n' "$out"
if [ "$code" -ne 0 ]; then
  why=$(printf '%s\n' "$out" | grep 'FAILED: ' | tail -n 1 | sed 's/^.*FAILED: //')
  record "failed $(basename "$file"): ${why:-restore.sh exited $code}"
  exit 1
fi
record "ok $(basename "$file") $(printf '%s\n' "$out" | grep 'Restore check passed' | tail -n 1 | sed 's/^.* restored completely //')"
