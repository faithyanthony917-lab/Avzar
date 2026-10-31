// Step 16a: the two timer-driven staff sweeps (worker overload, overdue installments) with a recording fake pool.
// The real SQL and row-level security run in test/db/staffNotifications.integration.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/http/errors.js';
import { enqueueStaffSweep } from '../../src/notifications/staffSweeps.js';

const business = '00000000-0000-4000-8000-0000000000b1';
const worker = '00000000-0000-4000-8000-0000000000a1';
const manager = '00000000-0000-4000-8000-0000000000a2';
const invoiceId = '00000000-0000-4000-8000-0000000000c3';
const planId = '00000000-0000-4000-8000-0000000000c4';
const location = '00000000-0000-4000-8000-0000000000d1';
const NOW = new Date('2026-11-12T08:00:00Z');
const silent = { error() {}, info() {} };

function fakePool({ candidates = [], seen = false, businesses = [{ Id: business }] } = {}) {
  const calls = [];
  const outbox = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('array_agg')) return { rows: [{ DisplayName: 'Ada Obi', TimeZoneId: 'UTC', LocationIds: [location] }] };
      if (sql.includes('FROM "Memberships" m')) return { rows: [{ Id: manager, DisplayName: 'Boss', Email: 'boss@example.test', TimeZoneId: 'UTC' }] };
      if (sql.includes('INSERT INTO "NotificationOutbox"')) {
        if (outbox.some((job) => job.recipient === values[2] && job.key === values[9])) return { rowCount: 0, rows: [] };
        const job = {
          recipient: values[2], key: values[9], Id: values[0], BusinessId: values[1], RecipientMembershipId: values[2], Category: values[3],
          EventType: values[4], Title: values[5], Body: values[6], TargetKind: values[7], TargetId: values[8], DeduplicationKey: values[9],
          InAppEnabled: values[10], EmailToAddress: values[11], Status: 'Pending', CreatedAtUtc: values[19],
        };
        outbox.push(job);
        return { rowCount: 1, rows: [job] };
      }
      if (sql.includes('INSERT INTO "Notifications"')) return { rowCount: 1, rows: [] };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return {
    calls,
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('FROM "Businesses" ORDER BY')) return { rows: businesses };
      if (sql.includes('FROM "InvoiceInstallmentPlans" pl')) return { rows: candidates };
      if (sql.includes('FROM "Notifications" WHERE')) return { rows: seen ? [{ '?column?': 1 }] : [] };
      return { rows: [] };
    },
    async connect() { return client; },
  };
}
const inserted = (pool) => pool.calls.filter((call) => call.sql.includes('INSERT INTO "Notifications"'));

const day = (date, status, reason = null) => ({ date, status, reason, capacityMinutes: 480, plannedMinutes: 600 });
const report = (workers) => ({ fromDate: '2026-11-12', days: [], workers });
const overloaded = { membershipId: worker, displayName: 'Ada Obi', days: [day('2026-11-13', 'over'), day('2026-11-14', 'over', 'leave'), day('2026-11-15', 'ok')] };
const fine = { membershipId: manager, displayName: 'Fine', days: [day('2026-11-13', 'ok'), day('2026-11-14', 'near')] };

describe('overload sweep', () => {
  it('tells the schedule managers once about a worker planned over capacity, counting only days that are not leave days', async () => {
    const pool = fakePool();
    const workload = async (_pool, user, allowed, query, now) => {
      assert.deepEqual(user, { businessId: business });
      assert.equal(allowed, null, 'the sweep looks at the whole business, not one manager\'s locations');
      assert.deepEqual(query, { days: '7' });
      assert.equal(now, NOW);
      return report([overloaded, fine]);
    };
    const first = await enqueueStaffSweep(pool, { businessId: business, now: NOW, log: silent, workload });
    assert.deepEqual(first, { scheduleOverloads: 1, installmentsOverdue: 0 });
    const [row] = inserted(pool);
    assert.equal(row.values[4], 'schedule.overload');
    assert.match(row.values[6], /Ada Obi is planned beyond capacity on 1 day in the next week, starting 2026-11-13\./);
    assert.equal(row.values[9], `schedule.overload:${worker.replaceAll('-', '')}:2026-11-12`);

    const second = await enqueueStaffSweep(pool, { businessId: business, now: NOW, log: silent, workload });
    assert.equal(second.scheduleOverloads, 0, 'the same worker on the same day is not announced twice');
    assert.equal(inserted(pool).length, 1);
  });

  it('skips a business whose plan has no shop-wide schedule, and does not hide any other failure', async () => {
    const pool = fakePool();
    const noPlan = async () => { throw AppError.forbidden('feature_not_in_plan', 'No.'); };
    assert.deepEqual(await enqueueStaffSweep(pool, { businessId: business, now: NOW, log: silent, workload: noPlan }),
      { scheduleOverloads: 0, installmentsOverdue: 0 });
    const broken = async () => { throw new Error('database down'); };
    await assert.rejects(() => enqueueStaffSweep(pool, { businessId: business, now: NOW, log: silent, workload: broken }), /database down/);
  });

  it('on a pool with no tenant wrapper it visits every business', async () => {
    const other = '00000000-0000-4000-8000-0000000000b2';
    const pool = fakePool({ businesses: [{ Id: business }, { Id: other }] });
    const seenBusinesses = [];
    await enqueueStaffSweep(pool, { now: NOW, log: silent, workload: async (_p, user) => { seenBusinesses.push(user.businessId); return report([]); } });
    assert.deepEqual(seenBusinesses, [business, other]);
  });
});

describe('installment sweep', () => {
  const candidate = { InvoiceId: invoiceId, Number: 'INV-2026-0007', LocationId: location, Today: '2026-11-12' };
  const plan = (extra = {}) => ({
    id: planId, state: 'Active', overdueCount: 1,
    installments: [{ sequence: 1, dueDate: '2026-10-10', overdue: false }, { sequence: 2, dueDate: '2026-11-10', overdue: true }, { sequence: 3, dueDate: '2026-12-10', overdue: false }],
    ...extra,
  });
  const noWorkload = async () => { throw AppError.forbidden('feature_not_in_plan', 'No.'); };

  it('announces the oldest overdue installment of a plan once, to the invoice managers at its location', async () => {
    const pool = fakePool({ candidates: [candidate] });
    const asked = [];
    const loadPlans = async (db, businessId, ids, today) => { asked.push({ businessId, ids, today }); return new Map([[invoiceId, plan()]]); };
    const result = await enqueueStaffSweep(pool, { businessId: business, now: NOW, batchLimit: 50, log: silent, loadPlans, workload: noWorkload });
    assert.deepEqual(result, { scheduleOverloads: 0, installmentsOverdue: 1 });
    assert.deepEqual(asked, [{ businessId: business, ids: [invoiceId], today: '2026-11-12' }]);
    const query = pool.calls.find((call) => call.sql.includes('FROM "InvoiceInstallmentPlans" pl'));
    assert.deepEqual(query.values, [business, NOW, 50]);
    assert.match(query.sql, /pl\."Status" = 'Active' AND i\."Status" = 'Issued'/);
    const [row] = inserted(pool);
    assert.equal(row.values[4], 'installment.overdue');
    assert.equal(row.values[7], 'invoice');
    assert.equal(row.values[8], invoiceId);
    assert.equal(row.values[9], `installment.overdue:${planId.replaceAll('-', '')}:2`);
    assert.equal(row.values[6], 'Installment 2 of invoice INV-2026-0007 was due on 2026-11-10 and is not paid.');
  });

  it('says nothing for a finished plan, a plan with nothing overdue, or an installment already announced', async () => {
    for (const [label, loaded, seen] of [
      ['completed', plan({ state: 'Completed' }), false],
      ['nothing overdue', plan({ overdueCount: 0, installments: [{ sequence: 1, dueDate: '2026-12-10', overdue: false }] }), false],
      ['already announced', plan(), true],
    ]) {
      const pool = fakePool({ candidates: [candidate], seen });
      const result = await enqueueStaffSweep(pool, { businessId: business, now: NOW, log: silent, workload: noWorkload,
        loadPlans: async () => new Map([[invoiceId, loaded]]) });
      assert.equal(result.installmentsOverdue, 0, label);
      assert.equal(inserted(pool).length, 0, label);
    }
  });

  it('does not read any plan when no installment is past its date', async () => {
    const pool = fakePool({ candidates: [] });
    let called = false;
    await enqueueStaffSweep(pool, { businessId: business, now: NOW, log: silent, workload: noWorkload, loadPlans: async () => { called = true; return new Map(); } });
    assert.equal(called, false);
  });
});
