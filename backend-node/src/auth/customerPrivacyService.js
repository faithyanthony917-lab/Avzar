import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { bindTenantByLookup } from '../db/tenantLookup.js';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex').toUpperCase();
const portalUnavailable = () => AppError.unauthorized('portal_link_invalid', 'This customer portal link is invalid or expired.');
const iso = (value) => (value ? new Date(value).toISOString() : null);

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

async function findPortalGrant(db, token, lock = false) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) throw portalUnavailable();
  // The token hash is the key; the grant it matches names the business, which is bound for this transaction before customers are joined.
  await bindTenantByLookup(db, 'portal_token_hash', sha256(token));
  const { rows } = await db.query(`
    SELECT g."Id", g."BusinessId", g."CustomerId"
    FROM "CustomerPortalGrants" g
    JOIN "Customers" c ON c."Id" = g."CustomerId" AND c."BusinessId" = g."BusinessId"
    WHERE g."TokenHash" = $1 AND g."RevokedAtUtc" IS NULL AND g."ExpiresAtUtc" > now()
    ${lock ? 'FOR UPDATE OF g' : ''}`, [sha256(token)]);
  if (!rows[0]) throw portalUnavailable();
  return rows[0];
}

function publicRequest(row) {
  return { id: row.Id, type: row.Type, status: row.Status, createdAtUtc: iso(row.CreatedAtUtc), updatedAtUtc: iso(row.UpdatedAtUtc) };
}

export async function listCustomerPrivacyRequests(pool, token) {
  return inTransaction(pool, async (db) => {
    const grant = await findPortalGrant(db, token, true);
    const { rows } = await db.query(`
      SELECT "Id", "Type", "Status", "CreatedAtUtc", "UpdatedAtUtc"
      FROM "CustomerPrivacyRequests"
      WHERE "BusinessId" = $1 AND "CustomerId" = $2
      ORDER BY "CreatedAtUtc" DESC LIMIT 50`, [grant.BusinessId, grant.CustomerId]);
    return { requests: rows.map(publicRequest) };
  });
}

export async function createCustomerPrivacyRequest(pool, { token, type, note }) {
  return inTransaction(pool, async (db) => {
    const grant = await findPortalGrant(db, token, true);
    const id = randomUUID();
    const inserted = await db.query(`
      INSERT INTO "CustomerPrivacyRequests" ("Id", "BusinessId", "CustomerId", "Type", "Status", "CustomerNote", "CreatedAtUtc")
      VALUES ($1, $2, $3, $4, 'Pending', $5, now())
      ON CONFLICT ("BusinessId", "CustomerId", "Type") WHERE "Status" = 'Pending' DO NOTHING
      RETURNING "Id", "Type", "Status", "CreatedAtUtc", "UpdatedAtUtc"`,
    [id, grant.BusinessId, grant.CustomerId, type, note?.trim() || null]);
    if (inserted.rows[0]) return { request: publicRequest(inserted.rows[0]), alreadyPending: false };
    const { rows } = await db.query(`
      SELECT "Id", "Type", "Status", "CreatedAtUtc", "UpdatedAtUtc"
      FROM "CustomerPrivacyRequests"
      WHERE "BusinessId" = $1 AND "CustomerId" = $2 AND "Type" = $3 AND "Status" = 'Pending'
      LIMIT 1`, [grant.BusinessId, grant.CustomerId, type]);
    if (!rows[0]) throw AppError.conflict('privacy_request_conflict', 'The request could not be saved. Please try again.');
    return { request: publicRequest(rows[0]), alreadyPending: true };
  });
}

export async function listBusinessCustomerPrivacyRequests(pool, user, customerId) {
  const { rows: customers } = await pool.query(
    'SELECT 1 FROM "Customers" WHERE "BusinessId" = $1 AND "Id" = $2', [user.businessId, customerId]);
  if (!customers.length) throw AppError.notFound('customer_not_found', 'Customer not found.');
  const { rows } = await pool.query(`
    SELECT "Id", "Type", "Status", "CustomerNote", "StaffNote", "CreatedAtUtc", "UpdatedAtUtc", "ReviewedAtUtc", "ReviewedByUserId"
    FROM "CustomerPrivacyRequests"
    WHERE "BusinessId" = $1 AND "CustomerId" = $2
    ORDER BY "CreatedAtUtc" DESC LIMIT 50`, [user.businessId, customerId]);
  return rows.map((row) => ({
    id: row.Id, type: row.Type, status: row.Status, customerNote: row.CustomerNote, staffNote: row.StaffNote,
    createdAtUtc: iso(row.CreatedAtUtc), updatedAtUtc: iso(row.UpdatedAtUtc), reviewedAtUtc: iso(row.ReviewedAtUtc),
    reviewedByUserId: row.ReviewedByUserId,
  }));
}

export async function reviewCustomerPrivacyRequest(pool, user, customerId, requestId, { status, staffNote }) {
  return inTransaction(pool, async (db) => {
    const { rows } = await db.query(`
      SELECT "Id", "BusinessId", "CustomerId", "Type", "Status", "CustomerNote", "StaffNote", "CreatedAtUtc", "UpdatedAtUtc", "ReviewedAtUtc", "ReviewedByUserId"
      FROM "CustomerPrivacyRequests"
      WHERE "BusinessId" = $1 AND "CustomerId" = $2 AND "Id" = $3 FOR UPDATE`, [user.businessId, customerId, requestId]);
    const request = rows[0];
    if (!request) throw AppError.notFound('privacy_request_not_found', 'Privacy request not found.');
    if (request.Status === status) return { id: request.Id, type: request.Type, status: request.Status, staffNote: request.StaffNote, reviewedAtUtc: iso(request.ReviewedAtUtc) };
    const allowed = (request.Status === 'Pending' && ['Approved', 'Denied'].includes(status))
      || (request.Status === 'Approved' && status === 'Completed');
    if (!allowed) throw AppError.conflict('invalid_privacy_request_transition', 'That privacy request has already been resolved or must be approved before completion.');
    const { rows: updatedRows } = await db.query(`
      UPDATE "CustomerPrivacyRequests"
      SET "Status" = $1, "StaffNote" = COALESCE($2, "StaffNote"), "UpdatedAtUtc" = now(), "ReviewedAtUtc" = now(), "ReviewedByUserId" = $3
      WHERE "BusinessId" = $4 AND "CustomerId" = $5 AND "Id" = $6
      RETURNING "Id", "Type", "Status", "StaffNote", "ReviewedAtUtc"`,
    [status, staffNote?.trim() || null, user.userId, user.businessId, customerId, requestId]);
    await db.query(`
      INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityId", "EntityType")
      VALUES ($1, 'customer.privacy_request.reviewed', $2, $3, now(), $4::jsonb, $5, 'CustomerPrivacyRequest')`,
    [randomUUID(), user.userId, user.businessId, JSON.stringify({ customerId, type: request.Type, status }), requestId]);
    const updated = updatedRows[0];
    return { id: updated.Id, type: updated.Type, status: updated.Status, staffNote: updated.StaffNote, reviewedAtUtc: iso(updated.ReviewedAtUtc) };
  });
}
