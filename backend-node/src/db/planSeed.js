// Default plans and their entitlements, plus the plan sync.
// INITIAL values only: missing plans are inserted and missing entitlement keys are added to existing plans.
// Existing plans, prices, names and entitlement values (admin edits) are NEVER overwritten.
import { randomUUID } from 'node:crypto';

const LOCK_KEY = 7_262_027; // pg_advisory_lock key: one seeder at a time across replicas (migrate uses 7_262_026)

function v(users, customers, orders, designs, storageGb, appts, storefronts, pages, builder, customPages, sched, shop, auto,
  template, theme, branding, section, inventory, reports, partialPayments, expenses) {
  const flag = (b) => (b ? 'true' : 'false');
  return {
    'users.max': String(users),
    'customers.active.max': String(customers),
    'orders.monthly.max': String(orders),
    'designs.max': String(designs),
    'storage.gb.max': String(storageGb),
    'appointments.monthly.max': String(appts),
    'storefront.count.max': String(storefronts),
    'storefront.pages.max': String(pages),
    'storefront.builder': flag(builder),
    'storefront.custom_pages': flag(customPages),
    'storefront.custom_domain': 'false', // off in every plan until the feature ships
    'finance.partial_payments': flag(partialPayments),
    'finance.expenses': flag(expenses),
    'scheduling.individual': flag(sched),
    'scheduling.shop': flag(shop),
    'scheduling.auto_planning': flag(auto),
    'ai.fashion_design': flag(inventory === 'full'),
    'ai.assistant_builder': flag(template === 'advanced' || template === 'premium'),
    // Daily shared credits across text and image generation. Plan seeding is add-only, so existing admin-edited values remain intact.
    'ai.credits.daily': template === 'premium' ? '300' : template === 'advanced' ? '100' : inventory === 'full' ? '5' : '0',
    'storefront.template_tier': template,
    'storefront.theme_level': theme,
    'storefront.branding_level': branding,
    'storefront.section_level': section,
    'inventory.level': inventory,
    'reports.level': reports,
  };
}

// monthlyPrice is a decimal string (NGN): money is never held in floats.
export const DEFAULT_PLANS = Object.freeze([
  { code: 'free', name: 'Free', description: 'Individuals and small tailors getting started.', sortOrder: 0, monthlyPrice: '0.00',
    values: v(1, 30, 20, 50, 1, 10, 1, 5, false, false, false, false, false, 'standard', 'none', 'none', 'none', 'none', 'basic', false, false) },
  { code: 'starter', name: 'Starter', description: 'Growing tailors who need invoicing, pricing and a branded catalog.', sortOrder: 1, monthlyPrice: '5000.00',
    values: v(3, 200, 100, 500, 5, 50, 1, 5, false, false, false, false, false, 'basic', 'basic', 'basic', 'none', 'basic', 'standard', true, true) },
  { code: 'professional', name: 'Professional', description: 'Studios running a team, a schedule and a customized storefront.', sortOrder: 2, monthlyPrice: '10000.00',
    values: v(10, 1000, 500, 2500, 25, 250, 1, 12, true, true, true, true, true, 'advanced', 'advanced', 'advanced', 'advanced', 'full', 'advanced', true, true) },
  { code: 'business', name: 'Business', description: 'Established brands with multiple storefronts and advanced controls.', sortOrder: 3, monthlyPrice: '20000.00',
    values: v(30, 5000, 2000, 10000, 100, 1000, 5, 25, true, true, true, true, true, 'premium', 'full', 'full', 'full', 'full', 'full', true, true) },
].map((p) => Object.freeze({ ...p, values: Object.freeze(p.values) })));

/**
 * Idempotent, add-only. Safe to run on every start and from several instances at once.
 * `pool` is a pg Pool. Returns { plansInserted, entitlementsInserted } (0/0 when nothing was missing).
 */
export async function syncPlans(pool, plans = DEFAULT_PLANS) {
  const client = await pool.connect();
  let plansInserted = 0;
  let entitlementsInserted = 0;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query('BEGIN');
    for (const plan of plans) {
      const inserted = await client.query(
        `INSERT INTO "Plans" ("Id","Code","Name","Description","IsActive","SortOrder","CurrencyCode","MonthlyPrice","AnnualPrice","CreatedAtUtc")
         VALUES ($1,$2,$3,$4,true,$5,'NGN',$6::numeric,NULL,now())
         ON CONFLICT ("Code") DO NOTHING`,
        [randomUUID(), plan.code, plan.name, plan.description, plan.sortOrder, plan.monthlyPrice]);
      plansInserted += inserted.rowCount;
      const found = await client.query('SELECT "Id" FROM "Plans" WHERE "Code" = $1', [plan.code]);
      const planId = found.rows[0].Id;
      const keys = Object.keys(plan.values);
      const added = await client.query(
        `INSERT INTO "PlanEntitlements" ("PlanId","Key","Value")
         SELECT $1, k, v FROM unnest($2::text[], $3::text[]) AS t(k, v)
         ON CONFLICT ("PlanId","Key") DO NOTHING`,
        [planId, keys, keys.map((k) => plan.values[k])]);
      entitlementsInserted += added.rowCount;
    }
    await client.query('COMMIT');
    return { plansInserted, entitlementsInserted };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
