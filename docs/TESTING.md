# Avzar testing guide

How the tests are organised, how to run them, and which rules every change must follow. Counts are from CI at `58c6710` (2026-10-23, all three jobs green); see `STATUS.md` for the latest run.

## The three CI jobs (`.github/workflows/ci.yml`)

| Job | What it runs | Result at `58c6710` |
|---|---|---|
| `node-api` | `npm ci`, `npm audit --audit-level=high`, `npm run check` (syntax), `npm test` | 583 of 583 pass, 148 suites |
| `node-db` | PostgreSQL 17 service and 17 client tools (`pg_dump`, `pg_restore`, `psql`); `npm run migrate` twice (idempotent); plan seed; `check-schema`; the schema, plan-seed, adoption and `flows` suites; then every `test/db` suite; then an indicative latency step | 199 of 199 pass, 33 suites |
| `web` | `npm ci`, `npm audit --audit-level=high`, typecheck, Vitest, optional Playwright, `npm run build` | 44 files, 510 of 510 pass; build compiled |

Other workflows: `apply-patch.yml` (manual: applies one `step-NN-*.patch` on a branch and runs the same checks), `node-lockfile.yml` (regenerates `backend-node/package-lock.json`), `mobile-ci.yml` (Expo checks; no lockfile, no unit tests). The Apply patch workflow cannot edit workflow files.

## Running tests locally

```bash
# API, no database needed (database suites skip themselves)
cd backend-node && npm ci && npm run check && npm test

# API with the database suites (a throw-away database is created per suite; the user must be allowed CREATE DATABASE)
cd backend-node && DATABASE_URL=postgres://<user>:<password>@localhost:5432/<any-existing-db> npm test

# One database suite
cd backend-node && DATABASE_URL=... node --test test/db/rls-http-paths.integration.test.js

# Web
cd web && npm ci && npm run typecheck && npm test
```

Never paste a connection string into a chat. `docker compose up postgres` gives a local PostgreSQL 17.

The backup and restore suite also needs `pg_dump`, `pg_restore` and `psql` on `PATH`, at the same major version as the server or newer. It fails (it does not skip) when they are missing or older.

## Layout

- `backend-node/test/*.test.js`: unit and route tests with fake pools and fake providers. No database.
- `backend-node/test/db/*.integration.test.js`: real PostgreSQL. Each suite makes its own database with `createTempDatabase` (`helpers.js`), applies the real migrations, and drops it afterwards. Skipped when `DATABASE_URL` is not set.
- `backend-node/test/db/httpHarness.js`: starts the real Express app on a real database, signs a business up over HTTP, adds staff with a chosen permission set, and walks an order to a paid invoice.
- `backend-node/test/db/restrictedRole.js`: makes a non-superuser role without `BYPASSRLS` and wraps a pool the way `src/server.js` does.
- `web/test/`: Vitest unit and component tests (`web/test/components` for React components). `web/e2e/`: one Playwright spec that runs only when the staging secrets are set.
- `backend-node/test/apiDoc.test.js`: fails when `docs/API.md` no longer matches the routes (refresh it with `npm run docs:api` in `backend-node`).

## Rules for every change

1. **Cross-tenant test for every new or changed resource:** a second business must get 404 (not 403, not data) for the first business's rows; add cross-location where it applies.
2. **Restricted role for anything that depends on the database.** The CI database user is a superuser and ignores row-level security, so a superuser-only test can pass while staging fails. Use `createRestrictedAppPool` and `assertRestrictedRole`.
3. **Any check of the form "is this value already taken anywhere"** (slugs, host names, references) needs a restricted-role test: the check runs under one business and cannot see the others unless a lookup policy lets it. The storefront slug bug (step-09c3) was invisible to superuser tests.
4. **External providers sit behind an interface with a test fake.** Anything that needs live credentials is reported as "unverified with live credentials" until step-20.
5. **Never disable or skip a test to get green.** A failing test is a finding: say whether it is a product defect or a test fault.
6. **Record real output.** Say exactly what ran and what did not; CI is the authority.
7. A new migration is tested against a fresh database (the CI job migrates twice) and, when it changes policies, by the policy-shape test in `rls-lookup`.

## What the database suites prove

- `rls-role`: policy behaviour for a restricted role (no context sees nothing, cross-tenant read, update, delete and insert are refused).
- `rls-lookup`: policy shape on every table and the lookup keys.
- `rls-auth-flows`, `rls-public-flows`, `rls-http-paths`, `rls-webhooks-workers`, `rls-workers`, `flowsRestricted`: the access paths without a signed-in user, the webhooks, six worker cycles and an end-to-end run, all as a restricted role.
- `appointmentsIsolation`, `platformRetry`, `readyToWearStock`, `reports`, `shopScheduleAudit`: HTTP and database behaviour on an ordinary connection.
- `production-view` (step-12a): the manager production views over HTTP through a restricted role: permission, plan gating, business and location isolation, workload numbers, calendar flags, leave conflicts. Its rules are also covered without a database by `workloadReport.test.js` and `productionViewService.test.js`.
- `backupRestore` (step-10): a real `pg_dump` and restore into an empty database, then the restored copy is checked for identical row counts, the same policies and forced row-level security, no pending migration, a clean `check-schema`, and a restricted-role sign-in with cross-tenant isolation through the real app. It also records that a dump taken as the application role fails.

## Known limits

- Five of the six worker cycles in `rls-workers` run on an empty queue: they prove "no policy or permission error", not "picks the right rows".
- The original `flows` suite and the step-09b suites still connect as a superuser.
- No mobile unit tests; Playwright is skipped without the staging secrets.
- The latency step is `continue-on-error`; read the figures from the log. They are from a shared runner with a local database and are not production figures.
- No test touches a live Paystack, Resend, S3, OpenAI, ClamAV, Turnstile, Expo, Twilio or Meta account.
- `ci.yml` runs "Database integration tests (all)" twice (harmless; decision 10 in the brief).
