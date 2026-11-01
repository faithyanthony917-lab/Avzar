import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { adoptTenant, setTenantLookup } from '../db/tenantRlsContext.js';
import { isBlank, parseEnum } from '../http/enums.js';
import { ensureBelowLimit } from './entitlementService.js';
import { allowedLocations, createOrderInTransaction } from './orderRoutes.js';
import { createAppointment } from './appointmentService.js';
import { notify } from '../notifications/notificationService.js';

const KINDS = ['Inquiry', 'Quotation', 'OrderRequest', 'Appointment', 'Contact'];
const STATUSES = ['New', 'Reviewed', 'Converted', 'Rejected'];
const accepted = { received: true, message: 'Thank you. We have received your message and will get back to you.' };

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

async function findOrCreateCustomer(client, user, inquiry) {
  const email = clean(inquiry.Email)?.toLowerCase() ?? null;
  const phone = clean(inquiry.Phone)?.replace(/\D/g, '') || null;
  const { rows: matches } = await client.query(`
    SELECT "Id" FROM "Customers" WHERE "BusinessId" = $1
      AND (($2::text IS NOT NULL AND "NormalizedEmail" = $2) OR ($3::text IS NOT NULL AND "NormalizedPhone" = $3))
    ORDER BY "CreatedAtUtc" LIMIT 1`, [user.businessId, email, phone]);
  let customerId = matches[0]?.Id;
  if (!customerId) {
    await ensureBelowLimit(client, user.businessId, 'customers.active.max', async (db) => {
      const { rows: counts } = await db.query(
        `SELECT count(*)::bigint AS "Count" FROM "Customers" WHERE "BusinessId" = $1 AND "Status" = 'Active'`, [user.businessId]);
      return Number(counts[0]?.Count ?? 0);
    });
    customerId = randomUUID();
    await client.query(`
      INSERT INTO "Customers" ("Id", "BusinessId", "FullName", "Email", "NormalizedEmail", "Phone", "NormalizedPhone", "Status", "CreatedAtUtc")
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'Active', now())`,
    [customerId, user.businessId, inquiry.Name, inquiry.Email, email, inquiry.Phone, phone]);
    await client.query(`
      INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "EntityId", "EntityType")
      VALUES ($1, 'customer.created', $2, $3, now(), $4, 'Customer')`, [randomUUID(), user.userId, user.businessId, customerId]);
  }
  return customerId;
}

export async function convertInquiry(pool, user, id, request) {
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT "Id", "Status", "Name", "Email", "Phone", "Message", "DesignId", "DesignNameSnapshot", "GarmentType"
       FROM "Inquiries" WHERE "Id" = $1 AND "BusinessId" = $2 FOR UPDATE`, [id, user.businessId]);
    const inquiry = rows[0];
    if (!inquiry) throw AppError.notFound('inquiry_not_found', 'Request not found.');
    if (inquiry.Status === 'Converted' || inquiry.Status === 'Rejected') {
      throw AppError.conflict('not_convertible', `A ${inquiry.Status} request cannot be converted.`);
    }

    const customerId = await findOrCreateCustomer(client, user, inquiry);

    const { rows: availableDesigns } = inquiry.DesignId ? await client.query(
      `SELECT "Id" FROM "Designs" WHERE "Id" = $1 AND "BusinessId" = $2 AND "Status" = 'Active'`, [inquiry.DesignId, user.businessId]) : { rows: [] };
    const note = `Website request: ${inquiry.Message}`;
    const orderResult = await createOrderInTransaction(client, user, {
      customerId,
      locationId: request.locationId,
      promisedDate: request.promisedDate,
      priority: 'Normal',
      deliveryMethod: 'Collection',
      discount: 0,
      garments: [{
        name: clean(request.garmentName) ?? inquiry.DesignNameSnapshot ?? inquiry.GarmentType ?? 'Custom order',
        quantity: 1,
        unitPrice: request.unitPrice,
        designId: availableDesigns[0]?.Id ?? null,
        styleInstructions: note.slice(0, 1000),
      }],
    }, `inquiry-${id.replaceAll('-', '')}`);

    const { rows: updated } = await client.query(`
      UPDATE "Inquiries" SET "Status" = 'Converted', "ConvertedOrderId" = $3, "HandledByUserId" = $4,
        "HandledAtUtc" = now(), "UpdatedAtUtc" = now()
      WHERE "Id" = $1 AND "BusinessId" = $2
      RETURNING "Id", "Kind", "Status", "Name", "Email", "Phone", "Message", "DesignId", "DesignNameSnapshot", "GarmentType", "Budget", "PreferredDate", "EventDate", "ConvertedOrderId", "AppointmentId", "InternalNote", "CreatedAtUtc", "HandledAtUtc"`,
    [id, user.businessId, orderResult.order.id, user.userId]);
    await client.query(`
      INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityId", "EntityType")
      VALUES ($1, 'inquiry.converted', $2, $3, now(), $4::jsonb, $5, 'Inquiry')`,
    [randomUUID(), user.userId, user.businessId, JSON.stringify({ order: orderResult.order.orderNumber }), id]);
    return dto(updated[0]);
  });
}

/**
 * Step-14: turn a storefront booking request into an appointment. One transaction under the inquiry's row lock:
 * find or create the customer (same rules as convert), book through createAppointment (conflict checks, plan limit,
 * reminder rows, audit), then mark the request Converted and link it. Any failure rolls back all of it.
 */
export async function scheduleInquiry(pool, user, id, request, now = new Date()) {
  const allowed = await allowedLocations(pool, user);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT "Id", "Kind", "Status", "Name", "Email", "Phone", "Message", "AppointmentId"
       FROM "Inquiries" WHERE "Id" = $1 AND "BusinessId" = $2 FOR UPDATE`, [id, user.businessId]);
    const inquiry = rows[0];
    if (!inquiry) throw AppError.notFound('inquiry_not_found', 'Request not found.');
    if (inquiry.AppointmentId) throw AppError.conflict('inquiry_already_scheduled', 'This request already has an appointment.');
    if (inquiry.Status === 'Converted' || inquiry.Status === 'Rejected') {
      throw AppError.conflict('not_schedulable', `A ${inquiry.Status} request cannot be scheduled.`);
    }
    if (inquiry.Kind !== 'Appointment') {
      throw AppError.badRequest('not_a_booking_request', 'Only a booking request can be scheduled as an appointment.');
    }

    const customerId = await findOrCreateCustomer(client, user, inquiry);
    const notes = request.notes === undefined || request.notes === null || !request.notes.trim()
      ? `Website request: ${inquiry.Message}`.slice(0, 2000) : request.notes.trim();
    // createAppointment opens its own transaction through the function it is given; hand it this one.
    const appointment = await createAppointment(pool, (_pool, work) => work(client), user, {
      type: request.type, customerId, locationId: request.locationId,
      assignedMembershipId: request.assignedMembershipId, startAt: request.startAt, endAt: request.endAt, notes,
    }, allowed, now);

    const { rows: updated } = await client.query(`
      UPDATE "Inquiries" SET "Status" = 'Converted', "AppointmentId" = $3, "HandledByUserId" = $4,
        "HandledAtUtc" = now(), "UpdatedAtUtc" = now()
      WHERE "Id" = $1 AND "BusinessId" = $2
      RETURNING "Id", "Kind", "Status", "Name", "Email", "Phone", "Message", "DesignId", "DesignNameSnapshot", "GarmentType", "Budget", "PreferredDate", "EventDate", "ConvertedOrderId", "AppointmentId", "InternalNote", "CreatedAtUtc", "HandledAtUtc"`,
    [id, user.businessId, appointment.id, user.userId]);
    await client.query(`
      INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityId", "EntityType")
      VALUES ($1, 'inquiry.scheduled', $2, $3, now(), $4::jsonb, $5, 'Inquiry')`,
    [randomUUID(), user.userId, user.businessId, JSON.stringify({ appointmentId: appointment.id }), id]);
    return { inquiry: dto(updated[0]), appointment };
  });
}

const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const dateOnlyValid = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
function shiftDate(value, days = 0, years = 0) {
  const [year, month, day] = value.split('-').map(Number);
  const targetYear = year + years;
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  const date = new Date(Date.UTC(targetYear, month - 1, Math.min(day, lastDay)));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function verifyTurnstile(secret, token, ip) {
  if (!secret) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body, signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return false;
    return (await response.json()).success === true;
  } catch {
    return false;
  }
}

function dto(row) {
  return {
    id: row.Id, kind: row.Kind, status: row.Status, name: row.Name, email: row.Email, phone: row.Phone,
    message: row.Message, designId: row.DesignId, designName: row.DesignNameSnapshot, garmentType: row.GarmentType,
    budget: row.Budget, preferredDate: row.PreferredDate, eventDate: row.EventDate,
    convertedOrderId: row.ConvertedOrderId, appointmentId: row.AppointmentId ?? null, internalNote: row.InternalNote,
    createdAtUtc: row.CreatedAtUtc, handledAtUtc: row.HandledAtUtc,
  };
}

export async function submitInquiry(pool, env, slug, request, clientIp) {
  if (request.website?.trim()) return accepted;
  if (!KINDS.includes(request.kind)) throw AppError.badRequest('invalid_kind', 'The inquiry kind is invalid.');

  // The public URL carries only the slug; the storefront row found by it names the business for everything this inquiry writes.
  setTenantLookup('storefront_slug', slug);
  const { rows: storefronts } = await pool.query(
    `SELECT "Id", "BusinessId", "WorkflowInquiry", "WorkflowBooking", "WorkflowCustomOrder", "WorkflowContact"
     FROM "Storefronts" WHERE "Slug" = $1 AND "Status" = 'Published'`, [slug]);
  const site = storefronts[0];
  if (!site) throw AppError.notFound('site_not_found', 'This site does not exist.');
  adoptTenant(site.BusinessId);

  const workflow = request.kind === 'Inquiry' || request.kind === 'Quotation' ? 'inquiry'
    : request.kind === 'OrderRequest' ? 'customOrder'
      : request.kind === 'Appointment' ? 'booking' : 'contact';
  const enabled = {
    inquiry: site.WorkflowInquiry, booking: site.WorkflowBooking,
    customOrder: site.WorkflowCustomOrder, contact: site.WorkflowContact,
  }[workflow];
  if (!enabled) throw AppError.conflict('workflow_disabled', 'This business is not taking that kind of request through the site.');
  if (env.STOREFRONT_CAPTCHA_SECRET_KEY && !(await verifyTurnstile(env.STOREFRONT_CAPTCHA_SECRET_KEY, request.captchaToken, clientIp))) {
    throw AppError.badRequest('captcha_failed', 'Please complete the check and try again.');
  }

  const email = clean(request.email);
  const phone = clean(request.phone);
  if (!email && !phone) throw AppError.badRequest('contact_required', 'Please give an email address or a phone number so we can reply.');
  for (const text of [request.name, request.message, request.garmentType, request.budget, phone].filter(Boolean)) {
    if (text.includes('<') || text.includes('>')) throw AppError.badRequest('invalid_text', 'The characters < and > are not allowed.');
  }

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = shiftDate(today, -1);
  const preferredDate = clean(request.preferredDate);
  const eventDate = clean(request.eventDate);
  if (request.kind === 'Appointment' && !preferredDate) throw AppError.badRequest('date_required', 'Please choose the day you would like to come in.');
  if (preferredDate && (!dateOnlyValid(preferredDate) || preferredDate < yesterday || preferredDate > shiftDate(today, 0, 2))) {
    throw AppError.badRequest('invalid_date', 'That date is not valid.');
  }
  if (eventDate && (!dateOnlyValid(eventDate) || eventDate < yesterday || eventDate > shiftDate(today, 0, 5))) {
    throw AppError.badRequest('invalid_date', 'That date is not valid.');
  }
  let designName = null;
  if (request.designId) {
    const { rows } = await pool.query(
      `SELECT "Name" FROM "Designs" WHERE "Id" = $1 AND "BusinessId" = $2 AND "Status" = 'Active' AND "Visibility" = 'Public'`,
      [request.designId, site.BusinessId]);
    if (!rows[0]) throw AppError.badRequest('unknown_design', 'That design is not available.');
    designName = rows[0].Name;
  }

  const ipHash = clientIp?.trim()
    ? createHash('sha256').update(`${site.BusinessId.replaceAll('-', '')}|${clientIp.trim()}`).digest('hex') : null;
  if (ipHash) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS "Count" FROM "Inquiries"
       WHERE "StorefrontId" = $1 AND "IpHash" = $2 AND "CreatedAtUtc" > now() - interval '1 hour'`, [site.Id, ipHash]);
    if (rows[0]?.Count >= 10) throw new AppError(429, 'too_many_requests', 'You have sent several messages recently. Please wait a while before sending another.');
  }

  const inquiryId = randomUUID();
  await inTransaction(pool, async (db) => {
    await db.query(
      `INSERT INTO "Inquiries" ("Id", "BusinessId", "StorefrontId", "Kind", "Status", "Name", "Email", "Phone", "Message", "DesignId", "DesignNameSnapshot", "GarmentType", "Budget", "PreferredDate", "EventDate", "IpHash", "CreatedAtUtc")
       VALUES ($1, $2, $3, $4, 'New', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())`,
      [inquiryId, site.BusinessId, site.Id, request.kind, request.name.trim(), email, phone, request.message.trim(), request.designId ?? null,
        designName, clean(request.garmentType), clean(request.budget), preferredDate, eventDate, ipHash]);
    await notify(db, {
      businessId: site.BusinessId, category: 'inquiries', eventType: 'inquiry.new', title: 'New storefront inquiry',
      body: 'A new request was submitted through your storefront.', dedupeKey: `inquiry.new:${inquiryId}`,
      target: { kind: 'inquiry', id: inquiryId }, recipients: { permission: 'inquiries.view' },
      email: {
        templateKey: 'inquiry.new', subject: 'A new storefront request was received',
        text: () => 'A new request was submitted through your storefront. Open Avzar to review it.',
      },
    });
  });
  return accepted;
}

function parseListQuery(query, maxPageSize = 100) {
  const page = Number.parseInt(query.page ?? '1', 10);
  const pageSize = Number.parseInt(query.pageSize ?? '25', 10);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > maxPageSize) {
    throw AppError.badRequest('invalid_paging', `Page must be positive and pageSize must be between 1 and ${maxPageSize}.`);
  }
  const status = isBlank(query.status) ? null : parseEnum(String(query.status), STATUSES, 'status');
  const kind = isBlank(query.kind) ? null : parseEnum(String(query.kind), KINDS, 'kind');
  return { page, pageSize, status, kind, search: query.search === undefined ? null : String(query.search).trim().slice(0, 200) };
}

export async function listInquiries(pool, user, query, { maxPageSize = 100 } = {}) {
  const filter = parseListQuery(query, maxPageSize);
  const params = [user.businessId];
  const conditions = ['"BusinessId" = $1'];
  for (const [column, value] of [['Status', filter.status], ['Kind', filter.kind]]) {
    if (value) {
      params.push(value);
      conditions.push(`"${column}" = $${params.length}`);
    }
  }
  if (filter.search) {
    const escaped = filter.search.replace(/[\\%_]/g, '\\$&');
    params.push(`%${escaped}%`);
    const index = params.length;
    conditions.push(`("Name" ILIKE $${index} ESCAPE E'\\\\' OR "Email" ILIKE $${index} ESCAPE E'\\\\' OR "Message" ILIKE $${index} ESCAPE E'\\\\')`);
  }
  const where = conditions.join(' AND ');
  const { rows: counts } = await pool.query(`SELECT count(*)::int AS "TotalCount" FROM "Inquiries" WHERE ${where}`, params);
  const offset = (filter.page - 1) * filter.pageSize;
  const { rows } = await pool.query(
    `SELECT "Id", "Kind", "Status", "Name", "Email", "Phone", "Message", "DesignId", "DesignNameSnapshot", "GarmentType", "Budget", "PreferredDate", "EventDate", "ConvertedOrderId", "AppointmentId", "InternalNote", "CreatedAtUtc", "HandledAtUtc"
     FROM "Inquiries" WHERE ${where} ORDER BY "CreatedAtUtc" DESC, "Id" DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filter.pageSize, offset]);
  return { items: rows.map(dto), page: filter.page, pageSize: filter.pageSize, totalCount: counts[0]?.TotalCount ?? 0 };
}

export async function getInquiry(pool, user, id) {
  const { rows } = await pool.query(
    `SELECT "Id", "Kind", "Status", "Name", "Email", "Phone", "Message", "DesignId", "DesignNameSnapshot", "GarmentType", "Budget", "PreferredDate", "EventDate", "ConvertedOrderId", "AppointmentId", "InternalNote", "CreatedAtUtc", "HandledAtUtc"
     FROM "Inquiries" WHERE "Id" = $1 AND "BusinessId" = $2`, [id, user.businessId]);
  if (!rows[0]) throw AppError.notFound('inquiry_not_found', 'Request not found.');
  return dto(rows[0]);
}

export async function updateInquiry(pool, user, id, request) {
  const status = parseEnum(request.status, STATUSES, 'status');
  if (status === 'Converted') throw AppError.badRequest('use_convert', 'Convert the request to an order to mark it converted.');
  if (request.internalNote?.includes('<') || request.internalNote?.includes('>')) {
    throw AppError.badRequest('invalid_text', 'The characters < and > are not allowed.');
  }
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT "Id", "Status" FROM "Inquiries" WHERE "Id" = $1 AND "BusinessId" = $2 FOR UPDATE`, [id, user.businessId]);
    const inquiry = rows[0];
    if (!inquiry) throw AppError.notFound('inquiry_not_found', 'Request not found.');
    if (inquiry.Status === 'Converted') throw AppError.conflict('already_converted', 'This request was already handled and cannot be changed.');
    const { rows: updated } = await client.query(
      `UPDATE "Inquiries" SET "Status" = $3, "InternalNote" = $4, "HandledByUserId" = $5, "HandledAtUtc" = now(), "UpdatedAtUtc" = now()
       WHERE "Id" = $1 AND "BusinessId" = $2
       RETURNING "Id", "Kind", "Status", "Name", "Email", "Phone", "Message", "DesignId", "DesignNameSnapshot", "GarmentType", "Budget", "PreferredDate", "EventDate", "ConvertedOrderId", "AppointmentId", "InternalNote", "CreatedAtUtc", "HandledAtUtc"`,
      [id, user.businessId, status, clean(request.internalNote), user.userId]);
    await client.query(
      `INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "EntityId", "EntityType")
       VALUES ($1, 'inquiry.updated', $2, $3, now(), $4, 'Inquiry')`, [randomUUID(), user.userId, user.businessId, id]);
    return dto(updated[0]);
  });
}

export async function summarizeInquiries(pool, user) {
  const { rows } = await pool.query(
    `SELECT "Status", count(*)::int AS "Count" FROM "Inquiries" WHERE "BusinessId" = $1 GROUP BY "Status"`, [user.businessId]);
  const counts = new Map(rows.map((row) => [row.Status, row.Count]));
  return { new: counts.get('New') ?? 0, reviewed: counts.get('Reviewed') ?? 0,
    converted: counts.get('Converted') ?? 0, rejected: counts.get('Rejected') ?? 0 };
}