#!/usr/bin/env bash
# pg_dump -> gzip -> age-encrypt. Exits non-zero on any failure — a silent
# backup failure is worse than no backup, so this script must be run
# somewhere its exit code is actually watched (cron + logging, at minimum).
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is required}"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETAIN_DAYS="${RETAIN_DAYS:-30}"

timestamp="$(date +%Y%m%d-%H%M%S)"
out="${BACKUP_DIR}/budget-${timestamp}.sql.gz.age"

mkdir -p "$BACKUP_DIR"

pg_dump "$DATABASE_URL" | gzip | age -r "$BACKUP_AGE_RECIPIENT" -o "$out"

echo "Backup written: $out"

find "$BACKUP_DIR" -maxdepth 1 -name 'budget-*.sql.gz.age' -mtime +"$RETAIN_DAYS" -print -delete

echo "Retention: keeping the last ${RETAIN_DAYS} day(s) of backups in ${BACKUP_DIR}."
