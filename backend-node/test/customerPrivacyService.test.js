import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerPrivacyRequest, listBusinessCustomerPrivacyRequests, listCustomerPrivacyRequests, reviewCustomerPrivacyRequest } from '../src/auth/customerPrivacyService.js';

const BUSINESS_A = '00000000-0000-4000-8000-000000000001';
const BUSINESS_B = '00000000-0000-4000-8000-000000000002';
const CUSTOMER_A = '00000000-0000-4000-8000-000000000003';
const CUSTOMER_B = '00000000-0000-4000-8000-000000000004';
const USER_A = '00000000-0000-4000-8000-000000000005';
const TOKEN = 'customer-portal-token-that-is-at-least-32-chars';
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex').toUpperCase();

function fakePool() {
  const state = { requests: [] };
  const grant = { Id: 'grant-a', BusinessId: BUSINESS_A, CustomerId: CUSTOMER_A };
  const customers = new Set([`${BUSINESS_A}:${CUSTOMER_A}`, `${BUSINESS_B}:${CUSTOMER_B}`]);
  async function query(sql, values = []) {
    if (sql.includes('FROM "CustomerPortalGrants"')) return { rows: values[0] === hash(TOKEN) ? [grant] : [] };
    if (sql.includes('INSERT INTO "CustomerPrivacyRequests"')) {
      const [id, businessId, customerId, type, note] = values;
      if (state.requests.some((row) => row.BusinessId === businessId && row.CustomerId === customerId && row.Type === type && row.Status === 'Pending')) return { rows: [] };
      const row = { Id: id, BusinessId: businessId, CustomerId: customerId, Type: type, Status: 'Pending', CustomerNote: note, StaffNote: null, CreatedAtUtc: new Date('2026-10-19T12:00:00Z'), UpdatedAtUtc: null, ReviewedAtUtc: null, ReviewedByUserId: null };
      state.requests.push(row);
      return { rows: [row] };
    }
    if (sql.includes('FROM "CustomerPrivacyRequests"') && sql.includes('"Type" = $3')) {
      const row = state.requests.find((item) => item.BusinessId === values[0] && item.CustomerId === values[1] && item.Type === values[2] && item.Status === 'Pending');
      return { rows: row ? [row] : [] };
    }
    if (sql.includes('FROM "CustomerPrivacyRequests"') && sql.includes('FOR UPDATE')) {
      const row = state.requests.find((item) => item.BusinessId === values[0] && item.CustomerId === values[1] && item.Id === values[2]);
      return { rows: row ? [row] : [] };
    }
    if (sql.includes('UPDATE "CustomerPrivacyRequests"')) {
      const [status, note, reviewedBy, businessId, customerId, id] = values;
      const row = state.requests.find((item) => item.BusinessId === businessId && item.CustomerId === customerId && item.Id === id);
      if (!row) return { rows: [] };
      row.Status = status; row.StaffNote = note ?? row.StaffNote; row.UpdatedAtUtc = new Date('2026-10-19T12:01:00Z'); row.ReviewedAtUtc = row.UpdatedAtUtc; row.ReviewedByUserId = reviewedBy;
      return { rows: [row] };
    }
    if (sql.includes('INSERT INTO "AuditLogs"')) return { rows: [], rowCount: 1 };
    if (sql.includes('SELECT 1 FROM "Customers"')) return { rows: customers.has(`${values[0]}:${values[1]}`) ? [{ '?column?': 1 }] : [] };
    if (sql.includes('FROM "CustomerPrivacyRequests"') && sql.includes('ORDER BY')) return { rows: state.requests.filter((row) => row.BusinessId === values[0] && row.CustomerId === values[1]) };
    return { rows: [] };
  }
  const client = { query, release() {} };
  return { state, query, connect: async () => client };
}

describe('customer privacy request service', () => {
  it('rejects an invalid or expired portal credential without exposing request data', async () => {
    const pool = fakePool();
    await assert.rejects(() => listCustomerPrivacyRequests(pool, 'short'), (error) => error.status === 401 && error.code === 'portal_link_invalid');
    assert.equal(pool.state.requests.length, 0);
  });

  it('creates one pending request per type and returns the existing request on retry', async () => {
    const pool = fakePool();
    const first = await createCustomerPrivacyRequest(pool, { token: TOKEN, type: 'Deletion', note: 'Please delete my data.' });
    const retry = await createCustomerPrivacyRequest(pool, { token: TOKEN, type: 'Deletion' });
    const exportRequest = await createCustomerPrivacyRequest(pool, { token: TOKEN, type: 'Export' });
    assert.equal(first.alreadyPending, false);
    assert.equal(retry.alreadyPending, true);
    assert.equal(retry.request.id, first.request.id);
    assert.equal(exportRequest.request.type, 'Export');
    assert.equal(pool.state.requests.length, 2);
  });

  it('enforces tenant scope and the Pending → Approved → Completed review flow', async () => {
    const pool = fakePool();
    const request = await createCustomerPrivacyRequest(pool, { token: TOKEN, type: 'Deletion' });
    await assert.rejects(() => listBusinessCustomerPrivacyRequests(pool, { businessId: BUSINESS_B }, CUSTOMER_A), (error) => error.status === 404);
    assert.deepEqual(await listBusinessCustomerPrivacyRequests(pool, { businessId: BUSINESS_B }, CUSTOMER_B), []);
    const approved = await reviewCustomerPrivacyRequest(pool, { businessId: BUSINESS_A, userId: USER_A }, CUSTOMER_A, request.request.id, { status: 'Approved', staffNote: 'We will review retention requirements.' });
    assert.equal(approved.status, 'Approved');
    const completed = await reviewCustomerPrivacyRequest(pool, { businessId: BUSINESS_A, userId: USER_A }, CUSTOMER_A, request.request.id, { status: 'Completed' });
    assert.equal(completed.status, 'Completed');
    assert.equal(completed.staffNote, 'We will review retention requirements.');
    await assert.rejects(() => reviewCustomerPrivacyRequest(pool, { businessId: BUSINESS_A, userId: USER_A }, CUSTOMER_A, request.request.id, { status: 'Denied' }), (error) => error.status === 409);
    await assert.rejects(() => reviewCustomerPrivacyRequest(pool, { businessId: BUSINESS_B, userId: USER_A }, CUSTOMER_A, request.request.id, { status: 'Approved' }), (error) => error.status === 404);
  });
});
