import { randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { hasAtMostPlaces } from '../money.js';

const categoryDefaults = [
  'Fabric & materials',
  'Labour & outsourcing',
  'Rent & utilities',
  'Equipment & maintenance',
  'Transport & delivery',
  'Marketing',
  'Other',
];
const expenseEntitlement = 'finance.expenses';

function dateOnly(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw AppError.badRequest('invalid_date', `${field} must be a valid date in YYYY-MM-DD format.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw AppError.badRequest('invalid_date', `${field} must be a valid date in YYYY-MM-DD format.`);
  }
  return value;
}

function businessDate(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function csvCell(value) {
  let text = value == null ? '' : String(value).replaceAll('\0', '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvRow(values) {
  return values.map(csvCell).join(',');
}

function expenseDto(row) {
  return {
    id: row.Id,
    categoryId: row.CategoryId,
    categoryName: row.CategoryName,
    expenseDate: String(row.ExpenseDate).slice(0, 10),
    amount: Number(row.Amount),
    currencyCode: row.CurrencyCode,
    description: row.Description,
    vendor: row.Vendor,
    reference: row.Reference,
    isVoid: row.VoidedAtUtc !== null,
    voidReason: row.VoidReason,
    version: Number(row.Version),
    createdAtUtc: new Date(row.CreatedAtUtc).toISOString(),
    locationId: row.LocationId,
  };
}

async function requireExpenseFeature(db, businessId) {
  const { rows } = await db.query(`
    SELECT COALESCE(override."Value", pe."Value", 'false') AS "Value"
    FROM "Plans" p
    LEFT JOIN "PlanEntitlements" pe ON pe."PlanId" = p."Id" AND pe."Key" = $2
    LEFT JOIN LATERAL (
      SELECT o."Value" FROM "EntitlementOverrides" o
      WHERE o."BusinessId" = $1 AND o."Key" = $2
        AND (o."ExpiresAtUtc" IS NULL OR o."ExpiresAtUtc" > now())
      ORDER BY o."CreatedAtUtc" DESC LIMIT 1
    ) override ON TRUE
    WHERE p."Id" = COALESCE(
      (SELECT s."PlanId" FROM "Subscriptions" s
        WHERE s."BusinessId" = $1 AND s."Status" <> 'Expired' LIMIT 1),
      (SELECT free."Id" FROM "Plans" free WHERE free."Code" = 'free' LIMIT 1)
    )`,
  [businessId, expenseEntitlement]);
  if (!rows.length) throw new AppError(503, 'plans_not_seeded', 'Subscription plans are not configured on this server.');
  if (String(rows[0].Value ?? '').trim() !== 'true') {
    throw AppError.forbidden('feature_not_in_plan', 'Your current plan does not include expense tracking.');
  }
}

async function recordAudit(db, user, action, entityType, entityId, details = null) {
  await db.query(`
    INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc",
      "DetailsJson", "EntityId", "EntityType")
    VALUES ($1, $2, $3, $4, now(), $5::jsonb, $6, $7)`,
  [randomUUID(), action, user.userId, user.businessId,
    details === null ? null : JSON.stringify(details), entityId, entityType]);
}

async function allowedLocations(pool, user) {
  if (user.isOwner || user.permissions.includes('locations.all')) return null;
  const { rows } = await pool.query(`
    SELECT DISTINCT ml."LocationId"
    FROM "Memberships" m
    JOIN "MembershipLocations" ml ON ml."MembershipId" = m."Id" AND ml."BusinessId" = m."BusinessId"
    WHERE m."UserId" = $1 AND m."BusinessId" = $2 AND m."Status" = 0`,
  [user.userId, user.businessId]);
  return rows.map((row) => row.LocationId);
}

function expenseScope(user, allowed) {
  const params = [user.businessId];
  const conditions = ['e."BusinessId" = $1'];
  if (allowed !== null) {
    params.push(allowed);
    conditions.push(`e."LocationId" = ANY($${params.length}::uuid[])`);
  }
  return { params, conditions };
}

async function ensureDefaultCategories(pool, user) {
  const { rows } = await pool.query(`
    SELECT 1 FROM "ExpenseCategories" WHERE "BusinessId" = $1 LIMIT 1`,
  [user.businessId]);
  if (rows.length) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`expense-categories:${user.businessId}`]);
    const { rows: existing } = await client.query(`
      SELECT 1 FROM "ExpenseCategories" WHERE "BusinessId" = $1 LIMIT 1`,
    [user.businessId]);
    if (!existing.length) {
      for (let sortOrder = 0; sortOrder < categoryDefaults.length; sortOrder += 1) {
        await client.query(`
          INSERT INTO "ExpenseCategories" ("Id", "BusinessId", "Name", "IsActive", "SortOrder", "CreatedAtUtc")
          VALUES ($1, $2, $3, TRUE, $4, now())`,
        [randomUUID(), user.businessId, categoryDefaults[sortOrder], sortOrder]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getBusiness(pool, businessId) {
  const { rows } = await pool.query(`
    SELECT "CurrencyCode", "TimeZoneId" FROM "Businesses" WHERE "Id" = $1`,
  [businessId]);
  if (!rows.length) throw AppError.notFound('business_not_found', 'Business not found.');
  return rows[0];
}

async function loadExpense(pool, user, expenseId, allowed) {
  const { params, conditions } = expenseScope(user, allowed);
  params.push(expenseId);
  conditions.push(`e."Id" = $${params.length}`);
  const { rows } = await pool.query(`
    SELECT e."Id", e."CategoryId", c."Name" AS "CategoryName", e."ExpenseDate",
      e."Amount", e."CurrencyCode", e."Description", e."Vendor", e."Reference",
      e."VoidedAtUtc", e."VoidReason", e."LocationId", e."CreatedAtUtc",
      e.xmin::text::bigint AS "Version"
    FROM "Expenses" e
    JOIN "ExpenseCategories" c ON c."BusinessId" = e."BusinessId" AND c."Id" = e."CategoryId"
    WHERE ${conditions.join(' AND ')}`,
  params);
  if (!rows.length) throw AppError.notFound('expense_not_found', 'Expense not found.');
  return rows[0];
}

async function validateExpense(pool, user, payload, today) {
  if (!hasAtMostPlaces(payload.amount, 2)) {
    throw AppError.badRequest('invalid_amount', 'Amounts can have at most 2 decimal places.');
  }
  const expenseDate = dateOnly(payload.expenseDate, 'expenseDate');
  if (expenseDate > today) throw AppError.badRequest('expense_in_future', 'An expense cannot be dated in the future.');
  const { rows: categories } = await pool.query(`
    SELECT "Name", "IsActive" FROM "ExpenseCategories"
    WHERE "BusinessId" = $1 AND "Id" = $2`,
  [user.businessId, payload.categoryId]);
  if (!categories.length) throw AppError.badRequest('unknown_category', 'Category not found.');
  if (!categories[0].IsActive) {
    throw AppError.conflict('category_inactive', `'${categories[0].Name}' is inactive. Pick another category or reactivate it.`);
  }
  return expenseDate;
}

async function resolveLocation(pool, user, locationId, allowed) {
  if (allowed !== null) {
    if (!locationId) throw AppError.forbidden('location_forbidden', 'Choose one of your locations for this expense.');
    if (!allowed.includes(locationId)) throw AppError.forbidden('location_forbidden', 'You do not have access to that location.');
  }
  if (locationId) {
    const { rows } = await pool.query(`
      SELECT 1 FROM "Locations" WHERE "BusinessId" = $1 AND "Id" = $2 AND "IsActive"`,
    [user.businessId, locationId]);
    if (!rows.length) throw AppError.badRequest('unknown_location', 'Location not found or inactive.');
  }
  return locationId ?? null;
}

export async function listExpenseCategories(pool, user) {
  await requireExpenseFeature(pool, user.businessId);
  await ensureDefaultCategories(pool, user);
  const { rows } = await pool.query(`
    SELECT "Id", "Name", "IsActive", "SortOrder"
    FROM "ExpenseCategories" WHERE "BusinessId" = $1
    ORDER BY "SortOrder", "Name"`,
  [user.businessId]);
  return rows.map((row) => ({
    id: row.Id, name: row.Name, isActive: row.IsActive, sortOrder: row.SortOrder,
  }));
}

export async function saveExpenseCategory(pool, transaction, user, categoryId, payload) {
  await requireExpenseFeature(pool, user.businessId);
  const name = payload.name.trim();
  return transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`expense-categories:${user.businessId}`]);
    if (categoryId) {
      const { rows: existing } = await db.query(`
        SELECT "Id" FROM "ExpenseCategories" WHERE "BusinessId" = $1 AND "Id" = $2 FOR UPDATE`,
      [user.businessId, categoryId]);
      if (!existing.length) throw AppError.notFound('category_not_found', 'Category not found.');
    }
    const { rows: duplicate } = await db.query(`
      SELECT 1 FROM "ExpenseCategories" WHERE "BusinessId" = $1 AND lower("Name") = lower($2)
        AND ($3::uuid IS NULL OR "Id" <> $3)
      LIMIT 1`,
    [user.businessId, name, categoryId ?? null]);
    if (duplicate.length) throw AppError.conflict('category_exists', 'A category with this name already exists.');
    let saved;
    if (!categoryId) {
      const { rows } = await db.query(`
        INSERT INTO "ExpenseCategories" ("Id", "BusinessId", "Name", "IsActive", "SortOrder", "CreatedAtUtc")
        VALUES ($1, $2, $3, $4, $5, now())
        RETURNING "Id", "Name", "IsActive", "SortOrder"`,
      [randomUUID(), user.businessId, name, payload.isActive, payload.sortOrder]);
      saved = rows[0];
      await recordAudit(db, user, 'expense_category.created', 'ExpenseCategory', saved.Id, { name });
    } else {
      const { rows } = await db.query(`
        UPDATE "ExpenseCategories" SET "Name" = $1, "IsActive" = $2, "SortOrder" = $3, "UpdatedAtUtc" = now()
        WHERE "BusinessId" = $4 AND "Id" = $5
        RETURNING "Id", "Name", "IsActive", "SortOrder"`,
      [name, payload.isActive, payload.sortOrder, user.businessId, categoryId]);
      saved = rows[0];
      await recordAudit(db, user, 'expense_category.updated', 'ExpenseCategory', categoryId);
    }
    return { id: saved.Id, name: saved.Name, isActive: saved.IsActive, sortOrder: saved.SortOrder };
  });
}

export async function listExpenses(pool, user, query, allowed) {
  await requireExpenseFeature(pool, user.businessId);
  const { params, conditions } = expenseScope(user, allowed);
  if (query.locationId) {
    params.push(query.locationId);
    conditions.push(`e."LocationId" = $${params.length}`);
  }
  if (!query.includeVoid) conditions.push('e."VoidedAtUtc" IS NULL');
  if (query.categoryId) {
    params.push(query.categoryId);
    conditions.push(`e."CategoryId" = $${params.length}`);
  }
  for (const [key, operator] of [['from', '>='], ['to', '<=']]) {
    if (query[key]) {
      params.push(query[key]);
      conditions.push(`e."ExpenseDate" ${operator} $${params.length}::date`);
    }
  }
  if (query.search) {
    params.push(`%${query.search.replace(/[\\%_]/g, '\\$&')}%`);
    conditions.push(`(e."Description" ILIKE $${params.length} ESCAPE E'\\\\'
      OR e."Vendor" ILIKE $${params.length} ESCAPE E'\\\\'
      OR e."Reference" ILIKE $${params.length} ESCAPE E'\\\\')`);
  }
  const where = conditions.join(' AND ');
  const count = await pool.query(`SELECT count(*)::int AS "TotalCount" FROM "Expenses" e WHERE ${where}`, params);
  const { rows } = await pool.query(`
    SELECT e."Id", e."CategoryId", c."Name" AS "CategoryName", e."ExpenseDate",
      e."Amount", e."CurrencyCode", e."Description", e."Vendor", e."Reference",
      e."VoidedAtUtc", e."VoidReason", e."LocationId", e."CreatedAtUtc",
      e.xmin::text::bigint AS "Version"
    FROM "Expenses" e
    JOIN "ExpenseCategories" c ON c."BusinessId" = e."BusinessId" AND c."Id" = e."CategoryId"
    WHERE ${where}
    ORDER BY e."ExpenseDate" DESC, e."CreatedAtUtc" DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
  [...params, query.pageSize, (query.page - 1) * query.pageSize]);
  return {
    items: rows.map(expenseDto),
    page: query.page,
    pageSize: query.pageSize,
    totalCount: Number(count.rows[0]?.TotalCount ?? 0),
  };
}

export async function getExpense(pool, user, expenseId, allowed) {
  await requireExpenseFeature(pool, user.businessId);
  return expenseDto(await loadExpense(pool, user, expenseId, allowed));
}

export async function createExpense(pool, transaction, user, payload, allowed) {
  await requireExpenseFeature(pool, user.businessId);
  const [business, permittedLocations] = await Promise.all([
    getBusiness(pool, user.businessId),
    allowed === undefined ? allowedLocations(pool, user) : allowed,
  ]);
  const today = businessDate(new Date(), business.TimeZoneId);
  const expenseDate = await validateExpense(pool, user, payload, today);
  const locationId = await resolveLocation(pool, user, payload.locationId, permittedLocations);
  return transaction(pool, async (db) => {
    const id = randomUUID();
    const { rows } = await db.query(`
      INSERT INTO "Expenses" ("Id", "BusinessId", "CategoryId", "LocationId", "ExpenseDate", "Amount",
        "CurrencyCode", "Description", "Vendor", "Reference", "CreatedByUserId", "CreatedAtUtc")
      VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, now())
      RETURNING "Id", "CategoryId", "ExpenseDate", "Amount", "CurrencyCode", "Description",
        "Vendor", "Reference", "VoidedAtUtc", "VoidReason", "LocationId", "CreatedAtUtc",
        xmin::text::bigint AS "Version"`,
    [id, user.businessId, payload.categoryId, locationId, expenseDate, payload.amount, business.CurrencyCode,
      payload.description.trim(), payload.vendor?.trim() || null, payload.reference?.trim() || null, user.userId]);
    const saved = rows[0];
    const { rows: categoryRows } = await db.query(`
      SELECT "Name" AS "CategoryName" FROM "ExpenseCategories"
      WHERE "BusinessId" = $1 AND "Id" = $2`,
    [user.businessId, payload.categoryId]);
    saved.CategoryName = categoryRows[0].CategoryName;
    await recordAudit(db, user, 'expense.created', 'Expense', id, {
      amount: payload.amount, description: payload.description.trim(), locationId,
    });
    return expenseDto(saved);
  });
}

export async function updateExpense(pool, transaction, user, expenseId, payload, allowed) {
  await requireExpenseFeature(pool, user.businessId);
  if (payload.version === undefined) throw AppError.badRequest('version_required', "Include the expense's current version when updating.");
  const permittedLocations = allowed === undefined ? await allowedLocations(pool, user) : allowed;
  const current = await loadExpense(pool, user, expenseId, permittedLocations);
  if (current.VoidedAtUtc) throw AppError.conflict('expense_void', 'A voided expense cannot be edited.');
  const business = await getBusiness(pool, user.businessId);
  const expenseDate = await validateExpense(pool, user, payload, businessDate(new Date(), business.TimeZoneId));
  const locationId = payload.locationId === undefined || payload.locationId === current.LocationId
    ? current.LocationId
    : await resolveLocation(pool, user, payload.locationId, permittedLocations);
  return transaction(pool, async (db) => {
    const { rows } = await db.query(`
      UPDATE "Expenses" SET "CategoryId" = $1, "LocationId" = $2, "ExpenseDate" = $3::date,
        "Amount" = $4, "Description" = $5, "Vendor" = $6, "Reference" = $7, "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $8 AND "Id" = $9 AND xmin::text::bigint = $10
        AND "VoidedAtUtc" IS NULL
      RETURNING "Id", "CategoryId", "ExpenseDate", "Amount", "CurrencyCode", "Description",
        "Vendor", "Reference", "VoidedAtUtc", "VoidReason", "LocationId", "CreatedAtUtc",
        xmin::text::bigint AS "Version"`,
    [payload.categoryId, locationId, expenseDate, payload.amount, payload.description.trim(),
      payload.vendor?.trim() || null, payload.reference?.trim() || null, user.businessId, expenseId, payload.version]);
    if (!rows.length) throw AppError.conflict('stale_version', 'This expense was changed by someone else. Reload and try again.');
    await recordAudit(db, user, 'expense.updated', 'Expense', expenseId, {
      amount: payload.amount, locationId,
    });
    const { rows: categoryRows } = await db.query(`
      SELECT "Name" AS "CategoryName" FROM "ExpenseCategories"
      WHERE "BusinessId" = $1 AND "Id" = $2`,
    [user.businessId, payload.categoryId]);
    rows[0].CategoryName = categoryRows[0].CategoryName;
    return expenseDto(rows[0]);
  });
}

export async function voidExpense(pool, transaction, user, expenseId, reason, allowed) {
  await requireExpenseFeature(pool, user.businessId);
  const permittedLocations = allowed === undefined ? await allowedLocations(pool, user) : allowed;
  return transaction(pool, async (db) => {
    const { params, conditions } = expenseScope(user, permittedLocations);
    params.push(expenseId);
    conditions.push(`e."Id" = $${params.length}`);
    const { rows: current } = await db.query(`
      SELECT e."Id", e."Amount", xmin::text::bigint AS "Version", e."VoidedAtUtc"
      FROM "Expenses" e WHERE ${conditions.join(' AND ')} FOR UPDATE`,
    params);
    if (!current.length) throw AppError.notFound('expense_not_found', 'Expense not found.');
    if (current[0].VoidedAtUtc) throw AppError.conflict('expense_void', 'This expense is already voided.');
    const { rows: updated } = await db.query(`
      UPDATE "Expenses" SET "VoidedAtUtc" = now(), "VoidReason" = $1, "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $2 AND "Id" = $3 AND xmin::text::bigint = $4
      RETURNING "Id"`,
    [reason.trim(), user.businessId, expenseId, current[0].Version]);
    if (!updated.length) throw AppError.conflict('stale_version', 'This expense was changed by someone else. Reload and try again.');
    await recordAudit(db, user, 'expense.voided', 'Expense', expenseId, {
      amount: current[0].Amount, reason: reason.trim(),
    });
  });
}

export async function summarizeExpenses(pool, user, query, allowed) {
  await requireExpenseFeature(pool, user.businessId);
  const { params, conditions } = expenseScope(user, allowed);
  conditions.push('e."VoidedAtUtc" IS NULL');
  if (query.locationId) {
    params.push(query.locationId);
    conditions.push(`e."LocationId" = $${params.length}`);
  }
  for (const [key, operator] of [['from', '>='], ['to', '<=']]) {
    if (query[key]) {
      params.push(query[key]);
      conditions.push(`e."ExpenseDate" ${operator} $${params.length}::date`);
    }
  }
  const { rows } = await pool.query(`
    SELECT e."CategoryId", c."Name" AS "CategoryName", sum(e."Amount") AS "Total", count(*)::int AS "Count"
    FROM "Expenses" e JOIN "ExpenseCategories" c
      ON c."BusinessId" = e."BusinessId" AND c."Id" = e."CategoryId"
    WHERE ${conditions.join(' AND ')}
    GROUP BY e."CategoryId", c."Name"
    ORDER BY sum(e."Amount") DESC`,
  params);
  const business = await getBusiness(pool, user.businessId);
  const byCategory = rows.map((row) => ({
    categoryId: row.CategoryId,
    categoryName: row.CategoryName,
    total: Number(row.Total),
    count: Number(row.Count),
  }));
  return {
    currencyCode: business.CurrencyCode,
    from: query.from ?? null,
    to: query.to ?? null,
    total: byCategory.reduce((sum, row) => sum + row.total, 0),
    byCategory,
  };
}

export async function exportExpenses(pool, user, query, allowed) {
  const rows = [];
  let page = 1;
  let totalCount = 0;
  const exportLimit = 100_000;
  do {
    const result = await listExpenses(pool, user, { ...query, page, pageSize: 100 }, allowed);
    rows.push(...result.items);
    totalCount = result.totalCount;
    if (totalCount > exportLimit) {
      throw new AppError(413, 'export_too_large', `Expense exports are limited to ${exportLimit} rows. Narrow the filters and try again.`);
    }
    page += 1;
    if (rows.length >= totalCount || !result.items.length) break;
  } while (rows.length < totalCount);
  const lines = [csvRow([
    'Expense ID', 'Date', 'Category', 'Amount', 'Currency', 'Description',
    'Vendor', 'Reference', 'Location ID', 'Voided', 'Void reason',
  ])];
  for (const row of rows) {
    lines.push(csvRow([
      row.id, row.expenseDate, row.categoryName, row.amount, row.currencyCode,
      row.description, row.vendor, row.reference, row.locationId,
      row.isVoid ? 'yes' : 'no', row.voidReason,
    ]));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
