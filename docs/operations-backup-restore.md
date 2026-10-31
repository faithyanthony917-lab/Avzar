# Avzar database backup and restore runbook

## Scope and ownership

This runbook covers the PostgreSQL database used by `backend-node`. Object storage (customer uploads and progress photos), environment secrets, DNS, and provider accounts are separate recovery items and must be backed up/configured separately. Never put database URLs, access tokens, encryption keys, or customer exports in source control.

## Who may take the backup (row-level security)

Every tenant table has forced row-level security (`SECURITY.md`). `pg_dump` turns row security off for the dump, and PostgreSQL then **refuses to dump** a table whose policy would hide rows from the role that is dumping. So the dump must be taken by a superuser or a role with `BYPASSRLS` (the database provider's admin role, or its managed backup). **Do not take it as the application role** (`avzar_user` on staging): it fails, and `--enable-row-security` would not help: with no tenant set that role sees no rows, so the dump would be empty. The test `backupRestore.integration.test.js` proves the failure for a restricted role. Whether the staging admin role can run `pg_dump` has not been tried; try it on staging before relying on it. Never grant `BYPASSRLS` to the role the API connects as.

## Backup

1. Confirm the target environment and approved maintenance window. Verify the destination has encryption at rest and restricted access.
2. Use a PostgreSQL client at the server's major version or newer (the API image has none). Set `BACKUP_DATABASE_URL` to the **admin** connection described above (not the API's `DATABASE_URL`) in the operator's secret manager or shell, typed with `read -rs` so it is not echoed; do not paste it into tickets or logs.
3. Create a custom-format backup:

   ```sh
   pg_dump --format=custom --no-owner --no-privileges "$BACKUP_DATABASE_URL" --file="avzar-$(date -u +%Y%m%dT%H%M%SZ).dump"
   ```

4. Record UTC timestamp, database/server version, backup size, and checksum in the restricted operations log. Encrypt and copy the dump to the approved off-host backup location.
5. Back up object storage and required deployment configuration using the provider's versioning/backup facility. Secrets should be recoverable from the secret manager, not copied into the dump directory.
6. Keep retention according to the business policy and verify that a recent backup exists. A successful `pg_dump` alone does not prove recoverability.

## What CI proves (step-10)

`backend-node/test/db/backupRestore.integration.test.js` runs in the `node-db` job. It builds two businesses through the real API as a restricted role, takes a custom-format `pg_dump`, restores it into an empty database with `scripts/verify-postgres-restore.sh` (unchanged), and then checks: identical row counts in the core tables; the same policies and forced row-level security; no migration left to apply; `check-schema` clean; and a sign-in as a restricted role on the restored copy, where each business sees only its own order, invoice and customer. It also checks that the script refuses a non-empty target, an empty file and a file that is not a backup. This proves the procedure on a small synthetic database with a local server; it does not prove a restore of staging or production data, object storage, or timing. Do that by hand once (below). The tools in CI must match the server's major version: the workflow installs `postgresql-client-17`.

## Restore drill

1. Choose an isolated recovery database. Never test a restore against production.
2. Create a new, empty database for the drill. The verification script refuses a non-empty target and never drops existing tables:

   ```sh
   export BACKUP_FILE="avzar-backup.dump"
   export RESTORE_TEST_DATABASE_URL="postgres://.../avzar_restore_drill"
   ./scripts/verify-postgres-restore.sh
   ```

   The script validates the archive, restores it without owner/privilege changes, and checks that core tables exist. This is a smoke test, not a substitute for application-level recovery checks.
3. Point a non-production instance at the restored database and run `npm run check-schema` from `backend-node`, then run the database integration tests using the project's documented test environment. Check that isolation came back, with the same counts you recorded on the source: `SELECT count(*) FROM pg_policies WHERE policyname = 'avzar_business_isolation';` (92 at migration 0033), `SELECT count(*) FROM pg_policies WHERE policyname <> 'avzar_business_isolation';` (14 expected), and `SELECT count(*) FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity;` equal to the source. Then connect the instance as the application role, not as the admin role, and confirm it is not a superuser and has no `BYPASSRLS`.
4. Verify login, tenant-scoped customer/order access, appointment/task views, invoices/payments, media metadata, and storefront reads. Verify object storage separately; database metadata does not restore uploaded objects.
5. Record elapsed recovery time, restore errors, test results, and any missing secrets/provider configuration. Fix failures before declaring the backup usable.
6. Delete the temporary recovery database and local dump according to the approved secure-disposal process.

## Recovery cautions

- Pause writes or use the provider's point-in-time recovery procedure when consistency requires it.
- Restore database and object storage to a mutually consistent point where possible.
- Rotate credentials if exposure is suspected; do not restore compromised secrets from a backup.
- After a production recovery, validate migration state and run smoke tests before reopening writes.
- Run a restore drill at least quarterly and after major database/migration changes.

## Rollback and migrations

Migrations are forward-only. Do not edit an already-applied migration to repair a live database. Ship a new migration that repairs the state and test it against both a fresh database and a copy of a migrated database. Take and verify a backup before production schema changes. List `backend-node/migrations` before adding a file; the next number after `0033` is `0034`.

The runner (`src/db/migrate.js`) takes an advisory lock, applies each missing file in its own transaction, and records its SHA-256 checksum in `avzar_schema_migrations`. These are the errors it can stop with, and what to do:

| Error | Meaning | What to do |
|---|---|---|
| `Migration NNNN_x.sql was modified after it was applied` | The file's checksum no longer matches the one stored when it was applied. | See below. Do not delete the row and do not re-run the file. |
| `Migration NNNN_x.sql failed: <message>` | The SQL raised an error. The transaction was rolled back and no row was recorded, so nothing from that file is in the database. | Read the message. If the file has never been applied anywhere, fix the file and redeploy. If it has been applied to any other database, leave it and fix forward with a new migration. |
| `Cannot safely initialize database: only one of __EFMigrationsHistory and AspNetUsers exists` | The database is half of an old EF schema. | Stop. Do not run anything. Restore a backup or ask for help; this is not a state the runner can repair. |
| `Cannot safely adopt EF database at migration '<id>'` | An old EF database that is not at the last migration the runner knows. | Bring it to the supported EF migration first, or restore a backup. |

### "Migration NNNN was modified after it was applied"

1. **Find what changed.** `git log -p -- backend-node/migrations/NNNN_*.sql` shows every edit. The usual causes are an intentional edit (a mistake: see step 3), a line-ending change from an editor or a download (the checksum covers every byte, so CRLF instead of LF changes it), and a trailing-newline or whitespace change.
2. **Put the file back.** Restore the file to the version that was applied: `git checkout <commit before the edit> -- backend-node/migrations/NNNN_*.sql`, then redeploy. The error should disappear. Check `sha256sum` of the restored file against the `checksum` column of `avzar_schema_migrations` for that name if you want to be certain (read-only query).
3. **Ship the change you wanted as a new migration** (`0034` or the next free number), tested on a fresh database and a migrated copy.
4. **Last resort, only with a verified backup and a second person watching:** if the edit was deliberate, the database already matches the new SQL, and putting the file back is not possible, the stored checksum can be updated by hand for that one row. This is a manual change to the database's own bookkeeping; write down who did it and why. Never do it to make a start-up error go away without knowing what changed.

Never set `DATABASE_MIGRATE_ON_STARTUP=false` to get past this error on a database that needs the migration; the service would start against an old schema.
