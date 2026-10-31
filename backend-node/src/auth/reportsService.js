import { AppError } from '../http/errors.js';
import { requireTier } from './entitlementService.js';

const cacheByPool = new WeakMap();
const cacheTtlMs = 30_000;

function parseDateOnly(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw AppError.badRequest('invalid_report_range', `${name} must be a valid date in YYYY-MM-DD format.`);
  }
  return text;
}

function dayNumber(value) { return Math.floor(Date.parse(`${value}T00:00:00.000Z`) / 86_400_000); }
function addDays(value, count) { return new Date((dayNumber(value) + count) * 86_400_000).toISOString().slice(0, 10); }
function cents(value) {
  const [whole, fraction = ''] = String(value ?? '0').split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2) || '0');
}

export async function allowedLocations(pool, user) {
  if (user.isOwner || user.permissions.includes('locations.all')) return null;
  const { rows } = await pool.query(`
    SELECT DISTINCT ml."LocationId" FROM "Memberships" m
    JOIN "MembershipLocations" ml ON ml."BusinessId" = m."BusinessId" AND ml."MembershipId" = m."Id"
    WHERE m."BusinessId" = $1 AND m."UserId" = $2 AND m."Status" = 0`, [user.businessId, user.userId]);
  return rows.map((row) => row.LocationId);
}

function cached(pool, key) {
  const entries = cacheByPool.get(pool);
  const hit = entries?.get(key);
  if (!hit || hit.expiresAt <= Date.now()) return null;
  return hit.value;
}

function saveCache(pool, key, value) {
  let entries = cacheByPool.get(pool);
  if (!entries) { entries = new Map(); cacheByPool.set(pool, entries); }
  entries.set(key, { value, expiresAt: Date.now() + cacheTtlMs });
  return value;
}

export async function reportSummary(pool, user, fromValue, toValue) {
  const businessId = user.businessId;
  await requireTier(pool, businessId, 'reports.level', 'basic');
  const today = new Date().toISOString().slice(0, 10);
  const to = parseDateOnly(toValue, 'to') ?? today;
  const from = parseDateOnly(fromValue, 'from') ?? addDays(today, -29);
  const start = dayNumber(from); const end = dayNumber(to);
  if (end < start || end - start > 366) throw AppError.badRequest('invalid_report_range', 'Choose a date range of at most 367 days, with the end date on or after the start date.');
  const allowed = await allowedLocations(pool, user);
  const scope = allowed === null ? 'all' : allowed.slice().sort().join('-');
  const key = `${businessId}:${scope}:${from}:${to}`;
  const hit = cached(pool, key);
  if (hit) return hit;

  const fromUtc = `${from}T00:00:00.000Z`;
  const untilUtc = `${addDays(to, 1)}T00:00:00.000Z`;
  const business = await pool.query('SELECT "CurrencyCode" FROM "Businesses" WHERE "Id" = $1', [businessId]);
  if (!business.rows.length) throw AppError.unauthorized('business_required', 'Select a business first.');
  const totals = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM "Orders" o WHERE o."BusinessId" = $1 AND o."CreatedAtUtc" >= $2::timestamptz AND o."CreatedAtUtc" < $3::timestamptz AND ($4::uuid[] IS NULL OR o."LocationId" = ANY($4::uuid[]))) AS "OrdersCreated",
      (SELECT count(*)::int FROM "Orders" o WHERE o."BusinessId" = $1 AND o."Status" = 'Delivered' AND o."DeliveredAtUtc" >= $2::timestamptz AND o."DeliveredAtUtc" < $3::timestamptz AND ($4::uuid[] IS NULL OR o."LocationId" = ANY($4::uuid[]))) AS "OrdersDelivered",
      (SELECT COALESCE(sum(o."Total"),0)::numeric(18,2) FROM "Orders" o WHERE o."BusinessId" = $1 AND o."CreatedAtUtc" >= $2::timestamptz AND o."CreatedAtUtc" < $3::timestamptz AND o."Status" NOT IN ('Draft','Quoted','Cancelled') AND ($4::uuid[] IS NULL OR o."LocationId" = ANY($4::uuid[]))) AS "OrderValue",
      (SELECT COALESCE(sum(p."Amount"),0)::numeric(18,2) FROM "Payments" p JOIN "Invoices" i ON i."BusinessId" = p."BusinessId" AND i."Id" = p."InvoiceId" LEFT JOIN "Orders" o ON o."BusinessId" = i."BusinessId" AND o."Id" = i."OrderId"
        WHERE p."BusinessId" = $1 AND p."Status" = 'Verified' AND p."VerifiedAtUtc" >= $2::timestamptz AND p."VerifiedAtUtc" < $3::timestamptz AND ($4::uuid[] IS NULL OR (i."OrderId" IS NOT NULL AND o."LocationId" = ANY($4::uuid[])))) AS "VerifiedRevenue",
      (SELECT COALESCE(sum(e."Amount"),0)::numeric(18,2) FROM "Expenses" e WHERE e."BusinessId" = $1 AND e."ExpenseDate" >= $5::date AND e."ExpenseDate" <= $6::date AND e."VoidedAtUtc" IS NULL AND ($4::uuid[] IS NULL OR (e."LocationId" IS NOT NULL AND e."LocationId" = ANY($4::uuid[])))) AS "Expenses",
      (SELECT count(*)::int FROM "ProductionTasks" t JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId" WHERE t."BusinessId" = $1 AND t."Status" NOT IN ('Completed','Cancelled') AND ($4::uuid[] IS NULL OR o."LocationId" = ANY($4::uuid[]))) AS "OpenTasks",
      (SELECT count(*)::int FROM "ProductionTasks" t JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId" WHERE t."BusinessId" = $1 AND t."Status" = 'Completed' AND t."CompletedAtUtc" >= $2::timestamptz AND t."CompletedAtUtc" < $3::timestamptz AND ($4::uuid[] IS NULL OR o."LocationId" = ANY($4::uuid[]))) AS "CompletedTasks",
      (SELECT count(*)::int FROM "ProductionTasks" t JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId" WHERE t."BusinessId" = $1 AND t."Status" NOT IN ('Completed','Cancelled') AND t."DeadlineUtc" < now() AND ($4::uuid[] IS NULL OR o."LocationId" = ANY($4::uuid[]))) AS "OverdueTasks"`,
  [businessId, fromUtc, untilUtc, allowed, from, to]);
  const daily = await pool.query(`
    WITH days AS (SELECT generate_series($2::date,$3::date,interval '1 day')::date AS "Date"),
    revenue AS (SELECT (p."VerifiedAtUtc" AT TIME ZONE 'UTC')::date AS "Date",sum(p."Amount")::numeric(18,2) AS "Amount"
      FROM "Payments" p JOIN "Invoices" i ON i."BusinessId" = p."BusinessId" AND i."Id" = p."InvoiceId" LEFT JOIN "Orders" o ON o."BusinessId" = i."BusinessId" AND o."Id" = i."OrderId"
      WHERE p."BusinessId" = $1 AND p."Status" = 'Verified' AND p."VerifiedAtUtc" >= $4::timestamptz AND p."VerifiedAtUtc" < $5::timestamptz AND ($6::uuid[] IS NULL OR (i."OrderId" IS NOT NULL AND o."LocationId" = ANY($6::uuid[]))) GROUP BY 1),
    expenses AS (SELECT e."ExpenseDate" AS "Date",sum(e."Amount")::numeric(18,2) AS "Amount" FROM "Expenses" e
      WHERE e."BusinessId" = $1 AND e."ExpenseDate" BETWEEN $2::date AND $3::date AND e."VoidedAtUtc" IS NULL AND ($6::uuid[] IS NULL OR (e."LocationId" IS NOT NULL AND e."LocationId" = ANY($6::uuid[]))) GROUP BY 1),
    orders AS (SELECT (o."CreatedAtUtc" AT TIME ZONE 'UTC')::date AS "Date",count(*)::int AS "Count" FROM "Orders" o
      WHERE o."BusinessId" = $1 AND o."CreatedAtUtc" >= $4::timestamptz AND o."CreatedAtUtc" < $5::timestamptz AND ($6::uuid[] IS NULL OR o."LocationId" = ANY($6::uuid[])) GROUP BY 1)
    SELECT days."Date",COALESCE(revenue."Amount",0)::numeric(18,2) AS "VerifiedRevenue",COALESCE(expenses."Amount",0)::numeric(18,2) AS "Expenses",COALESCE(orders."Count",0)::int AS "Orders"
    FROM days LEFT JOIN revenue USING ("Date") LEFT JOIN expenses USING ("Date") LEFT JOIN orders USING ("Date") ORDER BY days."Date"`,
  [businessId, from, to, fromUtc, untilUtc, allowed]);
  const [delivery, production, retention, garments, collections, materials] = await Promise.all([
    pool.query(`SELECT count(*) FILTER (WHERE o."DeliveredAtUtc" IS NOT NULL AND o."DeliveredAtUtc"::date > o."PromisedDate")::int AS "LateDelivered",
      count(*) FILTER (WHERE o."DeliveredAtUtc" IS NULL AND o."PromisedDate" < $3::date AND o."Status" NOT IN ('Cancelled','Draft','Quoted'))::int AS "LateOutstanding"
      FROM "Orders" o WHERE o."BusinessId" = $1 AND o."PromisedDate" BETWEEN $2::date AND $3::date
      AND ($4::uuid[] IS NULL OR o."LocationId" = ANY($4::uuid[]))`, [businessId, from, to, allowed]),
    pool.query(`SELECT count(*)::int AS "CompletedCount",
      COALESCE(round((avg(EXTRACT(EPOCH FROM (t."CompletedAtUtc" - COALESCE(t."ActualStartUtc",t."PlannedStartUtc",t."CreatedAtUtc"))) / 3600))::numeric,2),0) AS "AverageHours"
      FROM "ProductionTasks" t JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
      WHERE t."BusinessId" = $1 AND t."Status" = 'Completed' AND t."CompletedAtUtc" >= $2::timestamptz AND t."CompletedAtUtc" < $3::timestamptz
      AND ($4::uuid[] IS NULL OR o."LocationId" = ANY($4::uuid[]))
      AND COALESCE(t."ActualStartUtc",t."PlannedStartUtc",t."CreatedAtUtc") <= t."CompletedAtUtc"`,
      [businessId, fromUtc, untilUtc, allowed]),
    pool.query(`WITH customer_orders AS (
        SELECT o."CustomerId", count(*)::int AS order_count FROM "Orders" o
        WHERE o."BusinessId" = $1 AND o."CreatedAtUtc" >= $2::timestamptz AND o."CreatedAtUtc" < $3::timestamptz
          AND o."Status" NOT IN ('Draft','Quoted','Cancelled') AND ($4::uuid[] IS NULL OR o."LocationId" = ANY($4::uuid[]))
        GROUP BY o."CustomerId")
      SELECT count(*)::int AS "ActiveCustomers", count(*) FILTER (WHERE order_count > 1)::int AS "ReturningCustomers"
      FROM customer_orders`, [businessId, fromUtc, untilUtc, allowed]),
    pool.query(`SELECT COALESCE(NULLIF(g."DesignNameSnapshot",''), NULLIF(g."Name",''), NULLIF(g."Category",''), 'Uncategorized') AS "Name",
      COALESCE(sum(g."Quantity"),0)::int AS "Units", count(DISTINCT o."Id")::int AS "Orders"
      FROM "OrderGarments" g JOIN "Orders" o ON o."BusinessId" = g."BusinessId" AND o."Id" = g."OrderId"
      WHERE g."BusinessId" = $1 AND o."CreatedAtUtc" >= $2::timestamptz AND o."CreatedAtUtc" < $3::timestamptz
      AND o."Status" NOT IN ('Draft','Quoted','Cancelled') AND ($4::uuid[] IS NULL OR o."LocationId" = ANY($4::uuid[]))
      GROUP BY 1 ORDER BY "Units" DESC, "Orders" DESC, "Name" LIMIT 10`, [businessId, fromUtc, untilUtc, allowed]),
    pool.query(`SELECT c."Name", count(DISTINCT o."Id")::int AS "Orders", COALESCE(sum(g."Quantity"),0)::int AS "Units"
      FROM "DesignCollections" c JOIN "DesignCollectionItems" ci ON ci."BusinessId" = c."BusinessId" AND ci."CollectionId" = c."Id"
      JOIN "OrderGarments" g ON g."BusinessId" = ci."BusinessId" AND g."DesignId" = ci."DesignId"
      JOIN "Orders" o ON o."BusinessId" = g."BusinessId" AND o."Id" = g."OrderId"
      WHERE c."BusinessId" = $1 AND o."CreatedAtUtc" >= $2::timestamptz AND o."CreatedAtUtc" < $3::timestamptz
      AND o."Status" NOT IN ('Draft','Quoted','Cancelled') AND ($4::uuid[] IS NULL OR o."LocationId" = ANY($4::uuid[]))
      GROUP BY c."Id",c."Name" ORDER BY "Units" DESC,"Orders" DESC,c."Name" LIMIT 10`, [businessId, fromUtc, untilUtc, allowed]),
    pool.query(`SELECT m."Id" AS "MaterialId",m."Name",m."Unit",
      COALESCE(sum(sm."Quantity") FILTER (WHERE sm."Kind" = 'Consume'),0)::numeric(18,3) AS "Consumed",
      COALESCE(sum(sm."Quantity") FILTER (WHERE sm."Kind" = 'Wastage'),0)::numeric(18,3) AS "Wasted"
      FROM "Materials" m LEFT JOIN "StockMovements" sm ON sm."BusinessId" = m."BusinessId" AND sm."MaterialId" = m."Id"
        AND sm."CreatedAtUtc" >= $2::timestamptz AND sm."CreatedAtUtc" < $3::timestamptz
      WHERE m."BusinessId" = $1 AND ($4::uuid[] IS NULL OR m."LocationId" = ANY($4::uuid[]))
      GROUP BY m."Id",m."Name",m."Unit" HAVING COALESCE(sum(sm."Quantity") FILTER (WHERE sm."Kind" IN ('Consume','Wastage')),0) > 0
      ORDER BY "Consumed" DESC,"Wasted" DESC,m."Name" LIMIT 20`, [businessId, fromUtc, untilUtc, allowed]),
  ]);
  const row = totals.rows[0];
  const result = {
    from, to, currencyCode: business.rows[0].CurrencyCode,
    ordersCreated: Number(row.OrdersCreated), ordersDelivered: Number(row.OrdersDelivered),
    orderValue: Number(row.OrderValue), verifiedRevenue: Number(row.VerifiedRevenue), expenses: Number(row.Expenses),
    grossAfterExpenses: Number(cents(row.VerifiedRevenue) - cents(row.Expenses)) / 100,
    lateDeliveries: Number(delivery.rows[0]?.LateDelivered ?? 0),
    overdueDeliveries: Number(delivery.rows[0]?.LateOutstanding ?? 0),
    averageProductionHours: Number(production.rows[0]?.AverageHours ?? 0),
    completedProductionTasks: Number(production.rows[0]?.CompletedCount ?? 0),
    activeCustomers: Number(retention.rows[0]?.ActiveCustomers ?? 0),
    returningCustomers: Number(retention.rows[0]?.ReturningCustomers ?? 0),
    customerRetentionRate: Number(retention.rows[0]?.ActiveCustomers ?? 0) > 0
      ? Math.round(Number(retention.rows[0]?.ReturningCustomers ?? 0) * 10000 / Number(retention.rows[0].ActiveCustomers)) / 100 : 0,
    popularGarments: garments.rows.map((item) => ({ name: item.Name, units: Number(item.Units), orders: Number(item.Orders) })),
    popularCollections: collections.rows.map((item) => ({ name: item.Name, units: Number(item.Units), orders: Number(item.Orders) })),
    materialUsage: materials.rows.map((item) => ({ materialId: item.MaterialId, name: item.Name, unit: item.Unit, consumed: Number(item.Consumed), wasted: Number(item.Wasted) })),
    openTasks: Number(row.OpenTasks), completedTasks: Number(row.CompletedTasks), overdueTasks: Number(row.OverdueTasks),
    daily: daily.rows.map((item) => ({ date: item.Date, verifiedRevenue: Number(item.VerifiedRevenue), expenses: Number(item.Expenses), orders: Number(item.Orders) })),
  };
  return saveCache(pool, key, result);
}