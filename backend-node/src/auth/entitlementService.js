import { AppError } from '../http/errors.js';

const tiers = {
  'inventory.level': ['none', 'basic', 'full'],
  'reports.level': ['basic', 'standard', 'advanced', 'full'],
  'storefront.template_tier': ['standard', 'basic', 'advanced', 'premium'],
};
const nouns = {
  'users.max': 'staff accounts',
  'designs.max': 'saved designs',
};

export async function entitlementValue(db, businessId, key, fallback = '0') {
  const { rows } = await db.query(`
    SELECT COALESCE(override."Value", pe."Value", $3) AS "Value"
    FROM "Plans" p
    LEFT JOIN "PlanEntitlements" pe ON pe."PlanId" = p."Id" AND pe."Key" = $2
    LEFT JOIN LATERAL (
      SELECT o."Value" FROM "EntitlementOverrides" o
      WHERE o."BusinessId" = $1 AND o."Key" = $2 AND (o."ExpiresAtUtc" IS NULL OR o."ExpiresAtUtc" > now())
      ORDER BY o."CreatedAtUtc" DESC LIMIT 1
    ) override ON TRUE
    WHERE p."Id" = COALESCE(
      (SELECT s."PlanId" FROM "Subscriptions" s WHERE s."BusinessId" = $1 AND s."Status" <> 'Expired' LIMIT 1),
      (SELECT free."Id" FROM "Plans" free WHERE free."Code" = 'free' LIMIT 1)
    ) LIMIT 1`, [businessId, key, fallback]);
  if (!rows.length) throw new AppError(503, 'plans_not_seeded', 'Subscription plans are not configured on this server.');
  return String(rows[0].Value ?? fallback).trim();
}

export async function requireFlag(db, businessId, key) {
  if (await entitlementValue(db, businessId, key, 'false') !== 'true') {
    throw AppError.forbidden('feature_not_in_plan', `Your current plan does not include ${key}.`, { entitlement: key });
  }
}

export async function requireTier(db, businessId, key, minimum) {
  const order = tiers[key];
  if (!order) throw new Error(`Unknown tier entitlement: ${key}`);
  const current = await entitlementValue(db, businessId, key, order[0]);
  if (!order.includes(current) || order.indexOf(current) < order.indexOf(minimum)) {
    throw AppError.forbidden('feature_not_in_plan', `Your current plan does not include ${key}. Upgrade to unlock it.`,
      { entitlement: key, requiredTier: minimum });
  }
}

export async function ensureBelowLimit(db, businessId, key, countCurrent) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`${businessId}:${key}`]);
  const raw = await entitlementValue(db, businessId, key, '0');
  if (raw === 'unlimited') return;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new AppError(503, 'plans_not_seeded', 'The plan limit is not configured correctly.');
  const used = await countCurrent(db);
  if (used >= limit) {
    throw AppError.forbidden('plan_limit_reached', `Your plan allows ${limit} ${nouns[key] ?? 'items'}, and you have used ${used}. Upgrade your plan to add more. Nothing has been deleted.`,
      { entitlement: key, limit, used });
  }
}