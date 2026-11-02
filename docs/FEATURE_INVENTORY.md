# Avzar feature inventory

What exists, how far it goes, and what has been checked. Built from the code and `Avzar-Master-Audit.md` (rev 10) on 2026-10-23. If this file and the audit disagree, the audit wins: it was checked against the code.

**Status words:** **Done** = in the code and covered by a test that passes in CI. **Partial** = code exists; the gap is stated. **Missing** = searched, nothing found. **Unverified** = code exists but has never run against a real provider, device or live credentials (all providers are in this state until step-20). "Web" and "Mobile" name where a person can use it today.

## Accounts and access

| Feature | Status | Where | Gap |
|---|---|---|---|
| Register a business, sign in, sign out, refresh, switch business | Done | web `(auth)` pages; mobile sign-in; `coreAuthRoutes.js`, `mobileAuth.js` | Staging hand-tested (reported) |
| E-mail verification, password reset, change password | Done | `accountRoutes.js` | Staging sends real e-mail; verification enforced only with `REQUIRE_VERIFIED_EMAIL=true` |
| Two-factor sign-in (TOTP), session list and revoke | Done | `/account/security` | |
| Invitations and roles with permissions | Done | web `staff`, `staff/roles`, `staff/locations` | |
| Ownership transfer | Done | `adminRoutes.js`, web `ownership-transfer/confirm` | Needs an HTTPS public URL |
| Per-account login lockout | Done | `security/accountLockout.js`, unit and database tests | 5 wrong attempts lock for 15 minutes |
| Request IDs, access log, error causes | Done (step-17a) | `http/requestId.js`, `http/accessLog.js`, `http/errors.js` | Route pattern logged, never real addresses |
| Business closure, data retention jobs | Missing | | Step-17 |

## Customers and orders

| Feature | Status | Where | Gap |
|---|---|---|---|
| Customers, merge, CSV import, measurements and templates | Done | web `customers`; mobile customers and measurements | Reads of measurements are not audited |
| Orders, garments, pricing, quote, confirm, cancel, deliver | Done | web `orders`; mobile orders | Transition table in `orderTransitions.js` (step-11a, delivered, not yet run); the seven statuses stay (decision 6 settled); re-planning on change is step-11b |
| Changing an order re-plans its tasks | Missing | | Step-11 |
| Quotations and customer approval by link | Done | `quotationRoutes.js`, web `customer-portal` | Link not opened on staging |
| Customer portal and privacy requests | Done | `customerPortalService.js`, `customerPrivacyRoutes.js` | |
| Customer-reachable opt-out of messages | Partial | `messaging/optOut.js`, `publicMessagingRoutes.js`, `web/src/components/app/UnsubscribeClient.tsx` | Step-08b: link and SMS STOP; done in CI. Step-16d: WhatsApp STOP and START through Meta's signed webhook (written; CI not yet seen); live Twilio and Meta unverified |

## Money

| Feature | Status | Where | Gap |
|---|---|---|---|
| Invoices (from order, issue, void), payments (record, verify), receipts (PDF) | Done | web `finance` | |
| Online payment of an invoice or deposit (Paystack split payment to the business's subaccount) | Backend (15a1, CI green) and web (15a2, written). Unverified with live credentials | `invoicePaymentRoutes.js`, `invoicePaymentService.js` | Tested with a fake provider |
| Expenses, finance overview, reports summary | Done | `financeRoutes.js`, `reportsRoutes.js`, web `reports` | One report route only; no profit or labour figures; thin dashboard |
| Installment plans (a dated schedule on an issued invoice; read against the invoice's payments) | Backend and web, CI green at `d899ff9` (15b). Pay path unverified with live Paystack | `installmentRoutes.js`, `installmentService.js`, `installmentSchedule.js` | No reminders (step-16), no auto-charge, no late fees |
| Payment reconciliation report (collected money, payments to review, expired links, unverified and voided-invoice payments, reversed online payments, overdue installments; read only) | Backend and web written (15c), CI green at `726c0e9` | `reconciliationReport.js`, `reconciliationService.js`, `reportsRoutes.js`, `/reports/reconciliation` | No Paystack settlement comparison (step-20), no notification of findings (step-16) |
| Reconciliation report | Missing | | Step-15c |
| Subscription plans and Paystack billing, usage table | Unverified | web `settings/billing`, `billingRoutes.js` | Live Paystack unchecked |
| Exports | Partial | CSV for designs, collections, inventory, expenses, customers, the account | None for orders, invoices, payments (step-17) |

## Production and scheduling

| Feature | Status | Where | Gap |
|---|---|---|---|
| Workflows, stages, production tasks, assignment, checks, worker requests | Done | web `workflows`, `tasks`; mobile tasks | |
| Task progress photos | Partial | `TaskProgressPhotos.tsx` | Real-device check owed (A5) |
| Shop schedule planner, versions, publish with audit entry | Done | web `tasks/schedule`, `workers/schedule` | Read model for workload, forecast, calendar and leave conflicts exists (step-12a, API only, not yet run in CI); no screens yet (12b, 12c) |
| Worker availability and leave | Done | `workerScheduleService.js` | Planner reads leave; `GET /api/production/leave-conflicts` lists planned tasks that collide with leave (step-12a, API only); no screen yet |
| Appointments and fittings | Partial | web `fittings` | Tested on an ordinary connection; the status message reads "marked noshow" |
| Calendar feed (`.ics`, hashed revocable tokens) | Done in CI; checked by hand on staging (file imported into a calendar app, stop returns 404); a self-refreshing subscription not checked | `orderRoutes.js` | Manager screen to make, list and stop a feed link (`WorkerCalendarFeeds.tsx`, step-08a); appointment notes removed from the feed and the download (decision 5). Staging check 2026-10-25: link made, feed carried the appointment without notes, stopped link returned 404 |

## Stock and suppliers

| Feature | Status | Where | Gap |
|---|---|---|---|
| Materials, stock movements, low-stock alerts, reorder | Done | web `inventory` | |
| Suppliers and purchase orders | Partial | `supplyRoutes.js`, `SupplierManager.tsx`, `PurchaseOrder*.tsx` | Web screens (step-08d); no mobile screen; drafts cannot be edited; not checked on staging |
| Ready-to-wear stock and public checkout | Unverified | web `inventory/ready-to-wear`, `readyToWearRoutes.js` | Tested with a fake provider; live Paystack unchecked |

## Catalog and storefront

| Feature | Status | Where | Gap |
|---|---|---|---|
| Designs, collections, categories, CSV import, visibility | Done | web `catalog` | No cropping (reference images on orders: step 18a) |
| Storefront builder, publish, preview, slug redirects, custom hostnames | Partial | web `storefront`, `/sites/<slug>`, `publicSiteRoutes.js` | Raw JSON editors, no media picker, plan limits shown only after Save (step-13); no wildcard DNS yet |
| Storefront address unique across businesses | Done | `storefrontSlugCheck.js` | Staging needs the redeploy |
| Analytics with consent | Done | `storefrontAnalyticsRoutes.js`, web `settings/analytics` | |
| Public inquiry, "book a fitting" | Partial | `inquiryService.js`, `InquiryActions.tsx`, `/inquiries` | A booking creates an inquiry of kind Appointment; staff turn it into an appointment from the Requests page (step-14). No customer notice (step-16); not checked on staging |
| Media upload and public media | Unverified | `mediaRoutes.js`, S3 or local | Upload works on staging (reported); orphan sweep fails against S3 |
| Document uploads, virus scan | Unverified | `documentService.js` | ClamAV never run live |

## Messaging and notifications

| Feature | Status | Where | Gap |
|---|---|---|---|
| In-app notifications, preferences, quiet hours, bell | Partial | web `notifications`, `settings/notifications` | "Mark all read" message clears at once |
| E-mail outbox, retries, Resend webhook | Unverified | `email/` | Staging sends real e-mail; webhook secret not set |
| Push notifications | Partial | `pushService.js`, `pushDeliveryWorker.js` | Backend only; the mobile app never registers a token (step-07 deferred); off by default |
| Customer order and payment messages (order amended, order ready, payment receipt) and staff list | Partial | `messaging/customerEvents.js`, `messaging/customerEventWorker.js` | Step-16b; SMS and WhatsApp to opted-in customers only; done in CI at `f439b66`; step-16d sends WhatsApp as Meta-approved templates (written; CI not yet seen); live Twilio and Meta unverified |
| Customer SMS reminders and consent record | Partial | `messaging/` | Twilio only; customer opt-out by link and SMS STOP (08b); staff consent screen on the customer page (08c); done in CI; unverified with live Twilio |
| Worker morning and end-of-day summaries | Done | `workerSummaryService.js` | |
| Notification triggers | Partial | `NOTIFICATION_SYSTEM.md`, `staffEvents.js`, `staffSweeps.js` | Step-16a added leave requested, decided and colliding, appointment assigned, changed and cancelled, worker overload and overdue installment (CI not yet seen); no customer-facing messages or editable templates (step-16b to 16d) |

## Platform

| Feature | Status | Where | Gap |
|---|---|---|---|
| Platform admin: plans, feature flags, e-mail suppressions, failed-job retry | Partial | web `platform-admin/*` | No business or user management, usage view, audit viewer or health screen (step-17) |
| AI studio (design images, assistant builder, text) | Unverified | web `ai-studio`, `aiService.js` | Text and single image only; live provider unchecked |
| Realtime events | Done | `realtime/events.js` | One API replica only |
| Tenant isolation (row-level security) | Done in CI | `SECURITY.md` | Staging counts of the 14 lookup policies and redeploy still open |
| Backup and restore | Done in CI (step-10) | `operations-backup-restore.md`, `backupRestore.integration.test.js` | Not yet done by hand on staging |

## Mobile (Expo)

Screens that exist: sign-in, home, tasks, orders, customers (list, new, measurements), settings. Missing: notification inbox, schedule, appointments, push registration. No lockfile and no unit tests (decision 4). Real-device checks B11 and A5 are owed.

## Not built, by step

Step-11: order change re-plans. Step-12: manager dashboard and views. Step-13: no-code storefront editor. Step-14: booking becomes an appointment. Step-15: online payment, installments, reconciliation report. Step-16: all notification triggers. Step-17: hardening (request IDs, `helmet`, lockout, closure, retention, exports, OpenAPI). Step-18: reference images, task approval, mobile inbox. Step-19: full isolation matrix and quality pass. Step-20: live verification of every provider.
