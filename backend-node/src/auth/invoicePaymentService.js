import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { bindTenantByLookup } from '../db/tenantLookup.js';
import { withFreshTenantContext } from '../db/forEachBusiness.js';
import { hasAtMostPlaces, subtractMoney, toCents } from '../money.js';
import { notify } from '../notifications/notificationService.js';
import { withTransaction } from './accountService.js';
import { invoiceForPayment, issueReceipt, recordAudit, requirePartialPaymentFeature, todayInZone } from './paymentService.js';

// Step 15a: a customer pays an issued invoice (or a deposit on it) online. The money goes straight to the business's own Paystack
// subaccount. An attempt is only a record of a link that was handed out; the invoice balance changes only when the provider's webhook
// is signed, matches an attempt, and the provider confirms the amount and currency when asked again.

export const INVOICE_PAYMENT_WEBHOOK_PATH = '/api/invoice-payments/webhook';
export const INVOICE_REFERENCE_PREFIX = 'avzar_inv_';
// Payments.VerifiedByUserId has no foreign key and a verified payment must name a verifier; a payment the provider confirmed has no staff
// verifier, so it carries this fixed ID. It never matches a real user.
export const PROVIDER_VERIFIER_ID = '00000000-0000-4000-8000-00000000fa11';
const ATTEMPT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex').toUpperCase(); // same casing as CustomerPortalGrants.TokenHash
const minor = (value) => Number(toCents(value));

function attemptDto(row) {
  return {
    id: row.Id, invoiceId: row.InvoiceId, amount: Number(row.Amount), currencyCode: row.CurrencyCode, status: row.Status,
    source: row.Source, authorizationUrl: row.Status === 'Pending' ? row.AuthorizationUrl : null,
    expiresAtUtc: new Date(row.ExpiresAtUtc).toISOString(), paymentId: row.PaymentId,
    createdAtUtc: new Date(row.CreatedAtUtc).toISOString(),
  };
}

function requireProvider(provider) {
  if (!provider?.isConfigured?.()) throw new AppError(503, 'payments_unavailable', 'Online payments are not available right now.');
}

// ---------------------------------------------------------------- the business's payout account

export async function getPaymentAccount(pool, user) {
  const { rows } = await pool.query('SELECT "PaymentSubaccountCode" FROM "Businesses" WHERE "Id" = $1', [user.businessId]);
  if (!rows.length) throw AppError.notFound('business_not_found', 'Business not found.');
  return { configured: Boolean(rows[0].PaymentSubaccountCode) };
}

export async function listPaymentBanks(provider) {
  requireProvider(provider);
  return { items: await provider.listBanks() };
}

/** The account number goes to the provider once and is never stored or logged; only the provider's subaccount code is kept. */
export async function savePaymentAccount(pool, provider, user, { bankCode, accountNumber }) {
  requireProvider(provider);
  if (!/^[0-9]{3,10}$/.test(bankCode)) throw AppError.badRequest('invalid_bank_code', 'Choose a bank from the list.');
  if (!/^[0-9]{10}$/.test(accountNumber)) throw AppError.badRequest('invalid_account_number', 'Enter the 10-digit account number.');
  const { rows } = await pool.query('SELECT "Name" FROM "Businesses" WHERE "Id" = $1', [user.businessId]);
  if (!rows.length) throw AppError.notFound('business_not_found', 'Business not found.');
  const created = await provider.createSubaccount({ businessName: rows[0].Name, bankCode, accountNumber });
  await withTransaction(pool, async (db) => {
    await db.query('UPDATE "Businesses" SET "PaymentSubaccountCode" = $2 WHERE "Id" = $1', [user.businessId, created.subaccountCode]);
    await db.query(`INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityId", "EntityType")
      VALUES ($1, 'business.payment_account_saved', $2, $3, now(), $4::jsonb, $3, 'Business')`,
    [randomUUID(), user.userId, user.businessId, JSON.stringify({ bankCode })]);
  });
  return { configured: true, accountName: created.accountName ?? null };
}

// ---------------------------------------------------------------- start a payment

/**
 * Starts (or returns the open) online payment for an issued invoice. `context` is either a staff member (userId, allowed locations)
 * or a portal customer (customerId): the portal may only pay its own customer's invoices.
 */
export async function startInvoicePayment(pool, provider, context, invoiceId, { amount, idempotencyKey, callbackUrl } = {}) {
  requireProvider(provider);
  const key = typeof idempotencyKey === 'string' && idempotencyKey.trim() ? idempotencyKey.trim().slice(0, 100) : null;
  if (amount != null && (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || !hasAtMostPlaces(amount, 2))) {
    throw AppError.badRequest('invalid_amount', 'Amounts must be above zero and have at most 2 decimal places.');
  }
  const user = { businessId: context.businessId, userId: context.userId ?? null };
  const prepared = await withTransaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invoice:${invoiceId}`]);
    const invoice = await invoiceForPayment(db, user, invoiceId, context.allowed ?? null, { lock: true });
    if (context.customerId && invoice.CustomerId !== context.customerId) throw AppError.notFound('invoice_not_found', 'Invoice not found.');
    if (invoice.Status !== 'Issued') throw AppError.conflict('invoice_not_payable', `Only issued invoices can be paid online (this one is ${invoice.Status}).`);
    const balance = subtractMoney(invoice.Total, invoice.AmountPaid, invoice.AmountCredited);
    const payAmount = amount ?? balance;
    if (payAmount <= 0) throw AppError.conflict('nothing_owed', 'This invoice has nothing left to pay.');
    if (payAmount > balance) throw AppError.conflict('overpayment', `The amount (${payAmount}) is more than the amount still owed (${balance}).`);
    if (payAmount < balance) await requirePartialPaymentFeature(db, user.businessId);

    if (key) {
      const { rows } = await db.query('SELECT * FROM "InvoicePaymentAttempts" WHERE "BusinessId" = $1 AND "IdempotencyKey" = $2', [user.businessId, key]);
      if (rows.length) {
        if (rows[0].InvoiceId !== invoiceId || Number(rows[0].Amount) !== payAmount) {
          throw AppError.conflict('idempotency_key_reused', 'That idempotency key was already used for a different payment.');
        }
        return { existing: rows[0] };
      }
    }
    // An open, unexpired link for the same invoice and amount is reused, so repeated taps never pile up attempts.
    const { rows: open } = await db.query(`SELECT * FROM "InvoicePaymentAttempts"
      WHERE "BusinessId" = $1 AND "InvoiceId" = $2 AND "Status" = 'Pending' AND "Amount" = $3 AND "ExpiresAtUtc" > now() AND "AuthorizationUrl" IS NOT NULL
      ORDER BY "CreatedAtUtc" DESC LIMIT 1`, [user.businessId, invoiceId, payAmount]);
    if (open.length) return { existing: open[0] };

    const { rows: setup } = await db.query(`SELECT b."PaymentSubaccountCode", c."Email" FROM "Businesses" b
      JOIN "Customers" c ON c."Id" = $2 AND c."BusinessId" = b."Id" WHERE b."Id" = $1`, [user.businessId, invoice.CustomerId]);
    if (!setup[0]?.PaymentSubaccountCode) throw AppError.conflict('online_payments_not_set_up', 'Online payments are not set up for this business yet.');
    if (!setup[0].Email) throw AppError.conflict('customer_email_required', 'Add an email address to this customer before taking an online payment.');
    const attemptId = randomUUID();
    const reference = `${INVOICE_REFERENCE_PREFIX}${randomBytes(12).toString('hex')}`;
    await db.query(`INSERT INTO "InvoicePaymentAttempts" ("Id", "BusinessId", "InvoiceId", "CustomerId", "Reference", "Amount", "CurrencyCode",
        "Status", "Source", "IdempotencyKey", "RequestedByUserId", "ExpiresAtUtc")
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending', $8, $9, $10, $11)`,
    [attemptId, user.businessId, invoiceId, invoice.CustomerId, reference, payAmount, invoice.CurrencyCode,
      context.customerId ? 'Portal' : 'Staff', key, context.userId ?? null, new Date(Date.now() + ATTEMPT_LIFETIME_MS)]);
    return { attemptId, reference, payAmount, currency: invoice.CurrencyCode, email: setup[0].Email, subaccount: setup[0].PaymentSubaccountCode, number: invoice.Number };
  });
  if (prepared.existing) return { attempt: attemptDto(prepared.existing), created: false };

  // The provider call is made outside the database transaction. If it fails the attempt is closed as Failed, never left open.
  let authorizationUrl;
  try {
    ({ authorizationUrl } = await provider.initialize({
      email: prepared.email, amountMinor: minor(prepared.payAmount), currency: prepared.currency, reference: prepared.reference,
      subaccount: prepared.subaccount, ...(callbackUrl ? { callbackUrl } : {}), metadata: { kind: 'invoice', attemptId: prepared.attemptId, invoiceNumber: prepared.number },
    }));
  } catch (error) {
    await pool.query(`UPDATE "InvoicePaymentAttempts" SET "Status" = 'Failed', "FailureReason" = 'provider_error', "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $1 AND "Id" = $2 AND "Status" = 'Pending'`, [user.businessId, prepared.attemptId]);
    throw error;
  }
  const { rows } = await pool.query(`UPDATE "InvoicePaymentAttempts" SET "AuthorizationUrl" = $3, "UpdatedAtUtc" = now()
    WHERE "BusinessId" = $1 AND "Id" = $2 RETURNING *`, [user.businessId, prepared.attemptId, authorizationUrl]);
  return { attempt: attemptDto(rows[0]), created: true };
}

/** Staff view of an invoice's attempts (newest first). Location scope follows the invoice's order, as for payments. */
export async function listInvoicePaymentAttempts(pool, user, invoiceId, allowed) {
  await invoiceForPayment(pool, user, invoiceId, allowed);
  const { rows } = await pool.query(`SELECT * FROM "InvoicePaymentAttempts" WHERE "BusinessId" = $1 AND "InvoiceId" = $2
    ORDER BY "CreatedAtUtc" DESC LIMIT 50`, [user.businessId, invoiceId]);
  return { items: rows.map(attemptDto) };
}

/** The portal token is the credential. Returns the customer and business it names, or the same 404 for every kind of bad token. */
export async function portalContextForToken(pool, token) {
  const notFound = () => AppError.notFound('portal_link_unavailable', 'This link is no longer available.');
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) throw notFound();
  const tokenHash = sha256(token);
  await bindTenantByLookup(pool, 'portal_token_hash', tokenHash);
  const { rows } = await pool.query(`SELECT "BusinessId", "CustomerId" FROM "CustomerPortalGrants"
    WHERE "TokenHash" = $1 AND "RevokedAtUtc" IS NULL AND "ExpiresAtUtc" > now()`, [tokenHash]);
  if (!rows.length) throw notFound();
  return { businessId: rows[0].BusinessId, customerId: rows[0].CustomerId };
}

// ---------------------------------------------------------------- webhook

/** Returns the HTTP status for the webhook response. A payment is applied only after the provider confirms it a second time. */
export async function handleInvoicePaymentWebhook(pool, provider, rawBody, signature, log = console) {
  if (!provider?.isConfigured?.() || !provider.verifySignature(rawBody, signature)) return 401;
  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch { return 400; }
  if (event?.event !== 'charge.success') return 200;
  const reference = event?.data?.reference;
  if (typeof reference !== 'string' || !reference.startsWith(INVOICE_REFERENCE_PREFIX)) return 200;

  return withFreshTenantContext(pool, async () => {
    await bindTenantByLookup(pool, 'invoice_payment_reference', reference);
    const { rows } = await pool.query('SELECT "Id", "Amount", "CurrencyCode", "Status" FROM "InvoicePaymentAttempts" WHERE "Reference" = $1', [reference]);
    if (!rows.length) {
      // A correctly signed payment that matches nothing must not be acknowledged silently: a non-2xx makes the provider retry, and the log
      // makes a permanent mismatch findable.
      log.error?.(JSON.stringify({ level: 'error', event: 'invoice_payment_webhook_unmatched_reference', reference }));
      return 404;
    }
    const attempt = rows[0];
    if (attempt.Status === 'Paid') return 200;
    let verified;
    try { verified = await provider.verify(reference); } catch { return 502; }
    if (verified.reference !== reference || verified.currency !== attempt.CurrencyCode || verified.amountMinor !== minor(attempt.Amount)) return 400;
    if (verified.status !== 'success') return 400;

    await withTransaction(pool, async (db) => {
      const { rows: locked } = await db.query('SELECT * FROM "InvoicePaymentAttempts" WHERE "Id" = $1 FOR UPDATE', [attempt.Id]);
      const row = locked[0];
      if (!row || row.Status === 'Paid') return;
      const user = { businessId: row.BusinessId, userId: null };
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invoice:${row.InvoiceId}`]);
      const invoice = await invoiceForPayment(db, user, row.InvoiceId, null, { lock: true });
      const balance = subtractMoney(invoice.Total, invoice.AmountPaid, invoice.AmountCredited);
      const amount = Number(row.Amount);
      if (invoice.Status !== 'Issued' || amount > balance) {
        // The customer has paid money the invoice can no longer take (voided, already paid, or credited meanwhile): a person must refund or reassign it.
        await db.query(`UPDATE "InvoicePaymentAttempts" SET "Status" = 'NeedsReview', "FailureReason" = $2, "UpdatedAtUtc" = now() WHERE "Id" = $1`,
          [row.Id, invoice.Status !== 'Issued' ? 'invoice_not_payable' : 'overpayment']);
        log.error?.(JSON.stringify({ level: 'error', event: 'invoice_payment_needs_review', attemptId: row.Id, invoiceStatus: invoice.Status }));
        await notify(db, {
          businessId: row.BusinessId, category: 'finance', eventType: 'payment.needs_review', title: 'An online payment needs attention',
          body: `A customer paid online for invoice ${invoice.Number}, but the invoice can no longer take it. Review it and refund or reassign the money.`,
          dedupeKey: `payment.needs_review:${row.Id}`, target: { kind: 'invoice', id: row.InvoiceId },
          recipients: { permission: 'payments.verify', locationlessOnly: !invoice.LocationId, ...(invoice.LocationId && { locationId: invoice.LocationId }) },
          email: { templateKey: 'payment.needs_review', subject: 'An online payment needs attention', text: () => `An online payment for invoice ${invoice.Number} needs review. Open Avzar.` },
        });
        return;
      }
      const { TimeZoneId } = (await db.query('SELECT "TimeZoneId" FROM "Businesses" WHERE "Id" = $1', [row.BusinessId])).rows[0];
      const today = todayInZone(TimeZoneId);
      const paymentId = randomUUID();
      const { rows: paid } = await db.query(`INSERT INTO "Payments" ("Id", "Amount", "BusinessId", "CreatedAtUtc", "CurrencyCode", "CustomerId", "IdempotencyKey",
          "InvoiceId", "Method", "Notes", "ReceivedOn", "RecordedByUserId", "Reference", "Status", "VerifiedAtUtc", "VerifiedByUserId")
        VALUES ($1, $2, $3, now(), $4, $5, $6, $7, 'Card', 'Paid online with Paystack. Confirmed with the provider.', $8::date, NULL, $9, 'Verified', now(), $10)
        RETURNING *`,
      [paymentId, amount, row.BusinessId, row.CurrencyCode, row.CustomerId, `attempt:${row.Id}`, row.InvoiceId, today, row.Reference, PROVIDER_VERIFIER_ID]);
      await issueReceipt(db, user, paid[0], invoice, balance, today);
      await db.query(`UPDATE "InvoicePaymentAttempts" SET "Status" = 'Paid', "PaymentId" = $2, "UpdatedAtUtc" = now() WHERE "Id" = $1`, [row.Id, paymentId]);
      await recordAudit(db, user, 'payment.recorded_online', paymentId, { invoice: invoice.Number, amount, source: row.Source });
      await notify(db, {
        businessId: row.BusinessId, category: 'finance', eventType: 'payment.recorded', title: 'Online payment received',
        body: `A customer paid invoice ${invoice.Number} online.`, dedupeKey: `payment.recorded:${paymentId}`, target: { kind: 'payment', id: paymentId },
        recipients: invoice.LocationId ? { permission: 'payments.view', locationId: invoice.LocationId } : { permission: 'payments.view', locationlessOnly: true },
        email: { templateKey: 'payment.recorded', subject: 'A payment was recorded', text: () => `A payment was recorded for invoice ${invoice.Number}. Open Avzar to review it.` },
      });
    });
    return 200;
  });
}
