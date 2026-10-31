import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PLANS, syncPlans } from '../../src/db/planSeed.js';

// Every key in Tailoring.Domain/Billing/EntitlementKeys (EntitlementCatalog.cs), 24 in total.
const CATALOG_KEYS = [
  'users.max', 'customers.active.max', 'designs.max', 'storage.gb.max', 'storefront.count.max', 'storefront.pages.max',
  'orders.monthly.max', 'appointments.monthly.max',
  'storefront.builder', 'storefront.custom_pages', 'storefront.custom_domain', 'finance.partial_payments', 'finance.expenses',
  'scheduling.individual', 'scheduling.shop', 'scheduling.auto_planning', 'ai.fashion_design', 'ai.assistant_builder', 'ai.credits.daily',
  'storefront.template_tier', 'storefront.theme_level', 'storefront.branding_level', 'storefront.section_level', 'inventory.level', 'reports.level',
];
const plan = (code) => DEFAULT_PLANS.find((p) => p.code === code);

describe('default plans (port of DefaultPlans.cs)', () => {
  it('has the exact codes, names, order and NGN prices', () => {
    assert.deepEqual(DEFAULT_PLANS.map((p) => [p.code, p.name, p.sortOrder, p.monthlyPrice]),
      [['free', 'Free', 0, '0.00'], ['starter', 'Starter', 1, '5000.00'], ['professional', 'Professional', 2, '10000.00'], ['business', 'Business', 3, '20000.00']]);
  });
  it('gives every plan every catalogue key and nothing else', () => {
    for (const p of DEFAULT_PLANS) assert.deepEqual(Object.keys(p.values).sort(), [...CATALOG_KEYS].sort(), p.code);
  });
  it('keeps custom domains off in every plan', () => {
    for (const p of DEFAULT_PLANS) assert.equal(p.values['storefront.custom_domain'], 'false');
  });
  it('matches the values from DefaultPlans.cs', () => {
    assert.deepEqual(plan('free').values, {
      'users.max': '1', 'customers.active.max': '30', 'orders.monthly.max': '20', 'designs.max': '50', 'storage.gb.max': '1',
      'appointments.monthly.max': '10', 'storefront.count.max': '1', 'storefront.pages.max': '5', 'storefront.builder': 'false',
      'storefront.custom_pages': 'false', 'storefront.custom_domain': 'false', 'finance.partial_payments': 'false', 'finance.expenses': 'false',
      'scheduling.individual': 'false', 'scheduling.shop': 'false', 'scheduling.auto_planning': 'false', 'ai.fashion_design': 'false',
      'ai.assistant_builder': 'false', 'ai.credits.daily': '0', 'storefront.template_tier': 'standard', 'storefront.theme_level': 'none', 'storefront.branding_level': 'none',
      'storefront.section_level': 'none', 'inventory.level': 'none', 'reports.level': 'basic' });
    const starter = plan('starter').values;
    assert.equal(starter['users.max'], '3'); assert.equal(starter['finance.partial_payments'], 'true'); assert.equal(starter['ai.assistant_builder'], 'false');
    assert.equal(starter['storefront.template_tier'], 'basic'); assert.equal(starter['inventory.level'], 'basic'); assert.equal(starter['reports.level'], 'standard');
    const pro = plan('professional').values;
    assert.equal(pro['users.max'], '10'); assert.equal(pro['designs.max'], '2500'); assert.equal(pro['storefront.pages.max'], '12');
    assert.equal(pro['storefront.builder'], 'true'); assert.equal(pro['scheduling.auto_planning'], 'true');
    assert.equal(pro['ai.fashion_design'], 'true'); assert.equal(pro['ai.assistant_builder'], 'true'); assert.equal(pro['ai.credits.daily'], '100'); assert.equal(pro['storefront.template_tier'], 'advanced');
    const biz = plan('business').values;
    assert.equal(biz['users.max'], '30'); assert.equal(biz['orders.monthly.max'], '2000'); assert.equal(biz['storefront.count.max'], '5');
    assert.equal(biz['storefront.pages.max'], '25'); assert.equal(biz['ai.credits.daily'], '300'); assert.equal(biz['storefront.template_tier'], 'premium'); assert.equal(biz['reports.level'], 'full');
  });
  it('is immutable', () => {
    assert.throws(() => { 'use strict'; plan('free').values['users.max'] = '99'; }, TypeError);
  });
});

function fakePool(planExists = {}) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/^INSERT INTO "Plans"/.test(calls.at(-1).sql)) return { rowCount: planExists[params[1]] ? 0 : 1, rows: [] };
      if (/^SELECT "Id" FROM "Plans"/.test(calls.at(-1).sql)) return { rowCount: 1, rows: [{ Id: `id-${params[0]}` }] };
      if (/^INSERT INTO "PlanEntitlements"/.test(calls.at(-1).sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() { calls.push({ sql: 'release' }); },
  };
  return { calls, pool: { connect: async () => client } };
}

describe('syncPlans (port of PlanSeeder.SyncAsync)', () => {
  it('is add-only: no UPDATE or DELETE, conflicts do nothing, all values are parameters', async () => {
    const { calls, pool } = fakePool();
    await syncPlans(pool);
    const sql = calls.map((c) => c.sql).join('\n');
    assert.ok(!/\bUPDATE\b|\bDELETE\b|DO UPDATE/i.test(sql));
    assert.equal(calls.filter((c) => /^INSERT INTO "Plans"/.test(c.sql) && /ON CONFLICT \("Code"\) DO NOTHING/.test(c.sql)).length, 4);
    assert.equal(calls.filter((c) => /^INSERT INTO "PlanEntitlements"/.test(c.sql) && /ON CONFLICT \("PlanId","Key"\) DO NOTHING/.test(c.sql)).length, 4);
    for (const c of calls.filter((x) => x.params)) assert.ok(!/free|starter|5000/.test(c.sql));
  });
  it('runs in one transaction and releases the connection', async () => {
    const { calls, pool } = fakePool();
    await syncPlans(pool);
    const order = calls.map((c) => c.sql).filter((s) => ['BEGIN', 'COMMIT', 'release'].includes(s));
    assert.deepEqual(order, ['BEGIN', 'COMMIT', 'release']);
  });
  it('rolls back and releases when a statement fails', async () => {
    const calls = [];
    const client = { async query(sql) { calls.push(sql.trim().split(/\s/)[0]); if (/INSERT INTO "Plans"/.test(sql)) throw new Error('boom'); return { rowCount: 0, rows: [] }; }, release() { calls.push('release'); } };
    await assert.rejects(syncPlans({ connect: async () => client }), /boom/);
    assert.ok(calls.includes('ROLLBACK') && calls.at(-1) === 'release');
  });
  it('counts inserted plans', async () => {
    const { pool } = fakePool({ free: true, starter: true });
    assert.equal((await syncPlans(pool)).plansInserted, 2);
  });
});
