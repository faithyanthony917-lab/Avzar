import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchPushDeliveriesOnce } from '../../src/notifications/pushDeliveryWorker.js';

const now = new Date('2026-10-21T12:00:00Z');
const baseDelivery = { Id: 'delivery-1', BusinessId: 'business-1', PushTokenId: 'token-row-1', RecipientMembershipId: 'member-1', Attempts: 1, LeaseUntilUtc: new Date(now.getTime() + 300000) };
function poolFor(item) {
  const calls = [];
  return { calls, async query(sql, values = []) {
    calls.push({ sql, values });
    if (sql.includes('WITH picked AS')) return { rows: [{ ...baseDelivery }] };
    if (sql.includes('SELECT d."ExpiresAtUtc"')) return { rows: item ? [item] : [] };
    return { rowCount: 1, rows: [] };
  } };
}
const eligible = { Token: 'ExponentPushToken[test]', Active: true, SessionId: 'session-1', MembershipId: 'member-1', BusinessId: 'business-1', RevokedAtUtc: null,
  AbsoluteExpiresAtUtc: new Date(now.getTime() + 3600000), IdleExpiresAtUtc: new Date(now.getTime() + 3600000), MembershipStatus: 0, PushPreferenceEnabled: true, AppointmentStatus: null, AppointmentStartUtc: null,
  ExpiresAtUtc: null, Category: 'tasks', EventType: 'task.assignment', TargetKind: 'task', TargetId: 'task-1' };

describe('push delivery worker', () => {
  it('records Expo ticket acceptance without claiming device delivery', async () => {
    const pool = poolFor(eligible);
    let sent;
    const result = await dispatchPushDeliveriesOnce(pool, { now, sender: { async send(messages) { sent = messages[0]; return [{ status: 'ok', id: 'ticket-123' }]; } }, log: { error() {} } });
    assert.equal(result.accepted, 1);
    assert.equal(sent.to, eligible.Token);
    assert.equal(sent.body, 'A production task has been assigned to you.');
    assert.equal(sent.data.eventType, 'task.assignment');
    assert.ok(pool.calls.some(({ sql, values }) => sql.includes('"Status"=$3') && values[2] === 'Accepted'));
  });

  it('skips expired appointment reminders before sending', async () => {
    const pool = poolFor({ ...eligible, ExpiresAtUtc: new Date(now.getTime() - 1) });
    let sent = false;
    const result = await dispatchPushDeliveriesOnce(pool, { now, sender: { async send() { sent = true; return [{ status: 'ok' }]; } }, log: { error() {} } });
    assert.equal(result.skipped, 1);
    assert.equal(sent, false);
  });

  it('deactivates a token rejected as DeviceNotRegistered', async () => {
    const pool = poolFor(eligible);
    const result = await dispatchPushDeliveriesOnce(pool, { now, sender: { async send() { return [{ status: 'error', details: { error: 'DeviceNotRegistered' } }]; } }, log: { error() {} } });
    assert.equal(result.failed, 1);
    assert.ok(pool.calls.some(({ sql, values }) => sql.includes('"DeactivatedReason"=\'device_not_registered\'')));
  });

  it('does no work if no sender is configured', async () => {
    const result = await dispatchPushDeliveriesOnce(poolFor(eligible), { now, sender: null });
    assert.deepEqual(result, { claimed: 0, accepted: 0, retried: 0, failed: 0, skipped: 0 });
  });

  it('retries transient provider failures and exhausts attempts', async () => {
    const pool = poolFor(eligible);
    const transient = await dispatchPushDeliveriesOnce(pool, { now, sender: { async send() { const error = new Error('temporary'); error.status = 503; throw error; } }, log: { error() {} } });
    assert.equal(transient.retried, 1);
    assert.ok(pool.calls.some(({ sql, values }) => sql.includes('"Status"=$3') && values[2] === 'Pending'));

    const exhaustedPool = poolFor(eligible);
    const exhausted = await dispatchPushDeliveriesOnce(exhaustedPool, { now, maxAttempts: 1,
      sender: { async send() { const error = new Error('temporary'); error.status = 503; throw error; } }, log: { error() {} } });
    assert.equal(exhausted.failed, 1);
    assert.ok(exhaustedPool.calls.some(({ sql, values }) => sql.includes('"Status"=$3') && values[2] === 'Failed'));
  });

});
