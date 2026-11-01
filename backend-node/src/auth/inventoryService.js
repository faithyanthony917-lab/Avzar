import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { requireTier } from './entitlementService.js';
import { notify } from '../notifications/notificationService.js';
import { LIST_CAP, windowedRows } from './listWindow.js';

const inventoryEntitlement = 'inventory.level';
const materialDto = (row) => {
  const onHand = Number(row.OnHand);
  const reserved = Number(row.Reserved);
  const available = onHand - reserved;
  return { id: row.Id, locationId: row.LocationId, sku: row.Sku, name: row.Name, unit: row.Unit,
    onHand, reserved, available, reorderLevel: Number(row.ReorderLevel), lowStock: available <= Number(row.ReorderLevel), active: row.IsActive !== false, version: Number(row.Version) };
};
const parseDecimal = (value, { positive = false } = {}) => {
  const text = String(value);
  if (!/^(?:\d+)(?:\.\d{1,3})?$/.test(text)) throw AppError.badRequest('invalid_quantity', 'Stock quantities must be non-negative decimals with at most 3 decimal places.');
  const [whole, fractional = ''] = text.split('.');
  const scaled = BigInt(whole) * 1000n + BigInt(fractional.padEnd(3, '0') || '0');
  if (positive && scaled <= 0n) throw AppError.badRequest('invalid_quantity', 'Quantity must be greater than zero.');
  return { text, scaled };
};
const hashCsv = (csv) => createHash('sha256').update(csv, 'utf8').digest('hex').toUpperCase();

async function transaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function allowedLocations(pool, user) {
  if (user.isOwner || user.permissions.includes('locations.all')) return null;
  const { rows } = await pool.query(`
    SELECT DISTINCT ml."LocationId" FROM "Memberships" m
    JOIN "MembershipLocations" ml ON ml."MembershipId" = m."Id" AND ml."BusinessId" = m."BusinessId"
    WHERE m."BusinessId" = $1 AND m."UserId" = $2 AND m."Status" = 0`, [user.businessId, user.userId]);
  return rows.map((row) => row.LocationId);
}

async function audit(db, user, action, entityType, entityId, details = null) {
  await db.query(`
    INSERT INTO "AuditLogs" ("Id","Action","ActorUserId","BusinessId","CreatedAtUtc","DetailsJson","EntityId","EntityType")
    VALUES ($1,$2,$3,$4,now(),$5::jsonb,$6,$7)`,
  [randomUUID(), action, user.userId, user.businessId, details === null ? null : JSON.stringify(details), entityId, entityType]);
}

async function requireInventory(db, businessId) {
  await requireTier(db, businessId, inventoryEntitlement, 'basic');
}

async function notifyLowStock(db, user, material, previousAvailable, available, previousReorderLevel, reorderLevel) {
  const wasLow = previousAvailable <= previousReorderLevel;
  const isLow = available <= reorderLevel;
  if (wasLow || !isLow) return;
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  await notify(db, {
    businessId: user.businessId, category: 'inventory', eventType: 'stock.low', title: 'Low stock',
    body: 'A material is at or below its reorder level.',
    dedupeKey: `stock.low:${String(material.Id).replaceAll('-', '').toLowerCase()}:${day}`,
    target: { kind: 'material', id: material.Id },
    recipients: material.LocationId
      ? { permission: 'inventory.view', locationId: material.LocationId }
      : { permission: 'inventory.view', locationlessOnly: true },
    actorUserId: user.userId,
    email: {
      templateKey: 'inventory.low-stock', subject: 'Inventory is at its reorder level',
      text: (recipient) => `Hello ${String(recipient.DisplayName ?? '')},\n\nA material is at or below its reorder level. Please open Avzar to review inventory.`,
    },
  });
}

/** One window of the inventory list: { rows: DTOs, totalCount }. */
export async function listInventoryWindow(pool, user, window) {
  await requireInventory(pool, user.businessId);
  const allowed = await allowedLocations(pool, user);
  const { rows, totalCount } = await windowedRows((sql, params) => pool.query(sql, params), `
    SELECT m.*,m.xmin::text::bigint AS "Version", COALESCE(ms."IsActive", true) AS "IsActive" FROM "Materials" m
    LEFT JOIN "NodeMaterialStates" ms ON ms."BusinessId" = m."BusinessId" AND ms."MaterialId" = m."Id"
    WHERE m."BusinessId" = $1 AND ($2::uuid[] IS NULL OR m."LocationId" = ANY($2::uuid[])) ORDER BY m."Name", m."Id"`,
  [user.businessId, allowed], window);
  return { rows: rows.map(materialDto), totalCount };
}

/** Every material, read a window at a time, for the CSV export. More than maxRows is refused. */
export async function listInventoryAll(pool, user, maxRows = 50_000) {
  const items = [];
  for (let offset = 0; ; offset += LIST_CAP) {
    const { rows, totalCount } = await listInventoryWindow(pool, user, { limit: LIST_CAP, offset });
    if (totalCount > maxRows) throw new AppError(413, 'export_too_large', `Exports are limited to ${maxRows} items. Narrow the list and try again.`);
    items.push(...rows);
    if (!rows.length || items.length >= totalCount) return items;
  }
}

/** The first LIST_CAP materials (the bulk actions return this to refresh a screen). */
export async function listInventory(pool, user) {
  return (await listInventoryWindow(pool, user, { limit: LIST_CAP, offset: 0 })).rows;
}

export async function listInventoryLocations(pool, user) {
  await requireInventory(pool, user.businessId);
  const allowed = await allowedLocations(pool, user);
  const { rows } = await pool.query(`SELECT "Id","Name","Address","IsActive" FROM "Locations"
    WHERE "BusinessId" = $1 AND "IsActive" AND ($2::uuid[] IS NULL OR "Id" = ANY($2::uuid[])) ORDER BY "Name"`,
  [user.businessId, allowed]);
  return rows.map((row) => ({ id: row.Id, name: row.Name, address: row.Address, isActive: row.IsActive }));
}

export async function bulkSetReorderLevel(pool, user, request) {
  await requireInventory(pool, user.businessId);
  const ids = request.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) || new Set(ids).size !== ids.length) {
    throw AppError.badRequest('invalid_material_ids', 'Choose 1–100 unique inventory items.');
  }
  const reorderLevel = parseDecimal(request.reorderLevel);
  const allowed = await allowedLocations(pool, user);
  return transaction(pool, async (db) => {
    const found = await db.query(`
      SELECT "Id", "Name", "LocationId", "OnHand", "Reserved", "ReorderLevel" FROM "Materials"
      WHERE "BusinessId" = $1 AND "Id" = ANY($2::uuid[])
        AND ($3::uuid[] IS NULL OR "LocationId" = ANY($3::uuid[]))
      FOR UPDATE`, [user.businessId, ids, allowed]);
    if (found.rows.length !== ids.length) {
      throw AppError.notFound('material_not_found', 'One or more selected materials were not found or are outside your permitted locations.');
    }
    await db.query(`UPDATE "Materials" SET "ReorderLevel" = $1::numeric, "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $2 AND "Id" = ANY($3::uuid[])`, [reorderLevel.text, user.businessId, ids]);
    for (const row of found.rows) {
      const available = parseDecimal(String(row.OnHand)).scaled - parseDecimal(String(row.Reserved)).scaled;
      await notifyLowStock(db, user, row, available, available, parseDecimal(String(row.ReorderLevel)).scaled, reorderLevel.scaled);
    }
    for (const id of ids) await audit(db, user, 'inventory.reorder_level_changed', 'MaterialStock', id, { reorderLevel: reorderLevel.text, bulk: true });
    return { updated: ids.length, items: await listInventory(db, user) };
  });
}

export async function bulkSetMaterialActive(pool, user, request) {
  await requireInventory(pool, user.businessId);
  const ids = request.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) || new Set(ids).size !== ids.length) throw AppError.badRequest('invalid_material_ids', 'Choose 1–100 unique inventory items.');
  if (typeof request.active !== 'boolean') throw AppError.badRequest('invalid_active_state', 'Choose whether the selected materials should be active.');
  const allowed = await allowedLocations(pool, user);
  return transaction(pool, async (db) => {
    const found = await db.query(`SELECT "Id" FROM "Materials" WHERE "BusinessId" = $1 AND "Id" = ANY($2::uuid[]) AND ($3::uuid[] IS NULL OR "LocationId" = ANY($3::uuid[])) FOR UPDATE`, [user.businessId, ids, allowed]);
    if (found.rows.length !== ids.length) throw AppError.notFound('material_not_found', 'One or more selected materials were not found or are outside your permitted locations.');
    for (const id of ids) {
      await db.query(`INSERT INTO "NodeMaterialStates" ("BusinessId","MaterialId","IsActive","UpdatedAtUtc","UpdatedByUserId") VALUES ($1,$2,$3,now(),$4) ON CONFLICT ("BusinessId","MaterialId") DO UPDATE SET "IsActive" = EXCLUDED."IsActive", "UpdatedAtUtc" = now(), "UpdatedByUserId" = EXCLUDED."UpdatedByUserId"`, [user.businessId, id, request.active, user.userId]);
      await audit(db, user, request.active ? 'inventory.material_activated' : 'inventory.material_deactivated', 'MaterialStock', id, { active: request.active, bulk: true });
    }
    return { updated: ids.length, items: await listInventory(db, user) };
  });
}

export async function bulkMoveMaterials(pool, user, request) {
  await requireInventory(pool, user.businessId);
  const ids = request.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) || new Set(ids).size !== ids.length) throw AppError.badRequest('invalid_material_ids', 'Choose 1–100 unique inventory items.');
  if (typeof request.locationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(request.locationId)) throw AppError.badRequest('invalid_location', 'Choose a valid destination location.');
  const allowed = await allowedLocations(pool, user);
  if (allowed !== null && !allowed.includes(request.locationId)) throw AppError.forbidden('location_forbidden', 'The destination location is outside your permitted locations.');
  return transaction(pool, async (db) => {
    const location = await db.query('SELECT "Id" FROM "Locations" WHERE "BusinessId" = $1 AND "Id" = $2 AND "IsActive" FOR SHARE', [user.businessId, request.locationId]);
    if (!location.rows.length) throw AppError.badRequest('invalid_location', 'Destination location is not active in this business.');
    const found = await db.query(`SELECT m."Id", m."Name", m."Reserved" FROM "Materials" m WHERE m."BusinessId" = $1 AND m."Id" = ANY($2::uuid[]) AND ($3::uuid[] IS NULL OR m."LocationId" = ANY($3::uuid[])) FOR UPDATE`, [user.businessId, ids, allowed]);
    if (found.rows.length !== ids.length) throw AppError.notFound('material_not_found', 'One or more selected materials were not found or are outside your permitted locations.');
    const reserved = found.rows.find((row) => parseDecimal(String(row.Reserved ?? '0')).scaled > 0n);
    if (reserved) throw AppError.conflict('reserved_stock_protected', `Cannot move ${reserved.Name} while stock is reserved for production. Release or consume its reservations first.`);
    await db.query('UPDATE "Materials" SET "LocationId" = $1, "UpdatedAtUtc" = now() WHERE "BusinessId" = $2 AND "Id" = ANY($3::uuid[])', [request.locationId, user.businessId, ids]);
    for (const id of ids) await audit(db, user, 'inventory.material_moved', 'MaterialStock', id, { locationId: request.locationId, bulk: true });
    return { updated: ids.length, items: await listInventory(db, user) };
  });
}

export async function bulkAdjustStock(pool, user, request) {
  await requireInventory(pool, user.businessId);
  const ids = request.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) || new Set(ids).size !== ids.length) throw AppError.badRequest('invalid_material_ids', 'Choose 1–100 unique inventory items.');
  const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
  if (!reason || reason.length > 500) throw AppError.badRequest('adjustment_reason_required', 'Provide a reason of 1–500 characters for the stock adjustment.');
  const quantity = parseDecimal(String(request.quantity ?? ''));
  const allowed = await allowedLocations(pool, user);
  return transaction(pool, async (db) => {
    const found = await db.query(`SELECT m.*,m.xmin::text::bigint AS "Version" FROM "Materials" m WHERE m."BusinessId" = $1 AND m."Id" = ANY($2::uuid[]) AND ($3::uuid[] IS NULL OR m."LocationId" = ANY($3::uuid[])) FOR UPDATE`, [user.businessId, ids, allowed]);
    if (found.rows.length !== ids.length) throw AppError.notFound('material_not_found', 'One or more selected materials were not found or are outside your permitted locations.');
    for (const row of found.rows) {
      const reserved = parseDecimal(String(row.Reserved)).scaled;
      const previousAvailable = parseDecimal(String(row.OnHand)).scaled - reserved;
      if (quantity.scaled < reserved) throw AppError.conflict('reserved_stock_protected', `The new count for ${row.Name} cannot be below its reserved stock (${row.Reserved}).`);
      await db.query('UPDATE "Materials" SET "OnHand" = $1::numeric, "UpdatedAtUtc" = now() WHERE "BusinessId" = $2 AND "Id" = $3', [quantity.text, user.businessId, row.Id]);
      await db.query(`INSERT INTO "StockMovements" ("Id","BusinessId","MaterialId","Kind","Quantity","OnHandAfter","ReservedAfter","ActorUserId","Note","CreatedAtUtc") VALUES ($1,$2,$3,'Adjust',$4::numeric,$4::numeric,$5::numeric,$6,$7,now())`, [randomUUID(), user.businessId, row.Id, quantity.text, String(row.Reserved), user.userId, reason]);
      await audit(db, user, 'inventory.stock_adjusted', 'MaterialStock', row.Id, { onHand: quantity.text, reserved: String(row.Reserved), reason, bulk: true });
      await notifyLowStock(db, user, row, previousAvailable, quantity.scaled - reserved,
        parseDecimal(String(row.ReorderLevel)).scaled, parseDecimal(String(row.ReorderLevel)).scaled);
    }
    return { updated: found.rows.length, items: await listInventory(db, user) };
  });
}

export async function createMaterial(pool, user, request) {
  await requireInventory(pool, user.businessId);
  if (!request.sku.trim() || request.sku.trim().length > 64 || !request.name.trim() || request.name.trim().length > 160 || !request.unit.trim() || request.unit.trim().length > 24) {
    throw AppError.badRequest('invalid_material', 'SKU, name, unit and non-negative quantities are required.');
  }
  const openingStock = parseDecimal(request.openingStock ?? 0);
  const reorderLevel = parseDecimal(request.reorderLevel ?? 0);
  const allowed = await allowedLocations(pool, user);
  if (allowed !== null && (!request.locationId || !allowed.includes(request.locationId))) {
    throw AppError.forbidden('location_forbidden', 'A permitted location must be selected for this material.');
  }
  if (request.locationId) {
    const location = await pool.query('SELECT 1 FROM "Locations" WHERE "BusinessId" = $1 AND "Id" = $2 AND "IsActive"', [user.businessId, request.locationId]);
    if (!location.rows.length) throw AppError.badRequest('invalid_location', 'Location does not belong to this business.');
  }
  const id = randomUUID();
  try {
    await transaction(pool, async (db) => {
      const existing = await db.query('SELECT 1 FROM "Materials" WHERE "BusinessId" = $1 AND upper("Sku") = upper($2) LIMIT 1', [user.businessId, request.sku.trim()]);
      if (existing.rows.length) throw AppError.conflict('duplicate_sku', 'A material with this SKU already exists.');
      await db.query(`
        INSERT INTO "Materials" ("Id","BusinessId","LocationId","Sku","Name","Unit","OnHand","Reserved","ReorderLevel","Notes","CreatedAtUtc")
        VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,0,$8::numeric,$9,now())`,
      [id, user.businessId, request.locationId ?? null, request.sku.trim().toUpperCase(), request.name.trim(), request.unit.trim(), openingStock.text, reorderLevel.text, request.notes?.trim() ?? null]);
      if (openingStock.scaled > 0n) {
        await db.query(`INSERT INTO "StockMovements" ("Id","BusinessId","MaterialId","Kind","Quantity","OnHandAfter","ReservedAfter","ActorUserId","Note","CreatedAtUtc")
          VALUES ($1,$2,$3,'Receive',$4::numeric,$4::numeric,0,$5,'Opening stock',now())`,
        [randomUUID(), user.businessId, id, openingStock.text, user.userId]);
      }
      await audit(db, user, 'inventory.material_created', 'MaterialStock', id, { sku: request.sku.trim().toUpperCase(), name: request.name.trim() });
    });
  } catch (error) {
    if (error?.code === '23505') throw AppError.conflict('duplicate_sku', 'A material with this SKU already exists.');
    throw error;
  }
  const { rows } = await pool.query('SELECT *,xmin::text::bigint AS "Version" FROM "Materials" WHERE "BusinessId" = $1 AND "Id" = $2', [user.businessId, id]);
  return materialDto(rows[0]);
}

async function stockRow(db, businessId, materialId, allowed, lock = false) {
  const { rows } = await db.query(`
    SELECT m.*,m.xmin::text::bigint AS "Version", COALESCE(ms."IsActive", true) AS "IsActive" FROM "Materials" m
    LEFT JOIN "NodeMaterialStates" ms ON ms."BusinessId" = m."BusinessId" AND ms."MaterialId" = m."Id"
    WHERE m."BusinessId" = $1 AND m."Id" = $2 AND ($3::uuid[] IS NULL OR m."LocationId" = ANY($3::uuid[])) ${lock ? 'FOR UPDATE OF m' : ''}`,
  [businessId, materialId, allowed]);
  if (!rows.length) throw AppError.notFound('material_not_found', 'Material was not found.');
  return rows[0];
}

async function taskAndOrder(db, user, taskId, allowed) {
  const { rows } = await db.query(`
    SELECT t."Id",t."OrderId",t."Status",o."LocationId" FROM "ProductionTasks" t
    JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
    WHERE t."BusinessId" = $1 AND t."Id" = $2 AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[]))`,
  [user.businessId, taskId, allowed]);
  if (!rows.length) throw AppError.notFound('task_not_found', 'Production task was not found.');
  if (['Completed', 'Cancelled'].includes(rows[0].Status)) throw AppError.conflict('task_closed', 'Materials cannot be reserved or consumed for a completed or cancelled task.');
  return rows[0];
}

async function taskReserved(db, businessId, materialId, taskId) {
  const { rows } = await db.query(`
    SELECT COALESCE(sum(CASE WHEN "Kind" = 'Reserve' THEN "Quantity" ELSE 0 END) -
      sum(CASE WHEN "Kind" IN ('Release','Consume') THEN "Quantity" ELSE 0 END),0)::text AS "Reserved"
    FROM "StockMovements" WHERE "BusinessId" = $1 AND "MaterialId" = $2 AND "TaskId" IS NOT DISTINCT FROM $3`,
  [businessId, materialId, taskId ?? null]);
  return parseDecimal(rows[0].Reserved).scaled;
}

function mapStockAction(action) {
  const names = new Map([['receive','Receive'],['adjust','Adjust'],['reserve','Reserve'],['release','Release'],['consume','Consume'],['wastage','Wastage']]);
  const kind = names.get(String(action).toLowerCase());
  if (!kind) throw AppError.badRequest('invalid_action', 'Unsupported stock action.');
  return kind;
}

export async function changeStock(pool, user, materialId, action, request) {
  await requireInventory(pool, user.businessId);
  const quantity = parseDecimal(request.quantity, { positive: true });
  const kind = mapStockAction(action);
  const allowed = await allowedLocations(pool, user);
  try {
    await transaction(pool, async (db) => {
      const material = await stockRow(db, user.businessId, materialId, allowed, true);
      const onHand = parseDecimal(material.OnHand).scaled;
      const reserved = parseDecimal(material.Reserved).scaled;
      if (request.expectedVersion != null && Number(material.Version) !== request.expectedVersion) throw AppError.conflict('stock_version_conflict', 'Stock changed since it was read. Refresh and retry.');
      let order = null;
      if (request.taskId) {
        const task = await taskAndOrder(db, user, request.taskId, allowed);
        const orderQuery = await db.query('SELECT "Id","LocationId" FROM "Orders" WHERE "BusinessId" = $1 AND "Id" = $2', [user.businessId, task.OrderId]);
        order = orderQuery.rows[0];
        if (material.LocationId && material.LocationId !== order.LocationId) throw AppError.conflict('material_location_mismatch', 'Material and production order must belong to the same location.');
      }
      if (kind === 'Release' || kind === 'Consume') {
        const taskHeld = await taskReserved(db, user.businessId, materialId, request.taskId);
        if (quantity.scaled > taskHeld) throw AppError.conflict('reservation_exceeded', request.taskId
          ? 'This task has insufficient reserved quantity for the requested release or consumption.'
          : 'Unassigned stock reservations are insufficient; specify the task to release or consume its reservation.');
      }
      let nextOnHand = onHand;
      let nextReserved = reserved;
      if (kind === 'Receive') nextOnHand += quantity.scaled;
      else if (kind === 'Adjust') {
        if (quantity.scaled < reserved) throw AppError.conflict('reserved_stock_protected', 'Physical stock count cannot be lower than the quantity already reserved.');
        nextOnHand = quantity.scaled;
      } else if (kind === 'Reserve') {
        if (quantity.scaled > onHand - reserved) throw AppError.conflict('insufficient_stock', 'Available stock is insufficient for this reservation.');
        nextReserved += quantity.scaled;
      } else if (kind === 'Release') {
        if (quantity.scaled > reserved) throw AppError.conflict('reservation_exceeded', 'Cannot release more than the reserved quantity.');
        nextReserved -= quantity.scaled;
      } else if (kind === 'Wastage') {
        if (quantity.scaled > onHand - reserved) throw AppError.conflict('reserved_stock_protected', 'Wastage cannot include stock reserved for production.');
        if (!request.note?.trim()) throw AppError.badRequest('wastage_note_required', 'Provide a note explaining the recorded wastage.');
        nextOnHand -= quantity.scaled;
      } else {
        if (quantity.scaled > reserved) throw AppError.conflict('reservation_required', 'Consume stock only from an existing reservation.');
        nextReserved -= quantity.scaled;
        nextOnHand -= quantity.scaled;
      }
      await db.query(`UPDATE "Materials" SET "OnHand" = $1::numeric,"Reserved" = $2::numeric,"UpdatedAtUtc" = now()
        WHERE "BusinessId" = $3 AND "Id" = $4 AND xmin::text::bigint = $5`,
      [formatMilli(nextOnHand), formatMilli(nextReserved), user.businessId, materialId, material.Version]);
      await db.query(`INSERT INTO "StockMovements" ("Id","BusinessId","MaterialId","Kind","Quantity","OnHandAfter","ReservedAfter","OrderId","TaskId","ActorUserId","Note","CreatedAtUtc")
        VALUES ($1,$2,$3,$4,$5::numeric,$6::numeric,$7::numeric,$8,$9,$10,$11,now())`,
      [randomUUID(), user.businessId, materialId, kind, quantity.text, formatMilli(nextOnHand), formatMilli(nextReserved), request.orderId ?? order?.Id ?? null, request.taskId ?? null, user.userId, request.note?.trim() ?? null]);
      await audit(db, user, `inventory.stock_${kind.toLowerCase()}`, 'MaterialStock', materialId,
        { quantity: quantity.text, onHand: formatMilli(nextOnHand), reserved: formatMilli(nextReserved), orderId: request.orderId ?? null, taskId: request.taskId ?? null });
      await notifyLowStock(db, user, material, onHand - reserved, nextOnHand - nextReserved,
        parseDecimal(String(material.ReorderLevel)).scaled, parseDecimal(String(material.ReorderLevel)).scaled);
    });
  } catch (error) {
    if (error?.code === '40001' || error?.code === '40P01') throw AppError.conflict('stock_concurrency_conflict', 'Concurrent stock activity changed the result. Refresh and retry.');
    throw error;
  }
  const updated = await stockRow(pool, user.businessId, materialId, allowed);
  return materialDto(updated);
}

function formatMilli(units) {
  const whole = units / 1000n;
  const fraction = String(units % 1000n).padStart(3, '0');
  return `${whole}.${fraction}`;
}

function csvParse(text, maxRows = 10000) {
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  const rows = []; let row = []; let field = ''; let quoted = false; let afterQuote = false;
  const endRow = () => {
    row.push(field); field = ''; afterQuote = false;
    if (row.some((cell) => cell.trim())) { rows.push(row); if (rows.length > maxRows) throw AppError.badRequest('too_many_rows', `The file has more than ${maxRows} rows.`); }
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') { field += '"'; index += 1; }
      else { quoted = false; afterQuote = true; }
      continue;
    }
    if (afterQuote && ![',','\r','\n'].includes(char)) throw AppError.badRequest('csv_malformed', 'Unexpected characters after a quoted CSV value.');
    if (char === '"' && field.length === 0 && !afterQuote) quoted = true;
    else if (char === '"') throw AppError.badRequest('csv_malformed', 'A quote appeared inside an unquoted CSV value.');
    else if (char === ',') { row.push(field); field = ''; afterQuote = false; }
    else if (char === '\r') { if (text[index + 1] === '\n') index += 1; endRow(); }
    else if (char === '\n') endRow();
    else field += char;
  }
  if (quoted) throw AppError.badRequest('csv_malformed', 'The file has a quoted value that never closes.');
  if (field.length || row.length || afterQuote) endRow();
  return rows;
}

function normalizeHeader(value) { return value.trim().replace(/[^a-z0-9]/gi, '').toLowerCase(); }
function cellFormulaGuard(value) { return value.length > 1 && value[0] === "'" && '=+-@\t\r'.includes(value[1]) ? value.slice(1) : value; }

async function analyzeCsv(pool, user, csv) {
  if (Buffer.byteLength(csv, 'utf8') > 5 * 1024 * 1024) throw AppError.badRequest('file_too_large', 'CSV must be under 5 MB.');
  const rows = csvParse(csv);
  if (rows.length < 2) throw AppError.badRequest('csv_empty', 'CSV needs a header and at least one material row.');
  const headerMap = new Map();
  rows[0].forEach((heading, index) => { const key = normalizeHeader(heading); if (key && !headerMap.has(key)) headerMap.set(key, index); });
  for (const required of ['sku','name','unit','openingstock','reorderlevel']) if (!headerMap.has(required)) throw AppError.badRequest('csv_missing_column', `CSV is missing the required '${required}' column.`);
  const allowed = await allowedLocations(pool, user);
  const { rows: locationRows } = await pool.query('SELECT "Id" FROM "Locations" WHERE "BusinessId" = $1', [user.businessId]);
  const knownLocations = new Set(locationRows.map((location) => location.Id));
  const seen = new Set();
  const parsed = [];
  for (let index = 1; index < rows.length; index += 1) {
    const get = (key) => {
      const position = headerMap.get(key);
      if (position === undefined || position >= rows[index].length) return '';
      return cellFormulaGuard(rows[index][position].trim());
    };
    const sku = get('sku').toUpperCase(); const name = get('name'); const unit = get('unit');
    const opening = get('openingstock'); const reorder = get('reorderlevel'); const locationText = get('locationid');
    let error = null; let locationId = null;
    const validDecimal = (value) => /^(?:\d+)(?:\.\d{1,3})?$/.test(value);
    if (!sku || sku.length > 64 || !name || name.length > 160 || !unit || unit.length > 24) error = 'SKU, name and unit are required and must fit their field limits.';
    else if (!validDecimal(opening)) error = 'Opening stock must be a non-negative decimal using a dot for decimals.';
    else if (!validDecimal(reorder)) error = 'Reorder level must be a non-negative decimal using a dot for decimals.';
    else if (locationText && !/^[0-9a-f-]{36}$/i.test(locationText)) error = 'Location ID must be a valid GUID.';
    if (!error && locationText) locationId = locationText;
    if (!error && allowed !== null && (!locationId || !allowed.includes(locationId))) error = 'A permitted location ID is required for this user.';
    if (!error && locationId && !knownLocations.has(locationId)) error = 'Location does not belong to this business.';
    let duplicate = false;
    if (!error) { duplicate = seen.has(sku); seen.add(sku); }
    parsed.push({ row: index + 1, sku, name, unit, openingStock: opening, reorderLevel: reorder, locationId, error, duplicate });
  }
  const skuList = parsed.filter((item) => !item.error).map((item) => item.sku);
  const existing = skuList.length ? await pool.query('SELECT upper("Sku") AS "Sku" FROM "Materials" WHERE "BusinessId" = $1 AND upper("Sku") = ANY($2::text[])', [user.businessId, skuList]) : { rows: [] };
  const existingSkus = new Set(existing.rows.map((row) => row.Sku));
  for (const item of parsed) if (!item.error && existingSkus.has(item.sku)) item.duplicate = true;
  return parsed;
}

export async function previewInventoryCsv(pool, user, csv) {
  await requireInventory(pool, user.businessId);
  const parsed = await analyzeCsv(pool, user, csv);
  const items = parsed.map((row) => ({ row: row.row, outcome: row.error ? 'Invalid' : row.duplicate ? 'Duplicate' : 'Create',
    field: row.error ? (row.error.startsWith('Opening stock') ? 'openingStock' : row.error.startsWith('Reorder level') ? 'reorderLevel' : row.error.startsWith('Location') || row.error.startsWith('A permitted') ? 'locationId' : 'sku/name/unit') : null,
    message: row.error ?? (row.duplicate ? 'SKU already exists or repeats in this file.' : null), sku: row.sku || null, name: row.name || null }));
  return { fileHash: hashCsv(csv), totalRows: parsed.length, validRows: items.filter((row) => row.outcome === 'Create').length,
    duplicateRows: items.filter((row) => row.outcome === 'Duplicate').length, invalidRows: items.filter((row) => row.outcome === 'Invalid').length,
    problems: items.filter((row) => row.outcome !== 'Create') };
}

export async function commitInventoryCsv(pool, user, csv, { expectedHash, skipInvalidRows }) {
  await requireInventory(pool, user.businessId);
  const actualHash = hashCsv(csv);
  const expected = Buffer.from(String(expectedHash ?? '').toUpperCase());
  const actual = Buffer.from(actualHash);
  if (!expected.length || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw AppError.conflict('file_changed', 'The CSV differs from the preview. Preview the current file again.');
  const parsed = await analyzeCsv(pool, user, csv);
  if (!skipInvalidRows && parsed.some((row) => row.error)) {
    const rowErrors = parsed.filter((row) => row.error).map((row) => ({
      row: row.row, field: row.error.startsWith('Opening stock') ? 'openingStock' : row.error.startsWith('Reorder level') ? 'reorderLevel' : row.error.startsWith('Location') || row.error.startsWith('A permitted') ? 'locationId' : 'sku/name/unit',
      outcome: 'Invalid', message: row.error, sku: row.sku || null, name: row.name || null,
    }));
    throw AppError.conflict('invalid_rows', 'The file has invalid rows. Fix them or explicitly choose to skip invalid rows.', { rowErrors });
  }
  const resultRows = []; let created = 0; let skipped = 0; let failed = 0;
  try {
    await transaction(pool, async (db) => {
      for (const row of parsed) {
        if (row.error) { failed += 1; resultRows.push({ row: row.row, outcome: 'Invalid', field: row.error.startsWith('Opening stock') ? 'openingStock' : row.error.startsWith('Reorder level') ? 'reorderLevel' : row.error.startsWith('Location') || row.error.startsWith('A permitted') ? 'locationId' : 'sku/name/unit', message: row.error, sku: row.sku || null, name: row.name || null }); continue; }
        if (row.duplicate) { skipped += 1; resultRows.push({ row: row.row, outcome: 'Skipped', field: 'sku', message: 'SKU already exists or repeats in this file.', sku: row.sku, name: row.name }); continue; }
        const id = randomUUID();
        await db.query(`INSERT INTO "Materials" ("Id","BusinessId","LocationId","Sku","Name","Unit","OnHand","Reserved","ReorderLevel","CreatedAtUtc")
          VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,0,$8::numeric,now())`,
        [id, user.businessId, row.locationId, row.sku, row.name.trim(), row.unit.trim(), row.openingStock, row.reorderLevel]);
        if (parseDecimal(row.openingStock).scaled > 0n) await db.query(`INSERT INTO "StockMovements" ("Id","BusinessId","MaterialId","Kind","Quantity","OnHandAfter","ReservedAfter","ActorUserId","Note","CreatedAtUtc")
          VALUES ($1,$2,$3,'Receive',$4::numeric,$4::numeric,0,$5,'CSV opening stock import',now())`, [randomUUID(), user.businessId, id, row.openingStock, user.userId]);
        await audit(db, user, 'inventory.material_imported', 'MaterialStock', id, { sku: row.sku, name: row.name, row: row.row });
        created += 1;
        resultRows.push({ row: row.row, outcome: 'Created', field: null, message: null, sku: row.sku, name: row.name });
      }
    });
  } catch (error) {
    if (error?.code === '23505' || error?.code === '40001') throw AppError.conflict('import_conflict', 'Stock changed during import or a SKU was added concurrently. Preview the file again and retry.');
    throw error;
  }
  return { created, skipped, failed, rows: resultRows };
}

export async function taskMaterialBatch(pool, user, taskId, request, action) {
  await requireInventory(pool, user.businessId);
  const lines = request.materials ?? [];
  if (lines.length < 1 || lines.length > 100 || new Set(lines.map((line) => line.materialId)).size !== lines.length || lines.some((line) => !parseDecimal(line.quantity, { positive: true }))) {
    throw AppError.badRequest('invalid_material_batch', 'Provide 1–100 unique materials with positive quantities.');
  }
  const allowed = await allowedLocations(pool, user);
  const changed = [];
  await transaction(pool, async (db) => {
    const task = await taskAndOrder(db, user, taskId, allowed);
    const orderResult = await db.query('SELECT "Id","LocationId" FROM "Orders" WHERE "BusinessId" = $1 AND "Id" = $2', [user.businessId, task.OrderId]);
    const order = orderResult.rows[0];
    for (const line of lines) {
      const material = await stockRow(db, user.businessId, line.materialId, allowed, true);
      if (material.LocationId && material.LocationId !== order.LocationId) throw AppError.conflict('material_location_mismatch', 'Material and production order must belong to the same location.');
      const qty = parseDecimal(line.quantity, { positive: true });
      const onHand = parseDecimal(material.OnHand).scaled;
      const reserved = parseDecimal(material.Reserved).scaled;
      const heldForTask = await taskReserved(db, user.businessId, line.materialId, taskId);
      let nextOnHand = onHand; let nextReserved = reserved;
      if (action === 'Reserve') {
        if (heldForTask > 0n) throw AppError.conflict('reservation_exists', 'This task already has a reservation for one or more selected materials.');
        if (qty.scaled > onHand - reserved) throw AppError.conflict('insufficient_stock', `Insufficient available stock for ${material.Name}.`);
        nextReserved += qty.scaled;
      } else if (qty.scaled > heldForTask || qty.scaled > reserved) {
        throw AppError.conflict('reservation_exceeded', `Task reservation is insufficient for ${material.Name}.`);
      } else {
        nextReserved -= qty.scaled;
        if (action === 'Consume') nextOnHand -= qty.scaled;
      }
      await db.query('UPDATE "Materials" SET "OnHand" = $1::numeric,"Reserved" = $2::numeric,"UpdatedAtUtc" = now() WHERE "BusinessId" = $3 AND "Id" = $4',
        [formatMilli(nextOnHand), formatMilli(nextReserved), user.businessId, material.Id]);
      await db.query(`INSERT INTO "StockMovements" ("Id","BusinessId","MaterialId","Kind","Quantity","OnHandAfter","ReservedAfter","OrderId","TaskId","ActorUserId","Note","CreatedAtUtc")
        VALUES ($1,$2,$3,$4,$5::numeric,$6::numeric,$7::numeric,$8,$9,$10,$11,now())`,
      [randomUUID(), user.businessId, material.Id, action, qty.text, formatMilli(nextOnHand), formatMilli(nextReserved), order.Id, taskId, user.userId, request.note?.trim() ?? null]);
      await notifyLowStock(db, user, material, onHand - reserved, nextOnHand - nextReserved,
        parseDecimal(String(material.ReorderLevel)).scaled, parseDecimal(String(material.ReorderLevel)).scaled);
      changed.push(material.Id);
    }
    const auditAction = action === 'Reserve' ? 'inventory.task_materials_reserved' : action === 'Release' ? 'inventory.task_materials_released' : 'inventory.task_materials_consumed';
    await audit(db, user, auditAction, 'ProductionTask', taskId, { count: lines.length });
  });
  const results = [];
  for (const id of changed) results.push(materialDto(await stockRow(pool, user.businessId, id, allowed)));
  return results;
}

export async function inventoryHistory(pool, user, materialId, take = 100) {
  await requireInventory(pool, user.businessId);
  const allowed = await allowedLocations(pool, user);
  await stockRow(pool, user.businessId, materialId, allowed);
  const count = Math.min(200, Math.max(1, Number(take) || 100));
  const { rows } = await pool.query(`SELECT "Id","MaterialId","Kind","Quantity","OnHandAfter","ReservedAfter","OrderId","TaskId","Note","CreatedAtUtc"
    FROM "StockMovements" WHERE "BusinessId" = $1 AND "MaterialId" = $2 ORDER BY "CreatedAtUtc" DESC LIMIT $3`,
  [user.businessId, materialId, count]);
  return rows.map((row) => ({ id: row.Id, materialId: row.MaterialId, kind: row.Kind, quantity: Number(row.Quantity),
    onHandAfter: Number(row.OnHandAfter), reservedAfter: Number(row.ReservedAfter), orderId: row.OrderId,
    taskId: row.TaskId, note: row.Note, createdAtUtc: row.CreatedAtUtc }));
}