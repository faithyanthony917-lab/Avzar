import { randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { isBlank, matchEnum } from '../http/enums.js';
import { withTransaction } from './accountService.js';
import { ensureBelowLimit } from './entitlementService.js';

// Trimmed and case-insensitive, like the other enum fields; the canonical spelling is returned.
const enumValue = (value, allowed, name) => {
  const matched = matchEnum(value, allowed);
  if (matched === undefined) throw AppError.badRequest(`invalid_${name}`, `'${value}' is not a valid ${name}.`);
  return matched;
};

function paging(query) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? 25 : Number(query.pageSize);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw AppError.badRequest('invalid_paging', 'Page must be positive and pageSize must be between 1 and 100.');
  }
  return { page, pageSize };
}

function likePattern(value) {
  return `%${value.trim().replace(/[\\%_]/g, '\\$&')}%`;
}

function designSummary(row) {
  return {
    id: row.Id,
    name: row.Name,
    description: row.Description ?? null,
    garmentType: row.GarmentType ?? null,
    fabrics: row.Fabrics ?? [],
    colours: row.Colours ?? [],
    sizes: row.Sizes ?? [],
    productionDays: row.ProductionDays == null ? null : Number(row.ProductionDays),
    slug: row.Slug,
    kind: row.Kind,
    categoryId: row.CategoryId,
    categoryName: row.CategoryName,
    basePrice: row.BasePrice === null ? null : Number(row.BasePrice),
    currencyCode: row.CurrencyCode,
    isFeatured: row.IsFeatured,
    visibility: row.Visibility,
    status: row.Status,
    tags: row.Tags ?? [],
    createdAtUtc: row.CreatedAtUtc,
    coverMediaId: row.CoverMediaId,
  };
}

export async function listDesigns(pool, businessId, query) {
  const { page, pageSize } = paging(query);
  const values = [businessId];
  const filters = ['d."BusinessId" = $1'];
  const status = isBlank(query.status) ? 'Active' : enumValue(String(query.status), ['Active', 'Archived'], 'status');
  values.push(status);
  filters.push(`d."Status" = $${values.length}`);

  if (query.categoryId !== undefined) {
    if (!isUuid(String(query.categoryId))) throw AppError.badRequest('invalid_category_id', 'The category ID is invalid.');
    values.push(String(query.categoryId));
    filters.push(`d."CategoryId" = $${values.length}`);
  }
  if (query.featured !== undefined) {
    if (!['true', 'false'].includes(String(query.featured))) throw AppError.badRequest('invalid_featured', 'featured must be true or false.');
    values.push(String(query.featured) === 'true');
    filters.push(`d."IsFeatured" = $${values.length}`);
  }
  if (!isBlank(query.kind)) {
    values.push(enumValue(String(query.kind), ['ReadyMade', 'MadeToOrder', 'Service'], 'kind'));
    filters.push(`d."Kind" = $${values.length}`);
  }
  if (!isBlank(query.visibility)) {
    values.push(enumValue(String(query.visibility), ['Private', 'Public'], 'visibility'));
    filters.push(`d."Visibility" = $${values.length}`);
  }
  if (query.tag !== undefined && String(query.tag).trim()) {
    values.push(String(query.tag).trim().toLowerCase());
    filters.push(`$${values.length} = ANY(d."Tags")`);
  }
  if (query.search !== undefined && String(query.search).trim()) {
    values.push(likePattern(String(query.search)));
    const parameter = `$${values.length}`;
    filters.push(`(d."Name" ILIKE ${parameter} ESCAPE E'\\\\' OR d."Description" ILIKE ${parameter} ESCAPE E'\\\\' OR d."GarmentType" ILIKE ${parameter} ESCAPE E'\\\\')`);
  }

  const where = filters.join(' AND ');
  const count = await pool.query(`SELECT count(*)::int AS "TotalCount" FROM "Designs" d WHERE ${where}`, values);
  const rows = await pool.query(`
    SELECT d."Id", d."Name", d."Slug", d."Description", d."GarmentType", d."Fabrics", d."Colours", d."Sizes", d."ProductionDays", d."Kind", d."CategoryId", d."BasePrice", d."CurrencyCode", d."IsFeatured",
      d."Visibility", d."Status", d."Tags", d."CreatedAtUtc",
      (SELECT i."MediaAssetId" FROM "DesignImages" i WHERE i."BusinessId" = d."BusinessId" AND i."DesignId" = d."Id" ORDER BY i."SortOrder" LIMIT 1) AS "CoverMediaId",
      c."Name" AS "CategoryName"
    FROM "Designs" d
    LEFT JOIN "DesignCategories" c ON c."BusinessId" = d."BusinessId" AND c."Id" = d."CategoryId"
    WHERE ${where}
    ORDER BY d."IsFeatured" DESC, d."Name"
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
  [...values, pageSize, (page - 1) * pageSize]);

  return {
    items: rows.rows.map(designSummary),
    page,
    pageSize,
    totalCount: Number(count.rows[0]?.TotalCount ?? 0),
  };
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function getDesign(pool, businessId, id) {
  if (!isUuid(id)) throw AppError.notFound('design_not_found', 'Design not found.');
  const { rows } = await pool.query(`
    SELECT d."Id", d."Name", d."Slug", d."Description", d."Kind", d."CategoryId", c."Name" AS "CategoryName",
      d."GarmentType", d."Tags", d."Fabrics", d."Colours", d."Sizes", d."BasePrice", d."CurrencyCode",
      d."ProductionDays", d."IsFeatured", d."Visibility", d."Status", d."ParentDesignId",
      d.xmin::text::bigint AS "Version", d."CreatedAtUtc"
    FROM "Designs" d
    LEFT JOIN "DesignCategories" c ON c."BusinessId" = d."BusinessId" AND c."Id" = d."CategoryId"
    WHERE d."BusinessId" = $1 AND d."Id" = $2`, [businessId, id]);
  if (!rows.length) throw AppError.notFound('design_not_found', 'Design not found.');
  const row = rows[0];
  const images = await pool.query(`
    SELECT "MediaAssetId", "AltText", "SortOrder" FROM "DesignImages"
    WHERE "BusinessId" = $1 AND "DesignId" = $2 ORDER BY "SortOrder"`, [businessId, id]);
  return {
    id: row.Id,
    name: row.Name,
    slug: row.Slug,
    description: row.Description,
    kind: row.Kind,
    categoryId: row.CategoryId,
    categoryName: row.CategoryName,
    garmentType: row.GarmentType,
    tags: row.Tags ?? [],
    fabrics: row.Fabrics ?? [],
    colours: row.Colours ?? [],
    sizes: row.Sizes ?? [],
    basePrice: row.BasePrice === null ? null : Number(row.BasePrice),
    currencyCode: row.CurrencyCode,
    productionDays: row.ProductionDays,
    isFeatured: row.IsFeatured,
    visibility: row.Visibility,
    status: row.Status,
    parentDesignId: row.ParentDesignId,
    version: Number(row.Version),
    createdAtUtc: row.CreatedAtUtc,
    images: images.rows.map((image) => ({ mediaId: image.MediaAssetId, altText: image.AltText, sortOrder: image.SortOrder })),
  };
}

const clean = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const truncate = (value, length) => value.length > length ? value.slice(0, length) : value;

function slugFrom(value, fallback, maxLength) {
  const normalized = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const slug = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, maxLength).replace(/-+$/g, '');
  return slug || fallback;
}

function normalizedList(values, maxLength, lower = false) {
  const seen = new Set();
  const result = [];
  for (const raw of values ?? []) {
    let value = truncate(String(raw).trim(), maxLength);
    if (lower) value = value.toLowerCase();
    const key = value.toLowerCase();
    if (value && !seen.has(key)) { seen.add(key); result.push(value); }
  }
  return result;
}

async function recordAudit(db, user, action, entityType, entityId, details = null) {
  await db.query(`
    INSERT INTO "AuditLogs" ("Id","Action","ActorUserId","BusinessId","CreatedAtUtc","DetailsJson","EntityId","EntityType")
    VALUES ($1,$2,$3,$4,now(),$5::jsonb,$6,$7)`,
  [randomUUID(), action, user.userId, user.businessId, details === null ? null : JSON.stringify(details), entityId, entityType]);
}

async function businessCurrency(db, businessId) {
  const { rows } = await db.query('SELECT "CurrencyCode" FROM "Businesses" WHERE "Id" = $1', [businessId]);
  if (!rows.length) throw AppError.unauthorized('no_tenant', 'No business in scope.');
  return rows[0].CurrencyCode;
}

async function ensureCategory(db, businessId, categoryId) {
  if (!categoryId) return;
  const { rows } = await db.query('SELECT 1 FROM "DesignCategories" WHERE "BusinessId" = $1 AND "Id" = $2', [businessId, categoryId]);
  if (!rows.length) throw AppError.badRequest('unknown_category', 'Category not found.');
}

async function uniqueDesignSlug(db, businessId, name) {
  const base = slugFrom(name, 'design', 70);
  const { rows } = await db.query(`
    SELECT "Slug" FROM "Designs" WHERE "BusinessId" = $1 AND ("Slug" = $2 OR "Slug" LIKE $3)`,
  [businessId, base, `${base}-%`]);
  const taken = new Set(rows.map((row) => row.Slug));
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) if (!taken.has(`${base}-${index}`)) return `${base}-${index}`;
}

function designInput(request, currency) {
  const basePrice = request.basePrice ?? null;
  return {
    name: request.name.trim(),
    description: clean(request.description),
    categoryId: request.categoryId ?? null,
    garmentType: clean(request.garmentType),
    tags: normalizedList(request.tags, 30, true),
    fabrics: normalizedList(request.fabrics, 40),
    colours: normalizedList(request.colours, 40),
    sizes: normalizedList(request.sizes, 40),
    basePrice,
    currencyCode: basePrice === null ? null : currency,
    productionDays: request.productionDays ?? null,
    isFeatured: request.isFeatured ?? false,
  };
}

function designKind(value) { return enumValue(value, ['ReadyMade', 'MadeToOrder', 'Service'], 'kind'); }
function designStatus(value) { return enumValue(value, ['Active', 'Archived'], 'status'); }
function designVisibility(value) { return enumValue(value, ['Private', 'Public'], 'visibility'); }

export async function createDesign(pool, user, request) {
  const kind = designKind(request.kind);
  const businessId = user.businessId;
  await ensureCategory(pool, businessId, request.categoryId);
  if (request.parentDesignId) {
    const parent = await pool.query('SELECT 1 FROM "Designs" WHERE "BusinessId" = $1 AND "Id" = $2', [businessId, request.parentDesignId]);
    if (!parent.rows.length) throw AppError.badRequest('unknown_parent_design', 'The design you are varying does not exist.');
  }
  const currency = await businessCurrency(pool, businessId);
  const values = designInput(request, currency);
  const id = randomUUID();
  try {
    await withTransaction(pool, async (client) => {
      await ensureBelowLimit(client, businessId, 'designs.max', async (db) => {
        const count = await db.query('SELECT count(*)::int AS "Count" FROM "Designs" WHERE "BusinessId" = $1 AND "Status" = \'Active\'', [businessId]);
        return count.rows[0].Count;
      });
      const slug = await uniqueDesignSlug(client, businessId, values.name);
      await client.query(`
        INSERT INTO "Designs" ("Id","BusinessId","Name","Slug","Description","Kind","CategoryId","GarmentType","Tags","Fabrics","Colours","Sizes",
          "BasePrice","CurrencyCode","ProductionDays","IsFeatured","Visibility","Status","ParentDesignId","CreatedByUserId","CreatedAtUtc")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10::text[],$11::text[],$12::text[],$13,$14,$15,$16,'Private','Active',$17,$18,now())`,
      [id, businessId, values.name, slug, values.description, kind, values.categoryId, values.garmentType,
        values.tags, values.fabrics, values.colours, values.sizes, values.basePrice, values.currencyCode,
        values.productionDays, values.isFeatured, request.parentDesignId ?? null, user.userId]);
      await recordAudit(client, user, 'design.created', 'Design', id, { name: values.name, slug });
    });
  } catch (error) {
    if (error?.code === '23505') throw AppError.conflict('slug_conflict', 'Another design with the same name was saved at the same moment. Please try again.');
    throw error;
  }
  return getDesign(pool, businessId, id);
}

export async function updateDesign(pool, user, id, request) {
  if (request.version === undefined || request.version === null) throw AppError.badRequest('version_required', "Include the design's current version when updating.");
  const businessId = user.businessId;
  const kind = designKind(request.kind);
  await ensureCategory(pool, businessId, request.categoryId);
  const currency = await businessCurrency(pool, businessId);
  const values = designInput(request, currency);
  await withTransaction(pool, async (client) => {
    const current = await client.query(`SELECT "Status" FROM "Designs" WHERE "BusinessId" = $1 AND "Id" = $2 FOR UPDATE`, [businessId, id]);
    if (!current.rows.length) throw AppError.notFound('design_not_found', 'Design not found.');
    if (current.rows[0].Status === 'Archived') throw AppError.conflict('design_archived', 'Restore this design before editing it.');
    const updated = await client.query(`
      UPDATE "Designs" SET "Name" = $1,"Description" = $2,"Kind" = $3,"CategoryId" = $4,"GarmentType" = $5,
        "Tags" = $6::text[],"Fabrics" = $7::text[],"Colours" = $8::text[],"Sizes" = $9::text[],"BasePrice" = $10,
        "CurrencyCode" = $11,"ProductionDays" = $12,"IsFeatured" = $13,"UpdatedAtUtc" = now()
      WHERE "BusinessId" = $14 AND "Id" = $15 AND xmin::text::bigint = $16`,
    [values.name, values.description, kind, values.categoryId, values.garmentType, values.tags, values.fabrics, values.colours,
      values.sizes, values.basePrice, values.currencyCode, values.productionDays, values.isFeatured, businessId, id, request.version]);
    if (updated.rowCount !== 1) throw AppError.conflict('stale_version', 'This design was changed by someone else. Reload and try again.');
    await recordAudit(client, user, 'design.updated', 'Design', id);
  });
  return getDesign(pool, businessId, id);
}

export async function setDesignStatus(pool, user, id, request) {
  const businessId = user.businessId;
  const status = designStatus(request.status);
  return withTransaction(pool, async (client) => {
    const current = await client.query('SELECT "Status","Visibility" FROM "Designs" WHERE "BusinessId" = $1 AND "Id" = $2 FOR UPDATE', [businessId, id]);
    if (!current.rows.length) throw AppError.notFound('design_not_found', 'Design not found.');
    if (current.rows[0].Status === status) return getDesign(client, businessId, id);
    if (status === 'Active') {
      await ensureBelowLimit(client, businessId, 'designs.max', async (db) => {
        const count = await db.query('SELECT count(*)::int AS "Count" FROM "Designs" WHERE "BusinessId" = $1 AND "Status" = \'Active\'', [businessId]);
        return count.rows[0].Count;
      });
    }
    await client.query(`UPDATE "Designs" SET "Status" = $1,"Visibility" = CASE WHEN $1 = 'Archived' THEN 'Private' ELSE "Visibility" END,"UpdatedAtUtc" = now() WHERE "BusinessId" = $2 AND "Id" = $3`, [status, businessId, id]);
    await recordAudit(client, user, 'design.status_changed', 'Design', id, { status });
    return getDesign(client, businessId, id);
  });
}

export async function setDesignVisibility(pool, user, id, request) {
  const visibility = designVisibility(request.visibility);
  const businessId = user.businessId;
  return withTransaction(pool, async (client) => {
    const current = await client.query('SELECT "Status" FROM "Designs" WHERE "BusinessId" = $1 AND "Id" = $2 FOR UPDATE', [businessId, id]);
    if (!current.rows.length) throw AppError.notFound('design_not_found', 'Design not found.');
    if (visibility === 'Public' && current.rows[0].Status !== 'Active') throw AppError.conflict('design_archived', 'Archived designs cannot be made public. Restore it first.');
    await client.query('UPDATE "Designs" SET "Visibility" = $1,"UpdatedAtUtc" = now() WHERE "BusinessId" = $2 AND "Id" = $3', [visibility, businessId, id]);
    await recordAudit(client, user, 'design.visibility_changed', 'Design', id, { visibility });
    return getDesign(client, businessId, id);
  });
}

export async function setDesignImages(pool, user, id, request) {
  const businessId = user.businessId;
  const images = request.images ?? [];
  const ids = images.map((image) => image.mediaId);
  if (new Set(ids).size !== ids.length) throw AppError.badRequest('duplicate_image', 'The same image was listed twice.');
  const design = await pool.query('SELECT "Status" FROM "Designs" WHERE "BusinessId" = $1 AND "Id" = $2', [businessId, id]);
  if (!design.rows.length) throw AppError.notFound('design_not_found', 'Design not found.');
  if (design.rows[0].Status === 'Archived') throw AppError.conflict('design_archived', 'Restore this design before changing its images.');
  const valid = ids.length ? await pool.query(`SELECT "Id" FROM "MediaAssets" WHERE "BusinessId" = $1 AND "Purpose" = 'DesignImage' AND "Id" = ANY($2::uuid[])`, [businessId, ids]) : { rows: [] };
  if (valid.rows.length !== ids.length) throw AppError.badRequest('unknown_image', 'One or more images were not found. Upload them as design images first.');
  await withTransaction(pool, async (client) => {
    await client.query('DELETE FROM "DesignImages" WHERE "BusinessId" = $1 AND "DesignId" = $2', [businessId, id]);
    for (let sortOrder = 0; sortOrder < images.length; sortOrder += 1) {
      await client.query(`INSERT INTO "DesignImages" ("BusinessId","DesignId","MediaAssetId","SortOrder","AltText") VALUES ($1,$2,$3,$4,$5)`,
        [businessId, id, images[sortOrder].mediaId, sortOrder, clean(images[sortOrder].altText)]);
    }
    await recordAudit(client, user, 'design.images_changed', 'Design', id, { count: images.length });
  });
  return getDesign(pool, businessId, id);
}

export async function listDesignCategories(pool, businessId) {
  const { rows } = await pool.query(`
    SELECT c."Id",c."Name",c."SortOrder",count(d."Id")::int AS "DesignCount"
    FROM "DesignCategories" c LEFT JOIN "Designs" d ON d."BusinessId" = c."BusinessId" AND d."CategoryId" = c."Id"
    WHERE c."BusinessId" = $1 GROUP BY c."Id" ORDER BY c."SortOrder",c."Name"`, [businessId]);
  return rows.map((row) => ({ id: row.Id, name: row.Name, sortOrder: row.SortOrder, designCount: row.DesignCount }));
}

async function ensureCategoryNameFree(db, businessId, name, exceptId = null) {
  const { rows } = await db.query(`
    SELECT 1 FROM "DesignCategories" WHERE "BusinessId" = $1 AND lower("Name") = lower($2)
      AND ($3::uuid IS NULL OR "Id" <> $3) LIMIT 1`, [businessId, name, exceptId]);
  if (rows.length) throw AppError.conflict('category_exists', 'A category with this name already exists.');
}

export async function createDesignCategory(pool, user, request) {
  const businessId = user.businessId;
  const name = request.name.trim();
  const id = randomUUID();
  try {
    await withTransaction(pool, async (client) => {
      await ensureCategoryNameFree(client, businessId, name);
      await client.query('INSERT INTO "DesignCategories" ("Id","BusinessId","Name","SortOrder","CreatedAtUtc") VALUES ($1,$2,$3,$4,now())',
        [id, businessId, name, request.sortOrder]);
      await recordAudit(client, user, 'design_category.created', 'DesignCategory', id, { name });
    });
  } catch (error) {
    if (error?.code === '23505') throw AppError.conflict('category_exists', 'A category with this name already exists.');
    throw error;
  }
  return { id, name, sortOrder: request.sortOrder, designCount: 0 };
}

export async function updateDesignCategory(pool, user, id, request) {
  const businessId = user.businessId;
  const name = request.name.trim();
  const result = await withTransaction(pool, async (client) => {
    const current = await client.query('SELECT "Id" FROM "DesignCategories" WHERE "BusinessId" = $1 AND "Id" = $2 FOR UPDATE', [businessId, id]);
    if (!current.rows.length) throw AppError.notFound('category_not_found', 'Category not found.');
    await ensureCategoryNameFree(client, businessId, name, id);
    await client.query('UPDATE "DesignCategories" SET "Name" = $1,"SortOrder" = $2,"UpdatedAtUtc" = now() WHERE "BusinessId" = $3 AND "Id" = $4',
      [name, request.sortOrder, businessId, id]);
    await recordAudit(client, user, 'design_category.updated', 'DesignCategory', id);
    const count = await client.query('SELECT count(*)::int AS "DesignCount" FROM "Designs" WHERE "BusinessId" = $1 AND "CategoryId" = $2', [businessId, id]);
    return count.rows[0].DesignCount;
  });
  return { id, name, sortOrder: request.sortOrder, designCount: result };
}

export async function deleteDesignCategory(pool, user, id) {
  const businessId = user.businessId;
  await withTransaction(pool, async (client) => {
    const category = await client.query('SELECT "Name" FROM "DesignCategories" WHERE "BusinessId" = $1 AND "Id" = $2 FOR UPDATE', [businessId, id]);
    if (!category.rows.length) throw AppError.notFound('category_not_found', 'Category not found.');
    const used = await client.query('SELECT count(*)::int AS "Count" FROM "Designs" WHERE "BusinessId" = $1 AND "CategoryId" = $2', [businessId, id]);
    if (used.rows[0].Count > 0) {
      throw AppError.conflict('category_in_use', `${used.rows[0].Count} design(s) use this category. Move them to another category first.`,
        { designCount: used.rows[0].Count });
    }
    await client.query('DELETE FROM "DesignCategories" WHERE "BusinessId" = $1 AND "Id" = $2', [businessId, id]);
    await recordAudit(client, user, 'design_category.deleted', 'DesignCategory', id, { name: category.rows[0].Name });
  });
}

export async function bulkDesignOperation(pool, user, request) {
  const ids = request.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some((id) => !isUuid(id)) || new Set(ids).size !== ids.length) {
    throw AppError.badRequest('invalid_design_ids', 'Choose 1–100 unique valid design IDs.');
  }
  const action = request.action;
  if (!['status', 'visibility', 'featured'].includes(action)) throw AppError.badRequest('invalid_bulk_action', 'Choose a supported bulk action.');
  if (action === 'status') designStatus(request.status);
  if (action === 'visibility') designVisibility(request.visibility);
  if (action === 'featured' && typeof request.isFeatured !== 'boolean') throw AppError.badRequest('invalid_featured', 'isFeatured must be true or false.');
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query(`SELECT "Id","Status","Visibility" FROM "Designs" WHERE "BusinessId" = $1 AND "Id" = ANY($2::uuid[]) FOR UPDATE`, [user.businessId, ids]);
    if (rows.length !== ids.length) throw AppError.notFound('design_not_found', 'One or more selected designs were not found. Refresh the catalog and try again.');
    if (action === 'status' && request.status === 'Active') {
      const archivedIds = rows.filter((row) => row.Status !== 'Active').map((row) => row.Id);
      if (archivedIds.length) {
        await ensureBelowLimit(client, user.businessId, 'designs.max', async (db) => {
          const count = await db.query(`SELECT count(*)::int AS "Count" FROM "Designs" WHERE "BusinessId" = $1 AND "Status" = 'Active'`, [user.businessId]);
          return Number(count.rows[0].Count) + archivedIds.length - 1;
        });
      }
    }
    if (action === 'visibility' && request.visibility === 'Public' && rows.some((row) => row.Status !== 'Active')) {
      throw AppError.conflict('design_archived', 'Archived designs cannot be made public. Restore them first.');
    }
    for (const id of ids) {
      if (action === 'status') {
        await client.query(`UPDATE "Designs" SET "Status" = $1,"Visibility" = CASE WHEN $1 = 'Archived' THEN 'Private' ELSE "Visibility" END,"UpdatedAtUtc" = now() WHERE "BusinessId" = $2 AND "Id" = $3`, [request.status, user.businessId, id]);
        await recordAudit(client, user, 'design.status_changed', 'Design', id, { status: request.status, bulk: true });
      } else if (action === 'visibility') {
        await client.query(`UPDATE "Designs" SET "Visibility" = $1,"UpdatedAtUtc" = now() WHERE "BusinessId" = $2 AND "Id" = $3`, [request.visibility, user.businessId, id]);
        await recordAudit(client, user, 'design.visibility_changed', 'Design', id, { visibility: request.visibility, bulk: true });
      } else {
        await client.query(`UPDATE "Designs" SET "IsFeatured" = $1,"UpdatedAtUtc" = now() WHERE "BusinessId" = $2 AND "Id" = $3`, [request.isFeatured, user.businessId, id]);
        await recordAudit(client, user, 'design.featured_changed', 'Design', id, { isFeatured: request.isFeatured, bulk: true });
      }
    }
    return { updated: ids.length, ids };
  });
}

function csvCell(value) {
  if (value === null || value === undefined || value === '') return '';
  let text = String(value).replaceAll('\0', '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function exportDesigns(pool, businessId, query) {
  const rows = [];
  let page = 1;
  let totalCount = 0;
  do {
    const result = await listDesigns(pool, businessId, { ...query, page, pageSize: 100 });
    rows.push(...result.items);
    totalCount = result.totalCount;
    page += 1;
    if (!result.items.length || rows.length >= totalCount || rows.length >= 100_000) break;
  } while (true);
  const lines = [csvRow(['Design ID', 'Name', 'Description', 'Kind', 'Category', 'Garment Type', 'Base price', 'Currency', 'Production days', 'Featured', 'Tags', 'Fabrics', 'Colours', 'Sizes', 'Visibility', 'Status', 'Slug', 'Created UTC'])];
  for (const row of rows) {
    lines.push(csvRow([row.id, row.name, row.description, row.kind, row.categoryName, row.garmentType, row.basePrice, row.currencyCode,
      row.productionDays, row.isFeatured ? 'yes' : 'no', row.tags.join('; '), row.fabrics.join('; '), row.colours.join('; '), row.sizes.join('; '),
      row.visibility, row.status, row.slug, new Date(row.createdAtUtc).toISOString()]));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function csvRow(values) { return values.map(csvCell).join(','); }