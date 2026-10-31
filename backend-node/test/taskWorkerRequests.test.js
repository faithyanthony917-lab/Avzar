import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/http/errors.js';
import { createTaskWorkerRequest, reviewTaskWorkerRequest } from '../src/auth/orderRoutes.js';

const businessId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000001';
const taskId = '00000000-0000-4000-8000-000000000010';
const requestId = '00000000-0000-4000-8000-000000000011';
const membershipId = '00000000-0000-4000-8000-000000000012';
const req = { currentUser: { businessId, userId } };

function requestDb({ taskRows = [{ Id: taskId, OrderId: '00000000-0000-4000-8000-000000000020', Title: 'Sew shirt', Status: 'InProgress', EstimatedMinutes: 60, AssignedMembershipId: membershipId }], insertRows } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('FROM "Memberships"') && sql.includes('"UserId"')) return { rows: [{ Id: membershipId }] };
      if (sql.includes('FROM "ProductionTasks"') && sql.includes('FOR UPDATE')) return { rows: taskRows };
      if (sql.includes('INSERT INTO "TaskWorkerRequests"')) return { rows: insertRows ?? [{ Id: requestId, Type: 'Discrepancy', Status: 'Pending', Message: 'The fabric delayed work', PlannedMinutes: 60, ActualMinutes: 95, CreatedAtUtc: '2026-10-19T10:00:00Z' }] };
      if (sql.includes('INSERT INTO "TaskEvents"') || sql.includes('INSERT INTO "AuditLogs"')) return { rows: [] };
      if (sql.includes('FROM "TaskWorkerRequests"')) return { rows: [{ Id: requestId, TaskId: taskId, Type: 'Assistance', Status: 'Pending', TaskStatus: 'InProgress' }] };
      if (sql.includes('UPDATE "TaskWorkerRequests"')) return { rows: [{ Id: requestId, TaskId: taskId, Type: 'Assistance', Status: values[0], Message: 'Need help', ReviewNote: values[2] }] };
      return { rows: [] };
    },
  };
}

describe('production worker requests', () => {
  it('records discrepancy against the server-side planned estimate', async () => {
    const db = requestDb();
    const result = await createTaskWorkerRequest(db, req, taskId, { type: 'Discrepancy', message: 'The fabric delayed work', actualMinutes: 95 });
    assert.equal(result.Status, 'Pending');
    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO "TaskWorkerRequests"'));
    assert.equal(insert.values[0] !== undefined, true);
    assert.equal(insert.values[1], businessId);
    assert.equal(insert.values[2], taskId);
    assert.equal(insert.values[6], 60);
    assert.equal(insert.values[7], 95);
  });

  it('does not allow a worker to submit a request for another business task', async () => {
    const db = requestDb({ taskRows: [] });
    await assert.rejects(() => createTaskWorkerRequest(db, req, taskId, { type: 'Assistance', message: 'Need help at this stage' }),
      (error) => error instanceof AppError && error.status === 404 && error.code === 'task_not_found');
    const taskQuery = db.calls.find((call) => call.sql.includes('FROM "ProductionTasks"') && call.sql.includes('FOR UPDATE'));
    assert.equal(taskQuery.values[0], businessId);
  });

  it('requires a configured planned estimate for discrepancy reports', async () => {
    const db = requestDb({ taskRows: [{ Id: taskId, OrderId: 'x', Title: 'Sew shirt', Status: 'InProgress', EstimatedMinutes: null, AssignedMembershipId: membershipId }] });
    await assert.rejects(() => createTaskWorkerRequest(db, req, taskId, { type: 'Discrepancy', message: 'It took longer', actualMinutes: 90 }),
      (error) => error instanceof AppError && error.code === 'task_estimate_missing');
    assert.equal(db.calls.some((call) => call.sql.includes('INSERT INTO "TaskWorkerRequests"')), false);
  });

  it('prevents duplicate pending requests for the same task and type', async () => {
    const db = requestDb({ insertRows: [] });
    await assert.rejects(() => createTaskWorkerRequest(db, req, taskId, { type: 'Assistance', message: 'Need help with this seam' }),
      (error) => error instanceof AppError && error.status === 409 && error.code === 'request_already_pending');
  });

  it('reviews a request inside the active business and writes an audit record', async () => {
    const db = requestDb();
    const result = await reviewTaskWorkerRequest(db, req, requestId, { status: 'Accepted', note: 'We will send another tailor' }, null);
    assert.equal(result.Status, 'Accepted');
    const audit = db.calls.find((call) => call.sql.includes('INSERT INTO "AuditLogs"'));
    assert.equal(audit.values[3], businessId);
    assert.equal(audit.values[5], requestId);
  });

  it('does not expose a worker request from another business', async () => {
    const db = { async query(sql, values = []) {
      if (sql.includes('FROM "TaskWorkerRequests"')) { assert.equal(values[0], businessId); return { rows: [] }; }
      return { rows: [] };
    } };
    await assert.rejects(() => reviewTaskWorkerRequest(db, req, requestId, { status: 'Declined', note: null }, null),
      (error) => error instanceof AppError && error.status === 404 && error.code === 'task_request_not_found');
  });
});
