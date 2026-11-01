import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { ciEnum } from '../http/ciEnum.js';
import { isBlank, parseEnum } from '../http/enums.js';
import { AppError } from '../http/errors.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';
import { hasAtMostPlaces } from '../money.js';
import { respondList, windowedRows } from './listWindow.js';

const customerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(256).or(z.literal('')).optional(),
  phone: z.string().trim().max(40).optional(),
  addressLine: z.string().trim().max(300).optional(),
  city: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(4000).optional(),
  garmentPreferences: z.string().trim().max(2000).optional(),
  version: z.number().int().min(0).max(4_294_967_295).optional(),
  allowDuplicate: z.boolean().default(false),
});

const customerStatusSchema = z.object({ status: ciEnum(['Active', 'Inactive', 'Merged']) });
const communicationSchema = z.object({
  channel: ciEnum(['Phone', 'Email', 'WhatsApp', 'InPerson', 'Other']),
  direction: ciEnum(['Inbound', 'Outbound']),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1).max(4000),
});

const fieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  label: z.string().trim().min(1).max(60),
  unit: z.enum(['cm', 'mm', 'in', 'kg', 'lb']),
  minValue: z.number().optional(),
  maxValue: z.number().optional(),
  isRequired: z.boolean().default(false),
});
const templateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional(),
  isActive: z.boolean().default(true),
  fields: z.array(fieldSchema).min(1).max(60),
});
const measurementSetSchema = z.object({
  templateId: z.string().uuid(),
  label: z.string().trim().min(1).max(80),
  values: z.record(z.string(), z.number()),
  notes: z.string().trim().max(2000).optional(),
});
const revisionSchema = z.object({
  values: z.record(z.string(), z.number()),
  notes: z.string().trim().max(2000).optional(),
});

const CUSTOMER_COLUMNS = `
  "Id", "FullName", "Email", "Phone", "AddressLine", "City", "Notes", "GarmentPreferences",
  "Status", "MergedIntoCustomerId", "NormalizedEmail", "NormalizedPhone",
  xmin::text::bigint AS "Version", "CreatedAtUtc"`;

function parse(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const errors = Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.') || 'body', [issue.message]]));
    throw new AppError(400, 'validation_failed', 'One or more validation errors occurred.', { errors });
  }
  return result.data;
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeEmail(value) {
  return clean(value)?.toLowerCase() ?? null;
}

function normalizePhone(value) {
  const digits = clean(value)?.replace(/\D/g, '') ?? '';
  return digits || null;
}

function customerDto(row) {
  return {
    id: row.Id,
    fullName: row.FullName,
    email: row.Email,
    phone: row.Phone,
    addressLine: row.AddressLine,
    city: row.City,
    notes: row.Notes,
    garmentPreferences: row.GarmentPreferences,
    status: row.Status,
    mergedIntoCustomerId: row.MergedIntoCustomerId,
    version: Number(row.Version),
    createdAtUtc: row.CreatedAtUtc,
  };
}

function pageQuery(query) {
  const page = Number.parseInt(query.page ?? '1', 10);
  const pageSize = Number.parseInt(query.pageSize ?? '25', 10);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw AppError.badRequest('invalid_paging', 'Page must be positive and pageSize must be between 1 and 100.');
  }
  return { page, pageSize };
}

function parseStatus(status) {
  return parseEnum(status, ['Active', 'Inactive', 'Merged'], 'status');
}

async function inTransaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function recordAudit(client, req, action, entityType, entityId, details = null) {
  await client.query(`
    INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityId", "EntityType")
    VALUES ($1, $2, $3, $4, now(), $5::jsonb, $6, $7)`,
  [randomUUID(), action, req.currentUser.userId, req.currentUser.businessId, details ? JSON.stringify(details) : null, entityId, entityType]);
}

function lockDuplicateKeys(client, email, phone) {
  const keys = [email && `email:${email}`, phone && `phone:${phone}`].filter(Boolean).sort();
  return Promise.all(keys.map((key) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [key])));
}

async function duplicateCandidates(db, businessId, email, phone, excludeId = null) {
  if (!email && !phone) return [];
  const { rows } = await db.query(`
    SELECT "Id", "FullName", "Email", "Phone", "NormalizedEmail", "NormalizedPhone"
    FROM "Customers"
    WHERE "BusinessId" = $1 AND "Status" <> 'Merged'
      AND (($2::text IS NOT NULL AND "NormalizedEmail" = $2) OR ($3::text IS NOT NULL AND "NormalizedPhone" = $3))
      AND ($4::uuid IS NULL OR "Id" <> $4)
    ORDER BY "CreatedAtUtc"
    LIMIT 5`, [businessId, email, phone, excludeId]);
  return rows.map((row) => ({
    id: row.Id,
    fullName: row.FullName,
    email: row.Email,
    phone: row.Phone,
    matchedOn: email && row.NormalizedEmail === email ? 'email' : 'phone',
  }));
}

function throwPossibleDuplicate(candidates) {
  throw AppError.conflict(
    'possible_duplicate',
    'A customer with the same email or phone already exists. Open the existing profile, or resubmit with allowDuplicate=true.',
    { candidates },
  );
}

function parseJson(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function validateTemplateFields(fields) {
  const problems = [];
  const seen = new Set();
  for (const field of fields) {
    if (seen.has(field.key)) problems.push(`Duplicate field key '${field.key}'.`);
    seen.add(field.key);
    if (field.minValue !== undefined && field.minValue < 0) problems.push(`'${field.key}': minimum cannot be negative.`);
    if (field.minValue !== undefined && field.maxValue !== undefined && field.minValue > field.maxValue) {
      problems.push(`'${field.key}': minimum exceeds maximum.`);
    }
  }
  if (problems.length) throw AppError.badRequest('invalid_template', problems.join(' '));
}

function validateMeasurementValues(fields, input) {
  const problems = [];
  const unknown = Object.keys(input).filter((key) => !fields.some((field) => field.Key === key));
  if (unknown.length) problems.push(`Unknown measurement(s): ${unknown.join(', ')}.`);
  const values = [];
  for (const field of fields) {
    if (!Object.hasOwn(input, field.Key)) {
      if (field.IsRequired) problems.push(`${field.Label} is required.`);
      continue;
    }
    const value = input[field.Key];
    if (typeof value !== 'number' || !Number.isFinite(value) || !hasAtMostPlaces(value, 2)) problems.push(`${field.Label}: at most 2 decimal places.`);
    else if (field.MinValue !== null && field.MinValue !== undefined && value < Number(field.MinValue)) {
      problems.push(`${field.Label}: must be at least ${field.MinValue}.`);
    } else if (field.MaxValue !== null && field.MaxValue !== undefined && value > Number(field.MaxValue)) {
      problems.push(`${field.Label}: must be at most ${field.MaxValue}.`);
    } else {
      values.push({ key: field.Key, label: field.Label, unit: field.Unit, value });
    }
  }
  if (problems.length) throw AppError.badRequest('invalid_measurements', problems.join(' '));
  return values;
}

function templateDto(template, fields) {
  return {
    id: template.Id,
    name: template.Name,
    description: template.Description,
    isActive: template.IsActive,
    fields: fields.map((field) => ({
      key: field.Key,
      label: field.Label,
      unit: field.Unit,
      minValue: field.MinValue === null ? null : Number(field.MinValue),
      maxValue: field.MaxValue === null ? null : Number(field.MaxValue),
      isRequired: field.IsRequired,
      sortOrder: Number(field.SortOrder),
    })),
  };
}

async function getTemplate(db, businessId, id) {
  const { rows } = await db.query(`
    SELECT t."Id", t."Name", t."Description", t."IsActive",
      f."Key", f."Label", f."Unit", f."MinValue", f."MaxValue", f."IsRequired", f."SortOrder"
    FROM "MeasurementTemplates" t
    LEFT JOIN "MeasurementTemplateFields" f ON f."TemplateId" = t."Id" AND f."BusinessId" = t."BusinessId"
    WHERE t."BusinessId" = $1 AND t."Id" = $2
    ORDER BY f."SortOrder"`, [businessId, id]);
  if (!rows.length) throw AppError.notFound('template_not_found', 'Measurement template not found.');
  const { Key, Label, Unit, MinValue, MaxValue, IsRequired, SortOrder, ...template } = rows[0];
  const fields = rows.filter((row) => row.Key !== null).map((row) => ({
    Key: row.Key, Label: row.Label, Unit: row.Unit, MinValue: row.MinValue, MaxValue: row.MaxValue,
    IsRequired: row.IsRequired, SortOrder: row.SortOrder,
  }));
  return templateDto(template, fields);
}

export function createCustomerRouter({ env, pool }) {
  const router = Router();
  const requireCustomersView = [requireBearerAuth(env, pool), requirePermission('customers.view')];
  const requireCustomersManage = [requireBearerAuth(env, pool), requirePermission('customers.manage')];
  const requireMeasurementsTemplates = [requireBearerAuth(env, pool), requirePermission('measurements.templates')];
  const requireMeasurementsRecord = [requireBearerAuth(env, pool), requirePermission('measurements.record')];

  router.get('/customers', ...requireCustomersView, async (req, res) => {
    const { page, pageSize } = pageQuery(req.query);
    const conditions = ['c."BusinessId" = $1'];
    const values = [req.currentUser.businessId];
    if (!isBlank(req.query.status)) {
      values.push(parseStatus(String(req.query.status)));
      conditions.push(`c."Status" = $${values.length}`);
    } else {
      conditions.push(`c."Status" <> 'Merged'`);
    }
    if (req.query.search) {
      const search = String(req.query.search).trim().slice(0, 100);
      const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      const phone = normalizePhone(search);
      values.push(pattern, phone);
      conditions.push(`(c."FullName" ILIKE $${values.length - 1} ESCAPE E'\\\\' OR c."Email" ILIKE $${values.length - 1} ESCAPE E'\\\\' OR ($${values.length}::text IS NOT NULL AND c."NormalizedPhone" LIKE '%' || $${values.length} || '%'))`);
    }
    const where = conditions.join(' AND ');
    const totalResult = await pool.query(`SELECT count(*)::int AS "TotalCount" FROM "Customers" c WHERE ${where}`, values);
    const sort = String(req.query.sort ?? '').toLowerCase();
    const descending = String(req.query.descending ?? '').toLowerCase() === 'true';
    const orderBy = sort === 'created'
      ? `c."CreatedAtUtc" ${descending ? 'DESC' : 'ASC'}`
      : `c."FullName" ${descending ? 'DESC' : 'ASC'}`;
    const listValues = [...values, pageSize, (page - 1) * pageSize];
    const { rows } = await pool.query(`
      SELECT c."Id", c."FullName", c."Email", c."Phone", c."Status", c."CreatedAtUtc",
        (SELECT count(*)::int FROM "Orders" o WHERE o."BusinessId" = c."BusinessId" AND o."CustomerId" = c."Id") AS "OrderCount"
      FROM "Customers" c
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, listValues);
    return res.status(200).json({
      items: rows.map((row) => ({
        id: row.Id,
        fullName: row.FullName,
        email: row.Email,
        phone: row.Phone,
        status: row.Status,
        orderCount: Number(row.OrderCount),
        createdAtUtc: row.CreatedAtUtc,
      })),
      page,
      pageSize,
      totalCount: Number(totalResult.rows[0]?.TotalCount ?? 0),
    });
  });

  router.get('/customers/:id', ...requireCustomersView, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_customer_id', 'The customer ID is invalid.');
    const { rows } = await pool.query(
      `SELECT ${CUSTOMER_COLUMNS} FROM "Customers" WHERE "BusinessId" = $1 AND "Id" = $2`,
      [req.currentUser.businessId, req.params.id],
    );
    if (!rows.length) throw AppError.notFound('customer_not_found', 'Customer not found.');
    return res.status(200).json(customerDto(rows[0]));
  });

  router.post('/customers', ...requireCustomersManage, async (req, res) => {
    const payload = parse(customerSchema.omit({ version: true }), req.body);
    const id = randomUUID();
    const email = clean(payload.email);
    const phone = clean(payload.phone);
    const normalizedEmail = normalizeEmail(email);
    const normalizedPhone = normalizePhone(phone);
    const customer = await inTransaction(pool, async (client) => {
      await lockDuplicateKeys(client, normalizedEmail, normalizedPhone);
      if (!payload.allowDuplicate) {
        const candidates = await duplicateCandidates(client, req.currentUser.businessId, normalizedEmail, normalizedPhone);
        if (candidates.length) throwPossibleDuplicate(candidates);
      }
      const { rows } = await client.query(`
        INSERT INTO "Customers" ("Id", "BusinessId", "FullName", "Email", "NormalizedEmail", "Phone", "NormalizedPhone",
          "AddressLine", "City", "Notes", "GarmentPreferences", "Status", "CreatedAtUtc")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'Active', now())
        RETURNING ${CUSTOMER_COLUMNS}`,
      [id, req.currentUser.businessId, payload.fullName, email, normalizedEmail, phone, normalizedPhone,
        clean(payload.addressLine), clean(payload.city), clean(payload.notes), clean(payload.garmentPreferences)]);
      await recordAudit(client, req, 'customer.created', 'Customer', id);
      return rows[0];
    });
    return res.status(201).json(customerDto(customer));
  });

  router.put('/customers/:id', ...requireCustomersManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_customer_id', 'The customer ID is invalid.');
    const payload = parse(customerSchema, req.body);
    if (payload.version === undefined) throw AppError.badRequest('version_required', "Include the customer's current version when updating.");
    const email = clean(payload.email);
    const phone = clean(payload.phone);
    const normalizedEmail = normalizeEmail(email);
    const normalizedPhone = normalizePhone(phone);
    const customer = await inTransaction(pool, async (client) => {
      const { rows: existingRows } = await client.query(
        `SELECT ${CUSTOMER_COLUMNS} FROM "Customers" WHERE "BusinessId" = $1 AND "Id" = $2 FOR UPDATE`,
        [req.currentUser.businessId, req.params.id],
      );
      const existing = existingRows[0];
      if (!existing) throw AppError.notFound('customer_not_found', 'Customer not found.');
      if (existing.Status === 'Merged') {
        throw AppError.conflict('customer_merged', 'This profile was merged into another customer and can no longer be edited.');
      }
      const contactChanged = existing.NormalizedEmail !== normalizedEmail || existing.NormalizedPhone !== normalizedPhone;
      if (contactChanged) await lockDuplicateKeys(client, normalizedEmail, normalizedPhone);
      if (contactChanged && !payload.allowDuplicate) {
        const candidates = await duplicateCandidates(client, req.currentUser.businessId, normalizedEmail, normalizedPhone, req.params.id);
        if (candidates.length) throwPossibleDuplicate(candidates);
      }
      const { rows } = await client.query(`
        UPDATE "Customers"
        SET "FullName" = $1, "Email" = $2, "NormalizedEmail" = $3, "Phone" = $4, "NormalizedPhone" = $5,
          "AddressLine" = $6, "City" = $7, "Notes" = $8, "GarmentPreferences" = $9, "UpdatedAtUtc" = now()
        WHERE "BusinessId" = $10 AND "Id" = $11 AND xmin = $12::xid
        RETURNING ${CUSTOMER_COLUMNS}`,
      [payload.fullName, email, normalizedEmail, phone, normalizedPhone, clean(payload.addressLine), clean(payload.city),
        clean(payload.notes), clean(payload.garmentPreferences), req.currentUser.businessId, req.params.id, payload.version]);
      if (!rows.length) throw AppError.conflict('stale_version', 'This customer was changed by someone else. Reload and try again.');
      await recordAudit(client, req, 'customer.updated', 'Customer', req.params.id);
      return rows[0];
    });
    return res.status(200).json(customerDto(customer));
  });

  router.post('/customers/:id/status', ...requireCustomersManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_customer_id', 'The customer ID is invalid.');
    const { status } = parse(customerStatusSchema, req.body);
    if (status === 'Merged') throw AppError.badRequest('invalid_status', 'Use the merge action to merge customers.');
    const customer = await inTransaction(pool, async (client) => {
      const { rows: existing } = await client.query(
        `SELECT "Status" FROM "Customers" WHERE "BusinessId" = $1 AND "Id" = $2 FOR UPDATE`,
        [req.currentUser.businessId, req.params.id],
      );
      if (!existing.length) throw AppError.notFound('customer_not_found', 'Customer not found.');
      if (existing[0].Status === 'Merged') throw AppError.conflict('customer_merged', 'Merged profiles cannot change status.');
      const { rows } = await client.query(`
        UPDATE "Customers" SET "Status" = $1, "UpdatedAtUtc" = now()
        WHERE "BusinessId" = $2 AND "Id" = $3
        RETURNING ${CUSTOMER_COLUMNS}`, [status, req.currentUser.businessId, req.params.id]);
      await recordAudit(client, req, 'customer.status_changed', 'Customer', req.params.id, { status });
      return rows[0];
    });
    return res.status(200).json(customerDto(customer));
  });

  router.post('/customers/:sourceId/merge-into/:targetId', ...[requireBearerAuth(env, pool), requirePermission('customers.merge')], async (req, res) => {
    if (!isUuid(req.params.sourceId) || !isUuid(req.params.targetId)) {
      throw AppError.badRequest('invalid_customer_ids', 'The customer IDs are invalid.');
    }
    if (req.params.sourceId === req.params.targetId) throw AppError.badRequest('same_customer', 'Choose two different customers to merge.');
    if (!req.currentUser.permissions.includes('locations.all')) {
      throw AppError.forbidden('customer_merge_requires_all_locations', 'Customer merges affect records across locations and require access to all workshop locations.');
    }
    const target = await inTransaction(pool, async (client) => {
      const { rows } = await client.query(`
        SELECT ${CUSTOMER_COLUMNS} FROM "Customers"
        WHERE "BusinessId" = $1 AND "Id" = ANY($2::uuid[]) ORDER BY "Id" FOR UPDATE`,
      [req.currentUser.businessId, [req.params.sourceId, req.params.targetId]]);
      const source = rows.find((row) => row.Id === req.params.sourceId);
      const destination = rows.find((row) => row.Id === req.params.targetId);
      if (!source || !destination) throw AppError.notFound('customer_not_found', 'Customer not found.');
      if (source.Status === 'Merged' || destination.Status === 'Merged') {
        throw AppError.conflict('already_merged', 'One of these profiles has already been merged.');
      }

      const { rows: targetSets } = await client.query(
        `SELECT "Label" FROM "MeasurementSets" WHERE "BusinessId" = $1 AND "CustomerId" = $2`,
        [req.currentUser.businessId, destination.Id],
      );
      const taken = new Set(targetSets.map((row) => row.Label));
      const { rows: sourceSets } = await client.query(
        `SELECT "Id", "Label" FROM "MeasurementSets" WHERE "BusinessId" = $1 AND "CustomerId" = $2 FOR UPDATE`,
        [req.currentUser.businessId, source.Id],
      );
      for (const set of sourceSets) {
        let label = set.Label;
        for (let n = 1; taken.has(label); n += 1) {
          const suffix = `${n > 1 ? ` ${n}` : ''}`;
          const prefix = ` (from ${source.FullName})${suffix}`;
          label = `${set.Label.slice(0, Math.max(0, 80 - prefix.length))}${prefix}`;
        }
        taken.add(label);
        await client.query(`UPDATE "MeasurementSets" SET "CustomerId" = $1, "Label" = $2, "UpdatedAtUtc" = now() WHERE "BusinessId" = $3 AND "Id" = $4`,
          [destination.Id, label, req.currentUser.businessId, set.Id]);
      }

      const { rows: updatedTarget } = await client.query(`
        UPDATE "Customers" SET
          "Email" = COALESCE("Email", $1), "NormalizedEmail" = COALESCE("NormalizedEmail", $2),
          "Phone" = COALESCE("Phone", $3), "NormalizedPhone" = COALESCE("NormalizedPhone", $4),
          "AddressLine" = COALESCE("AddressLine", $5), "City" = COALESCE("City", $6), "UpdatedAtUtc" = now()
        WHERE "BusinessId" = $7 AND "Id" = $8
        RETURNING ${CUSTOMER_COLUMNS}`,
      [source.Email, source.NormalizedEmail, source.Phone, source.NormalizedPhone, source.AddressLine, source.City,
        req.currentUser.businessId, destination.Id]);
      await client.query(`
        UPDATE "Customers" SET "Status" = 'Merged', "MergedIntoCustomerId" = $1, "UpdatedAtUtc" = now()
        WHERE "BusinessId" = $2 AND "Id" = $3`, [destination.Id, req.currentUser.businessId, source.Id]);
      for (const table of ['Orders', 'CustomerCommunications', 'Fittings', 'Documents']) {
        await client.query(`UPDATE "${table}" SET "CustomerId" = $1 WHERE "BusinessId" = $2 AND "CustomerId" = $3`,
          [destination.Id, req.currentUser.businessId, source.Id]);
      }
      await recordAudit(client, req, 'customer.merged', 'Customer', destination.Id, { sourceId: source.Id, targetId: destination.Id });
      return updatedTarget[0];
    });
    return res.status(200).json(customerDto(target));
  });

  router.get('/customers/:id/communications', ...requireCustomersView, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_customer_id', 'The customer ID is invalid.');
    const customer = await pool.query(`SELECT 1 FROM "Customers" WHERE "BusinessId" = $1 AND "Id" = $2`,
      [req.currentUser.businessId, req.params.id]);
    if (!customer.rows.length) throw AppError.notFound('customer_not_found', 'Customer not found.');
    const { rows } = await pool.query(`
      SELECT "Id", "Channel", "Direction", "Subject", "Body", "RecordedByUserId", "CreatedAtUtc"
      FROM "CustomerCommunications" WHERE "BusinessId" = $1 AND "CustomerId" = $2
      ORDER BY "CreatedAtUtc" DESC LIMIT 200`, [req.currentUser.businessId, req.params.id]);
    return res.status(200).json(rows.map((row) => ({
      id: row.Id, channel: row.Channel, direction: row.Direction, subject: row.Subject,
      body: row.Body, recordedByUserId: row.RecordedByUserId, createdAtUtc: row.CreatedAtUtc,
    })));
  });

  router.post('/customers/:id/communications', ...requireCustomersManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_customer_id', 'The customer ID is invalid.');
    const payload = parse(communicationSchema, req.body);
    const id = randomUUID();
    const communication = await inTransaction(pool, async (client) => {
      const customer = await client.query(`SELECT 1 FROM "Customers" WHERE "BusinessId" = $1 AND "Id" = $2`,
        [req.currentUser.businessId, req.params.id]);
      if (!customer.rows.length) throw AppError.notFound('customer_not_found', 'Customer not found.');
      const { rows } = await client.query(`
        INSERT INTO "CustomerCommunications" ("Id", "BusinessId", "CustomerId", "Channel", "Direction", "Subject", "Body", "RecordedByUserId", "CreatedAtUtc")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
        RETURNING "Id", "Channel", "Direction", "Subject", "Body", "RecordedByUserId", "CreatedAtUtc"`,
      [id, req.currentUser.businessId, req.params.id, payload.channel, payload.direction, clean(payload.subject),
        payload.body, req.currentUser.userId]);
      await recordAudit(client, req, 'customer.communication_added', 'Customer', req.params.id);
      return rows[0];
    });
    return res.status(201).json({
      id: communication.Id, channel: communication.Channel, direction: communication.Direction,
      subject: communication.Subject, body: communication.Body, recordedByUserId: communication.RecordedByUserId,
      createdAtUtc: communication.CreatedAtUtc,
    });
  });

  router.get('/customers/:id/measurements', ...requireCustomersView, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_customer_id', 'The customer ID is invalid.');
    const customer = await pool.query(`SELECT "Status" FROM "Customers" WHERE "BusinessId" = $1 AND "Id" = $2`,
      [req.currentUser.businessId, req.params.id]);
    if (!customer.rows.length) throw AppError.notFound('customer_not_found', 'Customer not found.');
    if (customer.rows[0].Status === 'Merged') throw AppError.conflict('customer_not_active', 'This customer profile is not active.');
    await respondList(res, req.query, async (window) => {
      const { rows, totalCount } = await windowedRows((sql, params) => pool.query(sql, params), `
      SELECT s."Id", s."CustomerId", s."TemplateId", t."Name" AS "TemplateName", s."Label",
        s."CurrentRevision", r."ValuesJson", COALESCE(s."UpdatedAtUtc", s."CreatedAtUtc") AS "UpdatedAtUtc"
      FROM "MeasurementSets" s
      JOIN "MeasurementTemplates" t ON t."Id" = s."TemplateId" AND t."BusinessId" = s."BusinessId"
      JOIN "MeasurementRevisions" r ON r."SetId" = s."Id" AND r."RevisionNumber" = s."CurrentRevision" AND r."BusinessId" = s."BusinessId"
      WHERE s."BusinessId" = $1 AND s."CustomerId" = $2 ORDER BY s."Label", s."Id"`, [req.currentUser.businessId, req.params.id], window);
      return { totalCount, rows: rows.map((row) => ({
        id: row.Id, customerId: row.CustomerId, templateId: row.TemplateId, templateName: row.TemplateName,
        label: row.Label, currentRevision: Number(row.CurrentRevision), values: parseJson(row.ValuesJson),
        updatedAtUtc: row.UpdatedAtUtc,
      })) };
    });
  });

  router.post('/customers/:id/measurements', ...requireMeasurementsRecord, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_customer_id', 'The customer ID is invalid.');
    const payload = parse(measurementSetSchema, req.body);
    const setId = randomUUID();
    const revisionId = randomUUID();
    let set;
    try {
      set = await inTransaction(pool, async (client) => {
        const { rows: customerRows } = await client.query(
          `SELECT "Status" FROM "Customers" WHERE "BusinessId" = $1 AND "Id" = $2 FOR SHARE`,
          [req.currentUser.businessId, req.params.id],
        );
        if (!customerRows.length) throw AppError.notFound('customer_not_found', 'Customer not found.');
        if (customerRows[0].Status !== 'Active') {
          throw AppError.conflict('customer_not_active', 'This customer profile is not active.');
        }
        const { rows: templateRows } = await client.query(`
          SELECT t."Id", t."Name", t."IsActive", f."Key", f."Label", f."Unit", f."MinValue", f."MaxValue", f."IsRequired", f."SortOrder"
          FROM "MeasurementTemplates" t LEFT JOIN "MeasurementTemplateFields" f
            ON f."TemplateId" = t."Id" AND f."BusinessId" = t."BusinessId"
          WHERE t."BusinessId" = $1 AND t."Id" = $2 ORDER BY f."SortOrder"`,
        [req.currentUser.businessId, payload.templateId]);
        if (!templateRows.length) throw AppError.badRequest('unknown_template', 'Measurement template not found.');
        if (!templateRows[0].IsActive) throw AppError.conflict('template_inactive', 'This template is inactive.');
        const fields = templateRows.filter((row) => row.Key !== null).map((row) => ({
          Key: row.Key, Label: row.Label, Unit: row.Unit, MinValue: row.MinValue, MaxValue: row.MaxValue, IsRequired: row.IsRequired,
        }));
        const values = validateMeasurementValues(fields, payload.values);
        const duplicate = await client.query(
          `SELECT 1 FROM "MeasurementSets" WHERE "BusinessId" = $1 AND "CustomerId" = $2 AND "Label" = $3`,
          [req.currentUser.businessId, req.params.id, payload.label]);
        if (duplicate.rows.length) {
          throw AppError.conflict('label_exists', 'This customer already has a measurement profile with that label.');
        }
        await client.query(`
          INSERT INTO "MeasurementSets" ("Id", "BusinessId", "CustomerId", "TemplateId", "Label", "CurrentRevision", "CreatedAtUtc")
          VALUES ($1, $2, $3, $4, $5, 1, now())`,
        [setId, req.currentUser.businessId, req.params.id, payload.templateId, payload.label]);
        await client.query(`
          INSERT INTO "MeasurementRevisions" ("Id", "BusinessId", "SetId", "RevisionNumber", "ValuesJson", "Notes", "RecordedByUserId", "CreatedAtUtc")
          VALUES ($1, $2, $3, 1, $4::jsonb, $5, $6, now())`,
        [revisionId, req.currentUser.businessId, setId, JSON.stringify(values), clean(payload.notes), req.currentUser.userId]);
        await recordAudit(client, req, 'measurements.recorded', 'CustomerMeasurementSet', setId,
          { customerId: req.params.id, template: templateRows[0].Name });
        return {
          id: setId, customerId: req.params.id, templateId: payload.templateId, templateName: templateRows[0].Name,
          label: payload.label, currentRevision: 1, values, updatedAtUtc: new Date().toISOString(),
        };
      });
    } catch (error) {
      if (error?.code === '23505') {
        throw AppError.conflict('concurrent_edit', 'These measurements were changed at the same time by someone else. Reload and try again.');
      }
      throw error;
    }
    return res.status(201).json(set);
  });

  router.get('/measurement-templates', ...requireCustomersView, async (req, res) => {
    const includeInactive = String(req.query.includeInactive ?? '').toLowerCase() === 'true';
    const { rows } = await pool.query(`
      SELECT t."Id", t."Name", t."Description", t."IsActive", f."Key", f."Label", f."Unit",
        f."MinValue", f."MaxValue", f."IsRequired", f."SortOrder"
      FROM "MeasurementTemplates" t
      LEFT JOIN "MeasurementTemplateFields" f ON f."TemplateId" = t."Id" AND f."BusinessId" = t."BusinessId"
      WHERE t."BusinessId" = $1 AND ($2::boolean OR t."IsActive")
      ORDER BY t."Name", f."SortOrder"`, [req.currentUser.businessId, includeInactive]);
    const grouped = new Map();
    for (const row of rows) {
      if (!grouped.has(row.Id)) grouped.set(row.Id, { template: row, fields: [] });
      if (row.Key !== null) grouped.get(row.Id).fields.push({
        Key: row.Key, Label: row.Label, Unit: row.Unit, MinValue: row.MinValue, MaxValue: row.MaxValue,
        IsRequired: row.IsRequired, SortOrder: row.SortOrder,
      });
    }
    return res.status(200).json([...grouped.values()].map(({ template, fields }) => templateDto(template, fields)));
  });

  router.get('/measurement-templates/:id', ...requireCustomersView, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_template_id', 'The template ID is invalid.');
    return res.status(200).json(await getTemplate(pool, req.currentUser.businessId, req.params.id));
  });

  router.post('/measurement-templates', ...requireMeasurementsTemplates, async (req, res) => {
    const payload = parse(templateSchema, req.body);
    validateTemplateFields(payload.fields);
    const templateId = randomUUID();
    try {
      const result = await inTransaction(pool, async (client) => {
        const { rows } = await client.query(`
          INSERT INTO "MeasurementTemplates" ("Id", "BusinessId", "Name", "Description", "IsActive", "CreatedAtUtc")
          VALUES ($1, $2, $3, $4, $5, now())
          RETURNING "Id", "Name", "Description", "IsActive"`,
        [templateId, req.currentUser.businessId, payload.name, clean(payload.description), payload.isActive]);
        const fields = [];
        for (let i = 0; i < payload.fields.length; i += 1) {
          const field = payload.fields[i];
          fields.push({
            Key: field.key, Label: field.label, Unit: field.unit, MinValue: field.minValue ?? null,
            MaxValue: field.maxValue ?? null, IsRequired: field.isRequired, SortOrder: i,
          });
          await client.query(`
            INSERT INTO "MeasurementTemplateFields" ("Id", "BusinessId", "TemplateId", "Key", "Label", "Unit",
              "MinValue", "MaxValue", "IsRequired", "SortOrder", "CreatedAtUtc")
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
          [randomUUID(), req.currentUser.businessId, templateId, field.key, field.label, field.unit,
            field.minValue ?? null, field.maxValue ?? null, field.isRequired, i]);
        }
        await recordAudit(client, req, 'measurement_template.created', 'MeasurementTemplate', templateId, { name: payload.name });
        return templateDto(rows[0], fields);
      });
      return res.status(201).json(result);
    } catch (error) {
      if (error?.code === '23505') throw AppError.conflict('template_exists', 'A template with this name already exists.');
      throw error;
    }
  });

  router.put('/measurement-templates/:id', ...requireMeasurementsTemplates, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_template_id', 'The template ID is invalid.');
    const payload = parse(templateSchema, req.body);
    validateTemplateFields(payload.fields);
    try {
      const updated = await inTransaction(pool, async (client) => {
        const { rows } = await client.query(`
          SELECT "Id", "Name", "Description", "IsActive" FROM "MeasurementTemplates"
          WHERE "BusinessId" = $1 AND "Id" = $2 FOR UPDATE`,
        [req.currentUser.businessId, req.params.id]);
        if (!rows.length) throw AppError.notFound('template_not_found', 'Measurement template not found.');
        const { rows: duplicate } = await client.query(
          `SELECT 1 FROM "MeasurementTemplates" WHERE "BusinessId" = $1 AND "Name" = $2 AND "Id" <> $3`,
          [req.currentUser.businessId, payload.name, req.params.id]);
        if (duplicate.length) throw AppError.conflict('template_exists', 'A template with this name already exists.');
        const { rows: currentFields } = await client.query(
          `SELECT "Id", "Key" FROM "MeasurementTemplateFields" WHERE "BusinessId" = $1 AND "TemplateId" = $2`,
          [req.currentUser.businessId, req.params.id]);
        const incomingKeys = payload.fields.map((field) => field.key);
        const removed = currentFields.filter((field) => !incomingKeys.includes(field.Key));
        for (const field of removed) {
          await client.query(`DELETE FROM "MeasurementTemplateFields" WHERE "BusinessId" = $1 AND "Id" = $2`,
            [req.currentUser.businessId, field.Id]);
        }
        const orderedFields = [];
        for (let i = 0; i < payload.fields.length; i += 1) {
          const field = payload.fields[i];
          const existing = currentFields.find((item) => item.Key === field.key);
          if (existing) {
            await client.query(`
              UPDATE "MeasurementTemplateFields" SET "Label" = $1, "Unit" = $2, "MinValue" = $3, "MaxValue" = $4,
                "IsRequired" = $5, "SortOrder" = $6, "UpdatedAtUtc" = now()
              WHERE "BusinessId" = $7 AND "Id" = $8`,
            [field.label, field.unit, field.minValue ?? null, field.maxValue ?? null, field.isRequired, i,
              req.currentUser.businessId, existing.Id]);
          } else {
            await client.query(`
              INSERT INTO "MeasurementTemplateFields" ("Id", "BusinessId", "TemplateId", "Key", "Label", "Unit",
                "MinValue", "MaxValue", "IsRequired", "SortOrder", "CreatedAtUtc")
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
            [randomUUID(), req.currentUser.businessId, req.params.id, field.key, field.label, field.unit,
              field.minValue ?? null, field.maxValue ?? null, field.isRequired, i]);
          }
          orderedFields.push({
            Key: field.key, Label: field.label, Unit: field.unit, MinValue: field.minValue ?? null,
            MaxValue: field.maxValue ?? null, IsRequired: field.isRequired, SortOrder: i,
          });
        }
        const { rows: updatedRows } = await client.query(`
          UPDATE "MeasurementTemplates" SET "Name" = $1, "Description" = $2, "IsActive" = $3, "UpdatedAtUtc" = now()
          WHERE "BusinessId" = $4 AND "Id" = $5
          RETURNING "Id", "Name", "Description", "IsActive"`,
        [payload.name, clean(payload.description), payload.isActive, req.currentUser.businessId, req.params.id]);
        await recordAudit(client, req, 'measurement_template.updated', 'MeasurementTemplate', req.params.id, { name: payload.name });
        return templateDto(updatedRows[0], orderedFields);
      });
      return res.status(200).json(updated);
    } catch (error) {
      if (error?.code === '23505') throw AppError.conflict('template_exists', 'A template with this name already exists.');
      throw error;
    }
  });

  router.post('/measurement-sets/:id/revisions', ...requireMeasurementsRecord, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_measurement_set_id', 'The measurement set ID is invalid.');
    const payload = parse(revisionSchema, req.body);
    const set = await inTransaction(pool, async (client) => {
      const { rows: setRows } = await client.query(`
        SELECT s."Id", s."CustomerId", s."TemplateId", s."Label", s."CurrentRevision", c."Status"
        FROM "MeasurementSets" s JOIN "Customers" c ON c."BusinessId" = s."BusinessId" AND c."Id" = s."CustomerId"
        WHERE s."BusinessId" = $1 AND s."Id" = $2 FOR UPDATE OF s`,
      [req.currentUser.businessId, req.params.id]);
      if (!setRows.length) throw AppError.notFound('measurement_set_not_found', 'Measurement profile not found.');
      if (setRows[0].Status !== 'Active') throw AppError.conflict('customer_not_active', 'This customer profile is not active.');
      const { rows: templateRows } = await client.query(`
        SELECT t."Name", f."Key", f."Label", f."Unit", f."MinValue", f."MaxValue", f."IsRequired", f."SortOrder"
        FROM "MeasurementTemplates" t LEFT JOIN "MeasurementTemplateFields" f
          ON f."TemplateId" = t."Id" AND f."BusinessId" = t."BusinessId"
        WHERE t."BusinessId" = $1 AND t."Id" = $2 ORDER BY f."SortOrder"`,
      [req.currentUser.businessId, setRows[0].TemplateId]);
      const fields = templateRows.filter((row) => row.Key !== null).map((row) => ({
        Key: row.Key, Label: row.Label, Unit: row.Unit, MinValue: row.MinValue, MaxValue: row.MaxValue, IsRequired: row.IsRequired,
      }));
      const values = validateMeasurementValues(fields, payload.values);
      const revisionNumber = Number(setRows[0].CurrentRevision) + 1;
      await client.query(`
        INSERT INTO "MeasurementRevisions" ("Id", "BusinessId", "SetId", "RevisionNumber", "ValuesJson", "Notes", "RecordedByUserId", "CreatedAtUtc")
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now())`,
      [randomUUID(), req.currentUser.businessId, req.params.id, revisionNumber, JSON.stringify(values), clean(payload.notes), req.currentUser.userId]);
      await client.query(`UPDATE "MeasurementSets" SET "CurrentRevision" = $1, "UpdatedAtUtc" = now() WHERE "BusinessId" = $2 AND "Id" = $3`,
        [revisionNumber, req.currentUser.businessId, req.params.id]);
      await recordAudit(client, req, 'measurements.revised', 'CustomerMeasurementSet', req.params.id, { revision: revisionNumber });
      return {
        id: setRows[0].Id, customerId: setRows[0].CustomerId, templateId: setRows[0].TemplateId,
        templateName: templateRows[0].Name, label: setRows[0].Label, currentRevision: revisionNumber,
        values, updatedAtUtc: new Date().toISOString(),
      };
    });
    return res.status(200).json(set);
  });

  router.get('/measurement-sets/:id/history', ...requireCustomersView, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_measurement_set_id', 'The measurement set ID is invalid.');
    const { rows } = await pool.query(`
      SELECT r."RevisionNumber", r."ValuesJson", r."Notes", r."RecordedByUserId", r."CreatedAtUtc"
      FROM "MeasurementRevisions" r JOIN "MeasurementSets" s ON s."BusinessId" = r."BusinessId" AND s."Id" = r."SetId"
      WHERE r."BusinessId" = $1 AND s."Id" = $2 ORDER BY r."RevisionNumber" DESC`,
    [req.currentUser.businessId, req.params.id]);
    if (!rows.length) {
      const found = await pool.query(`SELECT 1 FROM "MeasurementSets" WHERE "BusinessId" = $1 AND "Id" = $2`,
        [req.currentUser.businessId, req.params.id]);
      if (!found.rows.length) throw AppError.notFound('measurement_set_not_found', 'Measurement profile not found.');
    }
    return res.status(200).json(rows.map((row) => ({
      revisionNumber: Number(row.RevisionNumber),
      values: parseJson(row.ValuesJson),
      notes: row.Notes,
      recordedByUserId: row.RecordedByUserId,
      recordedAtUtc: row.CreatedAtUtc,
    })));
  });

  router.get('/measurement-sets/:id/compare', ...requireCustomersView, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_measurement_set_id', 'The measurement set ID is invalid.');
    const from = Number.parseInt(String(req.query.from ?? ''), 10);
    const to = Number.parseInt(String(req.query.to ?? ''), 10);
    if (!Number.isInteger(from) || from < 1 || !Number.isInteger(to) || to < 1) {
      throw AppError.badRequest('invalid_revision', 'Both from and to revision numbers must be positive integers.');
    }
    const { rows } = await pool.query(`
      SELECT "RevisionNumber", "ValuesJson" FROM "MeasurementRevisions"
      WHERE "BusinessId" = $1 AND "SetId" = $2 AND "RevisionNumber" = ANY($3::integer[])`,
    [req.currentUser.businessId, req.params.id, [from, to]]);
    const fromRow = rows.find((row) => Number(row.RevisionNumber) === from);
    const toRow = rows.find((row) => Number(row.RevisionNumber) === to);
    if (!fromRow || !toRow) {
      const found = await pool.query(`SELECT 1 FROM "MeasurementSets" WHERE "BusinessId" = $1 AND "Id" = $2`,
        [req.currentUser.businessId, req.params.id]);
      if (!found.rows.length) throw AppError.notFound('measurement_set_not_found', 'Measurement profile not found.');
      throw AppError.notFound('revision_not_found', 'One of the requested revisions does not exist.');
    }
    const before = new Map(parseJson(fromRow.ValuesJson).map((value) => [value.key, value]));
    const after = new Map(parseJson(toRow.ValuesJson).map((value) => [value.key, value]));
    const keys = [...after.keys(), ...[...before.keys()].filter((key) => !after.has(key))];
    return res.status(200).json(keys.map((key) => {
      const value = after.get(key) ?? before.get(key);
      const fromValue = before.get(key)?.value ?? null;
      const toValue = after.get(key)?.value ?? null;
      return {
        key,
        label: value.label,
        unit: value.unit,
        from: fromValue,
        to: toValue,
        delta: fromValue !== null && toValue !== null ? toValue - fromValue : null,
      };
    }));
  });

  return router;
}
