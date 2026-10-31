import { randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { hasAtMostPlaces, subtractMoney } from '../money.js';
import { notify } from '../notifications/notificationService.js';
import { queueCustomerEvent } from '../messaging/customerEvents.js';

const methods = new Map([
  ['cash', 'Cash'],
  ['banktransfer', 'BankTransfer'],
  ['card', 'Card'],
  ['mobilemoney', 'MobileMoney'],
  ['other', 'Other'],
]);
const statuses = new Map([
  ['pending', 'Pending'],
  ['verified', 'Verified'],
  ['rejected', 'Rejected'],
  ['reversed', 'Reversed'],
]);

function paymentScope(user, allowed) {
  const params = [user.businessId];
  const conditions = ['p."BusinessId" = $1'];
  if (allowed !== null) {
    params.push(allowed);
    conditions.push(`i."OrderId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "Orders" scoped_order
      WHERE scoped_order."BusinessId" = i."BusinessId" AND scoped_order."Id" = i."OrderId"
        AND scoped_order."LocationId" = ANY($${params.length}::uuid[])
    )`);
  }
  return { params, conditions };
}

function dateOnly(value, field) {
  if (value == null) return null;
  const text = String(value);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== text) {
    throw AppError.badRequest('invalid_date', `${field} must be a valid date in YYYY-MM-DD format.`);
  }
  return text;
}

function dtoDate(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function referenceNow() {
  if (process.env.NODE_ENV === 'test' && process.env.AVZAR_NOW) return new Date(process.env.AVZAR_NOW);
  return new Date();
}

export function todayInZone(timeZoneId) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZoneId, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(referenceNow()).map(({ type, value }) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch (error) {
    if (error instanceof RangeError) return referenceNow().toISOString().slice(0, 10);
    throw error;
  }
}

function normalizeKey(value) {
  if (value == null) return null;
  const key = String(value).replaceAll('\0', '').trim();
  if (!key) return null;
  if (key.length > 100) throw AppError.badRequest('invalid_idempotency_key', 'Idempotency key is too long.');
  return key;
}

function parseMethod(value) {
  const method = methods.get(String(value ?? '').replaceAll(/[\s_-]/g, '').toLowerCase());
  if (!method) throw AppError.badRequest('invalid_method', 'Method must be Cash, BankTransfer, Card, MobileMoney or Other.');
  return method;
}

export async function requirePartialPaymentFeature(db, businessId) {
  const { rows } = await db.query(`
    SELECT COALESCE(override."Value", pe."Value", 'false') AS "Value"
    FROM "Plans" p
    LEFT JOIN "PlanEntitlements" pe ON pe."PlanId" = p."Id" AND pe."Key" = 'finance.partial_payments'
    LEFT JOIN LATERAL (
      SELECT o."Value" FROM "EntitlementOverrides" o
      WHERE o."BusinessId" = $1 AND o."Key" = 'finance.partial_payments'
        AND (o."ExpiresAtUtc" IS NULL OR o."ExpiresAtUtc" > now())
      ORDER BY o."CreatedAtUtc" DESC LIMIT 1
    ) override ON TRUE
    WHERE p."Id" = COALESCE(
      (SELECT s."PlanId" FROM "Subscriptions" s
        WHERE s."BusinessId" = $1 AND s."Status" <> 'Expired' LIMIT 1),
      (SELECT free."Id" FROM "Plans" free WHERE free."Code" = 'free' LIMIT 1)
    )`,
  [businessId]);
  if (!rows.length) throw new AppError(503, 'plans_not_seeded', 'Subscription plans are not configured on this server.');
  if (String(rows[0].Value ?? '').trim() !== 'true') {
    throw AppError.forbidden('feature_not_in_plan', 'Your current plan does not include deposits or partial payments.');
  }
}

async function business(pool, businessId) {
  const { rows } = await pool.query(`
    SELECT "TimeZoneId" FROM "Businesses" WHERE "Id" = $1`,
  [businessId]);
  if (!rows.length) throw AppError.notFound('business_not_found', 'Business not found.');
  return rows[0];
}

export async function recordAudit(db, user, action, entityId, details = null) {
  await db.query(`
    INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc",
      "DetailsJson", "EntityId", "EntityType")
    VALUES ($1, $2, $3, $4, now(), $5::jsonb, $6, 'Payment')`,
  [randomUUID(), action, user.userId, user.businessId,
    details === null ? null : JSON.stringify(details), entityId]);
}

export async function invoiceForPayment(db, user, invoiceId, allowed, { lock = false } = {}) {
  const params = [user.businessId, invoiceId];
  let locationCondition = '';
  if (allowed !== null) {
    params.push(allowed);
    locationCondition = `AND i."OrderId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "Orders" o WHERE o."BusinessId" = i."BusinessId" AND o."Id" = i."OrderId"
        AND o."LocationId" = ANY($3::uuid[])
    )`;
  }
  const { rows } = await db.query(`
    SELECT i."Id", i."Number", i."CustomerId", i."CurrencyCode", i."Status", i."Total", orderRow."LocationId",
      COALESCE((SELECT sum(p."Amount") FROM "Payments" p
        WHERE p."BusinessId" = i."BusinessId" AND p."InvoiceId" = i."Id" AND p."Status" = 'Verified'), 0) AS "AmountPaid",
      COALESCE((SELECT sum(cn."Amount") FROM "CreditNotes" cn
        WHERE cn."BusinessId" = i."BusinessId" AND cn."InvoiceId" = i."Id"), 0) AS "AmountCredited"
    FROM "Invoices" i
    LEFT JOIN "Orders" orderRow ON orderRow."BusinessId" = i."BusinessId" AND orderRow."Id" = i."OrderId"
    WHERE i."BusinessId" = $1 AND i."Id" = $2 ${locationCondition}${lock ? ' FOR UPDATE OF i' : ''}`,
  params);
  if (!rows.length) throw AppError.notFound('invoice_not_found', 'Invoice not found.');
  return rows[0];
}

async function paymentRow(db, user, paymentId, allowed, { lock = false } = {}) {
  const { params, conditions } = paymentScope(user, allowed);
  params.push(paymentId);
  conditions.push(`p."Id" = $${params.length}`);
  const { rows } = await db.query(`
    SELECT p.*, i."Number" AS "InvoiceNumber", r."Id" AS "ReceiptId", r."Number" AS "ReceiptNumber",
      p.xmin::text::bigint AS "Version"
    FROM "Payments" p
    JOIN "Invoices" i ON i."BusinessId" = p."BusinessId" AND i."Id" = p."InvoiceId"
    LEFT JOIN "Receipts" r ON r."BusinessId" = p."BusinessId" AND r."PaymentId" = p."Id"
    WHERE ${conditions.join(' AND ')}${lock ? ' FOR UPDATE OF p' : ''}`,
  params);
  if (!rows.length) throw AppError.notFound('payment_not_found', 'Payment not found.');
  return rows[0];
}

function paymentDto(row) {
  return {
    id: row.Id,
    invoiceId: row.InvoiceId,
    invoiceNumber: row.InvoiceNumber,
    customerId: row.CustomerId,
    amount: Number(row.Amount),
    currencyCode: row.CurrencyCode,
    method: row.Method,
    reference: row.Reference,
    receivedOn: dtoDate(row.ReceivedOn),
    status: row.Status,
    notes: row.Notes,
    statusReason: row.StatusReason,
    recordedByUserId: row.RecordedByUserId,
    verifiedByUserId: row.VerifiedByUserId,
    verifiedAtUtc: row.VerifiedAtUtc,
    receiptId: row.ReceiptId,
    receiptNumber: row.ReceiptNumber,
    version: Number(row.Version),
    createdAtUtc: new Date(row.CreatedAtUtc).toISOString(),
  };
}

async function receiptNumber(db, businessId, year) {
  const { rows } = await db.query(`
    INSERT INTO "DocumentCounters" ("BusinessId", "Kind", "Year", "LastValue")
    VALUES ($1, 'receipt', $2, 1)
    ON CONFLICT ("BusinessId", "Kind", "Year")
    DO UPDATE SET "LastValue" = "DocumentCounters"."LastValue" + 1
    RETURNING "LastValue"`,
  [businessId, year]);
  return `RCT-${year}-${String(rows[0].LastValue).padStart(5, '0')}`;
}

export async function issueReceipt(db, user, payment, invoice, balanceBefore, today) {
  const id = randomUUID();
  const number = await receiptNumber(db, user.businessId, Number(today.slice(0, 4)));
  const balanceAfter = subtractMoney(balanceBefore, payment.Amount);
  await db.query(`
    INSERT INTO "Receipts" ("Id", "Amount", "BalanceAfter", "BusinessId", "CreatedAtUtc",
      "InvoiceId", "IssuedAtUtc", "Number", "PaymentId")
    VALUES ($1, $2, $3, $4, now(), $5, now(), $6, $7)`,
  [id, payment.Amount, balanceAfter, user.businessId, invoice.Id, number, payment.Id]);
  // Step 16b: a customer who opted in gets the receipt by SMS or WhatsApp. This covers a payment recorded and verified at once,
  // one verified later, and an online payment, because all three issue their receipt here.
  await queueCustomerEvent(db, {
    businessId: user.businessId, customerId: invoice.CustomerId, kind: 'payment.receipt', subjectId: payment.Id, dedupeKey: `payment.receipt:${payment.Id}`,
  });
  return { id, number, balanceAfter };
}

async function paymentByKey(pool, user, key, allowed) {
  const { rows } = await pool.query(`
    SELECT p."Id", p."InvoiceId", p."Amount", p.xmin::text::bigint AS "Version"
    FROM "Payments" p
    WHERE p."BusinessId" = $1 AND p."IdempotencyKey" = $2`,
  [user.businessId, key]);
  if (!rows.length) return null;
  const existing = await paymentRow(pool, user, rows[0].Id, allowed);
  return { existing, version: rows[0].Version };
}

export async function recordPayment(pool, transaction, user, invoiceId, payload, idempotencyKey, allowed) {
  const key = normalizeKey(idempotencyKey);
  if (key) {
    const found = await paymentByKey(pool, user, key, allowed);
    if (found) {
      if (found.existing.InvoiceId !== invoiceId || Number(found.existing.Amount) !== payload.amount) {
        throw AppError.conflict('idempotency_key_reused', 'That idempotency key was already used for a different payment.');
      }
      return { payment: paymentDto(found.existing), created: false };
    }
  }
  const method = parseMethod(payload.method);
  if (payload.amount <= 0 || !hasAtMostPlaces(payload.amount, 2)) {
    throw AppError.badRequest('invalid_amount', 'Amounts must be above zero and have at most 2 decimal places.');
  }
  const { TimeZoneId } = await business(pool, user.businessId);
  const today = todayInZone(TimeZoneId);
  const receivedOn = dateOnly(payload.receivedOn, 'receivedOn') ?? today;
  if (receivedOn > today) throw AppError.badRequest('received_in_future', 'A payment cannot be dated in the future.');
  const canVerifyNow = payload.verifyNow && (user.isOwner || user.permissions.includes('payments.verify'));
  try {
    return await transaction(pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invoice:${invoiceId}`]);
      const invoice = await invoiceForPayment(db, user, invoiceId, allowed, { lock: true });
      if (invoice.Status !== 'Issued') {
        throw AppError.conflict('invoice_not_payable',
          `Payments can only be recorded against issued invoices (this one is ${invoice.Status}).`);
      }
      const balance = subtractMoney(invoice.Total, invoice.AmountPaid, invoice.AmountCredited);
      if (payload.amount > balance) {
        throw AppError.conflict('overpayment', `The payment (${payload.amount}) is more than the amount still owed (${balance}).`);
      }
      if (payload.amount < balance) await requirePartialPaymentFeature(db, user.businessId);
      const paymentId = randomUUID();
      let verification = { verifierId: null, verifiedAt: null };
      if (canVerifyNow) verification = { verifierId: user.userId, verifiedAt: new Date() };
      const status = canVerifyNow ? 'Verified' : 'Pending';
      const { rows } = await db.query(`
        INSERT INTO "Payments" ("Id", "Amount", "BusinessId", "CreatedAtUtc", "CurrencyCode",
          "CustomerId", "IdempotencyKey", "InvoiceId", "Method", "Notes", "ReceivedOn",
          "RecordedByUserId", "Reference", "Status", "VerifiedAtUtc", "VerifiedByUserId")
        VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9, $10::date, $11, $12, $13, $14, $15)
        RETURNING *, xmin::text::bigint AS "Version"`,
      [paymentId, payload.amount, user.businessId, invoice.CurrencyCode, invoice.CustomerId, key,
        invoiceId, method, payload.notes?.trim() || null, receivedOn, user.userId,
        payload.reference?.trim() || null, status, verification.verifiedAt, verification.verifierId]);
      const payment = rows[0];
      await recordAudit(db, user, 'payment.recorded', paymentId, {
        invoice: invoice.Number, amount: payload.amount, method, verifyNow: canVerifyNow,
      });
      await notify(db, {
        businessId: user.businessId, category: 'finance', eventType: 'payment.recorded', title: 'Payment recorded',
        body: `A payment was recorded for invoice ${invoice.Number}.`, dedupeKey: `payment.recorded:${paymentId}`,
        target: { kind: 'payment', id: paymentId },
        recipients: invoice.LocationId
          ? { permission: 'payments.view', locationId: invoice.LocationId }
          : { permission: 'payments.view', locationlessOnly: true },
        actorUserId: user.userId,
        email: {
          templateKey: 'payment.recorded', subject: 'A payment was recorded',
          text: () => `A payment was recorded for invoice ${invoice.Number}. Open Avzar to review it.`,
        },
      });
      if (canVerifyNow) await issueReceipt(db, user, payment, invoice, balance, today);
      const saved = await paymentRow(db, user, paymentId, allowed);
      return { payment: paymentDto(saved), created: true };
    });
  } catch (error) {
    if (key && error.code === '23505') {
      const winner = await paymentByKey(pool, user, key, allowed);
      if (!winner) throw error;
      if (winner.existing.InvoiceId !== invoiceId || Number(winner.existing.Amount) !== payload.amount) {
        throw AppError.conflict('idempotency_key_reused', 'That idempotency key was already used for a different payment.');
      }
      return { payment: paymentDto(winner.existing), created: false };
    }
    throw error;
  }
}

export async function listPayments(pool, user, query, allowed) {
  const { params, conditions } = paymentScope(user, allowed);
  if (query.invoiceId) {
    params.push(query.invoiceId);
    conditions.push(`p."InvoiceId" = $${params.length}`);
  }
  if (query.customerId) {
    params.push(query.customerId);
    conditions.push(`p."CustomerId" = $${params.length}`);
  }
  if (query.status) {
    const status = statuses.get(query.status.toLowerCase());
    if (!status) throw AppError.badRequest('invalid_status', 'Status must be Pending, Verified, Rejected or Reversed.');
    params.push(status);
    conditions.push(`p."Status" = $${params.length}`);
  }
  if (query.from) {
    params.push(query.from);
    conditions.push(`p."ReceivedOn" >= $${params.length}::date`);
  }
  if (query.to) {
    params.push(query.to);
    conditions.push(`p."ReceivedOn" <= $${params.length}::date`);
  }
  const where = conditions.join(' AND ');
  const count = await pool.query(`
    SELECT count(*)::int AS "TotalCount" FROM "Payments" p
    JOIN "Invoices" i ON i."BusinessId" = p."BusinessId" AND i."Id" = p."InvoiceId"
    WHERE ${where}`,
  params);
  const { rows } = await pool.query(`
    SELECT p.*, i."Number" AS "InvoiceNumber", r."Id" AS "ReceiptId", r."Number" AS "ReceiptNumber",
      p.xmin::text::bigint AS "Version"
    FROM "Payments" p
    JOIN "Invoices" i ON i."BusinessId" = p."BusinessId" AND i."Id" = p."InvoiceId"
    LEFT JOIN "Receipts" r ON r."BusinessId" = p."BusinessId" AND r."PaymentId" = p."Id"
    WHERE ${where}
    ORDER BY p."ReceivedOn" DESC, p."CreatedAtUtc" DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
  [...params, query.pageSize, (query.page - 1) * query.pageSize]);
  return {
    items: rows.map(paymentDto),
    page: query.page,
    pageSize: query.pageSize,
    totalCount: Number(count.rows[0]?.TotalCount ?? 0),
  };
}

export async function getPayment(pool, user, id, allowed) {
  return paymentDto(await paymentRow(pool, user, id, allowed));
}

async function loadForTransition(pool, transaction, user, id, allowed, operation) {
  const visible = await paymentRow(pool, user, id, allowed);
  return transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invoice:${visible.InvoiceId}`]);
    const invoice = await invoiceForPayment(db, user, visible.InvoiceId, allowed, { lock: true });
    const payment = await paymentRow(db, user, id, allowed, { lock: true });
    return operation(db, payment, invoice);
  });
}

export async function verifyPayment(pool, transaction, user, id, allowed) {
  const { TimeZoneId } = await business(pool, user.businessId);
  const today = todayInZone(TimeZoneId);
  return loadForTransition(pool, transaction, user, id, allowed, async (db, payment, invoice) => {
    if (payment.Status !== 'Pending') {
      throw AppError.conflict('invalid_transition', `Only pending payments can be verified (this one is ${payment.Status}).`);
    }
    if (invoice.Status !== 'Issued') {
      throw AppError.conflict('invoice_not_payable', `The invoice is ${invoice.Status}, so this payment cannot be verified.`);
    }
    const balance = subtractMoney(invoice.Total, invoice.AmountPaid, invoice.AmountCredited);
    if (Number(payment.Amount) > balance) {
      throw AppError.conflict('overpayment', `Verifying this payment (${payment.Amount}) would exceed what is still owed (${balance}).`);
    }
    if (Number(payment.Amount) < balance) await requirePartialPaymentFeature(db, user.businessId);
    const verifiedAt = new Date();
    const { rows } = await db.query(`
      UPDATE "Payments" SET "Status" = 'Verified', "VerifiedByUserId" = $1,
        "VerifiedAtUtc" = $2, "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $3 AND "Id" = $4 AND xmin::text::bigint = $5 AND "Status" = 'Pending'
      RETURNING *`,
    [user.userId, verifiedAt, user.businessId, id, payment.Version]);
    if (!rows.length) throw AppError.conflict('stale_version', 'This payment was changed by someone else. Reload and try again.');
    await issueReceipt(db, user, rows[0], invoice, balance, today);
    await recordAudit(db, user, 'payment.verified', id, { invoice: invoice.Number, amount: payment.Amount });
    return paymentDto(await paymentRow(db, user, id, allowed));
  });
}

export async function rejectPayment(pool, transaction, user, id, reason, allowed) {
  return loadForTransition(pool, transaction, user, id, allowed, async (db, payment, invoice) => {
    if (payment.Status !== 'Pending') {
      throw AppError.conflict('invalid_transition', `Only pending payments can be rejected (this one is ${payment.Status}).`);
    }
    const { rows } = await db.query(`
      UPDATE "Payments" SET "Status" = 'Rejected', "StatusReason" = $1, "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $2 AND "Id" = $3 AND xmin::text::bigint = $4 AND "Status" = 'Pending'
      RETURNING "Id"`,
    [reason.trim(), user.businessId, id, payment.Version]);
    if (!rows.length) throw AppError.conflict('stale_version', 'This payment was changed by someone else. Reload and try again.');
    await recordAudit(db, user, 'payment.rejected', id, { invoice: invoice.Number, reason: reason.trim() });
    return paymentDto(await paymentRow(db, user, id, allowed));
  });
}

export async function reversePayment(pool, transaction, user, id, reason, allowed) {
  return loadForTransition(pool, transaction, user, id, allowed, async (db, payment, invoice) => {
    if (payment.Status !== 'Verified') {
      throw AppError.conflict('invalid_transition', `Only verified payments can be reversed (this one is ${payment.Status}).`);
    }
    const { rows } = await db.query(`
      UPDATE "Payments" SET "Status" = 'Reversed', "StatusReason" = $1, "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $2 AND "Id" = $3 AND xmin::text::bigint = $4 AND "Status" = 'Verified'
      RETURNING "Id"`,
    [reason.trim(), user.businessId, id, payment.Version]);
    if (!rows.length) throw AppError.conflict('stale_version', 'This payment was changed by someone else. Reload and try again.');
    await db.query(`
      UPDATE "Receipts" SET "VoidedAtUtc" = now(), "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $1 AND "PaymentId" = $2 AND "VoidedAtUtc" IS NULL`,
    [user.businessId, id]);
    await recordAudit(db, user, 'payment.reversed', id, {
      invoice: invoice.Number, amount: payment.Amount, reason: reason.trim(),
    });
    return paymentDto(await paymentRow(db, user, id, allowed));
  });
}

async function receiptRow(db, user, receiptId, allowed) {
  const params = [user.businessId, receiptId];
  let scope = '';
  if (allowed !== null) {
    params.push(allowed);
    scope = `AND i."OrderId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "Orders" o WHERE o."BusinessId" = i."BusinessId" AND o."Id" = i."OrderId"
        AND o."LocationId" = ANY($3::uuid[])
    )`;
  }
  const { rows } = await db.query(`
    SELECT r.*, i."Number" AS "InvoiceNumber", i."CustomerId", i."CurrencyCode",
      c."FullName" AS "CustomerName", p."Method", p."Reference"
    FROM "Receipts" r
    JOIN "Invoices" i ON i."BusinessId" = r."BusinessId" AND i."Id" = r."InvoiceId"
    JOIN "Payments" p ON p."BusinessId" = r."BusinessId" AND p."Id" = r."PaymentId"
    LEFT JOIN "Customers" c ON c."BusinessId" = i."BusinessId" AND c."Id" = i."CustomerId"
    WHERE r."BusinessId" = $1 AND r."Id" = $2 ${scope}`,
  params);
  if (!rows.length) throw AppError.notFound('receipt_not_found', 'Receipt not found.');
  return rows[0];
}

function receiptDto(row) {
  return {
    id: row.Id,
    number: row.Number,
    paymentId: row.PaymentId,
    invoiceId: row.InvoiceId,
    invoiceNumber: row.InvoiceNumber,
    customerId: row.CustomerId,
    customerName: row.CustomerName ?? '',
    currencyCode: row.CurrencyCode,
    amount: Number(row.Amount),
    method: row.Method,
    reference: row.Reference,
    balanceAfter: Number(row.BalanceAfter),
    issuedAtUtc: new Date(row.IssuedAtUtc).toISOString(),
    isVoid: row.VoidedAtUtc !== null,
  };
}

export async function getReceipt(pool, user, id, allowed) {
  return receiptDto(await receiptRow(pool, user, id, allowed));
}

export async function getReceiptForPayment(pool, user, paymentId, allowed) {
  const payment = await paymentRow(pool, user, paymentId, allowed);
  const { rows } = await pool.query(`
    SELECT "Id" FROM "Receipts" WHERE "BusinessId" = $1 AND "PaymentId" = $2`,
  [user.businessId, payment.Id]);
  if (!rows.length) throw AppError.notFound('receipt_not_found', 'This payment has no receipt. Only verified payments get one.');
  return getReceipt(pool, user, rows[0].Id, allowed);
}
