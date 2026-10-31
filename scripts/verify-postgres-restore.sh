#!/usr/bin/env bash
set -euo pipefail

: "${RESTORE_TEST_DATABASE_URL:?Set RESTORE_TEST_DATABASE_URL to a disposable, empty PostgreSQL database.}"
: "${BACKUP_FILE:?Set BACKUP_FILE to a pg_dump custom-format backup file.}"

if [[ ! -f "$BACKUP_FILE" || ! -s "$BACKUP_FILE" ]]; then
  echo "Backup file is missing or empty: $BACKUP_FILE" >&2
  exit 2
fi
command -v pg_restore >/dev/null || { echo 'pg_restore is required.' >&2; exit 2; }
command -v psql >/dev/null || { echo 'psql is required.' >&2; exit 2; }

# Validate the archive before connecting to the restore target.
pg_restore --list "$BACKUP_FILE" >/dev/null

# Never drop or clean an existing database. Require an empty target instead.
existing=$(psql "$RESTORE_TEST_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -c "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='public'")
if [[ "$existing" != "0" ]]; then
  echo "Restore target is not empty ($existing public tables found). Use a newly created disposable database." >&2
  exit 3
fi

pg_restore --no-owner --no-privileges --exit-on-error --dbname="$RESTORE_TEST_DATABASE_URL" "$BACKUP_FILE"

psql "$RESTORE_TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF to_regclass('public."Businesses"') IS NULL THEN
    RAISE EXCEPTION 'Restore verification failed: Businesses table is missing';
  END IF;
  IF to_regclass('public."Orders"') IS NULL THEN
    RAISE EXCEPTION 'Restore verification failed: Orders table is missing';
  END IF;
  IF to_regclass('public."Customers"') IS NULL THEN
    RAISE EXCEPTION 'Restore verification failed: Customers table is missing';
  END IF;
END $$;
SELECT 'restore_verified' AS result, current_database() AS database_name;
SQL
