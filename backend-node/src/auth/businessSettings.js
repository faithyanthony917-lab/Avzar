import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';
import { withTransaction } from './accountService.js';

// Lengths are enforced after whitespace cleaning (cleanText), so the schema bound is only a sanity cap.
const brandingSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  accentColor: z.string().max(40).nullish(),
  logoMediaId: z.string().uuid().nullish(),
  phone: z.string().max(1000).nullish(),
  email: z.string().max(1000).nullish(),
  taxNumber: z.string().max(1000).nullish(),
  footerNote: z.string().max(2000).nullish(),
});

// WCAG contrast of the accent against white paper; below this, headings on generated PDFs are hard to read.
const MIN_CONTRAST_ON_WHITE = 3.0;

function contrastOnWhite(hex) {
  const channel = (start) => {
    const c = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return 1.05 / (luminance + 0.05);
}

/** One line of plain text: control characters become spaces and whitespace runs collapse, so nothing odd reaches a PDF. */
function cleanText(value, max, label) {
  if (value == null || String(value).trim() === '') return null;
  // eslint-disable-next-line no-control-regex
  const clean = String(value).trim().replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return null;
  if (clean.length > max) throw AppError.badRequest('branding_too_long', `The ${label} can be at most ${max} characters.`);
  return clean;
}

function cleanColor(value) {
  if (value == null || String(value).trim() === '') return null;
  const v = String(value).trim();
  if (!/^#[0-9A-Fa-f]{6}$/.test(v)) throw AppError.badRequest('invalid_brand_color', 'Use a colour like #1F3A5F (a # and six hex digits).');
  const upper = v.toUpperCase();
  if (contrastOnWhite(upper) < MIN_CONTRAST_ON_WHITE) {
    throw AppError.badRequest('brand_color_too_light', 'That colour is too light to read on white paper. Choose a darker one.');
  }
  return upper;
}

function brandingDto(businessId, row, fallbackName) {
  return {
    businessId,
    name: row?.Name ?? fallbackName,
    accentColor: row?.BrandColor ?? null,
    logoMediaId: row?.LogoMediaId ?? null,
    phone: row?.ContactPhone ?? null,
    email: row?.ContactEmail ?? null,
    taxNumber: row?.TaxNumber ?? null,
    footerNote: row?.PdfFooterNote ?? null,
  };
}

const BRANDING_COLUMNS = '"Id", "Name", "TimeZoneId", "BrandColor", "LogoMediaId", "ContactPhone", "ContactEmail", "TaxNumber", "PdfFooterNote"';

const dayHoursSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  isOpen: z.boolean(),
  opensAt: z.string().max(5).nullable().optional(),
  closesAt: z.string().max(5).nullable().optional(),
});

const hoursSchema = z.object({ days: z.array(dayHoursSchema).length(7) });
const holidaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    if (value.startsWith('0000')) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }),
  name: z.string().min(1).max(80).refine((value) => value.trim().length > 0),
});

function parse(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const errors = Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.') || 'body', [issue.message]]));
    throw new AppError(400, 'validation_failed', 'One or more validation errors occurred.', { errors });
  }
  return result.data;
}

function defaultSchedule(timeZoneId = 'UTC') {
  return {
    timeZoneId,
    days: Array.from({ length: 7 }, (_, index) => ({
      dayOfWeek: index,
      isOpen: index >= 1 && index <= 6,
      opensAt: index >= 1 && index <= 6 ? '09:00' : null,
      closesAt: index >= 1 && index <= 6 ? '17:00' : null,
    })),
    holidays: [],
  };
}

// A logo must be a business image that is not a task progress photo; task photos are only served through the task-scoped routes.
export async function assertLogoMedia(db, businessId, mediaId) {
  const media = await db.query(`
    SELECT 1 FROM "MediaAssets" a
    WHERE a."BusinessId" = $1 AND a."Id" = $2 AND a."Purpose" <> 'TaskProgressPhoto'
      AND NOT EXISTS (SELECT 1 FROM "TaskProgressPhotos" tp WHERE tp."BusinessId" = a."BusinessId" AND tp."MediaAssetId" = a."Id")`,
  [businessId, mediaId]);
  if (!media.rows.length) throw AppError.notFound('media_not_found', 'That image was not found. Upload it first, then choose it as the logo.');
}

export function createBusinessSettingsRouter({ env, pool }) {
  const router = Router();

  const requireBusinessSettings = [requireBearerAuth(env, pool), requirePermission('business.settings')];

  router.get('/business/branding', ...requireBusinessSettings, async (req, res) => {
    const businessId = req.currentUser?.businessId;
    if (!businessId) throw AppError.unauthorized('unauthorized', 'Authentication is required.');
    const row = pool ? (await pool.query(`SELECT ${BRANDING_COLUMNS} FROM "Businesses" WHERE "Id" = $1 LIMIT 1`, [businessId])).rows[0] : null;
    return res.status(200).json(brandingDto(businessId, row, req.currentUser.businessName ?? 'Shop'));
  });

  // Full replace, a field that is omitted or blank is cleared.
  // These columns are what invoice, credit-note and receipt PDFs read (pdfService.js, receiptPdfService.js).
  router.put('/business/branding', ...requireBusinessSettings, async (req, res) => {
    const payload = parse(brandingSchema, req.body);
    const businessId = req.currentUser?.businessId;
    const actorId = req.currentUser?.userId;
    if (!businessId) throw AppError.unauthorized('unauthorized', 'Authentication is required.');

    const accentColor = cleanColor(payload.accentColor);
    const phone = cleanText(payload.phone, 40, 'phone number');
    const email = cleanText(payload.email, 254, 'email');
    if (email !== null && !/^[^@\s]+@[^@\s]+$/.test(email)) throw AppError.badRequest('invalid_email', 'Enter a valid email address.');
    const taxNumber = cleanText(payload.taxNumber, 60, 'tax number');
    const footerNote = cleanText(payload.footerNote, 300, 'footer note');
    const logoMediaId = payload.logoMediaId ?? null;

    const updated = await withTransaction(pool, async (client) => {
      if (logoMediaId) await assertLogoMedia(client, businessId, logoMediaId);
      const current = (await client.query(`SELECT ${BRANDING_COLUMNS} FROM "Businesses" WHERE "Id" = $1 FOR UPDATE`, [businessId])).rows[0];
      if (!current) throw AppError.notFound('business_not_found', 'Business not found.');
      const name = payload.name ?? current.Name;
      const changed = [];
      if (name !== current.Name) changed.push('name');
      if ((current.BrandColor ?? null) !== accentColor) changed.push('accentColor');
      if ((current.LogoMediaId ?? null) !== logoMediaId) changed.push('logo');
      if ((current.ContactPhone ?? null) !== phone) changed.push('phone');
      if ((current.ContactEmail ?? null) !== email) changed.push('email');
      if ((current.TaxNumber ?? null) !== taxNumber) changed.push('taxNumber');
      if ((current.PdfFooterNote ?? null) !== footerNote) changed.push('footerNote');
      if (changed.length > 0) {
        await client.query(
          `UPDATE "Businesses" SET "Name" = $1, "BrandColor" = $2, "LogoMediaId" = $3, "ContactPhone" = $4,
             "ContactEmail" = $5, "TaxNumber" = $6, "PdfFooterNote" = $7, "UpdatedAtUtc" = now()
           WHERE "Id" = $8`,
          [name, accentColor, logoMediaId, phone, email, taxNumber, footerNote, businessId]);
        await client.query(
          `INSERT INTO "AuditLogs" ("Id","Action","ActorUserId","BusinessId","CreatedAtUtc","DetailsJson","EntityId","EntityType")
           VALUES ($1,'business.branding_updated',$2,$3,now(),$4::jsonb,$5,'Business')`,
          [randomUUID(), actorId, businessId, JSON.stringify({ changed }), businessId]); // field names only, never values
      }
      return { Name: name, BrandColor: accentColor, LogoMediaId: logoMediaId, ContactPhone: phone, ContactEmail: email, TaxNumber: taxNumber, PdfFooterNote: footerNote };
    });
    return res.status(200).json(brandingDto(businessId, updated, req.currentUser.businessName ?? 'Shop'));
  });

  router.get('/business/schedule', ...requireBusinessSettings, async (req, res) => {
    const businessId = req.currentUser?.businessId;
    if (!businessId) throw AppError.unauthorized('unauthorized', 'Authentication is required.');
    const businessRow = pool ? (await pool.query('SELECT "Id", "TimeZoneId" FROM "Businesses" WHERE "Id" = $1 LIMIT 1', [businessId])).rows[0] : null;
    return res.status(200).json(defaultSchedule(businessRow?.TimeZoneId ?? 'UTC'));
  });

  router.put('/business/schedule/hours', ...requireBusinessSettings, async (req, res) => {
    const payload = parse(hoursSchema, req.body);
    const businessId = req.currentUser?.businessId;
    if (!businessId) throw AppError.unauthorized('unauthorized', 'Authentication is required.');
    const businessRow = pool ? (await pool.query('SELECT "Id", "TimeZoneId" FROM "Businesses" WHERE "Id" = $1 LIMIT 1', [businessId])).rows[0] : null;
    const schedule = defaultSchedule(businessRow?.TimeZoneId ?? 'UTC');
    schedule.days = payload.days.map((day) => ({
      dayOfWeek: day.dayOfWeek,
      isOpen: day.isOpen,
      opensAt: day.isOpen ? day.opensAt ?? '09:00' : null,
      closesAt: day.isOpen ? day.closesAt ?? '17:00' : null,
    }));
    return res.status(200).json(schedule);
  });

  router.post('/business/schedule/holidays', ...requireBusinessSettings, async (req, res) => {
    const payload = parse(holidaySchema, req.body);
    const businessId = req.currentUser.businessId;
    const actorId = req.currentUser.userId;
    const holiday = await withTransaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [businessId]);
      const duplicate = await client.query('SELECT 1 FROM "BusinessHolidays" WHERE "BusinessId" = $1 AND "Date" = $2 LIMIT 1', [businessId, payload.date]);
      if (duplicate.rows.length) throw AppError.conflict('holiday_exists', 'That date is already marked as closed.');
      const count = await client.query('SELECT count(*)::int AS "Count" FROM "BusinessHolidays" WHERE "BusinessId" = $1', [businessId]);
      if (count.rows[0].Count >= 400) {
        throw AppError.badRequest('too_many_holidays', 'A business can have at most 400 closed dates.');
      }
      const id = randomUUID();
      const inserted = await client.query(
        `INSERT INTO "BusinessHolidays" ("Id","BusinessId","Date","Name","CreatedAtUtc")
         VALUES ($1,$2,$3,$4,now()) ON CONFLICT ("BusinessId","Date") DO NOTHING
         RETURNING "Id","Date","Name"`, [id, businessId, payload.date, payload.name.trim()]);
      if (!inserted.rows.length) throw AppError.conflict('holiday_exists', 'That date is already marked as closed.');
      await client.query(
        `INSERT INTO "AuditLogs" ("Id","Action","ActorUserId","BusinessId","CreatedAtUtc","EntityId","EntityType")
         VALUES ($1,'business.holiday_added',$2,$3,now(),$4,'BusinessHoliday')`, [randomUUID(), actorId, businessId, id]);
      return { id: inserted.rows[0].Id, date: inserted.rows[0].Date, name: inserted.rows[0].Name };
    });
    return res.status(201).json(holiday);
  });

  router.delete('/business/schedule/holidays/:holidayId', ...requireBusinessSettings, async (req, res) => {
    const businessId = req.currentUser.businessId;
    const actorId = req.currentUser.userId;
    const holidayId = z.string().uuid().safeParse(req.params.holidayId);
    if (!holidayId.success) throw AppError.notFound('holiday_not_found', 'Closed date not found.');
    await withTransaction(pool, async (client) => {
      const removed = await client.query(
        'DELETE FROM "BusinessHolidays" WHERE "Id" = $1 AND "BusinessId" = $2 RETURNING "Id"',
        [holidayId.data, businessId]);
      if (!removed.rows.length) throw AppError.notFound('holiday_not_found', 'Closed date not found.');
      await client.query(
        `INSERT INTO "AuditLogs" ("Id","Action","ActorUserId","BusinessId","CreatedAtUtc","EntityId","EntityType")
         VALUES ($1,'business.holiday_removed',$2,$3,now(),$4,'BusinessHoliday')`,
        [randomUUID(), actorId, businessId, holidayId.data]);
    });
    return res.status(204).end();
  });

  return router;
}
