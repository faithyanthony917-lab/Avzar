# Avzar

Multi-tenant software for tailoring businesses and fashion brands: orders, customers and measurements, quotations, invoices and payments, production tasks and scheduling, stock, a storefront builder, customer portal, notifications and billing.

| Part | Folder | Stack |
|---|---|---|
| Web app and public storefronts | `web/` | Next.js 15, React 19, TypeScript |
| API | `backend-node/` | Node 22, Express 5, PostgreSQL (forward-only SQL migrations) |
| Mobile app (worker screens) | `mobile/avzar-expo/` | Expo |

There is no C# backend. The browser calls the API only through the web app's `/backend/...` proxy.

Status and plan: `STATUS.md` (what is verified), `TODO.md` (what remains).

Documentation, in `docs/`:

| File | What it covers |
|---|---|
| `FEATURE_INVENTORY.md` | What exists, how far it goes, what is unverified |
| `ARCHITECTURE.md` | Parts, request path, tenant model, background workers |
| `API.md` | Route table (generated from the code; not OpenAPI) |
| `SECURITY.md` | Sign-in, permissions, row-level security, known gaps |
| `NOTIFICATION_SYSTEM.md` | Events, channels, retries, quiet hours |
| `DEPLOYMENT.md` | Settings, migrations, staging as it is today |
| `TESTING.md` | CI jobs, how to run tests, rules for every change |
| `operations-backup-restore.md` | Backup, restore drill, migration recovery |
| `messaging-and-tenant-security.md` | Customer messaging consent and the row-level security rollout notes |

## Requirements

- Node 22.13 or newer
- PostgreSQL 17 (Docker Compose provides one)

## Run locally with Docker Compose

```bash
cp .env.example .env      # set JWT_SIGNING_KEY to a random string of 32+ characters
docker compose up --build
```

The API listens on `http://localhost:8081` and the web app on `http://localhost:3000`. The `api` service applies migrations and then starts with file watching.

## Run without Docker

```bash
# API
cd backend-node
npm ci
npm run migrate          # needs DATABASE_URL
npm run dev              # or: npm start

# Web (second terminal)
cd web
npm ci
API_URL=http://localhost:8081 npm run dev
```

`npm run seed-plans` adds the subscription plans (idempotent, add-only).

## Tests

| What | Command | Notes |
|---|---|---|
| API syntax | `cd backend-node && npm run check` | |
| API tests | `cd backend-node && npm test` | No database needed |
| Database tests | `cd backend-node && node --test "test/db/**/*.test.js"` | Needs `DATABASE_URL` for an empty PostgreSQL database. The `rls-*` files use a restricted role; most other suites connect with the default URL (a superuser in CI). |
| Schema drift | `cd backend-node && npm run check-schema` | Read-only |
| Web typecheck | `cd web && npm run typecheck` | |
| Web tests | `cd web && npm test` | Vitest. Component tests in `web/test/components` start with `// @vitest-environment jsdom`; everything else runs in Node |
| Web end-to-end | `cd web && npm run test:e2e` | Playwright; skipped unless staging secrets are set |
| Web build | `cd web && npm run build` | |
| Mobile typecheck | `cd mobile/avzar-expo && npm install && npm run typecheck` | No lockfile yet |

CI (`.github/workflows/ci.yml`) runs the API, database and web jobs; `mobile-ci.yml` runs the mobile job. CI is the authority on whether a change passes.

## Environment variables

`.env.example` (repo root) is the local template. `backend-node/src/config/env.js` is the full list with defaults and validation. An optional variable that is present but empty can fail validation, so leave unused optional keys unset.

API, most important:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. See "Database role" below. |
| `JWT_SIGNING_KEY` | 32+ characters. Production also needs `CSRF_SIGNING_KEY`, or a 32+ character `JWT_SIGNING_KEY` it can fall back to. |
| `WEB_BASE_URL`, `PUBLIC_BASE_URL` | Public address of the web app. Ownership transfer needs `PUBLIC_BASE_URL` to be HTTPS. |
| `TRUSTED_PROXY_CIDRS` | See "Proxy setting". |
| `DATABASE_MIGRATE_ON_STARTUP`, `BILLING_SEED_PLANS_ON_STARTUP` | See "Migrations". |
| `EMAIL_PROVIDER` | `log`, `smtp` or `resend`. `log` is rejected when `NODE_ENV=production`. |
| `STOREFRONT_BASE_DOMAIN` | Default `avzar.app`. See "Storefront links". |
| `STORAGE_PROVIDER` | `local` or `s3` (then the `STORAGE_S3_*` keys are required). |
| `PLATFORM_ADMIN_EMAILS` | Comma-separated platform administrators. |

Web:

| Variable | Purpose |
|---|---|
| `API_URL` | Where the web server reaches the API (server side). |
| `BASE_DOMAIN` | Base domain for `{slug}.BASE_DOMAIN` storefront hosts. |
| `NEXT_PUBLIC_API_PUBLIC_URL`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Baked in at build time. |
| `TRUST_PROXY_HEADERS` | Set to `true` only behind a reverse proxy you control. |

Never commit `.env`, and never paste database URLs, tokens or passwords into a chat or an issue.

## Migrations

Migrations are SQL files in `backend-node/migrations/`, applied in name order and recorded with a SHA-256 checksum. They are forward-only: never edit a migration that has been applied anywhere. Add the next number instead (list the folder first). Keep `*.sql` line endings as LF (`.gitattributes` enforces this).

- `npm run migrate` applies them by hand.
- With `DATABASE_MIGRATE_ON_STARTUP=true` the API applies them when it starts, under an advisory lock, so several instances starting together are safe. Plans are then seeded when `BILLING_SEED_PLANS_ON_STARTUP=true`.
- When these two variables are unset they default to on in development and off everywhere else. A deployed environment that should migrate itself must set both to `true`.
- A failed migration stops startup (the process exits with `startup_database_failed`).

## Database role and tenant isolation

Migrations `0032` and `0033` enable and force row-level security on every table with a `BusinessId`. A superuser, or a role with `BYPASSRLS`, skips these policies, so the API must connect as an ordinary role in any real environment. Tables with no `BusinessId` (`Businesses`, the user tables, `Plans` and a few others) are protected by application code only. Details: `docs/SECURITY.md`.

## Proxy setting

Behind Render or any reverse proxy, set `TRUSTED_PROXY_CIDRS=uniquelocal` on the API service. Without it the API ignores `X-Forwarded-For`, every visitor shares one rate-limit bucket, and `express-rate-limit` logs `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`. On the web service, `TRUST_PROXY_HEADERS=true` makes the `/backend` proxy forward the client address.

## Deploy on Render

The repo has a Dockerfile for each service (`backend-node/Dockerfile`, built from the repository root; `web/Dockerfile`, built from `web/`). Staging runs as `avzar-api`, `avzar-web` and the database `avzar_staging`. Check each service against this list:

1. Database: an ordinary role (not superuser, not `BYPASSRLS`) in `DATABASE_URL`.
2. API: `JWT_SIGNING_KEY` (32+ characters), `WEB_BASE_URL`, `PUBLIC_BASE_URL`, `TRUSTED_PROXY_CIDRS=uniquelocal`, `DATABASE_MIGRATE_ON_STARTUP=true`, `BILLING_SEED_PLANS_ON_STARTUP=true`.
3. Web: `API_URL` (the API's address), `BASE_DOMAIN`, the two `NEXT_PUBLIC_*` values at build time, `TRUST_PROXY_HEADERS=true`.
4. After a deploy, the API log shows `applied <migration>` lines for any new migration, then the server start line.
5. Health: `GET /health/live` and `GET /health/ready` on the API.

Patches are delivered as `step-NN-*.patch` files in the repo root and applied with the manual "Apply patch" GitHub workflow, which applies the patch to a branch and runs the checks.

## Storefront links

A published storefront is served at `/sites/<slug>` on the web app, for example `https://avzar-web.onrender.com/sites/<slug>`. The manager may show `https://<slug>.avzar.app` because `STOREFRONT_BASE_DOMAIN` defaults to `avzar.app`; that address works only after wildcard DNS and a certificate exist for the domain. Until then, share the `/sites/<slug>` address.

## Installing the web app on a phone

The web app is no longer an installable PWA and has no service worker. Use it in the browser. If you installed it earlier, remove the home-screen icon, and if the browser still shows an old offline page, clear the site's data (browser settings, site settings, clear data for the site).
