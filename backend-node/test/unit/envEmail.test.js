import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../../src/config/env.js';
import { emailOptionsFromEnv } from '../../src/email/options.js';

const SECRET = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;
const resend = { EMAIL_PROVIDER: 'resend', EMAIL_RESEND_API_KEY: 're_key', EMAIL_FROM_ADDRESS: 'noreply@example.com' };

describe('email environment', () => {
  it('defaults mirror the C# options (log provider outside production)', () => {
    const o = emailOptionsFromEnv(loadEnv({ NODE_ENV: 'development' }));
    assert.deepEqual([o.provider, o.fromName, o.maxAttempts, o.batchSize, o.pollSeconds, o.leaseMinutes, o.dispatcherEnabled],
      ['log', 'Avzar', 6, 20, 5, 5, true]);
    assert.deepEqual([o.smtp.port, o.smtp.startTls, o.resend.baseUrl], [587, true, 'https://api.resend.com']);
  });
  it('refuses provider=log in production, including when it is simply unset', () => {
    assert.throws(() => loadEnv({ NODE_ENV: 'production' }), /EMAIL_PROVIDER/);
    assert.throws(() => loadEnv({ NODE_ENV: 'production', EMAIL_PROVIDER: 'log' }), /EMAIL_PROVIDER/);
    assert.doesNotThrow(() => loadEnv({ NODE_ENV: 'production', ...resend }));
  });
  it('requires a valid from address for a real provider', () => {
    assert.throws(() => loadEnv({ ...resend, EMAIL_FROM_ADDRESS: '' }), /EMAIL_FROM_ADDRESS/);
    assert.throws(() => loadEnv({ ...resend, EMAIL_FROM_ADDRESS: 'Avzar <noreply@example.com>' }), /EMAIL_FROM_ADDRESS/);
  });
  it('requires provider-specific settings', () => {
    assert.throws(() => loadEnv({ ...resend, EMAIL_RESEND_API_KEY: '' }), /EMAIL_RESEND_API_KEY/);
    assert.throws(() => loadEnv({ ...resend, EMAIL_RESEND_BASE_URL: 'not a url' }), /EMAIL_RESEND_BASE_URL/);
    assert.throws(() => loadEnv({ EMAIL_PROVIDER: 'smtp', EMAIL_FROM_ADDRESS: 'noreply@example.com' }), /EMAIL_SMTP_HOST/);
    assert.doesNotThrow(() => loadEnv({ EMAIL_PROVIDER: 'smtp', EMAIL_FROM_ADDRESS: 'noreply@example.com', EMAIL_SMTP_HOST: 'smtp.example.com' }));
  });
  it('validates ranges and booleans', () => {
    for (const bad of [{ EMAIL_MAX_ATTEMPTS: '0' }, { EMAIL_MAX_ATTEMPTS: '21' }, { EMAIL_BATCH_SIZE: '201' }, { EMAIL_POLL_SECONDS: '0' },
      { EMAIL_LEASE_MINUTES: '0' }, { EMAIL_SMTP_PORT: '70000' }, { EMAIL_DISPATCHER_ENABLED: 'yes' }, { EMAIL_SMTP_STARTTLS: '1' }, { EMAIL_PROVIDER: 'pigeon' }]) {
      assert.throws(() => loadEnv(bad), /Invalid backend-node environment/, JSON.stringify(bad));
    }
    assert.equal(loadEnv({ EMAIL_DISPATCHER_ENABLED: 'false' }).EMAIL_DISPATCHER_ENABLED, false);
  });
  it('validates the webhook secret only when set', () => {
    assert.equal(loadEnv({}).EMAIL_RESEND_WEBHOOK_SECRET, '');
    assert.equal(loadEnv({ EMAIL_RESEND_WEBHOOK_SECRET: SECRET }).EMAIL_RESEND_WEBHOOK_SECRET, SECRET);
    assert.throws(() => loadEnv({ EMAIL_RESEND_WEBHOOK_SECRET: 'whsec_nope' }), /EMAIL_RESEND_WEBHOOK_SECRET/);
  });
});
