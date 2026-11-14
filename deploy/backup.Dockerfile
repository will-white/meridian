# The backup sidecar: the Postgres image (pg_dump and psql of the server's major version) plus
# what backup.sh, restore.sh and restore-check.sh need that it lacks.
ARG POSTGRES_IMAGE=postgres:16-alpine
FROM ${POSTGRES_IMAGE}
# openssl encrypts the dumps; rclone and openssh-client (ssh, scp) carry the off-site copy
# (BACKUP_COPY_CMD); su-exec lets backup.sh start as root to hand /backups to postgres, then drop.
RUN apk add --no-cache openssl rclone openssh-client su-exec \
  && for tool in openssl rclone ssh scp su-exec pg_dump psql gzip; do command -v "$tool" > /dev/null || { echo "missing $tool" >&2; exit 1; }; done
COPY --chmod=0755 backup.sh restore.sh restore-check.sh /
ENV BACKUP_ROOT=/backups \
    BACKUP_RUN_AS=postgres \
    PGHOST=db \
    RCLONE_CONFIG=/backup-config/rclone.conf
ENTRYPOINT ["/bin/sh", "/backup.sh"]
CMD ["--nightly"]
