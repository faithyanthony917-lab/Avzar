import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchOnce, startEmailDispatcher } from '../../src/email/dispatcher.js';
import { TransportResult } from '../../src/email/transportResult.js';

const now = new Date('2026-10-18T12:00:00.000Z');
const options = { batchSize: 10, leaseMinutes: 5, maxAttempts: 3 };
const env = { EMAIL_DISPATCHER_ENABLED: true, EMAIL_PROVIDER: 'log', EMAIL_BATCH_SIZE: 10, EMAIL_LEASE_MINUTES: 5, EMAIL_MAX_ATTEMPTS: 3, EMAIL_POLL_SECONDS: 7 };
const message = (overrides = {}) => ({
  id: '11111111-2222-3333-4444-555555555555', attempts: 1,
  html_body: '<p>Private link</p>', lease_until: new Date('2026-10-18T12:05:00.000Z'),
  subject: 'Confirm account', text_body: 'https://example.test/secret', to_address: 'Ada@Example.test',
  ...overrides,
});

function fakePool(claimed = [message()], suppressed = false) {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('WITH picked AS')) return { rows: claimed };
      if (sql.includes('FROM "EmailSuppressions"')) return { rows: suppressed ? [{ '?column?': 1 }] : [], rowCount: suppressed ? 1 : 0 };
      return { rows: [], rowCount: 1 };
    },
  };
}

describe('email outbox dispatcher', () => {
  it('claims due messages with SKIP LOCKED and records successful delivery', async () => {
    const pool = fakePool();
    const sent = [];
    const count = await dispatchOnce({
      pool, options, now, log: {},
      transport: { send: async (email) => { sent.push(email); return TransportResult.ok('resend_123'); } },
    });

    assert.equal(count, 1);
    assert.match(pool.calls[0].sql, /FOR UPDATE SKIP LOCKED/);
    assert.deepEqual(pool.calls[0].values, [now, new Date('2026-10-18T12:05:00.000Z'), options.batchSize]);
    assert.deepEqual(sent, [{
      messageId: message().id, to: message().to_address, subject: message().subject,
      textBody: message().text_body, htmlBody: message().html_body,
    }]);
    assert.match(pool.calls.at(-1).sql, /"Status" = 'Sent'/);
    assert.match(pool.calls.at(-1).sql, /"TextBody" = ''/);
    assert.match(pool.calls.at(-1).sql, /"BodyPurgedAtUtc" = \$3/);
    assert.equal(pool.calls.at(-1).values[3], 'resend_123');
  });

  it('does not call the provider for a suppressed recipient and terminally purges the message', async () => {
    const pool = fakePool([message()], true);
    let sends = 0;
    await dispatchOnce({ pool, options, now, log: {}, transport: { send: async () => { sends++; return TransportResult.ok(); } } });

    assert.equal(sends, 0);
    assert.deepEqual(pool.calls[1].values, ['ada@example.test']);
    assert.match(pool.calls.at(-1).sql, /"Status" = 'Failed'/);
    assert.match(pool.calls.at(-1).sql, /"HtmlBody" = NULL/);
    assert.match(pool.calls.at(-1).values[3], /suppression list/);
  });

  it('retries transient failures with backoff and keeps the message body', async () => {
    const pool = fakePool([message({ attempts: 1 })]);
    await dispatchOnce({ pool, options, now, log: {}, transport: { send: async () => TransportResult.retry('provider unavailable') } });

    const update = pool.calls.at(-1);
    assert.match(update.sql, /"Status" = 'Pending'/);
    assert.match(update.sql, /"NextAttemptUtc" = \$4/);
    assert.equal(update.values[3].toISOString(), '2026-10-18T12:00:30.000Z');
    assert.equal(update.values[4], 'provider unavailable');
    assert.doesNotMatch(update.sql, /"TextBody" = ''/);
  });

  it('dead-letters exhausted transient failures and permanent rejections', async () => {
    for (const [attempts, result] of [
      [options.maxAttempts, TransportResult.retry('still offline')],
      [1, TransportResult.reject('invalid recipient')],
    ]) {
      const pool = fakePool([message({ attempts })]);
      await dispatchOnce({ pool, options, now, log: {}, transport: { send: async () => result } });
      const update = pool.calls.at(-1);
      assert.match(update.sql, /"Status" = 'Failed'/);
      assert.match(update.sql, /"TextBody" = ''/);
      assert.match(update.sql, /"BodyPurgedAtUtc" = \$3/);
    }
  });
});

describe('email dispatcher worker', () => {
  it('does not start without a pool or when disabled', async () => {
    let queries = 0;
    const pool = { query: async () => { queries++; return { rows: [] }; } };
    const stop = startEmailDispatcher({
      pool, env: { ...env, EMAIL_DISPATCHER_ENABLED: false }, transport: { send: async () => ({}) },
      schedule: () => assert.fail('disabled worker must not schedule'),
    });
    await stop();
    assert.equal(queries, 0);
    await startEmailDispatcher({ pool: null, env, transport: { send: async () => ({}) } })();
  });

  it('retries a failed cycle on the configured interval and cancels its timer on stop', async () => {
    const timers = [];
    const cancelled = [];
    const errors = [];
    let queries = 0;
    const pool = { query: async () => {
      queries++;
      if (queries === 1) throw new Error('database unavailable');
      return { rows: [] };
    } };
    const stop = startEmailDispatcher({
      pool, env, transport: { send: async () => ({}) }, log: { error: (...args) => errors.push(args) },
      schedule: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
      cancel: (timer) => cancelled.push(timer),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timers[0].delay, 7_000);
    assert.equal(errors.length, 1);

    timers[0].callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queries, 2);
    assert.equal(timers[1].delay, 7_000);
    await stop();
    assert.deepEqual(cancelled, [timers[1]]);
  });
});