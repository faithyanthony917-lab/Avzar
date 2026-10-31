import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { AppError } from '../http/errors.js';
import { bindTenantByLookup } from '../db/tenantLookup.js';
import { isBlank, matchEnum } from '../http/enums.js';
import { entitlementValue } from './entitlementService.js';

const variants = new Set(['orig', 'md', 'sm']);
const PURPOSES = ['DesignImage', 'SiteImage', 'TaskProgressPhoto'];
const gbBytes = 1_073_741_824n;
const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

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

export async function checkStorageQuota(client, env, businessId, incomingBytes) {
  const entitlementKey = 'storage.gb.max';
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`${businessId}:${entitlementKey}`]);
  const rawLimit = await entitlementValue(client, businessId, entitlementKey, '0');
  if (rawLimit === 'unlimited') return;
  if (!/^\d+$/.test(rawLimit)) throw new AppError(503, 'plans_not_seeded', 'The storage limit is not configured correctly.');
  const limitBytes = BigInt(rawLimit) * BigInt(env.STORAGE_QUOTA_BYTES_PER_GB ?? Number(gbBytes));
  const { rows } = await client.query(`
    SELECT (COALESCE((SELECT sum("SizeBytes") FROM "MediaAssets" WHERE "BusinessId" = $1), 0)
          + COALESCE((SELECT sum("SizeBytes") FROM "Documents" WHERE "BusinessId" = $1), 0))::text AS "UsedBytes"`, [businessId]);
  const usedBytes = BigInt(rows[0]?.UsedBytes ?? '0');
  if (usedBytes + BigInt(incomingBytes) > limitBytes) {
    throw new AppError(403, 'plan_limit_reached', 'Your plan storage limit would be exceeded.', {
      entitlement: entitlementKey, limit: Number(rawLimit), used: Number(usedBytes),
    });
  }
}

async function processImage(bytes, env) {
  let image;
  try {
    image = sharp(bytes, { limitInputPixels: env.MEDIA_MAX_PIXELS ?? 50_000_000, animated: false, failOn: 'error' });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw new Error('unsupported');
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > (env.MEDIA_MAX_PIXELS ?? 50_000_000)) {
      throw AppError.badRequest('image_too_large', 'This image has too many pixels. Please resize it and try again.');
    }
    const variantsByName = {};
    let width = 0;
    let height = 0;
    for (const [name, maxSide] of [['orig', 2560], ['md', 960], ['sm', 320]]) {
      const output = await sharp(bytes, { limitInputPixels: env.MEDIA_MAX_PIXELS ?? 50_000_000, animated: false, failOn: 'error' })
        .rotate().resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
      variantsByName[name] = output.data;
      if (name === 'orig') ({ width, height } = output.info);
    }
    return { width, height, variants: variantsByName };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.badRequest('unsupported_image', 'Upload a JPEG, PNG or WebP image. Other file types (including SVG and GIF) are not accepted.');
  }
}

function safeFileName(value) {
  const base = String(value ?? '').replaceAll('\\', '/').split('/').at(-1) ?? '';
  return [...base].filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('').trim().slice(0, 200) || 'image';
}

function mediaDto(row, inUse = false) {
  return { id: row.Id, purpose: row.Purpose, fileName: row.OriginalFileName, width: row.Width, height: row.Height,
    sizeBytes: Number(row.SizeBytes), createdAtUtc: row.CreatedAtUtc, inUse };
}

export async function uploadMedia(pool, env, storage, user, bytes, fileName, rawPurpose = 'DesignImage', taskPhoto = null) {
  if (!bytes?.length) throw AppError.badRequest('empty_file', 'The uploaded file is empty.');
  if (bytes.length > env.MEDIA_MAX_UPLOAD_BYTES) throw new AppError(413, 'file_too_large', `Images can be at most ${Math.floor(env.MEDIA_MAX_UPLOAD_BYTES / 1_048_576)} MB.`);
  const purpose = matchEnum(rawPurpose, PURPOSES);
  if (purpose === undefined) throw AppError.badRequest('invalid_purpose', `'${rawPurpose}' is not a valid purpose.`);
  const processed = await processImage(bytes, env);
  const id = randomUUID();
  const businessId = user.businessId;
  const objects = Object.entries(processed.variants).map(([variant, content]) => ({ key: `${businessId.replaceAll('-', '')}/${id.replaceAll('-', '')}/${variant}.webp`, content }));
  const sizeBytes = objects.reduce((sum, object) => sum + object.content.length, 0);
  const written = [];

  try {
    const created = await inTransaction(pool, async (client) => {
      await checkStorageQuota(client, env, businessId, sizeBytes);
      for (const object of objects) {
        await storage.put(object.key, object.content, 'image/webp');
        written.push(object.key);
      }
      const { rows } = await client.query(`
        INSERT INTO "MediaAssets" ("Id", "BusinessId", "ContentType", "CreatedAtUtc", "Height", "OriginalFileName", "Purpose", "Sha256", "SizeBytes", "UploadedByUserId", "Width")
        VALUES ($1, $2, 'image/webp', now(), $3, $4, $5, $6, $7, $8, $9)
        RETURNING "Id", "Purpose", "OriginalFileName", "Width", "Height", "SizeBytes", "CreatedAtUtc"`,
      [id, businessId, processed.height, safeFileName(fileName), purpose, createHash('sha256').update(bytes).digest('hex'), sizeBytes, user.userId, processed.width]);
      await client.query(`
        INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityId", "EntityType")
        VALUES ($1, 'media.uploaded', $2, $3, now(), $4::jsonb, $5, 'MediaAsset')`,
      [randomUUID(), user.userId, businessId, JSON.stringify({ sizeBytes, purpose }), id]);
      let photo = null;
      if (taskPhoto) {
        const { rows: tasks } = await client.query(`
          SELECT 1 FROM "ProductionTasks"
          WHERE "BusinessId" = $1 AND "Id" = $2 AND "AssignedMembershipId" = $3
          FOR UPDATE`, [businessId, taskPhoto.taskId, taskPhoto.membershipId]);
        if (!tasks.length) throw AppError.notFound('task_not_found', 'Task not found.');
        const { rows: photos } = await client.query(`
          INSERT INTO "TaskProgressPhotos" ("Id", "BusinessId", "TaskId", "MediaAssetId", "UploadedByMembershipId", "Caption", "UploadedAtUtc")
          VALUES ($1, $2, $3, $4, $5, $6, now())
          RETURNING "Id", "TaskId", "MediaAssetId", "Caption", "UploadedAtUtc"`,
        [randomUUID(), businessId, taskPhoto.taskId, id, taskPhoto.membershipId, taskPhoto.caption ?? null]);
        photo = photos[0];
      }
      return { ...rows[0], photo };
    });
    const asset = mediaDto(created);
    return created.photo ? { ...asset, photo: created.photo } : asset;
  } catch (error) {
    await Promise.all(written.map((key) => storage.delete(key).catch(() => {})));
    throw error;
  }
}

function parseMediaQuery(query) {
  const page = Number.parseInt(query.page ?? '1', 10);
  const pageSize = Number.parseInt(query.pageSize ?? '25', 10);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw AppError.badRequest('invalid_paging', 'Page must be positive and pageSize must be between 1 and 100.');
  }
  const purpose = isBlank(query.purpose) ? null : matchEnum(String(query.purpose), PURPOSES);
  if (!isBlank(query.purpose) && purpose === undefined) throw AppError.badRequest('invalid_purpose', `'${query.purpose}' is not a valid purpose.`);
  return { page, pageSize, purpose };
}

export async function listMedia(pool, user, query) {
  const filter = parseMediaQuery(query);
  const params = [user.businessId];
  const clauses = ['a."BusinessId" = $1', `a."Purpose" <> 'TaskProgressPhoto'`, `NOT EXISTS (SELECT 1 FROM "TaskProgressPhotos" tp WHERE tp."BusinessId" = a."BusinessId" AND tp."MediaAssetId" = a."Id")`];
  if (filter.purpose) { params.push(filter.purpose); clauses.push(`a."Purpose" = $${params.length}`); }
  const where = clauses.join(' AND ');
  const { rows: counts } = await pool.query(`SELECT count(*)::int AS "TotalCount" FROM "MediaAssets" a WHERE ${where}`, params);
  const { rows } = await pool.query(`
    SELECT a."Id", a."Purpose", a."OriginalFileName", a."Width", a."Height", a."SizeBytes", a."CreatedAtUtc",
      (EXISTS (SELECT 1 FROM "DesignImages" i WHERE i."BusinessId" = a."BusinessId" AND i."MediaAssetId" = a."Id")
       OR EXISTS (SELECT 1 FROM "StorefrontVersionMedia" m WHERE m."BusinessId" = a."BusinessId" AND m."MediaAssetId" = a."Id")
       OR EXISTS (SELECT 1 FROM "TaskProgressPhotos" p WHERE p."BusinessId" = a."BusinessId" AND p."MediaAssetId" = a."Id")) AS "InUse"
    FROM "MediaAssets" a WHERE ${where} ORDER BY a."CreatedAtUtc" DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
  [...params, filter.pageSize, (filter.page - 1) * filter.pageSize]);
  return { items: rows.map((row) => mediaDto(row, row.InUse)), page: filter.page, pageSize: filter.pageSize, totalCount: counts[0]?.TotalCount ?? 0 };
}

export async function getMedia(pool, user, id) {
  const { rows } = await pool.query(`
    SELECT a."Id", a."Purpose", a."OriginalFileName", a."Width", a."Height", a."SizeBytes", a."CreatedAtUtc",
      (EXISTS (SELECT 1 FROM "DesignImages" i WHERE i."BusinessId" = a."BusinessId" AND i."MediaAssetId" = a."Id")
       OR EXISTS (SELECT 1 FROM "TaskProgressPhotos" p WHERE p."BusinessId" = a."BusinessId" AND p."MediaAssetId" = a."Id")) AS "InUse"
    FROM "MediaAssets" a WHERE a."BusinessId" = $1 AND a."Id" = $2 AND a."Purpose" <> 'TaskProgressPhoto' AND NOT EXISTS (SELECT 1 FROM "TaskProgressPhotos" tp WHERE tp."BusinessId" = a."BusinessId" AND tp."MediaAssetId" = a."Id")`, [user.businessId, id]);
  if (!rows[0]) throw AppError.notFound('media_not_found', 'Image not found.');
  return mediaDto(rows[0], rows[0].InUse);
}

export async function mediaUsage(pool, env, user) {
  const { rows } = await pool.query(`
    SELECT (COALESCE((SELECT sum("SizeBytes") FROM "MediaAssets" WHERE "BusinessId" = $1), 0)
          + COALESCE((SELECT sum("SizeBytes") FROM "Documents" WHERE "BusinessId" = $1), 0))::text AS "UsedBytes"`, [user.businessId]);
  const rawLimit = await entitlementValue(pool, user.businessId, 'storage.gb.max', '0');
  if (rawLimit !== 'unlimited' && !/^\d+$/.test(rawLimit)) throw new AppError(503, 'plans_not_seeded', 'The storage limit is not configured correctly.');
  return { usedBytes: Number(rows[0]?.UsedBytes ?? '0'), limitBytes: rawLimit === 'unlimited' ? null : Number(BigInt(rawLimit) * BigInt(env.STORAGE_QUOTA_BYTES_PER_GB)) };
}

export async function openMedia(pool, storage, user, id, variant, isPublic = false) {
  if (!variants.has(variant)) throw AppError.notFound('media_not_found', 'Image not found.');
  // A public image URL carries only the asset ID. Bind the asset's business first; the query below still decides whether it is public.
  if (isPublic) await bindTenantByLookup(pool, 'media_asset_id', id);
  const { rows } = isPublic ? await pool.query(`
    SELECT a."Id", a."BusinessId", a."ContentType" FROM "MediaAssets" a
    WHERE a."Id" = $1 AND a."Purpose" <> 'TaskProgressPhoto'
      AND NOT EXISTS (SELECT 1 FROM "TaskProgressPhotos" tp WHERE tp."BusinessId" = a."BusinessId" AND tp."MediaAssetId" = a."Id")
      AND (
      EXISTS (SELECT 1 FROM "DesignImages" i JOIN "Designs" d ON d."Id" = i."DesignId" AND d."BusinessId" = i."BusinessId"
        WHERE i."BusinessId" = a."BusinessId" AND i."MediaAssetId" = a."Id" AND d."Status" = 'Active' AND d."Visibility" = 'Public')
      OR EXISTS (SELECT 1 FROM "StorefrontVersionMedia" m JOIN "Storefronts" s ON s."PublishedVersionId" = m."VersionId" AND s."BusinessId" = m."BusinessId"
        WHERE m."BusinessId" = a."BusinessId" AND m."MediaAssetId" = a."Id" AND s."Status" = 'Published'))`, [id]) : await pool.query(
    `SELECT a."Id", a."BusinessId", a."ContentType" FROM "MediaAssets" a WHERE a."BusinessId" = $1 AND a."Id" = $2 AND a."Purpose" <> 'TaskProgressPhoto' AND NOT EXISTS (SELECT 1 FROM "TaskProgressPhotos" tp WHERE tp."BusinessId" = a."BusinessId" AND tp."MediaAssetId" = a."Id")`, [user.businessId, id]);
  const asset = rows[0];
  if (!asset) throw AppError.notFound('media_not_found', 'Image not found.');
  const key = `${asset.BusinessId.replaceAll('-', '')}/${asset.Id.replaceAll('-', '')}/${variant}.webp`;
  const content = await storage.openRead(key);
  if (!content) throw AppError.notFound('media_missing', 'The file for this image is missing.');
  return { content, contentType: asset.ContentType };
}

export async function openTaskPhoto(pool, storage, user, taskId, photoId, variant, allowedLocations, membershipId) {
  if (!variants.has(variant)) throw AppError.notFound('task_photo_not_found', 'Photo not found.');
  const { rows } = await pool.query(`
    SELECT m."Id", m."BusinessId", m."ContentType"
    FROM "TaskProgressPhotos" tp
    JOIN "MediaAssets" m ON m."BusinessId" = tp."BusinessId" AND m."Id" = tp."MediaAssetId"
    JOIN "ProductionTasks" t ON t."BusinessId" = tp."BusinessId" AND t."Id" = tp."TaskId"
    JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
    WHERE tp."BusinessId" = $1 AND tp."TaskId" = $2 AND tp."Id" = $3
      AND ($4::uuid[] IS NULL OR o."LocationId" = ANY($4::uuid[]))
      AND ($5::uuid IS NULL OR t."AssignedMembershipId" = $5)
  `, [user.businessId, taskId, photoId, allowedLocations, membershipId]);
  const asset = rows[0];
  if (!asset) throw AppError.notFound('task_photo_not_found', 'Photo not found.');
  const key = `${asset.BusinessId.replaceAll('-', '')}/${asset.Id.replaceAll('-', '')}/${variant}.webp`;
  const content = await storage.openRead(key);
  if (!content) throw AppError.notFound('task_photo_not_found', 'Photo not found.');
  return { content, contentType: asset.ContentType };
}

export async function deleteMedia(pool, storage, user, id) {
  const asset = await inTransaction(pool, async (client) => {
    const { rows } = await client.query(`SELECT "Id", "BusinessId", "SizeBytes" FROM "MediaAssets" WHERE "BusinessId" = $1 AND "Id" = $2 FOR UPDATE`, [user.businessId, id]);
    const current = rows[0];
    if (!current) throw AppError.notFound('media_not_found', 'Image not found.');
    const { rows: references } = await client.query(`
      SELECT EXISTS (SELECT 1 FROM "DesignImages" WHERE "BusinessId" = $1 AND "MediaAssetId" = $2)
          OR EXISTS (SELECT 1 FROM "StorefrontVersionMedia" WHERE "BusinessId" = $1 AND "MediaAssetId" = $2)
          OR EXISTS (SELECT 1 FROM "TaskProgressPhotos" WHERE "BusinessId" = $1 AND "MediaAssetId" = $2)
          OR EXISTS (SELECT 1 FROM "Storefronts" WHERE "BusinessId" = $1 AND "DraftJson"::text ILIKE $3) AS "InUse"`,
    [user.businessId, id, `%${id}%`]);
    if (references[0]?.InUse) throw AppError.conflict('media_in_use', 'This image is still in use (design, website draft or version, or task photo). Remove the reference first.');
    await client.query('DELETE FROM "MediaAssets" WHERE "BusinessId" = $1 AND "Id" = $2', [user.businessId, id]);
    await client.query(`
      INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityId", "EntityType")
      VALUES ($1, 'media.deleted', $2, $3, now(), $4::jsonb, $5, 'MediaAsset')`,
    [randomUUID(), user.userId, user.businessId, JSON.stringify({ sizeBytes: Number(current.SizeBytes) }), id]);
    return current;
  });
  await Promise.all([...variants].map((variant) => storage.delete(`${asset.BusinessId.replaceAll('-', '')}/${asset.Id.replaceAll('-', '')}/${variant}.webp`).catch(() => {})));
}