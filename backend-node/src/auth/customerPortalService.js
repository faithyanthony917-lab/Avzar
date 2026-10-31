import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { bindTenantByLookup } from '../db/tenantLookup.js';
import { portalInstallmentPlans } from './installmentService.js';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex').toUpperCase();
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const portalUnavailable = () => AppError.unauthorized('portal_link_invalid', 'This customer portal link is invalid or expired.');

async function inTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** What the customer sees of a payment plan: the schedule and the next amount to pay, nothing internal. */
function portalPlanDto(plan) {
  return {
    state: plan.state,
    currencyCode: plan.currencyCode,
    outstanding: plan.outstanding,
    overdueCount: plan.overdueCount,
    installments: plan.installments.map(({ sequence, dueDate, amount, paid, outstanding, status, overdue }) => ({ sequence, dueDate, amount, paid, outstanding, status, overdue })),
    next: plan.next,
  };
}

export async function sendCustomerPortalLink(pool, env, user, customerId) {
  const { rows: customers } = await pool.query(
    `SELECT "Id", "BusinessId", "FullName", "Email" FROM "Customers"
     WHERE "Id" = $1 AND "BusinessId" = $2`, [customerId, user.businessId]);
  const customer = customers[0];
  if (!customer) throw AppError.notFound('customer_not_found', 'Customer was not found.');
  if (!customer.Email?.trim()) throw AppError.badRequest('customer_email_required', 'Add a valid customer email before sending a portal link.');

  const { rows: businesses } = await pool.query(
    `SELECT "Name" FROM "Businesses" WHERE "Id" = $1`, [user.businessId]);
  const business = businesses[0];
  if (!business) throw AppError.notFound('customer_not_found', 'Customer was not found.');

  const token = randomBytes(32).toString('base64url');
  const tokenHash = sha256(token);
  const expiresAtUtc = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const portalUrl = new URL('/customer-portal', env.WEB_BASE_URL ?? 'https://avzar.app');
  portalUrl.hash = token;
  const greeting = `Hello ${customer.FullName},`;
  const message = `View your order progress, invoices and payments securely here:\n${portalUrl}\n\nThis link expires in 7 days. If you did not request it, ignore this message.`;
  const html = `<p>${escapeHtml(greeting)}</p><p>View your order progress, invoices and payments securely here:</p><p><a href="${escapeHtml(portalUrl)}">Open your customer portal</a></p><p>This link expires in 7 days. If you did not request it, ignore this message.</p>`;

  await inTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO "CustomerPortalGrants" ("Id", "BusinessId", "CustomerId", "TokenHash", "ExpiresAtUtc", "RevokedAtUtc", "LastUsedAtUtc", "UseCount", "CreatedAtUtc")
       VALUES ($1, $2, $3, $4, $5, NULL, NULL, 0, now())`,
      [randomUUID(), user.businessId, customer.Id, tokenHash, expiresAtUtc]);
    await client.query(
      `INSERT INTO "EmailOutbox" ("Id", "Attempts", "BusinessId", "CreatedAtUtc", "HtmlBody", "NextAttemptUtc", "Status", "Subject", "TemplateKey", "TextBody", "ToAddress")
       VALUES ($1, 0, $2, now(), $3, now(), 'Pending', $4, 'customer_portal_link', $5, $6)`,
      [randomUUID(), user.businessId, html, `Your ${business.Name} customer portal`, `${greeting}\n\n${message}`, customer.Email]);
  });

  const at = customer.Email.indexOf('@');
  const maskedEmail = at <= 0 ? '***' : at === 1 ? `*${customer.Email.slice(at)}` : `${customer.Email[0]}${'*'.repeat(Math.min(8, at - 1))}${customer.Email.slice(at)}`;
  return { expiresAtUtc: expiresAtUtc.toISOString(), maskedEmail };
}

export async function revokeCustomerPortalLinks(pool, user, customerId) {
  const { rows } = await pool.query(
    `SELECT "Id" FROM "Customers" WHERE "Id" = $1 AND "BusinessId" = $2`, [customerId, user.businessId]);
  if (!rows[0]) throw AppError.notFound('customer_not_found', 'Customer was not found.');
  await pool.query(
    `UPDATE "CustomerPortalGrants" SET "RevokedAtUtc" = now(), "UpdatedAtUtc" = now()
     WHERE "CustomerId" = $1 AND "BusinessId" = $2 AND "RevokedAtUtc" IS NULL`, [customerId, user.businessId]);
}

export async function accessCustomerPortal(pool, token) {
  if (token.length < 32 || token.length > 128) throw portalUnavailable();
  const tokenHash = sha256(token);
  // The token hash is the key; the grant it matches names the business, which is bound before the transaction reads customer and order data.
  await bindTenantByLookup(pool, 'portal_token_hash', tokenHash);

  return inTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT g."Id" AS "GrantId", g."BusinessId", g."CustomerId", c."FullName" AS "CustomerName",
              b."Name" AS "BusinessName", b."CurrencyCode", (b."PaymentSubaccountCode" IS NOT NULL) AS "OnlinePayments"
       FROM "CustomerPortalGrants" g
       JOIN "Customers" c ON c."Id" = g."CustomerId" AND c."BusinessId" = g."BusinessId"
       JOIN "Businesses" b ON b."Id" = g."BusinessId"
       WHERE g."TokenHash" = $1 AND g."RevokedAtUtc" IS NULL AND g."ExpiresAtUtc" > now()
       FOR UPDATE OF g`, [tokenHash]);
    const grant = rows[0];
    if (!grant) throw portalUnavailable();

    const { rowCount } = await client.query(
      `UPDATE "CustomerPortalGrants" SET "LastUsedAtUtc" = now(), "UseCount" = "UseCount" + 1, "UpdatedAtUtc" = now()
       WHERE "Id" = $1 AND "RevokedAtUtc" IS NULL AND "ExpiresAtUtc" > now()`, [grant.GrantId]);
    if (rowCount !== 1) throw portalUnavailable();

    const { rows: orders } = await client.query(
      `SELECT "Id", "OrderNumber", "Status", "PromisedDate", "Total", "CurrencyCode"
       FROM "Orders" WHERE "BusinessId" = $1 AND "CustomerId" = $2 AND "Status" <> 'Cancelled'
       ORDER BY "CreatedAtUtc" DESC LIMIT 100`, [grant.BusinessId, grant.CustomerId]);
    const orderIds = orders.map((order) => order.Id);
    const tasks = orderIds.length ? (await client.query(
      `SELECT "OrderId", "StageName", "Status", "CompletedAtUtc" FROM "ProductionTasks"
       WHERE "BusinessId" = $1 AND "OrderId" = ANY($2::uuid[]) AND "Status" <> 'Cancelled'
       ORDER BY "CreatedAtUtc"`, [grant.BusinessId, orderIds])).rows : [];

    const { rows: invoices } = await client.query(
      `SELECT "Id", "Number", "Status", "IssueDate", "DueDate", "Total", "CurrencyCode"
       FROM "Invoices" WHERE "BusinessId" = $1 AND "CustomerId" = $2 AND "Status" <> 'Void'
       ORDER BY "CreatedAtUtc" DESC LIMIT 100`, [grant.BusinessId, grant.CustomerId]);
    const invoiceIds = invoices.map((invoice) => invoice.Id);
    const payments = invoiceIds.length ? (await client.query(
      `SELECT "InvoiceId", "Amount", "CurrencyCode", "Method", "ReceivedOn", "Reference"
       FROM "Payments" WHERE "BusinessId" = $1 AND "InvoiceId" = ANY($2::uuid[]) AND "Status" = 'Verified'
       ORDER BY "ReceivedOn"`, [grant.BusinessId, invoiceIds])).rows : [];
    const { rows: totals } = invoiceIds.length ? await client.query(
      `SELECT i."Id" AS "InvoiceId", COALESCE(SUM(p."Amount"), 0)::numeric(18,2) AS "VerifiedPaid",
              GREATEST(i."Total" - COALESCE(SUM(p."Amount"), 0), 0)::numeric(18,2) AS "Balance"
       FROM "Invoices" i LEFT JOIN "Payments" p
         ON p."InvoiceId" = i."Id" AND p."BusinessId" = i."BusinessId" AND p."Status" = 'Verified'
       WHERE i."BusinessId" = $1 AND i."CustomerId" = $2 AND i."Id" = ANY($3::uuid[])
       GROUP BY i."Id", i."Total"`, [grant.BusinessId, grant.CustomerId, invoiceIds]) : { rows: [] };
    const plansByInvoice = await portalInstallmentPlans(client, grant.BusinessId, invoices.filter((invoice) => invoice.Status === 'Issued').map((invoice) => invoice.Id));
    const totalsByInvoice = new Map(totals.map((row) => [row.InvoiceId, row]));
    const tasksByOrder = new Map();
    for (const task of tasks) {
      const progress = tasksByOrder.get(task.OrderId) ?? [];
      progress.push({ stage: task.StageName, status: task.Status, completedAtUtc: task.CompletedAtUtc });
      tasksByOrder.set(task.OrderId, progress);
    }
    const paymentsByInvoice = new Map();
    for (const payment of payments) {
      const receipts = paymentsByInvoice.get(payment.InvoiceId) ?? [];
      receipts.push({ amount: Number(payment.Amount), currencyCode: payment.CurrencyCode, method: payment.Method,
        receivedOn: payment.ReceivedOn, reference: payment.Reference });
      paymentsByInvoice.set(payment.InvoiceId, receipts);
    }

    return {
      customerName: grant.CustomerName,
      businessName: grant.BusinessName,
      currencyCode: grant.CurrencyCode,
      onlinePaymentsEnabled: Boolean(grant.OnlinePayments),
      orders: orders.map((order) => ({
        id: order.Id, orderNumber: order.OrderNumber, status: order.Status, promisedDate: order.PromisedDate,
        total: Number(order.Total), currencyCode: order.CurrencyCode, progress: tasksByOrder.get(order.Id) ?? [],
      })),
      invoices: invoices.map((invoice) => {
        const amount = totalsByInvoice.get(invoice.Id);
        return {
          id: invoice.Id, number: invoice.Number, status: invoice.Status, issueDate: invoice.IssueDate, dueDate: invoice.DueDate,
          total: Number(invoice.Total), currencyCode: invoice.CurrencyCode,
          verifiedPaid: Number(amount?.VerifiedPaid ?? 0), balance: Number(amount?.Balance ?? invoice.Total),
          payments: paymentsByInvoice.get(invoice.Id) ?? [],
          installmentPlan: plansByInvoice.get(invoice.Id) ? portalPlanDto(plansByInvoice.get(invoice.Id)) : null,
        };
      }),
    };
  });
}