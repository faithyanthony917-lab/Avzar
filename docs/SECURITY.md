# Avzar security notes

What the code enforces today and what it does not. Checked on 2026-10-23 (audit rev 10). "Proven in CI" means a test in `backend-node/test` passes in the `node-db` job; it does not mean checked on staging or with a live provider.

## Sign-in and sessions

- Passwords are hashed with argon2id (`src/security/passwordHasher.js`).
- Web sessions use the `tailoring.session` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` in production). Mobile uses a bearer token. A bad bearer token never falls back to the cookie.
- Access tokens last `ACCESS_TOKEN_MINUTES` (default 10); a refresh session expires after `REFRESH_IDLE_DAYS` idle (30) or `REFRESH_ABSOLUTE_DAYS` (90); at most `MAX_SESSIONS_PER_USER` (10) per person. Every request checks the session row is live and not revoked.
- Two-factor sign-in (TOTP) exists (`security/totp.js`, `/api/account/two-factor/*`). E-mail verification is enforced only when `REQUIRE_VERIFIED_EMAIL=true` (default `false`).
- **Lockout:** 5 wrong passwords or codes lock the account for 15 minutes (`security/accountLockout.js`, used by sign-in, password change, the owner checks and mobile sign-in; a deleted account stays locked). A per-IP limit also applies (10 attempts a minute on auth routes). Unit and database tests cover it. *(The earlier note here saying the lockout was missing was out of date.)*

## Request protection

- **CSRF:** signed double-submit cookie `tailoring.csrf` and header `X-XSRF-TOKEN` on unsafe `/api` requests without a bearer token (`security/csrf.js`). The exempt paths are listed in `src/http/app.js`.
- **Headers:** the API sets `nosniff`, a referrer policy, a permissions policy, an opener policy, strict transport security in production and a strict content-security policy by hand. Answers under `/api` also carry `Cross-Origin-Resource-Policy: same-origin` and `Cache-Control: no-store` (a route that sets its own `cache-control`, such as media and exports, replaces the default; public media and pages are not under `/api`). There is no `helmet` package, by decision (step 17).
- **Request IDs and logs:** every request gets an ID (a plain 8 to 64 character `x-request-id` from a proxy is kept), returned in the `x-request-id` header and in the body of a 500. In production the API writes one JSON line per request (`event: request`: request ID, method, route pattern, status, duration, business ID when signed in). The route pattern is logged, never the real address or query string, so tokens in addresses stay out of the log; health checks are not logged. An unhandled error logs the request ID, type, message, stack and causes (never a database `detail`). A worker that fails for one business logs the business, the error type, code, HTTP status and the same for each cause, with no message and no stack. The web app sets a nonce policy (`web/middleware.ts`).
- **Rate limits:** `express-rate-limit` per route group (auth 10 a minute, public 600 a minute; others set at the top of each route file). Behind a proxy the client address is trusted only for the ranges in `TRUSTED_PROXY_CIDRS`; if it is empty, every user looks like one address. `web` forwards the client address only with `TRUST_PROXY_HEADERS=true`.
- **Body limits:** 1 MB JSON; uploads limited by `MEDIA_MAX_UPLOAD_BYTES`, `MEDIA_MAX_PIXELS`, `DOCUMENT_MAX_UPLOAD_BYTES`; the large AI image-save body is read only after sign-in.
- **Browser to API:** only through the web proxy, same-origin, `/api/**` only.

## Permissions

- Owners pass every permission check. Other members need the permission named on the route (`requirePermission`). `API.md` lists the permission for each route. The permission names in use: `audit.view`, `business.settings`, `customers.manage`, `customers.merge`, `customers.view`, `designs.manage`, `designs.view`, `documents.manage`, `documents.view`, `expenses.manage`, `expenses.view`, `fittings.manage`, `inquiries.manage`, `inquiries.view`, `inventory.manage`, `inventory.view`, `invoices.manage`, `invoices.view`, `locations.manage`, `measurements.record`, `measurements.templates`, `media.manage`, `media.view`, `orders.confirm`, `orders.manage`, `orders.view`, `payments.record`, `payments.verify`, `payments.view`, `pricing.manage`, `pricing.view`, `reports.view`, `roles.manage`, `staff.manage`, `staff.view`, `storefront.edit`, `storefront.publish`, `storefront.view`, `tasks.assign`, `tasks.manage`, `tasks.override`, `tasks.view`, `tasks.work`, `workers.manage`, `workflows.manage`.
- Platform-admin routes (`/api/platform-admin/*`) need a signed-in user whose e-mail is in `PLATFORM_ADMIN_EMAILS`; the check is in the service (one shared helper, `platformAccess.js`). Platform screens (step 17b): business list and detail (counts only, never customer names or contacts), user lookup by e-mail, platform audit log, health report. Opening a business and every user lookup is written to `PlatformAuditLogs`; the lookup entry holds no address.
- Plan limits are enforced in services (`entitlementService.js`), not in route middleware.

## Tenant isolation (row-level security)

- Migration `0032` enables **and forces** row-level security on every public table that has a `BusinessId` column (92 policies named `avzar_business_isolation`). A query sees only rows whose `BusinessId` equals the transaction-local `app.business_id`; with no tenant set it sees nothing and writes are refused.
- The application must connect as a role that is **not** a superuser and does not have `BYPASSRLS`, or none of this applies (forcing makes the table owner subject to the policies too). Staging uses `avzar_user` (checked 2026-10-22).
- Migration `0038` adds `InvoiceInstallmentPlans` and `InvoiceInstallments` with the standard forced isolation policy and no lookup policy: the portal reaches a schedule through the invoice it already reached by its token.
- Migration `0037` adds one more key-matched lookup (`InvoicePaymentAttempts` by provider reference, for the invoice payment webhook) together with its own isolation policy. Migration `0033` adds 13 key-matched lookup policies (`SELECT` only) for paths with no signed-in user: storefront by slug, id, retired slug or hostname; portal, calendar-feed and invitation tokens (by hash); ready-to-wear and subscription payment references; e-mail provider message id; memberships by user; sessions by token hash; media by id. It also adds one platform-scope policy so tenantless e-mail rows (password reset, verification) can be read by the dispatcher. That is 14 policies besides `avzar_business_isolation`; this count comes from reading the migration and is not yet confirmed on staging. Migration `0043` adds five more, all `SELECT` only and named `avzar_platform_admin_read`, on `NotificationOutbox`, `PushDeliveries`, `WorkerSummaryJobs`, `AppointmentReminders` and `EmailOutbox`; they open only while `app.platform_admin_read = 'on'`, which the platform-admin services set after the allowlist check. A retry reads the row that way, then writes inside that row's own business context. Expect 20 policies besides `avzar_business_isolation` after `0043`.
- The lookup key comes from a frozen list in the code, never from request data; a malformed UUID key means "not found".
- **"Is this value taken anywhere" checks need the same lookup:** the storefront address check (`auth/storefrontSlugCheck.js`) uses two lookup keys to see another business's row with that exact address, `SELECT` only, and the unique index maps to a 409. This was a real bug found by a restricted-role test (audit finding 16). Any new check of this kind needs a restricted-role test.
- **Workers:** each cycle runs once per business (`forEachBusiness`).
- **Not under row-level security** (no `BusinessId`): `Businesses`, identity tables, `Plans`, `PlanEntitlements`, `PlatformAuditLogs`, `PlatformFeatureFlags`, `EmailSuppressions`, `DataProtectionKeys`. These rely on application checks.
- **Proven in CI under a restricted role:** sign-in and account flows, public storefront (by slug, redirect slug, hostname), public inquiry, portal, quotation and privacy links, calendar feed, analytics consent, ready-to-wear checkout and webhook, subscription and e-mail webhooks, media lookup, six worker cycles (five on an empty queue), an end-to-end flow, policy shape on every table, and (step-10) the same isolation on a restored backup. The original `flows` suite and the step-09b suites still connect as a superuser.

## Webhooks

Paystack (subscription and ready-to-wear): HMAC-SHA512 over the raw body, constant-time compare, amount and currency re-checked, replay is a no-op. Resend: Svix-style signature check (`email/svix.js`). When `EMAIL_RESEND_WEBHOOK_SECRET` is empty the endpoint is disabled and delivery events are not recorded; it is empty on staging. An unmatched reference returns 404 and is logged; unknown e-mail ids are acknowledged and logged.

## Uploads

Images are decoded and re-encoded with `sharp` and size-limited; documents can be scanned with ClamAV when `ANTIVIRUS_PROVIDER=clamav` (`ANTIVIRUS_REQUIRED=true` refuses uploads without a scan). ClamAV has never been run against a live scanner.

## Customer data and privacy

Customer privacy requests are in `auth/customerPrivacyRoutes.js`, account export and deletion in `auth/accountRoutes.js`, and the messaging consent record in `messaging-and-tenant-security.md`. There is no retention job, no business-closure flow, and measurement reads are not audited.

## Backups

Backups contain customer data. Handle them as described in `operations-backup-restore.md`, including why a dump cannot be taken as the application role.

## Known gaps (also in `TODO.md`)

No `helmet` package (by decision); worker failures log no message or stack; customers can opt out of SMS and WhatsApp reminders through the link and, for SMS, by replying STOP (step-08b; CI and live Twilio not yet verified); WhatsApp has no inbound STOP; staging sends real e-mail; Resend webhook secret not set on staging; live Paystack, Resend delivery, S3, ClamAV, Turnstile, Expo push, Twilio and Meta are unverified with live credentials.
