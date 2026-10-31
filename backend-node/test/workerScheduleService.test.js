import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addWorkerLeave,
  getWorkerAvailability,
  getWorkerCalendar,
  intersectCalendarFeedLocations,
  requestMyLeave,
  reviewWorkerLeave,
  setWorkerAvailability,
} from '../src/auth/workerScheduleService.js';

const businessId = '00000000-0000-4000-8000-000000000002';
const membershipId = '00000000-0000-4000-8000-000000000040';
const user = { businessId, userId: '00000000-0000-4000-8000-000000000001' };
const allowedLocations = ['00000000-0000-4000-8000-000000000060'];
const noRows = { rows: [] };
const makeTransaction = (db) => async (_pool, callback) => callback(db);

describe('calendar feed location revocation', () => {
  it('keeps only locations still assigned and present in the issue-time scope', () => {
    const a = '00000000-0000-4000-8000-000000000061';
    const b = '00000000-0000-4000-8000-000000000062';
    const c = '00000000-0000-4000-8000-000000000063';
    assert.deepEqual(intersectCalendarFeedLocations([a, b, c, a], [a, b]), [a, b]);
    assert.deepEqual(intersectCalendarFeedLocations([a, c], [a, b]), [a]);
    assert.deepEqual(intersectCalendarFeedLocations([a, c], []), []);
    assert.deepEqual(intersectCalendarFeedLocations([a, c], null), [a, c]);
  });
});

describe('worker schedule persistence', () => {
  it('reads configured availability only for active workers in permitted locations', async () => {
    const calls = [];
    const db = {
      query: async (sql, values) => {
        calls.push({ sql, values });
        if (sql.includes('FROM "Memberships"')) return { rows: [{ Id: membershipId }] };
        if (sql.includes('FROM "WorkerAvailability"')) return { rows: [{
          DayOfWeek: 1, IsAvailable: true, OpensAt: '09:00:00', ClosesAt: '17:00:00', CapacityMinutes: 420,
        }] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    const result = await getWorkerAvailability(db, user, membershipId, allowedLocations);
    assert.equal(result.isConfigured, true);
    assert.deepEqual(result.days, [{
      dayOfWeek: 1, isAvailable: true, opensAt: '09:00:00', closesAt: '17:00:00', capacityMinutes: 420,
    }]);
    assert.deepEqual(calls[0].values, [businessId, membershipId, allowedLocations]);
  });

  it('replaces all seven availability entries atomically and audits the change', async () => {
    const inserted = [];
    const audited = [];
    const db = {
      query: async (sql, values) => {
        if (sql.includes('FROM "Memberships"')) return { rows: [{ Id: membershipId }] };
        if (sql.includes('DELETE FROM "WorkerAvailability"')) return noRows;
        if (sql.includes('INSERT INTO "WorkerAvailability"')) {
          inserted.push(values);
          return noRows;
        }
        if (sql.includes('INSERT INTO "AuditLogs"')) {
          audited.push(values);
          return noRows;
        }
        if (sql.includes('FROM "WorkerAvailability"')) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    const days = Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek,
      isAvailable: dayOfWeek === 1,
      opensAt: dayOfWeek === 1 ? '09:00' : null,
      closesAt: dayOfWeek === 1 ? '17:00' : null,
      capacityMinutes: dayOfWeek === 1 ? 420 : 0,
    }));

    const pool = {
      query: async (sql) => sql.includes('FROM "Memberships"')
        ? { rows: [{ Id: membershipId }] } : { rows: [] },
    };
    const result = await setWorkerAvailability(pool, makeTransaction(db), user, membershipId, days, allowedLocations);
    assert.equal(result.isConfigured, false);
    assert.equal(inserted.length, 7);
    assert.equal(audited.length, 1);
    assert.equal(audited[0][1], 'worker.availability_updated');
    assert.deepEqual(JSON.parse(audited[0][4]), { availableDays: 1, dailyCapacityMinutes: 420 });
  });

  it('rejects malformed availability without opening a transaction', async () => {
    let began = false;
    const days = Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek, isAvailable: false, opensAt: null, closesAt: null, capacityMinutes: 0,
    }));
    days[1] = { dayOfWeek: 1, isAvailable: true, opensAt: '09:00', closesAt: '09:00:00', capacityMinutes: 60 };
    const pool = { query: async () => ({ rows: [{ Id: membershipId }] }) };
    await assert.rejects(
      setWorkerAvailability(pool, async () => { began = true; }, user, membershipId, days, allowedLocations),
      (error) => error.code === 'invalid_worker_availability',
    );
    assert.equal(began, false);
  });

  it('prevents approved leave from overlapping an existing approved interval', async () => {
    const calls = [];
    const db = {
      query: async (sql, values) => {
        calls.push(sql);
        if (sql.includes('FROM "Memberships"')) return { rows: [{ Id: membershipId }] };
        if (sql.includes('pg_advisory_xact_lock')) return noRows;
        if (sql.includes('FROM "WorkerLeaves"') && sql.includes('"Status" = \'Approved\'')) return { rows: [{ '?column?': 1 }] };
        return noRows;
      },
    };
    const pool = { query: async () => ({ rows: [{ Id: membershipId }] }) };
    await assert.rejects(
      addWorkerLeave(pool, makeTransaction(db), user, membershipId, {
        startsAtUtc: '2026-07-01T09:00:00Z',
        endsAtUtc: '2026-07-01T12:00:00Z',
        reason: 'Annual leave',
      }, allowedLocations),
      (error) => error.code === 'worker_leave_overlap',
    );
    assert.equal(calls.some((sql) => sql.includes('INSERT INTO "WorkerLeaves"')), false);
  });

  it('reviews only pending leave requests and persists the decision and audit record', async () => {
    const pending = {
      Id: '00000000-0000-4000-8000-000000000070',
      MembershipId: membershipId,
      StartsAtUtc: '2026-07-01T09:00:00.000Z',
      EndsAtUtc: '2026-07-01T12:00:00.000Z',
      Reason: 'Annual leave',
      Status: 'Pending',
      ReviewNote: null,
    };
    const calls = [];
    const db = {
      query: async (sql, values) => {
        calls.push({ sql, values });
        if (sql.includes('FROM "WorkerLeaves" l') && sql.includes('FOR UPDATE')) return { rows: [pending] };
        if (sql.includes('pg_advisory_xact_lock')) return noRows;
        if (sql.includes('FROM "WorkerLeaves"') && sql.includes('"Status" = \'Approved\'')) return noRows;
        if (sql.includes('UPDATE "WorkerLeaves"')) return { rows: [{ ...pending, Status: 'Approved', ReviewNote: 'Approved' }] };
        if (sql.includes('INSERT INTO "AuditLogs"')) return noRows;
        // Step 16a: the decision goes to the worker, and an approval is checked against planned work. Nobody is queued here.
        if (sql.includes('array_agg')) return { rows: [{ DisplayName: 'Worker', TimeZoneId: 'UTC', LocationIds: [] }] };
        if (sql.includes('FROM "ProductionTasks" t')) return { rows: [{ Count: 0 }] };
        if (sql.includes('JOIN "AspNetUsers" appUser')) return noRows;
        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    const result = await reviewWorkerLeave({}, makeTransaction(db), user, pending.Id, {
      approve: true, note: 'Approved',
    }, allowedLocations);
    assert.equal(result.status, 'Approved');
    assert.equal(result.reviewNote, 'Approved');
    const toWorker = calls.filter(({ sql }) => sql.includes('JOIN "AspNetUsers" appUser'));
    assert.deepEqual(toWorker[0].values[1], [membershipId], 'the decision is addressed to the worker alone');
    assert.ok(calls.some(({ sql }) => sql.includes('FROM "ProductionTasks" t')), 'an approval is checked against planned tasks');
  });

  it('creates a pending personal leave request with its audit row in the same transaction', async () => {
    let transactionUsed = false;
    const row = {
      Id: '00000000-0000-4000-8000-000000000071',
      MembershipId: membershipId,
      StartsAtUtc: '2026-07-01T09:00:00.000Z',
      EndsAtUtc: '2026-07-01T12:00:00.000Z',
      Reason: 'Annual leave',
      Status: 'Pending',
      ReviewNote: null,
    };
    const calls = [];
    const db = {
      query: async (sql, values) => {
        calls.push({ sql, values });
        // Step 16a: the leave managers are looked up (nobody is queued here) and planned work is checked.
        if (sql.includes('array_agg')) return { rows: [{ DisplayName: 'Worker', TimeZoneId: 'UTC', LocationIds: [] }] };
        if (sql.includes('FROM "ProductionTasks" t')) return { rows: [{ Count: 0 }] };
        if (sql.includes('JOIN "AspNetUsers" appUser')) return noRows;
        if (sql.includes('FROM "Memberships"')) return { rows: [{ Id: membershipId }] };
        if (sql.includes('INSERT INTO "WorkerLeaves"')) return { rows: [row] };
        if (sql.includes('INSERT INTO "AuditLogs"')) return noRows;
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    const tx = async (_pool, callback) => {
      transactionUsed = true;
      return callback(db);
    };

    const result = await requestMyLeave({}, tx, user, {
      startsAtUtc: '2026-07-01T09:00:00Z',
      endsAtUtc: '2026-07-01T12:00:00Z',
      reason: 'Annual leave',
    });
    assert.equal(transactionUsed, true);
    assert.equal(result.status, 'Pending');
    assert.equal(result.membershipId, membershipId);
    const toManagers = calls.filter(({ sql }) => sql.includes('JOIN "AspNetUsers" appUser'));
    assert.equal(toManagers[0].values[3], 'workers.manage', 'the request is announced to the leave managers');
  });

  it('returns only scheduled calendar tasks within the requested location scope', async () => {
    const calls = [];
    const db = {
      query: async (sql, values) => {
        calls.push({ sql, values });
        if (sql.includes('FROM "Memberships"')) return { rows: [{ Id: membershipId }] };
        if (sql.includes('FROM "ProductionTasks" t')) return { rows: [{
          Id: '00000000-0000-4000-8000-000000000080',
          OrderId: '00000000-0000-4000-8000-000000000050',
          Title: 'Cut shirt',
          Status: 'Scheduled',
          PlannedStartUtc: '2026-07-01T09:00:00Z',
          PlannedEndUtc: '2026-07-01T10:00:00Z',
          DeadlineUtc: null,
        }] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    const result = await getWorkerCalendar(db, user, membershipId,
      '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', allowedLocations);
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'Scheduled');
    const calendarQuery = calls.find(({ sql }) => sql.includes('FROM "ProductionTasks" t'));
    assert.match(calendarQuery.sql, /o\."LocationId" = ANY\(\$5::uuid\[\]\)/);
    assert.deepEqual(calendarQuery.values[4], allowedLocations);
  });
});
