// Step-14: POST /api/inquiries/:id/schedule over HTTP with a recording fake pool (no database).
// Covers the request shape, both permissions, tenant and location scope, the single transaction and its rollback.
// The real SQL runs in test/db/inquirySchedule.integration.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';
import { newCsrfToken } from '../src/security/csrf.js';

const userId = '00000000-0000-4000-8000-000000000001';
const businessId = '00000000-0000-4000-8000-000000000002';
const otherBusinessId = '00000000-0000-4000-8000-000000000020';
const inquiryId = '00000000-0000-4000-8000-000000000003';
const locationId = '00000000-0000-4000-8000-000000000007';
const otherLocationId = '00000000-0000-4000-8000-000000000008';
const staffId = '00000000-0000-4000-8000-000000000009';
const env = {
  NODE_ENV: 'test', PORT: 8081, HOST: '127.0.0.1', LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters',
  JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10,
};
const BOTH = ['inquiries.manage', 'fittings.manage'];
const DAY = 86_400_000;

async function requestApp(app, pathname, init = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, init);
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const token = () => issueAccessToken({
  jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER, jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
}, { userId, businessId, sessionId: '00000000-0000-4000-8000-000000000005' }).token;

function schedulePool({ permissions = BOTH, inquiryBusiness = businessId, kind = 'Appointment', appointmentId = null, status = 'New', allowedLocation = locationId, conflict = false } = {}) {
  const statements = [];
  let customerId = null;
  const inquiry = { Id: inquiryId, Kind: kind, Status: status, Name: 'Jane Doe', Email: 'Jane@Example.test', Phone: null, Message: 'I would like a fitting.', AppointmentId: appointmentId };
  const query = async (sql, values = []) => {
    statements.push({ sql, values });
    if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('SELECT DISTINCT ml."LocationId"')) return { rows: allowedLocation ? [{ LocationId: allowedLocation }] : [] };
    if (sql.includes('FROM "Memberships"')) return { rows: [{
      UserId: userId, BusinessId: businessId, Email: 'staff@example.test', FullName: 'Staff',
      BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: false, Permissions: permissions,
    }] };
    return { rows: [] };
  };
  return {
    statements, query,
    async connect() {
      return {
        async query(sql, values = []) {
          statements.push({ sql, values });
          const text = sql.trimStart();
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('FROM "Inquiries"') && sql.includes('FOR UPDATE')) return { rows: inquiryBusiness === businessId ? [inquiry] : [] };
          if (sql.includes('FROM "Customers"') && sql.includes('FOR KEY SHARE')) return { rows: customerId ? [{ Status: 'Active' }] : [] };
          if (sql.includes('FROM "Customers"') && sql.includes('"NormalizedEmail"')) return { rows: [] };
          if (sql.includes('SELECT count(*)::bigint AS "Count" FROM "Customers"')) return { rows: [{ Count: 0 }] };
          if (text.startsWith('INSERT INTO "Customers"')) { customerId = values[0]; return { rows: [], rowCount: 1 }; }
          if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: '10' }] };
          if (text.startsWith('INSERT INTO "UsageCounters"')) return { rows: [{ Count: 1 }] };
          if (sql.includes('FROM "Businesses"') && sql.includes('"TimeZoneId"')) return { rows: [{ TimeZoneId: 'UTC' }] };
          if (sql.includes('FROM "Locations"')) return { rows: values[1] === locationId ? [{ '?column?': 1 }] : [] };
          if (sql.includes('FROM "Memberships" member')) return { rows: [{ '?column?': 1 }] };
          if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
          if (sql.includes('FROM "Appointments" a')) {
            return { rows: conflict ? [{ Id: '00000000-0000-4000-8000-0000000000aa', Type: 'Fitting', CustomerId: customerId, AssignedMembershipId: staffId, LocationId: locationId, StartUtc: new Date(), EndUtc: new Date() }] : [] };
          }
          if (text.startsWith('INSERT INTO "Appointments"')) {
            return { rows: [{
              Id: values[0], Type: values[2], CustomerId: values[3], OrderId: values[4], LocationId: values[5], AssignedMembershipId: values[6],
              StartUtc: values[7], EndUtc: values[8], TimeZoneId: values[9], Status: 'Scheduled', Notes: values[10], CancellationReason: null,
            }], rowCount: 1 };
          }
          if (text.startsWith('UPDATE "Inquiries"')) {
            return { rows: [{
              Id: inquiryId, Kind: 'Appointment', Status: 'Converted', Name: inquiry.Name, Email: inquiry.Email, Phone: null, Message: inquiry.Message,
              DesignId: null, DesignNameSnapshot: null, GarmentType: null, Budget: null, PreferredDate: null, EventDate: null,
              ConvertedOrderId: null, AppointmentId: values[2], InternalNote: null, CreatedAtUtc: '2026-10-17T10:00:00.000Z', HandledAtUtc: '2026-10-26T10:00:00.000Z',
            }] };
          }
          return { rows: [], rowCount: 1 };
        },
        release() {},
      };
    },
  };
}

const interval = (days) => {
  const start = new Date(Date.now() + days * DAY);
  return { startAt: start.toISOString(), endAt: new Date(start.getTime() + 30 * 60_000).toISOString() };
};
const payload = (extra = {}) => ({ type: 'Fitting', locationId, assignedMembershipId: staffId, ...interval(5), ...extra });
// Without a bearer token the CSRF check runs first (400), so the unauthenticated call carries a valid CSRF pair and reaches the 401.
const csrfHeaders = () => { const t = newCsrfToken(env.JWT_SIGNING_KEY); return { cookie: `tailoring.csrf=${t}`, 'x-xsrf-token': t }; };
const post = (pool, body, { auth = true, id = inquiryId } = {}) => requestApp(createApp(env, pool), `/api/inquiries/${id}/schedule`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token()}` } : csrfHeaders()) }, body: JSON.stringify(body),
});
const has = (pool, prefix) => pool.statements.some(({ sql }) => sql.trimStart().startsWith(prefix));
const count = (pool, exact) => pool.statements.filter(({ sql }) => sql === exact).length;

describe('POST /api/inquiries/:id/schedule', () => {
  it('books the appointment, creates the customer and marks the request Converted in one transaction', async () => {
    const pool = schedulePool();
    const result = await post(pool, payload({ type: 'Consultation' }));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.inquiry.status, 'Converted');
    assert.equal(result.body.inquiry.appointmentId, result.body.appointment.id);
    assert.equal(result.body.inquiry.convertedOrderId, null);
    assert.equal(result.body.appointment.type, 'Consultation');
    assert.equal(result.body.appointment.status, 'Scheduled');
    assert.equal(result.body.appointment.notes, 'Website request: I would like a fitting.');
    assert.equal(count(pool, 'BEGIN'), 1, 'createAppointment must join the open transaction, not start another');
    assert.equal(count(pool, 'COMMIT'), 1);
    assert.equal(count(pool, 'ROLLBACK'), 0);
    const customer = pool.statements.find(({ sql }) => sql.trimStart().startsWith('INSERT INTO "Customers"'));
    assert.equal(customer.values[1], businessId);
    assert.equal(customer.values[4], 'jane@example.test');
    const audits = pool.statements.filter(({ sql }) => sql.trimStart().startsWith('INSERT INTO "AuditLogs"'));
    assert.ok(audits.some(({ sql }) => sql.includes("'inquiry.scheduled'")));
    assert.ok(audits.some(({ values }) => values[1] === 'appointment.created'));
    const update = pool.statements.find(({ sql }) => sql.trimStart().startsWith('UPDATE "Inquiries"'));
    assert.equal(update.values[0], inquiryId);
    assert.equal(update.values[1], businessId);
  });

  it('uses the staff member\'s own note when one is given', async () => {
    const pool = schedulePool();
    const result = await post(pool, payload({ notes: '  Bring the jacket.  ' }));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.appointment.notes, 'Bring the jacket.');
  });

  it('needs a sign-in and both inquiries.manage and fittings.manage', async () => {
    assert.equal((await post(schedulePool(), payload(), { auth: false })).status, 401);
    const manageOnly = schedulePool({ permissions: ['inquiries.manage'] });
    assert.equal((await post(manageOnly, payload())).status, 403);
    assert.equal(has(manageOnly, 'INSERT INTO "Customers"'), false);
    const fittingsOnly = schedulePool({ permissions: ['fittings.manage'] });
    assert.equal((await post(fittingsOnly, payload())).status, 403);
    assert.equal(has(fittingsOnly, 'INSERT INTO "Customers"'), false);
  });

  it('rejects a malformed id, unknown fields, a missing location and a bad type before touching the database', async () => {
    const pool = schedulePool();
    assert.equal((await post(pool, payload(), { id: 'not-a-uuid' })).status, 404);
    assert.equal((await post(pool, { ...payload(), customerId: staffId })).status, 400);
    assert.equal((await post(pool, { ...payload(), locationId: undefined })).status, 400);
    assert.equal((await post(pool, { ...payload(), type: 'Haircut' })).status, 400);
    assert.equal((await post(pool, { ...payload(), assignedMembershipId: 'x' })).status, 400);
    assert.equal(count(pool, 'BEGIN'), 0);
  });

  it('another business\'s request is a 404', async () => {
    const pool = schedulePool({ inquiryBusiness: otherBusinessId });
    const result = await post(pool, payload());
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'inquiry_not_found');
    assert.equal(has(pool, 'INSERT INTO "Customers"'), false);
  });

  it('a location the user may not use is refused and everything rolls back', async () => {
    const pool = schedulePool({ allowedLocation: otherLocationId });
    const result = await post(pool, payload());
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'location_forbidden');
    assert.equal(count(pool, 'ROLLBACK'), 1);
    assert.equal(count(pool, 'COMMIT'), 0);
    assert.equal(has(pool, 'UPDATE "Inquiries"'), false);
  });

  it('a time clash is a 409 and the customer, link and audit row are rolled back', async () => {
    const pool = schedulePool({ conflict: true });
    const result = await post(pool, payload());
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'appointment_conflict');
    assert.equal(count(pool, 'ROLLBACK'), 1);
    assert.equal(count(pool, 'COMMIT'), 0);
    assert.equal(has(pool, 'INSERT INTO "Appointments"'), false);
    assert.equal(has(pool, 'UPDATE "Inquiries"'), false);
  });

  it('a request that already has an appointment is a 409 inquiry_already_scheduled', async () => {
    const pool = schedulePool({ appointmentId: '00000000-0000-4000-8000-0000000000bb', status: 'Converted' });
    const result = await post(pool, payload());
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'inquiry_already_scheduled');
    assert.equal(has(pool, 'INSERT INTO "Customers"'), false);
  });

  it('a request that became an order or was rejected cannot be scheduled', async () => {
    for (const status of ['Converted', 'Rejected']) {
      const result = await post(schedulePool({ status }), payload());
      assert.equal(result.status, 409, status);
      assert.equal(result.body.code, 'not_schedulable');
    }
  });

  it('only a booking request can be scheduled', async () => {
    const pool = schedulePool({ kind: 'Inquiry' });
    const result = await post(pool, payload());
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'not_a_booking_request');
    assert.equal(has(pool, 'INSERT INTO "Customers"'), false);
  });
});
