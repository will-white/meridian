#!/bin/sh
# Encrypted pg_dump backups for Meridian (the `backup` service runs this; see deploy/backup.Dockerfile).
#
#   backup.sh            make one backup now; exit 0 only when it was written, read back and verified
#   backup.sh --nightly  loop: one backup a day at BACKUP_HOUR (UTC, default 2), each in its own process
#   backup.sh --health   the container's healthcheck: fails when the last backup failed, when no
#                        verified backup was made for BACKUP_HEALTH_MAX_AGE_HOURS (26), or when the
#                        off-site copy is failing
#
# A backup counts only after the dump is complete: pg_dump, gzip and openssl must each succeed,
# and the encrypted file must decrypt, gunzip and end with pg_dump's "dump complete" line. A
# failed backup leaves no file, promotes nothing and prunes nothing, so good copies are never
# pushed out by bad ones.
#
# Retention: 30 daily copies in $BACKUP_ROOT/daily and 12 monthly copies in $BACKUP_ROOT/monthly
# (the first verified backup of each month is promoted). Files are gzip + AES-256-CBC (PBKDF2,
# 200,000 iterations) encrypted with BACKUP_PASSPHRASE, readable by their owner only. The key
# for the app's own secrets (SECRETS_KEY) is never part of a backup: keep it with the
# passphrase, off this server.
#
# Off-site copy: BACKUP_COPY_CMD is run once for every backup file (daily and monthly) that has
# not been copied yet, with the file's path as $1 and its folder (daily or monthly) as $2, e.g.
#   rclone copy "$1" "offsite:meridian-backups/$2"
#   scp -i /backup-config/id_ed25519 -o UserKnownHostsFile=/backup-config/known_hosts "$1" me@nas:meridian-backups/$2/
# A file whose copy failed is tried again after the next backup; until then the healthcheck fails.
#
# Status: $BACKUP_ROOT/status holds last-success, last-failure, offsite and restore-check.
# Restore: see restore.sh; prove a backup restores: restore-check.sh.
set -u
umask 077

ROOT="${BACKUP_ROOT:-/backups}"
STATUS="$ROOT/status"
PGHOST="${PGHOST:-db}"
PGPORT="${PGPORT:-5432}"
DAILY_KEEP="${BACKUP_DAILY_KEEP:-30}"
MONTHLY_KEEP="${BACKUP_MONTHLY_KEEP:-12}"
mode="${1:-}"

log() { echo "[backup] $*"; }
warn() { echo "[backup] $*" >&2; }

now_epoch() { date -u +%s; }

# The first field of a status file (an epoch), or 0 when there is none.
status_epoch() {
  if [ -f "$STATUS/$1" ]; then
    v=$(cut -d' ' -f1 < "$STATUS/$1" 2>/dev/null)
    case "$v" in '' | *[!0-9]*) echo 0 ;; *) echo "$v" ;; esac
  else
    echo 0
  fi
}

record() { # file, text
  mkdir -p "$STATUS" 2>/dev/null && printf '%s %s\n' "$(now_epoch)" "$2" > "$STATUS/$1.tmp" && mv "$STATUS/$1.tmp" "$STATUS/$1"
}

fail() {
  warn "FAILED: $*"
  record last-failure "$*" || warn "could not record the failure under $STATUS"
  return 1
}

health() {
  now=$(now_epoch)
  max_hours="${BACKUP_HEALTH_MAX_AGE_HOURS:-26}"
  ok_at=$(status_epoch last-success)
  failed_at=$(status_epoch last-failure)
  started=$(status_epoch started)
  if [ "$failed_at" -gt "$ok_at" ]; then
    echo "the last backup failed: $(cut -d' ' -f2- < "$STATUS/last-failure")"
    return 1
  fi
  since="$ok_at"
  [ "$started" -gt "$since" ] && since="$started"
  if [ $((now - since)) -gt $((max_hours * 3600)) ]; then
    if [ "$ok_at" -eq 0 ]; then echo "no verified backup yet"; else echo "no verified backup for over ${max_hours} hours"; fi
    return 1
  fi
  if [ -f "$STATUS/offsite" ] && [ "$(cut -d' ' -f2 < "$STATUS/offsite")" != "ok" ]; then
    echo "the off-site copy is failing: $(cut -d' ' -f2- < "$STATUS/offsite")"
    return 1
  fi
  if [ "$ok_at" -eq 0 ]; then echo "ok: waiting for the first nightly backup"; else echo "ok: $(cut -d' ' -f2- < "$STATUS/last-success")"; fi
  return 0
}

require_tools() {
  missing=""
  for tool in "$@"; do
    command -v "$tool" > /dev/null 2>&1 || missing="$missing $tool"
  done
  if [ -n "$missing" ]; then
    fail "missing tools:$missing (the backup image installs them; see deploy/backup.Dockerfile)"
    return 1
  fi
}

require_settings() {
  for name in BACKUP_PASSPHRASE POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB; do
    eval "value=\${$name:-}"
    if [ -z "$value" ]; then
      fail "$name must be set"
      return 1
    fi
  done
}

# Decrypt, gunzip and look for pg_dump's closing line; any failing stage fails the check.
verify_backup() {
  vfile="$1"
  verrs="$STATUS/.verify.$$"
  : > "$verrs" || return 1
  end=$( { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$vfile" || echo "decrypt exited $?" >> "$verrs"; } \
    | { gzip -dc || echo "gunzip exited $?" >> "$verrs"; } \
    | tail -n 20)
  problems=$(tr '\n' ' ' < "$verrs"); rm -f "$verrs"
  if [ -n "$problems" ]; then
    echo "$problems"
    return 1
  fi
  if ! printf '%s\n' "$end" | grep -qx -- '-- PostgreSQL database dump complete'; then
    echo "the dump has no end marker (incomplete)"
    return 1
  fi
}

# The oldest files beyond the newest $2 in directory $1.
prune() {
  dir="$1"; keep="$2"
  ls -1 "$dir" 2>/dev/null | grep '^meridian-.*\.enc$' | sort | awk -v keep="$keep" '{ f[NR] = $0 } END { for (i = 1; i <= NR - keep; i++) print f[i] }' \
    | while read -r name; do
      rm -f "$dir/$name" && log "pruned $dir/$name"
    done
}

offsite_copy() {
  [ -n "${BACKUP_COPY_CMD:-}" ] || return 0
  list="$STATUS/offsite-copied"
  touch "$list" || return 1
  failed=0
  for f in "$ROOT"/daily/meridian-*.enc "$ROOT"/monthly/meridian-*.enc; do
    [ -f "$f" ] || continue
    rel="${f#"$ROOT"/}"
    grep -qxF -- "$rel" "$list" && continue
    if sh -c "$BACKUP_COPY_CMD" copy "$f" "${rel%%/*}"; then
      echo "$rel" >> "$list"
      log "copied $rel off the server"
    else
      failed=$((failed + 1))
      warn "off-site copy of $rel FAILED"
    fi
  done
  # Forget pruned files so the list stays the size of the backup set.
  kept="$list.tmp"
  : > "$kept"
  while read -r rel; do
    [ -f "$ROOT/$rel" ] && echo "$rel" >> "$kept"
  done < "$list"
  mv "$kept" "$list"
  if [ "$failed" -gt 0 ]; then
    record offsite "failed $failed file(s) not copied; BACKUP_COPY_CMD failed (they are tried again after the next backup)"
    return 1
  fi
  record offsite "ok"
}

run_backup() {
  require_settings || return 1
  require_tools pg_dump gzip openssl || return 1
  for d in "$ROOT" "$ROOT/daily" "$ROOT/monthly" "$STATUS"; do
    mkdir -p "$d" && chmod 700 "$d" || { fail "cannot create $d"; return 1; }
  done
  # Files are named to the second; a second backup within the same second waits for the next.
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  while [ -e "$ROOT/daily/meridian-${stamp}.sql.gz.enc" ] || [ -e "$ROOT/daily/meridian-${stamp}.sql.gz.enc.part" ]; do
    sleep 1
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
  done
  month=$(date -u +%Y%m)
  out="$ROOT/daily/meridian-${stamp}.sql.gz.enc"
  tmp="$out.part"
  errs="$STATUS/.pipeline.$$"
  : > "$errs" || { fail "cannot write under $STATUS"; return 1; }
  { PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h "$PGHOST" -p "$PGPORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges || echo "pg_dump exited $?" >> "$errs"; } \
    | { gzip -9 || echo "gzip exited $?" >> "$errs"; } \
    | { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$tmp" || echo "openssl exited $?" >> "$errs"; }
  problems=$(tr '\n' ' ' < "$errs"); rm -f "$errs"
  if [ -n "$problems" ]; then
    rm -f "$tmp"
    fail "the dump did not complete: ${problems% }; no backup was written"
    return 1
  fi
  if ! why=$(verify_backup "$tmp"); then
    rm -f "$tmp"
    fail "the new backup does not read back: $why; no backup was written"
    return 1
  fi
  mv "$tmp" "$out" || { rm -f "$tmp"; fail "cannot move the backup into place"; return 1; }
  log "wrote and verified $out ($(du -h "$out" | cut -f1))"

  # Promote the first verified backup of the month.
  if ! ls -1 "$ROOT/monthly" 2>/dev/null | grep -q "^meridian-${month}.*\.enc$"; then
    cp "$out" "$ROOT/monthly/" || { fail "cannot copy $out to $ROOT/monthly"; return 1; }
    log "promoted to monthly"
  fi
  prune "$ROOT/daily" "$DAILY_KEEP"
  prune "$ROOT/monthly" "$MONTHLY_KEEP"
  record last-success "$(basename "$out")"

  offsite_copy || return 3
  return 0
}

# Started as root in the container: hand the backup directory to BACKUP_RUN_AS and drop to it.
if [ "$mode" != "--health" ] && [ -n "${BACKUP_RUN_AS:-}" ] && [ "$(id -u)" = "0" ]; then
  mkdir -p "$ROOT" && chown -R "$BACKUP_RUN_AS:$(id -g "$BACKUP_RUN_AS")" "$ROOT" && chmod 700 "$ROOT" || { warn "cannot hand $ROOT to $BACKUP_RUN_AS"; exit 1; }
  exec su-exec "$BACKUP_RUN_AS" /bin/sh "$0" "$@"
fi

case "$mode" in
  --health)
    health
    exit $?
    ;;
  --nightly)
    hour="${BACKUP_HOUR:-2}"
    case "$hour" in '' | *[!0-9]*) warn "BACKUP_HOUR must be an hour 0 to 23, not \"$hour\""; exit 2 ;; esac
    [ "$hour" -le 23 ] || { warn "BACKUP_HOUR must be an hour 0 to 23, not \"$hour\""; exit 2; }
    # Refuse to start (the container restarts and shows it) rather than loop on a setup that cannot work.
    require_settings || exit 1
    require_tools pg_dump gzip openssl || exit 1
    mkdir -p "$STATUS" && chmod 700 "$ROOT" "$STATUS" || { warn "cannot create $STATUS"; exit 1; }
    record started "nightly mode" || exit 1
    log "nightly mode: daily at ${hour}:00 UTC, keeping ${DAILY_KEEP} daily and ${MONTHLY_KEEP} monthly"
    while true; do
      now=$(now_epoch)
      target=$(date -u -d "$(date -u +%Y-%m-%d) ${hour}:00:00" +%s)
      [ "$target" -le "$now" ] && target=$((target + 86400))
      sleep $((target - now))
      # Each backup is its own process, so nothing a failed step leaves behind reaches the next night.
      sh "$0"
      code=$?
      [ "$code" -eq 0 ] || warn "backup exited $code"
    done
    ;;
  '')
    run_backup
    exit $?
    ;;
  *)
    warn "usage: backup.sh [--nightly | --health]"
    exit 2
    ;;
esac
