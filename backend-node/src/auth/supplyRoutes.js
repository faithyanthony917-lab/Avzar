import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';
import { CUSTOMER_LINK_SOURCE } from '../messaging/publicMessagingRoutes.js';
import { isMessagingSuppressed } from '../messaging/suppressions.js';
import { maskPhone } from '../messaging/optOut.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const supplierBody = z.object({ name: z.string().trim().min(1).max(160), contactName: z.string().trim().max(80).nullable().optional(), email: z.string().trim().email().max(254).nullable().optional(), phone: z.string().trim().max(40).nullable().optional(), address: z.string().trim().max(500).nullable().optional(), notes: z.string().max(2000).nullable().optional(), isActive: z.boolean().default(true) });
const poBody = z.object({ supplierId: z.string().uuid(), locationId: z.string().uuid(), orderNumber: z.string().trim().min(1).max(40), currency: z.string().regex(/^[A-Z]{3}$/).default('NGN'), expectedAtUtc: z.string().datetime().nullable().optional(), expenseCategoryId: z.string().uuid().nullable().optional(), notes: z.string().max(2000).nullable().optional(), items: z.array(z.object({ description: z.string().trim().min(1).max(240), sku: z.string().trim().max(80).nullable().optional(), quantityOrdered: z.number().positive().max(1000000).refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7, 'Use at most 3 decimal places.'), unitCost: z.number().min(0).max(100000000000).multipleOf(0.01), stockItemId: z.string().uuid().nullable().optional() })).min(1).max(200) });
const receiveBody = z.object({ idempotencyKey: z.string().trim().min(8).max(80), items: z.array(z.object({ itemId: z.string().uuid(), quantity: z.number().positive().max(1000000).refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7, 'Use at most 3 decimal places.') })).min(1).max(200) });
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) throw new AppError(400, 'validation_failed', 'One or more fields are invalid.', { errors: Object.fromEntries(result.error.issues.map((x) => [x.path.join('.') || 'body', [x.message]])) }); return result.data; }
async function tx(pool, businessId, fn) { const c = await pool.connect(); try { await c.query('BEGIN'); await c.query("SELECT set_config('app.business_id', $1, true)", [businessId]); const v = await fn(c); await c.query('COMMIT'); return v; } catch (e) { await c.query('ROLLBACK').catch(() => {}); if (e.code === '23505') throw AppError.conflict('duplicate_record', 'A record with that identifier already exists.'); if (e.code === '23503') throw AppError.badRequest('invalid_reference', 'A referenced record does not exist in this business.'); throw e; } finally { c.release(); } }
async function tenantQuery(pool, businessId, sql, params = []) { const c = await pool.connect(); try { await c.query('BEGIN'); await c.query("SELECT set_config('app.business_id', $1, true)", [businessId]); const result = await c.query(sql, params); await c.query('COMMIT'); return result; } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); } }
async function locations(db, user) { if (user.isOwner || user.permissions.includes('locations.all')) return null; const { rows } = await db.query('SELECT DISTINCT ml."LocationId" FROM "Memberships" m JOIN "MembershipLocations" ml ON ml."MembershipId"=m."Id" AND ml."BusinessId"=m."BusinessId" WHERE m."BusinessId"=$1 AND m."UserId"=$2 AND m."Status"=0', [user.businessId, user.userId]); return rows.map(x => x.LocationId); }
export function createSupplyRouter({ env, pool }) {
  const router = Router();
  const view = [requireBearerAuth(env, pool), requirePermission('inventory.view')];
  const manage = [requireBearerAuth(env, pool), requirePermission('inventory.manage')];
  const customerView = [requireBearerAuth(env, pool), requirePermission('customers.view')];
  const customerManage = [requireBearerAuth(env, pool), requirePermission('customers.manage')];
  const consentBody = z.object({ address: z.string().trim().min(3).max(254), consent: z.enum(['OptedIn','OptedOut']), source: z.string().trim().max(40).optional(), note: z.string().trim().max(500).optional() });
  router.get('/customers/:customerId/messaging-preferences', ...customerView, async (req, res) => {
    if (!UUID.test(req.params.customerId)) throw AppError.badRequest('invalid_customer_id', 'Customer ID is invalid.');
    const { rows: customer } = await tenantQuery(pool, req.currentUser.businessId, 'SELECT 1 FROM "Customers" WHERE "Id"=$1 AND "BusinessId"=$2', [req.params.customerId, req.currentUser.businessId]);
    if (!customer.length) throw AppError.notFound('customer_not_found', 'Customer not found.');
    const { rows } = await tenantQuery(pool, req.currentUser.businessId, 'SELECT p."Id",p."Channel",p."Address",p."ConsentStatus",p."ConsentSource",p."ConsentNote",p."ConsentedAtUtc",p."OptedOutAtUtc",p."UpdatedAtUtc",((p."ConsentStatus"=\'OptedOut\' AND p."ConsentSource"=$3) OR EXISTS (SELECT 1 FROM "MessagingSuppressions" s WHERE s."Channel"=p."Channel" AND lower(s."Address")=lower(p."Address") AND s."LiftedAtUtc" IS NULL)) AS "CustomerOptedOut" FROM "CustomerMessagingPreferences" p WHERE p."BusinessId"=$1 AND p."CustomerId"=$2 ORDER BY p."Channel",p."Address"', [req.currentUser.businessId, req.params.customerId, CUSTOMER_LINK_SOURCE]);
    res.json(rows);
  });
  // Step 16b: the last 50 order and payment messages queued for this customer, so staff can see what was sent, what is waiting and what failed.
  router.get('/customers/:customerId/messages', ...customerView, async (req, res) => {
    if (!UUID.test(req.params.customerId)) throw AppError.badRequest('invalid_customer_id', 'Customer ID is invalid.');
    const businessId = req.currentUser.businessId;
    const { rows: customer } = await tenantQuery(pool, businessId, 'SELECT 1 FROM "Customers" WHERE "Id"=$1 AND "BusinessId"=$2', [req.params.customerId, businessId]);
    if (!customer.length) throw AppError.notFound('customer_not_found', 'Customer not found.');
    const { rows } = await tenantQuery(pool, businessId, `SELECT "Id","Kind","Channel","Address","Status","LastError","CreatedAtUtc","SentAtUtc"
      FROM "CustomerEventOutbox" WHERE "BusinessId"=$1 AND "CustomerId"=$2 ORDER BY "CreatedAtUtc" DESC,"Id" DESC LIMIT 50`, [businessId, req.params.customerId]);
    res.json(rows.map((row) => ({
      id: row.Id, kind: row.Kind, channel: row.Channel, address: maskPhone(row.Address), status: row.Status,
      error: row.Status === 'Failed' ? row.LastError : null, createdAtUtc: row.CreatedAtUtc, sentAtUtc: row.SentAtUtc,
    })));
  });
  router.put('/customers/:customerId/messaging-preferences/:channel', ...customerManage, async (req, res) => {
    if (!UUID.test(req.params.customerId)) throw AppError.badRequest('invalid_customer_id', 'Customer ID is invalid.');
    if (!['WhatsApp','SMS'].includes(req.params.channel)) throw AppError.badRequest('invalid_messaging_channel', 'Channel must be WhatsApp or SMS.');
    const x = parse(consentBody, req.body); const businessId = req.currentUser.businessId;
    const compactAddress = x.address.replace(/[\s()-]/g, '');
    if (!/^\+?[1-9]\d{7,14}$/.test(compactAddress)) throw AppError.badRequest('invalid_messaging_address', 'Use an international phone number, for example +2348012345678.');
    const normalizedAddress = compactAddress.startsWith('+') ? compactAddress : `+${compactAddress}`;
    if ((x.source ?? '').toLowerCase() === CUSTOMER_LINK_SOURCE) throw AppError.badRequest('reserved_consent_source', 'That source is reserved for customers opting out themselves.');
    // Decision 2: staff may record OptedIn only with a note saying how the customer agreed. Staff records always carry the source staff_note.
    const note = x.note ?? '';
    if (x.consent === 'OptedIn' && note.length < 5) throw AppError.badRequest('consent_note_required', 'Write a note of at least 5 characters saying how and when the customer agreed.');
    const result = await tx(pool, businessId, async db => {
      const customer = await db.query('SELECT 1 FROM "Customers" WHERE "Id"=$1 AND "BusinessId"=$2 FOR SHARE', [req.params.customerId,businessId]);
      if (!customer.rowCount) throw AppError.notFound('customer_not_found','Customer not found.');
      if (x.consent === 'OptedIn') {
        // A customer's own opt-out (unsubscribe link, or a STOP reply to the shared sender) cannot be undone by staff.
        const own = await db.query('SELECT 1 FROM "CustomerMessagingPreferences" WHERE "BusinessId"=$1 AND "CustomerId"=$2 AND "Channel"=$3 AND lower("Address")=lower($4) AND "ConsentStatus"=\'OptedOut\' AND "ConsentSource"=$5', [businessId,req.params.customerId,req.params.channel,normalizedAddress,CUSTOMER_LINK_SOURCE]);
        if (own.rowCount || await isMessagingSuppressed(db, { channel: req.params.channel, address: normalizedAddress })) throw AppError.conflict('customer_opted_out', 'This customer opted out of messages themselves. Only the customer can opt back in.');
      }
      const { rows } = await db.query(`INSERT INTO "CustomerMessagingPreferences" ("Id","BusinessId","CustomerId","Channel","Address","ConsentStatus","ConsentSource","ConsentedAtUtc","OptedOutAtUtc","ConsentNote","ConsentRecordedByUserId","UpdatedAtUtc") VALUES ($1,$2,$3,$4,$5,$6::text,$7,CASE WHEN $6::text='OptedIn' THEN now() ELSE NULL END,CASE WHEN $6::text='OptedOut' THEN now() ELSE NULL END,$8,$9,now()) ON CONFLICT ("BusinessId","CustomerId","Channel","Address") DO UPDATE SET "ConsentStatus"=EXCLUDED."ConsentStatus","ConsentSource"=CASE WHEN "CustomerMessagingPreferences"."ConsentSource"=$10 AND EXCLUDED."ConsentStatus"='OptedOut' THEN "CustomerMessagingPreferences"."ConsentSource" ELSE EXCLUDED."ConsentSource" END,"ConsentNote"=EXCLUDED."ConsentNote","ConsentRecordedByUserId"=EXCLUDED."ConsentRecordedByUserId","ConsentedAtUtc"=CASE WHEN EXCLUDED."ConsentStatus"='OptedIn' THEN now() ELSE NULL END,"OptedOutAtUtc"=CASE WHEN EXCLUDED."ConsentStatus"='OptedOut' THEN now() ELSE NULL END,"UpdatedAtUtc"=now() RETURNING "Id","Channel","Address","ConsentStatus","ConsentSource","ConsentNote","ConsentedAtUtc","OptedOutAtUtc","UpdatedAtUtc"`, [randomUUID(),businessId,req.params.customerId,req.params.channel,normalizedAddress,x.consent,'staff_note',note || null,req.currentUser.userId,CUSTOMER_LINK_SOURCE]);
      // Step-14b: one audit entry per recorded change, in the same transaction. Only the last 4 digits of the number are written, never the note.
      await db.query('INSERT INTO "AuditLogs" ("Id","Action","ActorUserId","BusinessId","CreatedAtUtc","DetailsJson","EntityId","EntityType") VALUES ($1,\'customer_messaging.consent_changed\',$2,$3,now(),$4::jsonb,$5,\'Customer\')', [randomUUID(), req.currentUser.userId, businessId, JSON.stringify({ channel: req.params.channel, consent: x.consent, source: 'staff_note', addressLast4: normalizedAddress.slice(-4) }), req.params.customerId]);
      return rows[0];
    }); res.json(result);
  });

  router.get('/suppliers', ...view, async (req, res) => {
    const { rows } = await tenantQuery(pool, req.currentUser.businessId, 'SELECT "Id","Name","ContactName","Email","Phone","Address","Notes","IsActive","CreatedAtUtc","UpdatedAtUtc" FROM "Suppliers" WHERE "BusinessId"=$1 ORDER BY lower("Name")', [req.currentUser.businessId]);
    res.json(rows);
  });
  router.post('/suppliers', ...manage, async (req, res) => {
    const x = parse(supplierBody, req.body); const id = randomUUID();
    const { rows } = await tenantQuery(pool, req.currentUser.businessId, 'INSERT INTO "Suppliers" ("Id","BusinessId","Name","ContactName","Email","Phone","Address","Notes","IsActive") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [id, req.currentUser.businessId, x.name, x.contactName ?? null, x.email ?? null, x.phone ?? null, x.address ?? null, x.notes ?? null, x.isActive]);
    res.status(201).json(rows[0]);
  });
  router.patch('/suppliers/:id', ...manage, async (req, res) => {
    if (!UUID.test(req.params.id)) throw AppError.badRequest('invalid_supplier_id', 'Supplier ID is invalid.');
    const x = parse(supplierBody.partial(), req.body); if (!Object.keys(x).length) throw AppError.badRequest('empty_update', 'Provide at least one field.');
    const columns = { name:'Name', contactName:'ContactName', email:'Email', phone:'Phone', address:'Address', notes:'Notes', isActive:'IsActive' };
    const sets = []; const values = [req.params.id, req.currentUser.businessId];
    for (const [key, value] of Object.entries(x)) { values.push(value); sets.push(`"${columns[key]}"=$${values.length}`); }
    sets.push('"UpdatedAtUtc"=now()');
    const { rows } = await tenantQuery(pool, req.currentUser.businessId, `UPDATE "Suppliers" SET ${sets.join(',')} WHERE "Id"=$1 AND "BusinessId"=$2 RETURNING *`, values);
    if (!rows.length) throw AppError.notFound('supplier_not_found', 'Supplier not found.'); res.json(rows[0]);
  });
  router.get('/purchase-orders', ...view, async (req, res) => {
    const allowed = await locations(pool, req.currentUser);
    const { rows } = await tenantQuery(pool, req.currentUser.businessId, `SELECT p.*,s."Name" AS "SupplierName",l."Name" AS "LocationName" FROM "PurchaseOrders" p JOIN "Suppliers" s ON s."Id"=p."SupplierId" AND s."BusinessId"=p."BusinessId" JOIN "Locations" l ON l."Id"=p."LocationId" AND l."BusinessId"=p."BusinessId" WHERE p."BusinessId"=$1 AND ($2::uuid[] IS NULL OR p."LocationId"=ANY($2::uuid[])) ORDER BY p."CreatedAtUtc" DESC LIMIT 500`, [req.currentUser.businessId, allowed]); res.json(rows);
  });
  router.get('/purchase-orders/:id', ...view, async (req, res) => {
    if (!UUID.test(req.params.id)) throw AppError.badRequest('invalid_purchase_order_id', 'Purchase order ID is invalid.');
    const allowed = await locations(pool, req.currentUser);
    const { rows } = await tenantQuery(pool, req.currentUser.businessId, `SELECT p.*,s."Name" AS "SupplierName",l."Name" AS "LocationName" FROM "PurchaseOrders" p JOIN "Suppliers" s ON s."Id"=p."SupplierId" AND s."BusinessId"=p."BusinessId" JOIN "Locations" l ON l."Id"=p."LocationId" AND l."BusinessId"=p."BusinessId" WHERE p."Id"=$1 AND p."BusinessId"=$2 AND ($3::uuid[] IS NULL OR p."LocationId"=ANY($3::uuid[]))`, [req.params.id, req.currentUser.businessId, allowed]);
    if (!rows.length) throw AppError.notFound('purchase_order_not_found', 'Purchase order not found.');
    const items = await tenantQuery(pool, req.currentUser.businessId, 'SELECT * FROM "PurchaseOrderItems" WHERE "BusinessId"=$1 AND "PurchaseOrderId"=$2 ORDER BY "CreatedAtUtc"', [req.currentUser.businessId, req.params.id]); res.json({ ...rows[0], items: items.rows });
  });
  router.post('/purchase-orders', ...manage, async (req, res) => {
    const x = parse(poBody, req.body); const user = req.currentUser; const id = randomUUID();
    const allowed = await locations(pool, user); if (allowed !== null && !allowed.includes(x.locationId)) throw AppError.forbidden('location_forbidden', 'The location is outside your permitted locations.');
    const subtotal = x.items.reduce((sum, item) => sum + Math.round(item.quantityOrdered * item.unitCost * 100) / 100, 0);
    if (!Number.isFinite(subtotal) || subtotal > 999999999999.99) throw AppError.badRequest('subtotal_out_of_range', 'Purchase order total is too large.');
    const result = await tx(pool, req.currentUser.businessId, async db => {
      const supplier = await db.query('SELECT 1 FROM "Suppliers" WHERE "Id"=$1 AND "BusinessId"=$2 AND "IsActive" FOR SHARE', [x.supplierId, user.businessId]); if (!supplier.rowCount) throw AppError.badRequest('invalid_supplier', 'Choose an active supplier in this business.');
      const loc = await db.query('SELECT 1 FROM "Locations" WHERE "Id"=$1 AND "BusinessId"=$2 AND "IsActive" FOR SHARE', [x.locationId, user.businessId]); if (!loc.rowCount) throw AppError.badRequest('invalid_location', 'Choose an active location in this business.');
      if (x.expenseCategoryId) {
        if (!user.isOwner && !user.permissions.includes('expenses.manage')) throw AppError.forbidden('expense_permission_required', 'Managing expenses is required to link a purchase order to an expense category.');
        const category = await db.query('SELECT 1 FROM "ExpenseCategories" WHERE "Id"=$1 AND "BusinessId"=$2 AND "IsActive"=TRUE FOR SHARE', [x.expenseCategoryId,user.businessId]);
        if (!category.rowCount) throw AppError.badRequest('invalid_expense_category', 'Choose an active expense category in this business.');
      }
      const po = await db.query(`INSERT INTO "PurchaseOrders" ("Id","BusinessId","SupplierId","LocationId","OrderNumber","Status","OrderedAtUtc","ExpectedAtUtc","Currency","Subtotal","Notes","CreatedByUserId","ExpenseCategoryId") VALUES ($1,$2,$3,$4,$5,'Draft',NULL,$6,$7,$8,$9,$10,$11) RETURNING *`, [id,user.businessId,x.supplierId,x.locationId,x.orderNumber,x.expectedAtUtc ?? null,x.currency,subtotal.toFixed(2),x.notes ?? null,user.userId,x.expenseCategoryId ?? null]);
      for (const item of x.items) {
        if (item.stockItemId) { const stock = await db.query('SELECT 1 FROM "Materials" WHERE "Id"=$1 AND "BusinessId"=$2 FOR SHARE', [item.stockItemId,user.businessId]); if (!stock.rowCount) throw AppError.badRequest('invalid_stock_item','A stock item is not in this business.'); }
        await db.query(`INSERT INTO "PurchaseOrderItems" ("Id","BusinessId","PurchaseOrderId","Description","Sku","QuantityOrdered","UnitCost","StockItemId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(),user.businessId,id,item.description,item.sku ?? null,item.quantityOrdered,item.unitCost,item.stockItemId ?? null]);
      }
      return po.rows[0];
    }); res.status(201).json(result);
  });
  router.post('/purchase-orders/:id/order', ...manage, async (req, res) => {
    if (!UUID.test(req.params.id)) throw AppError.badRequest('invalid_purchase_order_id', 'Purchase order ID is invalid.');
    const result = await tx(pool, req.currentUser.businessId, async db => {
      const { rows: current } = await db.query('SELECT * FROM "PurchaseOrders" WHERE "Id"=$1 AND "BusinessId"=$2 FOR UPDATE', [req.params.id,req.currentUser.businessId]);
      if (!current.length) throw AppError.notFound('purchase_order_not_found', 'Purchase order not found.');
      const allowed = await locations(db, req.currentUser);
      if (allowed !== null && !allowed.includes(current[0].LocationId)) throw AppError.notFound('purchase_order_not_found', 'Purchase order not found.');
      if (current[0].Status !== 'Draft') throw AppError.conflict('purchase_order_state_conflict', 'Only a draft purchase order can be ordered.');
      const { rows } = await db.query(`UPDATE "PurchaseOrders" SET "Status"='Ordered',"OrderedAtUtc"=COALESCE("OrderedAtUtc",now()),"UpdatedAtUtc"=now() WHERE "Id"=$1 AND "BusinessId"=$2 RETURNING *`, [req.params.id,req.currentUser.businessId]);
      return rows[0];
    }); res.json(result);
  });
  router.post('/purchase-orders/:id/cancel', ...manage, async (req, res) => {
    if (!UUID.test(req.params.id)) throw AppError.badRequest('invalid_purchase_order_id', 'Purchase order ID is invalid.');
    const result = await tx(pool, req.currentUser.businessId, async db => {
      const { rows } = await db.query('SELECT * FROM "PurchaseOrders" WHERE "Id"=$1 AND "BusinessId"=$2 FOR UPDATE', [req.params.id,req.currentUser.businessId]);
      const po = rows[0]; if (!po) throw AppError.notFound('purchase_order_not_found','Purchase order not found.');
      const allowed = await locations(db,req.currentUser);
      if (allowed !== null && !allowed.includes(po.LocationId)) throw AppError.notFound('purchase_order_not_found','Purchase order not found.');
      if (!['Draft','Ordered'].includes(po.Status)) throw AppError.conflict('purchase_order_state_conflict','Only draft or ordered purchase orders with no receipts can be cancelled.');
      const received = await db.query('SELECT 1 FROM "PurchaseOrderItems" WHERE "BusinessId"=$1 AND "PurchaseOrderId"=$2 AND "QuantityReceived">0 LIMIT 1', [req.currentUser.businessId,po.Id]);
      if (received.rowCount) throw AppError.conflict('purchase_order_already_received','A purchase order with received stock cannot be cancelled.');
      const updated = await db.query('UPDATE "PurchaseOrders" SET "Status"=\'Cancelled\',"UpdatedAtUtc"=now() WHERE "Id"=$1 AND "BusinessId"=$2 RETURNING *', [po.Id,req.currentUser.businessId]);
      return updated.rows[0];
    }); res.json(result);
  });

  router.post('/purchase-orders/:id/receive', ...manage, async (req, res) => {
    if (!UUID.test(req.params.id)) throw AppError.badRequest('invalid_purchase_order_id', 'Purchase order ID is invalid.'); const x = parse(receiveBody, req.body); const user = req.currentUser;
    const received = await tx(pool, user.businessId, async db => {
      const { rows: orders } = await db.query('SELECT * FROM "PurchaseOrders" WHERE "Id"=$1 AND "BusinessId"=$2 FOR UPDATE', [req.params.id,user.businessId]); const po = orders[0]; if (!po) throw AppError.notFound('purchase_order_not_found','Purchase order not found.');
      if (!['Ordered','PartiallyReceived'].includes(po.Status)) throw AppError.conflict('purchase_order_state_conflict','Only ordered or partially received orders can be received.');
      const allowed = await locations(db,user); if (allowed !== null && !allowed.includes(po.LocationId)) throw AppError.forbidden('location_forbidden','The purchase order location is outside your permitted locations.');
      const prior = await db.query(`SELECT "ReferenceId" FROM "StockMovements" WHERE "BusinessId"=$1 AND "IdempotencyKey"=$2 LIMIT 1`, [user.businessId,x.idempotencyKey]);
      if (prior.rowCount) {
        if (prior.rows[0].ReferenceId !== po.Id) throw AppError.conflict('idempotency_key_reused', 'This idempotency key was already used for another purchase order.');
        return { duplicate: true, purchaseOrderId: po.Id };
      }
      const { rows: items } = await db.query('SELECT * FROM "PurchaseOrderItems" WHERE "BusinessId"=$1 AND "PurchaseOrderId"=$2 FOR UPDATE', [user.businessId,po.Id]);
      const seen = new Set();
      for (const rec of x.items) {
        if (seen.has(rec.itemId)) throw AppError.badRequest('duplicate_item','Each purchase order item may appear once per receipt.'); seen.add(rec.itemId);
        const item = items.find(i => i.Id === rec.itemId); if (!item) throw AppError.badRequest('invalid_purchase_order_item','An item does not belong to this purchase order.');
        if (!item.StockItemId) throw AppError.badRequest('stock_item_required','Link each received item to an inventory material before receiving stock.');
        const remaining = Number(item.QuantityOrdered) - Number(item.QuantityReceived); if (rec.quantity > remaining + 0.0000001) throw AppError.conflict('quantity_exceeds_remaining','Received quantity exceeds the remaining ordered quantity.');
        const stock = await db.query('SELECT "OnHand","Reserved" FROM "Materials" WHERE "Id"=$1 AND "BusinessId"=$2 AND ("LocationId" IS NULL OR "LocationId"=$3) FOR UPDATE', [item.StockItemId,user.businessId,po.LocationId]); if (!stock.rowCount) throw AppError.badRequest('stock_location_mismatch','The linked material must be available at the purchase order location or have no assigned location.');
        await db.query('UPDATE "Materials" SET "OnHand"="OnHand"+$1::numeric,"UpdatedAtUtc"=now() WHERE "Id"=$2 AND "BusinessId"=$3', [rec.quantity,item.StockItemId,user.businessId]);
        const onHandAfter = Number(stock.rows[0].OnHand) + rec.quantity;
        const reservedAfter = Number(stock.rows[0].Reserved);
        await db.query(`INSERT INTO "StockMovements" ("Id","BusinessId","MaterialId","Kind","Quantity","OnHandAfter","ReservedAfter","ActorUserId","Note","LocationId","MovementType","QuantityDelta","UnitCost","ReferenceType","ReferenceId","IdempotencyKey","Reason","CreatedByUserId") VALUES ($1,$2,$3,'Receive',$5::numeric,$6::numeric,$7::numeric,$8,$9,$4,'Receipt',$5::numeric,$10,'PurchaseOrder',$11,$12,$9,$8)`, [randomUUID(),user.businessId,item.StockItemId,po.LocationId,rec.quantity,onHandAfter,reservedAfter,user.userId,`Receipt for ${po.OrderNumber}`,item.UnitCost,po.Id,(rec === x.items[0] ? x.idempotencyKey : `${x.idempotencyKey}:${rec.itemId}`)]);
        await db.query('UPDATE "PurchaseOrderItems" SET "QuantityReceived"="QuantityReceived"+$1 WHERE "Id"=$2 AND "BusinessId"=$3', [rec.quantity,item.Id,user.businessId]);
      }
      if (po.ExpenseCategoryId) {
        const receiptTotal = x.items.reduce((sum, rec) => {
          const item = items.find((candidate) => candidate.Id === rec.itemId);
          return sum + Math.round(rec.quantity * Number(item.UnitCost) * 100) / 100;
        }, 0);
        if (receiptTotal > 0) {
          const supplier = await db.query('SELECT "Name" FROM "Suppliers" WHERE "Id"=$1 AND "BusinessId"=$2', [po.SupplierId,user.businessId]);
          const expenseReference = `PO:${po.OrderNumber}:${x.idempotencyKey}`.slice(0, 100);
          await db.query(`INSERT INTO "Expenses" ("Id","Amount","BusinessId","CategoryId","CreatedAtUtc","CreatedByUserId","CurrencyCode","Description","ExpenseDate","LocationId","Reference","Vendor") VALUES ($1,$2,$3,$4,now(),$5,$6,$7,current_date,$8,$9,$10)`, [randomUUID(),receiptTotal.toFixed(2),user.businessId,po.ExpenseCategoryId,user.userId,po.Currency,`Purchase order receipt ${po.OrderNumber}`.slice(0,300),po.LocationId,expenseReference,supplier.rows[0]?.Name ?? null]);
        }
      }
      const { rows: remaining } = await db.query('SELECT count(*)::int AS n FROM "PurchaseOrderItems" WHERE "BusinessId"=$1 AND "PurchaseOrderId"=$2 AND "QuantityReceived" < "QuantityOrdered"', [user.businessId,po.Id]);
      const status = Number(remaining[0].n) === 0 ? 'Received' : 'PartiallyReceived';
      const { rows: updated } = await db.query('UPDATE "PurchaseOrders" SET "Status"=$1,"ReceivedAtUtc"=CASE WHEN $1=\'Received\' THEN now() ELSE "ReceivedAtUtc" END,"UpdatedAtUtc"=now() WHERE "Id"=$2 AND "BusinessId"=$3 RETURNING *', [status,po.Id,user.businessId]);
      return { duplicate:false, purchaseOrder:updated[0] };
    }); res.status(received.duplicate ? 200 : 201).json(received);
  });
  return router;
}
