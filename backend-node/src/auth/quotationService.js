// Quotations: staff send an issued quotation to the customer, the customer approves or declines it from the customer portal,
// and staff convert an approved quotation into an order with the existing "confirm order" action (which creates the production tasks).
// Every statement is scoped by BusinessId. Customers are identified only by a portal grant (hashed token), never by a client-supplied id.
// A decision is final for one quotation version: editing a quoted order clears Orders.QuotedAtUtc and re-issuing sets a new one,
// and QuotationEvents.QuotedAtUtc ties every event to the version it is about, so an approval never carries over to changed content.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { bindTenantByLookup } from '../db/tenantLookup.js';
import { notify } from '../notifications/notificationService.js';

const GRANT_DAYS = 7;
const RESEND_COOLDOWN_SECONDS = 60;
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex').toUpperCase();
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const portalUnavailable = () => AppError.unauthorized('portal_link_invalid', 'This customer portal link is invalid or expired.');
const iso = (value) => (value ? new Date(value).toISOString() : null);

async function transaction(pool, work) {
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

/** Locations the user may see; null means all. Same rule as the order routes. */
export async function allowedLocations(pool, user) {
  if (user.isOwner || user.permissions.includes('locations.all')) return null;
  const { rows } = await pool.query(`
    SELECT DISTINCT ml."LocationId" FROM "Memberships" m
    JOIN "MembershipLocations" ml ON ml."MembershipId" = m."Id" AND ml."BusinessId" = m."BusinessId"
    WHERE m."UserId" = $1 AND m."BusinessId" = $2 AND m."Status" = 0`, [user.userId, user.businessId]);
  return rows.map((row) => row.LocationId);
}

function maskEmail(email) {
  const at = email.indexOf('@');
  return at <= 0 ? '***' : at === 1 ? `*${email.slice(at)}` : `${email[0]}${'*'.repeat(Math.min(8, at - 1))}${email.slice(at)}`;
}

async function audit(db, action, { businessId, actorUserId, orderId, details }) {
  await db.query(`
    INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityId", "EntityType")
    VALUES ($1, $2, $3, $4, now(), $5::jsonb, $6, 'Order')`,
  [randomUUID(), action, actorUserId, businessId, details ? JSON.stringify(details) : null, orderId]);
}

async function findGrant(db, token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) throw portalUnavailable();
  // The token hash is the key; the grant it matches names the business, which is bound for this transaction before customers are joined.
  await bindTenantByLookup(db, 'portal_token_hash', sha256(token));
  const { rows } = await db.query(`
    SELECT g."Id" AS "GrantId", g."BusinessId", g."CustomerId"
    FROM "CustomerPortalGrants" g
    JOIN "Customers" c ON c."Id" = g."CustomerId" AND c."BusinessId" = g."BusinessId"
    WHERE g."TokenHash" = $1 AND g."RevokedAtUtc" IS NULL AND g."ExpiresAtUtc" > now()`, [sha256(token)]);
  if (!rows[0]) throw portalUnavailable();
  return rows[0];
}

/** Staff: email the customer a link to review and answer the current quotation. Needs orders.manage and access to the order's location. */
export async function sendQuotation(pool, env, user, orderId, allowed) {
  return transaction(pool, async (db) => {
    const { rows } = await db.query(`
      SELECT o."OrderNumber", o."Status", o."QuotedAtUtc"::text AS "QuotedAtUtc", o."Total", o."PromisedDate", o."CurrencyCode", o."CustomerId", o."LocationId",
             c."FullName", c."Email", c."Status" AS "CustomerStatus", b."Name" AS "BusinessName"
      FROM "Orders" o
      JOIN "Customers" c ON c."Id" = o."CustomerId" AND c."BusinessId" = o."BusinessId"
      JOIN "Businesses" b ON b."Id" = o."BusinessId"
      WHERE o."BusinessId" = $1 AND o."Id" = $2 AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[]))
      FOR UPDATE OF o`, [user.businessId, orderId, allowed]);
    const order = rows[0];
    if (!order) throw AppError.notFound('order_not_found', 'Order not found.');
    if (order.Status !== 'Quoted' || !order.QuotedAtUtc) throw AppError.conflict('quotation_not_open', `Only a quoted order can be sent to the customer (this one is ${order.Status}).`);
    if (order.CustomerStatus !== 'Active') throw AppError.conflict('customer_not_active', 'The customer profile is not active.');
    if (!order.Email?.trim()) throw AppError.badRequest('customer_email_required', 'Add a valid customer email before sending a quotation.');

    const answered = await db.query(`
      SELECT 1 FROM "QuotationEvents" WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "QuotedAtUtc" = $3 AND "Type" IN ('Approved', 'Declined') LIMIT 1`,
    [user.businessId, orderId, order.QuotedAtUtc]);
    if (answered.rows.length) throw AppError.conflict('quotation_already_answered', 'The customer has already answered this quotation. Edit the order and issue a new quotation to ask again.');
    const recent = await db.query(`
      SELECT 1 FROM "QuotationEvents" WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "QuotedAtUtc" = $3 AND "Type" = 'Sent'
        AND "CreatedAtUtc" > now() - make_interval(secs => $4::int) LIMIT 1`,
    [user.businessId, orderId, order.QuotedAtUtc, RESEND_COOLDOWN_SECONDS]);
    if (recent.rows.length) throw AppError.conflict('quotation_recently_sent', 'This quotation was just sent. Wait a minute before sending it again.');

    const token = randomBytes(32).toString('base64url');
    const expiresAtUtc = new Date(Date.now() + GRANT_DAYS * 24 * 60 * 60 * 1000);
    const portalUrl = new URL('/customer-portal', env.WEB_BASE_URL ?? 'https://avzar.app');
    portalUrl.hash = token;
    // The message names the order and the total only: no garment details, measurements or notes travel by email.
    const total = `${order.CurrencyCode} ${Number(order.Total).toFixed(2)}`;
    const promised = String(order.PromisedDate).slice(0, 10);
    const greeting = `Hello ${order.FullName},`;
    const text = `${greeting}\n\n${order.BusinessName} has sent you a quotation for order ${order.OrderNumber}: ${total}, promised by ${promised}.\nReview and approve or decline it here:\n${portalUrl}\n\nThis link expires in ${GRANT_DAYS} days. If you did not expect this message, ignore it.`;
    const html = `<p>${escapeHtml(greeting)}</p><p>${escapeHtml(order.BusinessName)} has sent you a quotation for order ${escapeHtml(order.OrderNumber)}: <strong>${escapeHtml(total)}</strong>, promised by ${escapeHtml(promised)}.</p><p><a href="${escapeHtml(portalUrl)}">Review and answer the quotation</a></p><p>This link expires in ${GRANT_DAYS} days. If you did not expect this message, ignore it.</p>`;

    await db.query(`
      INSERT INTO "CustomerPortalGrants" ("Id", "BusinessId", "CustomerId", "TokenHash", "ExpiresAtUtc", "RevokedAtUtc", "LastUsedAtUtc", "UseCount", "CreatedAtUtc")
      VALUES ($1, $2, $3, $4, $5, NULL, NULL, 0, now())`, [randomUUID(), user.businessId, order.CustomerId, sha256(token), expiresAtUtc]);
    await db.query(`
      INSERT INTO "EmailOutbox" ("Id", "Attempts", "BusinessId", "CreatedAtUtc", "HtmlBody", "NextAttemptUtc", "Status", "Subject", "TemplateKey", "TextBody", "ToAddress")
      VALUES ($1, 0, $2, now(), $3, now(), 'Pending', $4, 'quotation_sent', $5, $6)`,
    [randomUUID(), user.businessId, html, `Quotation ${order.OrderNumber} from ${order.BusinessName}`, text, order.Email]);
    const eventId = randomUUID();
    const { rows: events } = await db.query(`
      INSERT INTO "QuotationEvents" ("Id", "BusinessId", "OrderId", "Type", "QuotedAtUtc", "Total", "ActorUserId", "Note", "CreatedAtUtc")
      VALUES ($1, $2, $3, 'Sent', $4, $5, $6, NULL, now()) RETURNING "CreatedAtUtc"`,
    [eventId, user.businessId, orderId, order.QuotedAtUtc, order.Total, user.userId]);
    await notify(db, {
      businessId: user.businessId, category: 'orders', eventType: 'quotation.sent', title: 'Quotation awaiting approval',
      body: 'A quotation was sent and is awaiting customer approval.',
      dedupeKey: `quotation.sent:${orderId}:${order.QuotedAtUtc}`,
      target: { kind: 'quotation', id: orderId },
      recipients: { permission: 'orders.manage', locationId: order.LocationId },
      actorUserId: user.userId,
      email: {
        templateKey: 'quotation.awaiting-approval', subject: 'A quotation is awaiting approval',
        text: () => 'A quotation was sent to a customer and is awaiting approval. Open Avzar to review its status.',
      },
    });
    await audit(db, 'quotation.sent', { businessId: user.businessId, actorUserId: user.userId, orderId, details: { total: Number(order.Total), to: maskEmail(order.Email) } });
    return { sentAtUtc: iso(events[0]?.CreatedAtUtc), expiresAtUtc: expiresAtUtc.toISOString(), maskedEmail: maskEmail(order.Email) };
  });
}

/** Staff: where the current quotation stands. Events belonging to an older quotation version are ignored. */
export async function getQuotationStatus(pool, user, orderId, allowed) {
  const { rows } = await pool.query(`
    SELECT "Status", "QuotedAtUtc"::text AS "QuotedAtUtc" FROM "Orders"
    WHERE "BusinessId" = $1 AND "Id" = $2 AND ($3::uuid[] IS NULL OR "LocationId" = ANY($3::uuid[]))`, [user.businessId, orderId, allowed]);
  const order = rows[0];
  if (!order) throw AppError.notFound('order_not_found', 'Order not found.');
  if (!order.QuotedAtUtc) return { state: 'NotApplicable', orderStatus: order.Status, sentAtUtc: null, sendCount: 0, decidedAtUtc: null, customerNote: null, canSend: false, readyToConfirm: false };
  const { rows: events } = await pool.query(`
    SELECT "Type", "CreatedAtUtc", "Note" FROM "QuotationEvents"
    WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "QuotedAtUtc" = $3 ORDER BY "CreatedAtUtc"`, [user.businessId, orderId, order.QuotedAtUtc]);
  const sent = events.filter((event) => event.Type === 'Sent');
  const decision = [...events].reverse().find((event) => event.Type !== 'Sent') ?? null;
  const state = decision ? decision.Type : sent.length ? 'Sent' : 'NotSent';
  const open = order.Status === 'Quoted';
  return {
    state, orderStatus: order.Status,
    sentAtUtc: iso(sent.at(-1)?.CreatedAtUtc), sendCount: sent.length,
    decidedAtUtc: iso(decision?.CreatedAtUtc), customerNote: decision?.Note ?? null,
    canSend: open && !decision, readyToConfirm: open && decision?.Type === 'Approved',
  };
}

/** Portal: the quotations that were sent to this customer and are still open. Shows lines and totals only, never measurements. */
export async function listPortalQuotations(pool, token) {
  const grant = await findGrant(pool, token);
  const { rows: quotes } = await pool.query(`
    SELECT o."Id", o."OrderNumber", o."PromisedDate", o."Subtotal", o."Discount", o."Total", o."CurrencyCode", s."Id" AS "QuotationId", s."CreatedAtUtc" AS "SentAtUtc"
    FROM "Orders" o
    JOIN LATERAL (
      SELECT e."Id", e."CreatedAtUtc" FROM "QuotationEvents" e
      WHERE e."BusinessId" = o."BusinessId" AND e."OrderId" = o."Id" AND e."Type" = 'Sent' AND e."QuotedAtUtc" = o."QuotedAtUtc"
      ORDER BY e."CreatedAtUtc" DESC LIMIT 1) s ON TRUE
    WHERE o."BusinessId" = $1 AND o."CustomerId" = $2 AND o."Status" = 'Quoted'
    ORDER BY o."QuotedAtUtc" DESC LIMIT 20`, [grant.BusinessId, grant.CustomerId]);
  if (!quotes.length) return { quotations: [] };
  const ids = quotes.map((quote) => quote.Id);
  const [lines, decisions] = await Promise.all([
    pool.query(`SELECT "OrderId", "Name", "Quantity", "UnitPrice", "LineTotal" FROM "OrderGarments"
      WHERE "BusinessId" = $1 AND "OrderId" = ANY($2::uuid[]) ORDER BY "OrderId", "LineNumber"`, [grant.BusinessId, ids]),
    pool.query(`
      SELECT DISTINCT ON (e."OrderId") e."OrderId", e."Type", e."CreatedAtUtc"
      FROM "QuotationEvents" e JOIN "Orders" o ON o."Id" = e."OrderId" AND o."BusinessId" = e."BusinessId"
      WHERE e."BusinessId" = $1 AND e."OrderId" = ANY($2::uuid[]) AND e."Type" IN ('Approved', 'Declined') AND e."QuotedAtUtc" = o."QuotedAtUtc"
      ORDER BY e."OrderId", e."CreatedAtUtc" DESC`, [grant.BusinessId, ids]),
  ]);
  const decisionByOrder = new Map(decisions.rows.map((row) => [row.OrderId, row]));
  return {
    quotations: quotes.map((quote) => {
      const decision = decisionByOrder.get(quote.Id);
      return {
        orderId: quote.Id, quotationId: quote.QuotationId, orderNumber: quote.OrderNumber, promisedDate: String(quote.PromisedDate).slice(0, 10),
        currencyCode: quote.CurrencyCode, subtotal: Number(quote.Subtotal), discount: Number(quote.Discount), total: Number(quote.Total),
        sentAtUtc: iso(quote.SentAtUtc), decision: decision?.Type ?? null, decidedAtUtc: iso(decision?.CreatedAtUtc),
        lines: lines.rows.filter((line) => line.OrderId === quote.Id).map((line) => ({ name: line.Name, quantity: line.Quantity, unitPrice: Number(line.UnitPrice), lineTotal: Number(line.LineTotal) })),
      };
    }),
  };
}

/** Portal: the customer approves or declines the quotation version they were shown (quotationId). Final for that version; repeating the same answer is harmless. */
export async function respondToQuotation(pool, input) {
  return transaction(pool, async (db) => {
    const grant = await findGrant(db, input.token);
    const { rows } = await db.query(`
      SELECT "Status", "QuotedAtUtc"::text AS "QuotedAtUtc", "Total" FROM "Orders"
      WHERE "BusinessId" = $1 AND "Id" = $2 AND "CustomerId" = $3 FOR UPDATE`, [grant.BusinessId, input.orderId, grant.CustomerId]);
    const order = rows[0];
    if (!order) throw AppError.notFound('quotation_not_found', 'This quotation was not found.');
    if (order.Status !== 'Quoted' || !order.QuotedAtUtc) throw AppError.conflict('quotation_not_open', 'This quotation is no longer open. Contact the business.');
    const { rows: sent } = await db.query(`
      SELECT "Id" FROM "QuotationEvents" WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "QuotedAtUtc" = $3 AND "Type" = 'Sent'
      ORDER BY "CreatedAtUtc" DESC LIMIT 1`, [grant.BusinessId, input.orderId, order.QuotedAtUtc]);
    if (!sent[0]) throw AppError.notFound('quotation_not_found', 'This quotation was not found.');
    if (sent[0].Id !== input.quotationId) throw AppError.conflict('quotation_changed', 'This quotation was updated. Reload the page to see the latest version.');

    const wanted = input.decision === 'approve' ? 'Approved' : 'Declined';
    const { rows: prior } = await db.query(`
      SELECT "Type", "CreatedAtUtc" FROM "QuotationEvents" WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "QuotedAtUtc" = $3 AND "Type" IN ('Approved', 'Declined')
      ORDER BY "CreatedAtUtc" DESC LIMIT 1`, [grant.BusinessId, input.orderId, order.QuotedAtUtc]);
    if (prior[0]) {
      if (prior[0].Type === wanted) return { decision: wanted, decidedAtUtc: iso(prior[0].CreatedAtUtc), alreadyRecorded: true };
      throw AppError.conflict('quotation_already_answered', 'You have already answered this quotation. Contact the business to change it.');
    }
    const note = input.note?.trim() ? input.note.trim() : null;
    const { rows: created } = await db.query(`
      INSERT INTO "QuotationEvents" ("Id", "BusinessId", "OrderId", "Type", "QuotedAtUtc", "Total", "ActorUserId", "Note", "CreatedAtUtc")
      VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, now()) RETURNING "CreatedAtUtc"`,
    [randomUUID(), grant.BusinessId, input.orderId, wanted, order.QuotedAtUtc, order.Total, note]);
    await audit(db, wanted === 'Approved' ? 'quotation.approved' : 'quotation.declined', { businessId: grant.BusinessId, actorUserId: null, orderId: input.orderId, details: { total: Number(order.Total), viaPortal: true } });
    return { decision: wanted, decidedAtUtc: iso(created[0]?.CreatedAtUtc), alreadyRecorded: false };
  });
}
