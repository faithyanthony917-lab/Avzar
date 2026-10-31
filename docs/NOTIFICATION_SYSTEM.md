# Avzar notification system

How a notification is created, who gets it and by which channel. Read from the code on 2026-10-23 (audit rev 10). Delivery through real providers (Resend, Expo push, Twilio) has not been checked with live credentials.

## One entry point

Services call `notify(db, event)` in `backend-node/src/notifications/notificationService.js`, inside the same transaction as the change that caused it. It validates the event (an invalid one is logged and returns `ok: false`; it never throws into the caller), finds the recipients, and for each person writes:

- an **in-app** row (`Notifications`), always unless the person turned that category's in-app channel off;
- an **e-mail** row in the notification outbox, if the person's e-mail channel is on for that category;
- a **push** intent, if the person's push channel is on.

The call returns counts of durable intents, not deliveries.

### Event fields

`businessId`, `category`, `eventType`, `title` (cut to 120 characters), `body` (300), `dedupeKey` (200), optional `target` (`kind` plus `id`), `recipients`, optional `actorMembershipId` or `actorUserId` (that person is never notified about their own action) and optional `email` (`templateKey`, `subject`, `text(recipient)`, `dedupeKey(recipient)`).

### Recipients

`recipients` must hold `membershipIds`, a `permission`, or `ownersOnly: true`; the optional `locationId` and `locationlessOnly` narrow it. Filters combine with AND. The category's channel settings of each person are applied after that.

### Duplicates

In-app rows use `dedupeKey` as given; e-mail rows use `email.dedupeKey(recipient)` or `<dedupeKey>:<membershipId>`. The same event raised twice does not create a second row.

## Categories, defaults and channels

Seven categories (`notificationCatalog.js`): `tasks`, `schedule`, `orders`, `inquiries`, `finance`, `inventory`, `billing`.

| Category | In-app | E-mail | Push |
|---|---|---|---|
| tasks | on | **on** | off |
| every other category | on | off | off |

These are defaults for a person with no saved preference row. Preferences are read and saved through `GET` and `PUT /api/notifications/preferences`. Push is opt-in everywhere, and it is only delivered when a push sender is configured (`EXPO_ACCESS_TOKEN`; not set on staging) and the person has registered a device token (`POST` and `DELETE /api/auth/push-token`; the mobile app does not register tokens yet, step-07 is deferred).

**Quiet hours:** per person, off by default (22:00 to 07:00 in the business time zone when switched on). Quiet hours delay e-mail and push until they end; in-app rows are not delayed.

## Events raised by the code today

| Event type | Category | Raised by | Who is told |
|---|---|---|---|
| `task.assignment`, `task.unblocked`, `task.next-step-ready`, `task.issue`, `task.reassigned`, `task.worker-request.<type>` | tasks | `auth/orderRoutes.js` | the member the change is for |
| `task.due-soon` | tasks | notification sweep | the assigned member |
| `task.overdue` | tasks | `email/overdueTaskReminders.js` | the assigned member |
| `worker-summary.morning`, `worker-summary.end-of-day` | tasks | `workerSummaryService.js` | the worker the summary is for |
| `order.confirmed`, `order.cancelled`, `order.delivered`, `order.changed` | orders | `auth/orderRoutes.js` | members with `orders.manage` at the order's location |
| `order.delivery-at-risk` | orders | notification sweep | members with `orders.manage` at the order's location |
| `quotation.sent` | orders | `auth/quotationService.js` | members with `orders.manage` at the order's location |
| `quotation.reminder` | orders | notification sweep | members with `orders.manage` at the order's location |
| `invoice.overdue` | finance | notification sweep | members with `invoices.manage` (at the invoice's location when it has one) |
| `payment.needs_review` | finance | `auth/invoicePaymentService.js` (an online payment the invoice can no longer take) | members with `payments.verify` (at the invoice's location when it has one) |
| `payment.recorded` | finance | `auth/paymentService.js` | members with `payments.view` (at the invoice's location when it has one) |
| `inquiry.new` | inquiries | `auth/inquiryService.js` | members with `inquiries.view` |
| `stock.low` | inventory | `auth/inventoryService.js` | members with `inventory.view` (at the material's location when it has one) |
| `schedule.published` | schedule | `auth/productionScheduleService.js` | the member whose task moved |
| `leave.requested`, `leave.collision` | schedule | `auth/workerScheduleService.js` (a worker's request; collision also when a manager adds or approves leave) | members with `workers.manage` at each location the worker is at; the owner and people who see every location when the worker has none |
| `leave.decided` | schedule | `auth/workerScheduleService.js` (approve or reject) | the worker the leave is for |
| `appointment.assigned`, `appointment.changed`, `appointment.cancelled` | schedule | `auth/appointmentService.js` | the member the appointment is assigned to |
| `schedule.overload` | schedule | staff sweep (`staffSweeps.js`) | members with `tasks.manage` at each location the worker is at (same rule as leave) |
| `installment.overdue` | finance | staff sweep (`staffSweeps.js`) | members with `invoices.manage` (at the invoice's location when it has one) |
| `appointment.reminder` | schedule | `appointmentReminderWorker.js` | the member named on the reminder |
| `subscription.trial_ended`, `.subscription_ended`, `.payment_overdue`, `.subscription_suspended` | billing | `subscriptionLifecycleService.js` | owners only |

The plan's own list of 22 triggers is not in the repo. Step-16a (below) adds the seven that were proposed for the first patch; customer-facing notifications, editable templates and a WhatsApp sender are step-16b to 16d.

## Step-16a: staff triggers for leave, appointments, overload and overdue installments

Written in `src/notifications/staffEvents.js` (the events) and `src/notifications/staffSweeps.js` (the two timer-driven ones). Everything goes through `notify()`, so channels, quiet hours and deduplication are the ones above. Target kind `leave` was added (migration `0039`); the web bell links it to `/workers/schedule`.

- **Who is told about a worker.** Leave managers and schedule managers are chosen per location the worker is assigned to (one `notify()` per location; a manager at two of them is told once, because the deduplication key is shared). A worker with no location is announced to the owner and to people with `locations.all`.
- **Never in the text:** the leave reason, an appointment's staff notes or cancellation reason, a customer's name. Leave and appointment text carries the worker's name or the appointment type and the time in the business time zone.
- **Deduplication keys:** `leave.requested:<leave>`, `leave.decided:<leave>:<approved|rejected>`, `leave.collision:<leave>:<pending|approved>`, `appointment.assigned:<appointment>`, `appointment.changed|cancelled:<appointment>:<moment>` (so a rebooked appointment can be announced again), `schedule.overload:<worker>:<local date>`, `installment.overdue:<plan>:<installment number>`.
- **Collisions** count planned tasks (`Scheduled`, `InProgress`, `Paused`) assigned to the worker that overlap the leave, at every location the worker works at; the manager's own collision panel narrows the list to the manager's locations.
- **Overload sweep** (every 15 minutes, once per business inside that business's context): runs only for plans with the shop-wide schedule; looks at the next 7 local days; a day with no capacity because of approved leave is a collision, not an overload.
- **Installment sweep:** for Active plans on Issued invoices with an installment dated before the business's local today, reads the plan against the invoice's payments and credit notes (`loadActivePlans`) and announces the oldest overdue installment. A later installment becoming overdue while the oldest stays unpaid does not send a second notice.
- **Limits:** the same as the other sweeps (a notice removed by retention can be raised again; at most 500 candidate plans per business per pass); `payment.needs_review` was already raised by step-15a and is now listed above.


## Delivery

| Channel | Table | Worker | Retry |
|---|---|---|---|
| In-app | `Notifications` | none (written directly) | none |
| E-mail from a notification | notification outbox, then `EmailOutbox` | `notificationOutboxWorker.js` then `email/dispatcher.js` | up to 6 attempts for the notification job; e-mail attempts per `EMAIL_MAX_ATTEMPTS` (default 6) |
| Push | `PushDeliveries` | `pushDeliveryWorker.js` | up to 6 attempts |

Retry delays follow `email/retryPolicy.js`: 30 seconds, 2 minutes, 8 minutes, about 32 minutes, about 2 hours, then 6 hours at most. Rows are leased (5 minutes) so two workers do not send the same row; a lease that expires makes the row available again. The outbox worker keeps a round-robin cursor so one busy business cannot use up every batch.

E-mail providers: `log` (never delivers; refused in production), `smtp`, `resend`. Resend delivery events return at `/api/webhooks/email/resend` and update the row; without `EMAIL_RESEND_WEBHOOK_SECRET` that endpoint is disabled and delivery status is not recorded.

Customer messages use separate outboxes and workers, with a consent check at queue time and again at send time. See `messaging-and-tenant-security.md`. Appointment reminders use `CustomerMessageOutbox`; order and payment messages (step-16b) use `CustomerEventOutbox`, described below.

## Step-16b: customer messages about an order or a payment

Written in `src/messaging/customerEvents.js` (queue and wording) and `src/messaging/customerEventWorker.js` (sending). SMS and WhatsApp only (decision 32: there is no e-mail consent record).

| Kind | Queued by | Sent only while |
|---|---|---|
| `order.amended` | the end of `POST /api/orders/:id/amend` (never for the dry-run preview) | the order is Confirmed, InProduction, Ready or Delivered |
| `order.ready` | `syncOrderFromTasks` in `auth/orderRoutes.js`, when the last task finishes and the order becomes Ready | the order is still Ready (a reopened task flips it back, and the next Ready moment has a new `ReadyAtUtc`, so a new key) |
| `payment.receipt` | `issueReceipt` in `auth/paymentService.js`, so manual, later-verified and online payments are all covered | the payment is Verified and the receipt is not voided |

- **Who gets it:** one row per channel and address with a current `OptedIn` record (with a consent time, no opt-out time) and no standing sender-wide stop. A customer with no such record gets nothing, which is normal. Consent is read again just before sending; a withdrawn consent also cancels waiting rows through a database trigger on `CustomerMessagingPreferences`.
- **What is stored:** references only (customer, channel, address, kind, order or payment id, dedupe key, status, attempts, lease). The text is built at send time from the order or payment as it is then, so no stale amount or date is sent. Dedupe keys: `order.amended:<order>:<order version>`, `order.ready:<order>:<ReadyAtUtc>`, `payment.receipt:<payment>`; the table's unique key is business, key, channel and address.
- **Text:** business name, order or receipt number, promised date and total (amended), delivery or collection (ready), amount, invoice number and balance (receipt). No staff notes, addresses or other customers' data. Every message ends with the opt-out line (SMS: "Reply STOP to opt out."; both channels: a personal unsubscribe link).
- **Delivery:** the same lease, retry and provider-refusal rules as the appointment reminders (`recipient_opted_out` records a standing stop and cancels). Statuses: Pending, Leased, Sent, Cancelled, Failed.
- **Staff view:** `GET /api/customers/:customerId/messages` (`customers.view`) lists the last 50 with the number masked; the customer page shows it as "Order and payment messages". Appointment reminders are not in that list.
- **Limits:** live Twilio and Meta delivery are unverified; WhatsApp is sent as four Meta-approved templates (step-16d, `WHATSAPP_SETUP.md`), so a shop's own wording applies to SMS only; there is no per-business switch (decision 39); retention of sent rows is not built.

## Reading notifications

`GET /api/notifications` (cursor paging, optional `unread` and `category`), `GET /api/notifications/unread-count`, `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`. The web bell polls the unread count every 60 seconds. Read notifications are purged after 90 days and unread after 180 (`purgeOldNotifications`, run by the sweep).

## Operating it

- Platform admins can list failed notification and push jobs and retry one: `/api/platform-admin/background-jobs` and `.../:id/retry` (web: platform-admin operations screen).
- All notification workers go through `forEachBusiness`; with row-level security a worker that sets no tenant would see nothing (tests: `workerTenantContext.test.js`, `rls-workers`).
- Known open item: after "Mark all read" on the web list, the confirmation message is cleared almost at once (`TODO.md`).

### Editable customer wording (step-16c)

The text of the four customer messages (order changed, order ready, payment receipt, appointment reminder) can be changed per channel under Settings, "Customer messages". Defaults live in code (`templateCatalog.js`); a saved wording lives in `NotificationTemplates`. Staff notifications raised through `notify()` are not editable. See `messaging-and-tenant-security.md`.

