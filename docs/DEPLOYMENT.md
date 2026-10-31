# Avzar deployment guide

What is needed to run the API and web app, and what staging looks like today. Read from the code and the Render screens you sent on 2026-10-23. Names only: never put a value, URL with a password or token in this file, a ticket or a chat.

## What runs

| Service | Image or command | Port | Health |
|---|---|---|---|
| `avzar-api` | `docker build -f backend-node/Dockerfile .` from the repository root; starts `npm start` | `PORT` (8081 default) | `GET /health/live`, `GET /health/ready` |
| `avzar-web` | `web/Dockerfile` (Next.js) | 3000 | the app itself |
| PostgreSQL 17 | managed (Render `avzar_staging` on staging) | 5432 | `GET /health` on the API checks the database |

The API image has no PostgreSQL client tools; take backups from a machine that has `pg_dump` at the server's major version (`operations-backup-restore.md`).

## Local development

`docker compose up --build` (see `README.md`). The compose file starts PostgreSQL 17, runs `npm run migrate`, then starts the API with file watching. Development defaults turn migrations and plan seeding on at startup.

## API settings (`src/config/env.js` is the full list; this is what matters)

**Needed in production** (* means the code refuses to start without it when the condition in the second column holds; the rest are needed for the feature to work):

| Name | Rule |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | PostgreSQL URL; connect as a role that is not a superuser and has no `BYPASSRLS` (see `SECURITY.md`) |
| `JWT_SIGNING_KEY` * | at least 32 characters (startup fails otherwise). `CSRF_SIGNING_KEY` is optional; when it is unset the JWT key is used for CSRF too |
| `PUBLIC_BASE_URL`, `WEB_BASE_URL` | the public web address used in links; `PUBLIC_BASE_URL` falls back to `WEB_BASE_URL`, and ownership transfer needs an HTTPS value |
| `EMAIL_PROVIDER` * | `smtp` or `resend`; `log` is refused in production |
| `EMAIL_FROM_ADDRESS` * | a valid address when the provider is not `log` |
| `EMAIL_RESEND_API_KEY` | when `EMAIL_PROVIDER=resend` (or `EMAIL_SMTP_HOST` for `smtp`) |
| `STORAGE_PROVIDER` | `s3` for any real use (`local` writes to the container disk, which is lost on redeploy) |
| `STORAGE_S3_BUCKET` *, `STORAGE_S3_ACCESS_KEY` *, `STORAGE_S3_SECRET_KEY` * | when `STORAGE_PROVIDER=s3`; also `STORAGE_S3_REGION`, optional `STORAGE_S3_ENDPOINT`, `STORAGE_S3_KEY_PREFIX` |
| `PLATFORM_ADMIN_EMAILS` | comma-separated e-mail addresses allowed into `/api/platform-admin/*` |
| `TRUSTED_PROXY_CIDRS` | the proxy ranges to trust for the client address (`uniquelocal` on Render, per `README.md`); if empty, rate limits see every user as one address |

**Startup database work** (default off outside development): `DATABASE_MIGRATE_ON_STARTUP=true` applies pending migrations when the process starts (an advisory lock makes several instances safe); `BILLING_SEED_PLANS_ON_STARTUP=true` adds missing plans after migrations. Both are on for staging. Or run `npm run migrate` and `npm run seed-plans` as separate steps.

**Optional providers** (unset means the feature is off or uses a fake): `EMAIL_RESEND_WEBHOOK_SECRET` (without it Resend delivery events are ignored), `BILLING_PAYSTACK_SECRET_KEY` and `BILLING_PAYSTACK_CALLBACK_URL`, `AI_OPENAI_API_KEY`, `EXPO_ACCESS_TOKEN` (push), `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_SMS_FROM` (for customers' STOP replies, set Twilio's incoming-message webhook to `<API address>/api/messaging/twilio/inbound`; if the address Twilio calls differs from `PUBLIC_BASE_URL` plus that path, set `TWILIO_INBOUND_WEBHOOK_URL` to the exact URL, or every request fails its signature check), `META_WHATSAPP_*` (sending needs `META_WHATSAPP_ACCESS_TOKEN` and `META_WHATSAPP_PHONE_NUMBER_ID`; for customers' STOP replies also set `META_WHATSAPP_APP_SECRET` and `META_WHATSAPP_VERIFY_TOKEN` and point Meta's webhook at `<API address>/api/messaging/whatsapp/webhook`; the four message templates must be created and approved in Meta first: see `WHATSAPP_SETUP.md`), `ANTIVIRUS_PROVIDER=clamav` with `ANTIVIRUS_HOST` and `ANTIVIRUS_PORT`, `STOREFRONT_CAPTCHA_SECRET_KEY` (Turnstile), `STOREFRONT_BASE_DOMAIN` (default `avzar.app`, which has no DNS record yet).

**Worker switches** (all default on): `EMAIL_DISPATCHER_ENABLED`, `OVERDUE_TASK_REMINDERS_ENABLED`, `NOTIFICATION_SWEEP_ENABLED`, `NOTIFICATION_OUTBOX_ENABLED`, `WORKER_SUMMARY_ENABLED`, `CUSTOMER_MESSAGE_WORKER_ENABLED`, `RETENTION_WORKER_ENABLED`, `ORPHAN_CLEANUP_ENABLED`, `SUBSCRIPTION_LIFECYCLE_ENABLED`.

## Web settings

`API_URL` (where the proxy forwards `/api/**`), `BASE_DOMAIN`, `NEXT_PUBLIC_API_PUBLIC_URL` (media origin allowed in the content-security policy), `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (optional), `TRUST_PROXY_HEADERS=true` only when a proxy you control sets `X-Forwarded-For` in front of the web app.

## Migrations

Forward-only files in `backend-node/migrations/`; list the folder before adding one (the next free number after `0038` is `0039`). The runner records each file's checksum; editing an applied file stops startup with "Migration NNNN was modified after it was applied". Recovery for that error is in `operations-backup-restore.md`. Never edit an applied migration.

## Staging today (Render)

- `avzar-api`: Docker, **Free plan**, deploys `main`. The service stopped 15 minutes after each start in the logs (idle sleep, inferred): workers pause and webhooks meet a cold start while it sleeps. An always-on instance is a launch gate.
- The database role `avzar_user` is not a superuser and has no `BYPASSRLS` (checked 2026-10-22); 92 `avzar_business_isolation` policies. The other 14 policies from `0033` are not yet counted on staging (SQL in the audit, section 7).
- Staging sends **real e-mail** through Resend (`EMAIL_PROVIDER=resend`, `NODE_ENV=production`). Use only your own addresses for test customers.
- S3 uploads work (reported); the orphan sweep logged `S3ServiceException` (type only, cause unknown).
- Storefront links: use `https://avzar-web.onrender.com/sites/<slug>` until wildcard DNS exists.
- Redeploy staging with `step-09c3` (storefront address fix) before testing storefront creation; until then a business there can take another business's retired address.

## Before real customers

The launch gates are in the audit (section 11): isolation proven on staging, per-client rate limiting seen in a log, working storefront links, restore done once by hand, request IDs, customer opt-out, always-on API, S3 end to end, Resend delivery and webhook, live checks of every provider, and this guide matching what is deployed.
