// Step 16b: customer messages about an order or a payment. This file queues them (inside the transaction of the event that causes them)
// and builds their text; customerEventWorker.js sends them. Only SMS and WhatsApp, only to a customer with a current OptedIn record
// and no standing sender-wide stop, checked here AND again just before sending.

import { buildMessageText } from './templateCatalog.js';

export const CUSTOMER_EVENT_KINDS = Object.freeze(['order.amended', 'order.ready', 'payment.receipt']);

const QUEUE_SQL = `
  INSERT INTO "CustomerEventOutbox" ("Id", "BusinessId", "CustomerId", "Channel", "Address", "Kind", "SubjectId", "DedupeKey")
  SELECT gen_random_uuid(), p."BusinessId", p."CustomerId", p."Channel", p."Address", $3, $4, $5
  FROM "CustomerMessagingPreferences" p
  WHERE p."BusinessId" = $1 AND p."CustomerId" = $2
    AND p."ConsentStatus" = 'OptedIn' AND p."ConsentedAtUtc" IS NOT NULL AND p."OptedOutAtUtc" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "MessagingSuppressions" s
      WHERE s."Channel" = p."Channel" AND lower(s."Address") = lower(p."Address") AND s."LiftedAtUtc" IS NULL)
  ON CONFLICT ("BusinessId", "DedupeKey", "Channel", "Address") DO NOTHING
  RETURNING "Id"`;

/**
 * Queues one message per consenting channel and address of the customer, in the caller's transaction. Safe to repeat: the same
 * dedupe key never queues twice for the same channel and address. Returns how many rows were queued (0 for a customer who has not
 * opted in, which is the normal case and not an error).
 */
export async function queueCustomerEvent(db, { businessId, customerId, kind, subjectId, dedupeKey }) {
  if (!CUSTOMER_EVENT_KINDS.includes(kind)) throw new TypeError(`Unknown customer event: ${kind}`);
  if (!businessId || !customerId || !subjectId) return 0;
  const { rows } = await db.query(QUEUE_SQL, [businessId, customerId, kind, subjectId, String(dedupeKey).slice(0, 160)]);
  return rows?.length ?? 0;
}

const ORDER_SQL = `
  SELECT o."OrderNumber", o."Status", o."PromisedDate"::text AS "PromisedDate", o."Total"::text AS "Total", o."DeliveryMethod",
    b."Name" AS "BusinessName", b."CurrencyCode"
  FROM "Orders" o JOIN "Businesses" b ON b."Id" = o."BusinessId"
  WHERE o."BusinessId" = $1 AND o."Id" = $2 AND o."CustomerId" = $3 AND b."IsActive" = TRUE`;

const RECEIPT_SQL = `
  SELECT r."Number", r."Amount"::text AS "Amount", r."BalanceAfter"::text AS "BalanceAfter", r."VoidedAtUtc", p."Status" AS "PaymentStatus",
    i."Number" AS "InvoiceNumber", i."CurrencyCode", b."Name" AS "BusinessName"
  FROM "Receipts" r
  JOIN "Payments" p ON p."Id" = r."PaymentId" AND p."BusinessId" = r."BusinessId"
  JOIN "Invoices" i ON i."Id" = r."InvoiceId" AND i."BusinessId" = r."BusinessId"
  JOIN "Businesses" b ON b."Id" = r."BusinessId"
  WHERE r."BusinessId" = $1 AND r."PaymentId" = $2 AND i."CustomerId" = $3 AND b."IsActive" = TRUE`;

const SENDABLE_AFTER_AMENDMENT = Object.freeze(['Confirmed', 'InProduction', 'Ready', 'Delivered']);

/** "12 Nov 2026" from "2026-11-12" (a calendar date, never shifted by a time zone). */
export function formatDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  if (!match) return '';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
}

const money = (currency, amount) => `${currency} ${amount}`;

/**
 * Looks at the order or payment as it is now. Returns { eligible: false } when the message should no longer be sent (an amended
 * order that was cancelled since, an order that is no longer Ready, a payment that was reversed), otherwise { eligible: true, kind, values, text } (values feed the WhatsApp template).
 * The opt-out line is added by the caller.
 */
export async function describeCustomerEvent(db, job) {
  // Step 16c: the facts are read first (as before); the wording is the business's saved text for this kind and channel, else the default.
  // A job with no channel (older callers) uses the default.
  const text = (kind, values) => buildMessageText(db, { businessId: job.BusinessId, kind, channel: job.Channel, values });
  if (job.Kind === 'payment.receipt') {
    const { rows } = await db.query(RECEIPT_SQL, [job.BusinessId, job.SubjectId, job.CustomerId]);
    const row = rows[0];
    if (!row || row.VoidedAtUtc || row.PaymentStatus !== 'Verified') return { eligible: false };
    const settled = Number(row.BalanceAfter) <= 0;
    const balanceLine = settled ? 'Your invoice is now fully paid.' : `Balance remaining: ${money(row.CurrencyCode, row.BalanceAfter)}.`;
    const values = { business: row.BusinessName, receipt: row.Number, invoice: row.InvoiceNumber, amount: money(row.CurrencyCode, row.Amount), balance_line: balanceLine };
    return { eligible: true, kind: job.Kind, values, text: await text('payment.receipt', values) };
  }
  const { rows } = await db.query(ORDER_SQL, [job.BusinessId, job.SubjectId, job.CustomerId]);
  const order = rows[0];
  if (!order) return { eligible: false };
  if (job.Kind === 'order.ready') {
    if (order.Status !== 'Ready') return { eligible: false };
    const nextStep = order.DeliveryMethod === 'Delivery' ? 'Contact us to arrange delivery.' : 'It is ready for collection.';
    const values = { business: order.BusinessName, order: order.OrderNumber, next_step: nextStep };
    return { eligible: true, kind: job.Kind, values, text: await text('order.ready', values) };
  }
  if (job.Kind === 'order.amended') {
    if (!SENDABLE_AFTER_AMENDMENT.includes(order.Status)) return { eligible: false };
    const values = { business: order.BusinessName, order: order.OrderNumber, promised_date: formatDateOnly(order.PromisedDate), total: money(order.CurrencyCode, order.Total) };
    return { eligible: true, kind: job.Kind, values, text: await text('order.amended', values) };
  }
  return { eligible: false };
}
