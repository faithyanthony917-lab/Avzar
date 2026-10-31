import { AppError } from '../http/errors.js';

const escapeLike = (value) => value.replace(/[\\%_]/g, '\\$&');

async function allowedLocations(pool, user) {
  if (user.isOwner || user.permissions.includes('locations.all')) return null;
  const { rows } = await pool.query(`SELECT DISTINCT ml."LocationId" FROM "Memberships" m
    JOIN "MembershipLocations" ml ON ml."MembershipId" = m."Id" AND ml."BusinessId" = m."BusinessId"
    WHERE m."UserId" = $1 AND m."BusinessId" = $2 AND m."Status" = 0`, [user.userId, user.businessId]);
  return rows.map((row) => row.LocationId);
}

function canView(user, permission) {
  return user.isOwner || user.permissions.includes(permission);
}

export async function searchBusiness(pool, user, query, rawLimit = '5') {
  const search = String(query ?? '').trim();
  if (search.length < 2) throw AppError.badRequest('query_too_short', 'Type at least 2 characters.');
  const needle = search.slice(0, 80);
  const parsedLimit = Number(rawLimit);
  if (!Number.isSafeInteger(parsedLimit)) throw AppError.badRequest('invalid_limit', 'The result limit must be an integer.');
  const limit = Math.max(1, Math.min(10, parsedLimit));
  const pattern = `%${escapeLike(needle)}%`;
  const digits = needle.replace(/\D/g, '');
  const phoneNeedle = digits.length >= 3 ? digits : null;
  const businessId = user.businessId;
  const none = [];

  const customers = canView(user, 'customers.view') ? (await pool.query(`SELECT "Id", "FullName", "Email", "Phone" FROM "Customers"
    WHERE "BusinessId" = $1 AND "Status" <> 'Merged' AND (
      "FullName" ILIKE $2 ESCAPE E'\\\\' OR ("Email" IS NOT NULL AND "Email" ILIKE $2 ESCAPE E'\\\\')
      OR ($3::text IS NOT NULL AND "NormalizedPhone" IS NOT NULL AND "NormalizedPhone" LIKE $3))
    ORDER BY "FullName" LIMIT $4`, [businessId, pattern, phoneNeedle ? `%${phoneNeedle}%` : null, limit])).rows
    .map((row) => ({ kind: 'customer', id: row.Id, title: row.FullName, subtitle: row.Email ?? row.Phone })) : none;

  const locations = await allowedLocations(pool, user);
  const orders = canView(user, 'orders.view') ? (await pool.query(`SELECT o."Id", o."OrderNumber", o."Status", c."FullName" AS "Customer"
    FROM "Orders" o JOIN "Customers" c ON c."BusinessId" = o."BusinessId" AND c."Id" = o."CustomerId"
    WHERE o."BusinessId" = $1 AND ($2::uuid[] IS NULL OR o."LocationId" = ANY($2::uuid[]))
      AND (o."OrderNumber" ILIKE $3 ESCAPE E'\\\\' OR c."FullName" ILIKE $3 ESCAPE E'\\\\')
    ORDER BY o."CreatedAtUtc" DESC LIMIT $4`, [businessId, locations, pattern, limit])).rows
    .map((row) => ({ kind: 'order', id: row.Id, title: row.OrderNumber, subtitle: `${row.Customer} | ${row.Status}` })) : none;

  const invoiceScope = locations === null ? '' : 'AND i."OrderId" IS NOT NULL AND EXISTS (SELECT 1 FROM "Orders" o WHERE o."BusinessId" = i."BusinessId" AND o."Id" = i."OrderId" AND o."LocationId" = ANY($2::uuid[]))';
  const invoiceParams = locations === null ? [businessId, pattern, limit] : [businessId, locations, pattern, limit];
  const patternIndex = locations === null ? 2 : 3;
  const limitIndex = locations === null ? 3 : 4;
  const invoices = canView(user, 'invoices.view') ? (await pool.query(`SELECT i."Id", i."Number", i."Status", c."FullName" AS "Customer"
    FROM "Invoices" i JOIN "Customers" c ON c."BusinessId" = i."BusinessId" AND c."Id" = i."CustomerId"
    WHERE i."BusinessId" = $1 ${invoiceScope}
      AND ((i."Number" IS NOT NULL AND i."Number" ILIKE $${patternIndex} ESCAPE E'\\\\') OR c."FullName" ILIKE $${patternIndex} ESCAPE E'\\\\')
    ORDER BY i."CreatedAtUtc" DESC LIMIT $${limitIndex}`, invoiceParams)).rows
    .map((row) => ({ kind: 'invoice', id: row.Id, title: row.Number ?? 'Draft invoice', subtitle: `${row.Customer} | ${row.Status}` })) : none;

  const designs = canView(user, 'designs.view') ? (await pool.query(`SELECT "Id", "Name", "GarmentType" FROM "Designs"
    WHERE "BusinessId" = $1 AND ("Name" ILIKE $2 ESCAPE E'\\\\' OR ("GarmentType" IS NOT NULL AND "GarmentType" ILIKE $2 ESCAPE E'\\\\'))
    ORDER BY "Name" LIMIT $3`, [businessId, pattern, limit])).rows
    .map((row) => ({ kind: 'design', id: row.Id, title: row.Name, subtitle: row.GarmentType })) : none;

  const inquiries = canView(user, 'inquiries.view') ? (await pool.query(`SELECT "Id", "Name", "Status", "DesignNameSnapshot" FROM "Inquiries"
    WHERE "BusinessId" = $1 AND ("Name" ILIKE $2 ESCAPE E'\\\\' OR ("Email" IS NOT NULL AND "Email" ILIKE $2 ESCAPE E'\\\\')
      OR ("DesignNameSnapshot" IS NOT NULL AND "DesignNameSnapshot" ILIKE $2 ESCAPE E'\\\\'))
    ORDER BY "CreatedAtUtc" DESC LIMIT $3`, [businessId, pattern, limit])).rows
    .map((row) => ({ kind: 'inquiry', id: row.Id, title: row.Name, subtitle: `${row.DesignNameSnapshot ?? 'General'} | ${row.Status}` })) : none;

  return { customers, orders, invoices, designs, inquiries };
}