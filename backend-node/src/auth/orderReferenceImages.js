// Step 18a: reference images on an order. The upload itself goes through uploadMedia (mediaService.js) so that the image, its quota check,
// its storage objects and its link row are written in one transaction. This file reads, streams and removes them.
// Every query is scoped by business, and by the order's location for a location-limited user. A worker (tasks.work only) reaches the
// images of an order only through a task assigned to them.
import { randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';

const variants = new Set(['orig', 'md', 'sm']);
const keyOf = (businessId, mediaId, variant) => `${String(businessId).replaceAll('-', '')}/${String(mediaId).replaceAll('-', '')}/${variant}.webp`;

const toDto = (row) => ({
  id: row.Id, orderId: row.OrderId, mediaId: row.MediaAssetId, caption: row.Caption, fileName: row.OriginalFileName,
  width: row.Width, height: row.Height, sizeBytes: Number(row.SizeBytes), createdAtUtc: row.CreatedAtUtc,
});

const columns = `r."Id", r."OrderId", r."MediaAssetId", r."Caption", r."CreatedAtUtc", m."OriginalFileName", m."Width", m."Height", m."SizeBytes", m."BusinessId", m."ContentType"`;

export async function listOrderReferenceImages(pool, user, orderId, allowedLocations) {
  const { rows } = await pool.query(`
    SELECT ${columns}
    FROM "OrderReferenceImages" r
    JOIN "MediaAssets" m ON m."BusinessId" = r."BusinessId" AND m."Id" = r."MediaAssetId"
    JOIN "Orders" o ON o."BusinessId" = r."BusinessId" AND o."Id" = r."OrderId"
    WHERE r."BusinessId" = $1 AND r."OrderId" = $2 AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[]))
    ORDER BY r."CreatedAtUtc", r."Id"`, [user.businessId, orderId, allowedLocations ?? null]);
  return rows.map(toDto);
}

// The images of the order a task belongs to, for the worker the task is assigned to.
export async function listTaskReferenceImages(pool, user, taskId, membershipId) {
  const { rows } = await pool.query(`
    SELECT ${columns}
    FROM "ProductionTasks" t
    JOIN "OrderReferenceImages" r ON r."BusinessId" = t."BusinessId" AND r."OrderId" = t."OrderId"
    JOIN "MediaAssets" m ON m."BusinessId" = r."BusinessId" AND m."Id" = r."MediaAssetId"
    WHERE t."BusinessId" = $1 AND t."Id" = $2 AND t."AssignedMembershipId" = $3
    ORDER BY r."CreatedAtUtc", r."Id"`, [user.businessId, taskId, membershipId]);
  return rows.map(toDto);
}

async function openStored(storage, row, variant) {
  const content = await storage.openRead(keyOf(row.BusinessId, row.MediaAssetId, variant));
  if (!content) throw AppError.notFound('reference_image_not_found', 'Image not found.');
  return { content, contentType: row.ContentType };
}

export async function openOrderReferenceImage(pool, storage, user, orderId, imageId, variant, allowedLocations) {
  if (!variants.has(variant)) throw AppError.notFound('reference_image_not_found', 'Image not found.');
  const { rows } = await pool.query(`
    SELECT r."MediaAssetId", m."BusinessId", m."ContentType"
    FROM "OrderReferenceImages" r
    JOIN "MediaAssets" m ON m."BusinessId" = r."BusinessId" AND m."Id" = r."MediaAssetId"
    JOIN "Orders" o ON o."BusinessId" = r."BusinessId" AND o."Id" = r."OrderId"
    WHERE r."BusinessId" = $1 AND r."OrderId" = $2 AND r."Id" = $3 AND ($4::uuid[] IS NULL OR o."LocationId" = ANY($4::uuid[]))`,
  [user.businessId, orderId, imageId, allowedLocations ?? null]);
  if (!rows[0]) throw AppError.notFound('reference_image_not_found', 'Image not found.');
  return openStored(storage, rows[0], variant);
}

export async function openTaskReferenceImage(pool, storage, user, taskId, imageId, variant, membershipId) {
  if (!variants.has(variant)) throw AppError.notFound('reference_image_not_found', 'Image not found.');
  const { rows } = await pool.query(`
    SELECT r."MediaAssetId", m."BusinessId", m."ContentType"
    FROM "ProductionTasks" t
    JOIN "OrderReferenceImages" r ON r."BusinessId" = t."BusinessId" AND r."OrderId" = t."OrderId"
    JOIN "MediaAssets" m ON m."BusinessId" = r."BusinessId" AND m."Id" = r."MediaAssetId"
    WHERE t."BusinessId" = $1 AND t."Id" = $2 AND r."Id" = $3 AND t."AssignedMembershipId" = $4`,
  [user.businessId, taskId, imageId, membershipId]);
  if (!rows[0]) throw AppError.notFound('reference_image_not_found', 'Image not found.');
  return openStored(storage, rows[0], variant);
}

export async function deleteOrderReferenceImage(pool, storage, user, orderId, imageId, allowedLocations) {
  const client = await pool.connect();
  let removed;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT r."MediaAssetId", m."BusinessId", m."SizeBytes"
      FROM "OrderReferenceImages" r
      JOIN "MediaAssets" m ON m."BusinessId" = r."BusinessId" AND m."Id" = r."MediaAssetId"
      JOIN "Orders" o ON o."BusinessId" = r."BusinessId" AND o."Id" = r."OrderId"
      WHERE r."BusinessId" = $1 AND r."OrderId" = $2 AND r."Id" = $3 AND ($4::uuid[] IS NULL OR o."LocationId" = ANY($4::uuid[]))
      FOR UPDATE OF r`, [user.businessId, orderId, imageId, allowedLocations ?? null]);
    removed = rows[0];
    if (!removed) throw AppError.notFound('reference_image_not_found', 'Image not found.');
    await client.query('DELETE FROM "OrderReferenceImages" WHERE "BusinessId" = $1 AND "Id" = $2', [user.businessId, imageId]);
    await client.query('DELETE FROM "MediaAssets" WHERE "BusinessId" = $1 AND "Id" = $2', [user.businessId, removed.MediaAssetId]);
    await client.query(`
      INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityId", "EntityType")
      VALUES ($1, 'order.reference_image.removed', $2, $3, now(), $4::jsonb, $5, 'Order')`,
    [randomUUID(), user.userId, user.businessId, JSON.stringify({ mediaId: removed.MediaAssetId }), orderId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await Promise.all([...variants].map((variant) => storage.delete(keyOf(removed.BusinessId, removed.MediaAssetId, variant)).catch(() => {})));
}
