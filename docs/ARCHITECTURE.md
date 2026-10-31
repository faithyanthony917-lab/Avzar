# Avzar architecture

How the parts fit together, as the code is today. Checked against the repository on 2026-10-23 (audit rev 10). Not covered here: deployment values (`DEPLOYMENT.md`), the route list (`API.md`), isolation rules (`SECURITY.md`).

## Parts

| Part | Folder | What it is |
|---|---|---|
| Web app and public storefronts | `web/` | Next.js 15, React 19, TypeScript. Pages under `src/app`: signed-in screens in `(app)`, sign-in screens in `(auth)`, public storefronts at `/sites/<slug>`, the customer portal, help, privacy and terms. |
| API | `backend-node/` | Node 22, Express 5, PostgreSQL. Entry point `src/server.js`, app wiring `src/http/app.js`. |
| Mobile app | `mobile/avzar-expo/` | Expo. Screens: sign-in, home, tasks, orders, customers (list, new, measurements) and settings. Offline queue in `src/offline`, live events in `src/realtime`. |
| Database | `backend-node/migrations/` | Forward-only SQL files `0001` to `0038`, applied by `src/db/migrate.js` and recorded in `avzar_schema_migrations`. |

There is no C# backend. The first schema (`0001_baseline.sql`) came from an earlier EF model; a database that already has that schema is adopted, not recreated (`migrate.js`).

## Request path

1. **Browser to web app.** Browser code never calls the API directly. It calls `/backend/api/...` on the web app's own origin; `web/src/app/backend/[...path]/route.ts` forwards only `/api/**` to `API_URL`. Unsafe methods are refused unless the `Origin` matches the host. The client address is forwarded only when `TRUST_PROXY_HEADERS=true`.
2. **Web content-security policy.** `web/middleware.ts` sets a per-request nonce policy: no inline script or style elements (colours and sizes go in style attributes only), `connect-src 'self'`. It also resolves custom storefront hostnames through `/public/resolve`.
3. **API.** `createApp` (`src/http/app.js`) starts a tenant context for each request, sets security headers and a strict API content-security policy, parses JSON (1 MB limit; webhook paths keep the raw body for signature checks), applies CSRF protection on `/api`, then mounts the routers. Order matters only for the public routers, which are mounted at `/` (`/public/...`).
4. **Sign-in.** `requireBearerAuth` accepts a bearer token (mobile) or the `tailoring.session` cookie (web), verifies the signed token, checks the session row is live, loads the member and their permissions, and sets the tenant for the rest of the request.
5. **Database.** Every query runs through a pool wrapped by `installTenantRlsContext`, which opens a transaction and sets `app.business_id` before the query. Row-level security in PostgreSQL then limits each query to that business. See `SECURITY.md`.

## Tenant model

- A **business** is the tenant. Almost every table has a `BusinessId` column. Tables without one: `Businesses`, the AspNet identity tables, `Plans`, `PlanEntitlements`, `PlatformAuditLogs`, `PlatformFeatureFlags`, `EmailSuppressions`, `DataProtectionKeys`.
- A **user** can belong to several businesses (memberships) and switches between them; the token names the business in use.
- Paths with no signed-in user (public storefront, customer portal links, webhooks, invitations, sign-in) find their business through **lookup policies** (migration `0033`, `src/db/tenantLookup.js`, `src/db/userScope.js`): a transaction-local key such as a storefront slug or a token hash lets one `SELECT` see one row, and the app then adopts that row's business.
- **Background workers** have no token, so each cycle runs once per business through `src/db/forEachBusiness.js`. A test (`workerTenantContext.test.js`) fails when a started worker sets no tenant.

## Background workers

All are started in `src/server.js` and stopped on `SIGTERM` or `SIGINT`.

| Worker | File | Purpose | Switch |
|---|---|---|---|
| Email dispatcher | `email/dispatcher.js` | Sends queued e-mail from `EmailOutbox`, with retries | `EMAIL_DISPATCHER_ENABLED` |
| Overdue-task reminders | `email/overdueTaskReminders.js` | Notifies about overdue tasks | `OVERDUE_TASK_REMINDERS_ENABLED` |
| Notification sweep | `notifications/notificationWorker.js` | Due-soon tasks, delivery at risk, quotation reminders, overdue invoices, purges old notifications | `NOTIFICATION_SWEEP_ENABLED` |
| Notification outbox | `notifications/notificationOutboxWorker.js` | Turns queued notification jobs into e-mail and push rows | `NOTIFICATION_OUTBOX_ENABLED` |
| Push delivery | `notifications/pushDeliveryWorker.js` | Sends push through Expo; runs only when a push sender is configured | needs `EXPO_ACCESS_TOKEN` |
| Worker summaries | `notifications/workerSummaryService.js` | Morning and end-of-day task summaries | `WORKER_SUMMARY_ENABLED` |
| Appointment reminders | `notifications/appointmentReminderWorker.js` | Staff reminders before appointments | always on |
| Customer messages | `messaging/customerMessageWorker.js` | Sends customer SMS reminders from `CustomerMessageOutbox` | `CUSTOMER_MESSAGE_WORKER_ENABLED` |
| Customer order and payment messages | `messaging/customerEventWorker.js` | Sends order amended, order ready and payment receipt messages from `CustomerEventOutbox` (step-16b) | `CUSTOMER_MESSAGE_WORKER_ENABLED` (the same switch) |
| Editable customer wording | `messaging/templateCatalog.js`, `auth/messageTemplateRoutes.js` | Default and saved wording of the four customer messages (`NotificationTemplates`, step-16c); read when a message is sent | none |
| Orphan cleanup | `storage/orphanCleanup.js` | Deletes stored files no row points to, after a grace period | `ORPHAN_CLEANUP_ENABLED` |
| Subscription lifecycle | `auth/subscriptionLifecycleService.js` | Trial end, overdue, suspension, subscription end | `SUBSCRIPTION_LIFECYCLE_ENABLED` |

Workers live inside the API process. While the API is asleep (the Render Free plan stops it after about 15 idle minutes) no worker runs and webhooks meet a cold start.

## Other services

- **Object storage:** `auth/objectStorage.js`, local disk or S3 (`STORAGE_PROVIDER`). Uploads are checked and re-encoded with `sharp`; documents can pass a ClamAV scan (`ANTIVIRUS_PROVIDER`).
- **E-mail:** a durable outbox; providers `log` (refused in production), `smtp` or `resend`; Resend delivery events arrive at `/api/webhooks/email/resend`.
- **Customer messaging:** provider-neutral contract in `messaging/provider.js`; Twilio SMS is wired, Meta WhatsApp configuration exists but only SMS sending is wired. Consent gate and customer opt-out (unsubscribe link, Twilio STOP webhook, `MessagingSuppressions`) described in `messaging-and-tenant-security.md`.
- **Billing:** Paystack for subscriptions and ready-to-wear checkout, behind `auth/billingProvider.js`; webhooks verified by HMAC-SHA512 over the raw body.
- **AI studio:** `auth/aiService.js` behind `auth/aiProvider.js` (OpenAI); a daily limit per business.
- **Realtime:** `realtime/events.js`, a small server side of the SignalR JSON protocol over WebSockets at `/hubs/business-events`; server-to-client only; the business comes from the verified token. Connections are held in this process's memory, so more than one API replica needs a shared fan-out first.
- **Health:** `GET /health/live` (process), `GET /health/ready` and `GET /health` (database check; 200 or 503). The live response still names the service `avzar-pwa-node`, a leftover name.

## Known limits

No request IDs or stack traces in error logs; no `helmet` package (headers are set by hand); one API replica only (realtime and the per-business worker loop assume it). Full list: `TODO.md`.
