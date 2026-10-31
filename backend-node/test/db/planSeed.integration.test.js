// Plan seed against a real PostgreSQL: add-only, idempotent, safe with concurrent runners. Skipped unless DATABASE_URL is set.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../../src/db/migrate.js';
import { DEFAULT_PLANS, syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';

const url = process.env.DATABASE_URL;
const KEYS = Object.keys(DEFAULT_PLANS[0].values).length;

describe('plan seed against PostgreSQL', { skip: !url }, () => {
  let db;
  before(async () => {
    db = await createTempDatabase(url, 'avzar_plans');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
  });
  after(async () => { await db?.drop(); });

  const plans = async () => (await db.pool.query('SELECT * FROM "Plans" ORDER BY "SortOrder"')).rows;
  const value = async (code, key) => (await db.pool.query(
    'SELECT pe."Value" FROM "PlanEntitlements" pe JOIN "Plans" p ON p."Id" = pe."PlanId" WHERE p."Code" = $1 AND pe."Key" = $2', [code, key])).rows[0]?.Value;

  it('inserts the four plans with exact prices and every entitlement key on an empty database', async () => {
    assert.deepEqual(await syncPlans(db.pool), { plansInserted: 4, entitlementsInserted: 4 * KEYS });
    const rows = await plans();
    assert.deepEqual(rows.map((r) => [r.Code, r.Name, r.SortOrder, r.MonthlyPrice, r.CurrencyCode, r.IsActive, r.AnnualPrice]),
      [['free', 'Free', 0, '0.00', 'NGN', true, null], ['starter', 'Starter', 1, '5000.00', 'NGN', true, null],
        ['professional', 'Professional', 2, '10000.00', 'NGN', true, null], ['business', 'Business', 3, '20000.00', 'NGN', true, null]]);
    const count = await db.pool.query('SELECT count(*)::int AS n FROM "PlanEntitlements"');
    assert.equal(count.rows[0].n, 4 * KEYS);
    assert.equal(await value('professional', 'designs.max'), '2500');
    assert.equal(await value('business', 'storefront.template_tier'), 'premium');
  });

  it('a second run changes nothing', async () => {
    assert.deepEqual(await syncPlans(db.pool), { plansInserted: 0, entitlementsInserted: 0 });
  });

  it('never overwrites admin edits but re-adds a missing key', async () => {
    await db.pool.query(`UPDATE "Plans" SET "MonthlyPrice" = 7500, "Name" = 'Starter Plus', "IsActive" = false, "AnnualPrice" = 70000 WHERE "Code" = 'starter'`);
    await db.pool.query(`UPDATE "PlanEntitlements" SET "Value" = '99' WHERE "Key" = 'users.max' AND "PlanId" = (SELECT "Id" FROM "Plans" WHERE "Code" = 'starter')`);
    await db.pool.query(`DELETE FROM "PlanEntitlements" WHERE "Key" = 'reports.level' AND "PlanId" = (SELECT "Id" FROM "Plans" WHERE "Code" = 'starter')`);
    assert.deepEqual(await syncPlans(db.pool), { plansInserted: 0, entitlementsInserted: 1 });
    const starter = (await plans()).find((r) => r.Code === 'starter');
    assert.deepEqual([starter.Name, starter.MonthlyPrice, starter.IsActive, starter.AnnualPrice], ['Starter Plus', '7500.00', false, '70000.00']);
    assert.equal(await value('starter', 'users.max'), '99');
    assert.equal(await value('starter', 'reports.level'), 'standard');
  });

  it('concurrent runners (several instances starting together) end with one copy of everything', async () => {
    const fresh = await createTempDatabase(url, 'avzar_plans_race');
    try {
      await migrate(fresh.pool, MIGRATIONS_DIR, quiet);
      await Promise.all([syncPlans(fresh.pool), syncPlans(fresh.pool), syncPlans(fresh.pool)]);
      const n = await fresh.pool.query('SELECT (SELECT count(*)::int FROM "Plans") AS plans, (SELECT count(*)::int FROM "PlanEntitlements") AS ents');
      assert.deepEqual(n.rows[0], { plans: 4, ents: 4 * KEYS });
    } finally { await fresh.drop(); }
  });

  it('the migrate CLI path also seeds (migrate then syncPlans) and stays idempotent', async () => {
    const fresh = await createTempDatabase(url, 'avzar_plans_cli');
    try {
      await migrate(fresh.pool, MIGRATIONS_DIR, quiet);
      await syncPlans(fresh.pool);
      await migrate(fresh.pool, MIGRATIONS_DIR, quiet);
      assert.equal((await syncPlans(fresh.pool)).plansInserted, 0);
    } finally { await fresh.drop(); }
  });
});
