import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { adoptTenant, setTenantLookup } from '../db/tenantRlsContext.js';
import { bindTenantByLookup } from '../db/tenantLookup.js';
import { withFreshTenantContext } from '../db/forEachBusiness.js';
import { withTransaction } from './accountService.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const moneyMinor = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(Math.round(amount * 100))) return null;
  return Math.round(amount * 100);
};

async function checkoutEnabled(db) {
  const { rows } = await db.query('SELECT "Enabled" FROM "PlatformFeatureFlags" WHERE "Key"=$1', ['ready_to_wear_checkout']);
  if (!rows.length || rows[0].Enabled !== true) throw AppError.forbidden('checkout_disabled', 'Ready-to-wear checkout is not currently available.');
}

async function publishedStorefront(db, slug) {
  // The public slug names the storefront; the row found by it names the business for everything this checkout reads and writes.
  // Inside the checkout transaction the business is already bound from the earlier call, so the key is not needed there.
  setTenantLookup('storefront_slug', slug);
  const { rows } = await db.query(`SELECT s."Id",s."BusinessId",s."TemplateKey",b."Name" AS "BusinessName"
    FROM "Storefronts" s JOIN "Businesses" b ON b."Id"=s."BusinessId"
    WHERE s."Slug"=$1 AND s."Status"='Published' AND s."PublishedVersionId" IS NOT NULL`, [slug]);
  if (!rows.length) throw AppError.notFound('storefront_not_found', 'Storefront not found.');
  adoptTenant(rows[0].BusinessId);
  return rows[0];
}

export async function listReadyToWearProducts(pool, slug) {
  await checkoutEnabled(pool);
  const site = await publishedStorefront(pool, slug);
  const { rows } = await pool.query(`SELECT d."Id" AS "DesignId",d."Name",d."Slug",d."Description",d."BasePrice",d."CurrencyCode",
      v."Id" AS "VariantId",v."SKU",v."Size",v."Colour",(v."OnHand"-v."Reserved") AS "Available"
    FROM "Designs" d JOIN "ReadyToWearVariants" v ON v."BusinessId"=d."BusinessId" AND v."DesignId"=d."Id"
    WHERE d."BusinessId"=$1 AND d."Status"='Active' AND d."Visibility"='Public' AND d."Kind"='ReadyMade' AND v."IsActive"=TRUE
    ORDER BY d."Name",v."Size",v."Colour",v."SKU"`, [site.BusinessId]);
  return { storefront: { slug, name: site.BusinessName }, items: rows.map((r) => ({
    designId: r.DesignId, name: r.Name, slug: r.Slug, description: r.Description,
    price: r.BasePrice == null ? null : Number(r.BasePrice), currencyCode: r.CurrencyCode,
    variantId: r.VariantId, sku: r.SKU, size: r.Size, colour: r.Colour, available: Number(r.Available),
  })) };
}

export async function listBusinessReadyToWearVariants(pool, user) {
  const { rows } = await pool.query(`SELECT v."Id",v."DesignId",d."Name" AS "ProductName",v."SKU",v."Size",v."Colour",
    v."OnHand",v."Reserved",(v."OnHand"-v."Reserved") AS "Available",v."IsActive",d."BasePrice",d."CurrencyCode"
    FROM "ReadyToWearVariants" v JOIN "Designs" d ON d."BusinessId"=v."BusinessId" AND d."Id"=v."DesignId"
    WHERE v."BusinessId"=$1 ORDER BY d."Name",v."SKU"`, [user.businessId]);
  return rows.map((r) => ({ id:r.Id, designId:r.DesignId, productName:r.ProductName, sku:r.SKU, size:r.Size, colour:r.Colour,
    onHand:Number(r.OnHand), reserved:Number(r.Reserved), available:Number(r.Available), isActive:r.IsActive,
    price:r.BasePrice == null ? null : Number(r.BasePrice), currencyCode:r.CurrencyCode }));
}

export async function upsertReadyToWearVariant(pool, user, input) {
  return withTransaction(pool, async (db) => {
    const { rows: designs } = await db.query(`SELECT "Id" FROM "Designs" WHERE "BusinessId"=$1 AND "Id"=$2 AND "Kind"='ReadyMade' FOR UPDATE`, [user.businessId, input.designId]);
    if (!designs.length) throw AppError.notFound('ready_to_wear_product_not_found', 'Ready-to-wear product not found.');
    if (input.id) {
      const { rows } = await db.query(`UPDATE "ReadyToWearVariants" SET "SKU"=$3,"Size"=$4,"Colour"=$5,"OnHand"=$6,
        "IsActive"=$8,"UpdatedAtUtc"=now() WHERE "BusinessId"=$1 AND "Id"=$2 AND "DesignId"=$3 AND "Reserved" <= $7 RETURNING "Id"`,
      [user.businessId,input.id,input.designId,input.sku,input.size ?? null,input.colour ?? null,input.onHand,input.isActive]);
      if (!rows.length) throw AppError.conflict('stock_below_reserved', 'Stock cannot be reduced below the quantity already reserved, or the variant was not found.');
      return { id: rows[0].Id };
    }
    const id = randomUUID();
    await db.query(`INSERT INTO "ReadyToWearVariants" ("Id","BusinessId","DesignId","SKU","Size","Colour","OnHand","Reserved","IsActive")
      VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8)`, [id,user.businessId,input.designId,input.sku,input.size ?? null,input.colour ?? null,input.onHand,input.isActive]);
    return { id };
  });
}

async function releaseExpiredReadyToWearOrder(pool, orderId, businessId) {
  return withTransaction(pool, async (db) => {
    const { rows } = await db.query(`SELECT "Id","BusinessId","Status","ExpiresAtUtc" FROM "ReadyToWearOrders"
      WHERE "Id"=$1 AND "BusinessId"=$2 FOR UPDATE`, [orderId,businessId]);
    const order = rows[0];
    if (!order || order.Status !== 'PendingPayment' || new Date(order.ExpiresAtUtc) > new Date()) return false;
    const { rows: reservations } = await db.query(`SELECT "VariantId","Quantity" FROM "ReadyToWearReservations"
      WHERE "BusinessId"=$1 AND "OrderId"=$2 AND "Status"='Reserved' ORDER BY "VariantId" FOR UPDATE`, [businessId,orderId]);
    for (const reservation of reservations) {
      const { rowCount } = await db.query(`UPDATE "ReadyToWearVariants" SET "Reserved"="Reserved"-$3,"UpdatedAtUtc"=now()
        WHERE "BusinessId"=$1 AND "Id"=$2 AND "Reserved">=$3`, [businessId,reservation.VariantId,reservation.Quantity]);
      if (rowCount !== 1) throw AppError.conflict('reservation_stock_mismatch', 'The reserved stock could not be reconciled.');
    }
    await db.query(`UPDATE "ReadyToWearReservations" SET "Status"='Released',"UpdatedAtUtc"=now()
      WHERE "BusinessId"=$1 AND "OrderId"=$2 AND "Status"='Reserved'`, [businessId,orderId]);
    await db.query(`UPDATE "ReadyToWearOrders" SET "Status"='Expired',"UpdatedAtUtc"=now()
      WHERE "Id"=$1 AND "BusinessId"=$2 AND "Status"='PendingPayment'`, [orderId,businessId]);
    return true;
  });
}

async function cleanupTerminalExpiredCheckouts(pool, provider, businessId) {
  const { rows } = await pool.query(`SELECT "Id","PaymentReference" FROM "ReadyToWearOrders"
    WHERE "BusinessId"=$1 AND "Status"='PendingPayment' AND "ExpiresAtUtc"<=now()
    ORDER BY "ExpiresAtUtc" LIMIT 50`, [businessId]);
  for (const order of rows) {
    try {
      const result = await provider.verify(order.PaymentReference);
      // Do not release stock while the provider still reports a pending transaction; a late successful
      // payment must still be fulfilable from its reservation.
      if (['failed','abandoned'].includes(String(result.status).toLowerCase())) {
        await releaseExpiredReadyToWearOrder(pool, order.Id, businessId);
      }
    } catch {
      // A provider outage must never free stock that may already have been paid for.
    }
  }
}

export async function createReadyToWearCheckout(pool, provider, env, slug, request, idempotencyKey) {
  if (!provider?.isConfigured?.()) throw new AppError(503, 'checkout_unavailable', 'Online checkout is not configured.');
  if (!idempotencyKey || idempotencyKey.length > 120) throw AppError.badRequest('idempotency_key_required', 'A valid Idempotency-Key header is required.');
  const payloadHash = sha256(JSON.stringify({ ...request, items: [...request.items].sort((a,b) => a.variantId.localeCompare(b.variantId)) }));
  await checkoutEnabled(pool);
  const cleanupSite = await publishedStorefront(pool, slug);
  await cleanupTerminalExpiredCheckouts(pool, provider, cleanupSite.BusinessId);
  const created = await withTransaction(pool, async (db) => {
    await checkoutEnabled(db);
    const site = await publishedStorefront(db, slug);
    const { rows: prior } = await db.query(`SELECT "Id","BusinessId","AmountMinor","CurrencyCode","PaymentReference","AuthorizationUrl","Status","RequestHash","ExpiresAtUtc" FROM "ReadyToWearOrders"
      WHERE "BusinessId"=$1 AND "IdempotencyKey"=$2 FOR UPDATE`, [site.BusinessId,idempotencyKey]);
    if (prior.length) {
      if (prior[0].RequestHash !== payloadHash) throw AppError.conflict('idempotency_key_reused', 'This idempotency key was already used for a different checkout.');
      if (prior[0].Status === 'PendingPayment' && new Date(prior[0].ExpiresAtUtc) <= new Date()) {
        await db.query(`UPDATE "ReadyToWearOrders" SET "ExpiresAtUtc"=now()+interval '30 minutes',"UpdatedAtUtc"=now() WHERE "Id"=$1 AND "Status"='PendingPayment'`, [prior[0].Id]);
      }
      return { existing: true, order: prior[0] };
    }
    const items = [];
    for (const line of [...request.items].sort((a,b) => a.variantId.localeCompare(b.variantId))) {
      const { rows } = await db.query(`SELECT v."Id",v."DesignId",v."SKU",v."Size",v."Colour",v."OnHand",v."Reserved",v."IsActive",
          d."Name",d."BasePrice",d."CurrencyCode",d."Status",d."Visibility",d."Kind"
        FROM "ReadyToWearVariants" v JOIN "Designs" d ON d."BusinessId"=v."BusinessId" AND d."Id"=v."DesignId"
        WHERE v."BusinessId"=$1 AND v."Id"=$2 FOR UPDATE OF v`, [site.BusinessId,line.variantId]);
      const v = rows[0];
      if (!v || !v.IsActive || v.Status !== 'Active' || v.Visibility !== 'Public' || v.Kind !== 'ReadyMade') throw AppError.notFound('product_unavailable', 'One of the selected products is unavailable.');
      if (v.CurrencyCode !== 'NGN') throw AppError.badRequest('unsupported_currency', 'Checkout currently supports NGN products only.');
      if (Number(v.OnHand) - Number(v.Reserved) < line.quantity) throw AppError.conflict('insufficient_stock', `${v.Name} (${v.SKU}) no longer has enough stock.`);
      const unitPriceMinor = moneyMinor(v.BasePrice);
      if (!unitPriceMinor) throw AppError.conflict('product_price_unavailable', 'A selected product does not have a valid price.');
      items.push({ ...v, quantity: line.quantity, unitPriceMinor, variantLabel: [v.Size,v.Colour].filter(Boolean).join(' / ') || v.SKU });
    }
    if (new Set(items.map((i) => i.Id)).size !== items.length) throw AppError.badRequest('duplicate_variant', 'Each variant may appear only once in a checkout.');
    const amountMinor = items.reduce((sum,item) => sum + item.unitPriceMinor * item.quantity, 0);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw AppError.badRequest('checkout_total_invalid', 'The checkout total is invalid.');
    const id = randomUUID(); const reference = `avzar_rtw_${id.replaceAll('-','')}`;
    await db.query(`INSERT INTO "ReadyToWearOrders" ("Id","BusinessId","StorefrontId","CustomerName","Email","Phone","Status","CurrencyCode","AmountMinor","PaymentReference","IdempotencyKey","RequestHash")
      VALUES ($1,$2,$3,$4,$5,$6,'PendingPayment','NGN',$7,$8,$9,$10)`,
    [id,site.BusinessId,site.Id,request.customerName,request.email.toLowerCase(),request.phone ?? null,amountMinor,reference,idempotencyKey,payloadHash]);
    for (const item of items) {
      await db.query(`UPDATE "ReadyToWearVariants" SET "Reserved"="Reserved"+$3,"UpdatedAtUtc"=now() WHERE "BusinessId"=$1 AND "Id"=$2`, [site.BusinessId,item.Id,item.quantity]);
      await db.query(`INSERT INTO "ReadyToWearOrderItems" ("Id","BusinessId","OrderId","VariantId","DesignId","ProductName","VariantLabel","Quantity","UnitPriceMinor") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [randomUUID(),site.BusinessId,id,item.Id,item.DesignId,item.Name,item.variantLabel,item.quantity,item.unitPriceMinor]);
      await db.query(`INSERT INTO "ReadyToWearReservations" ("Id","BusinessId","OrderId","VariantId","Quantity") VALUES ($1,$2,$3,$4,$5)`, [randomUUID(),site.BusinessId,id,item.Id,item.quantity]);
    }
    return { existing: false, order: { Id:id, PaymentReference:reference, AmountMinor:amountMinor, CurrencyCode:'NGN', BusinessId:site.BusinessId } };
  });
  if (created.existing) {
    if (created.order.Status !== 'PendingPayment') throw AppError.conflict('checkout_not_pending', 'This checkout has already been completed or cancelled.');
    if (created.order.AuthorizationUrl) return { orderId: created.order.Id, authorizationUrl: created.order.AuthorizationUrl, reused: true };
  }
  try {
    const base = env.PUBLIC_BASE_URL ?? env.WEB_BASE_URL;
    const callbackUrl = base ? new URL(`/sites/${encodeURIComponent(slug)}?checkout=complete`, base).toString() : undefined;
    const initialized = await provider.initialize({ email:request.email.toLowerCase(), amountMinor:created.order.AmountMinor, currency:created.order.CurrencyCode ?? 'NGN', reference:created.order.PaymentReference, callbackUrl,
      metadata:{ orderId:created.order.Id, businessId:created.order.BusinessId, storefrontSlug:slug, kind:'ready_to_wear' } });
    await pool.query(`UPDATE "ReadyToWearOrders" SET "AuthorizationUrl"=$2,"UpdatedAtUtc"=now() WHERE "Id"=$1 AND "Status"='PendingPayment'`, [created.order.Id,initialized.authorizationUrl]);
    return { orderId:created.order.Id, authorizationUrl:initialized.authorizationUrl, reused:Boolean(created.existing) };
  } catch (error) {
    // Keep the pending order and reservation: a retry with the same idempotency key can safely initialize
    // the same provider reference instead of creating a duplicate charge/order. A manager can cancel it later.
    throw error;
  }
}

export async function cancelReadyToWearOrder(pool, provider, user, orderId) {
  const existing = await pool.query(`SELECT "PaymentReference","AuthorizationUrl","Status" FROM "ReadyToWearOrders" WHERE "BusinessId"=$1 AND "Id"=$2`, [user.businessId,orderId]);
  if (!existing.rows.length) throw AppError.notFound('ready_to_wear_order_not_found', 'Ready-to-wear order not found.');
  let paymentTerminal = false;
  if (existing.rows[0].AuthorizationUrl) {
    let payment;
    try { payment = await provider.verify(existing.rows[0].PaymentReference); } catch { throw AppError.conflict('payment_status_unavailable', 'Payment status could not be verified. Stock was not released; try again later.'); }
    paymentTerminal = ['failed','abandoned'].includes(String(payment.status).toLowerCase());
    if (!paymentTerminal) throw AppError.conflict('ready_to_wear_payment_not_terminal', 'Stock cannot be released while the payment provider reports a pending or successful transaction.');
  }
  return withTransaction(pool, async (db) => {
    const { rows } = await db.query(`SELECT "Id","BusinessId","Status","AuthorizationUrl" FROM "ReadyToWearOrders" WHERE "BusinessId"=$1 AND "Id"=$2 FOR UPDATE`, [user.businessId,orderId]);
    if (!rows.length) throw AppError.notFound('ready_to_wear_order_not_found', 'Ready-to-wear order not found.');
    if (rows[0].Status === 'Cancelled') return { id: orderId, status: 'Cancelled', reused: true };
    if (rows[0].Status !== 'PendingPayment') throw AppError.conflict('ready_to_wear_order_not_cancellable', 'Only unpaid orders can be cancelled.');
    if (rows[0].AuthorizationUrl && !paymentTerminal) throw AppError.conflict('ready_to_wear_payment_started', 'A payment link has already been issued. Do not release stock while the provider checkout can still be completed.');
    const { rows: reservations } = await db.query(`SELECT "VariantId","Quantity" FROM "ReadyToWearReservations"
      WHERE "BusinessId"=$1 AND "OrderId"=$2 AND "Status"='Reserved' ORDER BY "VariantId" FOR UPDATE`, [user.businessId,orderId]);
    for (const reservation of reservations) {
      const { rowCount } = await db.query(`UPDATE "ReadyToWearVariants" SET "Reserved"="Reserved"-$3,"UpdatedAtUtc"=now()
        WHERE "BusinessId"=$1 AND "Id"=$2 AND "Reserved">=$3`, [user.businessId,reservation.VariantId,reservation.Quantity]);
      if (rowCount !== 1) throw AppError.conflict('reservation_stock_mismatch', 'The reserved stock could not be reconciled.');
    }
    await db.query(`UPDATE "ReadyToWearReservations" SET "Status"='Released',"UpdatedAtUtc"=now()
      WHERE "BusinessId"=$1 AND "OrderId"=$2 AND "Status"='Reserved'`, [user.businessId,orderId]);
    await db.query(`UPDATE "ReadyToWearOrders" SET "Status"='Cancelled',"UpdatedAtUtc"=now() WHERE "BusinessId"=$1 AND "Id"=$2 AND "Status"='PendingPayment'`, [user.businessId,orderId]);
    return { id: orderId, status: 'Cancelled', reused: false };
  });
}

export async function handleReadyToWearWebhook(pool, provider, rawBody, signature, log = console) {
  if (!provider?.isConfigured?.() || !provider.verifySignature(rawBody,signature)) return 401;
  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch { return 400; }
  if (event?.event !== 'charge.success') return 200;
  const reference = event?.data?.reference;
  if (typeof reference !== 'string' || !reference.startsWith('avzar_rtw_')) return 200;
  // The webhook carries no token, so the payment reference is the key: it names the one order (and so the business) this payment is for.
  return withFreshTenantContext(pool, async () => {
    await bindTenantByLookup(pool, 'rtw_payment_reference', reference);
    const { rows } = await pool.query(`SELECT \"Id\",\"AmountMinor\",\"CurrencyCode\",\"Status\" FROM \"ReadyToWearOrders\" WHERE \"PaymentReference\"=$1`, [reference]);
    if (!rows.length) {
      // A correctly signed payment that matches no order must never be acknowledged silently: a non-2xx makes the provider retry,
      // which covers a webhook that arrives before the checkout row is visible, and the log makes a permanent mismatch findable.
      log.error?.(JSON.stringify({ level: 'error', event: 'rtw_webhook_unmatched_reference', reference }));
      return 404;
    }
    const order = rows[0];
    const verified = await provider.verify(reference);
    if (verified.reference !== reference || verified.currency !== order.CurrencyCode || verified.amountMinor !== Number(order.AmountMinor)) return 400;
    if (verified.status !== 'success') return 400;
    await withTransaction(pool, async (db) => {
      const { rows: locked } = await db.query(`SELECT \"Id\",\"BusinessId\",\"Status\" FROM \"ReadyToWearOrders\" WHERE \"Id\"=$1 FOR UPDATE`, [order.Id]);
      if (!locked.length || locked[0].Status === 'Paid') return;
      if (locked[0].Status !== 'PendingPayment') {
        // The customer has paid for an order that is no longer waiting for payment (expired or cancelled): needs a human.
        log.error?.(JSON.stringify({ level: 'error', event: 'rtw_webhook_paid_order_not_pending', orderId: order.Id, status: locked[0].Status }));
        return;
      }
      const { rows: reservations } = await db.query(`SELECT \"VariantId\",\"Quantity\" FROM \"ReadyToWearReservations\" WHERE \"BusinessId\"=$1 AND \"OrderId\"=$2 AND \"Status\"='Reserved' FOR UPDATE`, [locked[0].BusinessId,order.Id]);
      for (const r of reservations) {
        const { rowCount } = await db.query(`UPDATE \"ReadyToWearVariants\" SET \"OnHand\"=\"OnHand\"-$3,\"Reserved\"=\"Reserved\"-$3,\"UpdatedAtUtc\"=now()
          WHERE \"BusinessId\"=$1 AND \"Id\"=$2 AND \"OnHand\">=$3 AND \"Reserved\">=$3`, [locked[0].BusinessId,r.VariantId,r.Quantity]);
        if (rowCount !== 1) throw AppError.conflict('reservation_stock_mismatch', 'The reserved stock could not be reconciled.');
      }
      await db.query(`UPDATE \"ReadyToWearReservations\" SET \"Status\"='Consumed',\"UpdatedAtUtc\"=now() WHERE \"BusinessId\"=$1 AND \"OrderId\"=$2 AND \"Status\"='Reserved'`, [locked[0].BusinessId,order.Id]);
      await db.query(`UPDATE \"ReadyToWearOrders\" SET \"Status\"='Paid',\"PaidAtUtc\"=now(),\"UpdatedAtUtc\"=now() WHERE \"Id\"=$1 AND \"Status\"='PendingPayment'`, [order.Id]);
    });
    return 200;
  });
}
