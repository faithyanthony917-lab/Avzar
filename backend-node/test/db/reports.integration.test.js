// GET /api/reports/summary over HTTP against real PostgreSQL. The report SQL was once broken in a way no test caught
// (unterminated quoted identifier); this runs every query in it with real data. Skipped unless DATABASE_URL is set.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { addStaff, confirmedOrder, firstLocationId, paidInvoice, signUp, startApp } from './httpHarness.js';

const url = process.env.DATABASE_URL;
const EXPENSE = 1500;

describe('reports summary over HTTP on PostgreSQL', { skip: !url }, () => {
  let db; let api; let owner; let other; let staff; let paid;
  const today = new Date().toISOString().slice(0, 10);
  const get = (token, query = '') => api.call('GET', `/api/reports/summary${query}`, { token });

  before(async () => {
    db = await createTempDatabase(url, 'avzar_reports');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    api = await startApp(db.pool);
    owner = await signUp(api, 'report-owner');
    other = await signUp(api, 'report-other');
    staff = await addStaff(api, db, owner, 'report-viewer', ['orders.view']);
    const locationId = await firstLocationId(db, owner.businessId);
    const order = await confirmedOrder(api, db, owner, locationId, 'report');
    paid = await paidInvoice(api, owner, order.orderId);
    const categories = await api.call('GET', '/api/expense-categories', { token: owner.token });
    assert.equal(categories.status, 200, categories.text);
    let categoryId = (Array.isArray(categories.body) ? categories.body : categories.body.items)?.[0]?.id;
    if (!categoryId) {
      const created = await api.call('POST', '/api/expense-categories', { token: owner.token, body: { name: 'Fabric' } });
      assert.equal(created.status, 201, created.text);
      categoryId = created.body.id;
    }
    const expense = await api.call('POST', '/api/expenses', { token: owner.token, body: { categoryId, amount: EXPENSE, description: 'Thread and buttons', expenseDate: today } });
    assert.equal(expense.status, 201, expense.text);
  });
  after(async () => { await api?.close(); await db?.drop(); });

  it('reports this business\'s orders, verified revenue and expenses for the default range', async () => {
    const response = await get(owner.token);
    assert.equal(response.status, 200, response.text);
    const report = response.body;
    assert.equal(report.currencyCode, 'NGN');
    assert.equal(report.to, today);
    assert.equal(report.ordersCreated, 1);
    assert.ok(report.orderValue >= 40000, `order value ${report.orderValue}`);
    assert.equal(report.verifiedRevenue, paid.total);
    assert.equal(report.expenses, EXPENSE);
    assert.equal(report.grossAfterExpenses, Math.round(paid.total * 100 - EXPENSE * 100) / 100);
  });

  it('honours an explicit range, and a range with no activity reports zeros', async () => {
    const same = await get(owner.token, `?from=${today}&to=${today}`);
    assert.equal(same.status, 200, same.text);
    assert.equal(same.body.ordersCreated, 1);
    assert.equal(same.body.expenses, EXPENSE);
    const empty = await get(owner.token, '?from=2020-01-01&to=2020-01-31');
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual([empty.body.ordersCreated, empty.body.verifiedRevenue, empty.body.expenses], [0, 0, 0]);
  });

  it('never includes another business\'s figures', async () => {
    const response = await get(other.token);
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(
      [response.body.ordersCreated, response.body.orderValue, response.body.verifiedRevenue, response.body.expenses],
      [0, 0, 0, 0]);
  });

  it('needs the reports.view permission and a signed-in user', async () => {
    const refused = await get(staff.token);
    assert.equal(refused.status, 403, refused.text);
    const anonymous = await get(undefined);
    assert.equal(anonymous.status, 401, anonymous.text);
  });

  it('rejects impossible, reversed and over-long date ranges with 400', async () => {
    for (const query of ['?from=2026-02-30', '?from=not-a-date', `?from=${today}&to=2020-01-01`, '?from=2024-01-01&to=2026-01-01']) {
      const response = await get(owner.token, query);
      assert.equal(response.status, 400, `${query}: ${response.text}`);
      assert.equal(response.body.code, 'invalid_report_range', query);
    }
  });
});
