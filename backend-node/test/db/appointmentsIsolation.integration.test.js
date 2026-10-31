// Appointment mutations over HTTP against real PostgreSQL: another business must not be able to reschedule, cancel or
// change the status of this business's appointment, and a user without the permission must be refused.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { addStaff, firstLocationId, signUp, startApp } from './httpHarness.js';

const url = process.env.DATABASE_URL;
const DAY = 86_400_000;

describe('appointment routes across businesses and permissions (HTTP on PostgreSQL)', { skip: !url }, () => {
  let db; let api; let owner; let other; let staff; let appointmentId;

  const row = async () => (await db.pool.query(
    'SELECT "StartUtc", "EndUtc", "Status", xmin::text AS version FROM "Appointments" WHERE "Id" = $1', [appointmentId])).rows[0];
  let before0;
  const assertUntouched = async (message) => {
    const now = await row();
    assert.equal(now.version, before0.version, `${message}: the appointment row must not have been written`);
    assert.equal(now.Status, 'Scheduled');
    assert.equal(new Date(now.StartUtc).getTime(), new Date(before0.StartUtc).getTime());
  };
  const interval = (days) => {
    const start = new Date(Date.now() + days * DAY);
    return { startAt: start.toISOString(), endAt: new Date(start.getTime() + 30 * 60_000).toISOString() };
  };

  before(async () => {
    db = await createTempDatabase(url, 'avzar_appt_iso');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    api = await startApp(db.pool);
    owner = await signUp(api, 'appt-owner');
    other = await signUp(api, 'appt-other');
    staff = await addStaff(api, db, owner, 'appt-viewer', ['orders.view']);
    const locationId = await firstLocationId(db, owner.businessId);
    // POST /api/appointments requires an assignee; the owner's own membership is always active and allowed at every location.
    const ownerMembership = (await db.pool.query(`SELECT membership.\"Id\" FROM \"Memberships\" membership
      JOIN \"AspNetUsers\" appUser ON appUser.\"Id\" = membership.\"UserId\"
      WHERE membership.\"BusinessId\" = $1 AND membership.\"Status\" = 0 AND appUser.\"Email\" = $2`, [owner.businessId, owner.email])).rows[0];
    assert.ok(ownerMembership, 'the owner must have an active membership');
    const customer = await api.call('POST', '/api/customers', { token: owner.token, body: { fullName: 'Appointment customer', email: 'appt-customer@example.test' } });
    assert.equal(customer.status, 201, customer.text);
    const created = await api.call('POST', '/api/appointments', { token: owner.token, body: { type: 'Fitting', customerId: customer.body.id, locationId, assignedMembershipId: ownerMembership.Id, ...interval(5) } });
    assert.equal(created.status, 201, created.text);
    appointmentId = created.body.id;
    before0 = await row();
  });
  after(async () => { await api?.close(); await db?.drop(); });

  it('another business gets 404 when it reschedules the appointment', async () => {
    const response = await api.call('POST', `/api/appointments/${appointmentId}/reschedule`, { token: other.token, body: interval(9) });
    assert.equal(response.status, 404, response.text);
    assert.equal(response.body.code, 'appointment_not_found');
    await assertUntouched('reschedule');
  });

  it('another business gets 404 when it cancels the appointment', async () => {
    const response = await api.call('POST', `/api/appointments/${appointmentId}/cancel`, { token: other.token, body: { reason: 'Attempted cross-business cancel' } });
    assert.equal(response.status, 404, response.text);
    assert.equal(response.body.code, 'appointment_not_found');
    await assertUntouched('cancel');
  });

  it('another business gets 404 when it changes the status of the appointment', async () => {
    for (const status of ['Completed', 'NoShow']) {
      const response = await api.call('POST', `/api/appointments/${appointmentId}/status`, { token: other.token, body: { status } });
      assert.equal(response.status, 404, `${status}: ${response.text}`);
      assert.equal(response.body.code, 'appointment_not_found');
    }
    await assertUntouched('status');
  });

  it('a user without fittings.manage is refused on all three routes, and the row is untouched', async () => {
    const reschedule = await api.call('POST', `/api/appointments/${appointmentId}/reschedule`, { token: staff.token, body: interval(9) });
    const cancel = await api.call('POST', `/api/appointments/${appointmentId}/cancel`, { token: staff.token, body: { reason: 'No permission to do this' } });
    const status = await api.call('POST', `/api/appointments/${appointmentId}/status`, { token: staff.token, body: { status: 'Completed' } });
    assert.deepEqual([reschedule.status, cancel.status, status.status], [403, 403, 403]);
    await assertUntouched('missing permission');
  });

  it('a malformed ID is a 400 on all three routes and no token is a 401', async () => {
    for (const [route, body] of [['reschedule', interval(9)], ['cancel', { reason: 'Malformed id attempt' }], ['status', { status: 'Completed' }]]) {
      const bad = await api.call('POST', `/api/appointments/not-a-uuid/${route}`, { token: owner.token, body });
      assert.equal(bad.status, 400, `${route}: ${bad.text}`);
      assert.equal(bad.body.code, 'invalid_appointment_id');
      const anonymous = await api.call('POST', `/api/appointments/${appointmentId}/${route}`, { body });
      assert.equal(anonymous.status, 401, `${route}: ${anonymous.text}`);
    }
    await assertUntouched('malformed id and anonymous');
  });

  it('the owning business can still reschedule it afterwards', async () => {
    const response = await api.call('POST', `/api/appointments/${appointmentId}/reschedule`, { token: owner.token, body: interval(8) });
    assert.equal(response.status, 200, response.text);
    const now = await row();
    assert.notEqual(now.version, before0.version);
    assert.equal(new Date(now.StartUtc).getTime(), new Date(response.body.startUtc).getTime());
  });
});
