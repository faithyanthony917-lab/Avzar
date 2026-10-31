import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../../src/config/env.js';

const PROD_EMAIL = { EMAIL_PROVIDER: 'resend', EMAIL_RESEND_API_KEY: 're_test_key', EMAIL_FROM_ADDRESS: 'noreply@example.com' };

describe('startup database flags (Database:MigrateOnStartup, Billing:SeedPlansOnStartup)', () => {
  it('default to on in development', () => {
    const e = loadEnv({ NODE_ENV: 'development' });
    assert.equal(e.DATABASE_MIGRATE_ON_STARTUP, true);
    assert.equal(e.BILLING_SEED_PLANS_ON_STARTUP, true);
  });
  it('default to off in production and test', () => {
    for (const NODE_ENV of ['production', 'test']) {
      const e = loadEnv({ NODE_ENV, ...PROD_EMAIL });
      assert.equal(e.DATABASE_MIGRATE_ON_STARTUP, false, NODE_ENV);
      assert.equal(e.BILLING_SEED_PLANS_ON_STARTUP, false, NODE_ENV);
    }
  });
  it('can be switched either way explicitly', () => {
    const on = loadEnv({ ...PROD_EMAIL, NODE_ENV: 'production', DATABASE_MIGRATE_ON_STARTUP: 'true', BILLING_SEED_PLANS_ON_STARTUP: 'true' });
    assert.deepEqual([on.DATABASE_MIGRATE_ON_STARTUP, on.BILLING_SEED_PLANS_ON_STARTUP], [true, true]);
    const off = loadEnv({ NODE_ENV: 'development', DATABASE_MIGRATE_ON_STARTUP: 'false', BILLING_SEED_PLANS_ON_STARTUP: 'false' });
    assert.deepEqual([off.DATABASE_MIGRATE_ON_STARTUP, off.BILLING_SEED_PLANS_ON_STARTUP], [false, false]);
  });
  it('rejects a non-boolean value', () => {
    assert.throws(() => loadEnv({ ...PROD_EMAIL, NODE_ENV: 'production', BILLING_SEED_PLANS_ON_STARTUP: 'yes' }), /BILLING_SEED_PLANS_ON_STARTUP/);
  });
});

describe('worker summary settings (A2)', () => {
  it('default to enabled with a 60 second poll', () => {
    const e = loadEnv({ NODE_ENV: 'development' });
    assert.equal(e.WORKER_SUMMARY_ENABLED, true);
    assert.equal(e.WORKER_SUMMARY_POLL_SECONDS, 60);
  });
  it('can be disabled or tuned, and reject out-of-range values', () => {
    const e = loadEnv({ NODE_ENV: 'development', WORKER_SUMMARY_ENABLED: 'false', WORKER_SUMMARY_POLL_SECONDS: '120' });
    assert.deepEqual([e.WORKER_SUMMARY_ENABLED, e.WORKER_SUMMARY_POLL_SECONDS], [false, 120]);
    assert.throws(() => loadEnv({ NODE_ENV: 'development', WORKER_SUMMARY_POLL_SECONDS: '5' }), /WORKER_SUMMARY_POLL_SECONDS/);
  });
});

describe('notification outbox settings (A1)', () => {
  it('defaults to enabled with a 10 second poll', () => {
    const e = loadEnv({ NODE_ENV: 'development' });
    assert.equal(e.NOTIFICATION_OUTBOX_ENABLED, true);
    assert.equal(e.NOTIFICATION_OUTBOX_POLL_SECONDS, 10);
  });
  it('can be disabled or tuned, and rejects out-of-range polling', () => {
    const e = loadEnv({ NODE_ENV: 'development', NOTIFICATION_OUTBOX_ENABLED: 'false', NOTIFICATION_OUTBOX_POLL_SECONDS: '30' });
    assert.deepEqual([e.NOTIFICATION_OUTBOX_ENABLED, e.NOTIFICATION_OUTBOX_POLL_SECONDS], [false, 30]);
    assert.throws(() => loadEnv({ NODE_ENV: 'development', NOTIFICATION_OUTBOX_POLL_SECONDS: '0' }), /NOTIFICATION_OUTBOX_POLL_SECONDS/);
  });
});
