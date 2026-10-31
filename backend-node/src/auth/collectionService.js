import { randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { isBlank, parseEnum } from '../http/enums.js';
import { withTransaction } from './accountService.js';

function parseVisibility(value) {
  return parseEnum(value, ['Private', 'Public'], 'visibility');
}

function paging(query) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? 25 : Number(query.pageSize);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw AppError.badRequest('invalid_paging', 'Page must be positive and pageSize must be between 1 and 100.');
  }
  return { page, pageSize };
}

function slugFrom(value) {
  const slug = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70).replace(/-+$/g, '');
  return slug || 'collection';
}

async function uniqueSlug(db, businessId, name) {
  const base = slugFrom(name);
  const { rows } = await db.query(`SELECT "Slug" FROM "DesignCollections" WHERE "BusinessId" = $1 AND ("Slug" = $2 OR "Slug" LIKE $3)`,
    [businessId, base, `${base}-%`]);
  const taken = new Set(rows.map((row) => row.Slug));
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) if (!taken.has(`${base}-${index}`)) return `${base}-${index}`;
}

function csvCell(value) {
  if (value === null || value === undefined || value === '') return '';
  let text = String(value).replaceAll('\0', '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function audit(db, user, action, id, details = null) {
  await db.query(`
    INSERT INTO "AuditLogs" ("Id","Action","ActorUserId","BusinessId","CreatedAtUtc","DetailsJson","EntityId","EntityType")
    VALUES ($1,$2,$3,$4,now(),$5::jsonb,$6,'DesignCollection')`,
  [randomUUID(), action, user.userId, user.businessId, details === null ? null : JSON.stringify(details), id]);
}

export async function listCollections(pool, businessId, query = {}) {
  const { page, pageSize } = paging(query);
  const values = [businessId];
  const filters = ['c."BusinessId" = $1'];
  if (!isBlank(query.visibility)) {
    values.push(parseVisibility(String(query.visibility)));
    filters.push(`c."Visibility" = $${values.length}`);
  }
  if (query.search !== undefined && String(query.search).trim()) {
    values.push(`%${String(query.search).trim().replace(/[\\%_]/g, '\\$&')}%`);
    filters.push(`c."Name" ILIKE $${values.length} ESCAPE E'\\\\'`);
  }
  const where = filters.join(' AND ');
  const count = await pool.query(`SELECT count(*)::int AS "TotalCount" FROM "DesignCollections" c WHERE ${where}`, values);
  const { rows } = await pool.query(`
    SELECT c."Id",c."Name",c."Slug",c."Visibility",c."SortOrder",
      count(i."DesignId")::int AS "DesignCount",
      count(i."DesignId") FILTER (WHERE d."Visibility" = 'Public' AND d."Status" = 'Active')::int AS "PublicDesignCount"
    FROM "DesignCollections" c
    LEFT JOIN "DesignCollectionItems" i ON i."BusinessId" = c."BusinessId" AND i."CollectionId" = c."Id"
    LEFT JOIN "Designs" d ON d."BusinessId" = i."BusinessId" AND d."Id" = i."DesignId"
    WHERE ${where} GROUP BY c."Id" ORDER BY c."SortOrder",c."Name"
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
  [...values, pageSize, (page - 1) * pageSize]);
  return {
    items: rows.map((row) => ({ id: row.Id, name: row.Name, slug: row.Slug, visibility: row.Visibility,
      sortOrder: row.SortOrder, designCount: row.DesignCount, publicDesignCount: row.PublicDesignCount })),
    page, pageSize, totalCount: Number(count.rows[0]?.TotalCount ?? 0),
  };
}

export async function getCollection(pool, businessId, id) {
  const { rows } = await pool.query(`
    SELECT "Id","Name","Slug","Description","Visibility","SortOrder",xmin::text::bigint AS "Version"
    FROM "DesignCollections" WHERE "BusinessId" = $1 AND "Id" = $2`, [businessId, id]);
  if (!rows.length) throw AppError.notFound('collection_not_found', 'Collection not found.');
  const collection = rows[0];
  const items = await pool.query(`
    SELECT d."Id" AS "DesignId",d."Name",d."Slug",d."Status",d."Visibility",i."SortOrder",
      (SELECT di."MediaAssetId" FROM "DesignImages" di WHERE di."BusinessId" = d."BusinessId" AND di."DesignId" = d."Id" ORDER BY di."SortOrder" LIMIT 1) AS "CoverMediaId"
    FROM "DesignCollectionItems" i JOIN "Designs" d ON d."BusinessId" = i."BusinessId" AND d."Id" = i."DesignId"
    WHERE i."BusinessId" = $1 AND i."CollectionId" = $2 ORDER BY i."SortOrder"`, [businessId, id]);
  return { id: collection.Id, name: collection.Name, slug: collection.Slug, description: collection.Description,
    visibility: collection.Visibility, sortOrder: collection.SortOrder, version: Number(collection.Version),
    items: items.rows.map((item) => ({ designId: item.DesignId, name: item.Name, slug: item.Slug, status: item.Status,
      visibility: item.Visibility, sortOrder: item.SortOrder, coverMediaId: item.CoverMediaId })) };
}

const clean = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

export async function createCollection(pool, user, request) {
  const visibility = parseVisibility(request.visibility);
  const id = randomUUID();
  const name = request.name.trim();
  await withTransaction(pool, async (client) => {
    const slug = await uniqueSlug(client, user.businessId, name);
    await client.query(`
      INSERT INTO "DesignCollections" ("Id","BusinessId","Name","Slug","Description","Visibility","SortOrder","CreatedAtUtc")
      VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
    [id, user.businessId, name, slug, clean(request.description), visibility, request.sortOrder]);
    await audit(client, user, 'collection.created', id, { name });
  });
  return getCollection(pool, user.businessId, id);
}

export async function updateCollection(pool, user, id, request) {
  if (request.version == null) throw AppError.badRequest('version_required', "Include the collection's current version when updating.");
  const visibility = parseVisibility(request.visibility);
  const name = request.name.trim();
  await withTransaction(pool, async (client) => {
    const { rows } = await client.query(`SELECT xmin::text::bigint AS "Version" FROM "DesignCollections" WHERE "BusinessId" = $1 AND "Id" = $2 FOR UPDATE`,
      [user.businessId, id]);
    if (!rows.length) throw AppError.notFound('collection_not_found', 'Collection not found.');
    const updated = await client.query(`
      UPDATE "DesignCollections" SET "Name" = $1,"Description" = $2,"Visibility" = $3,"SortOrder" = $4,"UpdatedAtUtc" = now()
      WHERE "BusinessId" = $5 AND "Id" = $6 AND xmin::text::bigint = $7`,
    [name, clean(request.description), visibility, request.sortOrder, user.businessId, id, request.version]);
    if (updated.rowCount !== 1) throw AppError.conflict('stale_version', 'This collection was changed by someone else. Reload and try again.');
    await audit(client, user, 'collection.updated', id, { visibility });
  });
  return getCollection(pool, user.businessId, id);
}

export async function setCollectionItems(pool, user, id, designIds) {
  if (new Set(designIds).size !== designIds.length) throw AppError.badRequest('duplicate_design', 'The same design was listed twice.');
  return withTransaction(pool, async (client) => {
    const collection = await client.query('SELECT 1 FROM "DesignCollections" WHERE "BusinessId" = $1 AND "Id" = $2 FOR UPDATE', [user.businessId, id]);
    if (!collection.rows.length) throw AppError.notFound('collection_not_found', 'Collection not found.');
    const designs = designIds.length ? await client.query(`
      SELECT "Id","Status" FROM "Designs" WHERE "BusinessId" = $1 AND "Id" = ANY($2::uuid[])`, [user.businessId, designIds]) : { rows: [] };
    if (designs.rows.length !== designIds.length) throw AppError.badRequest('unknown_design', 'One or more designs were not found.');
    if (designs.rows.some((design) => design.Status === 'Archived')) throw AppError.conflict('design_archived', 'Archived designs cannot be added to a collection. Restore them first.');
    await client.query('DELETE FROM "DesignCollectionItems" WHERE "BusinessId" = $1 AND "CollectionId" = $2', [user.businessId, id]);
    for (let sortOrder = 0; sortOrder < designIds.length; sortOrder += 1) {
      await client.query('INSERT INTO "DesignCollectionItems" ("BusinessId","CollectionId","DesignId","SortOrder") VALUES ($1,$2,$3,$4)',
        [user.businessId, id, designIds[sortOrder], sortOrder]);
    }
    await audit(client, user, 'collection.items_changed', id, { count: designIds.length });
    return getCollection(client, user.businessId, id);
  });
}

export async function deleteCollection(pool, user, id) {
  await withTransaction(pool, async (client) => {
    const { rows } = await client.query('SELECT "Name" FROM "DesignCollections" WHERE "BusinessId" = $1 AND "Id" = $2 FOR UPDATE', [user.businessId, id]);
    if (!rows.length) throw AppError.notFound('collection_not_found', 'Collection not found.');
    await client.query('DELETE FROM "DesignCollections" WHERE "BusinessId" = $1 AND "Id" = $2', [user.businessId, id]);
    await audit(client, user, 'collection.deleted', id, { name: rows[0].Name });
  });
}

export async function exportCollections(pool, businessId, query) {
  const rows = [];
  let page = 1;
  let totalCount = 0;
  do {
    const result = await listCollections(pool, businessId, { ...query, page, pageSize: 100 });
    rows.push(...result.items);
    totalCount = result.totalCount;
    page += 1;
    if (!result.items.length || rows.length >= totalCount || rows.length >= 100_000) break;
  } while (true);
  const values = [['Collection ID', 'Name', 'Slug', 'Visibility', 'Sort order', 'Design count', 'Public design count'],
    ...rows.map((row) => [row.id, row.name, row.slug, row.visibility, row.sortOrder, row.designCount, row.publicDesignCount])];
  return `\uFEFF${values.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}